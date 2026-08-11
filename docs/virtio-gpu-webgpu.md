# VirtIO GPU and WebGPU Architecture

## Scope

PR 1 through PR 3 provide a modern VirtIO GPU PCI function, the complete standard 2D path, a deterministic memory backend, and optional browser WebGPU presentation:

- PCI identity `1af4:1050`, subsystem ID `16`, class `0380` (display controller, other).
- VirtIO 1 modern transport only (`VIRTIO_F_VERSION_1`).
- One configurable scanout, defaulting to `1024x768`, with control and cursor virtqueues.
- Display info, 2D resource create/unref, attach/detach backing, transfer, set-scanout, and flush commands.
- Four common 32-bit scanout formats: B8G8R8A8, B8G8R8X8, R8G8B8A8, and R8G8B8X8.
- Bounded fragmented guest-backing reads and ordered asynchronous backend submission.
- Fence-aware replies, reset/restore generation guards, and serializable resource metadata.
- A Linux 6.12 KMS test that transfers the locked `modetest` SMPTE pattern into `MemoryGpuBackend`.
- A separately built Rust/Wasm `wgpu` renderer that presents the same 2D scanout on a dedicated browser canvas.

EDID, blobs, UUIDs, virgl, cursor commands, custom capsets, and experimental 3D command streams remain deferred.

## Data Flow

```text
Linux virtio_gpu driver
  -> modern VirtIO PCI transport (src/virtio.js)
  -> VirtioGpu queue/parser (src/virtio_gpu.js)
  -> VirtioGpuBackend promise boundary
  -> MemoryGpuBackend (deterministic tests)
     or WgpuBackend -> Rust/Wasm wgpu renderer -> browser WebGPU canvas
```

`VirtioGpu` owns guest-visible PCI/config/queue state. A backend owns host renderer resources only. Protocol parsing never depends on browser APIs. Malformed guest data produces a VirtIO GPU response header rather than an assertion or exception.

Queue notifications remain synchronous, but backend work runs through an ordered promise chain. Only one request is popped per queue at a time; reset and restore generations invalidate stale completions. Guest-memory bytes are copied before any backend `await`, so no view survives Wasm memory growth.

## Backend Contract

`src/browser/virtio_gpu_backend.js` defines these asynchronous operations:

```text
initialize, createResource2D, destroyResource, uploadResource2D,
setScanout, flush, waitIdle, reset, dispose
```

The interface contains no WebGPU dependency. `MemoryGpuBackend` stores deterministic raw 32-bit resource bytes with their VirtIO GPU format, enforces rectangle and memory bounds, tracks scanout and flush state, and is suitable for Node and Linux integration tests.

`src/browser/virtio_gpu_wgpu_backend.js` implements the same contract for browsers. It dynamically imports the wasm-bindgen module from `build/virtio-gpu-wgpu/`, while the independent `tools/virtio-gpu-wgpu/` crate owns WebGPU textures, upload alignment, format conversion, scanout rendering, queue completion, surface recovery, and device-loss reporting.

Fenced renderer commands wait for `waitIdle()` before publishing their used-ring response. Unfenced commands reply after ordered validation and backend submission. Display-info and deterministic error responses require no renderer work.

## Protocol Invariants

- All guest fields are little-endian and untrusted.
- The fixed control header is 24 bytes.
- A request shorter than the header returns `VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER`.
- An unsupported complete request returns `VIRTIO_GPU_RESP_ERR_UNSPEC`.
- A fenced response copies the fence flag, 64-bit fence ID, and context ID.
- `GET_DISPLAY_INFO` returns the required 408-byte structure: scanout 0 enabled at `(0,0)` with the configured mode; scanouts 1-15 are zeroed.
- Writable buffers shorter than the command response receive an invalid-parameter header when capacity permits; writes are otherwise safely truncated by the VirtIO buffer-chain helper.
- Resource IDs must be nonzero and unique; total host resource storage is bounded before allocation.
- Backing lists are capped at 16,384 entries, reject nonzero high addresses and non-RAM ranges, and must cover the resource without exceeding its page-rounded size.
- Transfers validate rectangle, offset, row pitch, and fragmented backing bounds before allocating or copying.
- `SET_SCANOUT` accepts only scanout 0; resource ID 0 disables it. Flush submits backend work only for a scanned-out resource.
- Supported 2D commands return `VIRTIO_GPU_RESP_OK_NODATA`; invalid resource, scanout, parameter, and memory conditions use their specific protocol errors.

