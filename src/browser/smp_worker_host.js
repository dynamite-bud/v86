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
//   DMA/IDE transfers) through the jit-dirty ring, drained by the worker
//   strictly before IRQs;
// - replaces the main thread's guest tick: v86.do_tick now runs only the
//   device timers (PIT/RTC/ACPI — the devices live here) through tick();
//   the worker keeps its own LAPIC timer deadline (§6);
// - drives the §8 command protocol (RUN/PARK/RESET/TERMINATE).
//
// Ring overflow never drops events: the producer keeps an unbounded JS
// backlog and flushes it in order on every tick and after every serviced
// RPC (event order is load-bearing for level-triggered lines).

import { LOG_CPU } from "../const.js";
import { dbg_log } from "../log.js";
import {
    ctl_base_for, ctl_machine_offset,
    CTL_MACHINE_JIT_DIRTY_RING, CTL_MACHINE_DEV_IRQ_RING,
    CTL_JIT_DIRTY_RING_CAP, CTL_DEV_IRQ_RING_CAP, CTL_DEV_IRQ_RAISE_BIT,
    CTL_RING_HEAD, CTL_RING_TAIL,
    CTL_COMMAND_RUN, CTL_COMMAND_PARK_REQ, CTL_COMMAND_PARKED_ACK,
    CTL_COMMAND_TERMINATE, CTL_COMMAND_RESET, CTL_COMMAND_SAVE, CTL_COMMAND_RESTORE,
    ring_push, doorbell_post, command_write, command_read,
    mailbox_record_word, mailbox_service, mailbox_wait_for_request,
    MAILBOX_STATE, MAILBOX_REQUEST, MAILBOX_IDLE,
    MAILBOX_OP_OUT, MAILBOX_OP_IN, MAILBOX_OP_MMAP_READ, MAILBOX_OP_MMAP_WRITE,
    MAILBOX_OP_IN_REP, MAILBOX_OP_OUT_REP,
} from "./smpctl.js";

// re-arm timeout of the mailbox service loop; short enough that stop()
// takes effect promptly, long enough to stay off the hot path
const SERVICE_REARM_MS = 250;
// worker spawn + instantiate deadline before the ladder gives up
const SPAWN_TIMEOUT_MS = 60000;
// deadline for the worker to acknowledge TERMINATE before a hard terminate
const TERMINATE_TIMEOUT_MS = 2000;
// deadline for quiesce acks and state-assembly round trips (design §7)
const STATE_TIMEOUT_MS = 60000;
// struct sizes mirrored from the Rust layouts, as in cpu.js get_state_*
const APIC_STRUCT_SIZE = 4 * 46;
const PIC_STRUCT_SIZE = 13;
const IOAPIC_STRUCT_SIZE = 4 * 52;
// current_tsc global (global_pointers.rs): inside the per-vCPU state block
const CURRENT_TSC_ADDR = 960;

/**
 * Environment adapter around a dedicated worker running vcpu_worker.js:
 * browser `Worker` or Node `worker_threads` (via process.getBuiltinModule,
 * so no import syntax the bundler would have to understand). Shared with
 * the topology-(b) host (smp_vcpu_host.js).
 * @param {string} worker_url
 */
export function spawn_worker(worker_url)
{
    const is_node = typeof process === "object" && typeof process.versions === "object" &&
        typeof process.versions.node === "string" &&
        typeof process["getBuiltinModule"] === "function";
    if(is_node)
    {
        const worker_threads = process["getBuiltinModule"]("node:worker_threads");
        const worker = new worker_threads["Worker"](worker_url);
        // don't keep the Node process alive for the worker alone; the
        // machine's own tick timers do that while the emulator runs
        worker.unref();
        return {
            post: (message, transfer) => worker.postMessage(message, transfer),
            on_message: handler => worker.on("message", handler),
            on_error: handler =>
            {
                worker.on("error", handler);
                worker.on("exit", code =>
                {
                    if(code !== 0)
                    {
                        handler(new Error("vcpu worker exited with code " + code));
                    }
                });
            },
            terminate: () => worker.terminate(),
        };
    }
    const worker = new Worker(worker_url, { "type": "module" });
    return {
        post: (message, transfer) => worker.postMessage(message, transfer),
        on_message: handler => worker.addEventListener("message", e => handler(e.data)),
        on_error: handler => worker.addEventListener("error", e =>
            handler(e.error || new Error(e.message || "vcpu worker error"))),
        terminate: () => worker.terminate(),
    };
}

