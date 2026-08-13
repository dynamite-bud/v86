#!/usr/bin/env node

// Generates gram.wasm, the tiny hand-assembled wasm module whose memory 0 IS
// guest RAM (docs/smp-phase3-design.md §2 option A item 2, §4 Stage 3).
//
// Under the multimem build (Stage 4, cargo feature `guest-ram-import`) the
// main Rust module stays single-memory and reaches guest RAM only through
// imported accessor functions. gram.wasm implements those accessors: it
// imports guest RAM as its own memory 0 ("env"."guest_memory") and exports
// one function per accessor of src/rust/cpu/memory.rs' gram layer, plus the
// atomic set from design doc Addendum 2 so Phase 4's interpreter RMW path
// (safe_read_write under a LOCK prefix) is ready. JS merges these exports
// into the main module's `env` imports before instantiating it (Stage 5).
//
// ABI (every export; i32/i64 are wasm types; addresses are guest-physical):
//
//   gram_read8(addr: i32) -> i32              zero-extended
//   gram_read16(addr: i32) -> i32             zero-extended, unaligned ok
//   gram_read32(addr: i32) -> i32             unaligned ok
//   gram_read64(addr: i32) -> i64             unaligned ok
//   gram_read64_aligned(addr: i32) -> i64     addr must be 8-byte aligned
//   gram_read128(addr: i32) -> (i64, i64)     multivalue: (bits 0..63, 64..127)
//   gram_write8(addr: i32, value: i32)        low 8 bits stored
//   gram_write16(addr: i32, value: i32)       low 16 bits stored, unaligned ok
//   gram_write32(addr: i32, value: i32)       unaligned ok
//   gram_write64(addr: i32, value: i64)       unaligned ok
//   gram_write128(addr: i32, v0: i64, v1: i64)  v0 -> bits 0..63, v1 -> 64..127
//   gram_memset(addr: i32, value: i32, count: i32)   memory.fill (low 8 bits)
//   gram_memcpy(src_addr: i32, dst_addr: i32, count: i32)
//       memory.copy within guest RAM; overlap allowed (memmove semantics).
//       Parameter order matches memory.rs' gram_memcpy: source first.
//   gram_atomic_rmw_{add,sub,and,or,xor,xchg}_{8,16,32}(addr: i32, value: i32) -> i32
//       sequentially-consistent RMW returning the OLD value (zero-extended);
//       addr must be naturally aligned for the access size or the engine
//       traps (x86 allows misaligned LOCK'd ops; Phase 4's caller must
//       split or fall back before calling these).
//   gram_atomic_rmw_cmpxchg_{8,16,32}(addr: i32, expected: i32, replacement: i32) -> i32
//       compare-and-swap returning the OLD value; same alignment rule. The
//       8/16-bit forms compare against the zero-extended low bits of
//       `expected` (wasm rmw.cmpxchg_u semantics).
//   gram_fence()                              atomic.fence (seq-cst)
//
// Decisions, verified empirically (spike S1 and tests/rust/verify-gram-wasm.js):
//
// - 128-bit ABI: gram_read128 returns (i64, i64) via multivalue. A
//   scratch-pointer protocol is impossible here: gram.wasm's only memory is
//   guest RAM, so it cannot see the Rust module's scratch space. Stable Rust
//   cannot declare a multivalue extern return, so Stage 4's Rust-side
//   read128 macro instead issues gram_read64(addr) + gram_read64(addr + 8);
//   the multivalue export exists for hand-emitted callers (JIT modules,
//   Phase 4 helpers, JS/tests). gram_write128(addr, i64, i64) is directly
//   declarable as `extern "C" fn(u32, u64, u64)` and needs no split.
//
// - Cross-memory copies: memory.rs' gram_copy_out (guest RAM -> module-local
//   memory, used by memcpy_into_svga_lfb for the SVGA LFB) is NOT exported.
//   Neither gram.wasm nor the single-memory main module can address both
//   memories, so under the multimem build `env.gram_copy_out` must be
//   provided by JS (typed-array copy between the guest memory's buffer and
//   the instance memory's buffer) or by a dedicated hand-emitted two-memory
//   helper — Stage 4/5 owns that decision; this module only fixes the
//   contract that gram.wasm does not provide it.
//
// - Two artifacts, gram.wasm and gram-shared.wasm: shared-ness of a memory
//   import must match the provided memory exactly (LinkError otherwise), so
//   one file per shared-ness is required. Within each, the import declares
//   limits {min: 0, max: 65536 pages}: import subtyping accepts any actual
//   memory whose min >= 0 and max <= 65536 (max must be present — JS always
//   creates guest RAM with maximum == memory_size, and shared memories
//   require one), so a single file per shared-ness covers every guest RAM
//   size with no per-size generation.
//
// - Alignment hints: plain loads/stores use hint 0 like wasm_builder's
//   *_from_guest emitters (guest addresses are not statically aligned; the
//   hint has no semantic effect). gram_read64_aligned keeps the natural
//   hint 3, preserving Stage 1's aligned-load distinction. Atomics carry
//   their mandatory natural alignment.
//
// Both variants are byte-identical except for the limits flag of the memory
// import (0x01 min+max vs 0x03 min+max+shared). Atomic opcodes validate and
// execute on non-shared memories too (threads-spec relaxation, spike S1), so
// the function bodies are shared between the variants.
//
// Output is a pure function of this file: re-running produces identical
// bytes (asserted by tests/rust/verify-gram-wasm.js).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { get_switch_value } from "./util.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const CYAN_FMT = "\x1b[36m%s\x1b[0m";

