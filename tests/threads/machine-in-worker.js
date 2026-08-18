#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W2 gate (docs/smp-phase4-design.md §9 W2): the whole
// machine boots fully inside ONE worker (topology (c)) while the main
// thread serves devices — src/browser/vcpu_worker.js machine mode +
// src/browser/smp_worker_host.js, through the public V86 API with
// smp_workers: true.
//
// Phase A — linux4.iso, cpus: 1 (no acpi: the PIT/PIC leg): boots to the
//   text-mode prompt (every VGA text write is an mmap RPC), the serial boot
//   marker arrives, and a keyboard line typed from the main thread (PS2 irq1
//   through the device-IRQ ring) echoes on the screen.
//
// Phase B — the Alpine SMP fixture, cpus: 2, acpi (the IOAPIC/LAPIC leg,
//   main_loop_smp inside the worker): serial shell answers (serial
//   round-trip), kernel smp bring-up + nproc == 2; then the two Layer C
//   items the stage owns:
//   - item 3, mailbox under load: the guest floods its serial port with
//     40000 bytes (one blocking OUT RPC each) and every byte must arrive —
//     sustained PIO hammering with a data-integrity assertion;
//   - item 4, hlt/wake races: 100k doorbell posts against the hlt-looping
//     idle guest (spurious wakes by design), interleaved with real serial
//     input, then a serial round-trip proves the machine still schedules.
//
// Missing artifacts/images skip cleanly (the repo pattern).

import url from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";
import { install_node_web_worker } from "../node_web_worker.js";
import { ctl_base_for, doorbell_post, heartbeat_read } from "../../src/browser/smpctl.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = __dirname + "/../..";

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

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

function fail_timeout(label, seconds, dump)
{
    return setTimeout(() =>
    {
        dump && dump();
        throw new Error("Timeout: " + label);
    }, seconds * TIMEOUT_FACTOR * 1000);
}

// ---- Phase A: linux4.iso, cpus: 1, PIT/PIC leg ----

