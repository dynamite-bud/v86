mod ext {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn mmap_read8(addr: u32) -> i32;
        pub fn mmap_read32(addr: u32) -> i32;

        pub fn mmap_write8(addr: u32, value: i32);
        pub fn mmap_write16(addr: u32, value: i32);
        pub fn mmap_write32(addr: u32, value: i32);
        pub fn mmap_write64(addr: u32, v0: i32, v1: i32);
        pub fn mmap_write128(addr: u32, v0: i32, v1: i32, v2: i32, v3: i32);
    }
}

use crate::cpu::apic;
use crate::cpu::cpu::{
    handle_irqs, reg128, APIC_MEM_ADDRESS, APIC_MEM_SIZE, IOAPIC_MEM_ADDRESS, IOAPIC_MEM_SIZE,
};
use crate::cpu::global_pointers::memory_size;
use crate::cpu::ioapic;
use crate::cpu::vga;
use crate::jit;
use crate::page::Page;

use std::alloc;
use std::ptr;

#[allow(non_upper_case_globals)]
pub static mut mem8: *mut u8 = ptr::null_mut();
#[cfg(not(feature = "guest-ram-import"))]
#[no_mangle]
pub fn allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(mem8.is_null());
    };
    dbg_log!("Allocate memory size={}m", size >> 20);
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) as u32 };
    unsafe {
        mem8 = ptr as *mut u8;
    };
    ptr
}

/// Zero a range of guest RAM. Exported to JS, which uses it while creating
/// and restoring guest memory.
#[no_mangle]
pub unsafe fn zero_memory(addr: u32, size: u32) { gram_memset(addr, 0, size); }

#[allow(non_upper_case_globals)]
pub static mut vga_mem8: *mut u8 = ptr::null_mut();
#[allow(non_upper_case_globals)]
pub static mut vga_memory_size: u32 = 0;

#[no_mangle]
pub fn svga_allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(vga_mem8.is_null());
    };
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) };
    dbg_assert!(
        size & (1 << 12 << 6) == 0,
        "size not aligned to dirty_bitmap"
    );
    unsafe {
        vga_mem8 = ptr;
        vga_memory_size = size;
        vga::set_dirty_bitmap_size(size >> 12 >> 6);
    };
    ptr as u32
}

#[no_mangle]
pub fn in_mapped_range(addr: u32) -> bool {
    return addr >= 0xA0000 && addr < 0xC0000 || addr >= unsafe { *memory_size };
}

pub const VGA_LFB_ADDRESS: u32 = 0xE0000000;
pub fn in_svga_lfb(addr: u32) -> bool {
    addr >= VGA_LFB_ADDRESS && addr <= unsafe { VGA_LFB_ADDRESS + (vga_memory_size - 1) }
}

#[no_mangle]
pub fn read8(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe { *vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as i32 }
        }
        else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
            apic::read32((addr - APIC_MEM_ADDRESS) & !3) as i32 >> 8 * (addr & 3) & 0xFF
        }
        else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
            crate::ioapic_mmio_read8_hook!(addr)
        }
        else {
            unsafe { ext::mmap_read8(addr) }
        }
    }
    else {
        read8_no_mmap_check(addr)
    }
}
pub fn read8_no_mmap_check(addr: u32) -> i32 { unsafe { gram_read8(addr) } }

#[no_mangle]
pub fn read16(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe {
                ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const u16)
                    as i32
            }
        }
        else {
            read8(addr) | read8(addr + 1) << 8
        }
    }
    else {
        read16_no_mmap_check(addr)
    }
}
pub fn read16_no_mmap_check(addr: u32) -> i32 { unsafe { gram_read16(addr) } }

#[no_mangle]
pub fn read32s(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe {
                ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const i32)
            } // XXX
        }
        else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
            apic::read32(addr - APIC_MEM_ADDRESS) as i32
        }
        else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
            crate::ioapic_mmio_read32_hook!(addr)
        }
        else {
            unsafe { ext::mmap_read32(addr) }
        }
    }
    else {
        read32_no_mmap_check(addr)
    }
}
pub fn read32_no_mmap_check(addr: u32) -> i32 { unsafe { gram_read32(addr) } }

