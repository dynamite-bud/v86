import { v86 } from "../main.js";
import { LOG_CPU, MMAP_BLOCK_SIZE, WASM_TABLE_OFFSET, WASM_TABLE_SIZE } from "../const.js";
import { get_rand_int, load_file, read_sized_string_from_mem } from "../lib.js";
import { dbg_assert, dbg_trace, dbg_log, set_log_level } from "../log.js";
import * as print_stats from "./print_stats.js";
import { Bus } from "../bus.js";
import { BOOT_ORDER_FD_FIRST, BOOT_ORDER_HD_FIRST, BOOT_ORDER_CD_FIRST } from "../rtc.js";
import { EEXIST, ENOENT } from "../../lib/9p.js";

import { SpeakerAdapter } from "./speaker.js";
import { NetworkAdapter } from "./network.js";
import { FetchNetworkAdapter } from "./fetch_network.js";
import { WispNetworkAdapter } from "./wisp_network.js";
import { KeyboardAdapter } from "./keyboard.js";
import { MouseAdapter } from "./mouse.js";
import { ScreenAdapter } from "./screen.js";
import { DummyScreenAdapter } from "./dummy_screen.js";
import { ANSIScreenAdapter } from "./ansi_screen.js";
import { SerialAdapter, VirtioConsoleAdapter, SerialAdapterXtermJS, VirtioConsoleAdapterXtermJS } from "./serial.js";
import { InBrowserNetworkAdapter } from "./inbrowser_network.js";
import { Modem } from "./modem.js";

import { MemoryFileStorage, ServerFileStorageWrapper } from "./filestorage.js";
import { SyncBuffer, buffer_from_object } from "../buffer.js";
import { FS } from "../../lib/filesystem.js";
import { ctl_pages } from "./smpctl.js";
import { build_gram_env } from "./gram_env.js";
import { SMPWorkerHost } from "./smp_worker_host.js";
import { SMPVcpuHost } from "./smp_vcpu_host.js";

// Multi-memory capability probe (XWAH-9 Phase 3): a minimal hand-assembled
// two-memory module — imports "e"."m" and "e"."g" (the JIT modules' shape,
// wasm_builder.rs) and performs one memidx-1 i32.load. Engines without the
// multi-memory proposal reject it at validation, so guest_memory_backend
// "imported" can fail loudly at construction instead of wedging at the
// first JIT compile (byte layout cribbed from
// tests/rust/verify-wasmgen-multimem-output.js's module contract; memarg
// encoding: flags|0x40, then memidx LEB, then offset LEB).
// Exported for tests/api/multimem-negative.js.
export const MULTIMEM_PROBE_MODULE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6D, // \0asm magic
    0x01, 0x00, 0x00, 0x00, // version 1
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: one type, () -> ()
    0x02, 0x0F, 0x02, // import section, two imports:
    0x01, 0x65, 0x01, 0x6D, 0x02, 0x00, 0x00, // "e" "m" memory {min 0}
    0x01, 0x65, 0x01, 0x67, 0x02, 0x00, 0x00, // "e" "g" memory {min 0}
    0x03, 0x02, 0x01, 0x00, // function section: one function of type 0
    0x0A, 0x0B, 0x01, 0x09, 0x00, // code section: one body, no locals
    0x41, 0x00, // i32.const 0
    0x28, 0x42, 0x01, 0x00, // i32.load align=2|0x40 memidx=1 offset=0
    0x1A, // drop
    0x0B, // end
]);

/**
 * Constructor for emulator instances.
 *
 * For API usage, see v86.d.ts in the root of this repository.
 *
 * @param {{
      disable_mouse: (boolean|undefined),
      disable_keyboard: (boolean|undefined),
      cpus: (number|undefined),
      wasm_fn: (Function|undefined),
      guest_memory_backend: (string|undefined),
      guest_memory_shared: (string|boolean|undefined),
      smp_workers: (boolean|string|undefined),
      smp_worker_topology: (string|undefined),
      screen: ({
          scale: (number|undefined),
      } | undefined),
    }} options
 * @constructor
 */
