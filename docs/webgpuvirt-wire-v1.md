# webgpuvirt wire ABI version 1

This document is the byte-exact contract implemented by the opt-in v86 Phase 6
VirtIO GPU path. It is not virgl or virgl2. Linux and libdrm carry the standard
VirtIO GPU commands; only the capset payload and bytes inside `SUBMIT_3D` are
private.

Version 1 is exposed only when `virtio_gpu.backend` is `"wgpu"`,
`virtio_gpu.experimental_3d` is true, and Rust/Wasm obtains a WebGPU device with
the limits below. Default, unavailable-WebGPU, and direct-JavaScript
`webgpu-js` configurations expose `num_capsets = 0` and no 3D feature bits.
The negotiated bytes are immutable for the device lifetime.

All integer and IEEE-754 fields are little-endian. Every reserved field and all
padding bytes must be zero. Sizes below include their headers.

## Linux/libdrm transport

The pinned i386 appliance uses Linux 6.18.44 and libdrm 2.4.134. Its unmodified
render-node client successfully issued:

```text
DRM_IOCTL_VIRTGPU_GET_CAPS(cap_set_id=7, cap_set_ver=1, size=912)
DRM_IOCTL_VIRTGPU_CONTEXT_INIT(VIRTGPU_CONTEXT_PARAM_CAPSET_ID=7)
```

Observed guest markers were:

```text
V86_GPU_CAPSET7_GET_CAPS=PASS magic=0x57363856 size=912
V86_GPU_CAPSET7_CONTEXT_INIT=PASS capset=7
```

Linux emitted standard `GET_CAPSET_INFO`, `GET_CAPSET`, and `CTX_CREATE`
commands without interpreting private ID 7 as virgl. No guest patch or alternate
transport is required.

## Standard VirtIO GPU envelope

The enabled device advertises `VIRTIO_GPU_F_VIRGL` and
`VIRTIO_GPU_F_CONTEXT_INIT`, `num_capsets = 1`, and no blob, UUID,
host-visible-memory, or multiple-ring feature.

Version 1 accepts this standard command subset:

- `GET_CAPSET_INFO`, `GET_CAPSET`
- `CTX_CREATE`, `CTX_DESTROY`
- `CTX_ATTACH_RESOURCE`, `CTX_DETACH_RESOURCE`
- `RESOURCE_CREATE_3D`, `RESOURCE_UNREF`
- existing `RESOURCE_ATTACH_BACKING`, `RESOURCE_DETACH_BACKING`
- `TRANSFER_TO_HOST_3D`, `SUBMIT_3D`
- existing `SET_SCANOUT`, `RESOURCE_FLUSH`

The only accepted 3D resource is a single-level, single-layer, sample-1 2D
texture: target 2, format `R8G8B8A8_UNORM` (67), bind 2, nonzero width and
height, depth 1, array size 1, last level 0, and flags/padding zero. It shares
the existing 2D resource and backing-entry budgets. `TRANSFER_TO_HOST_3D`
accepts level 0, depth 1, zero high offset and layer stride, an in-bounds box,
and either stride zero (Linux non-blob tight packing) or a stride of at least
`width * 4`.

## Capset 7 payload

`GET_CAPSET_INFO(index=0)` returns ID 7, maximum version 2, and maximum size 912.
Version 2 is specified separately in
[`webgpuvirt-wire-v2.md`](webgpuvirt-wire-v2.md). `GET_CAPSET(id=7, version=1)`
still returns exactly these frozen 912 payload bytes. Any other index, ID,
unsupported version, nonzero request padding, short writable buffer, or
malformed request returns `VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER`.

