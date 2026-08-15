#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W3 gate (docs/smp-phase4-design.md §9 W3): Layer C
// item 1 ACROSS REAL WORKERS — two vCPUs, each in its own worker
// (src/browser/vcpu_worker.js per-vCPU mode), hammer `lock inc` on one
// guest cell CONCURRENTLY; the total must be exact. Plus the cross-worker
// slices of items 2 and 4 this harness can drive:
//
//   phase 1  both vCPUs run the same real-mode `lock inc dword [0x1000]`
//            loop (K iterations each), released simultaneously by a shared
//            go flag; while they run, the test storms fixed vectors
//            0x20..0x27 into BOTH workers' pending_irr bitmaps (the guest
//            IVT points them at an iret stub) — interrupt delivery races
//            the locked RMWs mid-loop. Exactness: [0x1000] == 2K.
//   phase 2  hlt/wake races on the parked (cli;hlt) vCPUs: a doorbell
//            storm produces wakes (heartbeats move) but no state change
//            and no counter change.
//   phase 3  INIT/SIPI restart: the parked AP is INIT (reset to
//            WaitForSipi on the live block) + SIPI'd again over the
//            control region and reruns its loop: counter == 3K exactly.
//   phase 4  W4 exclusive execution (design §5 final form): both vCPUs are
//            INIT/SIPI-restarted into new programs — vCPU 0 hammers a
//            MISALIGNED `lock inc dword` on a page-crossing cell (the
//            bus-lock fallback class, now exclusive execution: all other
//            workers parked per RMW), vCPU 1 concurrently hammers an
//            ALIGNED `lock inc dword` elsewhere (the CAS path, which now
//            parks at its slice boundary while an exclusive RMW runs).
//            Both counters exact.
//   phase 5  exclusive-vs-exclusive arbitration: both vCPUs hammer the
//            SAME page-crossing cell with misaligned locked incs — two
//            concurrent exclusive requesters contending on the machine
//            exclusive cell. Total exact.
//
// The AP is started by test-posted INIT/SIPI latches (real mode cannot
// reach the LAPIC MMIO window); the full guest-driven ICR path (BSP
// write_icr0 -> snapshot fan-out -> AP consume) is covered by SeaBIOS/
// Linux AP bring-up in tests/threads/vcpu-workers-smp.js. SIPI entry is
// architectural since W4: linear vector << 12 (the historical linear-0
// entry of apply_sipi survives only in the time-sliced path).
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
    CTL_VCPU_STRIDE, CTL_PENDING_IRR, CTL_IPI_SPECIAL,
    CTL_RUN_STATE_RUNNABLE, CTL_RUN_STATE_PARKED, CTL_RUN_STATE_HALTED,
    CTL_RUN_STATE_WAIT_FOR_SIPI,
    CTL_COMMAND_TERMINATE,
    doorbell_post, heartbeat_read, run_state_read, command_write,
    mailbox_record_word, mailbox_service, mailbox_wait_for_request,
    MAILBOX_OP_PIC_ACK,
} from "../../src/browser/smpctl.js";

process.on("unhandledRejection", exn => { throw exn; });

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "/../..";

const MEMORY_SIZE = 16 * 1024 * 1024;
const TOTAL_CPUS = 2;
const K = 500_000;              // lock incs per vCPU per round
const COUNTER = 0x1000;         // the hammered cell
const GO_FLAG = 0x1004;         // released by the test to start both loops
const DONE_BASE = 0x2000;       // per-vCPU done counters (0x2000, 0x2004)
const IRET_STUB = 0x3000;       // iret for the storm vectors
const SIPI_VECTOR = 0x9B;       // AP entry page -> 0x9B000
// ipi_special encoding (smpctl.rs): INIT bit 0, SIPI bit 1, vector << 8
const IPI_INIT_BIT = 1;
const IPI_SIPI_BIT = 2;

