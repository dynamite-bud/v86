#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    MemoryFileStorage,
    ServerFileStorageWrapper,
} from "../../src/browser/filestorage.js";
import { FS, STATUS_ON_STORAGE } from "../../lib/filesystem.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v86-filestorage-"));
try
{
    const compressed = new Uint8Array([1, 2, 3, 4]);
    const decompressed = new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 5, 6]);
    fs.writeFileSync(path.join(directory, "chunk.zst"), compressed);

    let decompressions = 0;
    const memory = new MemoryFileStorage();
    assert.equal(memory.max_bytes, 512 * 1024 * 1024,
        "the immutable file cache defaults to 512 MiB");
    const storage = new ServerFileStorageWrapper(
        memory, directory,
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
    storage.release("chunk.zst");
    assert.deepEqual(
        await storage.read("chunk.zst", 2, 2, decompressed.length),
        decompressed.subarray(2, 4));
    assert.equal(decompressions, 1, "closed files stay in the bounded memory cache");

    storage.uncache("chunk.zst");
    const concurrent = await Promise.all([
        storage.read("chunk.zst", 0, 2, decompressed.length),
        storage.read("chunk.zst", 3, 2, decompressed.length),
    ]);
    assert.deepEqual(concurrent[0], decompressed.subarray(0, 2));
    assert.deepEqual(concurrent[1], decompressed.subarray(3, 5));
    assert.equal(decompressions, 2, "concurrent misses share one server load");

    const lru = new MemoryFileStorage(6);
    await lru.cache("a", new Uint8Array([1, 2, 3]));
    await lru.cache("b", new Uint8Array([4, 5, 6]));
    assert.deepEqual(await lru.read("a", 0, 3), new Uint8Array([1, 2, 3]));
    await lru.cache("c", new Uint8Array([7, 8, 9]));
    assert.equal(await lru.read("b", 0, 3), null, "least-recently-used file is evicted");
    assert.deepEqual(await lru.read("a", 0, 3), new Uint8Array([1, 2, 3]));
    lru.release("a");
    assert.deepEqual(await lru.read("a", 0, 3), new Uint8Array([1, 2, 3]));
    lru.uncache("a");
    assert.equal(await lru.read("a", 0, 3), null, "uncache invalidates file data");

    const shared_empty = new MemoryFileStorage();
    await shared_empty.cache("empty", new Uint8Array());
    const filesystem = new FS(shared_empty);
    const inode_id = filesystem.CreateFile("resized", 0);
    const inode = filesystem.GetInode(inode_id);
    inode.status = STATUS_ON_STORAGE;
    inode.sha256sum = "empty";
    inode.size = 0;
    await filesystem.ChangeSize(inode_id, 1);
    assert.deepEqual(await shared_empty.read("empty", 0, 0), new Uint8Array(),
        "resizing one inode retains shared immutable source data");

    const bounded = new MemoryFileStorage(2);
    await bounded.cache("oversized", new Uint8Array([1, 2, 3]));
    assert.equal(await bounded.read("oversized", 0, 3), null,
        "files larger than the cache budget are not retained");
}
finally
{
    fs.rmSync(directory, { recursive: true, force: true });
}

console.log("file storage tests passed");
