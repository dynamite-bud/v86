// Time-sliced SMP vCPU contexts (XWAH-9 phase 2, see docs/smp-phase2-design.md)
//
// Each vCPU owns a save area for the fixed CPU-state block at linear-memory
// bytes 64..1280. A context switch memcpy-swaps the live block against the
// save areas; compiled JIT code embeds only absolute state offsets, the
// global TLB pointer and shared guest RAM, so it stays valid for whichever
// vCPU is currently swapped in.

use crate::cpu::cpu::CS;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

// The fixed CPU-state block. BLOCK_END must stay in sync with the last field
// declared in global_pointers.rs: fpu_st at 1152, eight 16-byte F80 entries.
// (Pointer constants cannot be cast to integers in const context, so the
// literal is asserted here and tied to global_pointers in the unit tests.)
pub const BLOCK_START: u32 = 64;
pub const BLOCK_END: u32 = 1280;
pub const BLOCK_SIZE: usize = 1216;

const _: () = assert!(BLOCK_END == 1152 + 8 * 16);
const _: () = assert!(BLOCK_SIZE == (BLOCK_END - BLOCK_START) as usize);

// Machine-shared fields inside the block (offset relative to BLOCK_START,
// width in bytes): loading a save area preserves the live values of these
// instead of the saved ones. Kept in sync with global_pointers.rs; asserted
// against it in the unit tests below.
const SHARED_FIELDS: [(usize, usize); 5] = [
    (552 - BLOCK_START as usize, 1), // acpi_enabled: machine config
    (664 - BLOCK_START as usize, 4), // instruction_counter: global monotonic counter
    (716 - BLOCK_START as usize, 4), // svga_dirty_bitmap_min_offset: device-side scratch
    (720 - BLOCK_START as usize, 4), // svga_dirty_bitmap_max_offset: device-side scratch
    (812 - BLOCK_START as usize, 4), // memory_size: machine config
];

// Fields the scheduler reads or patches inside a save area (offset relative
// to BLOCK_START). Derived from global_pointers.rs and the segment register
// indices in cpu.rs; asserted against both in the unit tests below.
// in_hlt: bool @616
const IN_HLT_OFFSET: usize = 616 - BLOCK_START as usize;
// sreg: [u16] @668, entry CS (index 1) — SIPI sets the CS selector
const SREG_CS_OFFSET: usize = 668 - BLOCK_START as usize + 2 * CS as usize;
// segment_offsets: [i32] @736, entry CS — SIPI sets the CS base
const SEGMENT_OFFSETS_CS_OFFSET: usize = 736 - BLOCK_START as usize + 4 * CS as usize;
// instruction_pointer: i32 @556 — SIPI sets IP = 0
const INSTRUCTION_POINTER_OFFSET: usize = 556 - BLOCK_START as usize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RunState {
    Runnable = 0,
    // AP waiting for INIT+SIPI (SeaBIOS bring-up contract)
    WaitForSipi = 1,
    // hlt with IF=0; only an INIT/SIPI or NMI can revive this vCPU
    Parked = 2,
}

// Layout is part of the future JS save/restore contract exposed through
// get_vcpu_state_addr/get_vcpu_state_size; keep in sync with cpu.js once
// that lands (stage 5).
#[repr(C)]
pub struct Vcpu {
    pub save_area: [u8; BLOCK_SIZE],
    pub run_state: RunState,
    pub wake_pending: bool,
    // INIT/SIPI latched by the LAPIC (apic::deliver) and applied by the
    // scheduler at the next slice boundary, where the target is not
    // mid-instruction and no APIC lock is held
    pub pending_init: bool,
    pub pending_sipi: bool,
    pub pending_sipi_vector: u8,
}

const _: () = assert!(std::mem::offset_of!(Vcpu, save_area) == 0);
const _: () = assert!(std::mem::offset_of!(Vcpu, run_state) == BLOCK_SIZE);
const _: () = assert!(std::mem::offset_of!(Vcpu, wake_pending) == BLOCK_SIZE + 1);
const _: () = assert!(std::mem::offset_of!(Vcpu, pending_init) == BLOCK_SIZE + 2);
const _: () = assert!(std::mem::offset_of!(Vcpu, pending_sipi) == BLOCK_SIZE + 3);
const _: () = assert!(std::mem::offset_of!(Vcpu, pending_sipi_vector) == BLOCK_SIZE + 4);
const _: () = assert!(std::mem::size_of::<Vcpu>() == BLOCK_SIZE + 5);

