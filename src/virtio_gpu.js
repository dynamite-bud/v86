import { LOG_VIRTIO } from "./const.js";
import { dbg_log } from "./log.js";
import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import { MemoryGpuBackend } from "./browser/virtio_gpu_backend.js";
import { WgpuBackend } from "./browser/virtio_gpu_wgpu_backend.js";
import { JsWebGpuBackend } from "./browser/virtio_gpu_webgpu_backend.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";
import { VirtioGpuBackend } from "./browser/virtio_gpu_backend.js";

const VIRTIO_GPU_PCI_ID = 0x0D << 3;
const VIRTIO_GPU_PCI_DEVICE_ID = 0x1050;
const VIRTIO_GPU_SUBSYSTEM_DEVICE_ID = 16;
const VIRTIO_GPU_DEVICE_CONFIG_PORT = 0xE600;
const VIRTIO_GPU_ISR_PORT = 0xE700;
const VIRTIO_GPU_COMMON_CONFIG_PORT = 0xE800;
const VIRTIO_GPU_NOTIFICATION_PORT = 0xE900;

const VIRTIO_GPU_CONTROL_QUEUE = 0;
const VIRTIO_GPU_CURSOR_QUEUE = 1;
const VIRTIO_GPU_CONTROL_QUEUE_SIZE = 256;
const VIRTIO_GPU_CURSOR_QUEUE_SIZE = 16;
const VIRTIO_GPU_MAX_SCANOUTS = 16;
const VIRTIO_GPU_MAX_BACKING_ENTRIES = 16384;
const VIRTIO_GPU_BYTES_PER_PIXEL = 4;
const VIRTIO_GPU_DEFAULT_HOST_MEMORY_BYTES = 256 * 1024 * 1024;

const VIRTIO_GPU_CTRL_HDR_SIZE = 24;
const VIRTIO_GPU_DISPLAY_ONE_SIZE = 24;
const VIRTIO_GPU_DISPLAY_INFO_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE +
    VIRTIO_GPU_MAX_SCANOUTS * VIRTIO_GPU_DISPLAY_ONE_SIZE;

export const VIRTIO_GPU_CMD_GET_DISPLAY_INFO = 0x0100;
export const VIRTIO_GPU_CMD_RESOURCE_CREATE_2D = 0x0101;
export const VIRTIO_GPU_CMD_RESOURCE_UNREF = 0x0102;
export const VIRTIO_GPU_CMD_SET_SCANOUT = 0x0103;
export const VIRTIO_GPU_CMD_RESOURCE_FLUSH = 0x0104;
export const VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D = 0x0105;
export const VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING = 0x0106;
export const VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING = 0x0107;

export const VIRTIO_GPU_RESP_OK_NODATA = 0x1100;
export const VIRTIO_GPU_RESP_OK_DISPLAY_INFO = 0x1101;
export const VIRTIO_GPU_RESP_ERR_UNSPEC = 0x1200;
export const VIRTIO_GPU_RESP_ERR_OUT_OF_MEMORY = 0x1201;
export const VIRTIO_GPU_RESP_ERR_INVALID_SCANOUT_ID = 0x1202;
export const VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID = 0x1203;
export const VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER = 0x1205;
export const VIRTIO_GPU_FLAG_FENCE = 1;

export const VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM = 1;
export const VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM = 2;
export const VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM = 67;
export const VIRTIO_GPU_FORMAT_R8G8B8X8_UNORM = 134;

const SUPPORTED_2D_FORMATS = new Set([
    VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM,
    VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM,
    VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM,
    VIRTIO_GPU_FORMAT_R8G8B8X8_UNORM,
]);

/**
 * @typedef {{addr: number, length: number}}
 */
var VirtioGpuBackingEntry;

/**
 * @typedef {{id: number, format: number, width: number, height: number,
 *            byte_length: number, backing: !Array<!VirtioGpuBackingEntry>,
 *            backing_length: number, scanout_ids: !Set<number>}}
 */