## PCI and Device Configuration

The allocated PCI function is `0x0d << 3`. Device, ISR, common, and notification capabilities use ports `0xe600`, `0xe700`, `0xe800`, and `0xe900`. These values are named in `src/virtio_gpu.js` rather than repeated.

The device configuration reports one scanout, zero capsets, and zero blob alignment. `events_clear` applies write-one-to-clear semantics to `events_read`.

`src/virtio.js` accepts optional programming-interface, subclass, and class bytes. Their defaults remain `00:02:00`, preserving every existing VirtIO device's PCI metadata.

## PCI and ACPI Interrupt Correctness

### Shared PCI INTx ownership

Linux exposed an existing PCI interrupt bug during release-mode bring-up. The 9p transport and virtio-gpu can share legacy IRQ 10. Previously, `PCI.lower_irq` lowered the CPU line whenever any one device acknowledged its interrupt, even if another device on that line still had a pending interrupt. Depending on timing, Linux then missed a virtqueue completion: debug logging could make the probe pass while the faster release bundle timed out.

`src/pci.js` now records the asserted IRQ for each PCI function and a reference count for each shared line. Raising an already-asserted function is idempotent. A device acknowledgement removes only that device's assertion, and the CPU line is lowered only after the final owner releases it. The per-device ownership array is included in PCI snapshots and the per-line counts are reconstructed during restore. `tests/unit/pci.js` covers duplicate raises, shared ownership, out-of-order lowers, and snapshot restore.

This is a transport-level fix, not a virtio-gpu timing workaround. Device handlers must continue to clear their own interrupt source; adding sleeps, serial logging, or delayed GPU replies would only mask the lost shared interrupt.

### ACPI GPE status writes

A second release-only failure initially enumerated the GPU in the kernel log, then removed PCI functions `00:07.0` and above—including virtio-gpu—from sysfs before the userspace probe. The four-byte GPE0 block at `0xAFE0` contains two status bytes followed by two enable bytes. Linux clears pending GPE status by writing ones. `src/acpi.js` previously assigned those writes to every byte, turning a clear operation into pending hotplug events that `acpiphp` could interpret as slot removal.

Writes to `0xAFE0` and `0xAFE1` now clear only the selected status bits; writes to `0xAFE2` and `0xAFE3` still replace the enable masks. `tests/unit/acpi.js` fixes this register contract. Release verification must keep ACPI enabled so the test exercises the path that previously generated phantom hotplug events.

## State and Resource Limits

CPU snapshot slot 92 stores serializable device metadata, resource/backing records, scanout state, and nested VirtIO queue state. Browser GPU handles are never serialized. Restore recreates backend resources, reloads their bytes from snapshotted guest backing, restores the scanout, and flushes it. Reset and restore increment a generation so stale asynchronous work cannot mutate restored state or publish replies into reset queues.

`max_host_memory_bytes` defaults to 256 MiB and bounds both device accounting and `MemoryGpuBackend` allocations. Resource dimensions, rectangles, row arithmetic, guest addresses, backing-entry count, total backing length, and copy ranges are checked before allocation or access.

## Browser Thread Model

The PCI device and queue parser run with the emulator CPU. A browser backend may execute on the same thread or proxy to a worker, but it must preserve the promise contract and per-queue completion ordering. It must not retain guest-memory views across an `await`; copy or re-resolve them because Wasm memory can change.

Standard VirtIO GPU 2D commands remain the compatibility path. Any virgl-like or project-specific 3D-over-WebGPU protocol is experimental, separately negotiated, and must not alter the 2D ABI.

## Test and Guest Contract

