# XWAH-9 Phase 2 design: time-sliced SMP on one thread

Goal: multiple guest vCPUs multiplexed on the single host thread, so Linux
boots with N schedulable CPUs. Correctness milestone; no parallelism yet.
Every implementation stage keeps `cpus: 1` behavior byte-identical (state
images, expect goldens, boot behavior).

## Context-switch mechanism

**Memcpy-swap of the fixed CPU-state block (linear-memory bytes 64..1280,
1216 bytes) into per-vCPU save areas, plus `full_clear_tlb()` on switch,
with a shared JIT cache.** The base-pointer refactor of `global_pointers.rs`
/`codegen.rs` is intentionally NOT done: it would rewrite thousands of deref
sites and every expect golden, regress generated-code quality (base+offset
per access), and is unnecessary for the Phase 3+ worker design, where each
worker instantiates its own wasm module (own linear memory, fixed offsets
valid per instance) sharing only guest RAM.

Compiled JIT code embeds only (i) absolute state offsets — identical for all
vCPUs because the swap puts the current vCPU's state at those addresses,
(ii) `&tlb_data[0]` — single global TLB whose content is per-current-vCPU,
(iii) `mem8` — shared guest RAM. `tlb_code` relinks lazily from the shared
phys-keyed `JIT_STATE.pages` after each flush, so compiled code stays warm
across vCPUs. Residual pre-existing approximation: compile-time `cs_offset`
embedding for 16-bit wrap-around (jit.rs:832/2158, codegen.rs:635/679) is
keyed only by phys page + state_flags; accepted (real-mode code essentially
never reaches the JIT threshold) and documented.

## Per-vCPU state inventory

The block 64..1280 swaps wholesale; four fields are then fixed up by writing
back the live (shared) values:

- `acpi_enabled` @552 — machine config
- `instruction_counter` @664 — global monotonic counter (deltas use
  wrapping_sub; JS IPS display stays meaningful)
- `svga_dirty_bitmap_min/max_offset` @716/720 — device-side scratch
- `memory_size` @812 — machine config

Everything else in the block is per-vCPU, including `apic_enabled` @548
(IA32_APIC_BASE.EN is a per-CPU MSR), `in_hlt` @616, cr0..cr7, all register
files, segment state, sysenter MSRs, FPU/SSE state, and `reg_pdpte`.

Non-offset statics: `cpuid_level`/`smp_cpus` shared config; TSC statics
shared (one machine-wide TSC — globally monotonic, which Linux's TSC-sync
check wants; WRMSR TSC moving all vCPUs is an accepted deviation);
`tlb_data`/`tlb_code`/`valid_tlb_entries` are current-vCPU caches flushed on
switch; `jit_block_boundary`/`in_jit`/scratch buffers never live across
slices; JIT state shared by design; PIC/IOAPIC are shared chipset devices;
the single `APIC` static becomes N contexts.

## TLB on switch

`full_clear_tlb()` unconditionally (not the global-page-preserving
`clear_tlb()`: APs run paging-off during bring-up while the BSP runs paged
mappings, so TLB_GLOBAL preservation is unsound across vCPUs). Swap first,
then flush — the flush also resets `last_virt_eip`. Estimated 2–10 %
overhead at 2 vCPUs with the existing ~100k-instruction slices; per-vCPU TLB
arrays (4 MiB × N) are the known mitigation if ever needed, out of scope.

## Per-vCPU LAPIC

`static APICS: Mutex<Vec<Apic>>`, sized once in `set_smp_cpus`, never
reallocated. `apic_id = i << 24` set in reset. `get_apic()` resolves to the
current vCPU's context, making the 0xFEE00000 MMIO window per-CPU-local like
real hardware. `route()` fans out over the slice and reports whether any
LAPIC accepted (the IOAPIC remote-IRR contract from Phase 1 carries over);
ICR shorthands 2/3 fan out — SeaBIOS boots APs with shorthand 3 INIT
(0x000C4500) then SIPI (0x000C4600|vector). `acknowledge_irq()` reads the
current context; `apic_timer(now)` iterates all contexts and returns the min
deadline. `deliver(i, ..)` sets `wake_pending[i]` and calls `stop_idling()`.

Save/restore: `get_apic_addr()` returns the contiguous array base;
`get_state_apic` returns N structs (N=1 → byte-identical to today's
state[46]); restore accepts a 1-struct image into LAPIC 0 + resets the rest,
throws StateLoadError on other mismatches. No STATE_VERSION bump.

## Scheduler, hlt, IRQ wake

Switch hook in `main_loop` between `do_many_cycles_native()` slices (timers
and `handle_irqs` already run there). `smp_cpus == 1` takes today's path
verbatim. New `src/rust/cpu/vcpu.rs`:

```
enum RunState { Runnable, WaitForSipi, Parked } // Parked = hlt with IF=0
struct Vcpu { save_area: [u8; 1216], run_state: RunState, wake_pending: bool }
```

Round-robin over Runnable (or halted-with-wake-pending) vCPUs; yield to the
host only when no vCPU is runnable (return min timer deadline); machine-dead
(`return 100.0`) only when ALL vCPUs are Parked/WaitForSipi. The rotation
pointer persists across 1 ms frames to guarantee progress. `instr_F4` with
IF=0 becomes Parked when `smp_cpus > 1` (SeaBIOS parks APs in hlt with IF=0;
Linux wakes them later with INIT+SIPI); `cpu_event_halt` fires only when all
vCPUs are parked. `handle_irqs` gates the 8259 leg to vCPU 0 (ExtINT wires
to the BSP); the APIC leg acknowledges from the current context.
`device_raise_irq` additionally sets `wake_pending[0]` conservatively for
the PIC leg — spurious wakes are harmless, missed wakes hang the guest.

