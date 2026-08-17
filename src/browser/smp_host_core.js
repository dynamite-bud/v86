// XWAH-9 Phase 4: the device-host core shared by BOTH worker topologies
// (docs/smp-phase4-design.md §6/§7/§8).
//
// smp_worker_host.js (topology (c): the whole machine in one worker) and
// smp_vcpu_host.js (topology (b): one worker per vCPU) were near-verbatim
// clones of each other — the same ~140-line mailbox dispatch switch, the
// same spawn/ready plumbing, timeouts, handle_message, service loops, and
// the same §7/§8 command protocol. They had already drifted: the (c)
// dispatch's catch answered IN_REP/OUT_REP with `undefined` while the (b)
// one answered 0, which silently turned a failed rep-I/O batch into a
// "fully transferred" one for the guest. Everything that can drift now
// lives HERE, exactly once; the two hosts keep only what genuinely differs
// between the topologies.
//
// What a host must supply (see install_smp_host_core below):
//
// - `this.workers`   — number of spawned workers (N for (b), 1 for (c)).
//                      Every command-protocol loop iterates over this, NOT
//                      over the vCPU count, which is `this.total` and is
//                      only a control-region layout input.
// - `this.io`        — the port-I/O primitive the mailbox dispatches onto:
//                      {read8,read16,read32,write8,write16,write32}. (b)
//                      routes through the main instance's host_io_port_*
//                      exports so the Rust 8259 intercepts hit the
//                      authoritative PIC; (c) routes through io.js, whose
//                      worker instance owns the whole chipset.
// - `spawn_payload(index, config)` — the per-topology worker spawn message.
// - `ready_message`  — "vcpu-ready" (b) / "machine-ready" (c).
// - `post_jit_dirty(start_addr, end_addr)` — already implemented by both;
//                      the shared dispatch calls it after landing rep-in
//                      bytes in guest RAM.
// - optional hooks: `on_pic_ack()` ((b) only), `after_service()` ((c)
//                      flushes its ring backlogs), `after_quiesce()` ((b)
//                      drains the level-EOI rings), `on_stop_service()`.

import { LOG_CPU } from "../const.js";
import { dbg_log } from "../log.js";
import {
    doorbell_post, command_write, command_read,
    mailbox_record_word, mailbox_service, mailbox_wait_for_request,
    MAILBOX_STATE, MAILBOX_REQUEST, MAILBOX_IDLE,
    CTL_COMMAND_RUN, CTL_COMMAND_PARK_REQ, CTL_COMMAND_PARKED_ACK,
    CTL_COMMAND_TERMINATE, CTL_COMMAND_RESET,
    MAILBOX_OP_OUT, MAILBOX_OP_IN, MAILBOX_OP_MMAP_READ, MAILBOX_OP_MMAP_WRITE,
    MAILBOX_OP_IN_REP, MAILBOX_OP_OUT_REP, MAILBOX_OP_PIC_ACK,
} from "./smpctl.js";

// re-arm timeout of the service loops; short enough that stop() takes
// effect promptly, long enough to stay off the hot path
export const SERVICE_REARM_MS = 250;
// worker spawn + instantiate deadline before the ladder gives up
export const SPAWN_TIMEOUT_MS = 60000;
// deadline for the workers to acknowledge TERMINATE before a hard terminate
export const TERMINATE_TIMEOUT_MS = 2000;
// deadline for quiesce acks and state-assembly round trips (design §7): a
// worker parks within one slice (ms-scale); anything near this bound is a
// dead worker, which is fail-stop
export const STATE_TIMEOUT_MS = 60000;
// After a serviced RPC, poll the record synchronously this many times
// before re-arming Atomics.waitAsync: during a burst (a rep-I/O stream, a
// text-mode scroll) the next request lands within a few µs, and the
// waitAsync wake would otherwise add an event-loop round trip to every
// single RPC. The spin is bounded (~tens of µs), so the main thread's
// device ticks are never starved.
export const SERVICE_SPIN = 4000;

