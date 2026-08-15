#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W5 (docs/smp-phase4-design.md §9 W5): the §8
// failure-mode contracts, end to end through the public V86 API.
//
// Phase A — fail-stop, topology (b): boot the Alpine SMP fixture with two
//   per-vCPU workers, put the guest under load, then worker.terminate()
//   vCPU 1's worker from the test (a mid-run kill). Contract (§8):
//   "emulator-error" with a descriptive Error, the surviving worker parked,
//   the machine stopped (the device tick loop must not keep running
//   against a dead guest), and no hang — destroy() completes.
//
// Phase B — fail-stop, topology (c): same contract for the single machine
//   worker (linux4.iso, cpus 1).
//
// Phase C — spawn-failure degradation: a bad smp_worker_url under
//   smp_workers: "auto" degrades down the ladder pre-boot; the smp-mode
//   event reports time-sliced execution and the guest still boots.
//
// Phase D — spawn failure under smp_workers: true is loud: emulator-error
//   carries the spawn error, no smp-mode event fires (init aborts).
//
// Phase E — capability failure under smp_workers: true throws
//   SYNCHRONOUSLY from the constructor, naming the conflict.
//
// Missing artifacts/images skip the corresponding phases (repo pattern).

import url from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";
import { install_node_web_worker } from "../node_web_worker.js";
import {
    ctl_base_for, command_read, CTL_COMMAND_PARKED_ACK,
} from "../../src/browser/smpctl.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = __dirname + "/../..";

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

// phases A/B/D produce EXPECTED emulator errors; anything else still fails
let expected_rejection = null;
process.on("unhandledRejection", exn =>
{
    if(expected_rejection && expected_rejection.test(String(exn && exn.message)))
    {
        return;
    }
    throw exn;
});

const multimem_wasm = root_path +
    (TEST_RELEASE_BUILD ? "/build/v86-multimem.wasm" : "/build/v86-multimem-debug.wasm");
if(!fs.existsSync(multimem_wasm))
{
    console.log("Missing " + multimem_wasm + ", test skipped");
    process.exit(0);
}

install_node_web_worker();

const WORKER_URL = new URL("../../src/browser/vcpu_worker.js", import.meta.url);
const TIMEOUT_FACTOR = +process.env.TIMEOUT_EXTRA_FACTOR || 1;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function wait_for(label, predicate, seconds)
{
    const deadline = Date.now() + seconds * TIMEOUT_FACTOR * 1000;
    while(!predicate())
    {
        assert(Date.now() < deadline, "timeout: " + label);
        await sleep(50);
    }
}

const ALPINE_OPTIONS = () => ({
    bios: { url: root_path + "/bios/seabios.bin" },
    vga_bios: { url: root_path + "/bios/vgabios.bin" },
    autostart: true,
    memory_size: 512 * 1024 * 1024,
    acpi: true,
    cpus: 2,
    smp_worker_url: WORKER_URL,
    log_level: 0,
    bzimage_initrd_from_filesystem: true,
    cmdline: [
        "rw", "root=host9p", "rootfstype=9p",
        "rootflags=trans=virtio,cache=loose", "modules=virtio_pci",
        "console=ttyS0,115200", "tsc=reliable", "init=/bin/sh",
    ].join(" "),
    filesystem: {
        basefs: root_path + "/images/alpine-virtio-gpu-codex-fs.json",
        baseurl: root_path + "/images/alpine-virtio-gpu-codex-rootfs-flat/",
    },
    disable_jit: +process.env.DISABLE_JIT,
});

function collect(emulator)
{
    const seen = { serial: "", errors: [], smp_mode: null, stopped: false };
    emulator.add_listener("serial0-output-byte",
        byte => { seen.serial += String.fromCharCode(byte); });
    emulator.add_listener("emulator-error", e => { seen.errors.push(e); });
    emulator.add_listener("smp-mode", mode => { seen.smp_mode = mode; });
    emulator.add_listener("emulator-stopped", () => { seen.stopped = true; });
    return seen;
}

