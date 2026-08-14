// XWAH-9 Phase 4 Stage W3: the device host of topology (b)
// (docs/smp-phase4-design.md §9 W3). Every vCPU runs in its own worker
// (src/browser/vcpu_worker.js per-vCPU mode); the main thread — this
// module — keeps the full V86 construction (devices, io.js, bus, its own
// wasm instance) but never executes guest code. Its instance is the
// AUTHORITATIVE chipset: 8259 PIC and IOAPIC. It:
//
// - services every worker's blocking io_port_*/mmap_* mailbox RPCs on
//   per-record Atomics.waitAsync loops. Port I/O dispatches through the
//   main instance's host_io_port_* exports so the Rust 8259 port
//   intercepts hit the real PIC (io.js has no handlers for those ports);
//   mmap dispatches onto cpu.read*/write* as in (c), keeping the Rust
//   SVGA-LFB leg and the IOAPIC MMIO intercept on THIS instance
//   (per-vCPU workers forward the 0xFEC00000 window here);
// - keeps cpu.device_raise_irq/device_lower_irq at their DEFAULT wasm
//   exports: pic::set_irq/ioapic::set_irq mutate the authoritative
//   chipset, apic::route's shared leg posts matched fixed vectors to the
//   right worker's pending_irr + doorbell, and wake_bsp's host leg posts
//   the PIC flag + doorbell[0] — the (b) wire, no ring replay;
// - answers the BSP worker's MAILBOX_OP_PIC_ACK RPC from the
//   authoritative 8259 and re-posts the PIC flag while INTR stays
//   asserted;
// - drains the workers' level-EOI rings (host doorbell + tick) into
//   ioapic::remote_eoi and reevaluates held lines after routing-snapshot
//   changes;
// - forwards JS-side guest-RAM invalidations (cpu.write_blob during
//   DMA/IDE) as dirty events into EVERY worker's jit inbox (overflow is
//   recovered by the worker's clear-all, so no backlog is needed);
// - runs the device tick (PIT/RTC/ACPI) and aggregates the machine-dead
//   condition from the published run states;
// - drives the §8 command protocol (RUN/PARK/RESET/TERMINATE) for all N
//   workers.

import { LOG_CPU } from "../const.js";
import { dbg_log } from "../log.js";
import { spawn_worker } from "./smp_worker_host.js";
import {
    ctl_base_for,
    CTL_VCPU_STRIDE, CTL_EOI_RING, CTL_EOI_RING_CAP,
    CTL_RUN_STATE_PARKED, CTL_RUN_STATE_WAIT_FOR_SIPI,
    CTL_COMMAND_RUN, CTL_COMMAND_PARK_REQ, CTL_COMMAND_TERMINATE, CTL_COMMAND_RESET,
    ring_pop, doorbell_post, command_write, run_state_read, insn_read,
    jit_inbox_push, pic_pending_set, host_doorbell_word,
    mailbox_record_word, mailbox_service, mailbox_wait_for_request,
    MAILBOX_STATE, MAILBOX_REQUEST,
    MAILBOX_OP_OUT, MAILBOX_OP_IN, MAILBOX_OP_MMAP_READ, MAILBOX_OP_MMAP_WRITE,
    MAILBOX_OP_IN_REP, MAILBOX_OP_OUT_REP, MAILBOX_OP_PIC_ACK,
} from "./smpctl.js";

// re-arm timeout of the service loops; short enough that stop() takes
// effect promptly, long enough to stay off the hot path
const SERVICE_REARM_MS = 250;
// worker spawn + instantiate deadline before the ladder gives up
const SPAWN_TIMEOUT_MS = 60000;
// deadline for the workers to acknowledge TERMINATE before a hard terminate
const TERMINATE_TIMEOUT_MS = 2000;
// synchronous post-service polls before re-arming Atomics.waitAsync
// (the smp_worker_host.js burst rationale)
const SERVICE_SPIN = 4000;

/**
 * @constructor
 * @param {!Object} cpu the main thread's CPU object (device host side)
 * @param {!Object} emulator_bus starter's emulator_bus (bus[1])
 * @param {!WebAssembly.Memory} guest_memory
 * @param {number} total vCPU count == worker count
 */
