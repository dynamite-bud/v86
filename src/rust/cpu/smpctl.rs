// XWAH-9 Phase 4 Stage W1: the shared control region (docs/smp-phase4-design.md
// §2). All cross-thread state of worker mode lives inside the imported guest
// memory, above guest RAM and above the JIT scratch page:
//
//   CTL_BASE = memory_size + 0x10000   (the next wasm-page boundary after the
//                                       scratch page at [memory_size,
//                                       memory_size + 0x2000))
//
// JS sizes the guest memory `memory_size + one wasm page + ctl pages` when
// worker mode is requested (src/browser/starter.js; the JS mirror of this
// layout is src/browser/smpctl.js — keep the two in lockstep, the
// worker-skeleton test asserts equality through the probe exports below).
// The guest can never touch the region: addresses >= memory_size are
// mmap-routed to the unmapped handler.
//
// Layout, N-scaled, every field in a 64-byte-aligned block so distinct
// writers never share a cache line (design §2):
//
//   per vCPU i at CTL_BASE + i*VCPU_STRIDE (0x12C0), offsets within the block:
//     0x000  doorbell       u32    version counter; post = add + notify
//     0x040  run_state_pub  u32    RunState published by the worker
//     0x044  heartbeat      u32    W1 addition: wake counter, same writer as
//                                  run_state_pub (no new false sharing)
//     0x048  insn_pub       u32    W3: the worker's instruction counter,
//                                  published per slice; main sums the cells
//                                  for get_instruction_counter (design §8);
//                                  same writer as run_state_pub
//     0x04C  excl_busy      u32    W4 exclusive execution (design §5 final
//                                  form): 1 while this vCPU's worker is
//                                  inside its guest-execution section
//                                  (handle_irqs + do_many_cycles), 0 at
//                                  every safe point (slice boundary, parked,
//                                  spinning for the exclusive cell). Written
//                                  only by the own worker — same writer,
//                                  same line as run_state_pub. An exclusive
//                                  owner waits for every other worker's
//                                  cell to read 0
//     0x080  command        u32    RUN / PARK_REQ / PARKED_ACK / TERMINATE
//     0x084  pic_pending    u32    W3, vCPU 0 only: 8259-INTR flag posted by
//                                  the device host, xchg-taken by the BSP
//                                  worker before its PIC-ack RPC (design §4);
//                                  same writer as command (the host)
//     0x0C0  pending_irr    8xu32  fixed-vector bitmap, atomic-or to post
//     0x100  pending_tmr    8xu32  level-trigger bitmap, same protocol
//     0x140  ipi_special    u32    INIT/SIPI/NMI latch word (or/xchg)
//     0x180  eoi_ring       head u32, tail u32, 16xu32 slots (SPSC)
//     0x200  mailbox        64-byte RPC record, byte-for-byte the
//                           tests/threads/mailbox-protocol.js layout
//                           (u32 indices: STATE, OP, ADDR, SIZE, VALUE_LO,
//                           VALUE_HI, SEQ, rest reserved)
//     0x240  jit_inbox      W3 cross-worker JIT shootdown inbox (design §6;
//                           topology (b)): spinlocked multi-producer push,
//                           single consumer (the block's own worker).
//                           0x240 lock u32, 0x244 head u32, 0x248 overflow
//                           u32 (producer-side line); 0x280 tail u32
//                           (consumer-owned line); 0x2C0 JIT_INBOX_CAP xu32 slots.
//                           Event = phys page number | JIT_EVENT_PROTECT_BIT
//                           (protect = "another instance compiled this
//                           page"); no bit = dirty ("invalidate this page").
//                           Overflow sets the flag instead of dropping: the
//                           consumer recovers with jit_clear_all +
//                           full_clear_tlb (the code-page bitmaps below are
//                           the persistent protection source, so nothing is
//                           lost).
//
//   routing_table at CTL_BASE + n*VCPU_STRIDE:
//     0x00   version        u32    bumped on every publish
//     0x40 + i*0x40          entry i: apic_id, ldr, dfr, tpr, enabled,
//                           runnable (u32 each; per-entry cache line — each
//                           worker publishes only its own entry)
//
//   machine at CTL_BASE + routing end:
//     0x00   tsc_offset     u64    (cmpxchg_64-based access)
//     0x40   buslock        u32    the shared bus-lock cell; cpu/lock.rs
//                                  uses it instead of its L1 instance-local
//                                  cell once set_worker_mode(1) ran (W2) —
//                                  a plain multimem build has no ctl pages
//                                  and never enters worker mode
//     0x80   jit_dirty ring head u32, tail u32, 64xu32 phys pages. W1 ships
//                           the single-producer push; topology (b) replaces
//                           this with the per-vCPU jit inboxes above.
//                           In topology (c) the producer is the device host
//                           (main-thread JS: DMA/disk writes into guest
//                           RAM), the consumer the machine worker
//     0x1C0  dev_irq ring   head u32, tail u32, 256xu32 events (SPSC). The
//                           topology-(c) device-IRQ wire (design §9 W2
//                           note): the device host posts device_raise_irq/
//                           device_lower_irq as ordered events
//                           (irq | DEV_IRQ_RAISE_BIT); the machine worker
//                           drains them at its loop boundary and replays
//                           them into device_raise_irq/device_lower_irq on
//                           ITS instance, which owns PIC+IOAPIC+LAPICs
//     0x600  host_doorbell  u32    W3: worker -> device-host wake counter
//                                  (level-EOI rings, routing-snapshot
//                                  changes); main parks in Atomics.waitAsync
//                                  on it — the worker-to-main mirror of the
//                                  per-vCPU doorbells
//     0x640  exclusive      u32    W4 exclusive execution (design §5 final
//                                  form): 0 = free, else owner vCPU index
//                                  + 1. CAS-acquired by a worker whose
//                                  misaligned/page-crossing/mmap-target
//                                  locked RMW needs bus-lock exactness; the
//                                  owner then waits for every other
//                                  worker's excl_busy to clear, performs
//                                  the RMW, stores 0 + notify. Purely
//                                  peer-to-peer — no host mediation, no
//                                  command-word interaction
//
//   code_bitmaps at CTL_BASE + machine end (W3, topology (b)): one bitmap
//   per vCPU, one bit per guest phys page, owned (written) exclusively by
//   that vCPU's worker: set when the worker starts compiling the page,
//   cleared when its local invalidation removes installed code. TLB fills
//   OR the OTHER workers' bitmaps to decide whether a write to the page
//   must take the dirty-notify slow path (docs/smp-phase4-design.md §9 W3
//   note). Sized from memory_size, so the region is NOT part of the const
//   layout: ctl_total_size/ctl_code_bitmap_offset below.
//
// Everything is reached through the gram accessor layer (no new import
// surface); on non-wasm targets (cargo test) the cell backend below operates
// on an injected buffer instead, so the layout and protocol logic are
// unit-tested natively (the vcpu.rs test pattern).

#![cfg_attr(not(feature = "guest-ram-import"), allow(dead_code))]

pub const CACHE_LINE: u32 = 64;

/// Gap between the end of guest RAM and CTL_BASE: one wasm page, containing
/// the two JIT slow-path scratch pages (memory.rs gram_jit_scratch_base).
pub const CTL_BASE_GAP: u32 = 0x10000;

// 0x2C0 of fixed fields + the jit inbox slots (JIT_INBOX_CAP below). The
// inbox capacity is sized so compile bursts cannot overflow it in steady
// operation: overflow recovery is jit_clear_all + full_clear_tlb on the
// consumer, and at the original 32 slots one worker's post-clear-all
// recompile burst (protect events, one per page per compile) reliably
// overflowed its PEERS' inboxes, whose clear-all recovery re-triggered
// the first worker's — a self-sustaining mutual cache-destruction storm
// (measured 10k-54k inbox events/s per worker with the overflow flag
// visible in up to a third of 1 ms samples; guest throughput collapsed.
// Found via the Ghostty/Codex appliance failing V86_APPLIANCE_READY
// under percpu workers, cpus=4, during its GL/shader-compile phase).
pub const VCPU_STRIDE: u32 = 0x12C0;

// per-vCPU field offsets (relative to the vCPU's block)
pub const DOORBELL: u32 = 0x000;
pub const RUN_STATE_PUB: u32 = 0x040;
pub const HEARTBEAT: u32 = 0x044;
pub const INSN_PUB: u32 = 0x048;
pub const EXCL_BUSY: u32 = 0x04C;
pub const COMMAND: u32 = 0x080;
pub const PIC_PENDING: u32 = 0x084;
pub const PENDING_IRR: u32 = 0x0C0;
pub const PENDING_TMR: u32 = 0x100;
pub const IPI_SPECIAL: u32 = 0x140;
pub const EOI_RING: u32 = 0x180;
pub const MAILBOX: u32 = 0x200;
pub const JIT_INBOX: u32 = 0x240;

pub const PENDING_WORDS: u32 = 8;
pub const EOI_RING_CAP: u32 = 16;
pub const MAILBOX_BYTES: u32 = 64;

