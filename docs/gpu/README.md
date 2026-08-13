# Working on the VirtIO GPU

This is the operational entry point for v86 VirtIO GPU development. The detailed protocol, state, security, and future-3D design is canonical in [`docs/virtio-gpu-webgpu.md`](../virtio-gpu-webgpu.md). Guest-image details remain beside their reproducible inputs.

## Current Boundary

Implemented and tested today:

- A modern VirtIO GPU PCI device with one scanout, EDID, display events, controlled resize, and control/cursor virtqueues.
- Standard 2D resources, fragmented guest backing, transfers, scanout/flush, cursor overlay, fences, reset, snapshots, hard limits, and performance counters.
- A deterministic in-memory backend for Node tests.
- Two browser presentation backends: direct JavaScript WebGPU (`webgpu-js`) and Rust/Wasm `wgpu`. Both upload and present standard 2D resources.
- Reproducible Linux KMS and Alpine XFCE guests, with Xorg and Wayland exercised through both browser backends.
- An opt-in capset-7 basic-render path on the Rust/Wasm backend. Frozen version
  1 maps the pinned Linux/libdrm flow to one startup-validated immutable
  pipeline. Version 2 accepts bounded guest WGSL, validates it synchronously
  with Naga, creates context-local WebGPU pipelines atomically under the patched
  wgpu error scope, caps draw work, and faults the renderer after 5000 ms if
  compilation or submitted GPU work does not settle.
- Browser acceptance proves both the pinned red triangle and an arbitrary green
  triangle, deterministic invalid-source and draw-limit rejection, ordered fence
  completion, repeated timeout fallback/recovery, and zero leaked standard 3D
  objects.

Not implemented:

- SPIR-V, resource bindings, vertex/index buffers, sampled textures,
  depth/stencil, blending, readback, resource blobs/UUIDs, host mappings,
  Mesa/Gallium, shader translation, virgl compatibility, Vulkan, or 3D on the
  direct JavaScript backend.
- The default device still reports `num_capsets = 0` and does not advertise 3D
  feature bits. Capset 7 is available only with `experimental_3d: true` and a
  successful Rust/Wasm backend preflight.

The exact implemented byte contracts are frozen in
[`docs/webgpuvirt-wire-v1.md`](../webgpuvirt-wire-v1.md) and
[`docs/webgpuvirt-wire-v2.md`](../webgpuvirt-wire-v2.md).

## Data Flow

```text
Linux guest DRM/KMS
  -> VirtIO GPU control/cursor queues
  -> src/virtio_gpu.js
  -> VirtioGpuBackend promise boundary
  -> MemoryGpuBackend (tests)
     or webgpu-js (browser JavaScript)
     or wgpu (Rust/Wasm)
  -> dedicated WebGPU canvas
```

JavaScript owns the guest-visible VirtIO protocol, guest-memory validation, queue ordering, resource IDs, snapshots, and error responses. A browser backend owns renderer objects and presentation. Guest bytes must be copied before an `await`; browser GPU handles never enter VM snapshots.

## Code Map

