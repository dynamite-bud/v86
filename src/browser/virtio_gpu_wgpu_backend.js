import { VirtioGpuBackend } from "./virtio_gpu_backend.js";

const DEFAULT_MODULE_URL = "build/virtio-gpu-wgpu/virtio_gpu_wgpu.js";
const DEVICE_STATUS_INTERVAL_MS = 250;

/**
 * Browser adapter for the independent Rust/wasm-bindgen wgpu renderer.
 */
export class WgpuBackend extends VirtioGpuBackend
{
    /**
     * @param {{screen_container: (HTMLElement|undefined), canvas: (HTMLCanvasElement|undefined),
     *          wasm_module_url: (string|undefined), wasm_url: (string|undefined)}} options
     */
    constructor(options = {})
    {
        super();
        this.options = options;
        this.module_promise = null;
        this.renderer = null;
        this.initialized = false;
        this.fatal_error = null;
        this.device_status_timer = 0;
        this.active_calls = 0;
        this.previous_hidden = null;

        const configured_canvas = options.canvas;
        const container = options.screen_container || configured_canvas && configured_canvas.parentElement;
        this.container = container || null;
        this.canvas = configured_canvas || null;
        this.owns_canvas = false;
        this.vga_canvas = null;
        this.vga_text = null;

        if(this.container)
        {
            const canvases = this.container.getElementsByTagName("canvas");
            for(const canvas of canvases)
            {
                if(canvas !== this.canvas)
                {
                    this.vga_canvas = canvas;
                    break;
                }
            }
            this.vga_text = this.container.getElementsByTagName("div")[0] || null;
        }

        if(!this.canvas && this.container && typeof document !== "undefined")
        {
            this.canvas = document.createElement("canvas");
            this.canvas.classList.add("v86-virtio-gpu-canvas");
            this.container.appendChild(this.canvas);
            this.owns_canvas = true;
        }
        if(this.canvas)
        {
            this.canvas.hidden = true;
        }
    }

    async initialize(options)
    {
        if(this.initialized)
        {
            return;
        }
        this.restore_vga();
        this.fatal_error = null;

        try
        {
            if(typeof navigator === "undefined" || !navigator["gpu"])
            {
                throw new Error("WebGPU is unavailable; use a secure context and a WebGPU-capable browser");
            }
            if(!this.canvas)
            {
                throw new Error("The wgpu backend requires a screen container or dedicated canvas");
            }

            const module = await this.load_module();
            const width = validate_dimension(options.width, "width");
            const height = validate_dimension(options.height, "height");
            const max_host_memory_bytes = validate_nonnegative_integer(
                options.max_host_memory_bytes === undefined ? 256 * 1024 * 1024 :
                    options.max_host_memory_bytes,
                "max_host_memory_bytes"
            );
            this.canvas.width = width;
            this.canvas.height = height;
            this.renderer = await module["create_renderer"](
                this.canvas, width, height, max_host_memory_bytes);
            this.initialized = true;
            this.start_device_monitor();
        }
        catch(error)
        {
            throw this.handle_fatal(error, "initialize");
        }
    }

    async createResource2D(desc)
    {
        return this.invoke("create_resource_2d", desc.resource_id, desc.format, desc.width, desc.height);
    }

    async destroyResource(resource_id)
    {
        return this.invoke("destroy_resource", resource_id);
    }

    async uploadResource2D(upload)
    {
        if(!(upload.data instanceof Uint8Array))
        {
            throw this.handle_fatal(new TypeError("upload.data must be a Uint8Array"), "uploadResource2D");
        }
        return this.invoke("upload_resource_2d", upload.resource_id, upload.x, upload.y,
            upload.width, upload.height, upload.stride, upload.data);
    }

    async setScanout(scanout)
    {
        if(scanout === null)
        {
            await this.invoke("clear_scanout");
            this.restore_vga();
            return;
        }
        return this.invoke("set_scanout", scanout.resource_id, scanout.x, scanout.y,
            scanout.width, scanout.height);
    }

    async flush(flush)
    {
        const presented = await this.invoke("flush", flush.resource_id, flush.x, flush.y,
            flush.width, flush.height);
        if(presented)
        {
            this.activate_webgpu();
        }
    }

    async waitIdle()
    {
        return this.invoke("wait_idle");
    }