export function SMPVcpuHost(cpu, emulator_bus, guest_memory, total)
{
    this.cpu = cpu;
    this.emulator_bus = emulator_bus;
    this.total = total;
    this.i32 = new Int32Array(guest_memory.buffer);
    this.ctl_base = ctl_base_for(cpu.memory_size[0]);
    this.host_doorbell = host_doorbell_word(this.ctl_base, total);
    this.channels = [];
    this.stopped = false;
    this.terminating = false;
    this.terminated_count = 0;
    this.fatal_error = null;
    this.service_done = [];
    this.host_doorbell_done = null;
    this.commanded_running = false;
    this.halt_event_sent = false;
    this.cpu_exception_hook = function(n) {};
}

/**
 * Spawn all N per-vCPU workers, send each its payload, and resolve when
 * every worker reports vcpu-ready (instantiated, layout-checked, reset,
 * role set, parked on the pre-written PARK_REQ). Rejects on any worker
 * error or timeout — the caller decides between fail-stop
 * (`smp_workers: true`) and ladder degradation (`"auto"`).
 * @param {{
 *     worker_url: string,
 *     wasm_source: !ArrayBuffer,
 *     gram_bytes: !ArrayBuffer,
 *     guest_memory: !WebAssembly.Memory,
 *     acpi: boolean,
 *     disable_jit: boolean,
 *     cpuid_level: (number|undefined),
 * }} config
 * @return {!Promise}
 */
SMPVcpuHost.prototype.start = function(config)
{
    // park every worker until run() — honored by each worker's very first
    // loop iteration
    for(let i = 0; i < this.total; i++)
    {
        command_write(this.i32, this.ctl_base, i, CTL_COMMAND_PARK_REQ);
    }

    // the main instance becomes the (b) device host BEFORE any worker can
    // run: from here on, device IRQs raised on this instance route into
    // the shared pending bitmaps instead of the local (guestless) vCPU
    this.cpu.wm.exports["set_worker_host"](1);

    const readies = [];
    for(let index = 0; index < this.total; index++)
    {
        const channel = spawn_worker(config.worker_url);
        this.channels.push(channel);
        readies.push(new Promise((resolve, reject) =>
        {
            const timeout = setTimeout(
                () => reject(new Error("vcpu worker " + index + " spawn timed out")),
                SPAWN_TIMEOUT_MS);
            if(timeout["unref"])
            {
                timeout["unref"]();
            }
            channel.on_message(m => this.handle_message(m, () =>
            {
                clearTimeout(timeout);
                resolve();
            }));
            channel.on_error(e =>
            {
                if(this.terminating)
                {
                    return;
                }
                clearTimeout(timeout);
                reject(e);
                this.fail(e);
            });
        }));
        channel.post({
            "wasm_source": config.wasm_source,
            "gram_bytes": config.gram_bytes,
            "guest_memory": config.guest_memory,
            "index": index,
            "total": this.total,
            "main_time_origin": performance.timeOrigin,
            "memory_size": this.cpu.memory_size[0],
            "vcpu": {
                "acpi": !!config.acpi,
                "disable_jit": !!config.disable_jit,
                "cpuid_level": config.cpuid_level || 0,
            },
        });
    }

    for(let i = 0; i < this.total; i++)
    {
        this.start_service_loop(i);
    }
    this.start_host_doorbell_loop();
    return Promise.all(readies);
};

/**
 * @param {*} m worker message
 * @param {function()} on_ready
 */
SMPVcpuHost.prototype.handle_message = function(m, on_ready)
{
    if(!m)
    {
        return;
    }
    switch(m["type"])
    {
        case "vcpu-ready":
            on_ready();
            break;
        case "terminated":
            this.terminated_count++;
            break;
        case "log":
            dbg_log("vcpu" + m["index"] + ": " + m["message"], LOG_CPU);
            break;
        case "console-log":
            console.error(m["message"]);
            break;
        case "cpu-exception":
            this.cpu_exception_hook(m["n"]);
            break;
        case "cpu-event-halt":
            this.emulator_bus.send("cpu-event-halt");
            break;
        case "abort":
        case "error":
            this.fail(new Error("vcpu worker " + m["type"] + ": " +
                (m["message"] || "") + "\n" + (m["stack"] || "")));
            break;
        // "init-done", "dbg-trace": informational
    }
};

/**
 * Fail-stop (design §8): a worker error after boot cannot be recovered —
 * a guest does not survive losing a CPU. Surface the error, park the
 * remaining workers, and stop servicing.
 * @param {!Error} error
 */
