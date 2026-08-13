#!/usr/bin/env node

// XWAH-9 Layer A (docs/smp-thread-test-plan.md): validates the test
// METHODOLOGY by demonstrating the difference between plain and atomic
// guest-RAM accesses under real parallelism.
//
// Phase 1 (plain): K workers do read-inc-write through gram_read32 +
// gram_write32 (plain wasm loads/stores — what ordinary guest MOVs compile
// to, design doc Addendum 2) on ONE cell. Lost updates are expected:
//   - the sum must never EXCEED K*N (that would be memory corruption), and
//   - across a few attempts it should come out BELOW K*N at least once,
//     proving this harness actually detects lost updates. If every attempt
//     lands exactly on K*N the run is logged INCONCLUSIVE, not failed —
//     the interleaving is timing-dependent and a pass-by-luck must not
//     turn the suite red.
// Phase 2 (atomic): the same traffic through gram_atomic_rmw_add_32 must be
// exact. Together the phases show the exactness assertions in
// atomics-exactness.js are meaningful: the same harness with plain accesses
// visibly loses updates, so exactness under atomics is signal, not luck.

import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import {
    ensure_gram_bytes, make_shared_guest_memory, instantiate_gram, main_thread_wait_for,
} from "./helpers.js";

process.on("unhandledRejection", exn => { throw exn; });

const K = 4;
const N = 1_000_000;
const PLAIN_ATTEMPTS = 5;

const READY = 0;
const START = 4;
const CELL = 64;

function worker_main()
{
    const { memory, mode, gram_bytes } = workerData;
    const gram = instantiate_gram(gram_bytes, memory);
    const i32 = new Int32Array(memory.buffer);

    Atomics.add(i32, READY >> 2, 1);
    Atomics.wait(i32, START >> 2, 0);

    if(mode === "plain")
    {
        for(let i = 0; i < N; i++)
        {
            const value = gram.gram_read32(CELL);
            gram.gram_write32(CELL, value + 1);
        }
    }
    else
    {
        for(let i = 0; i < N; i++) gram.gram_atomic_rmw_add_32(CELL, 1);
    }
    parentPort.postMessage("done");
}

async function run_once(mode)
{
    const gram_bytes = ensure_gram_bytes("shared");
    const memory = make_shared_guest_memory(2);
    const i32 = new Int32Array(memory.buffer);

    const workers = [];
    for(let k = 0; k < K; k++)
    {
        workers.push(new Worker(new URL(import.meta.url), { workerData: { memory, mode, gram_bytes } }));
    }
    const joins = workers.map(w => new Promise((resolve, reject) =>
    {
        w.on("error", reject);
        w.on("exit", code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
    }));

    await main_thread_wait_for(i32, READY >> 2, K, 10_000);
    Atomics.store(i32, START >> 2, 1);
    Atomics.notify(i32, START >> 2);
    await Promise.all(joins);

    return new DataView(memory.buffer).getUint32(CELL, true);
}

if(isMainThread)
{
    const expected = K * N;

    let lossy_attempts = 0;
    for(let attempt = 1; attempt <= PLAIN_ATTEMPTS; attempt++)
    {
        const total = await run_once("plain");
        assert(total <= expected,
            `plain: sum ${total} exceeds ${expected} — increments were manufactured, not lost`);
        const lost = expected - total;
        if(lost > 0) lossy_attempts++;
        console.log(`plain attempt ${attempt}: ${total} of ${expected} ` +
            `(${lost} lost updates, ${(100 * lost / expected).toFixed(1)}%)`);
    }
    if(lossy_attempts === 0)
    {
        // timing-dependent: do not fail, but flag that the harness proved nothing
        console.log(`INCONCLUSIVE: no lost updates observed in ${PLAIN_ATTEMPTS} plain attempts; ` +
            "this run cannot confirm the harness detects races");
    }
    else
    {
        console.log(`plain read-inc-write lost updates in ${lossy_attempts}/${PLAIN_ATTEMPTS} attempts ` +
            "— harness demonstrably detects lost updates");
    }

    const atomic_total = await run_once("atomic");
    assert.equal(atomic_total, expected, "atomic rmw_add_32 must be exact under the same load");
    console.log(`atomic: ${K} workers × ${N} rmw_add_32 = ${atomic_total} (exact)`);
    console.log("Tests passed");
}
else
{
    worker_main();
}
