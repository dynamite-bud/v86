// XWAH-9 Phase 4 Stage W3: topology (b) — one worker per vCPU
// (docs/smp-phase4-design.md §3, §4, §9 W3). Only compiled under the
// `guest-ram-import` cargo feature (gated in cpu/mod.rs); the default
// artifact stays byte-identical because every touch point in shared files
// is a line-neutral macro seam whose default arm is the historical code.
//
// Three roles an instance of this module can take:
//
// - `VcpuWorker(i)`: the instance executes exactly vCPU i inside a
//   dedicated worker (src/browser/vcpu_worker.js per-vCPU mode). Its
//   LAPIC (APICS[i]) is the authoritative home of that vCPU's interrupt
//   state; remote interrupt sends go through the shared control region
//   (pending_irr/tmr bitmaps, the ipi_special latch, the routing
//   snapshot — smpctl.rs).
// - `Host`: the main thread's instance. It never executes guest code but
//   owns the authoritative chipset (8259 PIC + IOAPIC): device IRQs run
//   the ordinary wasm `device_raise_irq` on it, and apic::route's shared
//   leg posts the resulting fixed vectors to the target workers.
// - `None`: everything as landed — single instance, time-sliced scheduler,
//   or the topology-(c) machine worker (which owns the whole chipset
//   itself and must keep the local delivery paths).

use crate::cpu::cpu::js;
use crate::cpu::global_pointers::{acpi_enabled, in_hlt, instruction_counter, instruction_pointer};
use crate::cpu::{apic, cpu, pic, smpctl, vcpu};
use crate::jit;
use crate::page::Page;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    None,
    VcpuWorker(u32),
    Host,
}

static mut ROLE: Role = Role::None;

pub fn role() -> Role { unsafe { ROLE } }

pub fn role_active() -> bool { role() != Role::None }

pub fn vcpu_index() -> Option<u32> {
    match role() {
        Role::VcpuWorker(i) => Some(i),
        _ => None,
    }
}

pub fn in_vcpu_worker() -> bool { vcpu_index().is_some() }

/// The mailbox record this instance's blocking RPCs use: its own vCPU
/// index in a per-vCPU worker, record 0 otherwise (topology (c)).
pub fn mailbox_record_index() -> u32 { vcpu_index().unwrap_or(0) }

fn total() -> u32 { vcpu::count() as u32 }

unsafe fn memory_size() -> u32 { *crate::cpu::global_pointers::memory_size }

/// Idle return of a non-Runnable worker: the JS loop caps the doorbell
/// wait at its own park timeout, and any doorbell post wakes it early.
const IDLE_PARK_MS: f64 = 1e9;

/// Put the main thread's instance into device-host mode (topology (b)).
#[no_mangle]
pub unsafe fn set_worker_host(v: u32) { ROLE = if v != 0 { Role::Host } else { Role::None } }

/// Put this instance into per-vCPU worker mode for vCPU `index` of
/// `total` (design §3). Must run after set_smp_cpus(total) and a
/// reset_cpu (which leaves every save area at power-on values with the
/// BSP Runnable and the APs WaitForSipi); also used to re-initialize the
/// worker on a machine reboot, so it clears this vCPU's control-region
/// cells — a pre-reset IPI or jit event must not leak into the next boot
/// (the vcpu::clear_pending twin).
#[no_mangle]
pub unsafe fn set_worker_vcpu(index: u32, total_cpus: u32) {
    dbg_assert!(total_cpus >= 1 && index < total_cpus);
    dbg_assert!(vcpu::count() == total_cpus as usize);
    vcpu::switch_to(index as usize);
    // switch_to contract; the reset flush ran while vCPU 0 was live
    cpu::full_clear_tlb();
    ROLE = Role::VcpuWorker(index);
    smpctl::ipi_special_take(index);
    for word in 0..smpctl::PENDING_WORDS {
        smpctl::pending_irr_drain(index, word);
        smpctl::pending_tmr_drain(index, word);
    }
    while smpctl::eoi_ring_pop(index).is_some() {}
    while smpctl::jit_inbox_drain(index, |_| ()) {}
    smpctl::code_bitmap_clear_all(total_cpus, index, memory_size());
    smpctl::pic_pending_take(index);
    smpctl::insn_publish(index, *instruction_counter as i32);
    publish_run_state(index);
    apic::publish_current_routing();
}

