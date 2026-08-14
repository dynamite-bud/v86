// XWAH-9 Phase 4 Stage W1: JS mirror of the shared control region
// (src/rust/cpu/smpctl.rs — the authoritative layout; keep the two in
// lockstep, the worker-skeleton test compares every offset through the
// get_smpctl_offset/get_smpctl_size probe exports) plus the Atomics helpers
// both sides of the worker runtime use.
//
// The control region lives inside the imported guest memory at
//   CTL_BASE = memory_size + CTL_BASE_GAP
// (the next wasm-page boundary after the JIT scratch page). JS reaches it as
// an Int32Array view over the guest memory's SharedArrayBuffer; all
// cross-thread cells are u32s at 4-byte-aligned offsets, so `byte >> 2` maps
// a layout offset to a view index.
//
// The mailbox client/server below are the Layer A protocol of
// tests/threads/mailbox-protocol.js, extracted verbatim so that test now
// imports from here and stays normative by usage: the record's plain field
// writes are published by a seq-cst Atomics.store on STATE (the only
// atomically-waited cell), the vCPU side blocks in Atomics.wait, the device
// host side is non-blocking (Atomics.waitAsync re-arm loop).

export const CTL_CACHE_LINE = 64;
export const CTL_BASE_GAP = 0x10000;
export const CTL_VCPU_STRIDE = 0x340;

// per-vCPU field byte offsets (relative to the vCPU's block)
export const CTL_DOORBELL = 0x000;
export const CTL_RUN_STATE_PUB = 0x040;
export const CTL_HEARTBEAT = 0x044;
export const CTL_INSN_PUB = 0x048;
export const CTL_COMMAND = 0x080;
export const CTL_PIC_PENDING = 0x084;
export const CTL_PENDING_IRR = 0x0C0;
export const CTL_PENDING_TMR = 0x100;
export const CTL_IPI_SPECIAL = 0x140;
export const CTL_EOI_RING = 0x180;
export const CTL_MAILBOX = 0x200;
export const CTL_JIT_INBOX = 0x240;

export const CTL_PENDING_WORDS = 8;
export const CTL_EOI_RING_CAP = 16;
export const CTL_MAILBOX_BYTES = 64;

// jit_inbox sub-offsets (relative to CTL_JIT_INBOX) and event encoding
// (W3, docs/smp-phase4-design.md §9 W3 note)
export const CTL_JIT_INBOX_LOCK = 0x00;
export const CTL_JIT_INBOX_HEAD = 0x04;
export const CTL_JIT_INBOX_OVERFLOW = 0x08;
export const CTL_JIT_INBOX_TAIL = 0x40;
export const CTL_JIT_INBOX_SLOTS = 0x80;
export const CTL_JIT_INBOX_CAP = 32;
export const CTL_JIT_EVENT_PROTECT_BIT = 1 << 24;

// routing entry field byte offsets (relative to the entry)
export const CTL_ROUTING_APIC_ID = 0x00;
export const CTL_ROUTING_LDR = 0x04;
export const CTL_ROUTING_DFR = 0x08;
export const CTL_ROUTING_TPR = 0x0C;
export const CTL_ROUTING_ENABLED = 0x10;
export const CTL_ROUTING_RUNNABLE = 0x14;
export const CTL_ROUTING_ENTRY_STRIDE = 0x40;

// machine field byte offsets (relative to the machine block)
export const CTL_MACHINE_TSC_OFFSET = 0x00;
export const CTL_MACHINE_BUSLOCK = 0x40;
export const CTL_MACHINE_JIT_DIRTY_RING = 0x80;
export const CTL_MACHINE_DEV_IRQ_RING = 0x1C0;
export const CTL_MACHINE_HOST_DOORBELL = 0x600;
export const CTL_MACHINE_SIZE = 0x640;
export const CTL_JIT_DIRTY_RING_CAP = 64;
export const CTL_DEV_IRQ_RING_CAP = 256;

