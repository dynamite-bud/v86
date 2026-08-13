# XWAH-9 Phase 3 design: threaded-capable wasm build — shared guest RAM

Goal: a build variant in which guest RAM lives in a `WebAssembly.Memory` that
can be imported by multiple wasm instances (one per future worker vCPU), while
each instance keeps its own private linear memory for CPU state, TLB, JIT
machinery and Rust statics. Phase 2's architecture decision
(docs/smp-phase2-design.md, §Context-switch mechanism) is load-bearing here:
the fixed state block 64..1280, the absolute-offset JS mirror, and JIT code
embedding absolute state offsets are all valid **per instance** — only `mem8`
is machine-shared. Phase 3 therefore does NOT mean "compile Rust with
`+atomics` and share everything"; it means "move guest RAM out of the
instance's linear memory, behind an abstraction that can be backed either by
today's in-linear-memory allocation or by an imported (optionally shared)
memory." Every stage keeps the default artifacts byte-identical; the new
backing is a separate artifact behind an option.

## 0. Where guest RAM is wired in today (evidence)

- **Allocation**: `allocate_memory` heap-allocates inside the module's own
  linear memory and stores the base in `static mut mem8`
  (src/rust/cpu/memory.rs:29–43). cpu.js calls the export and builds
  `this.mem8`/`this.mem32s` views over `wasm_memory` at the returned offset.
- **TLB baking**: `tlb_entry = (high + memory::mem8 as u32) ^ page << 12 |
  info_bits` — the mem8 addend is deliberately baked in "to save an
  instruction from the fast path" (src/rust/cpu/cpu.rs:2241–2246), with nine
  compensation sites subtracting it back (cpu.rs:1977, 2021, 2031, 2422,
  2445, 2473; jit.rs:197, 1113, 2287).
- **JIT codegen**: `gen_safe_read`/`gen_safe_write` (codegen.rs:642–779,
  858+) emit plain loads/stores on the module's single memory;
  `gen_page_switch_check` compares against the constant
  `next_block_addr + mem8` (codegen.rs:105).
- **Raw derefs outside memory.rs**: 13 `memory::mem8` sites in cpu.rs
  (interpreter fetch `read_imm8` at 2493, `jit_run_interpreted` opcode fetch
  at 3214, slow-path address manufacture at 3806/3837/3949, TLB math above),
  3 in jit.rs, 1 in codegen.rs. Everything else funnels through the ~25
  helpers in memory.rs. vga.rs touches only `vga_mem8` (device memory, stays
  per-instance).
- **JIT modules** import one memory `"e"."m"`, flag byte 0
  (wasm_builder.rs:480–496), satisfied by the main module's **exported**
  memory (`jit_imports["m"]`, cpu.js:335). The main module's memory is
  defined+exported, not imported (starter.js:180).
- **JS consumers** of guest RAM go through `cpu.read_blob`/`write_blob`
  (cpu.js:299–321) and direct `cpu.mem8` subarrays (dma.js:350, ide.js:2350,
  virtio.js:1476/1519, virtio_gpu.js, browser/main.js) — typed-array views
  that retarget trivially.
- **Build**: stable Rust, `+bulk-memory,+multivalue,+simd128`, lld via
  `tools/rust-lld-wrapper`, `--import-table --global-base=4096`, softfloat.o
  + zstddeclib.o linked in (Makefile:78–87); artifacts v86.wasm /
  v86-debug.wasm / v86-fallback.wasm; CI pins stable. Phase 0's COI dev
  server already exists (`make run-isolated`).

## 1. Runtime spikes that must run FIRST

Browser-capability claims must be verified before committing. Each spike is a
throwaway HTML page + Node script (scratch, servable via `make run-isolated`).

**Stage 0 executed 2026-08-13.** Spike scripts (throwaway, NOT in-repo):
`/Volumes/Xorcist-SSD/tmp/xwah9-spikes/` — `s1-multimem.mjs`,
`s2-callcost.mjs`, `s3-shared-ergonomics.mjs` + `s3-worker.mjs`,
`s4-sab-api-holes.mjs`, and the browser probe `probe.html` +
`serve-probe.py` (COI headers verified served; renders a DOM PASS/FAIL
matrix plus a machine-readable `#summary-json` block for an automated pass;
run once COI-served and once via `python3 -m http.server` for the non-COI
column). Node results below are Node v24.18.0 / V8 13.6.233.17 on Apple M4
(arm64); Node shares V8 with Chrome, so these predict Chrome.
Chrome/Firefox/Safari cells stay **pending browser run** of probe.html.