/// One frame of the per-worker loop (design §3), reached from main_loop
/// through the `main_loop_stat_or_worker!` seam. Returns like main_loop:
/// 0 = budget spent with work remaining, > 0 = idle for that many ms
/// (the worker JS loop turns it into a doorbell wait).
///
/// Per-iteration ordering (deliberate, documented in the §9 W3 note):
/// (1) consume the INIT/SIPI latch, (2) merge remotely posted vectors
/// into the local LAPIC, (3) drain the jit inbox, (4) deliver + execute.
/// A cross-modifying writer posts its dirt strictly before its IPI, so
/// any IPI/SIPI observed by (1)/(2) has its dirt visible to (3) — the
/// drain-before-IRQ contract under real concurrency.
pub unsafe fn main_loop_worker(index: u32) -> f64 {
    let start = js::microtick();
    loop {
        consume_ipi_special(index);
        merge_pending_interrupts(index);
        drain_jit_inbox(index);
        if vcpu::run_state(index as usize) != vcpu::RunState::Runnable {
            publish_run_state(index);
            return IDLE_PARK_MS;
        }
        // W4 exclusive execution (design §5 final form): the busy bracket
        // around the guest-execution section — handle_irqs may write the
        // guest stack, do_many_cycles is the guest. slice_begin honors a
        // held exclusive cell before entering.
        excl_slice_begin(index);
        cpu::handle_irqs();
        if !*in_hlt {
            cpu::do_many_cycles_native();
        }
        let now = js::microtick();
        // worker-local per §6: the env import returns only this
        // instance's apic_timer deadline
        let t = js::run_hardware_timers(*acpi_enabled, now);
        cpu::handle_irqs();
        excl_slice_end(index);
        // slice-boundary backstop for the deferred dirty posts (see
        // defer_dirty_post): nothing queued by JIT-emitted stores may
        // survive across a park, where this vCPU could sit for a long
        // time while a peer executes bytes we invalidated
        flush_dirty_posts();
        smpctl::insn_publish(index, *instruction_counter as i32);
        if vcpu::run_state(index as usize) != vcpu::RunState::Runnable {
            // hlt with IF=0 parked this vCPU mid-slice
            publish_run_state(index);
            return IDLE_PARK_MS;
        }
        if *in_hlt {
            smpctl::run_state_publish(index, smpctl::RUN_STATE_HALTED);
            return t;
        }
        smpctl::run_state_publish(index, smpctl::RUN_STATE_RUNNABLE);
        if now - start > cpu::TIME_PER_FRAME {
            return 0.0;
        }
    }
}

/// Publish this vCPU's run state to run_state_pub (main aggregates the
/// machine-dead condition from these cells).
unsafe fn publish_run_state(index: u32) {
    let state = match vcpu::run_state(index as usize) {
        vcpu::RunState::Runnable => {
            if *in_hlt {
                smpctl::RUN_STATE_HALTED
            }
            else {
                smpctl::RUN_STATE_RUNNABLE
            }
        },
        vcpu::RunState::WaitForSipi => smpctl::RUN_STATE_WAIT_FOR_SIPI,
        vcpu::RunState::Parked => smpctl::RUN_STATE_PARKED,
    };
    smpctl::run_state_publish(index, state);
}

/// instr_F4's park leg (hlt with IF=0), via the `vcpu_park_hook!` seam:
/// publish the state so the device host and the routing snapshot see the
/// parked vCPU immediately.
pub unsafe fn publish_parked() {
    if let Some(index) = vcpu_index() {
        publish_run_state(index);
        apic::publish_current_routing();
    }
}

