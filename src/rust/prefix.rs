pub const PREFIX_REPZ: u8 = 0b01000;
pub const PREFIX_REPNZ: u8 = 0b10000;
pub const PREFIX_MASK_REP: u8 = PREFIX_REPZ | PREFIX_REPNZ;

pub const PREFIX_MASK_OPSIZE: u8 = 0b100000;
pub const PREFIX_MASK_ADDRSIZE: u8 = 0b1000000;

// SMP atomic RMW (XWAH-9): records the LOCK prefix (0xF0). Read by the
// multimem build's interpreter (Phase 4 Stage L1: the locked
// safe_read_write/bt-family/cmpxchg8b lowerings and the `#UD` guard below);
// unread in the default build, whose artifact stays byte-identical.
pub const PREFIX_LOCK: u8 = 0b10000000;

/// `#UD` for LOCK-prefixed register-destination forms (XWAH-9 Phase 4
/// design §5: the `_reg` twin of every LOCKable `_mem` form must fault
/// instead of silently discarding the prefix). Emitted by
/// gen/generate_interpreter.js in front of the `_reg` dispatch call of
/// every table entry flagged `lock: 1`; expands to nothing in the default
/// build (same byte-identity discipline as the gram accessor macros in
/// memory.rs). The exception is a block boundary, so it is marked as such
/// before the early return (the generated postfix is skipped).
///
/// Interpreter-only by construction: JIT-compiled code never writes the
/// runtime `prefixes` global (compile-time prefixes live in
/// `ctx.cpu.prefixes`), so under JIT the guard reads 0 and never fires —
/// LOCK fidelity for JIT'd code is Stage L2.
#[macro_export]
macro_rules! ud_if_lock_prefix {
    () => {
        #[cfg(feature = "guest-ram-import")]
        {
            if *$crate::cpu::global_pointers::prefixes & $crate::prefix::PREFIX_LOCK != 0 {
                $crate::cpu::cpu::after_block_boundary();
                return $crate::cpu::cpu::trigger_ud();
            }
        }
    };
}

pub const PREFIX_66: u8 = PREFIX_MASK_OPSIZE;
pub const PREFIX_67: u8 = PREFIX_MASK_ADDRSIZE;
pub const PREFIX_F2: u8 = PREFIX_REPNZ;
pub const PREFIX_F3: u8 = PREFIX_REPZ;

pub const SEG_PREFIX_ZERO: u8 = 7;

pub const PREFIX_MASK_SEGMENT: u8 = 0b111;
