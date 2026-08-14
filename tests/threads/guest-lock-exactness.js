#!/usr/bin/env node

// XWAH-9 Phase 4 Stage L1 headline gate (docs/smp-phase4-design.md §5/§9):
// guest LOCK-prefixed RMW vs a concurrent JS thread, exact to the last
// increment. The multimem build runs a hand-written real-mode program that
// hammers a guest RAM cell with locked RMWs while a worker_threads Worker
// races Atomics.add on the SAME cell through the SharedArrayBuffer view of
// the imported guest memory. Locked interpreter RMWs lower to gram.wasm's
// seq-cst wasm atomics, so the final cell value must be EXACTLY
// guest_iterations + js_adds — any torn or lost update fails the test
// (tests/threads/plain-race-vs-atomic.js demonstrates that plain RMWs lose
// updates under this contention pattern with overwhelming probability).
//
// Interpreter phases (fresh machine each, JIT disabled via set_jit_config
// so the loop stays on the Stage L1 interpreter paths):
//   A. `lock inc dword [cell]`      — safe_read_write32 CAS loop
//   B. `lock xadd [cell], ebx`      — CAS loop with a register-writing
//                                     closure (exercises the retry
//                                     snapshot/rollback machinery)
//   B'. `lock xadd [cell], bl`      — byte form 0FC0: safe_read_write8 CAS
//                                     (and, under JIT, the non-custom
//                                     interpreter-call path; totals mod 256)
//   C. `lock cmpxchg8b [cell8]`     — gram_atomic_rmw_cmpxchg_64, with the
//                                     JS contender on a BigInt64Array view
//   D. `lock inc dword [0xFFF]`     — page-crossing target: interim
//                                     bus-lock fallback (guest-only; the
//                                     cell must advance exactly N)
//
// JIT phases (Stage L2): the same programs re-run with a REAL
// codegen_finalize (the Stage 4 proof-of-life implementation: validate,
// instantiate over the same two memories, install into the table) and the
// loop page force-compiled through the debug-only jit_force_generate_unsafe
// export BEFORE the first main_loop, so every guest iteration executes the
// compiled wasm CAS loop / locked slow path. Compiled execution is
// evidenced by generation tracking (assert_compiled_evidence): every
// codegen_finalize covered the code page, every jit_clear_func was of a
// superseded own generation (recompiles with a larger entry-point set are
// expected on long runs), and the final generation was still installed at
// the end — installed hot code is unconditionally entered by the dispatch
// loop.
//
// The machine harness follows the Stage 4 proof-of-life pattern (manual
// instantiation, env stubs from starter.js wasm_shared_funcs); the
// cross-thread shape follows tests/threads/multimem-instance.js (Layer B).

import url from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

process.on("unhandledRejection", exn => { throw exn; });

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = __dirname + "/../..";

const MEMORY_SIZE = 64 * 1024 * 1024;
const WASM_PAGE = 64 * 1024;
const GUEST_PAGES = MEMORY_SIZE / WASM_PAGE + 1; // + JIT scratch page
const WASM_TABLE_SIZE = 900; // src/const.js
const WASM_TABLE_OFFSET = 1024; // src/rust/cpu/cpu.rs

const CODE = 0xF0000;   // real-mode CS base after reset
const CELL = 0x1000;    // 4- and 8-aligned guest cell both sides hammer
const FLAG = 0x2000;    // guest sets one byte here when its loop is done
const PARK = 0x3000;    // always-zero cell the worker parks on (1 ms waits)
const CROSS = 0xFFF;    // page-crossing dword target for the bus-lock phase

const GUEST_ITERATIONS = 200_000;
const CROSS_ITERATIONS = 50_000;
const WORKER_BURST = 512;
const TIMEOUT_MS = 120_000;

function le32(n)
{
    return [n & 0xFF, n >> 8 & 0xFF, n >> 16 & 0xFF, n >>> 24];
}

// mov ecx, N; loop: lock inc dword [cell]; dec ecx; jnz loop;
// mov byte [FLAG], 1; hlt
function program_lock_inc(n, cell)
{
    return [
        0x66, 0xB9, ...le32(n),                         // mov ecx, n
        0xF0, 0x66, 0xFF, 0x06, ...le32(cell).slice(0, 2), // lock inc dword [cell]
        0x66, 0x49,                                     // dec ecx
        0x75, 0xF6,                                     // jnz $-10
        0xC6, 0x06, ...le32(FLAG).slice(0, 2), 0x01,    // mov byte [FLAG], 1
        0xF4,                                           // hlt
    ];
}