pub unsafe fn read64s(addr: u32) -> i64 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const i64)
        }
        else {
            read32s(addr) as i64 | (read32s(addr + 4) as i64) << 32
        }
    }
    else {
        gram_read64(addr)
    }
}

pub unsafe fn read128(addr: u32) -> reg128 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const reg128)
        }
        else {
            reg128 {
                i32: [
                    read32s(addr + 0),
                    read32s(addr + 4),
                    read32s(addr + 8),
                    read32s(addr + 12),
                ],
            }
        }
    }
    else {
        gram_read128(addr)
    }
}

#[no_mangle]
pub unsafe fn write8(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write8(addr, value & 0xFF);
    }
    else {
        crate::jit_dirty_page_for_store!(Page::page_of(addr));
        crate::store_then_flush!(write8_no_mmap_or_dirty_check(addr, value));
    };
}

pub unsafe fn write8_no_mmap_or_dirty_check(addr: u32, value: i32) { gram_write8(addr, value) }

#[no_mangle]
pub unsafe fn write16(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write16(addr, value & 0xFFFF);
    }
    else {
        crate::jit_dirty_cache_small_for_store!(addr, addr + 2);
        crate::store_then_flush!(write16_no_mmap_or_dirty_check(addr, value));
    };
}
pub unsafe fn write16_no_mmap_or_dirty_check(addr: u32, value: i32) { gram_write16(addr, value) }

#[no_mangle]
pub unsafe fn write32(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write32(addr, value);
    }
    else {
        crate::jit_dirty_cache_small_for_store!(addr, addr + 4);
        crate::store_then_flush!(write32_no_mmap_or_dirty_check(addr, value));
    }
}

pub unsafe fn write32_no_mmap_or_dirty_check(addr: u32, value: i32) { gram_write32(addr, value) }

pub unsafe fn write64_no_mmap_or_dirty_check(addr: u32, value: u64) { gram_write64(addr, value) }

pub unsafe fn write128_no_mmap_or_dirty_check(addr: u32, value: reg128) {
    gram_write128(addr, value)
}

pub unsafe fn memset_no_mmap_or_dirty_check(addr: u32, value: u8, count: u32) {
    gram_memset(addr, value, count)
}

pub unsafe fn memcpy_no_mmap_or_dirty_check(src_addr: u32, dst_addr: u32, count: u32) {
    dbg_assert!(src_addr < *memory_size);
    dbg_assert!(dst_addr < *memory_size);
    gram_memcpy(src_addr, dst_addr, count)
}

pub unsafe fn memcpy_into_svga_lfb(src_addr: u32, dst_addr: u32, count: u32) {
    dbg_assert!(src_addr < *memory_size);
    dbg_assert!(in_svga_lfb(dst_addr));
    dbg_assert!(Page::page_of(dst_addr) == Page::page_of(dst_addr + count - 1));
    vga::mark_dirty(dst_addr);
    gram_copy_out(
        src_addr,
        vga_mem8.offset((dst_addr - VGA_LFB_ADDRESS) as isize),
        count,
    )
}

pub unsafe fn mmap_write8(addr: u32, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        *vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) = value as u8
    }
    else {
        ext::mmap_write8(addr, value)
    }
}
pub unsafe fn mmap_write16(addr: u32, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut u16,
            value as u16,
        )
    }
    else {
        ext::mmap_write16(addr, value)
    }
}
pub unsafe fn mmap_write32(addr: u32, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut i32,
            value,
        )
    }
    else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
        apic::write32(addr - APIC_MEM_ADDRESS, value as u32);
        handle_irqs();
    }
    else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
        crate::ioapic_mmio_write32_hook!(addr, value);
        handle_irqs();
    }
    else {
        ext::mmap_write32(addr, value)
    }
}
pub unsafe fn mmap_write64(addr: u32, value: u64) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut u64,
            value,
        )
    }
    else {
        ext::mmap_write64(addr, value as i32, (value >> 32) as i32)
    }
}
pub unsafe fn mmap_write128(addr: u32, v0: u64, v1: u64) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut u64,
            v0,
        );
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS + 8) as isize) as *mut u64,
            v1,
        )
    }
    else {
        ext::mmap_write128(
            addr,
            v0 as i32,
            (v0 >> 32) as i32,
            v1 as i32,
            (v1 >> 32) as i32,
        )
    }
}

