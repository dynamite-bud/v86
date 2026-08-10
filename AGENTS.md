# Repository Guidelines

## Project Overview

v86 is a 32-bit x86 PC emulator for browsers and Node.js. A Rust interpreter/JIT translates hot guest code to WebAssembly; JavaScript supplies the host bridge, PC device models, browser adapters, storage, networking, and public API. The emulated ISA is roughly Pentium 4/SSE3 and does not support x86-64 or multicore guests.

`Readme.md` states that upstream generally does not accept issues or pull requests written partly or wholly with generative AI, except case-by-case. Confirm contribution policy before preparing an upstream submission.

## Architecture & Data Flow

1. Consumers construct `V86` from `src/browser/starter.js` (re-exported by `src/main.js`; declared in `v86.d.ts`). The built-in UI starts from `src/browser/main.js`.
2. `V86` creates paired `BusConnector`s, loads `build/v86[-debug].wasm`, calls `rust_init`, and constructs the low-level `v86`/`CPU` objects. `src/cpu.js` exposes Rust exports and fixed WebAssembly-memory regions through typed-array views.
3. `CPU.init` creates guest RAM and JavaScript device models. Port I/O and MMIO cross the Rust/JS boundary into `src/io.js`; string-keyed bus events connect emulator, devices, and browser adapters. `BusConnector.send` is synchronous; use `send_async` only when deferral is required.
4. `src/main.js` runs a cooperative tick loop around Rust `main_loop`. Rust interprets cold code, records hot pages, analyzes control flow, emits WebAssembly through `src/rust/wasmgen/`, and installs compiled functions into the shared Wasm table.
5. Devices own mutable state through `get_state`/`set_state`. `src/state.js` serializes a versioned header, JSON metadata, and aligned typed-array buffers; restore validates format/version and supports zstd streams.

Cross-language layouts are load-bearing. Keep JavaScript memory offsets synchronized with `src/rust/cpu/global_pointers.rs`, shared constants synchronized across JS/Rust, and Wasm-table/state slot layouts stable unless every producer and consumer is migrated together.

## Key Directories

| Path | Purpose |
| --- | --- |
| `src/` | JavaScript CPU facade, I/O routing, state/image loading, and PC device models. |
| `src/rust/` | x86 interpreter, paging, JIT analysis/codegen, Wasm builder, and CPU internals. |
| `src/browser/` | Public `V86` wrapper, UI entry, display/input/audio/network/filesystem adapters. |
| `lib/` | 9p protocol, in-memory filesystem, marshalling, vendored SoftFloat and zstd C sources. |
| `gen/` | Node generators and `x86_table.js`, the source of generated opcode dispatch code. |
| `tests/` | API, device, boot, differential CPU, JIT paging, golden Wasm, Rust, manual, and benchmark suites. |
| `examples/` | Browser and Node embedding/lifecycle examples. |
| `tools/`, `bios/` | Image/filesystem utilities, linker wrapper, containers, and BIOS assets/build scripts. |
| `docs/` | Architecture, networking, 9p, profiling, and guest setup notes. |

## Development Commands

The root `Makefile` is authoritative; `package.json` has no scripts.

```sh
make                         # debug Wasm for debug.html
make all                     # optimized JS/MJS and build/v86.wasm
make all-debug               # debug library bundles and Wasm
make run                     # serve on http://localhost:8000 via Python
make eslint                  # lint JS in src/tests/gen/lib/examples/tools
make rustfmt                 # check Rust formatting
make api-tests               # public API behavior
make devices-test            # device integrations; can hang locally
make nasmtests               # CPU/ISA fixtures
make qemutests               # differential run against QEMU
make acpi-unit-test           # ACPI GPE status/enable semantics
make pci-unit-test            # shared PCI INTx ownership and restore
make virtio-gpu-unit-test     # protocol, state, and memory backend
make virtio-gpu-test          # source build plus Alpine Linux probe
make virtio-gpu-test-release  # release bundle plus Alpine Linux probe
make jitpagingtests          # JIT/paging interaction
make expect-tests            # generated-Wasm golden files
make rust-test               # Cargo tests plus Wasm output verification
make tests                   # OS-boot integration suite
make all-tests               # broad local suite; intentionally omits devices-test
```

Integration images are external and ignored. Use the image download command in `Readme.md` before image-dependent suites. `make run` is required instead of `file://` because ROMs and disks are fetched over HTTP.

## Code Conventions & Common Patterns

- JavaScript is ESM, four-space indented, double-quoted, semicolon-terminated, and uses Allman braces. ESLint intentionally requires `if(...)`/`for(...)` without a space before `(`.
- Prefer existing constructor-function/prototype style in core JS. Constructors use PascalCase; functions, methods, and fields are predominantly `snake_case`; constants are uppercase. Preserve JSDoc because Closure uses it for checks.
- There is no dependency-injection framework. Pass collaborators (`bus`, Wasm exports, adapters, buffers) explicitly; use the paired event bus for existing cross-component channels.
- Async work is concentrated at resource, filesystem, and lifecycle boundaries. Public methods often return promises, while the device bus is synchronous by default. Test runners rethrow unhandled rejections.
- Use `dbg_assert`/`dbg_log` for JS invariants and category-based diagnostics. Rust uses `Result` for guest faults and many `unsafe`/`#[no_mangle]` ABI functions; preserve established boundary checks.
- Treat compact typed arrays, integer coercions, bit masks, and positional state arrays as intentional performance patterns. Avoid allocations or object wrappers in hot CPU/device paths.
- Do not edit ignored `src/rust/gen/{interpreter,jit,analyzer}*.rs` directly. Change `gen/x86_table.js` or the relevant `gen/generate_*.js` source and rebuild.
- Rust is edition 2021 and follows `.rustfmt.toml`; some opcode symbols intentionally encode instruction form, for example `instr16_01_reg`.

