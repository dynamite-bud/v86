#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W1 gate (docs/smp-phase4-design.md §9 W1): the vCPU
// worker runtime skeleton, driven end-to-end in real worker_threads.
//
// Main thread = stub device host. It creates the shared guest memory with
// the control-region pages (the starter.js worker-mode sizing), spawns
// src/browser/vcpu_worker.js as a REAL worker, and services its mailbox
// record with the production smpctl.js server functions. Asserts:
//
//   1. the worker instantiates gram-shared.wasm + v86-multimem-debug.wasm
//      over the shared memory, runs rust_init/set_smp_cpus/
//      set_guest_memory_shared, and the Rust control-region layout
//      (get_smpctl_base/get_smpctl_size/get_smpctl_offset) matches the JS
//      mirror field for field (checked inside the worker; init-done implies
//      it, and the base/size are re-asserted here);
//   2. the clock origin handshake is sane: the worker's mapped microtick is
//      within 5 ms of the main thread's performance.now();
//   3. worker-side codegen_finalize works: a force-compiled program's
//      module validates, imports "e"."m" + "e"."g", instantiates IN the
//      worker against the two real memories, and lands in the worker's own
//      table (jit-proof message);
//   4. a doorbell post wakes the parked worker (heartbeat publishes);
//   5. one mailbox RPC batch (OUT/IN echo pairs) through smpctl.js
//      completes with correct values, with a round-trip median within 2x
//      the Layer A baseline measured in-process right before (same
//      machine, same moment, same smpctl.js code over a bare SAB);
//   6. the TERMINATE command parks the skeleton loop for good and the
//      worker exits cleanly.
//
// build/v86-multimem-debug.wasm is an optional artifact: the test skips
// cleanly when it is missing (the repo's established missing-artifact
// pattern); `make multimem-tests` runs it with the artifact as a hard
// dependency.

import fs from "node:fs";
import url from "node:url";
import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { ensure_gram_bytes, latency_stats_us, format_stats_us } from "./helpers.js";
import {
    CTL_MAILBOX_BYTES,
    MAILBOX_STATE, MAILBOX_SEQ, MAILBOX_OP_OUT, MAILBOX_OP_IN,
    mailbox_request, mailbox_service, mailbox_wait_for_request,
    mailbox_record_word,
    ctl_base_for, ctl_size, ctl_pages,
    doorbell_post, heartbeat_read, run_state_read,
    command_write, CTL_COMMAND_TERMINATE,
    CTL_RUN_STATE_PARKED, CTL_RUN_STATE_HALTED,
} from "../../src/browser/smpctl.js";

process.on("unhandledRejection", exn => { throw exn; });

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "/../..";

const MEMORY_SIZE = 16 * 1024 * 1024;
const TOTAL_CPUS = 2;      // exercises N-scaling of the layout; index 0 runs
const VCPU = 0;
const RPC_PAIRS = 2_000;
const PORT = 0xe9;
const WAIT_TIMEOUT_MS = 10_000;

// ---- baseline half (runs in a worker): Layer A RPCs over a bare SAB ----

function baseline_worker_main()
{
    const ctl = new Int32Array(workerData.control_sab);
    const latencies_ns = new Float64Array(RPC_PAIRS * 2);
    let request_index = 0;
    for(let i = 0; i < RPC_PAIRS; i++)
    {
        for(const op of [MAILBOX_OP_OUT, MAILBOX_OP_IN])
        {
            ctl[MAILBOX_SEQ] = request_index;
            const begin = process.hrtime.bigint();
            const result = mailbox_request(ctl, 0, op, PORT, 4,
                op === MAILBOX_OP_OUT ? i : 0, WAIT_TIMEOUT_MS);
            latencies_ns[request_index] = Number(process.hrtime.bigint() - begin);
            if(op === MAILBOX_OP_IN)
            {
                assert.equal(result, i, `baseline IN must echo OUT (pair ${i})`);
            }
            request_index++;
        }
    }
    parentPort.postMessage(latencies_ns, [latencies_ns.buffer]);
}

