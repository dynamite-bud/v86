// XWAH-9 Phase 4 Stage W2: the device host of worker mode
// (docs/smp-phase4-design.md §9 W2, topology (c)). The whole machine's
// vCPUs run inside ONE worker (src/browser/vcpu_worker.js); the main
// thread — this module — keeps the full V86 construction (devices, io.js,
// bus, its own wasm instance) but never executes guest code. It:
//
// - services the worker's blocking io_port_*/mmap_* mailbox RPCs on an
//   Atomics.waitAsync loop (the Layer A protocol, smpctl.js) against the
//   main thread's io.js tables and wasm instance (whose read8/write8 leg
//   also covers the SVGA LFB fast path — main owns the vga memory);
// - forwards device_raise_irq/device_lower_irq as ordered events on the
//   shared device-IRQ ring + doorbell (the (c) wire: the WORKER instance
//   owns PIC+IOAPIC+LAPICs and replays the events into its own
//   device_raise_irq at its loop boundary — the reentrancy hazard of a DOM
//   event mutating guest state mid-instruction is gone);
// - forwards JS-side guest-RAM invalidations (cpu.write_blob during
//   DMA/IDE transfers, and the rep-in mailbox leg) through the jit-dirty
//   ring, drained by the worker strictly before IRQs;
// - replaces the main thread's guest tick: v86.do_tick now runs only the
//   device timers (PIT/RTC/ACPI — the devices live here) through tick();
//   the worker keeps its own LAPIC timer deadline (§6);
// - drives the §8 command protocol (RUN/PARK/RESET/TERMINATE).
//
// Ring overflow never drops events: the producer keeps an unbounded JS
// backlog and flushes it in order on every tick and after every serviced
// RPC (event order is load-bearing for level-triggered lines).
//
// Everything this host has in common with the topology-(b) host — the
// mailbox dispatch, spawn/ready plumbing, timeouts, service loops, and
// the §7/§8 command protocol — lives in smp_host_core.js. Only the (c)
// specifics are below.

import {
    ctl_base_for, ctl_machine_offset,
    CTL_MACHINE_JIT_DIRTY_RING, CTL_MACHINE_DEV_IRQ_RING,
    CTL_JIT_DIRTY_RING_CAP, CTL_DEV_IRQ_RING_CAP, CTL_DEV_IRQ_RAISE_BIT,
    CTL_RING_HEAD, CTL_RING_TAIL,
    CTL_COMMAND_SAVE, CTL_COMMAND_RESTORE,
    ring_push, doorbell_post, command_write,
    mailbox_record_word,
} from "./smpctl.js";
import {
    install_smp_host_core, spawn_worker,
    STATE_TIMEOUT_MS, APIC_STRUCT_SIZE, PIC_STRUCT_SIZE, IOAPIC_STRUCT_SIZE,
    CURRENT_TSC_ADDR,
} from "./smp_host_core.js";

export { spawn_worker };

/**
 * @constructor
 * @param {!Object} cpu the main thread's CPU object (device host side)
 * @param {!Object} emulator_bus starter's emulator_bus (bus[1])
 * @param {!WebAssembly.Memory} guest_memory
 * @param {number} total vCPU count the control region was sized for
 */
export function SMPWorkerHost(cpu, emulator_bus, guest_memory, total)
{
    // topology (c) is ONE worker no matter how many vCPUs it time-slices
    this.init_core(cpu, emulator_bus, guest_memory, total, 1);
    this.ctl_base = ctl_base_for(cpu.memory_size[0]);
    const machine_base = this.ctl_base + ctl_machine_offset(total);
    this.jit_ring = machine_base + CTL_MACHINE_JIT_DIRTY_RING;
    this.irq_ring = machine_base + CTL_MACHINE_DEV_IRQ_RING;
    this.record = mailbox_record_word(this.ctl_base, 0);
    // unbounded in-order backlogs for ring overflow (see header)
    this.irq_backlog = [];
    this.jit_backlog = [];
    this.channel = null;
    // port I/O dispatches onto io.js: in (c) the WORKER instance owns the
    // whole chipset, so main's tables are the only device models
    this.io = {
        read8: addr => cpu.io.port_read8(addr),
        read16: addr => cpu.io.port_read16(addr),
        read32: addr => cpu.io.port_read32(addr),
        write8: (addr, v) => cpu.io.port_write8(addr, v),
        write16: (addr, v) => cpu.io.port_write16(addr, v),
        write32: (addr, v) => cpu.io.port_write32(addr, v),
    };
}

install_smp_host_core(SMPWorkerHost.prototype);

SMPWorkerHost.prototype.ready_message = "machine-ready";

/**
 * @param {!Object} cpu
 */
SMPWorkerHost.prototype.attach_to = function(cpu)
{
    cpu.attach_smp_worker_host(this);
};

/** worker-failure.js and the starter reach the single channel by name. */
SMPWorkerHost.prototype.on_channel = function(index, channel)
{
    this.channel = channel;
};

/**
 * @param {number} index
 * @param {!Object} config
 */
