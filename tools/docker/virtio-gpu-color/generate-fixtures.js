#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DECODED_MEMORY_CEILING, FIXTURE_ROOT, FRAME_BYTES, FRAME_HEIGHT, FRAME_STRIDE,
    FRAME_WIDTH, decode_ppm, encode_ppm, expand_scene, sha256 } from "./reference.js";

const check = process.argv.includes("--check");

const photo_provenance = {
    photo_blue_marble: {
        title: "Blue Marble: Land Surface, Shallow Water, and Shaded Topography",
        source_page: "https://visibleearth.nasa.gov/images/57752/blue-marble-land-surface-shallow-water-and-shaded-topography",
        source_url: "https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57752/land_shallow_topo_2048.jpg",
        source_sha256: "5b54cc586c6cbf2b28762ef4d4011f6cf4227a8b93a637b818a0c54090ce6c2c",
        source_dimensions: [2048, 1024],
        transformation_tool: "ffmpeg 8.1.1",
        transformation: "ffmpeg -nostdin -y -i land_shallow_topo_2048.jpg -vf crop=1364:1024:342:0,scale=256:192:flags=lanczos+accurate_rnd+full_chroma_int -frames:v 1 -map_metadata -1 -pix_fmt rgb24 -c:v ppm photo_blue_marble.ppm",
    },
    photo_tokyo: {
        title: "Tokyo at Night (ISS016-E-027586)",
        source_page: "https://visibleearth.nasa.gov/images/8683/tokyo-at-night",
        source_url: "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/8000/8683/ISS016-E-027586_lrg.jpg",
        source_sha256: "d082acd6e43972b225fe1b2886a1530ac2b1f3985ba3a5c3dc337b3ac0ddc5e7",
        source_dimensions: [1080, 1080],
        transformation_tool: "ffmpeg 8.1.1",
        transformation: "ffmpeg -nostdin -y -i ISS016-E-027586_lrg.jpg -vf crop=1080:810:0:135,scale=256:192:flags=lanczos+accurate_rnd+full_chroma_int -frames:v 1 -map_metadata -1 -pix_fmt rgb24 -c:v ppm photo_tokyo.ppm",
    },
};

function generate_ramps()
{
    const width = 256;
    const height = 12;
    const pixels = Buffer.alloc(width * height * 3);
    for(let y = 0; y < 8; y++)
    {
        for(let x = 0; x < width; x++)
        {
            const value = y < 4 ? x : 255 - x;
            const channel = y & 3;
            const offset = (y * width + x) * 3;
            if(channel === 3)
            {
                pixels.fill(value, offset, offset + 3);
            }
            else
            {
                pixels[offset + channel] = value;
            }
        }
    }
    const boundaries = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 255],
        [0, 255, 0], [255, 0, 255], [0, 0, 255], [255, 255, 0]];
    for(let y = 8; y < height; y++)
    {
        for(let x = 0; x < width; x++)
        {
            const color = boundaries[(Math.floor(x / 32) + (y - 8) * 2) % boundaries.length];
            pixels.set(color, (y * width + x) * 3);
        }
    }
    return encode_ppm(width, height, pixels);
}

function generate_palette()
{
    const width = 64;
    const height = 64;
    const pixels = Buffer.alloc(width * height * 3);
    for(let index = 0; index < width * height; index++)
    {
        pixels[index * 3] = (index >> 8 & 15) * 17;
        pixels[index * 3 + 1] = (index >> 4 & 15) * 17;
        pixels[index * 3 + 2] = (index & 15) * 17;
    }
    return encode_ppm(width, height, pixels);
}

function generate_smpte()
{
    const width = FRAME_WIDTH;
    const rows = [
        [[192, 192, 192], [192, 192, 0], [0, 192, 192], [0, 192, 0],
            [192, 0, 192], [192, 0, 0], [0, 0, 192]],
        [[0, 0, 192], [19, 19, 19], [192, 0, 192], [19, 19, 19],
            [0, 192, 192], [19, 19, 19], [192, 192, 192]],
        [[0, 33, 76], [255, 255, 255], [50, 0, 106], [19, 19, 19],
            [9, 9, 9], [19, 19, 19], [29, 29, 29], [19, 19, 19]],
    ];
    const pixels = Buffer.alloc(width * rows.length * 3);
    for(let y = 0; y < rows.length; y++)
    {
        for(let x = 0; x < width; x++)
        {
            let index;
            if(y < 2)
            {
                index = Math.floor(x * 7 / width);
            }
            else if(x < Math.floor(width * 5 / 7))
            {
                index = Math.floor(x * 4 / Math.floor(width * 5 / 7));
            }
            else if(x < Math.floor(width * 6 / 7))
            {
                index = Math.floor((x - Math.floor(width * 5 / 7)) * 3 / Math.floor(width / 7)) + 4;
            }
            else
            {
                index = 7;
            }
            pixels.set(rows[y][index], (y * width + x) * 3);
        }
    }
    return encode_ppm(width, rows.length, pixels);
}