export function V86(options)
{
    if(typeof options.log_level === "number")
    {
        // XXX: Shared between all emulator instances
        set_log_level(options.log_level);
    }

    //var worker = new Worker("src/browser/worker.js");
    //var adapter_bus = this.bus = WorkerBus.init(worker);

    this.cpu_is_running = false;
    this.cpu_exception_hook = function(n) {};

    const bus = Bus.create();
    this.bus = bus[0];
    this.emulator_bus = bus[1];

    var cpu;
    var wasm_memory;

    const wasm_table = new WebAssembly.Table({ element: "anyfunc", initial: WASM_TABLE_SIZE + WASM_TABLE_OFFSET });

    // NOTE: Experimental (XWAH-9 Phase 3 Stage 5): guest_memory_backend
    // "imported" loads the multimem build (v86-multimem[-debug].wasm), in
    // which guest RAM is a separate WebAssembly.Memory created here and
    // imported by gram.wasm (interpreter accessors) and by JIT-generated
    // modules (docs/smp-phase3-design.md §2 option A). The default "linear"
    // backend is byte-for-byte untouched.
    let guest_memory_backend =
        options.guest_memory_backend === undefined ? "linear" : options.guest_memory_backend;
    dbg_assert(guest_memory_backend === "linear" || guest_memory_backend === "imported",
        "options.guest_memory_backend must be \"linear\" or \"imported\"");

    // Sub-option: whether the imported guest memory is shared
    // (SharedArrayBuffer-backed). "auto" = crossOriginIsolated in browsers;
    // in Node there is no crossOriginIsolated gate, so "auto" follows
    // SharedArrayBuffer availability (i.e. shared). Explicit true/false is
    // meant for testing both artifact variants without COI headers.
    const guest_memory_shared_option =
        options.guest_memory_shared === undefined ? "auto" : options.guest_memory_shared;
    dbg_assert(guest_memory_shared_option === "auto" || typeof guest_memory_shared_option === "boolean",
        "options.guest_memory_shared must be \"auto\", true or false");

    // NOTE: Experimental (XWAH-9 Phase 4 Stages W2-W4): smp_workers
    // requests worker execution (docs/smp-phase4-design.md §8/§9) over the
    // shared imported guest memory while this thread becomes the device
    // host — one worker per vCPU (topology (b), real parallelism) for
    // cpus > 1, the whole machine in one worker (topology (c)) for
    // cpus == 1; see smp_worker_topology below to override.
    // false = default, true = hard requirement (loud constructor throw
    // naming the missing capability), "auto" = degrade down the ladder
    // (workers -> time-sliced over imported memory -> time-sliced) with a
    // dbg_log. The resolved mode is observable through the "smp-mode" bus
    // event and the emulator.smp_mode property.
    const smp_workers = options.smp_workers === undefined ? false : options.smp_workers;
    dbg_assert(smp_workers === false || smp_workers === true || smp_workers === "auto",
        "options.smp_workers must be false, true or \"auto\"");
    this.smp_workers = smp_workers;
    this.smp_worker_host = null;
    this.smp_mode = null;
    // Stage W3: worker-execution topology (docs/smp-phase4-design.md §1,
    // §9 W3). "auto" (default): one worker per vCPU — topology (b) — when
    // cpus > 1, the whole machine in one worker — topology (c) — when
    // cpus == 1 (a single vCPU gains nothing from the (b) wire; (c) is the
    // landed, cheaper path there). "percpu"/"machine" force the respective
    // topology, primarily for testing ((c) with cpus > 1 remains the
    // time-sliced-in-a-worker mode W2 landed; (b) with cpus == 1 is legal
    // and exercises the per-vCPU wire without SMP).
    const smp_worker_topology =
        options.smp_worker_topology === undefined ? "auto" : options.smp_worker_topology;
    dbg_assert(smp_worker_topology === "auto" || smp_worker_topology === "percpu" ||
        smp_worker_topology === "machine",
        "options.smp_worker_topology must be \"auto\", \"percpu\" or \"machine\"");
    this.smp_worker_topology = smp_worker_topology;

    // Ladder step 1 requirements (design §8), probed synchronously; any
    // failure throws for `true` and degrades for "auto".
    let smp_workers_effective = false;
    if(smp_workers)
    {
        const is_node = typeof process === "object" && typeof process.versions === "object" &&
            typeof process.versions.node === "string";
        const shared_memory_available = typeof SharedArrayBuffer !== "undefined" &&
            (typeof globalThis.crossOriginIsolated === "undefined" ||
                Boolean(globalThis.crossOriginIsolated));
        const failure =
            options.multiboot ?
                "multiboot pokes CPU registers from the main thread, which has no guest" :
            options.wasm_fn ?
                "a custom wasm_fn hides the module bytes the worker must instantiate" :
            !WebAssembly.validate(MULTIMEM_PROBE_MODULE) ?
                "WebAssembly multi-memory support is missing" :
            !shared_memory_available ?
                "shared WebAssembly.Memory is unavailable (crossOriginIsolated/SharedArrayBuffer)" :
            options.guest_memory_shared === false ?
                "guest_memory_shared: false conflicts with worker execution" :
            !is_node && typeof Worker === "undefined" ?
                "Worker is unavailable" :
            is_node && typeof process["getBuiltinModule"] !== "function" ?
                "Node without process.getBuiltinModule (needs Node >= 22.3)" :
            "";
        if(failure)
        {
            if(smp_workers === true)
            {
                throw new Error("smp_workers: " + failure);
            }
            dbg_log("smp_workers \"auto\" degraded to time-sliced: " + failure);
        }
        else
        {
            smp_workers_effective = true;
        }
    }
    this.smp_workers_effective = smp_workers_effective;
    // The machine worker is a standalone module entry point (deliberately
    // outside the bundled library — see the Makefile note): embedders whose
    // layout differs from the repository tree pass its URL explicitly.
    // Node default resolves against the working directory.
    this.smp_worker_url = options.smp_worker_url ||
        (typeof window === "undefined"
            ? "./src/browser/vcpu_worker.js"
            : "src/browser/vcpu_worker.js");

    if(smp_workers_effective && guest_memory_backend !== "imported")
    {
        if(options.guest_memory_backend !== undefined)
        {
            dbg_log("smp_workers forces guest_memory_backend \"imported\" " +
                "(overriding \"" + options.guest_memory_backend + "\")");
        }
        guest_memory_backend = "imported";
    }

    let guest_memory = null;
    let guest_memory_is_shared = false;
    let guest_memory_ctl_pages = 0;

    if(guest_memory_backend === "imported")
    {
        // Capability probe before committing to the backend: JIT-generated
        // modules of the multimem build are true multi-memory modules, so an
        // engine without multi-memory support could instantiate the (single
        // -memory) main artifact and gram.wasm fine, then silently fail
        // every JIT compile. Fail at construction instead.
        if(!WebAssembly.validate(MULTIMEM_PROBE_MODULE))
        {
            throw new Error("guest_memory_backend \"imported\" requires WebAssembly " +
                "multi-memory support (JIT-generated modules import guest RAM as a " +
                "second memory), which this engine lacks");
        }

        // worker execution requires the shared variant (the probe above
        // already rejected explicit false)
        guest_memory_is_shared = smp_workers_effective ? true :
            guest_memory_shared_option === "auto"
            ? (typeof globalThis.crossOriginIsolated !== "undefined"
                ? Boolean(globalThis.crossOriginIsolated)
                : typeof SharedArrayBuffer !== "undefined")
            : guest_memory_shared_option;

        // Mirror of CPU.create_memory's size normalisation (cpu.js) — the
        // memory must exist before the module instantiates, long before
        // CPU.init runs; create_memory asserts the two calculations agree.
        // The minimum_size mirrors CPU.init's `settings.initrd ? 64M : 1M`
        // under the conditions continue_init will produce: settings.initrd
        // is populated from options.initrd unconditionally, but from
        // bzimage_initrd_from_filesystem only when there is no initial
        // state (see done() in continue_init — the filesystem-sourced
        // initrd is skipped when a state image overrides boot).
        let guest_memory_size = options.memory_size || 64 * 1024 * 1024;
        const minimum_size =
            options.initrd || (options.bzimage_initrd_from_filesystem && !options.initial_state)
                ? 64 * 1024 * 1024 : 1024 * 1024;
        if(guest_memory_size < minimum_size)
        {
            guest_memory_size = minimum_size;
        }
        else if((guest_memory_size | 0) < 0)
        {
            guest_memory_size = Math.pow(2, 31) - MMAP_BLOCK_SIZE;
        }
        guest_memory_size = ((guest_memory_size - 1) | (MMAP_BLOCK_SIZE - 1)) + 1 | 0;

        // One wasm page more than guest RAM: the JIT slow-path scratch pages
        // live at [memory_size, memory_size + 0x2000) in the guest memory
        // (src/rust/cpu/memory.rs gram_jit_scratch_base). maximum must be
        // present (shared memories require one; gram.wasm's and the JIT
        // modules' import declarations rely on it) and equals initial: guest
        // RAM never grows.
        //
        // Under smp_workers the shared control region follows at CTL_BASE =
        // memory_size + 0x10000 (src/rust/cpu/smpctl.rs / ./smpctl.js —
        // Stage W1): ceil(ctl_size(N)/64K) more pages. N mirrors
        // continue_init's cpus validation; sizing for the raw option value
        // is safe when continue_init later clamps it to 1 (the region only
        // has to be at least as large as the effective count needs).
        const cpus_option = options.cpus || 0;
        const sizing_cpus =
            Number.isInteger(cpus_option) && cpus_option >= 1 && cpus_option <= 255
                ? cpus_option : 1;
        guest_memory_ctl_pages =
            smp_workers_effective ? ctl_pages(sizing_cpus, guest_memory_size) : 0;
        const guest_pages = guest_memory_size / (64 * 1024) + 1 + guest_memory_ctl_pages;
        guest_memory = new WebAssembly.Memory(guest_memory_is_shared
            ? { "initial": guest_pages, "maximum": guest_pages, "shared": true }
            : { "initial": guest_pages, "maximum": guest_pages });
    }

    const wasm_shared_funcs = {
        "cpu_exception_hook": n => this.cpu_exception_hook(n),
        "run_hardware_timers": function(a, t) { return cpu.run_hardware_timers(a, t); },
        "cpu_event_halt": () => { this.emulator_bus.send("cpu-event-halt"); },
        "abort": function() { dbg_assert(false); },
        "microtick": v86.microtick,
        "get_rand_int": function() { return get_rand_int(); },
        "stop_idling": function() { return cpu.stop_idling(); },

        "io_port_read8": function(addr) { return cpu.io.port_read8(addr); },
        "io_port_read16": function(addr) { return cpu.io.port_read16(addr); },
        "io_port_read32": function(addr) { return cpu.io.port_read32(addr); },
        "io_port_write8": function(addr, value) { cpu.io.port_write8(addr, value); },
        "io_port_write16": function(addr, value) { cpu.io.port_write16(addr, value); },
        "io_port_write32": function(addr, value) { cpu.io.port_write32(addr, value); },

        "mmap_read8": function(addr) { return cpu.mmap_read8(addr); },
        "mmap_read32": function(addr) { return cpu.mmap_read32(addr); },
        "mmap_write8": function(addr, value) { cpu.mmap_write8(addr, value); },
        "mmap_write16": function(addr, value) { cpu.mmap_write16(addr, value); },
        "mmap_write32": function(addr, value) { cpu.mmap_write32(addr, value); },
        "mmap_write64": function(addr, value0, value1) { cpu.mmap_write64(addr, value0, value1); },
        "mmap_write128": function(addr, value0, value1, value2, value3) {
            cpu.mmap_write128(addr, value0, value1, value2, value3);
        },

        "log_from_wasm": function(offset, len) {
            const str = read_sized_string_from_mem(wasm_memory, offset, len);
            dbg_log(str, LOG_CPU);
        },
        "console_log_from_wasm": function(offset, len) {
            const str = read_sized_string_from_mem(wasm_memory, offset, len);
            console.error(str);
        },
        "dbg_trace_from_wasm": function() {
            dbg_trace(LOG_CPU);
        },

        "codegen_finalize": (wasm_table_index, start, state_flags, ptr, len) => {
            cpu.codegen_finalize(wasm_table_index, start, state_flags, ptr, len);
        },
        "jit_clear_func": (wasm_table_index) => cpu.jit_clear_func(wasm_table_index),
        "jit_clear_all_funcs": () => cpu.jit_clear_all_funcs(),

        "__indirect_function_table": wasm_table,
    };

    /* global __dirname */

    // Artifact directory rule, shared by the default loader and the gram
    // loader below: an explicit options.wasm_path names the main artifact
    // verbatim (it wins also under guest_memory_backend "imported", where it
    // must then point at a multimem-compatible build — cpu.js verifies), and
    // gram artifacts are expected next to the main artifact.
    const wasm_dirname = () =>
        options.wasm_path ? options.wasm_path.substring(0, options.wasm_path.lastIndexOf("/") + 1) :
        typeof window === "undefined" && typeof __dirname === "string" ? __dirname + "/" :
        "build/";

    let wasm_fn = options.wasm_fn;

    if(!wasm_fn)
    {
        wasm_fn = env =>
        {
            return new Promise(resolve => {
                let v86_bin = DEBUG ? "v86-debug.wasm" : "v86.wasm";
                let v86_bin_fallback = "v86-fallback.wasm";

                if(guest_memory)
                {
                    // multimem build variant (XWAH-9): guest RAM is imported.
                    // No fallback artifact — v86-fallback.wasm is a
                    // single-memory build without the gram import ABI.
                    v86_bin = DEBUG ? "v86-multimem-debug.wasm" : "v86-multimem.wasm";
                    v86_bin_fallback = null;
                }

                if(options.wasm_path)
                {
                    v86_bin = options.wasm_path;
                    v86_bin_fallback = v86_bin_fallback && v86_bin.replace("v86.wasm", "v86-fallback.wasm");
                }
                else
                {
                    v86_bin = wasm_dirname() + v86_bin;
                    v86_bin_fallback = v86_bin_fallback && wasm_dirname() + v86_bin_fallback;
                }

                load_file(v86_bin, {
                    done: async bytes =>
                    {
                        try
                        {
                            const { instance } = await WebAssembly.instantiate(bytes, env);
                            this.wasm_source = bytes;
                            resolve(instance.exports);
                        }
                        catch(err)
                        {
                            if(!v86_bin_fallback)
                            {
                                throw err;
                            }
                            load_file(v86_bin_fallback, {
                                    done: async bytes => {
                                        const { instance } = await WebAssembly.instantiate(bytes, env);
                                        this.wasm_source = bytes;
                                        resolve(instance.exports);
                                    },
                                });
                        }
                    },
                    progress: e =>
                    {
                        this.emulator_bus.send("download-progress", {
                            file_index: 0,
                            file_count: 1,
                            file_name: v86_bin,

                            lengthComputable: e.lengthComputable,
                            total: e.total,
                            loaded: e.loaded,
                        });
                    }
                });
            });
        };
    }

    // Instantiation order under guest_memory_backend "imported"
    // (docs/smp-phase3-design.md §2 option A): the guest memory already
    // exists (above); instantiate the matching gram variant over it, merge
    // its accessor exports plus the JS-implemented gram_copy_out into env,
    // and only then instantiate the main module (default or custom wasm_fn
    // alike — a custom wasm_fn receives the merged env unchanged in shape).
    const build_env = async () =>
    {
        if(!guest_memory)
        {
            return { "env": wasm_shared_funcs };
        }

        const gram_bin = wasm_dirname() + (guest_memory_is_shared ? "gram-shared.wasm" : "gram.wasm");
        // load_file's failure paths only console.error and may never call
        // done (in Node the readFile rejection additionally surfaces
        // through the returned promise, caught here), so check what
        // arrived: a missing or invalid gram artifact must fail the init
        // chain loudly (see the .catch below) instead of hanging it
        let gram_bytes = null;
        try
        {
            gram_bytes = await new Promise((resolve, reject) =>
            {
                Promise.resolve(load_file(gram_bin, { done: resolve })).catch(reject);
            });
        }
        catch(e)
        {
            console.error(e);
        }
        if(!gram_bytes || !WebAssembly.validate(gram_bytes))
        {
            throw new Error("guest_memory_backend \"imported\" requires " +
                (guest_memory_is_shared ? "gram-shared.wasm" : "gram.wasm") +
                " next to the multimem artifact (make gram-wasm), but " + gram_bin +
                " is missing or not a valid WebAssembly module");
        }
        // kept for the machine-worker spawn payload (Stage W2): the worker
        // instantiates its own gram instance over the same shared memory
        this.gram_bytes = gram_bytes;
        // gram instantiation + env merge (incl. the JS-implemented
        // gram_copy_out, the svga LFB path): the shape is shared with the
        // worker runtime — see src/browser/gram_env.js
        return build_gram_env(wasm_shared_funcs, gram_bytes, guest_memory,
            () => wasm_memory.buffer);
    };

    build_env()
        .then(env => wasm_fn(env))
        .then((exports) => {
            wasm_memory = exports.memory;
            exports["rust_init"]();

            const emulator = this.v86 = new v86(this.emulator_bus, {
                exports,
                wasm_table,
                guest_memory,
                // plumbed alongside guest_memory itself so the CPU and the
                // copy-first shims never have to sniff the buffer's type
                // (the SharedArrayBuffer global can be hidden while shared
                // memory still works)
                guest_memory_shared: guest_memory_is_shared,
                // control-region sizing (smp_workers), for create_memory's
                // cross-check of the guest memory's total size
                guest_memory_ctl_pages,
            });
            cpu = emulator.cpu;

            return this.continue_init(emulator, options);
        })
        .catch(e => {
            // a swallowed rejection here would leave the emulator silently
            // half-constructed (no "emulator-loaded", no error): log
            // prominently, notify listeners (same channel as the
            // "download-error" precedent above), and rethrow asynchronously
            // so embedders get an uncaught error instead of a silent hang
            console.error("Failed to initialize the emulator:", e);
            this.emulator_bus && this.emulator_bus.send("emulator-error", e);
            setTimeout(() => { throw e; }, 0);
        });

    this.zstd_worker = null;
    this.zstd_worker_request_id = 0;
}

