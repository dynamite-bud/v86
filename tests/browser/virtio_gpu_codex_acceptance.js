#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const READY_TIMEOUT_MS = Number(process.env.V86_CODEX_BROWSER_TIMEOUT_MS || 300000);
const PORT = Number(process.env.V86_CODEX_BROWSER_PORT || 8082);
const RELAY_URL = process.env.V86_CODEX_RELAY_URL || "";
const SCENARIO = process.env.V86_CODEX_BROWSER_SCENARIO || "appliance";
const MULTICORE_ACCELERATED = SCENARIO === "multi-core-accelerated";
const ACCELERATED = SCENARIO === "accelerated" || MULTICORE_ACCELERATED;
const OUTPUT_PATH = process.env.V86_CODEX_BROWSER_OUTPUT || "";
const BENCHMARK_MACHINE = process.env.V86_CODEX_BENCHMARK_MACHINE || "";
const LLVMPipe_BENCHMARK_PATH =
    path.join(ROOT, "tests/benchmark/baselines/ghostty-llvmpipe-wgpu-apple-m4.json");
assert.ok(
    ["appliance", "accelerated", "multi-core-accelerated", "triangle", "shader",
        "resources", "mesa", "benchmark", "benchmark-accelerated"].includes(SCENARIO),
    `Invalid V86_CODEX_BROWSER_SCENARIO: ${SCENARIO}`);
const renderers = (process.env.V86_CODEX_BROWSER_RENDERERS ||
    (SCENARIO === "appliance" ? "webgpu-js,wgpu" : "wgpu"))
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
let last_readiness_state = null;
for(const renderer of renderers)
{
    assert.ok(renderer === "webgpu-js" || renderer === "wgpu",
        `Invalid renderer in V86_CODEX_BROWSER_RENDERERS: ${renderer}`);
}

const required = [
    "build/libv86.mjs",
    MULTICORE_ACCELERATED ? "build/v86-multimem.wasm" : "build/v86.wasm",
    MULTICORE_ACCELERATED ?
        "images/virtio-gpu-multi-core-alpine-codex-fs.json" :
        "images/alpine-virtio-gpu-codex-fs.json",
];
if(MULTICORE_ACCELERATED)
{
    required.push("build/gram.wasm", "build/gram-shared.wasm");
}
for(const relative of required)
{
    if(!fs.existsSync(path.join(ROOT, relative)))
    {
        throw new Error(`Missing ${relative}; build the browser and Codex appliance first`);
    }
}
if(renderers.includes("wgpu") &&
   !fs.existsSync(path.join(ROOT, "build/virtio-gpu-wgpu/virtio_gpu_wgpu.js")))
{
    throw new Error("Missing build/virtio-gpu-wgpu/virtio_gpu_wgpu.js; run make virtio-gpu-wgpu first");
}

async function main()
{
    const server = http.createServer(serve_file);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(PORT, "127.0.0.1", resolve);
    });
    const base_url = `http://127.0.0.1:${PORT}`;
    try
    {
        const scenarios = [];
        for(const renderer of renderers)
        {
            scenarios.push(await run_in_chrome(base_url, renderer));
        }
        const result = { result: "pass", port: PORT, scenarios };
        if(OUTPUT_PATH)
        {
            const output_file = path.resolve(ROOT, OUTPUT_PATH);
            assert.ok(output_file.startsWith(ROOT + path.sep),
                "V86_CODEX_BROWSER_OUTPUT must remain inside the repository");
            fs.mkdirSync(path.dirname(output_file), { recursive: true });
            fs.writeFileSync(output_file, JSON.stringify(result, null, 2) + "\n");
        }
        console.log(JSON.stringify(result, null, 2));
    }
    finally
    {
        await new Promise(resolve => server.close(resolve));
    }
}

function serve_file(request, response)
{
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if(pathname === "/favicon.ico")
    {
        response.writeHead(204).end();
        return;
    }
    const filename = path.resolve(ROOT, "." + pathname);
    if(filename !== ROOT && !filename.startsWith(ROOT + path.sep))
    {
        response.writeHead(403).end();
        return;
    }
    fs.stat(filename, (stat_error, stat) => {
        if(stat_error || !stat.isFile())
        {
            response.writeHead(404).end();
            return;
        }
        response.setHeader("Content-Type", content_type(filename));
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        response.setHeader("Cache-Control", "no-store");
        const stream = fs.createReadStream(filename);
        stream.on("error", () => response.destroy());
        stream.pipe(response);
    });
}

