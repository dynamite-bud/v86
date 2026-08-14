// LOCK-prefix atomic lowering for the multimem build (XWAH-9 Phase 4 Stage
// L1, docs/smp-phase4-design.md §5). Only compiled under the
// `guest-ram-import` cargo feature (gated in cpu/mod.rs).
//
// The interpreter's locked RMW chokepoints live here rather than in cpu.rs:
// the default build's artifact must stay byte-identical, and that identity
// extends to the panic-Location records (file/line/column of `unwrap` and
// friends) embedded in the data section — so cpu.rs may not gain or lose a
// single line on the default path. The feature-aware `safe_read_write{8,16,
// 32}` below therefore SHADOW the plain cpu.rs versions at the use sites:
// instructions.rs and instructions_0f.rs (the only callers) import them
// explicitly at the end of each file, which takes precedence over the
// `cpu::cpu::*` glob import. The plain cpu.rs bodies stay untouched (and
// unused under this feature); keep the non-locked arms below in sync with
// them.
//
// Lowering summary (design §5):
// - aligned + non-mmap + non-page-crossing locked target -> CAS loop through
//   gram.wasm's seq-cst cmpxchg (closure re-run against the fresh value
//   after rolling back everything a closure may touch);
// - misaligned / page-crossing / MMIO locked target -> interim bus lock
//   around the historical plain RMW (virt_boundary machinery);
// - XCHG mem (86/87) forces the locked path regardless of prefix;
// - locked CMPXCHG8B on an 8-aligned non-mmap target is a single
//   gram_atomic_rmw_cmpxchg_64 (hooked into instructions_0f.rs by the
//   `cmpxchg8b_prologue!` macro, memory.rs);
// - the page walker's A/D updates become a PRESENT-rechecking cmpxchg loop
//   (`pte_set_accessed_dirty`, hooked in by `write_pte_ad!`, memory.rs).

use crate::cpu::cpu::{
    get_seg, read_reg16, read_reg32, test_privileges_for_io, translate_address_read,
    translate_address_write, translate_address_write_and_can_skip_dirty,
    translate_address_write_jit, virt_boundary_read16, virt_boundary_read32s,
    virt_boundary_write16, virt_boundary_write32, write_reg32, DX, EAX, EBX, ECX, EDI, EDX, ES,
    ESI, FLAG_DIRECTION, FLAG_ZERO, PAGE_TABLE_PRESENT_MASK,
};
use crate::cpu::global_pointers::{
    flags, flags_changed, instruction_pointer, last_op1, last_op_size, last_result, prefixes,
    previous_ip, reg32,
};
use crate::cpu::memory;
use crate::cpu::smpctl;
use crate::jit;
use crate::page::Page;
use crate::prefix;

use core::sync::atomic::{AtomicU32, Ordering};

/// Interim bus-lock cell (Stage L1). Serializes the locked fallback classes
/// (misaligned, page-crossing, MMIO-target LOCK ops) against each other.
/// Outside worker mode no second instance of this module executes, so an
/// **instance-local** cell covers all the traffic that exists — JS-side
/// contenders race via aligned gram atomics on guest cells, which by design
/// ignore the bus lock (the documented split-lock hole of design §5).
static BUS_LOCK: AtomicU32 = AtomicU32::new(0);

/// Worker mode (Stage W2): set once by the vCPU worker runtime
/// (vcpu_worker.js) right after `set_smp_cpus`, before any guest code runs.
/// While set, the bus lock lives in the shared control region
/// (`machine.buslock`, smpctl.rs) instead of the instance-local cell — the
/// region provably exists then, because only worker mode sizes the guest
/// memory with the ctl pages. In topology (c) a single instance executes and
/// either home would do; (b) needs the shared cell, so the mechanism lands
/// with the first worker topology (design §9 W1 deferral note).
static mut WORKER_MODE: bool = false;

#[no_mangle]
pub unsafe fn set_worker_mode(v: u32) { WORKER_MODE = v != 0 }

pub unsafe fn in_worker_mode() -> bool { WORKER_MODE }

