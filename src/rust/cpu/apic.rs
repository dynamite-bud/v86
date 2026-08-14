// See Intel's System Programming Guide

use crate::cpu::{cpu::js, global_pointers::acpi_enabled, ioapic, vcpu};
use std::sync::{Mutex, MutexGuard};

const APIC_LOG_VERBOSE: bool = false;

// should probably be kept in sync with TSC_RATE in cpu.rs
const APIC_TIMER_FREQ: f64 = 1.0 * 1000.0 * 1000.0;

const APIC_TIMER_MODE_MASK: u32 = 3 << 17;

const APIC_TIMER_MODE_ONE_SHOT: u32 = 0;
const APIC_TIMER_MODE_PERIODIC: u32 = 1 << 17;

const _APIC_TIMER_MODE_TSC: u32 = 2 << 17;

const DELIVERY_MODES: [&str; 8] = [
    "Fixed (0)",
    "Lowest Prio (1)",
    "SMI (2)",
    "Reserved (3)",
    "NMI (4)",
    "INIT (5)",
    "Startup (6)",
    "ExtINT (7)",
];

const DESTINATION_MODES: [&str; 2] = ["physical", "logical"];

const DESTINATION_MODE_PHYSICAL: u8 = 0;

// In physical destination mode, destination 0xFF addresses all LAPICs
const DESTINATION_BROADCAST: u8 = 0xFF;

const IOAPIC_CONFIG_MASKED: u32 = 0x10000;

const IOAPIC_DELIVERY_INIT: u8 = 5;
const IOAPIC_DELIVERY_NMI: u8 = 4;
const IOAPIC_DELIVERY_FIXED: u8 = 0;
const IOAPIC_DELIVERY_LOWEST_PRIORITY: u8 = 1;

// Startup IPI (SIPI); exists only in the ICR, not in IOAPIC redirection entries
const APIC_DELIVERY_STARTUP: u8 = 6;

// keep in sync with cpu.js
#[allow(dead_code)]
const APIC_STRUCT_SIZE: usize = 4 * 46;

// Note: JavaScript (cpu.get_state_apic) depens on this layout
const _: () = assert!(std::mem::offset_of!(Apic, timer_last_tick) == 6 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, lvt_timer) == 8 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, lvt_perf_counter) == 9 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, icr0) == 14 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, icr1) == 15 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, irr) == 16 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, isr) == 24 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, tmr) == 32 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, spurious_vector) == 40 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, lvt_thermal_sensor) == 45 * 4);
const _: () = assert!(std::mem::size_of::<Apic>() == APIC_STRUCT_SIZE);
#[repr(C)]
pub struct Apic {
    apic_id: u32,
    timer_divider: u32,
    timer_divider_shift: u32,
    timer_initial_count: u32,
    timer_current_count: u32,
    timer_last_tick: f64,
    lvt_timer: u32,
    lvt_perf_counter: u32,
    lvt_int0: u32,
    lvt_int1: u32,
    lvt_error: u32,
    tpr: u32,
    icr0: u32,
    icr1: u32,
    irr: [u32; 8],
    isr: [u32; 8],
    tmr: [u32; 8],
    spurious_vector: u32,
    destination_format: u32,
    local_destination: u32,
    error: u32,
    read_error: u32,
    lvt_thermal_sensor: u32,
}

// Power-on register values (Intel SDM vol. 3A, "Local APIC State After
// Power-Up or Reset"); also applied on guest reboot via reset()
const APIC_RESET_STATE: Apic = Apic {
    apic_id: 0,
    timer_divider: 0,
    timer_divider_shift: 1,
    timer_initial_count: 0,
    timer_current_count: 0,
    timer_last_tick: 0.0,
    lvt_timer: IOAPIC_CONFIG_MASKED,
    lvt_thermal_sensor: IOAPIC_CONFIG_MASKED,
    lvt_perf_counter: IOAPIC_CONFIG_MASKED,
    lvt_int0: IOAPIC_CONFIG_MASKED,
    lvt_int1: IOAPIC_CONFIG_MASKED,
    lvt_error: IOAPIC_CONFIG_MASKED,
    tpr: 0,
    icr0: 0,
    icr1: 0,
    irr: [0; 8],
    isr: [0; 8],
    tmr: [0; 8],
    spurious_vector: 0xFE,
    destination_format: !0,
    local_destination: 0,
    error: 0,
    read_error: 0,
};

// One LAPIC context per vCPU (XWAH-9 phase 2). Sized exactly once by init()
// from set_smp_cpus and never reallocated afterwards: get_apic_addr hands the
// buffer address to JavaScript
static APICS: Mutex<Vec<Apic>> = Mutex::new(Vec::new());

// Power-on state of LAPIC i; the APIC ID lives in bits 31:24 of the ID
// register
fn reset_state(i: usize) -> Apic {
    Apic {
        apic_id: (i as u32) << 24,
        ..APIC_RESET_STATE
    }
}

/// Size the LAPIC table; called exactly once from set_smp_cpus, next to
/// vcpu::init.
pub fn init(n: usize) {
    dbg_assert!(n >= 1);
    let mut apics = APICS.try_lock().unwrap();
    dbg_assert!(apics.is_empty() || apics.len() == n);
    apics.clear();
    apics.reserve_exact(n);
    for i in 0..n {
        apics.push(reset_state(i));
    }
}

pub fn reset() {
    let mut apics = get_apics();
    for (i, apic) in apics.iter_mut().enumerate() {
        *apic = reset_state(i);
    }
}

/// All LAPIC contexts, one per vCPU. Before set_smp_cpus has sized the table
/// this falls back to a single implicit context (mirroring vcpu.rs's count==0
/// fallback), so MMIO, timer and irq paths never panic.
pub fn get_apics() -> MutexGuard<'static, Vec<Apic>> {
    let mut apics = APICS.try_lock().unwrap();
    if apics.is_empty() {
        apics.push(reset_state(0));
    }
    apics
}

