#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const READY_TIMEOUT_MS = Number(process.env.V86_GPU_BROWSER_TIMEOUT_MS || 300000);
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

const required = [
    "build/libv86.mjs",
    "build/v86.wasm",
    "images/alpine-virtio-gpu-desktop-fs.json",
];
for(const relative of required)
{
    if(!fs.existsSync(path.join(ROOT, relative)))
    {
        throw new Error(`Missing ${relative}; build the browser and desktop guest first`);
    }
}
if(matrix.some(({ renderer }) => renderer === "wgpu"))
{
    const generated = "build/virtio-gpu-wgpu/virtio_gpu_wgpu.js";
    if(!fs.existsSync(path.join(ROOT, generated)))
    {
        throw new Error(`Missing ${generated}; run make virtio-gpu-wgpu first`);
    }
}

async function main()
{
    const server = http.createServer((request, response) => {
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
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const base_url = `http://127.0.0.1:${address.port}`;

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "v86-gpu-browser-"));
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

        const results = [];
        for(const scenario of matrix)
        {
            results.push(await run_scenario(browser_ws, base_url, scenario));
        }
        console.log(JSON.stringify({ result: "pass", scenarios: results }, null, 2));
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
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

async function run_scenario(browser_ws, base_url, scenario)
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

    const scenario_started = performance.now();
    const url = `${base_url}/examples/virtio_gpu_desktop.html?desktop=${scenario.desktop}` +
        `&renderer=${scenario.renderer}&acceptance=${Date.now()}`;
    await cdp.call("Page.navigate", { url });
    await wait_for(async() => {
        const state = await evaluate(cdp,
            `({ result: document.body?.dataset?.result || null, ` +
            `fatal: window.emulator?.v86?.cpu?.devices?.virtio_gpu?.backend?.fatal_error?.message || null })`);
        if(state.fatal) throw new Error(state.fatal);
        if(state.result === "fail") throw new Error("Desktop readiness contract failed");
        return state.result === "pass";
    }, READY_TIMEOUT_MS, `${scenario.renderer}:${scenario.desktop} desktop readiness`);
    const ready_ms = performance.now() - scenario_started;
    const acceptance_started = performance.now();

    const acceptance = await evaluate(cdp, `(${browser_acceptance.toString()})(${JSON.stringify(scenario)})`, true);
    assert.equal(acceptance.reset_fallback, true);
    assert.equal(acceptance.restore_presented, true);
    assert.equal(acceptance.storage_capacity, true);
    assert.equal(acceptance.cursor_overlay, true);
    assert.equal(acceptance.connector_mode, true);
    assert.equal(acceptance.resize_presented, true);
    assert.equal(acceptance.loss_fallback, true);
    assert.equal(acceptance.loss_recovery, true);
    assert.equal(acceptance.fatal_before_loss, null);
    assert.ok(acceptance.stats.commands > 0);
    assert.ok(acceptance.stats.presentations > 0);
    if(failures.length)
    {
        throw new Error(`${scenario.renderer}:${scenario.desktop} browser errors: ${failures.join(" | ")}`);
    }

    const result = {
        ...scenario,
        ...acceptance,
        ready_ms: Math.round(ready_ms),
        acceptance_ms: Math.round(performance.now() - acceptance_started),
        total_ms: Math.round(performance.now() - scenario_started),
    };
    await fetch(`http://${browser_url.host}/json/close/${target.id}`);
    cdp.close();
    return result;
}