/// Acquire the bus lock and fence. Outside worker mode the instance-local
/// compare_exchange can never actually spin (single thread; the bus-locked
/// sections neither re-enter nor unwind), but it is the protocol the
/// control-region cell keeps — and in worker mode the same CAS protocol
/// runs against `machine.buslock` through gram's seq-cst cmpxchg. The fence
/// is gram.wasm's real `atomic.fence`: core::sync::atomic::fence compiles
/// to nothing in this module (built without the wasm atomics target
/// feature, so LLVM drops singlethread fences), which is why ordering must
/// be established inside gram.wasm.
pub unsafe fn bus_lock_acquire() {
    if WORKER_MODE {
        let n = crate::cpu::vcpu::count() as u32;
        while !smpctl::buslock_try_acquire(n) {}
    }
    else {
        while BUS_LOCK
            .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {}
    }
    memory::gram_fence();
}

pub unsafe fn bus_lock_release() {
    memory::gram_fence();
    if WORKER_MODE {
        smpctl::buslock_release(crate::cpu::vcpu::count() as u32);
    }
    else {
        BUS_LOCK.store(0, Ordering::SeqCst);
    }
}

/// CAS-retry snapshot. A locked instruction's closure may read and write
/// GPRs and the lazy-flags machinery (ADC/SBB read CF; XCHG/XADD/CMPXCHG
/// write registers), so re-running it against a fresh memory value is only
/// sound after restoring that state to its pre-instruction contents —
/// design §5's "closure re-execution is idempotent" holds by construction
/// once everything a closure can touch is rolled back.
struct LockRetrySnapshot {
    reg: [i32; 8],
    flags: i32,
    flags_changed: i32,
    last_op1: i32,
    last_result: i32,
    last_op_size: i32,
}

impl LockRetrySnapshot {
    #[inline(always)]
    unsafe fn take() -> LockRetrySnapshot {
        let mut reg = [0; 8];
        for i in 0..8 {
            reg[i] = *reg32.offset(i as isize);
        }
        LockRetrySnapshot {
            reg,
            flags: *flags,
            flags_changed: *flags_changed,
            last_op1: *last_op1,
            last_result: *last_result,
            last_op_size: *last_op_size,
        }
    }
    #[inline(always)]
    unsafe fn restore(&self) {
        for i in 0..8 {
            *reg32.offset(i as isize) = self.reg[i];
        }
        *flags = self.flags;
        *flags_changed = self.flags_changed;
        *last_op1 = self.last_op1;
        *last_result = self.last_result;
        *last_op_size = self.last_op_size;
    }
}

#[inline(always)]
pub unsafe fn safe_read_write8(addr: i32, instruction: &dyn Fn(i32) -> i32) {
    safe_read_write8_impl(addr, instruction, *prefixes & prefix::PREFIX_LOCK != 0)
}

/// Implicitly-locked XCHG mem form (86): locked path regardless of prefix.
#[inline(always)]
pub unsafe fn safe_read_write8_locked(addr: i32, instruction: &dyn Fn(i32) -> i32) {
    safe_read_write8_impl(addr, instruction, true)
}

#[inline(always)]
unsafe fn safe_read_write8_impl(addr: i32, instruction: &dyn Fn(i32) -> i32, locked: bool) {
    let (phys_addr, can_skip_dirty_page) =
        return_on_pagefault!(translate_address_write_and_can_skip_dirty(addr));
    if locked && !memory::in_mapped_range(phys_addr) {
        // a single byte is always naturally aligned and never page-crossing
        if !can_skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        let snapshot = LockRetrySnapshot::take();
        let mut x = memory::read8(phys_addr);
        loop {
            let value = instruction(x);
            dbg_assert!(value >= 0 && value < 0x100);
            let prev = memory::gram_atomic_rmw_cmpxchg_8(phys_addr, x, value);
            if prev == x {
                break;
            }
            x = prev;
            snapshot.restore();
        }
        return;
    }
    if locked {
        // MMIO-target LOCK: the device access itself is main-thread-
        // serialized anyway (design §5); the bus lock still serializes it
        // against the other locked fallback classes.
        bus_lock_acquire();
    }
    let x = memory::read8(phys_addr);
    let value = instruction(x);
    dbg_assert!(value >= 0 && value < 0x100);
    if memory::in_mapped_range(phys_addr) {
        memory::mmap_write8(phys_addr, value);
    }
    else {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        memory::write8_no_mmap_or_dirty_check(phys_addr, value);
    }
    if locked {
        bus_lock_release();
    }
}

