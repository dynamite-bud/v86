//! XWAH-9 Phase 4 Stage L2: LOCK-prefix atomic lowering for the JIT
//! (docs/smp-phase4-design.md §5 "JIT emission", §9 L2). Only compiled under
//! the `guest-ram-import` cargo feature; the default build never reaches
//! this module (the `jit_locked_read_write!` seam expands to nothing there),
//! keeping the default artifact byte-identical.
//!
//! `gen_safe_read_write_locked` mirrors codegen.rs' `gen_safe_read_write` —
//! the single choke point every LOCKable `_mem` form funnels through
//! (arith/logic RMW groups, NOT/NEG, INC/DEC, XCHG 86/87, XADD 0FC1,
//! CMPXCHG 0FB1, the bt-family via `gen_bit_rmw`'s BYTE access, and
//! CMPXCHG8B 0FC7/1 as the one QWORD user) — but:
//!
//! - fast path (TLB hit, naturally aligned, non-mmap): a seq-cst CAS loop
//!   over the imported guest memory (memidx 1, the Stage-2 atomic emitters'
//!   first live use) instead of the plain load/compute/store;
//! - slow path: the `safe_read_write*_locked_slow_jit` helpers of
//!   cpu/lock.rs instead of `safe_read_write*_slow_jit` — the scratch-page
//!   redirection is non-atomic by design, so locked fallback classes
//!   (misaligned, page-crossing, mmap-target) run under the interim bus
//!   lock, which the read helper acquires and the write helper releases.
//!
//! Emitted structure (wasm pseudo-ops):
//!
//! ```text
//!   entry <- tlb_data[addr >> 12 << 2]
//!   fast <- entry & MASK == TLB_VALID
//!           && addr & 0xFFF <= 0x1000 - bytes     ; in-page (non-BYTE)
//!           && addr & (bytes-1) == 0              ; natural alignment
//!   if !fast:
//!       entry <- safe_read_write{8,16,32s,64}_locked_slow_jit(addr, eip)
//!       if entry & 1: goto exit-with-pagefault
//!   phys <- (entry & ~0xFFF) ^ addr
//!   if entry & 2 == 0:                            ; aligned guest RAM
//!       snapshot <- regs, lazy-flag globals       ; wasm-local copies
//!       old <- mem[phys]                          ; plain load, see below
//!       loop:
//!           value <- f(old)                       ; closure + side effects
//!           prev <- cmpxchg(phys, old, value)     ; seq-cst, memidx 1
//!           if prev != old:
//!               restore snapshot; old <- prev; continue
//!   else:                                         ; bus-locked scratch
//!       value <- f(mem[phys])                     ; phys is scratch
//!       safe_write{8,16,32,64}_locked_slow_jit(addr, value, eip)
//! ```
//!
//! Retry/side-effect ordering: a closure emits its register writebacks and
//! lazy-flags stores while computing the value, i.e. BEFORE the memory
//! operation completes, so a CAS retry must roll all of it back before
//! re-running the closure against the fresh old value — the wasm-level
//! mirror of cpu/lock.rs' `LockRetrySnapshot`. The snapshot is the 8
//! register locals plus the five lazy-flag globals (flags, flags_changed,
//! last_op1, last_result, last_op_size); closures that round-trip through
//! memory-resident registers (`gen_move_registers_from_locals_to_memory`
//! around an imported call) re-derive the memory copies from the restored
//! locals on re-execution. The successful iteration's side effects are the
//! ones that survive, which is exactly "side effects happen once,
//! post-success".
//!
//! The initial read is a plain (non-atomic) load: a torn value can only
//! make the first cmpxchg fail, whose atomically-returned old value seeds
//! the retry — the design's "first-iteration plain load + cmpxchg
//! validation".
//!
//! Discriminator bit: all historical slow-path returns are masked
//! `& !0xFFF` (bit 0 = page fault), so the locked read helper is free to
//! set bit 1 to mark "bus-locked scratch redirection". On the fast path
//! `entry` is the TLB entry, whose bit 1 (TLB_READONLY) the VALID-only
//! match guarantees clear; a pure-TLB-fill slow return (aligned guest RAM)
//! keeps bit 1 clear too and correctly takes the CAS branch — the wasm CAS
//! loop is what makes that class atomic, no bus lock needed.

