#!/usr/bin/env node

// XWAH-9 Layer A (docs/smp-thread-test-plan.md): the device-model pattern —
// wasm-side gram accessor writes on one thread, plain JS TypedArray views of
// the SAME shared guest memory on another (docs/smp-phase3-design.md §3:
// main-thread devices keep direct views; virtio rings/DMA never RPC).
//
// WHY THE HANDSHAKE IS REQUIRED: plain (non-atomic) writes to a shared
// memory come with NO cross-thread visibility or ordering guarantee by
// themselves — the JS/wasm shared-memory model only orders seq-cst atomic
// operations, and on weakly-ordered hosts (ARM Macs included, see the
// design doc's Addendum 2 TSO note) plain stores can genuinely be observed
// late or out of order. The Atomics.store(FLAG)+notify / Atomics.wait(FLAG)
// pair below is the publication edge: writes sequenced before the atomic
// store happen-before reads sequenced after the atomic load that observes
// it. This is exactly why Phase 4 device doorbells and mailbox STATE words
// must be atomic while the bulk payload (ring descriptors, DMA data) can
// stay plain: the payload borrows its visibility from the doorbell.
//
// Direction 1: worker writes a pattern through EVERY gram write-side export
// (write8/16/32/64/128, memset, memcpy), handshakes, main thread verifies
// through DataView/Uint8Array. Direction 2: main thread writes through JS
// views, handshakes, worker verifies through gram read accessors and
// reports mismatches.

import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import {
    ensure_gram_bytes, make_shared_guest_memory, instantiate_gram, main_thread_wait_for,
} from "./helpers.js";

process.on("unhandledRejection", exn => { throw exn; });

const FLAG = 0;                    // i32 handshake cell (byte offset 0)
const WORKER_WROTE = 1;
const MAIN_WROTE = 2;

// direction-1 pattern layout (worker writes via gram, main reads via views)
const W8 = 64;
const W16 = 66;
const W32 = 68;
const W64 = 72;
const W128 = 80;
const MEMSET_AT = 96;
const MEMSET_LEN = 32;
const MEMCPY_DST = 160;
const MEMCPY_LEN = 16;

// direction-2 region (main writes via views, worker reads via gram)
const JS_REGION = 0x200;
const JS_LEN = 4096;

function worker_main()
{
    const { memory, gram_bytes } = workerData;
    const gram = instantiate_gram(gram_bytes, memory);
    const i32 = new Int32Array(memory.buffer);

    // direction 1: write the pattern through every gram write export
    gram.gram_write8(W8, 0xa1);
    gram.gram_write16(W16, 0xb2c3);
    gram.gram_write32(W32, 0xd4e5f607);
    gram.gram_write64(W64, 0x1122334455667788n);
    gram.gram_write128(W128, 0xdeadbeefcafef00dn, 0x0123456789abcdefn);
    gram.gram_memset(MEMSET_AT, 0x5c, MEMSET_LEN);
    for(let i = 0; i < MEMCPY_LEN; i++) gram.gram_write8(MEMSET_AT + i, i + 1);
    gram.gram_memcpy(MEMSET_AT, MEMCPY_DST, MEMCPY_LEN);
    // publish: everything above happens-before a main-thread read that
    // observes FLAG === WORKER_WROTE
    Atomics.store(i32, FLAG, WORKER_WROTE);
    Atomics.notify(i32, FLAG);

    // direction 2: wait for the main thread's plain-view writes
    Atomics.wait(i32, FLAG, WORKER_WROTE);
    assert.equal(Atomics.load(i32, FLAG), MAIN_WROTE);
    const mismatches = [];
    for(let i = 0; i < JS_LEN; i++)
    {
        const expected = (i * 7 + 13) & 0xff;
        const got = gram.gram_read8(JS_REGION + i);
        if(got !== expected) mismatches.push({ at: JS_REGION + i, expected, got });
    }
    // and the wider read accessors over the same region
    const dv = new DataView(new ArrayBuffer(8));
    for(let i = 0; i < 8; i++) dv.setUint8(i, ((JS_REGION + i) - JS_REGION) * 7 + 13 & 0xff);
    if(gram.gram_read16(JS_REGION) !== dv.getUint16(0, true)) mismatches.push({ at: "read16" });
    if((gram.gram_read32(JS_REGION) >>> 0) !== dv.getUint32(0, true)) mismatches.push({ at: "read32" });
    if(BigInt.asUintN(64, gram.gram_read64(JS_REGION)) !== dv.getBigUint64(0, true)) mismatches.push({ at: "read64" });

    parentPort.postMessage({ mismatches });
}

async function main()
{
    const gram_bytes = ensure_gram_bytes("shared");
    const memory = make_shared_guest_memory(2);
    const i32 = new Int32Array(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);

    const worker = new Worker(new URL(import.meta.url), { workerData: { memory, gram_bytes } });
    const worker_result = new Promise((resolve, reject) =>
    {
        let message = null;
        worker.on("message", m => { message = m; });
        worker.on("error", reject);
        worker.on("exit", code =>
            code === 0 ? resolve(message) : reject(new Error(`worker exit ${code}`)));
    });

    // direction 1: acquire the worker's writes, then read via plain views
    await main_thread_wait_for(i32, FLAG, WORKER_WROTE, 10_000);
    assert.equal(view.getUint8(W8), 0xa1, "write8 visible through JS view");
    assert.equal(view.getUint16(W16, true), 0xb2c3, "write16 visible");
    assert.equal(view.getUint32(W32, true), 0xd4e5f607, "write32 visible");
    assert.equal(view.getBigUint64(W64, true), 0x1122334455667788n, "write64 visible");
    assert.equal(view.getBigUint64(W128, true), 0xdeadbeefcafef00dn, "write128 low half visible");
    assert.equal(view.getBigUint64(W128 + 8, true), 0x0123456789abcdefn, "write128 high half visible");
    for(let i = MEMCPY_LEN; i < MEMSET_LEN; i++)
    {
        assert.equal(bytes[MEMSET_AT + i], 0x5c, `memset byte ${i} visible`);
    }
    for(let i = 0; i < MEMCPY_LEN; i++)
    {
        assert.equal(bytes[MEMCPY_DST + i], i + 1, `memcpy byte ${i} visible`);
    }
    console.log("direction 1: all gram write accessors visible through JS views after handshake");

    // direction 2: plain JS-view writes, published by the FLAG store
    for(let i = 0; i < JS_LEN; i++)
    {
        bytes[JS_REGION + i] = (i * 7 + 13) & 0xff;
    }
    Atomics.store(i32, FLAG, MAIN_WROTE);
    Atomics.notify(i32, FLAG);

    const { mismatches } = await worker_result;
    assert.deepEqual(mismatches, [],
        "every JS-view write visible through gram read accessors after handshake");
    console.log(`direction 2: ${JS_LEN}-byte JS-view pattern visible through gram reads after handshake`);
    console.log("Tests passed");
}

if(isMainThread)
{
    await main();
}
else
{
    worker_main();
}