#[inline(always)]
pub unsafe fn safe_read_write16(addr: i32, instruction: &dyn Fn(i32) -> i32) {
    safe_read_write16_impl(addr, instruction, *prefixes & prefix::PREFIX_LOCK != 0)
}

/// Implicitly-locked XCHG mem form (87 with operand-size 16).
#[inline(always)]
pub unsafe fn safe_read_write16_locked(addr: i32, instruction: &dyn Fn(i32) -> i32) {
    safe_read_write16_impl(addr, instruction, true)
}

#[inline(always)]
unsafe fn safe_read_write16_impl(addr: i32, instruction: &dyn Fn(i32) -> i32, locked: bool) {
    let (phys_addr, can_skip_dirty_page) =
        return_on_pagefault!(translate_address_write_and_can_skip_dirty(addr));
    if phys_addr & 0xFFF == 0xFFF {
        // page-crossing locked target: interim bus lock around the
        // historical boundary RMW
        let phys_addr_high = return_on_pagefault!(translate_address_write(addr + 1));
        if locked {
            bus_lock_acquire();
        }
        let x = virt_boundary_read16(phys_addr, phys_addr_high);
        virt_boundary_write16(phys_addr, phys_addr_high, instruction(x));
        if locked {
            bus_lock_release();
        }
    }
    else if locked && phys_addr & 1 == 0 && !memory::in_mapped_range(phys_addr) {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        let snapshot = LockRetrySnapshot::take();
        let mut x = memory::read16(phys_addr);
        loop {
            let value = instruction(x);
            dbg_assert!(value >= 0 && value < 0x10000);
            let prev = memory::gram_atomic_rmw_cmpxchg_16(phys_addr, x, value);
            if prev == x {
                break;
            }
            x = prev;
            snapshot.restore();
        }
    }
    else {
        if locked {
            // misaligned or MMIO-target LOCK: interim bus lock
            bus_lock_acquire();
        }
        let x = memory::read16(phys_addr);
        let value = instruction(x);
        dbg_assert!(value >= 0 && value < 0x10000);
        if memory::in_mapped_range(phys_addr) {
            memory::mmap_write16(phys_addr, value);
        }
        else {
            if !can_skip_dirty_page {
                jit::jit_dirty_page(Page::page_of(phys_addr));
            }
            else {
                dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
            }
            memory::write16_no_mmap_or_dirty_check(phys_addr, value);
        };
        if locked {
            bus_lock_release();
        }
    }
}

#[inline(always)]
pub unsafe fn safe_read_write32(addr: i32, instruction: &dyn Fn(i32) -> i32) {
    safe_read_write32_impl(addr, instruction, *prefixes & prefix::PREFIX_LOCK != 0)
}

/// Implicitly-locked XCHG mem form (87 with operand-size 32).
#[inline(always)]
pub unsafe fn safe_read_write32_locked(addr: i32, instruction: &dyn Fn(i32) -> i32) {
    safe_read_write32_impl(addr, instruction, true)
}

