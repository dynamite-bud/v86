#!/usr/bin/env node

// XWAH-37: index/data register pairs must not be split across workers.
//
// An index/data pair is two addresses where the first selects which
// register the second one names. Under worker-per-vCPU execution each half
// of the pair forwards to the device host as its own mailbox RPC, so two
// workers' pairs can interleave and land one worker's data write in the
// register the other worker selected (see the audit comment above the pair
// constants in src/browser/smp_host_core.js).
//
// The bug was found as a once-in-~20-runs "TODO: Invalid vector: 0" assert
// out of tests/threads/vcpu-workers-smp.js, which is far too rare to gate
// on. This test instead drives the production dispatch — the same
// `install_smp_host_core` the two hosts install — directly, in the exact
// interleaved order, against device models that mirror the real register
// semantics (ioapic.rs write32_internal, rtc.js port 0x70/0x71). That makes
// the regression deterministic: every assertion below fails on a tree
// without the fix, rather than one run in twenty.
//
// Asserts:
//   - the interleaving from the issue leaves each worker's data in ITS OWN
//     register, for the IOAPIC (MMIO) and the CMOS (port I/O) pair,
//   - reads through the data window are serialized the same way,
//   - a worker that has not selected an index keeps the historical
//     behaviour (it uses whatever the device currently holds),
//   - a single-worker host issues byte-for-byte the device-access sequence
//     it issued before the fix — no replay where no interleaving is
//     possible.

import assert from "node:assert/strict";
import {
    install_smp_host_core,
    IOAPIC_MEM_ADDRESS, IOAPIC_IOREGSEL, IOAPIC_IOWIN,
    CMOS_INDEX_PORT, CMOS_DATA_PORT,
} from "../../src/browser/smp_host_core.js";
import {
    MAILBOX_OP_OUT, MAILBOX_OP_IN,
    MAILBOX_OP_MMAP_READ, MAILBOX_OP_MMAP_WRITE,
} from "../../src/browser/smpctl.js";

process.on("unhandledRejection", exn => { throw exn; });

const IOAPIC_FIRST_IRQ_REG = 0x10;
const IOAPIC_IRQ_COUNT = 24;

// the two redirection entries from the issue's reproduction
const ENTRY_A = 1;
const ENTRY_B = 7;
// low (config) dword of entry n, the IOREGSEL value naming it
const config_reg = n => IOAPIC_FIRST_IRQ_REG + 2 * n;

// distinguishable payloads: a real config word carries the vector in the
// low byte, which is what the mis-programming corrupts
const VALUE_A = 0x00000031;
const VALUE_B = 0x0000A047;

/**
 * The IOAPIC's register file as ioapic.rs models it: one IOREGSEL, and an
 * IOWIN whose meaning is whatever IOREGSEL currently names. `ops` records
 * every access the host made, so a test can assert on the sequence and not
 * only on the end state.
 */
function make_ioapic(ops)
{
    const config = new Int32Array(IOAPIC_IRQ_COUNT);
    let ioregsel = 0;

    // addresses cross the mailbox as signed int32, the way Rust hands them
    // over, so normalize exactly as the host does
    const reg_of = addr => (addr >>> 0) - IOAPIC_MEM_ADDRESS;

    const selected_entry = () =>
    {
        const sel = ioregsel;
        if(sel < IOAPIC_FIRST_IRQ_REG ||
            sel >= IOAPIC_FIRST_IRQ_REG + 2 * IOAPIC_IRQ_COUNT ||
            (sel & 1) !== 0)
        {
            return -1;
        }
        return sel - IOAPIC_FIRST_IRQ_REG >> 1;
    };

    return {
        config,
        write32: (addr, value) =>
        {
            ops.push(["write32", addr, value]);
            const reg = reg_of(addr);
            if(reg === IOAPIC_IOREGSEL)
            {
                ioregsel = value >>> 0;
            }
            else if(reg === IOAPIC_IOWIN)
            {
                const irq = selected_entry();
                assert.notEqual(irq, -1, "IOWIN write with a non-entry IOREGSEL");
                config[irq] = value;
            }
        },
        read32s: addr =>
        {
            ops.push(["read32s", addr]);
            if(reg_of(addr) === IOAPIC_IOREGSEL)
            {
                return ioregsel;
            }
            const irq = selected_entry();
            assert.notEqual(irq, -1, "IOWIN read with a non-entry IOREGSEL");
            return config[irq];
        },
        read8: () => 0,
        read16: () => 0,
        write8: () => {},
        write16: () => {},
    };
}

