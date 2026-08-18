#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W5 (docs/smp-phase4-design.md §9 W5): Layer C item 2
// — the GUEST-DRIVEN INVLPG/IPI TLB-shootdown storm across real workers,
// completing the harness-driven slice W3 landed (vcpu-workers-lock.js).
// Two vCPUs in per-vCPU workers run a hand-assembled protected-mode+paging
// guest:
//
//   vCPU A (BSP)  round r: writes marker r into the physical page about to
//     be mapped, rewrites the live PTE of VA 0x800000 (alternating between
//     two frames), and sends a fixed IPI (vector 0xFD) to B through its
//     OWN LAPIC ICR — the guest-driven write_icr0_shared -> pending-bitmap
//     -> doorbell wire; then waits for B's ack and asserts the acked value
//     is EXACTLY r.
//   vCPU B (AP)   sits in a sti;hlt loop; the IDT handler executes
//     INVLPG [0x800000] (its own private TLB — the §6 shootdown contract:
//     the target invalidates in its handler), reads the VA through the
//     fresh translation, publishes the value, EOIs, and irets.
//
//   A stale translation — B reading through a TLB entry that predates the
//   remap — returns the OTHER frame's marker (r-1 or the poison pattern),
//   caught by A's exact-match check the same round. B's TLB entry is HOT
//   at every remap: round r's handler read caches the translation that
//   round r+1's INVLPG must flush, so the invalidation is never vacuous.
//
// Cross-worker visibility edges are all locked/seq-cst (A's PTE write is
// published by the seq-cst IPI post; B's value by a lock-inc'd ack counter
// that A reads with a lock-xadd acquire spin), so the assertion isolates
// TLB semantics from the §5 memory-model question and holds under the
// default relaxed model.
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
const ROUNDS = +process.env.INVLPG_ROUNDS || 10_000;

// physical layout (all inside the 0-4 MiB identity 4M page except VA)
const GDT = 0x500;          // null, 0x08 code32 flat, 0x10 data32 flat
const GDTR = 0x520;         // 6-byte pseudo-descriptor
const IDTR = 0x528;
const IDT = 0x1000;         // 256 gates
const VECTOR = 0xFD;        // the shootdown vector
const PD = 0x100000;        // page directory (cr3)
const PT = 0x101000;        // page table behind PDE[2]
const P1 = 0x300000;        // frame A (odd rounds)
const P2 = 0x301000;        // frame B (even rounds; also the initial map)
const VA = 0x800000;        // the remapped virtual address (PDE 2, PTE 0)
// control cells (identity-mapped low memory)
const ACK_COUNT = 0x2000;
const ACK_VAL = 0x2004;
const BSP_DONE = 0x2010;
const B_READY = 0x2014;
const FAIL_FLAG = 0x2018;
const BAD_VAL = 0x2020;
const BAD_ROUND = 0x2024;
const AP_VECTOR = 0x9C;     // AP SIPI entry page
const HANDLER = 0x9D000;    // the 32-bit IDT handler, assembled separately
const BSP_ESP = 0x9F000;
const AP_ESP = 0x9E000;
// ipi_special encoding (smpctl.rs): INIT bit 0, SIPI bit 1, vector << 8
const IPI_INIT_BIT = 1;
const IPI_SIPI_BIT = 2;

// ---- tiny flat assembler (org-aware: labels resolve to absolute
// addresses for far jumps and gates) ----

function asm(org)
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
        // absolute 32-bit address of a label (for ptr16:32 far jumps)
        d32_label(name)
        {
            patches.push({ at: bytes.length, name, abs: true });
            bytes.push(0, 0, 0, 0);
        },
        // short jcc/jmp (rel8)
        jcc(opcode, name)
        {
            bytes.push(opcode, 0);
            patches.push({ at: bytes.length - 1, name, abs: false });
        },
        end()
        {
            for(const p of patches)
            {
                const target = labels.get(p.name);
                assert(target !== undefined, "undefined label " + p.name);
                if(p.abs)
                {
                    const abs = org + target;
                    bytes[p.at] = abs & 0xFF;
                    bytes[p.at + 1] = abs >> 8 & 0xFF;
                    bytes[p.at + 2] = abs >> 16 & 0xFF;
                    bytes[p.at + 3] = abs >>> 24;
                }
                else
                {
                    const rel = target - (p.at + 1);
                    assert(rel >= -128 && rel < 128, "short jump out of range");
                    bytes[p.at] = rel & 0xFF;
                }
            }
            return bytes;
        },
    };
}

