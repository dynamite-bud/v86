// XWAH-9 Phase 4 Stages W1+W2: the vCPU worker runtime
// (docs/smp-phase4-design.md §6, §9). Receives the spawn payload
// { wasm_source, gram_bytes, guest_memory, index, total, main_time_origin,
//   memory_size, machine? }, instantiates gram + the multimem main module
// over the SHARED guest memory (the same build_gram_env shape starter.js
// uses), runs rust_init / set_smp_cpus / set_guest_memory_shared, performs
// the clock origin handshake, and runs. No io.js, no devices, no CPU.js
// facade in the worker: the env import surface follows the §6 disposition
// table — io_port_*/mmap_* are blocking mailbox RPCs to the device host,
// codegen_finalize/jit_clear_* are worker-local (own WebAssembly.Table, own
// instance memory, instantiated in the worker), diagnostics go out via
// postMessage, the clock is worker-local.
//
// Three modes, selected by the payload:
//
// - `vcpu` present (Stage W3, topology (b)): this worker owns exactly
//   vCPU `index` of `total`. Same instance setup as machine mode plus
//   set_worker_vcpu; the loop body is Rust's main_loop_worker (via the
//   main_loop dispatch), which drains the jit inbox, consumes INIT/SIPI,
//   merges remotely posted vectors into the local LAPIC, and runs slices.
//
// - `machine` present (Stage W2, topology (c)): this worker IS the machine.
//   It mirrors CPU.init's instance setup (worker mode, acpi flag, cpuid
//   level, jit config, reset), then runs the cooperative machine loop:
//   drain the jit-dirty ring, replay the device-IRQ ring into
//   device_raise_irq/device_lower_irq on THIS instance (which owns
//   PIC+IOAPIC+LAPICs — the (c) wire, design §9 W2 note), call the real
//   main_loop (count>1 takes the landed main_loop_smp unchanged), and use
//   the returned idle deadline as the doorbell-wait timeout — the worker-
//   side replacement of src/main.js's timer-worker yield. run_hardware_
//   timers is worker-local and returns only this instance's apic_timer
//   deadline; PIT/RTC/ACPI tick on the device host and arrive as ring
//   events. JIT finalize is synchronous here (workers may compile
//   synchronously; the loop never returns to the event loop while running).
//
// - no `machine` (the W1 skeleton, kept for tests/threads/worker-skeleton
//   .js): the wake handler publishes a heartbeat and, under the test hooks,
//   exercises one mailbox RPC batch and the codegen_finalize proof.
//
// Environment-agnostic: runs as a browser module worker (self.onmessage)
// and as a Node worker_thread through the thin channel adapter below.

import { WASM_TABLE_SIZE, WASM_TABLE_OFFSET } from "../const.js";
import { get_rand_int } from "../lib.js";
import { build_gram_env } from "./gram_env.js";
import {
    ctl_base_for, ctl_total_size, ctl_probe_offset, SMPCTL_PROBE_FIELD_COUNT,
    ctl_machine_offset, ctl_code_bitmap_offset,
    CTL_COMMAND_RUN, CTL_COMMAND_PARK_REQ, CTL_COMMAND_PARKED_ACK, CTL_COMMAND_TERMINATE,
    CTL_COMMAND_RESET,
    CTL_RUN_STATE_RUNNABLE, CTL_RUN_STATE_PARKED, CTL_RUN_STATE_HALTED,
    CTL_MACHINE_JIT_DIRTY_RING, CTL_MACHINE_DEV_IRQ_RING,
    CTL_JIT_DIRTY_RING_CAP, CTL_DEV_IRQ_RING_CAP, CTL_DEV_IRQ_RAISE_BIT,
    ring_pop,
    doorbell_read, doorbell_wait, run_state_publish, heartbeat_publish,
    command_read, command_ack,
    mailbox_record_word, mailbox_request, MAILBOX_OP_OUT, MAILBOX_OP_IN,
    MAILBOX_OP_MMAP_READ, MAILBOX_OP_MMAP_WRITE, MAILBOX_SEQ,
} from "./smpctl.js";