/** The CMOS as rtc.js models it: `cmos_index` from 0x70, data at 0x71. */
function make_cmos(ops)
{
    const cmos = new Uint8Array(0x80);
    let cmos_index = 0;

    return {
        cmos,
        write8: (port, value) =>
        {
            ops.push(["write8", port, value]);
            if(port === CMOS_INDEX_PORT)
            {
                cmos_index = value & 0x7F;
            }
            else if(port === CMOS_DATA_PORT)
            {
                cmos[cmos_index] = value;
            }
        },
        read8: port =>
        {
            ops.push(["read8", port]);
            return port === CMOS_DATA_PORT ? cmos[cmos_index] : 0xFF;
        },
        read16: () => 0,
        read32: () => 0,
        write16: () => {},
        write32: () => {},
    };
}

const host_proto = {};
install_smp_host_core(host_proto);

/** A device host with `workers` workers over the two device models. */
function make_host(workers)
{
    const ops = [];
    const host = Object.create(host_proto);
    const ioapic = make_ioapic(ops);
    const cmos = make_cmos(ops);
    host.init_core(
        ioapic,
        { send: () => {} },
        { buffer: new ArrayBuffer(64) },
        workers,
        workers);
    host.io = cmos;
    // dispatch(requester, op, addr, size, value_lo, ...)
    host.rpc = (requester, op, addr, size, value) =>
        host.dispatch(requester, op, addr, size, value, 0, 0, 0, 0);
    host.ops = ops;
    host.ioapic = ioapic;
    host.cmos = cmos;
    return host;
}

// signed int32, the form a worker's mailbox record carries
const IOREGSEL_ADDR = IOAPIC_MEM_ADDRESS + IOAPIC_IOREGSEL | 0;
const IOWIN_ADDR = IOAPIC_MEM_ADDRESS + IOAPIC_IOWIN | 0;

// ---- 1. the interleaving from the issue, over MMIO ----
{
    const host = make_host(2);

    // worker 0 selects its entry; worker 1 clobbers the selector before
    // worker 0 gets to its data write
    host.rpc(0, MAILBOX_OP_MMAP_WRITE, IOREGSEL_ADDR, 4, config_reg(ENTRY_A));
    host.rpc(1, MAILBOX_OP_MMAP_WRITE, IOREGSEL_ADDR, 4, config_reg(ENTRY_B));
    host.rpc(0, MAILBOX_OP_MMAP_WRITE, IOWIN_ADDR, 4, VALUE_A);
    host.rpc(1, MAILBOX_OP_MMAP_WRITE, IOWIN_ADDR, 4, VALUE_B);

    assert.equal(host.ioapic.config[ENTRY_A], VALUE_A,
        "worker 0's config landed in worker 0's redirection entry");
    assert.equal(host.ioapic.config[ENTRY_B], VALUE_B,
        "worker 1's config landed in worker 1's redirection entry");

    // and the data window reads back per worker, in the same interleaving
    assert.equal(host.rpc(0, MAILBOX_OP_MMAP_READ, IOWIN_ADDR, 4, 0), VALUE_A);
    assert.equal(host.rpc(1, MAILBOX_OP_MMAP_READ, IOWIN_ADDR, 4, 0), VALUE_B);
    assert.equal(host.rpc(0, MAILBOX_OP_MMAP_READ, IOWIN_ADDR, 4, 0), VALUE_A,
        "worker 0 still sees its own entry after worker 1 read");

    // a worker reading the selector back sees the one it wrote
    assert.equal(host.rpc(0, MAILBOX_OP_MMAP_READ, IOREGSEL_ADDR, 4, 0),
        config_reg(ENTRY_A));
}