| Offset | Type | Version-1 value |
| ---: | --- | --- |
| 0 | `le32` | magic `0x57363856` (`V86W`) |
| 4 | `le16` | submit major 1 |
| 6 | `le16` | submit minor 0 |
| 8 | `le32` | capset size 912 |
| 12 | `le32` | feature bits `0x1` (basic render) |
| 16 | `le32` | shader IR bits `0x1` (WGSL) |
| 20 | `le32` | format count 1 |
| 24 | `le32` | format stride 12 |
| 28 | `le32` | maximum contexts 32 |
| 32 | `le32` | configured global-resource maximum, at most 256 |
| 36 | `le32` | maximum attachments per context 128 |
| 40 | `le32` | adapter/configured 2D dimension, at most 4096 |
| 44 | `le32` | maximum array layers 1 |
| 48 | `le32` | maximum mip levels 1 |
| 52 | `le32` | maximum samples 1 |
| 56 | `le32` | maximum private submit bytes 262144 |
| 60 | `le32` | maximum records per submit 64 |
| 64 | `le32` | maximum resource references per submit 128 |
| 68 | `le32` | maximum global in-flight submits 16 |
| 72 | `le32` | maximum in-flight submits per context 4 |
| 76 | `le32` | maximum transfer bytes, `min(host budget, 1048576)` |
| 80 | `le32` | maximum bytes per shader 189 |
| 84 | `le32` | maximum shader bytes per context 6048 |
| 88 | `le32` | maximum live shaders per context 32 |
| 92 | `le32` | maximum live pipelines per context 64 |
| 96–108 | four `le32` | bind-group, binding, vertex-buffer, and vertex-attribute limits: 0 |
| 112 | `le32` | maximum color attachments 1 |
| 116–124 | three `le32` | uniform alignment, storage alignment, reserved: 0 |
| 128 | `le64` | maximum buffer size 0; buffers are unsupported |
| 136 | `le64` | configured combined 2D/3D host-memory budget |
| 144 | `le32` | format 67 (`R8G8B8A8_UNORM`) |
| 148 | `le32` | usage bits `0x72`: color attachment, copy destination, scanout, CPU upload |
| 152 | `le32` | sample-count bits `0x1`: one sample |
| 156–911 | bytes | zero; unused format records and tail |

A zero feature or limit is a prohibition. Version 1 has no vertex/index buffers,
bind groups, sampled textures, depth/stencil, blending, instancing, copy/blit,
compute, readback, storage buffers, SPIR-V, or general resource formats.

## Private `SUBMIT_3D` payload

The standard `virtio_gpu_cmd_submit` header supplies context ID and optional
fence fields. Its `size` must equal the private payload length and be in
`1..=262144`; its padding and ring index are zero.

```text
struct v86_submit_v1 {
    le32 magic;             // 0x53363856, bytes "V86S"
    le16 major;             // 1
    le16 minor;             // 0
    le32 total_size;        // exact payload size
    le32 command_count;     // 1..=64
    le32 resource_count;    // 0..=128
    le32 flags;             // 0
    le32 reserved[2];       // 0
    le32 resource_ids[resource_count];
    // zero padding to an 8-byte boundary, then records
};

struct v86_record_v1 {
    le16 opcode;
    le16 dwords;            // whole record, even and >= 2
    le32 flags;             // 0
    le32 payload[dwords - 2];
};
```

Resource IDs are nonzero, unique, attached to the outer context, and addressed
by zero-based table index. Every table entry is referenced at least once.
Records consume `total_size` exactly; trailing bytes, overlap,
integer wrap, truncation, duplicate resources, odd record lengths, unknown
flags/opcodes, and nonzero padding are invalid.

## Record layouts

Each row lists payload fields after the common 8-byte record header.

| Opcode | Name | Exact size | Payload |
| ---: | --- | ---: | --- |
| `0x0001` | `CREATE_SHADER` | `24 + align8(byte_count)` | `le32 id`, `le32 stage`, `le32 ir_kind`, `le32 byte_count`, the exact pinned WGSL bytes below, zero padding |
| `0x0002` | `DESTROY_SHADER` | 16 | `le32 id`, `le32 zero` |
| `0x0003` | `CREATE_PIPELINE` | 40 | `le32 id`, vertex shader ID, fragment shader ID, topology 3, color format 67, sample count 1, flags 0, zero |
| `0x0004` | `DESTROY_PIPELINE` | 16 | `le32 id`, `le32 zero` |
| `0x0010` | `BEGIN_RENDER_PASS` | 40 | resource-table index, load op 1, store op 1, four finite `f32` clear components in `[0,1]`, zero |
| `0x0011` | `SET_PIPELINE` | 16 | `le32 id`, `le32 zero` |
| `0x0012` | `SET_VIEWPORT` | 32 | finite `f32 x, y, width, height, min_depth, max_depth` |
| `0x0013` | `SET_SCISSOR` | 24 | `le32 x, y, width, height` |
| `0x0014` | `DRAW` | 24 | `le32 vertices, instances, first_vertex, first_instance` |
| `0x0015` | `END_RENDER_PASS` | 8 | none |