`make virtio-gpu-unit-test` covers parsing, malformed buffers, all standard 2D commands, fragmented backing, format and resource limits, rectangle arithmetic, queue ordering, fenced completion, reset invalidation, snapshot restore, PCI identity/features, and the memory backend.

`tests/devices/virtio_gpu.js` boots the generated Alpine i386 filesystem, requires PCI/driver/DRM markers, runs `modetest` at `1024x768`, and asserts the resulting SMPTE pixels directly in `MemoryGpuBackend`. The reproducible image inputs, package/kernel contract, build command, and SHA-256 manifest live under `tools/docker/virtio-gpu-alpine/`.

Browser acceptance uses the same generated Alpine guest with each browser renderer. The VGA canvas remains visible during boot, the dedicated WebGPU canvas becomes visible only after the first successful resource flush, and the locked SMPTE samples must match the decoded `MemoryGpuBackend` pixels. Reset, renderer reinitialization, surface reconfiguration, and controlled device destruction must restore or preserve the VGA fallback without console or WebGPU validation errors.

## Linux Bring-up Workflow

`tools/docker/virtio-gpu-alpine/` contains the reviewed inputs for the canonical i386 guest. Docker is used only to assemble and export the Linux root filesystem; v86 does not depend on Docker at runtime. `build.sh` normalizes the exported tar, converts it to v86's JSON/content-addressed filesystem layout, and writes a checksum contract. Generated files stay ignored under `images/`; source inputs, package locks, probe scripts, and the reviewed `image-contract.json` are committed.

The guest enables normal DRM framebuffer behavior and then starts locked `libdrm` `modetest` against the connected virtio-gpu connector. The process remains alive for the test lifetime so its scanout resource is not torn down before the host assertions inspect dimensions, flushes, and known SMPTE pixels.

`lspci -nnk` reports `Kernel driver in use: virtio-pci` because that is the PCI transport driver. The actual GPU driver binding is the `virtioN` link under `/sys/bus/virtio/drivers/virtio_gpu`; the serial contract reports both facts separately.

## Reproducible Alpine Desktop Profiles

`tools/docker/virtio-gpu-alpine-desktop/` builds a pinned Alpine 3.24.1 i386 XFCE guest on Linux 6.18 LTS. It includes Xorg, labwc, seatd, D-Bus, `xfce4-terminal`, and Thunar. Reviewed direct and transitive package locks, a normalized root filesystem, a flat-file manifest, and the committed `image-contract.json` make the guest reproducible. See its [build and runtime guide](../tools/docker/virtio-gpu-alpine-desktop/Readme.md) for the input inventory, artifact contract, dependency-update procedure, and troubleshooting.

Build the guest and browser renderer, then serve the repository root:

```sh
make virtio-gpu-desktop-image
make all-debug virtio-gpu-wgpu
python3 -m http.server 8000
```

Open `examples/virtio_gpu_desktop.html?desktop=xorg` or `examples/virtio_gpu_desktop.html?desktop=wayland`. The page also provides selectors for both profiles.

| Profile | Guest display stack | Recommended use |
| --- | --- | --- |
| Xorg | Xorg modesetting, XFCE, xfwm4 | Compatibility default and daily desktop |
| Wayland | libinput, seatd, labwc, native XFCE Wayland | New display-stack and compatibility testing |

Both profiles share the root filesystem, terminal, Thunar, applications, and files. They require `/dev/dri/card0`, publish `V86_DESKTOP_READY=PASS` only after the session, panel, and desktop are live, and use the dedicated `1024x768` WebGPU canvas after KMS establishes a scanout. Browser acceptance exercises terminal keyboard input and filesystem browsing in both sessions.

This is a complete desktop over the standard VirtIO GPU 2D path, not guest virgl, OpenGL, or Vulkan acceleration. Guest windows are software-rendered, scanned out through Linux `virtio_gpu`, and presented by the host WebGPU backend. Wayland changes the guest display stack but does not alter that acceleration boundary. Alpine XFCE remains the preferred target because heavier shells would increase CPU and memory costs without gaining guest 3D acceleration.

## Diagnostics and Failure Modes

