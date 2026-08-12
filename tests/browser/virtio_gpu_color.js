#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    FRAME_HEIGHT,
    FRAME_WIDTH,
    expand_scene,
    load_manifest,
    load_scene,
    pixel_at,
    sha256,
} from "../../tools/docker/virtio-gpu-color/reference.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.V86_GPU_COLOR_PORT || 8081);
const TIMEOUT_MS = Number(process.env.V86_GPU_BROWSER_TIMEOUT_MS || 300000);
const DEFAULT_MATRIX = ["webgpu-js:xorg", "webgpu-js:wayland", "wgpu:xorg", "wgpu:wayland"];
const matrix = (process.env.V86_GPU_BROWSER_MATRIX || DEFAULT_MATRIX.join(","))
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
        const [renderer, desktop] = value.split(":");
        assert.ok(renderer === "webgpu-js" || renderer === "wgpu",
            `Invalid renderer in V86_GPU_BROWSER_MATRIX: ${value}`);
        assert.ok(desktop === "xorg" || desktop === "wayland",
            `Invalid desktop in V86_GPU_BROWSER_MATRIX: ${value}`);
        return { renderer, desktop };
    });

const manifest = load_manifest();
const expected_scenes = manifest.scenes.map(scene => {
    const source = load_scene(scene);
    assert.equal(sha256(source.bytes), scene.file_sha256, `${scene.name} fixture file digest`);
    assert.equal(sha256(source.pixels), scene.source_pixel_sha256, `${scene.name} source-pixel digest`);
    const rgba = expand_scene(scene, source);
    assert.equal(sha256(rgba), scene.frame_rgba_sha256, `${scene.name} reference frame digest`);
    return { scene, rgba };
});

for(const relative of ["build/libv86.mjs", "build/v86.wasm", "images/alpine-virtio-gpu-desktop-fs.json"])
{
    if(!fs.existsSync(path.join(ROOT, relative)))
    {
        throw new Error(`Missing ${relative}; build the browser and desktop guest first`);
    }
}
if(matrix.some(({ renderer }) => renderer === "wgpu") &&
   !fs.existsSync(path.join(ROOT, "build/virtio-gpu-wgpu/virtio_gpu_wgpu.js")))
{
    throw new Error("Missing build/virtio-gpu-wgpu/virtio_gpu_wgpu.js; run make virtio-gpu-wgpu first");
}

async function main()
{
    assert.ok(Number.isInteger(PORT) && PORT > 0 && PORT <= 65535, "V86_GPU_COLOR_PORT is invalid");
    const server = create_server();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(PORT, "127.0.0.1", resolve);
    });
    const base_url = `http://127.0.0.1:${PORT}`;
    try
    {
        const results = [];
        for(const scenario of matrix)
        {
            results.push(await run_scenario_in_chrome(base_url, scenario));
        }
        console.log(JSON.stringify({ result: "pass", port: PORT, scenarios: results }, null, 2));
    }
    finally
    {
        await new Promise(resolve => server.close(resolve));
    }
}

function create_server()
{
    return http.createServer((request, response) => {
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
    });
}

