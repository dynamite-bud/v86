#!/usr/bin/env node

import assert from "node:assert/strict";
import {
    READY_STATE_SNAPSHOT_SCHEMA,
    ReadyStateSnapshotStore,
    create_ready_state_fingerprint,
    validate_ready_state_snapshot,
} from "../../src/browser/ready_state_snapshot.js";

function make_state(version = 6, length = 32)
{
    const state = new ArrayBuffer(length);
    const header = new DataView(state);
    header.setUint32(0, 0x86768676, true);
    header.setInt32(4, version, true);
    header.setInt32(8, length, true);
    return state;
}

assert.equal(READY_STATE_SNAPSHOT_SCHEMA, 1);
assert.equal(validate_ready_state_snapshot(make_state()), 6);
assert.throws(() => validate_ready_state_snapshot(new ArrayBuffer(8)),
    /v86 ArrayBuffer/);

{
    const state = make_state();
    new DataView(state).setUint32(0, 0, true);
    assert.throws(() => validate_ready_state_snapshot(state), /invalid v86 header/);
}

{
    const state = make_state();
    new DataView(state).setInt32(8, state.byteLength + 4, true);
    assert.throws(() => validate_ready_state_snapshot(state), /length does not match/);
}

{
    const assets = new Map([
        ["v86.js", new Uint8Array([1, 2, 3])],
        ["v86.wasm", new Uint8Array([4, 5, 6])],
    ]);
    const fetch_asset = async url => new Response(assets.get(url));
    const configuration = { memory_size: 1024, renderer: "webgpu-js" };
    const first = await create_ready_state_fingerprint(
        configuration, ["v86.js", "v86.wasm"], fetch_asset);
    const repeated = await create_ready_state_fingerprint(
        configuration, ["v86.js", "v86.wasm"], fetch_asset);
    const changed_configuration = await create_ready_state_fingerprint(
        { memory_size: 2048, renderer: "webgpu-js" },
        ["v86.js", "v86.wasm"], fetch_asset);
    const changed_asset = await create_ready_state_fingerprint(
        configuration, ["v86.wasm", "v86.js"], fetch_asset);

    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(repeated, first);
    assert.notEqual(changed_configuration, first);
    assert.notEqual(changed_asset, first);
}

assert.throws(() => new ReadyStateSnapshotStore(""), /non-empty string/);

console.log("ready-state snapshot tests passed");
