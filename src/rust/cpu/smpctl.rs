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
//   per vCPU i at CTL_BASE + i*0x240 (VCPU_STRIDE), offsets within the block:
//     0x000  doorbell       u32    version counter; post = add + notify
//     0x040  run_state_pub  u32    RunState published by the worker
//     0x044  heartbeat      u32    W1 addition: wake counter, same writer as
//                                  run_state_pub (no new false sharing)
//     0x080  command        u32    RUN / PARK_REQ / PARKED_ACK / TERMINATE
//     0x0C0  pending_irr    8xu32  fixed-vector bitmap, atomic-or to post
//     0x100  pending_tmr    8xu32  level-trigger bitmap, same protocol
//     0x140  ipi_special    u32    INIT/SIPI/NMI latch word (or/xchg)
//     0x180  eoi_ring       head u32, tail u32, 16xu32 slots (SPSC)
//     0x200  mailbox        64-byte RPC record, byte-for-byte the
//                           tests/threads/mailbox-protocol.js layout
//                           (u32 indices: STATE, OP, ADDR, SIZE, VALUE_LO,
//                           VALUE_HI, SEQ, rest reserved)
//
//   routing_table at CTL_BASE + n*0x240:
//     0x00   version        u32    bumped on every publish
//     0x40 + i*0x40          entry i: apic_id, ldr, dfr, tpr, enabled,
//                           runnable (u32 each; per-entry cache line — each
//                           worker publishes only its own entry)
//
//   machine at CTL_BASE + n*0x280 + 0x40:
//     0x00   tsc_offset     u64    (cmpxchg_64-based access)
//     0x40   buslock        u32    W1 provides the accessors; the L1
//                                  instance-local cell (cpu/lock.rs) moves
//                                  here in W2, when worker mode guarantees
//                                  the region is actually sized/mapped —
//                                  a plain multimem build has no ctl pages
//     0x80   jit_dirty ring head u32, tail u32, 64xu32 phys pages. W1 ships
//                           the single-producer push; the cross-worker
//                           multi-producer protocol is W3's (design §6)
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

pub const VCPU_STRIDE: u32 = 0x240;

// per-vCPU field offsets (relative to the vCPU's block)
pub const DOORBELL: u32 = 0x000;
pub const RUN_STATE_PUB: u32 = 0x040;
pub const HEARTBEAT: u32 = 0x044;
pub const COMMAND: u32 = 0x080;
pub const PENDING_IRR: u32 = 0x0C0;
pub const PENDING_TMR: u32 = 0x100;
pub const IPI_SPECIAL: u32 = 0x140;
pub const EOI_RING: u32 = 0x180;
pub const MAILBOX: u32 = 0x200;

pub const PENDING_WORDS: u32 = 8;
pub const EOI_RING_CAP: u32 = 16;
pub const MAILBOX_BYTES: u32 = 64;

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

// command[i] values (design §2/§8 quiesce protocol)
pub const COMMAND_RUN: i32 = 0;
pub const COMMAND_PARK_REQ: i32 = 1;
pub const COMMAND_PARKED_ACK: i32 = 2;
pub const COMMAND_TERMINATE: i32 = 3;

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
pub const MACHINE_SIZE: u32 = 0x1C0;

pub const JIT_DIRTY_RING_CAP: u32 = 64;

// ring layout (eoi_ring and jit_dirty ring): head, tail, then the slots
pub const RING_HEAD: u32 = 0x0;
pub const RING_TAIL: u32 = 0x4;
pub const RING_SLOTS: u32 = 0x8;

// 64-byte-alignment and containment asserts over the whole layout
const _: () = assert!(VCPU_STRIDE % CACHE_LINE == 0);
const _: () = assert!(DOORBELL % CACHE_LINE == 0);
const _: () = assert!(RUN_STATE_PUB % CACHE_LINE == 0);
const _: () = assert!(HEARTBEAT == RUN_STATE_PUB + 4); // same writer, same line
const _: () = assert!(COMMAND % CACHE_LINE == 0);
const _: () = assert!(PENDING_IRR % CACHE_LINE == 0);
const _: () = assert!(PENDING_TMR % CACHE_LINE == 0);
const _: () = assert!(PENDING_IRR + 4 * PENDING_WORDS <= PENDING_TMR);
const _: () = assert!(IPI_SPECIAL % CACHE_LINE == 0);
const _: () = assert!(EOI_RING % CACHE_LINE == 0);
const _: () = assert!(EOI_RING + RING_SLOTS + 4 * EOI_RING_CAP <= MAILBOX);
const _: () = assert!(MAILBOX % CACHE_LINE == 0);
const _: () = assert!(MAILBOX + MAILBOX_BYTES <= VCPU_STRIDE);
const _: () = assert!(ROUTING_ENTRY_STRIDE % CACHE_LINE == 0);
const _: () = assert!(MACHINE_BUSLOCK % CACHE_LINE == 0);
const _: () = assert!(MACHINE_JIT_DIRTY_RING % CACHE_LINE == 0);
const _: () = assert!(MACHINE_JIT_DIRTY_RING + RING_SLOTS + 4 * JIT_DIRTY_RING_CAP <= MACHINE_SIZE);
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

/// Total control-region size for n vCPUs.
pub const fn ctl_size(n: u32) -> u32 { machine_offset(n) + MACHINE_SIZE }

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

/// Exported for JS: total control-region size for n vCPUs. The JS mirror
/// (src/browser/smpctl.js) must compute the same value.
#[no_mangle]
pub fn get_smpctl_size(n: u32) -> u32 { ctl_size(n) }

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
            pub fn gram_atomic_rmw_xchg_32(addr: u32, value: i32) -> i32;
        }
    }

    pub unsafe fn load32(addr: u32) -> i32 { memory::gram_atomic_load_32(addr) }
    pub unsafe fn store32(addr: u32, value: i32) { memory::gram_atomic_store_32(addr, value) }
    pub unsafe fn add32(addr: u32, value: i32) -> i32 { ext::gram_atomic_rmw_add_32(addr, value) }
    pub unsafe fn or32(addr: u32, value: i32) -> i32 { ext::gram_atomic_rmw_or_32(addr, value) }
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
                (RUN_STATE_PUB, 8), // + heartbeat
                (COMMAND, 4),
                (PENDING_IRR, 4 * PENDING_WORDS),
                (PENDING_TMR, 4 * PENDING_WORDS),
                (IPI_SPECIAL, 4),
                (EOI_RING, RING_SLOTS + 4 * EOI_RING_CAP),
                (MAILBOX, MAILBOX_BYTES),
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
}
