# v86 virtio-gpu -> wgpu -> Browser WebGPU, with a Mesa OpenGL Guest Driver

Status: implementation plan for Codex
Date: 2026-08-10
Primary upstream: `copy/v86`, branch `master`
Baseline inspected: commit `f3d4472a9c934b9ad78a311f5849ba711a296d23`

## 1. Goal

Build a browser-native accelerated graphics path for a Linux guest running in v86:

```text
Linux application (eventually Kitty)
        |
        | OpenGL
        v
Mesa OpenGL state tracker
        |
        v
Custom Gallium driver: webgpuvirt
        |
        | versioned WebGPU-oriented command stream
        v
Linux virtio_gpu DRM driver
        |
        | standard virtio-gpu control/3D commands and virtqueues
        v
v86 virtio-gpu PCI device
        |
        v
Rust/Wasm renderer using wgpu
        |
        v
Browser WebGPU
        |
        v
Host GPU
```

The implementation must be staged. The first usable milestone is not OpenGL. It is a standards-compatible, unaccelerated virtio-gpu 2D/KMS device whose scanout is displayed with wgpu. Once that path is reliable, add the custom 3D protocol and Mesa driver.

## 2. Non-goals for the first milestones

Do not attempt these in the first PRs:

- VirGL compatibility.
- Venus or Vulkan guest support.
- OpenGL translation inside v86.
- A custom Linux kernel driver.
- GPU compute for an LLM.
- WebGPU worker/offscreen-canvas support.
- Multi-monitor support.
- Zero-copy guest RAM to WebGPU.
- Running Kitty or Ghostty before a basic OpenGL triangle works.

Keep the browser-side LLM project separate. It can later share the browser GPU and communicate with the guest through a separate bridge.

## 3. Key design decisions

### 3.1 Implement standard virtio-gpu 2D first

The existing Linux `virtio_gpu` kernel driver already understands the standard 2D protocol. Implementing that protocol gives us:

- A normal DRM/KMS device in Linux.
- `/dev/dri/cardN`.
- A connector and fixed display mode.
- Framebuffer console and userspace modesetting.
- A stable base for later 3D contexts.

Mesa is not required for this first 2D/KMS milestone. A software-rendered Xorg or Wayland session can use KMS/dumb buffers while the device work is validated.

### 3.2 Keep the virtio control plane in v86 JavaScript initially

Implement the PCI device and virtqueues in `src/virtio_gpu.js`, following existing v86 devices such as `src/virtio_console.js`, `src/virtio_net.js`, and `src/virtio_balloon.js`.

Reasons:

- v86's existing `VirtIO` abstraction is JavaScript.
- Guest RAM and descriptor chains are already readily accessible there.
- It is the shortest path to Linux driver compatibility.
- It keeps the first changes reviewable upstream.

### 3.3 Put wgpu in a separate Rust/Wasm module

Do not add wgpu to v86's root Rust crate initially.

The root v86 crate is built as a custom bare `wasm32-unknown-unknown` module with manual exports and custom linker flags. Browser wgpu uses `wasm-bindgen`, `web-sys`, and async JavaScript integration. Mixing those build systems in the first iteration is unnecessary risk.

Create an independent renderer crate, for example:

```text
tools/virtio-gpu-wgpu/
  Cargo.toml
  Cargo.lock
  src/
    lib.rs
    renderer.rs
    resource.rs
    surface.rs
    error.rs
    shaders/
      blit.wgsl
```

Build it separately with `cargo` plus `wasm-bindgen-cli`, and dynamically import its generated ES module.

### 3.4 Define a renderer interface before choosing implementations

The virtio-gpu device must depend on an abstract backend, not directly on wgpu. This lets us support both of the desired browser paths later:

- `WgpuGpuBackend`: Rust/Wasm -> wgpu -> browser WebGPU.
- `JsWebGpuBackend`: JavaScript -> `navigator.gpu` directly.
- `MemoryGpuBackend`: deterministic Node/unit-test backend.

Suggested asynchronous interface:

```ts
interface VirtioGpuBackend {
    initialize(options: BackendInit): Promise<void>;
    createResource2D(desc: Resource2DDesc): Promise<void>;
    destroyResource(resourceId: number): Promise<void>;
    uploadResource2D(upload: Resource2DUpload): Promise<void>;
    setScanout(scanout: ScanoutDesc | null): Promise<void>;
    flush(flush: ResourceFlush): Promise<void>;
    waitIdle(): Promise<void>;
    reset(): Promise<void>;
    dispose(): Promise<void>;
}
```

The device must serialize calls to this interface so guest command order is preserved.

### 3.5 Use a separate WebGPU canvas

The current browser screen adapter immediately acquires a 2D context on the existing canvas. A canvas cannot also become a WebGPU surface after another context is acquired.

Create a second canvas dedicated to virtio-gpu. Keep the VGA canvas visible during BIOS boot. Switch visibility after the first successful virtio-gpu scanout flush. Restore VGA visibility on device reset or renderer failure.

### 3.6 Use a custom virtio-gpu capset for 3D later

For accelerated OpenGL, reuse the existing Linux `virtio_gpu` kernel and DRM uAPI, but introduce an experimental custom capability set and command payload understood by:

- The new Mesa `webgpuvirt` Gallium driver.
- The v86 virtio-gpu device.
- The wgpu renderer.

Use an experimental capset ID of `7` in the private fork because standard IDs `1` through `6` are already assigned. Treat this as private and unstable; do not propose it as an upstream number without coordination.

## 4. Existing v86 code map

Codex should inspect these files before editing:

| File | Why it matters |
|---|---|
| `src/virtio.js` | Modern VirtIO PCI transport, feature negotiation, virtqueues, interrupts. |
| `src/virtio_console.js` | Small reference implementation for queue parsing, replies, state, and reset. |
| `src/virtio_net.js` | Larger reference implementation with multiple queues and device config. |
| `src/virtio_balloon.js` | Another modern VirtIO device and the currently next PCI slot/port range. |
| `src/cpu.js` | Imports, device construction, reset, save/restore state. |
| `src/browser/starter.js` | Public settings, browser adapters, asset initialization. |
| `src/browser/screen.js` | Existing VGA canvas and 2D context ownership. |
| `src/state.js` | Snapshot format and state version. |
| `Makefile` | JavaScript file lists and the current raw Rust/Wasm build. |
| `v86.d.ts` | Public configuration type declarations. |
| `tests/devices/virtio_console.js` | Guest boot/integration-test pattern. |

Also use these protocol sources as authoritative references:

- VirtIO 1.3, section 5.7, GPU Device.
- Linux `include/uapi/linux/virtio_gpu.h`.
- Linux `include/uapi/drm/virtgpu_drm.h`.
- Mesa Gallium `pipe_screen` and `pipe_context` documentation.
- Mesa VirGL and Zink drivers as architectural references, not runtime dependencies.
- v86 issue #51, `add virtio gpu support`.

## 5. Repository strategy

Use separate forks or worktrees:

```text
workspace/
  v86/                 # fork of copy/v86
  mesa/                # fork of Mesa, not needed until phase 6
  guest/               # reproducible Linux image and test utilities
  design/              # protocol documents and captured traces
```

Recommended branches:

```text
v86:
  feature/virtio-gpu-2d
  feature/virtio-gpu-wgpu
  feature/virtio-gpu-3d

mesa:
  feature/webgpuvirt-gallium

guest:
  feature/v86-virtio-gpu-image
```

Every PR should compile and test independently. Do not create one giant cross-repository change.

# Part I: Standard virtio-gpu 2D and wgpu scanout

## 6. Phase 0 - Baseline, ADR, and test harness

### Deliverables

Create:

```text
docs/virtio-gpu-webgpu.md
tests/unit/virtio_gpu_protocol.js
src/browser/virtio_gpu_backend.js
```

`docs/virtio-gpu-webgpu.md` should record:

- The architecture in this plan.
- Supported and deferred VirtIO features.
- Browser thread assumptions.
- Resource limits.
- Snapshot policy.
- The renderer interface.
- The separation between standard 2D and experimental 3D.

`src/browser/virtio_gpu_backend.js` should contain JSDoc typedefs or a base class for the backend interface. It must not depend on WebGPU.

### Baseline checks

Before coding:

1. Build v86 debug and release artifacts.
2. Run existing VirtIO device tests.
3. Boot the existing Buildroot/Alpine guest.
4. Record `lspci -nn`, kernel version, and current VGA behavior.
5. Confirm the current state format version and choose an unused CPU state-array slot.
6. Verify unused PCI function and I/O port ranges rather than assuming them.

### Exit criteria

- Existing v86 tests are green.
- The design document is committed.
- A `MemoryGpuBackend` test double can be instantiated in Node.

## 7. Phase 1 - virtio-gpu PCI device skeleton

### New file

```text
src/virtio_gpu.js
```

### v86 integration files

Modify:

```text
src/virtio.js
src/cpu.js
src/browser/starter.js
v86.d.ts
Makefile
src/log.js or src/const.js if a GPU log category is added
src/state.js only if the snapshot version must change
```

### Device identity

Use the modern VirtIO PCI identity:

```text
PCI vendor:             0x1AF4
PCI device:             0x1050
VirtIO subsystem ID:    16
```

Tentative v86 allocation, subject to collision verification:

```text
PCI function:           0x0D << 3
Device config port:     0xE600
ISR port:               0xE700
Common config port:     0xE800
Notification port:      0xE900
```

Do not scatter these numbers throughout the implementation. Define named constants.

Extend `VirtIO` options so a device can override PCI class/subclass/prog-if. For virtio-gpu use a display-controller class appropriate for a non-VGA display device. Keep current defaults for existing devices.

### Queues

Expose two queues:

```text
queue 0: controlq
queue 1: cursorq
```

Use a conservative supported size such as 256 entries for the control queue and 16 or 64 for the cursor queue. Confirm Linux's behavior with the selected values.

### Feature bits for phase 1

Advertise only:

```text
VIRTIO_F_VERSION_1
```

Do not advertise:

```text
VIRTIO_GPU_F_VIRGL
VIRTIO_GPU_F_EDID
VIRTIO_GPU_F_RESOURCE_UUID
VIRTIO_GPU_F_RESOURCE_BLOB
VIRTIO_GPU_F_CONTEXT_INIT
```

### Device configuration

Implement `virtio_gpu_config` fields:

```text
events_read     = 0 initially
events_clear    = writable clear mask
num_scanouts    = 1
num_capsets     = 0
blob_alignment  = 0 while blob support is disabled
```

### First command

Implement only:

```text
VIRTIO_GPU_CMD_GET_DISPLAY_INFO
```

Return one enabled scanout with a configurable fixed mode, initially:

```text
1024 x 768
```

All other commands must return the correct `VIRTIO_GPU_RESP_ERR_*` response rather than throwing, asserting, or hanging the guest.

### Parser requirements

- Parse all fields as little-endian.
- Treat guest data as untrusted.
- Use `BigInt` or explicit low/high words for 64-bit values.
- Validate readable and writable chain lengths.
- Preserve the incoming fence ID in a fenced response.
- Never call `dbg_assert` for a malformed guest request in production behavior.
- Log command type, resource ID, context ID, and response in debug builds.

### v86 public configuration