/**
 * @constructor
 * @param {!Object} cpu the main thread's CPU object (device host side)
 * @param {!Object} emulator_bus starter's emulator_bus (bus[1])
 * @param {!WebAssembly.Memory} guest_memory
 * @param {number} total vCPU count the control region was sized for
 */
export function SMPWorkerHost(cpu, emulator_bus, guest_memory, total)
{
    this.cpu = cpu;
    this.emulator_bus = emulator_bus;
    this.total = total;
    this.i32 = new Int32Array(guest_memory.buffer);
    this.ctl_base = ctl_base_for(cpu.memory_size[0]);
    const machine_base = this.ctl_base + ctl_machine_offset(total);
    this.jit_ring = machine_base + CTL_MACHINE_JIT_DIRTY_RING;
    this.irq_ring = machine_base + CTL_MACHINE_DEV_IRQ_RING;
    this.record = mailbox_record_word(this.ctl_base, 0);
    // unbounded in-order backlogs for ring overflow (see header)
    this.irq_backlog = [];
    this.jit_backlog = [];
    this.channel = null;
    // pre-boot spawn errors reject start() and take the §8 ladder; only
    // errors after machine-ready are fail-stop
    this.ready = false;
    this.stopped = false;
    this.terminating = false;
    this.fatal_error = null;
    // §8 fail-stop: the starter points this at V86.stop so a fatal worker
    // error also halts the main thread's device tick loop
    this.on_fatal = null;
    this.service_done = null;
    this.cpu_exception_hook = function(n) {};
    // resolvers of in-flight COMMAND_SAVE / COMMAND_RESTORE round trips
    this.save_waiter = null;
    this.restore_waiter = null;
    // whether run() was last commanded (quiesce/resume bookkeeping)
    this.commanded_running = false;
    this.rebooting = false;
}

/**
 * Spawn the machine worker, send it the spawn payload, and resolve when the
 * worker reports machine-ready (instantiated, layout-checked, reset, parked
 * on the pre-written PARK_REQ). Rejects on worker error or timeout — the
 * caller decides between fail-stop (`smp_workers: true`) and ladder
 * degradation (`"auto"`).
 * @param {{
 *     worker_url: string,
 *     wasm_source: !ArrayBuffer,
 *     gram_bytes: !ArrayBuffer,
 *     guest_memory: !WebAssembly.Memory,
 *     acpi: boolean,
 *     disable_jit: boolean,
 *     cpuid_level: (number|undefined),
 *     memory_model: (string|undefined),
 * }} config
 * @return {!Promise}
 */
SMPWorkerHost.prototype.start = function(config)
{
    // park the machine until run() — the command word is honored by the
    // worker's very first loop iteration
    command_write(this.i32, this.ctl_base, 0, CTL_COMMAND_PARK_REQ);

    this.channel = spawn_worker(config.worker_url);

    const ready = new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(
            () => reject(new Error("vcpu worker spawn timed out")), SPAWN_TIMEOUT_MS);
        if(timeout["unref"])
        {
            timeout["unref"]();
        }
        this.channel.on_message(m => this.handle_message(m, () =>
        {
            clearTimeout(timeout);
            resolve();
        }));
        this.channel.on_error(e =>
        {
            if(this.terminating)
            {
                // expected shutdown path: a worker being torn down may
                // surface a non-zero exit from the hard terminate racing
                // its own clean close
                return;
            }
            clearTimeout(timeout);
            reject(e);
            if(this.ready)
            {
                this.fail(e);
            }
        });
    });

    this.channel.post({
        "wasm_source": config.wasm_source,
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
    });

    this.start_service_loop();
    return ready.then(() =>
    {
        this.ready = true;
    });
};