## AP startup (SeaBIOS rel-1.16.x contract)

INIT (assert) to an AP: reset its save area to power-on values,
`WaitForSipi`. INIT-deassert (level, assert=0): ignored, not a second reset.
SIPI(vector) to WaitForSipi: `CS = vector << 8`, CS base `vector << 12`,
`IP = 0`, everything else already power-on; → Runnable + stop_idling.
Second SIPI: idempotent. INIT to the BSP: logged no-op (warm reset out of
scope). BSP identity: `IA32_APIC_BASE` BSP bit, CPUID leaf 1 EBX[31:24], and
leaf 0xB EDX all report the current vCPU index. `reset_cpu` decomposes into
per-vCPU block reset (for each: switch, reset block, APs → WaitForSipi) plus
machine-globals (APIC/IOAPIC reset, TSC, JIT clear) exactly once.
SeaBIOS's BSP spins on CMOS 0x5F vs a guest-memory counter its APs
increment, and fw_cfg NB_CPUS/MAX_CPUS size the MADT — so the firmware
count un-gating (cpu.js) is the LAST stage, only after SIPI works.
`cpus > 1` requires `acpi: true` (LAPIC MMIO is gated on acpi_enabled).

Stage-3 finding: SeaBIOS broadcasts INIT+SIPI at its AP trampoline
(0x10000) unconditionally during POST and, when CMOS 0x5F advertises no
further CPUs, restores the trampoline bytes without waiting. An AP honoring
that SIPI under gated counts either executes the restored bytes (its first
slice begins only after the sending BSP's slice ends) or bumps CountCPUs
past the expected value and hangs the POST spin loop — real hardware fares
no better with mismatched firmware counts. Firmware counts above 1 and
SIPI honoring must therefore never disagree, so the wasm module is the
single authority for both (stage 4): `vcpu::init` arms `AP_STARTUP_ENABLED`
exactly when it sizes the table with more than one vCPU, and cpu.js sources
fw_cfg NB_CPUS/MAX_CPUS and CMOS 0x5F from the `get_firmware_cpus()`
export, which reports `smp_cpus` when AP startup is armed and 1 otherwise —
JavaScript can neither un-gate the counts without arming SIPIs nor the
reverse, and an older wasm without the export keeps both at 1. INIT was
already live in stage 3 (the deferred save-area reset is safe and keeps
APs in WaitForSipi).

## JS-side impacts

Live cpu.js views show the current vCPU — acceptable, switches happen only
inside `main_loop`, so synchronous device callbacks and post-tick reads see
one consistent vCPU. Save/restore: new trailing `state[93]` slot only when
`smp_cpus > 1` (`[u32 smp_cpus][u32 current]` + N × `[meta + 1216B block]`,
via new `vcpu_prepare_save`/`get_vcpu_state_addr/size` exports); cpus=1
state images stay byte-identical, STATE_VERSION stays 6. Documented risk:
older builds silently ignore slot 93 when restoring an experimental
cpus>1 image.

## Testing

Regression at cpus=1: expect goldens (automatic — codegen untouched),
nasmtests/qemutests/jitpagingtests (CI), api-tests incl. state roundtrip and
reboot, full OS-boot suite, rust-test. New: vcpu.rs cargo unit tests
(swap identity over an injected buffer, fixups, INIT/SIPI transitions);
kvm-unit-tests `smptest.flat` once un-gated (runner boots via SeaBIOS);
`tests/api/smp.js` booting an SMP kernel with `cpus: 2`, asserting `nproc`
== 2 over serial. NOTE: `images/buildroot-bzimage68.bin` is a UP kernel
(no CONFIG_SMP — verified from its UTS banner); the SMP fixture must use the
Alpine linux-lts i386 kernel (verify CONFIG_SMP=y) or a new SMP buildroot.

## Stages

1. **vCPU scaffolding (inert)** — vcpu.rs (block save/load with fixups,
   switch_to, run states, exports), set_smp_cpus allocation, reset_cpu
   decomposition, cargo tests.
2. **LAPIC multiplication (inert)** — APICS vector, per-context MMIO/ack/
   timer, route/deliver fan-out with wake plumbing, ioapic threading,
   per-vCPU CPUID/MSR identity, JS apic state for N.
3. **Scheduler + hlt + INIT/SIPI execution** — main_loop round-robin with
   verbatim cpus=1 fast path, Parked semantics, SIPI state machine.
4. **Firmware un-gating + SMP tests** — fw_cfg/CMOS counts served by
   `get_firmware_cpus` (single wasm authority, see §AP startup), acpi
   requirement enforced in starter.js (clamp to 1 + dbg_assert without
   acpi), tests/api/smp.js against the Alpine 9p fixture (skips when the
   image is missing). Stage-4 finding: SeaBIOS's legacy ACPI build reads
   8×(1+max_cpus) bytes from FW_CFG_NUMA (u64 node count + one u64 node id
   per CPU); the fw_cfg handler sizes its all-zero reply accordingly (the
   old fixed 16 bytes covered exactly one CPU). kvm-unit-tests
   `smptest.flat` needs a 32-bit gcc to build (unavailable on the primary
   dev host) — CI follow-up: build.sh the flats, teach run.mjs a cpus
   argument, wire a Makefile target.
5. **Save/restore for N>1 + docs.**

## Risks

JIT cs_offset approximation (pre-existing, low likelihood, detectable via
nasm/qemu suites); missed-wake hangs (mitigated by conservative wakes);
ioapic borrow restructuring for fan-out (fiddliest diff); hlt/IF=0 semantics
must not change cpus=1; state forward-compat for experimental images;
scheduler starvation across frames (persistent rotation pointer); shared
TSC offset; 2–10 % switch overhead at N=2 (measure via make tests timings).
