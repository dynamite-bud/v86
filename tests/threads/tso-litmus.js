#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W5 (docs/smp-phase4-design.md §9 W5): Layer C item 6
// — the TSO litmus tests that DECIDE the §5 memory-ordering posture. Two
// vCPUs in real workers (src/browser/vcpu_worker.js per-vCPU mode) run
// hand-assembled guest pairs; ordinary guest MOVs lower to PLAIN wasm
// accesses in both the interpreter (gram read/write) and the JIT, so a
// weakly-ordered host (ARM) is where relaxation surfaces:
//
//   MP (message passing)  P0: x=1; y=1.   P1: r1=y; r2=x.
//       x86-TSO FORBIDS r1=1 && r2=0 (neither stores nor loads reorder).
//   SB (store buffering)  P0: x=1; r1=y.  P1: y=1; r2=x.
//       x86-TSO ALLOWS r1=r2=0 (store buffers) — counted, never a failure.
//       A healthy nonzero count doubles as the detection-power check: a
//       harness that cannot observe the ALLOWED relaxation could not be
//       trusted to observe the forbidden one (plain-race-vs-atomic.js
//       semantics: report INCONCLUSIVE, do not fail green-by-luck).
//
// The test runs the pair TWICE (fresh machines):
//   pass 1, smp_memory_model "relaxed" (the default): histograms are
//     REPORTED, not asserted — on ARM hosts the forbidden MP outcome is
//     empirically observed at ppm rates (the §5 record; W5 landing runs:
//     7-27 per 1e6 trials on an Apple M4), which is exactly the documented
//     exposure of the relaxed default;
//   pass 2, smp_memory_model "fenced": the escape hatch (seq-cst fence
//     after every JIT guest load / before every JIT guest store,
//     wasm_builder.rs jit_gram_* arms) must make the forbidden outcome
//     VANISH — asserted == 0, provided pass 1 confirmed detection power.
//
// Harness soundness (why counts are signal, not artifact):
//   - per-trial sense barriers: `lock inc` to arrive + a `lock xadd`(0)
//     spin to leave (seq-cst RMWs — real acquire/release edges even on
//     ARM; a plain-load spin would let the collector read a half-published
//     result cell);
//   - all resets of the raced cells are performed by the vCPU whose next
//     reads they could contaminate (MP: the reader; SB: the collector),
//     so every cross-trial staleness hazard is same-CPU same-address —
//     which every architecture orders. Cross-CPU staleness inside a trial
//     is exactly the relaxation being measured;
//   - each trial increments exactly one histogram bucket with `lock inc`;
//     the bucket sum must equal the trial count exactly (harness gate).
//
// Iteration counts, host, and observed histograms are printed for the §5
// verdict record (HONESTY RULE: the doc states what ran where).
//
// build/v86-multimem-debug.wasm is optional: the test skips cleanly when
// missing (the repo pattern).

import fs from "node:fs";
import os from "node:os";
import url from "node:url";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { ensure_gram_bytes } from "./helpers.js";
import {
    ctl_base_for, ctl_pages,
    CTL_VCPU_STRIDE, CTL_IPI_SPECIAL,
    CTL_RUN_STATE_RUNNABLE, CTL_RUN_STATE_PARKED, CTL_RUN_STATE_HALTED,
    CTL_RUN_STATE_WAIT_FOR_SIPI,
    CTL_COMMAND_TERMINATE,
    doorbell_post, run_state_read, command_write,
    mailbox_record_word, mailbox_service, mailbox_wait_for_request,
    MAILBOX_OP_PIC_ACK,
} from "../../src/browser/smpctl.js";

process.on("unhandledRejection", exn => { throw exn; });

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "/../..";

const MEMORY_SIZE = 16 * 1024 * 1024;
const TOTAL_CPUS = 2;
const TRIALS = +process.env.TSO_TRIALS || 1_000_000;