var VirtioGpuResource;

/**
 * @typedef {{resource_id: number, x: number, y: number, width: number, height: number}}
 */
var VirtioGpuScanout;

/**
 * @typedef {{type: number, flags: number, fence_id_low: number,
 *            fence_id_high: number, ctx_id: number, ring_idx: number,
 *            complete: boolean}}
 */
var VirtioGpuCtrlHeader;

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 * @param {{backend: (string|undefined), width: (number|undefined), height: (number|undefined),
 *         max_host_memory_bytes: (number|undefined), screen_container: (HTMLElement|undefined),
 *         canvas: (HTMLCanvasElement|undefined), wasm_module_url: (string|undefined),
 *         wasm_url: (string|undefined)}=} options
 * @param {VirtioGpuBackend=} backend
 */
export function VirtioGpu(cpu, bus, options = {}, backend = undefined)
{
    this.cpu = cpu;
    this.bus = bus;
    this.width = validate_mode_dimension(options.width, 1024, "width");
    this.height = validate_mode_dimension(options.height, 768, "height");
    this.max_host_memory_bytes = validate_host_memory_limit(options.max_host_memory_bytes);
    this.events_read = 0;

    if(options.backend !== undefined && options.backend !== "memory" &&
       options.backend !== "wgpu" && options.backend !== "webgpu-js")
    {
        throw new Error("Unsupported virtio-gpu backend: " + options.backend);
    }

    this.backend = backend ||
        (options.backend === "wgpu" ? new WgpuBackend(options) :
        options.backend === "webgpu-js" ? new JsWebGpuBackend(options) :
        new MemoryGpuBackend());
    this.backend_options = {
        width: this.width,
        height: this.height,
        max_host_memory_bytes: this.max_host_memory_bytes,
    };
    this.backend_work = this.backend.initialize(this.backend_options);
    this.backend_ready = this.backend_work;

    /** @type {Map<number, !VirtioGpuResource>} */
    this.resources = new Map();
    /** @type {!Array<?VirtioGpuScanout>} */
    this.scanouts = [null];
    this.resource_memory_bytes = 0;
    this.work_generation = 0;
    this.queue_active = [false, false];

    const queues = [
        { size_supported: VIRTIO_GPU_CONTROL_QUEUE_SIZE, notify_offset: VIRTIO_GPU_CONTROL_QUEUE },
        { size_supported: VIRTIO_GPU_CURSOR_QUEUE_SIZE, notify_offset: VIRTIO_GPU_CURSOR_QUEUE },
    ];

    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-gpu",
        pci_id: VIRTIO_GPU_PCI_ID,
        device_id: VIRTIO_GPU_PCI_DEVICE_ID,
        subsystem_device_id: VIRTIO_GPU_SUBSYSTEM_DEVICE_ID,
        pci_class: 0x03,
        pci_subclass: 0x80,
        pci_progif: 0,
        common:
        {
            initial_port: VIRTIO_GPU_COMMON_CONFIG_PORT,
            queues,
            features: [VIRTIO_F_VERSION_1],
            on_driver_ok: () => {
                dbg_log("VirtIO GPU driver ready", LOG_VIRTIO);
            },
        },
        notification:
        {
            initial_port: VIRTIO_GPU_NOTIFICATION_PORT,
            single_handler: false,
            handlers: [
                queue_id => this.handle_queue(queue_id),
                queue_id => this.handle_queue(queue_id),
            ],
        },
        isr_status:
        {
            initial_port: VIRTIO_GPU_ISR_PORT,
        },
        device_specific:
        {
            initial_port: VIRTIO_GPU_DEVICE_CONFIG_PORT,
            struct: [
                {
                    bytes: 4,
                    name: "events_read",
                    read: () => this.events_read,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 4,
                    name: "events_clear",
                    read: () => 0,
                    write: data => { this.events_read &= ~data; },
                },
                {
                    bytes: 4,
                    name: "num_scanouts",
                    read: () => 1,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 4,
                    name: "num_capsets",
                    read: () => 0,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 4,
                    name: "blob_alignment",
                    read: () => 0,
                    write: data => { /* read only */ },
                },
            ],
        },
    });
}

