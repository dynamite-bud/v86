# `V86W` capset 7, version 2

Version 2 extends [`webgpuvirt-wire-v1.md`](webgpuvirt-wire-v1.md) with bounded guest-provided WGSL. It does not reinterpret version 1. Version-1 payload bytes, pinned sources, object semantics, and render behavior remain unchanged.

## Negotiation

`GET_CAPSET_INFO(index=0)` returns capset ID 7, maximum version 2, and maximum size 912. `GET_CAPSET(id=7, version=1)` returns the frozen version-1 payload. `GET_CAPSET(id=7, version=2)` returns the version-2 payload. Other versions are invalid.

Both payloads are 912 bytes. Version 2 changes these fields from version 1:

| Offset | Type | Version-2 value |
| ---: | --- | --- |
| 4 | `le16` | submit major 2 |
| 80 | `le32` | maximum source bytes per shader: 16384 |
| 84 | `le32` | maximum live source bytes per context: 131072 |
| 156 | `le32` | maximum global in-flight compilations: 1 |
| 160 | `le32` | maximum in-flight compilations per context: 1 |
| 164 | `le32` | pipeline-compilation timeout: 5000 ms |
| 168 | `le32` | submitted GPU-work completion timeout: 5000 ms |
| 172 | `le32` | maximum vertex invocations per submit: 65536 |
| 176 | `le32` | maximum instances per draw: 1 |

All other fields, including the 256 KiB submit limit, 64-record limit, 32 live shaders, 64 live pipelines, 256-draw limit, format 67, and zero-valued unsupported-feature limits, are identical to version 1.

A context locks to the submit major of its first successful object creation. Mixing version-1 and version-2 submits in one live context is invalid.

## Submit and record encoding

Version 2 uses the version-1 envelope and records byte-for-byte except that `v86_submit_v1.major` is 2. The version-1 opcodes and exact record sizes remain authoritative.

`CREATE_SHADER` still contains:

```text
le32 id;
le32 stage;       // 1 vertex, 2 fragment
le32 ir_kind;     // 1 WGSL
le32 byte_count;  // 1..=16384
byte source[byte_count];
byte zero_padding[align8(byte_count) - byte_count];
```

Version 2 accepts any UTF-8 source satisfying the validation and resource limits below. Version 1 continues to accept only its two digest-locked sources.

## Synchronous validation

Before creating any WebGPU object, the Rust renderer:

1. validates the entire private envelope, resource table, record stream, IDs, sizes, padding, and counts;
2. accounts all staged source bytes against the 131072-byte context limit;
3. parses every new source with Naga's WGSL frontend;
4. validates every module with all Naga validation flags and no optional Naga capabilities;
5. requires exactly one entry point named `main` whose stage matches the record;
6. rejects every global resource binding.

Malformed UTF-8, WGSL syntax/type errors, missing or wrong-stage entry points, unsupported bindings/features, oversized sources, and live-object limit violations return `VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER`. No WebGPU object or context-local handle is committed.

Version 2 retains the version-1 no-resource pipeline: triangle-list topology, no vertex buffers, no bind groups, one `R8G8B8A8_UNORM` color target, sample count one, and entry point `main`. WebGPU pipeline validation therefore rejects vertex-input requirements, stage-interface mismatches, incompatible fragment outputs, and other descriptor/module incompatibilities.

## WebGPU validation and timeout

After all synchronous checks pass, one validation error scope covers every staged shader module and render pipeline in the object submit. The renderer uses `wgpu` 30.0.0 from `dynamite-bud/wgpu` revision `7d5148d689f24101eb34c6af71b0071dcd113059`, which backports the approved null-result fix from [gfx-rs/wgpu#10039](https://github.com/gfx-rs/wgpu/pull/10039). Empty scopes settle as `None`; captured browser validation errors settle as `Some(Error)`.

The validation-scope future and every version-2 submitted-work future each race a 5000 ms window timer. A captured validation error rejects the guest submit without changing context state. Version-2 draw validation admits at most 65536 total vertex invocations per submit and one instance per draw. Either timeout records a renderer fault, destroys the WebGPU device, rejects the guest command, releases the standard VirtIO descriptor/fence, disposes all Rust renderer state, restores VGA, and requires explicit device reset before 3D can be reinitialized.

The JavaScript work queue and Rust mutable renderer permit one compilation globally and per context. No guest-memory view crosses either await. Standard fenced `SUBMIT_3D` replies use the Rust submit's validated completion directly; the JavaScript command path does not add a second, unbounded queue wait.

## Atomic ownership

Shader modules and pipelines are staged in temporary maps. Context-local source accounting and object maps update only after Naga validation and the bounded WebGPU scope both succeed. A failed batch drops every staged handle. Render submits select the context pipeline object; version-1 handles continue selecting the immutable startup pipeline.

Destroy rules are unchanged: IDs are context-local, missing objects are invalid, and a shader referenced by a surviving pipeline cannot be destroyed. Destroying a shader releases its accounted source bytes.

## Verification

`make virtio-gpu-3d-shader-test` runs on port 8082 and proves in real Chromium that:

- the i386 Linux/libdrm guest requests capset version 2, submits arbitrary non-version-1 WGSL through `DRM_IOCTL_VIRTGPU_EXECBUFFER`, and presents a green triangle;
- twelve invalid cases cover UTF-8, syntax, types, missing entry point, stage mismatch, bindings, per-shader bytes, per-context bytes, live shader count, pipeline interface mismatch, vertex-work limits, and instancing;
- every invalid batch leaves object counts and source-byte accounting unchanged;
- a standard fenced version-2 object submit completes without an outer queue wait, while a fenced render whose submitted-work promise never settles returns at the 5000 ms bound;
- two forced never-settling compilation scopes and one never-settling submitted-work promise each fault at the 5000 ms bound, restore VGA, reinitialize the backend, and leave zero standard 3D contexts/resources/attachments.

`make virtio-gpu-3d-triangle-test` remains the browser acceptance contract for the frozen version-1 pinned pipeline.