#[no_mangle]
pub unsafe fn is_memory_zeroed(addr: u32, length: u32) -> bool {
    dbg_assert!(addr % 8 == 0);
    dbg_assert!(length % 8 == 0);
    for i in (addr..addr + length).step_by(8) {
        if gram_read64_aligned(i) != 0 {
            return false;
        }
    }
    return true;
}

// Guest-RAM ("gram") access layer.
//
// Every raw dereference of guest physical memory funnels through the accessors
// below, which name the two backings described in docs/smp-phase3-design.md
// (§4):
//
// - Today (default build): guest RAM is a heap allocation inside the module's
//   own linear memory, based at `mem8` (set by `allocate_memory`). The
//   accessors expand to the historical mem8 pointer arithmetic, so the
//   generated artifact is byte-identical to before their introduction.
// - Stage 4 (`guest-ram-import` cargo feature): guest RAM becomes an imported
//   second wasm memory (shared when cross-origin isolated). The accessors turn
//   into extern imports implemented by gram.wasm, and `gram_base_tag!` returns
//   0, dropping the mem8 addend from TLB entries.
//
// Address forms:
// - "phys": a guest-physical address, 0-based within guest RAM.
// - "tag": the form stored in TLB entries and baked into page-switch
//   constants: phys + `gram_base_tag!()`. Today the base is `mem8`, added in
//   to save an instruction on the fast path of memory accesses (see
//   `do_page_walk` and `gen_get_phys_eip_plus_mem`); under `guest-ram-import`
//   the base becomes 0 and tag == phys.
//
// The accessors used from other modules (cpu.rs, jit.rs, codegen.rs) are
// macros rather than #[inline(always)] functions: a new cross-module function
// reference changes the order in which rustc collects mono items, which
// renumbers symbol disambiguators and flips LLVM's order-sensitive function
// merging — measurably churning the default artifact even though the IR is
// equivalent. Macro expansion keeps the compiler input token-identical to the
// historical arithmetic, so the default build stays byte-identical. The
// macros expand raw (no internal unsafe); call sites provide the unsafe
// context, as the raw expressions did before.

/// The base address that TLB entries and page-switch constants bake into the
/// tag form. Today: `mem8`; under `guest-ram-import`: 0.
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! gram_base_tag {
    () => {
        $crate::cpu::memory::mem8 as u32
    };
}

/// Under `guest-ram-import` guest RAM is its own wasm memory and guest
/// physical addresses are directly valid offsets into it, so the baked base
/// is 0 and tag == phys. `phys_to_tag!`/`tag_to_phys!`/
/// `tag_page_to_phys_page!` reduce to identities through this macro; the
/// optimizer folds the `+ 0`. Routed through an unsafe fn (not a literal) so
/// call sites that wrap the historical `mem8` static access in an unsafe
/// block compile without unused_unsafe warnings in both builds.
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! gram_base_tag {
    () => {
        $crate::cpu::memory::gram_base_tag_value()
    };
}

/// Convert a guest-physical address into the tag form stored in TLB entries.
#[macro_export]
macro_rules! phys_to_tag {
    ($phys:expr) => {
        ($phys) + ($crate::gram_base_tag!())
    };
}

/// Recover a guest-physical address from the tag form stored in TLB entries.
#[macro_export]
macro_rules! tag_to_phys {
    ($tag:expr) => {
        ($tag) - ($crate::gram_base_tag!())
    };
}

/// Recover a guest-physical page number from a tag-form page number
/// (tag >> 12). Relies on `mem8` being page-aligned.
#[macro_export]
macro_rules! tag_page_to_phys_page {
    ($tag_page:expr) => {
        ($tag_page) - ($crate::gram_base_tag!() >> 12)
    };
}

/// Read one byte of guest RAM at a guest-physical address (no mmap or dirty
/// handling). Used by the interpreter's instruction fetch.
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! gram_read8 {
    ($addr:expr) => {
        *$crate::cpu::memory::mem8.offset(($addr) as isize) as i32
    };
}