#[inline(always)]
unsafe fn safe_read_write32_impl(addr: i32, instruction: &dyn Fn(i32) -> i32, locked: bool) {
    let (phys_addr, can_skip_dirty_page) =
        return_on_pagefault!(translate_address_write_and_can_skip_dirty(addr));
    if phys_addr & 0xFFF >= 0xFFD {
        let phys_addr_high = return_on_pagefault!(translate_address_write(addr + 3 & !3));
        let phys_addr_high = phys_addr_high | (addr as u32) + 3 & 3;
        if locked {
            bus_lock_acquire();
        }
        let x = virt_boundary_read32s(phys_addr, phys_addr_high);
        virt_boundary_write32(phys_addr, phys_addr_high, instruction(x));
        if locked {
            bus_lock_release();
        }
    }
    else if locked && phys_addr & 3 == 0 && !memory::in_mapped_range(phys_addr) {
        if !can_skip_dirty_page {
            jit::jit_dirty_page(Page::page_of(phys_addr));
        }
        else {
            dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
        }
        let snapshot = LockRetrySnapshot::take();
        let mut x = memory::gram_atomic_load_32(phys_addr);
        loop {
            let value = instruction(x);
            let prev = memory::gram_atomic_rmw_cmpxchg_32(phys_addr, x, value);
            if prev == x {
                break;
            }
            x = prev;
            snapshot.restore();
        }
    }
    else {
        if locked {
            // misaligned or MMIO-target LOCK: interim bus lock
            bus_lock_acquire();
        }
        let x = memory::read32s(phys_addr);
        let value = instruction(x);
        if memory::in_mapped_range(phys_addr) {
            memory::mmap_write32(phys_addr, value);
        }
        else {
            if !can_skip_dirty_page {
                jit::jit_dirty_page(Page::page_of(phys_addr));
            }
            else {
                dbg_assert!(!jit::jit_page_has_code(Page::page_of(phys_addr as u32)));
            }
            memory::write32_no_mmap_or_dirty_check(phys_addr, value);
        };
        if locked {
            bus_lock_release();
        }
    }
}

/// Locked-CMPXCHG8B fast/fallback paths, hooked into the top of
/// `instr16_0FC7_1_mem` by the `cmpxchg8b_prologue!` macro (memory.rs)
/// after `writable_or_pagefault(addr, 8)` has succeeded. Returns true when
/// the locked instruction has been fully handled (the caller must return);
/// false for the non-locked case, which falls through to the untouched
/// plain body in instructions_0f.rs.
pub unsafe fn cmpxchg8b_locked(addr: i32) -> bool {
    if *prefixes & prefix::PREFIX_LOCK == 0 {
        return false;
    }
    // in the TLB after writable_or_pagefault: cannot fault
    let phys_addr = translate_address_write(addr).unwrap();
    if phys_addr & 7 == 0 && !memory::in_mapped_range(phys_addr) {
        // 8-aligned within a page: never page-crossing. One seq-cst CAS:
        // EDX:EAX expected, ECX:EBX replacement, ZF = old == expected,
        // EDX:EAX reloaded from the returned old value on mismatch.
        let expected = read_reg32(EAX) as u32 as u64 | (read_reg32(EDX) as u32 as u64) << 32;
        let replacement = read_reg32(EBX) as u32 as u64 | (read_reg32(ECX) as u32 as u64) << 32;
        let old = memory::gram_atomic_rmw_cmpxchg_64(phys_addr, expected, replacement);
        if old == expected {
            jit::jit_dirty_cache_small(phys_addr, phys_addr + 8);
            *flags |= FLAG_ZERO;
        }
        else {
            *flags &= !FLAG_ZERO;
            write_reg32(EAX, old as i32);
            write_reg32(EDX, (old >> 32) as i32);
        }
        *flags_changed &= !FLAG_ZERO;
        return true;
    }
    // misaligned or MMIO target under LOCK: interim bus lock around the
    // plain RMW (duplicates the plain body of instr16_0FC7_1_mem — keep in
    // sync with instructions_0f.rs)
    bus_lock_acquire();
    let m64 = crate::cpu::cpu::safe_read64s(addr).unwrap();
    let m64_low = m64 as i32;
    let m64_high = (m64 >> 32) as i32;
    if read_reg32(EAX) == m64_low && read_reg32(EDX) == m64_high {
        *flags |= FLAG_ZERO;
        crate::cpu::cpu::safe_write64(
            addr,
            read_reg32(EBX) as u32 as u64 | (read_reg32(ECX) as u32 as u64) << 32,
        )
        .unwrap();
    }
    else {
        *flags &= !FLAG_ZERO;
        write_reg32(EAX, m64_low);
        write_reg32(EDX, m64_high);
    }
    *flags_changed &= !FLAG_ZERO;
    bus_lock_release();
    true
}