// The current vCPU's LAPIC index: the 0xFEE00000 MMIO window and interrupt
// acknowledgement are per-CPU-local like on real hardware
fn current(apics: &[Apic]) -> usize {
    let i = vcpu::current();
    dbg_assert!(i < apics.len());
    if i < apics.len() {
        i
    }
    else {
        0
    }
}

/// Base of the contiguous LAPIC array (smp_cpus × Apic structs) for
/// JavaScript save/restore. Only stable after set_smp_cpus has sized the
/// table: the Vec allocates once and is never reallocated.
#[no_mangle]
pub fn get_apic_addr() -> u32 { get_apics().as_ptr() as u32 }

/// Reset LAPIC i to power-on state: per the SDM, an INIT returns the LAPIC
/// to its power-up state except the APIC ID (reset_state re-derives the ID
/// from i). Locks the APIC table internally so the caller
/// (process_pending_init_sipi) stays lock-free.
pub fn reset_one(i: usize) {
    let mut apics = get_apics();
    dbg_assert!(i < apics.len());
    if i < apics.len() {
        apics[i] = reset_state(i);
    }
}

/// Reset every LAPIC except vCPU 0's to power-on state; used by JavaScript
/// (cpu.set_state_apic) when restoring a single-LAPIC state image into a
/// machine with more than one vCPU.
#[no_mangle]
pub fn reset_secondary_apics() {
    let mut apics = get_apics();
    for i in 1..apics.len() {
        apics[i] = reset_state(i);
    }
}

pub fn read32(addr: u32) -> u32 {
    if unsafe { !*acpi_enabled } {
        return 0;
    }
    let mut apics = get_apics();
    let current = current(&apics);
    read32_internal(&mut apics[current], addr)
}

fn read32_internal(apic: &mut Apic, addr: u32) -> u32 {
    match addr {
        0x20 => {
            dbg_log!("APIC read id");
            apic.apic_id
        },

        0x30 => {
            // version
            dbg_log!("APIC read version");
            0x50014
        },

        0x80 => {
            if APIC_LOG_VERBOSE {
                dbg_log!("APIC read tpr");
            }
            apic.tpr
        },

        0xB0 => {
            // write-only (written by DSL)
            if APIC_LOG_VERBOSE {
                dbg_log!("APIC read eoi register");
            }
            0
        },

        0xD0 => {
            dbg_log!("Read local destination");
            apic.local_destination
        },

        0xE0 => {
            dbg_log!("Read destination format");
            apic.destination_format
        },

        0xF0 => apic.spurious_vector,

        0x100 | 0x110 | 0x120 | 0x130 | 0x140 | 0x150 | 0x160 | 0x170 => {
            let index = ((addr - 0x100) >> 4) as usize;
            dbg_log!("Read isr {}: {:08x}", index, apic.isr[index] as u32);
            apic.isr[index]
        },

        0x180 | 0x190 | 0x1A0 | 0x1B0 | 0x1C0 | 0x1D0 | 0x1E0 | 0x1F0 => {
            let index = ((addr - 0x180) >> 4) as usize;
            dbg_log!("Read tmr {}: {:08x}", index, apic.tmr[index] as u32);
            apic.tmr[index]
        },

        0x200 | 0x210 | 0x220 | 0x230 | 0x240 | 0x250 | 0x260 | 0x270 => {
            let index = ((addr - 0x200) >> 4) as usize;
            dbg_log!("Read irr {}: {:08x}", index, apic.irr[index] as u32);
            apic.irr[index]
        },

        0x280 => {
            dbg_log!("Read error: {:08x}", apic.read_error);
            apic.read_error
        },

        0x300 => {
            if APIC_LOG_VERBOSE {
                dbg_log!("APIC read icr0");
            }
            apic.icr0
        },

        0x310 => {
            dbg_log!("APIC read icr1");
            apic.icr1
        },

        0x320 => {
            if APIC_LOG_VERBOSE {
                dbg_log!("read timer lvt");
            }
            apic.lvt_timer
        },

        0x330 => {
            dbg_log!("read lvt thermal sensor");
            apic.lvt_thermal_sensor
        },

        0x340 => {
            dbg_log!("read lvt perf counter");
            apic.lvt_perf_counter
        },

        0x350 => {
            dbg_log!("read lvt int0");
            apic.lvt_int0
        },

        0x360 => {
            dbg_log!("read lvt int1");
            apic.lvt_int1
        },

        0x370 => {
            dbg_log!("read lvt error");
            apic.lvt_error
        },

        0x3E0 => {
            // divider
            dbg_log!("read timer divider");
            apic.timer_divider
        },

        0x380 => {
            dbg_log!("read timer initial count");
            apic.timer_initial_count
        },

        0x390 => {
            let now = unsafe { js::microtick() };
            if apic.timer_last_tick > now {
                // should only happen after restore_state
                dbg_log!("warning: APIC last_tick is in the future, resetting");
                apic.timer_last_tick = now;
            }
            let diff = now - apic.timer_last_tick;
            let diff_in_ticks = diff * APIC_TIMER_FREQ / (1 << apic.timer_divider_shift) as f64;
            dbg_assert!(diff_in_ticks >= 0.0);
            let diff_in_ticks = diff_in_ticks as u64;
            let result = if diff_in_ticks < apic.timer_initial_count as u64 {
                apic.timer_initial_count - diff_in_ticks as u32
            }
            else {
                let mode = apic.lvt_timer & APIC_TIMER_MODE_MASK;
                if mode == APIC_TIMER_MODE_PERIODIC {
                    apic.timer_initial_count
                        - (diff_in_ticks % (apic.timer_initial_count as u64 + 1)) as u32
                }
                else if mode == APIC_TIMER_MODE_ONE_SHOT {
                    0
                }
                else {
                    dbg_assert!(false, "apic unimplemented timer mode: {:x}", mode);
                    0
                }
            };
            if APIC_LOG_VERBOSE {
                dbg_log!("read timer current count: {}", result);
            }
            result
        },

        _ => {
            dbg_log!("APIC read {:x}", addr);
            dbg_assert!(false);
            0
        },
    }
}