// Sized exactly once by set_smp_cpus and never reallocated afterwards:
// get_vcpu_state_addr hands the buffer address to JavaScript
static VCPUS: Mutex<Vec<Vcpu>> = Mutex::new(Vec::new());
static mut CURRENT: usize = 0;

// Whether a Startup IPI may actually start an AP. Must stay false until the
// firmware CPU counts are un-gated (XWAH-9 stage 4): SeaBIOS rel-1.16.x
// unconditionally broadcasts INIT+SIPI at its AP trampoline (0x10000)
// during POST and, believing CMOS 0x5F advertises no further CPUs, restores
// the trampoline bytes immediately — an AP honoring that SIPI would either
// execute the restored garbage (its slice starts after the BSP's ends) or
// bump SeaBIOS's CountCPUs past the expected value and hang the POST spin
// loop. Real hardware behaves just as badly with such mismatched firmware
// counts, so the SIPI is dropped while the counts are gated.
static AP_STARTUP_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn ap_startup_enabled() -> bool {
    AP_STARTUP_ENABLED.load(Ordering::Relaxed)
}

/// Allow Startup IPIs to start APs; called by JavaScript (cpu.js) when it
/// advertises the real CPU count to the firmware (XWAH-9 stage 4).
#[no_mangle]
pub fn enable_ap_startup() {
    AP_STARTUP_ENABLED.store(true, Ordering::Relaxed)
}

// Copy the live CPU-state block into a save area. Pure over caller-provided
// buffers so native unit tests never touch the real wasm offsets.
fn save_block(block: &[u8; BLOCK_SIZE], save_area: &mut [u8; BLOCK_SIZE]) {
    save_area.copy_from_slice(block);
}

// Load a save area into the live CPU-state block, preserving the
// machine-shared fields from the previously live block. Pure over
// caller-provided buffers so native unit tests never touch the real wasm
// offsets.
fn load_block(save_area: &[u8; BLOCK_SIZE], block: &mut [u8; BLOCK_SIZE]) {
    let mut live = [[0u8; 4]; SHARED_FIELDS.len()];
    for (bytes, &(offset, width)) in live.iter_mut().zip(SHARED_FIELDS.iter()) {
        bytes[..width].copy_from_slice(&block[offset..offset + width]);
    }
    block.copy_from_slice(save_area);
    for (bytes, &(offset, width)) in live.iter().zip(SHARED_FIELDS.iter()) {
        block[offset..offset + width].copy_from_slice(&bytes[..width]);
    }
}

// The real state block in wasm linear memory. Must never be called from
// native unit tests: address 64 is not valid memory in a native process.
unsafe fn live_block() -> &'static mut [u8; BLOCK_SIZE] {
    &mut *(BLOCK_START as *mut [u8; BLOCK_SIZE])
}

/// Size the vCPU table; called exactly once from set_smp_cpus before any
/// switch happens. vCPU 0 (the BSP) starts Runnable, APs wait for INIT+SIPI.
pub fn init(n: usize) {
    dbg_assert!(n >= 1);
    let mut vcpus = VCPUS.try_lock().unwrap();
    dbg_assert!(vcpus.is_empty() || vcpus.len() == n);
    vcpus.clear();
    vcpus.reserve_exact(n);
    for i in 0..n {
        vcpus.push(Vcpu {
            save_area: [0; BLOCK_SIZE],
            run_state: if i == 0 { RunState::Runnable } else { RunState::WaitForSipi },
            wake_pending: false,
            pending_init: false,
            pending_sipi: false,
            pending_sipi_vector: 0,
        });
    }
    unsafe { CURRENT = 0 };
}