async function run_in_chrome(base_url, renderer)
{
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "v86-codex-browser-"));
    const chrome = spawn(find_chrome(), [
        "--headless=new",
        "--enable-unsafe-webgpu",
        "--disable-gpu-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let browser;
    try
    {
        const browser_ws = await read_devtools_url(chrome);
        browser = new Cdp(browser_ws);
        await browser.ready;
        return await run_scenario(browser_ws, base_url, renderer);
    }
    finally
    {
        browser && browser.close();
        chrome.kill("SIGTERM");
        if(chrome.exitCode === null)
        {
            await Promise.race([
                new Promise(resolve => chrome.once("exit", resolve)),
                new Promise(resolve => setTimeout(resolve, 5000)),
            ]);
        }
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

async function run_scenario(browser_ws, base_url, renderer)
{
    const browser_url = new URL(browser_ws);
    const target_response = await fetch(
        `http://${browser_url.host}/json/new?${encodeURIComponent("about:blank")}`,
        { method: "PUT" });
    if(!target_response.ok)
    {
        throw new Error(`Chrome target creation failed: ${target_response.status}`);
    }
    const target = await target_response.json();
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    const failures = [];
    cdp.on("Runtime.exceptionThrown", event => {
        failures.push(event.exceptionDetails?.text || "Uncaught browser exception");
    });
    cdp.on("Log.entryAdded", event => {
        if(event.entry?.level === "error") failures.push(event.entry.text);
    });
    await cdp.call("Runtime.enable");
    await cdp.call("Log.enable");
    await cdp.call("Page.enable");
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
        source: "performance.setResourceTimingBufferSize(10000);",
    });

    try
    {
        const started = performance.now();
        const url = new URL(
            `${base_url}/examples/virtio_gpu_codex.html?renderer=${renderer}&acceptance=${Date.now()}`);
        if(MULTICORE_ACCELERATED) url.searchParams.set("preset", "multi-core-accelerated");
        if(RELAY_URL) url.searchParams.set("relay", RELAY_URL);
        if(SCENARIO === "shader") url.searchParams.set("shader", "1");
        else if(SCENARIO === "resources") url.searchParams.set("resources", "1");
        else if(SCENARIO === "mesa") url.searchParams.set("mesa", "1");
        else if(ACCELERATED) url.searchParams.set("accelerated", "1");
        else if(SCENARIO === "triangle") url.searchParams.set("triangle", "1");
        else if(SCENARIO === "benchmark" || SCENARIO === "benchmark-accelerated")
        {
            url.searchParams.set("benchmark", "1");
            if(SCENARIO === "benchmark-accelerated") url.searchParams.set("accelerated", "1");
            if(BENCHMARK_MACHINE) url.searchParams.set("benchmark_machine", BENCHMARK_MACHINE);
        }
        await cdp.call("Page.navigate", { url: url.href });
        const renderer_stages = [];
        await wait_for(async() => {
            const state = await evaluate(cdp,
                `({ result: document.body?.dataset?.result || null, ` +
                `serial: window.applianceSerialText || "", ` +
                `renderer_stage: window.name || "", ` +
                `gpu: (() => { const device = window.emulator?.v86?.cpu?.devices?.virtio_gpu; ` +
                `return device ? { resources: Array.from(device.resources.values()).map(resource => ({ ` +
                `backing_length: resource.backing_length, backing_entries: resource.backing.length })), ` +
                `contexts: Array.from(device.contexts_3d.entries()).map(([id, context]) => ` +
                `({ id, resources: Array.from(context.resources) })), ` +
                `last_invalid_3d_error: device.backend?.last_invalid_3d_error || null, ` +
                `active_calls: device.backend?.active_calls ?? null, ` +
                `invalid_3d_errors: device.backend?.invalid_3d_errors || [], ` +
                `last_transfer_from_host_3d: device.last_transfer_from_host_3d || null, ` +
                `stats: device.get_performance_stats() } : null; })(), ` +
                `fatal: window.emulator?.v86?.cpu?.devices?.virtio_gpu?.backend?.fatal_error?.message || null })`);
            if(state.renderer_stage &&
                renderer_stages.at(-1) !== state.renderer_stage)
            {
                renderer_stages.push(state.renderer_stage);
            }
            last_readiness_state = state;
            if(state.fatal)
            {
                const error = new Error(state.fatal);
                error.terminal = true;
                throw error;
            }
            if(state.result === "fail")
            {
                const reason = /V86_APPLIANCE_FAILURE=([^\r\n]+)/.exec(state.serial)?.[1] || "unknown";
                const serial_tail = state.serial.slice(-60000);
                const error = new Error(
                    `Appliance readiness contract failed: ${reason}\n${serial_tail}\n` +
                    `Renderer stage: ${state.renderer_stage}\n` +
                    `Renderer stages: ${renderer_stages.join(" -> ")}\n` +
                    `GPU state: ${JSON.stringify(state.gpu)}\n` +
                    `3D rejections:\n` +
                    (state.gpu?.invalid_3d_errors || []).join("\n"));
                error.terminal = true;
                throw error;
            }
            return state.result === "pass";
        }, READY_TIMEOUT_MS, `${renderer} appliance readiness`);
        const ready_ms = performance.now() - started;
        if(SCENARIO === "appliance" || ACCELERATED)
        {
            await new Promise(resolve => setTimeout(resolve, 3000));
            const stable = await evaluate(cdp,
                `({ result: document.body?.dataset?.result || null, ` +
                `serial: window.applianceSerialText || "" })`);
            assert.equal(stable.result, "pass",
                `Appliance session exited after readiness:\n${stable.serial.slice(-12000)}`);
            assert.doesNotMatch(stable.serial, /V86_APPLIANCE_READY=FAIL/,
                "Appliance reported a post-readiness failure");
        }

        let clipboard_paste = null;
        if(SCENARIO === "appliance" || ACCELERATED)
        {
            const clipboard_commands = [
                "printf 'V86_CLIPBOARD_PASTE_LINE1=spaces punctuation !@#^&*()[]{}:;,.?/-_+=\\n' >/dev/ttyS0",
                "printf 'V86_CLIPBOARD_PASTE_LINE2=multiline-ok\\n' >/dev/ttyS0",
            ].join("\n") + "\n";
            const paste_event = await evaluate(cdp,
                `(${dispatch_clipboard_paste_in_page.toString()})(${JSON.stringify(clipboard_commands)})`);
            assert.equal(paste_event.focused, true,
                "clipboard acceptance did not focus the emulator display");
            assert.equal(paste_event.default_prevented, true,
                "display paste did not consume plain text");
            assert.equal(paste_event.outside_default_prevented, false,
                "paste outside the emulator display was consumed");
            assert.equal(paste_event.paste_button_visible, true,
                "clipboard fallback button is not visible");

            await wait_for(async() => {
                const serial = await evaluate(cdp, "window.applianceSerialText || ''");
                return serial.includes("V86_CLIPBOARD_PASTE_LINE1=spaces punctuation") &&
                    serial.includes("V86_CLIPBOARD_PASTE_LINE2=multiline-ok");
            }, 30000, "multiline clipboard paste in Ghostty");
            const clipboard_serial = await evaluate(cdp, "window.applianceSerialText || ''");
            assert.equal(
                clipboard_serial.split("V86_CLIPBOARD_PASTE_LINE1=").length - 1,
                1, "display paste reached the guest more than once");
            assert.equal(
                clipboard_serial.split("V86_CLIPBOARD_PASTE_LINE2=").length - 1,
                1, "multiline display paste reached the guest more than once");

            const button = await evaluate(cdp,
                `(${run_clipboard_button_acceptance_in_page.toString()})()`);
            assert.equal(button.reads_before_click, 0,
                "Paste button read the clipboard before a click");
            assert.equal(button.reads_after_success, 1);
            assert.deepEqual(button.sent_text, [{
                text: "button paste = value\nsecond line",
                delay: 1,
            }]);
            assert.match(button.success_status, /^Pasted 32 characters\.$/);
            assert.equal(button.reads_after_denial, 2);
            assert.match(button.denial_status, /Clipboard permission was denied/);
            assert.match(button.unavailable_status, /Clipboard access is unavailable/);
            assert.equal(button.body_result, "pass",
                "clipboard fallback failure changed appliance readiness");
            clipboard_paste = {
                guest_multiline: true,
                display_event_once: true,
                button_user_gesture: true,
                denial_nonfatal: true,
            };
        }


        const state = await evaluate(cdp, `(() => {
            const serial = window.applianceSerialText || "";
            const device = window.emulator.v86.cpu.devices.virtio_gpu;
            const canvas = device.backend.canvas;
            const cursor_canvas = device.backend.cursor_canvas;
            let cursor_alpha = null;
            if(cursor_canvas && !cursor_canvas.hidden)
            {
                const data = cursor_canvas.getContext("2d")
                    .getImageData(0, 0, cursor_canvas.width, cursor_canvas.height).data;
                let transparent = 0;
                let opaque = 0;
                for(let offset = 3; offset < data.length; offset += 4)
                {
                    transparent += data[offset] === 0;
                    opaque += data[offset] === 255;
                }
                cursor_alpha = { transparent, opaque };
            }
            const rect = canvas.getBoundingClientRect();
            return {
                session_id: window.applianceSessionId,
                serial,
                cross_origin_isolated: crossOriginIsolated,
                smp_mode: window.emulator.smp_mode || null,
                memory_size: window.emulator.v86.cpu.memory_size[0],
                storage_size: window.emulator.fs9p.total_size,
                scanout: device.scanouts[0],
                canvas_visible: !canvas.hidden && getComputedStyle(canvas).display !== "none",
                canvas_width: canvas.width,
                canvas_height: canvas.height,
                image_rendering: getComputedStyle(canvas).imageRendering,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                cursor_alpha,
                cursor_hidden: !cursor_canvas || cursor_canvas.hidden ||
                    getComputedStyle(cursor_canvas).display === "none",
                host_cursor_hidden:
                    getComputedStyle(document.getElementById("screen_container")).cursor === "none",
            };
        })()`);
        if(SCENARIO === "mesa")
        {
            const result = /V86_GPU_MESA_WEBGPUVIRT=PASS renderer=([^\r\n]+) center=(\d+),(\d+),(\d+),(\d+) corner=(\d+),(\d+),(\d+),(\d+)/.exec(
                state.serial);
            assert.ok(result, "Missing Mesa webgpuvirt rendering marker");
            const center = result.slice(2, 6).map(Number);
            const corner = result.slice(6, 10).map(Number);
            assert.ok(center[0] > 180 && center[1] < 100 && center[2] < 100,
                `Mesa triangle center is not red: ${center}`);
            assert.ok(corner[2] > corner[0] && corner[2] > corner[1],
                `Mesa clear color is not blue: ${corner}`);
            const gpu = await evaluate(cdp, `(() => {
                const device = window.emulator.v86.cpu.devices.virtio_gpu;
                return {
                    stats: device.get_performance_stats(),
                    last_invalid_3d_error: device.backend.last_invalid_3d_error,
                    last_transfer_from_host_3d: device.last_transfer_from_host_3d,
                };
            })()`);
            assert.equal(gpu.stats.invalid_commands, 0);
            assert.equal(gpu.stats.backend_errors, 0);
            assert.ok((gpu.stats.command_counts["0x206"] || 0) >= 1,
                "Mesa readback did not use TRANSFER_FROM_HOST_3D");
            assert.ok((gpu.stats.command_counts["0x207"] || 0) >= 1,
                "Mesa did not submit a standard VirGL command stream");
            assert.equal(gpu.last_invalid_3d_error, null);
            assert.ok(gpu.last_transfer_from_host_3d?.resource_id > 0);
            assert.equal(failures.length, 0, failures.join(" | "));
            await evaluate(cdp, "window.emulator.stop()");
            return {
                renderer,
                ready_ms: Math.round(ready_ms),
                mesa_webgpuvirt: true,
                guest_renderer: result[1],
                center_rgba: center,
                corner_rgba: corner,
                submit_3d_commands: gpu.stats.command_counts["0x207"],
                readback_commands: gpu.stats.command_counts["0x206"],
            };
        }
        if(["triangle", "shader", "resources"].includes(SCENARIO))
        {
            for(const marker of [
                "V86_GPU_TRIANGLE_RENDER_NODE=/dev/dri/renderD128",
                "V86_GPU_TRIANGLE_GET_CAPS=PASS",
                "V86_GPU_TRIANGLE_CONTEXT_INIT=PASS",
                "V86_GPU_TRIANGLE_TRANSFER=PASS",
                "V86_GPU_TRIANGLE_SUBMIT=PASS",
                "V86_GPU_TRIANGLE_FENCE=PASS",
                "V86_GPU_TRIANGLE_MODESET=PASS",
                "V86_GPU_TRIANGLE_READY=PASS",
                "V86_APPLIANCE_READY=PASS",
            ])
            {
                assert.ok(state.serial.includes(marker), `Missing guest marker: ${marker}`);
            }
            const expected_version = SCENARIO === "shader" ? 2 :
                SCENARIO === "resources" ? 3 : 1;
            assert.ok(state.serial.includes(
                `V86_GPU_TRIANGLE_GET_CAPS=PASS version=${expected_version}`),
                "Guest did not use the requested capset version");
            if(SCENARIO === "shader")
            {
                assert.ok(state.serial.includes("V86_GPU_SHADER_V2=PASS"),
                    "Missing version-2 guest shader marker");
            }
            else if(SCENARIO === "resources")
            {
                for(const marker of [
                    "V86_GPU_LLVMPIPE_REFERENCE=PASS renderer=llvmpipe",
                    "V86_GPU_TRIANGLE_RESOURCES=PASS textures=2 vertex_buffers=2 index_buffers=1 uniforms=1",
                    "V86_GPU_SHADER_V3=PASS resources=6 bindings=3 indexed_draws=1",
                ])
                {
                    assert.ok(state.serial.includes(marker), `Missing resource marker: ${marker}`);
                }
            }
            const rendered = await evaluate(cdp, `(() => {
                const device = window.emulator.v86.cpu.devices.virtio_gpu;
                const canvas = device.backend.canvas;
                const rect = canvas.getBoundingClientRect();
                return {
                    stats: device.get_performance_stats(),
                    scanout: device.scanouts[0],
                    canvas_visible: !canvas.hidden && getComputedStyle(canvas).display !== "none",
                    canvas_width: canvas.width,
                    canvas_height: canvas.height,
                    rect: {
                        x: rect.left + window.scrollX,
                        y: rect.top + window.scrollY,
                        width: rect.width,
                        height: rect.height,
                    },
                };
            })()`);
            const pixels = await sample_canvas_screenshot(cdp, rendered);
            if(SCENARIO === "shader")
            {
                assert.ok(pixels.center[1] > 180 && pixels.center[0] < 100 &&
                    pixels.center[2] < 100, `Guest shader triangle center is not green: ${pixels.center}`);
            }
            else
            {
                assert.ok(pixels.center[0] > 180 && pixels.center[1] < 100 &&
                    pixels.center[2] < 100, `Triangle center is not red: ${pixels.center}`);
            }
            assert.ok(pixels.corner[2] > pixels.corner[0] &&
                pixels.corner[2] > pixels.corner[1],
                `Triangle clear color is not blue: ${pixels.corner}`);
            assert.equal(rendered.canvas_visible, true);
            assert.equal(rendered.canvas_width, rendered.scanout.width);
            assert.equal(rendered.canvas_height, rendered.scanout.height);
            for(const command of ["0x202", "0x204", "0x205", "0x207"])
            {
                assert.ok((rendered.stats.command_counts[command] || 0) >= 1,
                    `Missing standard virtio-gpu command ${command}`);
            }
            if(SCENARIO === "resources")
            {
                assert.equal(rendered.stats.live_3d_resources, 6);
                assert.equal(rendered.stats.live_3d_contexts, 1);
                assert.ok(rendered.stats.upload_bytes >= 96,
                    `Guest resources were not uploaded: ${rendered.stats.upload_bytes}`);
                assert.equal(rendered.stats.invalid_commands, 0);
                assert.equal(rendered.stats.backend_errors, 0);
            }
            assert.equal(failures.length, 0, failures.join(" | "));
            if(SCENARIO === "shader")
            {
                const arbitrary = await evaluate(cdp,
                    `(${run_shader_acceptance_in_page.toString()})()`);
                const arbitrary_pixels = await sample_canvas_screenshot(cdp, arbitrary);
                assert.ok(arbitrary_pixels.center[1] > 180 &&
                    arbitrary_pixels.center[0] < 100 && arbitrary_pixels.center[2] < 100,
                    `Arbitrary shader triangle center is not green: ${arbitrary_pixels.center}`);
                assert.ok(arbitrary_pixels.corner[2] > arbitrary_pixels.corner[0] &&
                    arbitrary_pixels.corner[2] > arbitrary_pixels.corner[1],
                    `Arbitrary shader clear color is not blue: ${arbitrary_pixels.corner}`);
                assert.deepEqual(arbitrary.object_stats, [
                    arbitrary.baseline_stats[0] + 1,
                    arbitrary.baseline_stats[1] + 2,
                    arbitrary.baseline_stats[2] + 1,
                    arbitrary.baseline_stats[3] +
                        arbitrary.vertex_bytes + arbitrary.fragment_bytes,
                ]);
                assert.deepEqual(arbitrary.after_invalid_stats, [
                    arbitrary.object_stats[0] + 1,
                    arbitrary.object_stats[1],
                    arbitrary.object_stats[2],
                    arbitrary.object_stats[3],
                ]);
                assert.deepEqual(arbitrary.after_cleanup_stats, arbitrary.baseline_stats);
                assert.equal(arbitrary.invalid_cases, 12);
                assert.equal(failures.length, 0, failures.join(" | "));

                const work_timeout = await evaluate(cdp,
                    `(${run_shader_work_timeout_in_page.toString()})()`);
                assert.match(work_timeout.error,
                    /WebGPU render work timed out after 5000 ms/);
                assert.ok(work_timeout.elapsed_ms >= 4900 && work_timeout.elapsed_ms < 8000,
                    `Render work timeout was not bounded: ${work_timeout.elapsed_ms} ms`);
                assert.equal(work_timeout.object_response_type, 0x1100);
                assert.equal(work_timeout.object_response_flags, 1);
                assert.equal(work_timeout.object_response_fence, 1);
                assert.ok(work_timeout.object_elapsed_ms < 2000,
                    `Fenced object submit performed an outer GPU wait: ${work_timeout.object_elapsed_ms} ms`);
                assert.equal(work_timeout.render_response_type, 0x1200);
                assert.equal(work_timeout.canvas_hidden, true);
                assert.equal(work_timeout.renderer_disposed, true);
                assert.deepEqual(work_timeout.recovery, {
                    fatal: null,
                    initialized: true,
                    contexts: 0,
                    resources: 0,
                    attachments: 0,
                });

                const timeouts = [];
                for(let attempt = 0; attempt < 2; attempt++)
                {
                    const timeout = await evaluate(cdp,
                        `(${run_shader_timeout_in_page.toString()})()`);
                    assert.match(timeout.error,
                        /WebGPU pipeline compilation timed out after 5000 ms/);
                    assert.ok(timeout.elapsed_ms >= 4900 && timeout.elapsed_ms < 8000,
                        `Compilation timeout was not bounded: ${timeout.elapsed_ms} ms`);
                    assert.equal(timeout.canvas_hidden, true);
                    assert.equal(timeout.renderer_disposed, true);
                    assert.deepEqual(timeout.recovery, {
                        fatal: null,
                        initialized: true,
                        contexts: 0,
                        resources: 0,
                        attachments: 0,
                    });
                    timeouts.push(timeout);
                }
                await evaluate(cdp, "window.emulator.stop()");
                return {
                    renderer,
                    ready_ms: Math.round(ready_ms),
                    shader: true,
                    guest_shader_v2: state.serial.includes("V86_GPU_SHADER_V2=PASS"),
                    guest_center_rgba: pixels.center,
                    guest_corner_rgba: pixels.corner,
                    arbitrary_center_rgba: arbitrary_pixels.center,
                    arbitrary_corner_rgba: arbitrary_pixels.corner,
                    invalid_cases: arbitrary.invalid_cases,
                    compilation_timeout_ms:
                        timeouts.map(timeout => Math.round(timeout.elapsed_ms)),
                    render_work_timeout_ms: Math.round(work_timeout.elapsed_ms),
                    timeout_fallback: work_timeout.canvas_hidden &&
                        timeouts.every(timeout => timeout.canvas_hidden),
                    timeout_recovery: work_timeout.recovery.initialized &&
                        timeouts.every(timeout => timeout.recovery.initialized),
                    leaked_3d_objects: work_timeout.recovery.contexts +
                        work_timeout.recovery.resources + work_timeout.recovery.attachments +
                        timeouts.reduce((count, timeout) => count +
                            timeout.recovery.contexts + timeout.recovery.resources +
                            timeout.recovery.attachments, 0),
                };
            }
            const loss = await evaluate(cdp, `(() => {
                const device = window.emulator.v86.cpu.devices.virtio_gpu;
                device.backend.handle_fatal(
                    new Error("triangle acceptance injected device loss"), "acceptance");
                return device.backend.fatal_error?.message || null;
            })()`);
            assert.match(loss, /triangle acceptance injected device loss/);
            await wait_for(async() => evaluate(cdp,
                "window.emulator.v86.cpu.devices.virtio_gpu.backend.canvas.hidden"),
                5000, "triangle device-loss VGA fallback");
            const recovery = await evaluate(cdp, `(async() => {
                const device = window.emulator.v86.cpu.devices.virtio_gpu;
                device.reset();
                await device.backend_ready;
                const stats = device.get_performance_stats();
                return {
                    fatal: device.backend.fatal_error?.message || null,
                    initialized: device.backend.initialized,
                    capset: Boolean(device.capset_data),
                    contexts: stats.live_3d_contexts,
                    resources: stats.live_3d_resources,
                    attachments: stats.context_attachments,
                };
            })()`);
            assert.deepEqual(recovery, {
                fatal: null,
                initialized: true,
                capset: true,
                contexts: 0,
                resources: 0,
                attachments: 0,
            });
            assert.equal(failures.length, 0, failures.join(" | "));
            await evaluate(cdp, "window.emulator.stop()");
            return {
                renderer,
                ready_ms: Math.round(ready_ms),
                triangle: true,
                guest_shader_v2: SCENARIO === "shader",
                center_rgba: pixels.center,
                corner_rgba: pixels.corner,
                submit_3d_commands: rendered.stats.command_counts["0x207"],
                ordered_fence: state.serial.includes("V86_GPU_TRIANGLE_FENCE=PASS"),
                loss_fallback: true,
                loss_recovery: recovery.initialized,
                leaked_3d_objects: recovery.contexts + recovery.resources + recovery.attachments,
            };
        }
        if(SCENARIO === "benchmark" || SCENARIO === "benchmark-accelerated")
        {
            await wait_for(async() => {
                const benchmark = await evaluate(cdp,
                    "window.virtioGpuBenchmark?.result || null");
                if(benchmark?.status === "fail")
                {
                    const error = new Error(benchmark.error || "Ghostty benchmark failed");
                    error.terminal = true;
                    throw error;
                }
                return benchmark?.status === "pass";
            }, READY_TIMEOUT_MS, `${renderer} Ghostty benchmark`);
            const benchmark = await evaluate(cdp,
                "window.virtioGpuBenchmark.result");
            assert.equal(benchmark.schema_version, 1);
            assert.equal(benchmark.scenario.renderer, renderer);
            const accelerated = SCENARIO === "benchmark-accelerated";
            assert.equal(benchmark.scenario.guest_renderer,
                accelerated ? "webgpuvirt" : "llvmpipe");
            assert.equal(benchmark.scenario.accelerated_3d, accelerated);
            assert.equal(benchmark.method.warmup_runs, 2);
            assert.equal(benchmark.method.measured_runs, 5);
            assert.equal(benchmark.raw_runs.length, 5);
            assert.match(benchmark.terminal_reference_sha256, /^[0-9a-f]{64}$/);
            for(const run of benchmark.raw_runs)
            {
                assert.ok(run.guest_cpu_ms > 0);
                assert.ok(run.keystroke_to_present_ms >= 0);
                assert.ok(run.output_bytes > 0);
                assert.ok(run.output_lines > 0);
                assert.equal(run.terminal_reference.sha256,
                    benchmark.terminal_reference_sha256);
                assert.equal(run.gpu.invalid_commands, 0);
                assert.equal(run.gpu.backend_errors, 0);
                assert.ok(run.gpu.presentations > 0);
                assert.ok(run.gpu.presented_bytes > 0);
                assert.deepEqual(run.gpu.invalid_responses, []);
                assert.ok(run.gpu.fence_responses.every(response =>
                    response.response === 0x1100));
            }
            if(accelerated)
            {
                benchmark.performance_comparison =
                    compare_accelerated_benchmark(benchmark);
            }
            assert.equal(failures.length, 0, failures.join(" | "));
            await evaluate(cdp, "window.emulator.stop()");
            return benchmark;
        }
        for(const marker of [
            "V86_APPLIANCE_ARCH=i686",
            "V86_APPLIANCE_UID=1000",
            "V86_APPLIANCE_HOSTNAME=v86-appliance",
            "V86_APPLIANCE_LOOPBACK=PASS",
            "V86_APPLIANCE_PYTHON3=Python 3.14.7",
            "V86_APPLIANCE_JQ=jq-1.8.1",
            `V86_APPLIANCE_NETWORK=${RELAY_URL ? "PASS" : "UNCONFIGURED"}`,
            "V86_APPLIANCE_XORG=PASS",
            "V86_APPLIANCE_OPENBOX=PASS",
            "V86_APPLIANCE_GHOSTTY_PROCESS=PASS",
            "V86_APPLIANCE_GHOSTTY_WINDOW=PASS",
            "V86_APPLIANCE_GHOSTTY_SHELL=PASS",
            "V86_APPLIANCE_CODEX_BINARY=PASS",
            "V86_APPLIANCE_CODEX_AUTOSTART=DISABLED",
            "V86_APPLIANCE_CODEX_FULL_ACCESS=PASS",
            "V86_APPLIANCE_CODEX_HOME_WRITABLE=PASS",
            "V86_APPLIANCE_CODEX_APPS=DISABLED",
            "V86_APPLIANCE_NO_CODE_MODE_HOST=PASS",
            "V86_APPLIANCE_READY=PASS",
        ])
        {
            assert.ok(state.serial.includes(marker), `Missing guest marker: ${marker}`);
        }
        let parallel_speedup = null;
        if(MULTICORE_ACCELERATED)
        {
            for(const marker of [
                "V86_APPLIANCE_IMAGE=virtio-gpu-multi-core-alpine-codex",
                "V86_APPLIANCE_CPUS=4",
                "V86_APPLIANCE_CPUS_EXPECTED=4",
            ])
            {
                assert.ok(state.serial.includes(marker), `Missing guest marker: ${marker}`);
            }
            parallel_speedup = Number(
                /V86_APPLIANCE_PARALLEL_SPEEDUP=([0-9.]+)/.exec(state.serial)?.[1]);
            assert.ok(parallel_speedup >= 1.2,
                `Parallel speedup ${parallel_speedup} is below the worker execution gate`);
            assert.equal(state.cross_origin_isolated, true);
            assert.equal(state.smp_mode?.execution, "workers");
            assert.equal(state.smp_mode?.topology, "percpu");
            assert.equal(state.smp_mode?.memory_model, "relaxed");
        }
        const accelerated = ACCELERATED;
        let accelerated_screenshot = null;
        let accelerated_submit_3d_commands = null;
        assert.match(state.serial, accelerated ?
            /V86_APPLIANCE_RENDERER=.*webgpuvirt/i :
            /V86_APPLIANCE_RENDERER=.*llvmpipe/i);
        assert.match(state.serial, /V86_APPLIANCE_OPENGL=4\.[1-9]/);
        assert.match(state.serial, /V86_APPLIANCE_GHOSTTY=Ghostty 1\.3\.1/);
        assert.ok(state.serial.includes("V86_APPLIANCE_CODEX=codex-cli 0.147.0"));
        assert.equal(state.memory_size, 2 * 1024 * 1024 * 1024 - 128 * 1024);
        assert.equal(state.storage_size, 2 * 1024 * 1024 * 1024);
        assert.equal(state.canvas_visible, true);
        assert.equal(state.canvas_width, state.scanout.width);
        assert.equal(state.canvas_height, state.scanout.height);
        assert.equal(state.scanout.width, 1920);
        assert.equal(state.scanout.height, 1080);
        assert.equal(state.cursor_hidden, true);
        assert.equal(state.host_cursor_hidden, true);
        assert.equal(state.image_rendering, "auto");
        if(accelerated)
        {
            const gpu = await evaluate(cdp, `(() => {
                const device = window.emulator.v86.cpu.devices.virtio_gpu;
                return {
                    stats: device.get_performance_stats(),
                    last_invalid_3d_error: device.backend.last_invalid_3d_error,
                    invalid_3d_errors: device.backend.invalid_3d_errors,
                };
            })()`);
            assert.equal(gpu.stats.invalid_commands, 0, JSON.stringify(gpu));
            assert.equal(gpu.stats.backend_errors, 0);
            assert.ok((gpu.stats.command_counts["0x207"] || 0) >= 1,
                "Accelerated Ghostty did not submit a standard VirGL command stream");
            accelerated_submit_3d_commands = gpu.stats.command_counts["0x207"];
            assert.equal(gpu.last_invalid_3d_error, null);
            accelerated_screenshot = await sample_canvas_screenshot(cdp, state);
            assert.ok(accelerated_screenshot.nonblack,
                "Accelerated Ghostty scanout is black");
            assert.equal(accelerated_screenshot.background.uniform, true,
                `Accelerated Ghostty background is not uniform: ${
                    JSON.stringify(accelerated_screenshot.background)}`);
            assert.ok(state.cursor_alpha?.transparent > 0,
                `Accelerated cursor has no transparent pixels: ${JSON.stringify(state.cursor_alpha)}`);
            assert.ok(state.cursor_alpha?.opaque > 0,
                `Accelerated cursor has no opaque pixels: ${JSON.stringify(state.cursor_alpha)}`);
        }

        if(RELAY_URL)
        {
            await guest_command(cdp,
                "if wget -qO /tmp/v86-relay-check https://api.github.com/zen; then printf 'V86_APPLIANCE_TLS=%s\\n' PASS; else printf 'V86_APPLIANCE_TLS=%s\\n' FAIL; fi",
                "V86_APPLIANCE_TLS=PASS", "V86_APPLIANCE_TLS=FAIL", 60000);
        }
        await guest_command(cdp,
            "if python3 -c 'import socket; s = socket.socket(); s.bind((\"127.0.0.1\", 0)); s.close()'; then printf 'V86_APPLIANCE_LOOPBACK_BIND=%s\\n' PASS; else printf 'V86_APPLIANCE_LOOPBACK_BIND=%s\\n' FAIL; fi",
            "V86_APPLIANCE_LOOPBACK_BIND=PASS",
            "V86_APPLIANCE_LOOPBACK_BIND=FAIL", 30000);
        await guest_command(cdp,
            "if printf '%s\\n' '{\"ready\":true}' | jq -e '.ready == true' >/dev/null; then printf 'V86_APPLIANCE_GUEST_TOOLS=%s\\n' PASS; else printf 'V86_APPLIANCE_GUEST_TOOLS=%s\\n' FAIL; fi",
            "V86_APPLIANCE_GUEST_TOOLS=PASS",
            "V86_APPLIANCE_GUEST_TOOLS=FAIL", 30000);
        await guest_command(cdp,
            "found=; for package in xfce4 xfce4-panel xfce4-session xfdesktop thunar xfce4-terminal tumbler garcon exo; do if apk info -e \"$package\" >/dev/null 2>&1; then found=1; fi; done; if [ -z \"$found\" ]; then printf 'V86_APPLIANCE_EXCLUSIONS=%s\\n' PASS; else printf 'V86_APPLIANCE_EXCLUSIONS=%s\\n' FAIL; fi",
            "V86_APPLIANCE_EXCLUSIONS=PASS", "V86_APPLIANCE_EXCLUSIONS=FAIL", 30000);
        await guest_command(cdp,
            "if codex login status >/tmp/v86-codex-login.log 2>&1; then printf 'V86_APPLIANCE_LOGIN=%s\\n' FAIL; elif grep -q 'Not logged in' /tmp/v86-codex-login.log && [ ! -e /home/codex/.codex/auth.json ]; then printf 'V86_APPLIANCE_LOGIN=%s\\n' UNCONFIGURED; else printf 'V86_APPLIANCE_LOGIN=%s\\n' FAIL; fi",
            "V86_APPLIANCE_LOGIN=UNCONFIGURED", "V86_APPLIANCE_LOGIN=FAIL", 30000);
        await guest_command(cdp,
            "if codex mcp list >/tmp/v86-codex-mcp-list.log 2>&1 && ! grep -q '^context7 ' /tmp/v86-codex-mcp-list.log; then printf 'V86_APPLIANCE_CONTEXT7_AUTOCONFIG=%s\\n' DISABLED; else cat /tmp/v86-codex-mcp-list.log; printf 'V86_APPLIANCE_CONTEXT7_AUTOCONFIG=%s\\n' FAIL; fi",
            "V86_APPLIANCE_CONTEXT7_AUTOCONFIG=DISABLED",
            "V86_APPLIANCE_CONTEXT7_AUTOCONFIG=FAIL", 30000);
        await guest_command(cdp,
            "log=/tmp/v86-codex-mcp-write.log; if codex mcp add v86-write-probe -- /bin/true >\"$log\" 2>&1 && codex mcp list | grep -q '^v86-write-probe ' && codex mcp remove v86-write-probe >>\"$log\" 2>&1; then printf 'V86_APPLIANCE_CODEX_CONFIG_WRITE=%s\\n' PASS; else cat \"$log\"; codex mcp remove v86-write-probe >/dev/null 2>&1 || true; printf 'V86_APPLIANCE_CODEX_CONFIG_WRITE=%s\\n' FAIL; fi",
            "V86_APPLIANCE_CODEX_CONFIG_WRITE=PASS",
            "V86_APPLIANCE_CODEX_CONFIG_WRITE=FAIL", 30000);

        const duplicate_file_requests = await evaluate(cdp, `(() => {
            const counts = new Map();
            for(const entry of performance.getEntriesByType("resource"))
            {
                const pathname = new URL(entry.name).pathname;
                if(!/\\/[^/]+\\.bin\\.zst$/.test(pathname))
                {
                    continue;
                }
                counts.set(pathname, (counts.get(pathname) || 0) + 1);
            }
            return Array.from(counts).filter(([, count]) => count > 1);
        })()`);
        assert.deepEqual(duplicate_file_requests, [],
            `Root filesystem chunks were fetched repeatedly: ${
                JSON.stringify(duplicate_file_requests)}`);

        await evaluate(cdp, `(() => {
            window.applianceKeyboardEvents = 0;
            window.emulator.emulator_bus.register(
                "keyboard-code", () => window.applianceKeyboardEvents++);
            document.getElementById("screen_container").focus();
        })()`);
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "ArrowDown",
            code: "ArrowDown",
            windowsVirtualKeyCode: 40,
        });
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "ArrowDown",
            code: "ArrowDown",
            windowsVirtualKeyCode: 40,
        });
        await wait_for(async() => (await evaluate(cdp, "window.applianceKeyboardEvents")) > 0,
            5000, "guest keyboard input");
        const hidpi_pointer = await evaluate(cdp, `(() => {
            window.applianceHiDpiMouseDeltas = [];
            window.emulator.emulator_bus.register(
                "mouse-delta", data => window.applianceHiDpiMouseDeltas.push(data));
            const canvas = document.querySelector(".v86-virtio-gpu-canvas");
            const rect = canvas.getBoundingClientRect();
            const dispatch = (client_x, client_y, movement_x, movement_y) => {
                const event = new MouseEvent("mousemove", {
                    bubbles: true,
                    clientX: client_x,
                    clientY: client_y,
                });
                Object.defineProperties(event, {
                    movementX: { value: movement_x },
                    movementY: { value: movement_y },
                });
                canvas.dispatchEvent(event);
            };
            dispatch(rect.left + 100, rect.top + 100, 0, 0);
            dispatch(rect.left + 112, rect.top + 107, 24, 14);
            return {
                emitted: window.applianceHiDpiMouseDeltas.at(-1),
                expected: [
                    12 * canvas.width / rect.width,
                    -7 * canvas.height / rect.height,
                ],
            };
        })()`);
        assert.ok(Math.abs(hidpi_pointer.emitted[0] - hidpi_pointer.expected[0]) < 0.01,
            `HiDPI pointer x drifted: ${JSON.stringify(hidpi_pointer)}`);
        assert.ok(Math.abs(hidpi_pointer.emitted[1] - hidpi_pointer.expected[1]) < 0.01,
            `HiDPI pointer y drifted: ${JSON.stringify(hidpi_pointer)}`);

        const pointer_points = await evaluate(cdp, `(() => {
            window.applianceMouseDeltas = [];
            window.emulator.emulator_bus.register(
                "mouse-delta", data => window.applianceMouseDeltas.push(data));
            const canvas = document.querySelector(".v86-virtio-gpu-canvas");
            const rect = canvas.getBoundingClientRect();
            return {
                first: { x: rect.left + 240, y: rect.top + 220 },
                canvas: {
                    width: canvas.width,
                    height: canvas.height,
                    css_width: rect.width,
                    css_height: rect.height,
                },
            };
        })()`);
        await cdp.call("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: pointer_points.first.x,
            y: pointer_points.first.y,
            button: "none",
            pointerType: "mouse",
        });
        await new Promise(resolve => setTimeout(resolve, 500));
        const first_guest_pointer = await evaluate(cdp, `(() => {
            const cursor = document.querySelector(".v86-virtio-gpu-cursor");
            return { x: parseFloat(cursor.style.left), y: parseFloat(cursor.style.top) };
        })()`);
        pointer_points.second = {
            x: pointer_points.first.x +
                (first_guest_pointer.x < pointer_points.canvas.css_width / 2 ? 120 : -120),
            y: pointer_points.first.y +
                (first_guest_pointer.y < pointer_points.canvas.css_height / 2 ? 80 : -80),
        };
        const pointer_steps = 8;
        for(let step = 1; step <= pointer_steps; step++)
        {
            await cdp.call("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: pointer_points.first.x +
                    (pointer_points.second.x - pointer_points.first.x) * step / pointer_steps,
                y: pointer_points.first.y +
                    (pointer_points.second.y - pointer_points.first.y) * step / pointer_steps,
                button: "none",
                pointerType: "mouse",
            });
        }
        await new Promise(resolve => setTimeout(resolve, 700));
        const second_guest_pointer = await evaluate(cdp, `(() => {
            const cursor = document.querySelector(".v86-virtio-gpu-cursor");
            return { x: parseFloat(cursor.style.left), y: parseFloat(cursor.style.top) };
        })()`);
        const pointer_deltas = await evaluate(cdp, "window.applianceMouseDeltas");
        const pointer_tracking = {
            host_dx: pointer_points.second.x - pointer_points.first.x,
            host_dy: pointer_points.second.y - pointer_points.first.y,
            guest_dx: second_guest_pointer.x - first_guest_pointer.x,
            guest_dy: second_guest_pointer.y - first_guest_pointer.y,
            canvas: pointer_points.canvas,
            emitted_deltas: pointer_deltas,
            first_guest_pointer,
            second_guest_pointer,
        };
        pointer_tracking.speed_ratio =
            Math.hypot(pointer_tracking.guest_dx, pointer_tracking.guest_dy) /
            Math.hypot(pointer_tracking.host_dx, pointer_tracking.host_dy);
        assert.ok(pointer_tracking.speed_ratio >= 0.9 &&
            pointer_tracking.speed_ratio <= 1.1,
            `Guest pointer speed drifted: ${JSON.stringify(pointer_tracking)}`);
        assert.equal(Math.sign(pointer_tracking.guest_dx),
            Math.sign(pointer_tracking.host_dx), "Guest pointer x direction changed");
        assert.equal(Math.sign(pointer_tracking.guest_dy),
            Math.sign(pointer_tracking.host_dy), "Guest pointer y direction changed");

        await cdp.call("Emulation.setDeviceMetricsOverride", {
            width: 640,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
        });
        const narrow_layout = await evaluate(cdp, `(() => {
            const screen = document.getElementById("screen_container").getBoundingClientRect();
            return { width: screen.width, viewport: innerWidth };
        })()`);
        assert.ok(narrow_layout.width <= narrow_layout.viewport);
        await cdp.call("Emulation.clearDeviceMetricsOverride");

        let fresh_reset = null;
        if(renderer === "webgpu-js")
        {
            await guest_command(cdp,
                "touch /home/codex/workspace/.v86-reset-probe; printf 'V86_RESET_PROBE=%s\\n' CREATED",
                "V86_RESET_PROBE=CREATED", null, 30000);
            await evaluate(cdp, "document.getElementById('reset-session').click()");
            await wait_for(async() => {
                const reset_state = await evaluate(cdp,
                    `({ id: window.applianceSessionId || null, ` +
                    `result: document.body?.dataset?.result || null, ` +
                    `serial: window.applianceSerialText || "", ` +
                    `fatal: window.emulator?.v86?.cpu?.devices?.virtio_gpu?.backend?.fatal_error?.message || null })`);
                if(reset_state.fatal || reset_state.result === "fail")
                {
                    const reason = reset_state.fatal ||
                        /V86_APPLIANCE_FAILURE=([^\r\n]+)/.exec(reset_state.serial)?.[1] ||
                        "unknown";
                    const error = new Error(
                        `Fresh appliance reset failed: ${reason}\n${reset_state.serial.slice(-6000)}`);
                    error.terminal = true;
                    throw error;
                }
                return reset_state.id && reset_state.id !== state.session_id &&
                    reset_state.result === "pass";
            }, READY_TIMEOUT_MS, "fresh appliance reset");
            await guest_command(cdp,
                "if [ ! -e /home/codex/workspace/.v86-reset-probe ]; then printf 'V86_RESET_PROBE=%s\\n' CLEAN; else printf 'V86_RESET_PROBE=%s\\n' DIRTY; fi",
                "V86_RESET_PROBE=CLEAN", "V86_RESET_PROBE=DIRTY", 30000);
            fresh_reset = true;
        }

        if(failures.length)
        {
            throw new Error(`${renderer} browser errors: ${failures.join(" | ")}`);
        }
        return {
            renderer,
            ready_ms: Math.round(ready_ms),
            architecture: "i686",
            uid: 1000,
            llvmpipe: !accelerated,
            accelerated_3d: accelerated,
            preset: MULTICORE_ACCELERATED ? "multi-core-accelerated" : null,
            vcpus: MULTICORE_ACCELERATED ? 4 : 1,
            worker_execution: MULTICORE_ACCELERATED,
            parallel_speedup,
            submit_3d_commands: accelerated_submit_3d_commands,
            tls_relay: Boolean(RELAY_URL),
            codex_apps_disabled: true,
            codex_autostart: false,
            codex_full_access: true,
            codex_home_writable: true,
            python3: true,
            jq: true,
            loopback_bind: true,
            guest_tools: true,
            context7_autoconfig: false,
            desktop_exclusions: true,
            login_unconfigured: true,
            keyboard_input: true,
            clipboard_paste,
            responsive_layout: true,
            accelerated_scanout_pixel: accelerated_screenshot?.nonblack || null,
            accelerated_background_probe: accelerated_screenshot?.background || null,
            cursor_alpha: state.cursor_alpha,
            pointer_tracking,
            fresh_reset,
        };
    }
    finally
    {
        cdp.close();
        await fetch(`http://${browser_url.host}/json/close/${target.id}`).catch(() => {});
    }
}