/// Under `guest-ram-import` the interpreter's fetch calls the imported
/// accessor (implemented by gram.wasm over the guest memory).
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! gram_read8 {
    ($addr:expr) => {
        $crate::cpu::memory::gram_read8(($addr) as u32)
    };
}

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_read8(addr: u32) -> i32 { crate::gram_read8!(addr) }

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_read16(addr: u32) -> i32 {
    ptr::read_unaligned(mem8.offset(addr as isize) as *const u16) as i32
}

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_read32(addr: u32) -> i32 {
    ptr::read_unaligned(mem8.offset(addr as isize) as *const i32)
}

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_read64(addr: u32) -> i64 {
    ptr::read_unaligned(mem8.offset(addr as isize) as *const i64)
}

/// Like `gram_read64`, but `addr` must be 8-byte aligned (keeps the aligned
/// load hint in the generated code).
#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_read64_aligned(addr: u32) -> i64 { *(mem8.offset(addr as isize) as *const i64) }

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_read128(addr: u32) -> reg128 {
    ptr::read_unaligned(mem8.offset(addr as isize) as *const reg128)
}

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_write8(addr: u32, value: i32) { *mem8.offset(addr as isize) = value as u8 }

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_write16(addr: u32, value: i32) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut u16, value as u16)
}

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_write32(addr: u32, value: i32) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut i32, value)
}

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_write64(addr: u32, value: u64) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut u64, value)
}

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_write128(addr: u32, value: reg128) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut reg128, value)
}

#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_memset(addr: u32, value: u8, count: u32) {
    ptr::write_bytes(mem8.offset(addr as isize), value, count as usize)
}

/// Copy within guest RAM; the ranges may overlap.
#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_memcpy(src_addr: u32, dst_addr: u32, count: u32) {
    ptr::copy(
        mem8.offset(src_addr as isize),
        mem8.offset(dst_addr as isize),
        count as usize,
    )
}

/// Copy out of guest RAM into module-local memory (e.g. the vga buffer).
/// Under `guest-ram-import` this becomes a cross-memory `memory.copy`.
#[cfg(not(feature = "guest-ram-import"))]
#[inline(always)]
pub unsafe fn gram_copy_out(src_addr: u32, dst: *mut u8, count: u32) {
    ptr::copy_nonoverlapping(mem8.offset(src_addr as isize), dst, count as usize)
}

// ---- guest-ram-import backing (XWAH-9 Phase 3 Stage 4) ----
//
// Guest RAM is an imported second wasm memory: JS creates it (shared when
// cross-origin isolated), instantiates gram.wasm over it, and merges
// gram.wasm's exports into this module's `env` imports. The accessors below
// are therefore extern imports; guest-physical addresses are 0-based offsets
// into that memory (base offset 0, `gram_base_tag!()` == 0, tag == phys).
// The extern ABI matches gen/generate_gram_wasm.js exactly; see its header
// comment for the authoritative contract (including why read128 is split
// into two read64 calls: stable Rust cannot declare a multivalue return).

#[cfg(feature = "guest-ram-import")]
mod gram_ext {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn gram_read8(addr: u32) -> i32;
        pub fn gram_read16(addr: u32) -> i32;
        pub fn gram_read32(addr: u32) -> i32;
        pub fn gram_read64(addr: u32) -> i64;
        pub fn gram_read64_aligned(addr: u32) -> i64;

        pub fn gram_write8(addr: u32, value: i32);
        pub fn gram_write16(addr: u32, value: i32);
        pub fn gram_write32(addr: u32, value: i32);
        pub fn gram_write64(addr: u32, value: u64);
        pub fn gram_write128(addr: u32, v0: u64, v1: u64);

        pub fn gram_memset(addr: u32, value: i32, count: u32);
        pub fn gram_memcpy(src_addr: u32, dst_addr: u32, count: u32);