- **S1 — multi-memory validation matrix.** Hand-assembled module importing
  TWO memories; memidx-1 loads/stores (memarg flags|0x40, then memidx LEB,
  then offset LEB — the alternative order flags/offset/memidx does NOT
  validate); `memory.copy` mem0→mem1 (0xFC 0x0A, dst=1 src=0);
  `i32.atomic.rmw.add` on memidx 1; `atomic.fence`. Measured
  (`WebAssembly.validate` + instantiation + executed, asserted results):

  | case | Node 24 / V8 13.6 | Chrome | Firefox | Safari |
  | --- | --- | --- | --- | --- |
  | validate: 2 imported memories + memidx-1 load/store/copy/atomics, both non-shared | PASS | pending | pending | pending |
  | validate: memory 1 imported shared (limits flag 0x03, min==max) | PASS | pending | pending | pending |
  | validate: atomics targeting non-shared memidx 0 | PASS | pending | pending | pending |
  | exec: store/load on memidx 1 + address-space isolation from memidx 0 | PASS | pending | pending | pending |
  | exec: `memory.copy` mem0→mem1 | PASS | pending | pending | pending |
  | exec: `i32.atomic.rmw.add` on NON-shared memidx 1 (threads-spec relaxation) | PASS | pending | pending | pending |
  | exec: `atomic.fence` | PASS | pending | pending | pending |
  | exec: shared memidx 1 — store/load + rmw.add + copy; JS SAB view sees wasm writes | PASS | pending | pending | pending |
  | link negatives: shared↔non-shared import mismatch rejected both ways (LinkError) | PASS | pending | pending | pending |

  **S1: PASS in V8/Node 24 — multi-memory + shared memidx-1 + atomics all
  validate and execute**, including atomics on non-shared memory, so
  non-COI mode reuses identical generated code. Browser matrix pending.
- **S2 — cross-instance call cost.** Module A imports its memory 0
  (`"e"."g"` — the gram.wasm shape) and exports `read32(addr)` = i32.load;
  module B (own private memory) runs an N=100M wasm-side loop summing
  `read32((i<<2)&0xFFFC)` vs an identical loop with an in-module i32.load.
  5 runs, checksum-asserted, ns/op:

  | path | guest mem non-shared | guest mem shared |
  | --- | --- | --- |
  | cross-instance call `read32` | min 1.494 / median 1.497 | min 1.510 / median 1.519 |
  | in-module i32.load control | min 0.307 / median 0.308 | min 0.307 / median 0.309 |
  | Δ call overhead per access | **1.19 ns** | **1.21 ns** |

  Gate math: the no-JIT interpreter runs ~68 MIPS ≈ 14.8 ns/guest
  instruction (docs/jit-profile-2026-08.md, branch
  feature/XWAH-11/jit-profiling-baseline, commit 485f65e1). Access model:
  one `read_imm8` per instruction byte (≈3 bytes/instr) + ~1 data access
  per ~3 instructions ≈ 3.3 guest-RAM accesses/instr. Projected slowdown =
  (14.8 + 3.3×1.21)/14.8 ≈ **1.27×** (1.33× even at 4 accesses/instr;
  breaking the 2× gate would need ≈12 accesses/instr). Shared vs non-shared
  memory makes no measurable difference to the call cost.
  **S2: PASS — the ~2× gate holds with ~3× margin in V8**; the §5
  code-page fetch cache stays OUT of scope. (ns are host-relative — Apple
  M4 — but the gate is a ratio.)
