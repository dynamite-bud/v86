# JIT and run-loop performance baseline (2026-08, XWAH-11)

Single-core performance baseline for the v86 JIT and run loop, measured on the
merged multi-core branch (`ffdd237a`, single-vCPU fast path). Produced under
XWAH-11; no optimizations land under this report — it ranks candidates and
gives each of the issue's hypotheses a data-backed verdict.

## Environment

| | |
| --- | --- |
| Host | Apple M4 (10 cores), 16 GB RAM, macOS 15.6, SSD |
| Node | v24.18.0 |
| Rust | rustc 1.97.1, `wasm32-unknown-unknown`, release profile |
| Tree | branch `feature/XWAH-11/jit-profiling-baseline` at `ffdd237a` |
| Discipline | machine otherwise quiet; all builds completed before any measurement; runs strictly sequential |

Builds used (built once, stashed, swapped per configuration):

```sh
make build/v86.wasm     # release, "release" configuration
make with-profiler      # release + `profiler` cargo feature (overwrites build/v86.wasm)
make build/v86-debug.wasm  # built for completeness; not measured
```

## Methodology

All runs are headless Node (no browser). Harnesses live outside the repo in
`/Volumes/Xorcist-SSD/tmp/xwah11/` (`boot-bench.js`, `alpine-cpu-bench.js`,
`stats-collect.js`, `analyze-cpuprof.js`, `run-all.sh`); raw logs, profiler
stats JSON and `.cpuprofile` files are under
`/Volumes/Xorcist-SSD/tmp/xwah11/{runs,cpuprof}/`. The harnesses import
`src/main.js` with `globalThis.DEBUG = false` set first (disables `dbg_assert`
/ `dbg_log` at runtime) and pass `wasm_path` explicitly, which reproduces
release-bundle semantics without a Closure build. `tests/node_web_worker.js`
provides the Worker shim for 9p image loading.

Workloads (adapted from the issue because no archlinux images are available
locally — `arch-bytemark.js` / `arch-python.js` could not run):

1. **Boot**: linux3.iso boot to shell prompt, exactly the image and config of
   `tests/benchmark/linux-boot.js` (32 MB RAM, `log_level: 0`). Wall clock from
   `emulator-started` to the serial prompt.
2. **CPU-bound**: the Alpine virtio-gpu codex 9p fixture
   (`images/alpine-virtio-gpu-codex-fs.json`, SMP-capable linux-lts 6.18
   kernel, 512 MB RAM, `init=/bin/sh`, single vCPU), running a busybox-awk
   integer loop over serial:
   `awk 'BEGIN{s=0;for(i=0;i<N;i++)s+=i%7;print ...}'` with `N`=2,000,000
   (≈12.93 G guest instructions, ≈6,460 per awk iteration) or 200,000 for the
   DISABLE_JIT comparison. Host wall clock between serial markers; busybox
   `time` captured as guest-side cross-check (guest real time tracked host
   wall clock within ~0.1% in every run).
3. **MIPS**: `instruction_counter` (32-bit, sampled every 200 ms with
   wraparound accumulation) delta over the measured window.

Per configuration: 3 boots; the CPU-bound workload additionally runs 3
iterations per boot. Profiler counters are captured with the `with-profiler`
build via the same exports `src/browser/print_stats.js` uses
(`profiler_stat_get`, `get_opstats_buffer`); for the CPU-bound workload,
`profiler_init()` resets the misc counters at workload start and the opcode
buffers are snapshot-diffed, so those stats exclude boot.

## Phase 1 — Baselines (release build)

### Boot to shell (linux3.iso)

| config | runs, wall ms | mean ± sd | MIPS |
| --- | --- | --- | --- |
| JIT on | 1725, 1738, 2031 | 1831 ± 173 | 157 / 158 / 582 (see note) |
| DISABLE_JIT=1 | 3394, 3365, 3365 | 3375 ± 17 | 78.3–79.7 |

JIT on/off wall delta at boot: **1.84x**. Note: with the JIT on, boot
instruction counts are bimodal (270 M / 275 M / 1182 M; a warmup smoke run
also hit 1.44 G at 626 MIPS) — the guest appears to spend a
timing-dependent amount of boot busy-spinning, so boot MIPS is not a stable
metric; wall clock is. Without the JIT the count is stable (266–268 M).