| Area | Path | Responsibility |
| --- | --- | --- |
| Device and protocol | `src/virtio_gpu.js` | PCI integration, queues, commands, resources, guest backing, fences, state, limits, statistics |
| Abstract/test backend | `src/browser/virtio_gpu_backend.js` | Promise contract and deterministic `MemoryGpuBackend` |
| Shared browser adapter | `src/browser/virtio_gpu_wgpu_backend.js` | Canvas/VGA lifecycle, dynamic renderer boundary, device-loss handling |
| Direct renderer | `src/browser/virtio_gpu_webgpu_backend.js` | JavaScript `navigator.gpu` 2D textures, uploads, conversion, presentation |
| Rust renderer | `tools/virtio-gpu-wgpu/` | Rust/Wasm `wgpu` 2D renderer plus pinned version-1 and bounded arbitrary-WGSL version-2 paths |
| Browser API wiring | `src/browser/starter.js` | Backend selection, options, state integration |
| Protocol tests | `tests/unit/virtio_gpu_protocol.js` | Wire layouts, commands, malformed input, limits, state, ordering |
| Renderer tests | `tests/unit/virtio_gpu_webgpu_backend.js` | Direct renderer and shared browser lifecycle |
| Linux KMS test | `tests/devices/virtio_gpu.js` | Pinned guest probe, DRM/KMS modeset, reference pixels |
| Linux capset gate | `tests/devices/virtio_gpu_capset_probe.js` | Pinned Linux 6.18.44/libdrm capset-7 `GET_CAPS` and `CONTEXT_INIT` proof |
| Browser matrix | `tests/browser/virtio_gpu_acceptance.js` | Xorg/Wayland × JavaScript/Rust backends, resize, cursor, reset, device loss, snapshots |
| Desktop example | `examples/virtio_gpu_desktop.html` | Manual desktop, renderer/session selectors, persistent ready snapshots |
| KMS guest | `tools/docker/virtio-gpu-alpine/` | Minimal reproducible Linux DRM/KMS image and probe |
| Desktop guest | `tools/docker/virtio-gpu-alpine-desktop/` | Reproducible XFCE Xorg/Wayland image and readiness contract |

## Prerequisites

The repository build uses Make, Node.js, Rust, Python, and the Closure Compiler. GPU-specific work additionally needs:

- Rust stable with `wasm32-unknown-unknown`.
- `wasm-bindgen` matching `tools/virtio-gpu-wgpu/Cargo.lock`.
- The committed renderer lock pins `wgpu` and Naga 30.0.0 to
  `dynamite-bud/wgpu` revision
  `7d5148d689f24101eb34c6af71b0071dcd113059`, the reviewed v30 backport of
  [gfx-rs/wgpu#10039](https://github.com/gfx-rs/wgpu/pull/10039).
- A WebGPU-capable Chromium browser.
- Docker with `linux/386` support and Python `zstandard` only when rebuilding guest images.
- OpenJDK 17 on the executable `PATH` when rebuilding `build/libv86.mjs`. On Homebrew macOS:

```sh
export PATH="$(brew --prefix openjdk@17)/bin:$PATH"
```

Generated `build/`, `images/`, and Rust `target/` artifacts are not source. Do not commit them.

## Build and Launch

From the repository root:

```sh
make build/libv86.mjs build/v86.wasm
make virtio-gpu-wgpu
python3 -m http.server 8000
```

Open:

```text
http://127.0.0.1:8000/examples/virtio_gpu_desktop.html?desktop=xorg&renderer=webgpu-js
http://127.0.0.1:8000/examples/virtio_gpu_desktop.html?desktop=xorg&renderer=wgpu
http://127.0.0.1:8000/examples/virtio_gpu_desktop.html?desktop=wayland&renderer=webgpu-js
http://127.0.0.1:8000/examples/virtio_gpu_desktop.html?desktop=wayland&renderer=wgpu
```

Use one hostname and port consistently: persistent snapshots are origin-scoped. The first desktop boot lazily fetches content-addressed `.bin.zst` rootfs files over local HTTP; save a snapshot only after the complete desktop is visible.

Rebuild a guest only after changing its inputs:

```sh
make virtio-gpu-kms-image
make virtio-gpu-desktop-image
```

Review the generated contract against the committed contract. Never commit the generated `images/` tree.

## Verification by Change

| Change | Required focused checks |
| --- | --- |
| Device protocol, queues, resources, limits, or state | `make virtio-gpu-unit-test` |
| PCI/interrupt or ACPI behavior | `make pci-unit-test acpi-unit-test` |
| Guest backing/file storage | `make filesystem-unit-test` |
| Linux KMS path | `make virtio-gpu-test virtio-gpu-test-release` |
| Capset transport, private submit, or pinned Linux/libdrm path | `make virtio-gpu-codex-image virtio-gpu-capset-probe-test virtio-gpu-3d-transport-test` |
| Reference triangle guest or browser acceptance | `make virtio-gpu-3d-triangle-test` |
| Arbitrary WGSL validation, compilation, timeout, or recovery | `make virtio-gpu-3d-shader-test` |
| Browser backend, canvas lifecycle, resize, cursor, or loss | `make virtio-gpu-browser-test` |
| Ready-state persistence | `make virtio-gpu-ready-snapshot-test` |
| Rust renderer | `make virtio-gpu-wgpu`; run `cargo fmt --manifest-path tools/virtio-gpu-wgpu/Cargo.toml -- --check` and the applicable browser tests |
| Guest-image inputs | Rebuild the image, compare its generated checksum contract, then run its KMS/browser contract |
| JavaScript changes | `make eslint` or targeted ESLint plus the focused contract above |

`all-tests` includes the GPU unit target but not the long browser matrix. Run the browser target explicitly for browser or renderer changes.

## Invariants

- Standard 2D remains the default compatibility path.
- Never advertise a feature, format, limit, capset, or opcode before its implementation and tests are complete.
- Treat every guest field, descriptor, address, count, rectangle, shader, and command byte as untrusted.
- Use checked arithmetic before copies or allocations. Bound command bytes, backing entries, resources, queue work, and host GPU memory.
- Preserve queue order. Fenced commands wait for backend completion; unfenced commands still complete only after ordered validation and submission.
- Do not retain Wasm-memory views across asynchronous work.
- Reset/device loss must invalidate stale completions, release host objects, and preserve a working 2D/VGA recovery path.
- Malformed input returns a deterministic VirtIO GPU error. It must not assert JavaScript, panic Rust, partially submit GPU work, leak an object, or retain a descriptor indefinitely.
- Keep the direct JavaScript backend 2D-only until it independently meets the same 3D validation contract as Rust/Wasm.

## Debugging

- Use `log_level: 0` for normal Linux bring-up. Debug CPU/IRQ logging changes timing and can obscure transport failures.
- Expand the example's serial console for guest boot and readiness markers.
- Query `window.emulator.virtio_gpu_get_stats()` for command counts, rejected commands, bytes, waits, resources, queue depth, resize, cursor, and backend errors.
- A cold desktop boot produces many same-origin `.bin.zst` requests while the lazy 9p rootfs loads libraries, fonts, themes, icons, and applications. This is local guest filesystem traffic, not external networking.
- If the page remains on VGA, confirm `/dev/dri/card0`, the serial readiness markers, and a live scanout.
- If WebGPU fails, inspect browser console errors and `backend.fatal_error`; do not mask device loss with retries or sleeps.

## Documentation Map

- [`docs/virtio-gpu-webgpu.md`](../virtio-gpu-webgpu.md): canonical implemented architecture, protocol invariants, limits, state, browser behavior, and gated 3D design.
- [`tools/docker/virtio-gpu-alpine/Readme.md`](../../tools/docker/virtio-gpu-alpine/Readme.md): minimal KMS guest build and probe.
- [`tools/docker/virtio-gpu-alpine-desktop/Readme.md`](../../tools/docker/virtio-gpu-alpine-desktop/Readme.md): desktop image, launch URLs, snapshots, sessions, and image verification.
- [XWAH-1](https://github.com/dynamite-bud/v86/issues/1): completed bounded capset-7 basic-render milestone.
- [XWAH-15](https://github.com/dynamite-bud/v86/issues/15): bounded arbitrary-WGSL compilation and patched wgpu error-scope milestone.
- [`docs/gpu/ghostty-codex-appliance.md`](ghostty-codex-appliance.md): XWAH-3 architecture decision, downstream i386 artifacts, image contract, networking, acceptance, and size evidence.
- [`tools/docker/virtio-gpu-alpine-codex/Readme.md`](../../tools/docker/virtio-gpu-alpine-codex/Readme.md): reproducible Xorg/Openbox appliance implementation, file ownership, build and verification workflow, security limitations, troubleshooting, and Cage sibling handoff.

Historical root-level Codex task/plan files were removed after their implemented 2D material and surviving 3D decisions were consolidated into the canonical architecture and this contributor guide.
