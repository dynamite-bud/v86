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

Browser acceptance uses the same generated Alpine guest with `virtio_gpu.backend: "wgpu"`. The VGA canvas remains visible during boot, the dedicated WebGPU canvas becomes visible only after the first successful resource flush, and the locked SMPTE samples must match the decoded `MemoryGpuBackend` pixels. Reset, renderer reinitialization, surface reconfiguration, and controlled device destruction must restore or preserve the VGA fallback without console or WebGPU validation errors.

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

## Browser wgpu Backend

Build the optional renderer after the normal browser artifacts:

```sh
make all-debug
make virtio-gpu-wgpu
```

Select it through the existing public configuration:

```js
virtio_gpu: {
    backend: "wgpu",
    width: 1024,
    height: 768,
    wasm_module_url: "/build/virtio-gpu-wgpu/virtio_gpu_wgpu.js",
}
```

`WgpuBackend` creates a presentation canvas in the configured screen container unless `virtio_gpu.canvas` supplies one. Resource uploads are repacked to WebGPU's row alignment, the fullscreen conversion pass handles all four standard 32-bit formats and forces opaque alpha for X formats, and presentation occurs only on `RESOURCE_FLUSH`. Fenced commands additionally wait for submitted GPU work; unfenced commands return after ordered submission.

Reset and fatal renderer failures hide the WebGPU canvas and restore the prior VGA text/graphics state. Recoverable surface loss is reconfigured in place. Device loss and uncaptured validation errors become JavaScript errors and trigger the same VGA fallback.

EDID, blobs, UUIDs, virgl, custom capsets, cursor commands, and 3D commands must not be advertised before their complete paths exist.
