// XWAH-9 Phase 4 Stage W1: the vCPU worker runtime skeleton
// (docs/smp-phase4-design.md §6). Receives the spawn payload
// { wasm_source, gram_bytes, guest_memory, index, total, main_time_origin,
//   memory_size }, instantiates gram + the multimem main module over the
// SHARED guest memory (the same build_gram_env shape starter.js uses), runs
// rust_init / set_smp_cpus / set_guest_memory_shared, performs the clock
// origin handshake, and parks in the doorbell wait loop. No io.js, no
// devices, no CPU.js facade in the worker: the env import surface follows
// the §6 disposition table — io_port_*/mmap_* are blocking mailbox RPCs to
// the device host, codegen_finalize/jit_clear_* are worker-local (own
// WebAssembly.Table, own instance memory, WebAssembly.instantiate in the
// worker), diagnostics go out via postMessage, the clock is worker-local.
//
// W1 is a SKELETON: the wake handler publishes a heartbeat and (under the
// worker-skeleton test's hooks) exercises one mailbox RPC batch and the
// worker-side codegen_finalize proof — it does NOT run main_loop. Stage W2
// puts the real machine loop here.
//
// Environment-agnostic: runs as a browser module worker (self.onmessage)
// and as a Node worker_thread (tests/threads/worker-skeleton.js) through the
// thin channel adapter below.

import { WASM_TABLE_SIZE, WASM_TABLE_OFFSET } from "../const.js";
import { get_rand_int } from "../lib.js";
import { build_gram_env } from "./gram_env.js";
import {
    ctl_base_for, ctl_size, ctl_probe_offset, SMPCTL_PROBE_FIELD_COUNT,
    CTL_COMMAND_RUN, CTL_COMMAND_PARK_REQ, CTL_COMMAND_PARKED_ACK, CTL_COMMAND_TERMINATE,
    CTL_RUN_STATE_RUNNABLE, CTL_RUN_STATE_PARKED, CTL_RUN_STATE_HALTED,
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
    if(ctl_base + ctl_size(total) > guest_memory.buffer.byteLength)
    {
        throw new Error("guest memory is missing the control-region pages " +
            "(was it sized with smp_workers set?)");
    }
    const i32 = new Int32Array(guest_memory.buffer);
    const record = mailbox_record_word(ctl_base, index);

    const rpc = (op, addr, size, value) =>
        mailbox_request(i32, record, op, addr, size, value, RPC_TIMEOUT_MS);

    // worker-local JIT plumbing (§6 codegen_finalize row): own table, own
    // instance memory, WebAssembly.instantiate in this worker
    const wasm_table = new WebAssembly.Table({ "element": "anyfunc", "initial": WASM_TABLE_SIZE + WASM_TABLE_OFFSET });
    let exports = null;    // set after instantiation
    let jit_imports = null;
    const finalize_log = [];
    const pending_finalize = [];

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

        // the LAPIC window never reaches here (Rust intercept); wide writes
        // are split into dword RPCs in W1 — W2 finalizes the op surface
        "mmap_read8": addr => rpc(MAILBOX_OP_MMAP_READ, addr, 1, 0),
        "mmap_read32": addr => rpc(MAILBOX_OP_MMAP_READ, addr, 4, 0),
        "mmap_write8": (addr, value) => { rpc(MAILBOX_OP_MMAP_WRITE, addr, 1, value); },
        "mmap_write16": (addr, value) => { rpc(MAILBOX_OP_MMAP_WRITE, addr, 2, value); },
        "mmap_write32": (addr, value) => { rpc(MAILBOX_OP_MMAP_WRITE, addr, 4, value); },
        "mmap_write64": (addr, v0, v1) =>
        {
            rpc(MAILBOX_OP_MMAP_WRITE, addr, 4, v0);
            rpc(MAILBOX_OP_MMAP_WRITE, addr + 4, 4, v1);
        },
        "mmap_write128": (addr, v0, v1, v2, v3) =>
        {
            rpc(MAILBOX_OP_MMAP_WRITE, addr, 4, v0);
            rpc(MAILBOX_OP_MMAP_WRITE, addr + 4, 4, v1);
            rpc(MAILBOX_OP_MMAP_WRITE, addr + 8, 4, v2);
            rpc(MAILBOX_OP_MMAP_WRITE, addr + 12, 4, v3);
        },

        // --- worker-local (§6) ---
        "microtick": microtick,
        // W1 stub: no devices in the worker; W2+ returns only the
        // instance's own apic_timer deadline (PIT/RTC/ACPI stay main-side)
        "run_hardware_timers": (acpi, t) => t + 100,
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
        // instance's own table; caches are per-instance by construction ---
        "codegen_finalize": (wasm_table_index, start, state_flags, ptr, len) =>
        {
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
    const smpctl_size = exports["get_smpctl_size"](total);
    if(smpctl_size !== ctl_size(total))
    {
        throw new Error(`smpctl size mismatch: rust ${smpctl_size} != js ${ctl_size(total)}`);
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

    if(payload.test_force_jit)
    {
        await force_jit_proof();
    }

    park_loop();
    channel.close();

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
