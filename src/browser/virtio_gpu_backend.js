// Promise-based renderer boundary for virtio-gpu. This module deliberately has
// no browser or WebGPU dependencies so that backends remain unit-testable.

/**
 * @abstract
 */
export class VirtioGpuBackend
{
    /** @param {{width: number, height: number, max_host_memory_bytes: (number|undefined)}} options */
    initialize(options)
    {
        return Promise.reject(new Error("VirtioGpuBackend.initialize is not implemented"));
    }

    /** @param {{resource_id: number, format: number, width: number, height: number}} desc */
    createResource2D(desc)
    {
        return Promise.reject(new Error("VirtioGpuBackend.createResource2D is not implemented"));
    }

    /**
     * Return renderer limits for the private capset, or null when 3D is unavailable.
     * @return {!Promise<?{max_texture_dimension_2d: number, max_bind_groups: number,
     *                      max_color_attachments: number}>}
     */
    get3DCapabilities()
    {
        return Promise.resolve(null);
    }

    /** @param {number} context_id */
    createContext3D(context_id)
    {
        return Promise.reject(new Error("VirtioGpuBackend.createContext3D is not implemented"));
    }

    /** @param {number} context_id */
    destroyContext3D(context_id)
    {
        return Promise.reject(new Error("VirtioGpuBackend.destroyContext3D is not implemented"));
    }

    /**
     * @param {{resource_id: number, format: number, width: number, height: number}} desc
     */
    createResource3D(desc)
    {
        return Promise.reject(new Error("VirtioGpuBackend.createResource3D is not implemented"));
    }

    /** @param {number} context_id @param {number} resource_id */
    attachResource3D(context_id, resource_id)
    {
        return Promise.reject(new Error("VirtioGpuBackend.attachResource3D is not implemented"));
    }

    /** @param {number} context_id @param {number} resource_id */
    detachResource3D(context_id, resource_id)
    {
        return Promise.reject(new Error("VirtioGpuBackend.detachResource3D is not implemented"));
    }

    /**
     * @param {{resource_id: number, x: number, y: number, width: number, height: number,
     *          stride: number, data: Uint8Array}} upload
     */
    transferToHost3D(upload)
    {
        return Promise.reject(new Error("VirtioGpuBackend.transferToHost3D is not implemented"));
    }

    /**
     * @param {number} context_id
     * @param {!Uint8Array} commands
     * @param {!Uint32Array} resource_ids
     * @return {!Promise<boolean>} false for guest validation failure
     */
    submit3D(context_id, commands, resource_ids)
    {
        return Promise.reject(new Error("VirtioGpuBackend.submit3D is not implemented"));
    }

    /** @param {number} resource_id */
    destroyResource(resource_id)
    {
        return Promise.reject(new Error("VirtioGpuBackend.destroyResource is not implemented"));
    }

    /**
     * @param {{resource_id: number, x: number, y: number, width: number, height: number,
     *          stride: number, data: Uint8Array}} upload
     */
    uploadResource2D(upload)
    {
        return Promise.reject(new Error("VirtioGpuBackend.uploadResource2D is not implemented"));
    }

    /** @param {({resource_id: number, x: number, y: number, width: number, height: number}|null)} scanout */
    setScanout(scanout)
    {
        return Promise.reject(new Error("VirtioGpuBackend.setScanout is not implemented"));
    }

    /** @param {{resource_id: number, x: number, y: number, width: number, height: number}} flush */
    flush(flush)
    {
        return Promise.reject(new Error("VirtioGpuBackend.flush is not implemented"));
    }

    /**
     * @param {({resource_id: number, scanout_id: number, x: number, y: number,
     *          hot_x: number, hot_y: number, data: (?Uint8Array)}|null)} cursor
     */
    setCursor(cursor)
    {
        return Promise.reject(new Error("VirtioGpuBackend.setCursor is not implemented"));
    }

    waitIdle()
    {
        return Promise.reject(new Error("VirtioGpuBackend.waitIdle is not implemented"));
    }

    reset()
    {
        return Promise.reject(new Error("VirtioGpuBackend.reset is not implemented"));
    }

    dispose()
    {
        return Promise.reject(new Error("VirtioGpuBackend.dispose is not implemented"));
    }
}

/**
 * Deterministic RGBA8 backend used by Node tests and the initial device slice.
 */
export class MemoryGpuBackend extends VirtioGpuBackend
{
    constructor()
    {
        super();
        this.initialized = false;
        this.width = 0;
        this.height = 0;
        this.max_host_memory_bytes = 0;
        this.host_memory_bytes = 0;
        /** @type {Map<number, {format: number, width: number, height: number, data: Uint8Array}>} */
        this.resources = new Map();
        this.scanout = null;
        this.flush_count = 0;
        this.last_flush = null;
        this.cursor = null;
    }