/// Switch the live CPU-state block to vCPU i: save the block into the
/// current vCPU's save area, load vCPU i's save area (with shared-field
/// fixups) and make i current. True no-op when i is already current.
///
/// After a real switch the caller is responsible for full_clear_tlb():
/// tlb_data/tlb_code still cache the outgoing vCPU's mappings, and global
/// pages must not survive across vCPUs. Stage 3 wires that into the
/// scheduler; in stage 1 the only caller is reset_cpu, whose
/// reset_vcpu_block flushes anyway.
pub unsafe fn switch_to(i: usize) {
    if i == CURRENT {
        return;
    }
    let mut vcpus = VCPUS.try_lock().unwrap();
    dbg_assert!(i < vcpus.len());
    let block = live_block();
    let current = CURRENT;
    save_block(block, &mut vcpus[current].save_area);
    load_block(&vcpus[i].save_area, block);
    CURRENT = i;
}

/// Mark an interrupt for vCPU i so the scheduler (stage 3) knows a halted
/// vCPU has a reason to wake. Spurious wakes are harmless.
pub fn note_interrupt(i: usize) {
    VCPUS.try_lock().unwrap()[i].wake_pending = true
}

pub fn wake_pending(i: usize) -> bool {
    VCPUS.try_lock().unwrap()[i].wake_pending
}

pub fn clear_wake_pending(i: usize) {
    VCPUS.try_lock().unwrap()[i].wake_pending = false
}

/// Latch an INIT IPI for vCPU i. The scheduler performs the actual reset at
/// the next slice boundary: the target is never running mid-slice, and
/// resetting it there avoids doing so under the APIC lock and
/// mid-instruction of the sending vCPU.
pub fn set_pending_init(i: usize) {
    VCPUS.try_lock().unwrap()[i].pending_init = true
}

pub fn pending_init(i: usize) -> bool {
    VCPUS.try_lock().unwrap()[i].pending_init
}

pub fn take_pending_init(i: usize) -> bool {
    let mut vcpus = VCPUS.try_lock().unwrap();
    std::mem::take(&mut vcpus[i].pending_init)
}

/// Latch a Startup IPI for vCPU i. A second SIPI before the first is
/// consumed overwrites the vector, keeping SeaBIOS's INIT-SIPI-SIPI
/// sequence idempotent.
pub fn set_pending_sipi(i: usize, vector: u8) {
    let mut vcpus = VCPUS.try_lock().unwrap();
    vcpus[i].pending_sipi = true;
    vcpus[i].pending_sipi_vector = vector;
}

pub fn take_pending_sipi(i: usize) -> Option<u8> {
    let mut vcpus = VCPUS.try_lock().unwrap();
    let vcpu = &mut vcpus[i];
    if std::mem::take(&mut vcpu.pending_sipi) {
        Some(vcpu.pending_sipi_vector)
    } else {
        None
    }
}

/// Drop any latched INIT/SIPI: on machine reset a pre-reboot IPI must not
/// leak into the next boot's AP bring-up.
pub fn clear_pending(i: usize) {
    let mut vcpus = VCPUS.try_lock().unwrap();
    vcpus[i].pending_init = false;
    vcpus[i].pending_sipi = false;
    vcpus[i].pending_sipi_vector = 0;
}

/// in_hlt of vCPU i as stored in its save area. Only meaningful for
/// non-current vCPUs; for the current one the live block is authoritative
/// (read *global_pointers::in_hlt instead).
pub fn saved_in_hlt(i: usize) -> bool {
    VCPUS.try_lock().unwrap()[i].save_area[IN_HLT_OFFSET] != 0
}

/// Apply a Startup IPI to vCPU i's save area: real-mode entry at
/// vector<<12 with CS selector vector<<8 and IP 0; everything else keeps
/// the power-on image the preceding INIT reset left behind. The cached
/// state_flags in that image stay valid: still real mode, cpl 0 and
/// non-flat segmentation (SS base 0x300 from reset) whatever the vector.
pub fn apply_sipi(i: usize, vector: u8) {
    dbg_assert!(i != current());
    let mut vcpus = VCPUS.try_lock().unwrap();
    let save_area = &mut vcpus[i].save_area;
    save_area[SREG_CS_OFFSET..SREG_CS_OFFSET + 2]
        .copy_from_slice(&((vector as u16) << 8).to_le_bytes());
    save_area[SEGMENT_OFFSETS_CS_OFFSET..SEGMENT_OFFSETS_CS_OFFSET + 4]
        .copy_from_slice(&((vector as i32) << 12).to_le_bytes());
    save_area[INSTRUCTION_POINTER_OFFSET..INSTRUCTION_POINTER_OFFSET + 4]
        .copy_from_slice(&0i32.to_le_bytes());
}

