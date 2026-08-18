#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

// Verifies build/gram.wasm and build/gram-shared.wasm, the guest-RAM accessor
// modules produced by gen/generate_gram_wasm.js (XWAH-9 Phase 3 Stage 3).
// Kept in sync with the gram layer in src/rust/cpu/memory.rs: every export
// the Stage 4 multimem build will import is exercised here, over both a
// non-shared and a shared guest memory.

const build_dir = path.resolve(__dirname, "../../build");
const generator = path.resolve(__dirname, "../../gen/generate_gram_wasm.js");

// determinism: re-running the generator must reproduce the build outputs
// byte for byte
const check_dir = path.join(build_dir, "gram-determinism-check");
const generate = spawnSync(process.execPath, [generator, "--output-dir", check_dir]);
assert.equal(generate.status, 0, `generator failed: ${generate.stderr}`);
for(const filename of ["gram.wasm", "gram-shared.wasm"])
{
    const built = fs.readFileSync(path.join(build_dir, filename));
    const regenerated = fs.readFileSync(path.join(check_dir, filename));
    assert(built.equals(regenerated), `${filename}: generator output must be deterministic`);
}

const nonshared_module = fs.readFileSync(path.join(build_dir, "gram.wasm"));
const shared_module = fs.readFileSync(path.join(build_dir, "gram-shared.wasm"));

const PAGE = 0x10000;

function make_guest_memory(shared, pages)
{
    return shared ?
        new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true }) :
        new WebAssembly.Memory({ initial: pages, maximum: pages });
}

function instantiate(module_bytes, guest_memory)
{
    const wm = new WebAssembly.Module(module_bytes);
    return new WebAssembly.Instance(wm, { "env": { guest_memory } }).exports;
}