Add something similar to:

```ts
virtio_gpu?: false | {
    backend?: "memory" | "wgpu" | "webgpu-js";
    width?: number;
    height?: number;
    canvas?: HTMLCanvasElement;
    renderer_module_url?: string;
    max_host_memory_bytes?: number;
};
```

For the first PR only `false` and `backend: "memory"` need to work.

### State handling

Add device state to an unused CPU state slot. Store only serializable metadata:

- Device config and events.
- Scanout selection.
- Resource descriptors.
- Backing-entry lists.
- Queue/VirtIO state.

Do not try to serialize browser GPU objects.

### Tests

Add:

```text
tests/devices/virtio_gpu.js
tests/unit/virtio_gpu_protocol.js
```

Tests should cover:

- PCI enumeration.
- Feature negotiation.
- `GET_DISPLAY_INFO` response size and fields.
- Unsupported-command response.
- Short/malformed request handling.
- Fence ID echo.
- Reset.
- Save/restore metadata.

### Exit criteria

Inside Linux:

```text
lspci -nn
```

shows a VirtIO GPU with `1af4:1050`, the `virtio_gpu` driver probes without a kernel oops, and the browser console contains no unhandled exception.

The driver may not modeset yet; that belongs to phase 2.

## 8. Phase 2 - Complete standard 2D resource path with a memory backend

### Commands to implement

Implement the minimum standard 2D set:

```text
VIRTIO_GPU_CMD_GET_DISPLAY_INFO
VIRTIO_GPU_CMD_RESOURCE_CREATE_2D
VIRTIO_GPU_CMD_RESOURCE_UNREF
VIRTIO_GPU_CMD_SET_SCANOUT
VIRTIO_GPU_CMD_RESOURCE_FLUSH
VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D
VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING
VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING
```

Defer until hardening:

```text
VIRTIO_GPU_CMD_GET_EDID
VIRTIO_GPU_CMD_RESOURCE_ASSIGN_UUID
blob commands
cursor commands
all 3D/context commands
```

### Resource model

Suggested JavaScript record:

```ts
type Resource2D = {
    id: number;
    format: number;
    width: number;
    height: number;
    bytesPerPixel: 4;
    backing: Array<{ addrLow: number; addrHigh: number; length: number }>;
    scanoutIds: Set<number>;
};
```

Do not maintain a second full CPU pixel buffer in the device unless the selected backend needs it. `MemoryGpuBackend` may keep one for testing.

### Initially supported formats

Support the common 32-bit scanout formats first:

```text
B8G8R8A8_UNORM
B8G8R8X8_UNORM
R8G8B8A8_UNORM
R8G8B8X8_UNORM
```

Reject unsupported formats with `VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER`.

### Guest backing-store reader

Implement a dedicated helper that reads a logical resource byte range across a scatter/gather backing list:

```ts
readBackingRange(resource, offset, length): Uint8Array
```

Requirements:

- Reject nonzero high 32-bit guest addresses until v86 supports them safely here.
- Check every address and length against guest RAM.
- Detect integer overflow.
- Reject overlapping arithmetic that exceeds the configured resource size.
- Support a transfer spanning multiple backing entries.
- Never retain a stale `Uint8Array` across WebAssembly memory growth.

### Transfer semantics

For `TRANSFER_TO_HOST_2D`:

1. Validate resource and rectangle.
2. Validate `offset`.
3. Compute source row pitch from the full resource width and format.
4. Read only the requested rows/columns from guest backing.
5. Call `backend.uploadResource2D(...)`.
6. Complete the VirtIO request after the backend has accepted the upload.

For `RESOURCE_FLUSH`:

1. Validate the resource and rectangle.
2. If the resource is attached to an enabled scanout, call `backend.flush(...)`.
3. Return success after presentation submission. For a fenced request, wait for the backend fence as defined below.

### Command ordering and asynchrony

VirtIO queue notifications are synchronous, but browser GPU initialization and fences are asynchronous. Add a per-queue promise chain:

```js
this.controlWork = this.controlWork.then(() => this.processControlRequest(bufchain));
```

Requirements:

- Preserve guest submission order.
- Do not block the v86 CPU loop synchronously.
- Do not pop unlimited requests into memory.
- On backend rejection, reply with an error and put the device into a recoverable error state.

### Fence behavior

If `VIRTIO_GPU_FLAG_FENCE` is clear, reply after the command has been validated and submitted in order.

If the flag is set, do not publish the used-ring response until the renderer confirms all associated GPU work is complete. The wgpu backend will later implement this with queue-completion notification.

### Memory backend

Implement `MemoryGpuBackend` first. It should:

- Keep resource pixel arrays.
- Apply rectangular uploads.
- Track scanout state.
- Record flushes.
- Produce stable checksums or pixel assertions for tests.

This makes the protocol and guest-memory logic testable without WebGPU or a browser GPU.

### Exit criteria

- Unit tests prove transfers across fragmented backing entries.
- Linux can create a framebuffer resource, set a scanout, transfer pixels, and flush it.
- A guest-generated test pattern appears in the `MemoryGpuBackend` output with the correct dimensions and channel ordering.

## 9. Phase 3 - Rust/Wasm wgpu renderer

### Separate crate

Create:

```text
tools/virtio-gpu-wgpu/Cargo.toml
tools/virtio-gpu-wgpu/src/lib.rs
tools/virtio-gpu-wgpu/src/renderer.rs
tools/virtio-gpu-wgpu/src/resource.rs
tools/virtio-gpu-wgpu/src/surface.rs
tools/virtio-gpu-wgpu/src/error.rs
tools/virtio-gpu-wgpu/src/shaders/blit.wgsl
```

