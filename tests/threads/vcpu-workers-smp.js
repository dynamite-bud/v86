#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W3 gate (docs/smp-phase4-design.md §9 W3): topology
// (b) end to end through the public V86 API — every vCPU in its own
// worker, real parallelism.
//
// Phase A — the Alpine SMP fixture, cpus: 2, topology "percpu" (the W3
//   default for cpus > 1): SeaBIOS brings up the AP CROSS-WORKER (the
//   BSP's INIT-SIPI-SIPI travels write_icr0_shared -> ipi_special latch ->
//   the AP worker's consume), Linux SMP bring-up succeeds, nproc == 2;
//   then the PARALLELISM SMOKE: a two-process CPU-bound workload's
//   wall-clock under (b), compared against the identical workload on the
//   identical machine under topology (c) (time-sliced in one worker) in
//   phase C — the informal preview of the W5 benchmark;
//   plus cross-worker hlt/wake (Layer C item 4): doorbell storms against
//   BOTH idle workers, then a serial round-trip.
//
// Phase B — cpus: 4: SeaBIOS brings up 3 APs cross-worker, nproc == 4.
//
// Phase C — the (c) reference run for the smoke (same guest, same
//   workload, cpus: 2, one machine worker).
//
// Missing artifacts/images skip cleanly (the repo pattern).

import url from "node:url";
import fs from "node:fs";
import assert from "node:assert/strict";
import { install_node_web_worker } from "../node_web_worker.js";
import {
    ctl_base_for, doorbell_post, heartbeat_read,
} from "../../src/browser/smpctl.js";

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
if(!fs.existsSync(root_path + "/images/alpine-virtio-gpu-codex-fs.json"))
{
    console.log("Missing images/alpine-virtio-gpu-codex-fs.json, test skipped");
    process.exit(0);
}

install_node_web_worker();

const WORKER_URL = new URL("../../src/browser/vcpu_worker.js", import.meta.url);
const TIMEOUT_FACTOR = +process.env.TIMEOUT_EXTRA_FACTOR || 1;

// the smoke workload: two background CPU-bound pipelines + wait, wall
// time measured on the host between the serial markers
const SMOKE_JOB = "dd if=/dev/zero bs=1M count=256 2>/dev/null | md5sum > /dev/null";
const SMOKE = `echo S''T; ( ${SMOKE_JOB} ) & ( ${SMOKE_JOB} ) & wait; echo S''P\n`;

function fail_timeout(label, seconds, dump)
{
    return setTimeout(() =>
    {
        dump && dump();
        throw new Error("Timeout: " + label);
    }, seconds * TIMEOUT_FACTOR * 1000);
}

