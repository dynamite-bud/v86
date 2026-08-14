# Openbox, Ghostty, and Codex Appliance

Status: **IMPLEMENTED**

[XWAH-3](https://github.com/dynamite-bud/v86/issues/3) originally required Ghostty and OMP. Gate 0 proved that the original chain cannot run in v86: v86 has no x86-64 guest support, OMP and Bun publish no i386 runtime, and Alpine publishes Ghostty only for x86_64 and aarch64. The approved scope replaces OMP with a pinned downstream i386 Codex port. This does not add x86-64 support or claim upstream i386 support for either application.

## Architecture and Artifact Evidence

The appliance remains Alpine Linux 3.24.1 on `linux/386`, matching v86's supported guest architecture. It uses two downstream artifacts:

|Application|Pinned release|Compressed size|Installed executable|SHA-256|
|---|---:|---:|---:|---|
|Ghostty|[`v1.3.1-i386`](https://github.com/dynamite-bud/ghostty/releases/tag/v1.3.1-i386)|16,931,023 bytes|22,209,744 bytes|`a52ecaef55ea16c45d1ea154ca93674f0859a597280480303e96346110b0c64c`|
|Codex|[`rust-v0.147.0-i386.1`](https://github.com/dynamite-bud/codex/releases/tag/rust-v0.147.0-i386.1)|33,010,567 bytes|70,069,640 bytes|`e26bae168d40474d976eb272c48ef86b8acd86bfb3028e9e83060d8f18855438`|

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
  -> Mesa llvmpipe OpenGL
  -> maximized undecorated Ghostty
  -> Codex
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
- the Mesa renderer, which must contain `llvmpipe`;
- live Openbox, Ghostty, and Codex processes;
- final `V86_APPLIANCE_READY=PASS` or a precise failure reason.

The page declares success only after the guest PASS marker and a visible WebGPU scanout. Xorg, Openbox, Ghostty, and GL logs are copied to serial on startup failure.

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
- a writable workspace and pristine fresh-session reset on the direct JavaScript backend.

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

Reproduce either result on port 8082:

```sh
V86_CODEX_BROWSER_OUTPUT=tests/benchmark/baselines/ghostty-llvmpipe-wgpu-apple-m4.json \
V86_CODEX_BENCHMARK_MACHINE=apple-m4-10c \
make virtio-gpu-codex-benchmark

V86_CODEX_BROWSER_OUTPUT=tests/benchmark/baselines/ghostty-webgpuvirt-wgpu-apple-m4.json \
V86_CODEX_BENCHMARK_MACHINE=apple-m4-10c \
make virtio-gpu-codex-benchmark-accelerated
```

## Observed Authenticated Run

An authenticated run through a configured relay reached `gpt-5.6-sol` and returned a normal Codex response from `/home/codex/workspace`. It also exposed two application-level limitations:

- `codex_apps` MCP startup timed out during `tools/list` pagination after 30 seconds. The normal model response still completed.
- Code Mode failed closed because `/usr/local/bin/codex-code-mode-host` is absent. The pinned downstream release publishes only the main Codex archive and its checksum; the appliance does not fabricate a host executable or suppress the warning.

These are not appliance readiness successes and are not hidden by the serial contract. [XWAH-6](https://github.com/dynamite-bud/v86/issues/6), a child of XWAH-3, tracks the real i686 Code Mode host and bounded MCP pagination diagnosis. A future i386 Codex release must build, package, checksum, and exercise the real Code Mode host before that feature is enabled. External MCP readiness needs its own bounded acceptance scenario rather than a longer appliance boot timeout.

## Cage Sibling Boundary

Alpine 3.24 publishes [`cage` 0.3.0-r0 for `x86`](https://pkgs.alpinelinux.org/package/v3.24/community/x86/cage). Package availability is therefore established; native Ghostty Wayland behavior, software-rendered wlroots operation, input, resize, and lifecycle remain unproven in v86.

Add Cage as `tools/docker/virtio-gpu-alpine-cage-codex/`, beside this implementation. It must have independent `alpine-virtio-gpu-cage-codex` generated artifacts, a Make target, browser page, serial markers, and acceptance harness. Do not rename this directory, reuse its output paths, replace its Xorg/Openbox package locks, or remove its tests.

The Cage session should begin from the environment already proven by the XFCE/labwc Wayland fixture: software GLES, DRM modifiers disabled, `/dev/dri/card0`, software cursors, and seatd. Cage acceptance must then prove a live Wayland socket, Cage, native Ghostty, Codex, keyboard input, resize, visible scanout, and the absence of Xorg, Openbox, Xwayland, XFCE, and a display manager.

Cleanup for the Cage phase means removing temporary probes, generated images, stale package entries, and duplicated dead startup paths. It does **not** mean deleting this Openbox reference. Keep both variants runnable so Cage has a compatibility baseline, rollback path, and measurable image/boot comparison. The detailed file naming and handoff checklist are in the [Openbox fixture README](../../tools/docker/virtio-gpu-alpine-codex/Readme.md#cage-sibling-handoff).

## Size Evidence

The generated Codex appliance is smaller than the retained XFCE fixture:

|Artifact|Codex appliance|XFCE fixture|Delta|Reduction|
|---|---:|---:|---:|---:|
|Rootfs tar|676,556,800|794,818,560|-118,261,760 bytes|14.88%|
|Compressed flat files|275,304,359|295,224,610|-19,920,251 bytes|6.75%|
|Filesystem JSON|580,889|695,517|-114,628 bytes|16.48%|
|Flat-file count|7,946|9,175|-1,229|13.40%|
|Package closure|311|420|-109|25.95%|

These values come from the generated image contracts and package locks. Recompute them after any image, package, or artifact change.

The reproducible capset-probe rebuild produced these SHA-256 values:

|Artifact|SHA-256|
|---|---|
|Rootfs tar|`a417a48cc7a167c589703d76495954dfe577e86d9e0bbf3c0b83af60aa907344`|
|Filesystem JSON|`3bdc02a9f78f8ac6b388e174da331aac84a2771009cb91d41bd7d9d59b099a21`|
|Flat-file manifest|`b211ea07ad06429249db9633ceb871e768c8612bc43b9fb47a67c61be7c0d759`|
|Image contract|`e6cc7fda37e4a63f1270efb88febcf1dc38649ff8e053f30777a563c8aa4d228`|

## Original OMP Gate

The original OMP requirement remains infeasible without a separate prerequisite project:

- v86 emulates roughly Pentium 4/SSE3 and does not implement x86-64 guest mode;
- OMP's installer and Linux releases support x64 and arm64, not i386;
- OMP source installation requires Bun, whose Linux runtime and compile targets are x64 or arm64;
- moving OMP outside the guest or shipping an installer stub would not satisfy the original boot chain.

Restoring Ghostty → OMP scope therefore requires either verified v86 x86-64 support or a supported, fully functional i386 OMP runtime.