Use an independent lockfile. Pin an exact wgpu version known to work. At the time of this plan, wgpu `29.0.3` is a reasonable reference, but Codex must verify compatibility before committing the pin.

Initial dependency shape:

```toml
[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wgpu = { version = "=29.0.3", default-features = false, features = ["std", "webgpu", "wgsl"] }
wasm-bindgen = "..."
wasm-bindgen-futures = "..."
js-sys = "..."
web-sys = { version = "...", features = ["HtmlCanvasElement", "Window", "Document"] }
bytemuck = { version = "...", features = ["derive"] }
thiserror = "..."
console_error_panic_hook = "..."
```

Do not copy these ellipses literally. Resolve and pin compatible versions.

### Build integration

Add Makefile targets similar to:

```text
build/virtio-gpu-wgpu/virtio_gpu_wgpu.js
build/virtio-gpu-wgpu/virtio_gpu_wgpu_bg.wasm
```

Suggested commands:

```bash
cargo build \
  --manifest-path tools/virtio-gpu-wgpu/Cargo.toml \
  --target wasm32-unknown-unknown \
  --release

wasm-bindgen \
  --target web \
  --out-dir build/virtio-gpu-wgpu \
  target/wasm32-unknown-unknown/release/virtio_gpu_wgpu.wasm
```

The exact target path depends on the independent crate's target directory. Make the Makefile deterministic.

### JavaScript loader

Create:

```text
src/browser/virtio_gpu_wgpu_backend.js
```

Responsibilities:

- Dynamically import the generated module.
- Initialize the Wasm module.
- Create the renderer with the dedicated canvas.
- Convert backend method calls into exported Rust methods.
- Normalize errors into JavaScript `Error` instances.
- Expose a promise-based `VirtioGpuBackend` implementation.

### Rust renderer initialization

The Rust renderer should:

1. Create a `wgpu::Instance` restricted to `Backends::BROWSER_WEBGPU`.
2. Create a surface from the dedicated HTML canvas.
3. Request an adapter compatible with the surface.
4. Request a device using conservative limits.
5. Configure the surface with the browser-preferred format.
6. Build one fullscreen blit pipeline.
7. Report adapter/device/surface information through structured logs.

Do not silently fall back to WebGL in this backend. A separate backend can be added later if desired.

### Resource storage

Suggested Rust structures:

```rust
struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    resources: HashMap<u32, Resource2D>,
    scanout: Option<Scanout>,
    blit_pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
}

struct Resource2D {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    format: GuestPixelFormat,
    width: u32,
    height: u32,
}
```

### Uploads

Implement rectangular texture uploads. Pay attention to WebGPU row-layout requirements:

- Compute the guest source stride separately from the upload width.
- Repack rows into an aligned staging allocation when required.
- Preserve BGRA/RGBA ordering.
- Force alpha to `1.0` for XRGB/XBGR formats if needed.
- Reuse staging buffers or scratch vectors to avoid repeated large allocations.

### Presentation

Use a fullscreen triangle or quad that samples the current scanout texture and renders into the acquired surface texture.

Do not assume the scanout texture can be copied directly into the surface. A render pass is more portable and also provides a place for later scaling and format conversion.

Initial behavior:

- Nearest-neighbor sampling.
- Opaque output.
- Letterbox if CSS/display dimensions do not match the guest mode.
- Present on `RESOURCE_FLUSH`, not on every transfer.

### Canvas lifecycle

Add a browser adapter that:

- Creates or accepts a dedicated canvas.
- Sizes its backing store to the guest mode.
- Applies the same CSS scaling policy as v86's VGA canvas.
- Hides it until the first valid scanout flush.
- Hides the VGA canvas once virtio-gpu is active.
- Restores VGA on reset or fatal renderer failure.

### Fences

Expose a renderer method that resolves after submitted GPU work completes. Use it only for requests carrying the VirtIO fence flag; do not wait after every flush.

### Device loss and surface errors

Handle:

- Surface outdated/lost errors by reconfiguring.
- Device lost errors by rejecting pending work and requesting a virtio device reset.
- Canvas resize without losing resource metadata.
- Browser WebGPU unavailability with a clear user-facing error.

Never `unwrap` data or state derived from guest commands.

### Exit criteria

- A Linux KMS test pattern is visible through the dedicated WebGPU canvas.
- The VGA BIOS screen is visible before Linux activates virtio-gpu.
- Reset returns to a usable state.
- No wgpu validation errors occur for the standard test sequence.
- The Memory and wgpu backends produce visually equivalent output.

## 10. Phase 4 - Reproducible Linux guest and 2D desktop

Do not use an old Tiny Core image as the primary bring-up environment. Use a reproducible Buildroot or Alpine i686 image with a recent kernel and tools.

### Kernel configuration

Enable at minimum:

```text
CONFIG_VIRTIO=y
CONFIG_VIRTIO_PCI=y
CONFIG_DRM=y
CONFIG_DRM_KMS_HELPER=y
CONFIG_DRM_VIRTIO_GPU=y or m
CONFIG_DRM_FBDEV_EMULATION=y
CONFIG_FRAMEBUFFER_CONSOLE=y
```

Keep serial console enabled for test automation.

### Guest tools

Include:

```text
lspci
modetest
kmsprint or equivalent
fb-test/test pattern utility
dmesg
udevadm
```

Add a tiny deterministic KMS test program to the `guest` repository if distribution tools are unreliable.

### 2D GUI bring-up

Choose one of these before Mesa acceleration exists:

- Xorg modesetting driver with acceleration disabled.
- Weston using its Pixman renderer.
- A small direct DRM/KMS compositor.

The goal is to validate scanout and input, not performance.

### Automated checks

From serial console, verify:

```text
lspci -nn
ls -l /dev/dri
dmesg | grep -i virtio
modetest -M virtio_gpu -c -p
```

Then create a mode, draw a known pattern, and compare a browser-side checksum or screenshot.

### Exit criteria

- `/dev/dri/card0` or another deterministic card path exists.
- One connected connector exposes the configured mode.
- `modetest` can set the mode.
- A software-rendered desktop can be displayed.
- Existing VGA, serial, network, disk, and input behavior remains functional.

## 11. Phase 5 - 2D hardening

Add these incrementally:

### Cursor queue

Implement:

```text
VIRTIO_GPU_CMD_UPDATE_CURSOR
VIRTIO_GPU_CMD_MOVE_CURSOR
```

Render the cursor as a separate WebGPU quad or browser overlay. Do not force a full guest framebuffer upload for cursor movement.

### EDID and display events

- Advertise `VIRTIO_GPU_F_EDID` only after `GET_EDID` is implemented.
- Add a valid EDID for the configured mode.
- Implement `events_read`, `events_clear`, and display-change config interrupts.
- Add controlled guest resize support.

### Snapshots

GPU objects are not serializable. Snapshot state should contain:

- Resource metadata.
- Guest backing entries.
- Scanout and cursor metadata.
- Device config and events.

On restore:

1. Recreate renderer resources.
2. Re-read pixels from guest backing.
3. Upload current contents.
4. Restore scanout.
5. Present one frame.

If restore occurs before the renderer is initialized, queue rehydration behind the initialization promise.

### Security and resource limits

Make limits configurable and conservative:

```text
max resource dimension
max resource count
max total estimated texture bytes
max backing entries per resource
max command payload size
max queued asynchronous requests
max scanouts = 1 initially
```

Use checked multiplication and addition everywhere. A malformed guest must receive an error, not crash the browser tab.

### Performance instrumentation

Measure separately:

- Guest backing read time.
- JS-to-Wasm copy time.
- Pixel-format conversion time.
- wgpu upload time.
- GPU completion time.
- Present rate.
- Bytes uploaded per frame.

Initial target: a responsive 1024x768 desktop at 60 Hz when only dirty regions change. Do not promise this target until measured.

# Part II: Experimental 3D protocol and Mesa OpenGL

## 12. Phase 6 - Custom WebGPU-oriented virtio-gpu capset

This phase begins only after standard 2D is stable.

### Capability advertisement

In the private fork:

- Advertise `VIRTIO_GPU_F_VIRGL` because the Linux uAPI uses that feature bit for 3D command support.
- Advertise `VIRTIO_GPU_F_CONTEXT_INIT`.
- Set `num_capsets = 1`.
- Return experimental capset ID `7`, version `1`.
- Continue to support all standard 2D commands.

Confirm in a technical spike that the current Linux `virtio_gpu` kernel passes an unknown userspace capset through generically. If it rejects the custom context, make the smallest possible kernel patch and document why. Do not assume a kernel patch is definitely unnecessary.

### Standard transport commands to reuse

Use standard virtio-gpu operations for lifecycle and transport:

```text
GET_CAPSET_INFO
GET_CAPSET
CTX_CREATE
CTX_DESTROY
CTX_ATTACH_RESOURCE
CTX_DETACH_RESOURCE
RESOURCE_CREATE_3D
TRANSFER_TO_HOST_3D
TRANSFER_FROM_HOST_3D, later
SUBMIT_3D
```

Start without blob resources. Add them only if mapping performance requires them.

### Capset data

The capset should be a fixed, versioned, little-endian structure containing at least:

```text
magic
protocol_major
protocol_minor
max_command_bytes
max_buffer_size
max_texture_dimension_2d
max_bind_groups
max_color_attachments
supported_texture_format bitset
supported_feature bitset
supported_limit values
shader_input flags
```

Populate limits from the actual wgpu adapter/device after initialization. The guest driver must not advertise more than the browser device supports.

### Wire protocol rules

Create a separate specification document:

```text
docs/webgpuvirt-wire-v1.md
```

Rules:

- Little-endian only.
- Every command has opcode and byte length.
- Unknown opcodes can be skipped or rejected deterministically.
- Every object is referenced by a guest-chosen integer handle.
- No host pointer, JavaScript object, or browser object crosses the boundary.
- Every object belongs to one virtio-gpu context.
- Every command validates all referenced handles.
- All arrays carry explicit counts and checked byte lengths.
- The stream is replayable for debugging.
- The protocol version is negotiated through the capset.

Suggested command groups:

```text
Device/query:
  GET_LIMITS
  PUSH_DEBUG_GROUP
  POP_DEBUG_GROUP

Resources:
  CREATE_BUFFER
  DESTROY_BUFFER
  CREATE_TEXTURE
  DESTROY_TEXTURE
  CREATE_TEXTURE_VIEW
  DESTROY_TEXTURE_VIEW
  CREATE_SAMPLER
  DESTROY_SAMPLER

Shaders and pipelines:
  CREATE_SHADER_MODULE
  DESTROY_SHADER_MODULE
  CREATE_BIND_GROUP_LAYOUT
  CREATE_PIPELINE_LAYOUT
  CREATE_BIND_GROUP
  CREATE_RENDER_PIPELINE
  DESTROY_OBJECT

Encoding:
  BEGIN_COMMAND_ENCODER
  BEGIN_RENDER_PASS
  SET_PIPELINE
  SET_BIND_GROUP
  SET_VERTEX_BUFFER
  SET_INDEX_BUFFER
  SET_VIEWPORT
  SET_SCISSOR
  DRAW
  DRAW_INDEXED
  END_RENDER_PASS
  COPY_BUFFER_TO_BUFFER
  COPY_BUFFER_TO_TEXTURE
  COPY_TEXTURE_TO_BUFFER
  FINISH_ENCODER
  SUBMIT

Synchronization:
  INSERT_FENCE
  WAIT_FENCE, only if required by the guest winsys
```