const OUT_DIR = get_switch_value("--output-dir") || path.join(__dirname, "..", "build");
const VARIANT = get_switch_value("--variant");
assert(
    VARIANT === null || VARIANT === "nonshared" || VARIANT === "shared",
    "--variant must be nonshared or shared (omit to generate both)"
);

// declared limits of the guest-memory import, in 64 KiB wasm pages: the
// engine accepts any actual memory with a maximum of at most DECLARED_MAX
const DECLARED_MIN_PAGES = 0;
const DECLARED_MAX_PAGES = 65536;

const TYPE_I32 = 0x7f;
const TYPE_I64 = 0x7e;

const LOCAL_GET = 0x20;

const I32_LOAD = 0x28;
const I64_LOAD = 0x29;
const I32_LOAD8_U = 0x2d;
const I32_LOAD16_U = 0x2f;
const I32_STORE = 0x36;
const I64_STORE = 0x37;
const I32_STORE8 = 0x3a;
const I32_STORE16 = 0x3b;

const FC_PREFIX = 0xfc;
const MEMORY_COPY = 0x0a;
const MEMORY_FILL = 0x0b;

const FE_PREFIX = 0xfe;
const ATOMIC_FENCE = 0x03;
// i32.atomic.rmw*.<op>: base opcode of each 7-opcode group, plus the offset
// selecting the i32 form for the access size
const ATOMIC_RMW_BASE = { add: 0x1e, sub: 0x25, and: 0x2c, or: 0x33, xor: 0x3a, xchg: 0x41, cmpxchg: 0x48 };
const ATOMIC_SIZE_OFFSET = { 32: 0, 8: 2, 16: 3 };
const ATOMIC_SIZE_ALIGN = { 8: 0, 16: 1, 32: 2 };

function leb(n)
{
    // unsigned LEB128
    const out = [];
    do
    {
        let b = n & 0x7f;
        n >>>= 7;
        if(n) b |= 0x80;
        out.push(b);
    } while(n);
    return out;
}

function string(s)
{
    const bytes = [...Buffer.from(s, "utf8")];
    return [...leb(bytes.length), ...bytes];
}

function section(id, body)
{
    return [id, ...leb(body.length), ...body];
}

function vec(items)
{
    return [...leb(items.length), ...items.flat()];
}

function memarg(align, offset)
{
    return [...leb(align), ...leb(offset)];
}

// function types, deduplicated; the ordering here fixes the type indices
const types = [];
const type_index_by_key = new Map();
function type_index(params, results)
{
    const key = params.join() + "->" + results.join();
    if(!type_index_by_key.has(key))
    {
        type_index_by_key.set(key, types.length);
        types.push([0x60, ...vec(params.map(t => [t])), ...vec(results.map(t => [t]))]);
    }
    return type_index_by_key.get(key);
}

// { name, type index, body code (locals are the params; no extra locals) }
const functions = [];
function fn(name, params, results, code)
{
    functions.push({ name, type: type_index(params, results), code });
}

fn("gram_read8", [TYPE_I32], [TYPE_I32],
    [LOCAL_GET, 0, I32_LOAD8_U, ...memarg(0, 0)]);
fn("gram_read16", [TYPE_I32], [TYPE_I32],
    [LOCAL_GET, 0, I32_LOAD16_U, ...memarg(0, 0)]);
fn("gram_read32", [TYPE_I32], [TYPE_I32],
    [LOCAL_GET, 0, I32_LOAD, ...memarg(0, 0)]);
fn("gram_read64", [TYPE_I32], [TYPE_I64],
    [LOCAL_GET, 0, I64_LOAD, ...memarg(0, 0)]);
