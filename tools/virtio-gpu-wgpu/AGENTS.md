# Rust/Wasm VirtIO GPU Renderer Guidance

## Scope

This directory is an independent Rust/wasm-bindgen crate. It owns the browser `wgpu` renderer, standard 2D resource presentation, private capset versions 1-3, and the bounded Mesa/Ghostty translator. The root `Cargo.toml` does not build it. Keep its committed `Cargo.lock` deterministic.

Canonical protocol and lifecycle behavior lives in `../../docs/virtio-gpu-webgpu.md`; exact private byte layouts live in `../../docs/webgpuvirt-wire-v{1,2,3}.md`. Do not create a competing contract here.

## Boundary

JavaScript in `src/virtio_gpu.js` owns guest-memory validation, VirtIO commands, context/resource attachment, queue order, fences, snapshots, and error responses. This crate receives owned bytes and checked resource handles. It must not retain a Wasm-memory view across an `await` or invent guest-visible state outside the JavaScript device.

The default device is 2D-only. Private capset 7 is exposed only after explicit `experimental_3d` configuration and successful Rust/Wasm backend preflight. Do not advertise general virgl, GLSL, OpenGL, Vulkan, blobs, UUIDs, depth/stencil, or direct-JavaScript 3D support.

## Renderer Invariants

- Decode complete batches before creating WebGPU objects or submitting queue work. A rejected batch has no partial side effects.
- Keep checked byte, record, resource, binding, shader, pipeline, draw, transfer, in-flight, and timeout ceilings synchronized with `src/virtio_gpu.js` and the versioned wire documents.
- Preserve queue order. Fenced success waits for GPU completion; unfenced success still follows ordered validation and submission.
- Reset, context destruction, resource unref, timeout, and device loss retire generation-owned objects deterministically. Never reuse a stale WebGPU handle.
- Capture Naga and wgpu validation failures as bounded errors. Guest input must not panic Rust, hang a descriptor, or trigger an unhandled promise rejection.
- Keep 2D/VGA fallback functional after renderer failure. Live 3D state remains snapshot-ineligible.

## Measured Mesa/Ghostty Translation

`src/submit_3d.rs` accepts only the measured shader declarations, command records, resource layouts, and state combinations. Unknown shapes fail closed.

- `BackgroundColor` is a uniform-only whole-window draw. It uses a synthetic full-screen triangle and must not share the storage-buffer-driven `CellBackground` shader; doing so creates a two-tone diagonal half-screen.
- Cell backgrounds, glyphs, images, solid colors, rectangles, and diagnostic probes remain separate program classes with separate validated bindings.
- Preserve premultiplied-alpha semantics for glyph/image/cell draws and replacement blending for the whole-window background and solid-color program.
- Any expansion requires a new observed shape, explicit classification, bounded resources, malformed-input tests, and real-browser pixel acceptance before it is advertised.

## Performance Rules

The committed llvmpipe and accelerated Ghostty baselines are the control. Optimize only measured work; do not add unbounded caches, speculative retries, wider limits, or correctness-changing shortcuts.

Open investigations are split by ownership: XWAH-24 dirty-range uploads, XWAH-25 readbacks, XWAH-26 renderer-object caches, and XWAH-27 fences/notifications. XWAH-23 owns direct scanout. Preserve the fixed terminal SHA-256 and five-run comparison contract for performance claims.

## Verification

From the repository root:

```sh
make virtio-gpu-3d-transport-test
make virtio-gpu-3d-triangle-test
make virtio-gpu-3d-shader-test
make virtio-gpu-webgpuvirt-triangle-test
make virtio-gpu-codex-accelerated-test
cargo fmt --manifest-path tools/virtio-gpu-wgpu/Cargo.toml -- --check
```

The browser targets own port 8082; stop manual servers first. Accelerated acceptance must report matching dominant background colors across opposite diagonal regions, mixed transparent/opaque cursor alpha, zero invalid/backend/WebGPU errors, and no leaked 3D objects. `build/`, `target/`, Wasm, bindings, and generated images are ignored artifacts and must not be committed.
