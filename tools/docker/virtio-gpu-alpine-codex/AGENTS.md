# Openbox, Ghostty, and Codex Appliance Guidance

## Scope

This directory owns the reproducible Alpine 3.24 i386 Xorg/Openbox reference appliance for XWAH-3, the XWAH-5 accelerated rendering path, and the XWAH-6 MCP policy. It must remain runnable beside any future Cage/Wayland fixture; do not convert, rename, or delete it as kiosk cleanup.

Read `Readme.md`, `../../../docs/gpu/ghostty-codex-appliance.md`, and `../../../docs/virtio-gpu-webgpu.md` before changing inputs or runtime behavior.

## Reproducibility and Artifact Rules

- Pin the Alpine base by digest, direct APK requests in `world.lock`, the complete installed closure in `packages.lock`, application archives in `artifacts.lock`, and Mesa commit/artifact hashes in `mesa-artifacts.lock`.
- Never bypass the `apk info -v | sort | cmp` closure check or checksum validation. Update a lock only from reviewed, reproducible evidence.
- Docker is build-time only. `build.sh` exports and normalizes numeric ownership, then creates ignored rootfs, filesystem JSON, content-addressed chunks, and image-contract artifacts under `images/`.
- Preserve UID/GID 1000 for `/home/codex`, the locked root account, and the absence of baked model credentials.
- Keep the custom Mesa build release-stripped and package only the custom
  runtime objects. Default boots use Alpine's system Gallium file in place;
  accelerated boots replace it once during OpenRC startup. Do not package a
  duplicate system backup or Mesa build/debug artifacts.
- Generated images and Docker exports are not source and must not be committed.

## Runtime Contract

The normal chain is OpenRC -> unprivileged tty1 login -> Xorg -> Openbox -> Ghostty -> Codex. The default renderer is llvmpipe. The integrated accelerated mode requires `renderer=wgpu&accelerated=1`: `wgpu` is the browser-side Rust/Wasm backend and `accelerated=1` selects checksum-locked Mesa `webgpuvirt` inside the guest. Failure must not silently fall back.

The pinned i386 Codex release has no `codex-code-mode-host`. `codex-session` must keep these exact semantic settings:

```text
--sandbox workspace-write
--ask-for-approval never
--disable code_mode
--disable code_mode_only
--disable code_mode_host
--disable apps
--enable shell_tool
--enable unified_exec
-c code_mode.disable_in_process_fallback=false
```

These select supported direct tools, explicitly disable the unsupported host-owned Codex Apps catalog, and do not implement Code Mode. With a relay, `codex-session` separately configures `mcp_servers.context7.url="https://mcp.context7.com/mcp"`; without a relay it must omit that entry. `appliance-session` inspects the live process arguments before emitting `V86_APPLIANCE_CODEX_EXEC_FLAGS=PASS` and `V86_APPLIANCE_CODEX_APPS=DISABLED`. Never add a fake host executable or suppress a real startup failure.

The i386 port lacks Codex's normal Linux network seccomp filter. Keep the `workspace-write` sandbox and external disposable-v86 isolation warning. Authentication remains user-provided and ephemeral; fresh reset must discard credentials and workspace mutations.

## Graphics Invariants

- The whole-window Ghostty background is a uniform full-screen program, not a cell-background instance. A diagonal color split is a renderer regression.
- Cursor X formats preserve the fourth guest byte as alpha. Forcing it opaque creates a black 64x64 square; this differs intentionally from opaque X-format scanout conversion.
- The standard 2D scanout remains the presentation path in both default and accelerated modes.
- `webgpuvirt` accepts only the measured Ghostty command/shader subset. Unknown state fails closed.

## Readiness and Failure Evidence

A successful normal boot must prove architecture, UID, hostname, kernel, application versions, DRM, relay and Context7 states, renderer, Xorg, Openbox, Ghostty, Codex, direct-tool/MCP flags, Apps disablement, and `V86_APPLIANCE_READY=PASS` on ttyS0. Failure emits a precise reason plus bounded Xorg/Openbox/Ghostty/GL/MCP logs.

Do not replace readiness markers with sleeps. No relay means both `NETWORK=UNCONFIGURED` and `MCP_CONTEXT7=UNCONFIGURED`, not success. A supplied relay must obtain DHCP, pass CA-validated HTTPS, complete MCP initialization, and expose both expected Context7 tools before graphical readiness.

## Change Workflow
1. Change the narrow source input; do not hand-edit generated images.
2. Rebuild `make virtio-gpu-codex-image` twice and compare the generated contract.
3. Update documented sizes and hashes after intentional image changes.
4. Rebuild `build/libv86.mjs`, `build/v86.wasm`, and `virtio-gpu-wgpu` from the same source revision; do not test copied images with a stale browser bundle.
5. Stop manual port-8082 servers, then run the applicable browser target.
6. For renderer/session changes, also run protocol and Rust transport checks.

Focused commands:

```sh
make virtio-gpu-unit-test
make virtio-gpu-3d-transport-test
make virtio-gpu-webgpuvirt-triangle-test
V86_CODEX_BROWSER_PORT=8082 V86_CODEX_RELAY_URL=wss://relay.example.test/ \
    make virtio-gpu-codex-browser-test
V86_CODEX_BROWSER_PORT=8082 V86_CODEX_RELAY_URL=wss://relay.example.test/ \
    make virtio-gpu-codex-accelerated-test
make virtio-gpu-codex-benchmark-accelerated
```

Accelerated acceptance requires `webgpuvirt`, `SUBMIT_3D`, a uniform off-diagonal background, mixed cursor alpha, the live Codex flag marker, and zero browser/WebGPU/backend errors. Performance claims require the fixed five-run workload, unchanged terminal SHA-256, raw results, and the documented 20% gain/5% non-regression gate.
