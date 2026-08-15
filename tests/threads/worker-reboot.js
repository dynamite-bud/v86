#!/usr/bin/env node

// XWAH-9 Phase 4 Stage W4 gate (docs/smp-phase4-design.md §8/§9 W4): the
// quiesced reboot under worker execution.
//
// Phase A — topology (b), linux4.iso, cpus: 2: boot to a shell, then
//   reboot twice — first GUEST-triggered (`reboot`: the reset port write
//   is serviced inside a mailbox dispatch, exercising the fire-and-forget
//   quiesce that must not deadlock the triggering worker's own pending
//   RPC), then HOST-triggered (V86.restart). Each reboot: park + ack all
//   workers, main-side chipset/device reset, per-worker RESET commands
//   (each worker resets its instance, APs return to WaitForSipi, acks by
//   parking), all-acked barrier, release — and SeaBIOS brings the AP up
//   again cross-worker on the second POST.
// Phase B — topology (c), same guest: the single-machine-worker leg of
//   the same protocol.
//
// The guest is linux4.iso (the api reboot.js guest): rebooting after the
// Alpine linux-lts fixture crashes identically under plain time-sliced
// cpus=2 on the default artifact — the upstream reboot-after-Linux class
// of github.com/copy/v86/issues/636 — so it cannot gate the worker wire.
//
// Missing artifacts/images skip cleanly (the repo pattern).

import url from "node:url";
import fs from "node:fs";
import { install_node_web_worker } from "../node_web_worker.js";

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
if(!fs.existsSync(root_path + "/images/linux4.iso"))
{
    console.log("Missing images/linux4.iso, test skipped");
    process.exit(0);
}

install_node_web_worker();

const WORKER_URL = new URL("../../src/browser/vcpu_worker.js", import.meta.url);
const TIMEOUT_FACTOR = +process.env.TIMEOUT_EXTRA_FACTOR || 1;

async function reboot_phase(label, topology)
{
    const emulator = new V86({
        bios: { url: root_path + "/bios/seabios.bin" },
        vga_bios: { url: root_path + "/bios/vgabios.bin" },
        cdrom: { url: root_path + "/images/linux4.iso", async: true },
        autostart: true,
        memory_size: 128 * 1024 * 1024,
        acpi: true,
        cpus: 2,
        smp_workers: true,
        smp_worker_topology: topology,
        smp_worker_url: WORKER_URL,
        filesystem: {},
        log_level: 0,
        disable_jit: +process.env.DISABLE_JIT,
    });

    let serial = "";
    let stage = 0; // 0 = first boot, 1 = after guest reboot, 2 = after host restart
    let smp_mode = null;
    emulator.add_listener("smp-mode", mode => { smp_mode = mode; });
    emulator.add_listener("emulator-error", e => { throw e; });

    const done = new Promise(resolve =>
    {
        emulator.add_listener("serial0-output-byte", byte =>
        {
            serial += String.fromCharCode(byte);
            if(!serial.endsWith("~% "))
            {
                return;
            }
            if(stage === 0)
            {
                console.log(label + ": shell up; guest-triggered reboot");
                stage = 1;
                serial = "";
                emulator.serial0_send("reboot\n");
            }
            else if(stage === 1)
            {
                console.log(label + ": shell back after guest reboot; host restart()");
                stage = 2;
                serial = "";
                emulator.restart();
            }
            else
            {
                console.log(label + ": shell back after host restart");
                resolve();
            }
        });
    });

    const timeout = setTimeout(() =>
    {
        console.log(serial.slice(-3000));
        throw new Error("Timeout: " + label + " stage " + stage);
    }, 300 * TIMEOUT_FACTOR * 1000);
    await done;
    clearTimeout(timeout);
    if(!smp_mode || smp_mode["execution"] !== "workers" || smp_mode["topology"] !== topology)
    {
        throw new Error(label + ": expected worker topology " + topology +
            ", got " + JSON.stringify(smp_mode));
    }
    await emulator.destroy();
}

await reboot_phase("phase A (percpu, 2 vCPUs)", "percpu");
await reboot_phase("phase B (machine)", "machine");

console.log("Tests passed");
process.exit(0);
