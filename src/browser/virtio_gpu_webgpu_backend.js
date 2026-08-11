import { WgpuBackend } from "./virtio_gpu_wgpu_backend.js";

const FORMAT_B8G8R8A8_UNORM = 1;
const FORMAT_B8G8R8X8_UNORM = 2;
const FORMAT_R8G8B8A8_UNORM = 67;
const FORMAT_R8G8B8X8_UNORM = 134;
const BYTES_PER_PIXEL = 4;
const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

const PRESENT_SHADER = `
struct PresentParams {
    scanout_origin: vec2<u32>,
    scanout_size: vec2<u32>,
    resource_size: vec2<u32>,
    format: u32,
    _padding: u32,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> params: PresentParams;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    let positions = array(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    let position = positions[vertex_index];
    var output: VertexOutput;
    output.position = vec4<f32>(position, 0.0, 1.0);
    output.uv = position * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
    return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let resource_size = vec2<f32>(params.resource_size);
    let scanout_origin = vec2<f32>(params.scanout_origin);
    let scanout_size = vec2<f32>(params.scanout_size);
    let uv = (scanout_origin + input.uv * scanout_size) / resource_size;
    let pixel = textureSample(source_texture, source_sampler, uv);

    if params.format == 1u {
        return vec4<f32>(pixel.b, pixel.g, pixel.r, pixel.a);
    }
    if params.format == 2u {
        return vec4<f32>(pixel.b, pixel.g, pixel.r, 1.0);
    }
    if params.format == 67u {
        return pixel;
    }
    return vec4<f32>(pixel.rgb, 1.0);
}
`;

/**
 * Direct JavaScript navigator.gpu implementation of the browser backend.
 * Canvas lifecycle, VGA fallback, and fatal-error handling are shared with
 * WgpuBackend; only the renderer implementation differs.
 */
export class JsWebGpuBackend extends WgpuBackend
{
    constructor(options = {})
    {
        super(options);
        this.backend_name = "webgpu-js";
    }

    async load_module()
    {
        if(!this.module_promise)
        {
            this.module_promise = Promise.resolve({
                create_renderer: (canvas, width, height, max_host_memory_bytes) =>
                    JsWebGpuRenderer.create(canvas, width, height, max_host_memory_bytes),
            });
        }
        return this.module_promise;
    }
}

/**
 * Renderer-shaped object consumed by the shared browser backend adapter.
 * Method names intentionally match the wasm-bindgen renderer exports.
 */
export class JsWebGpuRenderer
{
    static async create(canvas, width, height, max_host_memory_bytes,
        gpu = globalThis.navigator && globalThis.navigator.gpu)
    {
        width = validate_dimension(width, "width");
        height = validate_dimension(height, "height");
        max_host_memory_bytes = validate_nonnegative_integer(
            max_host_memory_bytes, "max_host_memory_bytes");
        if(!gpu)
        {
            throw new Error("WebGPU is unavailable");
        }
        if(!canvas || typeof canvas.getContext !== "function")
        {
            throw new Error("A canvas is required for direct WebGPU presentation");
        }

        const context = canvas.getContext("webgpu");
        if(!context)
        {
            throw new Error("The canvas cannot create a WebGPU context");
        }
        const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
        if(!adapter)
        {
            throw new Error("No WebGPU adapter can present to the canvas");
        }
        const device = await adapter.requestDevice({ requiredFeatures: [], requiredLimits: {} });
        const texture_usage = globalThis["GPUTextureUsage"];
        const buffer_usage = globalThis["GPUBufferUsage"];
        if(!texture_usage || !buffer_usage)
        {
            device.destroy();
            throw new Error("WebGPU usage constants are unavailable");
        }

        const format = gpu.getPreferredCanvasFormat();
        const sampler = device.createSampler({
            label: "v86 virtio-gpu direct sampler",
            magFilter: "nearest",
            minFilter: "nearest",
        });
        const present_params = device.createBuffer({
            label: "v86 virtio-gpu direct present parameters",
            size: 32,
            usage: buffer_usage.UNIFORM | buffer_usage.COPY_DST,
        });
        const shader = device.createShaderModule({
            label: "v86 virtio-gpu direct present shader",
            code: PRESENT_SHADER,
        });
        const pipeline_descriptor = {
            label: "v86 virtio-gpu direct present pipeline",
            layout: "auto",
            vertex: {
                module: shader,
                entryPoint: "vertex_main",
            },
            primitive: { topology: "triangle-list" },
            fragment: {
                module: shader,
                entryPoint: "fragment_main",
                targets: [{ format }],
            },
        };
        const pipeline = typeof device.createRenderPipelineAsync === "function" ?
            await device.createRenderPipelineAsync(pipeline_descriptor) :
            device.createRenderPipeline(pipeline_descriptor);

        const renderer = new JsWebGpuRenderer({
            canvas,
            context,
            device,
            format,
            pipeline,
            sampler,
            present_params,
            texture_usage,
            max_host_memory_bytes,
        });
        renderer.configure_surface(width, height);
        renderer.monitor_device();
        return renderer;
    }