    async reset()
    {
        this.restore_vga();
        this.stop_device_monitor();
        this.dispose_renderer();
        this.initialized = false;
        this.fatal_error = null;
    }

    async dispose()
    {
        await this.reset();
        if(this.owns_canvas && this.canvas)
        {
            this.canvas.remove();
            this.canvas = null;
            this.owns_canvas = false;
        }
    }

    async load_module()
    {
        if(!this.module_promise)
        {
            const module_url = resolve_browser_url(this.options.wasm_module_url || DEFAULT_MODULE_URL);
            this.module_promise = import(module_url).then(async module =>
            {
                if(typeof module["default"] !== "function" ||
                   typeof module["create_renderer"] !== "function")
                {
                    throw new Error("Invalid virtio-gpu wasm-bindgen module");
                }
                if(this.options.wasm_url)
                {
                    await module["default"](resolve_browser_url(this.options.wasm_url));
                }
                else
                {
                    await module["default"]();
                }
                return module;
            });
        }
        return this.module_promise;
    }

    async invoke(method, ...args)
    {
        if(this.fatal_error)
        {
            throw this.fatal_error;
        }
        if(!this.initialized || !this.renderer)
        {
            throw this.handle_fatal(new Error("WebGPU renderer is not initialized"), method);
        }

        this.active_calls++;
        try
        {
            return await this.renderer[method](...args);
        }
        catch(error)
        {
            throw this.handle_fatal(error, method);
        }
        finally
        {
            this.active_calls--;
        }
    }

    start_device_monitor()
    {
        this.stop_device_monitor();
        this.device_status_timer = setInterval(() =>
        {
            if(!this.renderer || this.active_calls)
            {
                return;
            }
            try
            {
                this.renderer["device_status"]();
            }
            catch(error)
            {
                this.handle_fatal(error, "device_status");
            }
        }, DEVICE_STATUS_INTERVAL_MS);
    }

    stop_device_monitor()
    {
        if(this.device_status_timer)
        {
            clearInterval(this.device_status_timer);
            this.device_status_timer = 0;
        }
    }

    handle_fatal(error, operation)
    {
        if(this.fatal_error)
        {
            return this.fatal_error;
        }
        this.fatal_error = normalize_error(error, operation);
        this.restore_vga();
        this.stop_device_monitor();
        this.dispose_renderer();
        this.initialized = false;
        return this.fatal_error;
    }

    dispose_renderer()
    {
        if(!this.renderer)
        {
            return;
        }
        const renderer = this.renderer;
        this.renderer = null;
        try
        {
            renderer["dispose"]();
        }
        finally
        {
            renderer["free"]();
        }
    }

    activate_webgpu()
    {
        if(!this.canvas || !this.canvas.hidden)
        {
            return;
        }
        this.previous_hidden = {
            canvas_hidden: this.vga_canvas ? this.vga_canvas.hidden : false,
            canvas_display: this.vga_canvas ? this.vga_canvas.style.display : "",
            text_hidden: this.vga_text ? this.vga_text.hidden : false,
            text_display: this.vga_text ? this.vga_text.style.display : "",
        };
        if(this.vga_canvas)
        {
            this.vga_canvas.hidden = true;
            this.vga_canvas.style.display = "none";
        }
        if(this.vga_text)
        {
            this.vga_text.hidden = true;
            this.vga_text.style.display = "none";
        }
        this.canvas.hidden = false;
    }

    restore_vga()
    {
        if(this.canvas)
        {
            this.canvas.hidden = true;
        }
        if(this.previous_hidden)
        {
            if(this.vga_canvas)
            {
                this.vga_canvas.hidden = this.previous_hidden.canvas_hidden;
                this.vga_canvas.style.display = this.previous_hidden.canvas_display;
            }
            if(this.vga_text)
            {
                this.vga_text.hidden = this.previous_hidden.text_hidden;
                this.vga_text.style.display = this.previous_hidden.text_display;
            }
            this.previous_hidden = null;
        }
    }
}

function resolve_browser_url(value)
{
    if(typeof document === "undefined")
    {
        throw new Error("The wgpu backend is only available in a browser");
    }
    return new URL(value, document.baseURI || document.location.href).href;
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

function normalize_error(error, operation)
{
    let message;
    if(error && typeof error.message === "string")
    {
        message = error.message;
    }
    else
    {
        message = String(error);
    }
    return new Error("virtio-gpu wgpu " + operation + " failed: " + message);
}
