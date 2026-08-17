# v86 multicore (SMP)

Embedder guide to the experimental multicore support (XWAH-9). Everything
described here is opt-in; a `V86` constructed without the new options behaves
exactly as before, down to byte-identical wasm artifacts and state images.

Two independent features are covered:

* **Time-sliced SMP** — `cpus: N` boots a guest with N schedulable CPUs,
  multiplexed on a single host thread.
* **The imported guest memory backend** — `guest_memory_backend: "imported"`
  moves guest RAM into a separate (optionally shared) `WebAssembly.Memory`,
  the memory architecture required for future worker-based vCPUs.

Design background: [docs/smp-phase2-design.md](smp-phase2-design.md)
(time-sliced SMP), [docs/smp-phase3-design.md](smp-phase3-design.md) (shared
guest RAM), [docs/smp-thread-test-plan.md](smp-thread-test-plan.md)
(cross-thread test layering). The phased plan lives in tracker issue XWAH-9.

## Time-sliced SMP: `cpus: N`

```js
const emulator = new V86({
    acpi: true,   // required for cpus > 1
    cpus: 2,
    // ... memory, disks, etc.
});
```

`cpus` accepts an integer from 1 to 255 (default 1). **Values above 1 require
`acpi: true`**: the local APIC's MMIO window is gated on ACPI, and without a
LAPIC the guest could never start or interrupt the secondary CPUs. Without
`acpi: true`, `cpus` is clamped to 1 (with a `dbg_assert` in debug builds and
a log message).

### What the guest sees

The wasm module is the single authority for the firmware-visible CPU count:
`fw_cfg` `NB_CPUS`/`MAX_CPUS` and CMOS register 0x5F all report it, and
SeaBIOS builds the MADT and MP tables from those counts — v86 generates no
ACPI tables itself. On top of that:

* CPUID leaf 1 reports the logical CPU count and the current CPU's initial
  APIC ID in EBX, and sets the HTT flag when `cpus > 1`; leaves 4 and 0xB
  describe the topology (one thread per core, N cores).
* Each vCPU has its own local APIC with real ICR destination matching
  (physical/logical/broadcast, the shorthands, lowest-priority arbitration).
* AP bring-up works the way real firmware does it: SeaBIOS broadcasts
  INIT+SIPI, the target AP starts at the SIPI vector's real-mode startup
  page, and Linux later re-INITs the APs itself. `IA32_APIC_BASE` reports
  the BSP bit on vCPU 0 only.

A Linux guest with an SMP kernel (`CONFIG_SMP=y`) boots all N CPUs;
`nproc` reports N (this is the acceptance test, `tests/api/smp.js`).

### What it does and does not buy

Time-sliced SMP is a **correctness** milestone, not a performance one. All
vCPUs share one host thread; the scheduler round-robins between them at the
existing ~100k-instruction slice granularity, flushing the TLB on each
switch (an estimated 2–10 % overhead at 2 vCPUs — see
[smp-phase2-design.md](smp-phase2-design.md) §TLB on switch). A
multi-threaded guest workload is scheduled correctly but runs no faster
than on one CPU; a single-threaded workload runs marginally slower.

Host parallelism has landed behind `smp_workers` (issue XWAH-9):

| Phase | Content | Status |
| --- | --- | --- |
| 0–2 | Groundwork, SMP platform correctness, time-sliced SMP | Landed (this is `cpus: N`) |
| 3 | Sharable guest RAM (`v86-multimem.wasm` + gram accessor modules) | Landed (this is `guest_memory_backend: "imported"`) |
| 4 | Worker-per-vCPU execution, LOCK-prefix atomics, IPI doorbells | Landed (`smp_workers`: one worker per vCPU for `cpus > 1`, real host parallelism — see the benchmark report — plus the machine-in-a-worker topology; W1–W5 notes in [smp-phase4-design.md](smp-phase4-design.md) §9) |
| 5 | Integration: docs, API audit, CI | In progress |

