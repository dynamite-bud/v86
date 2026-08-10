#!/usr/bin/env node

import assert from "assert/strict";
import { MemoryGpuBackend } from "../../src/browser/virtio_gpu_backend.js";
import {
    VirtioGpu,
    VIRTIO_GPU_CMD_GET_DISPLAY_INFO,
    VIRTIO_GPU_CMD_RESOURCE_CREATE_2D,
    VIRTIO_GPU_CMD_RESOURCE_UNREF,
    VIRTIO_GPU_CMD_SET_SCANOUT,
    VIRTIO_GPU_CMD_RESOURCE_FLUSH,
    VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D,
    VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING,
    VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING,
    VIRTIO_GPU_RESP_OK_NODATA,
    VIRTIO_GPU_RESP_OK_DISPLAY_INFO,
    VIRTIO_GPU_RESP_ERR_UNSPEC,
    VIRTIO_GPU_RESP_ERR_OUT_OF_MEMORY,
    VIRTIO_GPU_RESP_ERR_INVALID_SCANOUT_ID,
    VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID,
    VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER,
    VIRTIO_GPU_FLAG_FENCE,
    VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM,
    VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM,
    VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM,
    VIRTIO_GPU_FORMAT_R8G8B8X8_UNORM,
    process_virtio_gpu_command,
    read_virtio_gpu_backing_range,
} from "../../src/virtio_gpu.js";
import { VirtIO, VIRTIO_F_VERSION_1 } from "../../src/virtio.js";

function make_request(type, options = {}, length = 24)
{
    const request = new Uint8Array(length);
    const view = new DataView(request.buffer);
    if(length >= 4) view.setUint32(0, type, true);
    if(length >= 8) view.setUint32(4, options.flags || 0, true);
    if(length >= 12) view.setUint32(8, options.fence_id_low || 0, true);
    if(length >= 16) view.setUint32(12, options.fence_id_high || 0, true);
    if(length >= 20) view.setUint32(16, options.ctx_id || 0, true);
    if(length >= 21) view.setUint8(20, options.ring_idx || 0);
    return request;
}

function make_create(resource_id, format, width, height, options = {})
{
    const request = make_request(VIRTIO_GPU_CMD_RESOURCE_CREATE_2D, options, 40);
    const view = new DataView(request.buffer);
    view.setUint32(24, resource_id, true);
    view.setUint32(28, format, true);
    view.setUint32(32, width, true);
    view.setUint32(36, height, true);
    return request;
}

function make_resource_command(type, resource_id, options = {})
{
    const request = make_request(type, options, 32);
    new DataView(request.buffer).setUint32(24, resource_id, true);
    return request;
}

function make_attach(resource_id, entries, options = {})
{
    const request = make_request(VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING,
        options, 32 + entries.length * 16);
    const view = new DataView(request.buffer);
    view.setUint32(24, resource_id, true);
    view.setUint32(28, entries.length, true);
    entries.forEach((entry, index) =>
    {
        const offset = 32 + index * 16;
        view.setUint32(offset, entry.addr, true);
        view.setUint32(offset + 4, entry.addr_high || 0, true);
        view.setUint32(offset + 8, entry.length, true);
    });
    return request;
}

function set_rect(view, rect)
{
    view.setUint32(24, rect.x, true);
    view.setUint32(28, rect.y, true);
    view.setUint32(32, rect.width, true);
    view.setUint32(36, rect.height, true);
}

function make_transfer(resource_id, rect, offset, options = {})
{
    const request = make_request(VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D, options, 56);
    const view = new DataView(request.buffer);
    set_rect(view, rect);
    view.setUint32(40, offset, true);
    view.setUint32(44, options.offset_high || 0, true);
    view.setUint32(48, resource_id, true);
    return request;
}

function make_scanout(scanout_id, resource_id, rect, options = {})
{
    const request = make_request(VIRTIO_GPU_CMD_SET_SCANOUT, options, 48);
    const view = new DataView(request.buffer);
    set_rect(view, rect);
    view.setUint32(40, scanout_id, true);
    view.setUint32(44, resource_id, true);
    return request;
}

function make_flush(resource_id, rect, options = {})
{
    const request = make_request(VIRTIO_GPU_CMD_RESOURCE_FLUSH, options, 48);
    const view = new DataView(request.buffer);
    set_rect(view, rect);
    view.setUint32(40, resource_id, true);
    return request;
}