// mov ecx, N; loop: mov ebx, 1; lock xadd [cell], ebx; dec ecx; jnz loop;
// mov byte [FLAG], 1; hlt
function program_lock_xadd(n)
{
    return [
        0x66, 0xB9, ...le32(n),                         // mov ecx, n
        0x66, 0xBB, 0x01, 0x00, 0x00, 0x00,             // mov ebx, 1
        0xF0, 0x66, 0x0F, 0xC1, 0x1E, 0x00, 0x10,       // lock xadd [0x1000], ebx
        0x66, 0x49,                                     // dec ecx
        0x75, 0xEF,                                     // jnz $-17
        0xC6, 0x06, ...le32(FLAG).slice(0, 2), 0x01,    // mov byte [FLAG], 1
        0xF4,                                           // hlt
    ];
}

// mov ecx, N; loop: mov bl, 1; lock xadd [cell], bl; dec ecx; jnz loop;
// flag; hlt — byte form 0FC0, the non-custom interpreter call from JIT'd
// code: under compiled execution atomicity comes from the
// jit_lock_interp_mem_call! runtime-prefix bracket (Stage L2) routing the
// body into L1's byte CAS. bl is reloaded every iteration because XADD
// writes the old memory value back into it.
function program_lock_xadd8(n)
{
    return [
        0x66, 0xB9, ...le32(n),                         // mov ecx, n
        0xB3, 0x01,                                     // mov bl, 1
        0xF0, 0x0F, 0xC0, 0x1E, ...le32(CELL).slice(0, 2), // lock xadd [cell], bl
        0x66, 0x49,                                     // dec ecx
        0x75, 0xF4,                                     // jnz $-12
        0xC6, 0x06, ...le32(FLAG).slice(0, 2), 0x01,    // mov byte [FLAG], 1
        0xF4,                                           // hlt
    ];
}

// EDX:EAX = [cell8]; esi = N;
// retry: ECX:EBX = EDX:EAX + 1; lock cmpxchg8b [cell8]; jnz retry
// (mismatch reloads EDX:EAX); dec esi; jnz retry; flag; hlt
function program_lock_cmpxchg8b(n)
{
    return [
        0x66, 0x31, 0xC0,                               // xor eax, eax
        0x66, 0x31, 0xD2,                               // xor edx, edx
        0x66, 0xA1, 0x00, 0x10,                         // mov eax, [0x1000]
        0x66, 0x8B, 0x16, 0x04, 0x10,                   // mov edx, [0x1004]
        0x66, 0xBE, ...le32(n),                         // mov esi, n
        0x66, 0x89, 0xC3,                               // mov ebx, eax
        0x66, 0x89, 0xD1,                               // mov ecx, edx
        0x66, 0x83, 0xC3, 0x01,                         // add ebx, 1
        0x66, 0x83, 0xD1, 0x00,                         // adc ecx, 0
        0xF0, 0x0F, 0xC7, 0x0E, 0x00, 0x10,             // lock cmpxchg8b [0x1000]
        0x75, 0xEA,                                     // jnz retry ($-22)
        0x66, 0x4E,                                     // dec esi
        0x75, 0xE6,                                     // jnz retry ($-26)
        0xC6, 0x06, ...le32(FLAG).slice(0, 2), 0x01,    // mov byte [FLAG], 1
        0xF4,                                           // hlt
    ];
}

function worker_main()
{
    // JS contender: bursts of seq-cst adds on the shared guest cell, with a
    // 1 ms park between bursts so the guest's CAS loops always find
    // uncontended windows (no livelock), until the guest posts its flag.
    const { buffer, mode } = workerData;
    const i8 = new Int8Array(buffer);
    const i32 = new Int32Array(buffer);
    const i64 = new BigInt64Array(buffer);
    const flag_idx = FLAG >> 2;
    let adds = 0;
    parentPort.postMessage("ready");
    while(Atomics.load(i32, flag_idx) === 0)
    {
        for(let i = 0; i < WORKER_BURST; i++)
        {
            if(mode === "i64")
            {
                Atomics.add(i64, CELL >> 3, 1n);
            }
            else if(mode === "i8")
            {
                Atomics.add(i8, CELL, 1);
            }
            else
            {
                Atomics.add(i32, CELL >> 2, 1);
            }
            adds++;
        }
        Atomics.wait(i32, PARK >> 2, 0, 1);
    }
    parentPort.postMessage(adds);
}

