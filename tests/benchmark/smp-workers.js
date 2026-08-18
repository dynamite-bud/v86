#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W5: the formal worker-vCPU benchmark against the
// design's acceptance bar (docs/smp-phase4-design.md §9, "Benchmark
// acceptance"). Results and methodology are recorded in
// docs/smp-benchmark-report.md.
//
// Configurations (all over the imported guest-memory backend, so the
// artifact and backend are identical across modes — the
// machine-in-worker-boottime.js comparability rule):
//   percpu2      cpus=2, one worker per vCPU (topology (b)) — the subject
//   worker1      cpus=1, worker execution, topology (b) — the 1-vCPU
//                worker baseline of gate (1)
//   timesliced2  cpus=2, smp_workers off — the landed time-sliced scheduler
//   percpu4      cpus=4 workers — informative, not gated (BENCH_SKIP_4=1
//                to skip)
//
// Workloads (the Alpine/busybox fixture has no compiler; per design §9 the
// "make -j2"-style mixed load is approximated by two cooperating
// gzip/zcat/awk pipelines over tmpfs files — multiple processes, mixed
// CPU/pipe/VFS work):
//   cpu2    two background `dd if=/dev/zero bs=1M count=256 | md5sum`
//           pipelines + wait (fixed work, CPU-bound, negligible device I/O)
//   mixed2  two background `gzip -c fN | zcat | awk '{s+=$1} END {print s}'`
//           pipelines over pre-generated tmpfs files + wait
//   single  one dd|md5sum pipeline (the single-thread regression probe)
//   cpu4    (percpu4 only) four dd|md5sum pipelines
//
// Methodology: one boot per configuration; workloads interleaved in rounds
// (round r runs cpu2, mixed2, single) to spread host drift across all
// cells; BENCH_RUNS rounds (default 5); wall time is measured on the host
// between the serial arrival of the ST/SP marker lines. Medians decide the
// gates; min..max spread is reported. Run on an otherwise idle machine.
//
// Gates (§9): cpu2: percpu2 >= 1.5x vs worker1 AND >= 1.4x vs timesliced2;
// mixed2: >= 1.15x vs timesliced2; single: percpu2 regression <= 10% vs
// timesliced2. Exit code 1 if a gate fails (BENCH_NO_GATE=1 to just
// report). Zero-lost-updates (gate 4) is the Layer C suite, referenced in
// the report, not re-run here.

import url from "node:url";
import fs from "node:fs";
import os from "node:os";
import { install_node_web_worker } from "../node_web_worker.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = __dirname + "/../..";

// release bundle by default (representative numbers); BENCH_DEBUG=1 uses
// the source tree + debug artifact
const BENCH_DEBUG = +process.env.BENCH_DEBUG;
const { V86 } = await import(BENCH_DEBUG ? "../../src/main.js" : "../../build/libv86.mjs");
const multimem_wasm = root_path +
    (BENCH_DEBUG ? "/build/v86-multimem-debug.wasm" : "/build/v86-multimem.wasm");

process.on("unhandledRejection", exn => { throw exn; });

for(const requirement of [multimem_wasm,
    root_path + "/images/alpine-virtio-gpu-codex-fs.json"])
{
    if(!fs.existsSync(requirement))
    {
        console.log("Missing " + requirement + ", benchmark skipped");
        process.exit(0);
    }
}

install_node_web_worker();

const WORKER_URL = new URL("../../src/browser/vcpu_worker.js", import.meta.url);
const RUNS = +process.env.BENCH_RUNS || 5;
const DD_COUNT = +process.env.BENCH_DD_COUNT || 256;

const JOB = `dd if=/dev/zero bs=1M count=${DD_COUNT} 2>/dev/null | md5sum > /dev/null`;
const MIXED_JOB = f =>
    `gzip -c /bench/${f} | zcat | awk '{s+=$1} END {print s}' > /dev/null`;
const WORKLOADS = {
    cpu2: `( ${JOB} ) & ( ${JOB} ) & wait`,
    mixed2: `( ${MIXED_JOB("f1")} ) & ( ${MIXED_JOB("f2")} ) & wait`,
    single: JOB,
};
const CPU4 = `( ${JOB} ) & ( ${JOB} ) & ( ${JOB} ) & ( ${JOB} ) & wait`;
const SETUP = "mkdir -p /bench && mount -t tmpfs tmpfs /bench && " +
    "seq 1 600000 > /bench/f1 && seq 600001 1200000 > /bench/f2 && echo SETUP-do''ne";

function boot(config)
{
    const emulator = new V86(Object.assign({
        bios: { url: root_path + "/bios/seabios.bin" },
        vga_bios: { url: root_path + "/bios/vgabios.bin" },
        autostart: true,
        memory_size: 512 * 1024 * 1024,
        acpi: true,
        smp_worker_url: WORKER_URL,
        guest_memory_backend: "imported",
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
    }, config));

    const state = { emulator, serial: "", serial_times: [], smp_mode: null };
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
    state.line_time = re =>
    {
        const index = state.serial.search(re);
        if(index < 0)
        {
            throw new Error("marker " + re + " missing from serial log");
        }
        return state.serial_times[Math.min(index, state.serial_times.length - 1)];
    };
    return state;
}

const timeout = (label, seconds, dump) => setTimeout(() =>
{
    dump && dump();
    throw new Error("Timeout: " + label);
}, seconds * 1000);

