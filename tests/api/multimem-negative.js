#!/usr/bin/env node
// Negative tests for guest_memory_backend "imported" (XWAH-9 Phase 3 final
// review findings 1 and 2a):
//
// 1. Missing gram artifact: wasm_path pointed at a directory that holds the
//    multimem artifact but no gram[-shared].wasm must fail LOUDLY — a
//    descriptive error on the "emulator-error" bus event plus an
//    asynchronous uncaught rethrow — not hang the init chain silently
//    (starter.js build_env + the init-chain .catch).
// 2. Multi-memory capability probe: the hand-assembled two-memory probe
//    module (starter.js MULTIMEM_PROBE_MODULE) must validate in this
//    engine, and corrupted variants must fail validation — proving
//    WebAssembly.validate actually discriminates on the multi-memory
//    shape the probe gates on.
//
// Always runs against the source tree (the probe export and the failure
// path under test live in src/browser/starter.js).

import url from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = __dirname + "/../..";

process.on("unhandledRejection", exn => { throw exn; });

const { V86 } = await import("../../src/main.js");
const { MULTIMEM_PROBE_MODULE } = await import("../../src/browser/starter.js");

// ---- 2. capability probe validates; corrupted probe does not ----

assert.ok(MULTIMEM_PROBE_MODULE instanceof Uint8Array && MULTIMEM_PROBE_MODULE.length > 8,
    "probe module bytes exported");
assert.ok(WebAssembly.validate(MULTIMEM_PROBE_MODULE),
    "the two-memory probe module must validate in this engine");

// memidx byte of the probe's i32.load memarg (…, 0x28, 0x42, memidx, 0x00,
// 0x1A, 0x0B): referencing memory index 2, which the module does not
// declare, must fail validation — the probe is sensitive to exactly the
// multi-memory indexing it gates on
const bad_memidx = MULTIMEM_PROBE_MODULE.slice();
assert.equal(bad_memidx[bad_memidx.length - 4], 0x01, "probe layout: memidx byte");
bad_memidx[bad_memidx.length - 4] = 0x02;
assert.ok(!WebAssembly.validate(bad_memidx),
    "probe referencing an undeclared memory index must not validate");

const bad_magic = MULTIMEM_PROBE_MODULE.slice();
bad_magic[0] = 0x01;
assert.ok(!WebAssembly.validate(bad_magic),
    "corrupted probe module must not validate");

console.log("probe validation checks passed");

// ---- 1. missing gram artifact fails loudly, not a hang ----

const multimem_artifact = root_path + "/build/v86-multimem-debug.wasm";
if(!fs.existsSync(multimem_artifact))
{
    console.log("Missing build/v86-multimem-debug.wasm, missing-gram phase skipped");
    console.log("Tests passed");
    process.exit(0);
}

// a directory holding the main artifact but no gram[-shared].wasm
// (build/ is the repo's ignored artifact directory)
const tmp_dir = root_path + "/build/multimem-negative-tmp";
fs.rmSync(tmp_dir, { recursive: true, force: true });
fs.mkdirSync(tmp_dir, { recursive: true });
fs.copyFileSync(multimem_artifact, tmp_dir + "/v86-multimem-debug.wasm");

let uncaught = null;
process.on("uncaughtException", e =>
{
    if(uncaught === null && /gram/.test(String(e && e.message || e)))
    {
        // the init chain's asynchronous rethrow — expected
        uncaught = e;
        return;
    }
    throw e;
});

const bus_error = await new Promise((resolve, reject) =>
{
    const timeout = setTimeout(
        () => reject(new Error("Hang: no emulator-error event within 30s")), 30000);

    const emulator = new V86({
        wasm_path: tmp_dir + "/v86-multimem-debug.wasm",
        guest_memory_backend: "imported",
        guest_memory_shared: false,
        memory_size: 16 * 1024 * 1024,
        autostart: false,
        log_level: 0,
    });

    emulator.add_listener("emulator-error", e =>
    {
        clearTimeout(timeout);
        resolve(e);
    });
});

assert.ok(bus_error instanceof Error, "emulator-error carries the failure");
assert.match(bus_error.message, /gram\.wasm/,
    "error must name the missing gram artifact");
assert.match(bus_error.message, /guest_memory_backend/,
    "error must name the option that requires the artifact");
console.log("emulator-error received: " + bus_error.message);

// the asynchronous rethrow must surface as an uncaught exception
await new Promise(resolve => setTimeout(resolve, 100));
assert.ok(uncaught, "init failure must also be rethrown asynchronously");
assert.equal(uncaught, bus_error, "rethrown error is the same failure");
console.log("async rethrow received");

fs.rmSync(tmp_dir, { recursive: true, force: true });

console.log("Tests passed");
process.exit(0);