SMPWorkerHost.prototype.spawn_payload = function(index, config)
{
    return {
        "wasm_module": config.wasm_module,
        "wasm_source": config.wasm_source,
        "gram_module": config.gram_module,
        "gram_bytes": config.gram_bytes,
        "guest_memory": config.guest_memory,
        "index": 0,
        "total": this.total,
        "main_time_origin": performance.timeOrigin,
        "memory_size": this.cpu.memory_size[0],
        "machine": {
            "acpi": !!config.acpi,
            "disable_jit": !!config.disable_jit,
            "cpuid_level": config.cpuid_level || 0,
            "memory_model": config.memory_model || "relaxed",
        },
    };
};

/** An RPC may have raised/lowered IRQs synchronously: keep rings flowing. */
SMPWorkerHost.prototype.after_service = function()
{
    this.flush_backlogs();
};

// ---- ring producers (device host -> machine worker) ----

SMPWorkerHost.prototype.flush_backlogs = function()
{
    let posted = false;
    while(this.jit_backlog.length &&
        ring_push(this.i32, this.jit_ring, CTL_JIT_DIRTY_RING_CAP, this.jit_backlog[0]))
    {
        this.jit_backlog.shift();
        posted = true;
    }
    while(this.irq_backlog.length &&
        ring_push(this.i32, this.irq_ring, CTL_DEV_IRQ_RING_CAP, this.irq_backlog[0]))
    {
        this.irq_backlog.shift();
        posted = true;
    }
    if(posted)
    {
        doorbell_post(this.i32, this.ctl_base, 0);
    }
};

/**
 * The worker-mode leg of cpu.device_raise_irq/device_lower_irq (wired by
 * CPU.attach_smp_worker_host): post the event, in order, and ring the
 * doorbell. The main instance's own wasm device_raise_irq must NOT run —
 * no guest executes on the main thread.
 * @param {number} irq
 * @param {boolean} raise
 */
SMPWorkerHost.prototype.post_irq = function(irq, raise)
{
    const event = irq & 0xFF | (raise ? CTL_DEV_IRQ_RAISE_BIT : 0);
    if(this.irq_backlog.length ||
        !ring_push(this.i32, this.irq_ring, CTL_DEV_IRQ_RING_CAP, event))
    {
        this.irq_backlog.push(event);
    }
    doorbell_post(this.i32, this.ctl_base, 0);
};

/**
 * The worker-mode leg of cpu.jit_dirty_cache: main-thread JS wrote guest
 * RAM (DMA/IDE/write_blob, or the rep-in mailbox leg), so the WORKER's JIT
 * cache — the live one — must invalidate those pages. Drained by the
 * worker before IRQ delivery.
 * @param {number} start_addr
 * @param {number} end_addr exclusive
 */
SMPWorkerHost.prototype.post_jit_dirty = function(start_addr, end_addr)
{
    const first = start_addr >>> 12;
    const last = end_addr - 1 >>> 12;
    for(let page = first; page <= last; page++)
    {
        if(this.jit_backlog.length ||
            !ring_push(this.i32, this.jit_ring, CTL_JIT_DIRTY_RING_CAP, page))
        {
            this.jit_backlog.push(page);
        }
    }
    doorbell_post(this.i32, this.ctl_base, 0);
};

// ---- the device tick (v86.do_tick's worker-mode body) ----

/**
 * Replaces cpu.main_loop on the device host: flush the rings and run the
 * main-side hardware timers — PIT/RTC/ACPI live here and fire through
 * cpu.device_raise_irq, i.e. through post_irq above. The worker returns its
 * own LAPIC deadline from its worker-local run_hardware_timers (§6).
 * @return {number} ms until the next device-timer deadline
 */
SMPWorkerHost.prototype.tick = function()
{
    this.flush_backlogs();
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
    this.flush_backlogs();
    return t;
};

// ---- Stage W4: save/restore assembly (design §7) ----
// (the topology-(c) shape: the single machine worker owns vCPUs, LAPICs,
// PIC and IOAPIC, so state assembly carries the whole chipset across,
// unlike the (b) host, whose main instance is chipset-authoritative)

/**
 * The §7 save-state assembly on the quiesced machine worker: the worker
 * drains the shared rings into its chipset, syncs its live block, and
 * posts its whole state — vCPU region, all LAPICs, PIC, IOAPIC (in (c)
 * the worker owns the entire chipset); main writes everything into ITS
 * OWN instance's regions, loads the current vCPU's block into its live
 * block and rebases its TSC on the saved value, then runs `capture`
 * (today's get_state-based save) SYNCHRONOUSLY. The SAVE round trip
 * repeats while the rings are non-empty at message receipt: the device
 * tick keeps running between the awaits of this function, and a
 * raise/lower it posts after the worker's drain lives only in the ring —
 * dropping it from the image would leave a device asserted with a chipset
 * that never saw the line (a lost virtio INTx wedges the restored guest's
 * 9p root, found empirically).
 * @param {function(): T} capture
 * @return {!Promise<T>}
 * @template T
 */