SMPVcpuHost.prototype.fail = function(error)
{
    if(this.fatal_error)
    {
        return;
    }
    this.fatal_error = error;
    console.error("smp vcpu worker failed:", error);
    for(let i = 0; i < this.total; i++)
    {
        command_write(this.i32, this.ctl_base, i, CTL_COMMAND_PARK_REQ);
        doorbell_post(this.i32, this.ctl_base, i);
    }
    this.emulator_bus.send("emulator-error", error);
    this.stop_service_loops();
};

// ---- mailbox service (device-host side of the §6 RPC protocol) ----

SMPVcpuHost.prototype.start_service_loop = function(index)
{
    const i32 = this.i32;
    const record = mailbox_record_word(this.ctl_base, index);
    const dispatch = this.dispatch.bind(this);
    this.service_done.push((async () =>
    {
        while(!this.stopped)
        {
            if(mailbox_service(i32, record, dispatch))
            {
                let spin = SERVICE_SPIN;
                while(spin-- > 0 &&
                    Atomics.load(i32, record + MAILBOX_STATE) !== MAILBOX_REQUEST)
                {
                }
                continue;
            }
            await mailbox_wait_for_request(i32, record, SERVICE_REARM_MS);
        }
    })());
};

SMPVcpuHost.prototype.stop_service_loops = function()
{
    this.stopped = true;
    for(let i = 0; i < this.total; i++)
    {
        Atomics.notify(this.i32, mailbox_record_word(this.ctl_base, i) + MAILBOX_STATE);
    }
    Atomics.notify(this.i32, this.host_doorbell);
};

/**
 * The worker -> host doorbell service (design §4): drain every worker's
 * level-EOI ring into the authoritative IOAPIC and reevaluate held lines
 * after routing-snapshot changes. Cheap enough to run unconditionally on
 * every wake; drain_notifications also runs from every tick as fallback.
 */
SMPVcpuHost.prototype.start_host_doorbell_loop = function()
{
    const i32 = this.i32;
    this.host_doorbell_done = (async () =>
    {
        while(!this.stopped)
        {
            const seen = Atomics.load(i32, this.host_doorbell);
            this.drain_notifications();
            const waited = Atomics.waitAsync(i32, this.host_doorbell, seen, SERVICE_REARM_MS);
            if(waited.async)
            {
                await waited.value;
            }
        }
    })();
};

SMPVcpuHost.prototype.drain_notifications = function()
{
    const exports = this.cpu.wm.exports;
    let any = false;
    for(let i = 0; i < this.total; i++)
    {
        const ring = this.ctl_base + i * CTL_VCPU_STRIDE + CTL_EOI_RING;
        for(let vector; (vector = ring_pop(this.i32, ring, CTL_EOI_RING_CAP)) !== undefined;)
        {
            exports["host_remote_eoi"](vector & 0xFF);
            any = true;
        }
    }
    // routing-snapshot changes share the host doorbell: reevaluate held
    // IOAPIC lines (a no-op when nothing is pending). Also run after EOI
    // replay, whose re-delivery may have been blocked by remote IRR.
    exports["host_chipset_reevaluate"]();
    return any;
};

/**
 * One RPC (per-record; op surface = (c) + MAILBOX_OP_PIC_ACK). Port I/O
 * goes through the host_io_port_* exports (Rust PIC intercept on the
 * authoritative chipset); mmap through cpu.read8/write8 and friends as in
 * (c). A throwing device handler is answered so the worker never
 * deadlocks, then surfaced as emulator-error.
 * @param {number} op
 * @param {number} addr
 * @param {number} size
 * @param {number} value_lo
 * @param {number} value_hi
 * @param {number} seq
 * @param {number} value_2
 * @param {number} value_3
 * @return {number|undefined}
 */