// jit_inbox sub-offsets (relative to JIT_INBOX) and event encoding
pub const JIT_INBOX_LOCK: u32 = 0x00;
pub const JIT_INBOX_HEAD: u32 = 0x04;
pub const JIT_INBOX_OVERFLOW: u32 = 0x08;
pub const JIT_INBOX_TAIL: u32 = 0x40;
pub const JIT_INBOX_SLOTS: u32 = 0x80;
pub const JIT_INBOX_CAP: u32 = 1024;
/// Set in a jit_inbox event: "another instance is compiling this page"
/// (the consumer re-protects its TLB entries); clear: "this page was
/// written" (the consumer invalidates its code for it). The low bits carry
/// the phys page number (phys >> 12, < 2^20 for any 32-bit guest RAM).
pub const JIT_EVENT_PROTECT_BIT: u32 = 1 << 24;

// mailbox record u32 indices — normative layout from
// tests/threads/mailbox-protocol.js (Layer A); STATE is the only
// atomically-waited cell, the other fields are plain writes published by the
// seq-cst STATE store
pub const MAILBOX_STATE: u32 = 0;
pub const MAILBOX_OP: u32 = 1;
pub const MAILBOX_ADDR: u32 = 2;
pub const MAILBOX_SIZE: u32 = 3;
pub const MAILBOX_VALUE_LO: u32 = 4;
pub const MAILBOX_VALUE_HI: u32 = 5;
pub const MAILBOX_SEQ: u32 = 6;

pub const MAILBOX_IDLE: i32 = 0;
pub const MAILBOX_REQUEST: i32 = 1;
pub const MAILBOX_RESPONSE: i32 = 2;

// Mailbox op codes used by the Rust-side client below (the JS mirror keeps
// the full table): IN_REP/OUT_REP are the W2 batched string-I/O ops — a rep
// ins/outs page batch as ONE RPC. ADDR = port, SIZE = element width,
// VALUE_LO = element count, VALUE_HI = guest-physical buffer address; the
// device host performs the per-element port accesses in order against the
// shared guest RAM and answers with the element count.
pub const MAILBOX_OP_IN_REP: i32 = 5;
pub const MAILBOX_OP_OUT_REP: i32 = 6;
// W3 (topology (b), design §4): the BSP worker's 8259 acknowledge RPC —
// the device host runs pic_acknowledge_irq() on ITS instance's PIC and
// answers the vector, or -1 when nothing is pending
pub const MAILBOX_OP_PIC_ACK: i32 = 7;

// command[i] values (design §2/§8 quiesce protocol; RESET is the W2
// machine-reboot request — the worker runs reset_cpu on its instance and
// acks by writing RUN back). SAVE/RESTORE are the W4 state-assembly
// requests (design §7), only ever posted to a PARKED_ACK'd worker: SAVE =
// run store_current_tsc + vcpu_prepare_save and post the state regions via
// postMessage, ack PARKED_ACK; RESTORE = receive the state regions via
// postMessage, load them into the live instance, ack PARKED_ACK.
pub const COMMAND_RUN: i32 = 0;
pub const COMMAND_PARK_REQ: i32 = 1;
pub const COMMAND_PARKED_ACK: i32 = 2;
pub const COMMAND_TERMINATE: i32 = 3;
pub const COMMAND_RESET: i32 = 4;
pub const COMMAND_SAVE: i32 = 5;
pub const COMMAND_RESTORE: i32 = 6;

// run_state_pub values: RunState (vcpu.rs) plus the published-only Halted
pub const RUN_STATE_RUNNABLE: i32 = 0;
pub const RUN_STATE_WAIT_FOR_SIPI: i32 = 1;
pub const RUN_STATE_PARKED: i32 = 2;
pub const RUN_STATE_HALTED: i32 = 3;

// routing entry field offsets (relative to the entry)
pub const ROUTING_APIC_ID: u32 = 0x00;
pub const ROUTING_LDR: u32 = 0x04;
pub const ROUTING_DFR: u32 = 0x08;
pub const ROUTING_TPR: u32 = 0x0C;
pub const ROUTING_ENABLED: u32 = 0x10;
pub const ROUTING_RUNNABLE: u32 = 0x14;
pub const ROUTING_ENTRY_STRIDE: u32 = 0x40;

// machine field offsets (relative to the machine block)
pub const MACHINE_TSC_OFFSET: u32 = 0x00;
pub const MACHINE_BUSLOCK: u32 = 0x40;
pub const MACHINE_JIT_DIRTY_RING: u32 = 0x80;
pub const MACHINE_DEV_IRQ_RING: u32 = 0x1C0;
pub const MACHINE_HOST_DOORBELL: u32 = 0x600;
pub const MACHINE_EXCLUSIVE: u32 = 0x640;
pub const MACHINE_SIZE: u32 = 0x680;

pub const JIT_DIRTY_RING_CAP: u32 = 64;
pub const DEV_IRQ_RING_CAP: u32 = 256;

// dev_irq ring event encoding: irq number in the low byte, bit 8 = raise
// (clear = lower). Raise/lower stay one ordered stream so level-triggered
// lines replay exactly.
pub const DEV_IRQ_RAISE_BIT: u32 = 1 << 8;

// ring layout (eoi_ring and jit_dirty ring): head, tail, then the slots
pub const RING_HEAD: u32 = 0x0;
pub const RING_TAIL: u32 = 0x4;
pub const RING_SLOTS: u32 = 0x8;

// 64-byte-alignment and containment asserts over the whole layout
const _: () = assert!(VCPU_STRIDE % CACHE_LINE == 0);
const _: () = assert!(DOORBELL % CACHE_LINE == 0);
const _: () = assert!(RUN_STATE_PUB % CACHE_LINE == 0);
const _: () = assert!(HEARTBEAT == RUN_STATE_PUB + 4); // same writer, same line
const _: () = assert!(INSN_PUB == HEARTBEAT + 4); // same writer, same line
const _: () = assert!(EXCL_BUSY == INSN_PUB + 4); // same writer, same line
const _: () = assert!(COMMAND % CACHE_LINE == 0);
const _: () = assert!(PIC_PENDING == COMMAND + 4); // same (host) writer, same line
const _: () = assert!(PENDING_IRR % CACHE_LINE == 0);
const _: () = assert!(PENDING_TMR % CACHE_LINE == 0);
const _: () = assert!(PENDING_IRR + 4 * PENDING_WORDS <= PENDING_TMR);
const _: () = assert!(IPI_SPECIAL % CACHE_LINE == 0);
const _: () = assert!(EOI_RING % CACHE_LINE == 0);
const _: () = assert!(EOI_RING + RING_SLOTS + 4 * EOI_RING_CAP <= MAILBOX);
const _: () = assert!(MAILBOX % CACHE_LINE == 0);
const _: () = assert!(MAILBOX + MAILBOX_BYTES <= JIT_INBOX);
const _: () = assert!(JIT_INBOX % CACHE_LINE == 0);
const _: () = assert!((JIT_INBOX + JIT_INBOX_TAIL) % CACHE_LINE == 0);
const _: () = assert!((JIT_INBOX + JIT_INBOX_SLOTS) % CACHE_LINE == 0);
const _: () = assert!(JIT_INBOX + JIT_INBOX_SLOTS + 4 * JIT_INBOX_CAP <= VCPU_STRIDE);
const _: () = assert!(ROUTING_ENTRY_STRIDE % CACHE_LINE == 0);
const _: () = assert!(MACHINE_BUSLOCK % CACHE_LINE == 0);
const _: () = assert!(MACHINE_JIT_DIRTY_RING % CACHE_LINE == 0);
const _: () =
    assert!(MACHINE_JIT_DIRTY_RING + RING_SLOTS + 4 * JIT_DIRTY_RING_CAP <= MACHINE_DEV_IRQ_RING);
const _: () = assert!(MACHINE_DEV_IRQ_RING % CACHE_LINE == 0);
const _: () =
    assert!(MACHINE_DEV_IRQ_RING + RING_SLOTS + 4 * DEV_IRQ_RING_CAP <= MACHINE_HOST_DOORBELL);
const _: () = assert!(MACHINE_HOST_DOORBELL % CACHE_LINE == 0);
const _: () = assert!(MACHINE_HOST_DOORBELL + 4 <= MACHINE_EXCLUSIVE);
const _: () = assert!(MACHINE_EXCLUSIVE % CACHE_LINE == 0);
const _: () = assert!(MACHINE_EXCLUSIVE + 4 <= MACHINE_SIZE);
const _: () = assert!(MACHINE_SIZE % CACHE_LINE == 0);

/// Offset of the routing table relative to CTL_BASE.
pub const fn routing_offset(n: u32) -> u32 { n * VCPU_STRIDE }

/// Offset of routing entry i relative to CTL_BASE.
pub const fn routing_entry_offset(n: u32, i: u32) -> u32 {
    routing_offset(n) + CACHE_LINE + i * ROUTING_ENTRY_STRIDE
}