/// Consume the INIT/SIPI/NMI latch word (design §3 step 2). INIT resets
/// the live block (this instance owns exactly one vCPU — no switch, no
/// rotation) and parks in WaitForSipi; SIPI applies the exact apply_sipi
/// recipe to the live block and publishes Runnable; NMI is dropped like
/// apic::deliver drops it (unsupported by the interrupt core).
unsafe fn consume_ipi_special(index: u32) {
    let special = smpctl::ipi_special_take(index);
    if special == 0 {
        return;
    }
    if special & smpctl::IPI_INIT_BIT != 0 {
        dbg_log!("vcpu worker {}: INIT consumed, -> WaitForSipi", index);
        cpu::reset_vcpu_block();
        // per the SDM, INIT returns the LAPIC to power-up state except
        // the APIC ID
        apic::reset_one(index as usize);
        // ...and the vectors that senders posted to the SHARED bitmaps
        // before the INIT die with it. reset_one only wipes the local
        // Apic struct; without this drain the very next step of the loop
        // (merge_pending_interrupts, which runs immediately after this
        // function) would re-materialize the pre-INIT irr/tmr into the
        // freshly reset LAPIC, and the AP would take an interrupt from
        // its previous life before executing a single SIPI instruction.
        // The time-sliced INIT (cpu.rs process_pending_init_sipi) gets
        // this for free: there is no control region, so apic::reset_one
        // IS the complete drop of pending vectors. Level EOIs queued by
        // the pre-INIT incarnation go with them.
        for word in 0..smpctl::PENDING_WORDS {
            smpctl::pending_irr_drain(index, word);
            smpctl::pending_tmr_drain(index, word);
        }
        while smpctl::eoi_ring_pop(index).is_some() {}
        // an 8259 INTR flag raised for the pre-INIT BSP likewise refers
        // to a vector the authoritative PIC will re-assert if still
        // pending (the host re-posts while INTR stays asserted)
        smpctl::pic_pending_take(index);
        vcpu::set_run_state(index as usize, vcpu::RunState::WaitForSipi);
        publish_run_state(index);
        apic::publish_current_routing();
    }
    if special & smpctl::IPI_SIPI_BIT != 0 {
        if vcpu::run_state(index as usize) == vcpu::RunState::WaitForSipi {
            let vector =
                ((special & smpctl::IPI_SIPI_VECTOR_MASK) >> smpctl::IPI_SIPI_VECTOR_SHIFT) as i32;
            dbg_log!("vcpu worker {}: SIPI vector={:02x} consumed", index, vector);
            // The vcpu::apply_sipi recipe, applied to the live block —
            // with one W4 correction: instruction_pointer is a LINEAR
            // address in v86 (CS base included), so the architectural
            // entry CS:IP = (vector<<8):0000 is linear vector<<12, NOT 0.
            // apply_sipi's literal 0 makes a SIPI'd vCPU start executing
            // at linear 0 and depend on sledding through pristine low
            // memory up into the trampoline — an accident that holds on
            // first boot and breaks on reboot, when low RAM holds guest
            // leftovers (found empirically by the W4 reboot gate: the
            // AP's garbage sled corrupted SeaBIOS's relocated POST code).
            // The time-sliced path keeps the historical entry: vcpu.rs is
            // part of the default artifact, whose byte identity W4 must
            // not break.
            cpu::switch_cs_real_mode(vector << 8);
            *instruction_pointer = vector << 12;
            vcpu::set_run_state(index as usize, vcpu::RunState::Runnable);
            publish_run_state(index);
            apic::publish_current_routing();
        }
        else {
            // SIPI to a vCPU that is not WaitForSipi: no effect (the
            // deliver() contract)
            dbg_log!("vcpu worker {}: SIPI ignored (not WaitForSipi)", index);
        }
    }
    if special & smpctl::IPI_NMI_BIT != 0 {
        dbg_log!("vcpu worker {}: NMI dropped (unsupported)", index);
    }
}

/// Merge remotely posted fixed vectors into the local LAPIC (design §3
/// step 3): atomic xchg-drain of each bitmap word.
unsafe fn merge_pending_interrupts(index: u32) {
    for word in 0..smpctl::PENDING_WORDS {
        let irr = smpctl::pending_irr_drain(index, word);
        let tmr = smpctl::pending_tmr_drain(index, word);
        if irr != 0 || tmr != 0 {
            apic::merge_pending(index as usize, word as usize, irr, tmr);
        }
    }
}

