# Openbox, Ghostty, and Codex Appliance

Status: **IMPLEMENTED — XWAH-5 and XWAH-6 consolidated**

[XWAH-3](https://github.com/dynamite-bud/v86/issues/3) originally required Ghostty and OMP. Gate 0 proved that the original chain cannot run in v86: v86 has no x86-64 guest support, OMP and Bun publish no i386 runtime, and Alpine publishes Ghostty only for x86_64 and aarch64. The approved scope replaces OMP with a pinned downstream i386 Codex port. This does not add x86-64 support or claim upstream i386 support for either application.

## Architecture and Artifact Evidence

The appliance remains Alpine Linux 3.24.1 on `linux/386`, matching v86's supported guest architecture. It uses two downstream artifacts:

|Application|Pinned release|Archive size|Archive SHA-256|Installed executable size|Installed executable SHA-256|
|---|---:|---:|---|---:|---|
|Ghostty|[`v1.3.1-i386.1`](https://github.com/dynamite-bud/ghostty/releases/tag/v1.3.1-i386.1)|16,930,924 bytes|`73391e2ea610e76d419b85634943877e98dcf1e0d412c03d2f0fc5662556114e`|22,209,904 bytes|`99930b1e0f6c13d318d13ed2e29bb8045cd440264d5e2b34900a2fe8d6dafa8a`|
|Codex|[`rust-v0.147.0-i386.3`](https://github.com/dynamite-bud/codex/releases/tag/rust-v0.147.0-i386.3)|33,010,114 bytes|`592c7b39a9910d3fc7d84879ff7355cb268c007f0454d050e72bf7fa8183a5b1`|70,069,640 bytes|`497bce02b22458cbfddf9e182245c72ea46ffc57cbac70e69077a0dc07f6a19c`|

Ghostty was cross-compiled for `x86-linux-musl` against an Alpine x86 sysroot. The release workflow and complete patch stack are on the Ghostty fork's `i386` branch. Its release artifact starts under Alpine `linux/386` and reports Ghostty 1.3.1.

Codex was cross-compiled from upstream `rust-v0.147.0` for `i686-unknown-linux-musl`. The fork's `i386` branch contains the complete patch stack, pinned Rust 1.95.0 and Zig 0.15.2 workflow, reproducible packaging, recurring upstream updates, and the i386 sandbox correction. Validation run [31892304999](https://github.com/dynamite-bud/codex/actions/runs/31892304999) compiled release commit `a5f4a008a657b497b7361db547bf86269aeba1bf` and smoke-tested the exact artifact in Alpine `linux/386`.

Codex's standard Linux network seccomp filter is unavailable on i386 because its seccompiler dependency does not support 32-bit x86. The appliance selects Codex's `workspace-write` filesystem sandbox with no interactive approvals, but model-generated commands do not receive Codex's usual network seccomp isolation. Use the port only inside an external isolation boundary such as this disposable v86 guest. No model credential is included in the image.

## Image Contract

`tools/docker/virtio-gpu-alpine-codex/` owns the separate Xorg/Openbox reference image. Its [implementation README](../../tools/docker/virtio-gpu-alpine-codex/Readme.md) documents every source file, the reproducible build, launch and verification commands, security boundaries, troubleshooting, and the Cage sibling handoff. This fixture does not replace or weaken the XFCE graphics regression image, and future Cage work must not convert it in place.

The boot chain is:

```text
Alpine OpenRC
  -> unprivileged codex user on tty1
  -> Xorg modesetting driver at 1024x768x24
  -> Openbox
  -> Mesa llvmpipe (default) or targeted webgpuvirt (explicit acceleration)
  -> maximized undecorated Ghostty
  -> Codex with direct shell/unified-exec tools
```

The image pins:

- the Alpine base image by digest;
- every installed APK and version in `packages.lock`;
- the direct APK world in `world.lock`;
- Ghostty and Codex release URLs, tags, and SHA-256 values in `artifacts.lock`;
- the generated filesystem JSON, flat-file manifest, rootfs tar, package lock, kernel, and base image in the image contract.

The `codex` user is UID 1000. `/home/codex` and `/home/codex/workspace` retain numeric UID/GID ownership through deterministic rootfs normalization. Root login is locked, no display manager is installed, and the image contains no Codex `auth.json`.

Build the fixture:

```sh
make virtio-gpu-codex-image
```

Generated artifacts are ignored under `images/`:

- `alpine-virtio-gpu-codex-rootfs.tar`
- `alpine-virtio-gpu-codex-fs.json`
- `alpine-virtio-gpu-codex-rootfs-flat/`
- `alpine-virtio-gpu-codex-image-contract.json`

Treat these four outputs as one indivisible local contract. When moving a
runnable appliance between worktrees, copy the tar, filesystem JSON,
content-addressed flat-file directory, and image contract together; mixing
generations can pair a filesystem index with missing or stale chunks.

## Implementation Method

The work followed a gated, reproducible path rather than modifying the existing desktop fixture:

1. Gate 0 checked v86 and upstream application architectures before image work. This rejected the impossible x86-64 OMP chain instead of hiding it behind a stub.
2. Ghostty and Codex were ported and released independently on their forks. The appliance consumes immutable release archives; it does not compile either application during the image build.
3. A separate Alpine `linux/386` image retained the proven kernel, VirtIO GPU KMS, Mesa, and browser presentation path while removing XFCE and adding only the Openbox kiosk session.
4. `world.lock` records deliberate direct APK inputs. `packages.lock` records the full installed closure, and the Docker build fails on any closure drift.
5. Docker exports the root filesystem, then `normalize_rootfs.py --preserve-owners` sorts entries, clears timestamps and owner names, removes Docker metadata, and retains numeric UID/GID ownership for the unprivileged session.
6. The page adds the fixture as an isolated browser entry point. A relay is opt-in, and a supplied relay becomes a VirtIO NIC plus guest DHCP rather than an implicit host network dependency.
7. Bounded serial markers make architecture, privileges, networking, rendering, and every live process observable. Browser acceptance requires both those markers and a visible WebGPU scanout.

This structure keeps downloaded application artifacts, guest assembly, emulator presentation, and browser acceptance independently reviewable.

## Networking

The browser page does not hardcode a relay. The consolidated XWAH-5/XWAH-6
mode uses the Rust/Wasm `wgpu` host renderer, explicit guest `webgpuvirt`
acceleration, and a percent-encoded WISP/wsproxy relay:

```text
http://127.0.0.1:8082/examples/virtio_gpu_codex.html?renderer=wgpu&accelerated=1&relay=wss%3A%2F%2Frelay.example.test%2F
```

`renderer=wgpu` selects the browser-side Rust/Wasm backend;
`accelerated=1` selects the checksum-locked Mesa `webgpuvirt` renderer inside
the guest. When a relay is supplied, v86 creates a VirtIO NIC and the
privileged OpenRC service obtains DHCP, performs the Context7 MCP 2025-06-18
initialization handshake, and verifies `resolve-library-id` plus `query-docs`
in `tools/list` before the unprivileged graphical session starts. The same
Context7 URL is then added to Codex as an ordinary configured MCP server.
Without a relay, the NIC and remote MCP entry are omitted; readiness reports
both network and Context7 as `UNCONFIGURED` and still starts the local UI.

For local verification, use port **8082**:

```sh
python3 -m http.server 8082 --bind 127.0.0.1
```

## Readiness and Failure Contract

The tty1 session writes bounded evidence to `ttyS0`:

- architecture, UID, deterministic hostname, and kernel;
- Ghostty and Codex versions;
- `/dev/dri/card0`;
- `NETWORK=PASS|UNCONFIGURED` and
  `MCP_CONTEXT7=PASS|UNCONFIGURED`;
- the selected Mesa renderer, `llvmpipe` by default or `webgpuvirt` when
  acceleration is explicit;
- live Openbox, Ghostty, and Codex processes, checked direct-tool and remote
  MCP launcher arguments, `CODEX_APPS=DISABLED`, and a direct sandboxed shell;
- final `V86_APPLIANCE_READY=PASS` or a precise failure reason.

The page declares success only after the guest PASS marker and a visible WebGPU
scanout. Accelerated acceptance additionally compares dominant background
colors on both sides of the screen diagonal and requires both transparent and
opaque cursor pixels. Xorg, Openbox, Ghostty, and GL logs are copied to serial
on startup failure.

## Browser Acceptance

Build the browser artifacts and run both host renderers:

```sh
V86_CODEX_BROWSER_PORT=8082 \
V86_CODEX_RELAY_URL=wss://relay.example.test/ \
make virtio-gpu-codex-browser-test
```

The acceptance harness verifies:

- i686 guest and UID 1000 session;
- exact application versions;
- llvmpipe OpenGL plus visible 1024x768 scanout;
- Xorg, Openbox, Ghostty, and Codex processes;
- supplied-relay DHCP, CA-validated HTTPS, and the Context7 MCP handshake/tool
  list, or an honest unconfigured network/MCP state;
- absence of XFCE, its panel/session/desktop, Thunar, `xfce4-terminal`,
  Tumbler, Garcon, and Exo;
- unconfigured Codex login with no baked home credential;
- browser keyboard delivery and responsive narrow layout;
- a writable workspace and pristine fresh-session reset on the direct
  JavaScript backend;
- live Codex process arguments that disable Code Mode, its absent host, and
  host-owned Codex Apps; enable direct shell/unified execution; retain
  in-process fallback; and configure Context7 only when a relay exists;
- verified absence of the external Code Mode host and its V8 runtime;
- a direct `/bin/sh` command executed through `codex sandbox --`, proving
  Bubblewrap enforces the filesystem sandbox while the unavailable i386
  network seccomp backend is bypassed without aborting;
- a uniform accelerated terminal background and a non-rectangular,
  alpha-masked hardware cursor.

The fresh-session reset is intentionally ephemeral: it discards guest changes. This appliance does not persist API credentials or workspace data across reloads.

## XWAH-5 Rendering Benchmark

The opt-in benchmark launches a fixed ANSI stream inside the same maximized
Ghostty window, performs two warmups followed by five keyboard-triggered
measured runs, and preserves the normal 2D/llvmpipe appliance as the control.
The browser records graphical readiness, aggregate non-idle guest CPU ticks,
keystroke-to-first-present latency, text/scroll throughput, VirtIO GPU counters,
frame cadence, timer delay, long tasks, WebGPU diagnostics, and a full-canvas
SHA-256 reference.

The same Apple M4/Chrome 151 host recorded both committed results:

- `tests/benchmark/baselines/ghostty-llvmpipe-wgpu-apple-m4.json`
- `tests/benchmark/baselines/ghostty-webgpuvirt-wgpu-apple-m4.json`

|Metric|llvmpipe|`webgpuvirt`|Change|
|---|---:|---:|---:|
|Graphical readiness|91,743 ms|42,769.9 ms|53.4% lower|
|Guest CPU p50 / p95|1,900 / 3,250 ms|330 / 360 ms|82.6% / 88.9% lower|
|Keystroke-to-first-present p50 / p95|1,478 / 1,877.4 ms|238.1 / 285.3 ms|83.9% / 84.8% lower|
|Scroll throughput p50|362.65 lines/s|1,633.15 lines/s|350.3% higher|
|Text throughput p50|0.03768 MiB/s|0.16969 MiB/s|350.3% higher|
|Browser long tasks|0|0|no regression|
|Invalid commands / backend errors|0 / 0|0 / 0|no regression|
|Terminal reference SHA-256|`bbd05cf6097ac9b1f89ea29d2542c1b7b67ee46848393895f5a9e43fa1f621e5`|same|identical|

The accelerated run clears XWAH-5's performance gate on both primary metrics:
guest CPU p50 falls by 82.6% and keystroke-to-present p95 falls by 84.8%.
Every accelerated measured run retained the reference hash, completed all
fences, and reported zero invalid commands, backend errors, WebGPU validation
errors, and long tasks. The path remains explicit and off by default; this
result does not advertise general OpenGL, virgl, or Vulkan compatibility.

### Visual correctness corrections

The first accelerated interactive capture exposed two translation bugs that
the original single-pixel readiness gate could not detect:

- A diagonal two-tone terminal background came from translating Ghostty's
  uniform whole-window background as a storage-buffer-driven cell-background
  draw. The renderer now classifies those programs separately and renders the
  former with a synthetic full-screen triangle.
- A black 64x64 pointer square came from forcing X-format cursor alpha opaque.
  Scanout X formats remain opaque, but cursor conversion now preserves the
  fourth guest byte as the cursor mask.

The accelerated browser gate samples 2,042 interior points in opposing
triangular regions. The corrected run reported the same dominant
`[16, 18, 22]` RGB value in both regions with `max_delta: 0`; the 64x64 cursor
contained 4,002 transparent and 94 opaque pixels. The page reached
`V86_APPLIANCE_READY=PASS` with no browser console or WebGPU validation errors.
These are output contracts, not screenshot-only observations.

Reproduce either result on port 8082:

```sh
V86_CODEX_BROWSER_OUTPUT=tests/benchmark/baselines/ghostty-llvmpipe-wgpu-apple-m4.json \
V86_CODEX_BENCHMARK_MACHINE=apple-m4-10c \
make virtio-gpu-codex-benchmark

V86_CODEX_BROWSER_OUTPUT=tests/benchmark/baselines/ghostty-webgpuvirt-wgpu-apple-m4.json \
V86_CODEX_BENCHMARK_MACHINE=apple-m4-10c \
make virtio-gpu-codex-benchmark-accelerated
```

The benchmark does not gate startup on a pre-run scanout readback: an idle
terminal may have no further dirty frame after the guest emits
`V86_APPLIANCE_READY=PASS`, which previously caused a false 300-second
readiness timeout. Benchmark readiness uses the guest marker and visible
canvas; every measured run must then report nonzero WebGPU presentations and
presented bytes. The interactive accelerated scenario retains the stricter
uniform-background pixel probe.

## Consolidated XWAH-5/XWAH-6 Runtime

XWAH-5 supplies the explicit accelerated graphics path: browser-side
Rust/Wasm `wgpu`, guest-side Mesa `webgpuvirt`, standard VirtIO GPU 2D scanout,
the measured Ghostty command subset, uniform full-window background handling,
and alpha-preserving cursor conversion. It remains opt-in through
`accelerated=1`; normal boots retain llvmpipe.

XWAH-6 classifies the host-owned `codex_apps` service as unsupported in this
i386 appliance and disables it with `--disable apps`. This is not a global MCP
disable. With a relay, Codex receives a separate
`mcp_servers.context7.url="https://mcp.context7.com/mcp"` entry after the guest
has completed a real MCP initialization and tool-list preflight. Without a
relay, that entry is omitted so offline startup does not wait for an
unreachable server.

The launcher also disables `code_mode`, `code_mode_only`, and
`code_mode_host`; enables `shell_tool` and `unified_exec`; and sets
`code_mode.disable_in_process_fallback=false`. The pinned i386 binary reports
Codex Apps and all three Code Mode features disabled, both direct-tool
features enabled, and no external Code Mode host. Readiness verifies the live
arguments and executes `/bin/sh` through `codex sandbox --`.

The combined browser run on port 8082 has been observed with:

```text
V86_APPLIANCE_NETWORK=PASS
V86_APPLIANCE_MCP_CONTEXT7=PASS
V86_APPLIANCE_RENDERER=webgpuvirt (v86 WebGPU)
V86_APPLIANCE_OPENGL=4.3 (Compatibility Profile) Mesa 26.1.6 (git-ffa422e53d)
V86_APPLIANCE_CODEX_EXEC_FLAGS=PASS
V86_APPLIANCE_CODEX_APPS=DISABLED
V86_APPLIANCE_CODEX_DIRECT_SHELL=PASS
V86_APPLIANCE_READY=PASS
```

This proves the guest DNS/TCP/TLS/HTTP path, MCP protocol initialization and
tool discovery, graphics selection, and launcher contract. It does not claim
that an authenticated model invoked a Context7 tool. Authentication remains
user-provided and ephemeral; no credential or authenticated home directory is
part of the image.

## Measured Follow-up Map

XWAH-5 is the committed correctness and performance control. Follow-up work is
split by ownership so a change cannot silently trade one bottleneck for
another:

The five accelerated raw runs establish this median GPU-side profile for one
58,399-byte terminal workload:

|Measured item|Median|Primary owner|
|---|---:|---|
|VirtIO GPU commands|40|XWAH-24/XWAH-27|
|Fenced commands|37|XWAH-27|
|`TRANSFER_TO_HOST_3D` uploads|21|XWAH-24|
|Uploaded bytes|9,692,936 (9.24 MiB)|XWAH-24|
|`SUBMIT_3D` commands|12|XWAH-24/XWAH-26/XWAH-27|
|`TRANSFER_FROM_HOST_3D` readbacks|4|XWAH-25|
|Presentations|3|XWAH-23|
|Fence wait / final present enqueue|18.5 / 0.1 ms|XWAH-27 / host already negligible|

This distinguishes the remaining command, copy, and guest synchronization work
from browser presentation. It does not support replacing correctness gates
with a host-only shortcut.

- [XWAH-23](https://github.com/dynamite-bud/v86/issues/23): fullscreen direct
  scanout/page-flip eligibility.
- [XWAH-24](https://github.com/dynamite-bud/v86/issues/24): resident BOs and
  dirty-range upload batching.
- [XWAH-25](https://github.com/dynamite-bud/v86/issues/25): evidence and
  removal of avoidable GPU readbacks.
- [XWAH-26](https://github.com/dynamite-bud/v86/issues/26): bounded,
  generation-safe renderer-object caches.
- [XWAH-27](https://github.com/dynamite-bud/v86/issues/27): frame fences,
  descriptor draining, and queue notifications.
- [XWAH-28](https://github.com/dynamite-bud/v86/issues/28): a separate
  host-rendered terminal transport investigation.

Each issue requires five-run evidence, the unchanged terminal SHA-256, bounded
resource ownership, deterministic reset/device-loss cleanup, and a no-go result
when the proposed complexity does not produce a material improvement.

## Cage Sibling Boundary

Alpine 3.24 publishes [`cage` 0.3.0-r0 for `x86`](https://pkgs.alpinelinux.org/package/v3.24/community/x86/cage). Package availability is therefore established; native Ghostty Wayland behavior, software-rendered wlroots operation, input, resize, and lifecycle remain unproven in v86.

Add Cage as `tools/docker/virtio-gpu-alpine-cage-codex/`, beside this implementation. It must have independent `alpine-virtio-gpu-cage-codex` generated artifacts, a Make target, browser page, serial markers, and acceptance harness. Do not rename this directory, reuse its output paths, replace its Xorg/Openbox package locks, or remove its tests.

The Cage session should begin from the environment already proven by the XFCE/labwc Wayland fixture: software GLES, DRM modifiers disabled, `/dev/dri/card0`, software cursors, and seatd. Cage acceptance must then prove a live Wayland socket, Cage, native Ghostty, Codex, keyboard input, resize, visible scanout, and the absence of Xorg, Openbox, Xwayland, XFCE, and a display manager.

Cleanup for the Cage phase means removing temporary probes, generated images, stale package entries, and duplicated dead startup paths. It does **not** mean deleting this Openbox reference. Keep both variants runnable so Cage has a compatibility baseline, rollback path, and measurable image/boot comparison. The detailed file naming and handoff checklist are in the [Openbox fixture README](../../tools/docker/virtio-gpu-alpine-codex/Readme.md#cage-sibling-handoff).

## Size Evidence

The generated Codex appliance is smaller than the retained XFCE fixture:

|Artifact|Codex appliance|XFCE fixture|Delta|Reduction|
|---|---:|---:|---:|---:|
|Rootfs tar|697,118,720|794,818,560|-97,699,840 bytes|12.29%|
|Compressed flat files|279,268,428|295,224,610|-15,956,182 bytes|5.40%|
|Filesystem JSON|581,461|695,517|-114,056 bytes|16.40%|
|Flat-file count|7,952|9,175|-1,223|13.33%|
|Package closure|311|420|-109|25.95%|

These values come from the generated image contracts and package locks.
Release-stripping reduced the custom Gallium library from 84,857,252 to
20,394,120 bytes and its DRI object from 2,747,252 to 95,600 bytes. Default
boots keep Alpine's system Gallium file in place; accelerated boot replaces it
once, so the image carries no duplicate system backup. Recompute this evidence
after any image, package, or artifact change.

The final reproducible XWAH-6 rebuild produced these SHA-256 values:

|Artifact|SHA-256|
|---|---|
|Rootfs tar|`9b5e4acf5c835bf0c928445997a70d0028fc70e50180e44e917efb3c9f072d6f`|
|Filesystem JSON|`002fba95c60d0953999951e8ff5656eaebe404d3e654fa58bcad6a94f558432d`|
|Flat-file manifest|`3dce79927661de5623f908f3690fca94d3cdbdb961c6ca44a48578ea0c9743c5`|
|Image contract|`d2d75fa457c5cda86f82d68afc114c13c556c44008ad51f6127d785760e843e7`|

## Original OMP Gate

The original OMP requirement remains infeasible without a separate prerequisite project:

- v86 emulates roughly Pentium 4/SSE3 and does not implement x86-64 guest mode;
- OMP's installer and Linux releases support x64 and arm64, not i386;
- OMP source installation requires Bun, whose Linux runtime and compile targets are x64 or arm64;
- moving OMP outside the guest or shipping an installer stub would not satisfy the original boot chain.

Restoring Ghostty → OMP scope therefore requires either verified v86 x86-64 support or a supported, fully functional i386 OMP runtime.