// how long a parked worker sleeps before re-arming its wait; wakes re-derive
// everything from the shared cells, so timeouts are harmless (design §3)
const PARK_TIMEOUT_MS = 60_000;
// a mailbox RPC that gets no response is a dead device host: fail-stop (§8)
const RPC_TIMEOUT_MS = 10_000;

/**
 * Channel adapter: { post, on_message } for the current environment.
 */
async function connect_channel()
{
    const is_node = typeof process === "object" && typeof process.versions === "object" &&
        typeof process.versions.node === "string";
    if(is_node)
    {
        const { parentPort } = await import("node:worker_threads");
        return {
            post: (message, transfer) => parentPort.postMessage(message, transfer),
            on_message: handler => parentPort.on("message", handler),
            // dropping the port's ref lets the worker thread exit once the
            // park loop returns (TERMINATE) — nothing else keeps it alive
            close: () => parentPort.close(),
        };
    }
    // browser dedicated worker global scope
    return {
        post: (message, transfer) => globalThis.postMessage(message, transfer),
        on_message: handler => globalThis.addEventListener("message", e => handler(e.data)),
        close: () => globalThis.close(),
    };
}

const channel = await connect_channel();

channel.on_message(payload =>
{
    run_worker(payload).catch(e =>
    {
        channel.post({ type: "error", message: String(e && e.message || e), stack: String(e && e.stack || "") });
        // rethrow out of the promise chain: in Node the worker exits
        // non-zero, in the browser the worker's error event fires —
        // fail-stop either way (design §8)
        setTimeout(() => { throw e; }, 0);
    });
});