async function browser_acceptance(scenario)
{
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const wait = async(predicate, timeout, label) => {
        const deadline = performance.now() + timeout;
        while(performance.now() < deadline)
        {
            if(await predicate()) return;
            await sleep(250);
        }
        throw new Error(`Timed out waiting for ${label}`);
    };
    const emulator = window.emulator;
    const storage_capacity = emulator.fs9p?.total_size === 2 * 1024 * 1024 * 1024;
    const device = emulator.v86.cpu.devices.virtio_gpu;
    const backend = device.backend;
    const canvas = backend.canvas;
    const initial = { width: device.scanouts[0].width, height: device.scanouts[0].height };
    const state = device.get_state();
    state[0] = device.virtio.get_state();
    for(let index = 0; index < device.virtio.queues.length; index++)
    {
        state[0][10 + index] = device.virtio.queues[index].get_state();
    }

    await emulator.stop();
    device.reset();
    await device.backend_ready;
    const reset_fallback = canvas.hidden;
    device.set_state(state);
    await device.backend_ready;
    const restore_presented = !canvas.hidden &&
        device.scanouts[0]?.width === initial.width && device.scanouts[0]?.height === initial.height;
    await emulator.run();

    const target = scenario.desktop === "xorg" ? { width: 800, height: 600 } :
        { width: 1280, height: 720 };
    if(!emulator.virtio_gpu_set_size(target.width, target.height))
    {
        throw new Error("Configured resize was unexpectedly a no-op");
    }
    if(device.events_read !== 1)
    {
        throw new Error("Resize did not raise a display event");
    }
    await wait(() => device.events_read === 0, 30000, "guest display-event acknowledgement");

    const serial = document.getElementById("serial");
    const query_begin = "V86_GPU_MODE_QUERY_BEGIN";
    const query_end = "V86_GPU_MODE_QUERY_END";
    emulator.serial0_send("printf 'V86_GPU_MODE_QUERY_''BEGIN\\n'; " +
        "modetest -M virtio_gpu -c; printf 'V86_GPU_MODE_QUERY_''END\\n'\n");
    await wait(() => serial.textContent.includes(query_end),
        30000, "resized connector query");
    const connector_output = serial.textContent.slice(serial.textContent.lastIndexOf(query_begin));
    if(!connector_output.includes(`${target.width}x${target.height}`))
    {
        throw new Error(`Resized connector mode was not advertised: ${connector_output}`);
    }
    const connector_match = connector_output.match(/\n(\d+)\s+\d+\s+connected/);
    if(!connector_match)
    {
        throw new Error("Could not identify the connected virtio-gpu connector");
    }
    const connector_mode = connector_output.includes(`${target.width}x${target.height}`);
    const stop_session = scenario.desktop === "xorg" ? "pkill Xorg" : "pkill labwc; pkill Xwayland";
    emulator.serial0_send(`${stop_session}; sleep 2; tail -f /dev/null | ` +
        `modetest -M virtio_gpu -s ${connector_match[1]}:${target.width}x${target.height} ` +
        ">/tmp/v86-gpu-resize.log 2>&1 &\n");
    await wait(() => device.scanouts[0]?.width === target.width &&
        device.scanouts[0]?.height === target.height && canvas.width === target.width &&
        canvas.height === target.height, 60000, "resized WebGPU presentation");
    const resize_presented = !canvas.hidden;
    const cursor_data = new Uint8Array(64 * 64 * 4);
    for(let offset = 3; offset < cursor_data.length; offset += 4)
    {
        cursor_data[offset] = 0xFF;
    }
    await backend.setCursor({
        resource_id: 1,
        scanout_id: 0,
        x: 32,
        y: 48,
        hot_x: 1,
        hot_y: 2,
        data: cursor_data,
    });
    const cursor_overlay = !backend.cursor_canvas.hidden &&
        backend.cursor_canvas.style.left !== "" &&
        backend.cursor_canvas.style.top !== "";
    await backend.setCursor(null);
    const fatal_before_loss = backend.fatal_error?.message || null;
    const stats = emulator.virtio_gpu_get_stats();

    backend.handle_fatal(new Error("acceptance injected device loss"), "acceptance");
    await wait(() => canvas.hidden, 5000, "VGA fallback after device loss");
    const loss_fallback = canvas.hidden &&
        backend.fatal_error?.message.includes("acceptance injected device loss");
    await emulator.stop();
    device.set_state(state);
    await device.backend_ready;
    const loss_recovery = !canvas.hidden &&
        backend.fatal_error === null &&
        device.scanouts[0]?.width === initial.width &&
        device.scanouts[0]?.height === initial.height;
    return {
        storage_capacity,
        reset_fallback,
        restore_presented,
        connector_mode,
        resize_presented,
        cursor_overlay,
        loss_fallback,
        loss_recovery,
        fatal_before_loss,
        target,
        stats,
    };
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
