# Alpine i386 Openbox Alacritty Codex Appliance

This directory owns the reproducible **Alacritty + Codex** appliance tracked by [XWAH-22](https://github.com/dynamite-bud/v86/issues/22). It is separate from the Ghostty appliance in `tools/docker/virtio-gpu-alpine-codex/`: both images, browser pages, readiness markers, and acceptance targets remain independently runnable.

The guest is an Alpine `linux/386` system. It boots directly into Codex inside one maximized, undecorated Alacritty window while retaining v86's standard VirtIO GPU 2D path and either browser WebGPU presentation backend.

## Runtime Topology

```text
Alpine OpenRC
  -> v86-networking (hostname, runtime directory, optional DHCP)
  -> automatic unprivileged codex login on tty1
  -> v86-alacritty-appliance-session
  -> Xorg modesetting on /dev/dri/card0 at 1024x768x24
  -> Openbox
  -> Mesa llvmpipe OpenGL
  -> Alacritty 0.17.0
  -> codex --sandbox workspace-write --ask-for-approval never
```

Guest rendering remains software-rendered. Linux sends completed scanouts through standard VirtIO GPU 2D resource, transfer, and flush commands; the selected direct JavaScript `webgpu-js` or Rust/Wasm `wgpu` backend uploads and presents the scanout through host WebGPU. This fixture does not provide guest virgl, Vulkan, accelerated OpenGL, or VirtIO GPU 3D.

## Reproducible Inputs

Alacritty is compiled inside the Docker build because Alpine does not publish an `x86` package:

- tag: `v0.17.0`;
- commit: `94e7c8874e526b1e67b349d9ba30ddf81669119e`;
- source archive and SHA-256: `artifacts.lock`;
- target: Alpine `linux/386` / i686 musl;
- command: `cargo build --release --locked --no-default-features --features=x11`;
- exact direct build inputs: `alacritty-build-world.lock`;
- exact installed build closure: `alacritty-build-packages.lock`.

The build verifies the source checksum, uses the upstream committed `Cargo.lock`, rejects APK closure drift, verifies a 32-bit i386 ELF, runs `alacritty --version`, installs the Alacritty terminfo entries, and records compiler evidence in `/usr/share/doc/alacritty/I686-BUILD.txt`.

Codex remains the pinned downstream i386 port:

- release: [`rust-v0.147.0-i386.1`](https://github.com/dynamite-bud/codex/releases/tag/rust-v0.147.0-i386.1);
- target: `i686-unknown-linux-musl`;
- archive and SHA-256: `artifacts.lock`.

`world.lock` and `packages.lock` pin the runtime APK request set and complete installed closure. Docker exports the root filesystem; `normalize_rootfs.py --preserve-owners` sorts archive members, clears timestamps and owner names, removes Docker metadata, and retains numeric UID/GID ownership.

## File Ownership

| File | Contract |
| --- | --- |
| `Dockerfile` | Pinned i386 build and runtime stages, verified source/artifacts, UID 1000 account, OpenRC services, and initramfs. |
| `artifacts.lock` | Immutable Alacritty source identity and Codex release identity. |
| `alacritty-build-world.lock` | Direct packages required to compile Alacritty. |
| `alacritty-build-packages.lock` | Complete sorted Alacritty builder package closure. |
| `world.lock` | Direct runtime APK inputs. |
| `packages.lock` | Complete sorted runtime package closure. |
| `alacritty.toml` | Maximized undecorated X11 window, fixed title/font/cursor, and Codex launcher. |
| `xinitrc` | Xorg/Openbox/llvmpipe startup and Alacritty lifecycle. |
| `codex-session` | Pristine workspace selection and non-interactive `workspace-write` Codex startup. |
| `appliance-session` | Architecture, privilege, DRM, renderer, process, window, and serial readiness contract. |
| `build.sh` | `linux/386` Docker export, normalized rootfs, filesystem JSON/zstd chunks, and image contract. |

## Prerequisites

- Docker with `linux/386` emulation; Docker Desktop provides this on Apple silicon.
- Python 3 with `zstandard` for the repository image tools.
- Normal v86 JavaScript/Wasm dependencies.
- Rust stable, `wasm32-unknown-unknown`, and `wasm-bindgen` for the optional Rust/Wasm renderer.
- Chromium or Chrome with WebGPU for browser acceptance.

## Build

From the repository root:

```sh
make virtio-gpu-alacritty-codex-image
make all-debug
make virtio-gpu-wgpu
```

The image target writes ignored products under `images/`:

- `alpine-virtio-gpu-alacritty-codex-rootfs.tar`;
- `alpine-virtio-gpu-alacritty-codex-fs.json`;
- `alpine-virtio-gpu-alacritty-codex-rootfs-flat/`;
- `alpine-virtio-gpu-alacritty-codex-image-contract.json`.

Do not commit generated images or Docker exports. For a deliberate dependency change, update the direct lock, regenerate and review its complete closure, rebuild twice, compare image-contract checksums, and rerun both renderers plus shared VirtIO GPU regressions. Never bypass a closure `cmp`.

## Launch

Serve the repository root:

```sh
python3 -m http.server 8082 --bind 127.0.0.1
```

Direct JavaScript renderer:

```text
http://127.0.0.1:8082/examples/virtio_gpu_alacritty_codex.html?renderer=webgpu-js
```

Rust/Wasm renderer:

```text
http://127.0.0.1:8082/examples/virtio_gpu_alacritty_codex.html?renderer=wgpu
```

Append a percent-encoded `relay=wss://.../` parameter for an online session. Without it, the page honestly reports the VirtIO NIC as unconfigured and still boots the local UI. Use a trusted relay for real credentials.

## Readiness Contract

A successful boot writes bounded serial evidence:

```text
V86_ALACRITTY_CODEX_BEGIN
V86_ALACRITTY_CODEX_ARCH=i686
V86_ALACRITTY_CODEX_UID=1000
V86_ALACRITTY_CODEX_HOSTNAME=v86-appliance
V86_ALACRITTY_CODEX_DRM=/dev/dri/card0
V86_ALACRITTY_CODEX_NETWORK=PASS|UNCONFIGURED
V86_ALACRITTY_CODEX_XORG=PASS
V86_ALACRITTY_CODEX_RENDERER=llvmpipe (...)
V86_ALACRITTY_CODEX_OPENBOX=PASS
V86_ALACRITTY_CODEX_ALACRITTY=alacritty 0.17.0
V86_ALACRITTY_CODEX_ALACRITTY_PROCESS=PASS
V86_ALACRITTY_CODEX_ALACRITTY_WINDOW=PASS
V86_ALACRITTY_CODEX_CODEX_PROCESS=PASS
V86_ALACRITTY_CODEX_READY=PASS
V86_ALACRITTY_CODEX_END
```

The browser declares success only after the final guest marker and a visible dedicated WebGPU canvas. Failures copy bounded Xorg, Openbox, Alacritty, and GL logs to serial and emit `V86_ALACRITTY_CODEX_FAILURE=...`.

## Verification

The browser harness owns its HTTP port:

```sh
V86_CODEX_BROWSER_PORT=8082 make virtio-gpu-alacritty-codex-browser-test
```

The default matrix runs both `webgpu-js` and `wgpu`. To run one renderer:

```sh
V86_CODEX_BROWSER_SCENARIO=alacritty \
V86_CODEX_BROWSER_RENDERERS=webgpu-js \
./tests/browser/virtio_gpu_alacritty_codex_acceptance.js
```

The acceptance contract checks i686/UID 1000, pinned versions, hostname, llvmpipe, Xorg/Openbox/Alacritty/Codex processes, maximized Alacritty window, visible 1024x768 scanout, keyboard delivery, responsive layout, absent XFCE packages, unconfigured login, and pristine fresh-session reset.

After changing the guest, launcher, standard 2D device, or either renderer, also run:

```sh
make virtio-gpu-unit-test
make virtio-gpu-test
TEST_RELEASE_BUILD=1 ./tests/devices/virtio_gpu.js
```

## Authentication and Security

No credential or `/home/codex/.codex/auth.json` is baked into the image. Prefer device-code login in a normal browser. **Reset fresh session** reloads the image and discards guest mutations; persistent browser snapshots are outside this fixture.

The i386 Codex port cannot apply Codex's normal Linux network seccomp filter because its compiler dependency does not support 32-bit x86. The `workspace-write` filesystem sandbox remains enabled, but model commands lack that additional network isolation. Run the appliance only inside an external isolation boundary.

## Troubleshooting

- **VGA console remains visible:** inspect serial for `V86_ALACRITTY_CODEX_FAILURE`; confirm `/dev/dri/card0` and PCI device `1af4:1050`.
- **Alacritty exits:** inspect `/tmp/v86-alacritty.log`, `/tmp/v86-openbox.log`, and `/tmp/v86-glxinfo.log` in the bounded serial failure output.
- **Package closure differs:** regenerate and review the corresponding closure; never remove the comparison.
- **Port 8082 is busy:** stop the manual server before running the harness.
- **Cold boot appears stalled:** wait for the serial contract rather than adding arbitrary browser sleeps; all guest rendering and Rust compilation during image creation run under i386 emulation.
