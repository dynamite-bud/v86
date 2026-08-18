import { dbg_assert } from "../log.js";
import { load_file } from "../lib.js";

/** @interface */
export function FileStorageInterface() {}

/**
 * Read a portion of a file.
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @param {number} file_size
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
FileStorageInterface.prototype.read = function(sha256sum, offset, count, file_size) {};

/**
 * Add a read-only file to the filestorage.
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
FileStorageInterface.prototype.cache = function(sha256sum, data) {};

/**
 * Call this when the file won't be used soon, e.g. when a file closes or when this immutable
 * version is already out of date. It is used to help prevent accumulation of unused files in
 * memory in the long run for some FileStorage mediums.
 */
FileStorageInterface.prototype.uncache = function(sha256sum) {};

/**
 * Call this when a file closes. Storage implementations may keep the immutable
 * data cached until they need the space.
 * @param {string} sha256sum
 */
FileStorageInterface.prototype.release = function(sha256sum) {};

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {number=} max_bytes Maximum cached immutable data in bytes. Defaults to 256 MiB.
 */
export function MemoryFileStorage(max_bytes = 256 * 1024 * 1024)
{
    if(!Number.isSafeInteger(max_bytes) || max_bytes < 0)
    {
        throw new TypeError("MemoryFileStorage max_bytes must be a non-negative safe integer");
    }

    /**
     * From sha256sum to file data, in least-to-most-recently-used order.
     * @type {Map<string,Uint8Array>}
     */
    this.filedata = new Map();
    this.max_bytes = max_bytes;
    this.total_bytes = 0;
}

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
MemoryFileStorage.prototype.read = async function(sha256sum, offset, count)
{
    dbg_assert(sha256sum, "MemoryFileStorage read: sha256sum should be a non-empty string");
    const data = this.filedata.get(sha256sum);

    if(!data)
    {
        return null;
    }

    // Refresh insertion order so cache pressure evicts the coldest file.
    this.filedata.delete(sha256sum);
    this.filedata.set(sha256sum, data);
    return data.subarray(offset, offset + count);
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
MemoryFileStorage.prototype.cache = async function(sha256sum, data)
{
    dbg_assert(sha256sum, "MemoryFileStorage cache: sha256sum should be a non-empty string");
    if(data.byteLength > this.max_bytes)
    {
        return;
    }
    const previous = this.filedata.get(sha256sum);
    if(previous)
    {
        this.total_bytes -= previous.byteLength;
        this.filedata.delete(sha256sum);
    }

    this.filedata.set(sha256sum, data);
    this.total_bytes += data.byteLength;

    while(this.total_bytes > this.max_bytes)
    {
        const oldest_sha256sum = this.filedata.keys().next().value;
        if(oldest_sha256sum === undefined)
        {
            throw new Error("MemoryFileStorage cache size accounting is inconsistent");
        }
        const oldest_data = this.filedata.get(oldest_sha256sum);
        dbg_assert(oldest_data);
        this.filedata.delete(oldest_sha256sum);
        this.total_bytes -= oldest_data.byteLength;
    }
};

/**
 * @param {string} sha256sum
 */
MemoryFileStorage.prototype.uncache = function(sha256sum)
{
    const data = this.filedata.get(sha256sum);
    if(data)
    {
        this.filedata.delete(sha256sum);
        this.total_bytes -= data.byteLength;
    }
};

/**
 * @param {string} sha256sum
 */
MemoryFileStorage.prototype.release = function(sha256sum)
{
    // The bounded LRU owns eviction. Retaining recently closed executables
    // avoids refetching and decompressing them on every guest exec.
};

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {FileStorageInterface} file_storage
 * @param {string} baseurl
 * @param {function(number,!Uint8Array):(!ArrayBuffer|!Promise<!ArrayBuffer>)} zstd_decompress
 */
export function ServerFileStorageWrapper(file_storage, baseurl, zstd_decompress)
{
    dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

    if(!baseurl.endsWith("/"))
    {
        baseurl += "/";
    }

    this.storage = file_storage;
    this.baseurl = baseurl;
    this.zstd_decompress = zstd_decompress;
    /** @type {Map<string,!Promise<Uint8Array>>} */
    this.pending_loads = new Map();
}

/**
 * @param {string} sha256sum
 * @param {number} file_size
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.load_from_server = function(sha256sum, file_size)
{
    const pending = this.pending_loads.get(sha256sum);
    if(pending)
    {
        return pending;
    }

    const load = new Promise((resolve, reject) =>
    {
        load_file(this.baseurl + sha256sum, { done: async buffer =>
        {
            try
            {
                let data = new Uint8Array(buffer);
                if(sha256sum.endsWith(".zst"))
                {
                    data = new Uint8Array(
                        await this.zstd_decompress(file_size, data)
                    );
                }
                await this.cache(sha256sum, data);
                resolve(data);
            }
            catch(error)
            {
                reject(error);
            }
        }});
    });
    this.pending_loads.set(sha256sum, load);
    const clear_pending = () =>
    {
        if(this.pending_loads.get(sha256sum) === load)
        {
            this.pending_loads.delete(sha256sum);
        }
    };
    load.then(clear_pending, clear_pending);
    return load;
};

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @param {number} file_size
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.read = async function(sha256sum, offset, count, file_size)
{
    const data = await this.storage.read(sha256sum, offset, count, file_size);
    if(!data)
    {
        const full_file = await this.load_from_server(sha256sum, file_size);
        return full_file.subarray(offset, offset + count);
    }
    return data;
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
ServerFileStorageWrapper.prototype.cache = async function(sha256sum, data)
{
    return await this.storage.cache(sha256sum, data);
};

/**
 * @param {string} sha256sum
 */
ServerFileStorageWrapper.prototype.uncache = function(sha256sum)
{
    this.storage.uncache(sha256sum);
};

/**
 * @param {string} sha256sum
 */
ServerFileStorageWrapper.prototype.release = function(sha256sum)
{
    this.storage.release(sha256sum);
};
