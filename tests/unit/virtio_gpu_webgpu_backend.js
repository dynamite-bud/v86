#!/usr/bin/env node

import assert from "node:assert/strict";
import { JsWebGpuRenderer } from "../../src/browser/virtio_gpu_webgpu_backend.js";

globalThis.GPUTextureUsage = {
    COPY_DST: 1,
    TEXTURE_BINDING: 2,
    RENDER_ATTACHMENT: 4,
};
globalThis.GPUBufferUsage = {
    UNIFORM: 1,
    COPY_DST: 2,
};

function make_webgpu()
{
    const state = {
        configurations: [],
        textures: [],
        texture_writes: [],
        texture_write_sources: [],
        buffer_writes: [],
        submissions: [],
        passes: [],
        handlers: {},
        wait_idle_count: 0,
        surface_failures: 0,
        device_destroyed: false,
        present_buffer_destroyed: false,
        context_unconfigured: false,
    };
    const context = {
        configure(configuration)
        {
            state.configurations.push(configuration);
        },
        unconfigure()
        {
            state.context_unconfigured = true;
        },
        getCurrentTexture()
        {
            if(state.surface_failures)
            {
                state.surface_failures--;
                throw new Error("stale surface");
            }
            return { createView: () => ({ surface: true }) };
        },
    };
    const canvas = {
        width: 0,
        height: 0,
        getContext(name)
        {
            assert.equal(name, "webgpu");
            return context;
        },
    };
    const queue = {
        writeTexture(destination, data, layout, size)
        {
            state.texture_write_sources.push(data);
            state.texture_writes.push({
                destination,
                data: new Uint8Array(data),
                layout: { ...layout },
                size: { ...size },
            });
        },
        writeBuffer(buffer, offset, data)
        {
            state.buffer_writes.push({ buffer, offset, data: Array.from(data) });
        },
        submit(command_buffers)
        {
            state.submissions.push(command_buffers);
        },
        async onSubmittedWorkDone()
        {
            state.wait_idle_count++;
        },
    };
    const pipeline = {
        getBindGroupLayout: index => ({ index }),
    };
    const device = {
        queue,
        limits: { maxTextureDimension2D: 4096 },
        lost: new Promise(() => {}),
        addEventListener(name, handler)
        {
            state.handlers[name] = handler;
        },
        createSampler: descriptor => ({ descriptor }),
        createBuffer(descriptor)
        {
            return {
                descriptor,
                destroy()
                {
                    state.present_buffer_destroyed = true;
                },
            };
        },
        createShaderModule: descriptor => ({ descriptor }),
        async createRenderPipelineAsync(descriptor)
        {
            state.pipeline_descriptor = descriptor;
            return pipeline;
        },
        createTexture(descriptor)
        {
            const texture = {
                descriptor,
                destroyed: false,
                createView: () => ({ texture }),
                destroy()
                {
                    texture.destroyed = true;
                },
            };
            state.textures.push(texture);
            return texture;
        },
        createBindGroup: descriptor => ({ descriptor }),
        createCommandEncoder()
        {
            const pass_state = { draw_calls: [] };
            const pass = {
                setPipeline(value)
                {
                    pass_state.pipeline = value;
                },
                setBindGroup(index, value)
                {
                    pass_state.bind_group = { index, value };
                },
                draw(...args)
                {
                    pass_state.draw_calls.push(args);
                },
                end()
                {
                    pass_state.ended = true;
                },
            };
            state.passes.push(pass_state);
            return {
                beginRenderPass(descriptor)
                {
                    pass_state.descriptor = descriptor;
                    return pass;
                },
                finish: () => ({ pass_state }),
            };
        },
        destroy()
        {
            state.device_destroyed = true;
        },
    };
    const gpu = {
        requestAdapter: async () => ({
            requestDevice: async () => device,
        }),
        getPreferredCanvasFormat: () => "bgra8unorm",
    };
    return { state, canvas, gpu };
}

