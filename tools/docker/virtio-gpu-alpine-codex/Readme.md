# Alpine i386 Openbox Ghostty Codex Appliance

This directory is the reproducible **Xorg/Openbox reference appliance** for the i386 Ghostty and Codex work tracked in [XWAH-3](https://github.com/dynamite-bud/v86/issues/3). It boots directly into Codex inside a maximized, undecorated Ghostty window while retaining v86's standard VirtIO GPU 2D protocol and either browser WebGPU presentation backend.

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
  -> maximized undecorated Ghostty
  -> codex --sandbox workspace-write --ask-for-approval never
       --disable code_mode --disable code_mode_only --disable code_mode_host
       --enable shell_tool --enable unified_exec
       -c code_mode.disable_in_process_fallback=false
```

The default guest remains software-rendered and uses standard VirtIO GPU 2D scanout with either browser presentation backend. The opt-in `accelerated=1` mode is available only with the Rust/Wasm `wgpu` backend: Linux negotiates capset 7, the targeted `webgpuvirt` Gallium winsys emits the measured Ghostty command subset, and the standard 2D path still presents the completed scanout. The direct JavaScript backend remains 2D-only. This is not general OpenGL, Vulkan, virgl, or virgl2 support.

## Architecture Decision

v86 is a 32-bit x86 emulator and cannot run the upstream x86-64 Ghostty, Codex, OMP, Bun, or Linux artifacts requested by the original XWAH-3 contract. The implemented appliance therefore pins reviewed downstream i386 ports:

- Ghostty [`v1.3.1-i386.1`](https://github.com/dynamite-bud/ghostty/releases/tag/v1.3.1-i386.1), built for Alpine `x86-linux-musl`;
- Codex [`rust-v0.147.0-i386.1`](https://github.com/dynamite-bud/codex/releases/tag/rust-v0.147.0-i386.1), built for `i686-unknown-linux-musl`.

`artifacts.lock` owns their release URLs and SHA-256 values. The image build downloads only those URLs, verifies both archives before extraction, runs both version commands, and removes download and build residue.

## Source File Ownership

| File | Contract |
| --- | --- |
| `Dockerfile` | Pinned Alpine and Mesa sources, verified Mesa/application artifacts, exact package closure, UID 1000 account, OpenRC services, locked root account, and initramfs generation. |
| `build.sh` | `linux/386` Docker build/export, deterministic rootfs normalization, filesystem JSON and zstd chunk generation, and image-contract generation. |
| `world.lock` | Exact direct APK requests. Openbox/Xorg packages in this file are part of this fixture's identity. |
| `packages.lock` | Sorted direct and transitive installed APK closure. The Docker build rejects drift with `apk info -v | sort | cmp`. |
| `artifacts.lock` | Immutable Ghostty and Codex release tags, URLs, and SHA-256 values. |
| `mesa-artifacts.lock` | Pinned Mesa commit plus reproducible i386 Gallium and DRI binary SHA-256 values. |
| `v86-networking` | Deterministic hostname, UID 1000 runtime directory, optional VirtIO NIC DHCP, and `/run/v86-network-ready`. |
| `profile` | Starts the appliance only for the automatic tty1 login. |
| `appliance-session` | Architecture, privilege, network, DRM, process, negotiated renderer, 2D fallback, and serial readiness/failure contract. |
| `virtio-gpu-capset-probe.c` | Direct pinned-libdrm `GET_CAPS` and `CONTEXT_INIT` proof for private capset ID 7. |
| `virtio-gpu-triangle.c` | Frozen capset-v1/v2 triangles plus the version-3 Mesa llvmpipe reference and explicit resource/buffer/shader/binding/indexed-draw workload. |
| `virtio-gpu-triangle-spv.h` | Pinned Naga-generated SPIR-V modules for the version-3 textured triangle. |
| `ghostty-terminal-benchmark.c` | Offline fixed ANSI/scroll workload, guest CPU accounting, keyboard synchronization, and serial run markers for the XWAH-5 baseline. |
| `probe-world.lock` | Exact direct build-only packages for the probes and triangle workloads. |
| `probe-packages.lock` | Complete sorted probe/triangle builder package closure; the build rejects drift. |
| `xinitrc` | Openbox, selected renderer check, 1024x768 mode, Ghostty, and Codex process startup. |
| `20-virtio-gpu.conf` | Xorg modesetting, glamor, and DRI3 configuration for PCI `1af4:1050`; the session selects llvmpipe unless acceleration is explicit. |
| `ghostty-config` | Undecorated maximized window and the Codex launcher command. |
| `codex-session` | Pristine workspace selection and non-interactive `workspace-write` Codex startup with unavailable Code Mode disabled and supported direct shell/unified execution enabled. |

Docker assembles and exports the root filesystem; it is not part of the browser runtime. `normalize_rootfs.py --preserve-owners` sorts archive members, clears timestamps and owner names, removes Docker metadata, and retains numeric UID/GID ownership for the unprivileged home and workspace.

## Prerequisites

- Docker with `linux/386` support. Docker Desktop supplies architecture emulation on Apple silicon.
- Python 3 with the `zstandard` module required by the repository image tools.
- The normal v86 JavaScript/Wasm build dependencies.
- Rust stable, `wasm32-unknown-unknown`, and `wasm-bindgen` when exercising the Rust/Wasm `wgpu` backend.
- Chromium or Chrome with WebGPU for browser acceptance.
- Enough disk space for Docker layers, a roughly 677 MiB rootfs tar, and about 275 MiB of content-addressed compressed files.

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
python3 -m http.server 8082 --bind 127.0.0.1
```

Offline direct-JavaScript launch:

```text
http://127.0.0.1:8082/examples/virtio_gpu_codex.html?renderer=webgpu-js
```

Online launch with a percent-encoded WISP/wsproxy relay:

```text
http://127.0.0.1:8082/examples/virtio_gpu_codex.html?renderer=webgpu-js&relay=wss%3A%2F%2Frelay.example.test%2F
```

Change `renderer=webgpu-js` to `renderer=wgpu` for the Rust/Wasm renderer. The page preserves the relay parameter when switching renderers.

The page deliberately does not hardcode a relay. Without `relay=`, it reports `VirtIO NIC relay: unconfigured`, passes `v86_relay=unconfigured` to the guest, omits the virtual NIC, and still boots the local Codex UI. With a relay, the guest must obtain an IPv4 lease before the graphical session starts. Use a trusted relay for real credentials; a public relay is suitable only for disposable testing and can observe connection metadata even though application HTTPS remains encrypted.

## Authentication and Persistence

No model credential or `/home/codex/.codex/auth.json` is baked into the image. Prefer Codex's device-code login so authentication is completed in a normal browser rather than by typing a secret into the guest.

The root filesystem is writable only for the current emulator session. **Reset fresh session** reloads the page and discards authentication, workspace changes, and all other guest mutations. Persistence is intentionally out of scope for this reference fixture.

The i386 Codex port cannot apply Codex's normal Linux network seccomp filter because the filter's compiler dependency does not support 32-bit x86. The `workspace-write` filesystem sandbox remains enabled, but model commands lack that extra network isolation. Run this appliance only inside an external isolation boundary.

## Readiness Contract

`appliance-session` writes bounded evidence to `ttyS0`. A successful boot includes:

```text
V86_APPLIANCE_BEGIN
V86_APPLIANCE_ARCH=i686
V86_APPLIANCE_UID=1000
V86_APPLIANCE_HOSTNAME=v86-appliance
V86_APPLIANCE_DRM=/dev/dri/card0
V86_APPLIANCE_NETWORK=PASS|UNCONFIGURED
V86_APPLIANCE_XORG=PASS
V86_APPLIANCE_RENDERER=llvmpipe (...)|webgpuvirt (...)
V86_APPLIANCE_OPENBOX=PASS
V86_APPLIANCE_GHOSTTY_PROCESS=PASS
V86_APPLIANCE_GHOSTTY_WINDOW=PASS
V86_APPLIANCE_CODEX_PROCESS=PASS
V86_APPLIANCE_CODEX_EXEC_FLAGS=PASS
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
Ghostty and Codex readiness, verified direct-tool process arguments, capset-7
`SUBMIT_3D` traffic, a uniform off-diagonal background, a mixed-alpha cursor,
and zero invalid commands, backend errors, browser console errors, or WebGPU
validation errors.

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
hostname, relay behavior, CA-validated HTTPS when configured, the expected
llvmpipe or `webgpuvirt` renderer, Xorg/Openbox/Ghostty/Codex processes, the
live Codex direct-tool flags, visible scanout, accelerated background
uniformity, cursor alpha, keyboard delivery, responsive layout, absence of
desktop packages, writable workspace, and pristine fresh-session reset.

## Observed Codex Limitations

An authenticated run through the configured relay reached `gpt-5.6-sol` and
returned a normal response. It exposed two application-level limitations that
are not hidden by the appliance readiness contract:

- `codex_apps` MCP startup can time out during `tools/list` pagination. This is
  an external MCP startup failure; the observed normal response still
  completed.
- The initial Code Mode request failed closed because the pinned i386 archive
  does not ship `/usr/local/bin/codex-code-mode-host`.

The appliance now selects Codex's supported direct path: it disables
`code_mode`, `code_mode_only`, and `code_mode_host`, enables `shell_tool` and
`unified_exec`, keeps in-process fallback enabled, and verifies those arguments
from `/proc/<pid>/cmdline` before readiness. `codex features list` on the exact
packaged i386 binary confirms the resulting feature states. This does not
implement Code Mode or weaken the no-credential image contract.

[XWAH-6](https://github.com/dynamite-bud/v86/issues/6), a child of XWAH-3,
tracks a real i686 Code Mode host and bounded MCP pagination diagnosis.
Preserve visible diagnostics until their underlying components are
implemented.

## Troubleshooting

- **`VirtIO NIC relay: unconfigured`:** add a percent-encoded `relay=wss://.../` query parameter, then reload. This status is intentional when no relay was supplied.
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
- **Codex says Code Mode is unavailable or cannot run commands:** inspect
  `/proc/$(cat /tmp/v86-codex.pid)/cmdline` and require
  `V86_APPLIANCE_CODEX_EXEC_FLAGS=PASS`. Do not add a fake
  `codex-code-mode-host`.

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