/// Drain this worker's jit inbox (design §9 W3 note): dirty events
/// invalidate local code for the page, protect events set the TLB
/// has-code bit so future writes take the dirty-notify slow path. An
/// overflow recovers with jit_clear_all + full_clear_tlb — nothing is
/// lost because the code bitmaps re-supply protection at TLB refill.
unsafe fn drain_jit_inbox(index: u32) {
    let n = total();
    let ms = memory_size();
    let overflowed = smpctl::jit_inbox_drain(index, |event| {
        let page = Page::page_of(((event as u32) & 0xFFFFF) << 12);
        if event as u32 & smpctl::JIT_EVENT_PROTECT_BIT != 0 {
            cpu::tlb_set_has_code(page, true);
        }
        else {
            jit::jit_dirty_page_local(page);
            if !jit::jit_page_has_code(page) {
                // no local code (any more): the entry's has-code bit only
                // mirrored remote protection, which this event just
                // invalidated everywhere
                cpu::tlb_set_has_code(page, false);
            }
            if !jit::jit_page_has_code_or_compiling(page) {
                // Self-heal a stale shared-bitmap bit: bits are set at
                // compile start, but not every removal path fires
                // jit_invalidate_page_hook — a sibling page swept by
                // free()'s retain() or the page set of a compile
                // discarded as CompilingWritten keeps its bit with no
                // code behind it. A stale bit makes every peer write to
                // the page take the dirty-notify slow path (one slow
                // write + a broadcast per TLB refill, forever) and, with
                // the targeted dirty posts (post_dirty_page_with), keeps
                // steering those posts here. This dirty event proves a
                // peer just wrote the page while this instance holds
                // nothing in it: retire the bit, bounding the stale
                // round at one event.
                smpctl::code_bitmap_clear(n, index, ms, page.to_u32());
            }
        }
    });
    if overflowed {
        dbg_log!(
            "vcpu worker {}: jit inbox overflow, clear-all recovery",
            index
        );
        jit::jit_clear_cache_js();
        cpu::full_clear_tlb();
    }
}

// ---- exclusive execution (W4, design §5 final form) ----
//
// The upgrade of the interim bus-lock cell for multi-worker topology (b):
// a worker whose locked RMW falls outside the CAS-able classes
// (misaligned, page-crossing, mmap-target) parks every OTHER worker for
// the duration of the RMW — QEMU MTTCG's start_exclusive, made of two
// kinds of control-region cells (smpctl.rs):
//
//   machine.exclusive   0 = free, else owner index + 1; CAS-acquired
//   excl_busy[i]        1 while worker i is inside its guest-execution
//                       section, 0 at every safe point
//
// Chosen mechanism: purely peer-to-peer. Host mediation was rejected
// because nothing the host owns is involved — the contended resource is
// guest RAM, which every worker reaches directly — and a host round trip
// would add two mailbox-class latencies to a path that only needs
// cross-worker ordering. Workers cannot service each other's mailboxes,
// but no mailbox is needed: the owner waits on the busy CELLS, and a
// worker blocked in a mailbox RPC keeps busy=1 until the device host
// (which keeps servicing throughout) completes the RPC and the slice
// reaches its boundary — the same "mid-RPC completes first" property as
// the §7 quiesce.
//
// Soundness (Dekker/store-buffering over seq-cst gram atomics): a worker
// stores busy=1 BEFORE loading the exclusive cell at slice entry; the
// owner's CAS precedes its busy loads. In the seq-cst total order either
// the entering worker sees the owner's CAS (and waits at the safe point
// with busy=0) or the owner sees busy=1 (and waits for that slice to
// end). Either way no other worker touches guest memory between the
// owner's acquisition returning and its release. A contending requester
// clears its own busy while spinning — it sits at a safe point
// (mid-instruction, but provably not touching guest memory), so a
// concurrent owner never deadlocks on it; livelock is excluded by the
// finite worker count and µs-scale exclusive sections.
//
// Residual (documented, same class as the interim cell's DMA story): the
// main thread's device writes (write_blob/DMA, rep-I/O servicing) do not
// participate — device DMA racing a guest's misaligned locked RMW on the
// same bytes remains hardware-race-class, unchanged from every earlier
// stage. Guest-vs-guest bus-lock semantics are now exact, including
// against aligned atomics on overlapping cells (the split-lock hole of
// design §5 is closed in this topology).

