# The Telnyx Experience

This directory is the branded, full-screen entry point for the Telnyx Codex appliance. The appliance runs an i386 Alpine guest in v86 with four worker vCPUs, the Rust/Wasm `wgpu` VirtIO GPU backend, Openbox, Ghostty, and Codex CLI 0.148.0 configured for Telnyx-hosted models.

The browser starts from a credential-free pre-Ghostty snapshot. A terminal-style Telnyx logo and event-driven progress bar cover the emulator until the guest reports that Ghostty is ready. The overlay is then removed from the DOM; the emulator canvas remains the only visible UI.

## Repository layout

The experience intentionally reuses the canonical v86 files instead of carrying copies:

- `index.html`: branded loader and appliance runtime.
- `server.py`: cross-origin-isolated development and deployment server.
- `branding/`: SVG, transparent PNG, and plain ASCII Telnyx marks.
- `../build/`, `../bios/`, `../src/`: browser runtime, firmware, and worker sources.
- `../images/virtio-gpu-multi-core-alpine-codex-telnyx-v0.148.0-*`: ignored guest image and snapshot outputs.
- `../tools/docker/virtio-gpu-multi-core-alpine-codex/telnyx/`: reproducible image overlay, Codex configuration, and model catalog.

Do not copy these directories into a second standalone tree. Use a symlink to this directory if another checkout path is required.

## Prerequisites

Install the normal v86 build toolchain plus Docker Desktop with `linux/386` emulation, Python 3 with `zstandard`, Rust with `wasm32-unknown-unknown`, and `wasm-bindgen`. The browser runtime uses `SharedArrayBuffer`; it must be served with COOP/COEP headers.

The image builder expects the i386 Codex package in a sibling checkout by default:

```text
../codex-i386-agent/dist/codex-rust-v0.148.0-i386-alpine-3.24.tar.gz
```

Build that package in the Codex checkout when necessary:

```sh
cd ../codex-i386-agent
UPSTREAM_TAG="$(cat .github/i386/upstream-version)" .github/i386/build.sh
```

The package SHA-256 must match `tools/docker/virtio-gpu-multi-core-alpine-codex/telnyx/artifacts.lock`. A different package is rejected before Docker starts and again inside the image build.

## Build the browser and guest image

From the v86 repository root:

```sh
make telnyx-experience-build
```

This builds:

- `build/libv86.mjs`
- `build/v86-multimem.wasm`
- `build/gram.wasm` and `build/gram-shared.wasm`
- `build/virtio-gpu-wgpu/`
- the versioned Telnyx rootfs tar, filesystem JSON, flat-file store, and image contract under `images/`

To use a non-sibling Codex package directory:

```sh
CODEX_I386_DIST=/absolute/path/to/dist make telnyx-experience-build
```

Build only the guest image with:

```sh
make virtio-gpu-multi-core-alpine-codex-telnyx-image
```

Generated browser, image, and snapshot artifacts are ignored. Commit only their source inputs and checksum contracts.

## Codex and Telnyx configuration

The image installs:

- `/usr/local/libexec/codex`: static i386 Codex CLI 0.148.0.
- `/home/codex/.codex/config.toml`: Telnyx Responses API provider configuration.
- `/home/codex/.codex/model-catalogs/telnyx.json`: pinned Telnyx model catalog.
- `/home/codex/.config/ghostty/config.ghostty`: maximized Ghostty with 20-point DejaVu Sans Mono text.

The default model is `moonshotai/Kimi-K2.6`. The provider URL is `https://api.telnyx.com/v2/ai/openai` and reads `TELNYX_API_KEY`. Codex Apps, browser/computer use, image generation, and multi-agent features are disabled. The Telnyx MCP entry is present but disabled; enabling it is an explicit per-user choice.

No credential is stored in the image or snapshot. Set it only in the live guest shell before starting Codex:

```sh
export TELNYX_API_KEY='your-key'
codex
```

Treat terminal scrollback and shell history as sensitive after entering a key. Never capture or redistribute a snapshot after provisioning credentials.

## Capture the hosted snapshot

The capture point is after the kernel, networking, Xorg, and Openbox are ready but before Ghostty creates live 3D resources. This keeps the snapshot credential-free and avoids serializing host WebGPU state.

```sh
make telnyx-experience-snapshot \
    TELNYX_RELAY_URL='wisps://your-relay.example/wisp/path/'
```

The default relay is the pinned Clawdtalk endpoint used by `index.html`. Capture writes:

- `images/virtio-gpu-multi-core-alpine-codex-telnyx-v0.148.0-ready-state.json`
- a fingerprinted `images/virtio-gpu-multi-core-alpine-codex-telnyx-v0.148.0-ready-*.bin.zst`

The manifest binds the snapshot to the browser runtime, firmware, worker source, renderer, image contract, memory layout, vCPU topology, and snapshot command line. Rebuild and recapture after changing any bound input.

Verify the real experience page and restored network path:

```sh
make telnyx-experience-test \
    TELNYX_RELAY_URL='wisps://your-relay.example/wisp/path/'
```

## Serve locally

Port 8082 is canonical:

```sh
make telnyx-experience-serve
```

Open <http://127.0.0.1:8082/>. `server.py` maps `/` to the experience, disables directory listings, supplies COOP/COEP/CORP headers, and applies immutable caching only to content-addressed or build artifacts. HTML, JSON, and the root entry point remain uncached.

The server owns port 8082. Stop another appliance server before starting it.

## Deploy with TLS

Run behind a reverse proxy that preserves the response headers, or serve TLS directly:

```sh
python3 telnyx-experience/server.py \
    --host 0.0.0.0 --port 8443 \
    --certfile /path/fullchain.pem \
    --keyfile /path/privkey.pem
```

Deploy from the v86 repository root layout; the page depends on sibling `build`, `bios`, `src`, and `images` paths. HTTPS is required outside localhost for secure browser APIs. Preserve these headers on every asset response:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

## Runtime behavior

- Four worker vCPUs with relaxed memory mode and shared WebAssembly memory.
- Rust/Wasm `wgpu` host renderer and guest `webgpuvirt` acceleration.
- Fixed Telnyx relay by default; no relay query parameter is required.
- Hosted snapshot restore with checksum and compatibility fingerprint validation; failure falls back to a cold boot.
- Real download byte progress and guest-readiness milestones; no timer-simulated completion.
- Native 1920×1080 guest scanout with 20-point Ghostty text, uniformly scaled to cover the current visual viewport.
- Aspect-preserving overflow crop at narrow or tall viewport sizes, avoiding non-uniform glyph stretching.
- Focused Cmd/Ctrl+V and explicit Paste button support, bounded to 64 KiB.

The page exports `window.emulator`, `window.applianceSerialText`, and `window.applianceHostedSnapshot` for acceptance diagnostics.

See [`../docs/telnyx-experience.md`](../docs/telnyx-experience.md) for architecture, artifact ownership, and maintenance rules.