// Raced cells and barriers on distinct 64-byte lines; histograms and done
// counters far away. MP and SB use disjoint everything so phase 2 never
// sees phase-1 residue.
const MP = {
    x: 0x1040, y: 0x1080, bar_a: 0x10C0, bar_b: 0x1100, go: 0x1140,
    hist: 0x2000, done: 0x2100,
};
const SB = {
    x: 0x3040, y: 0x3080, bar_a: 0x30C0, bar_b: 0x3100, go: 0x3140,
    res1: 0x3180, hist: 0x4000, done: 0x2110,
};
const MP_READER_VECTOR = 0x9B;      // AP entry page for phase 1
const SB_VECTORS = [0x10, 0x11];    // phase-2 entry pages (P0, P1)
// ipi_special encoding (smpctl.rs): INIT bit 0, SIPI bit 1, vector << 8
const IPI_INIT_BIT = 1;
const IPI_SIPI_BIT = 2;

// ---- tiny flat assembler: byte emission + short/near label patching ----

function asm()
{
    const bytes = [];
    const labels = new Map();
    const patches = [];
    return {
        db(...vs) { bytes.push(...vs); },
        d16(v) { bytes.push(v & 0xFF, v >> 8 & 0xFF); },
        d32(v) { bytes.push(v & 0xFF, v >> 8 & 0xFF, v >> 16 & 0xFF, v >>> 24); },
        label(name)
        {
            assert(!labels.has(name), "duplicate label " + name);
            labels.set(name, bytes.length);
        },
        // short jcc (rel8)
        jcc(opcode, name)
        {
            bytes.push(opcode, 0);
            patches.push({ at: bytes.length - 1, name, near: false });
        },
        // near jcc (0F cc rel16, 16-bit mode)
        jcc_near(cc, name)
        {
            bytes.push(0x0F, cc, 0, 0);
            patches.push({ at: bytes.length - 2, name, near: true });
        },
        end()
        {
            for(const p of patches)
            {
                const target = labels.get(p.name);
                assert(target !== undefined, "undefined label " + p.name);
                const rel = target - (p.at + (p.near ? 2 : 1));
                if(p.near)
                {
                    bytes[p.at] = rel & 0xFF;
                    bytes[p.at + 1] = rel >> 8 & 0xFF;
                }
                else
                {
                    assert(rel >= -128 && rel < 128, "short jump out of range");
                    bytes[p.at] = rel & 0xFF;
                }
            }
            return bytes;
        },
    };
}

// mov sp, imm16; spin until [go] != 0 (plain — only stores follow, and
// stores never speculate past the unresolved exit branch); ebp = barrier
// sense counter; ecx = trial counter
function emit_prologue(a, { sp, go })
{
    a.db(0xBC); a.d16(sp);                      // mov sp, imm16
    a.label("wait_go");
    a.db(0x66, 0xA1); a.d16(go);                // mov eax, [go]
    a.db(0x66, 0x85, 0xC0);                     // test eax, eax
    a.jcc(0x74, "wait_go");                     // jz wait_go
    a.db(0x66, 0x31, 0xED);                     // xor ebp, ebp
    a.db(0x66, 0xB9); a.d32(TRIALS);            // mov ecx, TRIALS
    a.label("trial");
    a.db(0x66, 0x83, 0xC5, 0x02);               // add ebp, 2
}

// arrive with a seq-cst inc, leave through a seq-cst read spin: lock xadd
// with eax=0 returns the current value with acquire/release semantics, so
// everything after the barrier is ordered after everything the peer
// published before its own inc. Clobbers eax.
function emit_barrier(a, cell, name)
{
    a.db(0xF0, 0x66, 0xFF, 0x06); a.d16(cell);          // lock inc dword [cell]
    a.label(name);
    a.db(0x66, 0x31, 0xC0);                             // xor eax, eax
    a.db(0xF0, 0x66, 0x0F, 0xC1, 0x06); a.d16(cell);    // lock xadd [cell], eax
    a.db(0x66, 0x39, 0xE8);                             // cmp eax, ebp
    a.jcc(0x7C, name);                                  // jl -> spin
}

