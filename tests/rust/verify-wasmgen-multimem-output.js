#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import assert from "node:assert/strict";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

// These tests have to be kept in sync with src/rust/wasmgen/wasm_builder.rs'
// multimem_builder_test: modules importing the module memory "e"."m" plus
// guest RAM as a second memory "e"."g" (shared and non-shared variants),
// exercising every guest-memory load/store and atomic emitter.

function read_module(filename)
{
    return fs.readFileSync(path.resolve(__dirname, "../../build/" + filename));
}

function make_guest_memory(shared)
{
    return shared ?
        new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }) :
        new WebAssembly.Memory({ initial: 1, maximum: 1 });
}

const shared_module = read_module("dummy_output_multimem_shared.wasm");
const nonshared_module = read_module("dummy_output_multimem_nonshared.wasm");

for(const [name, module_bytes, shared] of [
    ["shared", shared_module, true],
    ["non-shared", nonshared_module, false],
])
{
    assert(WebAssembly.validate(module_bytes), `${name}: module must validate`);

    const wm = new WebAssembly.Module(module_bytes);
    const mem = new WebAssembly.Memory({ initial: 256 });
    const guest_mem = make_guest_memory(shared);

    let foo_recd_arg;
    function foo(arg)
    {
        foo_recd_arg = arg;
    }

    const i = new WebAssembly.Instance(wm, { "e": { m: mem, g: guest_mem, foo } });
    i.exports.f(0);

    assert(foo_recd_arg === 2, `${name}: foo received: "${foo_recd_arg}"`);

    if(shared)
    {
        assert(guest_mem.buffer instanceof SharedArrayBuffer,
            `${name}: guest memory must be backed by a SharedArrayBuffer`);
    }

    const mem0 = new DataView(mem.buffer);
    const guest = new DataView(guest_mem.buffer);

    // plain stores to the guest memory (memidx 1)
    assert.equal(guest.getUint32(64, true), 0x11223344, `${name}: guest u32 store`);
    assert.equal(guest.getUint16(68, true), 0xBEEF, `${name}: guest u16 store`);
    assert.equal(guest.getUint8(70), 0xAB, `${name}: guest u8 store`);
    assert.equal(guest.getBigUint64(72, true), 0x0102030405060708n, `${name}: guest i64 store`);

    // guest loads, copied by the module into its own memory (memidx 0)
    assert.equal(mem0.getUint32(0, true), 0x11223344, `${name}: guest u32 load`);
    assert.equal(mem0.getUint32(4, true), 0xBEEF, `${name}: guest u16 load`);
    assert.equal(mem0.getUint32(8, true), 0xAB, `${name}: guest u8 load`);
    assert.equal(mem0.getBigUint64(16, true), 0x0102030405060708n, `${name}: guest i64 load`);

    // atomic rmw add/sub/and/or/xor/xchg/cmpxchg on the guest memory,
    // each engineered to leave 42 behind
    for(let addr = 128; addr < 156; addr += 4)
    {
        assert.equal(guest.getUint32(addr, true), 42, `${name}: u32 atomic rmw at ${addr}`);
    }
    for(let addr = 160; addr < 188; addr += 4)
    {
        assert.equal(guest.getUint16(addr, true), 42, `${name}: u16 atomic rmw at ${addr}`);
    }
    for(let addr = 192; addr < 199; addr += 1)
    {
        assert.equal(guest.getUint8(addr), 42, `${name}: u8 atomic rmw at ${addr}`);
    }
}

// engines reject shared/non-shared import mismatches at link time,
// which is why both limits-flag variants exist
function foo() {}

assert.throws(
    () => new WebAssembly.Instance(new WebAssembly.Module(shared_module), {
        "e": { m: new WebAssembly.Memory({ initial: 256 }), g: make_guest_memory(false), foo },
    }),
    WebAssembly.LinkError,
    "shared import must not link against a non-shared memory");

assert.throws(
    () => new WebAssembly.Instance(new WebAssembly.Module(nonshared_module), {
        "e": { m: new WebAssembly.Memory({ initial: 256 }), g: make_guest_memory(true), foo },
    }),
    WebAssembly.LinkError,
    "non-shared import must not link against a shared memory");