function response_type(response)
{
    return response.byteLength >= 4 ? new DataView(response.buffer,
        response.byteOffset, response.byteLength).getUint32(0, true) : null;
}

function make_cpu(memory_size = 64 * 1024)
{
    const pci = {
        devices: [],
        register_device(device)
        {
            this.devices.push(device);
        },
        raise_irq(pci_id) {},
        lower_irq(pci_id) {},
    };
    const mem8 = new Uint8Array(memory_size);
    return {
        devices: { pci },
        mem8,
        io: {
            register_read(port, device, read8, read16, read32) {},
            register_write(port, device, write8, write16, write32) {},
        },
        read_blob(offset, length)
        {
            return this.mem8.subarray(offset, offset + length);
        },
        in_mapped_range(addr)
        {
            return false;
        },
    };
}

async function make_device(options = {}, backend = undefined)
{
    const cpu = make_cpu();
    const device = new VirtioGpu(cpu, {}, options, backend);
    await device.backend_ready;
    return { cpu, device };
}

async function execute(device, request, writable_length = 24)
{
    return response_type(await device.process_command(request, writable_length));
}

class OrderedBackend extends MemoryGpuBackend
{
    constructor()
    {
        super();
        this.events = [];
        this.block_upload = false;
        this.release_upload = null;
        this.upload_started = null;
    }

    async uploadResource2D(upload)
    {
        this.events.push("upload-start");
        if(this.block_upload)
        {
            this.block_upload = false;
            this.upload_started && this.upload_started();
            await new Promise(resolve => { this.release_upload = resolve; });
        }
        await super.uploadResource2D(upload);
        this.events.push("upload-end");
    }

    async flush(flush)
    {
        this.events.push("flush");
        return super.flush(flush);
    }

    async waitIdle()
    {
        this.events.push("wait-idle");
        return super.waitIdle();
    }
}

{
    const response = process_virtio_gpu_command(
        make_request(VIRTIO_GPU_CMD_GET_DISPLAY_INFO), 408, 1024, 768);
    const view = new DataView(response.buffer);
    assert.equal(response.byteLength, 408);
    assert.equal(view.getUint32(0, true), VIRTIO_GPU_RESP_OK_DISPLAY_INFO);
    assert.equal(view.getUint32(24, true), 0);
    assert.equal(view.getUint32(28, true), 0);
    assert.equal(view.getUint32(32, true), 1024);
    assert.equal(view.getUint32(36, true), 768);
    assert.equal(view.getUint32(40, true), 1);
    assert.equal(view.getUint32(48, true), 0);
}

