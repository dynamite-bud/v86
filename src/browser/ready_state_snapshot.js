const DATABASE_NAME = "v86-ready-state-snapshots";
const DATABASE_VERSION = 1;
const STORE_NAME = "snapshots";
const STATE_MAGIC = 0x86768676;
const MIN_FREE_STORAGE_BYTES = 32 * 1024 * 1024;

export const READY_STATE_SNAPSHOT_SCHEMA = 1;

/**
 * @param {*} value
 * @param {string} name
 */
function require_nonempty_string(value, name)
{
    if(typeof value !== "string" || value.length === 0)
    {
        throw new TypeError(`${name} must be a non-empty string`);
    }
}

/**
 * @param {ArrayBuffer} state
 * @return {number}
 */
export function validate_ready_state_snapshot(state)
{
    if(!(state instanceof ArrayBuffer) || state.byteLength < 16)
    {
        throw new TypeError("Snapshot state must be a v86 ArrayBuffer");
    }
    const header = new DataView(state, 0, 16);
    if(header.getUint32(0, true) !== STATE_MAGIC)
    {
        throw new Error("Snapshot state has an invalid v86 header");
    }
    if(header.getInt32(8, true) !== state.byteLength)
    {
        throw new Error("Snapshot state length does not match its v86 header");
    }
    return header.getInt32(4, true);
}

/**
 * @param {ArrayBuffer|Uint8Array} value
 * @return {Promise<string>}
 */
async function sha256(value)
{
    const crypto = globalThis["crypto"];
    if(!crypto || !crypto.subtle)
    {
        throw new Error("Web Crypto is required for snapshot compatibility checks");
    }
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let result = "";
    for(const byte of digest)
    {
        result += byte.toString(16).padStart(2, "0");
    }
    return result;
}

/**
 * Hash every artifact that affects serialized emulator or guest state.
 * @param {!Object} configuration JSON-compatible emulator configuration
 * @param {!Array<string>} asset_urls
 * @param {function(string, Object=):Promise<!Response>=} fetch_fn
 * @return {Promise<string>}
 */
export async function create_ready_state_fingerprint(configuration, asset_urls, fetch_fn = fetch)
{
    if(!configuration || configuration.constructor !== Object)
    {
        throw new TypeError("Snapshot configuration must be an object");
    }
    if(!Array.isArray(asset_urls) || asset_urls.length === 0)
    {
        throw new TypeError("Snapshot assets must be a non-empty array");
    }
    const assets = await Promise.all(asset_urls.map(async url => {
        require_nonempty_string(url, "Snapshot asset URL");
        const response = await fetch_fn(url, { cache: "no-cache" });
        if(!response.ok)
        {
            throw new Error(`Snapshot compatibility asset failed to load: ${url} (${response.status})`);
        }
        return { url, sha256: await sha256(await response.arrayBuffer()) };
    }));
    const payload = new TextEncoder().encode(JSON.stringify({
        schema: READY_STATE_SNAPSHOT_SCHEMA,
        configuration,
        assets,
    }));
    return sha256(payload);
}

/** @param {*} request */
function request_result(request)
{
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
}

/** @param {*} transaction */
function transaction_complete(transaction)
{
    return new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
        transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    });
}

async function open_database()
{
    const indexed_db = globalThis["indexedDB"];
    if(!indexed_db)
    {
        throw new Error("IndexedDB is unavailable; persistent snapshots are not supported");
    }
    const request = indexed_db.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
        const database = request.result;
        if(!database.objectStoreNames.contains(STORE_NAME))
        {
            database.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
    };
    return request_result(request);
}

/** @param {ArrayBuffer} state */
async function compress_state(state)
{
    const CompressionStreamConstructor = globalThis["CompressionStream"];
    const BlobConstructor = globalThis["Blob"];
    if(typeof CompressionStreamConstructor !== "function" || typeof BlobConstructor !== "function")
    {
        return {
            compression: "none",
            data: state,
            stored_bytes: state.byteLength,
        };
    }
    const input = new BlobConstructor([state]);
    const stream = input.stream().pipeThrough(new CompressionStreamConstructor("gzip"));
    const data = await new Response(stream).blob();
    return {
        compression: "gzip",
        data,
        stored_bytes: data.size,
    };
}