/// 1 s wait slices while waiting for a peer; ~10 s of no progress means a
/// dead worker, which is fail-stop (design §8) — panic loudly.
const EXCL_WAIT_SLICE_NS: i64 = 1_000_000_000;
const EXCL_WAIT_SLICES_MAX: i32 = 10;

/// Slice entry: publish busy=1, then honor a held exclusive cell (wait at
/// this safe point until it frees). Cheap when free: one store + one load.
pub unsafe fn excl_slice_begin(index: u32) {
    let n = total();
    smpctl::excl_busy_set(index);
    loop {
        let owner = smpctl::exclusive_read(n);
        if owner == 0 {
            return;
        }
        dbg_assert!(owner != index as i32 + 1);
        smpctl::excl_busy_clear(index);
        smpctl::exclusive_wait(n, owner, EXCL_WAIT_SLICE_NS);
        smpctl::excl_busy_set(index);
    }
}

/// Slice end: publish the safe point (wakes a waiting exclusive owner).
pub unsafe fn excl_slice_end(index: u32) { smpctl::excl_busy_clear(index); }

/// Acquire exclusive execution: become the owner, then wait until every
/// other worker is at a safe point. Called mid-instruction from the locked
/// fallback paths (cpu/lock.rs) — the caller's own busy cell stays set on
/// the success path; while contending it is cleared so a concurrent owner
/// treats this worker as safe (it is: it spins right here, touching no
/// guest memory).
pub unsafe fn exclusive_acquire(index: u32) {
    let n = total();
    let own = index as i32 + 1;
    let mut slices = 0;
    while !smpctl::exclusive_try_acquire(n, own) {
        smpctl::excl_busy_clear(index);
        let owner = smpctl::exclusive_read(n);
        if owner != 0 {
            if smpctl::exclusive_wait(n, owner, EXCL_WAIT_SLICE_NS) == 2 {
                slices += 1;
                if slices > EXCL_WAIT_SLICES_MAX {
                    panic!("exclusive: owner never released");
                }
            }
        }
        smpctl::excl_busy_set(index);
    }
    for j in 0..n {
        if j == index {
            continue;
        }
        slices = 0;
        while smpctl::excl_busy_read(j) != 0 {
            if smpctl::excl_busy_wait_clear(j, EXCL_WAIT_SLICE_NS) == 2 {
                slices += 1;
                if slices > EXCL_WAIT_SLICES_MAX {
                    panic!("exclusive: peer never reached a safe point");
                }
            }
        }
    }
}

/// Release exclusive execution: free the cell and wake every worker parked
/// at a safe point (and any contending requester).
pub unsafe fn exclusive_release() { smpctl::exclusive_release(total()); }

/// Stage W4 save-time sync (design §7), called by the worker runtime on
/// COMMAND_SAVE before vcpu_prepare_save: drain every in-flight
/// control-region interrupt into the architectural structures the save
/// captures. Bits posted to pending_irr/tmr after this vCPU's last
/// consume, or an INIT/SIPI latched while it parked, live ONLY in the
/// control region — a snapshot taken without this drain silently drops
/// them (found empirically: a lost virtio INTx level raise wedged the
/// restored guest's 9p root). Consuming at a park boundary is exactly the
/// slice-boundary consume of the running loop.
#[no_mangle]
pub unsafe fn vcpu_worker_sync_for_save() {
    if let Some(index) = vcpu_index() {
        consume_ipi_special(index);
        merge_pending_interrupts(index);
        drain_jit_inbox(index);
        publish_run_state(index);
    }
}

// ---- interrupt-wire posting primitives (used by apic.rs' shared legs) ----

/// Post a fixed-delivery vector to another vCPU's pending bitmaps +
/// doorbell (design §4). The tmr bit is posted before the irr bit: the
/// consumer drains irr first, so an observed irr bit always sees its tmr
/// payload.
pub unsafe fn post_fixed(target: u32, vector: u8, is_level: bool) {
    let word = (vector >> 5) as u32;
    let bit = 1u32 << (vector & 31);
    if is_level {
        smpctl::pending_tmr_or(target, word, bit);
    }
    smpctl::pending_irr_or(target, word, bit);
    smpctl::doorbell_post(target);
}