function compare_accelerated_benchmark(accelerated)
{
    const baseline = JSON.parse(
        fs.readFileSync(LLVMPipe_BENCHMARK_PATH, "utf8")).scenarios[0];
    assert.equal(baseline.schema_version, accelerated.schema_version);
    assert.equal(baseline.scenario.renderer, accelerated.scenario.renderer);
    for(const key of [
        "label", "user_agent", "platform", "hardware_concurrency",
        "device_memory_gib",
    ])
    {
        assert.deepEqual(accelerated.machine[key], baseline.machine[key],
            `Benchmark machine mismatch: ${key}`);
    }
    assert.deepEqual(accelerated.machine.webgpu_adapter,
        baseline.machine.webgpu_adapter, "Benchmark WebGPU adapter mismatch");
    for(const key of [
        "workload", "synchronization", "warmup_runs", "measured_runs",
        "presentation_quiet_ms",
    ])
    {
        assert.deepEqual(accelerated.method[key], baseline.method[key],
            `Benchmark method mismatch: ${key}`);
    }
    assert.equal(accelerated.terminal_reference_sha256,
        baseline.terminal_reference_sha256);

    const baseline_cpu = baseline.summary.guest_cpu_ms.p50;
    const accelerated_cpu = accelerated.summary.guest_cpu_ms.p50;
    const baseline_latency = baseline.summary.keystroke_to_present_ms.p95;
    const accelerated_latency = accelerated.summary.keystroke_to_present_ms.p95;
    const cpu_ratio = accelerated_cpu / baseline_cpu;
    const latency_ratio = accelerated_latency / baseline_latency;
    assert.ok(cpu_ratio <= 0.8 || latency_ratio <= 0.8,
        `Acceleration did not improve a primary metric by 20%: ` +
        `cpu=${cpu_ratio} latency=${latency_ratio}`);
    assert.ok(cpu_ratio <= 1.05 && latency_ratio <= 1.05,
        `Acceleration regressed a primary metric by more than 5%: ` +
        `cpu=${cpu_ratio} latency=${latency_ratio}`);

    const baseline_long_tasks = baseline.raw_runs.reduce(
        (total, run) => total + run.browser_health.long_tasks.count, 0);
    const accelerated_long_tasks = accelerated.raw_runs.reduce(
        (total, run) => total + run.browser_health.long_tasks.count, 0);
    assert.ok(accelerated_long_tasks <= baseline_long_tasks,
        "Acceleration increased browser long tasks");
    const change = (value, control) =>
        Number(((value - control) * 100 / control).toFixed(1));
    return {
        baseline: path.relative(ROOT, LLVMPipe_BENCHMARK_PATH),
        gate: "pass",
        guest_cpu_p50_ms: {
            llvmpipe: baseline_cpu,
            webgpuvirt: accelerated_cpu,
            change_percent: change(accelerated_cpu, baseline_cpu),
        },
        keystroke_to_present_p95_ms: {
            llvmpipe: baseline_latency,
            webgpuvirt: accelerated_latency,
            change_percent: change(accelerated_latency, baseline_latency),
        },
        terminal_reference_identical: true,
        browser_long_tasks: accelerated_long_tasks,
    };
}

