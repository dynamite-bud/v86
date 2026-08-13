// Time-sliced SMP vCPU contexts (XWAH-9 phase 2, see docs/smp-phase2-design.md)
//
// Each vCPU owns a save area for the fixed CPU-state block at linear-memory
// bytes 64..1280. A context switch memcpy-swaps the live block against the
// save areas; compiled JIT code embeds only absolute state offsets, the
// global TLB pointer and shared guest RAM, so it stays valid for whichever
// vCPU is currently swapped in.

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
}

const _: () = assert!(std::mem::offset_of!(Vcpu, save_area) == 0);
const _: () = assert!(std::mem::offset_of!(Vcpu, run_state) == BLOCK_SIZE);
const _: () = assert!(std::mem::offset_of!(Vcpu, wake_pending) == BLOCK_SIZE + 1);
const _: () = assert!(std::mem::size_of::<Vcpu>() == BLOCK_SIZE + 2);

// Sized exactly once by set_smp_cpus and never reallocated afterwards:
// get_vcpu_state_addr hands the buffer address to JavaScript
static VCPUS: Mutex<Vec<Vcpu>> = Mutex::new(Vec::new());
static mut CURRENT: usize = 0;

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
pub fn note_interrupt(i: usize) { VCPUS.try_lock().unwrap()[i].wake_pending = true }

pub fn wake_pending(i: usize) -> bool { VCPUS.try_lock().unwrap()[i].wake_pending }

pub fn clear_wake_pending(i: usize) { VCPUS.try_lock().unwrap()[i].wake_pending = false }

pub fn current() -> usize { unsafe { CURRENT } }

/// Number of vCPUs; 0 until set_smp_cpus has sized the table.
pub fn count() -> usize { VCPUS.try_lock().unwrap().len() }

pub fn run_state(i: usize) -> RunState { VCPUS.try_lock().unwrap()[i].run_state }

pub fn set_run_state(i: usize, run_state: RunState) {
    VCPUS.try_lock().unwrap()[i].run_state = run_state
}

#[no_mangle]
pub fn get_current_vcpu() -> u32 { current() as u32 }

/// Address of the contiguous per-vCPU array (N × Vcpu, save area first in
/// each element) for future JS save/restore. Only stable after set_smp_cpus
/// has sized the table: the Vec allocates once and is never reallocated.
#[no_mangle]
pub fn get_vcpu_state_addr() -> u32 { VCPUS.try_lock().unwrap().as_ptr() as u32 }

#[no_mangle]
pub fn get_vcpu_state_size() -> u32 { (count() * std::mem::size_of::<Vcpu>()) as u32 }

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
            }
            else {
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
        init(2);
        assert_eq!(count(), 2);
        assert_eq!(current(), 0);
        assert_eq!(get_current_vcpu(), 0);
        assert_eq!(run_state(0), RunState::Runnable);
        assert_eq!(run_state(1), RunState::WaitForSipi);
        assert_eq!(get_vcpu_state_size(), 2 * (BLOCK_SIZE as u32 + 2));
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
}