    constructor(options)
    {
        this.canvas = options.canvas;
        this.context = options.context;
        this.device = options.device;
        this.queue = options.device.queue;
        this.format = options.format;
        this.pipeline = options.pipeline;
        this.sampler = options.sampler;
        this.present_params = options.present_params;
        this.present_params_data = new Uint32Array(8);
        this.texture_usage = options.texture_usage;
        this.max_host_memory_bytes = options.max_host_memory_bytes;
        this.host_memory_bytes = 0;
        this.resources = new Map();
        this.scanout = null;
        this.upload_scratch = new Uint8Array(0);
        this.surface_width = 0;
        this.surface_height = 0;
        this.fault = null;
        this.disposed = false;
    }

    monitor_device()
    {
        if(typeof this.device.addEventListener === "function")
        {
            this.device.addEventListener("uncapturederror", event => {
                const error = event && event.error;
                this.record_fault("Uncaptured WebGPU error: " +
                    (error && error.message || String(error)));
            });
        }
        if(this.device.lost && typeof this.device.lost.then === "function")
        {
            this.device.lost.then(info => {
                if(!this.disposed)
                {
                    this.record_fault("WebGPU device lost (" +
                        (info && info.reason || "unknown") + "): " +
                        (info && info.message || ""));
                }
            });
        }
    }

