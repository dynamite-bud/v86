// XWAH-9 Phase 4 Stage W3: the device host of topology (b)
// (docs/smp-phase4-design.md §9 W3). Every vCPU runs in its own worker
// (src/browser/vcpu_worker.js per-vCPU mode); the main thread — this
// module — keeps the full V86 construction (devices, io.js, bus, its own
// wasm instance) but never executes guest code. Its instance is the
// AUTHORITATIVE chipset: 8259 PIC and IOAPIC. It:
//
// - services every worker's blocking io_port_*/mmap_* mailbox RPCs.
//   Port I/O dispatches through the main instance's host_io_port_*
//   exports so the Rust 8259 port intercepts hit the real PIC (io.js has
//   no handlers for those ports); mmap dispatches onto cpu.read*/write*
//   as in (c), keeping the Rust SVGA-LFB leg and the IOAPIC MMIO
//   intercept on THIS instance (per-vCPU workers forward the 0xFEC00000
//   window here);
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
//   DMA/IDE, and the rep-in mailbox leg) as dirty events into EVERY
//   worker's jit inbox (overflow is recovered by the worker's clear-all,
//   so no backlog is needed);
// - runs the device tick (PIT/RTC/ACPI) and aggregates the machine-dead
//   condition from the published run states;
// - drives the §8 command protocol (RUN/PARK/RESET/TERMINATE) for all N
//   workers.
//
// Everything this host has in common with the topology-(c) host — the
// mailbox dispatch, spawn/ready plumbing, timeouts, service loops, and
// the §7/§8 command protocol — lives in smp_host_core.js. Only the (b)
// specifics are below.

import {
    ctl_base_for, ctl_code_bitmap_offset,
    CTL_VCPU_STRIDE, CTL_EOI_RING, CTL_EOI_RING_CAP,
    CTL_PENDING_IRR, CTL_PENDING_TMR,
    CTL_RUN_STATE_PARKED, CTL_RUN_STATE_WAIT_FOR_SIPI,
    CTL_COMMAND_SAVE, CTL_COMMAND_RESTORE,
    ring_pop, doorbell_post, command_write, run_state_read, insn_read,
    jit_inbox_push, pic_pending_set, host_doorbell_word,
} from "./smpctl.js";
import {
    install_smp_host_core,
    SERVICE_REARM_MS, STATE_TIMEOUT_MS, APIC_STRUCT_SIZE, CURRENT_TSC_ADDR,
} from "./smp_host_core.js";

/**
 * @constructor
 * @param {!Object} cpu the main thread's CPU object (device host side)
 * @param {!Object} emulator_bus starter's emulator_bus (bus[1])
 * @param {!WebAssembly.Memory} guest_memory
 * @param {number} total vCPU count == worker count
 */
export function SMPVcpuHost(cpu, emulator_bus, guest_memory, total)
{
    // topology (b): one worker per vCPU
    this.init_core(cpu, emulator_bus, guest_memory, total, total);
    this.ctl_base = ctl_base_for(cpu.memory_size[0]);
    this.host_doorbell = host_doorbell_word(this.ctl_base, total);
    this.host_doorbell_done = null;
    // port I/O goes through the main instance's host_io_port_* exports so
    // the Rust 8259 intercepts hit the AUTHORITATIVE PIC (io.js has no
    // handlers for those ports)
    const exports = cpu.wm.exports;
    this.io = {
        read8: addr => exports["host_io_port_read8"](addr),
        read16: addr => exports["host_io_port_read16"](addr),
        read32: addr => exports["host_io_port_read32"](addr),
        write8: (addr, v) => exports["host_io_port_write8"](addr, v),
        write16: (addr, v) => exports["host_io_port_write16"](addr, v),
        write32: (addr, v) => exports["host_io_port_write32"](addr, v),
    };
}

install_smp_host_core(SMPVcpuHost.prototype);

SMPVcpuHost.prototype.ready_message = "vcpu-ready";

/**
 * @param {!Object} cpu
 */
SMPVcpuHost.prototype.attach_to = function(cpu)
{
    cpu.attach_smp_vcpu_host(this);
};

/**
 * Leave the main instance out of host mode again (ladder step-down back to
 * time-sliced execution on this thread).
 */
SMPVcpuHost.prototype.on_spawn_teardown = function()
{
    this.cpu.wm.exports["set_worker_host"](0);
};

/**
 * The main instance becomes the (b) device host BEFORE any worker can
 * run: from here on, device IRQs raised on this instance route into the
 * shared pending bitmaps instead of the local (guestless) vCPU.
 */
SMPVcpuHost.prototype.before_spawn = function()
{
    this.cpu.wm.exports["set_worker_host"](1);
};

SMPVcpuHost.prototype.before_ready = function()
{
    this.start_host_doorbell_loop();
};

/**
 * @param {number} index
 * @param {!Object} config
 */
SMPVcpuHost.prototype.spawn_payload = function(index, config)
{
    return {
        "wasm_module": config.wasm_module,
        "wasm_source": config.wasm_source,
        "gram_module": config.gram_module,
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
            "memory_model": config.memory_model || "relaxed",
        },
    };
};