V86.prototype.continue_init = async function(emulator, options)
{
    this.bus.register("emulator-stopped", function()
    {
        this.cpu_is_running = false;
        this.screen_adapter.pause();
    }, this);

    this.bus.register("emulator-started", function()
    {
        this.cpu_is_running = true;
        this.screen_adapter.continue();
    }, this);

    var settings = {};

    const boot_order =
        options.boot_order ? options.boot_order :
        options.fda ? BOOT_ORDER_FD_FIRST :
        options.hda ? BOOT_ORDER_HD_FIRST : BOOT_ORDER_CD_FIRST;

    if(options.modem)
    {
        settings.modem = options.modem;
        switch(options.modem.uart)
        {
            case 1:
                options.uart1 = true;
                break;
            case 2:
                options.uart2 = true;
                break;
            case 3:
                options.uart3 = true;
                break;
        }
    }

    settings.acpi = options.acpi;
    settings.disable_jit = options.disable_jit;
    settings.load_devices = true;
    settings.memory_size = options.memory_size || 64 * 1024 * 1024;
    settings.vga_memory_size = options.vga_memory_size || 8 * 1024 * 1024;
    settings.boot_order = boot_order;
    settings.fastboot = options.fastboot || false;
    settings.fda = undefined;
    settings.fdb = undefined;
    settings.uart1 = options.uart1;
    settings.uart2 = options.uart2;
    settings.uart3 = options.uart3;
    settings.parallel1 = options.parallel1;
    settings.cmdline = options.cmdline;
    settings.preserve_mac_from_state_image = options.preserve_mac_from_state_image;
    settings.mac_address_translation = options.mac_address_translation;
    settings.cpuid_level = options.cpuid_level;
    // NOTE: Experimental (XWAH-9): time-sliced SMP — the firmware
    // advertises all CPUs and secondary CPUs actually boot, multiplexed on
    // one host thread. Requires acpi (the LAPIC MMIO window is gated on
    // acpi_enabled; without it the guest could never start or interrupt
    // the secondary CPUs)
    const cpus = options.cpus === undefined ? 1 : options.cpus;
    const cpus_valid = Number.isInteger(cpus) && cpus >= 1 && cpus <= 255;
    dbg_assert(cpus_valid, "options.cpus must be an integer between 1 and 255");
    const cpus_without_acpi = cpus_valid && cpus > 1 && !options.acpi;
    dbg_assert(!cpus_without_acpi, "options.cpus > 1 requires acpi: true");
    if(cpus_without_acpi)
    {
        dbg_log("cpus option clamped to 1: cpus > 1 requires acpi: true " +
            "(the LAPIC MMIO window is gated on acpi_enabled, so secondary " +
            "CPUs could never be started or interrupted)");
    }
    settings.cpus = cpus_valid && !cpus_without_acpi ? cpus : 1;
    settings.virtio_balloon = options.virtio_balloon;
    settings.virtio_console = !!options.virtio_console;
    if(options.virtio_gpu &&
       (options.virtio_gpu.backend === "wgpu" || options.virtio_gpu.backend === "webgpu-js"))
    {
        settings.virtio_gpu = Object.assign({}, options.virtio_gpu, {
            screen_container: options.virtio_gpu.screen_container ||
                options.screen && options.screen.container || options.screen_container,
        });
    }
    else
    {
        settings.virtio_gpu = options.virtio_gpu;
    }

    const relay_url = options.network_relay_url || options.net_device && options.net_device.relay_url;
    if(relay_url)
    {
        // TODO: remove bus, use direct calls instead
        if(relay_url === "fetch")
        {
            this.network_adapter = new FetchNetworkAdapter(this.bus, options.net_device);
        }
        else if(relay_url === "inbrowser")
        {
            // NOTE: experimental, will change when usage of options.net_device gets refactored in favour of emulator.bus
            this.network_adapter = new InBrowserNetworkAdapter(this.bus, options.net_device);
        }
        else if(relay_url.startsWith("wisp://") || relay_url.startsWith("wisps://"))
        {
            this.network_adapter = new WispNetworkAdapter(relay_url, this.bus, options.net_device);
        }
        else
        {
            this.network_adapter = new NetworkAdapter(relay_url, this.bus);
        }
    }

    // Enable unconditionally, so that state images don't miss hardware
    // TODO: Should be properly fixed in restore_state
    settings.net_device = options.net_device || { type: "ne2k" };

    const screen_options = options.screen || {};
    if(options.screen_container)
    {
        screen_options.container = options.screen_container;
    }

    if(!options.disable_keyboard)
    {
        this.keyboard_adapter = new KeyboardAdapter(this.bus);
    }
    if(!options.disable_mouse)
    {
        this.mouse_adapter = new MouseAdapter(this.bus, screen_options.container);
    }

    // Pointer lock is not needed while the guest uses absolute pointer
    // positions (the guest cursor follows the host cursor), so release it
    // when the guest driver enables absolute positioning
    this.absolute_pointer_enabled = false;
    this.bus.register("vmware-absolute-mouse", function(enabled)
    {
        if(enabled && !this.absolute_pointer_enabled &&
            typeof document !== "undefined" && document.pointerLockElement)
        {
            document.exitPointerLock();
        }
        this.absolute_pointer_enabled = enabled;
    }, this);

    if(screen_options.container)
    {
        this.screen_adapter = new ScreenAdapter(screen_options, () => this.v86.cpu.devices.vga && this.v86.cpu.devices.vga.screen_fill_buffer());
    }
    else if(screen_options.ansi)
    {
        this.screen_adapter = new ANSIScreenAdapter(screen_options);
    }
    else
    {
        this.screen_adapter = new DummyScreenAdapter(screen_options);
    }
    settings.screen = this.screen_adapter;
    settings.screen_options = screen_options;

    settings.serial_console = options.serial_console || { type: "none" };

    // NOTE: serial_container_xtermjs and serial_container are deprecated
    if(options.serial_container_xtermjs)
    {
        settings.serial_console.type = "xtermjs";
        settings.serial_console.container = options.serial_container_xtermjs;
    }
    else if(options.serial_container)
    {
        settings.serial_console.type = "textarea";
        settings.serial_console.container = options.serial_container;
    }

    if(settings.serial_console?.type === "xtermjs")
    {
        const xterm_lib = settings.serial_console.xterm_lib || window["Terminal"];
        this.serial_adapter = new SerialAdapterXtermJS(settings.serial_console.container, this.bus, xterm_lib);
    }
    else if(settings.serial_console?.type === "textarea")
    {
        this.serial_adapter = new SerialAdapter(settings.serial_console.container, this.bus);
        //this.recording_adapter = new SerialRecordingAdapter(this.bus);
    }

    const virtio_console_settings = (options.virtio_console && typeof options.virtio_console === "boolean") ? { type: "none" } : options.virtio_console;

    if(virtio_console_settings?.type === "xtermjs")
    {
        const xterm_lib = virtio_console_settings.xterm_lib || window["Terminal"];
        this.virtio_console_adapter = new VirtioConsoleAdapterXtermJS(virtio_console_settings.container, this.bus, xterm_lib);
    }
    else if(virtio_console_settings?.type === "textarea")
    {
        this.virtio_console_adapter = new VirtioConsoleAdapter(virtio_console_settings.container, this.bus);
    }

    if(settings.modem)
    {
        this.modem = new Modem(this.bus, settings.modem);
    }

    if(!options.disable_speaker)
    {
        this.speaker_adapter = new SpeakerAdapter(this.bus);
    }

    // ugly, but required for closure compiler compilation
    function put_on_settings(name, buffer)
    {
        switch(name)
        {
            case "hda":
                settings.hda = buffer;
                break;
            case "hdb":
                settings.hdb = buffer;
                break;
            case "cdrom":
                settings.cdrom = buffer;
                break;
            case "fda":
                settings.fda = buffer;
                break;
            case "fdb":
                settings.fdb = buffer;
                break;

            case "multiboot":
                settings.multiboot = buffer.buffer;
                break;
            case "bzimage":
                settings.bzimage = buffer.buffer;
                break;
            case "initrd":
                settings.initrd = buffer.buffer;
                break;

            case "bios":
                settings.bios = buffer.buffer;
                break;
            case "vga_bios":
                settings.vga_bios = buffer.buffer;
                break;
            case "initial_state":
                settings.initial_state = buffer.buffer;
                break;
            case "fs9p_json":
                settings.fs9p_json = buffer;
                break;
            default:
                dbg_assert(false, name);
        }
    }

    var files_to_load = [];

    const add_file = (name, file) =>
    {
        if(!file)
        {
            return;
        }

        if(file.get && file.set && file.load)
        {
            files_to_load.push({
                name: name,
                loadable: file,
            });
            return;
        }

        if(name === "bios" || name === "vga_bios" ||
            name === "initial_state" || name === "multiboot" ||
            name === "bzimage" || name === "initrd")
        {
            // Ignore async for these because they must be available before boot.
            // This should make result.buffer available after the object is loaded
            file.async = false;
        }

        if(name === "fda" || name === "fdb")
        {
            // small, doesn't make sense loading asynchronously
            file.async = false;
        }

        if(file.url && !file.async)
        {
            files_to_load.push({
                name: name,
                url: file.url,
                size: file.size,
            });
        }
        else
        {
            files_to_load.push({
                name,
                loadable: buffer_from_object(file, this.zstd_decompress_worker.bind(this)),
            });
        }
    };

    if(options.state)
    {
        console.warn("Warning: Unknown option 'state'. Did you mean 'initial_state'?");
    }

    add_file("bios", options.bios);
    add_file("vga_bios", options.vga_bios);
    add_file("cdrom", options.cdrom);
    add_file("hda", options.hda);
    add_file("hdb", options.hdb);
    add_file("fda", options.fda);
    add_file("fdb", options.fdb);
    add_file("initial_state", options.initial_state);
    add_file("multiboot", options.multiboot);
    add_file("bzimage", options.bzimage);
    add_file("initrd", options.initrd);

    if(options.filesystem && options.filesystem.handle9p)
    {
        settings.handle9p = options.filesystem.handle9p;
    }
    else if(options.filesystem && options.filesystem.proxy_url)
    {
        settings.proxy9p = options.filesystem.proxy_url;
    }
    else if(options.filesystem)
    {
        var fs_url = options.filesystem.basefs;
        var base_url = options.filesystem.baseurl;

        let file_storage = new MemoryFileStorage();

        if(base_url)
        {
            file_storage = new ServerFileStorageWrapper(
                file_storage, base_url, this.zstd_decompress_worker.bind(this));
        }
        settings.fs9p = this.fs9p = new FS(
            file_storage, undefined, options.filesystem.total_size);

        if(fs_url)
        {
            dbg_assert(base_url, "Filesystem: baseurl must be specified");

            var size;

            if(typeof fs_url === "object")
            {
                size = fs_url.size;
                fs_url = fs_url.url;
            }
            dbg_assert(typeof fs_url === "string");

            files_to_load.push({
                name: "fs9p_json",
                url: fs_url,
                size: size,
                as_json: true,
            });
        }
    }

    var starter = this;
    var total = files_to_load.length;

    var cont = function(index)
    {
        if(index === total)
        {
            setTimeout(done.bind(this), 0);
            return;
        }

        var f = files_to_load[index];

        if(f.loadable)
        {
            f.loadable.onload = function(e)
            {
                put_on_settings.call(this, f.name, f.loadable);
                cont(index + 1);
            }.bind(this);
            f.loadable.load();
        }
        else
        {
            load_file(f.url, {
                done: function(result)
                {
                    if(f.url.endsWith(".zst") && f.name !== "initial_state")
                    {
                        dbg_assert(f.size, "A size must be provided for compressed images");
                        result = this.zstd_decompress(f.size, new Uint8Array(result));
                    }

                    put_on_settings.call(this, f.name, f.as_json ? result : new SyncBuffer(result));
                    cont(index + 1);
                }.bind(this),
                progress: function progress(e)
                {
                    if(e.target.status === 200)
                    {
                        starter.emulator_bus.send("download-progress", {
                            file_index: index,
                            file_count: total,
                            file_name: f.url,

                            lengthComputable: e.lengthComputable,
                            total: e.total || f.size,
                            loaded: e.loaded,
                        });
                    }
                    else
                    {
                        starter.emulator_bus.send("download-error", {
                            file_index: index,
                            file_count: total,
                            file_name: f.url,
                            request: e.target,
                        });
                    }
                },
                as_json: f.as_json,
            });
        }
    }.bind(this);
    cont(0);

    async function done()
    {
        //if(settings.initial_state)
        //{
        //    // avoid large allocation now, memory will be restored later anyway
        //    settings.memory_size = 0;
        //}

        if(settings.fs9p && settings.fs9p_json)
        {
            if(!settings.initial_state)
            {
                settings.fs9p.load_from_json(settings.fs9p_json);

                if(options.bzimage_initrd_from_filesystem)
                {
                    const { bzimage_path, initrd_path } = this.get_bzimage_initrd_from_filesystem(settings.fs9p);

                    dbg_log("Found bzimage: " + bzimage_path + " and initrd: " + initrd_path);

                    const [initrd, bzimage] = await Promise.all([
                        settings.fs9p.read_file(initrd_path),
                        settings.fs9p.read_file(bzimage_path),
                    ]);
                    put_on_settings.call(this, "initrd", new SyncBuffer(initrd.buffer));
                    put_on_settings.call(this, "bzimage", new SyncBuffer(bzimage.buffer));
                }
            }
            else
            {
                dbg_log("Filesystem basefs ignored: Overridden by state image");
            }
        }
        else
        {
            dbg_assert(
                !options.bzimage_initrd_from_filesystem || settings.initial_state,
                "bzimage_initrd_from_filesystem: Requires a filesystem");
        }

        this.serial_adapter && this.serial_adapter.show && this.serial_adapter.show();
        this.virtio_console_adapter && this.virtio_console_adapter.show && this.virtio_console_adapter.show();

        this.v86.init(settings);

        // Stages W2/W3 (docs/smp-phase4-design.md §9): hand execution to
        // the worker(s). Topology resolution: "percpu" (or "auto" with
        // cpus > 1) spawns one worker per vCPU — topology (b); otherwise
        // the whole machine runs in one worker — topology (c). Spawn
        // failures degrade one ladder step under "auto" (time-sliced over
        // the already-created imported memory) and fail loudly under
        // `true`. The "smp-mode" event below reports whatever this
        // resolves to.
        let topology_effective = null;
        if(this.smp_workers_effective)
        {
            topology_effective =
                this.smp_worker_topology === "percpu" ||
                this.smp_worker_topology === "auto" && emulator.cpu.smp_cpus > 1
                    ? "percpu" : "machine";
            try
            {
                if(topology_effective === "percpu")
                {
                    await this.smp_vcpu_start(emulator, settings);
                }
                else
                {
                    await this.smp_worker_start(emulator, settings);
                }
            }
            catch(e)
            {
                if(this.smp_workers === true)
                {
                    this.emulator_bus.send("emulator-error", e);
                    throw e;
                }
                dbg_log("smp_workers \"auto\" degraded to time-sliced: " +
                    "worker spawn failed: " + e);
                this.smp_workers_effective = false;
                topology_effective = null;
            }
        }
        this.smp_mode = {
            "execution": this.smp_worker_host ? "workers" : "time-sliced",
            "topology": topology_effective,
            "cpus_effective": emulator.cpu.smp_cpus,
            "guest_memory": {
                "backend": emulator.cpu.guest_memory ? "imported" : "linear",
                "shared": emulator.cpu.guest_memory_shared,
            },
        };
        this.emulator_bus.send("smp-mode", this.smp_mode);

        this.modem && this.modem.initialize();

        if(settings.initial_state)
        {
            // worker-aware (Stage W4): under smp_workers the workers are
            // still parked here (run() only fires on emulator-started), so
            // the restore distributes the state before anything executes
            await this.restore_state_internal(settings.initial_state);

            // The GC can't free settings, since it is referenced from
            // several closures. This isn't needed anymore, so we delete it
            // here
            settings.initial_state = undefined;
        }

        if(options.autostart)
        {
            this.v86.run();
        }

        this.emulator_bus.send("emulator-loaded");
    }
};