async function guest_command(cdp, command, success_marker, failure_marker, timeout)
{
    await evaluate(cdp, `window.emulator.serial0_send(${JSON.stringify(command + "\n")})`);
    await wait_for(async() => {
        const serial = await evaluate(cdp, "window.applianceSerialText || ''");
        if(failure_marker && serial.includes(failure_marker))
        {
            const error = new Error(`Guest command failed: ${success_marker}`);
            error.terminal = true;
            throw error;
        }
        return serial.includes(success_marker);

    }, timeout, success_marker);
}
async function sample_canvas_screenshot(cdp, rendered)
{
    const screenshot = await cdp.call("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
            ...rendered.rect,
            scale: 1,
        },
    });
    return evaluate(cdp, `(async() => {
        const image = new Image();
        image.src = "data:image/png;base64,${screenshot.data}";
        await image.decode();
        const copy = document.createElement("canvas");
        copy.width = image.naturalWidth;
        copy.height = image.naturalHeight;
        const context = copy.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
        let nonblack = null;
        for(let offset = 0; offset < pixels.length; offset += 4)
        {
            if(pixels[offset] + pixels[offset + 1] + pixels[offset + 2] > 24)
            {
                nonblack = Array.from(pixels.slice(offset, offset + 4));
                break;
            }
        }
        const pixel_at = (x, y) => Array.from(
            pixels.slice((y * copy.width + x) * 4, (y * copy.width + x) * 4 + 4));
        const center = pixel_at(Math.floor(copy.width / 2), Math.floor(copy.height / 2));
        const corner_x = Math.min(copy.width - 1,
            Math.max(0, Math.floor(8 * copy.width / ${rendered.canvas_width})));
        const corner_y = Math.min(copy.height - 1,
            Math.max(0, Math.floor(8 * copy.height / ${rendered.canvas_height})));
        const corner = pixel_at(corner_x, corner_y);
        const region_counts = [new Map(), new Map()];
        for(let y = 16; y < copy.height - 16; y += 16)
        {
            for(let x = 16; x < copy.width - 16; x += 16)
            {
                const diagonal = x / copy.width + y / copy.height;
                const region = diagonal < 0.85 ? 0 : diagonal > 1.15 ? 1 : -1;
                if(region < 0)
                {
                    continue;
                }
                const color = pixel_at(x, y).slice(0, 3).join(",");
                region_counts[region].set(color, (region_counts[region].get(color) || 0) + 1);
            }
        }
        const dominant_color = counts =>
        {
            let color = null;
            let count = -1;
            for(const [candidate, candidate_count] of counts)
            {
                if(candidate_count > count)
                {
                    color = candidate;
                    count = candidate_count;
                }
            }
            return {
                color: color === null ? null : color.split(",").map(Number),
                count,
            };
        };
        const upper_left = dominant_color(region_counts[0]);
        const lower_right = dominant_color(region_counts[1]);
        const max_delta = upper_left.color && lower_right.color ?
            Math.max(...upper_left.color.map((channel, index) =>
                Math.abs(channel - lower_right.color[index]))) : Infinity;
        return {
            center,
            corner,
            nonblack,
            background: {
                upper_left,
                lower_right,
                max_delta,
                uniform: max_delta <= 2,
            },
        };
    })()`);
}

