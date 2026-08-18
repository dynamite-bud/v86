#!/usr/bin/env node
// XWAH-9 Phase 3 Stage 5 (docs/smp-phase3-design.md §4): boot real guests
// through the public V86 API with guest_memory_backend: "imported" — guest
// RAM as an imported WebAssembly.Memory, reached via gram.wasm accessors and
// memidx-1 JIT code.
//
// Phases:
//   1. Linux 4 (linux4.iso) to a shell with guest_memory_shared: false
//      (plain ArrayBuffer backing, gram.wasm)
//   2. the same with guest_memory_shared: true + acpi (SharedArrayBuffer
//      backing, gram-shared.wasm), plus the read_memory copy contract
//   Both assert the imported-memory plumbing and a save/restore roundtrip.
//   3. cpus: 2 over the imported+shared backend: the SMP-capable Alpine
//      kernel must bring up and schedule on both CPUs (nproc over serial),
//      proving the time-sliced SMP scheduler works unchanged over imported
//      guest RAM. Runs only when the Alpine filesystem image is present.
//
// Skips cleanly when the multimem artifacts are missing (the repo's
// established missing-artifact pattern).

import url from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = __dirname + "/../..";

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const TIMEOUT_FACTOR = +process.env.TIMEOUT_EXTRA_FACTOR || 1;

for(const artifact of [
    TEST_RELEASE_BUILD ? "build/v86-multimem.wasm" : "build/v86-multimem-debug.wasm",
    "build/gram.wasm",
    "build/gram-shared.wasm",
    "images/linux4.iso",
])
{
    if(!fs.existsSync(root_path + "/" + artifact))
    {
        console.log("Missing " + artifact + ", test skipped");
        process.exit(0);
    }
}

const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const MEMORY_SIZE = 64 * 1024 * 1024;
const WASM_PAGE = 64 * 1024;

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function watchdog(name, seconds)
{
    return setTimeout(() =>
    {
        throw new Error("Timeout in phase: " + name);
    }, seconds * TIMEOUT_FACTOR * 1000);
}

async function run_linux4(shared)
{
    const name = `linux4 shared:${shared}`;
    console.log("Starting: %s", name);
    const timeout = watchdog(name, 300);

    const emulator = new V86({
        bios: { url: root_path + "/bios/seabios.bin" },
        vga_bios: { url: root_path + "/bios/vgabios.bin" },
        cdrom: { url: root_path + "/images/linux4.iso", async: false },
        autostart: true,
        memory_size: MEMORY_SIZE,
        // the shared phase also covers acpi over the imported backend
        acpi: shared,
        guest_memory_backend: "imported",
        guest_memory_shared: shared,
        disable_jit: +process.env.DISABLE_JIT,
        log_level: 0,
    });

    await new Promise(resolve => emulator.add_listener("emulator-started", resolve));
    await emulator.wait_until_vga_screen_contains("~% ");

    const cpu = emulator.v86.cpu;

    // imported-memory plumbing: the multimem artifact is loaded and guest
    // RAM is the imported memory (one extra wasm page of JIT scratch),
    // backed as requested by the sub-option
    assert.ok(cpu.wm.exports["set_guest_memory_shared"], "multimem artifact loaded");
    assert.ok(cpu.guest_memory, "cpu wired to the imported guest memory");
    assert.equal(cpu.mem8.length, MEMORY_SIZE, "mem8 view spans guest RAM");
    assert.equal(cpu.mem8.buffer.byteLength, MEMORY_SIZE + WASM_PAGE,
        "guest memory is memory_size + one wasm page of JIT scratch");
    assert.equal(cpu.mem8.buffer instanceof SharedArrayBuffer, shared,
        "guest memory backing must match guest_memory_shared");
    assert.notEqual(cpu.mem8.buffer, cpu.wasm_memory.buffer,
        "guest RAM must not live in the instance memory");

    // read_memory contract (S4 copy-first shim): a copy under a shared
    // backing, contents equal to guest RAM either way
    const PROBE_ADDR = 0x7C00;
    const probe = emulator.read_memory(PROBE_ADDR, 64);
    assert.equal(probe.length, 64);
    assert.deepEqual(Array.from(probe), Array.from(cpu.mem8.subarray(PROBE_ADDR, PROBE_ADDR + 64)),
        "read_memory reads the imported guest RAM");
    if(shared)
    {
        assert.ok(!(probe.buffer instanceof SharedArrayBuffer),
            "read_memory must return a copy, not the live SAB view");
        const before = cpu.mem8[PROBE_ADDR];
        probe[0] = probe[0] ^ 0xFF;
        assert.equal(cpu.mem8[PROBE_ADDR], before,
            "mutating the returned copy must not write guest RAM");
    }

    // write_memory lands in the imported guest RAM
    const SCRATCH_ADDR = 0x2FF0000; // unused high RAM, far from the kernel
    emulator.write_memory([0xAA, 0x55, 0x12, 0xED], SCRATCH_ADDR);
    assert.deepEqual(Array.from(cpu.mem8.subarray(SCRATCH_ADDR, SCRATCH_ADDR + 4)),
        [0xAA, 0x55, 0x12, 0xED], "write_memory visible in the imported memory");

    // Zero-page-scan agreement: under the imported backend pack_memory
    // scans pages with a JS loop over the guest memory instead of the wasm
    // is_memory_zeroed export (whose per-8-byte gram accessor calls made a
    // save cross the instance boundary millions of times — cpu.js
    // pack_memory). Assert the two verdicts agree on a sample of pages
    // (a full sweep through the export is the very call storm the JS path
    // avoids); the roundtrip below then proves the packed image restores.
    await emulator.stop(); // don't race the running guest between the scans
    {
        const { bitmap } = cpu.pack_memory();
        const page_count = cpu.mem8.length >> 12;
        for(let page = 0; page < page_count; page += 61)
        {
            assert.equal(!bitmap.get(page), !!cpu.is_memory_zeroed(page << 12, 0x1000),
                "JS zero-page scan must agree with the wasm export at page " + page);
        }
    }
    emulator.run();

    // save/restore roundtrip over the imported backend
    console.log("Saving: %s", name);
    const state = await emulator.save_state();
    await sleep(500);
    console.log("Restoring: %s", name);
    await emulator.restore_state(state);
    await sleep(1000);

    emulator.keyboard_send_text("echo -n test; echo passed\n");
    let passed = false;
    for(let i = 0; i < 60 && !passed; i++)
    {
        await sleep(500);
        passed = emulator.screen_adapter.get_text_screen().some(line => line.startsWith("testpassed"));
    }
    if(!passed)
    {
        console.warn(emulator.screen_adapter.get_text_screen().map(line => line.replace(/\x00/g, " ")));
        throw new Error("Shell not alive after save/restore roundtrip: " + name);
    }

    console.log("Done: %s", name);
    clearTimeout(timeout);
    emulator.destroy();
}