pub fn write32(addr: u32, value: u32) {
    if unsafe { !*acpi_enabled } {
        return;
    }
    let mut apics = get_apics();
    let current = current(&apics);
    match addr {
        // EOI, ICR and the routing registers (APIC ID, LDR, DFR) involve
        // LAPICs beyond the current vCPU's own
        0xB0 => write_eoi(&mut apics, current, value),
        0x20 | 0xD0 | 0xE0 => write_routing_register(&mut apics, current, addr, value),
        0x300 => crate::apic_icr0_hook!(&mut apics, current, value),
        _ => write32_internal(&mut apics[current], addr, value),
    }
}

// APIC ID, LDR and DFR writes change which interrupts this LAPIC accepts:
// IOAPIC lines held asserted that found no matching destination before (and
// thus never latched remote IRR) must be re-evaluated, or they stay wedged
// until the guest rewrites the redirection entry
fn write_routing_register(apics: &mut [Apic], current: usize, addr: u32, value: u32) {
    match addr {
        0x20 => {
            // the APIC ID lives in bits 31:24; the register stores the raw value
            dbg_log!("APIC write id: {:08x} (apic id {:02x})", value, value >> 24);
            apics[current].apic_id = value;
        },
        0xD0 => {
            dbg_log!("Set local destination: {:08x}", value);
            apics[current].local_destination = value & 0xFF000000;
        },
        0xE0 => {
            dbg_log!("Set destination format: {:08x}", value);
            apics[current].destination_format = value | 0xFFFFFF;
        },
        _ => dbg_assert!(false),
    }
    crate::apic_routing_changed_hook!(apics, current);
}

// EOI is per-CPU: it retires the highest in-service vector of the current
// LAPIC; a level-triggered vector additionally sends an EOI to the IOAPIC,
// whose re-evaluation may deliver into any LAPIC
fn write_eoi(apics: &mut [Apic], current: usize, value: u32) {
    let apic = &mut apics[current];
    if let Some(highest_isr) = highest_isr(apic) {
        if APIC_LOG_VERBOSE {
            dbg_log!("eoi: {:08x} for vector {:x}", value, highest_isr);
        }
        register_clear_bit(&mut apic.isr, highest_isr);
        if register_get_bit(&apic.tmr, highest_isr) {
            // Send eoi to all IO APICs
            crate::apic_remote_eoi_hook!(apics, highest_isr);
        }
    }
    else {
        dbg_log!("Bad eoi: No isr set");
    }
}

fn write_icr0(apics: &mut [Apic], current: usize, value: u32) {
    let vector = (value & 0xFF) as u8;
    let delivery_mode = ((value >> 8) & 7) as u8;
    let destination_mode = ((value >> 11) & 1) as u8;
    // ICR bit 14 is the level-assert flag, bit 15 the trigger mode
    let is_assert = value & 1 << 14 != 0;
    let is_level = value & ioapic::IOAPIC_CONFIG_TRIGGER_MODE_LEVEL
        == ioapic::IOAPIC_CONFIG_TRIGGER_MODE_LEVEL;
    let destination_shorthand = (value >> 18) & 3;
    let destination = (apics[current].icr1 >> 24) as u8;
    dbg_log!(
        "APIC write icr0: {:08x} vector={:02x} destination_mode={} delivery_mode={} destination_shorthand={}",
        value,
        vector,
        DESTINATION_MODES[destination_mode as usize],
        DELIVERY_MODES[delivery_mode as usize],
        ["no", "self", "all with self", "all without self"][destination_shorthand as usize]
    );

    let mut value = value;
    value &= !(1 << 12);
    apics[current].icr0 = value;

    if delivery_mode == IOAPIC_DELIVERY_INIT && is_level && !is_assert {
        // INIT-deassert (level-triggered INIT with the assert bit clear): a
        // historical message that synchronized xAPIC arbitration IDs; Linux
        // still broadcasts it after INIT-assert. Explicitly ignored — it must
        // not act as a second reset of the target once INIT gains its
        // stage-3 AP-startup state machine.
        dbg_log!("APIC: INIT-deassert IPI ignored");
        return;
    }

    if destination_shorthand == 0 {
        // no shorthand
        route(
            apics,
            vector,
            delivery_mode,
            is_level,
            destination,
            destination_mode,
        );
    }
    else if destination_shorthand == 1 {
        // self: same mode dispatch as the other shorthands, so INIT/SIPI/NMI
        // to self take the intended ignore paths instead of tripping the
        // fixed-delivery vector assert
        deliver(
            &mut apics[current],
            current,
            vector,
            delivery_mode,
            is_level,
        );
    }
    else if destination_shorthand == 2 || destination_shorthand == 3 {
        // 2: all including self; 3: all excluding self (SeaBIOS boots APs
        // with INIT then SIPI broadcast in this shorthand)
        let is_candidate = |i: usize| destination_shorthand == 2 || i != current;
        if delivery_mode == IOAPIC_DELIVERY_LOWEST_PRIORITY {
            // broadcast shorthands arbitrate like route(): exactly one of
            // the candidates receives a lowest-priority interrupt
            if let Some(i) = arbitrate_lowest_priority(apics, is_candidate) {
                deliver(&mut apics[i], i, vector, delivery_mode, is_level);
            }
        }
        else {
            for i in 0..apics.len() {
                if is_candidate(i) {
                    deliver(&mut apics[i], i, vector, delivery_mode, is_level);
                }
            }
        }
    }
    else {
        dbg_assert!(false);
    }
}

