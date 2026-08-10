#!/usr/bin/env node

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", error => { throw error; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
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
        "modules=virtio_pci,9p,9pnet,9pnet_virtio,virtio_gpu",
        "tsc=reliable",
        "audit=0",
        "drm_kms_helper.fbdev_emulation=0",
        "quiet",
    ].join(" "),
    filesystem: {
        baseurl: __dirname + "/../../images/alpine-virtio-gpu-rootfs-flat/",
        basefs: __dirname + "/../../images/alpine-virtio-gpu-fs.json",
    },
    virtio_gpu: { backend: "memory", width: 1024, height: 768 },
});

let serial = "";
let finished = false;
const timeout = setTimeout(() =>
{
    finished = true;
    emulator.destroy();
    assert.fail("Timed out waiting for Alpine virtio-gpu probe. Serial output:\n" + serial);
}, 90 * (+process.env.TIMEOUT_EXTRA_FACTOR || 1) * 1000);

emulator.add_listener("serial0-output-byte", function(byte)
{
    if(finished)
    {
        return;
    }

    const character = String.fromCharCode(byte);
    process.stdout.write(character);
    serial += character;

    if(serial.includes("Mounting root: failed") ||
       serial.includes("initramfs emergency recovery shell"))
    {
        finished = true;
        clearTimeout(timeout);
        emulator.destroy();
        assert.fail("Alpine root filesystem failed to mount. Serial output:\n" + serial);
    }

    if(serial.includes("V86_GPU_PROBE_STATUS=FAIL"))
    {
        finished = true;
        clearTimeout(timeout);
        emulator.destroy();
        assert.fail("Alpine virtio-gpu probe failed. Serial output:\n" + serial);
    }

    if(serial.includes("V86_GPU_PROBE_END"))
    {
        finished = true;
        clearTimeout(timeout);
        assert.match(serial, /V86_GPU_PROBE_KERNEL=6\.12\./);
        assert.match(serial, /1af4:1050/);
        assert.match(serial, /V86_GPU_PROBE_DRIVER=virtio\d+/);
        assert.match(serial, /V86_GPU_PROBE_STATUS=PASS/);
        emulator.destroy();
        console.log("\nvirtio-gpu Linux probe passed");
    }
});