- Use `log_level: 0` and the kernel `quiet` argument for routine device tests. A debug source build can otherwise emit megabytes of CPU/IRQ tracing and materially slow the guest.
- `tests/devices/virtio_gpu.js` treats `Mounting root: failed` and the initramfs recovery shell as immediate infrastructure failures. Do not wait for the GPU probe timeout when the 9p root never mounted.
- The local probe timeout is 90 seconds multiplied by `TIMEOUT_EXTRA_FACTOR`. Slow CI can scale the timeout without weakening local feedback.
- `V86_GPU_PROBE_STATUS=PASS` means PCI enumeration, `virtio_gpu` binding, DRM discovery, a connected KMS connector, and a live `1024x768` `modetest` modeset all succeeded. The Node device test proves the memory path; browser verification must additionally observe the SMPTE frame on the dedicated WebGPU canvas.
- A response to an unsupported complete command is expected to be `VIRTIO_GPU_RESP_ERR_UNSPEC`. A malformed header or insufficient response buffer receives `VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER` when a response header fits.

## Verification Commands

```sh
make acpi-unit-test
make all-debug all
make virtio-gpu-wgpu
make pci-unit-test
make virtio-gpu-unit-test
make virtio-gpu-test
make virtio-gpu-test-release
make api-tests
make eslint
make rustfmt
```

The device tests require the generated Alpine artifacts described in `tools/docker/virtio-gpu-alpine/Readme.md`. The release target exercises `build/libv86.mjs`; the non-release target imports source modules directly. The `virtio-gpu-wgpu` target additionally requires `wasm-bindgen` and the `wasm32-unknown-unknown` Rust target.

## Browser WebGPU Backends

Both browser renderers implement the same `VirtioGpuBackend` contract and use the
same standard VirtIO GPU 2D device:

- `webgpu-js`: direct JavaScript `navigator.gpu` renderer. It is part of the
  normal browser bundle and needs no renderer-specific Wasm artifact.
- `wgpu`: independent Rust/wasm-bindgen renderer under
  `tools/virtio-gpu-wgpu/`. Build it with `make virtio-gpu-wgpu`.

Select the direct renderer:

```js
virtio_gpu: {
    backend: "webgpu-js",
    width: 1024,
    height: 768,
}
```

Or select the Rust/Wasm renderer:

```js
virtio_gpu: {
    backend: "wgpu",
    width: 1024,
    height: 768,
    wasm_module_url: "/build/virtio-gpu-wgpu/virtio_gpu_wgpu.js",
}
```

The shared browser adapter creates a presentation canvas in the configured
screen container unless `virtio_gpu.canvas` supplies one. Both renderers enforce
the host-memory budget, use already aligned source rows directly and repack only
when WebGPU's 256-byte row alignment requires it, convert all four standard
32-bit scanout formats, force opaque alpha
for X formats, and present only on `RESOURCE_FLUSH`. Fenced commands wait for
submitted GPU work; unfenced commands return after ordered submission.

Reset and fatal renderer failures hide the WebGPU canvas and restore the prior
VGA text/graphics state. Recoverable surface loss is reconfigured in place.
Device loss and uncaptured validation errors become JavaScript errors and
trigger the same VGA fallback.

`examples/virtio_gpu_desktop.html` exposes renderer and Xorg/Wayland selectors.
It defaults to `webgpu-js`; use `?renderer=wgpu` for the Rust/Wasm path. The
desktop requests 1 GiB guest RAM and reports a 2 GiB writable 9p filesystem
capacity. The GPU host-resource budget remains the default 256 MiB.

EDID, blobs, UUIDs, virgl, custom capsets, cursor commands, and 3D commands must
not be advertised before their complete paths exist.

## Desktop Performance Benchmark

`tests/benchmark/virtio-gpu-desktop.html` generates the four entry points
`examples/virtio_gpu_desktop.html?desktop={xorg|wayland}&renderer={webgpu-js|wgpu}`.
Each page waits for `V86_DESKTOP_READY=PASS` and a visible WebGPU scanout,
settles for 150 seconds, launches `xfce4-terminal` with the session D-Bus
address, and prints a fixed 62-character line with a 20 ms guest sleep. After
ten observed uploads and a two-second warmup, it records one 15-second window.
Run the four links in the same foreground tab; hidden iframes can be throttled.