async function wait_for_shell(emulator, seen, label, seconds)
{
    const poller = setInterval(() => emulator.serial0_send("\necho v86-read''y\n"), 5000);
    try
    {
        await wait_for(label, () => /^v86-ready\r?$/m.test(seen.serial), seconds);
    }
    finally
    {
        clearInterval(poller);
    }
}

// ---- Phase A: mid-run kill, topology (b) ----

async function phase_a()
{
    if(!fs.existsSync(root_path + "/images/alpine-virtio-gpu-codex-fs.json"))
    {
        console.log("Missing Alpine fixture, phase A skipped");
        return;
    }
    const emulator = new V86(Object.assign(ALPINE_OPTIONS(), {
        smp_workers: true,
        smp_worker_topology: "percpu",
    }));
    const seen = collect(emulator);
    await wait_for_shell(emulator, seen, "phase A boot", 420);
    assert.equal(seen.smp_mode["execution"], "workers", "phase A runs on workers");
    assert.equal(seen.smp_mode["topology"], "percpu");
    assert.equal(seen.smp_mode["memory_model"], "relaxed", "default memory model");

    // guest under load on both vCPUs, then kill vCPU 1's worker mid-run
    emulator.serial0_send("( while true; do :; done ) & ( while true; do :; done ) &\n");
    await sleep(1000);
    expected_rejection = /vcpu worker exited|vcpu worker error/;
    const host = emulator.smp_worker_host;
    assert(host && host.channels && host.channels.length === 2, "per-vCPU host with 2 channels");
    host.channels[1].terminate();

    await wait_for("emulator-error after the kill", () => seen.errors.length > 0, 60);
    const error = seen.errors[0];
    assert(error instanceof Error, "emulator-error carries an Error");
    assert(/vcpu worker exited with code/.test(error.message),
        "descriptive message, got: " + error.message);
    await wait_for("machine stopped", () => seen.stopped && !emulator.is_running(), 60);
    // the SURVIVING worker must park at its next slice boundary: fail()
    // posts PARK_REQ, which the worker CAS-acks to PARKED_ACK in its
    // command word (run_state_pub keeps publishing the GUEST's state)
    const cpu = emulator.v86.cpu;
    const i32 = new Int32Array(cpu.guest_memory.buffer);
    const ctl_base = ctl_base_for(cpu.memory_size[0]);
    await wait_for("survivor parked", () =>
        command_read(i32, ctl_base, 0) === CTL_COMMAND_PARKED_ACK, 60);
    // no hang: teardown completes
    await emulator.destroy();
    expected_rejection = null;
    console.log("phase A (percpu): mid-run worker kill -> emulator-error " +
        "(\"" + error.message.split("\n")[0] + "\"), survivor parked, " +
        "machine stopped, clean destroy");
}

// ---- Phase B: mid-run kill, topology (c) ----

async function phase_b()
{
    if(!fs.existsSync(root_path + "/images/linux4.iso"))
    {
        console.log("Missing images/linux4.iso, phase B skipped");
        return;
    }
    const emulator = new V86({
        bios: { url: root_path + "/bios/seabios.bin" },
        vga_bios: { url: root_path + "/bios/vgabios.bin" },
        cdrom: { url: root_path + "/images/linux4.iso", async: false },
        autostart: true,
        smp_workers: true,
        smp_worker_url: WORKER_URL,
        log_level: 0,
        disable_jit: +process.env.DISABLE_JIT,
    });
    const seen = collect(emulator);
    await wait_for("phase B boot marker", () =>
        seen.serial.includes("Files send via emulator appear in"), 300);
    assert.equal(seen.smp_mode["topology"], "machine", "phase B runs the machine worker");

    expected_rejection = /vcpu worker exited|vcpu worker error/;
    emulator.smp_worker_host.channel.terminate();
    await wait_for("emulator-error after the kill", () => seen.errors.length > 0, 60);
    assert(/vcpu worker exited with code/.test(seen.errors[0].message),
        "descriptive message, got: " + seen.errors[0].message);
    await wait_for("machine stopped", () => seen.stopped && !emulator.is_running(), 60);
    await emulator.destroy();
    expected_rejection = null;
    console.log("phase B (machine): mid-run worker kill -> emulator-error, " +
        "machine stopped, clean destroy");
}