- **S3 — shared-memory ergonomics.** Node-verifiable cells measured, all
  PASS: `new WebAssembly.Memory({initial,maximum,shared:true})` yields a
  SharedArrayBuffer-backed buffer; shared without `maximum` throws
  TypeError; with max==initial `grow(0)` returns current size and `grow(1)`
  throws RangeError (matches "RAM never grows" §5); growing a max>initial
  shared memory does NOT detach the old SAB (old view keeps old length);
  `Atomics.waitAsync` exists and resolves `"ok"` after notify; a shared
  `WebAssembly.Memory` posts to a `worker_threads` worker intact
  (SAB-backed there), where blocking `Atomics.wait` wakes on main-thread
  notify and reads the mailbox value — the Phase 4 mailbox pattern
  (worker blocking wait + main-thread waitAsync) executes end-to-end in
  V8. Node-only divergence: `Atomics.wait` on the MAIN thread is allowed
  in Node ("not-equal" immediate return) but throws on browser main
  threads — probe.html asserts the throw. Browser-pending:
  `crossOriginIsolated` gating (SAB/shared-Memory availability with and
  without COOP/COEP) — both columns covered by probe.html.
- **S4 — SAB-backed view API holes.** Key Node finding: **Node 24 enforces
  none of the WebIDL `[AllowShared]` restrictions** — `TextDecoder.decode`,
  `TextEncoder#encodeInto`, `crypto.getRandomValues`, `new Blob([view])`
  and `structuredClone` all ACCEPT SAB-backed views in Node. The throws
  are browser-spec behavior (WebIDL BufferSource without `[AllowShared]`),
  so Node CI cannot catch a missing shim; probe.html asserts the expected
  browser throws (TextDecoder.decode, getRandomValues, ImageData, Blob),
  pending browser run. JSON paths are indirect (stringify of a view is
  harmless key/value output; parse operates on strings — decode is the
  gate). `structuredClone(sabView)` clones sharing the SAB (legal);
  `WebAssembly.Module` accepts shared BufferSource.

  Repo audit (full `cpu.mem8`/`read_blob`/`write_blob` consumer sweep,
  data flow verified per site): only **two** sites feed guest RAM to a
  SAB-hostile API without an intervening copy —
  1. `src/browser/starter.js:1589-1592` — `V86.prototype.read_memory`
     returns the live `cpu.read_blob()` subarray to embedders (typed
     `Uint8Array` in v86.d.ts:986); any embedder TextDecoder/Blob/fetch
     use breaks under SAB. **Copy-first shim: return a `.slice()`.**
     Highest-leverage single fix.
  2. `src/browser/main.js:3083-3084` — debug "dump memory" wraps the whole
     `mem8` view in `new Blob(...)` (via lib.js:445-453) uncopied.
     **Copy-first shim: `mem8.slice()`.**
  Everything else already copies: every one of the 13 `get_next_blob` call
  sites allocates a fresh destination buffer (9p.js:286/911/999,
  virtio_console.js:98/127, virtio_net.js:100/121,
  virtio_balloon.js:86/101/119, virtio_gpu.js:359-361), which keeps
  marshall.js (encode-from-string, decode-from-copy), serial/xterm,
  networking (WebSocket.send paths), and GPU `writeTexture`/`writeBuffer`
  clean; dma.js:350 and ide.js:2350 use guest views only as
  `TypedArray.set` sources (legal with SAB); state.js copies guest RAM via
  `pack_memory` (cpu.js:1096-1105) before serialization and its
  TextDecoder path reads zstd scratch in the *module* memory, not guest
  RAM. The VGA `ImageData` (vga.js:1177-1180, 2520-2524) is backed by
  `svga_allocate_dest_buffer` in the main module's memory — untouched
  under option A, and an **independent option-B killer**: `new ImageData`
  over a shared buffer throws before a pixel is drawn, with no shim short
  of a per-frame framebuffer copy. `structuredClone` is unused in src/ and
  lib/. `write_blob`/`mem8.set(...)` (guest RAM as destination) is never
  SAB-hostile.
  **S4: two copy-first shims needed (Stage 5), both trivial; browser
  throw-behavior cells pending probe.html run.**
- **S5 — only if S1/S2 fail badly**: price option B for real (nightly
  build-std attempt). **Not triggered** — S1 clean, S2 passes with ~3×
  margin.

