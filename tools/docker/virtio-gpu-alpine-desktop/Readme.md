# Alpine i386 VirtIO GPU Desktop

This directory defines the reproducible full-desktop guest used to exercise v86's standard VirtIO GPU 2D path through either browser WebGPU renderer. It builds Alpine Linux 3.24.1 for i386 with Linux 6.18 LTS, XFCE, Xorg, labwc, `xfce4-terminal`, and Thunar.

The image is for local development and browser acceptance only. It has a blank root password and automatic root login on the VGA and serial consoles. Do not deploy it or expose it to an untrusted network.

## Rendering Model

Both sessions use the same device and presentation pipeline:

```text
XFCE application
  -> software-rendered guest window contents
  -> Linux virtio_gpu DRM/KMS scanout
  -> v86 standard VirtIO GPU 2D commands
  -> selected browser WebGPU backend (`webgpu-js` or Rust/Wasm `wgpu`)
  -> host WebGPU canvas
```

This proves a complete desktop over VirtIO GPU 2D and host WebGPU presentation. It is not guest virgl, OpenGL, or Vulkan acceleration. Selecting Wayland changes the guest display stack, not this acceleration boundary.

## Reproducible Inputs

- `Dockerfile`: pinned Alpine base, exact package installation, OpenRC setup, and initramfs generation.
- `world.lock`: exact direct APK package requests.
- `packages.lock`: sorted direct and transitive installed package closure.
- `desktop-session`: shared session bootstrap and serial readiness contract.
- `profile`: selects Xorg or Wayland from the kernel command line.
- `xinitrc`: Xorg XFCE startup.
- `20-virtio-gpu.conf`: Xorg modesetting configuration for the VirtIO GPU.
- `image-contract.json`: reviewed package and generated-artifact checksums.

Docker only assembles and exports the root filesystem. Docker is not part of the v86 browser runtime.

## Prerequisites

- Docker with `linux/386` support. Docker Desktop provides architecture emulation on Apple silicon.
- Python 3 with the `zstandard` module used by the repository image tools.
- Rust stable with `wasm32-unknown-unknown` and `wasm-bindgen` only when building the optional Rust/Wasm `wgpu` renderer.
- Enough space for Docker layers, a roughly 800 MiB rootfs tar, and the content-addressed flat filesystem.

Install the Python dependency if needed:

```sh
python3 -m pip install --user zstandard
```

## Build

From the repository root:

```sh
make virtio-gpu-desktop-image
make all-debug
make virtio-gpu-wgpu  # Optional Rust/Wasm renderer
```

The image build:

1. Builds the pinned Alpine base for `linux/386`.
2. Installs `world.lock` and rejects any installed closure that differs from `packages.lock`.
3. Configures automatic root login, OpenRC, D-Bus, seatd, Xorg, labwc, and XFCE.
4. Generates an initramfs with the `base`, `virtio`, and `9p` features.
5. Normalizes the exported rootfs tar.
6. Produces v86 filesystem JSON and content-addressed zstd chunks.
7. Records artifact and package checksums.

Generated and ignored artifacts live under `images/`:

- `alpine-virtio-gpu-desktop-rootfs.tar`
- `alpine-virtio-gpu-desktop-fs.json`
- `alpine-virtio-gpu-desktop-rootfs-flat/`
- `alpine-virtio-gpu-desktop-image-contract.json`

Confirm that a build matches the reviewed contract:

```sh
cmp \
  tools/docker/virtio-gpu-alpine-desktop/image-contract.json \
  images/alpine-virtio-gpu-desktop-image-contract.json
```

Do not commit the generated `images/` tree. When intentionally updating the image, review the complete package closure and every changed checksum before replacing the committed contract.

## Launch

Serve the repository root after building:

```sh
python3 -m http.server 8000
```

Open one of these URLs for the direct JavaScript renderer:

- Xorg: `http://127.0.0.1:8000/examples/virtio_gpu_desktop.html?desktop=xorg&renderer=webgpu-js`
- Wayland: `http://127.0.0.1:8000/examples/virtio_gpu_desktop.html?desktop=wayland&renderer=webgpu-js`

Use `renderer=wgpu` for the Rust/Wasm renderer. The page exposes both desktop
and renderer selectors. It boots the generated filesystem with 1 GiB guest RAM
at `1024x768` and switches from VGA to the dedicated WebGPU canvas after the
guest establishes its first KMS scanout.

