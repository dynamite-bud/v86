#!/usr/bin/env node

// XWAH-9 Layer B (docs/smp-thread-test-plan.md): the full multimem build
// over shared guest memory — main thread runs a guest (SeaBIOS POST, no
// disk) while a worker drives concurrent JS-view traffic against a disjoint
// region of the SAME shared guest RAM (the Phase 4 device/worker shape).
//
// GATED: build/v86-multimem-debug.wasm is produced by Stage 4
// (docs/smp-phase3-design.md §4), which is being implemented on a sibling
// branch. Until the artifact and the Stage 5 JS integration exist this test
// skips cleanly (the repo's established missing-artifact pattern).
//
// ASSUMPTIONS against the documented Stage 4/5 interfaces — finalize when
// Stage 4/5 merge (each assumption is asserted or gated, never silent):
//   A1. Stage 5 adds `options.guest_memory_backend: "imported"` to V86
//       (design §4 Stage 5) and selects build/v86-multimem-debug.wasm +
//       gram instantiation itself; detection below greps starter.js for the
//       option name and skips when the JS integration has not merged.
//   A2. In Node (no crossOriginIsolated gate) the imported guest memory is
//       created shared; guest RAM is reachable as a SharedArrayBuffer via
//       emulator.v86.cpu.mem8.buffer (the retargeted view of AGENTS.md §2 /
//       design §0 "JS consumers"). If the backing is non-shared the
//       cross-thread half is skipped with a message.
//   A3. The public read_memory/write_memory API (v86.d.ts:986/994) stays
//       routed through the imported memory.
//   A4. SeaBIOS POST does not touch the scratch region at 48 MiB of a
//       64 MiB machine (BIOS works in low memory + top-of-ram tables).

import url from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

process.on("unhandledRejection", exn => { throw exn; });

const SCRATCH = 48 * 1024 * 1024;   // disjoint from anything SeaBIOS uses (A4)
const COUNTER = SCRATCH;            // i32 the worker hammers atomically
const PATTERN = SCRATCH + 64;       // region for plain-visibility checks
const PATTERN_LEN = 4096;
const WORKER_ADDS = 1_000_000;

function worker_main()
{
    // concurrent JS-view traffic: what a Phase 4 device/IO worker does —
    // plain pattern writes plus atomic doorbell-style counter increments,
    // all through TypedArray views of the shared guest RAM (no wasm here).
    const i32 = new Int32Array(workerData.buffer);
    const bytes = new Uint8Array(workerData.buffer);
    for(let i = 0; i < PATTERN_LEN; i++)
    {
        bytes[PATTERN + i] = (i * 11 + 3) & 0xff;
    }
    for(let i = 0; i < WORKER_ADDS; i++)
    {
        Atomics.add(i32, COUNTER >> 2, 1);
    }
    parentPort.postMessage("done");
}

async function main()
{
    const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
    const root_path = __dirname + "/../..";

    if(!fs.existsSync(root_path + "/build/v86-multimem-debug.wasm"))
    {
        console.log("Missing build/v86-multimem-debug.wasm, test skipped");
        process.exit(0);
    }
    // A1: Stage 5 JS integration present?
    const starter_source = fs.readFileSync(root_path + "/src/browser/starter.js", "utf8");
    if(!starter_source.includes("guest_memory_backend"))
    {
        console.log("build/v86-multimem-debug.wasm exists but starter.js has no " +
            "guest_memory_backend option (Stage 5 not merged), test skipped");
        process.exit(0);
    }

    const { V86 } = await import("../../src/main.js");

    const emulator = new V86({
        bios: { url: root_path + "/bios/seabios.bin" },
        vga_bios: { url: root_path + "/bios/vgabios.bin" },
        autostart: true,
        memory_size: 64 * 1024 * 1024,
        guest_memory_backend: "imported",   // A1
        log_level: 0,
    });

    await new Promise(resolve => emulator.add_listener("emulator-started", resolve));

    // A2: guest RAM must be the imported (shared) memory
    const buffer = emulator.v86.cpu.mem8.buffer;
    if(!(buffer instanceof SharedArrayBuffer))
    {
        console.log("imported guest memory is not SharedArrayBuffer-backed in Node, " +
            "cross-thread half skipped");
        emulator.destroy();
        process.exit(0);
    }

    // let SeaBIOS actually execute concurrently with the worker below
    const worker = new Worker(new URL(import.meta.url), { workerData: { buffer } });
    await new Promise((resolve, reject) =>
    {
        worker.on("error", reject);
        worker.on("exit", code =>
            code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
    });

    // atomic traffic from the worker must be exact despite the running guest
    const counter = new DataView(buffer).getUint32(COUNTER, true);
    assert.equal(counter, WORKER_ADDS, "worker atomic adds on live guest RAM are exact");

    // worker plain writes visible through the public device-facing API (A3);
    // worker-join (exit message) is the happens-before edge here
    const readback = emulator.read_memory(PATTERN, PATTERN_LEN);
    for(let i = 0; i < PATTERN_LEN; i++)
    {
        assert.equal(readback[i], (i * 11 + 3) & 0xff, `pattern byte ${i} via read_memory`);
    }

    // and the reverse: main-thread write_memory lands in the shared buffer
    emulator.write_memory([0x12, 0x34, 0x56, 0x78], PATTERN);
    const bytes = new Uint8Array(buffer);
    assert.equal(bytes[PATTERN], 0x12, "write_memory visible in the shared buffer");
    assert.equal(bytes[PATTERN + 3], 0x78, "write_memory visible in the shared buffer");

    // the guest must still be alive after all of that
    assert(emulator.is_running(), "guest still running after concurrent JS-view traffic");

    emulator.destroy();
    console.log(`multimem: SeaBIOS ran while a worker did ${WORKER_ADDS} atomic adds (exact) ` +
        `+ ${PATTERN_LEN}-byte plain traffic on shared guest RAM`);
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