**Stage 0 verdict: GO for option A** on V8/Node 24 evidence. Everything
option A structurally depends on is proven in V8: multi-memory modules with
a shared memidx 1 validate and execute (S1); atomics validate on non-shared
memory, so one generated-code shape serves COI and non-COI (S1); the
interpreter's cross-instance accessor cost projects to ~1.27× — far inside
the 2× gate, keeping the §5 fetch-cache mitigation out of scope (S2); the
Phase 4 worker-mailbox primitives work end-to-end (S3); and the SAB API-hole
surface is exactly two copy-first shims (S4). Remaining browser-pending:
(a) the S1 multi-memory matrix in Chrome/Firefox and especially Safari —
Safari remains the real go/no-go unknown for shipping the variant beyond
Chromium/Gecko, but it gates only browser rollout, not Stages 1–4, which
are Rust/wasm_builder/Node-testable; (b) S3 crossOriginIsolated gating
cells; (c) S4 browser throw-behavior confirmations (Node provably cannot
test these — shim regressions need a browser check, not Node CI). All are
covered by loading `probe.html` (COI-served and plain-served) and reading
the DOM matrix / `#summary-json`.

## 2. Option analysis

### Option A — guest RAM as an imported second memory (RECOMMENDED)

Guest RAM becomes its own `WebAssembly.Memory` (created by JS, `shared:true`
when cross-origin isolated, maximum = memory_size). Three module classes:

1. **Main Rust module (v86-multimem.wasm)** stays a *single-memory* module on
   stable Rust — LLVM/Rust cannot address a second memory from source (hard
   constraint). All Rust-side guest-RAM access goes through **imported
   accessor functions** (`env.gram_read8/16/32/64/128`, `gram_write*`,
   `gram_copy`, `gram_fill`) implemented by:
2. **gram.wasm**, a tiny hand-generated module (Node generator in `gen/`)
   whose *memory 0 is the guest memory itself* (imported, shared) — also a
   plain single-memory module. Its exports merge into `env` before the main
   module instantiates. wasm→wasm import calls are cheap trampolines (S2
   quantifies).
3. **JIT-generated modules** are the only true multi-memory modules:
   memory 0 = `"e"."m"` (instance linear memory: state block, tlb_data,
   scratch) unchanged; memory 1 = `"e"."g"` (guest RAM, import flag 0x03 =
   has-max+shared). `gen_safe_read`/`gen_safe_write` emit the same address
   computation but load/store with memidx 1.

Consequential simplification: TLB entries stop baking `mem8` — the fast-path
address becomes a guest-physical address directly valid as a memidx-1 offset.
All nine "- mem8" compensation sites and the codegen constants lose the
addend — *in the multimem build only*; the default build keeps baking so
expect goldens stay byte-identical.

Changes: memory.rs helper bodies switch under a cargo feature to accessor
calls; `allocate_memory` stops allocating; the 17 raw deref sites move onto
the abstraction (inertly for both builds); wasm_builder grows memidx-aware
emitters and a second memory-import writer; JS adds `jit_imports["g"]` and
the gram.wasm instantiation in starter.js's `wasm_fn` seam; devices untouched
(views retarget).

Toolchain: **no nightly, no `+atomics` in the Rust build, no TLS/stack
work.** Each worker instance later gets its own linear memory exactly as
today — instantiate the same bytes N times (`this.wasm_source` and the
zstd-worker precedent already demonstrate this). Engines only need
multi-memory for **JIT modules** — DISABLE_JIT mode runs even without it.

Costs: interpreter guest access becomes a call (S2; JIT-covered hot code is
unaffected); new artifact + generator; more involved instantiation dance.

### Option B — whole-module shared memory (+atomics) — REJECTED