SMPVcpuHost.prototype.dispatch = function(op, addr, size, value_lo, value_hi, seq, value_2, value_3)
{
    const cpu = this.cpu;
    const exports = cpu.wm.exports;
    try
    {
        switch(op)
        {
            case MAILBOX_OP_IN:
                return size === 1 ? exports["host_io_port_read8"](addr) :
                    size === 2 ? exports["host_io_port_read16"](addr) :
                    exports["host_io_port_read32"](addr);
            case MAILBOX_OP_OUT:
                if(size === 1)
                {
                    exports["host_io_port_write8"](addr, value_lo);
                }
                else if(size === 2)
                {
                    exports["host_io_port_write16"](addr, value_lo);
                }
                else
                {
                    exports["host_io_port_write32"](addr, value_lo);
                }
                return undefined;
            case MAILBOX_OP_PIC_ACK:
            {
                // acknowledge from the authoritative 8259; while INTR
                // stays asserted (more pending requests), re-post the PIC
                // flag so the BSP worker comes back for the next vector
                const vector = exports["host_pic_acknowledge"]();
                if(exports["host_pic_has_requested"]())
                {
                    pic_pending_set(this.i32, this.ctl_base, 0);
                    doorbell_post(this.i32, this.ctl_base, 0);
                }
                return vector | 0;
            }
            case MAILBOX_OP_MMAP_READ:
                return size === 1 ? cpu.read8(addr) :
                    size === 2 ? cpu.read16(addr) :
                    cpu.read32s(addr);
            case MAILBOX_OP_IN_REP:
            {
                const count = value_lo >>> 0;
                const mem8 = cpu.mem8;
                let phys = value_hi >>> 0;
                if(size === 1)
                {
                    for(let i = 0; i < count; i++)
                    {
                        mem8[phys++] = exports["host_io_port_read8"](addr);
                    }
                }
                else if(size === 2)
                {
                    for(let i = 0; i < count; i++)
                    {
                        const v = exports["host_io_port_read16"](addr);
                        mem8[phys++] = v & 0xFF;
                        mem8[phys++] = v >> 8 & 0xFF;
                    }
                }
                else
                {
                    for(let i = 0; i < count; i++)
                    {
                        const v = exports["host_io_port_read32"](addr);
                        mem8[phys++] = v & 0xFF;
                        mem8[phys++] = v >> 8 & 0xFF;
                        mem8[phys++] = v >> 16 & 0xFF;
                        mem8[phys++] = v >>> 24;
                    }
                }
                return count | 0;
            }
            case MAILBOX_OP_OUT_REP:
            {
                const count = value_lo >>> 0;
                const mem8 = cpu.mem8;
                let phys = value_hi >>> 0;
                if(size === 1)
                {
                    for(let i = 0; i < count; i++)
                    {
                        exports["host_io_port_write8"](addr, mem8[phys++]);
                    }
                }
                else if(size === 2)
                {
                    for(let i = 0; i < count; i++)
                    {
                        exports["host_io_port_write16"](addr, mem8[phys] | mem8[phys + 1] << 8);
                        phys += 2;
                    }
                }
                else
                {
                    for(let i = 0; i < count; i++)
                    {
                        exports["host_io_port_write32"](addr,
                            mem8[phys] | mem8[phys + 1] << 8 |
                            mem8[phys + 2] << 16 | mem8[phys + 3] << 24);
                        phys += 4;
                    }
                }
                return count | 0;
            }
            case MAILBOX_OP_MMAP_WRITE:
                if(size === 1)
                {
                    cpu.write8(addr, value_lo);
                }
                else if(size === 2)
                {
                    cpu.write16(addr, value_lo);
                }
                else if(size === 4)
                {
                    cpu.write32(addr, value_lo);
                }
                else if(size === 8)
                {
                    cpu.write32(addr, value_lo);
                    cpu.write32(addr + 4 | 0, value_hi);
                }
                else
                {
                    cpu.write32(addr, value_lo);
                    cpu.write32(addr + 4 | 0, value_hi);
                    cpu.write32(addr + 8 | 0, value_2);
                    cpu.write32(addr + 12 | 0, value_3);
                }
                return undefined;
            default:
                dbg_log("unknown mailbox op " + op, LOG_CPU);
                return 0;
        }
    }
    catch(e)
    {
        this.fail(e instanceof Error ? e : new Error(String(e)));
        return op === MAILBOX_OP_OUT || op === MAILBOX_OP_MMAP_WRITE ? undefined : 0;
    }
};

// ---- cross-worker jit-dirty producer (design §9 W3 note) ----

/**
 * The worker-mode leg of cpu.jit_dirty_cache: main-thread JS wrote guest
 * RAM (DMA/IDE/write_blob), so EVERY worker's JIT cache must invalidate
 * those pages. Overflow needs no backlog: the flag makes the worker
 * recover with jit_clear_all + full_clear_tlb.
 * @param {number} start_addr
 * @param {number} end_addr exclusive
 */