class Cdp
{
    constructor(url)
    {
        this.socket = new WebSocket(url);
        this.next_id = 1;
        this.pending = new Map();
        this.handlers = new Map();
        this.ready = new Promise((resolve, reject) => {
            this.socket.addEventListener("open", resolve, { once: true });
            this.socket.addEventListener("error", reject, { once: true });
        });
        this.socket.addEventListener("message", event => {
            const message = JSON.parse(event.data);
            if(message.id)
            {
                const pending = this.pending.get(message.id);
                if(!pending) return;
                this.pending.delete(message.id);
                if(message.error) pending.reject(new Error(message.error.message));
                else pending.resolve(message.result);
                return;
            }
            for(const handler of this.handlers.get(message.method) || []) handler(message.params || {});
        });
    }

    call(method, params = {})
    {
        const id = this.next_id++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    on(method, handler)
    {
        const handlers = this.handlers.get(method) || [];
        handlers.push(handler);
        this.handlers.set(method, handlers);
    }

    close()
    {
        this.socket.close();
    }
}

async function run_shader_acceptance_in_page()
{
    const device = window.emulator.v86.cpu.devices.virtio_gpu;
    const backend = device.backend;
    const encoder = new TextEncoder();
    const valid_context_id = 0x7FFF0001;
    const invalid_context_id = 0x7FFF0002;
    const resource_id = 0x7FFF0001;
    const width = 128;
    const height = 128;

    function shader_record(id, stage, source)
    {
        const source_bytes = typeof source === "string" ? encoder.encode(source) : source;
        const size = 24 + ((source_bytes.byteLength + 7) & ~7);
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, 1, true);
        view.setUint16(2, size / 4, true);
        view.setUint32(8, id, true);
        view.setUint32(12, stage, true);
        view.setUint32(16, 1, true);
        view.setUint32(20, source_bytes.byteLength, true);
        bytes.set(source_bytes, 24);
        return bytes;
    }