/**
 * Acknowledge from the authoritative 8259; while INTR stays asserted
 * (more pending requests), re-post the PIC flag so the BSP worker comes
 * back for the next vector.
 * @return {number}
 */
SMPVcpuHost.prototype.on_pic_ack = function()
{
    const exports = this.cpu.wm.exports;
    const vector = exports["host_pic_acknowledge"]();
    if(exports["host_pic_has_requested"]())
    {
        pic_pending_set(this.i32, this.ctl_base, 0);
        doorbell_post(this.i32, this.ctl_base, 0);
    }
    return vector | 0;
};

SMPVcpuHost.prototype.on_stop_service = function()
{
    Atomics.notify(this.i32, this.host_doorbell);
};

SMPVcpuHost.prototype.on_terminated_wait = async function()
{
    await this.host_doorbell_done;
};

/** Drain the level-EOI rings so the authoritative IOAPIC is current. */
SMPVcpuHost.prototype.after_quiesce = function()
{
    this.drain_notifications();
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

// ---- cross-worker jit-dirty producer (design §9 W3 note) ----

/**
 * The worker-mode leg of cpu.jit_dirty_cache: main-thread JS wrote guest
 * RAM (DMA/IDE/write_blob, or the rep-in mailbox leg), so every worker
 * WITH CODE in those pages must invalidate it. The shared code bitmap
 * gates the post (the Rust post_dirty_page_with twin): a worker without
 * the page's bit has no installed code and no in-flight compile there —
 * bits are set before the compiler reads the page's bytes — so it has
 * nothing to invalidate. The probe is Atomics.or(..., 0), a seq-cst RMW
 * whose release leg publishes the bytes written above; a compiler whose
 * bit-set lands after the probe therefore reads the fresh bytes. Overflow
 * needs no backlog: the flag makes the worker recover with jit_clear_all
 * + full_clear_tlb.
 * @param {number} start_addr
 * @param {number} end_addr exclusive
 */
SMPVcpuHost.prototype.post_jit_dirty = function(start_addr, end_addr)
{
    const memory_size = this.cpu.memory_size[0];
    const first = start_addr >>> 12;
    // the bitmaps cover guest RAM only (the Rust code_bitmap_* guard):
    // pages beyond memory_size never have bits, never arm the peers'
    // dirty-notify slow path, and must not index past the region
    const last = Math.min(end_addr - 1 >>> 12, (memory_size >>> 12) - 1);
    for(let i = 0; i < this.total; i++)
    {
        const bitmap = this.ctl_base + ctl_code_bitmap_offset(this.total, i, memory_size);
        let posted = false;
        for(let page = first; page <= last; page++)
        {
            // >>> — the bitmap region can cross the 2^31 byte boundary
            // at maximum guest-RAM size, where signed >> corrupts the index
            const word = bitmap + 4 * (page >>> 5) >>> 2;
            if(Atomics.or(this.i32, word, 0) & 1 << (page & 31))
            {
                jit_inbox_push(this.i32, this.ctl_base, i, page);
                posted = true;
            }
        }
        if(posted)
        {
            doorbell_post(this.i32, this.ctl_base, i);
        }
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

// ---- Stage W4: save/restore assembly (design §7) ----

/**
 * The §7 save-state assembly, on quiesced workers: each worker drains its
 * in-flight control-region interrupts into its architectural structures
 * (vcpu_worker_sync_for_save), syncs its live block (vcpu_prepare_save,
 * fresh TSC included) and posts its state regions; main writes vCPU block
 * i and LAPIC struct i into ITS OWN instance's regions (same module bytes
 * = identical layout), loads the BSP block into its live block so the
 * per-field state slots read the guest's values, and rebases its TSC on
 * the BSP's saved value. `capture` (today's get_state-based save) runs
 * SYNCHRONOUSLY after one final drain of the pending bitmaps into the
 * assembled LAPIC structs: the device tick keeps running between the
 * awaits of this function, and a vector it posts to a parked worker after
 * that worker's own sync lives only in the control region — dropping it
 * from the image deadlocks a level line (IOAPIC remote_irr set, no LAPIC
 * bit, no EOI ever) and wedges the restored guest.
 * @param {function(): T} capture
 * @return {!Promise<T>}
 * @template T
 */
SMPVcpuHost.prototype.assemble_save = async function(capture)
{
    const messages = await Promise.all(
        Array.from({ length: this.total }, (_, i) => new Promise((resolve, reject) =>
        {
            const timeout = setTimeout(
                () => reject(new Error("vcpu worker " + i + " save-state timed out")),
                STATE_TIMEOUT_MS);
            if(timeout["unref"])
            {
                timeout["unref"]();
            }
            this.save_waiters[i] = m =>
            {
                clearTimeout(timeout);
                resolve(m);
            };
            command_write(this.i32, this.ctl_base, i, CTL_COMMAND_SAVE);
            doorbell_post(this.i32, this.ctl_base, i);
        })));

    const cpu = this.cpu;
    const buffer = cpu.wasm_memory.buffer;
    const vcpu_addr = cpu.get_vcpu_state_addr();
    const vcpu_size = cpu.get_vcpu_state_size();
    const struct_size = vcpu_size / this.total;
    for(let i = 0; i < this.total; i++)
    {
        new Uint8Array(buffer, vcpu_addr + i * struct_size, struct_size)
            .set(messages[i]["vcpu_region"].subarray(i * struct_size, (i + 1) * struct_size));
        new Uint8Array(buffer, cpu.get_apic_addr() + i * APIC_STRUCT_SIZE, APIC_STRUCT_SIZE)
            .set(messages[i]["apics"].subarray(i * APIC_STRUCT_SIZE, (i + 1) * APIC_STRUCT_SIZE));
    }
    // make the BSP's block live on the main instance: get_state's
    // per-field slots then hold the guest's values (and its
    // vcpu_prepare_save call re-syncs the identical bytes)
    cpu.vcpu_finish_restore(0);
    const tsc = new Uint32Array(buffer, CURRENT_TSC_ADDR, 2);
    cpu.set_tsc(tsc[0], tsc[1]);
    // final drain + capture, in one synchronous stretch (no interleaved
    // device tick): xchg every pending bitmap word into the assembled
    // LAPIC irr/tmr (LAPIC irr at i32 words 16..23 of the struct, tmr at
    // 32..39 — the apic.rs layout mirrored by cpu.js set_state_apic)
    for(let i = 0; i < this.total; i++)
    {
        const apic = new Int32Array(buffer, cpu.get_apic_addr() + i * APIC_STRUCT_SIZE,
            APIC_STRUCT_SIZE >> 2);
        for(let word = 0; word < 8; word++)
        {
            const irr = Atomics.exchange(this.i32,
                this.ctl_base + i * CTL_VCPU_STRIDE + CTL_PENDING_IRR + 4 * word >>> 2, 0);
            const tmr = Atomics.exchange(this.i32,
                this.ctl_base + i * CTL_VCPU_STRIDE + CTL_PENDING_TMR + 4 * word >>> 2, 0);
            apic[16 + word] |= irr;
            apic[32 + word] |= tmr;
        }
    }
    return capture();
};

/**
 * The §7 restore distribution, on quiesced workers, after main validated
 * and restored its own instance exactly as today (fail-fast intact): read
 * the restored regions back from the main instance — the same v7 bytes —
 * and send each worker its restore payload; the worker loads the blocks,
 * re-enters its role (clearing its control cells) and acks. Afterwards
 * re-deliver device state the cell-clear may have raced: held IOAPIC lines
 * via reevaluate, an asserting 8259 via a fresh PIC flag.
 * @return {!Promise}
 */
SMPVcpuHost.prototype.distribute_restore = async function()
{
    const cpu = this.cpu;
    // covers cpus=1 images (no trailing vcpu slot: the live block is the
    // only source); for cpus>1 this re-writes identical bytes
    cpu.vcpu_prepare_save();
    const buffer = cpu.wasm_memory.buffer;
    const payload = {
        type: "restore-state",
        "current": cpu.get_current_vcpu(),
        "vcpu_region": new Uint8Array(
            buffer, cpu.get_vcpu_state_addr(), cpu.get_vcpu_state_size()).slice(),
        "apics": new Uint8Array(
            buffer, cpu.get_apic_addr(), this.total * APIC_STRUCT_SIZE).slice(),
        // shared epoch for cross-worker TSC alignment: each worker sets
        // `saved_tsc + (its now − this epoch) × TSC_RATE`, which makes the
        // per-instance tsc_offset identical for all workers no matter when
        // each applies its restore (vcpu_worker.js apply_restore)
        "tsc_epoch": performance.now(),
    };
    await Promise.all(
        Array.from({ length: this.total }, (_, i) => new Promise((resolve, reject) =>
        {
            const timeout = setTimeout(
                () => reject(new Error("vcpu worker " + i + " restore-done timed out")),
                STATE_TIMEOUT_MS);
            if(timeout["unref"])
            {
                timeout["unref"]();
            }
            this.restore_waiters[i] = () =>
            {
                clearTimeout(timeout);
                resolve();
            };
            // payload first, then the command: the worker consumes the
            // queued message when it sees COMMAND_RESTORE
            this.channels[i].post(payload);
            command_write(this.i32, this.ctl_base, i, CTL_COMMAND_RESTORE);
            doorbell_post(this.i32, this.ctl_base, i);
        })));
    // device IRQs posted between main's chipset restore and the workers'
    // control-cell clears would be lost: reevaluate held IOAPIC lines and
    // re-post the PIC flag while INTR is asserted
    const exports = cpu.wm.exports;
    exports["host_chipset_reevaluate"]();
    if(exports["host_pic_has_requested"]())
    {
        pic_pending_set(this.i32, this.ctl_base, 0);
        doorbell_post(this.i32, this.ctl_base, 0);
    }
    this.halt_event_sent = false;
};