for(const [name, module_bytes, shared] of [
    ["non-shared", nonshared_module, false],
    ["shared", shared_module, true],
])
{
    assert(WebAssembly.validate(module_bytes), `${name}: module must validate`);

    const guest_memory = make_guest_memory(shared, 2);
    const gram = instantiate(module_bytes, guest_memory);
    if(shared)
    {
        assert(guest_memory.buffer instanceof SharedArrayBuffer,
            `${name}: guest memory must be backed by a SharedArrayBuffer`);
    }
    const view = new DataView(guest_memory.buffer);
    const bytes = new Uint8Array(guest_memory.buffer);

    // reads, checked against a JS view of the same memory
    view.setUint32(64, 0x8899aabb, true);
    view.setUint32(68, 0xccddeeff, true);
    assert.equal(gram.gram_read8(64), 0xbb, `${name}: read8`);
    assert.equal(gram.gram_read8(67), 0x88, `${name}: read8 high byte zero-extends`);
    assert.equal(gram.gram_read16(64), 0xaabb, `${name}: read16`);
    assert.equal(gram.gram_read16(65), 0x99aa, `${name}: read16 unaligned`);
    assert.equal(gram.gram_read32(64) >>> 0, 0x8899aabb, `${name}: read32`);
    assert.equal(gram.gram_read32(65) >>> 0, 0xff8899aa, `${name}: read32 unaligned`);
    assert.equal(BigInt.asUintN(64, gram.gram_read64(64)), 0xccddeeff8899aabbn, `${name}: read64`);
    assert.equal(BigInt.asUintN(64, gram.gram_read64(61)), 0xff8899aabb000000n, `${name}: read64 unaligned`);
    assert.equal(BigInt.asUintN(64, gram.gram_read64_aligned(64)), 0xccddeeff8899aabbn, `${name}: read64_aligned`);

    // 128-bit ABI: multivalue (i64 bits 0..63, i64 bits 64..127)
    view.setBigUint64(80, 0x1122334455667788n, true);
    view.setBigUint64(88, 0x99aabbccddeeff00n, true);
    const [read128_lo, read128_hi] = gram.gram_read128(80);
    assert.equal(BigInt.asUintN(64, read128_lo), 0x1122334455667788n, `${name}: read128 low half`);
    assert.equal(BigInt.asUintN(64, read128_hi), 0x99aabbccddeeff00n, `${name}: read128 high half`);
    const [unaligned_lo, unaligned_hi] = gram.gram_read128(81);
    assert.equal(BigInt.asUintN(64, unaligned_lo), 0x0011223344556677n, `${name}: read128 unaligned low`);
    assert.equal(BigInt.asUintN(64, unaligned_hi), 0x0099aabbccddeeffn, `${name}: read128 unaligned high`);

    // page-boundary crossing (memory is 2 pages; addresses straddle page 0/1)
    view.setUint32(PAGE - 2, 0x13579bdf, true);
    assert.equal(gram.gram_read32(PAGE - 2) >>> 0, 0x13579bdf, `${name}: read32 across page boundary`);
    assert.equal(gram.gram_read16(PAGE - 1), 0x579b, `${name}: read16 across page boundary`);

    // out-of-bounds accesses trap
    assert.throws(() => gram.gram_read8(2 * PAGE), WebAssembly.RuntimeError, `${name}: read8 oob`);
    assert.throws(() => gram.gram_read32(2 * PAGE - 3), WebAssembly.RuntimeError, `${name}: read32 partial oob`);
    assert.throws(() => gram.gram_write8(2 * PAGE, 1), WebAssembly.RuntimeError, `${name}: write8 oob`);

    // writes, checked from JS
    gram.gram_write8(100, 0x1ab);
    assert.equal(view.getUint8(100), 0xab, `${name}: write8 stores low 8 bits`);
    gram.gram_write16(101, 0x1cdef);
    assert.equal(view.getUint16(101, true), 0xcdef, `${name}: write16 unaligned, low 16 bits`);
    gram.gram_write32(103, 0x76543210);
    assert.equal(view.getUint32(103, true), 0x76543210, `${name}: write32 unaligned`);
    gram.gram_write64(107, 0x0102030405060708n);
    assert.equal(view.getBigUint64(107, true), 0x0102030405060708n, `${name}: write64 unaligned`);
    gram.gram_write128(120, 0xfedcba9876543210n, 0x0123456789abcdefn);
    assert.equal(view.getBigUint64(120, true), 0xfedcba9876543210n, `${name}: write128 low half`);
    assert.equal(view.getBigUint64(128, true), 0x0123456789abcdefn, `${name}: write128 high half`);

    // memset: exact range [200, 216), low 8 bits of the value
    bytes[199] = 0x77;
    bytes[216] = 0x77;
    gram.gram_memset(200, 0x15a, 16);
    assert.equal(bytes[199], 0x77, `${name}: memset leaves byte before range`);
    assert.equal(bytes[216], 0x77, `${name}: memset leaves byte after range`);
    for(let i = 200; i < 216; i++)
    {
        assert.equal(bytes[i], 0x5a, `${name}: memset byte at ${i}`);
    }
    gram.gram_memset(200, 0, 0);
    assert.equal(bytes[200], 0x5a, `${name}: memset count 0 is a no-op`);

    // memcpy(src, dst, count) — parameter order of memory.rs' gram_memcpy —
    // with memmove semantics for overlapping ranges in both directions
    for(let i = 0; i < 8; i++) bytes[300 + i] = i;
    gram.gram_memcpy(300, 400, 8);
    for(let i = 0; i < 8; i++)
    {
        assert.equal(bytes[400 + i], i, `${name}: memcpy byte at ${400 + i}`);
    }
    gram.gram_memcpy(300, 302, 6); // overlap, dst > src
    for(let i = 0; i < 6; i++)
    {
        assert.equal(bytes[302 + i], i, `${name}: overlapping forward memcpy at ${302 + i}`);
    }
    gram.gram_memcpy(402, 400, 6); // overlap, dst < src
    for(let i = 0; i < 6; i++)
    {
        assert.equal(bytes[400 + i], i + 2, `${name}: overlapping backward memcpy at ${400 + i}`);
    }

    // atomic RMW chains: each op returns the OLD value; final memory checked
    // via JS. 8/16-bit forms zero-extend.
    for(const [size, set, get, addr] of [
        [8, (a, v) => view.setUint8(a, v), a => view.getUint8(a), 501],
        [16, (a, v) => view.setUint16(a, v, true), a => view.getUint16(a, true), 512],
        [32, (a, v) => view.setUint32(a, v, true), a => view.getUint32(a, true), 516],
    ])
    {
        set(addr, 100);
        assert.equal(gram[`gram_atomic_rmw_add_${size}`](addr, 41), 100, `${name}: rmw_add_${size} old`);
        assert.equal(get(addr), 141, `${name}: rmw_add_${size} result`);
        assert.equal(gram[`gram_atomic_rmw_sub_${size}`](addr, 99), 141, `${name}: rmw_sub_${size} old`);
        assert.equal(get(addr), 42, `${name}: rmw_sub_${size} result`);
        assert.equal(gram[`gram_atomic_rmw_and_${size}`](addr, 0x0f), 42, `${name}: rmw_and_${size} old`);
        assert.equal(get(addr), 10, `${name}: rmw_and_${size} result`);
        assert.equal(gram[`gram_atomic_rmw_or_${size}`](addr, 0x21), 10, `${name}: rmw_or_${size} old`);
        assert.equal(get(addr), 0x2b, `${name}: rmw_or_${size} result`);
        assert.equal(gram[`gram_atomic_rmw_xor_${size}`](addr, 0x01), 0x2b, `${name}: rmw_xor_${size} old`);
        assert.equal(get(addr), 0x2a, `${name}: rmw_xor_${size} result`);
        assert.equal(gram[`gram_atomic_rmw_xchg_${size}`](addr, 77), 0x2a, `${name}: rmw_xchg_${size} old`);
        assert.equal(get(addr), 77, `${name}: rmw_xchg_${size} result`);
        // failed cmpxchg: expected mismatch leaves memory untouched
        assert.equal(gram[`gram_atomic_rmw_cmpxchg_${size}`](addr, 76, 1), 77, `${name}: cmpxchg_${size} fail old`);
        assert.equal(get(addr), 77, `${name}: cmpxchg_${size} fail leaves value`);
        // successful cmpxchg
        assert.equal(gram[`gram_atomic_rmw_cmpxchg_${size}`](addr, 77, 42), 77, `${name}: cmpxchg_${size} ok old`);
        assert.equal(get(addr), 42, `${name}: cmpxchg_${size} ok result`);
    }
    // 8-bit RMW returns zero-extended old values and only touches its byte
    view.setUint32(524, 0xffffffff, true);
    assert.equal(gram.gram_atomic_rmw_add_8(524, 1), 0xff, `${name}: rmw_add_8 zero-extends old`);
    assert.equal(view.getUint32(524, true), 0xffffff00, `${name}: rmw_add_8 touches one byte`);
    // misaligned atomics trap
    assert.throws(() => gram.gram_atomic_rmw_add_32(525, 1), WebAssembly.RuntimeError,
        `${name}: misaligned atomic traps`);

    // Phase 4 Stage L1 additions: 64-bit CAS, seq-cst load/store, notify.
    // All valid on both variants (notify simply has no waiters to wake on a
    // non-shared memory and returns 0); wait32 is runtime-shared-only and
    // is exercised from a worker further down.
    view.setBigUint64(528, 0x1122334455667788n, true);
    assert.equal(BigInt.asUintN(64, gram.gram_atomic_rmw_cmpxchg_64(528, 0n, 1n)),
        0x1122334455667788n, `${name}: cmpxchg_64 fail returns old`);
    assert.equal(view.getBigUint64(528, true), 0x1122334455667788n,
        `${name}: cmpxchg_64 fail leaves value`);
    assert.equal(BigInt.asUintN(64,
        gram.gram_atomic_rmw_cmpxchg_64(528, 0x1122334455667788n, 0x8877665544332211n)),
        0x1122334455667788n, `${name}: cmpxchg_64 ok returns old`);
    assert.equal(view.getBigUint64(528, true), 0x8877665544332211n,
        `${name}: cmpxchg_64 ok stores replacement`);
    assert.throws(() => gram.gram_atomic_rmw_cmpxchg_64(532, 0n, 1n), WebAssembly.RuntimeError,
        `${name}: misaligned cmpxchg_64 traps`);

    view.setUint32(544, 0xdeadbeef, true);
    assert.equal(gram.gram_atomic_load_32(544) >>> 0, 0xdeadbeef, `${name}: atomic_load_32`);
    gram.gram_atomic_store_32(544, 0x0badf00d | 0);
    assert.equal(view.getUint32(544, true), 0x0badf00d, `${name}: atomic_store_32`);
    assert.throws(() => gram.gram_atomic_load_32(545), WebAssembly.RuntimeError,
        `${name}: misaligned atomic_load_32 traps`);

    assert.equal(gram.gram_notify(544, 1), 0, `${name}: notify with no waiters returns 0`);
    assert.equal(typeof gram.gram_wait32, "function", `${name}: wait32 export exists`);

    gram.gram_fence();
}