/** @param {!Object} record */
async function decompress_state(record)
{
    if(record.compression === "none")
    {
        if(record.data instanceof ArrayBuffer)
        {
            return record.data;
        }
        if(record.data && typeof record.data.arrayBuffer === "function")
        {
            return record.data.arrayBuffer();
        }
        throw new Error("Uncompressed snapshot data is invalid");
    }
    if(record.compression !== "gzip")
    {
        throw new Error(`Unsupported snapshot compression: ${record.compression}`);
    }
    const DecompressionStreamConstructor = globalThis["DecompressionStream"];
    if(typeof DecompressionStreamConstructor !== "function" ||
       !record.data || typeof record.data.stream !== "function")
    {
        throw new Error("This browser cannot decompress the saved snapshot");
    }
    const stream = record.data.stream().pipeThrough(new DecompressionStreamConstructor("gzip"));
    return new Response(stream).arrayBuffer();
}

/** @param {number} required_bytes */
async function require_storage_capacity(required_bytes)
{
    const storage = navigator.storage;
    if(!storage || typeof storage.estimate !== "function")
    {
        return;
    }
    const estimate = await storage.estimate();
    if(Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) &&
       estimate.quota - estimate.usage < required_bytes + MIN_FREE_STORAGE_BYTES)
    {
        throw new Error("Not enough browser storage is available for this snapshot");
    }
}

/**
 * @constructor
 * @param {string} key
 */
export function ReadyStateSnapshotStore(key)
{
    require_nonempty_string(key, "Snapshot key");
    this.key = key;
}

ReadyStateSnapshotStore.prototype.get_metadata = async function()
{
    const database = await open_database();
    try
    {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const completion = transaction_complete(transaction);
        const record = await request_result(transaction.objectStore(STORE_NAME).get(this.key));
        await completion;
        if(!record)
        {
            return null;
        }
        return {
            created_at: record.created_at,
            fingerprint: record.fingerprint,
            state_version: record.state_version,
            state_bytes: record.state_bytes,
            stored_bytes: record.stored_bytes,
            compression: record.compression,
        };
    }
    finally
    {
        database.close();
    }
};

/**
 * @param {string} fingerprint
 * @return {Promise<?{state: ArrayBuffer, metadata: !Object}>}
 */
ReadyStateSnapshotStore.prototype.load = async function(fingerprint)
{
    require_nonempty_string(fingerprint, "Snapshot fingerprint");
    const database = await open_database();
    let record;
    try
    {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const completion = transaction_complete(transaction);
        record = await request_result(transaction.objectStore(STORE_NAME).get(this.key));
        await completion;
    }
    finally
    {
        database.close();
    }
    if(!record)
    {
        return null;
    }
    if(record.schema !== READY_STATE_SNAPSHOT_SCHEMA || record.fingerprint !== fingerprint)
    {
        await this.delete();
        return null;
    }
    const state = await decompress_state(record);
    const state_version = validate_ready_state_snapshot(state);
    if(state_version !== record.state_version || state.byteLength !== record.state_bytes)
    {
        await this.delete();
        throw new Error("Saved snapshot metadata does not match its state");
    }
    return {
        state,
        metadata: {
            created_at: record.created_at,
            fingerprint: record.fingerprint,
            state_version,
            state_bytes: state.byteLength,
            stored_bytes: record.stored_bytes,
            compression: record.compression,
        },
    };
};

/**
 * @param {string} fingerprint
 * @param {ArrayBuffer} state
 * @return {Promise<!Object>}
 */
ReadyStateSnapshotStore.prototype.save = async function(fingerprint, state)
{
    require_nonempty_string(fingerprint, "Snapshot fingerprint");
    const state_version = validate_ready_state_snapshot(state);
    const compressed = await compress_state(state);
    await require_storage_capacity(compressed.stored_bytes);
    const storage = navigator.storage;
    if(storage && typeof storage.persist === "function")
    {
        await storage.persist().catch(() => false);
    }
    const record = {
        key: this.key,
        schema: READY_STATE_SNAPSHOT_SCHEMA,
        fingerprint,
        created_at: new Date().toISOString(),
        state_version,
        state_bytes: state.byteLength,
        stored_bytes: compressed.stored_bytes,
        compression: compressed.compression,
        data: compressed.data,
    };
    const database = await open_database();
    try
    {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const completion = transaction_complete(transaction);
        transaction.objectStore(STORE_NAME).put(record);
        await completion;
    }
    finally
    {
        database.close();
    }
    return {
        created_at: record.created_at,
        fingerprint,
        state_version,
        state_bytes: record.state_bytes,
        stored_bytes: record.stored_bytes,
        compression: record.compression,
    };
};

ReadyStateSnapshotStore.prototype.delete = async function()
{
    const database = await open_database();
    try
    {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const completion = transaction_complete(transaction);
        transaction.objectStore(STORE_NAME).delete(this.key);
        await completion;
    }
    finally
    {
        database.close();
    }
};
