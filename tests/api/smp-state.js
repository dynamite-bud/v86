#!/usr/bin/env node
// Time-sliced SMP save/restore (XWAH-9 stage 5): boot with cpus: 2, save a
// running SMP machine, keep it running, restore the snapshot and assert the
// machine still runs with both CPUs (serial responsive, nproc == 2). Also
// assert that state images and machines with mismatched cpus settings
// fail fast in either direction, without harming the running machine.
// Boots the SMP-capable Alpine linux-lts kernel from the virtio-gpu codex
// filesystem image (see smp.js) and skips when it is missing.

import url from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";
import { install_node_web_worker } from "../node_web_worker.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const root_path = __dirname + "/../..";

process.on("unhandledRejection", exn => { throw exn; });

if(!fs.existsSync(root_path + "/images/alpine-virtio-gpu-codex-fs.json"))
{
    console.log("Missing images/alpine-virtio-gpu-codex-fs.json, test skipped");
    process.exit(0);
}

install_node_web_worker();

const CPUS = 2;

const emulator = new V86({
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
});

const timeout = setTimeout(() =>
{
    console.log(serial);
    throw new Error("Timeout");
}, 300 * (+process.env.TIMEOUT_EXTRA_FACTOR || 1) * 1000);

let serial = "";
const waiters = [];

emulator.add_listener("serial0-output-byte", function(byte)
{
    serial += String.fromCharCode(byte);

    if(byte !== 0x0A)
    {
        return;
    }

    for(let i = waiters.length - 1; i >= 0; i--)
    {
        const match = serial.match(waiters[i].pattern);
        if(match)
        {
            const [waiter] = waiters.splice(i, 1);
            waiter.resolve(match);
        }
    }
});

function wait_serial(pattern)
{
    return new Promise(resolve =>
    {
        const match = serial.match(pattern);
        if(match)
        {
            resolve(match);
            return;
        }
        waiters.push({ pattern, resolve });
    });
}

// Repeat a marker echo until the init shell answers: input typed before the
// shell listens (or swallowed by a snapshot restore) is lost. The quoted
// split keeps the echoed input line from matching the pattern only the
// output satisfies.
async function wait_shell_responsive(marker)
{
    const pattern = new RegExp("^" + marker + "\r?$", "m");
    const poller = setInterval(
        () => emulator.serial0_send("\necho " + marker.slice(0, -1) + "''" + marker.slice(-1) + "\n"),
        5000);
    emulator.serial0_send("\necho " + marker.slice(0, -1) + "''" + marker.slice(-1) + "\n");
    await wait_serial(pattern);
    clearInterval(poller);
}

async function assert_nproc(tag)
{
    emulator.serial0_send("echo NPROC" + tag + "''=$(nproc)\n");
    const match = await wait_serial(new RegExp("^NPROC" + tag + "=(\\d+)\r?$", "m"));
    assert.equal(+match[1], CPUS, "nproc (" + tag + ")");
}

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// full SMP bring-up: shell answers and both CPUs are schedulable
await wait_shell_responsive("v86-ready");
const brought_up = serial.match(/smp: Brought up \d+ nodes?, (\d+) CPUs?/);
assert(brought_up, "kernel smp bring-up line missing. Serial output:\n" + serial);
assert.equal(+brought_up[1], CPUS, "kernel smp bring-up count");
await assert_nproc("A");

console.log("Saving the running SMP machine");
const state = await emulator.save_state();

// keep running so the restore rolls the machine visibly back
await sleep(2000);

console.log("Restoring the SMP snapshot");
await emulator.restore_state(state);

await wait_shell_responsive("v86-restored");
await assert_nproc("B");
console.log("Roundtrip passed: machine runs with nproc=%d after restore", CPUS);

// A cpus=1 state image must be rejected before any mutation. Whichever
// pre-validation error fires first (the apic blob check accepts a
// single-LAPIC image, so today it is the missing-vcpu-contexts check) —
// the machine must stay unharmed.
const single = new V86({
    bios: { url: root_path + "/bios/seabios.bin" },
    vga_bios: { url: root_path + "/bios/vgabios.bin" },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    acpi: true,
    cpus: 1,
    log_level: 0,
});
await sleep(3000);
const single_state = await single.save_state();

await assert.rejects(
    emulator.restore_state(single_state),
    err => /vcpu contexts|apic state/.test(err.message),
    "cpus=1 image into cpus=2 machine");
console.log("cpus=1 image into cpus=2 machine rejected cleanly");

await wait_shell_responsive("v86-unharmed");
await assert_nproc("C");
console.log("cpus=2 machine unharmed after the rejected restore");

// and the reverse direction: a cpus=2 image into a cpus=1 machine (here
// the apic blob length check fires first)
await assert.rejects(
    single.restore_state(state),
    err => /apic state|saved with cpus/.test(err.message),
    "cpus=2 image into cpus=1 machine");
console.log("cpus=2 image into cpus=1 machine rejected cleanly");

console.log("Test passed");
clearTimeout(timeout);
single.destroy();
emulator.destroy();
