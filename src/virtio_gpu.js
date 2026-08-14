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
const VIRTIO_GPU_DEFAULT_MAX_RESOURCE_DIMENSION = 4096;
const VIRTIO_GPU_DEFAULT_MAX_RESOURCES = 256;
const VIRTIO_GPU_DEFAULT_MAX_COMMAND_BYTES = 1024 * 1024;
const VIRTIO_GPU_DEFAULT_MAX_TOTAL_BACKING_ENTRIES = 32768;

const VIRTIO_GPU_CTRL_HDR_SIZE = 24;
const VIRTIO_GPU_DISPLAY_ONE_SIZE = 24;
const VIRTIO_GPU_DISPLAY_INFO_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE +
    VIRTIO_GPU_MAX_SCANOUTS * VIRTIO_GPU_DISPLAY_ONE_SIZE;
const VIRTIO_GPU_EDID_DATA_SIZE = 1024;
const VIRTIO_GPU_EDID_BLOCK_SIZE = 128;
const VIRTIO_GPU_EDID_RESPONSE_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE + 8 + VIRTIO_GPU_EDID_DATA_SIZE;
const V86_WEBGPU_CAPSET_ID = 7;
const V86_WEBGPU_CAPSET_VERSION = 3;
const V86_WEBGPU_CAPSET_SIZE = 912;
const V86_WEBGPU_CAPSET_MAGIC = 0x57363856;
const V86_WEBGPU_CAPSET_FORMAT_STRIDE = 12;
const V86_WEBGPU_CAPSET_MAX_CONTEXTS = 32;
const VIRTIO_GPU_CAPSET_REQUEST_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE + 8;
const VIRTIO_GPU_CTX_CREATE_REQUEST_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE + 72;
const VIRTIO_GPU_CAPSET_INFO_RESPONSE_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE + 16;
const VIRTIO_GPU_CAPSET_RESPONSE_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE + V86_WEBGPU_CAPSET_SIZE;
const V86_WEBGPU_CAPSET_MAX_COMMANDS = 64;
const V86_WEBGPU_CAPSET_MAX_SUBMIT_BYTES = 256 * 1024;
const V86_WEBGPU_CAPSET_MAX_ATTACHMENTS = 128;
const V86_WEBGPU_CAPSET_MAX_SHADERS = 32;
const V86_WEBGPU_CAPSET_V1_MAX_SHADER_BYTES = 189;
const V86_WEBGPU_CAPSET_V1_MAX_SHADER_BYTES_PER_CONTEXT =
    V86_WEBGPU_CAPSET_V1_MAX_SHADER_BYTES * V86_WEBGPU_CAPSET_MAX_SHADERS;
const V86_WEBGPU_CAPSET_V2_MAX_SHADER_BYTES = 16 * 1024;
const V86_WEBGPU_CAPSET_V2_MAX_SHADER_BYTES_PER_CONTEXT = 128 * 1024;
const V86_WEBGPU_CAPSET_V3_MAX_SHADER_BYTES = 128 * 1024;
const V86_WEBGPU_CAPSET_V3_MAX_SHADER_BYTES_PER_CONTEXT = 256 * 1024;
const V86_WEBGPU_CAPSET_MAX_COMPILATIONS = 1;
const V86_WEBGPU_CAPSET_COMPILATION_TIMEOUT_MS = 5000;
const V86_WEBGPU_CAPSET_GPU_WORK_TIMEOUT_MS = 5000;
const V86_WEBGPU_CAPSET_V2_MAX_VERTEX_INVOCATIONS = 64 * 1024;
const V86_WEBGPU_CAPSET_V2_MAX_INSTANCES = 1;
const V86_WEBGPU_CAPSET_V3_MAX_VERTEX_INVOCATIONS = 4 * 1024 * 1024;
const V86_WEBGPU_CAPSET_V3_MAX_INSTANCES = 1024;
const V86_WEBGPU_CAPSET_MAX_PIPELINES = 64;
const V86_WEBGPU_CAPSET_MAX_DRAWS = 256;
const V86_WEBGPU_CAPSET_SHADER_IR_WGSL = 1;
const V86_WEBGPU_CAPSET_SHADER_IR_SPIRV = 2;
const V86_WEBGPU_CAPSET_FEATURE_RENDER = 1;
const V86_WEBGPU_CAPSET_V3_FEATURES =
    (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 6);
const VIRTIO_GPU_RESOURCE_CREATE_3D_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE + 48;
const VIRTIO_GPU_TRANSFER_HOST_3D_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE + 48;
const VIRTIO_GPU_CTX_RESOURCE_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE + 8;
const VIRTIO_GPU_SUBMIT_3D_HEADER_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE + 8;

export const VIRTIO_GPU_F_EDID = 1;
export const VIRTIO_GPU_F_VIRGL = 0;
export const VIRTIO_GPU_F_CONTEXT_INIT = 4;
export const VIRTIO_GPU_EVENT_DISPLAY = 1;

export const VIRTIO_GPU_CMD_GET_DISPLAY_INFO = 0x0100;
export const VIRTIO_GPU_CMD_GET_EDID = 0x010A;
export const VIRTIO_GPU_CMD_GET_CAPSET_INFO = 0x0108;
export const VIRTIO_GPU_CMD_GET_CAPSET = 0x0109;
export const VIRTIO_GPU_CMD_RESOURCE_CREATE_2D = 0x0101;
export const VIRTIO_GPU_CMD_RESOURCE_UNREF = 0x0102;
export const VIRTIO_GPU_CMD_SET_SCANOUT = 0x0103;
export const VIRTIO_GPU_CMD_RESOURCE_FLUSH = 0x0104;
export const VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D = 0x0105;
export const VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING = 0x0106;
export const VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING = 0x0107;
export const VIRTIO_GPU_CMD_CTX_CREATE = 0x0200;
export const VIRTIO_GPU_CMD_CTX_DESTROY = 0x0201;
export const VIRTIO_GPU_CMD_CTX_ATTACH_RESOURCE = 0x0202;
export const VIRTIO_GPU_CMD_CTX_DETACH_RESOURCE = 0x0203;
export const VIRTIO_GPU_CMD_RESOURCE_CREATE_3D = 0x0204;
export const VIRTIO_GPU_CMD_TRANSFER_TO_HOST_3D = 0x0205;
export const VIRTIO_GPU_CMD_TRANSFER_FROM_HOST_3D = 0x0206;
export const VIRTIO_GPU_CMD_SUBMIT_3D = 0x0207;
export const VIRTIO_GPU_CMD_UPDATE_CURSOR = 0x0300;
export const VIRTIO_GPU_CMD_MOVE_CURSOR = 0x0301;

export const VIRTIO_GPU_RESP_OK_NODATA = 0x1100;
export const VIRTIO_GPU_RESP_OK_DISPLAY_INFO = 0x1101;
export const VIRTIO_GPU_RESP_OK_EDID = 0x1104;
export const VIRTIO_GPU_RESP_OK_CAPSET_INFO = 0x1102;
export const VIRTIO_GPU_RESP_OK_CAPSET = 0x1103;
export const VIRTIO_GPU_RESP_ERR_UNSPEC = 0x1200;
export const VIRTIO_GPU_RESP_ERR_OUT_OF_MEMORY = 0x1201;
export const VIRTIO_GPU_RESP_ERR_INVALID_SCANOUT_ID = 0x1202;
export const VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID = 0x1203;
export const VIRTIO_GPU_RESP_ERR_INVALID_CONTEXT_ID = 0x1204;
export const VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER = 0x1205;
export const VIRTIO_GPU_FLAG_FENCE = 1;

export const VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM = 1;
export const VIRTIO_GPU_FORMAT_R8_UNORM = 64;
export const VIRTIO_GPU_FORMAT_R8_UINT = 177;
export const VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM = 2;
export const VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM = 67;
export const VIRTIO_GPU_FORMAT_R8G8B8X8_UNORM = 134;
export const VIRTIO_GPU_FORMAT_B8G8R8A8_SRGB = 100;
export const VIRTIO_GPU_FORMAT_B8G8R8X8_SRGB = 101;
export const VIRTIO_GPU_FORMAT_R8G8B8A8_SRGB = 104;

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
 * @typedef {{id: number, target: number, bind: number, format: number,
 *            width: number, height: number, byte_length: number,
 *            bytes_per_pixel: number, backing: !Array<!VirtioGpuBackingEntry>,
 *            backing_length: number, scanout_ids: !Set<number>, is_3d: boolean}}
 */
var VirtioGpuResource;

/**
 * @typedef {{resource_id: number, x: number, y: number, width: number, height: number}}
 */