    async create_resource_2d(resource_id, format, width, height)
    {
        this.check_fault();
        resource_id = validate_resource_id(resource_id);
        format = validate_format(format);
        width = validate_dimension(width, "width");
        height = validate_dimension(height, "height");
        if(this.resources.has(resource_id))
        {
            throw new Error("Duplicate resource " + resource_id);
        }
        const max_dimension = this.device.limits && this.device.limits.maxTextureDimension2D;
        if(max_dimension && (width > max_dimension || height > max_dimension))
        {
            throw new Error("Resource dimensions exceed WebGPU limits");
        }
        const byte_length = checked_rgba_size(width, height);
        if(byte_length > this.max_host_memory_bytes - this.host_memory_bytes)
        {
            throw new Error("GPU host memory limit exceeded");
        }

        const texture = this.device.createTexture({
            label: "v86 virtio-gpu direct resource",
            size: { width, height, depthOrArrayLayers: 1 },
            mipLevelCount: 1,
            sampleCount: 1,
            dimension: "2d",
            format: "rgba8unorm",
            usage: this.texture_usage.COPY_DST | this.texture_usage.TEXTURE_BINDING,
        });
        const bind_group = this.device.createBindGroup({
            label: "v86 virtio-gpu direct resource bind group",
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: texture.createView() },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: { buffer: this.present_params } },
            ],
        });
        this.resources.set(resource_id, {
            format,
            width,
            height,
            byte_length,
            texture,
            bind_group,
        });
        this.host_memory_bytes += byte_length;
    }

    destroy_resource(resource_id)
    {
        this.check_fault();
        resource_id = validate_resource_id(resource_id);
        const resource = this.resources.get(resource_id);
        if(!resource)
        {
            throw new Error("Unknown resource " + resource_id);
        }
        resource.texture.destroy();
        this.resources.delete(resource_id);
        this.host_memory_bytes -= resource.byte_length;
        if(this.scanout && this.scanout.resource_id === resource_id)
        {
            this.scanout = null;
        }
    }

    upload_resource_2d(resource_id, x, y, width, height, stride, data)
    {
        this.check_fault();
        const resource = this.get_resource(resource_id);
        const rect = validate_rect({ x, y, width, height }, resource.width, resource.height);
        stride = validate_nonnegative_integer(stride, "stride");
        if(!(data instanceof Uint8Array))
        {
            throw new TypeError("Upload data must be a Uint8Array");
        }
        const row_bytes = checked_multiply(rect.width, BYTES_PER_PIXEL,
            "Upload row size overflow");
        if(stride < row_bytes)
        {
            throw new Error("Upload stride is smaller than a row");
        }
        const required_length = checked_add(
            checked_multiply(stride, rect.height - 1, "Upload dimensions overflow"),
            row_bytes, "Upload dimensions overflow");
        if(data.byteLength < required_length)
        {
            throw new Error("Upload data is truncated");
        }

        const aligned_row_bytes = align_to(row_bytes, COPY_BYTES_PER_ROW_ALIGNMENT);
        let upload_data = data;
        if(stride !== aligned_row_bytes)
        {
            const upload_length = checked_multiply(aligned_row_bytes, rect.height,
                "Upload dimensions overflow");
            if(this.upload_scratch.byteLength < upload_length)
            {
                this.upload_scratch = new Uint8Array(upload_length);
            }
            for(let row = 0; row < rect.height; row++)
            {
                const source_offset = row * stride;
                const target_offset = row * aligned_row_bytes;
                this.upload_scratch.set(
                    data.subarray(source_offset, source_offset + row_bytes), target_offset);
            }
            upload_data = this.upload_scratch.subarray(0, upload_length);
        }

        this.queue.writeTexture(
            { texture: resource.texture, origin: { x: rect.x, y: rect.y, z: 0 } },
            upload_data,
            { offset: 0, bytesPerRow: aligned_row_bytes, rowsPerImage: rect.height },
            { width: rect.width, height: rect.height, depthOrArrayLayers: 1 }
        );
        this.queue.submit([]);
    }

    set_scanout(resource_id, x, y, width, height)
    {
        this.check_fault();
        const resource = this.get_resource(resource_id);
        const rect = validate_rect({ x, y, width, height }, resource.width, resource.height);
        this.scanout = { resource_id, ...rect };
    }

    clear_scanout()
    {
        this.check_fault();
        this.scanout = null;
    }

    flush(resource_id, x, y, width, height)
    {
        this.check_fault();
        const resource = this.get_resource(resource_id);
        validate_rect({ x, y, width, height }, resource.width, resource.height);
        if(!this.scanout || this.scanout.resource_id !== resource_id)
        {
            return false;
        }

        this.present_params_data[0] = this.scanout.x;
        this.present_params_data[1] = this.scanout.y;
        this.present_params_data[2] = this.scanout.width;
        this.present_params_data[3] = this.scanout.height;
        this.present_params_data[4] = resource.width;
        this.present_params_data[5] = resource.height;
        this.present_params_data[6] = resource.format;
        this.present_params_data[7] = 0;
        this.queue.writeBuffer(this.present_params, 0, this.present_params_data);
        this.configure_surface(this.scanout.width, this.scanout.height);
        const surface_texture = this.acquire_surface_texture();
        const encoder = this.device.createCommandEncoder({
            label: "v86 virtio-gpu direct present encoder",
        });
        const pass = encoder.beginRenderPass({
            label: "v86 virtio-gpu direct present pass",
            colorAttachments: [{
                view: surface_texture.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: "clear",
                storeOp: "store",
            }],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, resource.bind_group);
        pass.draw(3, 1, 0, 0);
        pass.end();
        this.queue.submit([encoder.finish()]);
        this.check_fault();
        return true;
    }

    async wait_idle()
    {
        this.check_fault();
        await this.queue.onSubmittedWorkDone();
        this.check_fault();
    }

    reset()
    {
        this.check_fault();
        this.destroy_resources();
        this.scanout = null;
        this.host_memory_bytes = 0;
        this.upload_scratch = new Uint8Array(0);
    }

    device_status()
    {
        this.check_fault();
    }

    dispose()
    {
        if(this.disposed)
        {
            return;
        }
        this.disposed = true;
        this.destroy_resources();
        this.scanout = null;
        this.host_memory_bytes = 0;
        this.present_params.destroy();
        if(typeof this.context.unconfigure === "function")
        {
            this.context.unconfigure();
        }
        this.device.destroy();
    }

    free()
    {
        // wasm-bindgen renderers expose free(); keep the shared adapter contract.
    }

    configure_surface(width, height)
    {
        width = validate_dimension(width, "surface width");
        height = validate_dimension(height, "surface height");
        if(this.surface_width === width && this.surface_height === height)
        {
            return;
        }
        this.canvas.width = width;
        this.canvas.height = height;
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: "opaque",
            usage: this.texture_usage.RENDER_ATTACHMENT,
        });
        this.surface_width = width;
        this.surface_height = height;
    }

    acquire_surface_texture()
    {
        for(let attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                return this.context.getCurrentTexture();
            }
            catch(error)
            {
                if(attempt)
                {
                    throw new Error("WebGPU surface could not be recovered: " + error);
                }
                this.context.configure({
                    device: this.device,
                    format: this.format,
                    alphaMode: "opaque",
                    usage: this.texture_usage.RENDER_ATTACHMENT,
                });
            }
        }
        throw new Error("WebGPU surface could not be recovered");
    }

    get_resource(resource_id)
    {
        resource_id = validate_resource_id(resource_id);
        const resource = this.resources.get(resource_id);
        if(!resource)
        {
            throw new Error("Unknown resource " + resource_id);
        }
        return resource;
    }

    destroy_resources()
    {
        for(const resource of this.resources.values())
        {
            resource.texture.destroy();
        }
        this.resources.clear();
    }

    record_fault(message)
    {
        if(!this.fault)
        {
            this.fault = String(message);
        }
    }

    check_fault()
    {
        if(this.fault)
        {
            throw new Error(this.fault);
        }
        if(this.disposed)
        {
            throw new Error("Direct WebGPU renderer is disposed");
        }
    }
}