// eax = 2*eax + edx (both masked to 1); lock inc dword [hist + 4*eax]
function emit_record(a, hist)
{
    a.db(0x66, 0x83, 0xE0, 0x01);               // and eax, 1
    a.db(0x66, 0x83, 0xE2, 0x01);               // and edx, 1
    a.db(0x66, 0x01, 0xC0);                     // add eax, eax
    a.db(0x66, 0x01, 0xD0);                     // add eax, edx
    a.db(0x66, 0xC1, 0xE0, 0x02);               // shl eax, 2
    a.db(0x89, 0xC3);                           // mov bx, ax
    a.db(0xF0, 0x66, 0xFF, 0x87); a.d16(hist);  // lock inc dword [bx+hist]
}

function emit_store32(a, addr, value)
{
    a.db(0x66, 0xC7, 0x06); a.d16(addr); a.d32(value);  // mov dword [addr], imm32
}

// dec ecx; jnz trial; inc dword [done]; cli; hlt
function emit_epilogue(a, done)
{
    a.db(0x66, 0x49);                           // dec ecx
    a.jcc_near(0x85, "trial");                  // jnz trial
    a.db(0x66, 0xFF, 0x06); a.d16(done);        // inc dword [done]
    a.db(0xFA, 0xF4);                           // cli; hlt
}

// MP writer (P0): barrier A; x=1; y=1; barrier B
function mp_writer()
{
    const a = asm();
    emit_prologue(a, { sp: 0x100, go: MP.go });
    emit_barrier(a, MP.bar_a, "bar_a");
    emit_store32(a, MP.x, 1);
    emit_store32(a, MP.y, 1);
    emit_barrier(a, MP.bar_b, "bar_b");
    emit_epilogue(a, MP.done);
    return a.end();
}

// MP reader (P1): barrier A; r1=y; r2=x; record; barrier B; reset x,y.
// The resets are the reader's own, so its next-trial loads can never see a
// stale value from an earlier trial — only 0 or the writer's fresh 1.
function mp_reader()
{
    const a = asm();
    emit_prologue(a, { sp: 0x300, go: MP.go });
    emit_barrier(a, MP.bar_a, "bar_a");
    a.db(0x66, 0xA1); a.d16(MP.y);              // mov eax, [y]   (r1)
    a.db(0x66, 0x8B, 0x16); a.d16(MP.x);        // mov edx, [x]   (r2)
    emit_record(a, MP.hist);
    emit_barrier(a, MP.bar_b, "bar_b");
    emit_store32(a, MP.x, 0);
    emit_store32(a, MP.y, 0);
    emit_epilogue(a, MP.done + 4);
    return a.end();
}

// SB P0 (collector): barrier A; x=1; r1=y (kept in edi across the barrier
// spin, which clobbers eax); barrier B (acquire — orders the res1 read
// after P1's release-inc); r2=[res1]; record; reset x, y, res1.
function sb_p0()
{
    const a = asm();
    emit_prologue(a, { sp: 0x100, go: SB.go });
    emit_barrier(a, SB.bar_a, "bar_a");
    emit_store32(a, SB.x, 1);
    a.db(0x66, 0xA1); a.d16(SB.y);              // mov eax, [y]   (r1)
    a.db(0x66, 0x89, 0xC7);                     // mov edi, eax
    emit_barrier(a, SB.bar_b, "bar_b");
    a.db(0x66, 0x8B, 0x16); a.d16(SB.res1);     // mov edx, [res1] (r2)
    a.db(0x66, 0x89, 0xF8);                     // mov eax, edi
    emit_record(a, SB.hist);
    emit_store32(a, SB.x, 0);
    emit_store32(a, SB.y, 0);
    emit_store32(a, SB.res1, 0);
    emit_epilogue(a, SB.done);
    return a.end();
}