Every instance would share ALL statics: the fixed CPU block 64..1280 (the
very thing Phase 2's swap multiplexes), tlb_data/tlb_code, JIT_STATE and the
other `try_lock().unwrap()` mutexes (instant panic under contention), and the
allocator heap. Private per-worker state would require the Phase-2-rejected
base-pointer refactor or wasm TLS (which for the hand-addressed block IS the
base-pointer refactor). Phase 2's swap machinery does not rescue this: it
multiplexes one live block per *memory*, and here there is only one memory.
Toolchain: nightly + build-std, atomics-rebuilt softfloat/zstd objects,
--shared-memory --import-memory --max-memory, TLS/stack init interacting
with the hand-reserved sub-4096 region, and no main-thread blocking waits.
Strictly more risk AND it un-decides Phase 2. Retained only as S5 contingency.

### Option C — replication + dirty-page sync — REJECTED

Cannot implement x86 SMP coherence (LOCK'd RMW, spinlocks, A/D bits) at page
granularity without a global ordering service; contended locks become
cross-worker round trips; N×RAM; JIT invalidation still needs shootdown.
Only viable read-mostly, which guest kernels are not.

## 3. Device access story (Phase 4 preview constraining Phase 3)

The synchronous wasm→JS surface is the `env` imports (starter.js:66–111):
port I/O, MMIO, timers, codegen_finalize, halt/idle. Under worker vCPUs these
become RPC via a control SAB: one 64-byte record per vCPU (`{state, op,
addr, size, value_lo, value_hi}`), worker does store+notify+wait; device side
is the main thread via `Atomics.waitAsync` (S3 confirms) or a dedicated I/O
pump worker. `hlt` parks on the same cell.

Hot paths avoid the mailbox entirely under option A: guest RAM is a SAB, so
main-thread device models keep their direct views — virtio rings, DMA, and
9p payloads never RPC; only notify port writes and IRQ doorbells cross
threads. Residual hot RPCs: legacy VGA 0xA0000 (BSP-only in practice) and
IDE PIO data (mitigated by DMA guests). Option A is the only option giving
devices this zero-copy view.

Phase 3's obligation: keep the import surface intact, keep guest RAM visible
to the main thread as plain typed arrays, and keep `wasm_source` + a factored
`env` builder so a worker can reconstruct instantiation.

## 4. Recommended scope and stages

Milestone: **v86 builds a `v86-multimem.wasm` + `gram.wasm` pair in which
guest RAM is an imported second memory (shared when cross-origin isolated),
and this variant passes the single-core and Phase-2 SMP suites; default
artifacts remain byte-identical.** Threading itself is Phase 4; Phase 3 ends
with the memory architecture proven on one thread.

- **Stage 0 — spikes S1–S4** (evidence recorded here; go/no-go on option A).
- **Stage 1 — guest-RAM abstraction in Rust (inert).** `gram_read*/write*/
  copy/fill/base_tag()/tag_to_phys()/phys_to_tag()` layer; default build
  `#[inline(always)]` over mem8 arithmetic (LTO makes it vanish). Port the
  17 raw sites + memory.rs bodies. Gate: expect goldens unchanged, suites
  green, artifact `cmp` before/after.
- **Stage 2 — wasm_builder multi-memory emitters (inert).** memidx-aware
  load/store + `write_guest_memory_import`; unit-tested by assembling and
  validating modules.
- **Stage 3 — gram.wasm generator.** `gen/generate_gram_wasm.js` →
  `build/gram.wasm` (Makefile rule); Node test over shared and non-shared
  memories.
- **Stage 4 — feature-gated multimem build.** Cargo feature
  `guest-ram-import`: accessors become extern imports, TLB drops the mem8
  addend, codegen emits memidx-1 fast paths. Targets
  `build/v86-multimem[-debug].wasm`. Existing artifacts untouched.
- **Stage 5 — JS integration behind an option.**
  `options.guest_memory_backend: "imported"` (independent of `cpus`);
  starter creates the memory, instantiates gram.wasm, merges env; cpu.js
  branches `create_memory`, adds `jit_imports["g"]`, S4 copy-first shims.
  Default path untouched to the byte.
- **Stage 6 — validation + CI.** All suites against the variant (non-shared
  mode needs no COI, headless CI works); benchmark deltas for interpreter
  and JIT workloads; `make multimem-tests`; embedder docs.

## 5. Risks

Interpreter slowdown from accessor calls (S2 gate; mitigation: 4 KiB
code-page fetch cache keyed like `last_virt_eip`, invalidated via existing
jit-dirty hooks — scoped in only if S2 demands); Safari multi-memory
uncertainty (variant is opt-in; Phase 4 can be Chrome/Firefox-first; option
B remains the priced fallback); divergence between the two TLB-entry formats
(single `phys_to_tag` choke point + debug asserts, qemu differential suite
as detector); gram/env instantiation ordering for embedders with custom
`wasm_fn` (keep the old signature); SAB view API holes (S4 audit;
TextDecoder-on-SAB throws); shared memory max==initial forecloses growth
(acceptable: RAM never grows today); the `view()` Proxy per-access
allocation now over SAB (pre-existing tax, revisit later); two-artifact
maintenance until Phase 4 proves the variant.

## Addendum: why option B is not "faster in theory" either

Option B's per-access ideal (guest RAM as a plain same-memory load, mem8
baked into TLB entries as today) exists only **before** making B correct for
multiple workers. Making it correct regresses a hotter access class than the
one it speeds up:

1. B must un-fix the CPU state block and TLB: with one shared memory, the
   block at 64..1280 and tlb_data/tlb_code are shared, so every worker needs
   them at a per-worker base — the base-pointer/TLS refactor Phase 2
   rejected, which turns every JIT'd state access (instruction pointer,
   flags, register spills, and the tlb_data load on EVERY guest memory
   access — codegen.rs:666/803/882) from absolute-constant addressing into
   base+offset with extra register pressure.