        // Atomic accessors (Phase 4 Stage L1, design doc §5): seq-cst wasm
        // atomics executed inside gram.wasm over the guest memory. Addresses
        // must be naturally aligned for the access size or the engine traps
        // — callers (the locked interpreter paths in cpu.rs) split off
        // misaligned/page-crossing targets to the interim bus lock first.
        // RMW ops return the OLD value (zero-extended for the 8-bit forms).
        pub fn gram_atomic_load_32(addr: u32) -> i32;
        #[allow(dead_code)] // consumer lands with the worker stages (W1+)
        pub fn gram_atomic_store_32(addr: u32, value: i32);
        pub fn gram_atomic_rmw_or_8(addr: u32, value: i32) -> i32;
        pub fn gram_atomic_rmw_and_8(addr: u32, value: i32) -> i32;
        pub fn gram_atomic_rmw_xor_8(addr: u32, value: i32) -> i32;
        pub fn gram_atomic_rmw_cmpxchg_8(addr: u32, expected: i32, replacement: i32) -> i32;
        pub fn gram_atomic_rmw_cmpxchg_16(addr: u32, expected: i32, replacement: i32) -> i32;
        pub fn gram_atomic_rmw_cmpxchg_32(addr: u32, expected: i32, replacement: i32) -> i32;
        pub fn gram_atomic_rmw_cmpxchg_64(addr: u32, expected: u64, replacement: u64) -> u64;

        // Real `atomic.fence` (seq-cst). This module is built WITHOUT the
        // wasm atomics target feature (phase-3 design Addendum 2 item 1),
        // where core::sync::atomic::fence lowers to nothing (singlethread
        // fences are dropped), so ordering-bearing fences must execute
        // inside gram.wasm, which is assembled with atomic opcodes.
        pub fn gram_fence();

        // memory.atomic.notify / wait32 (W1+ consumers; see the gram ABI
        // header for the runtime shared-only rule on wait32).
        #[allow(dead_code)]
        pub fn gram_notify(addr: u32, count: i32) -> i32;
        #[allow(dead_code)]
        pub fn gram_wait32(addr: u32, expected: i32, timeout_ns: i64) -> i32;

        // NOT implemented by gram.wasm (a single-memory module over guest
        // RAM cannot address this module's memory): JS provides it as a
        // typed-array copy from the guest memory's buffer into this
        // module's memory at `dst` (Stage 5 wires it in cpu.js; the Stage 4
        // proof harness stubs it the same way). Used by the svga LFB path
        // (memcpy_into_svga_lfb).
        pub fn gram_copy_out(src_addr: u32, dst: *mut u8, count: u32);
    }
}

/// Recorded by `allocate_memory`; doubles as the base of the JIT slow-path
/// scratch pages that live directly after guest RAM (see
/// `gram_jit_scratch_base`).
#[cfg(feature = "guest-ram-import")]
#[allow(non_upper_case_globals)]
static mut gram_size: u32 = 0;

/// Under `guest-ram-import` guest RAM is the imported guest memory, created
/// by JS before this module is instantiated — there is nothing to allocate.
/// Records the size (for `gram_jit_scratch_base`) and returns base offset 0:
/// guest-physical addresses are used as-is in the imported memory.
#[cfg(feature = "guest-ram-import")]
#[no_mangle]
pub fn allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(gram_size == 0);
        gram_size = size;
    }
    dbg_log!(
        "Allocate memory size={}m (imported guest memory)",
        size >> 20
    );
    0
}

/// The tag base under `guest-ram-import`: 0 (tag == phys). An unsafe fn
/// rather than a literal so `gram_base_tag!` call sites that wrap the
/// historical `mem8` static access in unsafe blocks stay warning-free.
#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_base_tag_value() -> u32 { 0 }

/// Guest-physical base of the two JIT slow-path scratch pages, placed
/// directly after guest RAM in the imported guest memory (JS creates the
/// memory one wasm page larger than memory_size). The JIT fast path
/// loads/stores guest memory at tag-form addresses, so the slow-path scratch
/// area the fast path is redirected to (page-crossing and mmap accesses)
/// must itself live in the guest memory — the module-linear
/// `jit_paging_scratch_buffer` is unreachable from a memidx-1 access. The
/// guest never sees this area: addresses >= memory_size are mmap-routed for
/// guest accesses, and only JIT scratch tags point here.
#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_jit_scratch_base() -> u32 {
    dbg_assert!(gram_size != 0);
    gram_size
}

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_read8(addr: u32) -> i32 { gram_ext::gram_read8(addr) }

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_read16(addr: u32) -> i32 { gram_ext::gram_read16(addr) }

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_read32(addr: u32) -> i32 { gram_ext::gram_read32(addr) }

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_read64(addr: u32) -> i64 { gram_ext::gram_read64(addr) }