// Device-host service loop over one record; runs until stop() is called.
// The port model is the Layer A register file: OUT stores, IN returns.
function start_device_host(ctl, record)
{
    const port_registers = new Map();
    let serviced = 0;
    let stopped = false;
    const done = (async () =>
    {
        while(!stopped)
        {
            const handled = mailbox_service(ctl, record, (op, addr, size, value_lo) =>
            {
                if(op === MAILBOX_OP_OUT)
                {
                    port_registers.set(addr, value_lo);
                    return undefined;
                }
                assert.equal(op, MAILBOX_OP_IN, "stub device host: known op");
                return port_registers.get(addr) ?? -1;
            });
            if(handled)
            {
                serviced++;
            }
            else
            {
                // short re-arm timeout so stop() takes effect promptly
                await mailbox_wait_for_request(ctl, record, 250);
            }
        }
    })();
    return {
        stop: () =>
        {
            stopped = true;
            // wake the pending waitAsync so `done` settles promptly (and
            // without relying on its timeout: Atomics.waitAsync does not
            // keep the Node event loop alive)
            Atomics.notify(ctl, record + MAILBOX_STATE);
        },
        done,
        get serviced() { return serviced; },
    };
}

async function measure_baseline()
{
    const control_sab = new SharedArrayBuffer(CTL_MAILBOX_BYTES);
    const ctl = new Int32Array(control_sab);
    const host = start_device_host(ctl, 0);

    const worker = new Worker(new URL(import.meta.url), { workerData: { control_sab } });
    const latencies_ns = await new Promise((resolve, reject) =>
    {
        let latencies = null;
        worker.on("message", m => { latencies = m; });
        worker.on("error", reject);
        worker.on("exit", code =>
            code === 0 ? resolve(latencies) : reject(new Error(`baseline worker exit ${code}`)));
    });
    host.stop();
    await host.done;
    assert.equal(host.serviced, RPC_PAIRS * 2, "baseline: every RPC serviced");
    return latency_stats_us(latencies_ns);
}

// ---- the real thing: vcpu_worker.js over shared guest memory ----