pub unsafe fn post_init(target: u32) {
    smpctl::ipi_special_or(target, smpctl::IPI_INIT_BIT);
    smpctl::doorbell_post(target);
}

pub unsafe fn post_sipi(target: u32, vector: u8) {
    smpctl::ipi_special_or(
        target,
        smpctl::IPI_SIPI_BIT | (vector as u32) << smpctl::IPI_SIPI_VECTOR_SHIFT,
    );
    smpctl::doorbell_post(target);
}

pub unsafe fn post_nmi(target: u32) {
    smpctl::ipi_special_or(target, smpctl::IPI_NMI_BIT);
    smpctl::doorbell_post(target);
}

/// write_eoi's level leg in a per-vCPU worker (design §4): the IOAPIC
/// lives on the device host, so the vector goes onto this worker's EOI
/// ring and the host doorbell wakes main to replay ioapic::remote_eoi on
/// the chipset instance. A full ring spins until the host drains — the
/// host is woken on every retry, so this is bounded by one main-thread
/// wake.
pub unsafe fn eoi_forward(vector: u8) {
    let index = mailbox_record_index();
    while !smpctl::eoi_ring_push(index, vector as i32) {
        smpctl::host_doorbell_post(total());
    }
    smpctl::host_doorbell_post(total());
}

/// Wake the device host (routing-snapshot change, level EOI).
pub unsafe fn notify_host() { smpctl::host_doorbell_post(total()); }

// ---- 8259 wire (design §4: ExtINT stays wired to vCPU 0) ----

/// handle_irqs' PIC leg via the `pic_acknowledge_hook!` seam.
pub unsafe fn pic_acknowledge() -> Option<u8> {
    match role() {
        Role::None => pic::pic_acknowledge_irq(),
        // the device host never acknowledges: no guest executes on main
        Role::Host => None,
        Role::VcpuWorker(0) => {
            if smpctl::pic_pending_take(0) != 0 {
                let vector = smpctl::mailbox_rpc(0, smpctl::MAILBOX_OP_PIC_ACK, 0, 0, 0, 0);
                if vector >= 0 {
                    return Some(vector as u8);
                }
            }
            None
        },
        // handle_irqs gates on vcpu::current() == 0, so this arm is
        // unreachable; keep it total
        Role::VcpuWorker(_) => None,
    }
}

/// wake_bsp_if_pic_requested's condition via the `wake_bsp_hook!` seam:
/// on the device host an asserting 8259 becomes a PIC flag + doorbell to
/// the BSP worker; in a vCPU worker the local 8259 is not authoritative
/// (PIC ports are forwarded), so never wake from here.
pub unsafe fn wake_bsp_filter() -> bool {
    match role() {
        Role::None => vcpu::count() > 1 && pic::has_requested_irq(),
        Role::Host => {
            if pic::has_requested_irq() {
                smpctl::pic_pending_set(0);
                smpctl::doorbell_post(0);
            }
            false
        },
        Role::VcpuWorker(_) => false,
    }
}

// ---- cross-worker JIT shootdown producers (design §9 W3 note) ----

/// A write invalidated (or would have invalidated) code for `page`: post
/// a dirty event to every other worker WHOSE SHARED CODE BITMAP marks the
/// page — a worker without the bit has no installed code and no in-flight
/// compile there (bits are set before the compiler reads the page's
/// bytes), so it has nothing to invalidate. The probe is a seq-cst RMW
/// (code_bitmap_check_rmw): its release leg publishes the guest write
/// that triggered this post, so a compiler whose bit-set lands after the
/// probe reads the fresh bytes — the case the former unconditional
/// broadcast covered by always delivering the event. Measured effect: in
/// the Ghostty appliance's shader-compile phase the broadcast form
/// posted 10k-50k events/s per worker, and the flood's inbox overflows
/// put every worker into perpetual clear-all recovery (each overflow
/// nukes the consumer's whole JIT cache, whose recompile burst floods
/// the peers in turn). `no_local_code` (the caller's post-invalidation
/// jit_page_has_code) clears the local TLB has-code bit so a burst of
/// writes to the same page posts only once — the bit is re-armed by the
/// next protect event or TLB refill.
pub fn post_dirty_page_with(no_local_code: bool, page: Page) {
    unsafe {
        let own = match role() {
            Role::None => return,
            Role::VcpuWorker(i) => i as i32,
            Role::Host => -1,
        };
        let n = total();
        let ms = memory_size();
        let page_number = page.to_u32();
        for i in 0..n {
            if i as i32 != own && smpctl::code_bitmap_check_rmw(n, i, ms, page_number) {
                smpctl::jit_inbox_push(i, page_number as i32);
                smpctl::doorbell_post(i);
            }
        }
        if own >= 0 && no_local_code {
            cpu::tlb_set_has_code(page, false);
        }
    }
}