var VirtioGpuScanout;

/**
 * @typedef {{resource_id: number, scanout_id: number, x: number, y: number,
 *            hot_x: number, hot_y: number}}
 */
var VirtioGpuCursor;

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
 *         max_host_memory_bytes: (number|undefined), max_resource_dimension: (number|undefined),
 *         max_resources: (number|undefined), max_command_bytes: (number|undefined),
 *         max_backing_entries: (number|undefined), max_total_backing_entries: (number|undefined),
 *         screen_container: (HTMLElement|undefined),
 *         canvas: (HTMLCanvasElement|undefined), wasm_module_url: (string|undefined),
 *         experimental_3d: (boolean|undefined),
 *         experimental_3d_capset_probe: (boolean|undefined),
 *         wasm_url: (string|undefined)}=} options
 */
export function VirtioGpu(cpu, bus, options = {}, backend = undefined)
{
    this.cpu = cpu;
    this.bus = bus;
    this.width = validate_mode_dimension(options.width, 1024, "width");
    this.height = validate_mode_dimension(options.height, 768, "height");
    this.max_host_memory_bytes = validate_host_memory_limit(options.max_host_memory_bytes);
    this.events_read = 0;
    // Gate-only mode proves negotiation without exposing rendering commands.
    this.experimental_3d_capset_probe = options.experimental_3d_capset_probe === true;
    this.experimental_3d = options.experimental_3d === true;
    this.capset_probe_contexts = new Set();
    /** @type {Map<number, {resources: !Set<number>}>} */
    this.contexts_3d = new Map();
    this.capset_data_v1 = this.experimental_3d_capset_probe ?
        create_webgpu_capset(null, 1) : null;
    this.capset_data_v2 = this.experimental_3d_capset_probe ?
        create_webgpu_capset(null, 2) : null;
    this.capset_data = this.experimental_3d_capset_probe ?
        create_webgpu_capset(null, V86_WEBGPU_CAPSET_VERSION) : null;

    this.max_resource_dimension = validate_positive_limit(options.max_resource_dimension,
        VIRTIO_GPU_DEFAULT_MAX_RESOURCE_DIMENSION, "max_resource_dimension");
    this.max_resources = validate_positive_limit(options.max_resources,
        VIRTIO_GPU_DEFAULT_MAX_RESOURCES, "max_resources");
    this.max_command_bytes = validate_positive_limit(options.max_command_bytes,
        VIRTIO_GPU_DEFAULT_MAX_COMMAND_BYTES, "max_command_bytes", VIRTIO_GPU_CTRL_HDR_SIZE);
    this.max_backing_entries = validate_positive_limit(options.max_backing_entries,
        VIRTIO_GPU_MAX_BACKING_ENTRIES, "max_backing_entries");
    this.max_total_backing_entries = validate_positive_limit(options.max_total_backing_entries,
        VIRTIO_GPU_DEFAULT_MAX_TOTAL_BACKING_ENTRIES, "max_total_backing_entries");
    if(options.backend !== undefined && options.backend !== "memory" &&
       options.backend !== "wgpu" && options.backend !== "webgpu-js")
    {
        throw new Error("Unsupported virtio-gpu backend: " + options.backend);
    }
    if(this.experimental_3d_capset_probe && this.experimental_3d)
    {
        throw new Error("experimental_3d and experimental_3d_capset_probe are mutually exclusive");
    }
    if(this.experimental_3d_capset_probe &&
       (backend !== undefined || options.backend && options.backend !== "memory"))
    {
        throw new Error("experimental_3d_capset_probe requires the memory backend");
    }
    if(this.experimental_3d && backend === undefined && options.backend !== "wgpu")
    {
        throw new Error("experimental_3d requires the wgpu backend");
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
    /** @type {!VirtioGpuCursor} */
    this.cursor = create_empty_cursor();
    this.resource_memory_bytes = 0;
    this.backing_entry_count = 0;
    this.work_generation = 0;
    this.performance_stats = create_performance_stats();
    this.queue_active = [false, false];
    this.queue_address_error = [false, false];

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
            features: this.experimental_3d_capset_probe ?
                [VIRTIO_F_VERSION_1, VIRTIO_GPU_F_EDID,
                    VIRTIO_GPU_F_VIRGL, VIRTIO_GPU_F_CONTEXT_INIT] :
                [VIRTIO_F_VERSION_1, VIRTIO_GPU_F_EDID],
            on_driver_ok: () => {
                dbg_log("VirtIO GPU driver ready", LOG_VIRTIO);
                if(this.events_read)
                {
                    this.virtio.notify_config_changes();
                }
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
                    read: () => this.capset_data ? 1 : 0,
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
    if(this.experimental_3d)
    {
        this.backend_ready = this.backend_work.then(() => this.initialize_3d());
        this.backend_work = this.backend_ready;
    }
}

VirtioGpu.prototype.initialize_3d = async function()
{
    let capabilities;
    try
    {
        capabilities = await this.backend.get3DCapabilities();
    }
    catch(error)
    {
        dbg_log("VirtIO GPU 3D preflight failed: " + error, LOG_VIRTIO);
        return;
    }
    if(!capabilities ||
       !Number.isSafeInteger(capabilities.max_texture_dimension_2d) ||
       !Number.isSafeInteger(capabilities.max_color_attachments) ||
       capabilities.max_texture_dimension_2d < 1 ||
       capabilities.max_color_attachments < 1)
    {
        dbg_log("VirtIO GPU 3D preflight unavailable; continuing with 2D", LOG_VIRTIO);
        return;
    }

    const capset_capabilities = {
        max_texture_dimension_2d: capabilities.max_texture_dimension_2d,
        max_bind_groups: capabilities.max_bind_groups,
        max_color_attachments: capabilities.max_color_attachments,
        max_resources: this.max_resources,
        max_resource_dimension: this.max_resource_dimension,
        max_host_memory_bytes: this.max_host_memory_bytes,
    };
    this.capset_data_v1 = create_webgpu_capset(capset_capabilities, 1);
    this.capset_data_v2 = create_webgpu_capset(capset_capabilities, 2);
    this.capset_data = create_webgpu_capset(
        capset_capabilities, V86_WEBGPU_CAPSET_VERSION);
    const feature_mask = (1 << VIRTIO_GPU_F_VIRGL) | (1 << VIRTIO_GPU_F_CONTEXT_INIT);
    this.virtio.device_feature[0] |= feature_mask;
    this.virtio.driver_feature[0] |= feature_mask;
};


VirtioGpu.prototype.set_display_size = function(width, height)
{
    width = validate_mode_dimension(width, undefined, "width");
    height = validate_mode_dimension(height, undefined, "height");
    if(width === this.width && height === this.height)
    {
        return false;
    }

    this.width = width;
    this.height = height;
    this.backend_options.width = width;
    this.backend_options.height = height;
    this.events_read |= VIRTIO_GPU_EVENT_DISPLAY;
    this.performance_stats.config_changes++;
    if(this.virtio.is_driver_ok())
    {
        this.virtio.notify_config_changes();
    }
    return true;
};

VirtioGpu.prototype.record_command = function(type)
{
    const stats = this.performance_stats;
    stats.commands++;
    stats.command_counts.set(type, (stats.command_counts.get(type) || 0) + 1);
};

VirtioGpu.prototype.record_response = function(type)
{
    if(type >= VIRTIO_GPU_RESP_ERR_UNSPEC)
    {
        this.performance_stats.invalid_commands++;
    }
};

VirtioGpu.prototype.get_performance_stats = function(reset = false)
{
    const stats = this.performance_stats;
    const command_counts = {};
    for(const [type, count] of stats.command_counts)
    {
        command_counts["0x" + type.toString(16)] = count;
    }
    const result = {
        commands: stats.commands,
        invalid_commands: stats.invalid_commands,
        guest_read_bytes: stats.guest_read_bytes,
        upload_bytes: stats.upload_bytes,
        flushes: stats.flushes,
        flushed_bytes: stats.flushed_bytes,
        presentations: stats.presentations,
        presented_bytes: stats.presented_bytes,
        cursor_updates: stats.cursor_updates,
        cursor_moves: stats.cursor_moves,
        fenced_commands: stats.fenced_commands,
        fence_wait_ms: stats.fence_wait_ms,
        guest_copy_ms: stats.guest_copy_ms,
        upload_wait_ms: stats.upload_wait_ms,
        present_wait_ms: stats.present_wait_ms,
        backend_errors: stats.backend_errors,
        config_changes: stats.config_changes,
        max_active_queues: stats.max_active_queues,
        command_counts,
        live_resources: this.resources.size,
        resource_memory_bytes: this.resource_memory_bytes,
        backing_entries: this.backing_entry_count,
        live_3d_contexts: this.contexts_3d.size,
        live_3d_resources: Array.from(this.resources.values())
            .filter(resource => resource.is_3d).length,
        context_attachments: Array.from(this.contexts_3d.values())
            .reduce((sum, context) => sum + context.resources.size, 0),
    };
    if(reset)
    {
        this.performance_stats = create_performance_stats();
    }
    return result;
};

VirtioGpu.prototype.handle_queue = function(queue_id)
{
    if(this.queue_active[queue_id])
    {
        return;
    }

    const queue = this.virtio.queues[queue_id];
    if(!is_valid_gpu_queue(this.cpu, queue))
    {
        if(!this.queue_address_error[queue_id])
        {
            this.queue_address_error[queue_id] = true;
            this.performance_stats.invalid_commands++;
            this.virtio.needs_reset();
        }
        return;
    }
    if(!queue.has_request())
    {
        return;
    }

    const generation = this.work_generation;
    const bufchain = queue.pop_request();
    const valid_chain = is_valid_gpu_buffer_chain(
        this.cpu, bufchain, this.max_command_bytes);
    const oversized = valid_chain && bufchain.length_readable > this.max_command_bytes;
    const rejected = !valid_chain || oversized;
    const writable_length = valid_chain ? bufchain.length_writable : 0;
    const request = new Uint8Array(
        rejected ? VIRTIO_GPU_CTRL_HDR_SIZE : bufchain.length_readable);
    if(valid_chain)
    {
        bufchain.get_next_blob(request);
    }
    this.queue_active[queue_id] = true;
    const active_queues = (this.queue_active[0] ? 1 : 0) + (this.queue_active[1] ? 1 : 0);
    this.performance_stats.max_active_queues =
        Math.max(this.performance_stats.max_active_queues, active_queues);
    if(rejected)
    {
        this.record_command(read_partial_ctrl_header(request).type);
        this.record_response(VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
    }

    const command_work = rejected ? Promise.resolve(create_ctrl_response_for_writable(
        VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER,
        read_partial_ctrl_header(request),
        writable_length
    )) : this.process_command(request, writable_length, queue_id, generation);
    command_work.then(response =>
    {
        if(generation !== this.work_generation || response === null)
        {
            return;
        }

        dbg_log("VirtIO GPU command " + read_partial_ctrl_header(request).type +
            " response " + (response.byteLength >= 4 ?
                new DataView(response.buffer, response.byteOffset, response.byteLength)
                    .getUint32(0, true) : 0),
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
    this.record_command(header.type);
    if(!header.complete || request.byteLength > this.max_command_bytes)
    {
        this.record_response(VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
        return create_ctrl_response_for_writable(
            VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header, writable_length);
    }
    if(writable_length < VIRTIO_GPU_CTRL_HDR_SIZE)
    {
        this.record_response(VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
        return new Uint8Array(0);
    }
    const cursor_queue_command = queue_id === VIRTIO_GPU_CURSOR_QUEUE &&
        (header.type === VIRTIO_GPU_CMD_UPDATE_CURSOR ||
         header.type === VIRTIO_GPU_CMD_MOVE_CURSOR);
    if(queue_id !== VIRTIO_GPU_CONTROL_QUEUE && !cursor_queue_command)
    {
        this.record_response(VIRTIO_GPU_RESP_ERR_UNSPEC);
        return create_ctrl_response(VIRTIO_GPU_RESP_ERR_UNSPEC, header);
    }
    if(this.capset_data &&
       (header.type === VIRTIO_GPU_CMD_GET_CAPSET_INFO ||
        header.type === VIRTIO_GPU_CMD_GET_CAPSET ||
        this.experimental_3d_capset_probe &&
        (header.type === VIRTIO_GPU_CMD_CTX_CREATE ||
         header.type === VIRTIO_GPU_CMD_CTX_DESTROY)))
    {
        const response = this.process_capset_probe_command(request, writable_length, header);
        this.record_response(response.byteLength >= 4 ?
            view_of(response).getUint32(0, true) : VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
        return response;
    }

    if(header.type === VIRTIO_GPU_CMD_GET_DISPLAY_INFO ||
       header.type === VIRTIO_GPU_CMD_GET_EDID)
    {
        const response = process_virtio_gpu_command(
            request, writable_length, this.width, this.height);
        this.record_response(response.byteLength >= 4 ?
            view_of(response).getUint32(0, true) : VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER);
        return response;
    }

    const scheduled = this.backend_work.then(async() =>
    {
        if(generation !== this.work_generation)
        {
            return null;
        }

        const response_type = cursor_queue_command ?
            await this.execute_cursor_command(request, header) :
            await this.execute_2d_command(request, header, generation);
        if(generation !== this.work_generation)
        {
            return null;
        }
        if(response_type === VIRTIO_GPU_RESP_OK_NODATA &&
           (header.flags & VIRTIO_GPU_FLAG_FENCE))
        {
            this.performance_stats.fenced_commands++;
            if(header.type !== VIRTIO_GPU_CMD_SUBMIT_3D)
            {
                const wait_started = performance_now();
                await this.backend.waitIdle();
                this.performance_stats.fence_wait_ms += performance_now() - wait_started;
            }
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
        this.performance_stats.backend_errors++;
        response_type = VIRTIO_GPU_RESP_ERR_UNSPEC;
    }

    if(response_type !== null)
    {
        this.record_response(response_type);
    }
    return response_type === null ? null : create_ctrl_response(response_type, header);
};

VirtioGpu.prototype.process_capset_probe_command = function(request, writable_length, header)
{
    const capset_data = this.capset_data;
    if(capset_data === null)
    {
        return create_ctrl_response_for_writable(
            VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header, writable_length);
    }
    const view = view_of(request);
    if(header.type === VIRTIO_GPU_CMD_GET_CAPSET_INFO)
    {
        if(request.byteLength !== VIRTIO_GPU_CAPSET_REQUEST_SIZE ||
           writable_length < VIRTIO_GPU_CAPSET_INFO_RESPONSE_SIZE ||
           view.getUint32(24, true) !== 0 || view.getUint32(28, true) !== 0)
        {
            return create_ctrl_response_for_writable(
                VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header, writable_length);
        }
        const response = create_ctrl_response(VIRTIO_GPU_RESP_OK_CAPSET_INFO, header,
            VIRTIO_GPU_CAPSET_INFO_RESPONSE_SIZE);
        const response_view = view_of(response);
        response_view.setUint32(24, V86_WEBGPU_CAPSET_ID, true);
        response_view.setUint32(28, V86_WEBGPU_CAPSET_VERSION, true);
        response_view.setUint32(32, V86_WEBGPU_CAPSET_SIZE, true);
        return response;
    }
    if(header.type === VIRTIO_GPU_CMD_GET_CAPSET)
    {
        const version = view.getUint32(28, true);
        const requested_capset = version === 1 ? this.capset_data_v1 :
            version === 2 ? this.capset_data_v2 :
            version === V86_WEBGPU_CAPSET_VERSION ? capset_data : null;
        if(request.byteLength !== VIRTIO_GPU_CAPSET_REQUEST_SIZE ||
           writable_length < VIRTIO_GPU_CAPSET_RESPONSE_SIZE ||
           view.getUint32(24, true) !== V86_WEBGPU_CAPSET_ID ||
           requested_capset === null)
        {
            return create_ctrl_response_for_writable(
                VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header, writable_length);
        }
        const response = create_ctrl_response(VIRTIO_GPU_RESP_OK_CAPSET, header,
            VIRTIO_GPU_CAPSET_RESPONSE_SIZE);
        response.set(requested_capset, VIRTIO_GPU_CTRL_HDR_SIZE);
        return response;
    }
    if(header.type === VIRTIO_GPU_CMD_CTX_CREATE)
    {
        const name_length = request.byteLength >= 28 ? view.getUint32(24, true) : 65;
        const context_init = request.byteLength >= 32 ? view.getUint32(28, true) : 0;
        if(request.byteLength !== VIRTIO_GPU_CTX_CREATE_REQUEST_SIZE ||
           header.ctx_id === 0 || header.ring_idx !== 0 ||
           name_length > 64 || context_init !== V86_WEBGPU_CAPSET_ID ||
           this.capset_probe_contexts.size >= V86_WEBGPU_CAPSET_MAX_CONTEXTS ||
           this.capset_probe_contexts.has(header.ctx_id))
        {
            return create_ctrl_response_for_writable(
                VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header, writable_length);
        }
        this.capset_probe_contexts.add(header.ctx_id);
        return create_ctrl_response(VIRTIO_GPU_RESP_OK_NODATA, header);
    }
    if(request.byteLength !== VIRTIO_GPU_CTRL_HDR_SIZE || header.ctx_id === 0 ||
       header.ring_idx !== 0 || !this.capset_probe_contexts.delete(header.ctx_id))
    {
        return create_ctrl_response_for_writable(
            VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header, writable_length);
    }
    return create_ctrl_response(VIRTIO_GPU_RESP_OK_NODATA, header);
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
        case VIRTIO_GPU_CMD_CTX_CREATE:
            return this.create_context_3d(request, header, generation);
        case VIRTIO_GPU_CMD_CTX_DESTROY:
            return this.destroy_context_3d(request, header, generation);
        case VIRTIO_GPU_CMD_CTX_ATTACH_RESOURCE:
            return this.attach_resource_3d(request, header);
        case VIRTIO_GPU_CMD_CTX_DETACH_RESOURCE:
            return this.detach_resource_3d(request, header);
        case VIRTIO_GPU_CMD_RESOURCE_CREATE_3D:
            return this.create_resource_3d(request, generation);
        case VIRTIO_GPU_CMD_TRANSFER_TO_HOST_3D:
            return this.transfer_to_host_3d(request);
        case VIRTIO_GPU_CMD_TRANSFER_FROM_HOST_3D:
            return this.transfer_from_host_3d(request);
        case VIRTIO_GPU_CMD_SUBMIT_3D:
            return this.submit_3d(request, header);
        default:
            return VIRTIO_GPU_RESP_ERR_UNSPEC;
    }
};

VirtioGpu.prototype.create_context_3d = async function(request, header, generation)
{
    if(!this.experimental_3d || !this.capset_data ||
       request.byteLength !== VIRTIO_GPU_CTX_CREATE_REQUEST_SIZE ||
       header.ctx_id === 0 || header.ring_idx !== 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const name_length = view.getUint32(24, true);
    const context_init = view.getUint32(28, true);
    if(name_length > 64 || context_init !== V86_WEBGPU_CAPSET_ID ||
       this.contexts_3d.size >= V86_WEBGPU_CAPSET_MAX_CONTEXTS ||
       this.contexts_3d.has(header.ctx_id))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    await this.backend.createContext3D(header.ctx_id);
    if(generation === this.work_generation)
    {
        this.contexts_3d.set(header.ctx_id, { resources: new Set() });
    }
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.destroy_context_3d = async function(request, header, generation)
{
    if(!this.experimental_3d || !this.capset_data ||
       request.byteLength !== VIRTIO_GPU_CTRL_HDR_SIZE ||
       header.ctx_id === 0 || header.ring_idx !== 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    if(!this.contexts_3d.has(header.ctx_id))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_CONTEXT_ID;
    }

    await this.backend.destroyContext3D(header.ctx_id);
    if(generation === this.work_generation)
    {
        this.contexts_3d.delete(header.ctx_id);
    }
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.attach_resource_3d = async function(request, header)
{
    if(!this.experimental_3d || !this.capset_data ||
       request.byteLength !== VIRTIO_GPU_CTX_RESOURCE_SIZE ||
       header.ctx_id === 0 || header.ring_idx !== 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const resource_id = view.getUint32(24, true);
    const context = this.contexts_3d.get(header.ctx_id);
    if(!context)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_CONTEXT_ID;
    }
    const resource = this.resources.get(resource_id);
    if(!resource)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    if(!resource.is_3d || view.getUint32(28, true) !== 0 ||
       context.resources.size >= V86_WEBGPU_CAPSET_MAX_ATTACHMENTS ||
       context.resources.has(resource_id))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    await this.backend.attachResource3D(header.ctx_id, resource_id);
    context.resources.add(resource_id);
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.detach_resource_3d = async function(request, header)
{
    if(!this.experimental_3d || !this.capset_data ||
       request.byteLength !== VIRTIO_GPU_CTX_RESOURCE_SIZE ||
       header.ctx_id === 0 || header.ring_idx !== 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const resource_id = view.getUint32(24, true);
    const context = this.contexts_3d.get(header.ctx_id);
    if(!context)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_CONTEXT_ID;
    }
    if(view.getUint32(28, true) !== 0 || !context.resources.has(resource_id))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    await this.backend.detachResource3D(header.ctx_id, resource_id);
    context.resources.delete(resource_id);
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.create_resource_3d = async function(request, generation)
{
    if(!this.experimental_3d || !this.capset_data ||
       request.byteLength !== VIRTIO_GPU_RESOURCE_CREATE_3D_SIZE)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const resource_id = view.getUint32(24, true);
    const target = view.getUint32(28, true);
    const format = view.getUint32(32, true);
    const bind = view.getUint32(36, true);
    const width = view.getUint32(40, true);
    const height = view.getUint32(44, true);
    const depth = view.getUint32(48, true);
    const array_size = view.getUint32(52, true);
    const last_level = view.getUint32(56, true);
    const nr_samples = view.getUint32(60, true);
    const flags = view.getUint32(64, true);
    const padding = view.getUint32(68, true);
    if(resource_id === 0 || this.resources.has(resource_id))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    const is_buffer = target === 0 && format === VIRTIO_GPU_FORMAT_R8_UNORM &&
        height === 1 &&
        (bind & ~((1 << 2) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 14))) === 0 &&
        bind !== 0;
    const is_texture = (target === 2 || target === 5) &&
        (format === VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM ||
         format === VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM ||
         format === VIRTIO_GPU_FORMAT_B8G8R8A8_SRGB ||
         format === VIRTIO_GPU_FORMAT_B8G8R8X8_SRGB ||
         format === VIRTIO_GPU_FORMAT_R8_UNORM ||
         format === VIRTIO_GPU_FORMAT_R8_UINT ||
         format === VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM ||
         format === VIRTIO_GPU_FORMAT_R8G8B8A8_SRGB) &&
        (bind & ~((1 << 1) | (1 << 3) | (1 << 7) | (1 << 18) | (1 << 20))) === 0 &&
        bind !== 0;
    if((!is_buffer && !is_texture) || width === 0 || height === 0 ||
       is_texture && (width > this.max_resource_dimension ||
                      height > this.max_resource_dimension) ||
       depth !== 1 || array_size !== 1 || last_level !== 0 || nr_samples > 1 ||
       flags !== 0 || padding !== 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    if(this.resources.size >= this.max_resources)
    {
        return VIRTIO_GPU_RESP_ERR_OUT_OF_MEMORY;
    }
    const bytes_per_pixel = format === VIRTIO_GPU_FORMAT_R8_UNORM ||
        format === VIRTIO_GPU_FORMAT_R8_UINT ? 1 : 4;
    const byte_length = checked_resource_size(width, height, bytes_per_pixel);
    if(byte_length === null)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    if(byte_length > this.max_host_memory_bytes - this.resource_memory_bytes)
    {
        return VIRTIO_GPU_RESP_ERR_OUT_OF_MEMORY;
    }

    const backend_format = format === VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM ||
        format === VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM ?
        VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM :
        format === VIRTIO_GPU_FORMAT_B8G8R8A8_SRGB ||
        format === VIRTIO_GPU_FORMAT_B8G8R8X8_SRGB ?
        VIRTIO_GPU_FORMAT_R8G8B8A8_SRGB : format;
    await this.backend.createResource3D({
        resource_id, target, bind, format: backend_format, width, height, byte_length,
    });
    if(generation !== this.work_generation)
    {
        return VIRTIO_GPU_RESP_OK_NODATA;
    }
    this.resources.set(resource_id, {
        id: resource_id,
        target,
        bind,
        format,
        width,
        height,
        byte_length,
        bytes_per_pixel,
        backing: [],
        backing_length: 0,
        scanout_ids: new Set(),
        is_3d: true,
    });
    this.resource_memory_bytes += byte_length;
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.transfer_to_host_3d = async function(request)
{
    if(!this.experimental_3d || !this.capset_data ||
       request.byteLength !== VIRTIO_GPU_TRANSFER_HOST_3D_SIZE)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const rect = {
        x: view.getUint32(24, true),
        y: view.getUint32(28, true),
        width: view.getUint32(36, true),
        height: view.getUint32(40, true),
    };
    const resource_id = view.getUint32(56, true);
    const resource = this.resources.get(resource_id);
    if(!resource)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    const offset = view.getUint32(48, true);
    const offset_high = view.getUint32(52, true);
    const stride = view.getUint32(64, true);
    const layer_stride = view.getUint32(68, true);
    if(!resource.is_3d || resource.backing.length === 0 ||
       view.getUint32(32, true) !== 0 || view.getUint32(44, true) !== 1 ||
       offset_high !== 0 || view.getUint32(60, true) !== 0 ||
       !valid_rect(rect, resource.width, resource.height))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const row_bytes = rect.width * resource.bytes_per_pixel;
    const effective_stride = stride === 0 ? row_bytes : stride;
    if(effective_stride < row_bytes || layer_stride !== 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const upload_length = row_bytes * rect.height;
    const last_row_offset = offset + effective_stride * (rect.height - 1);
    const max_transfer_bytes = view_of(this.capset_data).getUint32(76, true);
    if(!Number.isSafeInteger(upload_length) || upload_length > max_transfer_bytes ||
       !Number.isSafeInteger(last_row_offset) ||
       last_row_offset + row_bytes > resource.backing_length)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const data = new Uint8Array(upload_length);
    for(let row = 0; row < rect.height; row++)
    {
        if(!copy_backing_range(this.cpu, resource.backing,
            offset + row * effective_stride, data, row * row_bytes, row_bytes))
        {
            return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
        }
    }
    await this.backend.transferToHost3D({
        resource_id,
        ...rect,
        stride: row_bytes,
        data,
    });
    this.performance_stats.guest_read_bytes += upload_length;
    this.performance_stats.upload_bytes += upload_length;
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.transfer_from_host_3d = async function(request)
{
    if(!this.experimental_3d || !this.capset_data ||
       request.byteLength !== VIRTIO_GPU_TRANSFER_HOST_3D_SIZE)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const rect = {
        x: view.getUint32(24, true),
        y: view.getUint32(28, true),
        width: view.getUint32(36, true),
        height: view.getUint32(40, true),
    };
    const resource_id = view.getUint32(56, true);
    const resource = this.resources.get(resource_id);
    if(!resource)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    const offset = view.getUint32(48, true);
    const offset_high = view.getUint32(52, true);
    const stride = view.getUint32(64, true);
    const layer_stride = view.getUint32(68, true);
    this.last_transfer_from_host_3d = {
        resource_id,
        rect,
        z: view.getUint32(32, true),
        depth: view.getUint32(44, true),
        offset,
        offset_high,
        level: view.getUint32(60, true),
        stride,
        layer_stride,
        resource: resource && {
            width: resource.width,
            height: resource.height,
            backing_length: resource.backing_length,
            bytes_per_pixel: resource.bytes_per_pixel,
        },
    };
    if(!resource.is_3d || resource.backing.length === 0 ||
       view.getUint32(32, true) !== 0 || view.getUint32(44, true) !== 1 ||
       offset_high !== 0 || view.getUint32(60, true) !== 0 ||
       !valid_rect(rect, resource.width, resource.height))
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const row_bytes = rect.width * resource.bytes_per_pixel;
    const effective_stride = stride === 0 ? row_bytes : stride;
    if(effective_stride < row_bytes || layer_stride !== 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const download_length = row_bytes * rect.height;
    const last_row_offset = offset + effective_stride * (rect.height - 1);
    const max_transfer_bytes = view_of(this.capset_data).getUint32(76, true);
    if(!Number.isSafeInteger(download_length) || download_length > max_transfer_bytes ||
       !Number.isSafeInteger(last_row_offset) ||
       last_row_offset + row_bytes > resource.backing_length)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const data = await this.backend.transferFromHost3D({
        resource_id,
        ...rect,
        stride: row_bytes,
    });
    if(!(data instanceof Uint8Array) || data.byteLength !== download_length)
    {
        throw new TypeError("VirtIO GPU backend returned an invalid 3D download");
    }
    for(let row = 0; row < rect.height; row++)
    {
        if(!write_backing_range(this.cpu, resource.backing,
            offset + row * effective_stride, data, row * row_bytes, row_bytes))
        {
            return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
        }
    }
    return VIRTIO_GPU_RESP_OK_NODATA;
};

VirtioGpu.prototype.submit_3d = async function(request, header)
{
    if(!this.experimental_3d || !this.capset_data ||
       request.byteLength < VIRTIO_GPU_SUBMIT_3D_HEADER_SIZE ||
       header.ctx_id === 0 || header.ring_idx !== 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const context = this.contexts_3d.get(header.ctx_id);
    if(!context)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_CONTEXT_ID;
    }
    const view = view_of(request);
    const size = view.getUint32(24, true);
    if(size === 0 || size > V86_WEBGPU_CAPSET_MAX_SUBMIT_BYTES ||
       size > this.max_command_bytes - VIRTIO_GPU_SUBMIT_3D_HEADER_SIZE ||
       view.getUint32(28, true) !== 0 ||
       request.byteLength !== VIRTIO_GPU_SUBMIT_3D_HEADER_SIZE + size)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const commands = new Uint8Array(size);
    commands.set(request.subarray(VIRTIO_GPU_SUBMIT_3D_HEADER_SIZE));
    const resources = Uint32Array.from(context.resources);
    const accepted = await this.backend.submit3D(header.ctx_id, commands, resources);
    return accepted ? VIRTIO_GPU_RESP_OK_NODATA : VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
};

VirtioGpu.prototype.execute_cursor_command = async function(request, header)
{
    if(request.byteLength < 56)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const view = view_of(request);
    const scanout_id = view.getUint32(24, true);
    const x = view.getUint32(28, true);
    const y = view.getUint32(32, true);
    if(scanout_id >= this.scanouts.length)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_SCANOUT_ID;
    }

    if(header.type === VIRTIO_GPU_CMD_MOVE_CURSOR)
    {
        this.cursor.scanout_id = scanout_id;
        this.cursor.x = x;
        this.cursor.y = y;
        this.performance_stats.cursor_moves++;
        if(this.cursor.resource_id)
        {
            await this.backend.setCursor({ ...this.cursor, data: null });
        }
        return VIRTIO_GPU_RESP_OK_NODATA;
    }

    const resource_id = view.getUint32(40, true);
    const hot_x = view.getUint32(44, true);
    const hot_y = view.getUint32(48, true);
    if(resource_id === 0)
    {
        this.performance_stats.cursor_updates++;
        this.cursor = { resource_id: 0, scanout_id, x, y, hot_x: 0, hot_y: 0 };
        await this.backend.setCursor(null);
        return VIRTIO_GPU_RESP_OK_NODATA;
    }

    const resource = this.resources.get(resource_id);
    if(!resource)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID;
    }
    if(resource.width !== 64 || resource.height !== 64 ||
       hot_x >= resource.width || hot_y >= resource.height ||
       resource.backing.length === 0)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    const source = read_virtio_gpu_backing_range(
        this.cpu, resource.backing, 0, resource.byte_length);
    if(source === null)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }

    this.cursor = { resource_id, scanout_id, x, y, hot_x, hot_y };
    await this.backend.setCursor({
        ...this.cursor,
        data: convert_cursor_pixels(source, resource.format),
    });
    this.performance_stats.cursor_updates++;
    return VIRTIO_GPU_RESP_OK_NODATA;
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
    if(!SUPPORTED_2D_FORMATS.has(format) || width === 0 || height === 0 ||
       width > this.max_resource_dimension || height > this.max_resource_dimension)
    {
        return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
    }
    if(this.resources.size >= this.max_resources)
    {
        return VIRTIO_GPU_RESP_ERR_OUT_OF_MEMORY;
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
        target: 2,
        bind: (1 << 1) | (1 << 7),
        format,
        width,
        height,
        byte_length,
        bytes_per_pixel: VIRTIO_GPU_BYTES_PER_PIXEL,
        backing: [],
        backing_length: 0,
        scanout_ids: new Set(),
        is_3d: false,
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

    if(this.cursor.resource_id === resource_id)
    {
        await this.backend.setCursor(null);
        if(generation !== this.work_generation)
        {
            return VIRTIO_GPU_RESP_OK_NODATA;
        }
        this.cursor = create_empty_cursor();
    }

    await this.backend.destroyResource(resource_id);
    if(generation !== this.work_generation)
    {
        return VIRTIO_GPU_RESP_OK_NODATA;
    }

    for(const context of this.contexts_3d.values())
    {
        context.resources.delete(resource_id);
    }
    for(const scanout_id of resource.scanout_ids)
    {
        this.scanouts[scanout_id] = null;
    }
    this.resource_memory_bytes -= resource.byte_length;
    this.backing_entry_count -= resource.backing.length;
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
        const present_started = performance_now();
        try
        {
            await this.backend.flush({
                resource_id,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            });
        }
        finally
        {
            this.performance_stats.present_wait_ms += performance_now() - present_started;
        }
        this.performance_stats.presentations++;
        this.performance_stats.presented_bytes +=
            rect.width * rect.height * VIRTIO_GPU_BYTES_PER_PIXEL;
    }
    this.performance_stats.flushes++;
    this.performance_stats.flushed_bytes +=
        rect.width * rect.height * VIRTIO_GPU_BYTES_PER_PIXEL;
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
    if(resource.is_3d || offset_high !== 0 || resource.backing.length === 0 ||
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

    const copy_started = performance_now();
    const data = new Uint8Array(upload_length);
    if(row_bytes === stride)
    {
        if(!copy_backing_range(this.cpu, resource.backing,
            offset_low, data, 0, upload_length))
        {
            return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
        }
    }
    else
    {
        for(let row = 0; row < rect.height; row++)
        {
            if(!copy_backing_range(this.cpu, resource.backing,
                offset_low + row * stride, data, row * row_bytes, row_bytes))
            {
                return VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER;
            }
        }
    }
    this.performance_stats.guest_copy_ms += performance_now() - copy_started;

    const upload_started = performance_now();
    try
    {
        await this.backend.uploadResource2D({
            resource_id,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            stride: row_bytes,
            data,
        });
    }
    finally
    {
        this.performance_stats.upload_wait_ms += performance_now() - upload_started;
    }
    this.performance_stats.guest_read_bytes += upload_length;
    this.performance_stats.upload_bytes += upload_length;
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
    if(resource.backing.length || nr_entries === 0 || nr_entries > this.max_backing_entries ||
       nr_entries > this.max_total_backing_entries - this.backing_entry_count ||
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
    this.backing_entry_count += backing.length;
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
    this.backing_entry_count -= resource.backing.length;
    resource.backing = [];
    resource.backing_length = 0;
    return VIRTIO_GPU_RESP_OK_NODATA;
};
VirtioGpu.prototype.get_state = function()
{
    if(this.capset_probe_contexts.size)
    {
        throw new Error("Cannot save virtio-gpu state while a capset probe context is live");
    }
    if(this.contexts_3d.size ||
       Array.from(this.resources.values()).some(resource => resource.is_3d))
    {
        throw new Error("Cannot save virtio-gpu state while 3D state is live");
    }

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
    state[6] = [
        this.cursor.resource_id,
        this.cursor.scanout_id,
        this.cursor.x,
        this.cursor.y,
        this.cursor.hot_x,
        this.cursor.hot_y,
    ];
    return state;
};

VirtioGpu.prototype.set_state = function(state)
{
    this.work_generation++;
    const generation = this.work_generation;
    this.queue_active.fill(false);
    this.queue_address_error.fill(false);
    this.capset_probe_contexts.clear();
    this.contexts_3d.clear();
    this.virtio.set_state(state[0]);
    this.events_read = is_uint32(state[1]) ? state[1] : 0;
    this.width = restore_mode_dimension(state[2], this.width);
    this.height = restore_mode_dimension(state[3], this.height);
    this.backend_options.width = this.width;
    this.backend_options.height = this.height;
    this.resources.clear();
    this.resource_memory_bytes = 0;
    this.backing_entry_count = 0;

    for(const saved of Array.isArray(state[4]) ? state[4] : [])
    {
        if(this.resources.size >= this.max_resources)
        {
            break;
        }
        const resource = restore_resource_metadata(saved,
            this.max_host_memory_bytes - this.resource_memory_bytes,
            this.max_resource_dimension,
            Math.min(this.max_backing_entries,
                this.max_total_backing_entries - this.backing_entry_count),
            this.cpu);
        if(resource && !this.resources.has(resource.id))
        {
            this.resources.set(resource.id, resource);
            this.resource_memory_bytes += resource.byte_length;
            this.backing_entry_count += resource.backing.length;
        }
    }

    this.scanouts = [null];
    const saved_scanout = Array.isArray(state[5]) && Array.isArray(state[5][0]) &&
        state[5][0];
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

    this.cursor = restore_cursor_metadata(state[6], this.resources);
    this.schedule_backend_reset(generation, true);
};

VirtioGpu.prototype.reset = function()
{
    this.work_generation++;
    const generation = this.work_generation;
    this.queue_active.fill(false);
    this.queue_address_error.fill(false);
    this.capset_probe_contexts.clear();
    this.contexts_3d.clear();
    this.events_read = 0;
    this.resources.clear();
    this.scanouts = [null];
    this.cursor = create_empty_cursor();
    this.resource_memory_bytes = 0;
    this.backing_entry_count = 0;
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

        const cursor = this.cursor;
        if(cursor.resource_id && generation === this.work_generation)
        {
            const resource = this.resources.get(cursor.resource_id);
            const source = resource && read_virtio_gpu_backing_range(
                this.cpu, resource.backing, 0, resource.byte_length);
            if(!resource || source === null)
            {
                throw new Error("Invalid virtio-gpu cursor backing in restored state");
            }
            await this.backend.setCursor({
                ...cursor,
                data: convert_cursor_pixels(source, resource.format),
            });
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
    if(header.type === VIRTIO_GPU_CMD_GET_DISPLAY_INFO)
    {
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
    if(header.type === VIRTIO_GPU_CMD_GET_EDID)
    {
        if(request.byteLength < VIRTIO_GPU_CTRL_HDR_SIZE + 8 ||
           writable_length < VIRTIO_GPU_EDID_RESPONSE_SIZE)
        {
            return create_ctrl_response_for_writable(
                VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header, writable_length);
        }
        const scanout_id = view_of(request).getUint32(VIRTIO_GPU_CTRL_HDR_SIZE, true);
        if(scanout_id !== 0)
        {
            return create_ctrl_response_for_writable(
                VIRTIO_GPU_RESP_ERR_INVALID_SCANOUT_ID, header, writable_length);
        }

        const response = create_ctrl_response(VIRTIO_GPU_RESP_OK_EDID, header,
            VIRTIO_GPU_EDID_RESPONSE_SIZE);
        const view = view_of(response);
        view.setUint32(VIRTIO_GPU_CTRL_HDR_SIZE, VIRTIO_GPU_EDID_BLOCK_SIZE, true);
        response.set(create_edid(width, height), VIRTIO_GPU_CTRL_HDR_SIZE + 8);
        return response;
    }
    return create_ctrl_response_for_writable(
        VIRTIO_GPU_RESP_ERR_UNSPEC, header, writable_length);
}

function create_edid(width, height)
{
    const edid = new Uint8Array(VIRTIO_GPU_EDID_BLOCK_SIZE);
    edid.set([0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
    edid[8] = 0x5B;
    edid[9] = 0x05;
    edid[10] = 0x86;
    edid[11] = 0x00;
    edid[16] = 1;
    edid[17] = 36;
    edid[18] = 1;
    edid[19] = 4;
    edid[20] = 0x80;
    edid[21] = Math.min(255, Math.round(width * 2.54 / 96));
    edid[22] = Math.min(255, Math.round(height * 2.54 / 96));
    edid[23] = 120;
    edid[24] = 0x06;
    edid.fill(0x01, 38, 54);

    const pixel_clock = write_detailed_timing(edid, 54, width, height);
    write_text_descriptor(edid, 72, 0xFC, "v86 WebGPU");
    write_range_descriptor(edid, 90, pixel_clock);
    write_text_descriptor(edid, 108, 0xFF, "v86-virtio-gpu");
    edid[126] = 0;
    let checksum = 0;
    for(let index = 0; index < 127; index++)
    {
        checksum = checksum + edid[index] & 0xFF;
    }
    edid[127] = -checksum & 0xFF;
    return edid;
}

function write_detailed_timing(edid, offset, width, height)
{
    const horizontal_blank = Math.min(0xFFF,
        Math.max(160, Math.ceil(width / 40) * 8));
    const vertical_blank = Math.min(0xFFF,
        Math.max(30, Math.ceil(height / 20)));
    const horizontal_sync_offset = Math.min(0x3FF,
        Math.max(8, Math.floor(horizontal_blank / 32) * 8));
    const horizontal_sync_pulse = Math.min(0x3FF,
        Math.max(8, Math.floor(horizontal_blank / 24) * 8));
    const vertical_sync_offset = 3;
    const vertical_sync_pulse = 5;
    const total_pixels = (width + horizontal_blank) * (height + vertical_blank);
    const refresh_rate = Math.min(60, Math.max(1, Math.floor(0xFFFF * 10000 / total_pixels)));
    const pixel_clock = Math.max(1, Math.round(total_pixels * refresh_rate / 10000));
    const width_mm = Math.min(0xFFF, Math.round(width * 25.4 / 96));
    const height_mm = Math.min(0xFFF, Math.round(height * 25.4 / 96));

    edid[offset] = pixel_clock & 0xFF;
    edid[offset + 1] = pixel_clock >>> 8;
    edid[offset + 2] = width & 0xFF;
    edid[offset + 3] = horizontal_blank & 0xFF;
    edid[offset + 4] = (width >>> 8 & 0xF) << 4 | horizontal_blank >>> 8 & 0xF;
    edid[offset + 5] = height & 0xFF;
    edid[offset + 6] = vertical_blank & 0xFF;
    edid[offset + 7] = (height >>> 8 & 0xF) << 4 | vertical_blank >>> 8 & 0xF;
    edid[offset + 8] = horizontal_sync_offset & 0xFF;
    edid[offset + 9] = horizontal_sync_pulse & 0xFF;
    edid[offset + 10] = (vertical_sync_offset & 0xF) << 4 | vertical_sync_pulse & 0xF;
    edid[offset + 11] = (horizontal_sync_offset >>> 8 & 0x3) << 6 |
        (horizontal_sync_pulse >>> 8 & 0x3) << 4 |
        (vertical_sync_offset >>> 4 & 0x3) << 2 |
        vertical_sync_pulse >>> 4 & 0x3;
    edid[offset + 12] = width_mm & 0xFF;
    edid[offset + 13] = height_mm & 0xFF;
    edid[offset + 14] = (width_mm >>> 8 & 0xF) << 4 | height_mm >>> 8 & 0xF;
    edid[offset + 17] = 0x18;
    return pixel_clock;
}

function write_text_descriptor(edid, offset, tag, text)
{
    edid.set([0, 0, 0, tag, 0], offset);
    edid.fill(0x20, offset + 5, offset + 18);
    const length = Math.min(text.length, 12);
    for(let index = 0; index < length; index++)
    {
        edid[offset + 5 + index] = text.charCodeAt(index);
    }
    edid[offset + 5 + length] = 0x0A;
}

function write_range_descriptor(edid, offset, pixel_clock)
{
    edid.set([0, 0, 0, 0xFD, 0, 48, 120, 30, 160,
        Math.min(255, Math.ceil(pixel_clock / 1000)), 0, 0, 0, 0, 0, 0, 0, 0], offset);
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

function write_backing_range(cpu, backing, offset, source, source_offset, length)
{
    if(!Number.isSafeInteger(offset) || offset < 0 ||
       !Number.isSafeInteger(source_offset) || source_offset < 0 ||
       !Number.isSafeInteger(length) || length < 0 ||
       source_offset + length > source.byteLength)
    {
        return false;
    }

    let logical_offset = 0;
    let remaining = length;
    for(const entry of backing)
    {
        const entry_end = logical_offset + entry.length;
        if(offset < entry_end && remaining)
        {
            const entry_offset = Math.max(0, offset - logical_offset);
            const copy_length = Math.min(remaining, entry.length - entry_offset);
            cpu.write_blob(source.subarray(source_offset, source_offset + copy_length),
                entry.addr + entry_offset);
            source_offset += copy_length;
            offset += copy_length;
            remaining -= copy_length;
        }
        logical_offset = entry_end;
        if(remaining === 0)
        {
            return true;
        }
    }
    return false;
}

function restore_resource_metadata(
    saved, available_bytes, max_dimension, max_backing_entries, cpu)
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
       width > max_dimension || height > max_dimension ||
       byte_length === null || byte_length > available_bytes || !Array.isArray(saved[4]) ||
       saved[4].length > max_backing_entries)
    {
        return null;
    }

    const backing = [];
    let backing_length = 0;
    for(const entry of saved[4])
    {
        if(!Array.isArray(entry) || !is_uint32(entry[0]) ||
           !is_uint32(entry[1]) || entry[1] === 0 ||
           !is_guest_ram_range(cpu, entry[0], entry[1]))
        {
            return null;
        }
        backing.push({ addr: entry[0], length: entry[1] });
        backing_length += entry[1];
        if(!Number.isSafeInteger(backing_length))
        {
            return null;
        }
    }
    const rounded_resource_length = Math.ceil(byte_length / 4096) * 4096;
    if(backing.length &&
       (backing_length < byte_length || backing_length > rounded_resource_length))
    {
        return null;
    }
    return {
        id,
        target: 2,
        bind: (1 << 1) | (1 << 7),
        format,
        width,
        height,
        byte_length,
        bytes_per_pixel: VIRTIO_GPU_BYTES_PER_PIXEL,
        backing,
        backing_length,
        scanout_ids: new Set(),
        is_3d: false,
    };
}

/**
 * @param {?{max_texture_dimension_2d: number, max_bind_groups: number,
 *            max_color_attachments: number, max_resources: number,
 *            max_resource_dimension: number, max_host_memory_bytes: number}} capabilities
 * @param {number} version
 * @return {!Uint8Array}
 */
function create_webgpu_capset(capabilities, version)
{
    const capset = new Uint8Array(V86_WEBGPU_CAPSET_SIZE);
    const view = view_of(capset);
    view.setUint32(0, V86_WEBGPU_CAPSET_MAGIC, true);
    view.setUint16(4, version, true);
    view.setUint16(6, 0, true);
    view.setUint32(8, V86_WEBGPU_CAPSET_SIZE, true);
    view.setUint32(24, V86_WEBGPU_CAPSET_FORMAT_STRIDE, true);
    view.setUint32(28, V86_WEBGPU_CAPSET_MAX_CONTEXTS, true);
    if(!capabilities)
    {
        return capset;
    }

    view.setUint32(12, version === 3 ?
        V86_WEBGPU_CAPSET_V3_FEATURES : V86_WEBGPU_CAPSET_FEATURE_RENDER, true);
    view.setUint32(16, version === 3 ?
        V86_WEBGPU_CAPSET_SHADER_IR_SPIRV : V86_WEBGPU_CAPSET_SHADER_IR_WGSL, true);
    view.setUint32(20, version === 3 ? 3 : 1, true);
    view.setUint32(32, capabilities.max_resources, true);
    view.setUint32(36, V86_WEBGPU_CAPSET_MAX_ATTACHMENTS, true);
    view.setUint32(40, Math.min(capabilities.max_texture_dimension_2d,
        capabilities.max_resource_dimension), true);
    view.setUint32(44, 1, true);
    view.setUint32(48, 1, true);
    view.setUint32(52, 1, true);
    view.setUint32(56, V86_WEBGPU_CAPSET_MAX_SUBMIT_BYTES, true);
    view.setUint32(60, V86_WEBGPU_CAPSET_MAX_COMMANDS, true);
    view.setUint32(64, V86_WEBGPU_CAPSET_MAX_ATTACHMENTS, true);
    view.setUint32(68, 16, true);
    view.setUint32(72, 4, true);
    view.setUint32(76, Math.min(capabilities.max_host_memory_bytes, 1024 * 1024), true);
    const max_shader_bytes = version === 1 ?
        V86_WEBGPU_CAPSET_V1_MAX_SHADER_BYTES :
        version === 2 ? V86_WEBGPU_CAPSET_V2_MAX_SHADER_BYTES :
            V86_WEBGPU_CAPSET_V3_MAX_SHADER_BYTES;
    const max_shader_bytes_per_context = version === 1 ?
        V86_WEBGPU_CAPSET_V1_MAX_SHADER_BYTES_PER_CONTEXT :
        version === 2 ? V86_WEBGPU_CAPSET_V2_MAX_SHADER_BYTES_PER_CONTEXT :
            V86_WEBGPU_CAPSET_V3_MAX_SHADER_BYTES_PER_CONTEXT;
    view.setUint32(80, max_shader_bytes, true);
    view.setUint32(84, max_shader_bytes_per_context, true);
    view.setUint32(88, V86_WEBGPU_CAPSET_MAX_SHADERS, true);
    view.setUint32(92, V86_WEBGPU_CAPSET_MAX_PIPELINES, true);
    view.setUint32(96, version === 3 ? 1 : 0, true);
    view.setUint32(100, version === 3 ? 16 : 0, true);
    view.setUint32(104, version === 3 ? 8 : 0, true);
    view.setUint32(108, version === 3 ? 8 : 0, true);
    view.setUint32(112, 1, true);
    write_uint64(view, 136, capabilities.max_host_memory_bytes);
    write_uint64(view, 128, version === 3 ? 4 * 1024 * 1024 : 0);

    const format_offset = 144;
    view.setUint32(format_offset, VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM, true);
    view.setUint32(format_offset + 4, version === 3 ?
        (1 << 0) | (1 << 1) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) :
        0x72, true);
    view.setUint32(format_offset + 8, 1, true);
    if(version === 2)
    {
        view.setUint32(156, V86_WEBGPU_CAPSET_MAX_COMPILATIONS, true);
        view.setUint32(160, V86_WEBGPU_CAPSET_MAX_COMPILATIONS, true);
        view.setUint32(164, V86_WEBGPU_CAPSET_COMPILATION_TIMEOUT_MS, true);
        view.setUint32(168, V86_WEBGPU_CAPSET_GPU_WORK_TIMEOUT_MS, true);
        view.setUint32(172, V86_WEBGPU_CAPSET_V2_MAX_VERTEX_INVOCATIONS, true);
        view.setUint32(176, V86_WEBGPU_CAPSET_V2_MAX_INSTANCES, true);
    }
    else if(version === 3)
    {
        view.setUint32(format_offset + V86_WEBGPU_CAPSET_FORMAT_STRIDE,
            VIRTIO_GPU_FORMAT_R8_UNORM, true);
        view.setUint32(format_offset + V86_WEBGPU_CAPSET_FORMAT_STRIDE + 4,
            (1 << 0) | (1 << 1) | (1 << 3) | (1 << 4) | (1 << 6), true);
        view.setUint32(format_offset + V86_WEBGPU_CAPSET_FORMAT_STRIDE + 8, 1, true);
        view.setUint32(format_offset + 2 * V86_WEBGPU_CAPSET_FORMAT_STRIDE,
            VIRTIO_GPU_FORMAT_R8_UINT, true);
        view.setUint32(format_offset + 2 * V86_WEBGPU_CAPSET_FORMAT_STRIDE + 4,
            (1 << 0) | (1 << 1) | (1 << 3) | (1 << 4) | (1 << 6), true);
        view.setUint32(format_offset + 2 * V86_WEBGPU_CAPSET_FORMAT_STRIDE + 8, 1, true);
        view.setUint32(180, V86_WEBGPU_CAPSET_MAX_COMPILATIONS, true);
        view.setUint32(184, V86_WEBGPU_CAPSET_MAX_COMPILATIONS, true);
        view.setUint32(188, V86_WEBGPU_CAPSET_COMPILATION_TIMEOUT_MS, true);
        view.setUint32(192, V86_WEBGPU_CAPSET_GPU_WORK_TIMEOUT_MS, true);
        view.setUint32(196, V86_WEBGPU_CAPSET_V3_MAX_VERTEX_INVOCATIONS, true);
        view.setUint32(200, V86_WEBGPU_CAPSET_V3_MAX_INSTANCES, true);
        view.setUint32(204, 8, true);
        view.setUint32(208, 4 * 1024 * 1024, true);
        view.setUint32(212,
            (1 << 2) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 14), true);
    }
    return capset;
}

function write_uint64(view, offset, value)
{
    view.setUint32(offset, value >>> 0, true);
    view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
}

function create_empty_cursor()
{
    return { resource_id: 0, scanout_id: 0, x: 0, y: 0, hot_x: 0, hot_y: 0 };
}

function restore_cursor_metadata(saved, resources)
{
    if(!Array.isArray(saved) || saved.length < 6)
    {
        return create_empty_cursor();
    }
    const [resource_id, scanout_id, x, y, hot_x, hot_y] = saved;
    if(![resource_id, scanout_id, x, y, hot_x, hot_y].every(is_uint32) ||
       scanout_id !== 0)
    {
        return create_empty_cursor();
    }
    if(resource_id === 0)
    {
        return { resource_id, scanout_id, x, y, hot_x: 0, hot_y: 0 };
    }
    const resource = resources.get(resource_id);
    if(!resource || resource.width !== 64 || resource.height !== 64 ||
       resource.backing.length === 0 || hot_x >= resource.width || hot_y >= resource.height)
    {
        return create_empty_cursor();
    }
    return { resource_id, scanout_id, x, y, hot_x, hot_y };
}

function is_uint32(value)
{
    return Number.isSafeInteger(value) && value >= 0 && value <= 0xFFFFFFFF;
}

function convert_cursor_pixels(source, format)
{
    const result = new Uint8Array(source.byteLength);
    const bgra = format === VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM ||
        format === VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM;
    const opaque = format === VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM ||
        format === VIRTIO_GPU_FORMAT_R8G8B8X8_UNORM;
    for(let offset = 0; offset < source.byteLength; offset += VIRTIO_GPU_BYTES_PER_PIXEL)
    {
        result[offset] = source[offset + (bgra ? 2 : 0)];
        result[offset + 1] = source[offset + 1];
        result[offset + 2] = source[offset + (bgra ? 0 : 2)];
        result[offset + 3] = opaque ? 0xFF : source[offset + 3];
    }
    return result;
}

function is_valid_gpu_queue(cpu, queue)
{
    const size = queue.size;
    return Number.isSafeInteger(size) && size > 0 && size <= queue.size_supported &&
        (size & size - 1) === 0 &&
        queue.desc_addr % 16 === 0 &&
        queue.avail_addr % 2 === 0 &&
        queue.used_addr % 4 === 0 &&
        is_guest_ram_range(cpu, queue.desc_addr, size * 16) &&
        is_guest_ram_range(cpu, queue.avail_addr, 6 + size * 2) &&
        is_guest_ram_range(cpu, queue.used_addr, 6 + size * 8);
}

function is_valid_gpu_buffer_chain(cpu, bufchain, max_bytes)
{
    if(!Number.isSafeInteger(bufchain.length_readable) || bufchain.length_readable < 0 ||
       !Number.isSafeInteger(bufchain.length_writable) || bufchain.length_writable < 0 ||
       bufchain.length_writable > max_bytes)
    {
        return false;
    }
    return are_valid_gpu_descriptors(cpu, bufchain.read_buffers, max_bytes) &&
        are_valid_gpu_descriptors(cpu, bufchain.write_buffers, max_bytes);
}

function are_valid_gpu_descriptors(cpu, descriptors, max_bytes)
{
    for(const descriptor of descriptors)
    {
        if(descriptor.addr_high !== 0 ||
           !Number.isSafeInteger(descriptor.addr_low) || descriptor.addr_low < 0 ||
           !Number.isSafeInteger(descriptor.len) || descriptor.len < 0 ||
           descriptor.len > max_bytes ||
           descriptor.len === 0 && descriptor.addr_low > cpu.mem8.length ||
           descriptor.len > 0 && !is_guest_ram_range(cpu, descriptor.addr_low, descriptor.len))
        {
            return false;
        }
    }
    return true;
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

function checked_resource_size(width, height, bytes_per_pixel = VIRTIO_GPU_BYTES_PER_PIXEL)
{
    if(!Number.isSafeInteger(width) || width <= 0 ||
       !Number.isSafeInteger(height) || height <= 0 ||
       !Number.isSafeInteger(bytes_per_pixel) || bytes_per_pixel <= 0)
    {
        return null;
    }
    const pixels = width * height;
    const bytes = pixels * bytes_per_pixel;
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

function restore_mode_dimension(value, fallback)
{
    return Number.isSafeInteger(value) && value > 0 && value <= 0xFFF ? value : fallback;
}

function validate_mode_dimension(value, default_value, name)
{
    value = value === undefined ? default_value : value;
    if(!Number.isSafeInteger(value) || value <= 0 || value > 0xFFF)
    {
        throw new Error("virtio-gpu " + name + " must be a positive 12-bit integer");
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


function create_performance_stats()
{
    return {
        commands: 0,
        invalid_commands: 0,
        guest_read_bytes: 0,
        upload_bytes: 0,
        flushes: 0,
        flushed_bytes: 0,
        presentations: 0,
        presented_bytes: 0,
        cursor_updates: 0,
        cursor_moves: 0,
        fenced_commands: 0,
        fence_wait_ms: 0,
        guest_copy_ms: 0,
        upload_wait_ms: 0,
        present_wait_ms: 0,
        backend_errors: 0,
        config_changes: 0,
        max_active_queues: 0,
        command_counts: new Map(),
    };
}

function performance_now()
{
    return typeof performance === "undefined" ? Date.now() : performance.now();
}

function validate_positive_limit(value, default_value, name, minimum = 1)
{
    value = value === undefined ? default_value : value;
    if(!Number.isSafeInteger(value) || value < minimum)
    {
        throw new Error("virtio-gpu " + name + " must be a safe integer of at least " + minimum);
    }
    return value;
}
