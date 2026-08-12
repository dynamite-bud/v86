# Alpine i386 Openbox Ghostty Codex Appliance

This directory is the reproducible **Xorg/Openbox reference appliance** for the i386 Ghostty and Codex work tracked in [dynamite-bud/v86#3](https://github.com/dynamite-bud/v86/issues/3). It boots directly into Codex inside a maximized, undecorated Ghostty window while retaining v86's standard VirtIO GPU 2D protocol and either browser WebGPU presentation backend.

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
  -> Mesa llvmpipe OpenGL
  -> maximized undecorated Ghostty
  -> codex --sandbox workspace-write --ask-for-approval never
```

Guest rendering remains software-rendered. Linux sends the completed scanout through standard VirtIO GPU 2D resource, transfer, and flush commands; the selected `webgpu-js` or Rust/Wasm `wgpu` backend uploads and presents that scanout through host WebGPU. This fixture does not provide guest virgl, Vulkan, or accelerated OpenGL.

## Architecture Decision

v86 is a 32-bit x86 emulator and cannot run the upstream x86-64 Ghostty, Codex, OMP, Bun, or Linux artifacts requested by the original issue. The implemented appliance therefore pins reviewed downstream i386 ports:

- Ghostty [`v1.3.1-i386`](https://github.com/dynamite-bud/ghostty/releases/tag/v1.3.1-i386), built for Alpine `x86-linux-musl`;
- Codex [`rust-v0.147.0-i386.1`](https://github.com/dynamite-bud/codex/releases/tag/rust-v0.147.0-i386.1), built for `i686-unknown-linux-musl`.

`artifacts.lock` owns their release URLs and SHA-256 values. The image build downloads only those URLs, verifies both archives before extraction, runs both version commands, and removes download and build residue.

## Source File Ownership

| File | Contract |
| --- | --- |
| `Dockerfile` | Pinned Alpine base, exact package closure, verified application extraction, UID 1000 account, OpenRC services, locked root account, and initramfs generation. |
| `build.sh` | `linux/386` Docker build/export, deterministic rootfs normalization, filesystem JSON and zstd chunk generation, and image-contract generation. |
| `world.lock` | Exact direct APK requests. Openbox/Xorg packages in this file are part of this fixture's identity. |
| `packages.lock` | Sorted direct and transitive installed APK closure. The Docker build rejects drift with `apk info -v | sort | cmp`. |
| `artifacts.lock` | Immutable Ghostty and Codex release tags, URLs, and SHA-256 values. |
| `v86-networking` | Deterministic hostname, UID 1000 runtime directory, optional VirtIO NIC DHCP, and `/run/v86-network-ready`. |
| `profile` | Starts the appliance only for the automatic tty1 login. |
| `appliance-session` | Architecture, privilege, network, DRM, process, renderer, and serial readiness/failure contract. |
| `xinitrc` | Openbox, llvmpipe, 1024x768 mode, Ghostty, and Codex process startup. |
| `20-virtio-gpu.conf` | Xorg modesetting configuration for PCI `1af4:1050`, with guest acceleration disabled. |
| `ghostty-config` | Undecorated maximized window and the Codex launcher command. |
| `codex-session` | Pristine workspace selection and non-interactive `workspace-write` Codex startup. |

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

1. update `world.lock` only for deliberate direct-package changes;
2. regenerate and review the complete `packages.lock` closure rather than bypassing its comparison;
3. update `artifacts.lock` only from a reviewed release and verified checksum;
4. rebuild twice and confirm the generated image-contract checksum is stable;
5. update the artifact sizes and checksums in `docs/gpu/ghostty-codex-appliance.md`;
6. rerun both renderer scenarios and the shared VirtIO GPU regressions.

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
V86_APPLIANCE_RENDERER=llvmpipe (...)
V86_APPLIANCE_OPENBOX=PASS
V86_APPLIANCE_GHOSTTY_PROCESS=PASS
V86_APPLIANCE_GHOSTTY_WINDOW=PASS
V86_APPLIANCE_CODEX_PROCESS=PASS
V86_APPLIANCE_READY=PASS
V86_APPLIANCE_END
```

The browser declares success only after both the final guest marker and a visible dedicated WebGPU canvas. Startup failure copies bounded Xorg, Openbox, Ghostty, and GL diagnostics to serial, emits a precise `V86_APPLIANCE_FAILURE=...`, and leaves the serial console available.

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

After changing the guest, browser launcher, standard 2D device, or either renderer, also run:

```sh
make virtio-gpu-unit-test
make virtio-gpu-test
TEST_RELEASE_BUILD=1 ./tests/devices/virtio_gpu.js
```

The acceptance harness checks guest architecture and UID, pinned versions, hostname, relay behavior, CA-validated HTTPS when configured, llvmpipe, Xorg/Openbox/Ghostty/Codex processes, visible scanout, keyboard delivery, responsive layout, absence of desktop packages, writable workspace, and pristine fresh-session reset.

## Observed Codex Limitations

An authenticated run through the configured relay reached `gpt-5.6-sol` and returned a normal response. It also exposed two application-level limitations that are not hidden by the appliance readiness contract:

- `codex_apps` MCP startup can time out during `tools/list` pagination. This is an external MCP startup failure; the observed normal Codex response still completed.
- Code Mode fails closed because the pinned downstream release contains the main Codex archive and checksum but does not ship `/usr/local/bin/codex-code-mode-host`. The image must not fabricate a stub or silence this warning. A future i386 release must build, package, checksum, and test the real host before enabling that feature.

These warnings do not prove an emulator, VirtIO NIC, or Ghostty failure. [Issue #6](https://github.com/dynamite-bud/v86/issues/6), a child of issue #3, tracks the real i686 Code Mode host and bounded MCP pagination diagnosis. Preserve the visible diagnostics until their underlying components are implemented.

## Troubleshooting

- **`VirtIO NIC relay: unconfigured`:** add a percent-encoded `relay=wss://.../` query parameter, then reload. This status is intentional when no relay was supplied.
- **VGA console remains visible:** inspect the serial disclosure for `V86_APPLIANCE_FAILURE`; confirm `/dev/dri/card0` and the `1af4:1050` device.
- **Xorg rejects the display name:** confirm `v86-networking` set `v86-appliance` and both loopback mappings before the tty1 session started.
- **Openbox or Ghostty exits:** inspect `/tmp/v86-appliance.log`, `/tmp/v86-openbox.log`, `/tmp/v86-ghostty.log`, and `/tmp/v86-glxinfo.log` through the bounded serial failure output.
- **Package closure differs:** reconcile the reviewed direct and transitive locks. Never remove the `cmp` check.
- **Browser harness cannot bind port 8082:** stop the manual `python3 -m http.server` instance; the harness starts its own server.
- **Cold boot appears stalled:** software rendering in the emulated i686 guest can take roughly 90–120 seconds. Wait for the serial contract instead of adding arbitrary browser sleeps.

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