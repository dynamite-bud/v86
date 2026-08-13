#!/usr/bin/env node

// XWAH-9 Layer A (docs/smp-thread-test-plan.md): executable reference
// implementation of the Phase 4 device-mailbox RPC from
// docs/smp-phase3-design.md §3 — "one 64-byte record per vCPU
// ({state, op, addr, size, value_lo, value_hi}), worker does
// store+notify+wait; device side is the main thread via Atomics.waitAsync".
//
// The worker plays a vCPU issuing synchronous "port I/O": it fills the
// record, publishes it with a seq-cst Atomics.store on STATE (which is what
// makes the plain field writes visible — see shared-view-coherence.js),
// notifies, and BLOCKS in Atomics.wait until the main thread flips STATE to
// RESPONSE. The main thread plays the device host: it may not block, so it
// parks in Atomics.waitAsync and services requests as they arrive. The
// device model is an I/O-port register file: OUT stores value_lo at addr,
// IN returns it.
//
// Asserts, over 10_000 requests (5_000 OUT+IN pairs):
//   - every request is serviced (no lost wakeups in either direction),
//   - strictly in issue order (main thread checks an embedded sequence
//     number increments by exactly 1 each request),
//   - with correct values (worker checks every IN echoes the preceding OUT).
// Reports round-trip latency stats — the Phase 4 cost of a mailboxed port
// access, and the baseline for the §3 claim that hot paths must stay OFF
// the mailbox (virtio rings/DMA go through the shared RAM view instead).

import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { latency_stats_us, format_stats_us } from "./helpers.js";

process.on("unhandledRejection", exn => { throw exn; });

const PAIRS = 5_000;
const TOTAL = PAIRS * 2;
const WAIT_TIMEOUT_MS = 10_000;

// 64-byte per-vCPU record, i32-indexed over the control SAB (design §3).
// This test is vCPU 0, so its record is at byte offset 0.
const RECORD_BYTES = 64;
const STATE = 0;      // IDLE / REQUEST / RESPONSE — the only atomically-waited cell
const OP = 1;         // OP_OUT / OP_IN
const ADDR = 2;       // port number
const SIZE = 3;       // access size in bytes (carried, asserted, unused by the model)
const VALUE_LO = 4;   // OUT: value to write; IN: value returned by the device
const VALUE_HI = 5;   // upper half for 64-bit ops (unused here, must stay 0)
const SEQ = 6;        // test-only: issue sequence number for the order assertion

const IDLE = 0;
const REQUEST = 1;
const RESPONSE = 2;

const OP_OUT = 1;
const OP_IN = 2;

const PORT = 0xe9;

function worker_main()
{
    const ctl = new Int32Array(workerData.control_sab);
    const latencies_ns = new Float64Array(TOTAL);

    function request(op, addr, size, value)
    {
        // plain field writes, then seq-cst STATE store publishes them
        ctl[OP] = op;
        ctl[ADDR] = addr;
        ctl[SIZE] = size;
        ctl[VALUE_LO] = value;
        ctl[VALUE_HI] = 0;
        Atomics.store(ctl, STATE, REQUEST);
        Atomics.notify(ctl, STATE);
        while(Atomics.load(ctl, STATE) !== RESPONSE)
        {
            const outcome = Atomics.wait(ctl, STATE, REQUEST, WAIT_TIMEOUT_MS);
            assert.notEqual(outcome, "timed-out", "vCPU side: device never responded");
        }
        const result = ctl[VALUE_LO];
        Atomics.store(ctl, STATE, IDLE);
        return result;
    }

    let request_index = 0;
    for(let i = 0; i < PAIRS; i++)
    {
        for(const op of [OP_OUT, OP_IN])
        {
            ctl[SEQ] = request_index;
            const begin = process.hrtime.bigint();
            const result = request(op, PORT, 4, op === OP_OUT ? i : 0);
            latencies_ns[request_index] = Number(process.hrtime.bigint() - begin);
            if(op === OP_IN)
            {
                assert.equal(result, i, `IN must echo the preceding OUT (pair ${i})`);
            }
            request_index++;
        }
    }
    parentPort.postMessage(latencies_ns, [latencies_ns.buffer]);
}

async function device_host()
{
    const control_sab = new SharedArrayBuffer(RECORD_BYTES);
    const ctl = new Int32Array(control_sab);

    const worker = new Worker(new URL(import.meta.url), { workerData: { control_sab } });
    const worker_result = new Promise((resolve, reject) =>
    {
        let latencies = null;
        worker.on("message", m => { latencies = m; });
        worker.on("error", reject);
        worker.on("exit", code =>
            code === 0 ? resolve(latencies) : reject(new Error(`worker exit ${code}`)));
    });

    const port_registers = new Map();
    let serviced = 0;
    let expected_seq = 0;
    const deadline = Date.now() + 60_000;

    while(serviced < TOTAL)
    {
        assert(Date.now() < deadline, "device host: mailbox stalled");
        const state = Atomics.load(ctl, STATE);
        if(state === REQUEST)
        {
            // seq-cst STATE load acquired the worker's plain field writes
            assert.equal(ctl[SEQ], expected_seq, "requests must arrive in issue order");
            assert.equal(ctl[ADDR], PORT, "port number intact");
            assert.equal(ctl[SIZE], 4, "size field intact");
            assert.equal(ctl[VALUE_HI], 0, "value_hi untouched");
            if(ctl[OP] === OP_OUT)
            {
                port_registers.set(ctl[ADDR], ctl[VALUE_LO]);
            }
            else
            {
                assert.equal(ctl[OP], OP_IN, "known op");
                ctl[VALUE_LO] = port_registers.get(ctl[ADDR]) ?? -1;
            }
            expected_seq++;
            serviced++;
            Atomics.store(ctl, STATE, RESPONSE);
            Atomics.notify(ctl, STATE);
        }
        else
        {
            // main thread must not block: park in waitAsync until notified.
            // A stale `state` just returns "not-equal" and we re-inspect.
            const waited = Atomics.waitAsync(ctl, STATE, state, WAIT_TIMEOUT_MS);
            if(waited.async)
            {
                const outcome = await waited.value;
                assert.notEqual(outcome, "timed-out", "device host: no request arrived");
            }
        }
    }

    const latencies_ns = await worker_result;
    assert.equal(serviced, TOTAL, "every request serviced exactly once");
    assert.equal(latencies_ns.length, TOTAL);
    const stats = latency_stats_us(latencies_ns);
    console.log(`mailbox: ${TOTAL} port I/O RPCs serviced in order, values correct`);
    console.log(`round-trip latency: ${format_stats_us(stats)}`);
    console.log("Tests passed");
}

if(isMainThread)
{
    await device_host();
}
else
{
    worker_main();
}