// limits subtyping: the import declares {min: 0, max: 65536 pages}, so any
// smaller actual memory (with a maximum) must link — including much larger
// initial sizes than the tests above use
{
    const guest_memory = make_guest_memory(true, 1024); // 64 MB, {initial: 1024, maximum: 1024}
    const gram = instantiate(shared_module, guest_memory);
    gram.gram_write32(1023 * PAGE, 42);
    assert.equal(gram.gram_read32(1023 * PAGE), 42, "shared 1024-page memory satisfies {0, 65536} import");
}
{
    const gram = instantiate(nonshared_module, make_guest_memory(false, 3));
    gram.gram_write8(2 * PAGE, 7);
    assert.equal(gram.gram_read8(2 * PAGE), 7, "non-shared 3-page memory satisfies {0, 65536} import");
}

// a memory without a maximum cannot satisfy an import that declares one
assert.throws(
    () => instantiate(nonshared_module, new WebAssembly.Memory({ initial: 1 })),
    WebAssembly.LinkError,
    "memory without maximum must not link");

// shared-ness must match exactly — the reason both variants exist
assert.throws(
    () => instantiate(shared_module, make_guest_memory(false, 1)),
    WebAssembly.LinkError,
    "shared import must not link against a non-shared memory");
assert.throws(
    () => instantiate(nonshared_module, make_guest_memory(true, 1)),
    WebAssembly.LinkError,
    "non-shared import must not link against a shared memory");

