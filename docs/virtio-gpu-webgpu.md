# VirtIO GPU and WebGPU Architecture

## Scope

The first two slices provide a modern VirtIO GPU PCI function and its renderer boundary. They intentionally stop before framebuffer resources or browser presentation:

- PCI identity `1af4:1050`, subsystem ID `16`, class `0380` (display controller, other).
- VirtIO 1 modern transport only (`VIRTIO_F_VERSION_1`).
- One configurable scanout, defaulting to `1024x768`.
- Control and cursor virtqueues.
- `VIRTIO_GPU_CMD_GET_DISPLAY_INFO` plus deterministic protocol errors.
- Promise-based renderer API and a deterministic `MemoryGpuBackend`.

2D resource commands, EDID, blobs, UUIDs, virgl, accelerated WebGPU presentation, and experimental 3D command streams are deferred.

## Data Flow

```text
Linux virtio_gpu driver
  -> modern VirtIO PCI transport (src/virtio.js)
  -> VirtioGpu queue/parser (src/virtio_gpu.js)
  -> VirtioGpuBackend promise boundary
  -> MemoryGpuBackend now; wgpu/WebGPU backends later
```

`VirtioGpu` owns guest-visible PCI/config/queue state. A backend owns host renderer resources only. Protocol parsing never depends on browser APIs. Malformed guest data produces a VirtIO GPU response header rather than an assertion or exception.

Queue notifications and the current renderer-independent commands complete synchronously, preserving queue order and serving guests that busy-wait within an emulator tick. Backend-dependent commands must use a private promise chain per queue and a reset generation guard when they are introduced; guest-memory views must not survive an `await`.

## Backend Contract

`src/browser/virtio_gpu_backend.js` defines these asynchronous operations:

```text
initialize, createResource2D, destroyResource, uploadResource2D,
setScanout, flush, waitIdle, reset, dispose
```

The interface contains no WebGPU dependency. `MemoryGpuBackend` stores deterministic RGBA8 byte arrays, enforces rectangle and memory bounds, and is suitable for Node tests. Future implementations may be:

- Rust/Wasm `wgpu`, dynamically imported as a separate module.
- Direct browser WebGPU in JavaScript.

The device must await backend completion for fenced renderer commands. Unfenced renderer commands may reply after ordered validation and submission. The current display-info and error responses do no renderer work and complete inline.

## Protocol Invariants

- All guest fields are little-endian and untrusted.
- The fixed control header is 24 bytes.
- A request shorter than the header returns `VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER`.
- An unsupported complete request returns `VIRTIO_GPU_RESP_ERR_UNSPEC`.
- A fenced response copies the fence flag, 64-bit fence ID, and context ID.
- `GET_DISPLAY_INFO` returns the required 408-byte structure: scanout 0 enabled at `(0,0)` with the configured mode; scanouts 1-15 are zeroed.
- Writable buffers shorter than the command response receive an invalid-parameter header when capacity permits; writes are otherwise safely truncated by the VirtIO buffer-chain helper.

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

CPU snapshot slot 92 stores serializable device metadata and nested VirtIO queue state. Browser GPU handles are never serialized. Reset and restore clear events and reset the backend. Future asynchronous resource work must be invalidated across reset or restore. The initial slice has no guest-created resources, so snapshots contain no renderer data.

`max_host_memory_bytes` defaults to 256 MiB and bounds `MemoryGpuBackend` allocations. Dimensions and rectangle arithmetic are validated before allocation or copy. Later 2D work must add explicit guest backing-entry and total-resource limits rather than relying only on this host limit.

## Browser Thread Model

The PCI device and queue parser run with the emulator CPU. A browser backend may execute on the same thread or proxy to a worker, but it must preserve the promise contract and per-queue completion ordering. It must not retain guest-memory views across an `await`; copy or re-resolve them because Wasm memory can change.

