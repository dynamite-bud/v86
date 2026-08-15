# Openbox, Ghostty, and Codex Appliance

Status: **IMPLEMENTED**

[XWAH-3](https://github.com/dynamite-bud/v86/issues/3) originally required Ghostty and OMP. Gate 0 proved that the original chain cannot run in v86: v86 has no x86-64 guest support, OMP and Bun publish no i386 runtime, and Alpine publishes Ghostty only for x86_64 and aarch64. The approved scope replaces OMP with a pinned downstream i386 Codex port. This does not add x86-64 support or claim upstream i386 support for either application.

## Architecture and Artifact Evidence

The appliance remains Alpine Linux 3.24.1 on `linux/386`, matching v86's supported guest architecture. It uses two downstream artifacts:

|Application|Pinned release|Archive size|Archive SHA-256|Installed executable size|Installed executable SHA-256|
|---|---:|---:|---|---:|---|
|Ghostty|[`v1.3.1-i386.1`](https://github.com/dynamite-bud/ghostty/releases/tag/v1.3.1-i386.1)|16,930,924 bytes|`73391e2ea610e76d419b85634943877e98dcf1e0d412c03d2f0fc5662556114e`|22,209,904 bytes|`99930b1e0f6c13d318d13ed2e29bb8045cd440264d5e2b34900a2fe8d6dafa8a`|
|Codex|[`rust-v0.147.0-i386.1`](https://github.com/dynamite-bud/codex/releases/tag/rust-v0.147.0-i386.1)|33,010,567 bytes|`e26bae168d40474d976eb272c48ef86b8acd86bfb3028e9e83060d8f18855438`|70,069,640 bytes|`ddcf34dba92dcd4c6549325011ccb2b7e1832a98c91467e822034eed2120f9e4`|

Ghostty was cross-compiled for `x86-linux-musl` against an Alpine x86 sysroot. The release workflow and complete patch stack are on the Ghostty fork's `i386` branch. Its release artifact starts under Alpine `linux/386` and reports Ghostty 1.3.1.

Codex was cross-compiled from upstream `rust-v0.147.0` for `i686-unknown-linux-musl`. The fork's `i386` branch contains the complete patch stack, pinned Rust 1.95.0 and Zig 0.15.2 workflow, reproducible packaging, and a recurring upstream-update path. Validation run [31605548346](https://github.com/dynamite-bud/codex/actions/runs/31605548346) compiled the exact release commit and smoke-tested the artifact in Alpine `linux/386`.

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

The browser page does not hardcode a relay. Supply a WISP/wsproxy relay with the `relay` query parameter:

```text
http://127.0.0.1:8082/examples/virtio_gpu_codex.html?renderer=webgpu-js&relay=wss%3A%2F%2Frelay.example.test%2F
```

When supplied, v86 creates a VirtIO NIC and the privileged OpenRC boot service performs DHCP before the unprivileged graphical session starts. Readiness requires an IPv4 lease. Browser acceptance then verifies CA-validated HTTPS from the guest. When omitted, the guest emits `V86_APPLIANCE_NETWORK=UNCONFIGURED` and still starts the local Codex UI; it never reports network success.

For local verification, use port **8082**:

```sh
python3 -m http.server 8082 --bind 127.0.0.1
```

## Readiness and Failure Contract

The tty1 session writes bounded evidence to `ttyS0`:

- architecture, UID, deterministic hostname, and kernel;
- Ghostty and Codex versions;
- `/dev/dri/card0`;
- `NETWORK=PASS` or `NETWORK=UNCONFIGURED`;
- the selected Mesa renderer, `llvmpipe` by default or `webgpuvirt` when
  acceleration is explicit;
- live Openbox, Ghostty, and Codex processes plus the checked direct-tool
  launcher arguments;
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
- supplied-relay DHCP and CA-validated HTTPS, or an honest unconfigured state;
- absence of XFCE, its panel/session/desktop, Thunar, `xfce4-terminal`, Tumbler, Garcon, and Exo;
- unconfigured Codex login with no baked home credential;
- browser keyboard delivery and responsive narrow layout;
- a writable workspace and pristine fresh-session reset on the direct JavaScript backend;
- live Codex process arguments that disable Code Mode and its host, enable
  direct shell/unified execution, and retain in-process fallback;
- verified absence of the external Code Mode host and its V8 runtime;
- a direct `/bin/sh` command executed through `codex sandbox --`, proving
  Bubblewrap enforces the filesystem sandbox while the
  unavailable i386 network seccomp backend is bypassed without aborting;
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

## Observed Authenticated Run and Direct Tools

An authenticated run through a configured relay reached `gpt-5.6-sol` and
returned a normal Codex response from `/home/codex/workspace`. It also exposed
two application-level limitations:

- `codex_apps` MCP startup timed out during `tools/list` pagination after 30
  seconds. The normal model response still completed.
- The initial launcher requested Code Mode even though
  `/usr/local/bin/codex-code-mode-host` is absent, so command dispatch failed
  closed. The pinned release publishes only the main Codex archive and its
  checksum.

The corrected launcher explicitly disables `code_mode`, `code_mode_only`, and
`code_mode_host`; enables `shell_tool` and `unified_exec`; and sets
`code_mode.disable_in_process_fallback=false`. Readiness inspects the live
process arguments and emits `V86_APPLIANCE_CODEX_EXEC_FLAGS=PASS`. The exact
i386 binary reports the three Code Mode features disabled and both direct-tool
features enabled. This restores the supported direct command path; it does not
fabricate or claim a Code Mode host.

The clean-image acceptance remains deliberately unauthenticated, so
model-mediated command execution still requires user-supplied login after
boot. No credential is persisted or baked into the image.

These application warnings are not appliance readiness successes and are not
hidden by the serial contract. [XWAH-6](https://github.com/dynamite-bud/v86/issues/6),
a child of XWAH-3, tracks a real i686 Code Mode host and bounded MCP pagination
diagnosis. External MCP readiness needs its own bounded acceptance scenario
rather than a longer appliance boot timeout.

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
|Compressed flat files|279,267,802|295,224,610|-15,956,808 bytes|5.40%|
|Filesystem JSON|581,407|695,517|-114,110 bytes|16.41%|
|Flat-file count|7,951|9,175|-1,224|13.34%|
|Package closure|311|420|-109|25.95%|

These values come from the generated image contracts and package locks.
Release-stripping reduced the custom Gallium library from 84,857,252 to
20,394,120 bytes and its DRI object from 2,747,252 to 95,600 bytes. Default
boots keep Alpine's system Gallium file in place; accelerated boot replaces it
once, so the image carries no duplicate system backup. Recompute this evidence
after any image, package, or artifact change.

The final reproducible XWAH-5 rebuild produced these SHA-256 values:

|Artifact|SHA-256|
|---|---|
|Rootfs tar|`34da3e74563d830c8d1befc918ecc0a10e053025dc51ac9f4b0393b51faecd3c`|
|Filesystem JSON|`06b1075e00a9a7a7cfb98a30676858d43eef2b6f3cf3842df96593baadce372c`|
|Flat-file manifest|`4aca0a2a8bdec0190a8ae1c05445ef7965c2f2bafcd8e0e8570acfaa1ad97122`|
|Image contract|`ad0d74e91903fb6410a3d54aaef2a5cb7a1e3260d4f391bf17fe759ba76ae7d5`|

## Original OMP Gate

The original OMP requirement remains infeasible without a separate prerequisite project:

- v86 emulates roughly Pentium 4/SSE3 and does not implement x86-64 guest mode;
- OMP's installer and Linux releases support x64 and arm64, not i386;
- OMP source installation requires Bun, whose Linux runtime and compile targets are x64 or arm64;
- moving OMP outside the guest or shipping an installer stub would not satisfy the original boot chain.

Restoring Ghostty → OMP scope therefore requires either verified v86 x86-64 support or a supported, fully functional i386 OMP runtime.
