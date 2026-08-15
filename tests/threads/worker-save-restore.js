#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W4 gate (docs/smp-phase4-design.md §7, §9 W4):
// save/restore across workers — Layer C item 5 plus the cross-mode matrix.
//
// Phase 1 — topology (b), the Alpine SMP fixture, cpus: 2: boot to a
//   shell, start a two-process CPU-bound load, SAVE UNDER LOAD (quiesce ->
//   per-worker state assembly -> today's get_state -> resume), then
//   restore the image into the same machine: alive, serial responsive,
//   nproc == 2 (item 5's image-consistency acceptance).
// Phase 2 — cross-mode, workers -> time-sliced: the same image restores
//   into a plain time-sliced machine (same v7 bytes, default artifact).
// Phase 3 — cross-mode, time-sliced -> workers: an image saved from the
//   time-sliced machine restores into the (b) machine (distribution path).
// Phase 4 — topology (c) both directions plus the boot-time initial_state
//   route: a machine-worker V86 constructed WITH initial_state (the
//   time-sliced image) comes up restored; its own save restores back into
//   the time-sliced machine.
//
// Missing artifacts/images skip cleanly (the repo pattern).

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
const default_wasm = root_path +
    (TEST_RELEASE_BUILD ? "/build/v86.wasm" : "/build/v86-debug.wasm");
for(const artifact of [multimem_wasm, default_wasm])
{
    if(!fs.existsSync(artifact))
    {
        console.log("Missing " + artifact + ", test skipped");
        process.exit(0);
    }
}
if(!fs.existsSync(root_path + "/images/alpine-virtio-gpu-codex-fs.json"))
{
    console.log("Missing images/alpine-virtio-gpu-codex-fs.json, test skipped");
    process.exit(0);
}

install_node_web_worker();

const WORKER_URL = new URL("../../src/browser/vcpu_worker.js", import.meta.url);
const TIMEOUT_FACTOR = +process.env.TIMEOUT_EXTRA_FACTOR || 1;
const CPUS = 2;

// Two background CPU-bound pipelines; the image is saved while they spin.
// The loop pids are kept in shell variables so the load can be killed
// after the save-under-load phases: the images produced under load are
// restored and verified (phases 1 and 2), but the multi-generation image
// chain of phases 3/4 is built from a quiesced guest — a busy 9p-paging
// workload surviving several cross-machine restores exercises 9p fid
// churn far beyond what any single restore promises, and is not what
// this test gates.
const LOAD = "( while true; do dd if=/dev/zero bs=1M count=32 2>/dev/null | " +
    "md5sum > /dev/null; done ) & L1=$!; ( while true; do dd if=/dev/zero bs=1M " +
    "count=32 2>/dev/null | md5sum > /dev/null; done ) & L2=$!\n";
const KILL_LOAD = "kill $L1 $L2 2>/dev/null\n";

function fail_timeout(label, seconds, dump)
{
    return setTimeout(() =>
    {
        dump && dump();
        throw new Error("Timeout: " + label);
    }, seconds * TIMEOUT_FACTOR * 1000);
}