/// Multimem A/D-bit writer (design §5): sets the accessed/dirty bits of a
/// page-table/directory entry with a seq-cst cmpxchg loop on the entry's
/// low dword that re-checks PRESENT (a concurrently cleared entry must not
/// get A/D set — the SDM's locked-walker semantics, QEMU MTTCG precedent)
/// and retries on any concurrent change. Hooked into do_page_walk's three
/// A/D write sites by the `write_pte_ad!` macro (memory.rs); the default
/// build keeps the historical plain low-byte write there.
///
/// `new_entry` is the caller's already-computed entry-with-A/D-set; only
/// its A/D bits are used (the rest is re-read atomically here). Entry
/// addresses are 4-aligned by construction (masked table bases plus 4/8-
/// scaled indices); PAE entries keep A/D in their low dword.
pub unsafe fn pte_set_accessed_dirty(entry_addr: u32, new_entry: i32) {
    const AD_MASK: i32 =
        crate::cpu::cpu::PAGE_TABLE_ACCESSED_MASK | crate::cpu::cpu::PAGE_TABLE_DIRTY_MASK;
    let set_mask = new_entry & AD_MASK;
    if memory::in_mapped_range(entry_addr) {
        // page tables in device memory: not a real configuration; keep the
        // historical plain byte write (A/D live in the low byte)
        let entry = memory::read32s(entry_addr);
        if entry & PAGE_TABLE_PRESENT_MASK != 0 {
            memory::write8(entry_addr, entry | set_mask);
        }
        return;
    }
    dbg_assert!(entry_addr & 3 == 0);
    let mut entry = memory::gram_atomic_load_32(entry_addr);
    while entry & PAGE_TABLE_PRESENT_MASK != 0 && entry | set_mask != entry {
        let prev = memory::gram_atomic_rmw_cmpxchg_32(entry_addr, entry, entry | set_mask);
        if prev == entry {
            jit::jit_dirty_page(Page::page_of(entry_addr));
            return;
        }
        entry = prev;
    }
}

// ---- XWAH-9 Phase 4 Stage L2: JIT slow-path helpers ----
//
// The locked twins of cpu.rs' safe_read_write*_slow_jit /
// safe_write*_slow_jit pair (the guest-ram-import variants, cpu.rs — keep
// the scratch mechanics in sync). Under LOCK the scratch-page redirection
// alone is non-atomic by design, so:
//
// - an aligned, non-mmap, non-page-crossing target (i.e. a pure TLB fill)
//   returns the real tag with bit 1 CLEAR: the emitted CAS loop
//   (codegen_locked.rs) is what makes that class atomic, exactly like the
//   TLB-hit fast path;
// - every other class (page-crossing, mmap target, misaligned-in-page)
//   ACQUIRES the interim bus lock, fills the scratch pages, and returns
//   the scratch tag with bit 1 SET. The emitted code then runs the closure
//   against scratch and calls safe_write*_locked_slow_jit, which performs
//   the real write and RELEASES the lock — the whole RMW is bracketed by
//   the same bus-lock protocol as the interpreter's fallback above (with
//   the same documented split-lock hole against aligned atomic racers).
//
// Bit 1 is free for the discriminator: all historical tag returns are
// masked & !0xFFF and bit 0 already means "page fault".