The machine-readable result is exposed as
`window.virtioGpuBenchmark.result`, rendered in the page, and logged after
`V86_VIRTIO_GPU_BENCHMARK=`. It records readiness and duration, scanout,
transfer/upload/flush counts and bytes, full frames, host enqueue timings, rAF,
50 ms timer delay, long tasks, backend/renderer faults, console/window failures,
and WebGPU validation messages.

This baseline is machine-specific: Apple M4, 10 logical CPUs, Darwin 24.6.0
arm64, Chrome 151.0.0.0, 16 GiB reported device memory, Apple `metal-3`
adapter, device pixel ratio 1, localhost, 1 GiB guest RAM, 2 GiB writable
filesystem, default 256 MiB GPU host budget, and a `1024x768` scanout. It used
the pre-optimization built artifacts (`libv86.mjs`
`f309d093ac491b0c79c9b31f971ce664b452408d096d6bcf7e07625fd105b155`;
renderer Wasm
`b9357b22828268cbeb62fc94b8e61c4f69520b19db9aa5f52c2ae7973b6715bd`).

| Desktop | Renderer | Ready (s) | Full uploads | Upload/flush (Hz) | MiB/s | Transfer mean (ms) | Upload enqueue (ms) | Present enqueue (ms) | rAF (Hz) | Timer p95/max (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Xorg | `webgpu-js` | 87.834 | 164 | 10.932 | 32.797 | 0.581 | 0.170 | 0.077 | 59.928 | 2.800/35.000 |
| Xorg | `wgpu` | 89.070 | 159 | 10.599 | 31.797 | 0.678 | 0.265 | 0.107 | 59.862 | 2.400/27.700 |
| Wayland | `webgpu-js` | 62.673 | 15 | 1.000 | 3.000 | 0.733 | 0.193 | 0.093 | 59.930 | 1.700/4.200 |
| Wayland | `wgpu` | 64.554 | 13 | 0.867 | 2.600 | 1.038 | 0.438 | 0.177 | 59.932 | 2.200/11.800 |

Every upload was one full 3 MiB `1024x768x4` frame with one matching flush.
All runs had zero backend fatals, renderer faults, console/window failures,
validation messages, long tasks, and rAF intervals over 50 ms.

Guest work is dominant. Xorg produces a frame every 92-94 ms and Wayland every
1.0-1.15 seconds, while a complete host transfer command averages 0.58-1.04 ms,
renderer upload/present enqueue averages 0.08-0.44 ms, and browser rAF remains
near 60 Hz. Wayland's lower rate is consistent with its software compositor and
software GLES path on the emulated x86 CPU. GPU completion is not measured, so
enqueue timing must not be described as GPU execution timing.

The evidence supports three bounded changes:

- Full-width transfers traverse fragmented guest backing once instead of
  restarting at entry zero per row. One observed 3 MiB scanout went from
  64,326 entry checks to 90 (714.7x fewer), without changing validation,
  the owned guest copy, ordering, or partial-width behavior.
- Both renderers bypass repacking when the incoming row is already aligned.
  Measured 4096-byte rows therefore avoid one 3 MiB host copy per upload; the
  Rust/wasm-bindgen boundary copy remains.
- The direct renderer reuses its eight-word present parameter array instead of
  allocating one per flush.

The hashed baseline does not contain these source edits because this benchmark
task intentionally ran no build. A rebuilt before/after matrix is required
before claiming a frame-rate improvement. Deferred work includes partial guest
damage, an explicit ownership contract before pooling the device upload copy,
off-main-thread execution, GPU completion/fence timing, and a cursor path that
does not damage the full scanout. Guest 3D acceleration remains a later phase.


## Roadmap After the Direct JavaScript Backend

Phases 0-4 of the implementation plan are complete: backend abstraction, PCI
device, standard 2D commands, memory and Rust/Wasm WebGPU renderers, Linux KMS
proof, and reproducible Xorg/Wayland desktop guests. The direct JavaScript
renderer is also complete as an alternate Phase 4 presentation target.

### Phase 5: Standard 2D hardening

Complete these in order:

1. **Automated browser acceptance.** Cover the KMS pattern, VGA-to-WebGPU
   transition, reset, snapshot restore, surface reconfiguration, controlled
   device loss/VGA fallback, Xorg, Wayland, and both WebGPU renderers. Fail on
   validation errors or uncaught exceptions. Manual browser proof is not a
   replacement for this gate.
2. **Cursor queue.** Implement `VIRTIO_GPU_CMD_UPDATE_CURSOR` and
   `VIRTIO_GPU_CMD_MOVE_CURSOR`, cursor resource validation, cursor state in
   snapshots, and a separate WebGPU quad or browser overlay. Cursor movement
   must not upload the full scanout.
3. **EDID, display events, and resize.** Implement `GET_EDID`, advertise
   `VIRTIO_GPU_F_EDID` only then, maintain `events_read`/`events_clear`, raise
   display-change config interrupts, and add a controlled configured-mode
   change with canvas and scanout resize tests.
4. **Snapshot completion.** Keep resource metadata, guest backing, scanout,
   cursor, config, and event state serializable. On restore, recreate renderer
   resources, reread guest backing, upload pixels, restore scanout, and present
   one frame after renderer initialization. The existing 2D resource
   rehydration and asynchronous generation guards are the baseline, not the
   final browser acceptance proof.
5. **Limits and fuzzing.** Retain checked arithmetic and the total host-memory
   budget; add configurable resource count/dimension, command payload,
   backing-entry, and queued-work limits. Fuzz parser properties, partial
   uploads, invalid snapshot state, and reset interleavings.
6. **Instrumentation.** Measure guest reads, repacking/copy time, GPU upload,
   GPU completion, present rate, bytes per frame, command counts, invalid
   commands, queue depth, fence latency, surface recovery, and device loss.

Phase 5 exits only when those tests protect the current 2D desktop path and a
malformed guest cannot crash or indefinitely stall the browser.

### Phase 6: Experimental 3D transport

Start only after Phase 5. First verify that the pinned Linux `virtio_gpu` driver
passes an unknown private capset through to userspace. Then specify a versioned,
bounded custom capset and add truthful WebGPU limits, isolated
context/resource lifetimes, ordered fences, and a bounded `SUBMIT_3D` decoder.
Reuse standard context and 3D resource commands where possible. The first proof
is a guest utility rendering one hardcoded WGSL triangle through the existing
2D scanout; do not start with Mesa.

### Phase 7: Mesa winsys and Gallium skeleton

Add an out-of-tree `webgpuvirt` DRM winsys and Gallium driver selected initially
with `MESA_LOADER_DRIVER_OVERRIDE=webgpuvirt`. Bring up resource mapping,
fences, clear, then non-indexed/indexed draws, textures, uniforms, viewport,
scissor, and required blits. Advertise only capabilities backed by the capset
and host device. Exit with Mesa identifying the driver and rendering a clear
and triangle without leaked host objects.

### Phase 8: Shader translation

Progress from host-fixed WGSL to a restricted generated shader subset, then
spike NIR-to-SPIR-V in Mesa and SPIR-V-to-WebGPU validation through Naga/wgpu.
Resolve clip depth, Y orientation, combined samplers, binding layouts,
alignment, unsupported formats, line/point behavior, and robust access.
Every rejection must preserve the guest and capture the guest shader/NIR,
SPIR-V when used, host validation message, pipeline descriptor, and
reproduction command.

### Phase 9: OpenGL and terminal validation

Validate Gallium tests, surfaceless EGL clear, DRM/GBM triangle, a minimal X11
GL program, `glmark2-es2`, and a focused Piglit subset before compositors or
applications. Grow truthfully from GLES 2-class behavior to desktop OpenGL 2.1
and finally OpenGL 3.3 core. Kitty is the first terminal target; it must render
glyph atlases, textured quads, alpha blending, scrolling, and resize without
llvmpipe fallback. Ghostty is later because it adds unrelated platform and
packaging variables.
