#!/usr/bin/env node

// End-to-end acceptance for the multi-core Ghostty/Codex appliance
// (tools/docker/multicore-ghostty-codex), booted under worker-per-vCPU
// execution in a real browser.
//
// The bar is deliberately higher than "the guest reached a shell". Three
// classes of failure have all looked like success at some point:
//
//   1. Booting the WRONG image. images/ is a gitignored symlink shared by
//      every worktree, so before this appliance got its own prefix the
//      single-core appliance's rootfs answered to the same name and the
//      multi-core page silently booted a guest it never described. The
//      V86_APPLIANCE_IMAGE marker is asserted first for that reason.
//   2. Degrading to time-sliced execution. Without cross-origin isolation
//      there is no SharedArrayBuffer, and worker mode cannot start. The
//      run then merely looks slow. This test serves COOP/COEP itself and
//      asserts both crossOriginIsolated and the reported smp_mode.
//   3. Passing on a black screen. Every process can be alive with nothing
//      painted. So the canvas is sampled for real content, and then the
//      guest is typed at and the canvas must CHANGE — which is the only
//      check here that proves the whole path (host keystroke -> PS/2 -> X
//      -> Ghostty -> Codex TUI -> llvmpipe -> VirtIO GPU -> WebGPU canvas)
//      is live rather than a single frame that happened to render once.
//
// Usage:
//   node tests/browser/multicore_ghostty_codex_acceptance.js
// Environment:
//   V86_MC_PORT, V86_MC_TIMEOUT_MS, V86_MC_CPUS, V86_MC_RENDERER,
//   V86_MC_MIN_SPEEDUP, CHROME_BIN

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// 8083, not the 8082 the dev server uses, so a running dev server does not
// collide with a test run
const PORT = Number(process.env.V86_MC_PORT || 8083);
const TIMEOUT_MS = Number(process.env.V86_MC_TIMEOUT_MS || 420000);
const CPUS = Number(process.env.V86_MC_CPUS || 4);
const RENDERER = process.env.V86_MC_RENDERER || "webgpu-js";
// The guest grades its own parallel speedup loosely (see appliance-session);
// this is the browser-side bar and is looser still, because CI hosts are
// shared. Time-sliced execution cannot exceed ~1.0 regardless.
const MIN_SPEEDUP = Number(process.env.V86_MC_MIN_SPEEDUP || 1.2);

const REQUIRED = [
    "build/libv86.mjs",
    "build/v86-multimem.wasm",
    "build/gram.wasm",
    "build/gram-shared.wasm",
    "images/multicore-ghostty-codex-fs.json",
    "images/multicore-ghostty-codex-rootfs-flat",
];
for(const relative of REQUIRED)
{
    if(!fs.existsSync(path.join(ROOT, relative)))
    {
        throw new Error(
            `Missing ${relative}; run 'make build/libv86.mjs build/v86-multimem.wasm ` +
            `build/gram.wasm build/gram-shared.wasm' and ` +
            `tools/docker/multicore-ghostty-codex/build.sh first`);
    }
}

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".css": "text/css; charset=utf-8",
    ".bin": "application/octet-stream",
};

function serve_file(request, response)
{
    const url = new URL(request.url, "http://127.0.0.1");
    const target = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)));
    // COOP/COEP are the whole point of serving this ourselves: without them
    // the browser withholds SharedArrayBuffer and worker mode cannot run.
    const headers = {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "cross-origin",
    };
    if(!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory())
    {
        response.writeHead(404, headers);
        response.end("not found");
        return;
    }
    headers["Content-Type"] = MIME[path.extname(target)] || "application/octet-stream";
    response.writeHead(200, headers);
    fs.createReadStream(target).pipe(response);
}

class Cdp
{
    constructor(url)
    {
        this.next_id = 1;
        this.pending = new Map();
        this.listeners = new Map();
        this.socket = new WebSocket(url);
        this.ready = new Promise((resolve, reject) => {
            this.socket.addEventListener("open", resolve, { once: true });
            this.socket.addEventListener("error", reject, { once: true });
        });
        this.socket.addEventListener("message", event => {
            const message = JSON.parse(event.data);
            if(message.id && this.pending.has(message.id))
            {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                message.error ? reject(new Error(message.error.message)) : resolve(message.result);
            }
            else if(message.method)
            {
                for(const handler of this.listeners.get(message.method) || [])
                {
                    handler(message.params);
                }
            }
        });
    }