async function phase_a()
{
    if(!fs.existsSync(root_path + "/images/linux4.iso"))
    {
        console.log("Missing images/linux4.iso, phase A skipped");
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

    let smp_mode = null;
    emulator.add_listener("smp-mode", mode => { smp_mode = mode; });
    emulator.add_listener("emulator-error", e => { throw e; });

    // text-mode screen mirror, the tests/full/run.js pattern
    const screen = [];
    emulator.add_listener("screen-put-char", chr =>
    {
        const [row, col, code] = chr;
        (screen[row] || (screen[row] = []))[col] = String.fromCharCode(code);
    });
    const screen_text = () => screen.map(row => (row || []).join("")).join("\n");

    let serial = "";
    emulator.add_listener("serial0-output-byte", byte =>
    {
        serial += String.fromCharCode(byte);
    });

    const timeout = fail_timeout("phase A", 300, () =>
    {
        console.log("--- screen ---\n" + screen_text());
        console.log("--- serial ---\n" + serial);
        // self-diagnosis for an intermittent blank-VGA state: dump the
        // device host's vga model state and scan its text RAM so a failure
        // discriminates lost text writes / CRTC desync / a stuck mode
        const vga = emulator.v86.cpu.devices.vga;
        console.log("--- vga ---",
            "graphical_mode=" + vga.graphical_mode,
            "svga_enabled=" + vga.svga_enabled,
            "start_address=" + vga.start_address,
            "max_rows=" + vga.max_rows,
            "max_cols=" + vga.max_cols,
            "offset_register=" + vga.offset_register,
            "cursor=" + vga.cursor_address);
        const runs = [];
        let run = "";
        let run_start = 0;
        for(let i = 0; i < 0x8000; i += 2)
        {
            const c = vga.vga_memory[i];
            if(c >= 0x21 && c < 0x7F)
            {
                if(!run)
                {
                    run_start = i >> 1;
                }
                run += String.fromCharCode(c);
            }
            else if(run)
            {
                if(run.length >= 4)
                {
                    runs.push(run_start + ":" + run);
                }
                run = "";
            }
        }
        console.log("--- vga text runs ---\n" + runs.slice(0, 40).join(" | "));
        // the visible window as the model sees it (start_address-relative)
        const window_rows = [];
        for(let row = 0; row < vga.max_rows; row++)
        {
            let line = "";
            for(let col = 0; col < vga.max_cols; col++)
            {
                const c = vga.vga_memory[(vga.start_address + row * vga.max_cols + col) << 1];
                line += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : ".";
            }
            window_rows.push(line);
        }
        console.log("--- vga visible window ---\n" + window_rows.join("\n"));
        // if the lost text sits in the shared guest RAM BEHIND the MMIO
        // hole, the worker wrote the B8000 page as plain RAM (TLB/JIT bug)
        const ram = emulator.v86.cpu.mem8;
        const ram_runs = [];
        let ram_run = "";
        let ram_start = 0;
        for(let i = 0xB8000; i < 0xC0000; i += 2)
        {
            const c = ram[i];
            if(c >= 0x21 && c < 0x7F)
            {
                if(!ram_run)
                {
                    ram_start = i - 0xB8000 >> 1;
                }
                ram_run += String.fromCharCode(c);
            }
            else if(ram_run)
            {
                if(ram_run.length >= 4)
                {
                    ram_runs.push(ram_start + ":" + ram_run);
                }
                ram_run = "";
            }
        }
        console.log("--- guest RAM behind B8000 (should be empty) ---\n" +
            ram_runs.slice(0, 40).join(" | "));
    });

    const wait_for = async predicate =>
    {
        while(!predicate())
        {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    };
    const wait_for_screen = predicate => wait_for(() => predicate(screen_text()));

    await wait_for_screen(text => text.includes("~%"));
    assert(smp_mode, "smp-mode event must fire at init-complete");
    assert.equal(smp_mode["execution"], "workers", "execution mode");
    assert.equal(smp_mode["cpus_effective"], 1, "cpus_effective");
    assert.equal(smp_mode["guest_memory"]["backend"], "imported", "guest memory backend");
    assert.equal(smp_mode["guest_memory"]["shared"], true, "guest memory shared");
    assert.deepEqual(emulator.smp_mode, smp_mode, "smp_mode property matches the event");
    // the serial marker races the screen prompt by a few lines: poll it too
    await wait_for(() => serial.includes("Files send via emulator appear in"));

    // input delivery: a keyboard line from the main thread reaches the
    // guest through the device-IRQ ring and echoes on screen. The guest's
    // AT-keyboard driver binds asynchronously ~0.4 s AFTER the shell
    // prompt appears (registration order with the mouse varies run to
    // run), so keystrokes typed at first prompt can be dropped by the
    // still-binding input stack (real-i8042-realistic). The retry loop
    // absorbs that window; the typed line is quote-free so a lost byte can
    // never wedge the shell in a continuation prompt.
    let typed_attempts = 0;
    while(!screen_text().includes("w2input-ok"))
    {
        assert(typed_attempts++ < 15, "keyboard input must echo on the screen");
        // the leading newline clears any partially-delivered line
        await emulator.keyboard_send_text("\necho w2input-ok\n", 40);
        const retry_deadline = Date.now() + 15_000;
        while(Date.now() < retry_deadline && !screen_text().includes("w2input-ok"))
        {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    clearTimeout(timeout);
    await emulator.destroy();
    console.log("phase A (linux4.iso, cpus 1): boot + serial marker + keyboard echo OK");
}

// ---- Phase B: Alpine fixture, cpus: 2, acpi, main_loop_smp in the worker ----

async function phase_b()
{
    if(!fs.existsSync(root_path + "/images/alpine-virtio-gpu-codex-fs.json"))
    {
        console.log("Missing images/alpine-virtio-gpu-codex-fs.json, phase B skipped");
        return;
    }

    const CPUS = 2;
    const emulator = new V86({
        bios: { url: root_path + "/bios/seabios.bin" },
        vga_bios: { url: root_path + "/bios/vgabios.bin" },
        autostart: true,
        memory_size: 512 * 1024 * 1024,
        acpi: true,
        cpus: CPUS,
        smp_workers: true,
        // pin topology (c): this is the Stage W2 gate (main_loop_smp
        // inside ONE machine worker); the W3 default for cpus > 1 is
        // topology (b), gated by tests/threads/vcpu-workers-smp.js
        smp_worker_topology: "machine",
        smp_worker_url: WORKER_URL,
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

    let smp_mode = null;
    emulator.add_listener("smp-mode", mode => { smp_mode = mode; });
    emulator.add_listener("emulator-error", e => { throw e; });

    let serial = "";
    const serial_watchers = [];
    emulator.add_listener("serial0-output-byte", byte =>
    {
        serial += String.fromCharCode(byte);
        if(byte === 0x0A)
        {
            for(let i = serial_watchers.length - 1; i >= 0; i--)
            {
                if(serial_watchers[i]())
                {
                    serial_watchers.splice(i, 1);
                }
            }
        }
    });
    // resolves when `predicate(serial)` first holds at a line boundary
    const wait_for_serial = predicate => new Promise(resolve =>
    {
        const check = () =>
        {
            if(predicate(serial))
            {
                resolve();
                return true;
            }
            return false;
        };
        if(!check())
        {
            serial_watchers.push(check);
        }
    });

    const timeout = fail_timeout("phase B", 420, () => console.log(serial));

    // poll a marker until the init shell answers (the smp.js pattern)
    const poller = setInterval(() => emulator.serial0_send("\necho v86-read''y\n"), 5000);
    await wait_for_serial(s => /^v86-ready\r?$/m.test(s));
    clearInterval(poller);

    assert(smp_mode, "smp-mode event must fire");
    assert.equal(smp_mode["execution"], "workers", "execution mode");
    assert.equal(smp_mode["cpus_effective"], CPUS, "cpus_effective");

    emulator.serial0_send("echo NPROC''=$(nproc)\n");
    await wait_for_serial(s => /^NPROC=\d+\r?$/m.test(s));
    const nproc = serial.match(/^NPROC=(\d+)\r?$/m);
    const brought_up = serial.match(/smp: Brought up \d+ nodes?, (\d+) CPUs?/);
    assert(brought_up, "kernel smp bring-up line missing. Serial output:\n" + serial);
    assert.equal(+brought_up[1], CPUS, "kernel smp bring-up count");
    assert.equal(+nproc[1], CPUS, "nproc");
    console.log("phase B boot: %s; nproc=%d", brought_up[0], +nproc[1]);

    // Layer C item 3 — mailbox under load: 40000 serial bytes, each one a
    // blocking OUT RPC from the worker, all of which must arrive intact.
    const HAMMER_BYTES = 40_000;
    emulator.serial0_send("echo H''S; dd if=/dev/zero bs=1000 count=40 2>/dev/null" +
        " | tr '\\0' 'y' > /dev/ttyS0; echo; echo H''E\n");
    await wait_for_serial(s => /^HE\r?$/m.test(s));
    const start_index = serial.search(/^HS\r?$/m);
    const end_index = serial.search(/^HE\r?$/m);
    assert(start_index >= 0 && end_index > start_index, "hammer markers");
    const flooded = serial.slice(start_index, end_index);
    const received = (flooded.match(/y/g) || []).length;
    assert.equal(received, HAMMER_BYTES,
        `every hammered PIO byte must arrive (${received}/${HAMMER_BYTES})`);
    console.log(`phase B mailbox under load: ${received} serial OUT RPCs intact`);

    // Layer C item 4 — hlt/wake races: 100k doorbell posts against the
    // idle (hlt-looping) guest. Every post is a legitimate spurious wake;
    // the worker re-derives from the shared cells each time. Interleave
    // real serial input to race wakes against IRQ delivery, then prove the
    // machine still runs with a round-trip.
    const cpu = emulator.v86.cpu;
    const i32 = new Int32Array(cpu.guest_memory.buffer);
    const ctl_base = ctl_base_for(cpu.memory_size[0]);
    const heartbeat_before = heartbeat_read(i32, ctl_base, 0);
    const POSTS = 100_000;
    const CHUNK = 1000;
    for(let posted = 0; posted < POSTS; posted += CHUNK)
    {
        for(let i = 0; i < CHUNK; i++)
        {
            doorbell_post(i32, ctl_base, 0);
        }
        if(posted % 10_000 === 0)
        {
            emulator.serial0_send("\n");
        }
        // let the mailbox service loop and device ticks breathe
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    const heartbeat_after = heartbeat_read(i32, ctl_base, 0);
    assert(heartbeat_after > heartbeat_before,
        `doorbell storm must produce wakes (heartbeat ${heartbeat_before} -> ${heartbeat_after})`);
    emulator.serial0_send("echo AL''IVE-AFTER-STORM\n");
    await wait_for_serial(s => /^ALIVE-AFTER-STORM\r?$/m.test(s));
    console.log(`phase B hlt/wake storm: ${POSTS} posts, ` +
        `${heartbeat_after - heartbeat_before} wakes, machine responsive`);

    clearTimeout(timeout);
    await emulator.destroy();
}

await phase_a();
await phase_b();
console.log("Tests passed");
process.exit(0);