    function record(opcode, words)
    {
        const bytes = new Uint8Array(8 + words.length * 4);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, opcode, true);
        view.setUint16(2, bytes.byteLength / 4, true);
        for(let index = 0; index < words.length; index++)
        {
            view.setUint32(8 + index * 4, words[index], true);
        }
        return bytes;
    }

    function f32(value)
    {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setFloat32(0, value, true);
        return view.getUint32(0, true);
    }

    function submit(records, resources = [])
    {
        const records_offset = (32 + resources.length * 4 + 7) & ~7;
        const total_size = records_offset +
            records.reduce((total, item) => total + item.byteLength, 0);
        const bytes = new Uint8Array(total_size);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 0x53363856, true);
        view.setUint16(4, 2, true);
        view.setUint32(8, total_size, true);
        view.setUint32(12, records.length, true);
        view.setUint32(16, resources.length, true);
        resources.forEach((id, index) => view.setUint32(32 + index * 4, id, true));
        let offset = records_offset;
        for(const item of records)
        {
            bytes.set(item, offset);
            offset += item.byteLength;
        }
        return bytes;
    }

    const vertex_source = concat(
        "// capset version 2 arbitrary vertex source\n",
        "@vertex fn main(@builtin(vertex_index) i: u32) -> ",
        "@builtin(position) vec4f {",
        "let p = array<vec2f, 3>(vec2f(0.0, 0.72), ",
        "vec2f(-0.72, -0.72), vec2f(0.72, -0.72));",
        "return vec4f(p[i], 0.0, 1.0);}"
    );
    const fragment_source = concat(
        "@fragment fn main() -> @location(0) vec4f {",
        "return vec4f(0.02, 0.95, 0.04, 1.0);}"
    );
    const pipeline_record = record(3, [3, 1, 2, 3, 67, 1, 0, 0]);
    const baseline_stats = Array.from(backend.renderer["object_stats_3d"]());

    await backend.createContext3D(valid_context_id);
    await backend.createResource3D({
        resource_id,
        target: 2,
        bind: 1 << 1,
        format: 67,
        width,
        height,
        byte_length: width * height * 4,
    });
    await backend.attachResource3D(valid_context_id, resource_id);
    const object_submit = submit([
        shader_record(1, 1, vertex_source),
        shader_record(2, 2, fragment_source),
        pipeline_record,
    ]);
    if(!await backend.submit3D(valid_context_id, object_submit, new Uint32Array()))
    {
        throw new Error("Valid arbitrary shader object submit was rejected");
    }
    const object_stats = Array.from(backend.renderer["object_stats_3d"]());

    await backend.createContext3D(invalid_context_id);
    let invalid_cases = 0;
    async function expect_invalid(commands, label, context_id = invalid_context_id,
        resources = new Uint32Array())
    {
        if(await backend.submit3D(context_id, commands, resources))
        {
            throw new Error(`Invalid shader case was accepted: ${label}`);
        }
        if(backend.fatal_error)
        {
            throw backend.fatal_error;
        }
        invalid_cases++;
    }
    await expect_invalid(submit([
        shader_record(1, 1, new Uint8Array([0xFF])),
    ]), "UTF-8");
    await expect_invalid(submit([
        shader_record(1, 1, "@vertex fn main("),
    ]), "syntax");
    await expect_invalid(submit([
        shader_record(1, 1,
            "@vertex fn main() -> @builtin(position) vec4f { return vec4f(true); }"),
    ]), "types");
    await expect_invalid(submit([
        shader_record(1, 1, "fn helper() {}"),
    ]), "missing entry point");
    await expect_invalid(submit([
        shader_record(1, 1,
            "@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }"),
    ]), "stage mismatch");
    await expect_invalid(submit([
        shader_record(1, 1, concat(
            "@group(0) @binding(0) var<uniform> data: vec4f;",
            "@vertex fn main() -> @builtin(position) vec4f { return data; }")),
    ]), "resource binding");
    await expect_invalid(submit([
        shader_record(1, 1, new Uint8Array(16 * 1024 + 1).fill(0x78)),
    ]), "source limit");
    const aggregate_source = concat(
        "//", "x".repeat(15 * 1024), "\n",
        "@vertex fn main() -> @builtin(position) vec4f {",
        "return vec4f(0.0, 0.0, 0.0, 1.0);}"
    );
    await expect_invalid(submit(Array.from({ length: 9 }, (_, index) =>
        shader_record(index + 1, 1, aggregate_source))), "context source limit");
    const small_source = concat(
        "@vertex fn main() -> @builtin(position) vec4f {",
        "return vec4f(0.0, 0.0, 0.0, 1.0);}"
    );
    await expect_invalid(submit(Array.from({ length: 33 }, (_, index) =>
        shader_record(index + 1, 1, small_source))), "live shader limit");
    const mismatch_vertex = concat(
        "struct Out { @builtin(position) pos: vec4f, @location(0) value: vec4f };",
        "@vertex fn main() -> Out {",
        "return Out(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(1.0));}"
    );
    const mismatch_fragment = concat(
        "@fragment fn main(@location(0) value: vec2f) -> @location(0) vec4f {",
        "return vec4f(value, 0.0, 1.0);}"
    );
    await expect_invalid(submit([
        shader_record(1, 1, mismatch_vertex),
        shader_record(2, 2, mismatch_fragment),
        pipeline_record,
    ]), "pipeline interface");

    function make_render_submit(vertices = 3, instances = 1)
    {
        return submit([
            record(16, [0, 1, 1, f32(0.02), f32(0.04), f32(0.30), f32(1), 0]),
            record(17, [3, 0]),
            record(18, [f32(0), f32(0), f32(width), f32(height), f32(0), f32(1)]),
            record(19, [0, 0, width, height]),
            record(20, [vertices, instances, 0, 0]),
            record(21, []),
        ], [resource_id]);
    }
    const attached_resources = new Uint32Array([resource_id]);
    await expect_invalid(make_render_submit(64 * 1024 + 1), "vertex invocation limit",
        valid_context_id, attached_resources);
    await expect_invalid(make_render_submit(3, 2), "instance limit",
        valid_context_id, attached_resources);
    const after_invalid_stats = Array.from(backend.renderer["object_stats_3d"]());
    const render_submit = make_render_submit();
    if(!await backend.submit3D(
        valid_context_id, render_submit, new Uint32Array([resource_id])))
    {
        throw new Error("Valid arbitrary shader render submit was rejected");
    }
    await backend.setScanout({ resource_id, x: 0, y: 0, width, height });
    await backend.flush({ resource_id, x: 0, y: 0, width, height });
    const canvas = backend.canvas;
    const rect = canvas.getBoundingClientRect();

    await backend.detachResource3D(valid_context_id, resource_id);
    await backend.destroyResource(resource_id);
    await backend.destroyContext3D(valid_context_id);
    await backend.destroyContext3D(invalid_context_id);
    const after_cleanup_stats = Array.from(backend.renderer["object_stats_3d"]());
    return {
        baseline_stats,
        object_stats,
        after_invalid_stats,
        after_cleanup_stats,
        invalid_cases,
        vertex_bytes: encoder.encode(vertex_source).byteLength,
        fragment_bytes: encoder.encode(fragment_source).byteLength,
        canvas_visible: !canvas.hidden && getComputedStyle(canvas).display !== "none",
        canvas_width: canvas.width,
        canvas_height: canvas.height,
        rect: {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
        },
    };

    function concat(...parts)
    {
        return parts.join("");
    }
}