/**
 * Stage W2: spawn the machine worker, hand it the module/gram bytes and the
 * shared guest memory, and rewire this thread's CPU object into the device
 * host (CPU.attach_smp_worker_host). Resolves at machine-ready; rejects on
 * spawn/instantiate failure, leaving nothing wired (the caller decides
 * between fail-stop and ladder degradation).
 * @param {!Object} emulator
 * @param {!Object} settings
 * @return {!Promise}
 */
V86.prototype.smp_worker_start = async function(emulator, settings)
{
    const cpu = emulator.cpu;
    if(!this.wasm_source)
    {
        throw new Error("smp_workers requires the built-in wasm loader " +
            "(the worker instantiates the same module bytes)");
    }
    const host = new SMPWorkerHost(cpu, this.emulator_bus, cpu.guest_memory, cpu.smp_cpus);
    host.cpu_exception_hook = n => this.cpu_exception_hook(n);
    try
    {
        await host.start({
            worker_url: this.smp_worker_url,
            wasm_source: this.wasm_source,
            gram_bytes: this.gram_bytes,
            guest_memory: cpu.guest_memory,
            acpi: !!settings.acpi,
            disable_jit: !!settings.disable_jit,
            cpuid_level: settings.cpuid_level,
        });
    }
    catch(e)
    {
        host.stop_service_loop();
        host.channel && host.channel.terminate();
        throw e;
    }
    cpu.attach_smp_worker_host(host);
    this.smp_worker_host = host;
    // the §8 command protocol follows the emulator lifecycle: run resumes
    // the machine loop, stop parks it at the next slice boundary
    this.bus.register("emulator-started", function() { host.run(); }, this);
    this.bus.register("emulator-stopped", function() { host.park(); }, this);
};