// ---- Phase C: spawn failure degrades under "auto" ----

async function phase_c()
{
    if(!fs.existsSync(root_path + "/images/alpine-virtio-gpu-codex-fs.json"))
    {
        console.log("Missing Alpine fixture, phase C skipped");
        return;
    }
    const emulator = new V86(Object.assign(ALPINE_OPTIONS(), {
        smp_workers: "auto",
        smp_worker_url: root_path + "/nonexistent/vcpu_worker.js",
    }));
    const seen = collect(emulator);
    await wait_for("smp-mode after degradation", () => seen.smp_mode !== null, 120);
    assert.equal(seen.smp_mode["execution"], "time-sliced",
        "spawn failure must degrade to time-sliced under \"auto\"");
    assert.equal(seen.smp_mode["topology"], null, "no worker topology after degradation");
    assert.equal(seen.smp_mode["memory_model"], null, "memory_model reported null off-workers");
    assert.equal(seen.smp_mode["cpus_effective"], 2, "still 2 time-sliced vCPUs");
    assert.equal(seen.errors.length, 0, "\"auto\" degradation is not an error");
    // the machine must actually boot time-sliced after the degradation
    await wait_for_shell(emulator, seen, "phase C time-sliced boot", 420);
    await emulator.destroy();
    console.log("phase C: bad smp_worker_url under \"auto\" degraded to " +
        "time-sliced (smp-mode reflects it) and the guest booted");
}

// ---- Phase D: spawn failure under `true` is loud ----

async function phase_d()
{
    if(!fs.existsSync(root_path + "/images/alpine-virtio-gpu-codex-fs.json"))
    {
        console.log("Missing Alpine fixture, phase D skipped");
        return;
    }
    expected_rejection = /Cannot find module|vcpu worker|spawn/;
    const emulator = new V86(Object.assign(ALPINE_OPTIONS(), {
        smp_workers: true,
        smp_worker_url: root_path + "/nonexistent/vcpu_worker.js",
    }));
    const seen = collect(emulator);
    await wait_for("emulator-error from the failed spawn", () => seen.errors.length > 0, 120);
    assert(/Cannot find module|vcpu worker|spawn/.test(seen.errors[0].message),
        "spawn error surfaced, got: " + seen.errors[0].message);
    assert.equal(seen.smp_mode, null, "init aborts before smp-mode under `true`");
    await emulator.destroy();
    expected_rejection = null;
    console.log("phase D: spawn failure under smp_workers: true -> loud " +
        "emulator-error (\"" + seen.errors[0].message.split("\n")[0] + "\"), no smp-mode");
}

// ---- Phase E: capability conflict throws synchronously ----

function phase_e()
{
    assert.throws(
        () => new V86({
            smp_workers: true,
            guest_memory_shared: false,
            memory_size: 32 * 1024 * 1024,
        }),
        /guest_memory_shared: false conflicts/,
        "capability failure under `true` must throw from the constructor");
    console.log("phase E: smp_workers: true + guest_memory_shared: false " +
        "throws synchronously from the constructor");
}

const watchdog = setTimeout(() =>
{
    throw new Error("worker-failure: global 1500s timeout");
}, 1500_000 * TIMEOUT_FACTOR);

await phase_a();
await phase_b();
await phase_c();
await phase_d();
phase_e();
clearTimeout(watchdog);
console.log("Tests passed");
process.exit(0);
