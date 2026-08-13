// Shared helpers for tests/threads (XWAH-9 multi-threaded test suite,
// docs/smp-thread-test-plan.md). Not a test itself — run-all.js skips it.
//
// Every Layer A test runs K worker_threads against ONE shared guest memory
// (a shared WebAssembly.Memory, SharedArrayBuffer-backed), each worker with
// its OWN gram-shared.wasm instance imported over that memory — the exact
// shape Phase 4 gives worker vCPUs (docs/smp-phase3-design.md §2 option A).

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

export const BUILD_DIR = path.resolve(__dirname, "../../build");
const GENERATOR = path.resolve(__dirname, "../../gen/generate_gram_wasm.js");

// Returns the bytes of build/gram-shared.wasm (or gram.wasm), invoking the
// generator first when the artifact is absent. The generator is a pure
// function of its source (asserted by tests/rust/verify-gram-wasm.js), so
// generating on demand is always safe.
export function ensure_gram_bytes(variant)
{
    assert(variant === "shared" || variant === "nonshared", "variant");
    const filename = variant === "shared" ? "gram-shared.wasm" : "gram.wasm";
    const file_path = path.join(BUILD_DIR, filename);
    if(!fs.existsSync(file_path))
    {
        const result = spawnSync(process.execPath,
            [GENERATOR, "--output-dir", BUILD_DIR, "--variant", variant]);
        assert.equal(result.status, 0, `gram generator failed: ${result.stderr}`);
    }
    return fs.readFileSync(file_path);
}

// Guest RAM as Phase 3 Stage 5 creates it: shared, maximum == initial.
export function make_shared_guest_memory(pages)
{
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
    assert(memory.buffer instanceof SharedArrayBuffer,
        "shared WebAssembly.Memory must be SharedArrayBuffer-backed");
    return memory;
}

// One gram instance per caller — worker threads each instantiate their own
// over the one shared memory, like per-vCPU wasm instances in Phase 4.
export function instantiate_gram(module_bytes, guest_memory)
{
    const wasm_module = new WebAssembly.Module(module_bytes);
    return new WebAssembly.Instance(wasm_module, { "env": { "guest_memory": guest_memory } }).exports;
}

// Waits (without blocking the main thread) until i32_view[index] === value.
// Poll + waitAsync hybrid: waitAsync alone is the Phase 4 main-thread
// pattern, the poll bound makes test hangs fail loudly instead of silently.
export async function main_thread_wait_for(i32_view, index, value, timeout_ms)
{
    const deadline = Date.now() + timeout_ms;
    for(;;)
    {
        const current = Atomics.load(i32_view, index);
        if(current === value) return;
        assert(Date.now() < deadline,
            `timed out waiting for cell ${index} to become ${value} (is ${current})`);
        const waited = Atomics.waitAsync(i32_view, index, current, 1000);
        if(waited.async) await waited.value;
    }
}

// Latency statistics over an array of nanosecond samples, reported in µs.
export function latency_stats_us(samples_ns)
{
    const sorted = Float64Array.from(samples_ns).sort();
    const to_us = x => x / 1e3;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return {
        n: sorted.length,
        min: to_us(sorted[0]),
        mean: to_us(sum / sorted.length),
        median: to_us(at(0.5)),
        p99: to_us(at(0.99)),
        max: to_us(sorted[sorted.length - 1]),
    };
}

export function format_stats_us(stats)
{
    const f = x => x.toFixed(2);
    return `n=${stats.n} min=${f(stats.min)}µs mean=${f(stats.mean)}µs ` +
        `median=${f(stats.median)}µs p99=${f(stats.p99)}µs max=${f(stats.max)}µs`;
}