/**
 * Stage W3, topology (b): spawn one worker per vCPU, hand each the
 * module/gram bytes and the shared guest memory, and rewire this thread's
 * CPU object into the (b) device host (CPU.attach_smp_vcpu_host; the main
 * instance keeps the authoritative chipset and set_worker_host makes its
 * interrupt routing post to the workers). Resolves when every worker is
 * ready; rejects on any spawn/instantiate failure, tearing down whatever
 * was spawned (the caller decides between fail-stop and degradation).
 * @param {!Object} emulator
 * @param {!Object} settings
 * @return {!Promise}
 */
V86.prototype.smp_vcpu_start = async function(emulator, settings)
{
    const cpu = emulator.cpu;
    if(!this.wasm_source)
    {
        throw new Error("smp_workers requires the built-in wasm loader " +
            "(the workers instantiate the same module bytes)");
    }
    const host = new SMPVcpuHost(cpu, this.emulator_bus, cpu.guest_memory, cpu.smp_cpus);
    host.cpu_exception_hook = n => this.cpu_exception_hook(n);
    try
    {
        await host.start({
            worker_url: this.smp_worker_url,
            wasm_source: this.wasm_source,
            gram_bytes: this.gram_bytes,
            guest_memory: cpu.guest_memory,
            acpi: !!settings.acpi,
            disable_jit: !!settings.disable_jit,
            cpuid_level: settings.cpuid_level,
        });
    }
    catch(e)
    {
        host.stop_service_loops();
        for(const channel of host.channels)
        {
            channel.terminate();
        }
        // leave the main instance out of host mode again (ladder step-down
        // back to time-sliced execution on this thread)
        cpu.wm.exports["set_worker_host"](0);
        throw e;
    }
    cpu.attach_smp_vcpu_host(host);
    this.smp_worker_host = host;
    this.bus.register("emulator-started", function() { host.run(); }, this);
    this.bus.register("emulator-stopped", function() { host.park(); }, this);
};

/**
 * @param {number} decompressed_size
 * @param {Uint8Array} src
 * @return {ArrayBuffer}
 */
V86.prototype.zstd_decompress = function(decompressed_size, src)
{
    const cpu = this.v86.cpu;

    dbg_assert(!this.zstd_context);
    this.zstd_context = cpu.zstd_create_ctx(src.length);

    new Uint8Array(cpu.wasm_memory.buffer).set(src, cpu.zstd_get_src_ptr(this.zstd_context));

    const ptr = cpu.zstd_read(this.zstd_context, decompressed_size);
    const result = cpu.wasm_memory.buffer.slice(ptr, ptr + decompressed_size);
    cpu.zstd_read_free(ptr, decompressed_size);

    cpu.zstd_free_ctx(this.zstd_context);
    this.zstd_context = null;

    return result;
};

/**
 * @param {number} decompressed_size
 * @param {!Uint8Array} src
 * @return {!Promise<!ArrayBuffer>}
 */