// ---- deferred dirty posts: the store-before-probe ordering rule ----
//
// code_bitmap_check_rmw's contract (smpctl.rs) is that the guest store
// whose invalidation is being published must be GLOBALLY VISIBLE BEFORE
// the probe runs — the probe's seq-cst RMW is precisely what orders it
// ahead of a racing compiler's bit-set, so that a compiler we fail to
// notice reads the fresh bytes. Every guest-RAM write site, however,
// naturally reads "invalidate, then store": the local invalidation has
// to happen first (it is what makes the page writable again), and the
// cross-worker post used to ride along with it — i.e. BEFORE the store,
// exactly inverting the required order. The window is not bounded by a
// slice: the peer can compile stale bytes and never be told.
//
// The split below fixes that without reordering the LOCAL invalidation
// (which stays where it always was, so nothing about JIT-cache
// semantics moves): `jit_dirty_page_deferred` (jit.rs) invalidates
// locally and QUEUES the probe+post, and `flush_dirty_posts` publishes
// the queue. Call sites run the flush immediately after their store, so
// for them the queue is one entry deep and the post happens microseconds
// later than before, now correctly ordered. The one site whose store is
// emitted by the JIT rather than performed in Rust
// (translate_address_write_jit: it hands a physical address back to
// generated code, which then stores) has no such adjacent flush point;
// its post is published by the two backstops that bound how long a
// queued invalidation may stay invisible to a peer:
//
//   - before any shared IPI send (apic.rs write_icr0_shared /
//     deliver_shared), preserving the "a cross-modifying writer posts
//     its dirt strictly before its IPI" contract that main_loop_worker's
//     step ordering relies on — this is what makes the architectural
//     cross-modifying-code handshake sound;
//   - at the slice boundary in main_loop_worker, so nothing is queued
//     across a park.
//
// Both backstops are exactly the points at which the design's already
// documented sub-slice residual window closes, so a queued post is never
// weaker than the residual the phase already accepts.
const DEFERRED_DIRTY_CAP: usize = 8;
static mut DEFERRED_DIRTY: [(u32, bool); DEFERRED_DIRTY_CAP] = [(0, false); DEFERRED_DIRTY_CAP];
static mut DEFERRED_DIRTY_LEN: usize = 0;

/// Queue a probe+post for `page` (see above). Cheap no-op outside worker
/// roles, matching post_dirty_page_with's Role::None early return.
pub fn defer_dirty_post(no_local_code: bool, page: Page) {
    unsafe {
        if !role_active() {
            return;
        }
        if DEFERRED_DIRTY_LEN >= DEFERRED_DIRTY_CAP {
            // cannot happen with the current call sites (each flushes
            // right after its store, so the queue holds at most the two
            // pages of one page-crossing access); publishing immediately
            // is the historical behavior, never worse than dropping
            post_dirty_page_with(no_local_code, page);
            return;
        }
        DEFERRED_DIRTY[DEFERRED_DIRTY_LEN] = (page.to_u32(), no_local_code);
        DEFERRED_DIRTY_LEN += 1;
    }
}

/// Publish everything `defer_dirty_post` queued. Must be called AFTER the
/// store the queued entries describe.
pub fn flush_dirty_posts() {
    unsafe {
        if DEFERRED_DIRTY_LEN == 0 {
            return;
        }
        let len = DEFERRED_DIRTY_LEN;
        DEFERRED_DIRTY_LEN = 0;
        for k in 0..len {
            let (page_number, no_local_code) = DEFERRED_DIRTY[k];
            post_dirty_page_with(no_local_code, Page::page_of(page_number << 12));
        }
    }
}

