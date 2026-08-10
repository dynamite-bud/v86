#!/usr/bin/env node

import assert from "assert/strict";
import { ACPI } from "../../src/acpi.js";

const writes = new Map();
const cpu = {
    io: {
        register_read() {},
        register_write(port, owner, write8)
        {
            if(write8)
            {
                writes.set(port, value => write8.call(owner, value));
            }
        },
    },
    devices: {
        pci: {
            register_device() {},
        },
    },
    device_raise_irq() {},
    device_lower_irq() {},
};

const acpi = new ACPI(cpu);

acpi.gpe[0] = 0b11110000;
acpi.gpe[1] = 0b10101010;
writes.get(0xAFE0)(0b10100000);
writes.get(0xAFE1)(0b00001010);
assert.equal(acpi.gpe[0], 0b01010000, "GPE0_STS clears only bits written as one");
assert.equal(acpi.gpe[1], 0b10100000, "the second GPE0_STS byte is write-one-to-clear");

writes.get(0xAFE0)(0);
assert.equal(acpi.gpe[0], 0b01010000, "writing zero preserves pending GPE status");

writes.get(0xAFE2)(0b00110011);
writes.get(0xAFE3)(0b11001100);
assert.equal(acpi.gpe[2], 0b00110011, "GPE0_EN stores its enable mask");
assert.equal(acpi.gpe[3], 0b11001100, "the second GPE0_EN byte stores its enable mask");

console.log("ACPI GPE tests passed");