fn write32_internal(apic: &mut Apic, addr: u32, value: u32) {
    match addr {
        0x30 => {
            // version
            dbg_log!("APIC write version: {:08x}, ignored", value);
        },

        0x80 => {
            if APIC_LOG_VERBOSE {
                dbg_log!("Set tpr: {:02x}", value & 0xFF);
            }
            crate::apic_tpr_hook!(apic, value);
        },

        0xF0 => {
            dbg_log!("Set spurious vector: {:08x}", value);
            crate::apic_spurious_hook!(apic, value);
        },

        0x280 => {
            // updated readable error register with real error
            dbg_log!("Write error: {:08x}", value);
            apic.read_error = apic.error;
            apic.error = 0;
        },

        0x310 => {
            dbg_log!("APIC write icr1: {:08x}", value);
            apic.icr1 = value;
        },

        0x320 => {
            if APIC_LOG_VERBOSE {
                dbg_log!("timer lvt: {:08x}", value);
            }
            // TODO: check if unmasking and if this should trigger an interrupt immediately
            apic.lvt_timer = value;
        },

        0x330 => {
            dbg_log!("lvt thermal sensor: {:08x}", value);
            apic.lvt_thermal_sensor = value;
        },

        0x340 => {
            dbg_log!("lvt perf counter: {:08x}", value);
            apic.lvt_perf_counter = value;
        },

        0x350 => {
            dbg_log!("lvt int0: {:08x}", value);
            apic.lvt_int0 = value;
        },

        0x360 => {
            dbg_log!("lvt int1: {:08x}", value);
            apic.lvt_int1 = value;
        },

        0x370 => {
            dbg_log!("lvt error: {:08x}", value);
            apic.lvt_error = value;
        },

        0x3E0 => {
            apic.timer_divider = value;

            let divide_shift = (value & 0b11) | ((value & 0b1000) >> 1);
            apic.timer_divider_shift = if divide_shift == 0b111 { 0 } else { divide_shift + 1 };
            dbg_log!(
                "APIC timer divider: {:08x} shift={} tick={:.6}ms",
                apic.timer_divider,
                apic.timer_divider_shift,
                (1 << apic.timer_divider_shift) as f64 / APIC_TIMER_FREQ
            );
        },

        0x380 => {
            if APIC_LOG_VERBOSE {
                dbg_log!(
                    "APIC timer initial: {} next_interrupt={:.2}ms",
                    value,
                    value as f64 * (1 << apic.timer_divider_shift) as f64 / APIC_TIMER_FREQ,
                );
            }
            apic.timer_initial_count = value;
            apic.timer_current_count = value;
            apic.timer_last_tick = unsafe { js::microtick() };
        },

        0x390 => {
            dbg_log!("write timer current: {:08x}", value);
            dbg_assert!(false, "read-only register");
        },

        _ => {
            dbg_log!("APIC write32 {:x} <- {:08x}", addr, value);
            dbg_assert!(false);
        },
    }
}

/// Run every LAPIC's timer; returns the earliest next deadline.
#[no_mangle]
pub fn apic_timer(now: f64) -> f64 {
    let mut apics = get_apics();
    let mut deadline = f64::INFINITY;
    for i in 0..apics.len() {
        deadline = deadline.min(timer(&mut apics[i], i, now));
    }
    deadline
}

fn timer(apic: &mut Apic, target: usize, now: f64) -> f64 {
    if apic.timer_initial_count == 0 || apic.timer_current_count == 0 {
        return 100.0;
    }

    if apic.timer_last_tick > now {
        // should only happen after restore_state
        dbg_log!("warning: APIC last_tick is in the future, resetting");
        apic.timer_last_tick = now;
    }

    let diff = now - apic.timer_last_tick;
    let diff_in_ticks = diff * APIC_TIMER_FREQ / (1 << apic.timer_divider_shift) as f64;
    dbg_assert!(diff_in_ticks >= 0.0);
    let diff_in_ticks = diff_in_ticks as u64;

    let time_per_interrupt =
        apic.timer_initial_count as f64 * (1 << apic.timer_divider_shift) as f64 / APIC_TIMER_FREQ;

    if diff_in_ticks >= apic.timer_initial_count as u64 {
        let mode = apic.lvt_timer & APIC_TIMER_MODE_MASK;
        if mode == APIC_TIMER_MODE_PERIODIC {
            if APIC_LOG_VERBOSE {
                dbg_log!("APIC timer periodic interrupt");
            }

            if diff_in_ticks >= 2 * apic.timer_initial_count as u64 {
                dbg_log!(
                    "warning: APIC skipping {} interrupts initial={} ticks={} last_tick={:.1}ms now={:.1}ms d={:.1}ms",
                    diff_in_ticks / apic.timer_initial_count as u64 - 1,
                    apic.timer_initial_count,
                    diff_in_ticks,
                    apic.timer_last_tick,
                    now,
                    diff,
                );
                apic.timer_last_tick = now;
            }
            else {
                apic.timer_last_tick += time_per_interrupt;
                dbg_assert!(apic.timer_last_tick <= now);
            }
        }
        else if mode == APIC_TIMER_MODE_ONE_SHOT {
            if APIC_LOG_VERBOSE {
                dbg_log!("APIC timer one shot end");
            }
            apic.timer_current_count = 0;
        }
        else {
            dbg_assert!(false, "apic unimplemented timer mode: {:x}", mode);
        }

        if apic.lvt_timer & IOAPIC_CONFIG_MASKED == 0 {
            deliver(
                apic,
                target,
                (apic.lvt_timer & 0xFF) as u8,
                IOAPIC_DELIVERY_FIXED,
                false,
            );
        }
    }

    apic.timer_last_tick + time_per_interrupt - now
}

// Send an interrupt with an ICR- or IOAPIC-style destination to all matching
// local APICs: match every LAPIC against the destination, then deliver into
// each match. Returns whether any LAPIC accepted the interrupt, so callers
// such as the IOAPIC only commit side effects (remote IRR) for interrupts
// that were actually delivered.
pub fn route(
    apics: &mut [Apic],
    vector: u8,
    mode: u8,
    is_level: bool,
    destination: u8,
    destination_mode: u8,
) -> bool {
    let mut delivered = false;
    if mode == IOAPIC_DELIVERY_LOWEST_PRIORITY {
        let target = arbitrate_lowest_priority(apics, |i| {
            lapic_matches_destination(&apics[i], destination, destination_mode)
        });
        if let Some(i) = target {
            deliver(&mut apics[i], i, vector, mode, is_level);
            delivered = true;
        }
    }
    else {
        for i in 0..apics.len() {
            if lapic_matches_destination(&apics[i], destination, destination_mode) {
                deliver(&mut apics[i], i, vector, mode, is_level);
                delivered = true;
            }
        }
    }

    if !delivered {
        // e.g. a logical destination that no LAPIC has programmed into its
        // LDR yet
        dbg_log!(
            "APIC drop: no LAPIC matches destination={:02x} ({}) vector={:02x} delivery_mode={}",
            destination,
            DESTINATION_MODES[destination_mode as usize],
            vector,
            DELIVERY_MODES[mode as usize],
        );
    }
    delivered
}