/// Like `gram_read64`, but `addr` must be 8-byte aligned (gram.wasm's export
/// carries the aligned load hint).
#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_read64_aligned(addr: u32) -> i64 { gram_ext::gram_read64_aligned(addr) }

/// Two read64 calls per the gram ABI: stable Rust cannot declare gram.wasm's
/// multivalue (i64, i64) return, so the 128-bit read is split.
#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_read128(addr: u32) -> reg128 {
    reg128 {
        i64: [gram_ext::gram_read64(addr), gram_ext::gram_read64(addr + 8)],
    }
}

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_write8(addr: u32, value: i32) { gram_ext::gram_write8(addr, value) }

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_write16(addr: u32, value: i32) { gram_ext::gram_write16(addr, value) }

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_write32(addr: u32, value: i32) { gram_ext::gram_write32(addr, value) }

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_write64(addr: u32, value: u64) { gram_ext::gram_write64(addr, value) }

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_write128(addr: u32, value: reg128) {
    gram_ext::gram_write128(addr, value.u64[0], value.u64[1])
}

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_memset(addr: u32, value: u8, count: u32) {
    gram_ext::gram_memset(addr, value as i32, count)
}

/// Copy within guest RAM; the ranges may overlap (gram.wasm uses
/// memory.copy, which has memmove semantics).
#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_memcpy(src_addr: u32, dst_addr: u32, count: u32) {
    gram_ext::gram_memcpy(src_addr, dst_addr, count)
}

/// Copy out of guest RAM into module-local memory (e.g. the vga buffer).
/// Implemented by JS (see the gram_ext extern comment).
#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_copy_out(src_addr: u32, dst: *mut u8, count: u32) {
    gram_ext::gram_copy_out(src_addr, dst, count)
}

// Atomic gram accessors (Phase 4 Stage L1). All seq-cst, naturally-aligned
// only (the engine traps otherwise); RMW forms return the OLD value. See
// the gram_ext extern block for the full contract.

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_atomic_load_32(addr: u32) -> i32 { gram_ext::gram_atomic_load_32(addr) }

#[cfg(feature = "guest-ram-import")]
#[allow(dead_code)] // consumer lands with the worker stages (W1+)
#[inline(always)]
pub unsafe fn gram_atomic_store_32(addr: u32, value: i32) {
    gram_ext::gram_atomic_store_32(addr, value)
}

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_atomic_rmw_or_8(addr: u32, value: i32) -> i32 {
    gram_ext::gram_atomic_rmw_or_8(addr, value)
}

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_atomic_rmw_and_8(addr: u32, value: i32) -> i32 {
    gram_ext::gram_atomic_rmw_and_8(addr, value)
}

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_atomic_rmw_xor_8(addr: u32, value: i32) -> i32 {
    gram_ext::gram_atomic_rmw_xor_8(addr, value)
}

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_atomic_rmw_cmpxchg_8(addr: u32, expected: i32, replacement: i32) -> i32 {
    gram_ext::gram_atomic_rmw_cmpxchg_8(addr, expected, replacement)
}

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_atomic_rmw_cmpxchg_16(addr: u32, expected: i32, replacement: i32) -> i32 {
    gram_ext::gram_atomic_rmw_cmpxchg_16(addr, expected, replacement)
}

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_atomic_rmw_cmpxchg_32(addr: u32, expected: i32, replacement: i32) -> i32 {
    gram_ext::gram_atomic_rmw_cmpxchg_32(addr, expected, replacement)
}

#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_atomic_rmw_cmpxchg_64(addr: u32, expected: u64, replacement: u64) -> u64 {
    gram_ext::gram_atomic_rmw_cmpxchg_64(addr, expected, replacement)
}

/// Seq-cst `atomic.fence`, executed inside gram.wasm (this module's own
/// core::sync::atomic::fence lowers to nothing without the wasm atomics
/// target feature — see the gram_ext comment).
#[cfg(feature = "guest-ram-import")]
#[inline(always)]
pub unsafe fn gram_fence() { gram_ext::gram_fence() }

#[cfg(feature = "guest-ram-import")]
#[allow(dead_code)] // consumer lands with the worker stages (W1+)
#[inline(always)]
pub unsafe fn gram_notify(addr: u32, count: i32) -> i32 { gram_ext::gram_notify(addr, count) }