V86.prototype.zstd_decompress_worker = async function(decompressed_size, src)
{
    if(!this.zstd_worker)
    {
        function the_worker()
        {
            let wasm;

            globalThis.onmessage = function(e)
            {
                if(!wasm)
                {
                    const env = Object.fromEntries([
                        "cpu_exception_hook", "run_hardware_timers",
                        "cpu_event_halt", "microtick", "get_rand_int", "stop_idling",
                        "io_port_read8", "io_port_read16", "io_port_read32",
                        "io_port_write8", "io_port_write16", "io_port_write32",
                        "mmap_read8", "mmap_read32",
                        "mmap_write8", "mmap_write16", "mmap_write32", "mmap_write64", "mmap_write128",
                        "codegen_finalize",
                        "jit_clear_func", "jit_clear_all_funcs",
                    ].map(f => [f, () => console.error("zstd worker unexpectedly called " + f)]));

                    env["__indirect_function_table"] = new WebAssembly.Table({ element: "anyfunc", initial: 1024 });
                    env["abort"] = () => { throw new Error("zstd worker aborted"); };
                    env["log_from_wasm"] = env["console_log_from_wasm"] = (off, len) => {
                        console.log(read_sized_string_from_mem(wasm.exports.memory.buffer, off, len));
                    };
                    env["dbg_trace_from_wasm"] = () => console.trace();

                    const module = new WebAssembly.Module(e.data);

                    // stub the multimem build's gram_* guest-RAM accessors:
                    // zstd decompression is self-contained in the module's
                    // own memory, so they are the only imports legitimately
                    // absent here and none of them are expected to be
                    // called. Anything else unknown must keep producing a
                    // hard LinkError at instantiation.
                    for(const import_entry of WebAssembly.Module.imports(module))
                    {
                        const name = import_entry["name"];
                        if(import_entry["module"] === "env" && import_entry["kind"] === "function" &&
                            name.startsWith("gram_") && !env[name])
                        {
                            env[name] = () => console.error("zstd worker unexpectedly called " + name);
                        }
                    }

                    wasm = new WebAssembly.Instance(module, { "env": env });
                    return;
                }

                const { src, decompressed_size, id } = e.data;
                const exports = wasm.exports;

                const zstd_context = exports["zstd_create_ctx"](src.length);
                new Uint8Array(exports.memory.buffer).set(src, exports["zstd_get_src_ptr"](zstd_context));

                const ptr = exports["zstd_read"](zstd_context, decompressed_size);
                const result = exports.memory.buffer.slice(ptr, ptr + decompressed_size);
                exports["zstd_read_free"](ptr, decompressed_size);

                exports["zstd_free_ctx"](zstd_context);

                postMessage({ result, id }, [result]);
            };
        }

        const url = URL.createObjectURL(new Blob(["(" + the_worker.toString() + ")()"], { type: "text/javascript" }));
        this.zstd_worker = new Worker(url);
        URL.revokeObjectURL(url);
        // under worker execution the module bytes must stay intact for the
        // machine-worker spawn (smp_worker_start), so clone instead of
        // transferring them to the zstd worker
        this.zstd_worker.postMessage(this.wasm_source,
            this.smp_workers_effective ? [] : [this.wasm_source]);
    }

    return new Promise(resolve => {
        const id = this.zstd_worker_request_id++;
        const done = async e =>
        {
            if(e.data.id === id)
            {
                this.zstd_worker.removeEventListener("message", done);
                dbg_assert(decompressed_size === e.data.result.byteLength);
                resolve(e.data.result);
            }
        };
        this.zstd_worker.addEventListener("message", done);
        this.zstd_worker.postMessage({ src, decompressed_size, id }, [src.buffer]);
    });
};

V86.prototype.get_bzimage_initrd_from_filesystem = function(filesystem)
{
    const root = (filesystem.read_dir("/") || []).map(x => "/" + x);
    const boot = (filesystem.read_dir("/boot/") || []).map(x => "/boot/" + x);

    let initrd_path;
    let bzimage_path;

    for(const f of [].concat(root, boot))
    {
        const old = /old/i.test(f) || /fallback/i.test(f);
        const is_bzimage = /vmlinuz/i.test(f) || /bzimage/i.test(f);
        const is_initrd = /initrd/i.test(f) || /initramfs/i.test(f);

        if(is_bzimage && (!bzimage_path || !old))
        {
            bzimage_path = f;
        }

        if(is_initrd && (!initrd_path || !old))
        {
            initrd_path = f;
        }
    }

    if(!initrd_path || !bzimage_path)
    {
        console.log("Failed to find bzimage or initrd in filesystem. Files:");
        console.log(root.join(" "));
        console.log(boot.join(" "));
    }

    return { initrd_path, bzimage_path };
};

/**
 * Start emulation. Do nothing if emulator is running already. Can be asynchronous.
 */
V86.prototype.run = async function()
{
    this.v86.run();
};

/**
 * Stop emulation. Do nothing if emulator is not running. Can be asynchronous.
 */
V86.prototype.stop = async function()
{
    if(!this.cpu_is_running)
    {
        return;
    }

    await new Promise(resolve => {
        const listener = () => {
            this.remove_listener("emulator-stopped", listener);
            resolve();
        };
        this.add_listener("emulator-stopped", listener);
        this.v86.stop();
    });
};

/**
 * Free resources associated with this instance
 */
V86.prototype.destroy = async function()
{
    await this.stop();

    if(this.smp_worker_host)
    {
        await this.smp_worker_host.terminate();
        this.smp_worker_host = null;
    }

    const virtio_gpu = this.v86.cpu.devices.virtio_gpu;
    if(virtio_gpu)
    {
        await virtio_gpu.dispose();
    }
    this.v86.destroy();
    this.keyboard_adapter && this.keyboard_adapter.destroy();
    this.network_adapter && this.network_adapter.destroy();
    this.mouse_adapter && this.mouse_adapter.destroy();
    this.screen_adapter && this.screen_adapter.destroy();
    this.serial_adapter && this.serial_adapter.destroy();
    this.speaker_adapter && this.speaker_adapter.destroy();
    this.virtio_console_adapter && this.virtio_console_adapter.destroy();
    this.modem && this.modem.destroy();
};

/**
 * Restart (force a reboot).
 */
V86.prototype.restart = function()
{
    this.v86.restart();
};

/**
 * Add an event listener (the emulator is an event emitter).
 *
 * The callback function gets a single argument which depends on the event.
 *
 * @param {string} event Name of the event.
 * @param {function(?)} listener The callback function.
 */
V86.prototype.add_listener = function(event, listener)
{
    this.bus.register(event, listener, this);
};

/**
 * Remove an event listener.
 *
 * @param {string} event
 * @param {function(*)} listener
 */
V86.prototype.remove_listener = function(event, listener)
{
    this.bus.unregister(event, listener);
};

/**
 * Restore the emulator state from the given state, which must be an
 * ArrayBuffer returned by
 * [`save_state`](#save_statefunctionobject-arraybuffer-callback).
 *
 * Note that the state can only be restored correctly if this constructor has
 * been created with the same options as the original instance (e.g., same disk
 * images, memory size, etc.).
 *
 * Different versions of the emulator might use a different format for the
 * state buffer.
 *
 * @param {ArrayBuffer} state
 */
V86.prototype.restore_state = async function(state)
{
    dbg_assert(arguments.length === 1);
    await this.restore_state_internal(state);
};

/**
 * Worker-aware restore (XWAH-9 Phase 4 Stage W4, design §7). Without a
 * worker host this is today's synchronous restore. Under smp_workers:
 * quiesce all workers (each parks at its next slice boundary; a mid-RPC
 * worker completes the RPC first — the device host keeps servicing),
 * validate and restore the main instance exactly as today (fail-fast
 * intact: a rejected image leaves the machine unharmed and resumed), then
 * distribute each worker's state regions and resume.
 * @param {ArrayBuffer} state
 */
V86.prototype.restore_state_internal = async function(state)
{
    const host = this.smp_worker_host;
    if(!host)
    {
        this.v86.restore_state(state);
        return;
    }
    const was_running = await host.quiesce();
    try
    {
        this.v86.restore_state(state);
    }
    catch(e)
    {
        // the fail-fast validation rejected the image before any mutation:
        // the quiesced machine is intact, resume it
        host.resume(was_running);
        throw e;
    }
    await host.distribute_restore();
    host.resume(was_running);
};

/**
 * Asynchronously save the current state of the emulator.
 *
 * @return {Promise<ArrayBuffer>}
 */
V86.prototype.save_state = async function()
{
    dbg_assert(arguments.length === 0);
    const host = this.smp_worker_host;
    if(!host)
    {
        return this.v86.save_state();
    }
    // XWAH-9 Phase 4 Stage W4 (design §7): quiesce, pull every worker's
    // state regions into the main instance, run today's get_state
    // unchanged (v7 extends untouched), resume. The capture runs inside
    // assemble_save, synchronously after its final in-flight-interrupt
    // drain — the device tick must not slip a vector into the control
    // region between drain and capture.
    const was_running = await host.quiesce();
    try
    {
        return await host.assemble_save(() => this.v86.save_state());
    }
    finally
    {
        host.resume(was_running);
    }
};

/**
 * @return {number}
 * @ignore
 */
V86.prototype.get_instruction_counter = function()
{
    if(this.smp_worker_host && this.smp_worker_host.sum_instruction_counters)
    {
        // topology (b): the guest executes in the vCPU workers; sum the
        // per-worker published counters (design §8 — approximate, per
        // slice). The main instance's own counter stays 0.
        return this.smp_worker_host.sum_instruction_counters();
    }
    if(this.v86)
    {
        return this.v86.cpu.instruction_counter[0] >>> 0;
    }
    else
    {
        // TODO: Should be handled using events
        return 0;
    }
};