Do not add compute commands in version 1.

### First 3D transport milestone

Before Mesa, write a tiny guest test utility that:

1. Opens the virtio render node.
2. Creates a custom capset context.
3. Creates one buffer and one render target.
4. Submits a hardcoded triangle command stream.
5. Presents through the existing 2D scanout path.

Use a fixed WGSL shader compiled into the host renderer for this milestone. It proves context, resource, submit, and presentation paths without introducing shader translation.

### Exit criteria

- `GET_CAPSET` reports actual WebGPU limits.
- Multiple contexts cannot access each other's handles.
- A guest utility renders a triangle through `SUBMIT_3D` and wgpu.
- Fences complete in order.
- Invalid command streams return errors without losing the v86 VM.

## 13. Phase 7 - Mesa `webgpuvirt` Gallium driver skeleton

Fork current Mesa and add a dedicated Gallium driver. Suggested initial tree:

```text
src/gallium/drivers/webgpuvirt/
  meson.build
  webgpu_screen.c
  webgpu_context.c
  webgpu_resource.c
  webgpu_state.c
  webgpu_draw.c
  webgpu_shader.c
  webgpu_fence.c
  webgpu_format.c
  webgpu_protocol.h
  webgpu_protocol.c

src/gallium/winsys/webgpuvirt/drm/
  meson.build
  webgpu_drm_winsys.c
  webgpu_drm_resource.c
  webgpu_drm_fence.c
```

Exact placement must follow the current Mesa source tree and Meson conventions discovered at implementation time.

### Loader strategy

Initially select the driver explicitly:

```bash
MESA_LOADER_DRIVER_OVERRIDE=webgpuvirt
```

This avoids changing generic loader policy during bring-up. Later, detect the custom capset and select the driver automatically if upstream architecture permits it.

### Winsys responsibilities

The DRM winsys should:

- Open the `virtio_gpu` render node.
- Query `VIRTGPU_PARAM_3D_FEATURES` and supported capsets.
- Request capset ID `7`.
- Initialize a context with `DRM_VIRTGPU_CONTEXT_INIT`.
- Create virtio resources and retain BO/resource handles.
- Upload guest data with transfer ioctls.
- Submit custom wire streams with `DRM_VIRTGPU_EXECBUFFER`.
- Convert virtio fences/sync objects into Gallium fences.
- Recover cleanly from context loss.

Reuse patterns from the VirGL DRM winsys where useful, but do not depend on the VirGL command protocol.

### `pipe_screen` milestone

Implement enough `pipe_screen` to:

- Report renderer/vendor strings.
- Query capset limits.
- Create contexts.
- Create and destroy buffers/textures.
- Map and unmap staging resources.
- Check a very small supported format set.
- Implement fences.

Advertise the smallest truthful capability set. Over-advertising Gallium capabilities will cause Mesa state trackers to generate unsupported behavior.

### `pipe_context` milestone

Implement in this order:

1. Clear a render target.
2. Create/bind vertex buffers.
3. Create/bind a minimal vertex shader and fragment shader.
4. Create blend, rasterizer, and depth/stencil state objects.
5. Set framebuffer state.
6. Emit non-indexed triangle draws.
7. Add indexed draws.
8. Add sampled 2D textures and samplers.
9. Add uniform buffers.
10. Add scissor and viewport.
11. Add framebuffer blits required by the state tracker.

Translate Gallium state into immutable WebGPU pipeline descriptors. Cache pipelines by a stable hash of:

- Shader modules.
- Vertex layouts.
- Color/depth formats.
- Blend state.
- Rasterization state.
- Primitive topology.
- Multisample state.

### Initial API target

Progress in stages:

```text
Stage A: custom Gallium test / clear / triangle
Stage B: OpenGL ES 2.0-class functionality
Stage C: desktop OpenGL 2.1
Stage D: desktop OpenGL 3.3 core, target for Kitty
```

Do not advertise OpenGL 3.3 until the required Mesa/Gallium caps and shader behavior actually pass tests.

### Exit criteria

- Mesa builds with `-Dgallium-drivers=webgpuvirt` or the current equivalent.
- `MESA_LOADER_DRIVER_OVERRIDE=webgpuvirt` selects the driver.
- `glxinfo -B` or an EGL equivalent reports `webgpuvirt`.
- A clear and triangle render correctly.
- Resource destruction and context teardown leave no host wgpu objects leaked.

## 14. Phase 8 - Shader translation

This is likely the highest-risk technical area.

### Recommended staged approach

#### Stage 0 - Host-fixed WGSL

Use built-in WGSL shaders for the transport triangle. This is not an OpenGL solution; it is only a transport test.

#### Stage 1 - Restricted generated shaders

For the first Mesa draw path, support a tiny known NIR subset and generate a fixed protocol representation. Keep this deliberately narrow.

#### Stage 2 - NIR to SPIR-V in Mesa, SPIR-V to WebGPU through Naga

Investigate reusing Mesa's existing NIR-to-SPIR-V infrastructure used by Zink or related code. Send SPIR-V bytes in `CREATE_SHADER_MODULE`.

Build the host wgpu module with its `spirv` input feature. Let wgpu/Naga parse SPIR-V and produce a browser-compatible WebGPU shader representation before creating a shader module.

This is a proposed route, not an assumed success. Create a standalone spike before coupling the whole driver to it.

### Required lowering and compatibility work

Expect to handle at least:

- OpenGL clip-space depth versus WebGPU depth.
- Framebuffer Y orientation.
- Combined image samplers versus separate texture/sampler bindings.
- Vertex attribute format restrictions.
- Uniform/storage-buffer alignment.
- WebGPU binding layout rules.
- Unsupported texture formats.
- Point and line rendering differences.
- Front-face and viewport orientation.
- Robust buffer access expectations.
- Dynamic indexing restrictions.
- Shader precision and integer conversion differences.

Capture every shader rejection with:

- Guest shader/NIR dump.
- SPIR-V dump, if used.
- Naga/wgpu validation message.
- Pipeline descriptor.
- Reproduction command.

### Exit criteria

- A generated vertex/fragment shader pair renders a triangle.
- Textured quads work.
- Alpha blending works.
- Shader compilation failures are returned to Mesa without hanging the guest.

## 15. Phase 9 - OpenGL validation and terminal targets

Test in this order:

```text
1. Gallium unit tests
2. EGL surfaceless clear
3. EGL/GBM or direct DRM triangle
4. glxgears or a minimal X11 GL program
5. glmark2-es2
6. Piglit subset
7. Xorg or Wayland compositor path
8. Kitty
9. Ghostty, later
```

Kitty is the first terminal target because it is a direct OpenGL-oriented workload and avoids some of Ghostty's additional modern GTK/platform requirements.

Success criteria for Kitty:

- It creates a GL context.
- Glyph atlas upload works.
- Textured-quad rendering works.
- Alpha blending and scrolling are correct.
- Resize does not corrupt the framebuffer.
- Input remains responsive during continuous output.
- No fallback to llvmpipe occurs.

Do not use terminal startup as the first proof of the driver. A terminal can fail for packaging, fonts, window-system, or architecture reasons unrelated to the GPU.

# Part III: Testing, security, performance, and delivery

## 16. Test matrix

### Unit tests without a guest

- Command parser.
- Response encoder.
- Rectangle bounds.
- Integer overflow.
- Backing scatter/gather reads.
- Pixel format conversion.
- Resource lifetime.
- Scanout attach/detach.
- Fence ordering.
- Malformed-chain behavior.
- Snapshot metadata round-trip.

Use `MemoryGpuBackend` so these run in normal Node CI.

### v86 guest integration tests

Boot a small kernel/initramfs and automate over serial:

- PCI probe.
- Driver bind.
- DRM device creation.
- Connector and mode enumeration.
- KMS pattern.
- Reset/reboot.
- Snapshot/restore.

### Browser tests

Use a real browser with WebGPU where CI supports it:

- Renderer initialization.
- Resource upload.
- Surface present.
- Canvas switch from VGA to virtio-gpu.
- Device-lost simulation.
- Resize/reconfigure.

Keep these separate from mandatory unit CI until the WebGPU runner is reliable.

### Mesa tests

- Meson build.
- Driver-load smoke test.
- Gallium resource tests.
- Shader spike tests.
- Selected Piglit/deqp cases.
- Rendered-image hashes for deterministic scenes.

## 17. Security checklist

The guest is untrusted input. Require all of the following before enabling the device by default:

- Checked arithmetic for every size and offset.
- Bounds checks for every guest physical-memory range.
- Resource count and total-memory quotas.
- Command and shader size limits.
- Handle ownership scoped by context.
- No panics/`unwrap` on guest data.
- WebGPU error scopes around resource, shader, and pipeline creation.
- Clean handling of device loss.
- No unbounded promise or command queues.
- No direct browser capability exposure to guest shaders beyond WebGPU validation.
- Fuzz tests for the control parser and custom 3D decoder.
- Deterministic cleanup on context/device reset.

## 18. Performance strategy

Start correct, then optimize based on measurements.

Known copies in the first wgpu design:

```text
guest RAM
  -> JavaScript temporary upload buffer
  -> wasm-bindgen copy into renderer Wasm
  -> wgpu/WebGPU upload
  -> GPU texture
```

This is acceptable for the first implementation, but instrument it.

Optimization order:

1. Upload dirty rectangles only.
2. Reuse temporary and staging buffers.
3. Batch transfers before flush.
4. Avoid channel conversion when guest and WebGPU formats match.
5. Cache WebGPU pipelines, bind groups, and texture views.
6. Move renderer to OffscreenCanvas/worker if main-thread contention is measured.
7. Implement the direct JavaScript WebGPU backend and compare copy costs.
8. Investigate shared memory or mapped blob resources only after profiling proves the need.

Do not optimize by weakening validation.

## 19. Observability

Add structured debug counters visible from v86:

```text
control commands by opcode
invalid commands
resources created/destroyed
estimated host GPU bytes
bytes transferred to host
flush count
full-frame versus partial uploads
pending command depth
fenced command latency
wgpu validation errors
surface reconfigurations
device-loss count
pipeline cache hit rate, after 3D
shader compile count/failures, after 3D
```

Provide an optional debug panel or console dump, but keep it disabled by default.

## 20. Pull request sequence

### PR 0 - ADR and backend interface

- Design doc.
- `VirtioGpuBackend` interface.
- `MemoryGpuBackend` skeleton.
- No emulated PCI device yet.

### PR 1 - PCI device and `GET_DISPLAY_INFO`

- `src/virtio_gpu.js`.
- Device config and queues.
- CPU/starter/types/Makefile integration.
- Parser and response tests.
- Linux probe test.

### PR 2 - Standard 2D resources

- Create/unref.
- Attach/detach backing.
- Transfer/scanout/flush.
- Memory backend image tests.

### PR 3 - wgpu renderer

- Separate Rust/Wasm crate.
- Build target and loader.
- WebGPU canvas.
- KMS test-pattern browser demo.

