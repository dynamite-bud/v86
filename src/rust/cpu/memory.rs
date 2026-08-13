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
            ioapic::read32((addr - IOAPIC_MEM_ADDRESS) & !3) as i32 >> 8 * (addr & 3) & 0xFF
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
            ioapic::read32(addr - IOAPIC_MEM_ADDRESS) as i32
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
        jit::jit_dirty_page(Page::page_of(addr));
        write8_no_mmap_or_dirty_check(addr, value);
    };
}

pub unsafe fn write8_no_mmap_or_dirty_check(addr: u32, value: i32) { gram_write8(addr, value) }

#[no_mangle]
pub unsafe fn write16(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write16(addr, value & 0xFFFF);
    }
    else {
        jit::jit_dirty_cache_small(addr, addr + 2);
        write16_no_mmap_or_dirty_check(addr, value);
    };
}
pub unsafe fn write16_no_mmap_or_dirty_check(addr: u32, value: i32) { gram_write16(addr, value) }

#[no_mangle]
pub unsafe fn write32(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write32(addr, value);
    }
    else {
        jit::jit_dirty_cache_small(addr, addr + 4);
        write32_no_mmap_or_dirty_check(addr, value);
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
        ioapic::write32(addr - IOAPIC_MEM_ADDRESS, value as u32);
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
#[macro_export]
macro_rules! gram_base_tag {
    () => {
        $crate::cpu::memory::mem8 as u32
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
#[macro_export]
macro_rules! gram_read8 {
    ($addr:expr) => {
        *$crate::cpu::memory::mem8.offset(($addr) as isize) as i32
    };
}

#[inline(always)]
pub unsafe fn gram_read8(addr: u32) -> i32 { crate::gram_read8!(addr) }

#[inline(always)]
pub unsafe fn gram_read16(addr: u32) -> i32 {
    ptr::read_unaligned(mem8.offset(addr as isize) as *const u16) as i32
}

#[inline(always)]
pub unsafe fn gram_read32(addr: u32) -> i32 {
    ptr::read_unaligned(mem8.offset(addr as isize) as *const i32)
}

#[inline(always)]
pub unsafe fn gram_read64(addr: u32) -> i64 {
    ptr::read_unaligned(mem8.offset(addr as isize) as *const i64)
}

/// Like `gram_read64`, but `addr` must be 8-byte aligned (keeps the aligned
/// load hint in the generated code).
#[inline(always)]
pub unsafe fn gram_read64_aligned(addr: u32) -> i64 { *(mem8.offset(addr as isize) as *const i64) }

#[inline(always)]
pub unsafe fn gram_read128(addr: u32) -> reg128 {
    ptr::read_unaligned(mem8.offset(addr as isize) as *const reg128)
}

#[inline(always)]
pub unsafe fn gram_write8(addr: u32, value: i32) { *mem8.offset(addr as isize) = value as u8 }

#[inline(always)]
pub unsafe fn gram_write16(addr: u32, value: i32) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut u16, value as u16)
}

#[inline(always)]
pub unsafe fn gram_write32(addr: u32, value: i32) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut i32, value)
}

#[inline(always)]
pub unsafe fn gram_write64(addr: u32, value: u64) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut u64, value)
}

#[inline(always)]
pub unsafe fn gram_write128(addr: u32, value: reg128) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut reg128, value)
}

#[inline(always)]
pub unsafe fn gram_memset(addr: u32, value: u8, count: u32) {
    ptr::write_bytes(mem8.offset(addr as isize), value, count as usize)
}

/// Copy within guest RAM; the ranges may overlap.
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
#[inline(always)]
pub unsafe fn gram_copy_out(src_addr: u32, dst: *mut u8, count: u32) {
    ptr::copy_nonoverlapping(mem8.offset(src_addr as isize), dst, count as usize)
}