VirtioGpu.prototype.handle_queue = function(queue_id)
{
    if(this.queue_active[queue_id])
    {
        return;
    }

    const queue = this.virtio.queues[queue_id];
    if(!queue.has_request())
    {
        return;
    }

    const generation = this.work_generation;
    const bufchain = queue.pop_request();
    const request = new Uint8Array(bufchain.length_readable);
    bufchain.get_next_blob(request);
    this.queue_active[queue_id] = true;

    this.process_command(request, bufchain.length_writable, queue_id, generation).then(response =>
    {
        if(generation !== this.work_generation || response === null)
        {
            return;
        }

        dbg_log("VirtIO GPU command " + read_partial_ctrl_header(request).type +
            " response " + (response.byteLength >= 4 ?
                new DataView(response.buffer, response.byteOffset, response.byteLength).getUint32(0, true) : 0),
            LOG_VIRTIO);
        bufchain.set_next_blob(response);
        queue.push_reply(bufchain);
        queue.flush_replies();
    }, error =>
    {
        if(generation !== this.work_generation)
        {
            return;
        }

        dbg_log("VirtIO GPU command failed: " + error, LOG_VIRTIO);
        const response = create_ctrl_response_for_writable(
            VIRTIO_GPU_RESP_ERR_UNSPEC,
            read_partial_ctrl_header(request),
            bufchain.length_writable
        );
        bufchain.set_next_blob(response);
        queue.push_reply(bufchain);
        queue.flush_replies();
    }).then(() =>
    {
        if(generation !== this.work_generation)
        {
            return;
        }
        this.queue_active[queue_id] = false;
        this.handle_queue(queue_id);
    });
};

/**
 * @param {Uint8Array} request
 * @param {number} writable_length
 * @param {number} queue_id
 * @param {number} generation
 * @return {!Promise<?Uint8Array>}
 */
VirtioGpu.prototype.process_command = async function(request, writable_length,
    queue_id = VIRTIO_GPU_CONTROL_QUEUE, generation = this.work_generation)
{
    const header = read_partial_ctrl_header(request);
    if(!header.complete)
    {
        return create_ctrl_response_for_writable(
            VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header, writable_length);
    }
    if(writable_length < VIRTIO_GPU_CTRL_HDR_SIZE)
    {
        return new Uint8Array(0);
    }
    if(queue_id !== VIRTIO_GPU_CONTROL_QUEUE)
    {
        return create_ctrl_response(VIRTIO_GPU_RESP_ERR_UNSPEC, header);
    }
    if(header.type === VIRTIO_GPU_CMD_GET_DISPLAY_INFO)
    {
        return process_virtio_gpu_command(request, writable_length, this.width, this.height);
    }

    const scheduled = this.backend_work.then(async() =>
    {
        if(generation !== this.work_generation)
        {
            return null;
        }

        const response_type = await this.execute_2d_command(request, header, generation);
        if(generation !== this.work_generation)
        {
            return null;
        }
        if(response_type === VIRTIO_GPU_RESP_OK_NODATA &&
           (header.flags & VIRTIO_GPU_FLAG_FENCE))
        {
            await this.backend.waitIdle();
            if(generation !== this.work_generation)
            {
                return null;
            }
        }
        return response_type;
    });
    this.backend_work = scheduled.catch(() => {});

    let response_type;
    try
    {
        response_type = await scheduled;
    }
    catch(error)
    {
        if(generation !== this.work_generation)
        {
            return null;
        }
        dbg_log("VirtIO GPU backend error: " + error, LOG_VIRTIO);
        response_type = VIRTIO_GPU_RESP_ERR_UNSPEC;
    }

    return response_type === null ? null : create_ctrl_response(response_type, header);
};