/**
 * @return {boolean}
 */
V86.prototype.is_running = function()
{
    return this.cpu_is_running;
};

/**
 * Set the image inserted in the floppy drive. Can be changed at runtime, as
 * when physically changing the floppy disk.
 */
V86.prototype.set_fda = async function(file)
{
    const fda = this.v86.cpu.devices.fdc.drives[0];
    if(file.url && !file.async)
    {
        await new Promise(resolve => {
            load_file(file.url, {
                done: result =>
                {
                    fda.insert_disk(new SyncBuffer(result));
                    resolve();
                }
            });
        });
    }
    else
    {
        const image = buffer_from_object(file, this.zstd_decompress_worker.bind(this));
        image.onload = () =>
        {
            fda.insert_disk(image);
        };
        await image.load();
    }
};

/**
 * Set the image inserted in the second floppy drive, also at runtime.
 */
V86.prototype.set_fdb = async function(file)
{
    const fdb = this.v86.cpu.devices.fdc.drives[1];
    if(file.url && !file.async)
    {
        await new Promise(resolve => {
            load_file(file.url, {
                done: result =>
                {
                    fdb.insert_disk(new SyncBuffer(result));
                    resolve();
                }
            });
        });
    }
    else
    {
        const image = buffer_from_object(file, this.zstd_decompress_worker.bind(this));
        image.onload = () =>
        {
            fdb.insert_disk(image);
        };
        await image.load();
    }
};

/**
 * Eject floppy drive fda.
 */
V86.prototype.eject_fda = function()
{
    this.v86.cpu.devices.fdc.drives[0].eject_disk();
};

/**
 * Eject second floppy drive fdb.
 */
V86.prototype.eject_fdb = function()
{
    this.v86.cpu.devices.fdc.drives[1].eject_disk();
};

/**
 * Return buffer object of floppy disk of drive fda or null if the drive is empty.
 * @return {Uint8Array|null}
 */
V86.prototype.get_disk_fda = function()
{
    return this.v86.cpu.devices.fdc.drives[0].get_buffer();
};

/**
 * Return buffer object of second floppy disk of drive fdb or null if the drive is empty.
 * @return {Uint8Array|null}
 */
V86.prototype.get_disk_fdb = function()
{
    return this.v86.cpu.devices.fdc.drives[1].get_buffer();
};

/**
 * Set the image inserted in the CD-ROM drive. Can be changed at runtime, as
 * when physically changing the CD-ROM.
 */
V86.prototype.set_cdrom = async function(file)
{
    if(file.url && !file.async)
    {
        load_file(file.url, {
            done: result =>
            {
                this.v86.cpu.devices.cdrom.set_cdrom(new SyncBuffer(result));
            },
        });
    }
    else
    {
        const image = buffer_from_object(file, this.zstd_decompress_worker.bind(this));
        image.onload = () =>
        {
            this.v86.cpu.devices.cdrom.set_cdrom(image);
        };
        await image.load();
    }
};

/**
 * Eject the CD-ROM.
 */
V86.prototype.eject_cdrom = function()
{
    this.v86.cpu.devices.cdrom.eject();
};

/**
 * Send a sequence of scan codes to the emulated PS2 controller. A list of
 * codes can be found at http://stanislavs.org/helppc/make_codes.html.
 * Do nothing if there is no keyboard controller.
 *
 * @param {Array.<number>} codes
 * @param {number=} delay
 */