async function run_shader_timeout_in_page()
{
    const device = window.emulator.v86.cpu.devices.virtio_gpu;
    const backend = device.backend;
    const context_id = 0x7FFF0003;
    const source = new TextEncoder().encode(concat(
        "// forced timeout shader\n",
        "@vertex fn main() -> @builtin(position) vec4f {",
        "return vec4f(0.0, 0.0, 0.0, 1.0);}"
    ));
    const record_size = 24 + ((source.byteLength + 7) & ~7);
    const commands = new Uint8Array(32 + record_size);
    const view = new DataView(commands.buffer);
    view.setUint32(0, 0x53363856, true);
    view.setUint16(4, 2, true);
    view.setUint32(8, commands.byteLength, true);
    view.setUint32(12, 1, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, record_size / 4, true);
    view.setUint32(40, 1, true);
    view.setUint32(44, 1, true);
    view.setUint32(48, 1, true);
    view.setUint32(52, source.byteLength, true);
    commands.set(source, 56);

    const prototype = GPUDevice.prototype;
    const original_pop_error_scope = prototype.popErrorScope;
    prototype.popErrorScope = function()
    {
        return this.lost.then(info => {
            throw info;
        });
    };
    let error = "";
    const started = performance.now();
    try
    {
        await backend.createContext3D(context_id);
        await backend.submit3D(context_id, commands, new Uint32Array());
    }
    catch(failure)
    {
        error = failure && failure.message || String(failure);
    }
    finally
    {
        prototype.popErrorScope = original_pop_error_scope;
    }
    const elapsed_ms = performance.now() - started;
    const canvas_hidden = backend.canvas.hidden;
    const renderer_disposed = backend.renderer === null;
    device.reset();
    await device.backend_ready;
    const stats = device.get_performance_stats();
    return {
        error,
        elapsed_ms,
        canvas_hidden,
        renderer_disposed,
        recovery: {
            fatal: device.backend.fatal_error?.message || null,
            initialized: device.backend.initialized,
            contexts: stats.live_3d_contexts,
            resources: stats.live_3d_resources,
            attachments: stats.context_attachments,
        },
    };

    function concat(...parts)
    {
        return parts.join("");
    }
}