// ring layout (jit_dirty and dev_irq rings): head, tail, then the slots
export const CTL_RING_HEAD = 0x0;
export const CTL_RING_TAIL = 0x4;
export const CTL_RING_SLOTS = 0x8;

// dev_irq ring event encoding (topology (c), design §9 W2 note): irq number
// in the low byte, bit 8 = raise (clear = lower)
export const CTL_DEV_IRQ_RAISE_BIT = 1 << 8;

// command[i] values (quiesce protocol, design §8; RESET is the W2
// machine-reboot request, acked by the worker writing RUN back)
export const CTL_COMMAND_RUN = 0;
export const CTL_COMMAND_PARK_REQ = 1;
export const CTL_COMMAND_PARKED_ACK = 2;
export const CTL_COMMAND_TERMINATE = 3;
export const CTL_COMMAND_RESET = 4;

// run_state_pub values: RunState (vcpu.rs) plus the published-only Halted
export const CTL_RUN_STATE_RUNNABLE = 0;
export const CTL_RUN_STATE_WAIT_FOR_SIPI = 1;
export const CTL_RUN_STATE_PARKED = 2;
export const CTL_RUN_STATE_HALTED = 3;

/**
 * Byte offset of the routing table relative to CTL_BASE.
 * @param {number} n
 */
export function ctl_routing_offset(n)
{
    return n * CTL_VCPU_STRIDE;
}

/**
 * Byte offset of routing entry i relative to CTL_BASE.
 * @param {number} n
 * @param {number} i
 */
export function ctl_routing_entry_offset(n, i)
{
    return ctl_routing_offset(n) + CTL_CACHE_LINE + i * CTL_ROUTING_ENTRY_STRIDE;
}

/**
 * Byte offset of the machine block relative to CTL_BASE.
 * @param {number} n
 */
export function ctl_machine_offset(n)
{
    return ctl_routing_offset(n) + CTL_CACHE_LINE + n * CTL_ROUTING_ENTRY_STRIDE;
}

/**
 * Const-part control-region size in bytes for n vCPUs (everything except
 * the memory-size-scaled code bitmaps). Must equal the Rust
 * get_smpctl_size(n) export.
 * @param {number} n
 */
export function ctl_size(n)
{
    return ctl_machine_offset(n) + CTL_MACHINE_SIZE;
}

/**
 * Per-vCPU code-page bitmap stride in bytes (W3): one bit per guest phys
 * page, rounded up to whole cache lines. Must equal the Rust
 * code_bitmap_stride.
 * @param {number} memory_size
 */
export function ctl_code_bitmap_stride(memory_size)
{
    return (memory_size >> 15) + CTL_CACHE_LINE - 1 & ~(CTL_CACHE_LINE - 1);
}

/**
 * Byte offset of vCPU i's code-page bitmap relative to CTL_BASE. Must
 * equal the Rust get_smpctl_code_bitmap_offset(i, n) export.
 * @param {number} n
 * @param {number} i
 * @param {number} memory_size
 */
export function ctl_code_bitmap_offset(n, i, memory_size)
{
    return ctl_size(n) + i * ctl_code_bitmap_stride(memory_size);
}

/**
 * Total control-region size, code bitmaps included. Must equal the Rust
 * get_smpctl_total_size(n) export.
 * @param {number} n
 * @param {number} memory_size
 */
export function ctl_total_size(n, memory_size)
{
    return ctl_size(n) + n * ctl_code_bitmap_stride(memory_size);
}

/**
 * Control-region size in whole 64K wasm pages (what starter.js adds to the
 * guest memory when worker mode is requested).
 * @param {number} n
 * @param {number} memory_size
 */
export function ctl_pages(n, memory_size)
{
    return Math.ceil(ctl_total_size(n, memory_size) / 0x10000);
}

/**
 * CTL_BASE for a given guest-RAM size. Must equal the Rust get_smpctl_base()
 * export of an instance whose memory_size global is set to memory_size.
 * @param {number} memory_size
 */
export function ctl_base_for(memory_size)
{
    return memory_size + CTL_BASE_GAP;
}