/// Offset of the machine block relative to CTL_BASE.
pub const fn machine_offset(n: u32) -> u32 {
    routing_offset(n) + CACHE_LINE + n * ROUTING_ENTRY_STRIDE
}

/// Size of the const part of the control region (everything except the
/// memory-size-scaled code bitmaps) for n vCPUs.
pub const fn ctl_size(n: u32) -> u32 { machine_offset(n) + MACHINE_SIZE }

/// Per-vCPU code-page bitmap stride in bytes: one bit per guest phys page,
/// rounded up to whole cache lines so distinct owner workers never share a
/// line (W3, design §9 W3 note).
pub const fn code_bitmap_stride(memory_size: u32) -> u32 {
    ((memory_size >> 15) + CACHE_LINE - 1) & !(CACHE_LINE - 1)
}

/// Offset of vCPU i's code-page bitmap relative to CTL_BASE.
pub const fn code_bitmap_offset(n: u32, i: u32, memory_size: u32) -> u32 {
    ctl_size(n) + i * code_bitmap_stride(memory_size)
}

/// Total control-region size, code bitmaps included. What JS must size the
/// ctl pages for (the JS mirror is ctl_total_size in smpctl.js).
pub const fn ctl_total_size(n: u32, memory_size: u32) -> u32 {
    ctl_size(n) + n * code_bitmap_stride(memory_size)
}

/// CTL_BASE for a given guest-RAM size.
pub const fn ctl_base_for(memory_size: u32) -> u32 { memory_size + CTL_BASE_GAP }

/// Exported for JS (worker spawn/sizing checks): the control-region base in
/// the imported guest memory. Valid after JS set the memory_size global.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe fn get_smpctl_base() -> u32 {
    let memory_size = *crate::cpu::global_pointers::memory_size;
    dbg_assert!(memory_size != 0);
    ctl_base_for(memory_size)
}

/// Exported for JS: const-part control-region size for n vCPUs. The JS
/// mirror (src/browser/smpctl.js) must compute the same value.
#[no_mangle]
pub fn get_smpctl_size(n: u32) -> u32 { ctl_size(n) }

/// Exported for JS: total control-region size (code bitmaps included) for
/// this instance's memory_size. Valid after JS set the memory_size global.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe fn get_smpctl_total_size(n: u32) -> u32 {
    ctl_total_size(n, *crate::cpu::global_pointers::memory_size)
}

/// Exported for JS: offset (relative to CTL_BASE) of vCPU i's code-page
/// bitmap for this instance's memory_size.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe fn get_smpctl_code_bitmap_offset(i: u32, n: u32) -> u32 {
    code_bitmap_offset(n, i, *crate::cpu::global_pointers::memory_size)
}

// field ids of the get_smpctl_offset probe (mirrored in smpctl.js)
pub const PROBE_DOORBELL: u32 = 0;
pub const PROBE_RUN_STATE_PUB: u32 = 1;
pub const PROBE_HEARTBEAT: u32 = 2;
pub const PROBE_COMMAND: u32 = 3;
pub const PROBE_PENDING_IRR: u32 = 4;
pub const PROBE_PENDING_TMR: u32 = 5;
pub const PROBE_IPI_SPECIAL: u32 = 6;
pub const PROBE_EOI_RING: u32 = 7;
pub const PROBE_MAILBOX: u32 = 8;
pub const PROBE_ROUTING_VERSION: u32 = 9;
pub const PROBE_ROUTING_ENTRY: u32 = 10;
pub const PROBE_MACHINE_TSC_OFFSET: u32 = 11;
pub const PROBE_MACHINE_BUSLOCK: u32 = 12;
pub const PROBE_MACHINE_JIT_DIRTY_RING: u32 = 13;
pub const PROBE_MACHINE_DEV_IRQ_RING: u32 = 14;
pub const PROBE_INSN_PUB: u32 = 15;
pub const PROBE_PIC_PENDING: u32 = 16;
pub const PROBE_JIT_INBOX: u32 = 17;
pub const PROBE_MACHINE_HOST_DOORBELL: u32 = 18;
pub const PROBE_EXCL_BUSY: u32 = 19;
pub const PROBE_MACHINE_EXCLUSIVE: u32 = 20;

/// Exported for JS/tests: offset (relative to CTL_BASE) of a layout field —
/// the cross-language layout check of the worker-skeleton test iterates over
/// every id and compares against the JS mirror. Returns u32::MAX for an
/// unknown field id.
#[no_mangle]
pub fn get_smpctl_offset(field: u32, i: u32, n: u32) -> u32 {
    let vcpu = i * VCPU_STRIDE;
    match field {
        PROBE_DOORBELL => vcpu + DOORBELL,
        PROBE_RUN_STATE_PUB => vcpu + RUN_STATE_PUB,
        PROBE_HEARTBEAT => vcpu + HEARTBEAT,
        PROBE_COMMAND => vcpu + COMMAND,
        PROBE_PENDING_IRR => vcpu + PENDING_IRR,
        PROBE_PENDING_TMR => vcpu + PENDING_TMR,
        PROBE_IPI_SPECIAL => vcpu + IPI_SPECIAL,
        PROBE_EOI_RING => vcpu + EOI_RING,
        PROBE_MAILBOX => vcpu + MAILBOX,
        PROBE_ROUTING_VERSION => routing_offset(n),
        PROBE_ROUTING_ENTRY => routing_entry_offset(n, i),
        PROBE_MACHINE_TSC_OFFSET => machine_offset(n) + MACHINE_TSC_OFFSET,
        PROBE_MACHINE_BUSLOCK => machine_offset(n) + MACHINE_BUSLOCK,
        PROBE_MACHINE_JIT_DIRTY_RING => machine_offset(n) + MACHINE_JIT_DIRTY_RING,
        PROBE_MACHINE_DEV_IRQ_RING => machine_offset(n) + MACHINE_DEV_IRQ_RING,
        PROBE_INSN_PUB => vcpu + INSN_PUB,
        PROBE_PIC_PENDING => vcpu + PIC_PENDING,
        PROBE_JIT_INBOX => vcpu + JIT_INBOX,
        PROBE_MACHINE_HOST_DOORBELL => machine_offset(n) + MACHINE_HOST_DOORBELL,
        PROBE_EXCL_BUSY => vcpu + EXCL_BUSY,
        PROBE_MACHINE_EXCLUSIVE => machine_offset(n) + MACHINE_EXCLUSIVE,
        _ => u32::MAX,
    }
}

// ---- cell backend ----
//
// On wasm32 every op goes through the gram layer (gram.wasm executes the
// atomics over the shared guest memory). On other targets (cargo test) the
// same ops run against an injected buffer, keeping the accessor logic
// natively testable. Plain (non-atomic) ops exist for the fields whose
// protocol publishes them via a subsequent seq-cst store (mailbox record
// fields, ring slots) — the shared-view-coherence rule.

#[cfg(target_arch = "wasm32")]
mod cell {
    use crate::cpu::memory;

    // gram.wasm exports these (gen/generate_gram_wasm.js); memory.rs only
    // declares the subset the LOCK stages use, so the rmw add/or/xchg forms
    // are declared here. Duplicate extern declarations of the same import
    // unify — same "env" import either way.
    mod ext {
        #[link(wasm_import_module = "env")]
        extern "C" {
            pub fn gram_atomic_rmw_add_32(addr: u32, value: i32) -> i32;
            pub fn gram_atomic_rmw_or_32(addr: u32, value: i32) -> i32;
            pub fn gram_atomic_rmw_and_32(addr: u32, value: i32) -> i32;
            pub fn gram_atomic_rmw_xchg_32(addr: u32, value: i32) -> i32;
        }
    }

