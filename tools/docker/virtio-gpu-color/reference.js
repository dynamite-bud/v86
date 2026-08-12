import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const FRAME_WIDTH = 1024;
export const FRAME_HEIGHT = 768;
export const FRAME_STRIDE = FRAME_WIDTH * 4;
export const FRAME_BYTES = FRAME_STRIDE * FRAME_HEIGHT;
export const DECODED_MEMORY_CEILING = 4 * 1024 * 1024;

export function sha256(bytes)
{
    return create_hash("sha256").update(bytes).digest("hex");
}

export function encode_ppm(width, height, pixels)
{
    assert.equal(pixels.byteLength, width * height * 3);
    return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii"), pixels]);
}

export function decode_ppm(bytes)
{
    let offset = 0;
    const tokens = [];
    while(tokens.length < 4)
    {
        while(offset < bytes.length && /\s/.test(String.fromCharCode(bytes[offset]))) offset++;
        if(bytes[offset] === 35)
        {
            while(offset < bytes.length && bytes[offset++] !== 10) {}
            continue;
        }
        const start = offset;
        while(offset < bytes.length && !/\s/.test(String.fromCharCode(bytes[offset]))) offset++;
        tokens.push(bytes.subarray(start, offset).toString("ascii"));
    }
    assert.equal(tokens[0], "P6");
    const width = Number(tokens[1]);
    const height = Number(tokens[2]);
    assert.equal(Number(tokens[3]), 255);
    assert.ok(offset < bytes.length && /\s/.test(String.fromCharCode(bytes[offset])));
    offset++;
    const pixels = bytes.subarray(offset);
    assert.equal(pixels.byteLength, width * height * 3);
    return { width, height, pixels };
}

export function load_scene(scene, root = FIXTURE_ROOT)
{
    const bytes = fs.readFileSync(path.join(root, scene.file));
    const image = decode_ppm(bytes);
    assert.equal(image.width, scene.source_width);
    assert.equal(image.height, scene.source_height);
    return { ...image, bytes };
}

export function expand_scene(scene, source)
{
    assert.equal(source.width, scene.source_width);
    assert.equal(source.height, scene.source_height);
    const rgba = Buffer.allocUnsafe(FRAME_BYTES);
    for(let y = 0; y < FRAME_HEIGHT; y++)
    {
        const source_y = scene.scale === "smpte-bands" ?
            y < FRAME_HEIGHT * 6 / 9 ? 0 : y < Math.floor(FRAME_HEIGHT * 7 / 9) ? 1 : 2 :
            Math.floor(y * source.height / FRAME_HEIGHT);
        for(let x = 0; x < FRAME_WIDTH; x++)
        {
            const source_x = Math.floor(x * source.width / FRAME_WIDTH);
            const source_offset = (source_y * source.width + source_x) * 3;
            const target_offset = (y * FRAME_WIDTH + x) * 4;
            rgba[target_offset] = source.pixels[source_offset];
            rgba[target_offset + 1] = source.pixels[source_offset + 1];
            rgba[target_offset + 2] = source.pixels[source_offset + 2];
            rgba[target_offset + 3] = 255;
        }
    }
    return rgba;
}

export function load_manifest(root = FIXTURE_ROOT)
{
    return JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
}

export function pixel_at(rgba, x, y)
{
    assert.ok(x >= 0 && x < FRAME_WIDTH && y >= 0 && y < FRAME_HEIGHT);
    const offset = (y * FRAME_WIDTH + x) * 4;
    return Array.from(rgba.subarray(offset, offset + 4));
}