async function run_worker(payload)
{
    const index = payload.index;
    const total = payload.total;
    const memory_size = payload.memory_size;
    const guest_memory = payload.guest_memory;
    // machine mode (Stage W2, topology (c)): this worker runs the whole
    // machine's vCPUs; the payload carries the CPU.init settings the worker
    // instance must mirror
    const machine = payload.machine || null;
    // per-vCPU mode (Stage W3, topology (b)): this worker runs exactly
    // vCPU `index` of `total`; same instance settings as machine mode plus
    // set_worker_vcpu, and the loop body is Rust's main_loop_worker
    const vcpu = payload.vcpu || null;

    // clock origin handshake (design §6 microtick row): same monotonic
    // clock as the main thread, offset by the difference of the two
    // performance.timeOrigin values sent at spawn — zero rate drift
    const origin_delta = payload.main_time_origin - performance.timeOrigin;
    const microtick = () => performance.now() + origin_delta;

    if(!(guest_memory.buffer instanceof SharedArrayBuffer))
    {
        throw new Error("vcpu_worker requires a shared guest memory");
    }

    const ctl_base = ctl_base_for(memory_size);
    if(ctl_base + ctl_total_size(total, memory_size) > guest_memory.buffer.byteLength)
    {
        throw new Error("guest memory is missing the control-region pages " +
            "(was it sized with smp_workers set?)");
    }
    const i32 = new Int32Array(guest_memory.buffer);
    const record = mailbox_record_word(ctl_base, index);

    const rpc = (op, addr, size, value, value_hi, value_2, value_3) =>
        mailbox_request(i32, record, op, addr, size, value, RPC_TIMEOUT_MS,
            value_hi, value_2, value_3);

    // worker-local JIT plumbing (§6 codegen_finalize row): own table, own
    // instance memory, WebAssembly.instantiate in this worker
    const wasm_table = new WebAssembly.Table({ "element": "anyfunc", "initial": WASM_TABLE_SIZE + WASM_TABLE_OFFSET });
    let exports = null;    // set after instantiation
    let jit_imports = null;
    const finalize_log = [];
    const pending_finalize = [];
    // machine mode: codegen_finalize_finished callbacks deferred to the
    // loop boundary — codegen_finalize is called from INSIDE
    // jit_analyze_and_generate, and calling back into the module there
    // re-enters its jit state mid-borrow (RefCell panic)
    const pending_finished = [];

    const read_sized_string = (offset, len) =>
        new TextDecoder().decode(new Uint8Array(exports.memory.buffer, offset, len));

    const env_funcs = {
        // --- mailbox RPCs to the device host (blocking Atomics.wait) ---
        "io_port_read8": port => rpc(MAILBOX_OP_IN, port, 1, 0),
        "io_port_read16": port => rpc(MAILBOX_OP_IN, port, 2, 0),
        "io_port_read32": port => rpc(MAILBOX_OP_IN, port, 4, 0),
        "io_port_write8": (port, value) => { rpc(MAILBOX_OP_OUT, port, 1, value); },
        "io_port_write16": (port, value) => { rpc(MAILBOX_OP_OUT, port, 2, value); },
        "io_port_write32": (port, value) => { rpc(MAILBOX_OP_OUT, port, 4, value); },

        // the LAPIC/IOAPIC windows never reach here (Rust intercepts on
        // THIS instance); wide writes are single-record RPCs (SIZE = byte
        // width, VALUE_LO/HI/2/3 the payload — the W2 wide-op surface); the
        // device host replays them as ordered dword writes, the historical
        // JS mmap_write64/128 dword split
        "mmap_read8": addr => rpc(MAILBOX_OP_MMAP_READ, addr, 1, 0),
        "mmap_read32": addr => rpc(MAILBOX_OP_MMAP_READ, addr, 4, 0),
        "mmap_write8": (addr, value) => { rpc(MAILBOX_OP_MMAP_WRITE, addr, 1, value); },
        "mmap_write16": (addr, value) => { rpc(MAILBOX_OP_MMAP_WRITE, addr, 2, value); },
        "mmap_write32": (addr, value) => { rpc(MAILBOX_OP_MMAP_WRITE, addr, 4, value); },
        "mmap_write64": (addr, v0, v1) =>
        {
            rpc(MAILBOX_OP_MMAP_WRITE, addr, 8, v0, v1);
        },
        "mmap_write128": (addr, v0, v1, v2, v3) =>
        {
            rpc(MAILBOX_OP_MMAP_WRITE, addr, 16, v0, v1, v2, v3);
        },

        // --- worker-local (§6) ---
        "microtick": microtick,
        // worker-local per §6: only this instance's LAPIC timer deadline;
        // PIT/RTC/ACPI tick on the device host and arrive as ring events
        // ((c)) or pending-bitmap posts ((b)); the skeleton stub keeps its
        // inert W1 value
        "run_hardware_timers": (acpi, t) =>
            machine || vcpu ? (acpi ? exports["apic_timer"](t) : 100) : t + 100,
        "get_rand_int": () => get_rand_int(),
        // park/notify replaces stop_idling in worker mode (§3)
        "stop_idling": () => {},

        // --- postMessage to the device host (non-blocking) ---
        "cpu_exception_hook": n =>
        {
            channel.post({ type: "cpu-exception", "n": n });
            return 0;
        },
        "log_from_wasm": (offset, len) =>
        {
            channel.post({ type: "log", message: read_sized_string(offset, len) });
        },
        "console_log_from_wasm": (offset, len) =>
        {
            channel.post({ type: "console-log", message: read_sized_string(offset, len) });
        },
        "dbg_trace_from_wasm": () => { channel.post({ type: "dbg-trace" }); },
        "cpu_event_halt": () =>
        {
            run_state_publish(i32, ctl_base, index, CTL_RUN_STATE_HALTED);
            channel.post({ type: "cpu-event-halt" });
        },
        "abort": () =>
        {
            channel.post({ type: "abort" });
            throw new Error("wasm abort in vcpu worker " + index);
        },

        // --- worker-local JIT (§6): compile and install into this
        // instance's own table; caches are per-instance by construction.
        // Machine mode compiles SYNCHRONOUSLY (legal in workers): the
        // machine loop never returns to the event loop while running, so a
        // promise-based finalize would never settle. The finished callback
        // is deferred to the loop boundary — this env import runs INSIDE
        // jit_analyze_and_generate, and re-entering the module here
        // borrows its jit state twice ---
        "codegen_finalize": (wasm_table_index, start, state_flags, ptr, len) =>
        {
            if(machine || vcpu)
            {
                const code = new Uint8Array(exports.memory.buffer, ptr >>> 0, len >>> 0);
                const result = new WebAssembly.Instance(
                    new WebAssembly.Module(code), { "e": jit_imports });
                wasm_table.set(wasm_table_index + WASM_TABLE_OFFSET, result.exports["f"]);
                pending_finished.push(wasm_table_index, start, state_flags);
                return;
            }
            // copy out of the instance memory before yielding
            const code = new Uint8Array(exports.memory.buffer, ptr >>> 0, len >>> 0).slice();
            const finalized = WebAssembly.instantiate(code, { "e": jit_imports }).then(result =>
            {
                wasm_table.set(wasm_table_index + WASM_TABLE_OFFSET, result.instance.exports["f"]);
                exports.codegen_finalize_finished(wasm_table_index, start, state_flags);
                finalize_log.push({ "wasm_table_index": wasm_table_index, "start": start >>> 0, "code": code });
            });
            finalized.catch(e =>
            {
                channel.post({ type: "error", message: "JIT finalize failed: " + e });
                setTimeout(() => { throw e; }, 0);
            });
            pending_finalize.push(finalized);
        },
        "jit_clear_func": wasm_table_index =>
        {
            wasm_table.set(wasm_table_index + WASM_TABLE_OFFSET, null);
        },
        "jit_clear_all_funcs": () =>
        {
            for(let i = 0; i < WASM_TABLE_SIZE; i++)
            {
                wasm_table.set(i + WASM_TABLE_OFFSET, null);
            }
        },

        "__indirect_function_table": wasm_table,
    };

    // gram over the shared guest memory + env merge: the same shape the
    // main thread builds (src/browser/gram_env.js)
    const env = await build_gram_env(env_funcs, payload.gram_bytes, guest_memory,
        () => exports.memory.buffer);
    const { instance } = await WebAssembly.instantiate(payload.wasm_source, env);
    exports = instance.exports;

    exports["rust_init"]();
    exports["set_guest_memory_shared"](1);
    // memory_size global (src/rust/cpu/global_pointers.rs) must be set
    // before allocate_memory — the cpu.js create_memory contract
    new Uint32Array(exports.memory.buffer, 812, 1)[0] = memory_size;
    exports["allocate_memory"](memory_size);
    exports["set_smp_cpus"](total);

    const settings = machine || vcpu;
    if(settings)
    {
        // Mirror CPU.init's instance setup (src/cpu.js): in (c) this
        // instance IS the machine; in (b) it owns exactly one vCPU. The
        // main thread's instance never executes guest code and serves
        // only as the device host.
        if(typeof exports["set_worker_mode"] !== "function")
        {
            throw new Error("worker mode requires a wasm build with set_worker_mode " +
                "(rebuild the multimem artifact)");
        }
        // relocates the cpu/lock.rs bus-lock cell to machine.buslock in the
        // control region (design §9 W2; must precede any guest execution)
        exports["set_worker_mode"](1);
        settings["disable_jit"] && exports["set_jit_config"](0, 1);
        settings["cpuid_level"] && exports["set_cpuid_level"](settings["cpuid_level"]);
        // acpi_enabled global (cpu.js view at byte offset 552)
        new Uint8Array(exports.memory.buffer, 552, 1)[0] = settings["acpi"] ? 1 : 0;
        exports["set_tsc"](0, 0);
        exports["reset_cpu"]();
    }
    if(vcpu)
    {
        // Stage W3 (design §3): per-vCPU worker role — switches the live
        // block to vCPU `index`, publishes its run state + routing entry,
        // and re-initializes this vCPU's control cells
        exports["set_worker_vcpu"](index, total);
    }

    // jit imports: the cpu.js create_jit_imports shape plus "g" (the JIT
    // modules import guest RAM as memidx 1)
    jit_imports = Object.create(null);
    jit_imports["m"] = exports.memory;
    jit_imports["g"] = guest_memory;
    for(const name of Object.keys(exports))
    {
        if(name.startsWith("_") || name.startsWith("zstd") || name.endsWith("_js"))
        {
            continue;
        }
        jit_imports[name] = exports[name];
    }

    // cross-language layout check: the Rust control-region layout
    // (src/rust/cpu/smpctl.rs) and the JS mirror must agree byte for byte
    const smpctl_base = exports["get_smpctl_base"]();
    if(smpctl_base !== ctl_base)
    {
        throw new Error(`smpctl base mismatch: rust ${smpctl_base} != js ${ctl_base}`);
    }
    const smpctl_size = exports["get_smpctl_total_size"](total);
    if(smpctl_size !== ctl_total_size(total, memory_size))
    {
        throw new Error(`smpctl size mismatch: rust ${smpctl_size} != ` +
            `js ${ctl_total_size(total, memory_size)}`);
    }
    for(let field = 0; field < SMPCTL_PROBE_FIELD_COUNT; field++)
    {
        for(const i of [0, total - 1])
        {
            const rust_offset = exports["get_smpctl_offset"](field, i, total);
            const js_offset = ctl_probe_offset(field, i, total);
            if(rust_offset !== js_offset)
            {
                throw new Error(`smpctl offset mismatch: field ${field} i ${i}: ` +
                    `rust ${rust_offset} != js ${js_offset}`);
            }
        }
    }
    for(const i of [0, total - 1])
    {
        const rust_offset = exports["get_smpctl_code_bitmap_offset"](i, total);
        const js_offset = ctl_code_bitmap_offset(total, i, memory_size);
        if(rust_offset !== js_offset)
        {
            throw new Error(`smpctl code-bitmap offset mismatch: i ${i}: ` +
                `rust ${rust_offset} != js ${js_offset}`);
        }
    }

    channel.post({
        type: "init-done",
        "index": index,
        "total": total,
        "smpctl_base": smpctl_base,
        "smpctl_size": smpctl_size,
        // clock handshake sample: main compares against its own
        // performance.now() on receipt
        "microtick": microtick(),
        "origin_delta": origin_delta,
    });

    if(machine)
    {
        machine_loop();
        channel.close();
        return;
    }

    if(vcpu)
    {
        vcpu_loop();
        channel.close();
        return;
    }

    if(payload.test_force_jit)
    {
        await force_jit_proof();
    }

    park_loop();
    channel.close();

    // The Stage W2 machine loop (topology (c), design §9 W2 note): the
    // worker-side replacement of src/main.js's do_tick/yield cycle. Per
    // iteration: honor the command protocol, drain cross-thread work (JIT
    // dirt strictly before device IRQs — modified code must be invalidated
    // before an interrupt can steer execution into it), run the real
    // main_loop on this instance, and park on the doorbell for the idle
    // deadline main_loop returned. The doorbell is read BEFORE the drains
    // and main_loop, so any event posted while the machine ran turns the
    // wait into an immediate wake — no lost-wakeup window.
    function machine_loop()
    {
        const machine_base = ctl_base + ctl_machine_offset(total);
        const jit_ring = machine_base + CTL_MACHINE_JIT_DIRTY_RING;
        const irq_ring = machine_base + CTL_MACHINE_DEV_IRQ_RING;
        channel.post({ type: "machine-ready" });
        for(;;)
        {
            const seen = doorbell_read(i32, ctl_base, index);
            const command = command_read(i32, ctl_base, index);
            if(command === CTL_COMMAND_TERMINATE)
            {
                run_state_publish(i32, ctl_base, index, CTL_RUN_STATE_HALTED);
                channel.post({ type: "terminated" });
                return;
            }
            if(command === CTL_COMMAND_PARK_REQ || command === CTL_COMMAND_PARKED_ACK)
            {
                command_ack(i32, ctl_base, index, CTL_COMMAND_PARK_REQ, CTL_COMMAND_PARKED_ACK);
                run_state_publish(i32, ctl_base, index, CTL_RUN_STATE_PARKED);
                doorbell_wait(i32, ctl_base, index, seen, PARK_TIMEOUT_MS);
                continue;
            }
            if(command === CTL_COMMAND_RESET)
            {
                // machine reboot requested by the device host (guest reset
                // port write serviced there): reset THIS instance's CPU and
                // ack by restoring RUN
                exports["reset_cpu"]();
                command_ack(i32, ctl_base, index, CTL_COMMAND_RESET, CTL_COMMAND_RUN);
                continue;
            }
            run_state_publish(i32, ctl_base, index, CTL_RUN_STATE_RUNNABLE);
            heartbeat_publish(i32, ctl_base, index);
            for(let page; (page = ring_pop(i32, jit_ring, CTL_JIT_DIRTY_RING_CAP)) !== undefined;)
            {
                const start = (page >>> 0) * 0x1000;
                exports["jit_dirty_cache"](start, start + 0x1000);
            }
            for(let event; (event = ring_pop(i32, irq_ring, CTL_DEV_IRQ_RING_CAP)) !== undefined;)
            {
                if(event & CTL_DEV_IRQ_RAISE_BIT)
                {
                    exports["device_raise_irq"](event & 0xFF);
                }
                else
                {
                    exports["device_lower_irq"](event & 0xFF);
                }
            }
            const t = exports["main_loop"]();
            // deliver deferred codegen_finalize_finished callbacks (FIFO)
            // now that the module is reentrant again (outside main_loop)
            for(let i = 0; i < pending_finished.length; i += 3)
            {
                exports["codegen_finalize_finished"](
                    pending_finished[i], pending_finished[i + 1], pending_finished[i + 2]);
            }
            pending_finished.length = 0;
            if(t > 0)
            {
                doorbell_wait(i32, ctl_base, index, seen, Math.min(t, PARK_TIMEOUT_MS));
            }
        }
    }

    // The Stage W3 per-vCPU loop (topology (b), design §3/§9 W3): the thin
    // JS shell around Rust's main_loop_worker (reached through main_loop's
    // worker dispatch). Rust owns the whole iteration — jit-inbox drain,
    // INIT/SIPI consumption, pending-IRR merge, handle_irqs, the slice —
    // and returns the idle deadline; this loop owns the §8 command
    // protocol and the doorbell park. The doorbell is read BEFORE
    // main_loop runs, so anything posted mid-slice turns the wait into an
    // immediate wake — no lost-wakeup window (the machine_loop invariant).
    function vcpu_loop()
    {
        channel.post({ type: "vcpu-ready", "index": index });
        for(;;)
        {
            const seen = doorbell_read(i32, ctl_base, index);
            const command = command_read(i32, ctl_base, index);
            if(command === CTL_COMMAND_TERMINATE)
            {
                run_state_publish(i32, ctl_base, index, CTL_RUN_STATE_HALTED);
                channel.post({ type: "terminated", "index": index });
                return;
            }
            if(command === CTL_COMMAND_PARK_REQ || command === CTL_COMMAND_PARKED_ACK)
            {
                command_ack(i32, ctl_base, index, CTL_COMMAND_PARK_REQ, CTL_COMMAND_PARKED_ACK);
                doorbell_wait(i32, ctl_base, index, seen, PARK_TIMEOUT_MS);
                continue;
            }
            if(command === CTL_COMMAND_RESET)
            {
                // machine reboot: reset this instance and re-enter the
                // per-vCPU role (which also clears this vCPU's control
                // cells so pre-reset IPIs/jit events never leak)
                exports["reset_cpu"]();
                exports["set_worker_vcpu"](index, total);
                command_ack(i32, ctl_base, index, CTL_COMMAND_RESET, CTL_COMMAND_RUN);
                continue;
            }
            heartbeat_publish(i32, ctl_base, index);
            const t = exports["main_loop"]();
            // deliver deferred codegen_finalize_finished callbacks (FIFO)
            // now that the module is reentrant again
            for(let i = 0; i < pending_finished.length; i += 3)
            {
                exports["codegen_finalize_finished"](
                    pending_finished[i], pending_finished[i + 1], pending_finished[i + 2]);
            }
            pending_finished.length = 0;
            if(t > 0)
            {
                doorbell_wait(i32, ctl_base, index, seen, Math.min(t, PARK_TIMEOUT_MS));
            }
        }
    }

    // Worker-side codegen_finalize proof (W1 gate): force-compile a tiny
    // program written into the shared guest RAM through the debug export,
    // proving the whole worker-local JIT path — generated bytes read from
    // this instance's memory, module imports "e"."m" + "e"."g",
    // WebAssembly.instantiate against the two real memories inside the
    // worker, table install, codegen_finalize_finished.
    async function force_jit_proof()
    {
        if(typeof exports["jit_force_generate_unsafe"] !== "function")
        {
            channel.post({ type: "jit-proof", ok: false, reason: "debug export missing (release build)" });
            return;
        }
        // real-mode CS base F0000 (reset state); the program is the
        // stage4-proof counter loop: inc dword [0x1000]; jmp $-7
        exports["reset_cpu"]();
        const CODE = 0xF0000;
        new Uint8Array(guest_memory.buffer)
            .set([0x66, 0xFF, 0x06, 0x00, 0x10, 0xEB, 0xF9], CODE);
        exports["jit_force_generate_unsafe"](CODE);
        await Promise.all(pending_finalize);
        const compiled = finalize_log.find(f => (f["start"] & ~0xFFF) === CODE);
        const memory_imports = compiled
            ? WebAssembly.Module.imports(new WebAssembly.Module(compiled["code"]))
                .filter(imp => imp.kind === "memory")
                .map(imp => imp.module + "." + imp.name)
            : [];
        const installed = compiled
            ? wasm_table.get(compiled["wasm_table_index"] + WASM_TABLE_OFFSET) !== null
            : false;
        channel.post({
            type: "jit-proof",
            ok: !!compiled && installed,
            "finalize_count": finalize_log.length,
            "module_bytes": compiled ? compiled["code"].length : 0,
            "memory_imports": memory_imports,
            "installed": installed,
        });
    }

    // The W1 stub park/wake loop (§3 preview): park in Atomics.wait on the
    // doorbell; on wake publish a heartbeat, honor the §8 command protocol,
    // and (under the test hook) run one mailbox RPC batch. Spurious wakes
    // are harmless — every iteration re-derives from the shared cells. The
    // real slice execution replaces the wake body in Stage W2.
    function park_loop()
    {
        channel.post({ type: "parked" });
        let rpc_batch_done = false;
        for(;;)
        {
            // read the doorbell BEFORE the command word: a command posted
            // after this read still moves the counter, so the wait below
            // returns immediately instead of sleeping through it
            const seen = doorbell_read(i32, ctl_base, index);
            const command = command_read(i32, ctl_base, index);
            if(command === CTL_COMMAND_TERMINATE)
            {
                run_state_publish(i32, ctl_base, index, CTL_RUN_STATE_HALTED);
                channel.post({ type: "terminated" });
                return;
            }
            if(command === CTL_COMMAND_PARK_REQ)
            {
                command_ack(i32, ctl_base, index, CTL_COMMAND_PARK_REQ, CTL_COMMAND_PARKED_ACK);
            }
            run_state_publish(i32, ctl_base, index, CTL_RUN_STATE_PARKED);
            doorbell_wait(i32, ctl_base, index, seen, PARK_TIMEOUT_MS);
            run_state_publish(i32, ctl_base, index, CTL_RUN_STATE_RUNNABLE);
            heartbeat_publish(i32, ctl_base, index);
            if(payload.rpc_pairs && command_read(i32, ctl_base, index) === CTL_COMMAND_RUN &&
                !rpc_batch_done)
            {
                rpc_batch_done = true;
                rpc_batch(payload.rpc_pairs, payload.rpc_port | 0);
            }
        }
    }

    // Test hook: the Layer A OUT/IN echo exchange (mailbox-protocol.js),
    // issued from inside the worker runtime against the control-region
    // record, with per-RPC round-trip latency reported to the main thread.
    function rpc_batch(pairs, port)
    {
        const latencies_ns = new Float64Array(pairs * 2);
        let request_index = 0;
        for(let i = 0; i < pairs; i++)
        {
            for(const op of [MAILBOX_OP_OUT, MAILBOX_OP_IN])
            {
                i32[record + MAILBOX_SEQ] = request_index;
                const begin = performance.now();
                const result = rpc(op, port, 4, op === MAILBOX_OP_OUT ? i : 0);
                latencies_ns[request_index] = (performance.now() - begin) * 1e6;
                if(op === MAILBOX_OP_IN && result !== i)
                {
                    throw new Error(`RPC echo mismatch: pair ${i} returned ${result}`);
                }
                request_index++;
            }
        }
        channel.post({ type: "rpc-batch", "latencies_ns": latencies_ns }, [latencies_ns.buffer]);
    }
}
