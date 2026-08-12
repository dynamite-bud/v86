#!/usr/bin/env node

import assert from "node:assert/strict";
import url from "node:url";
import { install_node_web_worker } from "../node_web_worker.js";
import {
    FRAME_HEIGHT,
    FRAME_STRIDE,
    FRAME_WIDTH,
    expand_scene,
    load_manifest,
    load_scene,
    pixel_at,
    sha256,
} from "../../tools/docker/virtio-gpu-color/reference.js";
import {
    VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM,
    VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM,
    VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM,
    VIRTIO_GPU_FORMAT_R8G8B8X8_UNORM,
} from "../../src/virtio_gpu.js";

install_node_web_worker();

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const manifest = load_manifest();
const expected_scenes = new Map(manifest.scenes.map(scene => {
    const source = load_scene(scene);
    assert.equal(sha256(source.bytes), scene.file_sha256, `${scene.name} fixture file digest`);
    assert.equal(sha256(source.pixels), scene.source_pixel_sha256, `${scene.name} source-pixel digest`);
    return [scene.name, { scene, rgba: expand_scene(scene, source) }];
}));
process.on("unhandledRejection", error => { throw error; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    autostart: true,
    memory_size: 512 * 1024 * 1024,
    acpi: true,
    log_level: 0,
    bzimage_initrd_from_filesystem: true,
    cmdline: [
        "rw",
        "root=host9p",
        "rootfstype=9p",
        "rootflags=trans=virtio,cache=loose",
        "console=ttyS0,115200",
        "modules=virtio_pci,9p,9pnet,9pnet_virtio,virtio_gpu",
        "tsc=reliable",
        "audit=0",
        "quiet",
    ].join(" "),
    filesystem: {
        baseurl: __dirname + "/../../images/alpine-virtio-gpu-rootfs-flat/",
        basefs: __dirname + "/../../images/alpine-virtio-gpu-fs.json",
    },
    virtio_gpu: { backend: "memory", width: FRAME_WIDTH, height: FRAME_HEIGHT },
});

let serial = "";
let finished = false;
let probe_finished = false;
let color_started = false;
let next_scene_index = 0;
let last_flush_count = 0;
const timeout = setTimeout(() =>
{
    finished = true;
    emulator.destroy();
    assert.fail("Timed out waiting for Alpine virtio-gpu color probe. Serial output:\n" + serial);
}, 180 * (+process.env.TIMEOUT_EXTRA_FACTOR || 1) * 1000);

