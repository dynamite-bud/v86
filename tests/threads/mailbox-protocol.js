#!/usr/bin/env node

// XWAH-9 Layer A (docs/smp-thread-test-plan.md): executable reference
// implementation of the Phase 4 device-mailbox RPC from
// docs/smp-phase3-design.md §3 — "one 64-byte record per vCPU
// ({state, op, addr, size, value_lo, value_hi}), worker does
// store+notify+wait; device side is the main thread via Atomics.waitAsync".
//
// Since Stage W1 the protocol implementation lives in src/browser/smpctl.js
// (mailbox_request / mailbox_service / mailbox_wait_for_request — the same
// functions the worker runtime and the device host use), so this test is
// normative BY USAGE: it drives the production functions over a bare
// 64-byte record and asserts the protocol's guarantees.
//
// The worker plays a vCPU issuing synchronous "port I/O": mailbox_request
// fills the record with plain field writes, publishes them with a seq-cst
// Atomics.store on STATE (which is what makes the plain writes visible —
// see shared-view-coherence.js), notifies, and BLOCKS in Atomics.wait until
// the main thread flips STATE to RESPONSE. The main thread plays the device
// host: it may not block, so it parks in Atomics.waitAsync and services
// requests as they arrive. The device model is an I/O-port register file:
// OUT stores value_lo at addr, IN returns it.
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
import {
    CTL_MAILBOX_BYTES,
    MAILBOX_SEQ, MAILBOX_OP_OUT, MAILBOX_OP_IN,
    mailbox_request, mailbox_service, mailbox_wait_for_request,
} from "../../src/browser/smpctl.js";

process.on("unhandledRejection", exn => { throw exn; });

const PAIRS = 5_000;
const TOTAL = PAIRS * 2;
const WAIT_TIMEOUT_MS = 10_000;

// this test is vCPU 0 over a bare control SAB, so its record is at word 0
const RECORD = 0;

const PORT = 0xe9;

function worker_main()
{
    const ctl = new Int32Array(workerData.control_sab);
    const latencies_ns = new Float64Array(TOTAL);

    let request_index = 0;
    for(let i = 0; i < PAIRS; i++)
    {
        for(const op of [MAILBOX_OP_OUT, MAILBOX_OP_IN])
        {
            ctl[RECORD + MAILBOX_SEQ] = request_index;
            const begin = process.hrtime.bigint();
            // blocking round-trip; throws when the device never responds
            const result = mailbox_request(
                ctl, RECORD, op, PORT, 4, op === MAILBOX_OP_OUT ? i : 0, WAIT_TIMEOUT_MS);
            latencies_ns[request_index] = Number(process.hrtime.bigint() - begin);
            if(op === MAILBOX_OP_IN)
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
    const control_sab = new SharedArrayBuffer(CTL_MAILBOX_BYTES);
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
        const handled = mailbox_service(ctl, RECORD, (op, addr, size, value_lo, value_hi, seq) =>
        {
            // the seq-cst STATE load inside mailbox_service acquired the
            // worker's plain field writes
            assert.equal(seq, expected_seq, "requests must arrive in issue order");
            assert.equal(addr, PORT, "port number intact");
            assert.equal(size, 4, "size field intact");
            assert.equal(value_hi, 0, "value_hi untouched");
            if(op === MAILBOX_OP_OUT)
            {
                port_registers.set(addr, value_lo);
                return undefined;
            }
            assert.equal(op, MAILBOX_OP_IN, "known op");
            return port_registers.get(addr) ?? -1;
        });
        if(handled)
        {
            expected_seq++;
            serviced++;
        }
        else
        {
            // main thread must not block: park in waitAsync until notified.
            // A stale snapshot just resolves "not-equal" and we re-inspect.
            const arrived = await mailbox_wait_for_request(ctl, RECORD, WAIT_TIMEOUT_MS);
            assert(arrived, "device host: no request arrived");
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