unsafe fn locked_read_write_slow_jit(
    addr: i32,
    bitsize: i32,
    eip_and_wasm_table_index: i32,
) -> i32 {
    let wasm_table_index = (eip_and_wasm_table_index >> 16) as u16;
    let eip_offset_in_page = eip_and_wasm_table_index & 0xFFFF;
    dbg_assert!(eip_offset_in_page >= 0 && eip_offset_in_page < 0x1000);
    dbg_assert!(u32::from(wasm_table_index) < jit::WASM_TABLE_SIZE);

    let bytes = bitsize / 8;
    let crosses_page = (addr & 0xFFF) + bytes > 0x1000;
    let addr_low = match translate_address_write_jit(addr, wasm_table_index) {
        Err(()) => {
            *instruction_pointer = *instruction_pointer & !0xFFF | eip_offset_in_page;
            return 1;
        },
        Ok(x) => x,
    };
    if crosses_page {
        let addr_high = match translate_address_write_jit((addr | 0xFFF) + 1, wasm_table_index) {
            Err(()) => {
                *instruction_pointer = *instruction_pointer & !0xFFF | eip_offset_in_page;
                return 1;
            },
            Ok(x) => x,
        };
        // both translations done, nothing can fault below: take the bus
        // lock and fill both scratch halves (same fill as the plain twin)
        bus_lock_acquire();
        let scratch = memory::gram_jit_scratch_base();
        dbg_assert!(scratch & 0xFFF == 0);
        if memory::in_mapped_range(addr_low) {
            for s in addr_low..((addr_low | 0xFFF) + 1) {
                memory::gram_write8(scratch + (s & 0xFFF), memory::read8(s))
            }
        }
        else {
            memory::gram_memcpy(
                addr_low,
                scratch + (addr_low & 0xFFF),
                0x1000 - (addr_low & 0xFFF),
            );
        }
        let high_count = (addr + bytes & 0xFFF) as u32;
        if memory::in_mapped_range(addr_high) {
            for s in addr_high..(addr_high + high_count) {
                memory::gram_write8(scratch + (0x1000 | s & 0xFFF), memory::read8(s))
            }
        }
        else {
            dbg_assert!(addr_high & 0xFFF == 0);
            memory::gram_memcpy(addr_high, scratch + 0x1000, high_count);
        }
        return ((scratch as i32) ^ addr) & !0xFFF | 2;
    }
    if addr & (bytes - 1) == 0 && !memory::in_mapped_range(addr_low) {
        // pure TLB fill: the emitted CAS loop is atomic against the real
        // cell — no bus lock, bit 1 clear
        return (crate::phys_to_tag!(addr_low) as i32 ^ addr) & !0xFFF;
    }
    // misaligned-in-page or mmap target: bus-locked scratch redirection
    bus_lock_acquire();
    let scratch = memory::gram_jit_scratch_base();
    dbg_assert!(scratch & 0xFFF == 0);
    let offset = addr_low & 0xFFF;
    match bitsize {
        64 => memory::gram_write64(scratch + offset, memory::read64s(addr_low) as u64),
        32 => memory::gram_write32(scratch + offset, memory::read32s(addr_low)),
        16 => memory::gram_write16(scratch + offset, memory::read16(addr_low)),
        8 => memory::gram_write8(scratch + offset, memory::read8(addr_low)),
        _ => {
            dbg_assert!(false);
        },
    }
    ((scratch as i32) ^ addr) & !0xFFF | 2
}

#[no_mangle]
pub unsafe fn safe_read_write8_locked_slow_jit(addr: i32, eip_and_wasm_table_index: i32) -> i32 {
    locked_read_write_slow_jit(addr, 8, eip_and_wasm_table_index)
}
#[no_mangle]
pub unsafe fn safe_read_write16_locked_slow_jit(addr: i32, eip_and_wasm_table_index: i32) -> i32 {
    locked_read_write_slow_jit(addr, 16, eip_and_wasm_table_index)
}
#[no_mangle]
pub unsafe fn safe_read_write32s_locked_slow_jit(addr: i32, eip_and_wasm_table_index: i32) -> i32 {
    locked_read_write_slow_jit(addr, 32, eip_and_wasm_table_index)
}
#[no_mangle]
pub unsafe fn safe_read_write64_locked_slow_jit(addr: i32, eip_and_wasm_table_index: i32) -> i32 {
    locked_read_write_slow_jit(addr, 64, eip_and_wasm_table_index)
}