/**
 * @param {*} m worker message
 * @param {function()} on_ready
 */
SMPWorkerHost.prototype.handle_message = function(m, on_ready)
{
    if(!m)
    {
        return;
    }
    switch(m["type"])
    {
        case "machine-ready":
            this.machine_ready = true;
            on_ready();
            break;
        case "terminated":
            this.terminated = true;
            break;
        case "save-state":
        {
            const resolve = this.save_waiter;
            this.save_waiter = null;
            resolve && resolve(m);
            break;
        }
        case "restore-done":
        {
            const resolve = this.restore_waiter;
            this.restore_waiter = null;
            resolve && resolve(m);
            break;
        }
        case "log":
            dbg_log(m["message"], LOG_CPU);
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
 * Fail-stop (design §8): a worker error after boot cannot be recovered — a
 * guest does not survive losing its CPU. Surface the error and stop
 * servicing; the machine freezes rather than silently corrupting.
 * @param {!Error} error
 */
SMPWorkerHost.prototype.fail = function(error)
{
    if(this.fatal_error)
    {
        return;
    }
    this.fatal_error = error;
    console.error("smp worker failed:", error);
    this.emulator_bus.send("emulator-error", error);
    this.stop_service_loop();
    // stop the machine (§8): without this the device tick keeps running
    // against a dead guest
    this.on_fatal && this.on_fatal();
};

// ---- mailbox service (device-host side of the §6 RPC protocol) ----

// After a serviced RPC, poll the record synchronously this many times
// before re-arming Atomics.waitAsync: during a burst (a rep-I/O stream, a
// text-mode scroll) the next request lands within a few µs, and the
// waitAsync wake would otherwise add an event-loop round trip to every
// single RPC. The spin is bounded (~tens of µs), so the main thread's
// device ticks are never starved.
const SERVICE_SPIN = 4000;

SMPWorkerHost.prototype.start_service_loop = function()
{
    const i32 = this.i32;
    const record = this.record;
    const dispatch = this.dispatch.bind(this);
    this.service_done = (async () =>
    {
        while(!this.stopped)
        {
            if(mailbox_service(i32, record, dispatch))
            {
                // an RPC may have raised/lowered IRQs synchronously
                // (uart/ps2 reads clear lines): keep the rings flowing
                this.flush_backlogs();
                let spin = SERVICE_SPIN;
                while(spin-- > 0 &&
                    Atomics.load(i32, record + MAILBOX_STATE) !== MAILBOX_REQUEST)
                {
                }
                continue;
            }
            await mailbox_wait_for_request(i32, record, SERVICE_REARM_MS);
        }
    })();
};

SMPWorkerHost.prototype.stop_service_loop = function()
{
    this.stopped = true;
    // wake the pending waitAsync so the loop settles promptly
    Atomics.notify(this.i32, this.record + MAILBOX_STATE);
};

/**
 * One RPC. Dispatches onto the main thread's io.js tables (port I/O) and
 * wasm instance (mmap: read8/write8 & friends keep the Rust SVGA-LFB leg —
 * main owns the vga memory; the worker's Rust intercepts LAPIC/IOAPIC
 * before the RPC, so those windows never arrive here). Wide writes
 * (SIZE 8/16) replay as ordered dword writes — the historical JS
 * mmap_write64/128 dword split. A throwing device handler is answered with
 * 0 so the worker never deadlocks, then surfaced as emulator-error.
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
SMPWorkerHost.prototype.dispatch = function(op, addr, size, value_lo, value_hi, seq, value_2, value_3)
{
    const cpu = this.cpu;
    try
    {
        switch(op)
        {
            case MAILBOX_OP_IN:
                return size === 1 ? cpu.io.port_read8(addr) :
                    size === 2 ? cpu.io.port_read16(addr) :
                    cpu.io.port_read32(addr);
            case MAILBOX_OP_OUT:
                if(size === 1)
                {
                    cpu.io.port_write8(addr, value_lo);
                }
                else if(size === 2)
                {
                    cpu.io.port_write16(addr, value_lo);
                }
                else
                {
                    cpu.io.port_write32(addr, value_lo);
                }
                return undefined;
            case MAILBOX_OP_MMAP_READ:
                return size === 1 ? cpu.read8(addr) :
                    size === 2 ? cpu.read16(addr) :
                    cpu.read32s(addr);
            case MAILBOX_OP_IN_REP:
            {
                // batched rep ins (lock.rs ins_rep_batched): per-element
                // port reads in guest order, results straight into the
                // shared guest RAM. addr = port, size = element width,
                // value_lo = count, value_hi = guest-physical destination.
                const count = value_lo >>> 0;
                const mem8 = cpu.mem8;
                let phys = value_hi >>> 0;
                if(size === 1)
                {
                    for(let i = 0; i < count; i++)
                    {
                        mem8[phys++] = cpu.io.port_read8(addr);
                    }
                }
                else if(size === 2)
                {
                    for(let i = 0; i < count; i++)
                    {
                        const v = cpu.io.port_read16(addr);
                        mem8[phys++] = v & 0xFF;
                        mem8[phys++] = v >> 8 & 0xFF;
                    }
                }
                else
                {
                    for(let i = 0; i < count; i++)
                    {
                        const v = cpu.io.port_read32(addr);
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
                // batched rep outs: the mirror — read the shared guest RAM,
                // write the port per element in guest order
                const count = value_lo >>> 0;
                const mem8 = cpu.mem8;
                let phys = value_hi >>> 0;
                if(size === 1)
                {
                    for(let i = 0; i < count; i++)
                    {
                        cpu.io.port_write8(addr, mem8[phys++]);
                    }
                }
                else if(size === 2)
                {
                    for(let i = 0; i < count; i++)
                    {
                        cpu.io.port_write16(addr, mem8[phys] | mem8[phys + 1] << 8);
                        phys += 2;
                    }
                }
                else
                {
                    for(let i = 0; i < count; i++)
                    {
                        cpu.io.port_write32(addr,
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
        return op === MAILBOX_OP_IN || op === MAILBOX_OP_MMAP_READ ? 0 : undefined;
    }
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
 * RAM (DMA/IDE/write_blob), so the WORKER's JIT cache — the live one — must
 * invalidate those pages. Drained by the worker before IRQ delivery.
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

// ---- command protocol (design §8) ----

SMPWorkerHost.prototype.run = function()
{
    this.commanded_running = true;
    command_write(this.i32, this.ctl_base, 0, CTL_COMMAND_RUN);
    doorbell_post(this.i32, this.ctl_base, 0);
};

SMPWorkerHost.prototype.park = function()
{
    this.commanded_running = false;
    command_write(this.i32, this.ctl_base, 0, CTL_COMMAND_PARK_REQ);
    doorbell_post(this.i32, this.ctl_base, 0);
};

// ---- Stage W4: quiesce, save/restore assembly, quiesced reboot ----
// (docs/smp-phase4-design.md §7/§8; the topology-(c) shape: the single
// machine worker owns vCPUs, LAPICs, PIC and IOAPIC, so state assembly
// carries the whole chipset across, unlike the (b) host, whose main
// instance is chipset-authoritative)

/**
 * @param {string} label
 * @param {function(): boolean} predicate
 * @return {!Promise}
 */
SMPWorkerHost.prototype.wait_for = async function(label, predicate)
{
    const deadline = Date.now() + STATE_TIMEOUT_MS;
    while(!predicate())
    {
        if(this.fatal_error)
        {
            throw this.fatal_error;
        }
        if(Date.now() >= deadline)
        {
            throw new Error("smp quiesce: timeout waiting for " + label);
        }
        await new Promise(resolve => setTimeout(resolve, 2));
    }
};

/**
 * The §7 quiesce for the machine worker: PARK_REQ + doorbell, wait for
 * the PARKED_ACK at the loop boundary and an idle mailbox. The service
 * loop keeps running throughout, so a mid-RPC machine completes the RPC
 * first — no deadlock.
 * @return {!Promise<boolean>} whether the machine was commanded running
 */
SMPWorkerHost.prototype.quiesce = async function()
{
    const was_running = this.commanded_running;
    this.park();
    await this.wait_for("machine worker park ack", () =>
        command_read(this.i32, this.ctl_base, 0) === CTL_COMMAND_PARKED_ACK);
    await this.wait_for("machine worker mailbox idle", () =>
        Atomics.load(this.i32, this.record + MAILBOX_STATE) === MAILBOX_IDLE);
    return was_running;
};

/**
 * @param {boolean} was_running
 */
SMPWorkerHost.prototype.resume = function(was_running)
{
    if(was_running)
    {
        this.run();
    }
};

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
            this.save_waiter = m =>
            {
                clearTimeout(timeout);
                resolve(m);
            };
            command_write(this.i32, this.ctl_base, 0, CTL_COMMAND_SAVE);
            doorbell_post(this.i32, this.ctl_base, 0);
        });
        this.flush_backlogs();
        const rings_empty =
            Atomics.load(this.i32, this.jit_ring + CTL_RING_HEAD >> 2) ===
                Atomics.load(this.i32, this.jit_ring + CTL_RING_TAIL >> 2) &&
            Atomics.load(this.i32, this.irq_ring + CTL_RING_HEAD >> 2) ===
                Atomics.load(this.i32, this.irq_ring + CTL_RING_TAIL >> 2) &&
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
        const head = Atomics.load(this.i32, ring + CTL_RING_HEAD >> 2);
        Atomics.store(this.i32, ring + CTL_RING_TAIL >> 2, head);
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
        this.restore_waiter = () =>
        {
            clearTimeout(timeout);
            resolve();
        };
        // payload first, then the command: the worker consumes the queued
        // message when it sees COMMAND_RESTORE
        this.channel.post(payload);
        command_write(this.i32, this.ctl_base, 0, CTL_COMMAND_RESTORE);
        doorbell_post(this.i32, this.ctl_base, 0);
    });
};