// real-mode entry -> flat 32-bit protected mode with paging + IDT; falls
// through into 32-bit code following the "prot32" label
function emit_protected_setup(a, esp)
{
    // 16-bit real mode
    a.db(0xFA);                                     // cli
    a.db(0x66, 0x0F, 0x01, 0x16); a.d16(GDTR);      // o32 lgdt [GDTR]
    a.db(0x0F, 0x20, 0xC0);                         // mov eax, cr0
    a.db(0x66, 0x83, 0xC8, 0x01);                   // or eax, 1
    a.db(0x0F, 0x22, 0xC0);                         // mov cr0, eax
    a.db(0x66, 0xEA); a.d32_label("prot32"); a.d16(0x08); // ljmp 08:prot32
    a.label("prot32");
    // 32-bit protected mode
    a.db(0x66, 0xB8, 0x10, 0x00);                   // mov ax, 0x10
    a.db(0x8E, 0xD8);                               // mov ds, ax
    a.db(0x8E, 0xC0);                               // mov es, ax
    a.db(0x8E, 0xD0);                               // mov ss, ax
    a.db(0xBC); a.d32(esp);                         // mov esp, imm32
    a.db(0x0F, 0x20, 0xE0);                         // mov eax, cr4
    a.db(0x83, 0xC8, 0x10);                         // or eax, 0x10 (PSE)
    a.db(0x0F, 0x22, 0xE0);                         // mov cr4, eax
    a.db(0xB8); a.d32(PD);                          // mov eax, PD
    a.db(0x0F, 0x22, 0xD8);                         // mov cr3, eax
    a.db(0x0F, 0x20, 0xC0);                         // mov eax, cr0
    a.db(0x0D); a.d32(0x80000000);                  // or eax, 0x80000000 (PG)
    a.db(0x0F, 0x22, 0xC0);                         // mov cr0, eax
    a.db(0x0F, 0x01, 0x1D); a.d32(IDTR);            // lidt [IDTR]
}