    async initialize(options)
    {
        const width = validate_dimension(options.width, "width");
        const height = validate_dimension(options.height, "height");
        const max_host_memory_bytes = options.max_host_memory_bytes === undefined ?
            256 * 1024 * 1024 : validate_nonnegative_integer(options.max_host_memory_bytes, "max_host_memory_bytes");

        this.width = width;
        this.height = height;
        this.max_host_memory_bytes = max_host_memory_bytes;
        this.initialized = true;
        return Promise.resolve();
    }

    async createResource2D(desc)
    {
        this.assert_initialized();
        const resource_id = validate_resource_id(desc.resource_id);
        const width = validate_dimension(desc.width, "width");
        const height = validate_dimension(desc.height, "height");
        const format = validate_nonnegative_integer(desc.format, "format");
        if(this.resources.has(resource_id))
        {
            return Promise.reject(new Error("Duplicate resource " + resource_id));
        }

        const byte_length = checked_rgba_size(width, height);
        if(byte_length > this.max_host_memory_bytes - this.host_memory_bytes)
        {
            return Promise.reject(new Error("GPU host memory limit exceeded"));
        }

        this.resources.set(resource_id, { format, width, height, data: new Uint8Array(byte_length) });
        this.host_memory_bytes += byte_length;
        return Promise.resolve();
    }

    async destroyResource(resource_id)
    {
        this.assert_initialized();
        resource_id = validate_resource_id(resource_id);
        const resource = this.resources.get(resource_id);
        if(!resource)
        {
            return Promise.reject(new Error("Unknown resource " + resource_id));
        }

        this.host_memory_bytes -= resource.data.byteLength;
        this.resources.delete(resource_id);
        if(this.scanout && this.scanout.resource_id === resource_id)
        {
            this.scanout = null;
        }
        return Promise.resolve();
    }

    async uploadResource2D(upload)
    {
        this.assert_initialized();
        const resource = this.get_resource(upload.resource_id);
        const rect = validate_rect(upload, resource.width, resource.height);
        const stride = validate_nonnegative_integer(upload.stride, "stride");
        const row_bytes = rect.width * 4;
        if(stride < row_bytes)
        {
            return Promise.reject(new Error("Upload stride is smaller than a row"));
        }
        const upload_size = checked_multiply(stride, rect.height, "Upload dimensions overflow");
        if(upload.data.byteLength < upload_size)
        {
            return Promise.reject(new Error("Upload data is truncated"));
        }

        for(let row = 0; row < rect.height; row++)
        {
            const source_offset = row * stride;
            const target_offset = ((rect.y + row) * resource.width + rect.x) * 4;
            resource.data.set(upload.data.subarray(source_offset, source_offset + row_bytes), target_offset);
        }
        return Promise.resolve();
    }

    async setScanout(scanout)
    {
        this.assert_initialized();
        if(scanout === null)
        {
            this.scanout = null;
            return Promise.resolve();
        }

        const resource = this.get_resource(scanout.resource_id);
        const rect = validate_rect(scanout, resource.width, resource.height);
        this.scanout = {
            resource_id: scanout.resource_id,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        };
        return Promise.resolve();
    }

    async flush(flush)
    {
        this.assert_initialized();
        const resource = this.get_resource(flush.resource_id);
        const rect = validate_rect(flush, resource.width, resource.height);
        this.last_flush = {
            resource_id: flush.resource_id,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        };
        this.flush_count++;
        return Promise.resolve();
    }

    async setCursor(cursor)
    {
        this.assert_initialized();
        if(cursor === null)
        {
            this.cursor = null;
            return;
        }
        const data = cursor.data === null && this.cursor ? this.cursor.data :
            new Uint8Array(cursor.data);
        this.cursor = {
            resource_id: cursor.resource_id,
            scanout_id: cursor.scanout_id,
            x: cursor.x,
            y: cursor.y,
            hot_x: cursor.hot_x,
            hot_y: cursor.hot_y,
            data,
        };
    }

    async waitIdle()
    {
        this.assert_initialized();
        return Promise.resolve();
    }

    async reset()
    {
        this.resources.clear();
        this.scanout = null;
        this.flush_count = 0;
        this.last_flush = null;
        this.cursor = null;
        this.host_memory_bytes = 0;
        return Promise.resolve();
    }

    async dispose()
    {
        this.initialized = false;
        return this.reset();
    }

    /** @param {number} resource_id */
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

    assert_initialized()
    {
        if(!this.initialized)
        {
            throw new Error("GPU backend is not initialized");
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

function checked_rgba_size(width, height)
{
    const size = width * height * 4;
    if(!Number.isSafeInteger(size))
    {
        throw new Error("Resource dimensions overflow host addressing");
    }
    return size;
}

function checked_multiply(left, right, message)
{
    const result = left * right;
    if(!Number.isSafeInteger(result))
    {
        throw new Error(message);
    }
    return result;
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
