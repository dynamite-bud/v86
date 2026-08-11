#!/usr/bin/env node

import assert from "node:assert/strict";
import { FS } from "../../lib/filesystem.js";

const storage = {};
const default_filesystem = new FS(storage);
assert.equal(default_filesystem.GetSpace(), 256 * 1024 * 1024 * 1024);

const configured_filesystem = new FS(storage, undefined, 2 * 1024 * 1024 * 1024);
assert.equal(configured_filesystem.GetSpace(), 2 * 1024 * 1024 * 1024);
assert.throws(() => new FS(storage, undefined, -1), /non-negative safe integer/);
assert.throws(() => new FS(storage, undefined, Number.MAX_VALUE), /non-negative safe integer/);

console.log("filesystem capacity tests passed");