    pub unsafe fn load32(addr: u32) -> i32 { memory::gram_atomic_load_32(addr) }
    pub unsafe fn store32(addr: u32, value: i32) { memory::gram_atomic_store_32(addr, value) }
    pub unsafe fn add32(addr: u32, value: i32) -> i32 { ext::gram_atomic_rmw_add_32(addr, value) }
    pub unsafe fn or32(addr: u32, value: i32) -> i32 { ext::gram_atomic_rmw_or_32(addr, value) }
    pub unsafe fn and32(addr: u32, value: i32) -> i32 { ext::gram_atomic_rmw_and_32(addr, value) }
    pub unsafe fn xchg32(addr: u32, value: i32) -> i32 { ext::gram_atomic_rmw_xchg_32(addr, value) }
    pub unsafe fn cmpxchg32(addr: u32, expected: i32, replacement: i32) -> i32 {
        memory::gram_atomic_rmw_cmpxchg_32(addr, expected, replacement)
    }
    pub unsafe fn cmpxchg64(addr: u32, expected: u64, replacement: u64) -> u64 {
        memory::gram_atomic_rmw_cmpxchg_64(addr, expected, replacement)
    }
    pub unsafe fn read32_plain(addr: u32) -> i32 { memory::gram_read32(addr) }
    pub unsafe fn write32_plain(addr: u32, value: i32) { memory::gram_write32(addr, value) }
    pub unsafe fn notify(addr: u32, count: i32) -> i32 { memory::gram_notify(addr, count) }
    /// memory.atomic.wait32 (worker threads only — traps on a browser main
    /// thread, which never calls this). 0 = woken, 1 = not-equal, 2 =
    /// timed out.
    pub unsafe fn wait32(addr: u32, expected: i32, timeout_ns: i64) -> i32 {
        memory::gram_wait32(addr, expected, timeout_ns)
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod cell {
    // Native (cargo test) backend: word ops over an injected buffer. Tests
    // run single-threaded over their own region (RUST_TEST_THREADS=1 and a
    // per-test install), so plain accesses model the wasm atomics exactly.
    use std::cell::RefCell;

    thread_local! {
        static BUF: RefCell<Vec<u32>> = RefCell::new(Vec::new());
    }

    /// Install a zeroed test buffer of `bytes` bytes addressed from 0.
    pub fn install_test_buffer(bytes: u32) {
        BUF.with(|b| *b.borrow_mut() = vec![0; (bytes as usize + 3) / 4]);
    }

    fn word(addr: u32) -> usize {
        assert!(addr % 4 == 0, "unaligned cell access at {:#x}", addr);
        (addr / 4) as usize
    }

    pub unsafe fn load32(addr: u32) -> i32 { BUF.with(|b| b.borrow()[word(addr)] as i32) }
    pub unsafe fn store32(addr: u32, value: i32) {
        BUF.with(|b| b.borrow_mut()[word(addr)] = value as u32);
    }
    pub unsafe fn add32(addr: u32, value: i32) -> i32 {
        BUF.with(|b| {
            let mut b = b.borrow_mut();
            let old = b[word(addr)];
            b[word(addr)] = old.wrapping_add(value as u32);
            old as i32
        })
    }
    pub unsafe fn or32(addr: u32, value: i32) -> i32 {
        BUF.with(|b| {
            let mut b = b.borrow_mut();
            let old = b[word(addr)];
            b[word(addr)] = old | value as u32;
            old as i32
        })
    }
    pub unsafe fn and32(addr: u32, value: i32) -> i32 {
        BUF.with(|b| {
            let mut b = b.borrow_mut();
            let old = b[word(addr)];
            b[word(addr)] = old & value as u32;
            old as i32
        })
    }
    pub unsafe fn xchg32(addr: u32, value: i32) -> i32 {
        BUF.with(|b| {
            let mut b = b.borrow_mut();
            let old = b[word(addr)];
            b[word(addr)] = value as u32;
            old as i32
        })
    }
    pub unsafe fn cmpxchg32(addr: u32, expected: i32, replacement: i32) -> i32 {
        BUF.with(|b| {
            let mut b = b.borrow_mut();
            let old = b[word(addr)];
            if old == expected as u32 {
                b[word(addr)] = replacement as u32;
            }
            old as i32
        })
    }
    pub unsafe fn cmpxchg64(addr: u32, expected: u64, replacement: u64) -> u64 {
        assert!(addr % 8 == 0, "unaligned cmpxchg64 at {:#x}", addr);
        BUF.with(|b| {
            let mut b = b.borrow_mut();
            let lo = word(addr);
            let old = b[lo] as u64 | (b[lo + 1] as u64) << 32;
            if old == expected {
                b[lo] = replacement as u32;
                b[lo + 1] = (replacement >> 32) as u32;
            }
            old
        })
    }
    pub unsafe fn read32_plain(addr: u32) -> i32 { load32(addr) }
    pub unsafe fn write32_plain(addr: u32, value: i32) { store32(addr, value) }
    pub unsafe fn notify(_addr: u32, _count: i32) -> i32 { 0 }
    /// Native stand-in: single-threaded tests never block; report
    /// "not-equal" so a (never-reached) wait loop would re-inspect.
    pub unsafe fn wait32(_addr: u32, _expected: i32, _timeout_ns: i64) -> i32 { 1 }
}

#[cfg(not(target_arch = "wasm32"))]
pub use cell::install_test_buffer;

/// CTL_BASE of the live instance. On wasm32 it derives from the memory_size
/// global (set by JS before allocate_memory); natively the injected test
/// buffer is addressed from 0.
#[cfg(target_arch = "wasm32")]
unsafe fn base() -> u32 {
    let memory_size = *crate::cpu::global_pointers::memory_size;
    dbg_assert!(memory_size != 0);
    ctl_base_for(memory_size)
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn base() -> u32 { 0 }

unsafe fn vcpu_field(i: u32, offset: u32) -> u32 { base() + i * VCPU_STRIDE + offset }

// ---- doorbell ----

/// Post vCPU i's doorbell: bump the version counter and wake any waiter.
/// Returns the pre-post counter value.
pub unsafe fn doorbell_post(i: u32) -> i32 {
    let addr = vcpu_field(i, DOORBELL);
    let old = cell::add32(addr, 1);
    cell::notify(addr, i32::MAX);
    old
}

/// Read vCPU i's doorbell counter (the "seen" value a parked worker passes
/// to its wait).
pub unsafe fn doorbell_read(i: u32) -> i32 { cell::load32(vcpu_field(i, DOORBELL)) }

// ---- run state + heartbeat ----

pub unsafe fn run_state_publish(i: u32, state: i32) {
    cell::store32(vcpu_field(i, RUN_STATE_PUB), state);
}

pub unsafe fn run_state_read(i: u32) -> i32 { cell::load32(vcpu_field(i, RUN_STATE_PUB)) }

/// Bump vCPU i's wake counter (W1 skeleton liveness diagnostic).
pub unsafe fn heartbeat_publish(i: u32) -> i32 { cell::add32(vcpu_field(i, HEARTBEAT), 1) }

pub unsafe fn heartbeat_read(i: u32) -> i32 { cell::load32(vcpu_field(i, HEARTBEAT)) }

/// Publish vCPU i's instruction counter (W3, design §8): main sums the
/// cells for the approximate machine-wide get_instruction_counter.
pub unsafe fn insn_publish(i: u32, count: i32) { cell::store32(vcpu_field(i, INSN_PUB), count) }

pub unsafe fn insn_read(i: u32) -> i32 { cell::load32(vcpu_field(i, INSN_PUB)) }

// ---- 8259 INTR flag (W3, design §4: PIC doorbell to the BSP worker) ----

pub unsafe fn pic_pending_set(i: u32) { cell::store32(vcpu_field(i, PIC_PENDING), 1) }

/// Take the flag (atomic exchange with 0); non-zero = the 8259 asserted
/// INTR since the last take and the BSP worker must issue the PIC-ack RPC.
pub unsafe fn pic_pending_take(i: u32) -> i32 { cell::xchg32(vcpu_field(i, PIC_PENDING), 0) }

// ---- host doorbell (W3: worker -> device-host wake) ----

/// Wake the device host: bump the machine host_doorbell counter and notify
/// the main thread's Atomics.waitAsync.
pub unsafe fn host_doorbell_post(n: u32) -> i32 {
    let addr = base() + machine_offset(n) + MACHINE_HOST_DOORBELL;
    let old = cell::add32(addr, 1);
    cell::notify(addr, i32::MAX);
    old
}

// ---- exclusive execution (W4, design §5 final form) ----
//
// The cells of the peer-to-peer exclusive protocol. Requesters CAS the
// machine `exclusive` cell (0 -> own index + 1); every worker brackets its
// guest-execution section with `excl_busy` = 1/0 and re-checks the
// exclusive cell at each safe point. Dekker-style seq-cst ordering makes
// the pair sound: a worker stores busy=1 BEFORE loading the exclusive
// cell, the owner's CAS precedes its busy loads, so either the entering
// worker observes the owner (and waits at the safe point) or the owner
// observes busy=1 (and waits for the slice to end). All ops are seq-cst
// gram atomics; the wait forms use memory.atomic.wait32 (workers only).

/// Mark this worker inside its guest-execution section (no notify: nobody
/// ever waits for busy to BECOME set).
pub unsafe fn excl_busy_set(i: u32) { cell::store32(vcpu_field(i, EXCL_BUSY), 1) }

/// Mark this worker at a safe point and wake any exclusive owner waiting
/// on the cell.
pub unsafe fn excl_busy_clear(i: u32) {
    let addr = vcpu_field(i, EXCL_BUSY);
    cell::store32(addr, 0);
    cell::notify(addr, i32::MAX);
}

pub unsafe fn excl_busy_read(i: u32) -> i32 { cell::load32(vcpu_field(i, EXCL_BUSY)) }

/// Owner-side wait for worker i's busy cell to clear. Returns the wait32
/// outcome (0 woken / 1 not-equal / 2 timed out); the caller re-checks the
/// cell either way.
pub unsafe fn excl_busy_wait_clear(i: u32, timeout_ns: i64) -> i32 {
    cell::wait32(vcpu_field(i, EXCL_BUSY), 1, timeout_ns)
}

unsafe fn exclusive_addr(n: u32) -> u32 { base() + machine_offset(n) + MACHINE_EXCLUSIVE }

/// Try to become the exclusive owner: CAS 0 -> `owner` (vCPU index + 1;
/// never 0).
pub unsafe fn exclusive_try_acquire(n: u32, owner: i32) -> bool {
    dbg_assert!(owner > 0);
    cell::cmpxchg32(exclusive_addr(n), 0, owner) == 0
}

pub unsafe fn exclusive_release(n: u32) {
    let addr = exclusive_addr(n);
    cell::store32(addr, 0);
    cell::notify(addr, i32::MAX);
}

pub unsafe fn exclusive_read(n: u32) -> i32 { cell::load32(exclusive_addr(n)) }

/// Wait until the exclusive cell moves away from `current` (a contender or
/// a worker parked at its slice-entry safe point). Returns the wait32
/// outcome; the caller re-checks the cell either way.
pub unsafe fn exclusive_wait(n: u32, current: i32, timeout_ns: i64) -> i32 {
    cell::wait32(exclusive_addr(n), current, timeout_ns)
}

// ---- command (quiesce protocol, design §8) ----

pub unsafe fn command_read(i: u32) -> i32 { cell::load32(vcpu_field(i, COMMAND)) }

pub unsafe fn command_write(i: u32, command: i32) {
    cell::store32(vcpu_field(i, COMMAND), command);
}

/// Acknowledge a command: replace `expected` with `ack` atomically. Returns
/// false when the command word changed in between (the main thread re-posted).
pub unsafe fn command_ack(i: u32, expected: i32, ack: i32) -> bool {
    cell::cmpxchg32(vcpu_field(i, COMMAND), expected, ack) == expected
}

// ---- pending interrupt bitmaps ----

/// Post fixed-interrupt vector bits: atomic OR into word `word` of vCPU i's
/// IRR bitmap. Posting is idempotent and coalescing, like a real IRR.
pub unsafe fn pending_irr_or(i: u32, word: u32, bits: u32) -> u32 {
    dbg_assert!(word < PENDING_WORDS);
    cell::or32(vcpu_field(i, PENDING_IRR + 4 * word), bits as i32) as u32
}

/// Drain word `word` of vCPU i's IRR bitmap (atomic exchange with 0).
pub unsafe fn pending_irr_drain(i: u32, word: u32) -> u32 {
    dbg_assert!(word < PENDING_WORDS);
    cell::xchg32(vcpu_field(i, PENDING_IRR + 4 * word), 0) as u32
}

pub unsafe fn pending_tmr_or(i: u32, word: u32, bits: u32) -> u32 {
    dbg_assert!(word < PENDING_WORDS);
    cell::or32(vcpu_field(i, PENDING_TMR + 4 * word), bits as i32) as u32
}

pub unsafe fn pending_tmr_drain(i: u32, word: u32) -> u32 {
    dbg_assert!(word < PENDING_WORDS);
    cell::xchg32(vcpu_field(i, PENDING_TMR + 4 * word), 0) as u32
}

// ---- INIT/SIPI/NMI latch word ----

/// ipi_special bit assignments (design §2): INIT latch, SIPI latch, NMI
/// latch, SIPI vector byte.
pub const IPI_INIT_BIT: u32 = 1 << 0;
pub const IPI_SIPI_BIT: u32 = 1 << 1;
pub const IPI_NMI_BIT: u32 = 1 << 2;
pub const IPI_SIPI_VECTOR_SHIFT: u32 = 8;
pub const IPI_SIPI_VECTOR_MASK: u32 = 0xFF << IPI_SIPI_VECTOR_SHIFT;

pub unsafe fn ipi_special_or(i: u32, bits: u32) -> u32 {
    cell::or32(vcpu_field(i, IPI_SPECIAL), bits as i32) as u32
}

/// Consume the whole latch word (atomic exchange with 0).
pub unsafe fn ipi_special_take(i: u32) -> u32 { cell::xchg32(vcpu_field(i, IPI_SPECIAL), 0) as u32 }

// ---- mailbox record ----

/// Byte address of vCPU i's mailbox record (JS builds its Int32Array view
/// over the same address).
pub unsafe fn mailbox_addr(i: u32) -> u32 { vcpu_field(i, MAILBOX) }

/// Plain field write (published by the subsequent seq-cst STATE store).
pub unsafe fn mailbox_field_write(i: u32, field: u32, value: i32) {
    dbg_assert!(field >= 1 && field < MAILBOX_BYTES / 4);
    cell::write32_plain(mailbox_addr(i) + 4 * field, value);
}

/// Plain field read (acquired by the preceding seq-cst STATE load).
pub unsafe fn mailbox_field_read(i: u32, field: u32) -> i32 {
    dbg_assert!(field >= 1 && field < MAILBOX_BYTES / 4);
    cell::read32_plain(mailbox_addr(i) + 4 * field)
}

/// Seq-cst STATE store: publishes the plain field writes before it.
pub unsafe fn mailbox_state_store(i: u32, state: i32) {
    let addr = mailbox_addr(i) + 4 * MAILBOX_STATE;
    cell::store32(addr, state);
    cell::notify(addr, i32::MAX);
}

pub unsafe fn mailbox_state_load(i: u32) -> i32 {
    cell::load32(mailbox_addr(i) + 4 * MAILBOX_STATE)
}

/// Rust-side mailbox client (Stage W2): one blocking RPC on vCPU i's
/// record, byte-identical protocol to smpctl.js mailbox_request — plain
/// field writes published by the seq-cst STATE store + notify, then a
/// wait32 loop until the device host answers RESPONSE. Worker threads only
/// (wait32 traps on a browser main thread). A device host that never
/// answers is fail-stop, like the JS client's timeout throw.
pub unsafe fn mailbox_rpc(
    i: u32,
    op: i32,
    addr: i32,
    size: i32,
    value_lo: i32,
    value_hi: i32,
) -> i32 {
    mailbox_field_write(i, MAILBOX_OP, op);
    mailbox_field_write(i, MAILBOX_ADDR, addr);
    mailbox_field_write(i, MAILBOX_SIZE, size);
    mailbox_field_write(i, MAILBOX_VALUE_LO, value_lo);
    mailbox_field_write(i, MAILBOX_VALUE_HI, value_hi);
    mailbox_state_store(i, MAILBOX_REQUEST);
    let state_addr = mailbox_addr(i) + 4 * MAILBOX_STATE;
    let mut timeouts = 0;
    while cell::load32(state_addr) != MAILBOX_RESPONSE {
        // 1 s wait slices; ~10 s without a response is a dead device host
        if cell::wait32(state_addr, MAILBOX_REQUEST, 1_000_000_000) == 2 {
            timeouts += 1;
            if timeouts > 10 {
                panic!("mailbox: device host never responded");
            }
        }
    }
    let result = mailbox_field_read(i, MAILBOX_VALUE_LO);
    mailbox_state_store(i, MAILBOX_IDLE);
    result
}

// ---- rings (eoi_ring per vCPU; jit_dirty ring in the machine block) ----
//
// SPSC: the producer owns head, the consumer owns tail. The slot write is
// plain; the seq-cst head store publishes it (same rule as the mailbox).

unsafe fn ring_push(ring: u32, cap: u32, value: i32) -> bool {
    let head = cell::load32(ring + RING_HEAD) as u32;
    let tail = cell::load32(ring + RING_TAIL) as u32;
    if head.wrapping_sub(tail) >= cap {
        return false;
    }
    cell::write32_plain(ring + RING_SLOTS + 4 * (head % cap), value);
    cell::store32(ring + RING_HEAD, head.wrapping_add(1) as i32);
    true
}

/// Pop one element, or None when the ring is empty.
unsafe fn ring_pop(ring: u32, cap: u32) -> Option<i32> {
    let tail = cell::load32(ring + RING_TAIL) as u32;
    let head = cell::load32(ring + RING_HEAD) as u32;
    if head == tail {
        return None;
    }
    let value = cell::read32_plain(ring + RING_SLOTS + 4 * (tail % cap));
    cell::store32(ring + RING_TAIL, tail.wrapping_add(1) as i32);
    Some(value)
}

/// Push a level-EOI vector onto vCPU i's worker->main ring. False = full
/// (the poster must fall back / retry after a doorbell round).
pub unsafe fn eoi_ring_push(i: u32, vector: i32) -> bool {
    ring_push(vcpu_field(i, EOI_RING), EOI_RING_CAP, vector)
}

pub unsafe fn eoi_ring_pop(i: u32) -> Option<i32> {
    ring_pop(vcpu_field(i, EOI_RING), EOI_RING_CAP)
}

/// Push a dirty phys page onto the machine jit_dirty ring. W1: single
/// producer only (the W3 cross-worker shootdown owns the multi-producer
/// protocol). False = full; the consumer then falls back to jit_clear_all.
pub unsafe fn jit_dirty_ring_push(n: u32, phys_page: i32) -> bool {
    ring_push(
        base() + machine_offset(n) + MACHINE_JIT_DIRTY_RING,
        JIT_DIRTY_RING_CAP,
        phys_page,
    )
}

pub unsafe fn jit_dirty_ring_pop(n: u32) -> Option<i32> {
    ring_pop(
        base() + machine_offset(n) + MACHINE_JIT_DIRTY_RING,
        JIT_DIRTY_RING_CAP,
    )
}

/// Push one device-IRQ event (`irq | DEV_IRQ_RAISE_BIT` for a raise, bare
/// irq number for a lower) onto the topology-(c) device-IRQ ring. SPSC: the
/// producer is the device host, the consumer the machine worker. False =
/// full; the JS producer then queues the event and retries after the
/// consumer drained (events must stay ordered, so nothing may be dropped).
pub unsafe fn dev_irq_ring_push(n: u32, event: i32) -> bool {
    ring_push(
        base() + machine_offset(n) + MACHINE_DEV_IRQ_RING,
        DEV_IRQ_RING_CAP,
        event,
    )
}

pub unsafe fn dev_irq_ring_pop(n: u32) -> Option<i32> {
    ring_pop(
        base() + machine_offset(n) + MACHINE_DEV_IRQ_RING,
        DEV_IRQ_RING_CAP,
    )
}

// ---- per-vCPU jit inbox (W3 cross-worker JIT shootdown, design §9 W3) ----
//
// Multi-producer (every other worker plus the device host, which pushes
// from JS with the same protocol), single consumer (the block's own
// worker). Producers serialize on the spinlock; the lock is held for a
// handful of stores only. The consumer pops lock-free: producers publish
// the slot with the seq-cst head store, the consumer owns the tail.
// Overflow never drops silently: the flag makes the consumer recover with
// jit_clear_all + full_clear_tlb, and the code bitmaps re-supply the lost
// protect information at TLB refill.

/// Push one event into vCPU i's inbox (JIT_EVENT_PROTECT_BIT | page, or a
/// bare page number for a dirty event).
pub unsafe fn jit_inbox_push(i: u32, event: i32) {
    let inbox = vcpu_field(i, JIT_INBOX);
    while cell::cmpxchg32(inbox + JIT_INBOX_LOCK, 0, 1) != 0 {}
    let head = cell::load32(inbox + JIT_INBOX_HEAD) as u32;
    let tail = cell::load32(inbox + JIT_INBOX_TAIL) as u32;
    if head.wrapping_sub(tail) >= JIT_INBOX_CAP {
        cell::store32(inbox + JIT_INBOX_OVERFLOW, 1);
    }
    else {
        cell::write32_plain(inbox + JIT_INBOX_SLOTS + 4 * (head % JIT_INBOX_CAP), event);
        cell::store32(inbox + JIT_INBOX_HEAD, head.wrapping_add(1) as i32);
    }
    cell::store32(inbox + JIT_INBOX_LOCK, 0);
}

/// Drain vCPU i's inbox into `f`. Returns true when the inbox overflowed
/// since the last drain: the events up to the current head are then
/// consumed WITHOUT being delivered and the caller must recover with
/// jit_clear_all + full_clear_tlb (events pushed after the head snapshot
/// stay queued for the next drain).
pub unsafe fn jit_inbox_drain(i: u32, mut f: impl FnMut(i32)) -> bool {
    let inbox = vcpu_field(i, JIT_INBOX);
    let overflowed = cell::xchg32(inbox + JIT_INBOX_OVERFLOW, 0) != 0;
    let head = cell::load32(inbox + JIT_INBOX_HEAD) as u32;
    let mut tail = cell::load32(inbox + JIT_INBOX_TAIL) as u32;
    if overflowed {
        cell::store32(inbox + JIT_INBOX_TAIL, head as i32);
        return true;
    }
    while tail != head {
        f(cell::read32_plain(
            inbox + JIT_INBOX_SLOTS + 4 * (tail % JIT_INBOX_CAP),
        ));
        tail = tail.wrapping_add(1);
        cell::store32(inbox + JIT_INBOX_TAIL, tail as i32);
    }
    false
}

// ---- per-vCPU code-page bitmaps (W3, design §9 W3 note) ----
//
// One bit per guest phys page, owned exclusively by vCPU i's worker: set
// when it starts compiling the page, cleared when its local invalidation
// removes installed code. Readers (TLB fills of the OTHER workers) OR the
// non-own bitmaps to decide whether writes to the page must take the
// dirty-notify slow path. A stale set bit is conservative (extra slow-path
// writes); a missing set bit would be a correctness hole, so bits are set
// before the compiler reads the page's bytes.

pub unsafe fn code_bitmap_set(n: u32, i: u32, memory_size: u32, page: u32) {
    if page >= memory_size >> 12 {
        return;
    }
    let addr = base() + code_bitmap_offset(n, i, memory_size) + 4 * (page >> 5);
    cell::or32(addr, (1u32 << (page & 31)) as i32);
}

pub unsafe fn code_bitmap_clear(n: u32, i: u32, memory_size: u32, page: u32) {
    if page >= memory_size >> 12 {
        return;
    }
    let addr = base() + code_bitmap_offset(n, i, memory_size) + 4 * (page >> 5);
    cell::and32(addr, !(1u32 << (page & 31)) as i32);
}

/// Whether vCPU i has (or is compiling) code in `page` — probed with a
/// seq-cst RMW (or 0), NOT a plain atomic load. The RMW's release leg is
/// load-bearing for the dirty-post filter (worker.rs
/// post_dirty_page_with): the writer's PLAIN guest-RAM store must be
/// globally visible before this probe executes, so that when the probe
/// misses a concurrent compile's bit-set (bit-set ordered after the
/// probe), the compiler's subsequent byte reads — ordered after its own
/// seq-cst bit-set — are guaranteed to observe the write it will never be
/// notified about. An acquire-only load would leave the write sitting in
/// the writer's store buffer through the probe, reopening the lost-
/// invalidation window the unconditional broadcast used to cover.
pub unsafe fn code_bitmap_check_rmw(n: u32, i: u32, memory_size: u32, page: u32) -> bool {
    if page >= memory_size >> 12 {
        return false;
    }
    let addr = base() + code_bitmap_offset(n, i, memory_size) + 4 * (page >> 5);
    cell::or32(addr, 0) as u32 & (1u32 << (page & 31)) != 0
}

/// Whether any vCPU other than `own` has (or is compiling) code in `page`.
pub unsafe fn code_bitmap_any_other(n: u32, own: u32, memory_size: u32, page: u32) -> bool {
    if page >= memory_size >> 12 {
        return false;
    }
    let word = 4 * (page >> 5);
    let bit = 1u32 << (page & 31);
    for i in 0..n {
        if i != own
            && cell::load32(base() + code_bitmap_offset(n, i, memory_size) + word) as u32 & bit != 0
        {
            return true;
        }
    }
    false
}

/// Clear vCPU i's whole bitmap (jit_clear_cache / worker re-init).
pub unsafe fn code_bitmap_clear_all(n: u32, i: u32, memory_size: u32) {
    let bitmap = base() + code_bitmap_offset(n, i, memory_size);
    let mut offset = 0;
    while offset < code_bitmap_stride(memory_size) {
        cell::store32(bitmap + offset, 0);
        offset += 4;
    }
}

// ---- routing snapshot ----

/// Publish vCPU i's routing entry and bump the table version. Senders match
/// destinations against this snapshot (design §4).
pub unsafe fn routing_publish(
    n: u32,
    i: u32,
    apic_id: i32,
    ldr: i32,
    dfr: i32,
    tpr: i32,
    enabled: i32,
    runnable: i32,
) {
    let entry = base() + routing_entry_offset(n, i);
    cell::store32(entry + ROUTING_APIC_ID, apic_id);
    cell::store32(entry + ROUTING_LDR, ldr);
    cell::store32(entry + ROUTING_DFR, dfr);
    cell::store32(entry + ROUTING_TPR, tpr);
    cell::store32(entry + ROUTING_ENABLED, enabled);
    cell::store32(entry + ROUTING_RUNNABLE, runnable);
    cell::add32(base() + routing_offset(n), 1);
}

/// Read one field (a ROUTING_* offset) of vCPU i's routing entry.
pub unsafe fn routing_read(n: u32, i: u32, field: u32) -> i32 {
    dbg_assert!(field <= ROUTING_RUNNABLE && field % 4 == 0);
    cell::load32(base() + routing_entry_offset(n, i) + field)
}

pub unsafe fn routing_version(n: u32) -> i32 { cell::load32(base() + routing_offset(n)) }

// ---- machine fields ----

/// Atomic 64-bit read via cmpxchg(addr, 0, 0) (gram has no plain atomic
/// 64-bit load; exchanging 0 for 0 is a no-op that returns the old value).
pub unsafe fn machine_tsc_offset_read(n: u32) -> u64 {
    cell::cmpxchg64(base() + machine_offset(n) + MACHINE_TSC_OFFSET, 0, 0)
}

pub unsafe fn machine_tsc_offset_write(n: u32, value: u64) {
    let addr = base() + machine_offset(n) + MACHINE_TSC_OFFSET;
    let mut old = cell::cmpxchg64(addr, 0, value);
    while old != 0 {
        let prev = cell::cmpxchg64(addr, old, value);
        if prev == old {
            return;
        }
        old = prev;
    }
}

/// Try to acquire the shared bus-lock cell (the W2+ home of cpu/lock.rs'
/// interim cell; W1 only provides the accessors — see the header comment).
pub unsafe fn buslock_try_acquire(n: u32) -> bool {
    cell::cmpxchg32(base() + machine_offset(n) + MACHINE_BUSLOCK, 0, 1) == 0
}

pub unsafe fn buslock_release(n: u32) {
    cell::store32(base() + machine_offset(n) + MACHINE_BUSLOCK, 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Native tests over an injected buffer (the vcpu.rs pattern): base() is
    // 0 there, so offsets relative to CTL_BASE address the buffer directly.
    fn setup(n: u32) { install_test_buffer(ctl_size(n)); }

    #[test]
    fn layout_blocks_are_aligned_and_disjoint() {
        for n in [1, 2, 4, 8, 255] {
            // per-vCPU field intervals within one stride, in layout order
            let fields = [
                (DOORBELL, 4),
                (RUN_STATE_PUB, 16), // + heartbeat + insn_pub + excl_busy
                (COMMAND, 8),        // + pic_pending
                (PENDING_IRR, 4 * PENDING_WORDS),
                (PENDING_TMR, 4 * PENDING_WORDS),
                (IPI_SPECIAL, 4),
                (EOI_RING, RING_SLOTS + 4 * EOI_RING_CAP),
                (MAILBOX, MAILBOX_BYTES),
                (JIT_INBOX, JIT_INBOX_SLOTS + 4 * JIT_INBOX_CAP),
            ];
            for w in fields.windows(2) {
                let (off, len) = w[0];
                assert!(off + len <= w[1].0, "field overlap at {:#x}", w[1].0);
            }
            for (off, _) in [fields[0], fields[2]] {
                assert!(off % CACHE_LINE == 0);
            }
            // region order: vcpu blocks, routing, machine
            assert!(n * VCPU_STRIDE <= routing_offset(n));
            assert!(routing_offset(n) + CACHE_LINE <= routing_entry_offset(n, 0));
            assert!(routing_entry_offset(n, n - 1) + ROUTING_ENTRY_STRIDE <= machine_offset(n));
            assert!(machine_offset(n) % CACHE_LINE == 0);
            assert_eq!(ctl_size(n), machine_offset(n) + MACHINE_SIZE);
        }
    }

    #[test]
    fn probe_export_matches_constants() {
        let n = 4;
        for i in 0..n {
            assert_eq!(get_smpctl_offset(PROBE_DOORBELL, i, n), i * VCPU_STRIDE);
            assert_eq!(
                get_smpctl_offset(PROBE_MAILBOX, i, n),
                i * VCPU_STRIDE + MAILBOX
            );
            assert_eq!(
                get_smpctl_offset(PROBE_ROUTING_ENTRY, i, n),
                routing_entry_offset(n, i)
            );
        }
        assert_eq!(
            get_smpctl_offset(PROBE_ROUTING_VERSION, 0, n),
            routing_offset(n)
        );
        assert_eq!(
            get_smpctl_offset(PROBE_MACHINE_BUSLOCK, 0, n),
            machine_offset(n) + MACHINE_BUSLOCK
        );
        assert_eq!(get_smpctl_offset(99, 0, n), u32::MAX);
        assert_eq!(get_smpctl_size(n), ctl_size(n));
        assert_eq!(ctl_base_for(64 << 20), (64 << 20) + 0x10000);
    }

    #[test]
    fn doorbell_counts_and_reads() {
        setup(2);
        unsafe {
            assert_eq!(doorbell_read(1), 0);
            assert_eq!(doorbell_post(1), 0);
            assert_eq!(doorbell_post(1), 1);
            assert_eq!(doorbell_read(1), 2);
            // vCPU 0's doorbell is untouched
            assert_eq!(doorbell_read(0), 0);
        }
    }

    #[test]
    fn run_state_and_heartbeat() {
        setup(1);
        unsafe {
            assert_eq!(run_state_read(0), RUN_STATE_RUNNABLE);
            run_state_publish(0, RUN_STATE_PARKED);
            assert_eq!(run_state_read(0), RUN_STATE_PARKED);
            assert_eq!(heartbeat_read(0), 0);
            heartbeat_publish(0);
            heartbeat_publish(0);
            assert_eq!(heartbeat_read(0), 2);
            // heartbeat and run_state share a line but not a word
            assert_eq!(run_state_read(0), RUN_STATE_PARKED);
        }
    }

    #[test]
    fn command_ack_is_conditional() {
        setup(1);
        unsafe {
            command_write(0, COMMAND_PARK_REQ);
            assert!(command_ack(0, COMMAND_PARK_REQ, COMMAND_PARKED_ACK));
            assert_eq!(command_read(0), COMMAND_PARKED_ACK);
            // stale ack fails once the word changed
            command_write(0, COMMAND_TERMINATE);
            assert!(!command_ack(0, COMMAND_PARK_REQ, COMMAND_PARKED_ACK));
            assert_eq!(command_read(0), COMMAND_TERMINATE);
        }
    }

    #[test]
    fn pending_bitmaps_or_and_drain() {
        setup(2);
        unsafe {
            assert_eq!(pending_irr_or(1, 0, 1 << 3), 0);
            assert_eq!(pending_irr_or(1, 0, 1 << 3 | 1 << 7), 1 << 3);
            assert_eq!(pending_irr_or(1, 5, 1 << 31), 0);
            pending_tmr_or(1, 5, 1 << 30);
            assert_eq!(pending_irr_drain(1, 0), 1 << 3 | 1 << 7);
            assert_eq!(pending_irr_drain(1, 0), 0);
            assert_eq!(pending_irr_drain(1, 5), 1 << 31);
            // tmr is independent of irr
            assert_eq!(pending_tmr_drain(1, 5), 1 << 30);
        }
    }

    #[test]
    fn ipi_special_latches_and_takes() {
        setup(1);
        unsafe {
            ipi_special_or(0, IPI_INIT_BIT);
            ipi_special_or(0, IPI_SIPI_BIT | 0x9B << IPI_SIPI_VECTOR_SHIFT);
            let taken = ipi_special_take(0);
            assert_eq!(taken & IPI_INIT_BIT, IPI_INIT_BIT);
            assert_eq!(taken & IPI_SIPI_BIT, IPI_SIPI_BIT);
            assert_eq!(
                (taken & IPI_SIPI_VECTOR_MASK) >> IPI_SIPI_VECTOR_SHIFT,
                0x9B
            );
            assert_eq!(ipi_special_take(0), 0);
        }
    }

    #[test]
    fn mailbox_record_roundtrip() {
        setup(2);
        unsafe {
            assert_eq!(mailbox_addr(1), VCPU_STRIDE + MAILBOX);
            assert_eq!(mailbox_state_load(1), MAILBOX_IDLE);
            mailbox_field_write(1, MAILBOX_OP, 1);
            mailbox_field_write(1, MAILBOX_ADDR, 0xE9);
            mailbox_field_write(1, MAILBOX_SIZE, 4);
            mailbox_field_write(1, MAILBOX_VALUE_LO, 0x1234);
            mailbox_field_write(1, MAILBOX_VALUE_HI, 0);
            mailbox_field_write(1, MAILBOX_SEQ, 7);
            mailbox_state_store(1, MAILBOX_REQUEST);
            assert_eq!(mailbox_state_load(1), MAILBOX_REQUEST);
            assert_eq!(mailbox_field_read(1, MAILBOX_OP), 1);
            assert_eq!(mailbox_field_read(1, MAILBOX_ADDR), 0xE9);
            assert_eq!(mailbox_field_read(1, MAILBOX_VALUE_LO), 0x1234);
            assert_eq!(mailbox_field_read(1, MAILBOX_SEQ), 7);
            mailbox_state_store(1, MAILBOX_IDLE);
            // vCPU 0's record is untouched
            assert_eq!(mailbox_state_load(0), MAILBOX_IDLE);
            assert_eq!(mailbox_field_read(0, MAILBOX_VALUE_LO), 0);
        }
    }

    #[test]
    fn eoi_ring_fifo_full_and_wrap() {
        setup(1);
        unsafe {
            assert_eq!(eoi_ring_pop(0), None);
            for v in 0..EOI_RING_CAP as i32 {
                assert!(eoi_ring_push(0, 0x20 + v));
            }
            assert!(!eoi_ring_push(0, 0x99), "17th push must report full");
            for v in 0..EOI_RING_CAP as i32 {
                assert_eq!(eoi_ring_pop(0), Some(0x20 + v));
            }
            assert_eq!(eoi_ring_pop(0), None);
            // wraparound: 3 * cap interleaved pushes/pops stay FIFO
            for v in 0..(3 * EOI_RING_CAP as i32) {
                assert!(eoi_ring_push(0, v));
                assert_eq!(eoi_ring_pop(0), Some(v));
            }
        }
    }

    #[test]
    fn jit_dirty_ring_fifo() {
        let n = 2;
        setup(n);
        unsafe {
            assert_eq!(jit_dirty_ring_pop(n), None);
            for page in 0..JIT_DIRTY_RING_CAP as i32 {
                assert!(jit_dirty_ring_push(n, 0x100 + page));
            }
            assert!(!jit_dirty_ring_push(n, 0x999), "65th push must report full");
            assert_eq!(jit_dirty_ring_pop(n), Some(0x100));
            assert!(jit_dirty_ring_push(n, 0x999), "space after one pop");
        }
    }

    #[test]
    fn dev_irq_ring_orders_raise_and_lower() {
        let n = 1;
        setup(n);
        unsafe {
            assert_eq!(dev_irq_ring_pop(n), None);
            // a level line's raise/lower/raise sequence must replay in order
            for event in [
                (1 | DEV_IRQ_RAISE_BIT) as i32,
                1,
                (1 | DEV_IRQ_RAISE_BIT) as i32,
                (12 | DEV_IRQ_RAISE_BIT) as i32,
            ] {
                assert!(dev_irq_ring_push(n, event));
            }
            assert_eq!(dev_irq_ring_pop(n), Some((1 | DEV_IRQ_RAISE_BIT) as i32));
            assert_eq!(dev_irq_ring_pop(n), Some(1));
            assert_eq!(dev_irq_ring_pop(n), Some((1 | DEV_IRQ_RAISE_BIT) as i32));
            assert_eq!(dev_irq_ring_pop(n), Some((12 | DEV_IRQ_RAISE_BIT) as i32));
            assert_eq!(dev_irq_ring_pop(n), None);
            // full at capacity, space again after one pop
            for event in 0..DEV_IRQ_RING_CAP as i32 {
                assert!(dev_irq_ring_push(n, event));
            }
            assert!(
                !dev_irq_ring_push(n, 0x77),
                "push past capacity must report full"
            );
            assert_eq!(dev_irq_ring_pop(n), Some(0));
            assert!(dev_irq_ring_push(n, 0x77), "space after one pop");
            // the jit_dirty ring is a distinct region
            assert_eq!(jit_dirty_ring_pop(n), None);
        }
    }

    #[test]
    fn routing_publish_read_and_version() {
        let n = 2;
        setup(n);
        unsafe {
            assert_eq!(routing_version(n), 0);
            routing_publish(n, 1, 1 << 24, 0x0200_0000, -1, 0, 1, 1);
            assert_eq!(routing_version(n), 1);
            assert_eq!(routing_read(n, 1, ROUTING_APIC_ID), 1 << 24);
            assert_eq!(routing_read(n, 1, ROUTING_LDR), 0x0200_0000);
            assert_eq!(routing_read(n, 1, ROUTING_DFR), -1);
            assert_eq!(routing_read(n, 1, ROUTING_ENABLED), 1);
            // entry 0 untouched
            assert_eq!(routing_read(n, 0, ROUTING_APIC_ID), 0);
            routing_publish(n, 1, 1 << 24, 0, -1, 0x40, 1, 0);
            assert_eq!(routing_version(n), 2);
            assert_eq!(routing_read(n, 1, ROUTING_TPR), 0x40);
            assert_eq!(routing_read(n, 1, ROUTING_RUNNABLE), 0);
        }
    }

    #[test]
    fn jit_inbox_push_drain_and_overflow() {
        setup(2);
        unsafe {
            let mut got: Vec<i32> = Vec::new();
            assert!(!jit_inbox_drain(1, |e| got.push(e)));
            assert!(got.is_empty());
            jit_inbox_push(1, 0x100);
            jit_inbox_push(1, (JIT_EVENT_PROTECT_BIT | 0x101) as i32);
            assert!(!jit_inbox_drain(1, |e| got.push(e)));
            assert_eq!(got, vec![0x100, (JIT_EVENT_PROTECT_BIT | 0x101) as i32]);
            // vCPU 0's inbox is untouched
            assert!(!jit_inbox_drain(0, |_| panic!("inbox 0 must be empty")));
            // fill past capacity: overflow is flagged, the flagged drain
            // delivers nothing (clear-all recovery supersedes), later
            // pushes survive
            for e in 0..(JIT_INBOX_CAP as i32 + 5) {
                jit_inbox_push(1, e);
            }
            got.clear();
            assert!(jit_inbox_drain(1, |e| got.push(e)), "overflow must report");
            assert!(got.is_empty(), "overflow drain must deliver nothing");
            jit_inbox_push(1, 7);
            assert!(!jit_inbox_drain(1, |e| got.push(e)));
            assert_eq!(got, vec![7]);
        }
    }

    #[test]
    fn code_bitmaps_are_per_vcpu_and_bounded() {
        let n = 2;
        let ms = 1 << 20; // 1 MB guest RAM -> 256 pages
        install_test_buffer(ctl_total_size(n, ms));
        unsafe {
            assert!(!code_bitmap_any_other(n, 0, ms, 5));
            code_bitmap_set(n, 1, ms, 5);
            assert!(code_bitmap_any_other(n, 0, ms, 5));
            assert!(!code_bitmap_any_other(n, 1, ms, 5), "own bits excluded");
            code_bitmap_clear(n, 1, ms, 5);
            assert!(!code_bitmap_any_other(n, 0, ms, 5));
            code_bitmap_set(n, 1, ms, 255);
            assert!(code_bitmap_any_other(n, 0, ms, 255));
            code_bitmap_clear_all(n, 1, ms);
            assert!(!code_bitmap_any_other(n, 0, ms, 255));
            // out-of-ram pages never set or match
            code_bitmap_set(n, 1, ms, ms >> 12);
            assert!(!code_bitmap_any_other(n, 0, ms, ms >> 12));
        }
    }

    #[test]
    fn pic_pending_insn_and_host_doorbell() {
        let n = 1;
        setup(n);
        unsafe {
            assert_eq!(pic_pending_take(0), 0);
            pic_pending_set(0);
            pic_pending_set(0);
            assert_eq!(pic_pending_take(0), 1, "flag coalesces");
            assert_eq!(pic_pending_take(0), 0, "take consumes");

            assert_eq!(insn_read(0), 0);
            insn_publish(0, 12345);
            assert_eq!(insn_read(0), 12345);

            assert_eq!(host_doorbell_post(n), 0);
            assert_eq!(host_doorbell_post(n), 1);
        }
    }

    #[test]
    fn machine_tsc_and_buslock() {
        let n = 1;
        setup(n);
        unsafe {
            assert_eq!(machine_tsc_offset_read(n), 0);
            machine_tsc_offset_write(n, 0x1122_3344_5566_7788);
            assert_eq!(machine_tsc_offset_read(n), 0x1122_3344_5566_7788);
            machine_tsc_offset_write(n, 5);
            assert_eq!(machine_tsc_offset_read(n), 5);
            machine_tsc_offset_write(n, 0);
            assert_eq!(machine_tsc_offset_read(n), 0);

            assert!(buslock_try_acquire(n));
            assert!(!buslock_try_acquire(n), "second acquire must fail");
            buslock_release(n);
            assert!(buslock_try_acquire(n));
            buslock_release(n);
        }
    }

    #[test]
    fn exclusive_and_busy_cells() {
        let n = 2;
        setup(n);
        unsafe {
            // exclusive cell: CAS-owned, released with store 0
            assert_eq!(exclusive_read(n), 0);
            assert!(exclusive_try_acquire(n, 1));
            assert_eq!(exclusive_read(n), 1);
            assert!(!exclusive_try_acquire(n, 2), "held cell must reject");
            exclusive_release(n);
            assert_eq!(exclusive_read(n), 0);
            assert!(exclusive_try_acquire(n, 2));
            exclusive_release(n);

            // busy cells are per-vCPU and independent of the machine cell
            assert_eq!(excl_busy_read(0), 0);
            excl_busy_set(0);
            assert_eq!(excl_busy_read(0), 1);
            assert_eq!(excl_busy_read(1), 0, "vCPU 1's cell untouched");
            excl_busy_clear(0);
            assert_eq!(excl_busy_read(0), 0);
            // busy cells share the run_state line but not a word
            run_state_publish(0, RUN_STATE_HALTED);
            excl_busy_set(0);
            assert_eq!(run_state_read(0), RUN_STATE_HALTED);
            excl_busy_clear(0);

            // probe export covers the new fields
            assert_eq!(
                get_smpctl_offset(PROBE_EXCL_BUSY, 1, n),
                VCPU_STRIDE + EXCL_BUSY
            );
            assert_eq!(
                get_smpctl_offset(PROBE_MACHINE_EXCLUSIVE, 0, n),
                machine_offset(n) + MACHINE_EXCLUSIVE
            );
        }
    }
}
