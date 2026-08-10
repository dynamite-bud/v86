import { LOG_VIRTIO } from "./const.js";
import { dbg_log } from "./log.js";
import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import { MemoryGpuBackend } from "./browser/virtio_gpu_backend.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

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

const VIRTIO_GPU_CTRL_HDR_SIZE = 24;
const VIRTIO_GPU_DISPLAY_ONE_SIZE = 24;
const VIRTIO_GPU_DISPLAY_INFO_SIZE = VIRTIO_GPU_CTRL_HDR_SIZE +
    VIRTIO_GPU_MAX_SCANOUTS * VIRTIO_GPU_DISPLAY_ONE_SIZE;

export const VIRTIO_GPU_CMD_GET_DISPLAY_INFO = 0x0100;
export const VIRTIO_GPU_RESP_OK_DISPLAY_INFO = 0x1101;
export const VIRTIO_GPU_RESP_ERR_UNSPEC = 0x1200;
export const VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER = 0x1205;
export const VIRTIO_GPU_FLAG_FENCE = 1;

/**
 * @typedef {{
 *     type: number,
 *     flags: number,
 *     fence_id_low: number,
 *     fence_id_high: number,
 *     ctx_id: number,
 *     ring_idx: number,
 *     complete: boolean,
 * }}
 */
var VirtioGpuCtrlHeader;

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 * @param {{backend: (string|undefined), width: (number|undefined), height: (number|undefined),
 *         max_host_memory_bytes: (number|undefined)}=} options
 * @param {MemoryGpuBackend=} backend
 */
export function VirtioGpu(cpu, bus, options = {}, backend = undefined)
{
    this.bus = bus;
    this.width = validate_mode_dimension(options.width, 1024, "width");
    this.height = validate_mode_dimension(options.height, 768, "height");
    this.events_read = 0;

    if(options.backend !== undefined && options.backend !== "memory")
    {
        throw new Error("Unsupported virtio-gpu backend: " + options.backend);
    }

    this.backend = backend || new MemoryGpuBackend();
    this.backend_options = {
        width: this.width,
        height: this.height,
        max_host_memory_bytes: options.max_host_memory_bytes,
    };
    this.backend_ready = this.backend.initialize(this.backend_options);

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
    const queue = this.virtio.queues[queue_id];
    while(queue.has_request())
    {
        const bufchain = queue.pop_request();
        const request = new Uint8Array(bufchain.length_readable);
        bufchain.get_next_blob(request);

        try
        {
            const response = process_virtio_gpu_command(
                request,
                bufchain.length_writable,
                this.width,
                this.height
            );
            dbg_log("VirtIO GPU command " + read_partial_ctrl_header(request).type +
                " response " + new DataView(response.buffer).getUint32(0, true), LOG_VIRTIO);
            bufchain.set_next_blob(response);
        }
        catch(error)
        {
            dbg_log("VirtIO GPU backend error: " + error, LOG_VIRTIO);
            bufchain.set_next_blob(create_ctrl_response(
                VIRTIO_GPU_RESP_ERR_UNSPEC,
                read_partial_ctrl_header(request)
            ));
        }

        queue.push_reply(bufchain);
    }
    queue.flush_replies();
};

VirtioGpu.prototype.get_state = function()
{
    const state = [];
    state[0] = this.virtio;
    state[1] = this.events_read;
    state[2] = this.width;
    state[3] = this.height;
    return state;
};

VirtioGpu.prototype.set_state = function(state)
{
    this.virtio.set_state(state[0]);
    this.events_read = state[1];
    this.width = state[2];
    this.height = state[3];
    this.backend_options.width = this.width;
    this.backend_options.height = this.height;
    this.backend_ready = this.backend.reset().then(() => this.backend.initialize(this.backend_options));
};

VirtioGpu.prototype.reset = function()
{
    this.events_read = 0;
    this.virtio.reset();
    this.backend_ready = this.backend.reset().then(() => this.backend.initialize(this.backend_options));
};

/**
 * Pure protocol handler shared by the device and Node tests.
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
        return create_ctrl_response(VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header);
    }

    if(header.type !== VIRTIO_GPU_CMD_GET_DISPLAY_INFO)
    {
        return create_ctrl_response(VIRTIO_GPU_RESP_ERR_UNSPEC, header);
    }

    if(writable_length < VIRTIO_GPU_DISPLAY_INFO_SIZE)
    {
        return create_ctrl_response(VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER, header);
    }

    const response = create_ctrl_response(VIRTIO_GPU_RESP_OK_DISPLAY_INFO, header,
        VIRTIO_GPU_DISPLAY_INFO_SIZE);
    const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
    const scanout_offset = VIRTIO_GPU_CTRL_HDR_SIZE;
    view.setUint32(scanout_offset + 8, width, true);
    view.setUint32(scanout_offset + 12, height, true);
    view.setUint32(scanout_offset + 16, 1, true);
    return response;
}

/** @param {Uint8Array} request @return {VirtioGpuCtrlHeader} */
export function read_partial_ctrl_header(request)
{
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
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
 * @param {number} type
 * @param {VirtioGpuCtrlHeader} request_header
 * @param {number=} length
 * @return {Uint8Array}
 */
function create_ctrl_response(type, request_header, length = VIRTIO_GPU_CTRL_HDR_SIZE)
{
    const response = new Uint8Array(length);
    const view = new DataView(response.buffer);
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