### CPU-bound (Alpine, awk loop, host wall per iteration)

| config | iterations, wall ms | mean ± sd | MIPS mean (range) |
| --- | --- | --- | --- |
| JIT on, N=2M, 3 boots × 3 iters | 22922, 24078, 30085 / 31018, 27721, 26219 / 28512, 26445, 28022 | 27225 ± 2625 | 479 (417–563) |
| JIT on, N=200k, 1 boot × 3 iters | 2302, 2178, 2944 | 2475 | 532 (440–593) |
| DISABLE_JIT=1, N=200k, boots 1–2 | 21127, 20239, 22194 / 19119, 18835, 19203 | 20120 ± 1330 | 67.8 (61.3–72.1) |
| DISABLE_JIT=1, N=200k, boot 3 (outlier) | 32324, 78088, 47119 | — excluded | 17.6–42.2 |

- **JIT on/off delta on CPU-bound guest code: 8.1x wall** (20120 ms vs
  2475 ms at identical N; 7.8x by MIPS). ≈2.1 ns per guest instruction with
  the JIT, ≈14.8 ns without.
- Variance with JIT on is real and sizeable (±10–15% across runs; intra-run
  drift downward, e.g. 563→536→430 MIPS within one boot). The no-JIT boot-3
  outlier (2–4x slower, host interference or thermal suspected) is excluded
  from means but retained above.
- Alpine boot-to-shell: 14.2 / 24.5 / 17.8 s (JIT), 43.0 / 34.1 / 34.4 s
  (no JIT) — includes 9p rootfs loading from the host, so it is not a pure
  CPU benchmark.

## Phase 2 — JIT-internal profile (`make with-profiler`)

**Observer effect (release vs with-profiler wall clock, same workloads):**
boot 1831→2731 ms (**1.49x**); CPU-bound iteration 27225→47773 ms
(**1.75x**, 267–282 MIPS). The instrumentation (per-opcode counters compiled
into generated code) is heavy; counter *ratios* below are meaningful,
absolute wall times from profiler builds are not.

### Steady-state CPU-bound workload (counters reset at workload start; 2 runs, both shown)

| counter | run 1 | run 2 |
| --- | --- | --- |
| RUN_INTERPRETED_STEPS | 443.9 M | 443.9 M |
| RUN_FROM_CACHE_STEPS | 38.65 G | 38.69 G |
| **interpreted share of steps** | **1.14%** | **1.13%** |
| RUN_FROM_CACHE (entries into compiled code) | 2.32 G | 2.63 G |
| **steps per compiled-code entry** | **16.7** | **14.7** |
| RUN_FROM_CACHE_EXIT_DIFFERENT_PAGE | 2.12 G (91%) | 2.44 G (93%) |
| RUN_FROM_CACHE_EXIT_NEAR_END_OF_PAGE | 129.4 M | 129.4 M |
| RUN_FROM_CACHE_EXIT_SAME_PAGE | 68.3 M | 68.4 M |
| RUN_INTERPRETED (entries) | 130.0 M | 129.9 M |
| … of which NEAR_END_OF_PAGE | 129.4 M (99.6%) | 129.4 M |
| INDIRECT_JUMP | 2.08 G | 2.08 G |
| INDIRECT_JUMP_NO_ENTRY | 1.21 G (58%) | 1.46 G (70%) |
| CONDITION_OPTIMISED | 3.53 G | 3.53 G |
| CONDITION_UNOPTIMISED | 1.02 G (22.4%) | 1.02 G |
| CONDITION_UNOPTIMISED_PF | 12.0 M | 12.0 M |
| CONDITION_UNOPTIMISED_UNHANDLED_L / _LE | 0 | 0 |
| COMPILE / COMPILE_PAGE | 18 / 48 | 18 / 47 |
| COMPILE_WASM_TOTAL_BYTES | 3.45 MB | 2.92 MB |
| INVALIDATE_ALL_MODULES_NO_FREE_WASM_INDICES | **0** | **0** |
| other INVALIDATE_* | 0 | 3 |
| WASM_TABLE_FREE (of 899) | 641 | 643 |
| MAIN_LOOP / DO_MANY_CYCLES | 113.6 k / 390.9 k | 131.0 k / 391.3 k |