SMPWorkerHost.prototype.assemble_save = async function(capture)
{
    let message;
    for(;;)
    {
        message = await new Promise((resolve, reject) =>
        {
            const timeout = setTimeout(
                () => reject(new Error("machine worker save-state timed out")),
                STATE_TIMEOUT_MS);
            if(timeout["unref"])
            {
                timeout["unref"]();
            }
            this.save_waiters[0] = m =>
            {
                clearTimeout(timeout);
                resolve(m);
            };
            command_write(this.i32, this.ctl_base, 0, CTL_COMMAND_SAVE);
            doorbell_post(this.i32, this.ctl_base, 0);
        });
        this.flush_backlogs();
        const rings_empty =
            Atomics.load(this.i32, this.jit_ring + CTL_RING_HEAD >>> 2) ===
                Atomics.load(this.i32, this.jit_ring + CTL_RING_TAIL >>> 2) &&
            Atomics.load(this.i32, this.irq_ring + CTL_RING_HEAD >>> 2) ===
                Atomics.load(this.i32, this.irq_ring + CTL_RING_TAIL >>> 2) &&
            this.jit_backlog.length === 0 && this.irq_backlog.length === 0;
        if(rings_empty)
        {
            break;
        }
        // events landed after the worker's drain: wake it (the parked
        // loop drains on every wake) and take a fresh snapshot
    }

    const cpu = this.cpu;
    const buffer = cpu.wasm_memory.buffer;
    new Uint8Array(buffer, cpu.get_vcpu_state_addr(), cpu.get_vcpu_state_size())
        .set(message["vcpu_region"]);
    new Uint8Array(buffer, cpu.get_apic_addr(), this.total * APIC_STRUCT_SIZE)
        .set(message["apics"]);
    new Uint8Array(buffer, cpu.get_pic_addr_master(), PIC_STRUCT_SIZE)
        .set(message["pic_master"]);
    new Uint8Array(buffer, cpu.get_pic_addr_slave(), PIC_STRUCT_SIZE)
        .set(message["pic_slave"]);
    new Uint8Array(buffer, cpu.get_ioapic_addr(), IOAPIC_STRUCT_SIZE)
        .set(message["ioapic"]);
    cpu.vcpu_finish_restore(message["current"]);
    const tsc = new Uint32Array(buffer, CURRENT_TSC_ADDR, 2);
    cpu.set_tsc(tsc[0], tsc[1]);
    // capture in the same synchronous stretch as the final ring check
    return capture();
};

/**
 * Reset the shared rings while the worker is parked: events queued before
 * the quiesce belong to the pre-restore machine and must not replay into
 * restored chipset state. Safe here — the consumer is parked and the
 * producer (this thread) clears its backlogs in the same breath.
 */
SMPWorkerHost.prototype.clear_rings = function()
{
    this.irq_backlog.length = 0;
    this.jit_backlog.length = 0;
    for(const ring of [this.jit_ring, this.irq_ring])
    {
        const head = Atomics.load(this.i32, ring + CTL_RING_HEAD >>> 2);
        Atomics.store(this.i32, ring + CTL_RING_TAIL >>> 2, head);
    }
};

/**
 * The §7 restore distribution to the quiesced machine worker, after main
 * validated and restored its own instance exactly as today: read the
 * restored regions back from the main instance and send the worker its
 * restore payload (whole machine, chipset included); the worker loads the
 * blocks and acks.
 * @return {!Promise}
 */
SMPWorkerHost.prototype.distribute_restore = async function()
{
    const cpu = this.cpu;
    // covers cpus=1 images (no trailing vcpu slot: the live block is the
    // only source); for cpus>1 this re-writes identical bytes
    cpu.vcpu_prepare_save();
    this.clear_rings();
    const buffer = cpu.wasm_memory.buffer;
    const payload = {
        type: "restore-state",
        "current": cpu.get_current_vcpu(),
        "vcpu_region": new Uint8Array(
            buffer, cpu.get_vcpu_state_addr(), cpu.get_vcpu_state_size()).slice(),
        "apics": new Uint8Array(
            buffer, cpu.get_apic_addr(), this.total * APIC_STRUCT_SIZE).slice(),
        "pic_master": new Uint8Array(
            buffer, cpu.get_pic_addr_master(), PIC_STRUCT_SIZE).slice(),
        "pic_slave": new Uint8Array(
            buffer, cpu.get_pic_addr_slave(), PIC_STRUCT_SIZE).slice(),
        "ioapic": new Uint8Array(
            buffer, cpu.get_ioapic_addr(), IOAPIC_STRUCT_SIZE).slice(),
    };
    await new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(
            () => reject(new Error("machine worker restore-done timed out")),
            STATE_TIMEOUT_MS);
        if(timeout["unref"])
        {
            timeout["unref"]();
        }
        this.restore_waiters[0] = () =>
        {
            clearTimeout(timeout);
            resolve();
        };
        // payload first, then the command: the worker consumes the queued
        // message when it sees COMMAND_RESTORE
        this.channels[0].post(payload);
        command_write(this.i32, this.ctl_base, 0, CTL_COMMAND_RESTORE);
        doorbell_post(this.i32, this.ctl_base, 0);
    });
};
