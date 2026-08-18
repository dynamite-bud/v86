#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W2 boot-regression gate (docs/smp-phase4-design.md
// §9 W2): boot-time comparison of worker mode (the whole machine inside one
// worker, devices RPC'd to the main thread) against time-sliced execution
// over the SAME imported shared guest memory and the SAME multimem
// artifact — so the ratio isolates exactly the worker topology's cost
// (mailbox RPCs for PIO/MMIO, ring-hop IRQ delivery, device-tick split).
//
// Measures construction -> serial boot marker on linux4.iso, RUNS runs per
// mode interleaved, compares medians, gate: worker median <= 1.25x
// time-sliced median.
//
// Deliberately not part of `make threads-test` (six sequential guest boots;
// minutes of wall clock) — this is the stage-gate harness, run explicitly:
//     ./tests/threads/machine-in-worker-boottime.js

import url from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";
import { install_node_web_worker } from "../node_web_worker.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = __dirname + "/../..";

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const multimem_wasm = root_path +
    (TEST_RELEASE_BUILD ? "/build/v86-multimem.wasm" : "/build/v86-multimem-debug.wasm");
if(!fs.existsSync(multimem_wasm) || !fs.existsSync(root_path + "/images/linux4.iso"))
{
    console.log("Missing multimem artifact or images/linux4.iso, test skipped");
    process.exit(0);
}

install_node_web_worker();

const WORKER_URL = new URL("../../src/browser/vcpu_worker.js", import.meta.url);
const RUNS = 3;
const MARKER = "Files send via emulator appear in";
const GATE = 1.25;
const TIMEOUT_FACTOR = +process.env.TIMEOUT_EXTRA_FACTOR || 1;

async function boot_once(workers)
{
    const begin = performance.now();
    const emulator = new V86({
        bios: { url: root_path + "/bios/seabios.bin" },
        vga_bios: { url: root_path + "/bios/vgabios.bin" },
        cdrom: { url: root_path + "/images/linux4.iso", async: false },
        autostart: true,
        log_level: 0,
        smp_workers: workers,
        smp_worker_url: WORKER_URL,
        guest_memory_backend: "imported",
        guest_memory_shared: true,
        disable_jit: +process.env.DISABLE_JIT,
    });
    emulator.add_listener("emulator-error", e => { throw e; });

    let serial = "";
    const elapsed = await new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(
            () => reject(new Error("boot timeout. Serial:\n" + serial)),
            300 * TIMEOUT_FACTOR * 1000);
        emulator.add_listener("serial0-output-byte", byte =>
        {
            serial += String.fromCharCode(byte);
            if(byte === 0x0A && serial.includes(MARKER))
            {
                clearTimeout(timeout);
                resolve(performance.now() - begin);
            }
        });
    });
    assert.equal(emulator.smp_mode["execution"], workers ? "workers" : "time-sliced",
        "resolved execution mode");
    await emulator.destroy();
    return elapsed;
}

const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];

const worker_times = [];
const sliced_times = [];
for(let run = 0; run < RUNS; run++)
{
    // interleaved so host thermal/load drift hits both modes evenly
    sliced_times.push(await boot_once(false));
    console.log(`run ${run + 1}: time-sliced ${(sliced_times.at(-1) / 1000).toFixed(2)}s`);
    worker_times.push(await boot_once(true));
    console.log(`run ${run + 1}: workers     ${(worker_times.at(-1) / 1000).toFixed(2)}s`);
}

const sliced = median(sliced_times);
const workers = median(worker_times);
const ratio = workers / sliced;
console.log(`\nlinux4.iso boot to serial marker, ${RUNS} runs each:`);
console.log(`  time-sliced (imported, shared): median ${(sliced / 1000).toFixed(2)}s ` +
    `[${sliced_times.map(t => (t / 1000).toFixed(2)).join(", ")}]`);
console.log(`  workers (topology c):           median ${(workers / 1000).toFixed(2)}s ` +
    `[${worker_times.map(t => (t / 1000).toFixed(2)).join(", ")}]`);
console.log(`  ratio ${ratio.toFixed(3)} (gate: <= ${GATE})`);
assert(ratio <= GATE,
    `worker-mode boot regression ${ratio.toFixed(3)} exceeds the ${GATE} gate`);
console.log("Tests passed");
process.exit(0);