## Important Files

- `Makefile`: build graph, generated sources, Closure/Cargo flags, and all QA targets.
- `src/main.js`, `src/browser/starter.js`, `src/cpu.js`: runtime loop, public API initialization, and JS/Wasm bridge.
- `src/rust/cpu/cpu.rs`, `src/rust/jit.rs`, `src/rust/codegen.rs`: CPU loop, hot-code compilation, and Wasm emission.
- `src/bus.js`, `src/io.js`, `src/state.js`: component messaging, device I/O dispatch, and save/restore format.
- `gen/x86_table.js`: canonical instruction table used by interpreter/JIT/analyzer generators.
- `v86.d.ts`: public API contract; currently marked experimental/incomplete.
- `Cargo.toml`, `.cargo/config.toml`, `eslint.config.mjs`, `.rustfmt.toml`: compiler and style settings.
- `.github/workflows/ci.yml`: definitive CI toolchain and suite list.
- `Readme.md`, `docs/how-it-works.md`, `tests/Readme.md`: setup, architecture, and test controls.
- `src/virtio_gpu.js`, `src/browser/virtio_gpu_backend.js`, `src/browser/virtio_gpu_wgpu_backend.js`, `src/browser/virtio_gpu_webgpu_backend.js`: VirtIO GPU protocol device, renderer-independent contract, shared browser WebGPU adapter, and direct JavaScript WebGPU renderer.
- `tools/virtio-gpu-wgpu/`: independent Rust/Wasm `wgpu` renderer with its own manifest and committed lockfile.
- `docs/virtio-gpu-webgpu.md`: implemented 2D protocol, both browser renderers, state and failure invariants, Linux KMS proof, browser setup, 2D hardening, and the gated 3D/Mesa roadmap.
- `tools/docker/virtio-gpu-alpine/`: reproducible i386 guest inputs, package locks, probe, build pipeline, and reviewed checksum contract.

## Runtime/Tooling Preferences

- Use GNU Make as the task runner and Node.js as the JavaScript runtime; do not substitute Bun. CI pins Node `24.17.0`; the README identifies recent Node (`24.16` known working). The repository has no JS dependency lockfile or pinned package manager.
- Rust stable with `wasm32-unknown-unknown`, Cargo, Clang, and `tools/rust-lld-wrapper` builds the core. The optional `tools/virtio-gpu-wgpu/` renderer also requires `wasm-bindgen`; keep it outside the root crate. Java is required for optimized Closure builds; Python 3 serves files and powers utilities.
- Full QA additionally needs NASM, GDB, QEMU, 32-bit GCC/libc, rustfmt, and downloaded guest images. The dev container provides an amd64 Linux toolchain.
- The virtio-gpu Linux fixture additionally needs Docker with `linux/386` emulation and Python `zstandard`. Generated files under `images/` remain ignored; commit only reviewed fixture inputs and `image-contract.json`.
- `build/`, `images/`, generated Rust dispatch files, Wasm, maps, objects, and the root `Cargo.lock` are ignored. `tools/virtio-gpu-wgpu/Cargo.lock` is intentionally committed for deterministic renderer builds. Do not commit generated artifacts unless a release workflow explicitly requires them.

## Testing & QA

JavaScript tests are standalone Node ESM scripts using `node:assert/strict` and custom event/timeout harnesses; there is no Jest/Mocha/Vitest layer. Rust uses `cargo test`. CPU correctness relies heavily on differential and golden tests:

- `tests/api/`: public lifecycle, media, serial, PIC, and state behavior.
- `tests/nasm/`: deterministic GDB-generated CPU/FPU/register fixtures.
- `tests/qemu/`: v86 output diffed against QEMU.
- `tests/expect/`: assembly-to-Wasm golden output; review diffs before accepting updates.
- `tests/full/`, `tests/devices/`, `tests/jit-paging/`, `tests/kvm-unit-tests/`: boot, device, paging/JIT, and bare-metal integration.
- `tests/unit/`: standalone protocol and PCI shared-interrupt tests.

Common controls are `TEST_RELEASE_BUILD=1`, `MAX_PARALLEL_TESTS=n`, and `TEST_NAME="..."`; full tests also support `RUN_SLOW_TESTS`, `TIMEOUT_EXTRA_FACTOR`, `LOG_LEVEL`, `DISABLE_JIT`, and `TEST_ACPI`. Select the narrow suite for the changed contract, then match CI coverage for cross-cutting changes. CI runs device tests separately even though `make all-tests` omits them due to hangs. For browser GPU work, run `make virtio-gpu-unit-test`, serve the repository over localhost, and boot the reproducible Alpine guest with `virtio_gpu.backend: "webgpu-js"`; also run `make virtio-gpu-wgpu` and repeat with `"wgpu"` when shared adapter or protocol behavior changes. Inspect the WebGPU canvas and console validation errors. No coverage tool, threshold, or report is configured; correctness is enforced through targeted behavioral, differential, and golden assertions.