use crate::cpu::cpu::{tlb_data, TLB_GLOBAL, TLB_NO_USER, TLB_VALID};
use crate::cpu::global_pointers;
use crate::jit::JitContext;
use crate::profiler;
use crate::wasmgen::wasm_builder::WasmLocal;
use crate::wasmgen::wasm_builder::GUEST_MEMORY_INDEX;

use super::{
    gen_debug_track_jit_exit, gen_profiler_stat_increment, BitSize, GenSafeReadWriteValue,
};

/// The five lazy-flag globals a locked closure may read or write; saved
/// before the CAS loop and restored on every retry (order is arbitrary but
/// must match between save and restore).
const FLAG_GLOBALS: [*mut i32; 5] = [
    global_pointers::flags,
    global_pointers::flags_changed,
    global_pointers::last_op1,
    global_pointers::last_result,
    global_pointers::last_op_size,
];

pub fn gen_safe_read_write_locked(
    ctx: &mut JitContext,
    bits: BitSize,
    address_local: &WasmLocal,
    f: &dyn Fn(&mut JitContext),
) {
    dbg_assert!(matches!(
        bits,
        BitSize::BYTE | BitSize::WORD | BitSize::DWORD | BitSize::QWORD
    ));
    let bytes = bits.bytes() as i32;

    let cont = ctx.builder.block_void();
    ctx.builder.get_local(address_local);

    ctx.builder.const_i32(12);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32(2);
    ctx.builder.shl_i32();

    ctx.builder
        .load_aligned_i32(unsafe { &tlb_data[0] as *const i32 as u32 });
    let entry_local = ctx.builder.tee_new_local();

    ctx.builder
        .const_i32((0xFFF & !TLB_GLOBAL & !(if ctx.cpu.cpl3() { 0 } else { TLB_NO_USER })) as i32);
    ctx.builder.and_i32();

    ctx.builder.const_i32(TLB_VALID as i32);
    ctx.builder.eq_i32();

    if bits != BitSize::BYTE {
        ctx.builder.get_local(address_local);
        ctx.builder.const_i32(0xFFF);
        ctx.builder.and_i32();
        ctx.builder.const_i32(0x1000 - bytes);
        ctx.builder.le_i32();
        ctx.builder.and_i32();

        // the locked fast path additionally requires natural alignment:
        // wasm atomics trap on unaligned addresses, and a split access
        // could not be a single atomic anyway (design §5)
        ctx.builder.get_local(address_local);
        ctx.builder.const_i32(bytes - 1);
        ctx.builder.and_i32();
        ctx.builder.eqz_i32();
        ctx.builder.and_i32();
    }

    ctx.builder.br_if(cont);

    if cfg!(feature = "profiler") {
        ctx.builder.get_local(address_local);
        ctx.builder.get_local(&entry_local);
        ctx.builder.call_fn2("report_safe_read_write_jit_slow");
    }

    ctx.builder.get_local(address_local);

    // packed lower bits of eip and wasm table index
    ctx.builder.const_i32(
        ctx.start_of_current_instruction as i32 & 0xFFF
            | (ctx.wasm_table_index.to_u16() as i32) << 16,
    );

    match bits {
        BitSize::BYTE => {
            ctx.builder.call_fn2_ret("safe_read_write8_locked_slow_jit");
        },
        BitSize::WORD => {
            ctx.builder
                .call_fn2_ret("safe_read_write16_locked_slow_jit");
        },
        BitSize::DWORD => {
            ctx.builder
                .call_fn2_ret("safe_read_write32s_locked_slow_jit");
        },
        BitSize::QWORD => {
            ctx.builder
                .call_fn2_ret("safe_read_write64_locked_slow_jit");
        },
        BitSize::DQWORD => {
            dbg_assert!(false);
        },
    }
    ctx.builder.tee_local(&entry_local);
    ctx.builder.const_i32(1);
    ctx.builder.and_i32();

    if cfg!(feature = "profiler") {
        ctx.builder.if_void();
        gen_debug_track_jit_exit(ctx.builder, ctx.start_of_current_instruction);
        ctx.builder.block_end();

        ctx.builder.get_local(&entry_local);
        ctx.builder.const_i32(1);
        ctx.builder.and_i32();
    }

    ctx.builder.br_if(ctx.exit_with_fault_label);

    ctx.builder.block_end();

    gen_profiler_stat_increment(ctx.builder, profiler::stat::SAFE_READ_WRITE_FAST); // XXX: Also slow

    ctx.builder.get_local(&entry_local);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.get_local(address_local);
    ctx.builder.xor_i32();
    let phys_addr_local = ctx.builder.set_new_local();

    // entry & 2 == 0 <=> aligned guest RAM, CAS loop applies (see module doc)
    ctx.builder.get_local(&entry_local);
    ctx.builder.const_i32(2);
    ctx.builder.and_i32();
    ctx.builder.eqz_i32();
    ctx.builder.free_local(entry_local);

    ctx.builder.if_void();
    {
        // ---- aligned guest RAM: seq-cst CAS loop ----
        let mut reg_snapshot = Vec::with_capacity(8);
        for i in 0..8 {
            ctx.builder.get_local(&ctx.register_locals[i]);
            reg_snapshot.push(ctx.builder.set_new_local());
        }
        let mut flag_snapshot = Vec::with_capacity(FLAG_GLOBALS.len());
        for &global in FLAG_GLOBALS.iter() {
            ctx.builder.load_fixed_i32(global as u32);
            flag_snapshot.push(ctx.builder.set_new_local());
        }

        ctx.builder.get_local(&phys_addr_local);
        gen_load(ctx, bits);
        let old_local = new_value_local(ctx, bits);

        let retry = ctx.builder.loop_void();
        get_value_local(ctx, &old_local);

        f(ctx);

        let value_local = new_value_local(ctx, bits);

        ctx.builder.get_local(&phys_addr_local);
        get_value_local(ctx, &old_local);
        get_value_local(ctx, &value_local);
        match bits {
            BitSize::BYTE => ctx.builder.atomic_rmw_cmpxchg_u8(GUEST_MEMORY_INDEX, 0),
            BitSize::WORD => ctx.builder.atomic_rmw_cmpxchg_u16(GUEST_MEMORY_INDEX, 0),
            BitSize::DWORD => ctx.builder.atomic_rmw_cmpxchg_i32(GUEST_MEMORY_INDEX, 0),
            BitSize::QWORD => ctx.builder.atomic_rmw_cmpxchg_i64(GUEST_MEMORY_INDEX, 0),
            BitSize::DQWORD => dbg_assert!(false),
        }
        let prev_local = new_value_local(ctx, bits);

        get_value_local(ctx, &prev_local);
        get_value_local(ctx, &old_local);
        if bits == BitSize::QWORD {
            ctx.builder.ne_i64();
        }
        else {
            ctx.builder.ne_i32();
        }
        ctx.builder.if_void();
        {
            // mismatch: roll back the closure's side effects and retry
            // against the atomically-observed old value
            for i in 0..8 {
                ctx.builder.get_local(&reg_snapshot[i]);
                ctx.builder.set_local(&ctx.register_locals[i]);
            }
            for (i, &global) in FLAG_GLOBALS.iter().enumerate() {
                ctx.builder.const_i32(global as i32);
                ctx.builder.get_local(&flag_snapshot[i]);
                ctx.builder.store_aligned_i32(0);
            }
            get_value_local(ctx, &prev_local);
            set_value_local(ctx, &old_local);
            ctx.builder.br(retry);
        }
        ctx.builder.block_end();
        ctx.builder.block_end(); // loop

        free_value_local(ctx, prev_local);
        free_value_local(ctx, value_local);
        free_value_local(ctx, old_local);
        for local in flag_snapshot {
            ctx.builder.free_local(local);
        }
        for local in reg_snapshot {
            ctx.builder.free_local(local);
        }
    }
    ctx.builder.else_();
    {
        // ---- bus-locked fallback: phys points into the scratch pages the
        // read helper filled; it still holds the interim bus lock. Run the
        // closure against the scratch value, then hand the result to the
        // locked write helper, which performs the real (page-crossing/mmap/
        // misaligned) write and releases the lock. The historical scratch
        // store is skipped — the scratch contents are dead once the
        // closure ran.
        ctx.builder.get_local(&phys_addr_local);
        gen_load(ctx, bits);

        f(ctx);

        let value_local = new_value_local(ctx, bits);

        ctx.builder.get_local(address_local);
        get_value_local(ctx, &value_local);
        // packed lower bits of eip and wasm table index
        ctx.builder.const_i32(
            ctx.start_of_current_instruction as i32 & 0xFFF
                | (ctx.wasm_table_index.to_u16() as i32) << 16,
        );
        match bits {
            BitSize::BYTE => {
                ctx.builder.call_fn3_ret("safe_write8_locked_slow_jit");
            },
            BitSize::WORD => {
                ctx.builder.call_fn3_ret("safe_write16_locked_slow_jit");
            },
            BitSize::DWORD => {
                ctx.builder.call_fn3_ret("safe_write32_locked_slow_jit");
            },
            BitSize::QWORD => {
                ctx.builder
                    .call_fn3_i32_i64_i32_ret("safe_write64_locked_slow_jit");
            },
            BitSize::DQWORD => {
                dbg_assert!(false);
            },
        }

        // the read helper already translated the address for write, so the
        // write half cannot fault
        if cfg!(debug_assertions) {
            ctx.builder.const_i32(1);
            ctx.builder.and_i32();
            ctx.builder.if_void();
            {
                ctx.builder.const_i32(match bits {
                    BitSize::BYTE => 8,
                    BitSize::WORD => 16,
                    BitSize::DWORD => 32,
                    BitSize::QWORD => 64,
                    _ => {
                        dbg_assert!(false);
                        0
                    },
                });
                ctx.builder.get_local(address_local);
                ctx.builder.call_fn2("bug_gen_safe_read_write_page_fault");
            }
            ctx.builder.block_end();
        }
        else {
            ctx.builder.drop_();
        }

        free_value_local(ctx, value_local);
    }
    ctx.builder.block_end();

    ctx.builder.free_local(phys_addr_local);
}