// field ids of the get_smpctl_offset probe export (smpctl.rs); the
// worker-skeleton test iterates over these to prove the two layouts agree
export const SMPCTL_PROBE_FIELD_COUNT = 15;

/**
 * JS twin of the Rust get_smpctl_offset(field, i, n) probe export.
 * @param {number} field
 * @param {number} i
 * @param {number} n
 */
export function ctl_probe_offset(field, i, n)
{
    const vcpu = i * CTL_VCPU_STRIDE;
    switch(field)
    {
        case 0: return vcpu + CTL_DOORBELL;
        case 1: return vcpu + CTL_RUN_STATE_PUB;
        case 2: return vcpu + CTL_HEARTBEAT;
        case 3: return vcpu + CTL_COMMAND;
        case 4: return vcpu + CTL_PENDING_IRR;
        case 5: return vcpu + CTL_PENDING_TMR;
        case 6: return vcpu + CTL_IPI_SPECIAL;
        case 7: return vcpu + CTL_EOI_RING;
        case 8: return vcpu + CTL_MAILBOX;
        case 9: return ctl_routing_offset(n);
        case 10: return ctl_routing_entry_offset(n, i);
        case 11: return ctl_machine_offset(n) + CTL_MACHINE_TSC_OFFSET;
        case 12: return ctl_machine_offset(n) + CTL_MACHINE_BUSLOCK;
        case 13: return ctl_machine_offset(n) + CTL_MACHINE_JIT_DIRTY_RING;
        case 14: return ctl_machine_offset(n) + CTL_MACHINE_DEV_IRQ_RING;
        default: return -1 >>> 0;
    }
}

// ---- doorbell / run state / command helpers ----
//
// All take the Int32Array view over the guest memory's SharedArrayBuffer
// plus the CTL_BASE byte offset — never a subarray, so layout offsets stay
// absolute.

/**
 * Post vCPU i's doorbell: bump the version counter and wake any waiter.
 * Returns the pre-post counter value.
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 */
export function doorbell_post(i32, ctl_base, i)
{
    const w = ctl_base + i * CTL_VCPU_STRIDE + CTL_DOORBELL >> 2;
    const old = Atomics.add(i32, w, 1);
    Atomics.notify(i32, w);
    return old;
}

/**
 * Read vCPU i's doorbell counter (the "seen" value a parked worker passes to
 * doorbell_wait).
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 */
export function doorbell_read(i32, ctl_base, i)
{
    return Atomics.load(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_DOORBELL >> 2);
}

/**
 * Park on vCPU i's doorbell until it moves past `seen` (worker threads only:
 * Atomics.wait throws on a browser main thread). Returns the Atomics.wait
 * outcome string.
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 * @param {number} seen
 * @param {number} timeout_ms
 */
export function doorbell_wait(i32, ctl_base, i, seen, timeout_ms)
{
    return Atomics.wait(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_DOORBELL >> 2, seen, timeout_ms);
}

/**
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 * @param {number} state
 */
export function run_state_publish(i32, ctl_base, i, state)
{
    Atomics.store(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_RUN_STATE_PUB >> 2, state);
}

/**
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 */
export function run_state_read(i32, ctl_base, i)
{
    return Atomics.load(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_RUN_STATE_PUB >> 2);
}

/**
 * Bump vCPU i's wake counter (W1 skeleton liveness diagnostic).
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 */
export function heartbeat_publish(i32, ctl_base, i)
{
    return Atomics.add(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_HEARTBEAT >> 2, 1);
}

/**
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 */
export function heartbeat_read(i32, ctl_base, i)
{
    return Atomics.load(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_HEARTBEAT >> 2);
}

/**
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 */
export function command_read(i32, ctl_base, i)
{
    return Atomics.load(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_COMMAND >> 2);
}

/**
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 * @param {number} command
 */
export function command_write(i32, ctl_base, i, command)
{
    Atomics.store(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_COMMAND >> 2, command);
}

/**
 * Acknowledge a command: replace `expected` with `ack` atomically. Returns
 * false when the command word changed in between.
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 * @param {number} expected
 * @param {number} ack
 */