fn("gram_read64_aligned", [TYPE_I32], [TYPE_I64],
    [LOCAL_GET, 0, I64_LOAD, ...memarg(3, 0)]);
fn("gram_read128", [TYPE_I32], [TYPE_I64, TYPE_I64],
    [LOCAL_GET, 0, I64_LOAD, ...memarg(0, 0),
     LOCAL_GET, 0, I64_LOAD, ...memarg(0, 8)]);

fn("gram_write8", [TYPE_I32, TYPE_I32], [],
    [LOCAL_GET, 0, LOCAL_GET, 1, I32_STORE8, ...memarg(0, 0)]);
fn("gram_write16", [TYPE_I32, TYPE_I32], [],
    [LOCAL_GET, 0, LOCAL_GET, 1, I32_STORE16, ...memarg(0, 0)]);
fn("gram_write32", [TYPE_I32, TYPE_I32], [],
    [LOCAL_GET, 0, LOCAL_GET, 1, I32_STORE, ...memarg(0, 0)]);
fn("gram_write64", [TYPE_I32, TYPE_I64], [],
    [LOCAL_GET, 0, LOCAL_GET, 1, I64_STORE, ...memarg(0, 0)]);
fn("gram_write128", [TYPE_I32, TYPE_I64, TYPE_I64], [],
    [LOCAL_GET, 0, LOCAL_GET, 1, I64_STORE, ...memarg(0, 0),
     LOCAL_GET, 0, LOCAL_GET, 2, I64_STORE, ...memarg(0, 8)]);

fn("gram_memset", [TYPE_I32, TYPE_I32, TYPE_I32], [],
    [LOCAL_GET, 0, LOCAL_GET, 1, LOCAL_GET, 2, FC_PREFIX, MEMORY_FILL, 0x00]);
// (src, dst, count) like memory.rs; memory.copy pops (dst, src, count)
fn("gram_memcpy", [TYPE_I32, TYPE_I32, TYPE_I32], [],
    [LOCAL_GET, 1, LOCAL_GET, 0, LOCAL_GET, 2, FC_PREFIX, MEMORY_COPY, 0x00, 0x00]);

for(const op of ["add", "sub", "and", "or", "xor", "xchg", "cmpxchg"])
{
    for(const size of [8, 16, 32])
    {
        const opcode = ATOMIC_RMW_BASE[op] + ATOMIC_SIZE_OFFSET[size];
        const align = ATOMIC_SIZE_ALIGN[size];
        if(op === "cmpxchg")
        {
            fn(`gram_atomic_rmw_cmpxchg_${size}`, [TYPE_I32, TYPE_I32, TYPE_I32], [TYPE_I32],
                [LOCAL_GET, 0, LOCAL_GET, 1, LOCAL_GET, 2, FE_PREFIX, opcode, ...memarg(align, 0)]);
        }
        else
        {
            fn(`gram_atomic_rmw_${op}_${size}`, [TYPE_I32, TYPE_I32], [TYPE_I32],
                [LOCAL_GET, 0, LOCAL_GET, 1, FE_PREFIX, opcode, ...memarg(align, 0)]);
        }
    }
}

fn("gram_fence", [], [], [FE_PREFIX, ATOMIC_FENCE, 0x00]);

function build_module(shared)
{
    // limits flags: 0x01 min+max, 0x03 min+max+shared
    const limits = [shared ? 0x03 : 0x01, ...leb(DECLARED_MIN_PAGES), ...leb(DECLARED_MAX_PAGES)];
    const type_section = section(1, vec(types));
    const import_section = section(2, vec([
        [...string("env"), ...string("guest_memory"), 0x02, ...limits],
    ]));
    const function_section = section(3, vec(functions.map(f => [...leb(f.type)])));
    const export_section = section(7, vec(
        functions.map((f, i) => [...string(f.name), 0x00, ...leb(i)])
    ));
    const code_section = section(10, vec(functions.map(f =>
    {
        const body = [...vec([]), ...f.code, 0x0b];
        return [...leb(body.length), ...body];
    })));

    return new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        ...type_section, ...import_section, ...function_section,
        ...export_section, ...code_section,
    ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for(const [variant, filename, shared] of [
    ["nonshared", "gram.wasm", false],
    ["shared", "gram-shared.wasm", true],
])
{
    if(VARIANT !== null && VARIANT !== variant) continue;
    const bytes = build_module(shared);
    assert(WebAssembly.validate(bytes), `${filename} must validate`);
    const file_path = path.join(OUT_DIR, filename);
    fs.writeFileSync(file_path, bytes);
    console.log(CYAN_FMT, `[+] Wrote ${filename} (${bytes.length} bytes).`);
}