function validate_resource_id(resource_id)
{
    resource_id = validate_nonnegative_integer(resource_id, "resource_id");
    if(resource_id === 0)
    {
        throw new Error("resource_id must not be zero");
    }
    return resource_id;
}

function validate_format(format)
{
    format = validate_nonnegative_integer(format, "format");
    if(format !== FORMAT_B8G8R8A8_UNORM && format !== FORMAT_B8G8R8X8_UNORM &&
       format !== FORMAT_R8G8B8A8_UNORM && format !== FORMAT_R8G8B8X8_UNORM)
    {
        throw new Error("Unsupported virtio-gpu format " + format);
    }
    return format;
}

function validate_dimension(value, name)
{
    value = validate_nonnegative_integer(value, name);
    if(value === 0)
    {
        throw new Error(name + " must not be zero");
    }
    return value;
}

function validate_nonnegative_integer(value, name)
{
    if(!Number.isSafeInteger(value) || value < 0)
    {
        throw new Error(name + " must be a non-negative safe integer");
    }
    return value;
}

function validate_rect(rect, resource_width, resource_height)
{
    const x = validate_nonnegative_integer(rect.x, "x");
    const y = validate_nonnegative_integer(rect.y, "y");
    const width = validate_dimension(rect.width, "width");
    const height = validate_dimension(rect.height, "height");
    if(x + width > resource_width || y + height > resource_height)
    {
        throw new Error("Rectangle exceeds resource bounds");
    }
    return { x, y, width, height };
}

function checked_rgba_size(width, height)
{
    return checked_multiply(checked_multiply(width, height,
        "Resource dimensions overflow host addressing"), BYTES_PER_PIXEL,
    "Resource dimensions overflow host addressing");
}

function checked_multiply(left, right, message)
{
    const value = left * right;
    if(!Number.isSafeInteger(value))
    {
        throw new Error(message);
    }
    return value;
}

function checked_add(left, right, message)
{
    const value = left + right;
    if(!Number.isSafeInteger(value))
    {
        throw new Error(message);
    }
    return value;
}

function align_to(value, alignment)
{
    return Math.floor(checked_add(value, alignment - 1,
        "Upload row alignment overflow") / alignment) * alignment;
}