V86.prototype.keyboard_send_scancodes = async function(codes, delay)
{
    for(var i = 0; i < codes.length; i++)
    {
        this.bus.send("keyboard-code", codes[i]);
        if(delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
};

/**
 * Send translated keys
 * @param {Array.<number>} codes
 * @param {number=} delay
 */
V86.prototype.keyboard_send_keys = async function(codes, delay)
{
    for(var i = 0; i < codes.length; i++)
    {
        this.keyboard_adapter.simulate_press(codes[i]);
        if(delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
};

/**
 * Send text, assuming the guest OS uses a US keyboard layout
 * @param {string} string
 * @param {number=} delay
 */
V86.prototype.keyboard_send_text = async function(string, delay)
{
    for(var i = 0; i < string.length; i++)
    {
        this.keyboard_adapter.simulate_char(string[i]);
        if(delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
};

/**
 * Download a screenshot (returns an <img> element, only works in browsers)
 */
V86.prototype.screen_make_screenshot = function()
{
    if(this.screen_adapter)
    {
        return this.screen_adapter.make_screenshot();
    }
    return null;
};

/**
 * Set the scaling level of the emulated screen.
 *
 * @param {number} sx
 * @param {number} sy
 */
V86.prototype.screen_set_scale = function(sx, sy)
{
    if(this.screen_adapter)
    {
        this.screen_adapter.set_scale(sx, sy);
    }
};

/**
 * Go fullscreen (only browsers)
 */
V86.prototype.screen_go_fullscreen = function()
{
    if(!this.screen_adapter)
    {
        return;
    }

    var elem = document.getElementById("screen_container");

    if(!elem)
    {
        return;
    }

    // bracket notation because otherwise they get renamed by closure compiler
    var fn = elem["requestFullScreen"] ||
            elem["webkitRequestFullscreen"] ||
            elem["mozRequestFullScreen"] ||
            elem["msRequestFullScreen"];

    if(fn)
    {
        fn.call(elem);

        // This is necessary, because otherwise chromium keyboard doesn't work anymore.
        // Might (but doesn't seem to) break something else
        var focus_element = document.getElementsByClassName("phone_keyboard")[0];
        focus_element && focus_element.focus();
    }

    try {
        navigator.keyboard.lock();
    } catch(e) {}

    this.lock_mouse();
};

/**
 * Lock the mouse cursor: It becomes invisble and is not moved out of the
 * browser window.
 */
V86.prototype.lock_mouse = async function()
{
    const elem = document.body;

    try
    {
        await elem.requestPointerLock({
            unadjustedMovement: true,
        });
    }
    catch(e)
    {
        // as per MDN, retry without unadjustedMovement option
        await elem.requestPointerLock();
    }
};

/**
 * Enable or disable sending mouse events to the emulated PS2 controller.
 *
 * @param {boolean} enabled
 */
V86.prototype.mouse_set_enabled = function(enabled)
{
    if(this.mouse_adapter)
    {
        this.mouse_adapter.emu_enabled = enabled;
        this.mouse_adapter.update_cursor();
    }
};
V86.prototype.mouse_set_status = V86.prototype.mouse_set_enabled;

/**
 * Enable or disable sending keyboard events to the emulated PS2 controller.
 *
 * @param {boolean} enabled
 */
V86.prototype.keyboard_set_enabled = function(enabled)
{
    if(this.keyboard_adapter)
    {
        this.keyboard_adapter.emu_enabled = enabled;
    }
};
V86.prototype.keyboard_set_status = V86.prototype.keyboard_set_enabled;

/**
 * Send a string to the first emulated serial terminal.
 *
 * @param {string} data
 */
V86.prototype.serial0_send = function(data)
{
    for(var i = 0; i < data.length; i++)
    {
        this.bus.send("serial0-input", data.charCodeAt(i));
    }
};

/**
 * Change the preferred virtio-gpu display size and notify the guest.
 *
 * @param {number} width
 * @param {number} height
 * @return {boolean}
 */
V86.prototype.virtio_gpu_set_size = function(width, height)
{
    const virtio_gpu = this.v86.cpu.devices.virtio_gpu;
    if(!virtio_gpu)
    {
        throw new Error("Cannot resize virtio-gpu: device is unavailable");
    }
    return virtio_gpu.set_display_size(width, height);
};

/**
 * Read virtio-gpu counters and current resource gauges.
 *
 * @param {boolean=} reset
 * @return {!Object}
 */
V86.prototype.virtio_gpu_get_stats = function(reset = false)
{
    const virtio_gpu = this.v86.cpu.devices.virtio_gpu;
    if(!virtio_gpu)
    {
        throw new Error("Cannot read virtio-gpu stats: device is unavailable");
    }
    return virtio_gpu.get_performance_stats(reset);
};

/**
 * Send bytes to a serial port (to be received by the emulated PC).
 *
 * @param {Uint8Array} data
 */
V86.prototype.serial_send_bytes = function(serial, data)
{
    for(var i = 0; i < data.length; i++)
    {
        this.bus.send("serial" + serial + "-input", data[i]);
    }
};

/**
 * Set or clear the data carrier detect (DCD) status of a serial port.
 *
 * @param {number} serial
 * @param {boolean} status
 */
V86.prototype.serial_set_carrier_detect = function(serial, status)
{
    this.bus.send("serial" + serial + "-carrier-detect-input", status);
};

/**
 * Set or clear the ring indicator (RING) status of a serial port.
 *
 * @param {number} serial
 * @param {boolean} status
 */
V86.prototype.serial_set_ring_indicator = function(serial, status)
{
    this.bus.send("serial" + serial + "-ring-indicator-input", status);
};

/**
 * Set or clear the data set ready (DSR) status of a serial port.
 *
 * @param {number} serial
 * @param {boolean} status
 */
V86.prototype.serial_set_data_set_ready = function(serial, status)
{
    this.bus.send("serial" + serial + "-data-set-ready-input", status);
};

/**
 * Set or clear the clear to send (CTS) status of a serial port.
 *
 * @param {number} serial
 * @param {boolean} status
 */
V86.prototype.serial_set_clear_to_send = function(serial, status)
{
    this.bus.send("serial" + serial + "-clear-to-send-input", status);
};

/**
 * Write to a file in the 9p filesystem. Nothing happens if no filesystem has
 * been initialized.
 *
 * @param {string} file
 * @param {Uint8Array} data
 */
V86.prototype.create_file = async function(file, data)
{
    dbg_assert(arguments.length === 2);
    var fs = this.fs9p;

    if(!fs)
    {
        return;
    }

    var parts = file.split("/");
    var filename = parts[parts.length - 1];

    var path_infos = fs.SearchPath(file);
    var parent_id = path_infos.parentid;
    var not_found = filename === "" || parent_id === -1;

    if(!not_found)
    {
        await fs.CreateBinaryFile(filename, parent_id, data);
    }
    else
    {
        return Promise.reject(new FileNotFoundError());
    }
};

/**
 * Read a file in the 9p filesystem. Nothing happens if no filesystem has been
 * initialized.
 *
 * @param {string} file
 */
V86.prototype.read_file = async function(file)
{
    dbg_assert(arguments.length === 1);
    var fs = this.fs9p;

    if(!fs)
    {
        return;
    }

    const result = await fs.read_file(file);

    if(result)
    {
        return result;
    }
    else
    {
        return Promise.reject(new FileNotFoundError());
    }
};

/*
 * @deprecated
 * Use wait_until_vga_screen_contains etc.
 */
V86.prototype.automatically = function(steps)
{
    const run = (steps) =>
    {
        const step = steps[0];

        if(!step)
        {
            return;
        }

        const remaining_steps = steps.slice(1);

        if(step.sleep)
        {
            setTimeout(() => run(remaining_steps), step.sleep * 1000);
            return;
        }

        if(step.vga_text)
        {
            this.wait_until_vga_screen_contains(step.vga_text).then(() => run(remaining_steps));
            return;
        }

        if(step.keyboard_send)
        {
            if(Array.isArray(step.keyboard_send))
            {
                this.keyboard_send_scancodes(step.keyboard_send);
            }
            else
            {
                dbg_assert(typeof step.keyboard_send === "string");
                this.keyboard_send_text(step.keyboard_send);
            }

            run(remaining_steps);
            return;
        }

        if(step.call)
        {
            step.call();
            run(remaining_steps);
            return;
        }

        dbg_assert(false, step);
    };

    run(steps);
};

/**
 * Wait until expected text is present on the VGA text screen.
 *
 * Returns immediately if the expected text is already present on screen
 * at the time this funtion is called.
 *
 * An optional timeout may be specified in `options.timeout_msec`, returns
 * false if the timeout expires before the expected text could be detected.
 *
 * Expected text (or texts, see below) must be of type string or RegExp,
 * strings are tested against the beginning of a screen line, regular
 * expressions against the full line but may use wildcards for partial
 * matching.
 *
 * Two methods of text detection are supported depending on the type of the
 * argument `expected`:
 *
 * 1. If `expected` is a string or RegExp then the given text string or
 *    regular expression may match any line on screen for this function
 *    to succeed.
 *
 * 2. If `expected` is an array of strings and/or RegExp objects then the
 *    list of expected lines must match exactly at "the bottom" of the
 *    screen. The "bottom" line is the first non-empty line starting from
 *    the screen's end.
 *    Expected lines should not contain any trailing whitespace and/or
 *    newline characters. Expecting an empty line is valid.
 *
 * Returns `true` on success and `false` when the timeout has expired.
 *
 * @param {string|RegExp|Array<string|RegExp>} expected
 * @param {{timeout_msec:(number|undefined)}=} options
 */
V86.prototype.wait_until_vga_screen_contains = async function(expected, options)
{
    const match_multi = Array.isArray(expected);
    const timeout_msec = options?.timeout_msec || 0;
    const changed_rows = new Set();
    const screen_put_char = args => changed_rows.add(args[0]);
    const contains_expected = (screen_line, pattern) => pattern.test ? pattern.test(screen_line) : screen_line.startsWith(pattern);
    const screen_lines = [];

    this.add_listener("screen-put-char", screen_put_char);

    for(const screen_line of this.screen_adapter.get_text_screen())
    {
        if(match_multi)
        {
            screen_lines.push(screen_line.trimRight());
        }
        else if(contains_expected(screen_line, expected))
        {
            this.remove_listener("screen-put-char", screen_put_char);
            return true;
        }
    }

    let succeeded = false;
    const end = timeout_msec ? performance.now() + timeout_msec : 0;
    loop: while(!end || performance.now() < end)
    {
        if(match_multi)
        {
            let screen_height = screen_lines.length;
            while(screen_height > 0 && screen_lines[screen_height - 1] === "")
            {
                screen_height--;
            }
            const screen_offset = screen_height - expected.length;
            if(screen_offset >= 0)
            {
                let matches = true;
                for(let i = 0; i < expected.length && matches; i++)
                {
                    matches = contains_expected(screen_lines[screen_offset + i], expected[i]);
                }
                if(matches)
                {
                    succeeded = true;
                    break;
                }
            }
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        for(const row of changed_rows)
        {
            const screen_line = this.screen_adapter.get_text_row(row);
            if(match_multi)
            {
                screen_lines[row] = screen_line.trimRight();
            }
            else if(contains_expected(screen_line, expected))
            {
                succeeded = true;
                break loop;
            }
        }
        changed_rows.clear();
    }

    this.remove_listener("screen-put-char", screen_put_char);
    return succeeded;
};

/**
 * Reads data from memory at specified offset.
 *
 * @param {number} offset
 * @param {number} length
 * @returns
 */
V86.prototype.read_memory = function(offset, length)
{
    const cpu = this.v86.cpu;
    const blob = cpu.read_blob(offset, length);
    if(cpu.guest_memory_shared)
    {
        // Guest RAM is a shared imported memory (guest_memory_backend
        // "imported" + shared): browsers reject SharedArrayBuffer-backed
        // views in TextDecoder/Blob/fetch etc. (docs/smp-phase3-design.md
        // §1 S4), so hand embedders a copy instead of the live view.
        // guest_memory_shared is the flag the starter plumbed through wm —
        // no buffer sniffing (the SharedArrayBuffer global can be hidden).
        return blob.slice();
    }
    return blob;
};

/**
 * Writes data to memory at specified offset.
 *
 * @param {Array.<number>|Uint8Array} blob
 * @param {number} offset
 */
V86.prototype.write_memory = function(blob, offset)
{
    this.v86.cpu.write_blob(blob, offset);
};

/*
 * @param {HTMLElement} element
 * @param {Function} [xterm_lib]
 */
V86.prototype.set_serial_container_xtermjs = function(element, xterm_lib = window["Terminal"])
{
    this.serial_adapter && this.serial_adapter.destroy && this.serial_adapter.destroy();
    this.serial_adapter = new SerialAdapterXtermJS(element, this.bus, xterm_lib);
    this.serial_adapter.show();
};

/*
 * @param {HTMLElement} element
 * @param {Function} [xterm_lib]
 */
V86.prototype.set_virtio_console_container_xtermjs = function(element, xterm_lib = window["Terminal"])
{
    this.virtio_console_adapter && this.virtio_console_adapter.destroy && this.virtio_console_adapter.destroy();
    this.virtio_console_adapter = new VirtioConsoleAdapterXtermJS(element, this.bus, xterm_lib);
    this.virtio_console_adapter.show();
};

V86.prototype.get_instruction_stats = function()
{
    return print_stats.stats_to_string(this.v86.cpu);
};

/**
 * @ignore
 * @constructor
 *
 * @param {string=} message
 */
function FileExistsError(message)
{
    this.message = message || "File already exists";
}
FileExistsError.prototype = Error.prototype;

/**
 * @ignore
 * @constructor
 *
 * @param {string=} message
 */
function FileNotFoundError(message)
{
    this.message = message || "File not found";
}
FileNotFoundError.prototype = Error.prototype;

/* global module, self */

if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    module.exports["V86"] = V86;
}
else if(typeof window !== "undefined")
{
    window["V86"] = V86;
}
else if(typeof importScripts === "function")
{
    // web worker
    self["V86"] = V86;
}