## The imported guest memory backend

```js
const emulator = new V86({
    guest_memory_backend: "imported",   // default: "linear"
    guest_memory_shared: "auto",        // default; or true / false
    // ... other options; independent of cpus
});
```

With `guest_memory_backend: "imported"`, guest RAM is a separate
`WebAssembly.Memory` created before instantiation and imported by the wasm
side, instead of living inside the module's own linear memory. When the
memory is additionally **shared** (SharedArrayBuffer-backed), it can later
be imported by wasm instances running in workers — this is the Phase 4
prerequisite. Use it when you want to validate that memory architecture, or
run the cross-thread tests (`tests/threads/`, `make threads-test`); for
production embedding today, the default `"linear"` backend remains the
right choice.

Both features compose: `cpus: 2` plus the imported shared backend is the
configuration closest to the Phase 4 target and is exercised by
`make multimem-tests`.

### Artifacts

The backend loads different build artifacts:

* `v86-multimem.wasm` / `v86-multimem-debug.wasm` — the main module, built
  with the `guest-ram-import` cargo feature (`make build/v86-multimem.wasm`,
  `make build/v86-multimem-debug.wasm`).
* `gram.wasm` / `gram-shared.wasm` — a tiny generated accessor module whose
  memory 0 *is* the guest memory; the interpreter reaches guest RAM through
  its exports (`make gram-wasm` builds both variants).

There is **no fallback artifact** for this backend (`v86-fallback.wasm` is a
single-memory build without the gram import ABI). All artifacts are resolved
from the same directory: an explicit `wasm_path` still names the main
artifact (which must then be a multimem-compatible build — cpu.js
hard-errors on a default artifact), and the gram artifacts are expected next
to it. In Node the default directory is the library's own; in browsers it is
`build/`.

### Engine requirements

JIT-generated code addresses guest RAM as a **second memory**, so the engine
must support the WebAssembly multi-memory proposal. The constructor runs a
validation probe (a minimal two-memory module) before committing to the
backend and **throws synchronously** on engines without multi-memory
support:

> guest_memory_backend "imported" requires WebAssembly multi-memory support
> (JIT-generated modules import guest RAM as a second memory), which this
> engine lacks

Multi-memory support is verified on V8 in Node 24 and directly in
Chrome 151 under cross-origin isolation (automated probe run, recorded in
[smp-phase3-design.md](smp-phase3-design.md) §1 S1). The Firefox and
especially **Safari** cells of the capability matrix are still pending —
on an engine without multi-memory, the probe fails cleanly as above. Failures
*after* construction — a missing or invalid gram artifact, instantiation
errors — are reported asynchronously: logged via `console.error`, emitted as
an `"emulator-error"` bus event carrying the `Error`, and rethrown as an
uncaught async exception so the failure is never silent
(`tests/api/multimem-negative.js` covers both paths).

### Shared mode and cross-origin isolation

`guest_memory_shared` controls whether the imported memory is created
`shared: true` (SharedArrayBuffer-backed):

* `"auto"` (default) — in browsers, follows `crossOriginIsolated`: shared
  exactly when the embedding page is cross-origin isolated. In Node there is
  no `crossOriginIsolated` gate, so `"auto"` follows `SharedArrayBuffer`
  availability — effectively shared.
* `true` / `false` — explicit override, meant for testing both artifact
  variants without COOP/COEP headers.

Browsers only expose `SharedArrayBuffer` on cross-origin isolated pages, so
shared mode requires the embedding page to be served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Note that COOP/COEP constrains the whole page (third-party iframes and CDN
scripts must be CORP/CORS-clean). For development, `make run-isolated`
serves the repository with those headers (`tools/coi-server.py`);
plain `make run` does not send them.

The gram artifact variant must match the memory's shared-ness exactly
(a mismatch is a `LinkError`), which is why both `gram.wasm` and
`gram-shared.wasm` are built.

