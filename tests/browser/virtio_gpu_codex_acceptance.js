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
assert.ok(["appliance", "triangle", "shader"].includes(SCENARIO),
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

for(const relative of [
    "build/libv86.mjs",
    "build/v86.wasm",
    "images/alpine-virtio-gpu-codex-fs.json",
])
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
        console.log(JSON.stringify({ result: "pass", port: PORT, scenarios }, null, 2));
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

    try
    {
        const started = performance.now();
        const url = new URL(
            `${base_url}/examples/virtio_gpu_codex.html?renderer=${renderer}&acceptance=${Date.now()}`);
        if(RELAY_URL) url.searchParams.set("relay", RELAY_URL);
        if(SCENARIO === "shader") url.searchParams.set("shader", "1");
        else if(SCENARIO === "triangle") url.searchParams.set("triangle", "1");
        await cdp.call("Page.navigate", { url: url.href });
        await wait_for(async() => {
            const state = await evaluate(cdp,
                `({ result: document.body?.dataset?.result || null, ` +
                `serial: window.applianceSerialText || "", ` +
                `gpu: (() => { const device = window.emulator?.v86?.cpu?.devices?.virtio_gpu; ` +
                `return device ? { resources: Array.from(device.resources.values()).map(resource => ({ ` +
                `backing_length: resource.backing_length, backing_entries: resource.backing.length })), ` +
                `contexts: Array.from(device.contexts_3d.entries()).map(([id, context]) => ` +
                `({ id, resources: Array.from(context.resources) })), ` +
                `stats: device.get_performance_stats() } : null; })(), ` +
                `fatal: window.emulator?.v86?.cpu?.devices?.virtio_gpu?.backend?.fatal_error?.message || null })`);
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
                const serial_tail = state.serial.slice(-6000);
                const error = new Error(
                    `Appliance readiness contract failed: ${reason}\n${serial_tail}\n` +
                    `GPU state: ${JSON.stringify(state.gpu)}`);
                error.terminal = true;
                throw error;
            }
            return state.result === "pass";
        }, READY_TIMEOUT_MS, `${renderer} appliance readiness`);
        const ready_ms = performance.now() - started;

        const state = await evaluate(cdp, `(() => {
            const serial = window.applianceSerialText || "";
            const device = window.emulator.v86.cpu.devices.virtio_gpu;
            const canvas = device.backend.canvas;
            return {
                session_id: window.applianceSessionId,
                serial,
                memory_size: window.emulator.v86.cpu.memory_size[0],
                storage_size: window.emulator.fs9p.total_size,
                scanout: device.scanouts[0],
                canvas_visible: !canvas.hidden && getComputedStyle(canvas).display !== "none",
                canvas_width: canvas.width,
                canvas_height: canvas.height,
            };
        })()`);
        if(SCENARIO !== "appliance")
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
            assert.ok(state.serial.includes(
                `V86_GPU_TRIANGLE_GET_CAPS=PASS version=${SCENARIO === "shader" ? 2 : 1}`),
                "Guest did not use the requested capset version");
            if(SCENARIO === "shader")
            {
                assert.ok(state.serial.includes("V86_GPU_SHADER_V2=PASS"),
                    "Missing version-2 guest shader marker");
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
        for(const marker of [
            "V86_APPLIANCE_ARCH=i686",
            "V86_APPLIANCE_UID=1000",
            "V86_APPLIANCE_HOSTNAME=v86-appliance",
            `V86_APPLIANCE_NETWORK=${RELAY_URL ? "PASS" : "UNCONFIGURED"}`,
            "V86_APPLIANCE_XORG=PASS",
            "V86_APPLIANCE_OPENBOX=PASS",
            "V86_APPLIANCE_GHOSTTY_PROCESS=PASS",
            "V86_APPLIANCE_GHOSTTY_WINDOW=PASS",
            "V86_APPLIANCE_CODEX_PROCESS=PASS",
            "V86_APPLIANCE_READY=PASS",
        ])
        {
            assert.ok(state.serial.includes(marker), `Missing guest marker: ${marker}`);
        }
        assert.match(state.serial, /V86_APPLIANCE_RENDERER=.*llvmpipe/i);
        assert.match(state.serial, /V86_APPLIANCE_OPENGL=4\.[1-9]/);
        assert.match(state.serial, /V86_APPLIANCE_GHOSTTY=Ghostty 1\.3\.1/);
        assert.ok(state.serial.includes("V86_APPLIANCE_CODEX=codex-cli 0.147.0"));
        assert.equal(state.memory_size, 2 * 1024 * 1024 * 1024 - 128 * 1024);
        assert.equal(state.storage_size, 2 * 1024 * 1024 * 1024);
        assert.equal(state.canvas_visible, true);
        assert.equal(state.canvas_width, state.scanout.width);
        assert.equal(state.canvas_height, state.scanout.height);

        if(RELAY_URL)
        {
            await guest_command(cdp,
                "if wget -qO /tmp/v86-relay-check https://api.github.com/zen; then printf 'V86_APPLIANCE_TLS=%s\\n' PASS; else printf 'V86_APPLIANCE_TLS=%s\\n' FAIL; fi",
                "V86_APPLIANCE_TLS=PASS", "V86_APPLIANCE_TLS=FAIL", 60000);
        }
        await guest_command(cdp,
            "found=; for package in xfce4 xfce4-panel xfce4-session xfdesktop thunar xfce4-terminal tumbler garcon exo; do if apk info -e \"$package\" >/dev/null 2>&1; then found=1; fi; done; if [ -z \"$found\" ]; then printf 'V86_APPLIANCE_EXCLUSIONS=%s\\n' PASS; else printf 'V86_APPLIANCE_EXCLUSIONS=%s\\n' FAIL; fi",
            "V86_APPLIANCE_EXCLUSIONS=PASS", "V86_APPLIANCE_EXCLUSIONS=FAIL", 30000);
        await guest_command(cdp,
            "if codex login status >/tmp/v86-codex-login.log 2>&1; then printf 'V86_APPLIANCE_LOGIN=%s\\n' FAIL; elif grep -q 'Not logged in' /tmp/v86-codex-login.log && [ ! -e /home/codex/.codex/auth.json ]; then printf 'V86_APPLIANCE_LOGIN=%s\\n' UNCONFIGURED; else printf 'V86_APPLIANCE_LOGIN=%s\\n' FAIL; fi",
            "V86_APPLIANCE_LOGIN=UNCONFIGURED", "V86_APPLIANCE_LOGIN=FAIL", 30000);

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
            llvmpipe: true,
            tls_relay: Boolean(RELAY_URL),
            desktop_exclusions: true,
            login_unconfigured: true,
            keyboard_input: true,
            responsive_layout: true,
            fresh_reset,
        };
    }
    finally
    {
        cdp.close();
        await fetch(`http://${browser_url.host}/json/close/${target.id}`).catch(() => {});
    }
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
        const center = Array.from(context.getImageData(
            Math.floor(copy.width / 2), Math.floor(copy.height / 2), 1, 1).data);
        const corner_x = Math.min(copy.width - 1,
            Math.max(0, Math.floor(8 * copy.width / ${rendered.canvas_width})));
        const corner_y = Math.min(copy.height - 1,
            Math.max(0, Math.floor(8 * copy.height / ${rendered.canvas_height})));
        const corner = Array.from(context.getImageData(corner_x, corner_y, 1, 1).data);
        return { center, corner };
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
        format: 67,
        width,
        height,
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