2. On the JIT path — dominant for sustained workloads — A is equal or
   better: absolute TLB load + memidx-1 data access, vs B's base-relative
   TLB load + memidx-0 data access. A memidx-1 load in engine-generated
   machine code is the same load against a different cached base register,
   not an indirection.
3. B is genuinely faster only in the interpreter, where A pays a
   cross-instance call per guest access (read_imm8 worst case). That is the
   cold path by design; spike S2 measures it, the code-page fetch cache is
   the scoped mitigation, and a catastrophic S2 result is the one legitimate
   reason to revisit B (hence S5 keeps it priced).
4. B carries negative terms of its own: one dlmalloc heap behind a lock
   (JIT compile Vec traffic contends), the try_lock().unwrap() mutexes
   (JIT_STATE/APICS/VCPUS/IOAPIC/PIC) become real contended locks, shared
   statics create cache-line contention, a contended lock on the main thread
   cannot block, and the JIT cache cannot be shared even under B (wasm
   tables are per-instance, so table indices baked into compiled code
   diverge) — B ends up needing per-worker JIT state through TLS anyway.

Whole-system: A wins or ties on the hot path, loses measurably only in the
interpreter (S2 quantifies), and avoids B's toolchain and correctness
overhauls.

## Addendum 2: where atomics do and don't appear under option A

"Atomics" means three different things here, treated differently:

1. **Toolchain atomics** (`-C target-feature=+atomics`, `--shared-memory`,
   rebuilt std): NOT used — that is the point of A. The flag exists to make
   Rust's own memory (statics, heap, stack, mutexes, allocator) safe when
   the module's linear memory is shared between threads. Under A each
   worker's linear memory is private, so the stable-toolchain non-atomic
   build stays correct.
2. **Wasm atomic instructions on the guest memory**: used, but only from
   modules we hand-emit, and only starting in Phase 4 when the LOCK prefix
   becomes real: JIT modules (wasm_builder gains `i32.atomic.rmw.*` +
   `atomic.fence` emitters with memidx 1) for LOCK-prefixed instructions,
   implicitly-locked XCHG, and atomic page-table A/D updates; gram.wasm
   gains `gram_atomic_*` exports so the interpreter's `safe_read_write` RMW
   path gets the same semantics; JS `Atomics` serve the Phase-4 mailbox,
   doorbells, and hlt parking. Ordinary guest MOVs stay plain loads/stores —
   the wasm threads model permits racy plain accesses to shared memory;
   only the operations x86 defines as atomic/ordering points become wasm
   atomics.
3. **Phase 3 itself executes zero atomic instructions** — one thread, the
   shared memory is just a container. The only contact is spike S1
   validating `i32.atomic.rmw` on an imported-shared memidx-1 memory NOW so
   Phase 4 cannot discover an engine gap after the memory architecture
   ships. Stage 2's emitters can land the atomic opcodes inertly alongside
   the memidx loads.

Forward risk for the Phase 4 list (not Phase 3 scope): x86 guests assume
TSO memory ordering; wasm plain accesses on weakly-ordered hosts (ARM Macs
included) are weaker. QEMU MTTCG faced exactly this; the options are
fences/acquire-release on guest accesses (costly) or MTTCG's calculated
default risk. Under option A this is purely a codegen decision in files we
own (codegen.rs + the gram generator) — another reason the "we emit every
shared-memory access ourselves" property is worth protecting.
