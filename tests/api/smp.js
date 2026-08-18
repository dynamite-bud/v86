#!/usr/bin/env node
// Time-sliced SMP (XWAH-9): boot with cpus: 2 and assert that Linux brings
// up and schedules on both CPUs (kernel smp bring-up line + nproc over
// serial). images/buildroot-bzimage68.bin is a UP kernel (no CONFIG_SMP),
// so this boots the SMP-capable Alpine linux-lts kernel from the
// virtio-gpu codex filesystem image and skips when it is missing.

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
}, 180 * (+process.env.TIMEOUT_EXTRA_FACTOR || 1) * 1000);

let serial = "";
let answered = false;

// Poll a marker echo until the init shell answers; the quoted split keeps
// the echoed input line from matching the pattern only the output satisfies
const poller = setInterval(() =>
{
    emulator.serial0_send("\necho v86-read''y\n");
}, 5000);

emulator.add_listener("serial0-output-byte", function(byte)
{
    serial += String.fromCharCode(byte);

    if(byte !== 0x0A)
    {
        return;
    }

    if(!answered && /^v86-ready\r?$/m.test(serial))
    {
        answered = true;
        clearInterval(poller);
        emulator.serial0_send("echo NPROC''=$(nproc)\n");
        return;
    }

    const nproc = serial.match(/^NPROC=(\d+)\r?$/m);
    if(nproc)
    {
        const brought_up = serial.match(/smp: Brought up \d+ nodes?, (\d+) CPUs?/);
        assert(brought_up, "kernel smp bring-up line missing. Serial output:\n" + serial);
        assert.equal(+brought_up[1], CPUS, "kernel smp bring-up count");
        assert.equal(+nproc[1], CPUS, "nproc");
        console.log("Test passed: %s; nproc=%d", brought_up[0], +nproc[1]);
        clearTimeout(timeout);
        emulator.destroy();
    }
});