const generated = new Map([
    ["ramps.ppm", generate_ramps()],
    ["palette.ppm", generate_palette()],
    ["smpte.ppm", generate_smpte()],
]);

for(const [name, bytes] of generated)
{
    const filename = path.join(FIXTURE_ROOT, name);
    if(check)
    {
        assert.deepEqual(fs.readFileSync(filename), bytes, `${name} is stale; regenerate fixtures`);
    }
    else
    {
        fs.writeFileSync(filename, bytes);
    }
}

const definitions = [
    { name: "ramps", file: "ramps.ppm", scale: "nearest" },
    { name: "palette", file: "palette.ppm", scale: "nearest" },
    { name: "smpte", file: "smpte.ppm", scale: "smpte-bands" },
    { name: "photo_blue_marble", file: "photo_blue_marble.ppm", scale: "nearest" },
    { name: "photo_tokyo", file: "photo_tokyo.ppm", scale: "nearest" },
];

const scenes = definitions.map(definition => {
    const filename = path.join(FIXTURE_ROOT, definition.file);
    const bytes = fs.readFileSync(filename);
    const source = decode_ppm(bytes);
    const scene = {
        ...definition,
        source_width: source.width,
        source_height: source.height,
        file_sha256: sha256(bytes),
        source_pixel_sha256: sha256(source.pixels),
    };
    const frame = expand_scene(scene, source);
    scene.frame_rgba_sha256 = sha256(frame);
    if(photo_provenance[scene.name]) scene.provenance = photo_provenance[scene.name];
    return scene;
});

const source_bytes = scenes.reduce((total, scene) => total + scene.source_width * scene.source_height * 3, 0);
const largest_source_bytes = Math.max(...scenes.map(scene => scene.source_width * scene.source_height * 3));
assert.ok(FRAME_BYTES + largest_source_bytes <= DECODED_MEMORY_CEILING);
const manifest = {
    version: 1,
    pixel_encoding: "untagged 8-bit RGB P6 PPM; expanded to opaque RGBA8",
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    stride: FRAME_STRIDE,
    frame_bytes: FRAME_BYTES,
    decoded_memory_ceiling: DECODED_MEMORY_CEILING,
    peak_decoded_bytes: FRAME_BYTES + largest_source_bytes,
    total_source_pixel_bytes: source_bytes,
    scenes,
};
const manifest_bytes = Buffer.from(JSON.stringify(manifest, null, 4) + "\n");
const header = `/* Generated by generate-fixtures.js. */\n` +
    `static const struct scene_definition SCENES[] = {\n` +
    scenes.map(scene => `    { "${scene.name}", "${scene.file}", ${scene.source_width}, ${scene.source_height}, ` +
        `${scene.scale === "smpte-bands" ? "SCALE_SMPTE_BANDS" : "SCALE_NEAREST"}, ` +
        `"${scene.source_pixel_sha256}", "${scene.frame_rgba_sha256}" },`).join("\n") +
    `\n};\n`;

for(const [filename, bytes] of [
    [path.join(FIXTURE_ROOT, "manifest.json"), manifest_bytes],
    [path.join(path.dirname(FIXTURE_ROOT), "scenes.generated.h"), Buffer.from(header)],
])
{
    if(check)
    {
        assert.deepEqual(fs.readFileSync(filename), bytes, `${path.basename(filename)} is stale; regenerate fixtures`);
    }
    else
    {
        fs.writeFileSync(filename, bytes);
    }
}

console.log(`${check ? "Checked" : "Generated"} ${scenes.length} scenes; peak decoded bytes ${manifest.peak_decoded_bytes}`);