async function run_shader_work_timeout_in_page()
{
    const device = window.emulator.v86.cpu.devices.virtio_gpu;
    const backend = device.backend;
    const encoder = new TextEncoder();
    const context_entry = device.contexts_3d.entries().next().value;
    if(!context_entry)
    {
        throw new Error("Guest version-2 context is unavailable");
    }
    const [context_id, context] = context_entry;
    const resource_id = context.resources.values().next().value;
    const resource = device.resources.get(resource_id);
    if(!resource)
    {
        throw new Error("Guest version-2 resource is unavailable");
    }

    function record(opcode, words)
    {
        const bytes = new Uint8Array(8 + words.length * 4);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, opcode, true);
        view.setUint16(2, bytes.byteLength / 4, true);
        for(let index = 0; index < words.length; index++)
        {
            view.setUint32(8 + index * 4, words[index], true);
        }
        return bytes;
    }

    function shader_record(id, source)
    {
        const source_bytes = encoder.encode(source);
        const size = 24 + ((source_bytes.byteLength + 7) & ~7);
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, 1, true);
        view.setUint16(2, size / 4, true);
        view.setUint32(8, id, true);
        view.setUint32(12, 1, true);
        view.setUint32(16, 1, true);
        view.setUint32(20, source_bytes.byteLength, true);
        bytes.set(source_bytes, 24);
        return bytes;
    }

    function f32(value)
    {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setFloat32(0, value, true);
        return view.getUint32(0, true);
    }

    function private_submit(records, resources = [])
    {
        const records_offset = (32 + resources.length * 4 + 7) & ~7;
        const total_size = records_offset +
            records.reduce((total, item) => total + item.byteLength, 0);
        const bytes = new Uint8Array(total_size);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 0x53363856, true);
        view.setUint16(4, 2, true);
        view.setUint32(8, total_size, true);
        view.setUint32(12, records.length, true);
        view.setUint32(16, resources.length, true);
        resources.forEach((id, index) => view.setUint32(32 + index * 4, id, true));
        let offset = records_offset;
        for(const item of records)
        {
            bytes.set(item, offset);
            offset += item.byteLength;
        }
        return bytes;
    }

    function fenced_request(commands, fence_id)
    {
        const request = new Uint8Array(32 + commands.byteLength);
        const view = new DataView(request.buffer);
        view.setUint32(0, 0x0207, true);
        view.setUint32(4, 1, true);
        view.setUint32(8, fence_id, true);
        view.setUint32(16, context_id, true);
        view.setUint32(24, commands.byteLength, true);
        request.set(commands, 32);
        return request;
    }

    const prototype = GPUQueue.prototype;
    const original_on_submitted_work_done = prototype.onSubmittedWorkDone;
    prototype.onSubmittedWorkDone = function()
    {
        return new Promise(() => {});
    };
    const object_commands = private_submit([
        shader_record(4, concat(
            "@vertex fn main() -> @builtin(position) vec4f {",
            "return vec4f(0.0, 0.0, 0.0, 1.0);}")),
    ]);
    let object_response;
    const object_started = performance.now();
    try
    {
        object_response = await Promise.race([
            device.process_command(fenced_request(object_commands, 1), 24),
            new Promise((resolve, reject) =>
                setTimeout(() => reject(new Error("Fenced object submit did not settle")), 2000)),
        ]);
    }
    finally
    {
        prototype.onSubmittedWorkDone = original_on_submitted_work_done;
    }
    const object_elapsed_ms = performance.now() - object_started;
    const object_response_view = new DataView(
        object_response.buffer, object_response.byteOffset, object_response.byteLength);

    const render_commands = private_submit([
        record(16, [0, 1, 1, f32(0.02), f32(0.04), f32(0.30), f32(1), 0]),
        record(17, [1, 0]),
        record(18, [
            f32(0), f32(0), f32(resource.width), f32(resource.height), f32(0), f32(1),
        ]),
        record(19, [0, 0, resource.width, resource.height]),
        record(20, [3, 1, 0, 0]),
        record(21, []),
    ], [resource_id]);
    prototype.onSubmittedWorkDone = function()
    {
        return new Promise(() => {});
    };
    let render_response;
    const started = performance.now();
    try
    {
        render_response = await device.process_command(
            fenced_request(render_commands, 2), 24);
    }
    finally
    {
        prototype.onSubmittedWorkDone = original_on_submitted_work_done;
    }
    const elapsed_ms = performance.now() - started;
    const render_response_view = new DataView(
        render_response.buffer, render_response.byteOffset, render_response.byteLength);
    const error = backend.fatal_error?.message || "";
    const canvas_hidden = backend.canvas.hidden;
    const renderer_disposed = backend.renderer === null;
    device.reset();
    await device.backend_ready;
    const stats = device.get_performance_stats();
    return {
        error,
        elapsed_ms,
        object_elapsed_ms,
        object_response_type: object_response_view.getUint32(0, true),
        object_response_flags: object_response_view.getUint32(4, true),
        object_response_fence: object_response_view.getUint32(8, true),
        render_response_type: render_response_view.getUint32(0, true),
        canvas_hidden,
        renderer_disposed,
        recovery: {
            fatal: device.backend.fatal_error?.message || null,
            initialized: device.backend.initialized,
            contexts: stats.live_3d_contexts,
            resources: stats.live_3d_resources,
            attachments: stats.context_attachments,
        },
    };

    function concat(...parts)
    {
        return parts.join("");
    }
}

function dispatch_clipboard_paste_in_page(text)
{
    const display = document.getElementById("screen_container");
    const outside_data = new globalThis.DataTransfer();
    outside_data.setData("text/plain", "outside");
    const outside_event = new globalThis.ClipboardEvent("paste", {
        clipboardData: outside_data,
        bubbles: true,
        cancelable: true,
    });
    document.getElementById("status").dispatchEvent(outside_event);

    const data = new globalThis.DataTransfer();
    data.setData("text/plain", text);
    const event = new globalThis.ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
    });
    display.focus();
    display.dispatchEvent(event);
    return {
        focused: document.activeElement === display,
        default_prevented: event.defaultPrevented,
        outside_default_prevented: outside_event.defaultPrevented,
        paste_button_visible:
            getComputedStyle(document.getElementById("paste-clipboard")).display !== "none",
    };
}

async function run_clipboard_button_acceptance_in_page()
{
    const button = document.getElementById("paste-clipboard");
    const status = document.getElementById("clipboard-status");
    const original_clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const original_send_text = window.emulator.keyboard_send_text;
    const sent_text = [];
    let reads = 0;

    const set_clipboard = value => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value,
        });
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));

    try
    {
        set_clipboard({
            readText: async () => {
                reads++;
                return "button paste = value\nsecond line";
            },
        });
        window.emulator.keyboard_send_text = async (text, delay) => {
            sent_text.push({ text, delay });
        };
        const reads_before_click = reads;
        button.click();
        await settle();
        const reads_after_success = reads;
        const success_status = status.textContent;

        set_clipboard({
            readText: async () => {
                reads++;
                throw new globalThis.DOMException("denied", "NotAllowedError");
            },
        });
        button.click();
        await settle();
        const reads_after_denial = reads;
        const denial_status = status.textContent;

        set_clipboard(undefined);
        button.click();
        await settle();
        const unavailable_status = status.textContent;

        return {
            reads_before_click,
            reads_after_success,
            reads_after_denial,
            sent_text,
            success_status,
            denial_status,
            unavailable_status,
            body_result: document.body.dataset.result,
        };
    }
    finally
    {
        window.emulator.keyboard_send_text = original_send_text;
        if(original_clipboard)
        {
            Object.defineProperty(navigator, "clipboard", original_clipboard);
        }
        else
        {
            delete navigator.clipboard;
        }
    }
}

async function evaluate(cdp, expression)
{
    const response = await cdp.call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if(response.exceptionDetails)
    {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
}

async function wait_for(predicate, timeout, label)
{
    const deadline = Date.now() + timeout;
    let last_error;
    while(Date.now() < deadline)
    {
        try
        {
            if(await predicate()) return;
            last_error = null;
        }
        catch(error)
        {
            if(error.terminal) throw error;
            last_error = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    const diagnostics = last_readiness_state ?
        `\n${last_readiness_state.serial.slice(-6000)}\n` +
        `GPU state: ${JSON.stringify(last_readiness_state.gpu)}` : "";
    throw new Error(`Timed out waiting for ${label}${last_error ? `: ${last_error.message}` : ""}${diagnostics}`);
}

function find_chrome()
{
    const names = process.platform === "win32" ? ["chrome.exe", "chromium.exe"] :
        ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
    const candidates = [
        process.env.CHROME_BIN,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ...String(process.env.PATH || "").split(path.delimiter)
            .flatMap(directory => names.map(name => path.join(directory, name))),
    ].filter(Boolean);
    const executable = candidates.find(candidate => {
        try
        {
            fs.accessSync(candidate, fs.constants.X_OK);
            return true;
        }
        catch
        {
            return false;
        }
    });
    if(!executable)
    {
        throw new Error("Chrome or Chromium was not found; set CHROME_BIN");
    }
    return executable;
}

function read_devtools_url(process)
{
    return new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Chrome DevTools endpoint timed out")), 30000);
        process.stderr.setEncoding("utf8");
        process.stderr.on("data", chunk => {
            output += chunk;
            const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if(match)
            {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        process.once("exit", code => {
            clearTimeout(timer);
            reject(new Error(`Chrome exited before DevTools was ready (${code}): ${output}`));
        });
    });
}

function content_type(filename)
{
    switch(path.extname(filename))
    {
        case ".html": return "text/html; charset=utf-8";
        case ".js":
        case ".mjs": return "text/javascript; charset=utf-8";
        case ".json": return "application/json";
        case ".wasm": return "application/wasm";
        case ".css": return "text/css; charset=utf-8";
        case ".zst": return "application/zstd";
        default: return "application/octet-stream";
    }
}

await main();