// ---- XWAH-37: index/data register pairs across workers ----
//
// An index/data register pair is two addresses where the first selects
// which register the second one names: the guest writes the index, then
// accesses the data window. That is TWO guest instructions, and under
// worker-per-vCPU execution each of them forwards to this host as its own
// independent mailbox RPC. Nothing keeps the two halves of one worker's
// pair adjacent, so two workers interleave:
//
//     worker A: write index = entry_1_low
//     worker B: write index = entry_7_low     <-- clobbers A's index
//     worker A: write data  = <A's value>     <-- lands in entry 7
//
// The observable result is a register programmed with another register's
// data. For the IOAPIC that is a redirection entry carrying a foreign
// vector — e.g. unmasked with vector 0, which trips the "Invalid vector"
// assert in apic.rs on the next device IRQ, and in a release build
// silently misroutes the line instead.
//
// The fix is to make the pair atomic per requester rather than to lock the
// host: this host remembers the index each worker last wrote, and re-writes
// that index immediately before servicing that worker's data access. Both
// halves then happen inside ONE synchronous dispatch, which no other
// worker's RPC can split. It removes the interleaving window instead of
// narrowing it, and needs no cross-worker blocking — a worker that writes
// an index and then parks (or is saved) before its data access holds no
// lock and stalls nobody.
//
// This gives each worker its own effective index register, where real
// hardware has one shared one. A guest that serializes its own pair
// accesses — Linux holds `ioapic_lock`, `rtc_lock`, `pci_config_lock` for
// exactly this reason — cannot tell the difference: under its own lock the
// index it reads back is always the one it wrote. Only a guest that
// deliberately sets an index on one CPU and reads the data window from
// another observes the change, and that sequence is already a data race on
// real hardware.
//
// Engages only with two or more workers: with one worker no interleaving
// exists, so topology (c) and a single-vCPU (b) machine keep byte-for-byte
// the device-access sequence they had before.
//
// AUDIT of the other index/data pairs reachable over the mailbox
// (docs/multicore.md "Known limitations" carries the same table):
//
// - IOAPIC IOREGSEL/IOWIN (MMIO 0xFEC00000/+0x10) — SERIALIZED here. The
//   index write is a bare field store (ioapic.rs write32_internal), so
//   replaying it has no side effect of its own.
// - CMOS/RTC 0x70/0x71 — SERIALIZED here. Port 0x70's handler stores
//   `cmos_index` and `nmi_disabled` and nothing else (rtc.js), and
//   `nmi_disabled` is never read back by the emulator, so a replay is a
//   pure index restore.
// - PCI CF8/CFC — NOT serialized: replaying the config address is not
//   side-effect free. pci.js routes the 0xCF9 reset control register
//   through byte 1 of the CF8 window, so a replay can reach
//   `cpu.reboot_internal()` on an address transition the guest never made.
//   Needs the index carried with the data access instead of replayed.
// - VGA attribute controller 0x3C0 — NOT an index/data pair: one port that
//   alternates index and data through a flip-flop (reset by reading
//   0x3DA). A replay would flip the flop, so this needs its own mechanism.
// - VGA DAC 0x3C8/0x3C9 — NOT serializable this way: the data port
//   auto-advances a sub-index across the three palette bytes, so replaying
//   0x3C8 mid-triple would restart the colour.
// - VGA CRTC/sequencer/graphics 0x3D4, 0x3C4, 0x3CE and SB16 mixer 0x224 —
//   structurally exposed, but every driver programs them from one CPU, and
//   the common 16-bit `outw` form already crosses as a single RPC. Left
//   alone rather than paying a replay on the display path.
//
// The three that need a different mechanism are filed as follow-ups rather
// than forced into this one.
export const IOAPIC_MEM_ADDRESS = 0xFEC00000; // cpu.rs IOAPIC_MEM_ADDRESS
export const IOAPIC_IOREGSEL = 0;
export const IOAPIC_IOWIN = 0x10;
export const CMOS_INDEX_PORT = 0x70;
export const CMOS_DATA_PORT = 0x71;
// one shadow slot per (worker, pair); -1 = this worker has not written
// this pair's index yet, so its data accesses stay on the historical path
export const PAIR_IOAPIC = 0;
export const PAIR_CMOS = 1;
export const PAIR_COUNT = 2;