function boot(options)
{
    const emulator = new V86(Object.assign({
        bios: { url: root_path + "/bios/seabios.bin" },
        vga_bios: { url: root_path + "/bios/vgabios.bin" },
        autostart: true,
        memory_size: 512 * 1024 * 1024,
        acpi: true,
        cpus: CPUS,
        log_level: 0,
        bzimage_initrd_from_filesystem: true,
        cmdline: [
            "rw",
            "root=host9p",
            "rootfstype=9p",
            "rootflags=trans=virtio,cache=loose",
            "modules=virtio_pci",
            "console=ttyS0,115200",
            "tsc=reliable",
            "init=/bin/sh",
        ].join(" "),
        filesystem: {
            basefs: root_path + "/images/alpine-virtio-gpu-codex-fs.json",
            baseurl: root_path + "/images/alpine-virtio-gpu-codex-rootfs-flat/",
        },
        disable_jit: +process.env.DISABLE_JIT,
    }, options));

    const state = { emulator, serial: "", smp_mode: null };
    emulator.add_listener("smp-mode", mode => { state.smp_mode = mode; });
    emulator.add_listener("emulator-error", e => { throw e; });
    const watchers = [];
    emulator.add_listener("serial0-output-byte", byte =>
    {
        state.serial += String.fromCharCode(byte);
        if(byte === 0x0A)
        {
            for(let i = watchers.length - 1; i >= 0; i--)
            {
                if(watchers[i]())
                {
                    watchers.splice(i, 1);
                }
            }
        }
    });
    state.wait_for_serial = predicate => new Promise(resolve =>
    {
        const check = () =>
        {
            if(predicate(state.serial))
            {
                resolve();
                return true;
            }
            return false;
        };
        if(!check())
        {
            watchers.push(check);
        }
    });
    return state;
}

let marker_id = 0;

// Repeat a unique marker echo until the shell answers: input typed before
// the shell listens — or swallowed around a snapshot restore — is lost, so
// a single send can hang forever (the smp-state.js pattern).
async function wait_shell_responsive(state, label, seconds)
{
    const marker = "v86-mark-" + marker_id++;
    const pattern = new RegExp("^" + marker + "\r?$", "m");
    let timed_out = false;
    const timeout = setTimeout(() => { timed_out = true; }, seconds * TIMEOUT_FACTOR * 1000);
    // retries lead with ^C: an image captured with the shell blocked in a
    // foreground read gets its prompt back on SIGINT
    const send = interrupt => state.emulator.serial0_send(
        (interrupt ? "\x03" : "") +
        "\necho " + marker.slice(0, -1) + "''" + marker.slice(-1) + "\n");
    const poller = setInterval(() => send(true), 5000);
    send(false);
    await Promise.race([
        state.wait_for_serial(s => pattern.test(s)),
        (async () => { while(!timed_out) { await sleep(250); } })(),
    ]);
    clearInterval(poller);
    clearTimeout(timeout);
    if(timed_out && !pattern.test(state.serial))
    {
        console.log(state.serial.slice(-3000));
        throw new Error("Timeout: " + label);
    }
}

// One restore attempt + responsiveness check, with a single retry on an
// unresponsive shell: an image whose guest was captured at an unlucky
// point can come back with PID 1 wedged (the same capture-point class as
// the long-flaky default-mode state.js "async cdrom" case) — that is a
// property of the capture, not of the restore wire, and a genuinely
// broken wire fails both attempts deterministically.
async function restore_and_verify(state, image, label)
{
    for(let attempt = 0; ; attempt++)
    {
        await state.emulator.restore_state(image);
        try
        {
            await wait_shell_responsive(state, label + " shell", 240);
            break;
        }
        catch(e)
        {
            if(attempt >= 1)
            {
                throw e;
            }
            console.log(label + ": unresponsive after restore, retrying the restore once");
        }
    }
    await assert_nproc(state, label);
}