// phase 4/5 (W4 exclusive execution): fresh programs, go flags, counters.
// The misaligned counters sit two bytes before a page boundary, so the
// dword RMW crosses the page — the bus-lock fallback class that now runs
// under exclusive execution. Exclusive acquisition may wait out the peer's
// do_many_cycles window, so the misaligned iteration counts are far
// smaller than K (the ops are slice-latency-bounded while the peer runs).
const GO2_FLAG = 0x1008;
const GO3_FLAG = 0x100C;
const MIS_COUNTER = 0x4FFE;     // dword crossing the 0x4000/0x5000 boundary
const ALIGNED_COUNTER = 0x6000;
const MIS2_COUNTER = 0x8FFE;    // phase 5: the shared crossing cell
const DONE2_BASE = 0x2010;
const DONE3_BASE = 0x2020;
const K_MIS = 20_000;
const K_ALIGNED = 200_000;
// phase 4/5 program pages, entered directly by SIPI vector
// (architectural entry: linear vector << 12 — the W4 worker consume)
const P4_VECTORS = [0x10, 0x11];
const P5_VECTORS = [0x12, 0x13];

// Real-mode program (identical for both vCPUs up to the counter/done
// addresses and stack): set a PER-vCPU stack first — both vCPUs come out
// of reset/SIPI with the same SS:SP, and two CPUs taking storm interrupts
// on one shared stack corrupt each other's frames (a genuine guest-side
// SMP race: it made an iret pop a clobbered CS:IP roughly once per five
// runs before the mov sp landed) — then spin on the go flag, `lock inc
// dword [counter]` k times (with interrupts enabled when `sti` — the
// phase-1 storm delivers mid-loop), bump the own done counter, and
// cli;hlt (Parked).
function program_bytes({ counter, k, go_flag, done_addr, sp, sti })
{
    const code = [];
    // mov sp, imm16 (SS base 0x300 from reset; frames land below 0x300+sp)
    code.push(0xBC, sp & 0xFF, sp >> 8);
    // wait: mov eax, [go_flag]; test eax, eax; jz wait
    code.push(0x66, 0xA1, go_flag & 0xFF, go_flag >> 8);
    code.push(0x66, 0x85, 0xC0);
    code.push(0x74, 0xF7); // -9
    if(sti)
    {
        // sti (storm vectors may deliver mid-loop)
        code.push(0xFB);
    }
    // mov ecx, k
    code.push(0x66, 0xB9, k & 0xFF, k >> 8 & 0xFF, k >> 16 & 0xFF, k >>> 24);
    // loop: lock inc dword [counter]; dec ecx; jnz loop
    code.push(0xF0, 0x66, 0xFF, 0x06, counter & 0xFF, counter >> 8);
    code.push(0x66, 0x49);
    code.push(0x75, 0xF6); // -10
    // inc dword [done_addr]; cli; hlt
    code.push(0x66, 0xFF, 0x06, done_addr & 0xFF, done_addr >> 8);
    code.push(0xFA, 0xF4);
    return code;
}

function post_ipi_special(i32, ctl_base, i, bits)
{
    Atomics.or(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_IPI_SPECIAL >> 2, bits);
    doorbell_post(i32, ctl_base, i);
}

function post_fixed_vector(i32, ctl_base, i, vector)
{
    const word = ctl_base + i * CTL_VCPU_STRIDE + CTL_PENDING_IRR + 4 * (vector >> 5) >> 2;
    Atomics.or(i32, word, 1 << (vector & 31));
    doorbell_post(i32, ctl_base, i);
}

// Defensive device host: the guest programs perform no I/O, but any stray
// RPC must be answered or the worker deadlocks (fail via the assert).
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