/**
 * Machine reboot (guest reset port / V86.restart), design §8: quiesce,
 * main-side chipset/device reset, worker reset command (the worker resets
 * its instance at the loop boundary and acks by parking; RUN releases it
 * — the same barrier protocol as the (b) host, degenerate with one
 * worker).
 * Fire-and-forget from reboot_internal, which may run inside a mailbox
 * dispatch: the quiesce must not be awaited there, or the triggering
 * worker's pending RPC would deadlock it.
 * @param {function()} reset_main
 * @return {!Promise}
 */
SMPWorkerHost.prototype.reboot = async function(reset_main)
{
    if(this.rebooting || this.fatal_error)
    {
        return;
    }
    this.rebooting = true;
    try
    {
        const was_running = await this.quiesce();
        reset_main();
        command_write(this.i32, this.ctl_base, 0, CTL_COMMAND_RESET);
        doorbell_post(this.i32, this.ctl_base, 0);
        await this.wait_for("machine worker reset ack", () =>
            command_read(this.i32, this.ctl_base, 0) === CTL_COMMAND_PARKED_ACK);
        if(was_running)
        {
            this.run();
        }
    }
    finally
    {
        this.rebooting = false;
    }
};

/**
 * Quiesce and tear down: TERMINATE + doorbell, wait briefly for the ack,
 * then hard-terminate the worker and stop the service loop.
 * @return {!Promise}
 */
SMPWorkerHost.prototype.terminate = async function()
{
    this.terminating = true;
    command_write(this.i32, this.ctl_base, 0, CTL_COMMAND_TERMINATE);
    doorbell_post(this.i32, this.ctl_base, 0);
    const deadline = Date.now() + TERMINATE_TIMEOUT_MS;
    while(!this.terminated && Date.now() < deadline)
    {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.stop_service_loop();
    await this.service_done;
    this.channel && this.channel.terminate();
};