emulator.add_listener("serial0-output-byte", function(byte)
{
    if(finished)
    {
        return;
    }

    const character = String.fromCharCode(byte);
    process.stdout.write(character);
    serial += character;

    if(serial.includes("Mounting root: failed") ||
       serial.includes("initramfs emergency recovery shell"))
    {
        fail("Alpine root filesystem failed to mount");
        return;
    }
    if(serial.includes("V86_GPU_PROBE_STATUS=FAIL"))
    {
        fail("Alpine virtio-gpu probe failed");
        return;
    }
    if(/V86_GPU_COLOR_ERROR=[^\r\n]+\r?\n/.test(serial))
    {
        fail("Alpine virtio-gpu color utility failed");
        return;
    }

    if(!probe_finished && serial.includes("V86_GPU_PROBE_END"))
    {
        probe_finished = true;
        assert.match(serial, /V86_GPU_PROBE_KERNEL=6\.12\./);
        assert.match(serial, /1af4:1050/);
        assert.match(serial, /V86_GPU_PROBE_DRIVER=virtio\d+/);
        assert.match(serial, /V86_GPU_PROBE_STATUS=PASS/);
        assert.match(serial, /V86_GPU_PROBE_KMS=PASS/);
        return;
    }
    if(probe_finished && !color_started && /localhost:~# $/.test(serial))
    {
        color_started = true;
        const backend = emulator.v86.cpu.devices.virtio_gpu.backend;
        last_flush_count = backend.flush_count;
        setTimeout(() => emulator.serial0_send(
            "kill $(pidof modetest) 2>/dev/null || true; sleep 1; /usr/local/bin/v86-gpu-color\n"), 0);
        return;
    }
    const scene_matches = [...serial.matchAll(
        /V86_GPU_COLOR_SCENE=(\S+) DIGEST=([0-9a-f]{64}) SOURCE_DIGEST=([0-9a-f]{64}) WIDTH=(\d+) HEIGHT=(\d+) STRIDE=(\d+) FORMAT=(\S+)\r?\n/g)];
    if(scene_matches.length > next_scene_index)
    {
        const match = scene_matches[next_scene_index];
        const expected_name = manifest.scenes[next_scene_index].name;
        assert.equal(match[1], expected_name, "guest scene order");
        next_scene_index++;
        validate_scene(match).then(() => {
            emulator.serial0_send(next_scene_index < manifest.scenes.length ? "next\n" : "quit\n");
        }, error => fail(error.stack || error.message));
    }

    if(next_scene_index === manifest.scenes.length && serial.includes("V86_GPU_COLOR_DONE"))
    {
        finished = true;
        clearTimeout(timeout);
        emulator.destroy();
        console.log("\nvirtio-gpu Linux color-fidelity probe passed");
    }
});

async function validate_scene(marker)
{
    const name = marker[1];
    const expected = expected_scenes.get(name);
    assert(expected, `Unknown guest scene ${name}`);
    const ready = await wait_for_scene_flush(name, expected.scene.frame_rgba_sha256);
    assert.equal(marker[2], expected.scene.frame_rgba_sha256, `${name} serial frame digest`);
    assert.equal(marker[3], expected.scene.source_pixel_sha256, `${name} serial source-pixel digest`);
    assert.equal(Number(marker[4]), FRAME_WIDTH, `${name} width`);
    assert.equal(Number(marker[5]), FRAME_HEIGHT, `${name} height`);
    assert.equal(Number(marker[6]), FRAME_STRIDE, `${name} stride`);
    assert.equal(marker[7], "B8G8R8X8", `${name} scanout format name`);

    const device = emulator.v86.cpu.devices.virtio_gpu;
    const backend = device.backend;
    const scanout = ready.scanout;
    assert.equal(scanout.width, FRAME_WIDTH, `${name} scanout width`);
    assert.equal(scanout.height, FRAME_HEIGHT, `${name} scanout height`);
    const resource = backend.resources.get(scanout.resource_id);
    const device_resource = device.resources.get(scanout.resource_id);
    assert(resource, `${name}: scanout resource is missing from the memory backend`);
    assert(device_resource, `${name}: scanout resource is missing from the device`);
    assert.equal(resource.width, FRAME_WIDTH, `${name} resource width`);
    assert.equal(resource.height, FRAME_HEIGHT, `${name} resource height`);
    assert.equal(resource.data.byteLength, manifest.frame_bytes, `${name} resource bytes`);
    assert.equal(resource.format, VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM, `${name} backend format`);
    assert.equal(device_resource.format, VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM, `${name} device format`);
    assert.ok(backend.flush_count > last_flush_count, `${name}: scanout was not flushed`);
    last_flush_count = backend.flush_count;
    assert.deepEqual(backend.last_flush,
        { resource_id: scanout.resource_id, x: 0, y: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT },
        `${name} flush rectangle`);

    const actual = resource_to_rgba(resource);
    const actual_digest = sha256(actual);
    if(actual_digest !== expected.scene.frame_rgba_sha256)
    {
        const mismatch = summarize_mismatch(expected.rgba, actual);
        assert.fail(`${name} full-frame RGBA digest: expected ${expected.scene.frame_rgba_sha256}, ` +
            `actual ${actual_digest}; ${mismatch.count} mismatching bytes; ` +
            `first ${JSON.stringify(mismatch.first)}`);
    }
    validate_representative_pixels(name, actual, expected.rgba);
    if(name === "ramps") validate_ramps(actual);
    if(name === "palette") validate_palette(actual);
}

async function wait_for_scene_flush(name, expected_digest)
{
    const backend = emulator.v86.cpu.devices.virtio_gpu.backend;
    const deadline = Date.now() + 10000;
    let candidate = null;
    while(Date.now() < deadline)
    {
        const scanout = backend.scanout;
        if(scanout && backend.flush_count > last_flush_count &&
           backend.last_flush?.resource_id === scanout.resource_id)
        {
            candidate = { scanout };
            const resource = backend.resources.get(scanout.resource_id);
            if(resource && sha256(resource_to_rgba(resource)) === expected_digest)
            {
                return candidate;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    if(candidate)
    {
        return candidate;
    }
    throw new Error(`${name}: timed out waiting for a new flushed scanout`);
}

function resource_to_rgba(resource)
{
    const rgba = new Uint8Array(resource.data.byteLength);
    for(let offset = 0; offset < resource.data.byteLength; offset += 4)
    {
        if(resource.format === VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM ||
           resource.format === VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM)
        {
            rgba[offset] = resource.data[offset + 2];
            rgba[offset + 1] = resource.data[offset + 1];
            rgba[offset + 2] = resource.data[offset];
        }
        else
        {
            rgba[offset] = resource.data[offset];
            rgba[offset + 1] = resource.data[offset + 1];
            rgba[offset + 2] = resource.data[offset + 2];
        }
        rgba[offset + 3] =
            resource.format === VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM ||
            resource.format === VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM ?
                resource.data[offset + 3] : 255;
    }
    return rgba;
}

function validate_representative_pixels(name, actual, expected)
{
    const coordinates = [[0, 0], [FRAME_WIDTH - 1, 0], [0, FRAME_HEIGHT - 1],
        [FRAME_WIDTH - 1, FRAME_HEIGHT - 1], [FRAME_WIDTH >> 1, FRAME_HEIGHT >> 1]];
    if(name === "smpte")
    {
        for(let bar = 0; bar < 7; bar++)
        {
            coordinates.push([Math.floor((bar + 0.5) * FRAME_WIDTH / 7), 256]);
            coordinates.push([Math.floor((bar + 0.5) * FRAME_WIDTH / 7), 550]);
        }
        const first_width = Math.floor(FRAME_WIDTH * 5 / 7);
        const second_start = first_width;
        const second_width = Math.floor(FRAME_WIDTH / 7);
        for(let block = 0; block < 4; block++)
        {
            coordinates.push([Math.floor((block + 0.5) * first_width / 4), 700]);
        }
        for(let block = 0; block < 3; block++)
        {
            coordinates.push([second_start + Math.floor((block + 0.5) * second_width / 3), 700]);
        }
        coordinates.push([960, 700]);
    }
    if(name.startsWith("photo_"))
    {
        for(const x of [128, 384, 640, 896])
        {
            for(const y of [96, 288, 480, 672]) coordinates.push([x, y]);
        }
    }
    for(const [x, y] of coordinates)
    {
        const expected_pixel = pixel_at(expected, x, y);
        const actual_pixel = pixel_at(actual, x, y);
        if(!actual_pixel.every((value, index) => value === expected_pixel[index]))
        {
            assert.fail(`${name} pixel (${x},${y}): expected ${expected_pixel}, actual ${actual_pixel}`);
        }
    }
}

function validate_ramps(rgba)
{
    const channels = [0, 1, 2, -1, 0, 1, 2, -1];
    for(let row = 0; row < 8; row++)
    {
        const values = [];
        for(let level = 0; level < 256; level++)
        {
            const pixel = pixel_at(rgba, level * 4, row * 64 + 32);
            const expected = row < 4 ? level : 255 - level;
            if(channels[row] === -1)
            {
                assert.deepEqual(pixel, [expected, expected, expected, 255],
                    `ramps neutral row ${row} level ${level}`);
            }
            else
            {
                assert.equal(pixel[channels[row]], expected,
                    `ramps channel ${channels[row]} row ${row} level ${level}`);
                assert.equal(pixel[(channels[row] + 1) % 3], 0,
                    `ramps inactive channel row ${row} level ${level}`);
                assert.equal(pixel[(channels[row] + 2) % 3], 0,
                    `ramps inactive channel row ${row} level ${level}`);
            }
            values.push(pixel[channels[row] === -1 ? 0 : channels[row]]);
        }
        assert.deepEqual(values, row < 4 ?
            Array.from({ length: 256 }, (_, index) => index) :
            Array.from({ length: 256 }, (_, index) => 255 - index),
        `ramps monotonic row ${row}`);
    }
    assert.deepEqual(pixel_at(rgba, 127, 544), [0, 0, 0, 255], "ramps hard black boundary");
    assert.deepEqual(pixel_at(rgba, 128, 544), [255, 255, 255, 255], "ramps hard white boundary");
}

function validate_palette(rgba)
{
    const colors = new Set();
    for(let index = 0; index < 4096; index++)
    {
        const x = (index % 64) * 16 + 8;
        const y = Math.floor(index / 64) * 12 + 6;
        const pixel = pixel_at(rgba, x, y);
        colors.add((pixel[0] << 16 | pixel[1] << 8 | pixel[2]) >>> 0);
    }
    assert.equal(colors.size, 4096, "palette unique RGB colors");
    assert.deepEqual(pixel_at(rgba, 8, 6), [0, 0, 0, 255], "palette top-left sentinel");
    assert.deepEqual(pixel_at(rgba, 1016, 6), [0, 51, 255, 255], "palette top-right sentinel");
    assert.deepEqual(pixel_at(rgba, 8, 762), [255, 204, 0, 255], "palette bottom-left sentinel");
    assert.deepEqual(pixel_at(rgba, 1016, 762), [255, 255, 255, 255], "palette bottom-right sentinel");
}

function summarize_mismatch(expected, actual)
{
    let count = 0;
    const first = [];
    for(let offset = 0; offset < expected.byteLength; offset++)
    {
        if(expected[offset] !== actual[offset])
        {
            count++;
            if(first.length < 12)
            {
                const pixel = Math.floor(offset / 4);
                first.push({
                    x: pixel % FRAME_WIDTH,
                    y: Math.floor(pixel / FRAME_WIDTH),
                    channel: "rgba"[offset & 3],
                    expected: expected[offset],
                    actual: actual[offset],
                });
            }
        }
    }
    return { count, first };
}

function fail(message)
{
    finished = true;
    clearTimeout(timeout);
    emulator.destroy();
    assert.fail(`${message}. Serial output:\n${serial}`);
}