const { state, canvas, gpu } = make_webgpu();
const renderer = await JsWebGpuRenderer.create(canvas, 4, 4, 64, gpu);
assert.equal(canvas.width, 4);
assert.equal(canvas.height, 4);
assert.equal(state.configurations.length, 1);
assert.equal(state.pipeline_descriptor.fragment.targets[0].format, "bgra8unorm");

await renderer.create_resource_2d(1, 1, 4, 4);
assert.equal(renderer.host_memory_bytes, 64);
assert.equal(state.textures[0].descriptor.format, "rgba8unorm");
await assert.rejects(renderer.create_resource_2d(2, 67, 1, 1),
    /GPU host memory limit exceeded/);
await assert.rejects(renderer.create_resource_2d(1, 67, 1, 1), /Duplicate resource/);

const pixels = Uint8Array.from([
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
]);
renderer.upload_resource_2d(1, 1, 1, 2, 2, 8, pixels);
assert.equal(state.texture_writes.length, 1);
assert.deepEqual(state.texture_writes[0].destination.origin, { x: 1, y: 1, z: 0 });
assert.equal(state.texture_writes[0].layout.bytesPerRow, 256);
assert.equal(state.texture_writes[0].layout.rowsPerImage, 2);
assert.deepEqual(Array.from(state.texture_writes[0].data.subarray(0, 8)),
    Array.from(pixels.subarray(0, 8)));
assert.deepEqual(Array.from(state.texture_writes[0].data.subarray(256, 264)),
    Array.from(pixels.subarray(8, 16)));
assert.throws(() => renderer.upload_resource_2d(1, 0, 0, 2, 2, 7, pixels),
    /stride is smaller/);

renderer.set_scanout(1, 0, 0, 4, 4);
state.surface_failures = 1;
assert.equal(renderer.flush(1, 0, 0, 4, 4), true);
assert.deepEqual(state.buffer_writes[0].data, [0, 0, 4, 4, 4, 4, 1, 0]);
assert.deepEqual(state.passes[0].draw_calls, [[3, 1, 0, 0]]);
assert.equal(state.passes[0].ended, true);
assert.equal(state.configurations.length, 2);
await renderer.wait_idle();
assert.equal(state.wait_idle_count, 1);

renderer.clear_scanout();
assert.equal(renderer.flush(1, 0, 0, 4, 4), false);
renderer.destroy_resource(1);
assert.equal(renderer.host_memory_bytes, 0);
assert.equal(state.textures[0].destroyed, true);
assert.throws(() => renderer.destroy_resource(1), /Unknown resource/);

await renderer.create_resource_2d(3, 134, 2, 2);
renderer.reset();
assert.equal(renderer.resources.size, 0);
assert.equal(renderer.host_memory_bytes, 0);
assert.equal(state.textures[1].destroyed, true);

state.handlers.uncapturederror({ error: new Error("validation failed") });
assert.throws(() => renderer.device_status(), /Uncaptured WebGPU error: validation failed/);
renderer.dispose();
renderer.dispose();
assert.equal(state.present_buffer_destroyed, true);
assert.equal(state.context_unconfigured, true);
assert.equal(state.device_destroyed, true);

{
    const aligned_webgpu = make_webgpu();
    const aligned_renderer = await JsWebGpuRenderer.create(
        aligned_webgpu.canvas, 64, 2, 512, aligned_webgpu.gpu);
    await aligned_renderer.create_resource_2d(1, 1, 64, 2);
    const aligned_pixels = new Uint8Array(512);
    aligned_renderer.upload_resource_2d(1, 0, 0, 64, 2, 256, aligned_pixels);
    assert.equal(aligned_webgpu.state.texture_write_sources[0], aligned_pixels);
    assert.equal(aligned_renderer.upload_scratch.byteLength, 0);
    assert.equal(aligned_webgpu.state.texture_writes[0].layout.bytesPerRow, 256);
    aligned_renderer.dispose();
}

console.log("virtio-gpu direct WebGPU backend tests passed");