/**
 * @param {Uint8Array} request
 * @param {VirtioGpuCtrlHeader} header
 * @param {number} generation
 * @return {!Promise<number>}
 */
VirtioGpu.prototype.execute_2d_command = async function(request, header, generation)
{
    switch(header.type)
    {
        case VIRTIO_GPU_CMD_RESOURCE_CREATE_2D:
            return this.create_resource_2d(request, generation);
        case VIRTIO_GPU_CMD_RESOURCE_UNREF:
            return this.unref_resource(request, generation);
        case VIRTIO_GPU_CMD_SET_SCANOUT:
            return this.set_scanout(request, generation);
        case VIRTIO_GPU_CMD_RESOURCE_FLUSH:
            return this.flush_resource(request);
        case VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D:
            return this.transfer_to_host_2d(request);
        case VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING:
            return this.attach_backing(request);
        case VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING:
            return this.detach_backing(request);
        default:
            return VIRTIO_GPU_RESP_ERR_UNSPEC;
    }
};

VirtioGpu.prototype.create_resource_2d = async function(request, generation)
{
    if(request.byteLength < 40)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const resource_id = view.getUint32(24, true);
    const format = view.getUint32(28, true);
    const width = view.getUint32(32, true);
    const height = view.getUint32(36, true);
    if(resource_id === 0 || this.resources.has(resource_id))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    if(!SUPPORTED_2D_FORMATS.has(format) || width === 0 || height === 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    const byte_length = checked_resource_size(width, height);
    if(byte_length === null)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    if(byte_length > this.max_host_memory_bytes - this.resource_memory_bytes)
    {
        return VIRTIO_GPU_RESP_ERR_OUT_OF_MEMORY;
    }

    await this.backend.createResource2D({ resource_id, format, width, height });
    if(generation !== this.work_generation)
    {
        return VIRTIO_GPU_RESP_OK_NODATA;
    }

    this.resources.set(resource_id, {
        id: resource_id,
        format,
        width,
        height,
        byte_length,
        backing: [],
        backing_length: 0,
        scanout_ids: new Set(),
    });
    this.resource_memory_bytes += byte_length;
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.unref_resource = async function(request, generation)
{
    if(request.byteLength < 32)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const resource_id = view_of(request).getUint32(24, true);
    const resource = this.resources.get(resource_id);
    if(!resource)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }

    await this.backend.destroyResource(resource_id);
    if(generation !== this.work_generation)
    {
        return VIRTIO_GPU_RESP_OK_NODATA;
    }

    for(const scanout_id of resource.scanout_ids)
    {
        this.scanouts[scanout_id] = null;
    }
    this.resource_memory_bytes -= resource.byte_length;
    this.resources.delete(resource_id);
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.set_scanout = async function(request, generation)
{
    if(request.byteLength < 48)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const rect = read_rect(view, 24);
    const scanout_id = view.getUint32(40, true);
    const resource_id = view.getUint32(44, true);
    if(scanout_id >= this.scanouts.length)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_SCANOUT_ID;
    }

    const old_scanout = this.scanouts[scanout_id];
    if(resource_id === 0)
    {
        await this.backend.setScanout(null);
        if(generation !== this.work_generation)
        {
            return VIRTIO_GPU_RESP_OK_NODATA;
        }
        if(old_scanout)
        {
            const old_resource = this.resources.get(old_scanout.resource_id);
            old_resource && old_resource.scanout_ids.delete(scanout_id);
        }
        this.scanouts[scanout_id] = null;
        return VIRTIO_GPU_RESP_OK_NODATA;
    }

    const resource = this.resources.get(resource_id);
    if(!resource)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    if(resource.backing.length === 0 || !valid_rect(rect, resource.width, resource.height))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    const scanout = { resource_id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    await this.backend.setScanout(scanout);
    if(generation !== this.work_generation)
    {
        return VIRTIO_GPU_RESP_OK_NODATA;
    }

    if(old_scanout)
    {
        const old_resource = this.resources.get(old_scanout.resource_id);
        old_resource && old_resource.scanout_ids.delete(scanout_id);
    }
    resource.scanout_ids.add(scanout_id);
    this.scanouts[scanout_id] = scanout;
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.flush_resource = async function(request)
{
    if(request.byteLength < 48)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const rect = read_rect(view, 24);
    const resource_id = view.getUint32(40, true);
    const resource = this.resources.get(resource_id);
    if(!resource)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    if(!valid_rect(rect, resource.width, resource.height))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    if(resource.scanout_ids.size)
    {
        await this.backend.flush({
            resource_id,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        });
    }
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.transfer_to_host_2d = async function(request)
{
    if(request.byteLength < 56)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const rect = read_rect(view, 24);
    const offset_low = view.getUint32(40, true);
    const offset_high = view.getUint32(44, true);
    const resource_id = view.getUint32(48, true);
    const resource = this.resources.get(resource_id);
    if(!resource)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    if(offset_high !== 0 || resource.backing.length === 0 ||
       !valid_rect(rect, resource.width, resource.height))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    const row_bytes = rect.width * VIRTIO_GPU_BYTES_PER_PIXEL;
    const stride = resource.width * VIRTIO_GPU_BYTES_PER_PIXEL;
    const upload_length = row_bytes * rect.height;
    const last_row_offset = offset_low + stride * (rect.height - 1);
    if(!Number.isSafeInteger(upload_length) || !Number.isSafeInteger(last_row_offset) ||
       last_row_offset + row_bytes > resource.backing_length)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    const data = new Uint8Array(upload_length);
    for(let row = 0; row < rect.height; row++)
    {
        if(!copy_backing_range(this.cpu, resource.backing,
            offset_low + row * stride, data, row * row_bytes, row_bytes))
        {
            return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
        }
    }

    await this.backend.uploadResource2D({
        resource_id,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        stride: row_bytes,
        data,
    });
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.attach_backing = async function(request)
{
    if(request.byteLength < 32)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const resource_id = view.getUint32(24, true);
    const nr_entries = view.getUint32(28, true);
    const resource = this.resources.get(resource_id);
    if(!resource)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    if(resource.backing.length || nr_entries === 0 || nr_entries > VIRTIO_GPU_MAX_BACKING_ENTRIES ||
       nr_entries > Math.floor((request.byteLength - 32) / 16))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    const backing = [];
    let backing_length = 0;
    for(let index = 0; index < nr_entries; index++)
    {
        const offset = 32 + index * 16;
        const addr = view.getUint32(offset, true);
        const addr_high = view.getUint32(offset + 4, true);
        const length = view.getUint32(offset + 8, true);
        if(addr_high !== 0 || length === 0 || !is_guest_ram_range(this.cpu, addr, length))
        {
            return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
        }
        backing_length += length;
        if(!Number.isSafeInteger(backing_length))
        {
            return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
        }
        backing.push({ addr, length });
    }

    const rounded_resource_length = Math.ceil(resource.byte_length / 4096) * 4096;
    if(backing_length < resource.byte_length || backing_length > rounded_resource_length)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    resource.backing = backing;
    resource.backing_length = backing_length;
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.detach_backing = async function(request)
{
    if(request.byteLength < 32)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const resource_id = view_of(request).getUint32(24, true);
    const resource = this.resources.get(resource_id);
    if(!resource)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    if(resource.backing.length === 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    resource.backing = [];
    resource.backing_length = 0;
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.get_state = function()
{
    const state = [];
    state[0] = this.virtio;
    state[1] = this.events_read;
    state[2] = this.width;
    state[3] = this.height;
    state[4] = Array.from(this.resources.values(), resource => [
        resource.id,
        resource.format,
        resource.width,
        resource.height,
        resource.backing.map(entry => [entry.addr, entry.length]),
    ]);
    state[5] = this.scanouts.map(scanout => scanout && [
        scanout.resource_id,
        scanout.x,
        scanout.y,
        scanout.width,
        scanout.height,
    ]);
    return state;
};

VirtioGpu.prototype.set_state = function(state)
{
    this.work_generation++;
    const generation = this.work_generation;
    this.queue_active.fill(false);
    this.virtio.set_state(state[0]);
    this.events_read = state[1];
    this.width = state[2];
    this.height = state[3];
    this.backend_options.width = this.width;
    this.backend_options.height = this.height;
    this.resources.clear();
    this.resource_memory_bytes = 0;

    for(const saved of state[4] || [])
    {
        const resource = restore_resource_metadata(saved, this.max_host_memory_bytes - this.resource_memory_bytes);
        if(resource)
        {
            this.resources.set(resource.id, resource);
            this.resource_memory_bytes += resource.byte_length;
        }
    }

    this.scanouts = [null];
    const saved_scanout = state[5] && state[5][0];
    if(saved_scanout)
    {
        const resource = this.resources.get(saved_scanout[0]);
        const rect = {
            x: saved_scanout[1],
            y: saved_scanout[2],
            width: saved_scanout[3],
            height: saved_scanout[4],
        };
        if(resource && valid_rect(rect, resource.width, resource.height))
        {
            this.scanouts[0] = {
                resource_id: resource.id,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            };
            resource.scanout_ids.add(0);
        }
    }

    this.schedule_backend_reset(generation, true);
};

VirtioGpu.prototype.reset = function()
{
    this.work_generation++;
    const generation = this.work_generation;
    this.queue_active.fill(false);
    this.events_read = 0;
    this.resources.clear();
    this.scanouts = [null];
    this.resource_memory_bytes = 0;
    this.virtio.reset();
    this.schedule_backend_reset(generation, false);
};

VirtioGpu.prototype.schedule_backend_reset = function(generation, restore_resources)
{
    const reset_work = this.backend_work.catch(() => {}).then(async() =>
    {
        await this.backend.reset();
        await this.backend.initialize(this.backend_options);
        if(!restore_resources || generation !== this.work_generation)
        {
            return;
        }

        for(const resource of this.resources.values())
        {
            if(generation !== this.work_generation)
            {
                return;
            }
            await this.backend.createResource2D({
                resource_id: resource.id,
                format: resource.format,
                width: resource.width,
                height: resource.height,
            });
            if(resource.backing.length)
            {
                const data = read_virtio_gpu_backing_range(
                    this.cpu, resource.backing, 0, resource.byte_length);
                if(data === null)
                {
                    throw new Error("Invalid virtio-gpu backing in restored state");
                }
                await this.backend.uploadResource2D({
                    resource_id: resource.id,
                    x: 0,
                    y: 0,
                    width: resource.width,
                    height: resource.height,
                    stride: resource.width * VIRTIO_GPU_BYTES_PER_PIXEL,
                    data,
                });
            }
        }

        const scanout = this.scanouts[0];
        if(scanout && generation === this.work_generation)
        {
            await this.backend.setScanout(scanout);
            await this.backend.flush({ resource_id: scanout.resource_id,
                x: scanout.x, y: scanout.y, width: scanout.width, height: scanout.height });
        }
    });
    this.backend_work = reset_work.catch(() => {});
    this.backend_ready = reset_work;
};

VirtioGpu.prototype.dispose = function()
{
    this.work_generation++;
    this.queue_active.fill(false);
    const dispose_work = this.backend_work.catch(() => {}).then(() => this.backend.dispose());
    this.backend_work = dispose_work.catch(() => {});
    return dispose_work;
};

/**
 * Pure display-info and unsupported-command handler retained for parser tests.
 * @param {Uint8Array} request
 * @param {number} writable_length
 * @param {number} width
 * @param {number} height
 * @return {Uint8Array}
 */
export function process_virtio_gpu_command(request, writable_length, width, height)
{
    const header = read_partial_ctrl_header(request);
    if(!header.complete)
    {
        return create_ctrl_response_for_writable(
            VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header, writable_length);
    }
    if(header.type !== VIRTIO_GPU_CMD_GET_DISPLAY_INFO)
    {
        return create_ctrl_response_for_writable(
            VIRTIO_GPU_RESP_ERR_UNSPEC, header, writable_length);
    }
    if(writable_length < VIRTIO_GPU_DISPLAY_INFO_SIZE)
    {
        return create_ctrl_response_for_writable(
            VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header, writable_length);
    }

    const response = create_ctrl_response(VIRTIO_GPU_RESP_OK_DISPLAY_INFO, header,
        VIRTIO_GPU_DISPLAY_INFO_SIZE);
    const view = view_of(response);
    const scanout_offset = VIRTIO_GPU_CTRL_HDR_SIZE;
    view.setUint32(scanout_offset + 8, width, true);
    view.setUint32(scanout_offset + 12, height, true);
    view.setUint32(scanout_offset + 16, 1, true);
    return response;
}

/** @param {Uint8Array} request @return {VirtioGpuCtrlHeader} */
export function read_partial_ctrl_header(request)
{
    const view = view_of(request);
    return {
        type: request.byteLength >= 4 ? view.getUint32(0, true) : 0,
        flags: request.byteLength >= 8 ? view.getUint32(4, true) : 0,
        fence_id_low: request.byteLength >= 12 ? view.getUint32(8, true) : 0,
        fence_id_high: request.byteLength >= 16 ? view.getUint32(12, true) : 0,
        ctx_id: request.byteLength >= 20 ? view.getUint32(16, true) : 0,
        ring_idx: request.byteLength >= 21 ? view.getUint8(20) : 0,
        complete: request.byteLength >= VIRTIO_GPU_CTRL_HDR_SIZE,
    };
}

/**
 * Copies a logical byte range from fragmented guest backing into an owned array.
 * @param {CPU} cpu
 * @param {!Array<!VirtioGpuBackingEntry>} backing
 * @param {number} offset
 * @param {number} length
 * @return {?Uint8Array}
 */
export function read_virtio_gpu_backing_range(cpu, backing, offset, length)
{
    if(!Number.isSafeInteger(length) || length < 0)
    {
        return null;
    }
    const result = new Uint8Array(length);
    return copy_backing_range(cpu, backing, offset, result, 0, length) ? result : null;
}

function copy_backing_range(cpu, backing, offset, destination, destination_offset, length)
{
    if(!Number.isSafeInteger(offset) || offset < 0 ||
       !Number.isSafeInteger(destination_offset) || destination_offset < 0 ||
       !Number.isSafeInteger(length) || length < 0 ||
       destination_offset + length > destination.byteLength)
    {
        return false;
    }

    let logical_offset = 0;
    let remaining = length;
    let output_offset = destination_offset;
    for(const entry of backing)
    {
        const entry_end = logical_offset + entry.length;
        if(offset < entry_end && remaining)
        {
            const entry_offset = Math.max(0, offset - logical_offset);
            const copy_length = Math.min(remaining, entry.length - entry_offset);
            const source = cpu.read_blob(entry.addr + entry_offset, copy_length);
            if(source.byteLength !== copy_length)
            {
                return false;
            }
            destination.set(source, output_offset);
            output_offset += copy_length;
            offset += copy_length;
            remaining -= copy_length;
        }
        logical_offset = entry_end;
        if(remaining === 0)
        {
            return true;
        }
    }
    return remaining === 0;
}

function restore_resource_metadata(saved, available_bytes)
{
    if(!Array.isArray(saved) || saved.length < 5)
    {
        return null;
    }
    const id = saved[0];
    const format = saved[1];
    const width = saved[2];
    const height = saved[3];
    const byte_length = checked_resource_size(width, height);
    if(!Number.isSafeInteger(id) || id <= 0 || !SUPPORTED_2D_FORMATS.has(format) ||
       byte_length === null || byte_length > available_bytes || !Array.isArray(saved[4]))
    {
        return null;
    }

    const backing = [];
    let backing_length = 0;
    for(const entry of saved[4])
    {
        if(!Array.isArray(entry) || !Number.isSafeInteger(entry[0]) || entry[0] < 0 ||
           !Number.isSafeInteger(entry[1]) || entry[1] <= 0)
        {
            return null;
        }
        backing.push({ addr: entry[0], length: entry[1] });
        backing_length += entry[1];
    }
    if(backing.length && backing_length < byte_length)
    {
        return null;
    }
    return { id, format, width, height, byte_length, backing, backing_length, scanout_ids: new Set() };
}

function is_guest_ram_range(cpu, addr, length)
{
    const end = addr + length;
    if(!Number.isSafeInteger(addr) || !Number.isSafeInteger(end) || addr < 0 || length <= 0 ||
       !cpu.mem8 || end > cpu.mem8.length)
    {
        return false;
    }
    if(typeof cpu.in_mapped_range !== "function")
    {
        return true;
    }

    for(let current = addr; current < end; current = Math.min(end, (Math.floor(current / 4096) + 1) * 4096))
    {
        if(cpu.in_mapped_range(current))
        {
            return false;
        }
    }
    return !cpu.in_mapped_range(end - 1);
}

function checked_resource_size(width, height)
{
    if(!Number.isSafeInteger(width) || width <= 0 ||
       !Number.isSafeInteger(height) || height <= 0)
    {
        return null;
    }
    const pixels = width * height;
    const bytes = pixels * VIRTIO_GPU_BYTES_PER_PIXEL;
    return Number.isSafeInteger(pixels) && Number.isSafeInteger(bytes) ? bytes : null;
}

function read_rect(view, offset)
{
    return {
        x: view.getUint32(offset, true),
        y: view.getUint32(offset + 4, true),
        width: view.getUint32(offset + 8, true),
        height: view.getUint32(offset + 12, true),
    };
}

function valid_rect(rect, resource_width, resource_height)
{
    return rect.width > 0 && rect.height > 0 &&
        rect.x <= resource_width && rect.y <= resource_height &&
        rect.width <= resource_width && rect.height <= resource_height &&
        rect.x + rect.width <= resource_width && rect.y + rect.height <= resource_height;
}

function view_of(bytes)
{
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function create_ctrl_response_for_writable(type, request_header, writable_length)
{
    return writable_length < VIRTIO_GPU_CTRL_HDR_SIZE ? new Uint8Array(0) :
        create_ctrl_response(type, request_header);
}

/**
 * @param {number} type
 * @param {VirtioGpuCtrlHeader} request_header
 * @param {number=} length
 * @return {Uint8Array}
 */
function create_ctrl_response(type, request_header, length = VIRTIO_GPU_CTRL_HDR_SIZE)
{
    const response = new Uint8Array(length);
    const view = view_of(response);
    view.setUint32(0, type, true);
    if(request_header.flags & VIRTIO_GPU_FLAG_FENCE)
    {
        view.setUint32(4, VIRTIO_GPU_FLAG_FENCE, true);
        view.setUint32(8, request_header.fence_id_low, true);
        view.setUint32(12, request_header.fence_id_high, true);
        view.setUint32(16, request_header.ctx_id, true);
    }
    return response;
}

function validate_mode_dimension(value, default_value, name)
{
    value = value === undefined ? default_value : value;
    if(!Number.isSafeInteger(value) || value <= 0 || value > 0xFFFFFFFF)
    {
        throw new Error("virtio-gpu " + name + " must be a positive 32-bit integer");
    }
    return value;
}

function validate_host_memory_limit(value)
{
    value = value === undefined ? VIRTIO_GPU_DEFAULT_HOST_MEMORY_BYTES : value;
    if(!Number.isSafeInteger(value) || value < 0)
    {
        throw new Error("virtio-gpu max_host_memory_bytes must be a non-negative safe integer");
    }
    return value;
}