function boot(cpus, topology)
{
    const emulator = new V86({
        bios: { url: root_path + "/bios/seabios.bin" },
        vga_bios: { url: root_path + "/bios/vgabios.bin" },
        autostart: true,
        memory_size: 512 * 1024 * 1024,
        acpi: true,
        cpus: cpus,
        smp_workers: true,
        smp_worker_topology: topology,
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

    const state = {
        emulator,
        serial: "",
        serial_times: [],
        smp_mode: null,
    };
    emulator.add_listener("smp-mode", mode => { state.smp_mode = mode; });
    emulator.add_listener("emulator-error", e => { throw e; });
    const watchers = [];
    emulator.add_listener("serial0-output-byte", byte =>
    {
        state.serial += String.fromCharCode(byte);
        state.serial_times.push(performance.now());
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
    // host receive time of the serial line first matching `re`
    state.line_time = re =>
    {
        const index = state.serial.search(re);
        assert(index >= 0, "marker " + re + " must be in the serial log");
        return state.serial_times[Math.min(index, state.serial_times.length - 1)];
    };
    return state;
}

async function wait_for_shell(state, label, seconds)
{
    const timeout = fail_timeout(label, seconds, () => console.log(state.serial));
    const poller = setInterval(
        () => state.emulator.serial0_send("\necho v86-read''y\n"), 5000);
    await state.wait_for_serial(s => /^v86-ready\r?$/m.test(s));
    clearInterval(poller);
    clearTimeout(timeout);
}

async function check_smp(state, cpus)
{
    state.emulator.serial0_send("echo NPROC''=$(nproc)\n");
    await state.wait_for_serial(s => /^NPROC=\d+\r?$/m.test(s));
    const nproc = state.serial.match(/^NPROC=(\d+)\r?$/m);
    const brought_up = state.serial.match(/smp: Brought up \d+ nodes?, (\d+) CPUs?/);
    assert(brought_up, "kernel smp bring-up line missing. Serial output:\n" + state.serial);
    assert.equal(+brought_up[1], cpus, "kernel smp bring-up count");
    assert.equal(+nproc[1], cpus, "nproc");
    return brought_up[0];
}

async function run_smoke(state, label)
{
    const timeout = fail_timeout("smoke " + label, 600, () => console.log(state.serial));
    state.emulator.serial0_send(SMOKE);
    await state.wait_for_serial(s => /^SP\r?$/m.test(s));
    clearTimeout(timeout);
    const wall_ms = state.line_time(/^SP\r?$/m) - state.line_time(/^ST\r?$/m);
    console.log(`${label}: 2-process CPU-bound smoke took ${(wall_ms / 1000).toFixed(2)} s`);
    return wall_ms;
}

// ---- Phase A: cpus 2, topology (b) ----

async function phase_a()
{
    const CPUS = 2;
    const state = boot(CPUS, "percpu");
    await wait_for_shell(state, "phase A boot", 420);

    assert(state.smp_mode, "smp-mode event must fire");
    assert.equal(state.smp_mode["execution"], "workers", "execution mode");
    assert.equal(state.smp_mode["topology"], "percpu", "topology (b)");
    assert.equal(state.smp_mode["cpus_effective"], CPUS, "cpus_effective");

    const brought_up = await check_smp(state, CPUS);
    // AP bring-up transcript evidence: the kernel's SMP boot line
    const smpboot = state.serial.match(/^.*Booting SMP configuration.*$/m);
    console.log("phase A boot (percpu): %s%s", brought_up,
        smpboot ? "; " + smpboot[0].trim() : "");

    // instruction counters flow from the published per-worker cells
    const insn_a = state.emulator.get_instruction_counter();
    await new Promise(resolve => setTimeout(resolve, 300));
    const insn_b = state.emulator.get_instruction_counter();
    assert(insn_b >>> 0 !== 0 && insn_b !== insn_a,
        `summed instruction counter must advance (${insn_a} -> ${insn_b})`);

    const smoke_ms = await run_smoke(state, "phase A (percpu, 2 vCPUs)");

    // Layer C item 4 cross-worker: doorbell storms against both idle
    // workers; every post is a legitimate spurious wake, and the machine
    // must stay responsive
    const cpu = state.emulator.v86.cpu;
    const i32 = new Int32Array(cpu.guest_memory.buffer);
    const ctl_base = ctl_base_for(cpu.memory_size[0]);
    const before = [heartbeat_read(i32, ctl_base, 0), heartbeat_read(i32, ctl_base, 1)];
    const POSTS = 50_000;
    for(let posted = 0; posted < POSTS; posted += 1000)
    {
        for(let i = 0; i < 1000; i++)
        {
            doorbell_post(i32, ctl_base, 0);
            doorbell_post(i32, ctl_base, 1);
        }
        if(posted % 10_000 === 0)
        {
            state.emulator.serial0_send("\n");
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    for(const i of [0, 1])
    {
        assert(heartbeat_read(i32, ctl_base, i) > before[i],
            `doorbell storm must produce wakes on worker ${i}`);
    }
    state.emulator.serial0_send("echo AL''IVE-AFTER-STORM\n");
    const storm_timeout = fail_timeout("post-storm round-trip", 60,
        () => console.log(state.serial));
    await state.wait_for_serial(s => /^ALIVE-AFTER-STORM\r?$/m.test(s));
    clearTimeout(storm_timeout);
    console.log(`phase A hlt/wake storm: ${2 * POSTS} posts across both workers, ` +
        "machine responsive");

    await state.emulator.destroy();
    return smoke_ms;
}

// ---- Phase B: cpus 4, topology (b) ----

async function phase_b()
{
    const CPUS = 4;
    const state = boot(CPUS, "percpu");
    await wait_for_shell(state, "phase B boot", 600);
    assert.equal(state.smp_mode["topology"], "percpu", "topology (b)");
    assert.equal(state.smp_mode["cpus_effective"], CPUS, "cpus_effective");
    const brought_up = await check_smp(state, CPUS);
    console.log("phase B boot (percpu, 4 vCPUs): %s", brought_up);
    await state.emulator.destroy();
}

// ---- Phase C: the (c) reference for the parallelism smoke ----

async function phase_c()
{
    const state = boot(2, "machine");
    await wait_for_shell(state, "phase C boot", 420);
    assert.equal(state.smp_mode["topology"], "machine", "topology (c)");
    await check_smp(state, 2);
    const smoke_ms = await run_smoke(state, "phase C (machine, time-sliced)");
    await state.emulator.destroy();
    return smoke_ms;
}

const percpu_ms = await phase_a();
await phase_b();
const machine_ms = await phase_c();

const speedup = machine_ms / percpu_ms;
console.log(`parallelism smoke: percpu ${(percpu_ms / 1000).toFixed(2)} s vs ` +
    `time-sliced ${(machine_ms / 1000).toFixed(2)} s -> ${speedup.toFixed(2)}x`);
// smoke, not the W5 formal acceptance: real parallelism must show a
// measurable win on a 2-process CPU-bound workload
assert(speedup >= 1.2,
    `topology (b) must beat time-sliced on the parallel workload (got ${speedup.toFixed(2)}x)`);

console.log("Tests passed");
process.exit(0);