/// Runtime rule: shared guest memory only (traps on non-shared), from an
/// agent that may block — see the gram ABI header.
#[cfg(feature = "guest-ram-import")]
#[allow(dead_code)] // consumer lands with the worker stages (W1+)
#[inline(always)]
pub unsafe fn gram_wait32(addr: u32, expected: i32, timeout_ns: i64) -> i32 {
    gram_ext::gram_wait32(addr, expected, timeout_ns)
}

// ---- Stage L1 line-neutral hook macros (XWAH-9 Phase 4) ----
//
// These follow the gram accessor macro discipline above: the default arm
// expands to exactly the historical tokens, so the default artifact stays
// byte-identical, and the hook call replaces a single line at the call
// site so the panic-Location records (file/line/column) of the surrounding
// default code do not move either. The feature arm routes into
// cpu::lock (see src/rust/cpu/lock.rs).

/// do_page_walk's A/D write: the default build writes the low byte of the
/// already-computed entry as it always has; the multimem build runs the
/// PRESENT-rechecking cmpxchg loop (design §5).
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! write_pte_ad {
    ($entry_addr:expr, $new_entry:expr) => {
        memory::write8($entry_addr, $new_entry)
    };
}

#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! write_pte_ad {
    ($entry_addr:expr, $new_entry:expr) => {
        $crate::cpu::lock::pte_set_accessed_dirty($entry_addr, $new_entry)
    };
}

/// The first statement of `instr16_0FC7_1_mem` (CMPXCHG8B): the default
/// build keeps the historical writability check; the multimem build
/// additionally dispatches LOCKed executions to cpu::lock::cmpxchg8b_locked
/// (single gram cmpxchg_64 when 8-aligned and non-mmap, interim bus lock
/// otherwise), returning early when handled.
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! cmpxchg8b_prologue {
    ($addr:expr) => {
        return_on_pagefault!(writable_or_pagefault($addr, 8))
    };
}

#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! cmpxchg8b_prologue {
    ($addr:expr) => {
        return_on_pagefault!(writable_or_pagefault($addr, 8));
        if $crate::cpu::lock::cmpxchg8b_locked($addr) {
            return;
        }
    };
}

// ---- XWAH-9 Phase 4 Stage W3: IOAPIC MMIO forwarding seams ----
//
// In a per-vCPU worker (topology (b)) the IOAPIC lives on the device
// host's instance, so the 0xFEC00000 window forwards as an ordinary mmap
// RPC (design §4: cold, setup-time) — the env import reaches the device
// host, whose read8/read32s/write32 exports run this same intercept on
// the main instance's authoritative IOAPIC. Every other role keeps the
// local intercept. Each hook replaces exactly one line at its call site.

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! ioapic_mmio_read8_hook {
    ($addr:expr) => {
        ioapic::read32(($addr - IOAPIC_MEM_ADDRESS) & !3) as i32 >> 8 * ($addr & 3) & 0xFF
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! ioapic_mmio_read8_hook {
    ($addr:expr) => {
        if $crate::cpu::worker::in_vcpu_worker() {
            unsafe { ext::mmap_read8($addr) }
        }
        else {
            ioapic::read32(($addr - IOAPIC_MEM_ADDRESS) & !3) as i32 >> 8 * ($addr & 3) & 0xFF
        }
    };
}

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! ioapic_mmio_read32_hook {
    ($addr:expr) => {
        ioapic::read32($addr - IOAPIC_MEM_ADDRESS) as i32
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! ioapic_mmio_read32_hook {
    ($addr:expr) => {
        if $crate::cpu::worker::in_vcpu_worker() {
            unsafe { ext::mmap_read32($addr) }
        }
        else {
            ioapic::read32($addr - IOAPIC_MEM_ADDRESS) as i32
        }
    };
}

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! ioapic_mmio_write32_hook {
    ($addr:expr, $value:expr) => {
        ioapic::write32($addr - IOAPIC_MEM_ADDRESS, $value as u32)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! ioapic_mmio_write32_hook {
    ($addr:expr, $value:expr) => {
        if $crate::cpu::worker::in_vcpu_worker() {
            unsafe { ext::mmap_write32($addr, $value) }
        }
        else {
            ioapic::write32($addr - IOAPIC_MEM_ADDRESS, $value as u32)
        }
    };
}