### Performance

Measured on the Phase 3 acceptance runs
([smp-phase3-design.md](smp-phase3-design.md) §4 Stage 6; Apple M4,
Node 24, release artifacts, boot-to-shell):

| Configuration | Relative to the linear backend |
| --- | --- |
| Imported, non-shared | parity (within noise) |
| Imported, shared | ~1.12× slower |
| Imported, shared, JIT disabled | ~1.66× slower |

The 1.66× interpreter-only number exists because every interpreter guest-RAM
access becomes a cross-instance call into gram.wasm; JIT-compiled code
addresses the second memory directly and is unaffected. In steady state only
~1.1 % of executed instructions are interpreted (measured in
`docs/jit-profile-2026-08.md`, branch `feature/XWAH-11/jit-profiling-baseline`),
so the JIT-on numbers are what real workloads see.

## State images: version 6 vs 7

The save/restore format ([src/state.js](../src/state.js)) is versioned:

* **`cpus: 1` machines write version 6**, byte-identical to images from
  builds without SMP support — no compatibility break for existing
  embedders or existing state images.
* **`cpus > 1` machines write version 7**, which appends one trailing state
  slot carrying the per-vCPU contexts (register blocks, run states, pending
  INIT/SIPI latches, and the current-vCPU index).

Restore accepts versions 6 and 7. The version bump is deliberate
forward-protection: **older builds reject a cpus>1 image cleanly** at the
version check instead of silently ignoring the vCPU contexts and failing
mid-restore.

Restore is fail-fast: all validation happens before any machine state is
mutated, so a rejected image leaves the machine untouched
(`StateLoadError`):

* **Cross-cpus restore fails in both directions** — an image saved with
  `cpus=M` does not restore into a machine constructed with `cpus=N` (the
  vCPU slot's header records the image's CPU count and is checked against
  the machine's; a cpus>1 machine likewise rejects an image with no vCPU
  contexts).
* A version-7 image restored on a wasm module that predates vCPU
  save/restore is rejected.
* **Under the imported backend, an image with more RAM than the machine is
  rejected**: the imported guest memory is created with
  `maximum == initial` and can never grow. (The linear backend keeps its
  long-standing lenient behavior — a `console.warn` on mismatch.)

As always, restore also requires the machine to be constructed with the same
options as the saving instance (disks, memory size, and now `cpus` and the
memory backend).

## API contracts under the new options

Behavior an embedder can rely on:

* **`read_memory` returns a copy when guest RAM is SAB-backed** (imported
  backend, shared mode). Browsers reject SharedArrayBuffer-backed views in
  APIs like `TextDecoder`, `Blob` and `fetch`, so instead of the usual live
  view you get a snapshot (`starter.js` `read_memory`). Code that treated
  the return value as a live window into guest RAM must re-read instead of
  holding the array.
* **`"emulator-error"` event**: emitted (with the `Error` as argument) when
  emulator initialization fails asynchronously — today's producer is the
  imported backend's artifact loading. Listen for it whenever you set
  `guest_memory_backend: "imported"`. Engine-capability failures throw
  synchronously from the constructor instead (see above).
* **`save_state()` works at `cpus > 1`** and produces a version-7 image with
  the constraints of the previous section. The call was always
  `Promise`-returning; nothing changes in its signature.
* **`get_instruction_counter()` counts all vCPUs combined**: the counter is
  a single machine-wide monotonic counter, not per-CPU
  (`smp-phase2-design.md` §Per-vCPU state inventory).

## API stability for the worker phase

Audit of the public surface (`v86.d.ts` + `V86.prototype` methods) against
(a) time-sliced SMP today and (b) the planned Phase 4 worker-per-vCPU
execution. "Safe today" rests on one Phase 2 invariant: vCPU switches happen
only inside `main_loop`, so every synchronous JS callback and every
post-tick read observes one consistent vCPU
(`smp-phase2-design.md` §JS-side impacts). Phase 4 breaks the
"CPU state is synchronously reachable from the main thread" assumption;
APIs are flagged accordingly.