SMPVcpuHost.prototype.post_jit_dirty = function(start_addr, end_addr)
{
    const first = start_addr >>> 12;
    const last = end_addr - 1 >>> 12;
    for(let i = 0; i < this.total; i++)
    {
        for(let page = first; page <= last; page++)
        {
            jit_inbox_push(this.i32, this.ctl_base, i, page);
        }
        doorbell_post(this.i32, this.ctl_base, i);
    }
};

// ---- the device tick (v86.do_tick's worker-mode body) ----

/**
 * Replaces cpu.main_loop on the device host: run the main-side hardware
 * timers (PIT/RTC/ACPI fire through cpu.device_raise_irq, i.e. through
 * the wasm chipset and route()'s shared leg), drain worker notifications,
 * and aggregate the machine-dead condition.
 * @return {number} ms until the next device-timer deadline
 */
SMPVcpuHost.prototype.tick = function()
{
    const now = performance.now();
    const devices = this.cpu.devices;
    let t = 100;
    if(devices.pit)
    {
        t = Math.min(t, devices.pit.timer(now, false));
    }
    if(devices.rtc)
    {
        t = Math.min(t, devices.rtc.timer(now, false));
    }
    if(this.cpu.acpi_enabled[0] && devices.acpi)
    {
        t = Math.min(t, devices.acpi.timer(now));
    }
    this.drain_notifications();
    if(this.commanded_running && !this.halt_event_sent)
    {
        let dead = true;
        for(let i = 0; i < this.total; i++)
        {
            const state = run_state_read(this.i32, this.ctl_base, i);
            if(state !== CTL_RUN_STATE_PARKED && state !== CTL_RUN_STATE_WAIT_FOR_SIPI)
            {
                dead = false;
                break;
            }
        }
        if(dead)
        {
            // every vCPU is parked (hlt with IF=0) or WaitForSipi: the
            // machine is dead (the main_loop_smp aggregation, host-side)
            this.halt_event_sent = true;
            this.emulator_bus.send("cpu-event-halt");
        }
    }
    return t;
};

/**
 * Sum of the workers' published instruction counters mod 2^32 (design §8:
 * the documented approximate get_instruction_counter of worker mode).
 * @return {number}
 */
SMPVcpuHost.prototype.sum_instruction_counters = function()
{
    let sum = 0;
    for(let i = 0; i < this.total; i++)
    {
        sum = sum + (insn_read(this.i32, this.ctl_base, i) >>> 0) >>> 0;
    }
    return sum >>> 0;
};

// ---- command protocol (design §8) ----

SMPVcpuHost.prototype.run = function()
{
    this.commanded_running = true;
    this.halt_event_sent = false;
    for(let i = 0; i < this.total; i++)
    {
        command_write(this.i32, this.ctl_base, i, CTL_COMMAND_RUN);
        doorbell_post(this.i32, this.ctl_base, i);
    }
};

SMPVcpuHost.prototype.park = function()
{
    this.commanded_running = false;
    for(let i = 0; i < this.total; i++)
    {
        command_write(this.i32, this.ctl_base, i, CTL_COMMAND_PARK_REQ);
        doorbell_post(this.i32, this.ctl_base, i);
    }
};

/**
 * Machine reboot (guest reset port / V86.restart): each worker resets its
 * instance, re-enters its per-vCPU role (clearing its control cells) and
 * acks by restoring RUN.
 */
SMPVcpuHost.prototype.post_reset = function()
{
    this.halt_event_sent = false;
    for(let i = 0; i < this.total; i++)
    {
        command_write(this.i32, this.ctl_base, i, CTL_COMMAND_RESET);
        doorbell_post(this.i32, this.ctl_base, i);
    }
};

/**
 * Quiesce and tear down: TERMINATE + doorbell to every worker, wait
 * briefly for the acks, then hard-terminate and stop the service loops.
 * @return {!Promise}
 */
SMPVcpuHost.prototype.terminate = async function()
{
    this.terminating = true;
    for(let i = 0; i < this.total; i++)
    {
        command_write(this.i32, this.ctl_base, i, CTL_COMMAND_TERMINATE);
        doorbell_post(this.i32, this.ctl_base, i);
    }
    const deadline = Date.now() + TERMINATE_TIMEOUT_MS;
    while(this.terminated_count < this.total && Date.now() < deadline)
    {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.stop_service_loops();
    await Promise.all(this.service_done);
    await this.host_doorbell_done;
    for(const channel of this.channels)
    {
        channel.terminate();
    }
};