async function wait_for_shell(state, label)
{
    const t = timeout(label, 600, () => console.log(state.serial));
    const poller = setInterval(
        () => state.emulator.serial0_send("\necho v86-read''y\n"), 5000);
    await state.wait_for_serial(s => /^v86-ready\r?$/m.test(s));
    clearInterval(poller);
    clearTimeout(t);
}

let sequence = 0;

// one timed workload run: wall clock between host receipt of the unique
// ST-n / SP-n marker lines
async function timed(state, command)
{
    const n = sequence++;
    const t = timeout("workload " + n, 600, () => console.log(state.serial.slice(-2000)));
    state.emulator.serial0_send(`echo S''T-${n}; ${command}; echo S''P-${n}\n`);
    await state.wait_for_serial(s => new RegExp(`^SP-${n}\r?$`, "m").test(s));
    clearTimeout(t);
    return state.line_time(new RegExp(`^SP-${n}\r?$`, "m")) -
        state.line_time(new RegExp(`^ST-${n}\r?$`, "m"));
}

const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const fmt = ms => (ms / 1000).toFixed(2) + " s";
const spread = xs => `${fmt(Math.min(...xs))}..${fmt(Math.max(...xs))}`;

async function run_config(name, config, workloads)
{
    console.log(`\n=== ${name} ===`);
    const state = boot(config);
    await wait_for_shell(state, name + " boot");
    console.log(`${name}: booted; smp_mode = ` + JSON.stringify(state.smp_mode));
    state.emulator.serial0_send(SETUP + "\n");
    await state.wait_for_serial(s => /^SETUP-done\r?$/m.test(s));

    // warmup (JIT compilation, page cache) — one untimed cpu round
    await timed(state, workloads["cpu2"] || workloads["single"]);

    const results = {};
    for(const w of Object.keys(workloads))
    {
        results[w] = [];
    }
    for(let round = 0; round < RUNS; round++)
    {
        for(const w of Object.keys(workloads))
        {
            const ms = await timed(state, workloads[w]);
            results[w].push(ms);
            console.log(`${name} round ${round + 1} ${w}: ${fmt(ms)}`);
        }
    }
    for(const w of Object.keys(results))
    {
        console.log(`${name} ${w}: median ${fmt(median(results[w]))} ` +
            `(${RUNS} runs, ${spread(results[w])})`);
    }
    await state.emulator.destroy();
    return results;
}

console.log(`smp-workers benchmark: ${RUNS} rounds/cell, dd count=${DD_COUNT} MiB, ` +
    `host ${os.arch()} (${os.cpus()[0].model}, ${os.cpus().length} cores), ` +
    `node ${process.version}, ${BENCH_DEBUG ? "DEBUG" : "release"} bundle` +
    `${+process.env.DISABLE_JIT ? ", DISABLE_JIT" : ""}`);

const percpu2 = await run_config("percpu2",
    { cpus: 2, smp_workers: true, smp_worker_topology: "percpu" }, WORKLOADS);
const worker1 = await run_config("worker1",
    { cpus: 1, smp_workers: true, smp_worker_topology: "percpu" },
    { cpu2: WORKLOADS.cpu2, single: WORKLOADS.single });
const timesliced2 = await run_config("timesliced2",
    { cpus: 2 }, WORKLOADS);
let percpu4 = null;
if(!+process.env.BENCH_SKIP_4)
{
    percpu4 = await run_config("percpu4",
        { cpus: 4, smp_workers: true, smp_worker_topology: "percpu" },
        { cpu2: WORKLOADS.cpu2, cpu4: CPU4, mixed2: WORKLOADS.mixed2 });
}

// ---- the acceptance gates ----
console.log("\n=== gates (design §9 benchmark acceptance) ===");
const gates = [];
function gate(name, actual, bound, pass)
{
    gates.push(pass);
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${actual} (bar: ${bound})`);
}
const ratio = (a, b) => median(a) / median(b);

const cpu2_vs_worker1 = ratio(worker1.cpu2, percpu2.cpu2);
gate("cpu2 speedup vs cpus=1 worker", cpu2_vs_worker1.toFixed(2) + "x", ">= 1.5x",
    cpu2_vs_worker1 >= 1.5);
const cpu2_vs_ts = ratio(timesliced2.cpu2, percpu2.cpu2);
gate("cpu2 speedup vs cpus=2 time-sliced", cpu2_vs_ts.toFixed(2) + "x", ">= 1.4x",
    cpu2_vs_ts >= 1.4);
const mixed_vs_ts = ratio(timesliced2.mixed2, percpu2.mixed2);
gate("mixed2 speedup vs time-sliced", mixed_vs_ts.toFixed(2) + "x", ">= 1.15x",
    mixed_vs_ts >= 1.15);
const single_reg = ratio(percpu2.single, timesliced2.single) - 1;
gate("single-thread regression vs time-sliced", (100 * single_reg).toFixed(1) + " %",
    "<= 10 %", single_reg <= 0.10);
console.log("(gate 4, zero lost updates: the Layer C suite — " +
    "tests/threads/*, all exactness assertions — is the evidence; see " +
    "docs/smp-benchmark-report.md)");
if(percpu4)
{
    console.log(`informative percpu4: cpu2 ${fmt(median(percpu4.cpu2))}, ` +
        `cpu4 ${fmt(median(percpu4.cpu4))} ` +
        `(cpu4 on percpu2 would serialize 2x), mixed2 ${fmt(median(percpu4.mixed2))}`);
}

if(!gates.every(g => g) && !+process.env.BENCH_NO_GATE)
{
    console.log("BENCHMARK GATES FAILED");
    process.exit(1);
}
console.log("Benchmark complete");
process.exit(0);