| API | cpus > 1 today (verified) | Phase 4 outlook |
| --- | --- | --- |
| `run` / `stop` / `destroy` | Work; already `Promise`-returning | **Current** (Stage W4): signatures unchanged; under `smp_workers`, run/stop drive the command-word protocol (RUN / PARK_REQ, acked at slice boundaries) and destroy quiesces then TERMINATEs every worker |
| `read_memory` / `write_memory` | Work; `read_memory` returns a copy under SAB backing | Can stay synchronous — guest RAM is a SAB the main thread keeps a view of — but reads/writes race running vCPUs: snapshot/torn semantics unless the embedder stops the emulator first. **Semantics-change candidate** (not signature) |
| `get_instruction_counter` | Works; counts all vCPUs combined | Per-worker counters need aggregation; a synchronous exact read is impossible. **Sync-becomes-approximate/async candidate** |
| `get_instruction_stats` | Works (single-thread counters) | Same aggregation caveat as the counter. **Async candidate** |
| `save_state` / `restore_state` | Work; v7 images, fail-fast validation (see above) | **Current** (Stage W4): signatures unchanged, still async, **same v7 bytes** — images cross freely between time-sliced and worker execution in both directions. Under `smp_workers`, save quiesces the workers ([smp-phase4-design.md](smp-phase4-design.md) §7: PARK_REQ → PARKED_ACK at a slice boundary, mailbox idle), drains every in-flight control-region interrupt into the architectural structures (an undelivered vector must not be dropped from the image — it would dead-lock its level line after restore), pulls each worker's vCPU block + LAPIC struct (topology (c): the whole chipset) into the main instance via postMessage, and runs today's `get_state` unchanged, synchronously after a final drain; restore validates and restores the main instance exactly as today (fail-fast intact — a rejected image leaves the quiesced machine unharmed and resumed), then distributes the regions back to the workers, which reload their live blocks and re-enter their roles. `initial_state` follows the same path at boot. No v8 format was needed |
| `restart` | Works (`reset_cpu` resets every vCPU, APs back to wait-for-SIPI) | **Current** (Stage W4): signature (void, fire-and-forget) unchanged; under `smp_workers` it is the quiesced reboot — park + ack all workers (a guest-triggered reset completes its own port RPC first), reset the main-side chipset/devices, then per-worker reset commands (each worker resets its instance, APs return to WaitForSipi, and acks by parking; the machine is released together once every worker has reset). Gated by `tests/threads/worker-reboot.js`; note that rebooting after a large Linux guest is broken in every mode (upstream copy/v86#636) |
| Keyboard/mouse input (`keyboard_send_scancodes`, `keyboard_send_keys`, `keyboard_send_text`, `mouse_set_enabled`, adapters) | Work. Input events synchronously reach the PS/2 device and can synchronously interrupt the *current* vCPU; the 8259 leg is gated to the BSP (`cpu.rs` `handle_irqs`) | Device models stay on one thread; `device_raise_irq` becomes a doorbell post instead of a synchronous call into CPU state (this also removes today's reentrancy hazard). Embedder-facing signatures unchanged; delivery becomes asynchronous — indistinguishable from the guest's perspective |
| Serial (`serial0_send`, `serial_send_bytes`, `serial_set_*`, adapters) | Work; same synchronous-IRQ path as input, same BSP gating | Same doorbell outlook as input; signatures unchanged |
| Screen adapters (`screen_*` methods, `ScreenAdapter`/`DummyScreenAdapter`) | Work; screen state is device-side, fed by bus events; the VGA framebuffer lives in the main module's memory | Devices (including VGA) stay on the device thread; unaffected. Legacy VGA MMIO from a non-BSP vCPU becomes a cross-thread RPC (perf, not correctness) |
| `add_listener` / `remove_listener` events | Work; events dispatch synchronously on the main thread | Signature unchanged. Events caused by vCPU-worker activity arrive via message passing: still ordered, no longer synchronous with guest execution. **Timing-sensitive listeners are the flag here**, not the API |
| `wait_until_vga_screen_contains` | Works (polling, `Promise`) | Unaffected |
| 9p filesystem (`create_file`, `read_file`) | Work; already async | Unaffected (virtio rings live in guest RAM, which stays main-thread-visible under the imported backend) |
| Media (`set_fda`/`set_cdrom`/eject) | Work; already async | Unaffected (device-side) |

Summary: no public API needs a signature break for Phase 4. The flagged
items are semantic: memory access becomes racy-by-default, instruction
counting becomes approximate, and event timing decouples from guest
execution.

## Known limitations

| Limitation | Detail | Reference |
| --- | --- | --- |
| Shared TSC | One machine-wide TSC (globally monotonic — what Linux's TSC-sync check wants). A guest `WRMSR` to the TSC moves it for *all* vCPUs; accepted deviation | [smp-phase2-design.md](smp-phase2-design.md) §Per-vCPU state inventory; `cpu.rs` `set_tsc` |
| No NMI | NMI delivery (LAPIC ICR or IOAPIC-routed) is dropped at the delivery point; the interrupt core has no NMI support | `apic.rs` (`NMI … dropped (NMI unsupported)`) |
| INIT to the BSP ignored | INIT to vCPU 0 means warm reset, which is intentionally not implemented (logged no-op); INIT to APs works | `apic.rs`; [smp-phase2-design.md](smp-phase2-design.md) §AP startup |
| Lowest-priority arbitration uses TPR, not PPR | Arbitration picks the lowest task-priority register among Runnable candidates (ties → lowest APIC index) instead of the SDM's processor priority | `apic.rs` `arbitrate_lowest_priority` |
| JIT `cs_offset` approximation | Compile-time `cs_offset` embedding for 16-bit wrap-around is keyed only by physical page + state flags (pre-existing; real-mode code essentially never reaches the JIT threshold) | [smp-phase2-design.md](smp-phase2-design.md) §Context-switch mechanism; `jit.rs` |
| vCPU switch overhead | Estimated 2–10 % at 2 vCPUs from the unconditional TLB flush per slice | [smp-phase2-design.md](smp-phase2-design.md) §TLB on switch |
| Interpreter cost on the imported backend | ~1.66× with the JIT disabled (every interpreter guest-RAM access is a cross-instance call). Steady state is ~1.1 % interpreted, so JIT-on workloads see ~1× (non-shared) to ~1.12× (shared) | [smp-phase3-design.md](smp-phase3-design.md) §4 Stage 6; `docs/jit-profile-2026-08.md` (branch `feature/XWAH-11/jit-profiling-baseline`) |
| Safari multi-memory pending | The multi-memory validation matrix passes on V8 (Node 24) and Chrome 151; Firefox is untested and Safari is the open go/no-go for the imported backend beyond Chromium/Gecko — and therefore transitively for worker execution, which ships Chrome-first behind the `"auto"` ladder. The Stage 0 probe page gained the W5 `memory.atomic.wait32`/`notify` cells; Firefox/Safari columns remain pending | [smp-phase3-design.md](smp-phase3-design.md) §1 S1, §5; [smp-phase4-design.md](smp-phase4-design.md) §8 |
| Relaxed memory ordering on ARM hosts (worker mode) | Under per-vCPU workers, racing PLAIN guest accesses can observe x86-forbidden orderings on weakly ordered hosts at ppm rates (measured: 7–27 per 1e6 racing trials, Apple M4); locked/fenced guest code is unaffected (all LOCK ops are seq-cst). Opt-out: `smp_memory_model: "fenced"` (JIT fast paths fenced, TSO restored — measured 0/1e6; interpreter/slow paths stay unfenced) | [smp-phase4-design.md](smp-phase4-design.md) §5 W5 verdict; `tests/threads/tso-litmus.js` |
| Exclusive-execution bus-lock cost (worker mode) | Misaligned/page-crossing LOCKed accesses park every other worker for the RMW; acquisition can wait out a busy peer's current execution slice, so split-lock throughput under load is slice-latency-bounded (~ms). Pathological guests only; aligned locked ops take the CAS fast path | [smp-phase4-design.md](smp-phase4-design.md) §5, §9 W4 note |
| Index/data pairs are per-worker (worker mode) | The IOAPIC `IOREGSEL`/`IOWIN` and CMOS `0x70`/`0x71` pairs are serialized by remembering each worker's selector and re-applying it inside the same host dispatch (XWAH-37), so each worker effectively gets its own index register where hardware has one shared one. Indistinguishable to any guest that holds its own lock across the pair (Linux: `ioapic_lock`, `rtc_lock`); a guest that deliberately selects on one CPU and reads the data window from another sees the difference — already a data race on real hardware | `smp_host_core.js` `sync_index_pair`; `tests/threads/index-data-pairs.js` |
| Index/data pairs still splittable (worker mode) | Three pairs are *not* serialized because re-applying their index is not side-effect free: PCI `CF8`/`CFC` (pci.js routes the `0xCF9` reset register through byte 1 of the address window, so a replay can reach `reboot_internal`), the VGA attribute controller `0x3C0` (one port alternating index and data through a flip-flop), and the VGA DAC `0x3C8`/`0x3C9` (the data port auto-advances a sub-index across the three palette bytes). Each needs the index carried with the data access rather than replayed | `smp_host_core.js` audit comment; XWAH-40 |
| Index/data pairs splittable in time-sliced mode | The same hazard predates worker execution: `main_loop_smp` rotates vCPUs between guest instructions, so a slice boundary can fall between a pair's index and data access with the devices shared. Not fixed here — the fix belongs in the device models and would change the default artifact's bytes and the time-sliced paths, which this phase holds identical | [smp-phase4-design.md](smp-phase4-design.md) (intro); `cpu.rs` `main_loop_smp`; XWAH-41 |
| SIPI entry in the default artifact | The default (non-multimem) artifact's time-sliced SIPI consume enters at linear 0 instead of the architectural vector<<12 (masked on first boot by the low-memory sled; multimem builds enter architecturally since W5). One-line fix deferred to the first phase allowed to change the default artifact's bytes | [smp-phase4-design.md](smp-phase4-design.md) §9 W5 note; `vcpu.rs` `sipi_entry_linear_ip!` |

## Worker execution (experimental)

`smp_workers: true | "auto"` (XWAH-9 Phase 4,
[smp-phase4-design.md](smp-phase4-design.md) §9) moves guest execution off
the main thread. For `cpus > 1` the default topology is **one worker per
vCPU** (`smp_worker_topology: "percpu"`, topology (b)) — real host
parallelism: each vCPU is its own `src/browser/vcpu_worker.js` instance
over the ONE shared imported guest memory, interrupts travel a shared
control region (pending-vector bitmaps, INIT/SIPI latches, doorbells), and
LOCK-prefixed guest instructions execute as real wasm atomics (CAS loops;
misaligned/page-crossing locked accesses run under exclusive execution).
On the benchmark fixture a CPU-bound 2-process workload runs 1.74× faster
than time-sliced `cpus: 2` (a mixed 2-process pipeline load 1.93×; see
[smp-benchmark-report.md](smp-benchmark-report.md)). For `cpus == 1` (or
`smp_worker_topology: "machine"`), the whole machine runs time-sliced
inside ONE worker (topology (c)) — main-thread responsiveness without
parallelism. Either way the main thread is the device host: devices,
io.js, and the UI stay on main; blocking port-I/O/MMIO RPCs are serviced
over a SharedArrayBuffer mailbox; PIT/RTC/ACPI tick on main while workers
keep their own LAPIC timer deadlines.

Requirements (probed; `true` throws, `"auto"` degrades with a debug log):
WebAssembly multi-memory, `SharedArrayBuffer` (cross-origin isolation in
browsers), `Worker`, the built-in wasm loader (no `wasm_fn`), and the
worker entry point reachable at `smp_worker_url` (it is deliberately not
part of the bundled library). The resolved mode is observable via the
`"smp-mode"` event / `emulator.smp_mode` property (fields: `execution`,
`topology`, `memory_model`, `cpus_effective`, `guest_memory`).

Memory ordering (`smp_memory_model`, Stage W5): plain guest accesses stay
plain wasm accesses by default (`"relaxed"`). On x86 hosts the host's TSO
carries over; on weakly ordered hosts (ARM), the TSO litmus detector
(`tests/threads/tso-litmus.js`) observes the x86-forbidden message-passing
outcome at ppm rates (7–27 per million racing trials on an Apple M4) —
real but confined to guest code that races PLAIN accesses with no locked
edge between them, a pattern correct kernels avoid (all locked ops are
seq-cst here). `smp_memory_model: "fenced"` closes it: every JIT
guest-RAM fast-path access carries a seq-cst fence (measured: restores
TSO exactly — 0/1e6 forbidden outcomes with the TSO-allowed
store-buffering relaxation still visible) at a substantial per-access
cost; interpreter and slow-path accesses stay unfenced (documented
residual — see the §5 verdict in the phase design).

Failure modes (§8, gated by `tests/threads/worker-failure.js`): a worker
dying mid-run is fail-stop — remaining workers park, `"emulator-error"`
fires with a descriptive `Error`, and the machine stops; spawn failures
under `"auto"` degrade down the ladder pre-boot (clean, no error event),
under `true` they surface loudly; capability conflicts under `true` throw
synchronously from the constructor.

Since Stage W4, `save_state`/`restore_state`/`initial_state`/`restart` work
in worker mode (quiesce + state assembly, see the API table above); images
are the same v7 bytes as time-sliced ones and cross between the modes in
both directions (`tests/threads/worker-save-restore.js`). Current
limitations in worker mode: `multiboot` is unsupported,
`get_instruction_counter` under topology (c) reads a stale main-thread
counter (topology (b) sums the published per-worker cells), and the three
semantic shifts flagged in the API table above (racy `read_memory`,
approximate counters, decoupled event timing) are now real. Chrome/V8 (incl. Node worker_threads) is the verified
engine; the Firefox/Safari cells follow the Phase 3 probe matrix. Tested by
`tests/threads/machine-in-worker.js` (boots Linux with `cpus: 1` and the
Alpine SMP fixture with `cpus: 2` fully inside the worker, plus
mailbox-under-load and hlt/wake-race stress) and
`tests/threads/machine-in-worker-boottime.js` (the ≤ 1.25× boot-time gate
vs time-sliced execution over the same memory backend).

### Running the Codex appliance under worker vCPUs

The flagship fixture is `examples/virtio_gpu_codex.html` (Alpine + Openbox
+ Ghostty + Codex over 9p). On this branch it accepts the SMP query
parameters below; the copy on `main` does not — see the divergence note at
the end of this section.

Build the release artifacts once. Worker mode loads the **multimem**
module, not `build/v86.wasm`:

```sh
make build/libv86.mjs          # Closure bundle — needs Java on PATH
make build/v86-multimem.wasm   # release multimem module
make build/gram.wasm build/gram-shared.wasm
```

Serve with cross-origin isolation. This is the step the appliance guide's
`python3 -m http.server 8082` recipe does not cover: without COOP/COEP the
browser withholds `SharedArrayBuffer`. The page passes `smp_workers: true`
(not `"auto"`), so it fails loudly rather than degrading — the constructor
throws `smp_workers: shared WebAssembly.Memory is unavailable
(crossOriginIsolated/SharedArrayBuffer)` (`starter.js`). An embedder
passing `"auto"` gets the opposite: a silent step down to time-sliced
execution, logged and reported through `smp_mode` but easy to mistake for a
merely slow boot.

```sh
python3 tools/coi-server.py 8082
```

`make run-isolated` runs the same server but defaults to port 8000; the
appliance guide and the browser acceptance tests standardise on 8082.

```text
http://127.0.0.1:8082/examples/virtio_gpu_codex.html?cpus=4&workers=1
```

| Query | Mode |
| --- | --- |
| `?cpus=4&workers=1` | 4 worker vCPUs — real host parallelism, the fastest configuration |
| `?cpus=2&workers=1` | 2 worker vCPUs — less host contention on smaller machines |
| `?cpus=4` | 4 vCPUs time-sliced on one thread |
| `?cpus=1` | single core, the appliance's historical acpi-less setup |
| `&mm=fenced` | seq-cst fences on the JIT fast paths (TSO restored); slower, for ordering A/B |

**Confirm the mode actually took.** The `"auto"` ladder degrades silently
by design, so a disappointing boot may simply not be running workers:

```js
emulator.smp_mode  // { execution: "workers", topology: "percpu", memory_model: "relaxed", … }
```

The `smp-mode` event carries the same record at startup.

Measured on an Apple M4 (4P+6E), release artifacts: appliance readiness
115–136 s under 4 workers versus 175 s time-sliced. Boot is not
embarrassingly parallel, so this is not a 4× workload — see
[smp-benchmark-report.md](smp-benchmark-report.md) for the gated workloads
and for why 4 workers plus the device host thread can land on E-cores and
produce outlier rounds.

Notes:

* `acpi` switches on automatically for `cpus > 1` (the LAPIC MMIO window is
  gated on it); the one-CPU appliance keeps its historical acpi-less setup.
* `renderer=wgpu` additionally needs `make virtio-gpu-wgpu`; the default
  `webgpu-js` renderer needs no extra build.
* The guest fixture must exist under `images/` — worktrees symlink it to
  the primary checkout rather than duplicating ~700 MB.

**Divergence to resolve at merge time.** `main` and `multi-core` have both
edited `examples/virtio_gpu_codex.html` and neither side has the other's
query parameters: `main` added `shader`/`resources`/`mesa`/`accelerated`/
`benchmark` (the XWAH-5/XWAH-6 GPU acceleration work), `multi-core` added
`cpus`/`workers`/`mm`. Merging the branches must **union** the parameter
sets rather than take either side wholesale, or one feature set disappears
silently. `AGENTS.md` and `docs/gpu/ghostty-codex-appliance.md` have
diverged the same way.

## Testing

* `tests/api/smp.js` — boots an SMP guest with `cpus: 2`, asserts `nproc`
  reports 2 (skips when the Alpine fixture image is missing).
* `tests/api/smp-state.js` — v7 state roundtrip and mismatch rejection.
* `tests/api/multimem-negative.js` — imported-backend failure surfacing
  (`emulator-error`).
* `make multimem-tests` — the imported backend (shared and non-shared),
  including SMP over shared memory.
* `make threads-test` — the cross-thread primitives and the worker-vCPU
  Layer C suite ([smp-thread-test-plan.md](smp-thread-test-plan.md)):
  LOCK exactness, SMP boot, save/restore, reboot, the TSO litmus
  (`tso-litmus.js`), the guest-driven INVLPG/IPI shootdown storm
  (`invlpg-storm.js`), and the failure-mode contracts
  (`worker-failure.js`).
* `tests/benchmark/smp-workers.js` — the Phase 4 acceptance benchmark
  (results: [smp-benchmark-report.md](smp-benchmark-report.md)).
* `tests/kvm-unit-tests/` — bare-metal APIC/SMP tests; the runner takes a
  `CPUS=n` variable.