The headline: in steady state the JIT covers ~99% of executed steps, but
compiled code is entered ~16–17 M times per second and **exits on average
every ~15–17 guest instructions**, over 90% of the time because control
transfers to a different page (`MAX_PAGES = 3` modules; cross-page
call/ret/jmp forces an exit through the dispatch loop). The 130 M residual
interpreted entries are almost entirely `NEAR_END_OF_PAGE` stubs averaging
3.4 steps each — pure transition overhead, not "cold code".

Top opcodes by **jit-exit** count (run 1): `c3` ret 941 M, `e8` call 889 M,
`ff /mem` indirect call/jmp 270 M, `e9` jmp 60.5 M, `f3` rep 60.4 M — i.e.
the exits are call/return traffic, matching the different-page exit counts.
Top opcodes by dynamic execution count: `8b` mov r,m 3.99 G, `83` grp1 3.13 G,
`89` mov m,r 2.39 G, `e8` call 1.72 G, `c3` ret 1.72 G — ordinary
interpreter-loop code.

### Boot workload (cumulative, 3 runs)

- Interpreted share of steps: **16.4% / 13.7% / 16.4%** — the interpreter is
  a first-order cost at boot, unlike steady state. `RUN_INTERPRETED` entries
  average ~38 steps; compiled entries average 278–460 steps (much less churn
  than the awk workload).
- COMPILE_PAGE ≈ 113 pages, COMPILE_WASM_TOTAL_BYTES 8.8–9.7 MB per boot;
  `JIT_THRESHOLD = 200_000` means every eventually-hot page first burns
  ≥200 k interpreted steps, and short-lived boot code never compiles at all.
- Top jit-exit opcodes: again `c3`/`e8` (323 k / 204 k), plus string/flag ops
  (`f3`, `ae`, `f2`, `9d`).
- INVALIDATE_ALL_MODULES_NO_FREE_WASM_INDICES = 0 in all runs;
  WASM_TABLE_FREE never dropped below 873/899 (boot) or 641/899 (Alpine).

## Phase 3 — Host-level profile (`node --cpu-prof`, release build)

Self-time by category (sum of sampled self time):

| category | boot (1.94 s span) | CPU-bound Alpine (59.7 s span, incl. 14 s boot/idle) |
| --- | --- | --- |
| wasm (all modules) | 85.1% | 88.7% |
| idle | 2.1% | 9.7% (mostly the boot/shell-wait phase) |
| js: v86 (`src/`) | 6.0% | 0.5% |
| js: node/other | 4.1% | 0.5% |
| GC | 1.4% | 0.1% |
| (program) | 1.4% | 0.6% |

CPU-bound top self-time frames: `do_many_cycles_native` 16.3%,
`jit_find_cache_entry_in_page` 2.8%, Rust std SipHash/`DefaultHasher` frames
~1.6%, `gen::interpreter::run` 3.4%, `modrm_resolve` + `read_imm*` ~2.9%;
the rest is spread across 270 distinct generated JIT modules (top single
module 11.7%). Split within wasm: **~39% main `v86.wasm` module
(dispatch + interpreter + helpers), ~61% generated JIT code**. The
dispatch-machinery self time (`do_many_cycles_native` + cache lookup +
hashing ≈ 20% of all samples) is the host-side face of the Phase 2 exit
churn.

Boot top frames: interpreter core dominates (`gen::interpreter::run` 9.9%,
`read_imm8` 4.5%, `modrm_resolve` 3.9%, `safe_read32s` 2.7%) beside
`do_many_cycles_native` 10.6%; largest JS frames are `h()` string formatting
(1.5%) and `VGAScreen.text_mode_redraw` (1.4%).

Node-specific caveat: in Node the run loop yields via
`setImmediate`/`setTimeout` (`src/main.js`), not the browser Blob-worker
timer; browser scheduling overhead, `postMessage` round-trips and DevTools
tracing are **out of scope for this pass** and remain follow-up work.

## Findings, ranked by estimated wall-clock impact

1. **Compiled-block exit churn on cross-page control flow** (CPU-bound
   steady state). ~2.3–2.6 G dispatch round-trips per ~39 G steps; ≥20% of
   host samples in dispatch machinery, plus whatever execution locality the
   16-instruction bursts destroy inside generated code. Largest single
   lever for guest compute throughput.