async function run_smp()
{
    if(!fs.existsSync(root_path + "/images/alpine-virtio-gpu-codex-fs.json"))
    {
        console.log("Missing images/alpine-virtio-gpu-codex-fs.json, smp-over-imported phase skipped");
        return;
    }

    const { install_node_web_worker } = await import("../node_web_worker.js");
    install_node_web_worker();

    const CPUS = 2;
    const name = `alpine cpus:${CPUS} imported+shared`;
    console.log("Starting: %s", name);

    const emulator = new V86({
        bios: { url: root_path + "/bios/seabios.bin" },
        vga_bios: { url: root_path + "/bios/vgabios.bin" },
        autostart: true,
        memory_size: 512 * 1024 * 1024,
        acpi: true,
        cpus: CPUS,
        guest_memory_backend: "imported",
        guest_memory_shared: true,
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

    await new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(() =>
        {
            console.log(serial);
            reject(new Error("Timeout in phase: " + name));
        }, 300 * TIMEOUT_FACTOR * 1000);

        let serial = "";
        let answered = false;

        // Poll a marker echo until the init shell answers; the quoted split
        // keeps the echoed input from matching the pattern only the output
        // satisfies
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
                try
                {
                    const brought_up = serial.match(/smp: Brought up \d+ nodes?, (\d+) CPUs?/);
                    assert(brought_up, "kernel smp bring-up line missing. Serial output:\n" + serial);
                    assert.equal(+brought_up[1], CPUS, "kernel smp bring-up count");
                    assert.equal(+nproc[1], CPUS, "nproc");
                    assert.ok(emulator.v86.cpu.mem8.buffer instanceof SharedArrayBuffer,
                        "smp phase must run over the shared imported memory");
                    console.log("Done: %s (%s; nproc=%d)", name, brought_up[0], +nproc[1]);
                }
                catch(e)
                {
                    reject(e);
                    return;
                }
                clearTimeout(timeout);
                emulator.destroy();
                resolve();
            }
        });
    });
}

await run_linux4(false);
await run_linux4(true);
await run_smp();

console.log("Tests passed");
process.exit(0);