// Lowest-priority arbitration (Intel SDM vol. 3A): among the candidate
// LAPICs, exactly one receives the interrupt — the Runnable vCPU with the
// lowest processor priority, ties broken by lowest APIC index. vCPUs that
// are not Runnable (parked, or APs that never left WaitForSipi) are
// excluded: their TPR is stuck at the power-on 0, which would win every
// arbitration and wedge a level-triggered line behind a context that never
// acknowledges (its remote IRR would latch forever). If no candidate is
// Runnable, the full candidate set arbitrates instead — an interrupt must
// not vanish because every matching vCPU is parked.
fn arbitrate_lowest_priority(
    apics: &[Apic],
    is_candidate: impl Fn(usize) -> bool,
) -> Option<usize> {
    (0..apics.len())
        .filter(|&i| is_candidate(i) && vcpu::is_runnable(i))
        .min_by_key(|&i| (apics[i].tpr, i))
        .or_else(|| {
            (0..apics.len())
                .filter(|&i| is_candidate(i))
                .min_by_key(|&i| (apics[i].tpr, i))
        })
}

// xAPIC destination matching per the Intel SDM vol. 3A, "Determining IPI
// Destination" (message destination address, MDA)
fn lapic_matches_destination(apic: &Apic, destination: u8, destination_mode: u8) -> bool {
    if destination_mode == DESTINATION_MODE_PHYSICAL {
        // physical: the MDA is an APIC ID; 0xFF is broadcast
        destination == DESTINATION_BROADCAST || destination as u32 == apic.apic_id >> 24
    }
    else {
        // logical: the MDA is matched against LDR[31:24] under the model
        // selected by DFR[31:28]
        let ldr = (apic.local_destination >> 24) as u8;
        match apic.destination_format >> 28 {
            // flat model: the MDA is a bitmask of target LDRs
            0xF => destination & ldr != 0,
            // cluster model: MDA[7:4] selects the cluster (0xF addresses all
            // clusters), MDA[3:0] is a bitmask matched against LDR[27:24]
            0x0 => {
                (destination >> 4 == 0xF || destination >> 4 == ldr >> 4)
                    && destination & ldr & 0xF != 0
            },
            model => {
                dbg_log!("APIC: reserved DFR model {:x}, no destination match", model);
                false
            },
        }
    }
}

// Deliver an interrupt into the LAPIC of vCPU `target` (which is
// `apics[target]`; passed separately so callers keep a single slice borrow)
fn deliver(apic: &mut Apic, target: usize, vector: u8, mode: u8, is_level: bool) {
    if APIC_LOG_VERBOSE {
        dbg_log!(
            "Deliver {:02x} mode={} level={} to LAPIC id={:02x}",
            vector,
            mode,
            is_level,
            apic.apic_id >> 24
        );
    }

    if mode == IOAPIC_DELIVERY_INIT {
        if target == 0 {
            // INIT to the BSP (vCPU 0 by architecture) means warm reset,
            // intentionally not implemented
            dbg_log!(
                "APIC: INIT to LAPIC id={:02x} ignored (warm reset not implemented)",
                apic.apic_id >> 24
            );
        }
        else {
            // Latch the INIT; the scheduler resets the target to power-on
            // values and WaitForSipi at the next slice boundary, outside
            // the APIC lock and the sender's mid-instruction context. The
            // target may be the sender itself (AP self-INIT): consumption
            // handles a current-vCPU target (see process_pending_init_sipi).
            dbg_log!("APIC: INIT to LAPIC id={:02x} latched", apic.apic_id >> 24);
            crate::vcpu_latch_init_hook!(target);
        }
        return;
    }

    if mode == IOAPIC_DELIVERY_NMI {
        // TODO: v86 has no NMI support in the interrupt core (see hlt), so a
        // routed NMI is dropped at delivery
        dbg_log!(
            "APIC: NMI to LAPIC id={:02x} dropped (NMI unsupported)",
            apic.apic_id >> 24
        );
        return;
    }

    if mode == APIC_DELIVERY_STARTUP {
        // Startup IPI: the vector encodes the real-mode startup page, not
        // an interrupt vector. pending_init counts as WaitForSipi: the
        // scheduler always applies a latched INIT before a latched SIPI.
        if !vcpu::ap_startup_enabled() {
            // Only reachable on a single-vCPU machine: vcpu::init arms the
            // gate together with a multi-vCPU table. See
            // vcpu::AP_STARTUP_ENABLED for why honoring a SIPI while the
            // firmware counts say 1 would break SeaBIOS's unconditional
            // INIT+SIPI broadcast.
            dbg_log!(
                "APIC: Startup IPI vector={:02x} to LAPIC id={:02x} dropped (AP startup gated)",
                vector,
                apic.apic_id >> 24
            );
            return;
        }
        if target != vcpu::current()
            && (vcpu::run_state(target) == vcpu::RunState::WaitForSipi
                || vcpu::pending_init(target))
        {
            dbg_log!(
                "APIC: Startup IPI vector={:02x} to LAPIC id={:02x} latched",
                vector,
                apic.apic_id >> 24
            );
            vcpu::set_pending_sipi(target, vector);
        }
        else {
            // SIPI to a running vCPU (the sender included): no effect
            dbg_log!(
                "APIC: Startup IPI vector={:02x} to LAPIC id={:02x} ignored",
                vector,
                apic.apic_id >> 24
            );
        }
        return;
    }

    if vector < 0x10 || vector == 0xFF {
        dbg_assert!(false, "TODO: Invalid vector: {:x}", vector);
    }

    // A fixed-style interrupt for a vCPU other than the executing one parks
    // in that context's irr; note the wake so the scheduler (stage 3) knows
    // the target has a reason to run. Noted even when irr already holds the
    // vector: spurious wakes are harmless, missed wakes hang the guest.
    if target != vcpu::current() {
        vcpu::note_interrupt(target);
        // The machine may be idling in the host with every vCPU halted;
        // wake the JS run loop like pic_call_irq does. A spurious
        // stop_idling is harmless.
        unsafe { js::stop_idling() };
    }

    if register_get_bit(&apic.irr, vector) {
        dbg_log!("Not delivered: irr already set, vector={:02x}", vector);
        return;
    }

    register_set_bit(&mut apic.irr, vector);

    if is_level {
        register_set_bit(&mut apic.tmr, vector);
    }
    else {
        register_clear_bit(&mut apic.tmr, vector);
    }
}