/// Write half of the bus-locked fallback: performs the real write for the
/// scratch-redirected classes and releases the bus lock taken by the read
/// half. Only ever called on that branch (tag bit 1 was set). Translation
/// cannot fault — the read half translated the same address for write
/// within the same instruction — so a non-zero return is a bug, checked by
/// the emitted code in debug builds.
unsafe fn locked_write_slow_jit(
    addr: i32,
    bitsize: i32,
    value: u64,
    eip_and_wasm_table_index: i32,
) -> i32 {
    let wasm_table_index = (eip_and_wasm_table_index >> 16) as u16;
    let eip_offset_in_page = eip_and_wasm_table_index & 0xFFFF;
    dbg_assert!(eip_offset_in_page >= 0 && eip_offset_in_page < 0x1000);
    dbg_assert!(u32::from(wasm_table_index) < jit::WASM_TABLE_SIZE);

    let bytes = bitsize / 8;
    let crosses_page = (addr & 0xFFF) + bytes > 0x1000;
    let addr_low = match translate_address_write_jit(addr, wasm_table_index) {
        Err(()) => {
            dbg_assert!(false);
            bus_lock_release();
            *instruction_pointer = *instruction_pointer & !0xFFF | eip_offset_in_page;
            return 1;
        },
        Ok(x) => x,
    };
    if crosses_page {
        let addr_high = match translate_address_write_jit((addr | 0xFFF) + 1, wasm_table_index) {
            Err(()) => {
                dbg_assert!(false);
                bus_lock_release();
                *instruction_pointer = *instruction_pointer & !0xFFF | eip_offset_in_page;
                return 1;
            },
            Ok(x) => x,
        };
        match bitsize {
            64 => crate::cpu::cpu::safe_write64(addr, value).unwrap(),
            32 => virt_boundary_write32(addr_low, addr_high | (addr as u32) + 3 & 3, value as i32),
            16 => virt_boundary_write16(addr_low, addr_high, value as i32),
            _ => {
                // a single byte never crosses a page
                dbg_assert!(false);
            },
        }
    }
    else if memory::in_mapped_range(addr_low) {
        match bitsize {
            64 => memory::mmap_write64(addr_low, value),
            32 => memory::mmap_write32(addr_low, value as i32),
            16 => memory::mmap_write16(addr_low, (value & 0xFFFF) as i32),
            8 => memory::mmap_write8(addr_low, (value & 0xFF) as i32),
            _ => {
                dbg_assert!(false);
            },
        }
    }
    else {
        // misaligned guest RAM (aligned non-mmap targets take the CAS
        // branch; a byte is always aligned, so 8-bit never gets here).
        // translate_address_write_jit already performed the jitted-page
        // invalidation for this write, matching the plain slow path's
        // final-store contract.
        match bitsize {
            64 => memory::write64_no_mmap_or_dirty_check(addr_low, value),
            32 => memory::write32_no_mmap_or_dirty_check(addr_low, value as i32),
            16 => memory::write16_no_mmap_or_dirty_check(addr_low, (value & 0xFFFF) as i32),
            _ => {
                dbg_assert!(false);
            },
        }
    }
    bus_lock_release();
    0
}

#[no_mangle]
pub unsafe fn safe_write8_locked_slow_jit(
    addr: i32,
    value: u32,
    eip_and_wasm_table_index: i32,
) -> i32 {
    locked_write_slow_jit(addr, 8, value as u64, eip_and_wasm_table_index)
}
#[no_mangle]
pub unsafe fn safe_write16_locked_slow_jit(
    addr: i32,
    value: u32,
    eip_and_wasm_table_index: i32,
) -> i32 {
    locked_write_slow_jit(addr, 16, value as u64, eip_and_wasm_table_index)
}
#[no_mangle]
pub unsafe fn safe_write32_locked_slow_jit(
    addr: i32,
    value: u32,
    eip_and_wasm_table_index: i32,
) -> i32 {
    locked_write_slow_jit(addr, 32, value as u64, eip_and_wasm_table_index)
}
#[no_mangle]
pub unsafe fn safe_write64_locked_slow_jit(
    addr: i32,
    value: u64,
    eip_and_wasm_table_index: i32,
) -> i32 {
    locked_write_slow_jit(addr, 64, value, eip_and_wasm_table_index)
}

// ---- XWAH-9 Phase 4 Stage W2: batched string I/O (topology (c)) ----
//
// Under worker mode every io_port_* env call is a blocking mailbox RPC to
// the device host (~6 µs protocol + wake latency). A guest `rep ins/outs`
// — IDE/ATAPI PIO data above all — issues one port access per element,
// which multiplies that cost by the element count (measured: an ISO boot
// makes ~1.8M io_port_read32 RPCs and blows the W2 boot gate 11×). These
// helpers collapse one page-bounded rep batch into ONE RPC
// (MAILBOX_OP_IN_REP/OUT_REP, smpctl.rs): the device host performs the
// per-element port accesses in exactly the guest's order against the
// shared guest RAM, so device semantics (streaming data ports, status
// transitions, IRQs raised mid-batch) are the same as the per-element
// loop's — only the boundary crossings collapse.
//
// Called from the very ends of the ins/outs rep entry points (string.rs);
// returns false to fall through to the untouched generic string loop.
// Deliberately conservative: 32-bit address size, direction up, aligned,
// non-mmap target, count >= 2 — everything else takes the historical path.

