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

The normal chain is OpenRC -> unprivileged tty1 login -> Xorg -> Openbox ->
Ghostty -> supervised interactive `/bin/sh`. A shell exit MUST start a fresh
login shell without tearing down Ghostty, Openbox, or Xorg. Codex is installed
but MUST NOT start automatically. The default renderer is llvmpipe. The
integrated accelerated
mode requires `renderer=wgpu&accelerated=1`: `wgpu` is the browser-side
Rust/Wasm backend and `accelerated=1` selects checksum-locked Mesa
`webgpuvirt` inside the guest. Failure must not silently fall back.

The opt-in hosted snapshot checkpoint is after Xorg and Openbox establish the
1920x1080 mode but before Ghostty starts. It MUST own zero live VirtIO GPU 3D
contexts, resources, or attachments. Capture uses the non-glamor
`20-virtio-gpu-snapshot.conf`; restore releases that X server, removes the
capture configuration, and starts the normal accelerated Xorg/Ghostty path.
The page MUST validate state version, SHA-256, and the complete machine
fingerprint before `initial_state`, and MUST cold boot with a visible reason on
any mismatch. Snapshot artifacts remain ignored and MUST NOT contain model
credentials or post-login workspace state.

The pinned i386 Codex release has no `codex-code-mode-host`. The manual
`codex-launcher` must keep these exact semantic settings:

```text
--dangerously-bypass-approvals-and-sandbox
--disable code_mode
--disable code_mode_only
--disable code_mode_host
--disable apps
--enable shell_tool
--enable unified_exec
-c code_mode.disable_in_process_fallback=false
```

These select full manual permissions inside the already isolated disposable
guest, retain supported direct tools, explicitly disable the unsupported
host-owned Codex Apps catalog, and do not implement Code Mode. MCP servers are
exclusively user-configured; do not inject Context7 or any other endpoint from
the relay startup path. `appliance-session` verifies the installed binary,
launcher policy, feature states, writable `~/.codex`, live Ghostty shell, and
absence of an auto-started Codex process. Never add a fake host executable or
suppress a real startup failure.

Do not reintroduce the `workspace-write` launcher: it made `~/.codex` read-only
to model-spawned configuration commands. The full-access flag intentionally
removes Codex approval and filesystem sandboxing; the i386 port also lacks
Codex's normal Linux network seccomp filter. The external v86 guest is the
sandbox, Codex remains UID 1000, root remains locked, and authentication stays
user-provided and ephemeral. Fresh reset must discard credentials,
configuration, and workspace mutations.

## Browser Input and Cache Invariants

- Clicking the emulator canvas MUST focus the display-scoped clipboard target.
- Focused Cmd/Ctrl+V MUST call `navigator.clipboard.readText()` while the
  trusted key event owns user activation, because Chromium does not emit a
  native paste event for the non-editable canvas. Native paste events remain
  supported and MUST cancel the pending API fallback to prevent duplicates.
- Clipboard input remains plain text, bounded to 64 KiB, and permission
  failure is visible and non-fatal. The Paste button is the explicit retry.
- Immutable rootfs files use a byte-bounded 512 MiB LRU. The limit is retention,
  not an eager allocation.

## Graphics Invariants

- The whole-window Ghostty background is a uniform full-screen program, not a cell-background instance. A diagonal color split is a renderer regression.
- Cursor X formats preserve the fourth guest byte as alpha. Forcing it opaque creates a black 64x64 square; this differs intentionally from opaque X-format scanout conversion.
- The standard 2D scanout remains the presentation path in both default and accelerated modes.
- `webgpuvirt` accepts only the measured Ghostty command/shader subset. Unknown state fails closed.

## Readiness and Failure Evidence

A successful normal boot must prove architecture, UID, hostname, kernel, application versions, DRM, IPv4 loopback, relay state, renderer, Xorg, Openbox, Ghostty, its interactive shell, the installed Codex binary, disabled Codex autostart, full-access launcher policy, writable Codex home, Apps disablement, and `V86_APPLIANCE_READY=PASS` on ttyS0. Failure emits a precise reason plus bounded Xorg/Openbox/Ghostty/GL/network logs.

Do not replace readiness markers with sleeps. `V86_APPLIANCE_LOOPBACK=PASS` is mandatory so local OAuth listeners can bind. No relay means `NETWORK=UNCONFIGURED`; a supplied relay must obtain DHCP before graphical readiness. Relay startup MUST NOT add or probe an MCP server.

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
V86_CODEX_RELAY_URL=wss://relay.example.test/ \
    make virtio-gpu-multi-core-alpine-codex-hosted-snapshot
V86_CODEX_RELAY_URL=wss://relay.example.test/ \
    make virtio-gpu-multi-core-alpine-codex-hosted-snapshot-test
```

Accelerated acceptance requires `webgpuvirt`, `SUBMIT_3D`, a uniform off-diagonal background, mixed cursor alpha, `V86_APPLIANCE_CODEX_AUTOSTART=DISABLED`, `V86_APPLIANCE_CODEX_FULL_ACCESS=PASS`, a successful Codex configuration write, and zero browser/WebGPU/backend errors. Performance claims require the fixed five-run workload, unchanged terminal SHA-256, raw results, and the documented 20% gain/5% non-regression gate.