fn highest_irr(apic: &mut Apic) -> Option<u8> {
    let highest = register_get_highest_bit(&apic.irr);
    if let Some(x) = highest {
        dbg_assert!(x >= 0x10);
        dbg_assert!(x != 0xFF);
    }
    highest
}

fn highest_isr(apic: &mut Apic) -> Option<u8> {
    let highest = register_get_highest_bit(&apic.isr);
    if let Some(x) = highest {
        dbg_assert!(x >= 0x10);
        dbg_assert!(x != 0xFF);
    }
    highest
}

/// Acknowledge from the current vCPU's LAPIC (interrupt acknowledgement is
/// per-CPU like the MMIO window).
pub fn acknowledge_irq() -> Option<u8> {
    let mut apics = get_apics();
    let current = current(&apics);
    acknowledge_irq_internal(&mut apics[current])
}

fn acknowledge_irq_internal(apic: &mut Apic) -> Option<u8> {
    let highest_irr = match highest_irr(apic) {
        None => return None,
        Some(x) => x,
    };

    if let Some(highest_isr) = highest_isr(apic) {
        if highest_isr >= highest_irr {
            if APIC_LOG_VERBOSE {
                dbg_log!("Higher isr, isr={:x} irr={:x}", highest_isr, highest_irr);
            }
            return None;
        }
    }

    if highest_irr & 0xF0 <= apic.tpr as u8 & 0xF0 {
        if APIC_LOG_VERBOSE {
            dbg_log!(
                "Higher tpr, tpr={:x} irr={:x}",
                apic.tpr & 0xF0,
                highest_irr
            );
        }
        return None;
    }

    register_clear_bit(&mut apic.irr, highest_irr);
    register_set_bit(&mut apic.isr, highest_irr);

    if APIC_LOG_VERBOSE {
        dbg_log!("Calling vector {:x}", highest_irr);
    }

    dbg_assert!(acknowledge_irq_internal(apic).is_none());

    Some(highest_irr)
}

// functions operating on 256-bit registers (for irr, isr, tmr)
fn register_get_bit(v: &[u32; 8], bit: u8) -> bool { v[(bit >> 5) as usize] & 1 << (bit & 31) != 0 }

fn register_set_bit(v: &mut [u32; 8], bit: u8) { v[(bit >> 5) as usize] |= 1 << (bit & 31); }

fn register_clear_bit(v: &mut [u32; 8], bit: u8) { v[(bit >> 5) as usize] &= !(1 << (bit & 31)); }

fn register_get_highest_bit(v: &[u32; 8]) -> Option<u8> {
    dbg_assert!(v.as_ptr().addr() & std::mem::align_of::<u64>() - 1 == 0);
    let v: &[u64; 4] = unsafe { std::mem::transmute(v) };
    for i in (0..4).rev() {
        let word = v[i];

        if word != 0 {
            return Some(word.ilog2() as u8 | (i as u8) << 6);
        }
    }

    None
}

// ---- XWAH-9 Phase 4 Stage W3: the shared interrupt wire (design §4) ----
//
// Appended at the end of the file so the default build's panic-Location
// line numbers above stay put; every in-body hook replaces exactly one
// line at its call site. In worker roles (per-vCPU worker or the (b)
// device host) interrupt SENDS resolve destinations against the routing
// SNAPSHOT in the shared control region instead of the local APICS table:
// only the target's own instance may touch its authoritative LAPIC.
// Staleness races of the snapshot are exactly the races real hardware
// has (design §4).

/// route() twin over the routing snapshot: match every vCPU's published
/// (apic_id, LDR, DFR) against the destination, arbitrate lowest-priority
/// over published TPR + runnable, then deliver locally (own vCPU) or post
/// to the target's pending bitmaps / ipi_special latch.
#[cfg(feature = "guest-ram-import")]
pub fn route_shared(
    apics: &mut [Apic],
    vector: u8,
    mode: u8,
    is_level: bool,
    destination: u8,
    destination_mode: u8,
) -> bool {
    let matches = |i: usize| {
        lapic_matches_destination(&snapshot_apic(i as u32), destination, destination_mode)
    };
    let mut delivered = false;
    if mode == IOAPIC_DELIVERY_LOWEST_PRIORITY {
        if let Some(i) = arbitrate_lowest_priority_shared(matches) {
            deliver_shared(apics, i, vector, mode, is_level);
            delivered = true;
        }
    }
    else {
        for i in 0..vcpu::count() {
            if matches(i) {
                deliver_shared(apics, i, vector, mode, is_level);
                delivered = true;
            }
        }
    }
    if !delivered {
        dbg_log!(
            "APIC drop (shared): no snapshot entry matches destination={:02x} ({}) vector={:02x} delivery_mode={}",
            destination,
            DESTINATION_MODES[destination_mode as usize],
            vector,
            DELIVERY_MODES[mode as usize],
        );
    }
    delivered
}