// vCPU A: the remap/IPI/verify loop (32-bit)
function bsp_program()
{
    const a = asm(0xF0000);
    emit_protected_setup(a, BSP_ESP);
    // LAPIC software-enable (spurious vector register) before ICR sends
    a.db(0xC7, 0x05); a.d32(0xFEE000F0); a.d32(0x1FF);
    // wait for B: lock-xadd acquire spin on B_READY >= 1
    a.label("wait_b");
    a.db(0x31, 0xC0);                               // xor eax, eax
    a.db(0xF0, 0x0F, 0xC1, 0x05); a.d32(B_READY);   // lock xadd [B_READY], eax
    a.db(0x85, 0xC0);                               // test eax, eax
    a.jcc(0x74, "wait_b");                          // jz wait_b
    a.db(0xBB, 0x01, 0x00, 0x00, 0x00);             // mov ebx, 1 (round)
    a.label("round");
    // edx = frame for this round: P1 if odd, P2 if even
    a.db(0xBA); a.d32(P2);                          // mov edx, P2
    a.db(0xF7, 0xC3); a.d32(1);                     // test ebx, 1
    a.jcc(0x74, "even");                            // jz even
    a.db(0xBA); a.d32(P1);                          // mov edx, P1
    a.label("even");
    a.db(0x89, 0x1A);                               // mov [edx], ebx (marker = r)
    a.db(0x8D, 0x42, 0x03);                         // lea eax, [edx+3] (PTE bits P|RW)
    a.db(0xA3); a.d32(PT);                          // mov [PT+0], eax (the remap)
    // fixed IPI vector 0xFD to APIC ID 1 through the LOCAL APIC ICR
    a.db(0xC7, 0x05); a.d32(0xFEE00310); a.d32(1 << 24);    // ICR high: dest 1
    a.db(0xC7, 0x05); a.d32(0xFEE00300); a.d32(VECTOR);     // ICR low: fixed 0xFD
    // wait for the ack: lock-xadd acquire spin until ACK_COUNT >= r
    a.label("wait_ack");
    a.db(0x31, 0xC0);                               // xor eax, eax
    a.db(0xF0, 0x0F, 0xC1, 0x05); a.d32(ACK_COUNT); // lock xadd [ACK_COUNT], eax
    a.db(0x39, 0xD8);                               // cmp eax, ebx
    a.jcc(0x7C, "wait_ack");                        // jl wait_ack
    a.jcc(0x75, "fail");                            // jne fail (count overshoot)
    // the acked value must be exactly this round's marker
    a.db(0xA1); a.d32(ACK_VAL);                     // mov eax, [ACK_VAL]
    a.db(0x39, 0xD8);                               // cmp eax, ebx
    a.jcc(0x75, "fail");                            // jne fail (STALE TRANSLATION)
    a.db(0x43);                                     // inc ebx
    a.db(0x81, 0xFB); a.d32(ROUNDS);                // cmp ebx, ROUNDS
    a.jcc(0x7E, "round");                           // jle round
    a.db(0xF0, 0xFF, 0x05); a.d32(BSP_DONE);        // lock inc [BSP_DONE]
    a.db(0xFA, 0xF4);                               // cli; hlt
    a.label("fail");
    a.db(0xA3); a.d32(BAD_VAL);                     // mov [BAD_VAL], eax
    a.db(0x89, 0x1D); a.d32(BAD_ROUND);             // mov [BAD_ROUND], ebx
    a.db(0xF0, 0xFF, 0x05); a.d32(FAIL_FLAG);       // lock inc [FAIL_FLAG]
    a.db(0xFA, 0xF4);                               // cli; hlt
    return a.end();
}

// vCPU B: protected-mode setup, publish readiness, sti;hlt idle loop (the
// handler below does the per-round work)
function ap_program()
{
    const a = asm(AP_VECTOR << 12);
    emit_protected_setup(a, AP_ESP);
    // LAPIC software-enable (spurious vector register)
    a.db(0xC7, 0x05); a.d32(0xFEE000F0); a.d32(0x1FF);
    a.db(0xF0, 0xFF, 0x05); a.d32(B_READY);         // lock inc [B_READY]
    a.db(0xFB);                                     // sti
    a.label("idle");
    a.db(0xF4);                                     // hlt
    a.jcc(0xEB, "idle");                            // jmp idle
    return a.end();
}

// the vector-0xFD handler: invalidate the private TLB entry, read through
// the fresh translation, publish, EOI, iret
function handler_program()
{
    const a = asm(HANDLER);
    a.db(0x0F, 0x01, 0x3D); a.d32(VA);              // invlpg [VA]
    a.db(0xA1); a.d32(VA);                          // mov eax, [VA]
    a.db(0xA3); a.d32(ACK_VAL);                     // mov [ACK_VAL], eax
    a.db(0xF0, 0xFF, 0x05); a.d32(ACK_COUNT);       // lock inc [ACK_COUNT]
    a.db(0xC7, 0x05); a.d32(0xFEE000B0); a.d32(0);  // EOI
    a.db(0xCF);                                     // iretd
    return a.end();
}