// ---- 2. every interleaving of one pair each ----
// exhaustive over the orders the two workers' four RPCs can arrive in,
// with each worker's own two RPCs kept in program order
{
    const orders = [
        [0, 0, 1, 1],
        [0, 1, 0, 1],
        [0, 1, 1, 0],
        [1, 0, 0, 1],
        [1, 0, 1, 0],
        [1, 1, 0, 0],
    ];
    for(const order of orders)
    {
        const host = make_host(2);
        const issued = [0, 0];
        for(const worker of order)
        {
            const entry = worker === 0 ? ENTRY_A : ENTRY_B;
            const value = worker === 0 ? VALUE_A : VALUE_B;
            if(issued[worker]++ === 0)
            {
                host.rpc(worker, MAILBOX_OP_MMAP_WRITE, IOREGSEL_ADDR, 4,
                    config_reg(entry));
            }
            else
            {
                host.rpc(worker, MAILBOX_OP_MMAP_WRITE, IOWIN_ADDR, 4, value);
            }
        }
        assert.equal(host.ioapic.config[ENTRY_A], VALUE_A,
            "entry A under arrival order " + order.join(""));
        assert.equal(host.ioapic.config[ENTRY_B], VALUE_B,
            "entry B under arrival order " + order.join(""));
    }
}

// ---- 3. the same interleaving over the CMOS port pair ----
{
    const host = make_host(2);
    const INDEX_A = 0x0A;
    const INDEX_B = 0x32;

    host.rpc(0, MAILBOX_OP_OUT, CMOS_INDEX_PORT, 1, INDEX_A);
    host.rpc(1, MAILBOX_OP_OUT, CMOS_INDEX_PORT, 1, INDEX_B);
    host.rpc(0, MAILBOX_OP_OUT, CMOS_DATA_PORT, 1, 0x5A);
    host.rpc(1, MAILBOX_OP_OUT, CMOS_DATA_PORT, 1, 0xA5);

    assert.equal(host.cmos.cmos[INDEX_A], 0x5A, "worker 0's CMOS byte");
    assert.equal(host.cmos.cmos[INDEX_B], 0xA5, "worker 1's CMOS byte");
    assert.equal(host.rpc(0, MAILBOX_OP_IN, CMOS_DATA_PORT, 1, 0), 0x5A);
    assert.equal(host.rpc(1, MAILBOX_OP_IN, CMOS_DATA_PORT, 1, 0), 0xA5);
}

// ---- 4. a worker that never selected an index keeps the old behaviour ----
{
    const host = make_host(2);
    host.rpc(0, MAILBOX_OP_MMAP_WRITE, IOREGSEL_ADDR, 4, config_reg(ENTRY_A));
    // worker 1 has no index of its own: its data write uses whatever the
    // device holds, exactly as before the fix
    host.rpc(1, MAILBOX_OP_MMAP_WRITE, IOWIN_ADDR, 4, VALUE_B);
    assert.equal(host.ioapic.config[ENTRY_A], VALUE_B,
        "an unselected worker follows the device's live selector");
}

// ---- 5. forgetting the shadows returns every worker to that path ----
{
    const host = make_host(2);
    host.rpc(0, MAILBOX_OP_MMAP_WRITE, IOREGSEL_ADDR, 4, config_reg(ENTRY_A));
    host.forget_index_shadows();
    host.rpc(1, MAILBOX_OP_MMAP_WRITE, IOREGSEL_ADDR, 4, config_reg(ENTRY_B));
    host.rpc(0, MAILBOX_OP_MMAP_WRITE, IOWIN_ADDR, 4, VALUE_A);
    assert.equal(host.ioapic.config[ENTRY_B], VALUE_A,
        "a dropped shadow replays nothing");
}