async function create_machine(gram_bytes, v86_bytes, jit)
{
    const guest_memory = new WebAssembly.Memory({
        initial: GUEST_PAGES,
        maximum: GUEST_PAGES,
        shared: true,
    });
    assert(guest_memory.buffer instanceof SharedArrayBuffer,
        "shared guest memory must be SharedArrayBuffer-backed");

    const gram = await WebAssembly.instantiate(gram_bytes,
        { "env": { "guest_memory": guest_memory } });
    const table = new WebAssembly.Table({
        element: "anyfunc",
        initial: WASM_TABLE_SIZE + WASM_TABLE_OFFSET,
    });

    let tick = 0;
    let exports;
    const read_string = (ptr, len) =>
        new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len));

    // JIT plumbing (Stage L2 phases): the Stage 4 proof-of-life
    // codegen_finalize — validate the generated module, instantiate it over
    // the same two memories under cpu.js's jit_imports shape, install into
    // the shared table, and report completion only after the current wasm
    // frame has returned to JS (cpu.js's async path)
    const finalize_calls = [];
    const jit_clears = [];
    const pending_finished = [];
    const flush_pending_finished = () =>
    {
        while(pending_finished.length)
        {
            pending_finished.shift()();
        }
    };
    const codegen_finalize = (wasm_table_index, start, state_flags, ptr, len) =>
    {
        assert(jit, "codegen_finalize must not fire with the JIT disabled");
        const bytes = new Uint8Array(exports.memory.buffer, ptr >>> 0, len >>> 0).slice();
        assert.ok(WebAssembly.validate(bytes), "generated JIT module must validate");
        const module = new WebAssembly.Module(bytes);
        const jit_imports = Object.create(null);
        jit_imports["m"] = exports.memory;
        jit_imports["g"] = guest_memory;
        for(const name of Object.keys(exports))
        {
            if(name.startsWith("_") || name.startsWith("zstd") || name.endsWith("_js")) continue;
            jit_imports[name] = exports[name];
        }
        const instance = new WebAssembly.Instance(module, { "e": jit_imports });
        table.set(wasm_table_index + WASM_TABLE_OFFSET, instance.exports["f"]);
        finalize_calls.push({ wasm_table_index, start: start >>> 0 });
        pending_finished.push(() =>
            exports.codegen_finalize_finished(wasm_table_index, start, state_flags));
    };

    // env stubs: starter.js wasm_shared_funcs shape (Stage 4 proof-of-life
    // harness pattern); gram exports provide every gram_* import
    const env = {
        ...gram.instance.exports,
        "gram_copy_out": (src_addr, dst, count) =>
        {
            new Uint8Array(exports.memory.buffer, dst, count)
                .set(new Uint8Array(guest_memory.buffer).subarray(src_addr, src_addr + count));
        },

        "cpu_exception_hook": n => 0,
        "run_hardware_timers": (acpi, t) => t + 100,
        "cpu_event_halt": () => {},
        "abort": () => { throw new Error("wasm abort"); },
        "microtick": () => (tick += 10),
        "get_rand_int": () => 4,
        "stop_idling": () => {},

        "io_port_read8": port => 0xFF,
        "io_port_read16": port => 0xFFFF,
        "io_port_read32": port => -1,
        "io_port_write8": (port, value) => {},
        "io_port_write16": (port, value) => {},
        "io_port_write32": (port, value) => {},

        "mmap_read8": addr => 0xFF,
        "mmap_read32": addr => -1,
        "mmap_write8": (addr, value) => {},
        "mmap_write16": (addr, value) => {},
        "mmap_write32": (addr, value) => {},
        "mmap_write64": (addr, v0, v1) => {},
        "mmap_write128": (addr, v0, v1, v2, v3) => {},

        "log_from_wasm": (ptr, len) => read_string(ptr, len),
        "console_log_from_wasm": (ptr, len) => read_string(ptr, len),
        "dbg_trace_from_wasm": () => {},

        // real when jit (Stage L2 phases), asserting-throwing otherwise
        "codegen_finalize": codegen_finalize,
        "jit_clear_func": wasm_table_index => { jit_clears.push(wasm_table_index); },
        "jit_clear_all_funcs": () => { jit_clears.push(-1); },

        "__indirect_function_table": table,
    };

    const main = await WebAssembly.instantiate(v86_bytes, { "env": env });
    exports = main.instance.exports;

    exports.rust_init();
    exports.set_guest_memory_shared(1);
    if(!jit)
    {
        exports.set_jit_config(0, 1); // spend no cycles compiling: interpreter only
    }

    const memory_size_view = new Uint32Array(exports.memory.buffer, 812, 1);
    memory_size_view[0] = MEMORY_SIZE;
    assert.equal(exports.allocate_memory(MEMORY_SIZE), 0, "imported guest RAM is 0-based");
    exports.zero_memory(0, MEMORY_SIZE);
    exports.reset_cpu();

    return {
        exports,
        guest_memory,
        guest8: new Uint8Array(guest_memory.buffer),
        guest_dv: new DataView(guest_memory.buffer),
        instruction_pointer: new Int32Array(exports.memory.buffer, 556, 1),
        previous_ip: new Int32Array(exports.memory.buffer, 560, 1),
        segment_offsets: new Int32Array(exports.memory.buffer, 736, 8),
        in_hlt: new Uint8Array(exports.memory.buffer, 616, 1),
        finalize_calls,
        jit_clears,
        flush_pending_finished,
    };
}