/// Emit a store of an immediate into the runtime `*prefixes` global (u8,
/// global_pointers::prefixes) — the bracket around interpreter calls of
/// LOCK-decoded non-custom instructions (see `jit_lock_interp_mem_call!`
/// in codegen.rs and its generate_jit.js splice).
pub fn gen_store_runtime_prefixes(ctx: &mut JitContext, prefixes: u8) {
    ctx.builder.const_i32(global_pointers::prefixes as i32);
    ctx.builder.const_i32(prefixes as i32);
    ctx.builder.store_u8(0);
}

fn gen_load(ctx: &mut JitContext, bits: BitSize) {
    match bits {
        BitSize::BYTE => {
            crate::jit_gram_load8!(ctx.builder, 0);
        },
        BitSize::WORD => {
            crate::jit_gram_load16!(ctx.builder, 0);
        },
        BitSize::DWORD => {
            crate::jit_gram_load32!(ctx.builder, 0);
        },
        BitSize::QWORD => {
            crate::jit_gram_load64!(ctx.builder, 0);
        },
        BitSize::DQWORD => dbg_assert!(false),
    }
}

fn new_value_local(ctx: &mut JitContext, bits: BitSize) -> GenSafeReadWriteValue {
    if bits == BitSize::QWORD {
        GenSafeReadWriteValue::I64(ctx.builder.set_new_local_i64())
    }
    else {
        GenSafeReadWriteValue::I32(ctx.builder.set_new_local())
    }
}

fn get_value_local(ctx: &mut JitContext, local: &GenSafeReadWriteValue) {
    match local {
        GenSafeReadWriteValue::I32(l) => ctx.builder.get_local(l),
        GenSafeReadWriteValue::I64(l) => ctx.builder.get_local_i64(l),
    }
}

fn set_value_local(ctx: &mut JitContext, local: &GenSafeReadWriteValue) {
    match local {
        GenSafeReadWriteValue::I32(l) => ctx.builder.set_local(l),
        GenSafeReadWriteValue::I64(l) => ctx.builder.set_local_i64(l),
    }
}

fn free_value_local(ctx: &mut JitContext, local: GenSafeReadWriteValue) {
    match local {
        GenSafeReadWriteValue::I32(l) => ctx.builder.free_local(l),
        GenSafeReadWriteValue::I64(l) => ctx.builder.free_local_i64(l),
    }
}
