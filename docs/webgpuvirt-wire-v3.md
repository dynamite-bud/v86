# `V86W` capset 7, version 3

Version 3 extends [`webgpuvirt-wire-v2.md`](webgpuvirt-wire-v2.md) with WebGPU-restricted SPIR-V, multiple vertex buffers, indexed draw, sampled textures, uniform and storage buffers, premultiplied-alpha blending, instancing, and explicit resource bindings. It does not reinterpret versions 1 or 2.

## Negotiation

`GET_CAPSET_INFO(index=0)` returns capset ID 7, maximum version 3, and maximum size 912. Versions 1 and 2 retain their frozen payloads. `GET_CAPSET(id=7, version=3)` returns the version-3 payload; other versions are invalid.

The payload is 912 bytes. Version 3 changes or defines these fields:

| Offset | Type | Version-3 value |
| ---: | --- | ---: |
| 4 | `le16` | submit major 3 |
| 12 | `le32` | feature bits `0x85f`: basic render, vertex buffers, indexed draw, sampled textures, uniform buffers, blending, storage buffers |
| 16 | `le32` | shader IR bits `0x2`: WebGPU-restricted SPIR-V only |
| 20 | `le32` | three format records |
| 76 | `le32` | maximum transfer bytes: 16777216 |
| 80 | `le32` | maximum bytes per shader: 131072 |
| 84 | `le32` | maximum live shader bytes per context: 262144 |
| 96 | `le32` | one bind group per pipeline |
| 100 | `le32` | 16 bindings in group zero |
| 104 | `le32` | eight vertex buffers per pipeline |
| 108 | `le32` | eight vertex attributes per pipeline |
| 128 | `le64` | maximum buffer size: 16777216 bytes |
| 144 | format record | format 67 (`R8G8B8A8_UNORM`), usage `0x7b`, sample count bit `0x1` |
| 156 | format record | format 64 (`R8_UNORM`), usage `0x5b`, sample count bit `0x1` |
| 168 | format record | format 177 (`R8_UINT`), usage `0x5b`, sample count bit `0x1` |
| 180 | `le32` | one global in-flight compilation |
| 184 | `le32` | one in-flight compilation per context |
| 188 | `le32` | pipeline-compilation timeout: 5000 ms |
| 192 | `le32` | submitted GPU-work timeout: 5000 ms |
| 196 | `le32` | maximum vertex invocations per submit: 4194304 |
| 200 | `le32` | maximum instances per draw: 4096 |
| 204 | `le32` | version-3 vertex-layout count ceiling: 8 |
| 208 | `le32` | maximum single host allocation: 16777216 bytes |
| 212 | `le32` | accepted buffer bind bits `0x4054`: constant, vertex, index, shader buffer |

The 4096-instance ceiling covers the measured Ghostty terminal batches, whose
observed maximum is 2479, while the aggregate invocation ceiling remains
unchanged.

All unspecified bytes remain zero or retain the common capset value defined by version 1. Format usage bits keep the meaning in the canonical architecture document. Buffer bind bits use the stable virgl numeric namespace; they are not format usage bits.

A context locks to the submit major of its first successful object creation. Mixing submit majors in one live context is invalid.

## Resource descriptors and transfers

Version 3 accepts these standard `RESOURCE_CREATE_3D` shapes:

- buffers: target 0, format 64 (`R8_UNORM` as the byte-addressable wire format), `width == byte_length`, unit height/depth/array/sample/level, a nonempty subset of bind bits `0x4054`, and `byte_length <= min(maximum buffer size, maximum single host allocation, maximum transfer bytes)`;
- textures: target 2 or 5, a listed texture format, unit depth/array/sample/level, and a nonempty subset of render-target, sampler-view, and scanout bind bits.
Format 177 (`R8_UINT`) is the measured Ghostty glyph-atlas compatibility
record. The renderer stores it as WebGPU `r8unorm`, and the bounded translated
shader consumes normalized alpha. This does not advertise general integer
texture or integer-sampling semantics.
`TRANSFER_TO_HOST_3D` uploads the attached GEM backing and `TRANSFER_FROM_HOST_3D` downloads into it. Both directions reject any request whose effective byte count exceeds the advertised sixteen-MiB transfer maximum. Buffer transfers may use the resource's page-rounded staging footprint, but their guest payload remains bounded by the resource allocation. Buffer uploads must be four-byte aligned and contiguous. Texture rows are repacked to WebGPU's row alignment when necessary. Linux 6.18 requires zero `stride` and `layer_stride` for these non-blob GEM resources; width and format determine the effective stride.

## Submit envelope and object records

Version 3 uses the version-1 envelope with `major = 3`. Resource table indices below are zero-based and every table entry must be used.

`CREATE_SHADER` keeps the existing variable-size layout:

```text
le32 id;
le32 stage;       // 1 vertex, 2 fragment
le32 ir_kind;     // 2 SPIR-V
le32 byte_count;  // nonzero, multiple of 4, <= 131072
byte source[byte_count];
byte zero_padding[align8(byte_count) - byte_count];
```