export function command_ack(i32, ctl_base, i, expected, ack)
{
    const w = ctl_base + i * CTL_VCPU_STRIDE + CTL_COMMAND >> 2;
    return Atomics.compareExchange(i32, w, expected, ack) === expected;
}

// ---- SPSC rings (jit_dirty and dev_irq, machine block) ----
//
// The producer owns head, the consumer owns tail. The slot write is plain;
// the seq-cst head store publishes it (same rule as the mailbox). Byte base
// = ctl_base + ctl_machine_offset(n) + CTL_MACHINE_*_RING.

/**
 * Push one value. Returns false when the ring is full — the caller must
 * queue and retry, never drop (event order is load-bearing).
 * @param {!Int32Array} i32
 * @param {number} ring byte offset of the ring
 * @param {number} cap
 * @param {number} value
 */
export function ring_push(i32, ring, cap, value)
{
    const head = Atomics.load(i32, ring + CTL_RING_HEAD >> 2) >>> 0;
    const tail = Atomics.load(i32, ring + CTL_RING_TAIL >> 2) >>> 0;
    if(((head - tail) >>> 0) >= cap)
    {
        return false;
    }
    i32[ring + CTL_RING_SLOTS + 4 * (head % cap) >> 2] = value;
    Atomics.store(i32, ring + CTL_RING_HEAD >> 2, head + 1 | 0);
    return true;
}

/**
 * Pop one value, or undefined when the ring is empty.
 * @param {!Int32Array} i32
 * @param {number} ring byte offset of the ring
 * @param {number} cap
 */
export function ring_pop(i32, ring, cap)
{
    const tail = Atomics.load(i32, ring + CTL_RING_TAIL >> 2) >>> 0;
    const head = Atomics.load(i32, ring + CTL_RING_HEAD >> 2) >>> 0;
    if(head === tail)
    {
        return undefined;
    }
    const value = i32[ring + CTL_RING_SLOTS + 4 * (tail % cap) >> 2];
    Atomics.store(i32, ring + CTL_RING_TAIL >> 2, tail + 1 | 0);
    return value;
}

// ---- per-vCPU jit inbox (W3, design §9 W3 note) ----
//
// Multi-producer push under the inbox spinlock (the same protocol as the
// Rust smpctl::jit_inbox_push — the device host pushes DMA dirty events
// from here). Overflow sets the flag instead of dropping: the consumer
// recovers with jit_clear_all + full_clear_tlb and the code bitmaps
// re-supply the protection, so nothing needs a JS backlog.

/**
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i target vCPU
 * @param {number} event page number, | CTL_JIT_EVENT_PROTECT_BIT for
 *     protect events
 */
export function jit_inbox_push(i32, ctl_base, i, event)
{
    const inbox = ctl_base + i * CTL_VCPU_STRIDE + CTL_JIT_INBOX;
    while(Atomics.compareExchange(i32, inbox + CTL_JIT_INBOX_LOCK >> 2, 0, 1) !== 0)
    {
    }
    const head = Atomics.load(i32, inbox + CTL_JIT_INBOX_HEAD >> 2) >>> 0;
    const tail = Atomics.load(i32, inbox + CTL_JIT_INBOX_TAIL >> 2) >>> 0;
    if(((head - tail) >>> 0) >= CTL_JIT_INBOX_CAP)
    {
        Atomics.store(i32, inbox + CTL_JIT_INBOX_OVERFLOW >> 2, 1);
    }
    else
    {
        i32[inbox + CTL_JIT_INBOX_SLOTS + 4 * (head % CTL_JIT_INBOX_CAP) >> 2] = event;
        Atomics.store(i32, inbox + CTL_JIT_INBOX_HEAD >> 2, head + 1 | 0);
    }
    Atomics.store(i32, inbox + CTL_JIT_INBOX_LOCK >> 2, 0);
}

// ---- W3 host-side helpers (device host of topology (b)) ----

