# Ghostty and Codex Appliance

Status: **IMPLEMENTED**

Issue [dynamite-bud/v86#3](https://github.com/dynamite-bud/v86/issues/3) originally required Ghostty and OMP. Gate 0 proved that the original chain cannot run in v86: v86 has no x86-64 guest support, OMP and Bun publish no i386 runtime, and Alpine publishes Ghostty only for x86_64 and aarch64. The approved scope replaces OMP with a pinned downstream i386 Codex port. This does not add x86-64 support or claim upstream i386 support for either application.

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

`tools/docker/virtio-gpu-alpine-codex/` builds a separate image. It does not replace or weaken the XFCE graphics regression fixture.

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

## Size Evidence

The generated Codex appliance is smaller than the retained XFCE fixture:

|Artifact|Codex appliance|XFCE fixture|Delta|Reduction|
|---|---:|---:|---:|---:|
|Rootfs tar|676,536,320|794,818,560|-118,282,240 bytes|14.88%|
|Compressed flat files|275,299,815|295,224,610|-19,924,795 bytes|6.75%|
|Filesystem JSON|580,824|695,517|-114,693 bytes|16.49%|
|Flat-file count|7,945|9,175|-1,230|13.41%|
|Package closure|311|420|-109|25.95%|

These values come from the generated image contracts and package locks. Recompute them after any image, package, or artifact change.

## Original OMP Gate

The original OMP requirement remains infeasible without a separate prerequisite project:

- v86 emulates roughly Pentium 4/SSE3 and does not implement x86-64 guest mode;
- OMP's installer and Linux releases support x64 and arm64, not i386;
- OMP source installation requires Bun, whose Linux runtime and compile targets are x64 or arm64;
- moving OMP outside the guest or shipping an installer stub would not satisfy the original boot chain.

Restoring Ghostty → OMP scope therefore requires either verified v86 x86-64 support or a supported, fully functional i386 OMP runtime.