function build_tables(mem8, dview)
{
    // GDT: null, 0x08 flat code32, 0x10 flat data32
    mem8.set([0xFF, 0xFF, 0, 0, 0, 0x9A, 0xCF, 0], GDT + 8);
    mem8.set([0xFF, 0xFF, 0, 0, 0, 0x92, 0xCF, 0], GDT + 16);
    // GDTR/IDTR pseudo-descriptors
    dview.setUint16(GDTR, 23, true);
    dview.setUint32(GDTR + 2, GDT, true);
    dview.setUint16(IDTR, 0x7FF, true);
    dview.setUint32(IDTR + 2, IDT, true);
    // IDT gate for VECTOR: offset HANDLER, selector 0x08, 32-bit intr gate
    const gate = IDT + 8 * VECTOR;
    dview.setUint16(gate, HANDLER & 0xFFFF, true);
    dview.setUint16(gate + 2, 0x08, true);
    dview.setUint16(gate + 4, 0x8E00, true);
    dview.setUint16(gate + 6, HANDLER >>> 16, true);
    // paging: PDE[0] identity 4M (guest RAM low), PDE[2] -> PT (the VA),
    // PDE[0x3FB] identity 4M over the APIC MMIO window
    dview.setUint32(PD, 0x83, true);
    dview.setUint32(PD + 4 * 2, PT | 3, true);
    dview.setUint32(PD + 4 * 0x3FB, 0xFEC00000 | 0x83, true);
    // PT[0]: VA initially maps the even frame
    dview.setUint32(PT, P2 | 3, true);
    // poison markers so a protocol bug reads distinctively
    dview.setUint32(P1, 0xAAAAAAAA, true);
    dview.setUint32(P2, 0xBBBBBBBB, true);
}

function post_ipi_special(i32, ctl_base, i, bits)
{
    Atomics.or(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_IPI_SPECIAL >>> 2, bits);
    doorbell_post(i32, ctl_base, i);
}

// Defensive device host: the guest performs no port I/O, but any stray RPC
// must be answered or the worker deadlocks (fail via the assert).
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
        throw new Error("invlpg-storm: global 600s timeout");
    }, 600_000);

    const guest_pages = MEMORY_SIZE / 0x10000 + 1 + ctl_pages(TOTAL_CPUS, MEMORY_SIZE);
    const guest_memory = new WebAssembly.Memory(
        { initial: guest_pages, maximum: guest_pages, shared: true });
    const ctl_base = ctl_base_for(MEMORY_SIZE);
    const i32 = new Int32Array(guest_memory.buffer);
    const mem8 = new Uint8Array(guest_memory.buffer);
    const dview = new DataView(guest_memory.buffer);

    build_tables(mem8, dview);
    mem8.set([0xEA, 0x00, 0x00, 0x00, 0xF0], 0xFFFF0);          // ljmp F000:0000
    mem8.set(bsp_program(), 0xF0000);
    mem8.set(ap_program(), AP_VECTOR << 12);
    mem8.set(handler_program(), HANDLER);

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
            // acpi on: the APIC leg delivers the shootdown vector
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
    post_ipi_special(i32, ctl_base, 1, IPI_INIT_BIT | IPI_SIPI_BIT | AP_VECTOR << 8);

    const start = performance.now();
    await wait_for("storm finished", () =>
    {
        check_errors();
        if(Atomics.load(i32, FAIL_FLAG >>> 2) !== 0)
        {
            assert.fail("STALE TRANSLATION: round " +
                (Atomics.load(i32, BAD_ROUND >>> 2) >>> 0) + " acked 0x" +
                (Atomics.load(i32, BAD_VAL >>> 2) >>> 0).toString(16) +
                " (ack count " + (Atomics.load(i32, ACK_COUNT >>> 2) >>> 0) + ")");
        }
        return Atomics.load(i32, BSP_DONE >>> 2) === 1;
    }, 480_000);
    const secs = (performance.now() - start) / 1000;
    assert.equal(Atomics.load(i32, ACK_COUNT >>> 2), ROUNDS, "every round acked exactly once");
    await wait_for("BSP parked", () => state(0) === CTL_RUN_STATE_PARKED, 60_000);
    console.log(`${ROUNDS} guest-driven remap+INVLPG+IPI rounds, zero stale ` +
        `translations, every IPI delivered exactly once (${secs.toFixed(1)} s, ` +
        `${(1000 * secs / ROUNDS * 1000).toFixed(0)} us/round)`);

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