/// Compile start (jit_analyze_and_generate, once the compile's page set
/// is known and before codegen re-reads the guest bytes): mark the pages
/// in this worker's code bitmap and send protect events so the other
/// workers' future writes take the dirty-notify path.
pub fn protect_pages(pages: &std::collections::HashSet<Page>) {
    unsafe {
        let own = match role() {
            Role::VcpuWorker(i) => i,
            _ => return,
        };
        let n = total();
        let ms = memory_size();
        for page in pages {
            let p = page.to_u32();
            smpctl::code_bitmap_set(n, own, ms, p);
            for i in 0..n {
                if i != own {
                    smpctl::jit_inbox_push(i, (p | smpctl::JIT_EVENT_PROTECT_BIT) as i32);
                }
            }
        }
        for i in 0..n {
            if i != own {
                smpctl::doorbell_post(i);
            }
        }
    }
}

/// Local invalidation removed installed code for `page`: retire the
/// bitmap bit (jit_dirty_page_ctx's pages-with-code branch, via the
/// `jit_invalidate_page_hook!` seam).
pub fn page_invalidated(page: Page) {
    unsafe {
        if let Role::VcpuWorker(i) = role() {
            smpctl::code_bitmap_clear(total(), i, memory_size(), page.to_u32());
        }
    }
}

/// TLB-fill consult (cpu.rs `page_has_code_hook!` seam): does any OTHER
/// instance have (or is compiling) code in the page of this phys address?
pub fn remote_page_has_code(phys: u32) -> bool {
    unsafe {
        match role() {
            Role::VcpuWorker(i) => {
                smpctl::code_bitmap_any_other(total(), i, memory_size(), phys >> 12)
            },
            _ => false,
        }
    }
}

// ---- device-host exports (main-thread side of the (b) wire) ----
//
// The mailbox dispatch and the host service loop call these on the MAIN
// instance, whose Rust PIC/IOAPIC are the authoritative chipset: port I/O
// goes through cpu::io_port_* so the 8259 port intercepts hit the real
// PIC (io.js has no handlers for those ports), and the EOI/reevaluate
// entry points replay worker notifications into the IOAPIC.

#[no_mangle]
pub fn host_io_port_read8(port: i32) -> i32 { cpu::io_port_read8(port) }
#[no_mangle]
pub fn host_io_port_read16(port: i32) -> i32 { cpu::io_port_read16(port) }
#[no_mangle]
pub fn host_io_port_read32(port: i32) -> i32 { cpu::io_port_read32(port) }
#[no_mangle]
pub fn host_io_port_write8(port: i32, value: i32) { cpu::io_port_write8(port, value) }
#[no_mangle]
pub fn host_io_port_write16(port: i32, value: i32) { cpu::io_port_write16(port, value) }
#[no_mangle]
pub fn host_io_port_write32(port: i32, value: i32) { cpu::io_port_write32(port, value) }

/// The BSP worker's PIC-ack RPC target: acknowledge from the
/// authoritative 8259 and answer the vector, or -1 when nothing is
/// pending (a spurious flag).
#[no_mangle]
pub fn host_pic_acknowledge() -> i32 { pic::pic_acknowledge_irq().map_or(-1, |v| v as i32) }

/// Whether the 8259 still asserts INTR (the host re-posts the PIC flag
/// after a serviced acknowledge when more requests are pending).
#[no_mangle]
pub fn host_pic_has_requested() -> u32 { pic::has_requested_irq() as u32 }

/// Replay a worker's level-EOI (drained from its eoi_ring) into the
/// authoritative IOAPIC; re-delivery routes through apic::route's shared
/// leg back into the pending bitmaps.
#[no_mangle]
pub fn host_remote_eoi(vector: u32) {
    crate::cpu::ioapic::remote_eoi(&mut apic::get_apics()[..], vector as u8);
}

/// Re-run delivery for IOAPIC lines still requesting service: called
/// after a worker published a routing-snapshot change (LDR/DFR/APIC-ID
/// writes), the cross-worker twin of the same-instance
/// ioapic::reevaluate call in write_routing_register.
#[no_mangle]
pub fn host_chipset_reevaluate() { crate::cpu::ioapic::reevaluate(&mut apic::get_apics()[..]); }