// struct sizes mirrored from the Rust layouts, as in cpu.js get_state_*
export const APIC_STRUCT_SIZE = 4 * 46;
export const PIC_STRUCT_SIZE = 13;
export const IOAPIC_STRUCT_SIZE = 4 * 52;
// current_tsc global (global_pointers.rs): lives inside the per-vCPU state
// block, so a loaded save area carries the saved TSC
export const CURRENT_TSC_ADDR = 960;

/**
 * Environment adapter around a dedicated worker running vcpu_worker.js:
 * browser `Worker` or Node `worker_threads` (via process.getBuiltinModule,
 * so no import syntax the bundler would have to understand).
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
 * Install the shared core onto a host prototype.
 * @param {!Object} proto
 */
export function install_smp_host_core(proto)
{

/**
 * Shared constructor body.
 * @param {!Object} cpu the main thread's CPU object (device host side)
 * @param {!Object} emulator_bus starter's emulator_bus (bus[1])
 * @param {!WebAssembly.Memory} guest_memory
 * @param {number} total vCPU count (control-region layout input)
 * @param {number} workers number of spawned workers
 * @this {!Object}
 */
proto.init_core = function(cpu, emulator_bus, guest_memory, total, workers)
{
    this.cpu = cpu;
    this.emulator_bus = emulator_bus;
    this.total = total;
    this.workers = workers;
    this.i32 = new Int32Array(guest_memory.buffer);
    this.channels = [];
    // pre-boot spawn errors reject start() and take the §8 ladder; only
    // errors after every worker is ready are fail-stop
    this.ready = false;
    this.stopped = false;
    this.terminating = false;
    this.terminated_count = 0;
    this.fatal_error = null;
    // §8 fail-stop: the starter points this at V86.stop so a fatal worker
    // error also halts the main thread's device tick loop
    this.on_fatal = null;
    this.service_done = [];
    this.commanded_running = false;
    this.halt_event_sent = false;
    this.cpu_exception_hook = function(n) {};
    // per-worker resolvers of in-flight COMMAND_SAVE / COMMAND_RESTORE
    // round trips (design §7), keyed by worker index
    this.save_waiters = [];
    this.restore_waiters = [];
    // fix: one in-flight lifecycle operation at a time (see lifecycle)
    this.lifecycle_chain = Promise.resolve();
    // a reboot already queued or in flight coalesces further requests
    this.rebooting = false;
    // XWAH-37: per-worker last-written index of each index/data register
    // pair, -1 until that worker writes one
    this.index_shadow = new Int32Array(workers * PAIR_COUNT).fill(-1);
};

/**
 * Drop every remembered index (XWAH-37). Called wherever the devices
 * behind the pairs are reset or replaced wholesale — after a reboot's
 * chipset reset and after a state restore — so a stale pre-reset index can
 * never be replayed into a freshly programmed device. Dropping a shadow is
 * always safe: it only returns that worker to the historical path, where
 * its data access uses whatever index the device currently holds, and
 * every guest writes the index again before its next data access anyway.
 * @this {!Object}
 */
proto.forget_index_shadows = function()
{
    this.index_shadow.fill(-1);
};

/**
 * Re-establish this worker's index before its data access, so an
 * index/data pair cannot be split by another worker's RPC (XWAH-37; the
 * audit and the reasoning are above the pair constants).
 *
 * Runs inside dispatch's try, before the op itself: a replay goes through
 * the same primitive the op would use, so a throwing device handler is
 * reported and answered exactly like a throwing op.
 * @param {number} requester worker index the RPC came from
 * @param {number} op
 * @param {number} addr address for the mmap ops, port for the I/O ops
 * @param {number} size
 * @param {number} value
 * @this {!Object}
 */
proto.sync_index_pair = function(requester, op, addr, size, value)
{
    const shadow = this.index_shadow;

    if(op === MAILBOX_OP_MMAP_READ || op === MAILBOX_OP_MMAP_WRITE)
    {
        // Only the widths memory.rs routes into the IOAPIC reach the
        // register file at all: write32, and read8/read32s (an 8-bit read
        // is byte-extracted from the dword the selector names, which is why
        // the register is masked to its dword below). Every other width
        // falls through to the JS memory map without touching the device,
        // so it must neither move nor consult the shadow.
        if(op === MAILBOX_OP_MMAP_WRITE ? size !== 4 : size !== 1 && size !== 4)
        {
            return;
        }
        const reg = (addr >>> 0) - IOAPIC_MEM_ADDRESS & ~3;
        const slot = requester * PAIR_COUNT + PAIR_IOAPIC;
        if(reg === IOAPIC_IOREGSEL && op === MAILBOX_OP_MMAP_WRITE)
        {
            // the guest is selecting a register: this IS the index write,
            // so record it and let it through unchanged
            shadow[slot] = value;
        }
        else if(reg === IOAPIC_IOWIN || reg === IOAPIC_IOREGSEL)
        {
            const index = shadow[slot];
            if(index !== -1)
            {
                this.cpu.write32(IOAPIC_MEM_ADDRESS + IOAPIC_IOREGSEL | 0, index);
            }
        }
        return;
    }

    // Same rule on the port side: rtc.js registers only 8-bit handlers for
    // 0x70 and 0x71, and io.js leaves the wider entries of every port at
    // empty_port_write / empty_port_read, so a 16- or 32-bit access to
    // either port is a no-op that must not move or consult the shadow
    // either. The rep ops carry their ELEMENT width here, so a batched
    // insb/outsb — which does reach the byte handlers — passes this test
    // for the same reason a plain one does.
    if(size !== 1)
    {
        return;
    }
    const slot = requester * PAIR_COUNT + PAIR_CMOS;
    if(addr === CMOS_INDEX_PORT)
    {
        if(op === MAILBOX_OP_OUT)
        {
            shadow[slot] = value & 0xFF;
        }
        else if(op === MAILBOX_OP_OUT_REP)
        {
            // a batched `rep outsb` to the index port ends on a byte this
            // host never sees as a value: forget the index rather than
            // replay a stale one, which only returns this worker to the
            // historical path
            shadow[slot] = -1;
        }
        return;
    }
    if(addr !== CMOS_DATA_PORT)
    {
        return;
    }
    const index = shadow[slot];
    if(index !== -1)
    {
        this.io.write8(CMOS_INDEX_PORT, index);
    }
};

/**
 * Serialize the lifecycle operations — save, restore, reboot, destroy —
 * behind a single in-flight chain.
 *
 * They all drive the SAME command word per worker (PARK_REQ -> SAVE /
 * RESTORE / RESET -> RUN) and the same per-worker message waiters, so two
 * of them overlapping is a corruption, not a race to tolerate: a reboot
 * that arrives while a save is between its quiesce and its capture used
 * to overwrite the SAVE command with RESET, and the save's waiter would
 * then hang until its 60 s deadline (or, worse, resolve against a worker
 * that had already reset, producing an image of a rebooted machine).
 * Guest-triggered reboots are exactly this case: reboot_internal fires
 * from inside a mailbox dispatch, i.e. from a device access the guest can
 * make at any moment, including while an embedder's save_state is in
 * flight.
 *
 * A rejection never poisons the chain — the next operation runs either
 * way; only ordering is enforced.
 * @param {function(): !Promise<T>} fn
 * @return {!Promise<T>}
 * @template T
 * @this {!Object}
 */
proto.lifecycle = function(fn)
{
    const next = this.lifecycle_chain.then(fn, fn);
    this.lifecycle_chain = next.then(function() {}, function() {});
    return next;
};

/**
 * Spawn every worker, send each its payload, and resolve when all report
 * ready. Rejects on any worker error or timeout — the caller decides
 * between fail-stop (`smp_workers: true`) and ladder degradation ("auto").
 * @param {!Object} config
 * @return {!Promise}
 * @this {!Object}
 */
proto.start = function(config)
{
    // park every worker until run() — honored by each worker's very first
    // loop iteration
    for(let i = 0; i < this.workers; i++)
    {
        command_write(this.i32, this.ctl_base, i, CTL_COMMAND_PARK_REQ);
    }

    this.before_spawn && this.before_spawn();

    const readies = [];
    for(let index = 0; index < this.workers; index++)
    {
        const channel = spawn_worker(config.worker_url);
        this.channels.push(channel);
        this.on_channel && this.on_channel(index, channel);
        readies.push(new Promise((resolve, reject) =>
        {
            const timeout = setTimeout(
                () => reject(new Error("vcpu worker " + index + " spawn timed out")),
                SPAWN_TIMEOUT_MS);
            if(timeout["unref"])
            {
                timeout["unref"]();
            }
            // `index` is closed over per channel: workers do not put their
            // index in every message (logs in particular), so this is the
            // only place the attribution exists
            channel.on_message(m => this.handle_message(m, index, () =>
            {
                clearTimeout(timeout);
                resolve();
            }, reject));
            channel.on_error(e =>
            {
                if(this.terminating)
                {
                    // expected shutdown path: a worker being torn down may
                    // surface a non-zero exit from the hard terminate
                    // racing its own clean close
                    return;
                }
                clearTimeout(timeout);
                reject(e);
                if(this.ready)
                {
                    this.fail(e);
                }
            });
        }));
        channel.post(this.spawn_payload(index, config));
    }

    for(let i = 0; i < this.workers; i++)
    {
        this.start_service_loop(i);
    }
    this.before_ready && this.before_ready();
    return Promise.all(readies).then(() =>
    {
        this.ready = true;
    });
};

/**
 * @param {*} m worker message
 * @param {number} index worker index this channel belongs to
 * @param {function()} on_ready
 * @param {function(!Error)} on_spawn_error rejects the spawn promise
 * @this {!Object}
 */
proto.handle_message = function(m, index, on_ready, on_spawn_error)
{
    if(!m)
    {
        return;
    }
    switch(m["type"])
    {
        case this.ready_message:
            on_ready();
            break;
        case "terminated":
            this.terminated_count++;
            break;
        case "save-state":
        {
            const resolve = this.save_waiters[index];
            this.save_waiters[index] = null;
            resolve && resolve(m);
            break;
        }
        case "restore-done":
        {
            const resolve = this.restore_waiters[index];
            this.restore_waiters[index] = null;
            resolve && resolve(m);
            break;
        }
        case "log":
            dbg_log("vcpu" + index + ": " + m["message"], LOG_CPU);
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
        {
            const error = new Error("vcpu worker " + m["type"] + ": " +
                (m["message"] || "") + "\n" + (m["stack"] || ""));
            // Gate on readiness exactly like the channel's on_error arm
            // above (design §8: spawn-time failures degrade cleanly down
            // the ladder, only post-boot failures are fail-stop). A worker
            // that aborts DURING instantiation — an unsupported engine, a
            // failed layout check — reports it through this message, not
            // through a channel error, so treating it as fatal here used
            // to emit a spurious `emulator-error` for a machine that then
            // booted fine time-sliced, and left `smp_workers: "auto"`
            // waiting out the full 60 s spawn timeout instead of stepping
            // down immediately.
            if(this.ready)
            {
                this.fail(error);
            }
            else
            {
                on_spawn_error(error);
            }
            break;
        }
        // "init-done", "dbg-trace": informational
    }
};

/**
 * Fail-stop (design §8): a worker error after boot cannot be recovered —
 * a guest does not survive losing a CPU. Surface the error, park the
 * remaining workers, and stop servicing.
 * @param {!Error} error
 * @this {!Object}
 */
proto.fail = function(error)
{
    if(this.fatal_error)
    {
        return;
    }
    this.fatal_error = error;
    console.error("smp worker failed:", error);
    for(let i = 0; i < this.workers; i++)
    {
        command_write(this.i32, this.ctl_base, i, CTL_COMMAND_PARK_REQ);
        doorbell_post(this.i32, this.ctl_base, i);
    }
    this.emulator_bus.send("emulator-error", error);
    this.stop_service_loops();
    // stop the machine (§8): without this the device tick keeps running
    // against a dead guest
    this.on_fatal && this.on_fatal();
};

// ---- mailbox service (device-host side of the §6 RPC protocol) ----

/**
 * @this {!Object}
 * @param {number} index
 */
proto.start_service_loop = function(index)
{
    const i32 = this.i32;
    const record = mailbox_record_word(this.ctl_base, index);
    const dispatch = (op, addr, size, value_lo, value_hi, seq, value_2, value_3) =>
        this.dispatch(index, op, addr, size, value_lo, value_hi, seq, value_2, value_3);
    this.service_done.push((async () =>
    {
        while(!this.stopped)
        {
            if(mailbox_service(i32, record, dispatch))
            {
                // an RPC may have raised/lowered IRQs synchronously
                // (uart/ps2 reads clear lines): keep the rings flowing
                this.after_service && this.after_service();
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

/**
 * Undo a failed spawn: stop servicing and terminate whatever was spawned,
 * leaving the thread able to fall back down the §8 ladder. `topology`
 * extras (the (b) host's set_worker_host(0)) go in on_spawn_teardown.
 * @this {!Object}
 */
proto.spawn_teardown = function()
{
    this.stop_service_loops();
    for(const channel of this.channels)
    {
        channel.terminate();
    }
    this.on_spawn_teardown && this.on_spawn_teardown();
};

/** @this {!Object} */
proto.stop_service_loops = function()
{
    this.stopped = true;
    for(let i = 0; i < this.workers; i++)
    {
        Atomics.notify(this.i32, mailbox_record_word(this.ctl_base, i) + MAILBOX_STATE);
    }
    this.on_stop_service && this.on_stop_service();
};

/**
 * One RPC. Port I/O goes through `this.io` (the per-topology primitive);
 * mmap through cpu.read8/write8 and friends, which keep the Rust SVGA-LFB
 * leg — main owns the vga memory. Wide writes (SIZE 8/16) replay as
 * ordered dword writes, the historical JS mmap_write64/128 dword split. A
 * throwing device handler is still answered so the worker never
 * deadlocks, then surfaced as emulator-error.
 * @param {number} requester worker index this RPC came from (XWAH-37)
 * @param {number} op
 * @param {number} addr
 * @param {number} size
 * @param {number} value_lo
 * @param {number} value_hi
 * @param {number} seq
 * @param {number} value_2
 * @param {number} value_3
 * @return {number|undefined}
 * @this {!Object}
 */
proto.dispatch = function(requester, op, addr, size, value_lo, value_hi, seq, value_2, value_3)
{
    const cpu = this.cpu;
    const io = this.io;
    try
    {
        if(this.workers > 1)
        {
            this.sync_index_pair(requester, op, addr, size, value_lo);
        }
        switch(op)
        {
            case MAILBOX_OP_IN:
                return size === 1 ? io.read8(addr) :
                    size === 2 ? io.read16(addr) :
                    io.read32(addr);
            case MAILBOX_OP_OUT:
                if(size === 1)
                {
                    io.write8(addr, value_lo);
                }
                else if(size === 2)
                {
                    io.write16(addr, value_lo);
                }
                else
                {
                    io.write32(addr, value_lo);
                }
                return undefined;
            case MAILBOX_OP_PIC_ACK:
                // (b) only: acknowledge from the authoritative 8259
                return this.on_pic_ack ? this.on_pic_ack() : 0;
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
                const start = value_hi >>> 0;
                let phys = start;
                if(size === 1)
                {
                    for(let i = 0; i < count; i++)
                    {
                        mem8[phys++] = io.read8(addr);
                    }
                }
                else if(size === 2)
                {
                    for(let i = 0; i < count; i++)
                    {
                        const v = io.read16(addr);
                        mem8[phys++] = v & 0xFF;
                        mem8[phys++] = v >> 8 & 0xFF;
                    }
                }
                else
                {
                    for(let i = 0; i < count; i++)
                    {
                        const v = io.read32(addr);
                        mem8[phys++] = v & 0xFF;
                        mem8[phys++] = v >> 8 & 0xFF;
                        mem8[phys++] = v >> 16 & 0xFF;
                        mem8[phys++] = v >>> 24;
                    }
                }
                // These bytes are a main-thread write into shared guest
                // RAM, exactly like the write_blob/DMA leg, so they need
                // the same jit-dirty routing: a worker with compiled code
                // on those pages must invalidate it, or a guest that
                // PIO-loads code (every ATAPI/IDE boot does) can execute
                // the pre-transfer bytes. AFTER the writes, never before —
                // the probe inside post_jit_dirty is the seq-cst RMW that
                // publishes them (smpctl.rs code_bitmap_check_rmw).
                if(phys > start)
                {
                    this.post_jit_dirty(start, phys);
                }
                return count | 0;
            }
            case MAILBOX_OP_OUT_REP:
            {
                // batched rep outs: the mirror — read the shared guest
                // RAM, write the port per element in guest order. No dirty
                // routing: this leg only reads guest memory.
                const count = value_lo >>> 0;
                const mem8 = cpu.mem8;
                let phys = value_hi >>> 0;
                if(size === 1)
                {
                    for(let i = 0; i < count; i++)
                    {
                        io.write8(addr, mem8[phys++]);
                    }
                }
                else if(size === 2)
                {
                    for(let i = 0; i < count; i++)
                    {
                        io.write16(addr, mem8[phys] | mem8[phys + 1] << 8);
                        phys += 2;
                    }
                }
                else
                {
                    for(let i = 0; i < count; i++)
                    {
                        io.write32(addr,
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
        // Answer with a VALUE the worker can act on for every op that
        // returns one. The rep ops MUST report 0 transferred: the Rust
        // client (lock.rs ins_rep_batched/outs_rep_batched) advances
        // ECX/ESI/EDI by the returned count, so answering `undefined`
        // here — which makes mailbox_service leave VALUE_LO holding the
        // worker's own request count — told the guest a batch that never
        // happened had completed in full. Only the pure-write ops, whose
        // callers ignore the response, return undefined.
        return op === MAILBOX_OP_OUT || op === MAILBOX_OP_MMAP_WRITE ? undefined : 0;
    }
};

// ---- command protocol (design §8) ----

/** @this {!Object} */
proto.run = function()
{
    this.commanded_running = true;
    this.halt_event_sent = false;
    for(let i = 0; i < this.workers; i++)
    {
        command_write(this.i32, this.ctl_base, i, CTL_COMMAND_RUN);
        doorbell_post(this.i32, this.ctl_base, i);
    }
};

/** @this {!Object} */
proto.park = function()
{
    this.commanded_running = false;
    for(let i = 0; i < this.workers; i++)
    {
        command_write(this.i32, this.ctl_base, i, CTL_COMMAND_PARK_REQ);
        doorbell_post(this.i32, this.ctl_base, i);
    }
};

// ---- Stage W4: quiesce, lifecycle (design §7/§8) ----

/**
 * Await `predicate` with a deadline; the service loops keep running (they
 * are independent async loops), so a worker mid-RPC completes the RPC and
 * parks at its next slice boundary — no deadlock.
 * @param {string} label
 * @param {function(): boolean} predicate
 * @return {!Promise}
 * @this {!Object}
 */
proto.wait_for = async function(label, predicate)
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
 * The §7 quiesce: PARK_REQ + doorbell to every worker, then wait until
 * each has acked PARKED_ACK at its slice boundary and its mailbox is IDLE
 * (parked = not in do_many_cycles, mailbox idle, doorbell-waited).
 * @return {!Promise<boolean>} whether the machine was commanded running
 *     (the caller passes it back to resume())
 * @this {!Object}
 */
proto.quiesce = async function()
{
    const was_running = this.commanded_running;
    this.park();
    for(let i = 0; i < this.workers; i++)
    {
        await this.wait_for("worker " + i + " park ack", () =>
            command_read(this.i32, this.ctl_base, i) === CTL_COMMAND_PARKED_ACK);
        await this.wait_for("worker " + i + " mailbox idle", () =>
            Atomics.load(this.i32,
                mailbox_record_word(this.ctl_base, i) + MAILBOX_STATE) === MAILBOX_IDLE);
    }
    this.after_quiesce && this.after_quiesce();
    return was_running;
};

/**
 * Undo a quiesce: resume the workers when the machine was running before,
 * leave them parked otherwise.
 * @param {boolean} was_running
 * @this {!Object}
 */
proto.resume = function(was_running)
{
    if(was_running)
    {
        this.run();
    }
};

/**
 * Machine reboot (guest reset port / V86.restart), design §8: quiesce,
 * main-side chipset reset, per-worker reset commands (each worker resets
 * its instance, re-enters its role — APs return to WaitForSipi — and acks
 * by PARKING), then release the whole machine at once. The all-acked
 * barrier before RUN is load-bearing: a released BSP runs SeaBIOS, whose
 * one-shot INIT+SIPI broadcast must not race a sibling's pending reset —
 * set_worker_vcpu clears that vCPU's ipi_special latch, which would
 * silently swallow the AP's startup IPI.
 *
 * Fire-and-forget from reboot_internal, which may run inside a mailbox
 * dispatch: the quiesce must not be awaited there, or the triggering
 * worker's pending RPC would deadlock it. Serialized against save/restore
 * /destroy through lifecycle() — see its comment.
 * @param {function()} reset_main main-side chipset/device reset
 * @return {!Promise}
 * @this {!Object}
 */
proto.reboot = function(reset_main)
{
    // A reboot already queued or running makes another one redundant — the
    // machine comes up freshly reset either way — so drop it, preserving
    // the historical `rebooting` guard. Only reboot-vs-reboot coalesces;
    // reboot-vs-save/restore/destroy DEFERS through lifecycle() below.
    // Without this, a guest hitting the reset port again while the first
    // quiesce is in flight would queue a SECOND full park/reset/release
    // cycle that re-parks a machine the first one had already released.
    if(this.rebooting || this.fatal_error)
    {
        return Promise.resolve();
    }
    this.rebooting = true;
    return this.lifecycle(async () =>
    {
        try
        {
            if(this.fatal_error)
            {
                return;
            }
            const was_running = await this.quiesce();
            reset_main();
            this.forget_index_shadows();
            this.halt_event_sent = false;
            this.before_reset && this.before_reset();
            for(let i = 0; i < this.workers; i++)
            {
                command_write(this.i32, this.ctl_base, i, CTL_COMMAND_RESET);
                doorbell_post(this.i32, this.ctl_base, i);
            }
            for(let i = 0; i < this.workers; i++)
            {
                await this.wait_for("worker " + i + " reset ack", () =>
                    command_read(this.i32, this.ctl_base, i) === CTL_COMMAND_PARKED_ACK);
            }
            if(was_running)
            {
                this.run();
            }
        }
        finally
        {
            this.rebooting = false;
        }
    });
};

/**
 * Quiesce and tear down: TERMINATE + doorbell to every worker, wait
 * briefly for the acks, then hard-terminate and stop the service loops.
 * Serialized behind any in-flight save/restore/reboot.
 * @return {!Promise}
 * @this {!Object}
 */
proto.terminate = function()
{
    return this.lifecycle(async () =>
    {
        this.terminating = true;
        for(let i = 0; i < this.workers; i++)
        {
            command_write(this.i32, this.ctl_base, i, CTL_COMMAND_TERMINATE);
            doorbell_post(this.i32, this.ctl_base, i);
        }
        const deadline = Date.now() + TERMINATE_TIMEOUT_MS;
        while(this.terminated_count < this.workers && Date.now() < deadline)
        {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        this.stop_service_loops();
        await Promise.all(this.service_done);
        await this.on_terminated_wait();
        for(const channel of this.channels)
        {
            channel.terminate();
        }
    });
};

/**
 * Overridable: extra loops a topology must join before terminating.
 * @this {!Object}
 */
proto.on_terminated_wait = async function() {};

}