// Stage L2: force-compile the code page up front (debug-only export, one
// shot of JIT_THRESHOLD heat) so every guest iteration below runs the
// compiled locked lowering, and assert the compile actually happened and
// covered the loop page.
function force_jit(m, name)
{
    m.exports.jit_force_generate_unsafe(CODE);
    m.flush_pending_finished();
    assert.equal(m.finalize_calls.length, 1, `${name}: exactly one compilation`);
    assert.equal(m.finalize_calls[0].start & ~0xFFF, CODE,
        `${name}: compiled entry must be on the code page`);
}

// Compiled-execution evidence, tolerant of generational recompiles: a long
// run interleaves main_loop slices, and when the compiled function exits at
// an eip that is not a registered entry point, the interpreter both
// executes and heats a new entry point, whereupon the page is recompiled
// with the larger entry set and the superseded module's table index is
// freed (jit.rs free_wasm_table_index via "unused after overwrite"). That
// clear is a replacement, not a loss of compiled execution, so the
// assertions are: every compilation covered the code page (the forced one
// before the first slice included), every cleared index was one of our own
// superseded generations (never -1 = jit_clear_all_funcs, never a foreign
// index), and the final generation was still installed when the guest
// finished — combined with the dispatch loop unconditionally entering
// installed hot code, the guest's locked loop ran compiled.
function assert_compiled_evidence(m, name)
{
    assert(m.finalize_calls.length >= 1, `${name}: at least the forced compilation`);
    for(const f of m.finalize_calls)
    {
        assert.equal(f.start & ~0xFFF, CODE,
            `${name}: every compilation must cover the code page`);
    }
    const installed = m.finalize_calls.map(f => f.wasm_table_index);
    for(const cleared of m.jit_clears)
    {
        assert(installed.includes(cleared),
            `${name}: cleared index ${cleared} must be a superseded own generation`);
    }
    const last = installed[installed.length - 1];
    assert(!m.jit_clears.includes(last),
        `${name}: the final compiled generation must survive the run`);
    console.log(`${name}: compiled generations ${m.finalize_calls.length}, ` +
        `superseded ${m.jit_clears.length}`);
}

function enter_program(m, bytes)
{
    m.guest8.set(bytes, CODE);
    assert.equal(m.segment_offsets[1], CODE, "reset must leave real-mode CS base F0000");
    m.instruction_pointer[0] = CODE;
    m.previous_ip[0] = CODE;
}

async function run_contended_phase(name, files, program, mode, expected_total, jit)
{
    const m = await create_machine(files.gram_bytes, files.v86_bytes, jit);
    enter_program(m, program);
    if(jit)
    {
        force_jit(m, name);
    }

    const flag_view = new Int32Array(m.guest_memory.buffer);
    const worker = new Worker(new URL(import.meta.url),
        { workerData: { buffer: m.guest_memory.buffer, mode } });
    // let the worker signal that its contention loop is running before the
    // guest starts, so the two genuinely overlap (the guest can finish its
    // whole loop faster than a Worker spawns)
    const messages = [];
    let on_message = null;
    const next_message = () => new Promise((resolve, reject) =>
    {
        if(messages.length) resolve(messages.shift());
        else on_message = { resolve, reject };
    });
    worker.on("message", m =>
    {
        if(on_message) { on_message.resolve(m); on_message = null; }
        else messages.push(m);
    });
    worker.on("error", e =>
    {
        if(on_message) { on_message.reject(e); on_message = null; }
        else throw e;
    });
    assert.equal(await next_message(), "ready", `${name}: worker must start`);

    const deadline = Date.now() + TIMEOUT_MS;
    while(Atomics.load(flag_view, FLAG >> 2) === 0)
    {
        assert(Date.now() < deadline, `${name}: guest loop did not finish in time`);
        m.exports.main_loop();
        m.flush_pending_finished();
    }
    const adds = await next_message();
    await worker.terminate();

    assert(adds > 0, `${name}: the JS contender must actually contend`);
    if(jit)
    {
        assert_compiled_evidence(m, name);
    }
    let total;
    if(mode === "i64")
    {
        total = m.guest_dv.getBigUint64(CELL, true);
        assert.equal(total, expected_total + BigInt(adds),
            `${name}: exact total (guest ${expected_total} + js ${adds})`);
    }
    else if(mode === "i8")
    {
        total = m.guest_dv.getUint8(CELL);
        assert.equal(total, (expected_total + adds) & 0xFF,
            `${name}: exact total mod 256 (guest ${expected_total} + js ${adds})`);
    }
    else
    {
        total = m.guest_dv.getUint32(CELL, true);
        assert.equal(total, (expected_total + adds) >>> 0,
            `${name}: exact total (guest ${expected_total} + js ${adds})`);
    }
    console.log(`${name}: exact — guest ${expected_total} + js ${adds} = ${total}`);
}