/**
 * Set vCPU i's 8259-INTR flag (paired with a doorbell_post; the BSP
 * worker xchg-takes it before its PIC-ack RPC).
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 */
export function pic_pending_set(i32, ctl_base, i)
{
    Atomics.store(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_PIC_PENDING >> 2, 1);
}

/**
 * Read vCPU i's published instruction counter (design §8: main sums the
 * cells for the approximate machine-wide counter).
 * @param {!Int32Array} i32
 * @param {number} ctl_base
 * @param {number} i
 */
export function insn_read(i32, ctl_base, i)
{
    return Atomics.load(i32, ctl_base + i * CTL_VCPU_STRIDE + CTL_INSN_PUB >> 2);
}

/**
 * Word index of the machine host_doorbell (workers post it after level
 * EOIs and routing-snapshot changes; the host waitAsyncs on it).
 * @param {number} ctl_base
 * @param {number} n
 */
export function host_doorbell_word(ctl_base, n)
{
    return ctl_base + ctl_machine_offset(n) + CTL_MACHINE_HOST_DOORBELL >> 2;
}

// ---- mailbox (Layer A RPC protocol, tests/threads/mailbox-protocol.js) ----

// 64-byte per-vCPU record, i32-indexed; field indices within the record.
// STATE is the only atomically-waited cell.
export const MAILBOX_STATE = 0;
export const MAILBOX_OP = 1;
export const MAILBOX_ADDR = 2;
export const MAILBOX_SIZE = 3;
export const MAILBOX_VALUE_LO = 4;
export const MAILBOX_VALUE_HI = 5;
export const MAILBOX_SEQ = 6;
// Upper quadword of single-record mmap_write128 RPCs (the W2 wide-op
// surface: SIZE carries the byte width 8/16, VALUE_LO/HI/2/3 the payload)
export const MAILBOX_VALUE_2 = 7;
export const MAILBOX_VALUE_3 = 8;

export const MAILBOX_IDLE = 0;
export const MAILBOX_REQUEST = 1;
export const MAILBOX_RESPONSE = 2;

// op codes: OUT/IN keep the normative Layer A values; mmap ops are the §6
// worker-runtime additions (SIZE carries the access width in bytes);
// IN_REP/OUT_REP are the W2 batched string-I/O ops — one page-bounded
// rep ins/outs batch as ONE RPC (ADDR = port, SIZE = element width,
// VALUE_LO = element count, VALUE_HI = guest-physical buffer; the device
// host performs the per-element port accesses in order against the shared
// guest RAM and answers with the element count). The Rust-side client is
// smpctl.rs mailbox_rpc.
export const MAILBOX_OP_OUT = 1;
export const MAILBOX_OP_IN = 2;
export const MAILBOX_OP_MMAP_READ = 3;
export const MAILBOX_OP_MMAP_WRITE = 4;
export const MAILBOX_OP_IN_REP = 5;
export const MAILBOX_OP_OUT_REP = 6;
// W3 (topology (b), design §4): the BSP worker's 8259 acknowledge RPC —
// the device host answers the acknowledged vector, or -1 when nothing is
// pending
export const MAILBOX_OP_PIC_ACK = 7;

/**
 * Word index of vCPU i's mailbox record within the control-region view.
 * Pass 0 for a bare test record at the start of its own SAB.
 * @param {number} ctl_base
 * @param {number} i
 */
export function mailbox_record_word(ctl_base, i)
{
    return ctl_base + i * CTL_VCPU_STRIDE + CTL_MAILBOX >> 2;
}

/**
 * vCPU side: issue one blocking RPC and return the response's VALUE_LO.
 * Plain field writes, then the seq-cst STATE store publishes them; blocks in
 * Atomics.wait until the device host flips STATE to RESPONSE (worker threads
 * only). Throws on timeout — a dead device host is fail-stop (design §8).
 * Wide mmap writes are single-record (design §9 W2): a 64-bit write carries
 * SIZE=8 with VALUE_LO/VALUE_HI, a 128-bit write SIZE=16 with
 * VALUE_LO/HI/2/3; the device host dispatches them as ordered dword writes
 * (the historical JS mmap_write64/128 dword split).
 * @param {!Int32Array} ctl the view containing the record
 * @param {number} record word index of the record (mailbox_record_word)
 * @param {number} op
 * @param {number} addr
 * @param {number} size
 * @param {number} value
 * @param {number} timeout_ms
 * @param {number=} value_hi
 * @param {number=} value_2
 * @param {number=} value_3
 */