Standard VirtIO GPU 2D commands remain the compatibility path. Any virgl-like or project-specific 3D-over-WebGPU protocol is experimental, separately negotiated, and must not alter the 2D ABI.

## Test and Guest Contract

`make virtio-gpu-unit-test` covers parsing, malformed buffers, display information, unsupported commands, fence metadata, PCI identity/features, reset/state metadata, class defaults, and the memory backend.

`tests/devices/virtio_gpu.js` boots the generated Alpine i386 filesystem and requires serial probe markers for kernel version, `1af4:1050`, `virtio_gpu` binding, and DRM device discovery. The reproducible image inputs, package/kernel contract, build command, and SHA-256 manifest live under `tools/docker/virtio-gpu-alpine/`.

## Linux Bring-up Workflow

`tools/docker/virtio-gpu-alpine/` contains the reviewed inputs for the canonical i386 guest. Docker is used only to assemble and export the Linux root filesystem; v86 does not depend on Docker at runtime. `build.sh` normalizes the exported tar, converts it to v86's JSON/content-addressed filesystem layout, and writes a checksum contract. Generated files stay ignored under `images/`; source inputs, package locks, probe scripts, and the reviewed `image-contract.json` are committed.

The guest deliberately uses `drm_kms_helper.fbdev_emulation=0`. PR 1 implements enumeration and display information but not framebuffer resource commands, so allowing fbdev emulation would make Linux immediately issue deferred PR 2 commands. The probe verifies PCI identity, the virtio-gpu sysfs binding, and `/dev/dri/card0` without claiming that scanout presentation works.

`lspci -nnk` reports `Kernel driver in use: virtio-pci` because that is the PCI transport driver. The actual GPU driver binding is the `virtioN` link under `/sys/bus/virtio/drivers/virtio_gpu`; the serial contract reports both facts separately.

## Diagnostics and Failure Modes

- Use `log_level: 0` and the kernel `quiet` argument for routine device tests. A debug source build can otherwise emit megabytes of CPU/IRQ tracing and materially slow the guest.
- `tests/devices/virtio_gpu.js` treats `Mounting root: failed` and the initramfs recovery shell as immediate infrastructure failures. Do not wait for the GPU probe timeout when the 9p root never mounted.
- The local probe timeout is 90 seconds multiplied by `TIMEOUT_EXTRA_FACTOR`. Slow CI can scale the timeout without weakening local feedback.
- `V86_GPU_PROBE_STATUS=PASS` means the PCI function enumerated, Linux bound virtio-gpu, and the DRM card appeared. It does not mean that 2D resources, modesetting, or browser presentation are implemented.
- A response to an unsupported complete command is expected to be `VIRTIO_GPU_RESP_ERR_UNSPEC`. A malformed header or insufficient response buffer receives `VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER` when a response header fits.

## Verification Commands

```sh
make acpi-unit-test
make all-debug all
make pci-unit-test
make virtio-gpu-unit-test
make virtio-gpu-test
make virtio-gpu-test-release
make api-tests
make eslint
make rustfmt
```

The device tests require the generated Alpine artifacts described in `tools/docker/virtio-gpu-alpine/Readme.md`. The release target exercises `build/libv86.mjs`; the non-release target imports source modules directly.

## PR 2 Handoff

The next slice should implement standard VirtIO GPU 2D resources without changing the negotiated feature set:

1. Resource create/unref and attach/detach backing.
2. Bounded scatter/gather reads from guest backing storage.
3. `TRANSFER_TO_HOST_2D`, `SET_SCANOUT`, and `RESOURCE_FLUSH`.
4. Ordered asynchronous backend submission with reset/restore generation guards.
5. Tests for fragmented backing entries, rectangle arithmetic, resource limits, queue ordering, and fenced completion.

WebGPU presentation remains a later backend. EDID, blobs, UUIDs, virgl, custom capsets, and 3D commands must not be advertised before their complete command paths exist.