// ---- 6. one worker issues exactly the historical access sequence ----
// no interleaving is possible with a single worker, so the mechanism must
// stay entirely off the path — topology (c) and cpus=1 machines are
// unchanged
{
    const single = make_host(1);
    single.rpc(0, MAILBOX_OP_MMAP_WRITE, IOREGSEL_ADDR, 4, config_reg(ENTRY_A));
    single.rpc(0, MAILBOX_OP_MMAP_WRITE, IOWIN_ADDR, 4, VALUE_A);
    single.rpc(0, MAILBOX_OP_MMAP_READ, IOWIN_ADDR, 4, 0);
    single.rpc(0, MAILBOX_OP_OUT, CMOS_INDEX_PORT, 1, 0x0A);
    single.rpc(0, MAILBOX_OP_OUT, CMOS_DATA_PORT, 1, 0x5A);
    single.rpc(0, MAILBOX_OP_IN, CMOS_DATA_PORT, 1, 0);

    assert.deepEqual(single.ops, [
        ["write32", IOREGSEL_ADDR, config_reg(ENTRY_A)],
        ["write32", IOWIN_ADDR, VALUE_A],
        ["read32s", IOWIN_ADDR],
        ["write8", CMOS_INDEX_PORT, 0x0A],
        ["write8", CMOS_DATA_PORT, 0x5A],
        ["read8", CMOS_DATA_PORT],
    ], "a single-worker host replays no index");
}

// ---- 7. an uninvolved access never pays for the mechanism ----
{
    const host = make_host(2);
    host.rpc(0, MAILBOX_OP_MMAP_WRITE, IOREGSEL_ADDR, 4, config_reg(ENTRY_A));
    host.ops.length = 0;
    const SVGA_LFB = 0xFEB00000 | 0;
    host.rpc(0, MAILBOX_OP_OUT, 0x3F8, 1, 0x41);
    host.rpc(0, MAILBOX_OP_MMAP_WRITE, SVGA_LFB, 4, 0);
    assert.deepEqual(host.ops, [
        ["write8", 0x3F8, 0x41],
        ["write32", SVGA_LFB, 0],
    ], "unrelated ports and MMIO windows are untouched");
}

// ---- 8. widths the devices ignore never move the shadow ----
// memory.rs routes only write32/read8/read32s into the IOAPIC, and io.js
// leaves 0x70's write16/write32 at empty_port_write, so those accesses
// never reach the register file. Treating one as an index write would
// remember a selector the device never took, and replaying it later would
// change what the guest reads.
{
    const host = make_host(2);

    // a 16-bit write to the CMOS index port is a no-op in v86
    host.rpc(0, MAILBOX_OP_OUT, CMOS_INDEX_PORT, 2, 0x0A);
    host.rpc(1, MAILBOX_OP_OUT, CMOS_INDEX_PORT, 1, 0x32);
    host.ops.length = 0;
    host.rpc(0, MAILBOX_OP_IN, CMOS_DATA_PORT, 1, 0);
    assert.deepEqual(host.ops, [["read8", CMOS_DATA_PORT]],
        "an ignored wide index write leaves worker 0 on the historical path");

    // likewise a narrow write into the IOAPIC selector, which memory.rs
    // sends to the JS memory map rather than to the register file
    host.rpc(0, MAILBOX_OP_MMAP_WRITE, IOREGSEL_ADDR, 1, config_reg(ENTRY_A));
    host.rpc(1, MAILBOX_OP_MMAP_WRITE, IOREGSEL_ADDR, 4, config_reg(ENTRY_B));
    host.ops.length = 0;
    host.rpc(0, MAILBOX_OP_MMAP_WRITE, IOWIN_ADDR, 4, VALUE_A);
    assert.deepEqual(host.ops, [["write32", IOWIN_ADDR, VALUE_A]],
        "an ignored narrow selector write replays nothing");
    assert.equal(host.ioapic.config[ENTRY_B], VALUE_A,
        "and the write follows the device's live selector");
}

console.log("index-data-pairs: ok");
