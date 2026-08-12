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
const renderers = (process.env.V86_CODEX_BROWSER_RENDERERS || "webgpu-js,wgpu")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
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
        await cdp.call("Page.navigate", { url: url.href });
        await wait_for(async() => {
            const state = await evaluate(cdp,
                `({ result: document.body?.dataset?.result || null, ` +
                `serial: window.applianceSerialText || "", ` +
                `fatal: window.emulator?.v86?.cpu?.devices?.virtio_gpu?.backend?.fatal_error?.message || null })`);
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
                    `Appliance readiness contract failed: ${reason}\n${serial_tail}`);
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
    throw new Error(`Timed out waiting for ${label}${last_error ? `: ${last_error.message}` : ""}`);
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
