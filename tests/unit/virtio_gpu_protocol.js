#!/usr/bin/env node

import assert from "assert/strict";
import { MemoryGpuBackend } from "../../src/browser/virtio_gpu_backend.js";
import {
    VirtioGpu,
    VIRTIO_GPU_CMD_GET_DISPLAY_INFO,
    VIRTIO_GPU_RESP_OK_DISPLAY_INFO,
    VIRTIO_GPU_RESP_ERR_UNSPEC,
    VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER,
    VIRTIO_GPU_FLAG_FENCE,
    process_virtio_gpu_command,
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

function make_cpu()
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
    return {
        devices: { pci },
        io: {
            register_read(port, device, read8, read16, read32) {},
            register_write(port, device, write8, write16, write32) {},
        },
    };
}

{
    const response = process_virtio_gpu_command(
        make_request(VIRTIO_GPU_CMD_GET_DISPLAY_INFO),
        408,
        1024,
        768
    );
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
        make_request(VIRTIO_GPU_CMD_GET_DISPLAY_INFO),
        407,
        1024,
        768
    );
    assert.equal(new DataView(response.buffer).getUint32(0, true),
        VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
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
    const view = new DataView(first.buffer);
    assert.equal(view.getUint32(0, true), VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
    assert.equal(view.getUint32(4, true), VIRTIO_GPU_FLAG_FENCE);
    assert.equal(view.getUint32(8, true), 7);
    assert.equal(view.getUint32(12, true), 9);
    assert.equal(view.getUint32(16, true), 11);
}

{
    const response = process_virtio_gpu_command(new Uint8Array(0), 24, 1024, 768);
    assert.equal(response.byteLength, 24);
    assert.equal(new DataView(response.buffer).getUint32(0, true),
        VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
}

{
    const cpu = make_cpu();
    const device = new VirtioGpu(cpu, {}, { backend: "memory", width: 1280, height: 720 });
    await device.backend_ready;

    assert.equal(device.virtio.pci_space[0], 0xF4);
    assert.equal(device.virtio.pci_space[1], 0x1A);
    assert.equal(device.virtio.pci_space[2], 0x50);
    assert.equal(device.virtio.pci_space[3], 0x10);
    assert.equal(device.virtio.pci_space[9], 0);
    assert.equal(device.virtio.pci_space[10], 0x80);
    assert.equal(device.virtio.pci_space[11], 0x03);
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
    await backend.createResource2D({ resource_id: 1, width: 4, height: 4 });
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
    await backend.waitIdle();
    await backend.reset();
    assert.equal(backend.resources.size, 0);
    assert.equal(backend.scanout, null);
}

console.log("virtio-gpu protocol tests passed");