async function main()
{
    const multimem_wasm = ROOT + "/build/v86-multimem-debug.wasm";
    if(!fs.existsSync(multimem_wasm))
    {
        console.log("Missing build/v86-multimem-debug.wasm, test skipped");
        process.exit(0);
    }
    const watchdog = setTimeout(() =>
    {
        throw new Error("vcpu-workers-lock: global 300s timeout");
    }, 300_000);

    const guest_pages = MEMORY_SIZE / 0x10000 + 1 + ctl_pages(TOTAL_CPUS, MEMORY_SIZE);
    const guest_memory = new WebAssembly.Memory(
        { initial: guest_pages, maximum: guest_pages, shared: true });
    const ctl_base = ctl_base_for(MEMORY_SIZE);
    const i32 = new Int32Array(guest_memory.buffer);
    const mem8 = new Uint8Array(guest_memory.buffer);

    // guest image: reset vector -> BSP program at F0000; each SIPI'd
    // program is entered at its architectural entry point (linear
    // vector << 12 — the W4 worker consume; the historical linear-0 entry
    // relied on sledding through pristine low memory and broke on reboot)
    mem8.set([0xEA, 0x00, 0x00, 0x00, 0xF0], 0xFFFF0);           // ljmp F000:0000
    mem8.set(program_bytes({ counter: COUNTER, k: K, go_flag: GO_FLAG,
        done_addr: DONE_BASE, sp: 0x100, sti: true }), 0xF0000); // BSP, stack < 0x400
    // the AP program (phases 1 and 3), entered by SIPI vector 0x9B
    mem8.set(program_bytes({ counter: COUNTER, k: K, go_flag: GO_FLAG,
        done_addr: DONE_BASE + 4, sp: 0x300, sti: true }),       // AP, stack < 0x600
        SIPI_VECTOR << 12);
    // phase 4: one vCPU -> misaligned page-crossing lock incs, the other
    // -> aligned lock incs elsewhere (both released by GO2)
    mem8.set(program_bytes({ counter: MIS_COUNTER, k: K_MIS, go_flag: GO2_FLAG,
        done_addr: DONE2_BASE, sp: 0x100, sti: false }), P4_VECTORS[0] << 12);
    mem8.set(program_bytes({ counter: ALIGNED_COUNTER, k: K_ALIGNED, go_flag: GO2_FLAG,
        done_addr: DONE2_BASE + 4, sp: 0x300, sti: false }), P4_VECTORS[1] << 12);
    // phase 5: both vCPUs on the SAME crossing cell (released by GO3)
    mem8.set(program_bytes({ counter: MIS2_COUNTER, k: K_MIS, go_flag: GO3_FLAG,
        done_addr: DONE3_BASE, sp: 0x100, sti: false }), P5_VECTORS[0] << 12);
    mem8.set(program_bytes({ counter: MIS2_COUNTER, k: K_MIS, go_flag: GO3_FLAG,
        done_addr: DONE3_BASE + 4, sp: 0x300, sti: false }), P5_VECTORS[1] << 12);

    // unaligned dword reads of the crossing counters (only ever read after
    // both vCPUs published Parked, which orders the plain bytes)
    const dview = new DataView(guest_memory.buffer);
    mem8[IRET_STUB] = 0xCF;                                     // iret
    for(let v = 0x20; v <= 0x27; v++)
    {
        // IVT entry: offset16 = IRET_STUB, segment16 = 0
        mem8[4 * v] = IRET_STUB & 0xFF;
        mem8[4 * v + 1] = IRET_STUB >> 8;
        mem8[4 * v + 2] = 0;
        mem8[4 * v + 3] = 0;
    }

    const services = [];
    const workers = [];
    const exits = [];
    const errors = [];
    for(let index = 0; index < TOTAL_CPUS; index++)
    {
        services.push(start_service_loop(i32, mailbox_record_word(ctl_base, index)));
        const worker = new Worker(new URL("../../src/browser/vcpu_worker.js", import.meta.url));
        workers.push(worker);
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
            // acpi on: handle_irqs' APIC leg must deliver the storm
            // vectors; jit on: the hot loops compile in both workers
            vcpu: { acpi: true, disable_jit: +process.env.DISABLE_JIT },
        });
    }
    const check_errors = () =>
    {
        if(errors.length)
        {
            throw errors[0];
        }
    };

    const counter_word = COUNTER >> 2;
    const state = i => run_state_read(i32, ctl_base, i);

    // BSP spins on the go flag (Runnable/Halted published per slice); the
    // AP parks in WaitForSipi until the INIT/SIPI latch arrives (its cell
    // is published by set_worker_vcpu once the worker has initialized)
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

    // start the AP: INIT+SIPI latch over the control region (design §3
    // step 2), then release both loops at once
    post_ipi_special(i32, ctl_base, 1, IPI_INIT_BIT | IPI_SIPI_BIT | SIPI_VECTOR << 8);
    await wait_for("AP running after SIPI", () =>
    {
        check_errors();
        return state(1) === CTL_RUN_STATE_RUNNABLE;
    }, 60_000);
    assert.equal(Atomics.load(i32, counter_word), 0, "no increments before the release");

    Atomics.store(i32, GO_FLAG >> 2, 1);
    // storm fixed vectors into both workers while the loops run (item 2's
    // cross-worker interrupt-storm slice: delivery races the locked RMWs)
    let storm_posts = 0;
    while(Atomics.load(i32, DONE_BASE >> 2) === 0 ||
        Atomics.load(i32, DONE_BASE + 4 >> 2) === 0)
    {
        check_errors();
        for(let i = 0; i < TOTAL_CPUS; i++)
        {
            post_fixed_vector(i32, ctl_base, i, 0x20 + storm_posts % 8);
        }
        storm_posts++;
        if(storm_posts >= 60_000)
        {
            // self-diagnosis before failing: distinguish a parked-but-
            // short counter (lost updates), a still-running loop (stall)
            // and a wandered guest (state Runnable, counter frozen)
            console.log("storm stall: counter=%d done=[%d,%d] states=[%d,%d] heartbeats=[%d,%d]",
                Atomics.load(i32, counter_word),
                Atomics.load(i32, DONE_BASE >> 2), Atomics.load(i32, DONE_BASE + 4 >> 2),
                state(0), state(1),
                heartbeat_read(i32, ctl_base, 0), heartbeat_read(i32, ctl_base, 1));
            assert(false, "loops must finish under the storm");
        }
        await sleep(1);
    }
    await wait_for("both parked after round 1", () =>
        state(0) === CTL_RUN_STATE_PARKED && state(1) === CTL_RUN_STATE_PARKED, 60_000);
    assert.equal(Atomics.load(i32, counter_word), 2 * K,
        "cross-worker lock inc must be exact (2 vCPUs x " + K + ")");
    console.log(`round 1: 2x${K} concurrent lock incs exact under ` +
        `${storm_posts} interrupt-storm posts`);

    // phase 2 — hlt/wake races on the parked vCPUs: spurious wakes only
    const heartbeats_before = [heartbeat_read(i32, ctl_base, 0), heartbeat_read(i32, ctl_base, 1)];
    for(let n = 0; n < 20_000; n++)
    {
        doorbell_post(i32, ctl_base, 0);
        doorbell_post(i32, ctl_base, 1);
        if(n % 1000 === 0)
        {
            await sleep(0);
        }
    }
    await sleep(50);
    check_errors();
    for(const i of [0, 1])
    {
        assert(heartbeat_read(i32, ctl_base, i) > heartbeats_before[i],
            `doorbell storm must wake worker ${i}`);
        assert.equal(state(i), CTL_RUN_STATE_PARKED,
            `spurious wakes must not unpark worker ${i}`);
    }
    assert.equal(Atomics.load(i32, counter_word), 2 * K, "counter unchanged by wakes");
    console.log("phase 2: 40000 doorbell posts on parked vCPUs, states and counter intact");

    // phase 3 — INIT/SIPI restart of the parked AP: INIT resets the live
    // block to WaitForSipi, the SIPI reruns the loop (go flag still set)
    post_ipi_special(i32, ctl_base, 1, IPI_INIT_BIT | IPI_SIPI_BIT | SIPI_VECTOR << 8);
    await wait_for("AP reran after INIT/SIPI restart", () =>
    {
        check_errors();
        return Atomics.load(i32, DONE_BASE + 4 >> 2) === 2;
    }, 120_000);
    await wait_for("AP parked after round 2", () => state(1) === CTL_RUN_STATE_PARKED, 60_000);
    assert.equal(Atomics.load(i32, counter_word), 3 * K,
        "restarted AP must add exactly K more increments");
    console.log(`phase 3: INIT/SIPI restart exact (counter == 3x${K})`);

    // phase 4 — W4 exclusive execution, mixed classes: INIT/SIPI both
    // vCPUs into the phase-4 programs. The misaligned page-crossing
    // `lock inc` takes the exclusive-execution path (all other workers
    // parked per RMW); the concurrent aligned `lock inc` takes the CAS
    // path and parks at its slice boundary whenever the exclusive cell is
    // held. Exactness of BOTH counters proves no update was lost on
    // either side and the machinery neither deadlocks nor corrupts.
    post_ipi_special(i32, ctl_base, 0, IPI_INIT_BIT | IPI_SIPI_BIT | P4_VECTORS[0] << 8);
    post_ipi_special(i32, ctl_base, 1, IPI_INIT_BIT | IPI_SIPI_BIT | P4_VECTORS[1] << 8);
    await wait_for("both running phase 4 programs", () =>
    {
        check_errors();
        return state(0) === CTL_RUN_STATE_RUNNABLE && state(1) === CTL_RUN_STATE_RUNNABLE;
    }, 60_000);
    assert.equal(dview.getUint32(MIS_COUNTER, true), 0, "no early misaligned increments");
    Atomics.store(i32, GO2_FLAG >> 2, 1);
    await wait_for("phase 4 loops done", () =>
    {
        check_errors();
        return Atomics.load(i32, DONE2_BASE >> 2) === 1 &&
            Atomics.load(i32, DONE2_BASE + 4 >> 2) === 1;
    }, 240_000);
    await wait_for("both parked after phase 4", () =>
        state(0) === CTL_RUN_STATE_PARKED && state(1) === CTL_RUN_STATE_PARKED, 60_000);
    assert.equal(dview.getUint32(MIS_COUNTER, true), K_MIS,
        "misaligned page-crossing lock incs must be exact under exclusive execution");
    assert.equal(Atomics.load(i32, ALIGNED_COUNTER >> 2), K_ALIGNED,
        "concurrent aligned lock incs must stay exact");
    console.log(`phase 4: ${K_MIS} misaligned page-crossing lock incs exact against ` +
        `${K_ALIGNED} concurrent aligned lock incs (exclusive execution)`);

    // phase 5 — exclusive-vs-exclusive arbitration: both vCPUs hammer the
    // SAME crossing cell; two exclusive requesters contend on the machine
    // exclusive cell (the loser clears its busy flag while spinning, so
    // neither deadlocks). Total must be exact.
    post_ipi_special(i32, ctl_base, 0, IPI_INIT_BIT | IPI_SIPI_BIT | P5_VECTORS[0] << 8);
    post_ipi_special(i32, ctl_base, 1, IPI_INIT_BIT | IPI_SIPI_BIT | P5_VECTORS[1] << 8);
    await wait_for("both running phase 5 programs", () =>
    {
        check_errors();
        return state(0) === CTL_RUN_STATE_RUNNABLE && state(1) === CTL_RUN_STATE_RUNNABLE;
    }, 60_000);
    Atomics.store(i32, GO3_FLAG >> 2, 1);
    await wait_for("phase 5 loops done", () =>
    {
        check_errors();
        return Atomics.load(i32, DONE3_BASE >> 2) === 1 &&
            Atomics.load(i32, DONE3_BASE + 4 >> 2) === 1;
    }, 240_000);
    await wait_for("both parked after phase 5", () =>
        state(0) === CTL_RUN_STATE_PARKED && state(1) === CTL_RUN_STATE_PARKED, 60_000);
    assert.equal(dview.getUint32(MIS2_COUNTER, true), 2 * K_MIS,
        "contending misaligned lock incs on one crossing cell must sum exactly");
    console.log(`phase 5: 2x${K_MIS} contending exclusive RMWs on one crossing cell exact`);

    // teardown
    for(let i = 0; i < TOTAL_CPUS; i++)
    {
        command_write(i32, ctl_base, i, CTL_COMMAND_TERMINATE);
        doorbell_post(i32, ctl_base, i);
    }
    await Promise.all(exits);
    for(const i of [0, 1])
    {
        assert.equal(state(i), CTL_RUN_STATE_HALTED, `worker ${i} publishes Halted`);
    }
    for(const service of services)
    {
        service.stop();
    }
    await Promise.all(services.map(s => s.done));
    clearTimeout(watchdog);
    console.log("Tests passed");
    process.exit(0);
}

await main();