/// One page-bounded `rep ins` batch. True = the instruction (or its page
/// slice, with EIP rewound for re-entry) is fully handled.
pub unsafe fn ins_rep_batched(is_asize_32: bool, size_bytes: i32) -> bool {
    if !WORKER_MODE || !is_asize_32 || *flags & FLAG_DIRECTION != 0 {
        return false;
    }
    let count = read_reg32(ECX) as u32;
    if count < 2 {
        return false;
    }
    let port = read_reg16(DX);
    if !test_privileges_for_io(port, size_bytes) {
        // #GP raised inside the check, like the string_instruction path
        return true;
    }
    let es = match get_seg(ES) {
        Ok(seg) => seg,
        Err(()) => return true,
    };
    let dst = read_reg32(EDI);
    if (es + dst) & (size_bytes - 1) != 0 {
        return false;
    }
    let (phys_dst, skip_dirty_page) = match translate_address_write_and_can_skip_dirty(es + dst) {
        Ok(x) => x,
        Err(()) => return true, // page fault raised
    };
    if memory::in_mapped_range(phys_dst) {
        return false;
    }
    let n = u32::min(count, (0x1000 - (phys_dst & 0xFFF)) / size_bytes as u32);
    if n < 2 {
        return false;
    }
    if !skip_dirty_page {
        jit::jit_dirty_page(Page::page_of(phys_dst));
    }
    // vCPU record 0: topology (c) has exactly one machine worker; (b)
    // parameterizes this by the worker's vCPU index
    let done = smpctl::mailbox_rpc(
        0,
        smpctl::MAILBOX_OP_IN_REP,
        port,
        size_bytes,
        n as i32,
        phys_dst as i32,
    ) as u32;
    dbg_assert!(done == n);
    write_reg32(EDI, dst + (n as i32) * size_bytes);
    write_reg32(ECX, (count - n) as i32);
    if count != n {
        // this batch only covered one page: re-enter the instruction for
        // the rest (the string_instruction fast-path contract)
        *instruction_pointer = *previous_ip;
    }
    true
}

/// One page-bounded `rep outs` batch; the mirror of `ins_rep_batched`.
pub unsafe fn outs_rep_batched(is_asize_32: bool, seg: i32, size_bytes: i32) -> bool {
    if !WORKER_MODE || !is_asize_32 || *flags & FLAG_DIRECTION != 0 {
        return false;
    }
    let count = read_reg32(ECX) as u32;
    if count < 2 {
        return false;
    }
    let port = read_reg16(DX);
    if !test_privileges_for_io(port, size_bytes) {
        return true;
    }
    let ds = match get_seg(seg) {
        Ok(base) => base,
        Err(()) => return true,
    };
    let src = read_reg32(ESI);
    if (ds + src) & (size_bytes - 1) != 0 {
        return false;
    }
    let phys_src = match translate_address_read(ds + src) {
        Ok(x) => x,
        Err(()) => return true,
    };
    if memory::in_mapped_range(phys_src) {
        return false;
    }
    let n = u32::min(count, (0x1000 - (phys_src & 0xFFF)) / size_bytes as u32);
    if n < 2 {
        return false;
    }
    let done = smpctl::mailbox_rpc(
        0,
        smpctl::MAILBOX_OP_OUT_REP,
        port,
        size_bytes,
        n as i32,
        phys_src as i32,
    ) as u32;
    dbg_assert!(done == n);
    write_reg32(ESI, src + (n as i32) * size_bytes);
    write_reg32(ECX, (count - n) as i32);
    if count != n {
        *instruction_pointer = *previous_ip;
    }
    true
}
