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

The image now boots to an interactive Ghostty shell and does not start Codex automatically. When the user runs `codex`, the launcher sets `--dangerously-bypass-approvals-and-sandbox`: the disposable v86 guest is the external isolation boundary, while the process remains unprivileged UID 1000 and root stays locked. The i386 port also lacks Codex's normal Linux network seccomp filter because its seccompiler dependency does not support 32-bit x86. No model credential is included in the image.

## Image Contract

`tools/docker/virtio-gpu-alpine-codex/` owns the separate Xorg/Openbox reference image. Its [implementation README](../../tools/docker/virtio-gpu-alpine-codex/Readme.md) documents every source file, the reproducible build, launch and verification commands, security boundaries, troubleshooting, and the Cage sibling handoff. This fixture does not replace or weaken the XFCE graphics regression image, and future Cage work must not convert it in place.

The boot chain is:

```text
Alpine OpenRC
  -> unprivileged codex user on tty1
  -> Xorg modesetting driver at 1920x1080x24
  -> Openbox
  -> Mesa llvmpipe (default) or targeted webgpuvirt (explicit acceleration)
  -> maximized undecorated Ghostty
  -> interactive /bin/sh; user runs codex manually when wanted
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
7. Bounded serial markers make architecture, privileges, networking, rendering, the Ghostty shell, the installed Codex binary, and disabled Codex autostart observable. Browser acceptance requires both those markers and a visible WebGPU scanout.

This structure keeps downloaded application artifacts, guest assembly, emulator presentation, and browser acceptance independently reviewable.

The browser host contract is equally explicit: a fixed 1920x1080 guest
scanout is responsively downsampled with browser-native filtering; the
16-point terminal font remains legible at non-integer fit ratios; hidden
host/guest cursor overlays leave the terminal pointerless; CSS-pixel mouse
deltas prevent HiDPI acceleration outside pointer lock; and a byte-bounded
256 MiB LRU retains recently closed immutable rootfs chunks. Acceptance rejects
duplicate compressed-chunk requests during its boot and interaction sequence.


## Manual Codex Session

Normal boot stops at `/home/codex/workspace` in Ghostty. Codex is installed but
not running. Type `codex` after editing any desired configuration. The launcher
uses the pinned real binary and always passes
`--dangerously-bypass-approvals-and-sandbox`; it also disables the unavailable
Code Mode host and Codex Apps, keeps direct shell/unified execution enabled,
and leaves every ordinary MCP server to user configuration.

Host-to-guest clipboard input is available on the browser page. Focus the
emulator display and press Cmd/Ctrl+V, or click **Paste** when the browser
suppresses paste on the canvas. Both paths inject only `text/plain`, cap one
paste at 65,536 UTF-16 code units, and pace keyboard delivery so multiline
shell commands are not dropped. The button reads the host clipboard only from
its click handler; unavailable access or permission denial is visible and
non-fatal.

The Ghostty command supervises its interactive login shell. If that shell
exits, it reports `V86_APPLIANCE_GHOSTTY_SHELL_RESTART=<status>` and starts a
fresh login shell without tearing down Ghostty, Openbox, or Xorg. Closing the
Ghostty window still ends the graphical session.

This is not guest-to-host copy. Canvas pixels do not retain Ghostty's selected
text, so [XWAH-38](https://github.com/dynamite-bud/v86/issues/38) deliberately
does not use OCR or claim that selecting text in the guest can populate the
host clipboard. Copy-out still requires a separately reviewed guest-to-host
transport.

The previous automatic `workspace-write` session caused model-spawned
`codex mcp add` commands to see `/home/codex/.codex` as read-only. The manual
full-access launcher removes that inner filesystem sandbox, so configuration
persists for the current guest session. This is deliberately dangerous:
model-generated commands receive unrestricted UID-1000 guest access and no
Codex approval prompts. Resetting the page discards configuration, credentials,
and workspace changes.

The guest includes pinned Python 3.14.7-r1 and jq 1.8.1-r0 for ordinary agent
and MCP workflows.

## Networking

The browser page does not hardcode a relay. The consolidated XWAH-5/XWAH-6
mode uses the Rust/Wasm `wgpu` host renderer, explicit guest `webgpuvirt`
acceleration, and an optional percent-encoded WISP/wsproxy relay:

```text
http://127.0.0.1:8082/examples/virtio_gpu_codex.html?renderer=wgpu&accelerated=1&relay=wss%3A%2F%2Frelay.example.test%2F
```

`renderer=wgpu` selects the browser-side Rust/Wasm backend;
`accelerated=1` selects the checksum-locked Mesa `webgpuvirt` renderer inside
the guest. `v86-networking` always configures IPv4 loopback. When a relay is
supplied, v86 creates a VirtIO NIC and the privileged OpenRC service obtains
DHCP before the unprivileged graphical session starts. Without a relay, the
NIC is omitted, readiness reports the network as `UNCONFIGURED`, and the local
UI still starts. The boot path never selects or probes an MCP server; add one
manually after the relay is available.

For local verification, use port **8082**:

```sh
python3 -m http.server 8082 --bind 127.0.0.1
```

## Readiness and Failure Contract

The tty1 session writes bounded evidence to `ttyS0`:

- architecture, UID, deterministic hostname, and kernel;
- Ghostty and Codex versions;
- `/dev/dri/card0`;
- `LOOPBACK=PASS` and `NETWORK=PASS|UNCONFIGURED`;
- the selected Mesa renderer, `llvmpipe` by default or `webgpuvirt` when
  acceleration is explicit;
- live Openbox, Ghostty, and interactive shell processes; the installed but
  non-running Codex binary; full-access manual-launch policy; writable Codex
  home; disabled Code Mode host and Apps;
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
- llvmpipe OpenGL plus visible 1920x1080 scanout;
- live Xorg, Openbox, Ghostty, and interactive shell processes, with Codex installed but not started;
- configured IPv4 loopback plus an actual localhost socket bind, and
  supplied-relay DHCP or an honest unconfigured network state;
- pinned Python execution and jq parsing inside the guest;
- absence of XFCE, its panel/session/desktop, Thunar, `xfce4-terminal`,
  Tumbler, Garcon, and Exo;
- unconfigured Codex login with no baked home credential;
- browser keyboard delivery, display-scoped Cmd/Ctrl+V, the explicit Paste
  button, exact-once multiline text with spaces and punctuation, non-fatal
  clipboard denial, clean shell-exit recovery with keyboard input into the
  replacement shell, and responsive narrow layout;
- a writable workspace and pristine fresh-session reset on the direct
  JavaScript backend;
- manual launcher policy that disables Code Mode, its absent host, and
  host-owned Codex Apps; enables direct shell/unified execution; retains
  in-process fallback; uses
  `--dangerously-bypass-approvals-and-sandbox`; and injects no MCP server;
- no automatically configured Context7 entry before the user's first
  `codex mcp add`;
- verified absence of the external Code Mode host and its V8 runtime;
- an actual `codex mcp add`/`list`/`remove` cycle proving that the manual
  full-access launcher can write `~/.codex/config.toml`;
- a uniform accelerated terminal background, a valid alpha-masked hardware
  cursor resource, and hidden host/guest pointer overlays.
  The 16-point guest font and browser-native canvas filtering preserve
  readability when the 1920x1080 scanout is fitted into a narrower viewport.

The fresh-session reset is intentionally ephemeral: it discards guest changes. This appliance does not persist API credentials or workspace data across reloads.

## Hosted Pre-Ghostty Snapshot

XWAH-45 adds an opt-in static hosted state for the four-worker-vCPU accelerated
appliance. The capture checkpoint is deliberately earlier than normal
readiness:

1. boot the exact image and multimemory browser build;
2. establish Xorg, Openbox, and the 1920x1080 mode with capture-only,
   non-glamor Xorg configuration;
3. require zero live VirtIO GPU 3D contexts, resources, and context
   attachments;
4. save and zstd-compress state before Ghostty starts;
5. after restore, release the checkpoint, restart Xorg with the normal
   accelerated configuration, and launch Ghostty.

This two-stage lifecycle avoids serializing unsupported live `webgpuvirt`
state while retaining the expensive kernel, OpenRC, networking, SMP probe,
Xorg, and Openbox work. The JSON metadata binds the state to the exact machine
configuration and image assets, records the state SHA-256 and v86 state
version, and points to a content-addressed `.bin.zst`. The page restores only
after every check passes; otherwise it reports the reason and cold boots.
Relay selection remains runtime-specific, and restore acceptance proves that
guest networking reconnects.

Create and verify the ignored local artifacts on port 8082:

```sh
V86_CODEX_RELAY_URL=wss://relay.example.test/ \
    make virtio-gpu-multi-core-alpine-codex-hosted-snapshot