// gram_wait32 (runtime shared-only, from an agent that may block): a worker
// instantiates gram-shared.wasm over the same shared memory and drives all
// three wait32 outcomes; the main thread wakes it through gram_notify. The
// non-shared variant only asserts the export's existence above — per the
// threads spec the wait instruction validates on unshared memories but
// traps at runtime there (it could never be woken).
{
    const guest_memory = make_guest_memory(true, 2);
    const gram = instantiate(shared_module, guest_memory);
    const i32 = new Int32Array(guest_memory.buffer);
    const WAIT_ADDR = 640;
    i32[WAIT_ADDR >> 2] = 7;

    const worker = new Worker(
        `
        const { parentPort, workerData } = require("node:worker_threads");
        const { module_bytes, guest_memory } = workerData;
        const wm = new WebAssembly.Module(module_bytes);
        const gram = new WebAssembly.Instance(wm, { "env": { guest_memory } }).exports;
        const WAIT_ADDR = ${WAIT_ADDR};
        const results = {
            // value is 7, expected 8 -> immediate 1 ("not-equal"; the agent
            // never enters the wait queue)
            not_equal: gram.gram_wait32(WAIT_ADDR, 8, -1n),
            // separate never-notified address (the main thread's notify loop
            // must not be able to catch this wait): value matches -> blocks;
            // 1 ms timeout -> 2 ("timed-out")
            timed_out: gram.gram_wait32(WAIT_ADDR + 4, 0, 1_000_000n),
            // value matches, infinite timeout -> woken by main -> 0 ("ok")
            woken: gram.gram_wait32(WAIT_ADDR, 7, -1n),
        };
        parentPort.postMessage(results);
        `,
        { eval: true, workerData: { module_bytes: shared_module, guest_memory } });

    const results = new Promise((resolve, reject) =>
    {
        worker.on("message", resolve);
        worker.on("error", reject);
    });
    // wake the third wait; loop until the notify reports a woken agent, which
    // also verifies notify's return value from a live waiter
    let worker_failed = null;
    worker.on("error", e => { worker_failed = e; });
    const deadline = Date.now() + 30_000;
    let woken = 0;
    while(woken === 0)
    {
        if(worker_failed) throw worker_failed;
        assert(Date.now() < deadline, "wait32 worker must reach the infinite wait");
        woken = gram.gram_notify(WAIT_ADDR, 1);
    }
    assert.equal(woken, 1, "notify reports exactly one woken waiter");
    assert.deepEqual(await results, { not_equal: 1, timed_out: 2, woken: 0 },
        "wait32 returns not-equal/timed-out/ok from a worker on shared memory");
    await worker.terminate();
}