// SB P1: barrier A; y=1; r2=x; publish r2 into res1 (plain store — the
// barrier-B lock inc is its release edge); barrier B.
function sb_p1()
{
    const a = asm();
    emit_prologue(a, { sp: 0x300, go: SB.go });
    emit_barrier(a, SB.bar_a, "bar_a");
    emit_store32(a, SB.y, 1);
    a.db(0x66, 0x8B, 0x16); a.d16(SB.x);        // mov edx, [x]   (r2)
    a.db(0x66, 0x89, 0x16); a.d16(SB.res1);     // mov [res1], edx
    emit_barrier(a, SB.bar_b, "bar_b");
    emit_epilogue(a, SB.done + 4);
    return a.end();
}

function post_ipi_special(i32, ctl_base, i, bits)
{
    Atomics.or(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_IPI_SPECIAL >> 2, bits);
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

function read_histogram(i32, base)
{
    // outcome index r1*2 + r2; read after both vCPUs published Parked
    // (their seq-cst run-state stores order the plain guest bytes)
    return [0, 1, 2, 3].map(idx => Atomics.load(i32, base + 4 * idx >> 2) >>> 0);
}

function report(label, hist, names)
{
    const total = hist.reduce((sum, n) => sum + n, 0);
    console.log(`${label}: ${TRIALS} trials on ${os.arch()} (${os.cpus()[0].model})`);
    for(let idx = 0; idx < 4; idx++)
    {
        console.log(`  r1=${idx >> 1} r2=${idx & 1}  ${hist[idx]}  ${names[idx] || ""}`);
    }
    assert.equal(total, TRIALS, `${label}: histogram must sum to the trial count`);
    return hist;
}

// One full machine lifecycle under the given memory model: spawn both
// vCPU workers over a fresh shared memory, run MP then SB, terminate.
async function run_litmus(memory_model)
{
    const multimem_wasm = ROOT + "/build/v86-multimem-debug.wasm";
    const guest_pages = MEMORY_SIZE / 0x10000 + 1 + ctl_pages(TOTAL_CPUS, MEMORY_SIZE);
    const guest_memory = new WebAssembly.Memory(
        { initial: guest_pages, maximum: guest_pages, shared: true });
    const ctl_base = ctl_base_for(MEMORY_SIZE);
    const i32 = new Int32Array(guest_memory.buffer);
    const mem8 = new Uint8Array(guest_memory.buffer);

    // guest image: reset vector -> MP writer at F0000; the MP reader and
    // both SB programs are entered at their architectural SIPI entry
    // points (linear vector << 12 — the W4 worker consume)
    mem8.set([0xEA, 0x00, 0x00, 0x00, 0xF0], 0xFFFF0);          // ljmp F000:0000
    mem8.set(mp_writer(), 0xF0000);
    mem8.set(mp_reader(), MP_READER_VECTOR << 12);
    mem8.set(sb_p0(), SB_VECTORS[0] << 12);
    mem8.set(sb_p1(), SB_VECTORS[1] << 12);

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
            // jit on unless the suite says otherwise: the litmus verdict
            // is about the JIT's plain-access lowering running hot
            vcpu: {
                acpi: true,
                disable_jit: +process.env.DISABLE_JIT,
                memory_model,
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

    // ---- MP ----
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
    post_ipi_special(i32, ctl_base, 1,
        IPI_INIT_BIT | IPI_SIPI_BIT | MP_READER_VECTOR << 8);
    await wait_for("AP running after SIPI", () =>
    {
        check_errors();
        return state(1) === CTL_RUN_STATE_RUNNABLE;
    }, 60_000);

    const mp_start = performance.now();
    Atomics.store(i32, MP.go >> 2, 1);
    await wait_for("MP loops done", () =>
    {
        check_errors();
        return Atomics.load(i32, MP.done >> 2) === 1 &&
            Atomics.load(i32, MP.done + 4 >> 2) === 1;
    }, 480_000);
    await wait_for("both parked after MP", () =>
        state(0) === CTL_RUN_STATE_PARKED && state(1) === CTL_RUN_STATE_PARKED, 60_000);
    const mp_secs = (performance.now() - mp_start) / 1000;
    const mp_hist = report(
        `MP histogram [${memory_model}] (P0: x=1;y=1  P1: r1=y;r2=x)`,
        read_histogram(i32, MP.hist), {
            0: "(reader ran first)",
            1: "(reader interleaved)",
            2: "*** x86-FORBIDDEN (r1=1, r2=0) ***",
            3: "(writer ran first)",
        });

    // ---- SB (INIT/SIPI both vCPUs into the SB programs) ----
    post_ipi_special(i32, ctl_base, 0, IPI_INIT_BIT | IPI_SIPI_BIT | SB_VECTORS[0] << 8);
    post_ipi_special(i32, ctl_base, 1, IPI_INIT_BIT | IPI_SIPI_BIT | SB_VECTORS[1] << 8);
    await wait_for("both running SB programs", () =>
    {
        check_errors();
        return state(0) === CTL_RUN_STATE_RUNNABLE && state(1) === CTL_RUN_STATE_RUNNABLE;
    }, 60_000);
    const sb_start = performance.now();
    Atomics.store(i32, SB.go >> 2, 1);
    await wait_for("SB loops done", () =>
    {
        check_errors();
        return Atomics.load(i32, SB.done >> 2) === 1 &&
            Atomics.load(i32, SB.done + 4 >> 2) === 1;
    }, 480_000);
    await wait_for("both parked after SB", () =>
        state(0) === CTL_RUN_STATE_PARKED && state(1) === CTL_RUN_STATE_PARKED, 60_000);
    const sb_secs = (performance.now() - sb_start) / 1000;
    const sb_hist = report(
        `SB histogram [${memory_model}] (P0: x=1;r1=y  P1: y=1;r2=x)`,
        read_histogram(i32, SB.hist), {
            0: "x86-ALLOWED relaxation (both store-buffered)",
        });
    console.log(`[${memory_model}] MP ${mp_secs.toFixed(1)} s, SB ${sb_secs.toFixed(1)} s`);

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
    return { mp_hist, sb_hist };
}

async function main()
{
    if(!fs.existsSync(ROOT + "/build/v86-multimem-debug.wasm"))
    {
        console.log("Missing build/v86-multimem-debug.wasm, test skipped");
        process.exit(0);
    }
    const watchdog = setTimeout(() =>
    {
        throw new Error("tso-litmus: global 900s timeout");
    }, 900_000);

    // ---- pass 1: the relaxed default — the §5 record ----
    const relaxed = await run_litmus("relaxed");
    const detection_power = relaxed.sb_hist[0] > 0;
    if(!detection_power)
    {
        console.log("INCONCLUSIVE: the allowed SB relaxation was never observed under " +
            "\"relaxed\" — this host/run cannot distinguish the memory models " +
            "(expected under DISABLE_JIT or on TSO hosts)");
    }
    else
    {
        console.log(`relaxed: SB relaxation ${relaxed.sb_hist[0]}/${TRIALS} ` +
            `(${(100 * relaxed.sb_hist[0] / TRIALS).toFixed(2)} %) — detection power ` +
            `confirmed; x86-forbidden MP outcome ${relaxed.mp_hist[2]}/${TRIALS} ` +
            "(the documented exposure of the relaxed default — recorded, not a failure)");
    }

    // ---- pass 2: the fenced escape hatch must close the window ----
    const fenced = await run_litmus("fenced");
    assert.equal(fenced.mp_hist[2], 0,
        `smp_memory_model "fenced" must forbid the MP outcome ` +
        `(observed ${fenced.mp_hist[2]}/${TRIALS} on ${os.arch()})`);
    if(detection_power)
    {
        console.log(`fenced: x86-forbidden MP outcome 0/${TRIALS} — the escape hatch ` +
            "restores guest TSO on this host (against confirmed detection power)");
    }
    else
    {
        console.log(`fenced: x86-forbidden MP outcome 0/${TRIALS} (vacuous on this ` +
            "host/run: no detection power)");
    }

    clearTimeout(watchdog);
    console.log("Tests passed");
    process.exit(0);
}

await main();