{
    const response = process_virtio_gpu_command(
        make_request(VIRTIO_GPU_CMD_GET_DISPLAY_INFO), 407, 1024, 768);
    assert.equal(response_type(response), VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
    assert.equal(process_virtio_gpu_command(
        make_request(VIRTIO_GPU_CMD_GET_DISPLAY_INFO), 23, 1024, 768).byteLength, 0);
}

{
    const request = make_request(0xDEADBEEF, {
        flags: VIRTIO_GPU_FLAG_FENCE,
        fence_id_low: 0x89ABCDEF,
        fence_id_high: 0x01234567,
        ctx_id: 0x76543210,
        ring_idx: 31,
    });
    const response = process_virtio_gpu_command(request, 24, 1024, 768);
    const view = new DataView(response.buffer);
    assert.equal(view.getUint32(0, true), VIRTIO_GPU_RESP_ERR_UNSPEC);
    assert.equal(view.getUint32(4, true), VIRTIO_GPU_FLAG_FENCE);
    assert.equal(view.getUint32(8, true), 0x89ABCDEF);
    assert.equal(view.getUint32(12, true), 0x01234567);
    assert.equal(view.getUint32(16, true), 0x76543210);
    assert.equal(view.getUint8(20), 0);
}

{
    const request = make_request(VIRTIO_GPU_CMD_GET_DISPLAY_INFO, {
        flags: VIRTIO_GPU_FLAG_FENCE,
        fence_id_low: 7,
        fence_id_high: 9,
        ctx_id: 11,
    }, 20);
    const first = process_virtio_gpu_command(request, 24, 1024, 768);
    const second = process_virtio_gpu_command(request, 24, 1024, 768);
    assert.deepEqual(first, second);
    assert.equal(response_type(first), VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
    assert.equal(new DataView(first.buffer).getUint32(8, true), 7);
}

{
    const response = process_virtio_gpu_command(new Uint8Array(0), 24, 1024, 768);
    assert.equal(response.byteLength, 24);
    assert.equal(response_type(response), VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
}

{
    const cpu = make_cpu();
    const device = new VirtioGpu(cpu, {}, { backend: "memory", width: 1280, height: 720 });
    await device.backend_ready;

    assert.equal(device.virtio.pci_space[0], 0xF4);
    assert.equal(device.virtio.pci_space[1], 0x1A);
    assert.equal(device.virtio.pci_space[2], 0x50);
    assert.equal(device.virtio.pci_space[3], 0x10);
    assert.deepEqual(device.virtio.pci_space.slice(9, 12), [0, 0x80, 0x03]);
    assert.equal(device.virtio.pci_space[46], 16);
    assert.equal(device.virtio.device_feature[0], 0);
    assert.equal(device.virtio.device_feature[1], 1 << (VIRTIO_F_VERSION_1 - 32));
    assert.equal(device.virtio.device_feature[2], 0);
    assert.equal(device.virtio.device_feature[3], 0);
    assert.equal(device.virtio.queues.length, 2);
    assert.equal(device.virtio.queues[0].size_supported, 256);
    assert.equal(device.virtio.queues[1].size_supported, 16);

    device.events_read = 1;
    const state = device.get_state();
    state[0] = device.virtio.get_state();
    device.reset();
    await device.backend_ready;
    assert.equal(device.events_read, 0);
    device.set_state(state);
    await device.backend_ready;
    assert.equal(device.events_read, 1);
    assert.equal(device.width, 1280);
    assert.equal(device.height, 720);
}

{
    const cpu = make_cpu();
    const device = new VirtIO(cpu, {
        name: "default-class",
        pci_id: 0,
        device_id: 0x1040,
        subsystem_device_id: 0,
        common: {
            initial_port: 0x1000,
            queues: [{ size_supported: 1, notify_offset: 0 }],
            features: [VIRTIO_F_VERSION_1],
            on_driver_ok() {},
        },
        notification: {
            initial_port: 0x1100,
            single_handler: true,
            handlers: [() => {}],
        },
        isr_status: { initial_port: 0x1200 },
        device_specific: undefined,
    });
    assert.deepEqual(device.pci_space.slice(9, 12), [0, 2, 0]);
}

{
    const backend = new MemoryGpuBackend();
    await backend.initialize({ width: 4, height: 4, max_host_memory_bytes: 64 });
    await backend.createResource2D({
        resource_id: 1,
        format: VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM,
        width: 4,
        height: 4,
    });
    const pixels = Uint8Array.from([
        1, 2, 3, 4, 5, 6, 7, 8,
        9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    await backend.uploadResource2D({
        resource_id: 1,
        x: 1,
        y: 1,
        width: 2,
        height: 2,
        stride: 8,
        data: pixels,
    });
    assert.deepEqual(backend.resources.get(1).data.slice(20, 28), pixels.slice(0, 8));
    assert.deepEqual(backend.resources.get(1).data.slice(36, 44), pixels.slice(8, 16));
    await backend.setScanout({ resource_id: 1, x: 0, y: 0, width: 4, height: 4 });
    await backend.flush({ resource_id: 1, x: 0, y: 0, width: 4, height: 4 });
    assert.equal(backend.flush_count, 1);
    assert.deepEqual(backend.last_flush,
        { resource_id: 1, x: 0, y: 0, width: 4, height: 4 });
    await backend.waitIdle();
    await backend.reset();
    assert.equal(backend.resources.size, 0);
    assert.equal(backend.scanout, null);
    assert.equal(backend.flush_count, 0);
}

{
    const cpu = make_cpu();
    cpu.mem8.set([1, 2, 3, 4], 100);
    cpu.mem8.set([5, 6, 7, 8], 200);
    assert.deepEqual(read_virtio_gpu_backing_range(cpu,
        [{ addr: 100, length: 4 }, { addr: 200, length: 4 }], 2, 4),
        Uint8Array.from([3, 4, 5, 6]));
    assert.equal(read_virtio_gpu_backing_range(cpu,
        [{ addr: 100, length: 4 }], 3, 2), null);
}

{
    const { cpu, device } = await make_device({ max_host_memory_bytes: 64 });
    const formats = [
        VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM,
        VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM,
        VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM,
        VIRTIO_GPU_FORMAT_R8G8B8X8_UNORM,
    ];
    for(let index = 0; index < formats.length; index++)
    {
        assert.equal(await execute(device, make_create(index + 1, formats[index], 1, 1)),
            VIRTIO_GPU_RESP_OK_NODATA);
    }
    assert.equal(await execute(device, make_create(10, 999, 1, 1)),
        VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
    device.reset();
    await device.backend_ready;

    assert.equal(await execute(device, make_create(1,
        VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM, 4, 4)), VIRTIO_GPU_RESP_OK_NODATA);
    assert.equal(await execute(device, make_create(1,
        VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM, 4, 4)), VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID);
    assert.equal(await execute(device, make_create(2,
        VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM, 1, 1)), VIRTIO_GPU_RESP_ERR_OUT_OF_MEMORY);
    assert.equal(await execute(device, make_request(
        VIRTIO_GPU_CMD_RESOURCE_CREATE_2D, {}, 39)), VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);

    cpu.mem8.set(Uint8Array.from({ length: 32 }, (_, index) => index), 0x1000);
    cpu.mem8.set(Uint8Array.from({ length: 32 }, (_, index) => index + 32), 0x2000);
    assert.equal(await execute(device, make_attach(1, [
        { addr: 0x1000, length: 32 },
        { addr: 0x2000, length: 32 },
    ])), VIRTIO_GPU_RESP_OK_NODATA);
    assert.equal(await execute(device, make_attach(1, [
        { addr: 0x3000, length: 64 },
    ])), VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);

    const rect = { x: 1, y: 1, width: 2, height: 2 };
    assert.equal(await execute(device, make_transfer(1, rect, 20)), VIRTIO_GPU_RESP_OK_NODATA);
    assert.deepEqual(device.backend.resources.get(1).data.slice(20, 28),
        Uint8Array.from({ length: 8 }, (_, index) => index + 20));
    assert.deepEqual(device.backend.resources.get(1).data.slice(36, 44),
        Uint8Array.from({ length: 8 }, (_, index) => index + 36));

    assert.equal(await execute(device, make_scanout(1, 1,
        { x: 0, y: 0, width: 4, height: 4 })), VIRTIO_GPU_RESP_ERR_INVALID_SCANOUT_ID);
    assert.equal(await execute(device, make_scanout(0, 99,
        { x: 0, y: 0, width: 4, height: 4 })), VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID);
    assert.equal(await execute(device, make_scanout(0, 1,
        { x: 0, y: 0, width: 5, height: 4 })), VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
    assert.equal(await execute(device, make_scanout(0, 1,
        { x: 0, y: 0, width: 4, height: 4 })), VIRTIO_GPU_RESP_OK_NODATA);
    assert.equal(await execute(device, make_flush(1, rect)), VIRTIO_GPU_RESP_OK_NODATA);
    assert.equal(device.backend.flush_count, 1);

    const fenced_flush = make_flush(1, rect, {
        flags: VIRTIO_GPU_FLAG_FENCE,
        fence_id_low: 0x12345678,
        fence_id_high: 0x9ABCDEF0,
        ctx_id: 7,
    });
    const fenced_response = await device.process_command(fenced_flush, 24);
    assert.equal(response_type(fenced_response), VIRTIO_GPU_RESP_OK_NODATA);
    assert.equal(new DataView(fenced_response.buffer).getUint32(8, true), 0x12345678);

    assert.equal(await execute(device, make_transfer(1, rect, 20, { offset_high: 1 })),
        VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
    assert.equal(await execute(device, make_transfer(1,
        { x: 3, y: 3, width: 2, height: 2 }, 0)), VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
    assert.equal(await execute(device, make_resource_command(
        VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING, 1)), VIRTIO_GPU_RESP_OK_NODATA);
    assert.equal(await execute(device, make_transfer(1, rect, 20)),
        VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
    assert.equal(await execute(device, make_resource_command(
        VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING, 1)), VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
    assert.equal(await execute(device, make_resource_command(
        VIRTIO_GPU_CMD_RESOURCE_UNREF, 1)), VIRTIO_GPU_RESP_OK_NODATA);
    assert.equal(device.resources.size, 0);
    assert.equal(device.backend.scanout, null);
    assert.equal(await execute(device, make_resource_command(
        VIRTIO_GPU_CMD_RESOURCE_UNREF, 1)), VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID);
}

{
    const { device } = await make_device();
    assert.equal(await device.process_command(make_create(1,
        VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM, 1, 1), 23).then(response => response.byteLength), 0);
    const cursor_response = await device.process_command(make_request(0x0300), 24, 1);
    assert.equal(response_type(cursor_response), VIRTIO_GPU_RESP_ERR_UNSPEC);
}

{
    const backend = new OrderedBackend();
    const { cpu, device } = await make_device({ max_host_memory_bytes: 64 }, backend);
    cpu.mem8.fill(0x5A, 0x1000, 0x1040);
    assert.equal(await execute(device, make_create(1,
        VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM, 4, 4)), VIRTIO_GPU_RESP_OK_NODATA);
    assert.equal(await execute(device, make_attach(1,
        [{ addr: 0x1000, length: 64 }])), VIRTIO_GPU_RESP_OK_NODATA);
    assert.equal(await execute(device, make_scanout(0, 1,
        { x: 0, y: 0, width: 4, height: 4 })), VIRTIO_GPU_RESP_OK_NODATA);
    backend.events.length = 0;
    backend.block_upload = true;
    const upload_started = new Promise(resolve => { backend.upload_started = resolve; });
    const transfer = device.process_command(make_transfer(1,
        { x: 0, y: 0, width: 4, height: 4 }, 0), 24);
    const flush = device.process_command(make_flush(1,
        { x: 0, y: 0, width: 4, height: 4 }, { flags: VIRTIO_GPU_FLAG_FENCE }), 24);
    await upload_started;
    assert.deepEqual(backend.events, ["upload-start"]);
    backend.release_upload();
    assert.equal(response_type(await transfer), VIRTIO_GPU_RESP_OK_NODATA);
    assert.equal(response_type(await flush), VIRTIO_GPU_RESP_OK_NODATA);
    assert.deepEqual(backend.events,
        ["upload-start", "upload-end", "flush", "wait-idle"]);
}

{
    const backend = new OrderedBackend();
    const { cpu, device } = await make_device({ max_host_memory_bytes: 64 }, backend);
    cpu.mem8.fill(0xA5, 0x1000, 0x1040);
    await execute(device, make_create(1, VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM, 4, 4));
    await execute(device, make_attach(1, [{ addr: 0x1000, length: 64 }]));
    backend.block_upload = true;
    const upload_started = new Promise(resolve => { backend.upload_started = resolve; });
    const pending = device.process_command(make_transfer(1,
        { x: 0, y: 0, width: 4, height: 4 }, 0), 24);
    await upload_started;
    device.reset();
    backend.release_upload();
    assert.equal(await pending, null);
    await device.backend_ready;
    assert.equal(device.resources.size, 0);
    assert.equal(backend.resources.size, 0);
}

{
    const { cpu, device } = await make_device({ max_host_memory_bytes: 64 });
    cpu.mem8.set(Uint8Array.from({ length: 16 }, (_, index) => index + 1), 0x1000);
    await execute(device, make_create(7, VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM, 2, 2));
    await execute(device, make_attach(7, [{ addr: 0x1000, length: 16 }]));
    await execute(device, make_transfer(7, { x: 0, y: 0, width: 2, height: 2 }, 0));
    await execute(device, make_scanout(0, 7, { x: 0, y: 0, width: 2, height: 2 }));
    const state = device.get_state();
    state[0] = device.virtio.get_state();

    device.reset();
    await device.backend_ready;
    device.set_state(state);
    await device.backend_ready;
    assert.deepEqual(device.backend.resources.get(7).data,
        Uint8Array.from({ length: 16 }, (_, index) => index + 1));
    assert.deepEqual(device.backend.scanout,
        { resource_id: 7, x: 0, y: 0, width: 2, height: 2 });
    assert.equal(device.backend.flush_count, 1);
}

console.log("virtio-gpu protocol tests passed");