    on(method, handler)
    {
        if(!this.listeners.has(method)) this.listeners.set(method, []);
        this.listeners.get(method).push(handler);
    }

    call(method, params = {})
    {
        const id = this.next_id++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    close() { try { this.socket.close(); } catch{} }
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
        throw new Error(response.exceptionDetails.exception?.description ||
            response.exceptionDetails.text);
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
            const value = await predicate();
            if(value) return value;
        }
        catch(error)
        {
            last_error = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${label}` +
        (last_error ? `: ${last_error.message}` : ""));
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
        try { fs.accessSync(candidate, fs.constants.X_OK); return true; }
        catch{ return false; }
    });
    if(!executable) throw new Error("Chrome or Chromium was not found; set CHROME_BIN");
    return executable;
}

function read_devtools_url(child)
{
    return new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Chrome did not report a DevTools URL")), 30000);
        child.stderr.on("data", chunk => {
            output += chunk.toString();
            const match = output.match(/ws:\/\/[^\s]+/);
            if(match)
            {
                clearTimeout(timer);
                resolve(match[0]);
            }
        });
        child.once("exit", code => {
            clearTimeout(timer);
            reject(new Error(`Chrome exited early with code ${code}: ${output}`));
        });
    });
}

/** Parse the guest's KEY=VALUE readiness markers out of the serial log. */
function parse_markers(serial_text)
{
    const markers = new Map();
    for(const line of serial_text.split(/\r?\n/))
    {
        const match = line.match(/^(V86_APPLIANCE_[A-Z0-9_]+)=(.*)$/);
        if(match) markers.set(match[1], match[2].trim());
    }
    return markers;
}

/**
 * Screenshot the VirtIO GPU canvas and reduce it to statistics that
 * distinguish a real terminal from a blank one: how much of the frame
 * differs from its own most common colour, how many distinct colours are
 * present, and a coarse signature for comparing two frames.
 */
async function sample_canvas(cdp)
{
    const rect = await evaluate(cdp, `(() => {
        const canvas = document.querySelector(".v86-virtio-gpu-canvas");
        if(!canvas) return null;
        const r = canvas.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height,
                 hidden: canvas.hidden || getComputedStyle(canvas).display === "none" };
    })()`);
    assert.ok(rect, "the VirtIO GPU canvas is present in the page");
    assert.equal(rect.hidden, false, "the VirtIO GPU canvas is visible");
    assert.ok(rect.width > 0 && rect.height > 0, "the canvas has a non-zero size");

    const screenshot = await cdp.call("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
    });

    return evaluate(cdp, `(async () => {
        const image = new Image();
        image.src = "data:image/png;base64,${screenshot.data}";
        await image.decode();
        const copy = document.createElement("canvas");
        copy.width = image.naturalWidth;
        copy.height = image.naturalHeight;
        const context = copy.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, copy.width, copy.height).data;

        const histogram = new Map();
        // Quantise to 5 bits per channel: antialiased text would otherwise
        // inflate the distinct-colour count on its own.
        for(let offset = 0; offset < pixels.length; offset += 4)
        {
            const key = (pixels[offset] >> 3) << 10 | (pixels[offset + 1] >> 3) << 5 |
                pixels[offset + 2] >> 3;
            histogram.set(key, (histogram.get(key) || 0) + 1);
        }
        let background = 0, background_count = 0;
        for(const [key, count] of histogram)
        {
            if(count > background_count) { background_count = count; background = key; }
        }
        const total = copy.width * copy.height;

        // Coarse 8x8 luminance signature, for frame-to-frame comparison.
        const signature = [];
        const step_x = Math.max(1, Math.floor(copy.width / 8));
        const step_y = Math.max(1, Math.floor(copy.height / 8));
        for(let y = 0; y < 8; y++)
        {
            for(let x = 0; x < 8; x++)
            {
                let sum = 0, n = 0;
                for(let dy = 0; dy < step_y; dy += 4)
                {
                    for(let dx = 0; dx < step_x; dx += 4)
                    {
                        const px = Math.min(copy.width - 1, x * step_x + dx);
                        const py = Math.min(copy.height - 1, y * step_y + dy);
                        const o = (py * copy.width + px) * 4;
                        sum += pixels[o] * 0.299 + pixels[o + 1] * 0.587 + pixels[o + 2] * 0.114;
                        n++;
                    }
                }
                signature.push(n ? sum / n : 0);
            }
        }

        return {
            width: copy.width,
            height: copy.height,
            distinct_colors: histogram.size,
            background_fraction: background_count / total,
            foreground_fraction: 1 - background_count / total,
            signature,
        };
    })()`);
}

/** Mean absolute difference between two 8x8 luminance signatures. */
function signature_delta(a, b)
{
    let sum = 0;
    for(let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
}

async function main()
{
    const server = http.createServer(serve_file);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(PORT, "127.0.0.1", resolve);
    });
    const base_url = `http://127.0.0.1:${PORT}`;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "v86-multicore-codex-"));
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

    let cdp;
    try
    {
        const browser_ws = await read_devtools_url(chrome);
        const browser_url = new URL(browser_ws);
        const created = await fetch(
            `http://${browser_url.host}/json/new?${encodeURIComponent("about:blank")}`,
            { method: "PUT" });
        assert.ok(created.ok, `Chrome target creation failed: ${created.status}`);
        cdp = new Cdp((await created.json()).webSocketDebuggerUrl);
        await cdp.ready;

        const failures = [];
        cdp.on("Runtime.exceptionThrown", event =>
            failures.push(event.exceptionDetails?.text || "uncaught browser exception"));
        await cdp.call("Runtime.enable");
        await cdp.call("Page.enable");

        const url = `${base_url}/examples/multicore_ghostty_codex.html` +
            `?cpus=${CPUS}&workers=1&renderer=${RENDERER}`;
        await cdp.call("Page.navigate", { url });

        // ---- 1. the run is meaningful at all ----
        await wait_for(() => evaluate(cdp, "typeof window.emulator !== 'undefined'"),
            60000, "the emulator to be constructed");
        assert.equal(await evaluate(cdp, "crossOriginIsolated"), true,
            "the page is cross-origin isolated (worker mode is impossible without it)");

        const smp_mode = await wait_for(
            () => evaluate(cdp, "window.emulator.smp_mode || null"),
            60000, "smp_mode to be reported");
        assert.equal(smp_mode.execution, "workers",
            `expected worker execution, got ${JSON.stringify(smp_mode)}`);
        assert.equal(smp_mode.topology, "percpu",
            `expected the per-vCPU topology, got ${JSON.stringify(smp_mode)}`);

        // ---- 2. the guest's own readiness contract ----
        const serial = await wait_for(async () => {
            const text = await evaluate(cdp, "window.applianceSerialText || ''");
            if(text.includes("V86_APPLIANCE_READY=FAIL"))
            {
                throw new Error(`guest reported FAIL:\n${text.slice(-2000)}`);
            }
            return text.includes("V86_APPLIANCE_END") ? text : null;
        }, TIMEOUT_MS, "the guest readiness contract");

        const markers = parse_markers(serial);
        const marker = name => {
            assert.ok(markers.has(name), `missing serial marker ${name}`);
            return markers.get(name);
        };

        // Asserted first: this is the check that catches a stale or foreign
        // rootfs answering to this page's image paths.
        assert.equal(marker("V86_APPLIANCE_IMAGE"), "multicore-ghostty-codex",
            "the booted rootfs is this appliance, not another branch's");
        assert.equal(marker("V86_APPLIANCE_READY"), "PASS");
        assert.equal(marker("V86_APPLIANCE_ARCH"), "i686");
        assert.equal(marker("V86_APPLIANCE_UID"), "1000");

        // SMP: every vCPU came out of WaitForSipi and Linux scheduled it.
        assert.equal(marker("V86_APPLIANCE_CPUS"), String(CPUS),
            "the guest brought every configured vCPU online");
        assert.equal(marker("V86_APPLIANCE_CPUS_EXPECTED"), String(CPUS));
        const speedup = Number(marker("V86_APPLIANCE_PARALLEL_SPEEDUP"));
        assert.ok(speedup >= MIN_SPEEDUP,
            `in-guest parallel speedup ${speedup} is below ${MIN_SPEEDUP}; ` +
            "the vCPUs are online but not running concurrently");

        // Graphics and Codex.
        assert.match(marker("V86_APPLIANCE_RENDERER"), /llvmpipe/i);
        assert.equal(marker("V86_APPLIANCE_XORG"), "PASS");
        assert.equal(marker("V86_APPLIANCE_OPENBOX"), "PASS");
        assert.equal(marker("V86_APPLIANCE_GHOSTTY_PROCESS"), "PASS");
        assert.equal(marker("V86_APPLIANCE_CODEX_PROCESS"), "PASS");
        assert.equal(marker("V86_APPLIANCE_CODEX_TUI"), "PASS");
        assert.equal(marker("V86_APPLIANCE_NETWORK"), "UNCONFIGURED",
            "no relay was supplied, so the guest must report UNCONFIGURED and still pass");

        // ---- 3. real pixels ----
        const before = await wait_for(async () => {
            const sample = await sample_canvas(cdp);
            return sample.foreground_fraction > 0.005 ? sample : null;
        }, 120000, "the canvas to show more than a uniform field");

        assert.ok(before.distinct_colors >= 8,
            `the canvas has only ${before.distinct_colors} distinct colours; ` +
            "a painted terminal has many more");
        assert.ok(before.foreground_fraction >= 0.005,
            `only ${(before.foreground_fraction * 100).toFixed(3)}% of the canvas ` +
            "differs from its background; the screen is effectively blank");

        // ---- 4. real ACTIVITY: the pixels must respond to input ----
        // A single rendered frame can be a splash screen. Typing proves the
        // whole chain is live end to end.
        await evaluate(cdp,
            "window.emulator.keyboard_send_text('echo v86-multicore-acceptance'), true");
        const after = await wait_for(async () => {
            const sample = await sample_canvas(cdp);
            return signature_delta(before.signature, sample.signature) > 1.0 ? sample : null;
        }, 90000, "the canvas to change in response to typed input");

        const delta = signature_delta(before.signature, after.signature);
        assert.ok(delta > 1.0,
            `the canvas did not change after input (delta ${delta.toFixed(2)}); ` +
            "the frame is static, so the terminal is not live");

        assert.deepEqual(failures, [], `browser reported errors: ${failures.join("; ")}`);

        console.log("multicore-ghostty-codex acceptance: PASS");
        console.log(`  execution      ${smp_mode.execution}/${smp_mode.topology}` +
            ` (${smp_mode.memory_model})`);
        console.log(`  vCPUs online   ${markers.get("V86_APPLIANCE_CPUS")}` +
            ` (in-guest parallel speedup ${speedup}x)`);
        console.log(`  renderer       ${markers.get("V86_APPLIANCE_RENDERER")}`);
        console.log(`  ghostty/codex  ${markers.get("V86_APPLIANCE_GHOSTTY")} / ` +
            `${markers.get("V86_APPLIANCE_CODEX")}`);
        console.log(`  canvas         ${after.width}x${after.height}, ` +
            `${after.distinct_colors} colours, ` +
            `${(after.foreground_fraction * 100).toFixed(2)}% foreground, ` +
            `input delta ${delta.toFixed(2)}`);
    }
    finally
    {
        cdp && cdp.close();
        chrome.kill("SIGTERM");
        if(chrome.exitCode === null)
        {
            await Promise.race([
                new Promise(resolve => chrome.once("exit", resolve)),
                new Promise(resolve => setTimeout(resolve, 5000)),
            ]);
        }
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        server.close();
    }
}

await main();