async function run_scenario_in_chrome(base_url, scenario)
{
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "v86-gpu-color-"));
    const chrome = spawn(find_chrome(), [
        "--headless=new",
        "--enable-unsafe-webgpu",
        "--disable-gpu-sandbox",
        "--force-device-scale-factor=1",
        "--window-size=1280,1100",
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
        return await run_scenario(browser_ws, base_url, scenario);
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

async function run_scenario(browser_ws, base_url, scenario)
{
    const browser_url = new URL(browser_ws);
    const target_response = await fetch(
        `http://${browser_url.host}/json/new?${encodeURIComponent("about:blank")}`,
        { method: "PUT" });
    if(!target_response.ok) throw new Error(`Chrome target creation failed: ${target_response.status}`);
    const target = await target_response.json();
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    const failures = [];
    cdp.on("Runtime.exceptionThrown", event => {
        failures.push(event.exceptionDetails?.exception?.description ||
            event.exceptionDetails?.text || "Uncaught browser exception");
    });
    cdp.on("Log.entryAdded", event => {
        if(event.entry?.level === "error") failures.push(event.entry.text);
    });
    await cdp.call("Runtime.enable");
    await cdp.call("Log.enable");
    await cdp.call("Page.enable");

    const started = performance.now();
    try
    {
        const url = `${base_url}/examples/virtio_gpu_desktop.html?desktop=${scenario.desktop}` +
            `&renderer=${scenario.renderer}&color=${Date.now()}`;
        await cdp.call("Page.navigate", { url });
        await wait_for(async() => {
            const state = await evaluate(cdp,
                `({ result: document.body?.dataset?.result || null, ` +
                `fatal: window.emulator?.v86?.cpu?.devices?.virtio_gpu?.backend?.fatal_error?.message || null })`);
            if(state.fatal) throw new Error(state.fatal);
            if(state.result === "fail") throw new Error("Desktop readiness contract failed");
            return state.result === "pass";
        }, TIMEOUT_MS, `${scenario.renderer}:${scenario.desktop} desktop readiness`);

        const stop_session = scenario.desktop === "xorg" ?
            "pkill Xorg; pkill xfce4-session" :
            "pkill labwc; pkill Xwayland; pkill xfce4-session";
        const wait_session = scenario.desktop === "xorg" ? "Xorg" : "labwc Xwayland";
        const color_command = `touch /run/v86-gpu-color-mode; ${stop_session}; ` +
            `timeout 30 sh -c 'while pidof ${wait_session} >/dev/null; do sleep 1; done'; ` +
            "rc-service seatd stop >/dev/null 2>&1 || true; sleep 1; /usr/local/bin/v86-gpu-color\n";
        await evaluate(cdp,
            `window.emulator.serial0_send(${JSON.stringify(color_command)})`, true);
        await wait_for_serial(cdp, "V86_GPU_COLOR_READY",
            60000, `${scenario.renderer}:${scenario.desktop} color utility readiness`);

        const scene_results = [];
        for(let index = 0; index < expected_scenes.length; index++)
        {
            const { scene, rgba: expected } = expected_scenes[index];
            const marker = `V86_GPU_COLOR_SCENE=${scene.name} DIGEST=${scene.frame_rgba_sha256} ` +
                `SOURCE_DIGEST=${scene.source_pixel_sha256}`;
            await wait_for_serial(cdp, marker,
                60000, `${scenario.renderer}:${scenario.desktop}:${scene.name} scanout`);
            const { captured, actual, comparison } =
                await wait_for_presented_rgba(cdp, expected, 30000);
            assert.equal(captured.width, FRAME_WIDTH, `${scenario.renderer}:${scenario.desktop}:${scene.name} width`);
            assert.equal(captured.height, FRAME_HEIGHT, `${scenario.renderer}:${scenario.desktop}:${scene.name} height`);
            assert.equal(captured.device_pixel_ratio, 1,
                `${scenario.renderer}:${scenario.desktop}:${scene.name} device pixel ratio`);
            assert.equal(actual.byteLength, manifest.frame_bytes,
                `${scenario.renderer}:${scenario.desktop}:${scene.name} RGBA bytes`);
            if(comparison.mismatch_count)
            {
                const artifact = write_failure_artifact(scenario, scene, actual, comparison);
                assert.fail(`${scenario.renderer}:${scenario.desktop}:${scene.name}: ` +
                    `${comparison.mismatch_count} mismatches, max channel error ${comparison.max_error}, ` +
                    `first ${JSON.stringify(comparison.first_mismatches)}; artifact ${artifact}`);
            }
            validate_scene_properties(scenario, scene.name, actual);
            scene_results.push({ name: scene.name, rgba_sha256: sha256(actual), mismatch_count: 0 });
            await evaluate(cdp,
                `window.emulator.serial0_send(${JSON.stringify(index + 1 < expected_scenes.length ? "next\n" : "quit\n")})`,
                true);
        }
        await wait_for_serial(cdp, "V86_GPU_COLOR_DONE",
            30000, `${scenario.renderer}:${scenario.desktop} color utility completion`);
        if(failures.length)
        {
            throw new Error(`${scenario.renderer}:${scenario.desktop} browser errors: ${failures.join(" | ")}`);
        }
        return {
            ...scenario,
            scenes: scene_results,
            duration_ms: Math.round(performance.now() - started),
        };
    }
    finally
    {
        await fetch(`http://${browser_url.host}/json/close/${target.id}`);
        cdp.close();
    }
}

async function wait_for_serial(cdp, expected, timeout, label)
{
    let serial = "";
    try
    {
        await wait_for(async() => {
            serial = await evaluate(cdp, `document.getElementById("serial")?.textContent || ""`);
            const error = serial.match(/V86_GPU_COLOR_ERROR=[^\r\n]*/);
            if(error) throw new Error(`${label}: ${error[0]}`);
            return serial.includes(expected);
        }, timeout, label);
    }
    catch(error)
    {
        const tail = serial.slice(-4000);
        throw new Error(`${error.message}. Serial output:\n${tail}`);
    }
}

async function wait_for_presented_rgba(cdp, expected, timeout)
{
    const deadline = Date.now() + timeout;
    let last = null;
    while(Date.now() < deadline)
    {
        await evaluate(cdp, `(async() => {
            const device = window.emulator.v86.cpu.devices.virtio_gpu;
            await device.backend.waitIdle();
        })()`, true);
        const captured = await capture_canvas(cdp);
        const actual = Buffer.from(captured.rgba_base64, "base64");
        const comparison = compare_rgba(expected, actual);
        last = { captured, actual, comparison };
        if(comparison.mismatch_count === 0)
        {
            return last;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return last;
}

async function capture_canvas(cdp)
{
    const rect = await evaluate(cdp, `(() => {
        const canvas = window.emulator.v86.cpu.devices.virtio_gpu.backend.canvas;
        const bounds = canvas.getBoundingClientRect();
        return {
            x: bounds.left + scrollX,
            y: bounds.top + scrollY,
            width: bounds.width,
            height: bounds.height,
            device_pixel_ratio: devicePixelRatio,
        };
    })()`);
    const screenshot = await cdp.call("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
    });
    return await evaluate(cdp, `(async() => {
        const response = await fetch(${JSON.stringify(`data:image/png;base64,${screenshot.data}`)});
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const rgba = context.getImageData(0, 0, canvas.width, canvas.height,
            { colorSpace: "srgb" }).data;
        let binary = "";
        const chunk_size = 0x8000;
        for(let offset = 0; offset < rgba.length; offset += chunk_size)
        {
            binary += String.fromCharCode(...rgba.subarray(offset, offset + chunk_size));
        }
        return {
            width: canvas.width,
            height: canvas.height,
            device_pixel_ratio: ${JSON.stringify(rect.device_pixel_ratio)},
            rgba_base64: btoa(binary),
        };
    })()`, true);
}

function compare_rgba(expected, actual)
{
    let mismatch_count = 0;
    let max_error = 0;
    const first_mismatches = [];
    for(let offset = 0; offset < expected.byteLength; offset++)
    {
        const error = Math.abs(expected[offset] - actual[offset]);
        if(error)
        {
            mismatch_count++;
            max_error = Math.max(max_error, error);
            if(first_mismatches.length < 12)
            {
                const pixel = Math.floor(offset / 4);
                first_mismatches.push({
                    x: pixel % FRAME_WIDTH,
                    y: Math.floor(pixel / FRAME_WIDTH),
                    channel: "rgba"[offset & 3],
                    expected: expected[offset],
                    actual: actual[offset],
                });
            }
        }
    }
    return { mismatch_count, max_error, first_mismatches };
}

function validate_scene_properties(scenario, name, rgba)
{
    const label = `${scenario.renderer}:${scenario.desktop}:${name}`;
    if(name === "ramps")
    {
        const channels = [0, 1, 2, 0, 0, 1, 2, 0];
        for(let row = 0; row < 8; row++)
        {
            const values = [];
            for(let level = 0; level < 256; level++)
            {
                values.push(pixel_at(rgba, level * 4, row * 64 + 32)[channels[row]]);
            }
            assert.deepEqual(values, row < 4 ?
                Array.from({ length: 256 }, (_, index) => index) :
                Array.from({ length: 256 }, (_, index) => 255 - index),
            `${label} 256-step monotonic ramp row ${row}`);
        }
    }
    if(name === "palette")
    {
        const colors = new Set();
        for(let index = 0; index < 4096; index++)
        {
            const pixel = pixel_at(rgba, (index % 64) * 16 + 8,
                Math.floor(index / 64) * 12 + 6);
            colors.add((pixel[0] << 16 | pixel[1] << 8 | pixel[2]) >>> 0);
        }
        assert.equal(colors.size, 4096, `${label} unique palette colors`);
    }
}

function write_failure_artifact(scenario, scene, rgba, comparison)
{
    const directory = path.join(ROOT, "build", "virtio-gpu-color-failures");
    fs.mkdirSync(directory, { recursive: true });
    const stem = `${scenario.renderer}-${scenario.desktop}-${scene.name}`;
    const rgb = Buffer.allocUnsafe(FRAME_WIDTH * FRAME_HEIGHT * 3);
    for(let source = 0, target = 0; source < rgba.length; source += 4)
    {
        rgb[target++] = rgba[source];
        rgb[target++] = rgba[source + 1];
        rgb[target++] = rgba[source + 2];
    }
    const image = path.join(directory, stem + ".ppm");
    fs.writeFileSync(image, Buffer.concat([
        Buffer.from(`P6\n${FRAME_WIDTH} ${FRAME_HEIGHT}\n255\n`), rgb,
    ]));
    fs.writeFileSync(path.join(directory, stem + ".json"), JSON.stringify({
        scenario,
        scene: scene.name,
        expected_sha256: scene.frame_rgba_sha256,
        actual_sha256: sha256(rgba),
        ...comparison,
    }, null, 4) + "\n");
    return image;
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

async function evaluate(cdp, expression, await_promise = false)
{
    const response = await cdp.call("Runtime.evaluate", {
        expression,
        awaitPromise: await_promise,
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
    while(Date.now() < deadline)
    {
        if(await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${label}`);
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
    if(!executable) throw new Error("Chrome or Chromium was not found; set CHROME_BIN");
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
