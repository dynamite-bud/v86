#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root = path.resolve(__dirname, "../..");
const filesystem_json = path.join(root, "images/alpine-virtio-gpu-codex-fs.json");
const filesystem_flat = path.join(root, "images/alpine-virtio-gpu-codex-rootfs-flat");

assert(fs.existsSync(filesystem_json) && fs.existsSync(filesystem_flat),
    "Build the pinned Alpine 3.24 appliance with make virtio-gpu-codex-image first");

process.on("unhandledRejection", error => { throw error; });
const { V86 } = await import("../../src/main.js");
V86.prototype.zstd_decompress_worker = async function(decompressed_size, source)
{
    return this.zstd_decompress(decompressed_size, source);
};

const emulator = new V86({
    bios: { url: path.join(root, "bios/seabios.bin") },
    vga_bios: { url: path.join(root, "bios/vgabios.bin") },
    autostart: true,
    memory_size: 512 * 1024 * 1024,
    acpi: true,
    log_level: 0,
    bzimage_initrd_from_filesystem: true,
    cmdline: [
        "rw",
        "root=host9p",
        "rootfstype=9p",
        "rootflags=trans=virtio,cache=loose",
        "console=ttyS0,115200",
        "modules=virtio_pci",
        "tsc=reliable",
        "audit=0",
        "v86_relay=unconfigured",
        "v86_gpu_capset_probe=1",
    ].join(" "),
    filesystem: {
        baseurl: filesystem_flat + "/",
        basefs: filesystem_json,
        total_size: 2 * 1024 * 1024 * 1024,
    },
    virtio_gpu: {
        backend: "memory",
        width: 1024,
        height: 768,
        experimental_3d_capset_probe: true,
    },
});

let serial = "";
let finished = false;
const timeout = setTimeout(() =>
{
    finished = true;
    emulator.destroy();
    assert.fail("Timed out waiting for Linux capset-7 probe. Serial output:\n" + serial);
}, 120 * (+process.env.TIMEOUT_EXTRA_FACTOR || 1) * 1000);

emulator.add_listener("serial0-output-byte", byte =>
{
    if(finished)
    {
        return;
    }

    const character = String.fromCharCode(byte);
    process.stdout.write(character);
    serial += character;

    if(serial.includes("V86_APPLIANCE_READY=FAIL") ||
       serial.includes("V86_GPU_CAPSET7_GET_CAPS=FAIL") ||
       serial.includes("V86_GPU_CAPSET7_CONTEXT_INIT=FAIL"))
    {
        finished = true;
        clearTimeout(timeout);
        emulator.destroy();
        assert.fail("Linux capset-7 probe failed. Serial output:\n" + serial);
    }

    if(serial.includes("V86_GPU_CAPSET7_PROBE_END"))
    {
        finished = true;
        clearTimeout(timeout);
        assert.match(serial, /V86_APPLIANCE_KERNEL=6\.18\.44-0-lts/);
        assert.match(serial,
            /V86_GPU_CAPSET7_GET_CAPS=PASS magic=0x57363856 size=912/);
        assert.match(serial, /V86_GPU_CAPSET7_CONTEXT_INIT=PASS capset=7/);
        const commands = emulator.virtio_gpu_get_stats().command_counts;
        assert((commands["0x108"] || 0) >= 1,
            "Linux did not enumerate capset index 0");
        assert((commands["0x109"] || 0) >= 1,
            "Linux did not fetch capset ID 7");
        assert((commands["0x200"] || 0) >= 1,
            "Linux did not emit CTX_CREATE for capset ID 7");
        emulator.destroy();
        console.log("\nVirtIO GPU Linux/libdrm capset-7 probe passed");
    }
});