pub fn current() -> usize {
    unsafe { CURRENT }
}

/// Number of vCPUs; 0 until set_smp_cpus has sized the table.
pub fn count() -> usize {
    VCPUS.try_lock().unwrap().len()
}

pub fn run_state(i: usize) -> RunState {
    VCPUS.try_lock().unwrap()[i].run_state
}

pub fn set_run_state(i: usize, run_state: RunState) {
    VCPUS.try_lock().unwrap()[i].run_state = run_state
}

#[no_mangle]
pub fn get_current_vcpu() -> u32 {
    current() as u32
}

/// Address of the contiguous per-vCPU array (N × Vcpu, save area first in
/// each element) for future JS save/restore. Only stable after set_smp_cpus
/// has sized the table: the Vec allocates once and is never reallocated.
#[no_mangle]
pub fn get_vcpu_state_addr() -> u32 {
    VCPUS.try_lock().unwrap().as_ptr() as u32
}

#[no_mangle]
pub fn get_vcpu_state_size() -> u32 {
    (count() * std::mem::size_of::<Vcpu>()) as u32
}

/// Sync the live block into the current vCPU's save area so the region
/// returned by get_vcpu_state_addr is complete for saving.
#[no_mangle]
pub unsafe fn vcpu_prepare_save() {
    let mut vcpus = VCPUS.try_lock().unwrap();
    if vcpus.is_empty() {
        return;
    }
    let current = CURRENT;
    save_block(live_block(), &mut vcpus[current].save_area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cpu::global_pointers as gp;

    // The tests below share the global VCPUS table (and its non-blocking
    // try_lock accessors), so the stateful ones must not run concurrently
    static STATE_LOCK: Mutex<()> = Mutex::new(());

    fn pseudo_block(seed: u8) -> Box<[u8; BLOCK_SIZE]> {
        let mut block = Box::new([0u8; BLOCK_SIZE]);
        for (i, byte) in block.iter_mut().enumerate() {
            *byte = (i as u8).wrapping_mul(31).wrapping_add(seed);
        }
        block
    }

    fn is_shared_byte(offset: usize) -> bool {
        SHARED_FIELDS
            .iter()
            .any(|&(start, width)| offset >= start && offset < start + width)
    }

    #[test]
    fn block_constants_match_global_pointers() {
        assert_eq!(gp::reg8 as u32, BLOCK_START);
        assert_eq!(gp::fpu_st as u32 + 8 * 16, BLOCK_END);
        let addresses = [
            gp::acpi_enabled as usize,
            gp::instruction_counter as usize,
            gp::svga_dirty_bitmap_min_offset as usize,
            gp::svga_dirty_bitmap_max_offset as usize,
            gp::memory_size as usize,
        ];
        for (&(offset, _), address) in SHARED_FIELDS.iter().zip(addresses) {
            assert_eq!(offset + BLOCK_START as usize, address);
        }
    }

    #[test]
    fn scheduler_offsets_match_global_pointers() {
        let sreg_cs = unsafe { gp::sreg.offset(CS as isize) } as usize;
        let segment_offsets_cs = unsafe { gp::segment_offsets.offset(CS as isize) } as usize;
        assert_eq!(IN_HLT_OFFSET + BLOCK_START as usize, gp::in_hlt as usize);
        assert_eq!(SREG_CS_OFFSET + BLOCK_START as usize, sreg_cs);
        assert_eq!(
            SEGMENT_OFFSETS_CS_OFFSET + BLOCK_START as usize,
            segment_offsets_cs
        );
        assert_eq!(
            INSTRUCTION_POINTER_OFFSET + BLOCK_START as usize,
            gp::instruction_pointer as usize
        );
    }

    #[test]
    fn swap_out_swap_in_is_identity() {
        let mut block = pseudo_block(3);
        let original = block.clone();
        let mut save_area = Box::new([0u8; BLOCK_SIZE]);
        save_block(&block, &mut save_area);
        assert_eq!(save_area[..], original[..]);
        load_block(&save_area, &mut block);
        assert_eq!(block[..], original[..]);
    }

    #[test]
    fn load_preserves_shared_fields_from_live_block() {
        let mut block = pseudo_block(3);
        let live = block.clone();
        let incoming = pseudo_block(101);
        load_block(&incoming, &mut block);
        for offset in 0..BLOCK_SIZE {
            if is_shared_byte(offset) {
                assert_eq!(
                    block[offset], live[offset],
                    "shared byte at offset {}",
                    offset
                );
            } else {
                assert_eq!(
                    block[offset], incoming[offset],
                    "vcpu byte at offset {}",
                    offset
                );
            }
        }
    }

    #[test]
    fn run_state_transitions() {
        let _lock = STATE_LOCK.lock().unwrap();
        init(2);
        assert_eq!(count(), 2);
        assert_eq!(current(), 0);
        assert_eq!(get_current_vcpu(), 0);
        assert_eq!(run_state(0), RunState::Runnable);
        assert_eq!(run_state(1), RunState::WaitForSipi);
        assert_eq!(get_vcpu_state_size(), 2 * (BLOCK_SIZE as u32 + 5));
        assert!(get_vcpu_state_addr() != 0);

        // BSP executes hlt with IF=0, then an interrupt arrives for it
        set_run_state(0, RunState::Parked);
        assert_eq!(run_state(0), RunState::Parked);
        assert!(!wake_pending(0));
        note_interrupt(0);
        assert!(wake_pending(0));
        set_run_state(0, RunState::Runnable);
        clear_wake_pending(0);
        assert!(!wake_pending(0));
        assert_eq!(run_state(0), RunState::Runnable);

        // AP receives SIPI, runs, parks
        set_run_state(1, RunState::Runnable);
        assert_eq!(run_state(1), RunState::Runnable);
        set_run_state(1, RunState::Parked);
        assert_eq!(run_state(1), RunState::Parked);
    }

    #[test]
    fn pending_init_sipi_latches() {
        let _lock = STATE_LOCK.lock().unwrap();
        init(2);

        // AP startup stays gated until stage 4 flips it from cpu.js
        assert!(!ap_startup_enabled());

        // INIT latches once and take consumes it
        assert!(!pending_init(1));
        set_pending_init(1);
        assert!(pending_init(1));
        assert!(take_pending_init(1));
        assert!(!pending_init(1));
        assert!(!take_pending_init(1));

        // SIPI latches the vector; a second SIPI overwrites (idempotent
        // INIT-SIPI-SIPI); take consumes exactly once
        assert_eq!(take_pending_sipi(1), None);
        set_pending_sipi(1, 0x9A);
        set_pending_sipi(1, 0x9B);
        assert_eq!(take_pending_sipi(1), Some(0x9B));
        assert_eq!(take_pending_sipi(1), None);
    }

    #[test]
    fn apply_sipi_patches_save_area() {
        let _lock = STATE_LOCK.lock().unwrap();
        init(2);
        let image = pseudo_block(7);
        VCPUS.try_lock().unwrap()[1]
            .save_area
            .copy_from_slice(&image[..]);

        apply_sipi(1, 0x9A);

        let vcpus = VCPUS.try_lock().unwrap();
        let save_area = &vcpus[1].save_area;
        assert_eq!(
            save_area[SREG_CS_OFFSET..SREG_CS_OFFSET + 2],
            0x9A00u16.to_le_bytes()
        );
        assert_eq!(
            save_area[SEGMENT_OFFSETS_CS_OFFSET..SEGMENT_OFFSETS_CS_OFFSET + 4],
            0x9A000i32.to_le_bytes()
        );
        assert_eq!(
            save_area[INSTRUCTION_POINTER_OFFSET..INSTRUCTION_POINTER_OFFSET + 4],
            0i32.to_le_bytes()
        );
        // every byte outside the three patched fields is untouched
        for offset in 0..BLOCK_SIZE {
            let patched = (SREG_CS_OFFSET..SREG_CS_OFFSET + 2).contains(&offset)
                || (SEGMENT_OFFSETS_CS_OFFSET..SEGMENT_OFFSETS_CS_OFFSET + 4).contains(&offset)
                || (INSTRUCTION_POINTER_OFFSET..INSTRUCTION_POINTER_OFFSET + 4).contains(&offset);
            if !patched {
                assert_eq!(
                    save_area[offset], image[offset],
                    "byte at offset {}",
                    offset
                );
            }
        }
    }
}