### Ready-state snapshots

After the desktop reports ready, **Save ready snapshot** pauses the emulator,
captures CPU, device, VirtIO GPU, and writable 9p filesystem state, compresses
it with gzip, stores it in origin-scoped IndexedDB, and resumes the VM. Reloading
the same desktop and renderer automatically restores that state before guest
boot. **Delete saved snapshot** returns later reloads to a cold boot.

The record is keyed by desktop and renderer. A SHA-256 compatibility fingerprint
covers the emulator JavaScript and Wasm, BIOS images, guest filesystem manifest,
renderer artifacts, memory and storage sizes, display mode, and kernel command
line. Incompatible or corrupt records are deleted instead of restored.
`snapshot=off` bypasses automatic restore while leaving the saved record
available for deletion or replacement. Benchmarks always disable snapshots.

On the Apple M4 development machine, one Xorg `webgpu-js` run captured a
212.7 MiB state, stored it as 80.5 MiB, and restored the ready desktop in 1.3
seconds versus a 73.6-second cold boot. Run the focused contract with:

```sh
make virtio-gpu-ready-snapshot-test
```

## Session Comparison

| Session | Guest stack | Strength | Use |
| --- | --- | --- | --- |
| Xorg | Xorg modesetting, XFCE, xfwm4 | Mature XFCE compatibility and predictable application behavior | Default daily desktop |
| Wayland | libinput, seatd, labwc, native XFCE Wayland session | Newer display stack and Wayland feature testing | Modern compatibility target |

Both sessions provide the same root filesystem, terminal, file manager, panel, applications, and files. Wayland is not inherently faster here because both sessions use software guest rendering before the VirtIO GPU scanout. Keep Xorg as the compatibility default and use Wayland to track the newer XFCE stack.

Alpine XFCE is intentionally preferred over GNOME or KDE for this stage: it provides a complete desktop within v86's CPU and memory constraints without adding a heavyweight shell that still lacks guest 3D acceleration.

## Runtime Contract

`profile` reads `v86.desktop=xorg` or `v86.desktop=wayland` from the kernel command line and invokes `v86-desktop-session`. Successful startup emits:

```text
V86_DESKTOP_BEGIN
V86_DESKTOP_MODE=xorg|wayland
V86_DESKTOP_KERNEL=6.18...
V86_DESKTOP_DRM=/dev/dri/card0
V86_DESKTOP_READY=PASS
V86_DESKTOP_END
```

`V86_DESKTOP_READY=PASS` requires `/dev/dri/card0`, a live session process, and the XFCE panel and desktop. The browser launcher treats `V86_DESKTOP_READY=FAIL` as a terminal startup failure and leaves the serial console available for diagnosis.

## Verification

Run the protocol, KMS, and automated browser regressions after image or renderer
changes:

```sh
make virtio-gpu-unit-test
make virtio-gpu-test
make virtio-gpu-browser-test
```

The browser target runs Xorg and Wayland through both `webgpu-js` and `wgpu`.
It verifies `V86_DESKTOP_READY=PASS`, a visible scanout, reset fallback,
snapshot rehydration, EDID/config-event resize, cursor overlay, injected device
loss/VGA fallback plus snapshot-based recovery, and the absence of backend,
WebGPU validation, and uncaught JavaScript errors. Manually verify terminal
keyboard input and Thunar when changing guest packages or desktop configuration.

Chromium may report that `AudioContext` autoplay was blocked before a user gesture; that warning is unrelated to VirtIO GPU presentation.

## Troubleshooting

- If the page remains on VGA, inspect the serial console for the desktop contract and confirm that `virtio_gpu` created `/dev/dri/card0`.
- If Wayland reports swapchain failures, confirm that the profile selects `/dev/dri/card0`, disables DRM modifiers, and permits the software GLES renderer used by labwc.
- If Xorg cannot find a screen, confirm that `20-virtio-gpu.conf` selects the modesetting driver and the VirtIO GPU is present at PCI ID `1af4:1050`.
- If the package closure check fails, do not bypass it. Reconcile `world.lock`, `packages.lock`, and the pinned base digest.
- If the KMS regression fails after desktop work, fix the shared standard 2D path rather than adding a desktop-only workaround.