export function mailbox_request(ctl, record, op, addr, size, value, timeout_ms,
                                value_hi, value_2, value_3)
{
    ctl[record + MAILBOX_OP] = op;
    ctl[record + MAILBOX_ADDR] = addr;
    ctl[record + MAILBOX_SIZE] = size;
    ctl[record + MAILBOX_VALUE_LO] = value;
    ctl[record + MAILBOX_VALUE_HI] = value_hi | 0;
    ctl[record + MAILBOX_VALUE_2] = value_2 | 0;
    ctl[record + MAILBOX_VALUE_3] = value_3 | 0;
    Atomics.store(ctl, record + MAILBOX_STATE, MAILBOX_REQUEST);
    Atomics.notify(ctl, record + MAILBOX_STATE);
    while(Atomics.load(ctl, record + MAILBOX_STATE) !== MAILBOX_RESPONSE)
    {
        const outcome = Atomics.wait(ctl, record + MAILBOX_STATE, MAILBOX_REQUEST, timeout_ms);
        if(outcome === "timed-out")
        {
            throw new Error("mailbox: device host never responded");
        }
    }
    const result = ctl[record + MAILBOX_VALUE_LO];
    Atomics.store(ctl, record + MAILBOX_STATE, MAILBOX_IDLE);
    return result;
}

/**
 * Device-host side: service one pending request, if any. The seq-cst STATE
 * load acquires the requester's plain field writes; `handler(op, addr, size,
 * value_lo, value_hi, seq, value_2, value_3)` returns the response value for
 * reads and undefined for writes (the record's VALUE_LO is only written when
 * a value is returned, preserving the Layer A byte behavior). Returns true
 * when a request was serviced.
 * @param {!Int32Array} ctl
 * @param {number} record
 * @param {function(number, number, number, number, number, number, number, number): (number|undefined)} handler
 */
export function mailbox_service(ctl, record, handler)
{
    if(Atomics.load(ctl, record + MAILBOX_STATE) !== MAILBOX_REQUEST)
    {
        return false;
    }
    const result = handler(
        ctl[record + MAILBOX_OP],
        ctl[record + MAILBOX_ADDR],
        ctl[record + MAILBOX_SIZE],
        ctl[record + MAILBOX_VALUE_LO],
        ctl[record + MAILBOX_VALUE_HI],
        ctl[record + MAILBOX_SEQ],
        ctl[record + MAILBOX_VALUE_2],
        ctl[record + MAILBOX_VALUE_3]);
    if(result !== undefined)
    {
        ctl[record + MAILBOX_VALUE_LO] = result | 0;
    }
    Atomics.store(ctl, record + MAILBOX_STATE, MAILBOX_RESPONSE);
    Atomics.notify(ctl, record + MAILBOX_STATE);
    return true;
}

/**
 * Device-host side: park in Atomics.waitAsync until the record's STATE moves
 * (the main thread must never block). A stale snapshot resolves immediately
 * ("not-equal") and the caller just re-inspects. Resolves to false on
 * timeout, true otherwise.
 * @param {!Int32Array} ctl
 * @param {number} record
 * @param {number} timeout_ms
 */
export async function mailbox_wait_for_request(ctl, record, timeout_ms)
{
    const state = Atomics.load(ctl, record + MAILBOX_STATE);
    if(state === MAILBOX_REQUEST)
    {
        return true;
    }
    const waited = Atomics.waitAsync(ctl, record + MAILBOX_STATE, state, timeout_ms);
    if(waited.async)
    {
        const outcome = await waited.value;
        return outcome !== "timed-out";
    }
    return true;
}
