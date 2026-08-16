#!/usr/bin/env node

// XWAH-9 Phase 4 regression test: cross-worker TSC coherence (design §6
// microtick row). Every per-vCPU worker derives its TSC from the shared
// microtick clock, so the vCPUs of one machine must agree like the cores
// of one package — the contract `tsc=reliable` guests trust unchecked
// (Linux skips its boot-time TSC sync test with that flag).
//
// The regression this guards (found via the Ghostty/Codex appliance
// failing V86_APPLIANCE_READY under percpu workers, cpus=4): each worker
// used to pin its TSC zero at its OWN reset moment, and workers reach
// that line milliseconds apart (spawn + compile stagger — 6.4 ms across 4
// workers on the machine that diagnosed it). The resulting constant
// cross-CPU TSC skew is the same order as the guest's 10 ms scheduler
// tick and 16 ms frame interval; per-CPU clock_gettime/sched_clock then
// disagree by the stagger and glib/GTK timer loops (openbox, Xorg,
// ghostty) degrade into busy-polling, because their deadlines oscillate
// between "long past" and "far future" with every task migration. The
// fix (vcpu_worker.js set_shared_tsc) rebases every worker's TSC onto the
// shared clock; this test measures the skew directly from guest rdtsc.
//
// Method: BSP and one SIPI'd AP each run a tight `rdtsc; mov [slot], eax`
// loop over the shared guest memory; the host samples both slots twice,
// interleaved, accepts only brackets where BOTH vCPUs demonstrably
// stored, and takes the minimum |skew| over many such brackets spread
// across ~2 s (the minimum discards host-scheduling staleness — a
// single clean bracket bounds the true skew). Pass: < 1e6 ticks = 1 ms
// of guest TSC time (TSC_RATE is 1e6 ticks per microtick millisecond).
// Pre-fix runs measure the worker reset stagger instead (millions of
// ticks); post-fix agreement is microsecond-scale.
//
// build/v86-multimem-debug.wasm is optional: the test skips cleanly when
// missing (the repo pattern).

import fs from "node:fs";
import url from "node:url";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { ensure_gram_bytes } from "./helpers.js";
import {
    ctl_base_for, ctl_pages,
    CTL_VCPU_STRIDE, CTL_IPI_SPECIAL,
    CTL_RUN_STATE_RUNNABLE, CTL_RUN_STATE_WAIT_FOR_SIPI,
    CTL_COMMAND_TERMINATE,
    doorbell_post, run_state_read, command_write,
    mailbox_record_word, mailbox_service, mailbox_wait_for_request,
    MAILBOX_OP_PIC_ACK,
} from "../../src/browser/smpctl.js";

process.on("unhandledRejection", exn => { throw exn; });

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "/../..";

const multimem_wasm = ROOT + "/build/v86-multimem-debug.wasm";
if(!fs.existsSync(multimem_wasm))
{
    console.log("Missing " + multimem_wasm + ", test skipped");
    process.exit(0);
}

const MEMORY_SIZE = 16 * 1024 * 1024;
const TOTAL_CPUS = 2;
// TSC ticks: TSC_RATE (cpu.rs) is 1e6 ticks per microtick MILLISECOND
// (the guest sees a ~1 GHz TSC). Brackets wider than BRACKET_MAX are
// host-scheduling noise and rejected; the skew bound (1 ms of guest TSC
// time) is the pass criterion — pre-fix skew measures in MILLIONS of
// ticks (the per-worker reset stagger), post-fix in single-digit
// microseconds.
const BRACKET_MAX_TICKS = 100_000;
const SKEW_MAX_TICKS = 1_000_000;
const SAMPLE_ROUNDS = 20_000;
const SAMPLES_MIN = 50;

// rdtsc result cells on distinct 64-byte lines
const SLOT0 = 0x1040;
const SLOT1 = 0x1080;
const AP_VECTOR = 0x10;
// ipi_special encoding (smpctl.rs): INIT bit 0, SIPI bit 1, vector << 8
const IPI_INIT_BIT = 1;
const IPI_SIPI_BIT = 2;