### PR 4 - 2D production readiness

- Cursor.
- EDID and resize.
- Snapshots.
- Device loss.
- Limits and fuzzing.
- Guest image and integration tests.

### PR 5 - Custom capset and hardcoded 3D triangle

- Capset v1.
- Context/resource/submit support.
- Guest test utility.
- Host fixed WGSL triangle.

### PR 6 - Mesa winsys and Gallium skeleton

- Custom driver selected by override.
- Resource and fence path.
- Clear operation.

### PR 7 - Draw path and restricted shaders

- Vertex/index buffers.
- Pipeline state.
- Triangle and texture.

### PR 8 - NIR/SPIR-V shader path

- Shader compiler spike integrated.
- Robust errors and dumps.

### PR 9 - OpenGL 3.3 target and Kitty

- Required caps/features.
- Performance tuning.
- Kitty integration image and tests.

The direct JavaScript WebGPU backend was implemented before Phase 5 using the same `VirtioGpuBackend` interface. Keep both browser renderers behind the shared adapter and run the Phase 5 browser matrix against both.

## 21. Codex kickoff prompt - first assignment

Copy the following prompt into Codex after opening a fork of `copy/v86`:

```text
Work in my fork of copy/v86 on a new branch named feature/virtio-gpu-2d.
The upstream baseline I inspected was master at commit
f3d4472a9c934b9ad78a311f5849ba711a296d23. Rebase or report drift if
master has changed materially.

Read before editing:
- GitHub issue copy/v86#51
- src/virtio.js
- src/virtio_console.js
- src/virtio_net.js
- src/virtio_balloon.js
- src/cpu.js
- src/browser/starter.js
- src/browser/screen.js
- src/state.js
- Makefile
- v86.d.ts
- tests/devices/virtio_console.js
- Linux include/uapi/linux/virtio_gpu.h
- Linux include/uapi/drm/virtgpu_drm.h
- docs/virtio-gpu-webgpu.md from this project plan

Implement PR 0 and PR 1 only. Do not add wgpu, WebGPU rendering, Mesa,
VirGL, or any 3D command support yet.

Required work:
1. Add an abstract promise-based VirtioGpuBackend interface and a deterministic
   MemoryGpuBackend test implementation.
2. Add src/virtio_gpu.js using v86's existing VirtIO abstraction.
3. Expose modern VirtIO GPU PCI identity 1af4:1050 and subsystem ID 16.
4. Add two queues, controlq and cursorq.
5. Implement virtio_gpu_config with one scanout and zero capsets.
6. Advertise only VIRTIO_F_VERSION_1.
7. Implement VIRTIO_GPU_CMD_GET_DISPLAY_INFO for one configurable 1024x768
   scanout.
8. Return spec error responses for all unsupported or malformed commands.
9. Echo fence metadata correctly in responses.
10. Integrate the device into CPU initialization, reset, state save/restore,
    starter settings, v86.d.ts, and Makefile.
11. If necessary, generalize src/virtio.js so a device can provide PCI class,
    subclass, and programming-interface values without changing existing
    devices' behavior.
12. Add unit tests for parsing, malformed buffers, display info, unsupported
    commands, reset, and state.
13. Add a guest boot test that verifies PCI enumeration and Linux virtio_gpu
    driver probing over serial.

Constraints:
- Treat all guest input as untrusted.
- Do not use assertions or exceptions for malformed guest requests.
- Use checked arithmetic and explicit little-endian parsing.
- Do not assume a PCI slot or I/O port range is free; verify collisions first.
- Do not serialize functions, promises, or backend GPU objects in v86 state.
- Keep all existing tests passing.
- Keep the patch reviewable; do not implement 2D resource transfers in this PR.

Before coding, post a concise implementation outline naming every file you
intend to change. After coding, run the relevant build and test commands and
report exact results, remaining limitations, and follow-up tasks for PR 2.
```

## 22. Codex second assignment - standard 2D

After PR 1 is merged, give Codex this narrower task:

```text
Implement PR 2 from v86-virtio-gpu-webgpu-codex-plan.md.
Add the standard virtio-gpu 2D resource commands, fragmented backing-store
reads, MemoryGpuBackend uploads, scanout, flush, ordered async processing, and
fence-aware replies. Do not add wgpu or Mesa yet. Add exhaustive unit tests and
a guest KMS pattern integration test.
```

## 23. Definition of done

The project reaches its intended first major goal when all of these are true:

- Linux sees a standard virtio-gpu DRM/KMS device in v86.
- The guest desktop is presented by a Rust/Wasm wgpu renderer through browser WebGPU.
- Standard 2D behavior, reset, and snapshots are reliable.
- A custom versioned capset carries WebGPU-oriented 3D commands.
- Mesa's `webgpuvirt` Gallium driver exposes truthful OpenGL capabilities.
- A generated shader path works through the browser WebGPU implementation.
- Kitty runs using `webgpuvirt`, not llvmpipe.
- The renderer backend can later be replaced by direct JavaScript WebGPU without changing the guest protocol.

## 24. Highest-risk items

Track these as explicit research spikes rather than burying them inside feature PRs:

1. Shader translation from Mesa NIR into a WebGPU-compatible form.
2. Linux kernel behavior for an unknown custom virtio-gpu capset.
3. Correct asynchronous fence completion without stalling v86.
4. wgpu's separate wasm-bindgen module integration with v86 packaging and workers.
5. Guest-to-host copy overhead for large scanouts and texture uploads.
6. OpenGL semantics that do not map directly to WebGPU.
7. 32-bit guest packaging and current Kitty dependencies.
8. Browser GPU contention when the future local LLM runs in parallel.

Resolve each with a minimal standalone test before broad implementation.