async function assert_nproc(state, label)
{
    const tag = "NPROC" + marker_id++;
    const timeout = fail_timeout(label + " nproc", 120, () => console.log(state.serial));
    state.emulator.serial0_send("echo " + tag.slice(0, -1) + "''" + tag.slice(-1) +
        "=$(nproc)\n");
    await state.wait_for_serial(s => new RegExp("^" + tag + "=\\d+\r?$", "m").test(s));
    clearTimeout(timeout);
    const match = state.serial.match(new RegExp("^" + tag + "=(\\d+)\r?$", "m"));
    assert.equal(+match[1], CPUS, "nproc (" + label + ")");
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- phase 1: (b) boot, save under load, roundtrip into itself ----

const w = boot({
    smp_workers: true,
    smp_worker_topology: "percpu",
    smp_worker_url: WORKER_URL,
});
{
    const timeout = fail_timeout("phase 1 boot", 420, () => console.log(w.serial));
    await wait_shell_responsive(w, "phase 1 shell", 420);
    clearTimeout(timeout);
}
assert(w.smp_mode && w.smp_mode["execution"] === "workers" &&
    w.smp_mode["topology"] === "percpu", "phase 1 must run topology (b)");
await assert_nproc(w, "phase 1 boot");

w.emulator.serial0_send(LOAD);
await sleep(1500);

console.log("phase 1: saving the (b) machine under load");
const state_w = await w.emulator.save_state();
assert(state_w instanceof ArrayBuffer && state_w.byteLength > 1024 * 1024,
    "save under load must produce a real image");
// keep running under load so the restore visibly rolls back
await sleep(1500);

console.log("phase 1: restoring the image into the same (b) machine");
await restore_and_verify(w, state_w, "phase 1 restore");
console.log("phase 1: (b) save-under-load image restored into (b), machine alive, nproc == " +
    CPUS);
// stop the restored load in W (the image keeps its own copy running)
w.emulator.serial0_send(KILL_LOAD);
await sleep(1000);

// NOTE: no reboot phase on this machine — rebooting after THIS guest
// (Alpine linux-lts) crashes identically under plain time-sliced cpus=2
// on the default artifact (the upstream reboot-after-Linux class of
// github.com/copy/v86/issues/636, the reason reboot-buildroot.js is
// disabled in the Makefile). The W4 quiesced-reboot machinery is gated by
// tests/threads/worker-reboot.js against a guest whose reboot works.

// ---- phase 2: cross-mode, workers -> time-sliced ----

const t = boot({});
await wait_shell_responsive(t, "phase 2 boot", 420);
assert(!t.smp_mode || t.smp_mode["execution"] === "time-sliced",
    "phase 2 machine must be time-sliced");
console.log("phase 2: restoring the (b)-saved image into the time-sliced machine");
await restore_and_verify(t, state_w, "phase 2 restore");
console.log("phase 2: worker-saved image restored under time-sliced execution");
// T now runs the under-load image; stop its load before building the
// phase-3/4 image chain from it
t.emulator.serial0_send(KILL_LOAD);
await sleep(1000);
await wait_shell_responsive(t, "phase 2 post-kill shell", 120);

// ---- phase 3: cross-mode, time-sliced -> workers ----

console.log("phase 3: saving the time-sliced machine");
const state_t = await t.emulator.save_state();
console.log("phase 3: restoring the time-sliced image into the (b) machine");
await restore_and_verify(w, state_t, "phase 3 restore");
console.log("phase 3: time-sliced image restored under workers (b)");

// ---- phase 4: topology (c) both directions + boot-time initial_state ----

const c = boot({
    smp_workers: true,
    smp_worker_topology: "machine",
    smp_worker_url: WORKER_URL,
    initial_state: { buffer: state_t },
});
{
    const timeout = fail_timeout("phase 4 initial_state come-up", 300,
        () => console.log(c.serial));
    await wait_shell_responsive(c, "phase 4 shell", 300);
    clearTimeout(timeout);
}
assert(c.smp_mode && c.smp_mode["execution"] === "workers" &&
    c.smp_mode["topology"] === "machine", "phase 4 must run topology (c)");
await assert_nproc(c, "phase 4 initial_state");
console.log("phase 4: time-sliced image restored at boot into topology (c) via initial_state");

console.log("phase 4: saving the (c) machine");
const state_c = await c.emulator.save_state();
console.log("phase 4: restoring the (c)-saved image into the time-sliced machine");
await restore_and_verify(t, state_c, "phase 4 restore");
console.log("phase 4: (c)-saved image restored under time-sliced execution");

await w.emulator.destroy();
await t.emulator.destroy();
await c.emulator.destroy();

console.log("Tests passed");
process.exit(0);