/// A destination-matching view of vCPU i's published routing entry: the
/// snapshot fields dropped into a stack Apic so the exact
/// lapic_matches_destination logic applies unchanged.
#[cfg(feature = "guest-ram-import")]
fn snapshot_apic(i: u32) -> Apic {
    let n = vcpu::count() as u32;
    unsafe {
        Apic {
            apic_id: crate::cpu::smpctl::routing_read(n, i, crate::cpu::smpctl::ROUTING_APIC_ID)
                as u32,
            local_destination: crate::cpu::smpctl::routing_read(
                n,
                i,
                crate::cpu::smpctl::ROUTING_LDR,
            ) as u32,
            destination_format: crate::cpu::smpctl::routing_read(
                n,
                i,
                crate::cpu::smpctl::ROUTING_DFR,
            ) as u32,
            tpr: crate::cpu::smpctl::routing_read(n, i, crate::cpu::smpctl::ROUTING_TPR) as u32,
            ..APIC_RESET_STATE
        }
    }
}

#[cfg(feature = "guest-ram-import")]
fn snapshot_runnable(i: u32) -> bool {
    let n = vcpu::count() as u32;
    unsafe { crate::cpu::smpctl::routing_read(n, i, crate::cpu::smpctl::ROUTING_RUNNABLE) != 0 }
}

/// arbitrate_lowest_priority twin over the snapshot (published TPR, the
/// runnable bit from run_state_pub — design §4).
#[cfg(feature = "guest-ram-import")]
pub fn arbitrate_lowest_priority_shared(is_candidate: impl Fn(usize) -> bool) -> Option<usize> {
    let n = vcpu::count();
    (0..n)
        .filter(|&i| is_candidate(i) && snapshot_runnable(i as u32))
        .min_by_key(|&i| (snapshot_apic(i as u32).tpr, i))
        .or_else(|| {
            (0..n)
                .filter(|&i| is_candidate(i))
                .min_by_key(|&i| (snapshot_apic(i as u32).tpr, i))
        })
}

/// deliver() twin for worker roles: the own vCPU delivers into its
/// authoritative LAPIC exactly as today; every other target becomes a
/// control-region post + doorbell. INIT to the BSP keeps its warm-reset
/// ignore; SIPI keeps the AP_STARTUP_ENABLED gate (the target itself
/// enforces the WaitForSipi state on consumption); NMI posts the latch
/// bit, which the target drops (unsupported), mirroring deliver().
#[cfg(feature = "guest-ram-import")]
pub fn deliver_shared(apics: &mut [Apic], target: usize, vector: u8, mode: u8, is_level: bool) {
    use crate::cpu::worker;
    if worker::vcpu_index() == Some(target as u32) {
        deliver(&mut apics[target], target, vector, mode, is_level);
        return;
    }
    if mode == IOAPIC_DELIVERY_INIT {
        if target == 0 {
            dbg_log!("APIC (shared): INIT to BSP ignored (warm reset not implemented)");
        }
        else {
            unsafe { worker::post_init(target as u32) };
        }
        return;
    }
    if mode == IOAPIC_DELIVERY_NMI {
        unsafe { worker::post_nmi(target as u32) };
        return;
    }
    if mode == APIC_DELIVERY_STARTUP {
        if !vcpu::ap_startup_enabled() {
            dbg_log!(
                "APIC (shared): Startup IPI vector={:02x} to vcpu {} dropped (AP startup gated)",
                vector,
                target
            );
            return;
        }
        unsafe { worker::post_sipi(target as u32, vector) };
        return;
    }
    if vector < 0x10 || vector == 0xFF {
        dbg_assert!(false, "TODO: Invalid vector: {:x}", vector);
    }
    unsafe { worker::post_fixed(target as u32, vector, is_level) };
}

/// Merge remotely posted vectors into vCPU i's authoritative LAPIC
/// (design §3 step 3). The tmr merge is set-only: posts never clear a
/// level bit — a same-vector edge post after a level post leaves tmr set,
/// whose EOI then pings a remote IOAPIC line that no longer matches
/// (harmless no-op), instead of ever losing a level EOI.
#[cfg(feature = "guest-ram-import")]
pub fn merge_pending(i: usize, word: usize, irr_bits: u32, tmr_bits: u32) {
    let mut apics = get_apics();
    dbg_assert!(i < apics.len());
    let apic = &mut apics[i];
    apic.tmr[word] |= tmr_bits;
    apic.irr[word] |= irr_bits;
}

/// Publish the current vCPU's routing entry from its authoritative LAPIC
/// (write_routing_register/TPR/spurious hooks below pass the borrowed
/// Apic; this variant locks the table itself for worker.rs call sites).
#[cfg(feature = "guest-ram-import")]
pub fn publish_current_routing() {
    let apics = get_apics();
    let current = current(&apics);
    publish_routing_from(&apics[current]);
}

#[cfg(feature = "guest-ram-import")]
pub fn publish_routing_from(apic: &Apic) {
    let i = vcpu::current();
    let n = vcpu::count() as u32;
    let runnable = vcpu::run_state(i) == vcpu::RunState::Runnable;
    unsafe {
        crate::cpu::smpctl::routing_publish(
            n,
            i as u32,
            apic.apic_id as i32,
            apic.local_destination as i32,
            apic.destination_format as i32,
            apic.tpr as i32,
            (apic.spurious_vector & 0x100 != 0) as i32,
            runnable as i32,
        );
    }
}

