#!/usr/bin/env node

// Driver for tests/threads (XWAH-9): runs every test in this directory
// sequentially — the same way the Makefile unit-test targets list their
// scripts — and summarizes. Sequential on purpose: each test saturates
// several cores with worker_threads, and the plain-race test's lost-update
// demonstration wants an unloaded machine.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const NOT_TESTS = new Set(["run-all.js", "helpers.js"]);
const test_files = fs.readdirSync(__dirname)
    .filter(name => name.endsWith(".js") && !NOT_TESTS.has(name))
    .sort();

let failures = 0;
for(const name of test_files)
{
    console.log(`\n=== tests/threads/${name} ===`);
    const started = performance.now();
    const result = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: "inherit" });
    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    if(result.status === 0)
    {
        console.log(`=== ${name} passed (${elapsed}s) ===`);
    }
    else
    {
        failures++;
        console.log(`=== ${name} FAILED with status ${result.status} (${elapsed}s) ===`);
    }
}

console.log(failures === 0 ?
    `\nAll ${test_files.length} thread tests passed` :
    `\n${failures} of ${test_files.length} thread tests FAILED`);
process.exit(failures === 0 ? 0 : 1);
