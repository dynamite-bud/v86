// XWAH-9 Phase 4 Stage W1: the gram instantiation shape shared by the main
// thread (src/browser/starter.js build_env) and the worker runtime
// (src/browser/vcpu_worker.js). Factored out of starter.js unchanged in
// behavior: instantiate the matching gram variant over the (already created)
// guest memory, merge its accessor exports over the caller's env functions,
// and add the JS-implemented gram_copy_out (guest RAM -> instance memory
// copy; neither single-memory module can address both memories —
// src/rust/cpu/memory.rs gram_ext).

/**
 * @param {Object} env_funcs the caller's env import functions
 * @param {BufferSource} gram_bytes a validated gram[-shared].wasm module
 * @param {WebAssembly.Memory} guest_memory
 * @param {function(): ArrayBuffer} get_instance_buffer returns the *current*
 *        buffer of the main module's instance memory (looked up per call:
 *        the memory only exists after the main module instantiates, and its
 *        buffer identity changes if the instance memory grows)
 * @return {Promise<Object>} the "env" imports object for the main module
 */
export async function build_gram_env(env_funcs, gram_bytes, guest_memory, get_instance_buffer)
{
    // shared-ness of gram.wasm's memory import must match guest_memory
    // exactly (LinkError otherwise), hence the two artifact variants
    const gram = await WebAssembly.instantiate(gram_bytes, { "env": { "guest_memory": guest_memory } });

    const env = Object.assign(Object.create(null), env_funcs, gram.instance.exports);
    env["gram_copy_out"] = (src_addr, dst, count) =>
    {
        new Uint8Array(get_instance_buffer(), dst, count)
            .set(new Uint8Array(guest_memory.buffer, src_addr, count));
    };
    return { "env": env };
}
