#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    MemoryFileStorage,
    ServerFileStorageWrapper,
} from "../../src/browser/filestorage.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v86-filestorage-"));
try
{
    const compressed = new Uint8Array([1, 2, 3, 4]);
    const decompressed = new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 5, 6]);
    fs.writeFileSync(path.join(directory, "chunk.zst"), compressed);

    let decompressions = 0;
    const storage = new ServerFileStorageWrapper(
        new MemoryFileStorage(), directory,
        async (decompressed_size, source) => {
            decompressions++;
            assert.equal(decompressed_size, decompressed.length);
            assert.deepEqual(source, compressed);
            await Promise.resolve();
            return decompressed.buffer;
        });

    assert.deepEqual(
        await storage.read("chunk.zst", 1, 3, decompressed.length),
        decompressed.subarray(1, 4));
    assert.deepEqual(
        await storage.read("chunk.zst", 2, 2, decompressed.length),
        decompressed.subarray(2, 4));
    assert.equal(decompressions, 1);
}
finally
{
    fs.rmSync(directory, { recursive: true, force: true });
}

console.log("file storage tests passed");
