# Alpine i386 Openbox Ghostty Codex Appliance

This directory is the reproducible **Xorg/Openbox reference appliance** for the i386 Ghostty and Codex work tracked in [XWAH-3](https://github.com/dynamite-bud/v86/issues/3). It boots into an interactive shell inside a maximized, undecorated Ghostty window. Codex is installed but is not started automatically, so the user can edit configuration before running it.

Keep this implementation intact when adding a Cage variant. A Cage + Ghostty + Codex appliance belongs in the sibling directory `tools/docker/virtio-gpu-alpine-cage-codex/` with distinct image names, generated artifacts, browser entry point, readiness markers, and acceptance harness. The two fixtures must remain runnable side by side.

Start with the [GPU contributor guide](../../../docs/gpu/README.md), the [appliance architecture and evidence](../../../docs/gpu/ghostty-codex-appliance.md), and the [canonical VirtIO GPU architecture](../../../docs/virtio-gpu-webgpu.md).

## Runtime Topology

```text
Alpine OpenRC
  -> v86-networking (hostname, runtime directory, optional DHCP)
  -> automatic unprivileged codex login on tty1
  -> v86-appliance-session
  -> Xorg modesetting on /dev/dri/card0 at 1024x768x24
  -> Openbox
  -> Mesa llvmpipe (default) or targeted webgpuvirt Gallium (opt-in)
  -> maximized undecorated Ghostty with an interactive /bin/sh
  -> user runs codex when wanted
       --dangerously-bypass-approvals-and-sandbox
       --disable code_mode --disable code_mode_only --disable code_mode_host
       --disable apps --enable shell_tool --enable unified_exec
       -c code_mode.disable_in_process_fallback=false
```

The default guest remains software-rendered and uses standard VirtIO GPU 2D scanout with either browser presentation backend. The opt-in `accelerated=1` mode is available only with the Rust/Wasm `wgpu` backend: Linux negotiates capset 7, the targeted `webgpuvirt` Gallium winsys emits the measured Ghostty command subset, and the standard 2D path still presents the completed scanout. The direct JavaScript backend remains 2D-only. This is not general OpenGL, Vulkan, virgl, or virgl2 support.

## Architecture Decision

v86 is a 32-bit x86 emulator and cannot run the upstream x86-64 Ghostty, Codex, OMP, Bun, or Linux artifacts requested by the original XWAH-3 contract. The implemented appliance therefore pins reviewed downstream i386 ports:

- Ghostty [`v1.3.1-i386.1`](https://github.com/dynamite-bud/ghostty/releases/tag/v1.3.1-i386.1), built for Alpine `x86-linux-musl`;
- Codex [`rust-v0.147.0-i386.3`](https://github.com/dynamite-bud/codex/releases/tag/rust-v0.147.0-i386.3), built for `i686-unknown-linux-musl`.

`artifacts.lock` owns their release URLs and SHA-256 values. The image build downloads only those URLs, verifies both archives before extraction, runs both version commands, and removes download and build residue.

## Source File Ownership

| File | Contract |
| --- | --- |
| `Dockerfile` | Pinned Alpine and Mesa sources, verified Mesa/application artifacts, exact package closure, UID 1000 account, separate real Codex binary and manual launcher, OpenRC services, locked root account, and initramfs generation. |
| `build.sh` | `linux/386` Docker build/export, deterministic rootfs normalization, filesystem JSON and zstd chunk generation, and image-contract generation. |
| `world.lock` | Exact direct APK requests. Openbox/Xorg packages in this file are part of this fixture's identity. |
| `packages.lock` | Sorted direct and transitive installed APK closure. The Docker build rejects drift with `apk info -v | sort | cmp`. |
| `artifacts.lock` | Immutable Ghostty and Codex release tags, URLs, and SHA-256 values. |
| `mesa-artifacts.lock` | Pinned Mesa commit plus reproducible i386 Gallium and DRI binary SHA-256 values. |
| `v86-networking` | Deterministic hostname, IPv4 loopback setup, UID 1000 runtime directory, and optional VirtIO NIC DHCP. |
| `profile` | Starts the appliance only for the automatic tty1 login. |
| `appliance-session` | Architecture, privilege, loopback/network, DRM, process, negotiated renderer, 2D fallback, and serial readiness/failure contract. |
| `virtio-gpu-capset-probe.c` | Direct pinned-libdrm `GET_CAPS` and `CONTEXT_INIT` proof for private capset ID 7. |
| `virtio-gpu-triangle.c` | Frozen capset-v1/v2 triangles plus the version-3 Mesa llvmpipe reference and explicit resource/buffer/shader/binding/indexed-draw workload. |
| `virtio-gpu-triangle-spv.h` | Pinned Naga-generated SPIR-V modules for the version-3 textured triangle. |
| `ghostty-terminal-benchmark.c` | Offline fixed ANSI/scroll workload, guest CPU accounting, keyboard synchronization, and serial run markers for the XWAH-5 baseline. |
| `probe-world.lock` | Exact direct build-only packages for the probes and triangle workloads. |
| `probe-packages.lock` | Complete sorted probe/triangle builder package closure; the build rejects drift. |
| `xinitrc` | Openbox, selected renderer check, 1024x768 mode, and Ghostty process startup. |
| `20-virtio-gpu.conf` | Xorg modesetting, glamor, and DRI3 configuration for PCI `1af4:1050`; the session selects llvmpipe unless acceleration is explicit. |
| `ghostty-config` | Undecorated maximized window and the interactive shell-session command. |
| `ghostty-session` | Benchmark selection or a ready-marked interactive `/bin/sh` in `/home/codex/workspace`. |
| `codex-launcher` | Manual `codex` command, exact full-access bypass, unsupported feature disablement, supported direct tools, and user-owned MCP configuration. |

Docker assembles and exports the root filesystem; it is not part of the browser runtime. `normalize_rootfs.py --preserve-owners` sorts archive members, clears timestamps and owner names, removes Docker metadata, and retains numeric UID/GID ownership for the unprivileged home and workspace.

## Prerequisites

- Docker with `linux/386` support. Docker Desktop supplies architecture emulation on Apple silicon.
- Python 3 with the `zstandard` module required by the repository image tools.
- The normal v86 JavaScript/Wasm build dependencies.
- Rust stable, `wasm32-unknown-unknown`, and `wasm-bindgen` when exercising the Rust/Wasm `wgpu` backend.
- Chromium or Chrome with WebGPU for browser acceptance.
- Enough disk space for Docker layers, a roughly 703 MiB rootfs tar, and about 280 MiB of content-addressed compressed files.

Install the Python dependency if needed:

```sh
python3 -m pip install --user zstandard
```

## Build

From the repository root:

```sh
make virtio-gpu-codex-image
make all-debug
make virtio-gpu-wgpu
```

The combined four-vCPU accelerated variant reuses the same locked guest inputs
and custom Mesa build, adds the multicore readiness probe, and writes a distinct
artifact namespace:

```sh
make virtio-gpu-multi-core-alpine-codex-image
make virtio-gpu-multi-core-alpine-codex-browser-test
```

Its generated artifacts use the
`virtio-gpu-multi-core-alpine-codex-*` prefix, so they cannot silently collide
with either the single-core or multicore-only appliance.

The image target writes ignored build products under `images/`:

- `alpine-virtio-gpu-codex-rootfs.tar`
- `alpine-virtio-gpu-codex-fs.json`
- `alpine-virtio-gpu-codex-rootfs-flat/`
- `alpine-virtio-gpu-codex-image-contract.json`

Do not commit generated images or Docker exports. An intentional input change requires all of the following:

1. update `world.lock` or `probe-world.lock` only for deliberate direct-package changes;
2. regenerate and review the matching complete `packages.lock` or
   `probe-packages.lock` closure rather than bypassing its comparison;
3. update `artifacts.lock` only from a reviewed release and verified checksum;
4. rebuild twice and confirm the generated image-contract checksum is stable;
5. update the artifact sizes and checksums in `docs/gpu/ghostty-codex-appliance.md`;
6. rerun both renderer scenarios and the shared VirtIO GPU regressions.
7. retain the release-stripped custom Mesa build and package only its runtime
   objects; default boots keep Alpine's system Gallium file, so a duplicate
   system backup only inflates the exported rootfs.

## Launch on Port 8082

Serve the repository root:

```sh
python3 tools/coi-server.py 8082
```

The cross-origin-isolated server is required by worker-per-vCPU execution.

Offline direct-JavaScript launch:

```text
http://127.0.0.1:8082/examples/virtio_gpu_codex.html?renderer=webgpu-js
```

Online launch with a percent-encoded WISP/wsproxy relay:

```text
http://127.0.0.1:8082/examples/virtio_gpu_codex.html?renderer=webgpu-js&relay=wss%3A%2F%2Frelay.example.test%2F
```

Change `renderer=webgpu-js` to `renderer=wgpu` for the Rust/Wasm renderer. The page preserves the relay parameter when switching renderers.

The canonical consolidated XWAH-5/XWAH-6 launch uses browser-side Rust/Wasm
`wgpu`, guest-side Mesa `webgpuvirt`, and an optional relay for guest
networking:

```text
http://127.0.0.1:8082/examples/virtio_gpu_codex.html?renderer=wgpu&accelerated=1&relay=wss%3A%2F%2Frelay.example.test%2F
```

For this mode, require `V86_APPLIANCE_RENDERER=webgpuvirt (v86 WebGPU)`,
`V86_APPLIANCE_LOOPBACK=PASS`, `V86_APPLIANCE_NETWORK=PASS`, and
`V86_APPLIANCE_CODEX_APPS=DISABLED`; do not accept llvmpipe fallback.

The combined accelerated multicore launch fixes the Rust/Wasm `wgpu` backend,
guest `webgpuvirt` rendering, four worker-backed vCPUs, and the relaxed SMP
memory model:

```text
http://127.0.0.1:8082/examples/virtio_gpu_codex.html?preset=multi-core-accelerated
```

Append the same percent-encoded `relay=` parameter when guest networking is
required. The corresponding acceptance target requires all four vCPUs online,
worker execution, at least `1.30x` in-guest parallel speedup, non-llvmpipe
rendering, accelerated 3D command submission, and the complete Ghostty/Codex
readiness contract.

The page deliberately does not hardcode a relay. Without `relay=`, it reports
`VirtIO NIC relay: unconfigured`, passes `v86_relay=unconfigured` to the guest,
omits the virtual NIC, and still boots the local Ghostty shell. With a relay,
the guest must obtain an IPv4 lease before the graphical session starts. The
relay startup path does not add, probe, or otherwise select an MCP server.
Configure MCP servers manually in the writable guest home. Use a trusted relay
for real credentials; a public relay is suitable only for disposable testing
and can observe connection metadata even though application HTTPS remains
encrypted.

## Manual Codex Launch and Permissions

Normal boots intentionally stop at a shell prompt in
`/home/codex/workspace`. Codex remains installed and available on `PATH`; start
it only when wanted:

```sh
codex
```

`/usr/local/bin/codex` is a small launcher for the pinned real binary at
`/usr/local/libexec/codex`. It always sets
`--dangerously-bypass-approvals-and-sandbox` because the disposable v86 guest
is the external sandbox. It also retains the supported direct tools and
disables the unavailable Code Mode host and host-owned Apps catalog. It does
not inject an MCP server; relay and MCP selection are independent.

This fixes the previous `Read-only file system (os error 30)` failure: the old
automatic `workspace-write` session mounted paths outside the workspace,
including `/home/codex/.codex`, read-only for model-spawned commands. A manual
full-access session can persist commands such as `codex mcp add` in the
session's writable `~/.codex/config.toml`.

Full access is deliberate and dangerous. Model-generated commands run without
Codex approval prompts or a Codex filesystem sandbox, as unprivileged UID
1000. Root remains locked, no credential is baked into the image, and resetting
the page discards every guest mutation.

The guest includes pinned `python3` 3.14.7-r1 and `jq` 1.8.1-r0 for ordinary
agent and MCP workflows. They are direct inputs in `world.lock`; their complete
transitive closure is checksum-stable through `packages.lock`.

## Authentication and Persistence

No model credential or `/home/codex/.codex/auth.json` is baked into the image. Prefer Codex's device-code login so authentication is completed in a normal browser rather than by typing a secret into the guest.

The root filesystem is writable only for the current emulator session. **Reset fresh session** reloads the page and discards authentication, workspace changes, and all other guest mutations. Persistence is intentionally out of scope for this reference fixture.

The pinned i386 port also lacks Codex's normal Linux network seccomp filter because the filter's compiler dependency does not support 32-bit x86. Manual Codex sessions therefore have neither Codex filesystem sandboxing nor its network seccomp isolation. Run this appliance only inside the external disposable-v86 isolation boundary.

## Readiness Contract

`appliance-session` writes bounded evidence to `ttyS0`. A successful boot includes:

```text
V86_APPLIANCE_BEGIN
V86_APPLIANCE_ARCH=i686
V86_APPLIANCE_UID=1000
V86_APPLIANCE_HOSTNAME=v86-appliance
V86_APPLIANCE_LOOPBACK=PASS
V86_APPLIANCE_PYTHON3=Python 3.14.7
V86_APPLIANCE_JQ=jq-1.8.1
V86_APPLIANCE_DRM=/dev/dri/card0
V86_APPLIANCE_NETWORK=PASS|UNCONFIGURED
V86_APPLIANCE_XORG=PASS
V86_APPLIANCE_RENDERER=llvmpipe (...)|webgpuvirt (...)
V86_APPLIANCE_OPENBOX=PASS
V86_APPLIANCE_GHOSTTY_PROCESS=PASS
V86_APPLIANCE_GHOSTTY_WINDOW=PASS
V86_APPLIANCE_GHOSTTY_SHELL=PASS
V86_APPLIANCE_CODEX_BINARY=PASS
V86_APPLIANCE_CODEX_AUTOSTART=DISABLED
V86_APPLIANCE_CODEX_FULL_ACCESS=PASS
V86_APPLIANCE_CODEX_HOME_WRITABLE=PASS
V86_APPLIANCE_CODEX_APPS=DISABLED
V86_APPLIANCE_NO_CODE_MODE_HOST=PASS
V86_APPLIANCE_READY=PASS
V86_APPLIANCE_END
```

The browser declares success only after both the final guest marker and a
visible dedicated WebGPU canvas. Accelerated acceptance also requires matching
dominant colors in opposite interior triangles and both transparent and opaque
cursor pixels. Startup failure copies bounded Xorg, Openbox, Ghostty, and GL
diagnostics to serial, emits a precise `V86_APPLIANCE_FAILURE=...`, and leaves
the serial console available.

## Capset-7 Transport Gate

This pinned Linux 6.18.44 image also owns XWAH-1's first mandatory transport
gate. The probe is dormant during every normal appliance boot. The dedicated
Node harness adds `v86_gpu_capset_probe=1`, enables the internal zero-feature
host probe, runs direct DRM ioctls, and exits before Xorg:

```sh
make virtio-gpu-codex-image
make virtio-gpu-capset-probe-test
```

Success requires both exact markers:

```text
V86_GPU_CAPSET7_GET_CAPS=PASS magic=0x57363856 size=912
V86_GPU_CAPSET7_CONTEXT_INIT=PASS capset=7
```

This proves that pinned Linux and libdrm preserve provisional capset ID 7. It
does not provide 3D resources, shaders, submits, Mesa acceleration, or a public
emulator option. Normal boots remain the standard 2D appliance.

## XWAH-5 llvmpipe Baseline

The opt-in `benchmark=1` boot mode replaces the Codex child process with the
offline `/usr/local/bin/v86-ghostty-benchmark` workload. Normal appliance boots
remain unchanged. The benchmark emits 512 scrolling ANSI lines and a stable
24-line terminal reference, waits for browser acknowledgement after WebGPU
presentations quiesce, and records aggregate non-idle guest CPU ticks from
`/proc/stat`.

Run two warmups and five measured runs on port 8082:

```sh
V86_CODEX_BROWSER_OUTPUT=tests/benchmark/baselines/ghostty-llvmpipe-wgpu-apple-m4.json \
V86_CODEX_BENCHMARK_MACHINE=apple-m4-10c \
make virtio-gpu-codex-benchmark
```

The committed Apple M4/Chrome 151 llvmpipe baseline records 91,743 ms graphical
readiness, 1,900/3,250 ms guest CPU p50/p95, and 1,478/1,877.4 ms
keystroke-to-first-present p50/p95. Every measured run produced the same
`bbd05cf6097ac9b1f89ea29d2542c1b7b67ee46848393895f5a9e43fa1f621e5`
terminal pixel hash. Each run issued two 2D transfers and two flushes, uploaded
and presented 6,291,456 bytes, reported zero invalid/backend commands, and
retained zero 3D objects. The five runs reported no browser long tasks or WebGPU
validation errors.

This is the XWAH-5 comparison baseline, not a performance claim. The
accelerated benchmark target enforces the same workload, machine/browser/build,
raw-run schema, terminal hash, and zero-error contract.

## XWAH-5 Version-3 Resource Triangle

The opt-in `resources=1` boot mode stops before Xorg and runs two equivalent
triangle workloads. First, Mesa llvmpipe renders and reads back a deterministic
textured, premultiplied-alpha triangle as the software reference. Then the
libdrm workload negotiates capset version 3 and sends actual standard VirtIO GPU
resources plus the private WebGPU submit stream: one render target, two vertex
buffers, one index buffer, one sampled texture, one uniform buffer, two SPIR-V
modules, three bindings, and one indexed draw. This proves the version-3
transport and renderer independently of the Gallium integration exercised by
the opt-in accelerated appliance.

Run the real-browser contract on the reserved port:

```sh
make virtio-gpu-webgpuvirt-triangle-test
```

Success requires the llvmpipe and version-3 guest markers, red-center and
blue-corner browser pixels, standard resource/transfer/submit/scanout commands,
zero invalid/backend/WebGPU errors, ordered fences, deterministic device-loss
recovery, and zero leaked 3D objects. The exact byte contract is
[`docs/webgpuvirt-wire-v3.md`](../../../docs/webgpuvirt-wire-v3.md).

## XWAH-5 Accelerated Ghostty

The explicit `accelerated=1` boot mode selects the checksum-locked
`webgpuvirt` Mesa artifacts under `/usr/local`, requires capset version 3, and
fails rather than silently falling back to llvmpipe. The Rust/Wasm backend
accepts only the measured Ghostty virgl command and shader profiles. Unknown
state is a deterministic invalid submit; it does not broaden the advertised
contract.

Run the browser acceptance contract:

```sh
make virtio-gpu-codex-accelerated-test
```

Run the fixed terminal workload for comparison with the committed baseline:

```sh
V86_CODEX_BROWSER_OUTPUT=tests/benchmark/baselines/ghostty-webgpuvirt-wgpu-apple-m4.json \
V86_CODEX_BENCHMARK_MACHINE=apple-m4-10c \
make virtio-gpu-codex-benchmark-accelerated
```

The committed Apple M4/Chrome 151 accelerated result records 42,769.9 ms
graphical readiness, 330/360 ms guest CPU p50/p95, and 238.1/285.3 ms
keystroke-to-first-present p50/p95. Relative to the committed llvmpipe control,
guest CPU p50 is 82.6% lower and keystroke-to-present p95 is 84.8% lower, with
no regression in either primary metric. Scroll throughput p50 rises from
362.65 to 1,633.15 lines/s. All five runs retain the exact
`bbd05cf6097ac9b1f89ea29d2542c1b7b67ee46848393895f5a9e43fa1f621e5`
terminal hash and report zero invalid commands, backend errors, WebGPU
validation errors, or long tasks.

Both targets own port 8082. Acceptance requires a `webgpuvirt` renderer marker,
Ghostty shell readiness, installed/manual Codex markers, a successful
configuration write, capset-7 `SUBMIT_3D` traffic, a uniform off-diagonal
background, a mixed-alpha cursor, and zero invalid commands, backend errors,
browser console errors, or WebGPU validation errors.

## XWAH-5/XWAH-6 Change Review

This is the PR-level audit of the feature history and broad diffs, not only the
final happy path. The review covers the original XWAH-5 feature, its
post-merge appliance/Codex corrections, XWAH-6, and the consolidated local
handoff.

The fork's GitHub PR index contained no PR object for these work items at
review time; issue discussions and the commit ranges below are therefore the
authoritative review record.

### Broad diff review

|Slice|Range|Files|Insertions|Deletions|Primary ownership|
|---|---|---:|---:|---:|---|
|XWAH-5 primary implementation|`5c7c8eb2..0b8cc576`|51|10,685|605|Mesa/Gallium and DRM winsys, capset-v3 protocol, Rust/Wasm renderer, appliance, benchmarks, acceptance, tools, and docs|
|XWAH-5 post-merge corrections|`0b8cc576..8f42ae66`|8|173|212|Session lifecycle, direct-tool selection, reviewed i386 artifact, and sandboxed shell execution|
|XWAH-6 MCP policy|`c1af225c..ffc7db1e`|7|136|31|Apps disablement, Context7 configuration/preflight, readiness, acceptance, and docs|
|Consolidated operations|`f32bff78..4839842f`|4|123|55|Canonical runtime, image handoff, stale-build guard, and root/fixture agent guidance|

The XWAH-5 primary diff is intentionally broad because the guest driver,
wire format, host renderer, reproducible image, and observable acceptance
contract had to move together. The smaller follow-up ranges are corrections;
they are part of the shipped behavior and must not be omitted from review.

### Bugs and hardening findings

|Area|Observed failure or risk|Correction and retained guard|
|---|---|---|
|Mesa capability negotiation|Ghostty configured framebuffer sRGB, but `webgpuvirt` did not advertise the control.|Advertise the bounded capability (`e816e5bc`) and keep the measured GL callset test.|
|Mesa patch generation|Adding sRGB support left the generated patch hunk range stale.|Correct the range (`490527a3`); CI applies the pinned patch from scratch.|
|Mesa artifact CI|The built DRI driver was a symlink and artifact collection did not follow it.|Dereference the driver symlink (`b6bf0580`) and checksum the real runtime object.|
|Build dependencies|The i386 Mesa recipe omitted XRandR, zlib, zstd, Expat, and ELF development inputs.|Install and lock the complete build closure (`0b0e56ee`).|
|Resource validation|Valid Mesa buffer resource shapes were rejected by the private resource path.|Accept the measured shapes (`d0b6642b`) without widening dimensions or quotas generally.|
|Validation attribution|A guest render failure could leak into unrelated global diagnostics.|Scope errors to the offending submit (`55df78b4`) and retain bounded rejection history (`a3c2c4d4`).|
|Rejected submits|Validation failure could leave partially staged Mesa state.|Roll back atomically (`795dca31`); fuzzed decoding must not submit, retain descriptors, or create objects.|
|Malformed submits|A bad submit could destroy an otherwise valid guest context.|Preserve the context (`84e86d7c`) while rejecting only the malformed command.|
|Artifact portability|CI emitted platform-dependent checksum text.|Emit portable hashes (`905abc6b`) and separate artifact export from lock verification (`782fdc61`).|
|Benchmark attribution|The accelerated benchmark could report the wrong renderer.|Emit and assert the selected renderer (`b2cc6555`).|
|Texture capability gaps|Ghostty uses R8, RG, integer atlas, and atlas color-attachment formats not covered by the initial subset.|Add only the measured R8/RG/integer-atlas paths and advertised targets (`a0d2e138`, `69fa9e61`, `b94ee31e`, `d41823ea`, `0f7f447a`, `8a25f294`).|
|Clear-color conversion|Mesa BGRA clears could arrive with swapped colors.|Preserve BGRA clear semantics (`168bf90f`) and retain the triangle/pixel contracts.|
|Browser optimization|Closure could rename browser API properties used dynamically by WebGPU integration.|Preserve those property names (`df2dfb8c`).|
|Tracing|Development virgl/format tracing was noisy and could perturb normal runs.|Gate command tracing (`1a472184`) and remove temporary format tracing (`06c5a1a9`).|
|Snapshot memory|Compressed state chunks were materialized instead of streamed.|Stream chunks (`966735e5`) to bound transient memory.|
|Visual acceptance|A single readiness pixel missed a diagonal two-tone Ghostty background.|Separate global and cell-background programs, draw the former with a synthetic full-screen triangle, and sample both diagonal regions (`60182f5a`, `0b8cc576`).|
|Cursor conversion|Forcing opaque alpha for X-format cursors produced a black 64×64 square.|Keep scanout X formats opaque but preserve the cursor's fourth guest byte; require transparent and opaque pixels (`0b8cc576`).|
|Benchmark readiness|An idle terminal could stop producing dirty frames after guest readiness and trigger a false timeout.|Use the guest marker plus visible canvas before measured runs; require nonzero presentations during every run (`0b8cc576`).|
|Appliance lifecycle|The accelerated launch path could replace or lose the terminal session.|Preserve the Ghostty PTY and interactive shell. The current manual workflow intentionally starts no Codex process and acceptance proves its absence.|
|Code Mode availability|The i386 archive has no V8-backed Code Mode host, so model-requested Code Mode failed closed and left commands unusable.|Disable all Code Mode selectors, retain in-process fallback, and expose supported direct tools (`491c4b50`). Never add a fake host.|
|Artifact provenance|The first downstream Codex pin preceded the final CI-validated sandbox correction.|Pin `rust-v0.147.0-i386.3` from the reviewed successful workflow (`a6f3829f`).|
|i386 network seccomp|The seccompiler dependency has no 32-bit x86 backend and aborted direct commands before `/bin/sh` ran.|Skip only the unavailable network filter; retain setuid Bubblewrap for modes that use it, and disclose that the manual full-access launcher relies on the disposable guest boundary (`8f42ae66`).|
|Codex Apps MCP|The account-owned `codex_apps` server timed out during paginated `tools/list` and created a false degraded-startup state.|Classify it as unsupported here and disable only Apps with `--disable apps` (`ffc7db1e`).|
|Automatic remote MCP|Relay startup selected Context7 and coupled graphical readiness to an unrelated public service.|Remove automatic MCP configuration and preflight. Relay startup now owns only DHCP; users choose servers with `codex mcp add`.|
|Manual customization|The automatic `workspace-write` Codex session made `~/.codex` read-only to model-spawned commands and prevented interactive MCP configuration.|Boot only the Ghostty shell, keep Codex manually runnable, and launch it with `--dangerously-bypass-approvals-and-sandbox`; readiness proves no autostart and a writable Codex home.|
|OAuth loopback|The guest never configured `lo`, so Codex's local OAuth listener failed with `Address not available (os error 99)`.|Bring up `lo` with `127.0.0.1/8` before the session and require `LOOPBACK=PASS`. Host-browser callbacks still need an explicit host-to-guest bridge.|
|Guest utility gap|Ordinary agent workflows lacked Python and jq.|Pin `python3` and `jq` directly and lock their complete i386 package closure.|
|Local worktree handoff|A current image copied into the base worktree was first exercised with a stale browser bundle that lacked `contexts_3d`.|Treat images and browser builds as revision-coupled; rebuild `libv86.mjs`, `v86.wasm`, and `virtio-gpu-wgpu` after handoff (`4839842f`).|
|Public relay availability|The disposable public relay can occasionally fail DHCP or disappear.|Readiness fails honestly with `network-unavailable`; retry or use a trusted relay rather than weakening the contract.|

### Improvements delivered

- Added a deterministic llvmpipe control and accelerated five-run Ghostty
  workload with stable full-canvas SHA-256, guest CPU, latency, throughput,
  presentation, timer, long-task, and error evidence.
- Added a reproducible, checksum-locked Mesa 26.1.6 i386 build with targeted
  `webgpuvirt` Gallium/DRM winsys support, branch CI, complete dependency locks,
  and release-only runtime artifacts.
- Added capset-v3 resource and submit decoding, atomic validation, fuzz
  coverage, quotas, ownership, ordered fences, deterministic teardown and
  device-loss handling, bounded rejection evidence, and shared staged shader
  bytes.
- Added the independent version-3 resource triangle using standard VirtIO GPU
  resources, SPIR-V modules, bindings, indexed drawing, browser pixel checks,
  and zero-leak recovery.
- Added the measured Ghostty vertex/rectangle/texture/atlas subset without
  claiming general OpenGL, virgl, Vulkan, or default 3D compatibility.
- Added fast content-addressed filesystem image patching for development while
  preserving the full reproducible image build and checksum contract.
- Added explicit opt-in appliance and benchmark targets, measured GL callset
  evidence, a GLX-compatible pinned Ghostty artifact, live renderer reporting,
  uniform-background and cursor-alpha gates, and stable direct-tool readiness.
- Added explicit Codex behavior for the actual i386 artifact: non-root UID
  1000, locked root, ephemeral credentials, no fake Code Mode host, Apps
  disabled, manual full-access startup inside the external guest boundary, and
  the remaining network-seccomp limitation disclosed.
- Removed automatic Context7 selection and protocol preflight. Relays now
  provide networking only; ordinary MCP servers are user-configured in the
  writable guest home.
- Added deterministic IPv4 loopback plus pinned Python 3 and jq guest tools.
- Added source/renderer/image ownership guidance, benchmark baselines, wire
  documentation, browser and unit regressions, troubleshooting, image hashes,
  and exact base-worktree handoff instructions.

### Reviewed commit ledger

|Work item|Commit|Message|
|---|---|---|
|XWAH-5|`b3e41650`|`perf(virtio-gpu): establish Ghostty llvmpipe baseline`|
|XWAH-5|`abdb1d86`|`build(webgpuvirt): add reproducible i386 Mesa build`|
|XWAH-5|`172ffd10`|`ci(webgpuvirt): build Mesa artifacts on branch updates`|
|XWAH-5|`0b0e56ee`|`build(webgpuvirt): install Mesa build dependencies`|
|XWAH-5|`e816e5bc`|`fix(webgpuvirt): advertise framebuffer srgb control`|
|XWAH-5|`490527a3`|`fix(webgpuvirt): correct Mesa patch range`|
|XWAH-5|`48f213ed`|`feat(webgpuvirt): expose Ghostty vertex formats`|
|XWAH-5|`b6bf0580`|`fix(webgpuvirt): follow Mesa driver symlink in CI`|
|XWAH-5|`d0b6642b`|`fix(virtio-gpu): accept Mesa buffer resource shapes`|
|XWAH-5|`bd25fc4b`|`feat(tools): add fast filesystem image patching`|
|XWAH-5|`86e63aa7`|`feat(virtio-gpu): render capset v3 guest workloads`|
|XWAH-5|`55df78b4`|`fix(virtio-gpu): scope guest render validation errors`|
|XWAH-5|`d97d314f`|`test(virtio-gpu): fuzz capset v3 submit decoding`|
|XWAH-5|`795dca31`|`fix(virtio-gpu): roll back rejected Mesa submits`|
|XWAH-5|`dcd0f1fe`|`perf(virtio-gpu): share staged Mesa shader bytes`|
|XWAH-5|`318a2c42`|`chore(eslint): declare browser rendering globals`|
|XWAH-5|`2d38044b`|`test(virtio-gpu): add accelerated Ghostty benchmark mode`|
|XWAH-5|`905abc6b`|`fix(ci): emit portable Mesa artifact checksums`|
|XWAH-5|`df5983fe`|`build(mesa): lock i386 webgpuvirt artifacts`|
|XWAH-5|`b2cc6555`|`fix(virtio-gpu): report accelerated benchmark renderer`|
|XWAH-5|`a0d2e138`|`feat(virtio-gpu): support Ghostty R8 textures`|
|XWAH-5|`69fa9e61`|`fix(mesa): advertise R8 render targets`|
|XWAH-5|`1a472184`|`fix(mesa): gate virgl command tracing`|
|XWAH-5|`a3dc19d4`|`feat(virtio-gpu): render Ghostty rectangles`|
|XWAH-5|`a3c2c4d4`|`feat(virtio-gpu): retain bounded 3D rejection history`|
|XWAH-5|`782fdc61`|`build(mesa): separate artifact export from lock verification`|
|XWAH-5|`21d54b15`|`feat(appliance): select opt-in webgpuvirt session`|
|XWAH-5|`17d240f7`|`test(virtio-gpu): add accelerated appliance targets`|
|XWAH-5|`d2cef02c`|`test(appliance): record measured Ghostty GL callset`|
|XWAH-5|`f7126cb1`|`build(appliance): pin GLX-compatible Ghostty artifact`|
|XWAH-5|`84e86d7c`|`fix(virtio-gpu): preserve contexts after malformed submits`|
|XWAH-5|`a2f2db50`|`feat(virtio-gpu): add version three resource triangle`|
|XWAH-5|`168bf90f`|`fix(virtio-gpu): preserve Mesa BGRA clear colors`|
|XWAH-5|`06c5a1a9`|`chore(mesa): remove development format tracing`|
|XWAH-5|`b94ee31e`|`fix(virtio-gpu): support Ghostty integer atlases`|
|XWAH-5|`d41823ea`|`fix(virtio-gpu): expose RG texture support`|
|XWAH-5|`df2dfb8c`|`fix(webgpu): preserve browser API property names`|
|XWAH-5|`0f7f447a`|`fix(virtio-gpu): support Ghostty integer atlas`|
|XWAH-5|`8a25f294`|`fix(virtio-gpu): advertise atlas color attachment`|
|XWAH-5|`966735e5`|`fix(snapshot): stream compressed state chunks`|
|XWAH-5|`60182f5a`|`feat(virtio-gpu): accelerate Ghostty with targeted WebGPU`|
|XWAH-5|`0b8cc576`|`fix(virtio-gpu): harden accelerated Ghostty appliance`|
|XWAH-5|`40794b53`|`fix(appliance): preserve accelerated Codex session`|
|XWAH-5|`491c4b50`|`fix(codex): fall back to direct tools without code mode`|
|XWAH-5|`a6f3829f`|`chore(codex): pin CI-validated i386 artifact`|
|XWAH-5|`8f42ae66`|`fix(codex): enable sandboxed i386 shell execution`|
|XWAH-6|`ffc7db1e`|`fix(codex): disable apps mcp and probe context7`|

Integration points on `main`: `fed57a4c` merged Ghostty WebGPU acceleration,
`76fa734d` merged direct-tool fallback, `60c65042` merged the validated artifact
pin, `c1af225c` merged sandboxed shell execution, `f32bff78` merged remote MCP
support, and `4839842f` consolidated the runtime and local handoff guidance.

## Verification

The browser harness owns its HTTP server. Stop any manual server on port 8082 before running it:

```sh
V86_CODEX_BROWSER_PORT=8082 \
V86_CODEX_RELAY_URL=wss://relay.example.test/ \
make virtio-gpu-codex-browser-test
```

The default matrix runs `webgpu-js` and `wgpu`. For a focused local smoke test after the browser artifacts already exist:

```sh
V86_CODEX_BROWSER_PORT=8082 \
V86_CODEX_BROWSER_RENDERERS=webgpu-js \
./tests/browser/virtio_gpu_codex_acceptance.js
```


For the opt-in targeted Mesa path:

```sh
make virtio-gpu-codex-accelerated-test
```
After changing the guest, browser launcher, standard 2D device, or either renderer, also run:

```sh
make virtio-gpu-unit-test
make virtio-gpu-test
TEST_RELEASE_BUILD=1 ./tests/devices/virtio_gpu.js
```

The acceptance harness checks guest architecture and UID, pinned versions,
hostname, configured IPv4 loopback plus an actual localhost socket bind,
relay/DHCP behavior, Python execution, jq parsing, absence of automatic
Context7 configuration, the expected llvmpipe or `webgpuvirt` renderer, live
Xorg/Openbox/Ghostty and interactive-shell processes, the installed but
non-running Codex binary, full-access launcher policy, writable Codex
configuration, visible scanout, accelerated background uniformity, cursor
alpha, keyboard delivery, responsive layout, absence of desktop packages,
writable workspace, and pristine fresh-session reset.

## MCP Topology

The host-owned `codex_apps` MCP is explicitly disabled with `--disable apps`
whenever the user manually launches Codex. It is not a general MCP switch: the
authenticated Apps/connector catalog was the server that timed out during
paginated `tools/list`, while ordinary configured MCP servers use separate
entries under `mcp_servers`.

The appliance never injects Context7 or another endpoint. A relay URL controls
only guest network availability. Once the relay is configured, add any desired
server explicitly:

```sh
codex mcp add context7 --url https://mcp.context7.com/mcp
codex mcp list
```

The writable `~/.codex/config.toml` retains that configuration until the page
is reset. Browser acceptance performs an actual add/list/remove cycle against
a local inert entry to verify this path without choosing a service or sending
credentials.

`v86-networking` configures `127.0.0.1/8` before the unprivileged session, so
Codex can bind an MCP OAuth listener. An older image that omitted this step
failed with `Address not available (os error 99)`. Loopback binding alone does
not bridge address spaces: a callback to `http://127.0.0.1:<port>/callback`
opened in the host browser targets the host, not the v86 guest. This fixture
therefore does not claim browser OAuth completion; it requires an explicit
callback bridge or a server authentication method that does not depend on a
host-browser localhost redirect.

The i386 archive intentionally omits `/usr/local/bin/codex-code-mode-host` and
its V8 runtime. The launcher disables `code_mode`, `code_mode_only`, and
`code_mode_host`, disables host-owned Apps, enables `shell_tool` and
`unified_exec`, and keeps in-process fallback enabled. It also sets
`--dangerously-bypass-approvals-and-sandbox`; no `--sandbox` option is present.
Readiness checks the launcher, packaged feature states, writable
`/home/codex/.codex`, and absence of a running Codex process.

This does not implement Code Mode, package V8, add credentials, select an MCP
server, or start Codex without an explicit user command.

## Troubleshooting

- **`V86_APPLIANCE_FAILURE=session-exited-after-readiness:0`:** Ghostty exited cleanly because its `/bin/sh` child ended or its window was closed; the GTK, systemd-scope, and on-screen-keyboard warnings are non-fatal. The tty1 session is intentionally one-shot, so use **Reset fresh session** to boot Ghostty again. Avoid `Ctrl+D`, `exit`, or `Alt+F4` when the shell should remain open.
- **`V86_APPLIANCE_FAILURE=network-unavailable` or `udhcpc` obtains no lease:** the configured public relay may be unavailable even though the page can parse its URL. Use **Reset fresh session** to retry or provide a trusted relay; inspect the bounded `/var/log/v86-networking.log` output for missing `eth0` versus exhausted DHCP discovery.
- **`VirtIO NIC relay: unconfigured`:** add a percent-encoded `relay=wss://.../` query parameter, then reload. This status is intentional when no relay was supplied.
- **MCP OAuth reports `Address not available (os error 99)`:** rebuild the image and require `V86_APPLIANCE_LOOPBACK=PASS`; the current boot service configures `127.0.0.1/8` before Codex can start. Host-browser redirects to guest localhost still require an explicit callback bridge.
- **VGA console remains visible:** inspect the serial disclosure for `V86_APPLIANCE_FAILURE`; confirm `/dev/dri/card0` and the `1af4:1050` device.
- **Xorg rejects the display name:** confirm `v86-networking` set `v86-appliance` and both loopback mappings before the tty1 session started.
- **Openbox or Ghostty exits:** inspect `/tmp/v86-appliance.log`, `/tmp/v86-openbox.log`, `/tmp/v86-ghostty.log`, and `/tmp/v86-glxinfo.log` through the bounded serial failure output.
- **Package closure differs:** reconcile the reviewed direct and transitive locks. Never remove the `cmp` check.
- **Browser harness cannot bind port 8082:** stop the manual `python3 -m http.server` instance; the harness starts its own server.
- **Cold boot appears stalled:** software rendering in the emulated i686 guest can take roughly 90–120 seconds. Wait for the serial contract instead of adding arbitrary browser sleeps.
- **Diagonal split across the terminal background:** the renderer is using the
  cell-background shader for the global background. Keep `BackgroundColor`
  separate and run the accelerated acceptance's off-diagonal color probe.
- **Black square around the pointer:** cursor conversion forced X-format alpha
  opaque. Preserve the cursor resource's fourth byte; do not change the
  scanout X-format rule.
- **Codex reports `Read-only file system` for `~/.codex`:** the session is using an old image that still starts Codex under `workspace-write`. Rebuild the image, confirm `V86_APPLIANCE_CODEX_AUTOSTART=DISABLED`, then run `codex` manually from the Ghostty shell. The launcher must contain `--dangerously-bypass-approvals-and-sandbox`.
- **Codex is not visible after boot:** this is intentional. The image now opens an interactive Ghostty shell so configuration can be edited first; type `codex` to start it.
- **Codex cannot run commands:** require
  `V86_APPLIANCE_CODEX_FULL_ACCESS=PASS`,
  `V86_APPLIANCE_CODEX_HOME_WRITABLE=PASS`, and
  `V86_APPLIANCE_NO_CODE_MODE_HOST=PASS`. The image provides `/bin/sh`, not
  Bash. Do not add a fake or V8-backed `codex-code-mode-host`; this fixture
  uses direct tools.

## Cage Sibling Handoff

Alpine 3.24 publishes [`cage` 0.3.0-r0 for `x86`](https://pkgs.alpinelinux.org/package/v3.24/community/x86/cage), so package architecture is not the current gate. Native Ghostty-on-Wayland behavior, software-rendered wlroots operation, input, resize, and lifecycle still require proof in v86.

Implement Cage in `tools/docker/virtio-gpu-alpine-cage-codex/`; do not convert this directory in place. The first Cage change should copy only the minimum reusable image inputs, then give the variant independent names such as:

- image prefix `alpine-virtio-gpu-cage-codex`;
- Docker image/container `v86-virtio-gpu-alpine-cage-codex`;
- Make target `virtio-gpu-cage-codex-image`;
- browser page `examples/virtio_gpu_cage_codex.html`;
- acceptance harness `tests/browser/virtio_gpu_cage_codex_acceptance.js`.

Reuse the already validated Wayland baseline from `tools/docker/virtio-gpu-alpine-desktop/desktop-session`: `WLR_RENDERER=gles2`, `WLR_RENDERER_ALLOW_SOFTWARE=1`, `WLR_DRM_NO_MODIFIERS=1`, `WLR_DRM_DEVICES=/dev/dri/card0`, `WLR_NO_HARDWARE_CURSORS=1`, `LIBGL_ALWAYS_SOFTWARE=1`, and `LIBSEAT_BACKEND=seatd`. Treat these as starting evidence, not as a reason to skip a Cage-specific runtime test.

The Cage fixture must:

1. pin Cage and its complete `x86` package closure independently;
2. start an unprivileged UID 1000 Wayland session on tty1 through seatd;
3. prove a live Wayland socket, Cage, native Ghostty, Codex, keyboard input, resize, and visible scanout;
4. prove that Xorg, Openbox, Xwayland, XFCE, and display-manager processes and packages are absent;
5. retain the same artifact verification, credential, relay, fresh-reset, and external-isolation rules;
6. use distinct readiness markers that name Wayland and Cage instead of reusing `XORG=PASS` or `OPENBOX=PASS`;
7. run beside this Openbox reference without overwriting its generated files, URL, test profile, or port selection;
8. compare image and cold-boot measurements against this fixture before claiming improvement.

Do not delete this directory, remove its Make target, or weaken its acceptance checks as Cage cleanup. The Openbox appliance is the compatibility baseline and rollback path; Cage is an additional kiosk implementation.