async function main()
{
    if(!fs.existsSync(root_path + "/build/v86-multimem-debug.wasm"))
    {
        console.log("Missing build/v86-multimem-debug.wasm, test skipped");
        process.exit(0);
    }
    const files = {
        gram_bytes: fs.readFileSync(root_path + "/build/gram-shared.wasm"),
        v86_bytes: fs.readFileSync(root_path + "/build/v86-multimem-debug.wasm"),
    };

    await run_contended_phase("lock inc", files,
        program_lock_inc(GUEST_ITERATIONS, CELL), "i32", GUEST_ITERATIONS, false);
    await run_contended_phase("lock xadd", files,
        program_lock_xadd(GUEST_ITERATIONS), "i32", GUEST_ITERATIONS, false);
    await run_contended_phase("lock xadd8", files,
        program_lock_xadd8(GUEST_ITERATIONS), "i8", GUEST_ITERATIONS, false);
    await run_contended_phase("lock cmpxchg8b", files,
        program_lock_cmpxchg8b(GUEST_ITERATIONS), "i64", BigInt(GUEST_ITERATIONS), false);
    await run_buslock_phase("interp", files, false);

    // Stage L2: the same exactness bar under COMPILED execution — the JIT
    // CAS-loop fast path (DWORD via inc and the register-writing xadd
    // closure, QWORD via cmpxchg8b), the interpreter-called byte form
    // (xadd8: 0FC0's jit_lock_interp_mem_call! runtime-prefix bracket into
    // L1's byte CAS), and the bus-locked JIT slow path (page-crossing inc)
    await run_contended_phase("lock inc (jit)", files,
        program_lock_inc(GUEST_ITERATIONS, CELL), "i32", GUEST_ITERATIONS, true);
    await run_contended_phase("lock xadd (jit)", files,
        program_lock_xadd(GUEST_ITERATIONS), "i32", GUEST_ITERATIONS, true);
    await run_contended_phase("lock xadd8 (jit)", files,
        program_lock_xadd8(GUEST_ITERATIONS), "i8", GUEST_ITERATIONS, true);
    await run_contended_phase("lock cmpxchg8b (jit)", files,
        program_lock_cmpxchg8b(GUEST_ITERATIONS), "i64", BigInt(GUEST_ITERATIONS), true);
    await run_buslock_phase("jit", files, true);

    console.log("Tests passed");
}

// page-crossing locked target (interim bus-lock fallback), guest-only
async function run_buslock_phase(name, files, jit)
{
    const m = await create_machine(files.gram_bytes, files.v86_bytes, jit);
    enter_program(m, program_lock_inc(CROSS_ITERATIONS, CROSS));
    if(jit)
    {
        force_jit(m, `bus-lock (${name})`);
    }
    const flag_view = new Int32Array(m.guest_memory.buffer);
    const deadline = Date.now() + TIMEOUT_MS;
    while(Atomics.load(flag_view, FLAG >> 2) === 0)
    {
        assert(Date.now() < deadline,
            `bus-lock phase (${name}): guest loop did not finish in time`);
        m.exports.main_loop();
        m.flush_pending_finished();
    }
    const value = m.guest_dv.getUint32(CROSS, true);
    assert.equal(value, CROSS_ITERATIONS, `page-crossing lock inc is exact (${name})`);
    if(jit)
    {
        assert_compiled_evidence(m, `bus-lock (${name})`);
    }
    console.log(`lock inc [0xFFF] (page-crossing bus lock, ${name}): exact — ${value}`);
}

if(isMainThread)
{
    await main();
}
else
{
    worker_main();
}
