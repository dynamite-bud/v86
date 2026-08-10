#!/usr/bin/env node

import assert from "assert/strict";
import { PCI } from "../../src/pci.js";

const FIRST_DEVICE = 0x30;
const SECOND_DEVICE = 0x68;
const SHARED_IRQ = 10;

function make_device_space()
{
    const space = new Int32Array(64);
    space[0x3C >>> 2] = 1 << 8;
    return space;
}

function make_pci()
{
    const raised = [];
    const lowered = [];
    const pci = Object.create(PCI.prototype);

    pci.cpu = {
        device_raise_irq(irq) { raised.push(irq); },
        device_lower_irq(irq) { lowered.push(irq); },
    };
    pci.device_spaces = new Array(256);
    pci.devices = new Array(256);
    pci.irq_device_state = new Uint8Array(256);
    pci.irq_line_state = new Uint16Array(16);
    pci.isa_bridge_space8 = new Uint8Array(256);
    pci.pci_addr = new Uint8Array(4);
    pci.pci_value = new Uint8Array(4);
    pci.pci_response = new Uint8Array(4);
    pci.pci_status = new Uint8Array(4);

    pci.device_spaces[FIRST_DEVICE] = make_device_space();
    pci.device_spaces[SECOND_DEVICE] = make_device_space();
    pci.devices[FIRST_DEVICE] = { pci_bars: [], name: "first" };
    pci.devices[SECOND_DEVICE] = { pci_bars: [], name: "second" };

    // FIRST_DEVICE routes through PIRQ B and SECOND_DEVICE through PIRQ A.
    pci.isa_bridge_space8[0x60] = SHARED_IRQ;
    pci.isa_bridge_space8[0x61] = SHARED_IRQ;

    return { pci, raised, lowered };
}

const { pci, raised, lowered } = make_pci();

pci.raise_irq(FIRST_DEVICE);
pci.raise_irq(FIRST_DEVICE);
pci.raise_irq(SECOND_DEVICE);
assert.deepEqual(raised, [SHARED_IRQ], "a shared INTx line is raised only once");
assert.equal(pci.irq_line_state[SHARED_IRQ], 2);

pci.lower_irq(FIRST_DEVICE);
pci.lower_irq(FIRST_DEVICE);
assert.deepEqual(lowered, [], "one device cannot lower another device's active INTx line");

const saved_state = pci.get_state();
const restored = make_pci();
restored.pci.set_state(saved_state);
assert.equal(restored.pci.irq_line_state[SHARED_IRQ], 1, "INTx ownership survives restore");

restored.pci.lower_irq(SECOND_DEVICE);
assert.deepEqual(restored.lowered, [SHARED_IRQ], "the last owner lowers the shared INTx line");

console.log("PCI shared IRQ tests passed");
