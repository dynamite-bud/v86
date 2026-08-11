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

### EDID and controlled display changes

The device advertises `VIRTIO_GPU_F_EDID` and returns one checksummed EDID 1.4
base block for scanout 0. The preferred detailed timing tracks the configured
mode; configured dimensions are limited to the EDID detailed-timing field's
12-bit range. Invalid scanout IDs, short requests, and response buffers smaller
than the standard 1,056-byte `GET_EDID` response are rejected.

`V86.virtio_gpu_set_size(width, height)` changes the preferred mode. A real
change updates the device and backend configuration, sets
`VIRTIO_GPU_EVENT_DISPLAY`, and raises a configuration interrupt after
`DRIVER_OK`; requesting the active size is a no-op. The guest acknowledges
events through `events_clear` and must perform the new modeset. Event and mode
state remain part of snapshots. Protocol tests cover EDID layout and checksum,
feature advertisement, bounds, display events, interrupt generation, and
snapshot preservation. Browser resize acceptance for both renderers remains a
Phase 5 exit gate.

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
make virtio-gpu-browser-test
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
capacity. The GPU host-resource budget remains 256 MiB unless configured
otherwise.

Blobs, UUIDs, virgl, custom capsets, and 3D commands must not be advertised
before their complete paths exist.

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

The rebuilt post-change artifacts were
`libv86.mjs`
`8b5a67bccf07f0b3b1ea73e12f4bebcab72d999f6bb8d960878f5fdc74e529e7`
and renderer Wasm
`ca32f4cf1262b538d1899fadcd254eabcf5030d4e407877c2938c7592569b651`.
The same machine, guest, 150-second settle, 2-second warmup, and 15-second
sampling window produced:

| Desktop | Renderer | Ready (s) | Full uploads | Upload/flush (Hz) | MiB/s | Transfer mean (ms) | Upload enqueue (ms) | Present enqueue (ms) | rAF (Hz) | Timer p95/max (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Xorg | `webgpu-js` | 89.324 | 160 | 10.666 | 31.999 | 0.456 | 0.112 | 0.064 | 59.865 | 2.600/43.300 |
| Xorg | `wgpu` | 91.968 | 155 | 10.333 | 30.998 | 0.535 | 0.194 | 0.114 | 59.729 | 2.700/21.200 |
| Wayland | `webgpu-js` | 67.563 | 15 | 1.000 | 2.999 | 0.560 | 0.173 | 0.060 | 59.919 | 1.800/4.600 |
| Wayland | `wgpu` | 67.057 | 15 | 1.000 | 3.000 | 0.827 | 0.333 | 0.167 | 59.862 | 2.200/5.000 |

Mean end-to-end transfer time fell 20.4-23.6% in every scenario. Renderer
upload enqueue time fell 10.2-34.2%; present enqueue time fell in three
scenarios and rose by 0.007 ms for Xorg `wgpu`. Xorg frame rate varied down
2.4-2.5%, Wayland `webgpu-js` was unchanged, and Wayland `wgpu` varied up
15.3%. The workload is guest-limited and these are single samples, so the
data supports lower host transfer/copy cost but not a frame-rate claim.

Deferred work includes partial guest damage, an explicit ownership contract
before pooling the device upload copy, off-main-thread execution, GPU
completion/fence timing, and a cursor path that does not damage the full
scanout. Guest 3D acceleration remains a later phase.

The rebuilt post-change four-scenario browser acceptance matrix also passed
with zero backend errors while exercising reset, snapshot restore, controlled
resize, cursor overlay, injected device loss/VGA fallback, snapshot recovery,
and the configured 2 GiB writable capacity.

## Roadmap After the Direct JavaScript Backend

Phases 0-4 of the implementation plan are complete: backend abstraction, PCI
device, standard 2D commands, memory and Rust/Wasm WebGPU renderers, Linux KMS
proof, and reproducible Xorg/Wayland desktop guests. The direct JavaScript
renderer is also complete as an alternate Phase 4 presentation target.

### Phase 5: Standard 2D hardening

Phase 5 is implemented and guarded as follows:

1. **Automated browser acceptance.** `make virtio-gpu-browser-test` runs Xorg
   and Wayland through both browser renderers. It covers VGA-to-WebGPU
   transition, reset fallback, snapshot restore, controlled KMS resize,
   cursor overlay, injected device loss/VGA fallback and snapshot-based
   recovery, and rejects browser, WebGPU validation, or backend errors.
2. **Cursor queue.** `VIRTIO_GPU_CMD_UPDATE_CURSOR` and
   `VIRTIO_GPU_CMD_MOVE_CURSOR` use the dedicated queue, validate a backed
   64x64 resource and hotspot, preserve cursor snapshot state, and update a
   separate browser overlay without uploading the scanout.
3. **EDID, display events, and resize.** The advertised EDID is checksummed and
   tracks the configured mode. `events_read`/`events_clear`, config interrupts,
   snapshots, `V86.virtio_gpu_set_size`, and browser scanout/canvas resize are
   covered.
4. **Snapshot completion.** Restore bounds and validates serialized metadata,
   recreates resources, rereads checked guest backing, uploads pixels, restores
   scanout/cursor state, and presents after renderer initialization. Generation
   guards discard reset-era asynchronous work.
5. **Limits and fuzzing.** Resource count/dimension, command bytes,
   per-resource and total backing entries, host bytes, and active queue work
   are bounded. Queue-ring addresses are checked before descriptor traversal;
   descriptor buffers are checked before request copies. Deterministic malformed
   GPU queue/request properties, corrupt snapshots, partial uploads, and reset
   interleavings are tested. Validation stays GPU-local: a stricter shared
   VirtIO descriptor rewrite was rejected after the 1 GiB Wayland stress
   workload exposed guest allocator
   corruption that the unchanged shared traversal does not trigger.
6. **Instrumentation.** `V86.virtio_gpu_get_stats()` reports commands,
   rejection/backend errors, guest/copy/upload/present bytes and wait times,
   resource gauges, queue depth, fences, resize, and cursor counters. The
   desktop benchmark adds frame rate, enqueue timing, browser scheduling,
   surface recovery, validation, and device-loss evidence.

Phase 5 exits through the unit, source/release KMS, and four-scenario browser
targets listed above. 3D remains explicitly unadvertised.

### Future 3D status boundary

**Implemented today:** the device advertises `VIRTIO_F_VERSION_1` and
`VIRTIO_GPU_F_EDID`, reports `num_capsets = 0`, and implements the standard 2D
path described above. Both browser renderers use WebGPU only to upload and
present those 2D resources. There is no context, 3D resource, 3D transfer,
capset, Mesa, shader, or `SUBMIT_3D` implementation; those complete commands
return `VIRTIO_GPU_RESP_ERR_UNSPEC`. The device does not advertise
`VIRTIO_GPU_F_VIRGL`, `VIRTIO_GPU_F_CONTEXT_INIT`, resource blobs, or a virgl
capset.

Everything below is a future, experimental architecture, not a statement of
current support. Default configuration must remain the standard 2D device. A
phase may advertise only the bits, limits, formats, and opcodes whose gate has
passed; naming an item in this roadmap does not make it available.

### Negotiation and 2D fallback

3D is an explicit opt-in and initially exists only with the Rust/Wasm `wgpu`
backend. Before the VM starts, that backend must obtain the WebGPU adapter and
device, intersect adapter limits with v86's compiled ceilings and configured
limits, and return an immutable capset. If preflight fails, startup continues
as the existing 2D device with zero capsets and no 3D feature bits. Features
cannot be added or withdrawn after VirtIO negotiation.

After the complete Phase 6 gate, the opt-in device may additionally advertise
`VIRTIO_GPU_F_VIRGL` (the Linux gate for standard context/resource/execbuffer
ioctls) and `VIRTIO_GPU_F_CONTEXT_INIT`, with `num_capsets = 1`. It advertises
only the private capset below, never `VIRTIO_GPU_CAPSET_VIRGL` or
`VIRTIO_GPU_CAPSET_VIRGL2`. Blob, UUID, host-visible-memory, and multiple-ring
features remain off. `CTX_CREATE.context_init` must select that capset and the
single default ring; other capset IDs, upper bits, and ring indices are
rejected.

The provisional experimental capset ID is `7`, the first unassigned ID after
the IDs 1-6 in the pinned Linux 6.18 UAPI. Phase 6 must prove that this kernel
and libdrm preserve it through `GET_CAPS` and `CONTEXT_INIT`. It is not an
upstream allocation: a standards collision requires changing the host and
guest together before release.

A guest that does not negotiate 3D continues to use the unchanged 2D ABI.
Mesa's `webgpuvirt` loader declines the device when capset 7 or a required bit
is absent, allowing llvmpipe/softpipe to render into the same standard 2D KMS
scanout. A lost 3D context is reported as context/device loss, not silently
replayed; the browser restores the existing VGA fallback on renderer failure.

### Exact guest-to-host flow

```text
OpenGL/EGL application
  -> Mesa state tracker
  -> webgpuvirt Gallium driver (state, NIR, command builder)
  -> webgpuvirt DRM winsys (GEM BOs, transfers, execbuffer, syncobj/fence)
  -> Linux virtio_gpu DRM UAPI
  -> standard VirtIO GPU control commands and private SUBMIT_3D payload
  -> src/virtio_gpu.js (standard wire, guest memory, IDs, ordering)
  -> owned Uint8Array across the asynchronous backend boundary
  -> Rust/Wasm decoder + Naga + wgpu (host objects and WebGPU validation)
  -> one WebGPU queue and the existing WebGPU canvas
```

The concrete sequence is:

1. Linux enumerates capset index 0 with `GET_CAPSET_INFO`; Mesa reads version 1
   through `DRM_IOCTL_VIRTGPU_GET_CAPS`, then initializes capset 7 before the
   kernel emits `CTX_CREATE`.
2. A Gallium BO uses `DRM_IOCTL_VIRTGPU_RESOURCE_CREATE`; Linux emits
   `RESOURCE_CREATE_3D` and `RESOURCE_ATTACH_BACKING`. The returned resource ID
   is used unchanged by the winsys and private submit resource table.
3. CPU maps operate on GEM shmem. The winsys uses standard
   `TRANSFER_TO_HOST_3D` and `TRANSFER_FROM_HOST_3D`; JavaScript validates and
   gathers/scatters fragmented guest backing, while Rust performs WebGPU
   uploads or bounded readback.
4. Gallium emits one bounded command stream and the matching GEM BO list to
   `DRM_IOCTL_VIRTGPU_EXECBUFFER`. Linux wraps the bytes in standard
   `SUBMIT_3D`; JavaScript validates the outer command and Rust validates the
   entire private payload before encoding any WebGPU work.
5. Standard fenced responses complete the DRM fence. A renderable 3D resource
   is presented with the existing standard `SET_SCANOUT` and `RESOURCE_FLUSH`;
   no custom present command or second display ABI is introduced.

### Standard command reuse

The VirtIO GPU structures and command numbers remain unmodified:

| Standard command | Future 3D use |
| --- | --- |
| `GET_CAPSET_INFO`, `GET_CAPSET` | Return only the immutable capset described below. |
| `CTX_CREATE`, `CTX_DESTROY` | Create/destroy a nonzero context selected for capset 7. |
| `RESOURCE_CREATE_3D`, `RESOURCE_UNREF` | Create/destroy buffers and textures using capset-listed target, format, bind, dimension, mip, layer, and sample values. |
| `RESOURCE_ATTACH_BACKING`, `RESOURCE_DETACH_BACKING` | Reuse the existing bounded guest scatter/gather validation. |
| `CTX_ATTACH_RESOURCE`, `CTX_DETACH_RESOURCE` | Define which resources a context may reference. |
| `TRANSFER_TO_HOST_3D`, `TRANSFER_FROM_HOST_3D` | Upload/read back a validated box, mip, offset, stride, and layer stride. |
| `SUBMIT_3D` | Carry the private bytes below; the standard header supplies context and optional fence. |
| `SET_SCANOUT`, `RESOURCE_FLUSH` | Present a capset-listed, scanout-capable 2D color resource. |

For capset 7, `RESOURCE_CREATE_3D` uses the stable virgl protocol numeric
namespaces for target, format, and bind fields, but support is implied only by
the returned format/feature tables. Version 1 accepts buffer, 2D texture, and
2D-array targets only. Buffer resources use format 0, byte size in `width`,
unit height/depth/array, one level, and one sample. Unknown bits or combinations
are invalid. Blobs, host mappings, and a second resource-creation ABI are not
part of version 1.

### Capset 7, version 1

`GET_CAPSET_INFO(index = 0)` returns ID 7, maximum version 1, and maximum size
912 bytes. `GET_CAPSET(id = 7, version = 1)` returns exactly 912 zero-initialized
data bytes after the standard response header. Other indices, IDs, or versions
return `VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER`. All fields are packed
little-endian and the capset is frozen for the device lifetime:

```text
struct v86_webgpu_capset_v1 {
    le32 magic;                         // bytes "V86W", value 0x57363856
    le16 submit_abi_major;              // 1
    le16 submit_abi_minor;              // 0
    le32 capset_size;                   // 912
    le32 feature_bits;
    le32 shader_ir_bits;
    le32 format_count;                  // <= 64
    le32 format_stride;                 // 12
    le32 max_contexts;
    le32 max_resources;
    le32 max_resources_per_context;
    le32 max_resource_dimension_2d;
    le32 max_resource_array_layers;
    le32 max_resource_mip_levels;
    le32 max_samples;
    le32 max_submit_bytes;
    le32 max_commands_per_submit;
    le32 max_resource_refs_per_submit;
    le32 max_inflight_submits;
    le32 max_inflight_submits_per_context;
    le32 max_transfer_bytes;
    le32 max_shader_bytes;
    le32 max_shader_bytes_per_context;
    le32 max_live_shaders_per_context;
    le32 max_live_pipelines_per_context;
    le32 max_bind_groups_per_pipeline;
    le32 max_bindings_per_group;
    le32 max_vertex_buffers;
    le32 max_vertex_attributes;
    le32 max_color_attachments;
    le32 min_uniform_buffer_offset_alignment;
    le32 min_storage_buffer_offset_alignment;
    le32 reserved0;                     // must be zero
    le64 max_buffer_size;
    le64 max_total_3d_bytes;
    struct {
        le32 format;
        le32 usage_bits;
        le32 sample_count_bits;
    } formats[64];
};
```

`feature_bits` are, from bit 0: basic render, vertex buffers, indexed draw,
sampled textures, uniform buffers, depth/stencil, blending, instancing,
copy/blit, compute, readback, and storage buffers. `shader_ir_bits` bit 0 is
WGSL and bit 1 is WebGPU-restricted SPIR-V. A zero bit is a hard prohibition,
not an invitation to probe. Basic render means only shader/pipeline objects,
one color attachment, viewport/scissor, clear/load/store, and non-indexed draw.

Format `usage_bits` are, from bit 0: sampled, color attachment, depth/stencil,
copy source, copy destination, scanout, CPU upload, and CPU readback.
`sample_count_bits` bits 0-3 represent 1, 2, 4, and 8 samples. Records
`format_count` through 63 must be all zero; duplicate formats are forbidden.
Every numeric limit is
`min(compiled ceiling, configured limit, WebGPU adapter limit)`. A feature is
set only when every opcode, format, validation path, and test needed for it is
complete; associated limits are zero otherwise. An incompatible layout needs
capset version 2 rather than reinterpretation of version 1.

### Private `SUBMIT_3D` ABI version 1

Only the bytes inside the standard `SUBMIT_3D` envelope are private. The
outer `size` must equal the payload length and be no larger than both the
capset limit and the device's standard command limit.

```text
struct v86_submit_v1 {
    le32 magic;                 // bytes "V86S", value 0x53363856
    le16 major;                 // 1
    le16 minor;                 // 0
    le32 total_size;            // exactly SUBMIT_3D.size
    le32 command_count;
    le32 resource_count;
    le32 flags;                 // zero in version 1
    le32 reserved[2];           // zero
    le32 resource_ids[resource_count];
    // zero padding to the next 8-byte boundary, then command records
};

struct v86_record_v1 {
    le16 opcode;
    le16 dwords;                // includes this 8-byte header; even and >= 2
    le32 flags;                 // zero unless the opcode defines it
    le32 payload[dwords - 2];
};
```

Resource IDs are nonzero, unique, attached to the header context, and addressed
by zero-based table index in records; `0xffffffff` is the only optional-resource
sentinel. Every table entry must be used. Records exactly consume `total_size`,
with no overlap, integer wrap, nonzero padding, or trailing data. A new minor
version may add an opcode gated by a capset bit but never change an existing
record layout.

The Phase 6 basic-render opcode set is deliberately small:

| Opcode | Payload after the record header |
| --- | --- |
| `0x0001 CREATE_SHADER` | object ID, stage, IR kind, byte count, then inline WGSL/SPIR-V bytes and zero padding |
| `0x0002 DESTROY_SHADER` | object ID, zero |
| `0x0003 CREATE_PIPELINE` | object ID, vertex shader ID, fragment shader ID, topology, color format, sample count, flags, zero |
| `0x0004 DESTROY_PIPELINE` | object ID, zero |
| `0x0010 BEGIN_RENDER_PASS` | color resource index, load op, store op, four IEEE-754 clear words, zero |
| `0x0011 SET_PIPELINE` | object ID, zero |
| `0x0012 SET_VIEWPORT` | six finite IEEE-754 words: x, y, width, height, minimum depth, maximum depth |
| `0x0013 SET_SCISSOR` | x, y, width, height |
| `0x0014 DRAW` | vertex count, instance count, first vertex, first instance |
| `0x0015 END_RENDER_PASS` | no payload |

Shader and pipeline IDs are nonzero and unique in separate context-local
namespaces. Version 1 stages are vertex 1 and fragment 2; IR kinds are WGSL 1
and SPIR-V 2, and the matching capset IR bit is mandatory. The bootstrap
pipeline has no resource bindings or vertex inputs, uses triangle-list/sample-1
only, and targets one capset-listed color format. New fixed-layout opcodes,
not extensions of `CREATE_PIPELINE`, add vertex/index buffers, bindings,
textures, and later features.

Object mutation submits contain only create/destroy records and are fenced.
The decoder validates and stages all creations before committing any of them.
Render submits contain one or more balanced, non-nested render passes, start
with no inherited dynamic state, reference existing objects only, and submit
no WebGPU work until the whole stream validates. This makes malformed submits
atomic: no partial object graph, command encoder, or queue submission survives.

### Host ownership and validation boundary

JavaScript owns guest-visible VirtIO state: standard headers, configuration,
context/resource IDs and attachment sets, fragmented guest backing, queue
ordering, fence replies, generation guards, snapshot policy, and the combined
2D/3D resource budget. It checks the standard envelope and copies request or
transfer bytes before any `await`; no guest-memory view crosses the boundary.

Rust/Wasm owns all 3D-only state: the private decoder, context-local shader and
pipeline tables, WebGPU buffers/textures/views/samplers, Naga translation and
validation, command encoders, staging/readback buffers, the WebGPU device and
queue, and renderer error scopes. JavaScript passes only owned bytes and
already-validated standard descriptors. Rust rechecks sizes, IDs, attachment
membership, capabilities, and its own allocation accounting before calling
`wgpu`; WebGPU validation is a final boundary, not the primary parser.

The 2D and 3D paths share one Rust `wgpu::Device` and `wgpu::Queue` so transfers,
draws, scanout flushes, and fences have one order. The direct JavaScript WebGPU
backend remains 2D-only until it independently implements the same Rust-owned
validation contract; selecting it must therefore suppress all 3D negotiation.

### Mesa winsys, Gallium, and shader path

The out-of-tree Mesa work is split so protocol code is not mixed with Gallium
state tracking:

- `webgpuvirt` DRM winsys: render-node probing; `GETPARAM`/`GET_CAPS`;
  capset-7 `CONTEXT_INIT`; GEM BO create/map; 3D transfers; execbuffer BO lists;
  syncobj/fence import/export; and the bounded submit/resource table builder.
- `webgpuvirt` Gallium screen: exposes only the intersection of capset bits,
  format records, adapter limits, and implemented driver paths.
- Gallium context/resource/state/shader modules: lower pipe state to explicit
  immutable objects and submit records, track dirty state, and never guess a
  capability missing from the screen.
- An initial DRI target selected with
  `MESA_LOADER_DRIVER_OVERRIDE=webgpuvirt`; automatic loader selection is
  deferred until isolation and compatibility gates pass.

NIR remains Mesa's canonical shader IR. Phase 6 sends one bounded, hardcoded
WGSL module to prove transport and host validation, not general GLSL support.
Phase 8 compares two explicit routes: preferred Mesa NIR-to-SPIR-V followed by
Rust Naga SPIR-V validation and WGSL emission, versus a guest NIR-to-WGSL
emitter. The gate selects one production route using corpus correctness,
translation time, code size, and debuggability; the other is removed rather
than maintained as an implicit fallback.

Before serialization Mesa legalizes robust buffer/texture access, clip depth,
Y orientation, combined samplers, binding layouts, alignment, and unsupported
line/point modes. Rust then parses and validates the advertised IR with pinned
Naga rules, emits WGSL when needed, and creates the `wgpu` module inside an
error scope. Unsupported capabilities, entry points, binding layouts, or
non-finite values are deterministic validation failures.

### Contexts, resources, fences, reset, and snapshots

- A context ID is live from successful `CTX_CREATE` until ordered
  `CTX_DESTROY`. Destroy stops new submits, waits behind already accepted work,
  drops context-local objects and attachments, then replies. It does not
  implicitly destroy global resources.
- A resource is global from successful create until `RESOURCE_UNREF`.
  Attachment is explicit and submissions may use only resources attached to
  their context. Detach prevents future use; unref removes scanout/context
  references, marks the object retired, and releases its host handle only after
  earlier submissions and presentation references complete. An ID is not
  reusable while retired.
- A standard fenced command receives an internal monotonically increasing
  queue serial. Unfenced success replies after validation and ordered WebGPU
  submission; fenced success additionally waits for completion through that
  serial. A rejected command performs no GPU work and returns its error header
  immediately, echoing the standard fence fields. Per-context order and the
  single WebGPU queue define visibility for transfers, draws, and flushes.
- Reset increments the existing work generation, rejects stale completions,
  retires all 3D contexts/resources/fences in queue order, clears decoder and
  pipeline caches, drops WebGPU handles, and restores VGA fallback. Device loss
  follows the same path and requires the guest to recreate 3D state.
- Version 1 does not promise transparent snapshots of GPU-only content.
  A snapshot request fails deterministically while a 3D context, 3D resource,
  or 3D fence is live; it neither resets the guest nor writes a partial
  snapshot. Existing 2D-only snapshots remain unchanged. Transparent 3D
  snapshot support requires a new snapshot format, readback/replay proof, and
  a later capset version.

### Hard limits and malformed-submit behavior

These are compiled ceilings; configuration and adapter limits may only lower
them, and the capset reports the result:

| Item | Absolute ceiling |
| --- | ---: |
| Standard control request / private submit | 1 MiB / 1 MiB |
| Records / resource references per submit | 4,096 / 256 |
| Contexts / global resources / attachments per context | 32 / 256 / 128 |
| One resource / all 2D+3D host resources | 64 MiB / 256 MiB |
| 2D dimension / array layers / mip levels / samples | 4,096 / 256 / 13 / 4 |
| One transfer / all transient decode and staging bytes | 16 MiB / 32 MiB |
| In-flight submits, global / per context | 32 / 8 |
| One shader / shader bytes per context | 256 KiB / 4 MiB |
| Live shaders / pipelines per context | 64 / 256 |
| Simultaneous pipeline compilations | 4 |
| Bind groups / bindings / vertex buffers / attributes / color targets | 4 / 16 / 8 / 16 / 4 |
| Backing entries, per resource / global | 16,384 / 32,768 |

Resource accounting includes mip levels, layers, samples, alignment, staging,
and cached objects before allocation. Checked addition/multiplication precedes
every copy or `Vec`/WebGPU allocation. Decode is iterative and linear in the
bounded payload; there are no guest pointers, recursion, or unbounded strings.
Shader compilation is rate- and byte-limited before Naga or WebGPU sees input.

Structural errors, unknown versions/opcodes/bits, invalid state-machine order,
duplicate/foreign IDs, missing attachments, unsupported formats/usages, quota
exhaustion, out-of-range boxes, misalignment, non-finite floats, or nonzero
reserved bytes reject the entire command. Missing contexts return
`VIRTIO_GPU_RESP_ERR_INVALID_CONTEXT_ID`, missing resources return
`VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID`, quotas return
`VIRTIO_GPU_RESP_ERR_OUT_OF_MEMORY`, and malformed/unsupported combinations
return `VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER`. Backend/device failure returns
`VIRTIO_GPU_RESP_ERR_UNSPEC` and loses the affected context. No guest input may
panic Rust, assert JavaScript, create an unhandled rejection, partially submit,
or indefinitely retain a virtqueue descriptor. Repeated failures are counted
and rate-limited in logs but do not bypass normal response handling.

### Observability

Extend the existing GPU statistics with negotiated capset/version and backend;
per-opcode counts/bytes/rejection reasons; live and high-water
contexts/resources/attachments/bytes; submit size, records, refs, queue depth,
and in-flight work; transfer/readback bytes; shader parse/translate/compile
time; pipeline cache hits/misses/evictions; WebGPU encode/submit/completion and
fence latency; resets, device loss, and fallback. Tests consume stable numeric
counters rather than console text.

Default logs contain only bounded IDs, sizes, reason codes, and a payload/shader
hash. An explicit debug-capture option may store a size-capped submit, source
IR, translated WGSL, pipeline descriptor, adapter summary, and reproduction
command; it is off by default and never changes validation or limits.

### Phase 6: Transport and one triangle

Implement capset query/pass-through, opt-in negotiation, the standard context
and resource commands above, 3D transfers, basic-render submit opcodes, Rust
validation, fences, and standard scanout presentation. Start with a guest
utility and one WGSL triangle; do not start with Mesa.

The phase is not complete until future targets
`make virtio-gpu-3d-transport-test` and
`make virtio-gpu-3d-triangle-test` exist and pass. The first must prove exact
capset bytes through pinned Linux/libdrm, default-zero 3D advertisement,
standard error responses, limits, reset, and a malformed-submit corpus. The
second must boot the pinned guest in a browser, verify triangle pixels through
the standard scanout, prove fenced completion, force teardown/device loss, and
end with zero live 3D objects and no WebGPU validation or console errors. Only
then may the experimental opt-in expose the Phase 6 bits.

### Phase 7: Mesa winsys and Gallium skeleton

Add the out-of-tree winsys, screen, context, resource, state, and DRI target.
Bring up mapping/fences, clear, non-indexed and indexed draws, vertex buffers,
textures, uniforms, viewport/scissor, and required copies one capset bit at a
time.

The future `make virtio-gpu-3d-mesa-test` gate must boot the pinned guest with
`MESA_LOADER_DRIVER_OVERRIDE=webgpuvirt`, assert the renderer is
`webgpuvirt` and not llvmpipe, compare clear and indexed/non-indexed triangle
pixels, exercise map/upload/readback and fence waits, close the process, and
assert zero leaked contexts, resources, shaders, pipelines, or fences.

### Phase 8: Shader translation

Implement and select the NIR translation route, then add only the shader
features needed by the advertised Gallium level. Keep WGSL and SPIR-V
acceptance independently gated so a translator cannot be selected merely
because Naga parses one sample.

The future `make virtio-gpu-3d-shader-test` gate must run a pinned positive and
negative shader corpus through the chosen end-to-end route, compare rendered
reference pixels, cover robust out-of-bounds access and every coordinate,
sampler, binding, and alignment legalization, and verify deterministic
rejection artifacts. It must also enforce module/compile quotas and leave no
host objects after invalid, reset, or device-loss cases.

### Phase 9: OpenGL and terminal validation

Validate Gallium tests, surfaceless EGL clear, DRM/GBM and X11 triangles,
`glmark2-es2`, and a focused Piglit subset before compositors or applications.
Gate GLES 2, OpenGL 2.1, and OpenGL 3.3 separately; `GL_VERSION` and every
Gallium cap advance only with the corresponding passing set.

The future `make virtio-gpu-3d-gl-test` gate must run those tests in the pinned
guest, assert `webgpuvirt` in each process, and record pixel/performance/leak
results. The future `make virtio-gpu-3d-terminal-test` gate must run Kitty and
automate glyph-atlas rendering, textured alpha blending, scrolling, and resize
with reference screenshots and no llvmpipe fallback. Ghostty remains later
because it adds unrelated platform and packaging variables.

### Phase 10: Hardening and eligibility review

Run long malformed-stream, quota, context-isolation, transfer, reset,
device-loss, 2D-fallback, and lifecycle campaigns. Keep the explicit live-3D
snapshot rejection until transparent restore has its own complete design and
gate.

The future `make virtio-gpu-3d-hardening-test` gate must execute deterministic
fuzz seeds plus randomized decoder/property tests, inject reset and device loss
at every asynchronous boundary, prove bounded memory and queue depth, verify
live-3D snapshot rejection and unchanged 2D snapshot restore, and finish the
Xorg/Wayland 2D acceptance matrix with 3D both disabled and unavailable.
Passing this gate permits an eligibility review; it does not by itself make 3D
the default or authorize any unimplemented feature bit.