Shader IDs and pipeline IDs are nonzero context-local namespaces. Stage 1 is
vertex; stage 2 is fragment; IR kind 1 is WGSL. Version 1 accepts only these
exact UTF-8 sources:

```wgsl
@vertex fn main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {let p = array<vec2f, 3>(vec2f(0.0, 0.72), vec2f(-0.72, -0.72), vec2f(0.72, -0.72));return vec4f(p[i], 0.0, 1.0);}
```

```wgsl
@fragment fn main() -> @location(0) vec4f {return vec4f(1.0, 0.08, 0.04, 1.0);}
```

Their SHA-256 digests are
`4d6f1c5188ad28c254296373ad1cfc35daa8c348b360d5a3337f144a9ee6d9ac`
and `f2e0943fa3612e30bee0119b1239d2a51b158cfbc07d609805848e43e9ae0ffc`,
respectively. Any other source bytes are invalid. The only topology is triangle
list (3); pipelines have no vertex inputs or resource bindings.

Object submits contain creates only or destroys only and no render records.
At renderer initialization, Naga parses and validates both pinned shaders,
WebGPU creates one immutable host pipeline, and a 1×1 draw probe must complete
without a device fault. Guest creates validate the exact source bytes and assign
context-local handles to those immutable objects; no shader compilation or
validation promise runs while a VirtIO fence is pending. Creates commit
atomically. A pipeline may use matching-stage existing shader handles or handles
staged earlier in the same submit. Destroy rejects missing or still-referenced
objects.

Render submits contain no object mutations. Passes are balanced and non-nested;
each starts without inherited pipeline, viewport, or scissor state. A draw
requires a pipeline, nonzero vertex and instance counts, in-bounds viewport and
scissor, and non-overflowing ranges. At most 256 draws are accepted. The entire
stream validates before a command encoder is submitted.

## Ownership, errors, fences, reset

JavaScript owns standard headers, context/resource IDs, attachment sets,
fragmented guest backing validation and copying, queue order, fence echoing,
generation guards, scanout state, and the combined host-memory budget. No guest
memory view crosses an `await`. Rust/Wasm owns context-local immutable-object
handles, the private decoder, the startup-validated host pipeline, WebGPU
textures, the device and queue, and command encoders.

Malformed standard requests return the matching standard VirtIO GPU error.
Malformed private bytes return `VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER`. A
rejected submit creates no object, commits no state, and submits no WebGPU work.
Unexpected backend or device loss enters the existing fatal path and restores
VGA fallback.

The single WebGPU queue orders transfers, object creation, draws, KMS scanout
flushes, and replies. Version 1 waits for submitted render work before returning
from the Rust backend; a standard fenced request therefore cannot complete
before its draw. Fence ID, context ID, and ring index are echoed using the
standard response header.

Reset increments the work generation, invalidates stale completions, clears all
contexts, attachments, 3D resources, shader/pipeline objects, and WebGPU
handles, and restores VGA. Device-loss recovery follows the same reset path and
requires guest state recreation. `CTX_DESTROY` drops its objects and
attachments but not global resources; `RESOURCE_UNREF` removes that resource
from contexts and scanout before host destruction.

Snapshots remain the existing 2D format. A snapshot attempt fails while any 3D
context or 3D resource is live; no partial snapshot is produced. Transparent
3D readback/replay requires a later snapshot format and capset version.