async function main()
{
    const multimem_wasm = ROOT + "/build/v86-multimem-debug.wasm";
    if(!fs.existsSync(multimem_wasm))
    {
        console.log("Missing build/v86-multimem-debug.wasm, test skipped");
        process.exit(0);
    }

    // ref'd watchdog: fails the test loudly on a stall AND keeps the event
    // loop alive across the phase boundaries — pending Atomics.waitAsync
    // promises alone do not, and Node would otherwise exit mid-await with
    // an unsettled top-level await (observed as exit code 13)
    const watchdog = setTimeout(() =>
    {
        throw new Error("worker-skeleton: global 120s timeout");
    }, 120_000);

    const baseline = await measure_baseline();
    console.log(`baseline (bare-SAB Layer A): ${format_stats_us(baseline)}`);

    // guest memory sized exactly as starter.js sizes it under smp_workers:
    // guest RAM + scratch page + control-region pages
    const guest_pages = MEMORY_SIZE / 0x10000 + 1 + ctl_pages(TOTAL_CPUS);
    const guest_memory = new WebAssembly.Memory(
        { initial: guest_pages, maximum: guest_pages, shared: true });
    assert(guest_memory.buffer instanceof SharedArrayBuffer, "guest memory must be shared");

    const ctl_base = ctl_base_for(MEMORY_SIZE);
    const i32 = new Int32Array(guest_memory.buffer);
    const record = mailbox_record_word(ctl_base, VCPU);
    const host = start_device_host(i32, record);

    const worker = new Worker(new URL("../../src/browser/vcpu_worker.js", import.meta.url));
    const worker_exit = new Promise((resolve, reject) =>
    {
        worker.on("error", reject);
        worker.on("exit", code =>
            code === 0 ? resolve() : reject(new Error(`vcpu worker exit ${code}`)));
    });

    // message plumbing: every expected type gets a waitable slot
    const pending = new Map();
    const message_arrived = type => new Promise((resolve, reject) =>
    {
        pending.set(type, { resolve, reject });
        setTimeout(() => reject(new Error(`timed out waiting for "${type}" message`)),
            30_000).unref();
    });
    const wanted = ["init-done", "jit-proof", "parked", "rpc-batch", "terminated"];
    const waits = Object.fromEntries(wanted.map(type => [type, message_arrived(type)]));
    const receipt_times = new Map();
    worker.on("message", m =>
    {
        if(m && m.type === "error")
        {
            const failure = new Error(`vcpu worker error: ${m.message}\n${m.stack}`);
            for(const slot of pending.values())
            {
                slot.reject(failure);
            }
            throw failure;
        }
        if(m && pending.has(m.type))
        {
            receipt_times.set(m.type, performance.now());
            pending.get(m.type).resolve(m);
            pending.delete(m.type);
        }
    });

    worker.postMessage({
        wasm_source: fs.readFileSync(multimem_wasm),
        gram_bytes: ensure_gram_bytes("shared"),
        guest_memory,
        index: VCPU,
        total: TOTAL_CPUS,
        main_time_origin: performance.timeOrigin,
        memory_size: MEMORY_SIZE,
        // W1 test hooks
        test_force_jit: true,
        rpc_pairs: RPC_PAIRS,
        rpc_port: PORT,
    });

    // 1. instantiation over the shared memory + cross-language layout check
    // (the worker throws on any offset mismatch before posting init-done)
    const init = await waits["init-done"];
    assert.equal(init.smpctl_base, ctl_base,
        "rust get_smpctl_base must be memory_size + 0x10000");
    assert.equal(init.smpctl_size, ctl_size(TOTAL_CPUS),
        "rust get_smpctl_size must match the JS mirror");

    // 2. clock origin handshake: the worker's mapped clock reads as main
    // time; it was sampled strictly before the message arrived, so the
    // delta must be small and non-negative (5 ms allows scheduling noise)
    const clock_delta_ms = receipt_times.get("init-done") - init.microtick;
    assert(clock_delta_ms > -0.5 && clock_delta_ms < 5,
        `worker microtick must track main time (delta ${clock_delta_ms.toFixed(3)} ms)`);

    // 3. worker-side codegen_finalize proof
    const jit = await waits["jit-proof"];
    assert.equal(jit.ok, true, "force-compiled module must finalize in the worker");
    assert(jit.finalize_count >= 1, "at least one codegen_finalize");
    assert(jit.module_bytes > 0, "generated module must be non-empty");
    assert.deepEqual(jit.memory_imports, ["e.m", "e.g"],
        "JIT module must import instance memory e.m and guest memory e.g");
    assert.equal(jit.installed, true, "compiled function must land in the worker's table");

    // 4. doorbell wake round-trip: the parked worker publishes a heartbeat
    // per wake (and runs the RPC batch on the first RUN wake)
    await waits["parked"];
    assert.equal(heartbeat_read(i32, ctl_base, VCPU), 0, "no heartbeat before any doorbell");
    doorbell_post(i32, ctl_base, VCPU);

    // 5. the mailbox RPC batch through smpctl.js, latency vs the baseline
    const batch = await waits["rpc-batch"];
    const stats = latency_stats_us(batch.latencies_ns);
    console.log(`vcpu-worker mailbox:         ${format_stats_us(stats)}`);
    const heartbeat = heartbeat_read(i32, ctl_base, VCPU);
    assert(heartbeat >= 1, `doorbell wake must publish a heartbeat (${heartbeat})`);
    assert(stats.median <= 2 * baseline.median,
        `worker RPC median ${stats.median.toFixed(2)}µs must stay within 2x the ` +
        `baseline median ${baseline.median.toFixed(2)}µs`);

    // the worker re-parks after the batch (run_state_pub round-trips
    // Runnable -> Parked)
    const park_deadline = Date.now() + 5_000;
    while(run_state_read(i32, ctl_base, VCPU) !== CTL_RUN_STATE_PARKED)
    {
        assert(Date.now() < park_deadline, "worker must re-park after the batch");
        await new Promise(resolve => setTimeout(resolve, 1));
    }

    // 6. quiesce: TERMINATE command + doorbell ends the skeleton loop
    command_write(i32, ctl_base, VCPU, CTL_COMMAND_TERMINATE);
    doorbell_post(i32, ctl_base, VCPU);
    await waits["terminated"];
    assert.equal(run_state_read(i32, ctl_base, VCPU), CTL_RUN_STATE_HALTED,
        "terminated worker publishes Halted");
    await worker_exit;

    host.stop();
    await host.done;
    assert.equal(host.serviced, RPC_PAIRS * 2, "every worker RPC serviced");
    clearTimeout(watchdog);

    console.log(`worker-skeleton: instantiate+layout+clock+jit+doorbell+${RPC_PAIRS * 2} RPCs ` +
        `+terminate OK (worker median ${stats.median.toFixed(2)}µs vs ` +
        `baseline ${baseline.median.toFixed(2)}µs)`);
    console.log("Tests passed");
}

if(isMainThread)
{
    await main();
}
else
{
    baseline_worker_main();
}