The SPIR-V frontend must parse and validate the module synchronously before pipeline creation, and must produce exactly one `main` entry point of the declared stage. Truncated or malformed modules, unsupported capabilities, invalid types, and descriptors outside group zero or binding 0 through 15 are rejected before any WebGPU object is created.

`CREATE_PIPELINE` is variable-sized:

```text
le16 opcode = 3;
le16 dwords;
le32 flags = 0;
le32 id;
le32 vertex_shader_id;
le32 fragment_shader_id;
le32 topology;              // 3, triangle list
le32 color_format;          // 67
le32 sample_count;          // 1
le32 blend;                 // 0 replace, 1 premultiplied alpha
le32 vertex_buffer_count;   // 0..=8
le32 vertex_attribute_count;// 0..=8
le32 reserved = 0;
struct {
    le32 stride;             // 1..=2048
    le32 reserved;           // zero
} vertex_buffers[vertex_buffer_count];
struct {
    le32 shader_location;
    le32 byte_offset;
    le32 format;             // 1 f32, 2 f32x2, 3 f32x3, 4 f32x4, 5 unorm8x4
    le32 buffer_slot;        // < vertex_buffer_count
} attributes[vertex_attribute_count];
```

The record size is exactly `48 + vertex_buffer_count * 8 + vertex_attribute_count * 16`. Attribute locations are unique. `byte_offset + format_size` must not exceed the selected buffer stride. Empty and nonempty vertex-buffer/attribute tables must match.

Object creation remains atomic: the complete mutation submit, Naga modules, shader interface, bind-group layout, vertex layout, and WebGPU pipeline validate before any context handle is committed.

## Render records

Version 3 retains the balanced render-pass, pipeline, viewport, scissor, draw, and end-pass records from versions 1 and 2 and adds:

```text
SET_VERTEX_BUFFER (opcode 22, 32 bytes)
le32 resource_index;
le64 byte_offset;
le64 byte_size;
le32 slot;
```

The resource must be an attached buffer. Slot is less than eight. Offset, size, and end are checked against the resource; the draw range must fit `first_vertex + vertex_count` elements at the pipeline stride for every required slot.

```text
SET_INDEX_BUFFER (opcode 24, 32 bytes)
le32 resource_index;
le64 byte_offset;
le64 byte_size;
le32 format;             // 1 uint16, 2 uint32
```

The resource must be an attached buffer. Offset, size, and end are checked against the resource and aligned to the selected format. As with vertex and uniform use, the private record determines consumption independently of the accepted standard allocation bind bits.

```text
SET_BIND_GROUP (opcode 23, 16 + count * 32 bytes)
le32 count;                 // 0..=16
le32 reserved = 0;
struct {
    le32 binding;
    le32 kind;              // 1 buffer, 2 texture, 3 immutable sampler
    le32 resource_index;    // sampler requires 0xffffffff
    le32 reserved;          // zero
    le64 byte_offset;       // buffer only
    le64 byte_size;         // buffer only, nonzero
} entries[count];
```

```text
DRAW_INDEXED (opcode 25, 32 bytes)
le32 index_count;
le32 instance_count;
le32 first_index;
le32 base_vertex;        // signed two's-complement i32
le32 first_instance;
le32 reserved = 0;
```

Bindings are unique and in group zero. Buffer offset/size and texture attachment/type are checked before the renderer creates a transient bind group. The sampler is renderer-owned and immutable. A draw requiring a bind group, vertex buffer, or index buffer is invalid when that state is absent. Indexed fetch ranges, instance ranges, alignment, and aggregate work are validated before encoding.

Every render submit is completely validated before creating a command encoder or submitting queue work. Version 3 allows at most 4194304 aggregate vertex invocations, 4096 instances per draw, 256 draws, and the common command/resource limits. Work completion is fenced and bounded by 5000 ms.

## Proving workload

`make virtio-gpu-webgpuvirt-triangle-test` owns port 8082 and proves the
version-3 contract in real Chromium. The i386 guest first renders a
deterministic textured/blended triangle with Mesa llvmpipe as the software
reference. It then creates a host render target, two vertex buffers, an index
buffer, a sampled texture, and a uniform buffer through standard Linux/libdrm
ioctls; uploads GEM backing; submits two SPIR-V modules, a two-slot vertex
layout, three bindings, and one indexed draw; presents the result through the
existing scanout; and checks matching red-center/blue-corner pixels.
Acceptance also requires zero invalid commands, backend failures, WebGPU
validation errors, and leaked objects after device-loss recovery.

This remains the transport and renderer proof. The separate
`make virtio-gpu-codex-accelerated-test` gate exercises the checksum-locked
Mesa `webgpuvirt` winsys, measured virgl command translation, and Ghostty
OpenGL startup. The default appliance and direct JavaScript backend remain
2D-only; acceleration is explicit and available only with Rust/Wasm `wgpu`.
Neither gate claims general virgl, GLSL, Vulkan, or OpenGL compatibility.
