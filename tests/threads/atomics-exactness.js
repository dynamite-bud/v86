#!/usr/bin/env node

// XWAH-9 Layer A (docs/smp-thread-test-plan.md): the gram atomic RMW exports
// are REALLY atomic across threads. K worker_threads, each with its OWN
// gram-shared.wasm instance imported over the SAME shared guest memory (the
// Phase 4 per-vCPU shape), hammer one cell; the total must be EXACT.
//
// This is the property Phase 4's LOCK-prefix lowering stands on: a wasm
// i32.atomic.rmw.add emitted by code we generate, executed from different
// wasm instances on different threads against one imported shared memory,
// must never lose an update. A single lost increment here would mean
// guest spinlocks/refcounts can corrupt under worker vCPUs.
//
// Three phases:
//   1. add_32: K×N atomic adds on one 32-bit cell → sum exactly K*N.
//   2. mixed width: per-iteration add_8 + add_16 + add_32 on DISJOINT cells;
//      32-bit sum exact, 8/16-bit sums exact modulo width, and guard bytes
//      adjacent to the 8-bit cell stay untouched (atomics touch only their
//      access width — no read-modify-write of neighbouring bytes).
//   3. cmpxchg: workers CAS-loop a shared counter; every success is exactly
//      one increment, so the final value is exactly K*CAS_N.

import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import {
    ensure_gram_bytes, make_shared_guest_memory, instantiate_gram, main_thread_wait_for,
} from "./helpers.js";

process.on("unhandledRejection", exn => { throw exn; });

const K = 4;                 // worker count
const N = 1_000_000;         // atomic adds per worker, phase 1
const MIX_N = 250_000;       // iterations per worker, phase 2
const CAS_N = 100_000;       // successful CAS increments per worker, phase 3

// guest-memory byte offsets (all disjoint)
const READY = 0;             // i32: workers arrived (atomic add)
const START = 4;             // i32: start gate (workers Atomics.wait here)
const COUNTER32 = 64;        // phase 1 cell
const MIX8 = 128;            // phase 2 8-bit cell, guards at 127 and 129
const MIX16 = 132;           // phase 2 16-bit cell
const MIX32 = 136;           // phase 2 32-bit cell
const CAS_CELL = 192;        // phase 3 cell
const GUARD = 0xa5;

function worker_main()
{
    // gram bytes arrive via workerData: only the main thread touches the
    // generator, so workers can never observe a half-written artifact
    const { memory, phase, gram_bytes } = workerData;
    const gram = instantiate_gram(gram_bytes, memory);
    const i32 = new Int32Array(memory.buffer);

    // start barrier: everyone contends from the first iteration
    Atomics.add(i32, READY >> 2, 1);
    Atomics.wait(i32, START >> 2, 0);

    let retries = 0;
    if(phase === "add32")
    {
        for(let i = 0; i < N; i++) gram.gram_atomic_rmw_add_32(COUNTER32, 1);
    }
    else if(phase === "mixed")
    {
        for(let i = 0; i < MIX_N; i++)
        {
            gram.gram_atomic_rmw_add_8(MIX8, 1);
            gram.gram_atomic_rmw_add_16(MIX16, 1);
            gram.gram_atomic_rmw_add_32(MIX32, 1);
        }
    }
    else if(phase === "cmpxchg")
    {
        let successes = 0;
        // seed the loop with one atomic read (add of 0)
        let expected = gram.gram_atomic_rmw_add_32(CAS_CELL, 0);
        while(successes < CAS_N)
        {
            const old = gram.gram_atomic_rmw_cmpxchg_32(CAS_CELL, expected, expected + 1);
            if(old === expected)
            {
                successes++;
                expected = old + 1;
            }
            else
            {
                retries++;
                expected = old;
            }
        }
    }
    else
    {
        throw new Error(`unknown phase ${phase}`);
    }
    parentPort.postMessage({ retries });
}

async function run_phase(phase)
{
    const gram_bytes = ensure_gram_bytes("shared");
    const memory = make_shared_guest_memory(2);
    const bytes = new Uint8Array(memory.buffer);
    const i32 = new Int32Array(memory.buffer);
    bytes[MIX8 - 1] = GUARD;
    bytes[MIX8 + 1] = GUARD;

    const started = performance.now();
    const workers = [];
    for(let k = 0; k < K; k++)
    {
        workers.push(new Worker(new URL(import.meta.url), { workerData: { memory, phase, gram_bytes } }));
    }
    const results = workers.map(w => new Promise((resolve, reject) =>
    {
        let message = null;
        w.on("message", m => { message = m; });
        w.on("error", reject);
        w.on("exit", code => code === 0 ? resolve(message) : reject(new Error(`worker exit ${code}`)));
    }));

    await main_thread_wait_for(i32, READY >> 2, K, 10_000);
    Atomics.store(i32, START >> 2, 1);
    Atomics.notify(i32, START >> 2);
    const messages = await Promise.all(results);
    const elapsed_ms = performance.now() - started;

    const view = new DataView(memory.buffer);
    if(phase === "add32")
    {
        const total = view.getUint32(COUNTER32, true);
        assert.equal(total, K * N, `add_32: ${K}×${N} atomic adds must sum exactly`);
        console.log(`add32: ${K} workers × ${N} rmw_add_32 on one cell = ${total} (exact), ${elapsed_ms.toFixed(0)} ms`);
    }
    else if(phase === "mixed")
    {
        const total = K * MIX_N;
        assert.equal(view.getUint32(MIX32, true), total, "mixed: 32-bit cell exact");
        assert.equal(view.getUint16(MIX16, true), total % 0x10000, "mixed: 16-bit cell exact mod 2^16");
        assert.equal(view.getUint8(MIX8), total % 0x100, "mixed: 8-bit cell exact mod 2^8");
        assert.equal(bytes[MIX8 - 1], GUARD, "mixed: byte below the 8-bit cell untouched");
        assert.equal(bytes[MIX8 + 1], GUARD, "mixed: byte above the 8-bit cell untouched");
        console.log(`mixed: ${K} workers × ${MIX_N} its (8/16/32 disjoint) — 32-bit=${total}, ` +
            `16-bit=${total % 0x10000}, 8-bit=${total % 0x100}, guards intact, ${elapsed_ms.toFixed(0)} ms`);
    }
    else if(phase === "cmpxchg")
    {
        const total = view.getUint32(CAS_CELL, true);
        assert.equal(total, K * CAS_N, `cmpxchg: ${K}×${CAS_N} CAS successes must sum exactly`);
        const retries = messages.reduce((a, m) => a + m.retries, 0);
        console.log(`cmpxchg: ${K} workers × ${CAS_N} CAS-loop increments = ${total} (exact), ` +
            `${retries} retries total, ${elapsed_ms.toFixed(0)} ms`);
    }
}

if(isMainThread)
{
    await run_phase("add32");
    await run_phase("mixed");
    await run_phase("cmpxchg");
    console.log("Tests passed");
}
else
{
    worker_main();
}