// 16-bit real-mode program: mov sp, imm16; loop { rdtsc; mov [slot], eax }
function tsc_loop(sp, slot)
{
    return [
        0xBC, sp & 0xFF, sp >> 8 & 0xFF,        // mov sp, imm16
        // loop body: 2 (rdtsc) + 4 (66 A3 d16) + 2 (jmp) = 8 bytes back
        0x0F, 0x31,                             // rdtsc
        0x66, 0xA3, slot & 0xFF, slot >> 8,     // mov [slot], eax
        0xEB, 0xF8,                             // jmp -> rdtsc
    ];
}

// Defensive device host (the tso-litmus pattern): the guest programs
// perform no I/O, but any stray RPC must be answered or the worker
// deadlocks.
function start_service_loop(i32, record)
{
    let stopped = false;
    const done = (async () =>
    {
        while(!stopped)
        {
            const handled = mailbox_service(i32, record, op =>
            {
                assert.equal(op, MAILBOX_OP_PIC_ACK, `unexpected mailbox op ${op}`);
                return -1;
            });
            if(!handled)
            {
                await mailbox_wait_for_request(i32, record, 250);
            }
        }
    })();
    return {
        stop: () => { stopped = true; },
        done,
    };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function wait_for(label, predicate, timeout_ms)
{
    const deadline = Date.now() + timeout_ms;
    while(!predicate())
    {
        assert(Date.now() < deadline, "timeout: " + label);
        await sleep(2);
    }
}

const guest_pages = MEMORY_SIZE / 0x10000 + 1 + ctl_pages(TOTAL_CPUS, MEMORY_SIZE);
const guest_memory = new WebAssembly.Memory(
    { initial: guest_pages, maximum: guest_pages, shared: true });
const ctl_base = ctl_base_for(MEMORY_SIZE);
const i32 = new Int32Array(guest_memory.buffer);
const mem8 = new Uint8Array(guest_memory.buffer);

// guest image: reset vector -> BSP loop at F0000; AP loop at its
// architectural SIPI entry (linear vector << 12)
mem8.set([0xEA, 0x00, 0x00, 0x00, 0xF0], 0xFFFF0);              // ljmp F000:0000
mem8.set(tsc_loop(0x100, SLOT0), 0xF0000);
mem8.set(tsc_loop(0x300, SLOT1), AP_VECTOR << 12);

const services = [];
const exits = [];
const errors = [];
for(let index = 0; index < TOTAL_CPUS; index++)
{
    services.push(start_service_loop(i32, mailbox_record_word(ctl_base, index)));
    const worker = new Worker(new URL("../../src/browser/vcpu_worker.js", import.meta.url));
    exits.push(new Promise((resolve, reject) =>
    {
        worker.on("error", reject);
        worker.on("exit", code =>
            code === 0 ? resolve() : reject(new Error(`vcpu worker ${index} exit ${code}`)));
    }));
    worker.on("message", m =>
    {
        if(m && (m.type === "error" || m.type === "abort"))
        {
            errors.push(new Error(`vcpu worker ${index}: ${m.message}\n${m.stack || ""}`));
        }
    });
    worker.postMessage({
        wasm_source: fs.readFileSync(multimem_wasm),
        gram_bytes: ensure_gram_bytes("shared"),
        guest_memory,
        index,
        total: TOTAL_CPUS,
        main_time_origin: performance.timeOrigin,
        memory_size: MEMORY_SIZE,
        vcpu: {
            acpi: true,
            disable_jit: +process.env.DISABLE_JIT,
        },
    });
}
const check_errors = () =>
{
    if(errors.length)
    {
        throw errors[0];
    }
};
const state = i => run_state_read(i32, ctl_base, i);

await wait_for("BSP running", () =>
{
    check_errors();
    return state(0) === CTL_RUN_STATE_RUNNABLE;
}, 60_000);
await wait_for("AP WaitForSipi", () =>
{
    check_errors();
    return state(1) === CTL_RUN_STATE_WAIT_FOR_SIPI;
}, 60_000);
Atomics.or(i32, ctl_base + 1 * CTL_VCPU_STRIDE + CTL_IPI_SPECIAL >>> 2,
    IPI_INIT_BIT | IPI_SIPI_BIT | AP_VECTOR << 8);
doorbell_post(i32, ctl_base, 1);
await wait_for("AP running after SIPI", () =>
{
    check_errors();
    return state(1) === CTL_RUN_STATE_RUNNABLE;
}, 60_000);

// both loops publishing fresh rdtsc values
const first = [Atomics.load(i32, SLOT0 >>> 2), Atomics.load(i32, SLOT1 >>> 2)];
await wait_for("both rdtsc loops advancing", () =>
{
    check_errors();
    return Atomics.load(i32, SLOT0 >>> 2) !== first[0] &&
        Atomics.load(i32, SLOT1 >>> 2) !== first[1];
}, 60_000);

// Skew sampling: both slots read twice, interleaved (a0 b0 a1 b1). A
// sample counts only when BOTH vCPUs demonstrably stored during the
// bracket (a1−a0 and b1−b0 small and nonzero) — a worker descheduled by
// the host mid-sample would otherwise contribute its stale slot value as
// phantom skew. Samples are spread over ~2 s of wall time (a tight JS
// loop would finish inside a single scheduling quantum, where one
// stalled worker poisons every sample and the minimum cannot reject it).
// For an accepted sample |true skew| ≤ |midpoint difference| + bracket.
let min_abs_skew = Infinity;
let min_skew = 0;
let accepted = 0;
for(let round = 0; round < SAMPLE_ROUNDS; round++)
{
    const a0 = Atomics.load(i32, SLOT0 >>> 2) >>> 0;
    const b0 = Atomics.load(i32, SLOT1 >>> 2) >>> 0;
    const a1 = Atomics.load(i32, SLOT0 >>> 2) >>> 0;
    const b1 = Atomics.load(i32, SLOT1 >>> 2) >>> 0;
    const bracket_a = (a1 - a0) >>> 0;
    const bracket_b = (b1 - b0) >>> 0;
    if(round % 20 === 0)
    {
        await sleep(2);
    }
    if(bracket_a === 0 || bracket_a > BRACKET_MAX_TICKS ||
        bracket_b === 0 || bracket_b > BRACKET_MAX_TICKS)
    {
        continue;
    }
    accepted++;
    // signed 32-bit difference of unsigned tick counters (both near each
    // other mod 2^32)
    const skew = (b0 / 2 + b1 / 2 - a0 / 2 - a1 / 2) | 0;
    if(Math.abs(skew) < min_abs_skew)
    {
        min_abs_skew = Math.abs(skew);
        min_skew = skew;
    }
}

console.log(`tsc skew: min |skew| ${min_abs_skew} ticks (signed ${min_skew}) ` +
    `over ${accepted}/${SAMPLE_ROUNDS} tight brackets`);
assert(accepted >= SAMPLES_MIN,
    `need at least ${SAMPLES_MIN} tight sample brackets (got ${accepted})`);
assert(min_abs_skew < SKEW_MAX_TICKS,
    `cross-vCPU TSC skew must stay under ${SKEW_MAX_TICKS} ticks (1 ms of guest TSC time): ` +
    `measured ${min_abs_skew} — per-worker TSC epochs have diverged ` +
    `(vcpu_worker.js set_shared_tsc regression)`);

// teardown
for(let i = 0; i < TOTAL_CPUS; i++)
{
    command_write(i32, ctl_base, i, CTL_COMMAND_TERMINATE);
    doorbell_post(i32, ctl_base, i);
}
await Promise.all(exits);
for(const service of services)
{
    service.stop();
}
Atomics.notify(i32, mailbox_record_word(ctl_base, 0));
Atomics.notify(i32, mailbox_record_word(ctl_base, 1));
await Promise.all(services.map(s => s.done));

console.log("Tests passed");
process.exit(0);