V86_CODEX_RELAY_URL=wss://relay.example.test/ \
    make virtio-gpu-multi-core-alpine-codex-hosted-snapshot-test
```

Static deployment consists of the metadata JSON and its named state file under
`images/`, served beside the exact matching browser/Wasm and guest image
artifacts with cross-origin isolation enabled. Users opt in with
`snapshot=hosted`; neither ordinary cold boots nor other appliance modes load
the state. Generated states remain ignored because a state captured after
interactive use could contain credentials or workspace data.

The Apple M4/Chrome 151 capture used 197,546,168 raw bytes and compressed to
53,978,374 bytes (51.5 MiB). Two acceptance restores reached complete
Ghostty/Codex readiness in 39,673-43,929 ms versus 105,083 ms from cold boot,
a 2.39-2.65x speedup. They also proved four worker vCPUs, `webgpuvirt`,
post-restore network access, shell restart and input, a uniform background,
mixed cursor alpha, and zero browser/WebGPU/backend errors.

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
disable. Relay configuration controls only guest networking; the boot service
and launcher inject no Context7 or other ordinary MCP endpoint. Users can add a
server explicitly with `codex mcp add` once networking is available.

The launcher also disables `code_mode`, `code_mode_only`, and
`code_mode_host`; enables `shell_tool` and `unified_exec`; sets
`code_mode.disable_in_process_fallback=false`; and uses
`--dangerously-bypass-approvals-and-sandbox`. The pinned i386 binary reports
Codex Apps and all three Code Mode features disabled and both direct-tool
features enabled. Readiness verifies the launcher contract, writable Codex
home, and that Codex has not started. Browser acceptance exercises a real MCP
configuration write.

The combined browser run on port 8082 must report:

```text
V86_APPLIANCE_LOOPBACK=PASS
V86_APPLIANCE_NETWORK=PASS
V86_APPLIANCE_RENDERER=webgpuvirt (v86 WebGPU)
V86_APPLIANCE_OPENGL=4.3 (Compatibility Profile) Mesa 26.1.6 (git-ffa422e53d)
V86_APPLIANCE_CODEX_AUTOSTART=DISABLED
V86_APPLIANCE_CODEX_FULL_ACCESS=PASS
V86_APPLIANCE_CODEX_HOME_WRITABLE=PASS
V86_APPLIANCE_READY=PASS
```

This proves loopback setup, relay-backed guest networking, graphics selection,
and launcher/configuration contracts. A local MCP OAuth listener can now bind,
but a callback opened at host-browser `127.0.0.1` does not reach guest
loopback; authenticated OAuth therefore needs an explicit callback bridge not
provided by this fixture. Authentication remains user-provided and ephemeral;
no credential or authenticated home directory is part of the image.

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

The generated Codex artifact sizes remain smaller than the retained XFCE
fixture. Python and jq add files, so flat-file count is no longer lower:

|Artifact|Codex appliance|XFCE fixture|Delta|Reduction|
|---|---:|---:|---:|---:|
|Rootfs tar|736,215,040|794,818,560|-58,603,520 bytes|7.37%|
|Compressed flat files|293,077,098|295,224,610|-2,147,512 bytes|0.73%|
|Filesystem JSON|661,972|695,517|-33,545 bytes|4.82%|
|Flat-file count|9,222|9,175|+47|-0.51%|
|Package closure|321|420|-99|23.57%|

These values come from the generated image contracts and package locks.
Release-stripping reduced the custom Gallium library from 84,857,252 to
20,394,120 bytes and its DRI object from 2,747,252 to 95,600 bytes. Default
boots keep Alpine's system Gallium file in place; accelerated boot replaces it
once, so the image carries no duplicate system backup. Recompute this evidence
after any image, package, or artifact change.

The reproducible shell-supervision rebuild produced these SHA-256 values
identically on consecutive builds:

|Artifact|SHA-256|
|---|---|
|Rootfs tar|`ca0051b8c50723097cc1f6269126a30616cc5879f9fd873d8749883a6b800907`|
|Filesystem JSON|`4e5cc749870135b7f8ad3876fef588fb6b03cbe043ee9b3972fac042a69f10e3`|
|Flat-file manifest|`5e9a550765746a7038ad310a8c3dc27405236444a3ae1448e0aa2c7960a0126d`|
|Image contract|`8f533189efdd0529ecb748a0d5ea9f3d23f2945487c105b342ebd2c99fbf7694`|

## Original OMP Gate

The original OMP requirement remains infeasible without a separate prerequisite project:

- v86 emulates roughly Pentium 4/SSE3 and does not implement x86-64 guest mode;
- OMP's installer and Linux releases support x64 and arm64, not i386;
- OMP source installation requires Bun, whose Linux runtime and compile targets are x64 or arm64;
- moving OMP outside the guest or shipping an installer stub would not satisfy the original boot chain.

Restoring Ghostty → OMP scope therefore requires either verified v86 x86-64 support or a supported, fully functional i386 OMP runtime.