/// route()'s dispatch seam (both call sites: write_icr0's no-shorthand
/// arm and ioapic::check_irq): worker roles resolve against the snapshot.
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! apic_route_hook {
    ($apics:expr, $vector:expr, $mode:expr, $level:expr, $dest:expr, $dest_mode:expr $(,)?) => {
        $crate::cpu::apic::route($apics, $vector, $mode, $level, $dest, $dest_mode)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! apic_route_hook {
    ($apics:expr, $vector:expr, $mode:expr, $level:expr, $dest:expr, $dest_mode:expr $(,)?) => {
        if $crate::cpu::worker::role_active() {
            $crate::cpu::apic::route_shared($apics, $vector, $mode, $level, $dest, $dest_mode)
        }
        else {
            $crate::cpu::apic::route($apics, $vector, $mode, $level, $dest, $dest_mode)
        }
    };
}

/// write_icr0's dispatch seam (write32's 0x300 arm): worker roles run the
/// full snapshot-resolving twin below; the default arm is the exact
/// historical call, so no potentially panicking expression moves into the
/// macro (panic-Location spans of the default build stay put).
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! apic_icr0_hook {
    ($apics:expr, $current:expr, $value:expr) => {
        write_icr0($apics, $current, $value)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! apic_icr0_hook {
    ($apics:expr, $current:expr, $value:expr) => {
        if $crate::cpu::worker::role_active() {
            write_icr0_shared($apics, $current, $value)
        }
        else {
            write_icr0($apics, $current, $value)
        }
    };
}

/// write_icr0 twin for worker roles (design §4 "ICR sends"): identical
/// decode + icr0 store + INIT-deassert ignore, but destination resolution
/// and shorthand fan-out run over the routing snapshot and deliveries go
/// through deliver_shared. Keep the decode in sync with write_icr0.
#[cfg(feature = "guest-ram-import")]
pub fn write_icr0_shared(apics: &mut [Apic], current: usize, value: u32) {
    let vector = (value & 0xFF) as u8;
    let delivery_mode = ((value >> 8) & 7) as u8;
    let destination_mode = ((value >> 11) & 1) as u8;
    let is_assert = value & 1 << 14 != 0;
    let is_level = value & ioapic::IOAPIC_CONFIG_TRIGGER_MODE_LEVEL
        == ioapic::IOAPIC_CONFIG_TRIGGER_MODE_LEVEL;
    let destination_shorthand = (value >> 18) & 3;
    let destination = (apics[current].icr1 >> 24) as u8;
    dbg_log!(
        "APIC write icr0 (shared): {:08x} vector={:02x} destination_mode={} delivery_mode={} destination_shorthand={}",
        value,
        vector,
        DESTINATION_MODES[destination_mode as usize],
        DELIVERY_MODES[delivery_mode as usize],
        ["no", "self", "all with self", "all without self"][destination_shorthand as usize]
    );

    let value = value & !(1 << 12);
    apics[current].icr0 = value;

    if delivery_mode == IOAPIC_DELIVERY_INIT && is_level && !is_assert {
        // INIT-deassert: explicitly ignored, exactly like write_icr0
        dbg_log!("APIC (shared): INIT-deassert IPI ignored");
        return;
    }

    if destination_shorthand == 0 {
        route_shared(
            apics,
            vector,
            delivery_mode,
            is_level,
            destination,
            destination_mode,
        );
    }
    else if destination_shorthand == 1 {
        deliver_shared(apics, current, vector, delivery_mode, is_level);
    }
    else if destination_shorthand == 2 || destination_shorthand == 3 {
        let is_candidate = |i: usize| destination_shorthand == 2 || i != current;
        if delivery_mode == IOAPIC_DELIVERY_LOWEST_PRIORITY {
            if let Some(i) = arbitrate_lowest_priority_shared(is_candidate) {
                deliver_shared(apics, i, vector, delivery_mode, is_level);
            }
        }
        else {
            for i in 0..vcpu::count() {
                if is_candidate(i) {
                    deliver_shared(apics, i, vector, delivery_mode, is_level);
                }
            }
        }
    }
    else {
        dbg_assert!(false);
    }
}

/// write_eoi's level leg: a per-vCPU worker cannot call ioapic::remote_eoi
/// (the IOAPIC lives on the device host) — the vector goes onto the
/// worker's eoi_ring and the host doorbell (design §4).
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! apic_remote_eoi_hook {
    ($apics:expr, $vector:expr) => {
        ioapic::remote_eoi($apics, $vector)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! apic_remote_eoi_hook {
    ($apics:expr, $vector:expr) => {
        if $crate::cpu::worker::in_vcpu_worker() {
            unsafe { $crate::cpu::worker::eoi_forward($vector) }
        }
        else {
            ioapic::remote_eoi($apics, $vector)
        }
    };
}

/// write_routing_register's tail: a per-vCPU worker publishes its new
/// routing entry and wakes the device host to reevaluate held IOAPIC
/// lines; every other role keeps the same-instance reevaluate.
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! apic_routing_changed_hook {
    ($apics:expr, $current:expr) => {
        ioapic::reevaluate($apics)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! apic_routing_changed_hook {
    ($apics:expr, $current:expr) => {
        if $crate::cpu::worker::in_vcpu_worker() {
            publish_routing_from(&$apics[$current]);
            unsafe { $crate::cpu::worker::notify_host() }
        }
        else {
            ioapic::reevaluate($apics)
        }
    };
}

/// The TPR write (0x80): a per-vCPU worker republishes its routing entry
/// (lowest-priority arbitration reads published TPR — design §4).
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! apic_tpr_hook {
    ($apic:expr, $value:expr) => {
        $apic.tpr = $value & 0xFF
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! apic_tpr_hook {
    ($apic:expr, $value:expr) => {
        $apic.tpr = $value & 0xFF;
        if $crate::cpu::worker::in_vcpu_worker() {
            publish_routing_from($apic);
        }
    };
}

/// The spurious-vector write (0xF0): republishes the software-enable bit.
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! apic_spurious_hook {
    ($apic:expr, $value:expr) => {
        $apic.spurious_vector = $value
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! apic_spurious_hook {
    ($apic:expr, $value:expr) => {
        $apic.spurious_vector = $value;
        if $crate::cpu::worker::in_vcpu_worker() {
            publish_routing_from($apic);
        }
    };
}

/// deliver()'s INIT latch: reachable in a per-vCPU worker only with the
/// own vCPU as target (an AP self-INIT via shorthand); the latch then
/// goes through the own ipi_special cell and is consumed at the next loop
/// boundary — the (b) twin of the vcpu.rs latch.
#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! vcpu_latch_init_hook {
    ($target:expr) => {
        vcpu::set_pending_init($target)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! vcpu_latch_init_hook {
    ($target:expr) => {
        if $crate::cpu::worker::in_vcpu_worker() {
            unsafe { $crate::cpu::worker::post_init($target as u32) }
        }
        else {
            vcpu::set_pending_init($target)
        }
    };
}