2. **Interpreter share at boot (14–16% of steps)** driven by
   `JIT_THRESHOLD = 200_000` warmup and short-lived pages; interpreter
   frames are the top boot self-time. Affects boot/startup UX rather than
   steady-state compute.
3. **`NEAR_END_OF_PAGE` interpreted stubs**: 129 M entries × 3.4 steps in the
   CPU-bound run — every occurrence is a cache-exit→interpret→re-dispatch
   bounce at a page tail. Same root cause family as (1).
4. **Lazy-flags misses**: 22% of conditional evaluations take
   `CONDITION_UNOPTIMISED`; the named sub-causes (PF, L, LE) explain only
   ~1% of it, so the bulk is unattributed and worth a counter improvement
   before optimizing.
5. **Observer effect of the profiler feature is 1.5–1.75x** — fine for
   ratios, unusable for absolute timing; keep release wall-clock runs beside
   any counter work.

## Verdicts on the issue's hypotheses

| hypothesis | verdict | evidence |
| --- | --- | --- |
| `WASM_TABLE_SIZE = 900` exhaustion flushes all modules | **not reproduced** in these workloads | `INVALIDATE_ALL_MODULES_NO_FREE_WASM_INDICES = 0` in all 5 profiler runs; ≥641 of 899 slots always free. May still bite larger guests (desktop images); needs a bigger workload to confirm. |
| `JIT_THRESHOLD = 200_000` too high | **supported for boot-type workloads** | 14–16% of boot steps interpreted; 113 compiled pages × 200 k warmup steps ≈ half the interpreted volume. Irrelevant in steady state (1.1% interpreted). |
| `MAX_PAGES = 3` / cross-page exits | **supported, top finding** | 91–93% of cache exits leave the page group; ret/call/indirect are the top jit-exit opcodes; ~15–17 steps per compiled entry. |
| `view()` Proxy tax | **not measurable in Node runs** | total JS self time 0.5% (CPU-bound) / 6% (boot); GC ≤1.4%. Browser story untested — the Proxy is unconditional in all builds, so a browser pass should re-check. |
| `run_hardware_timers` per-loop cost | **minor on Node** | called once per `do_many_cycles_native` slice (~2.8 k/s at 100 k instructions per slice), total `js: v86` self time 0.5% of the CPU-bound profile. |
| 1 ms `TIME_PER_FRAME` scheduling loss | **minor on Node** | guest real time == host wall within ~0.1% during compute; `MAIN_LOOP_IDLE` ≈ 0 during workload; Node yields via `setImmediate`. Browser Blob-worker path untested. |
| sync `codegen_finalize` stalls | **premise false** | `SYNC_COMPILATION = false` in `src/cpu.js`; modules are instantiated via async `WebAssembly.instantiate`. Compile volume in steady state is trivial (≤3.5 MB, 18 compile events). |

## Proposed follow-up issues (not created yet)

- `XWAH: Reduce compiled-code exit churn on cross-page call/ret (module linking or larger MAX_PAGES)` — from finding 1.
- `XWAH: Cheapen the hot dispatch path (jit_find_cache_entry SipHash → direct-mapped/FxHash lookup)` — from finding 1's host profile.
- `XWAH: Eliminate NEAR_END_OF_PAGE interpret-bounce at page tails` — from finding 3.
- `XWAH: Tiered or lower JIT_THRESHOLD for boot-heavy workloads` — from finding 2.
- `XWAH: Attribute the unexplained 22% CONDITION_UNOPTIMISED share` — from finding 4.
- `XWAH: Browser-side run-loop profile (DevTools tracing, Blob-worker yield, view() Proxy)` — the deferred browser pass.

## Reproduction

```sh
# builds (in order; with-profiler overwrites build/v86.wasm — stash between)
make build/v86.wasm && cp build/v86.wasm <stash>/v86-release.wasm
make with-profiler  && cp build/v86.wasm <stash>/v86-profiler.wasm

# harnesses + raw data (this machine)
/Volumes/Xorcist-SSD/tmp/xwah11/run-all.sh          # full matrix
/Volumes/Xorcist-SSD/tmp/xwah11/runs/               # logs + stats JSON
/Volumes/Xorcist-SSD/tmp/xwah11/cpuprof/            # .cpuprofile files
node /Volumes/Xorcist-SSD/tmp/xwah11/analyze-cpuprof.js <file.cpuprofile>
```
