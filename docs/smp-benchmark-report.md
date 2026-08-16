# XWAH-9 Phase 4 benchmark report: worker-per-vCPU execution

Stage W5 acceptance run against the bar in
[smp-phase4-design.md](smp-phase4-design.md) §9 ("Benchmark acceptance").
Harness: `tests/benchmark/smp-workers.js` (reusable; reproduces this table).

**Verdict: all four gates PASS** (details below). Run date: 2026-08-15.

## Environment

- Host: Apple M4 (arm64), macOS (Darwin 24.6.0), otherwise idle
- Runtime: Node v24.18.0 (V8 13.6), `worker_threads` workers
- Artifacts: release `build/libv86.mjs` + `build/v86-multimem.wasm`
  (wasm-opt'd), JIT on
- Guest: the Alpine SMP fixture (`images/alpine-virtio-gpu-codex-fs.json`,
  9p root, `tsc=reliable`, `init=/bin/sh`)

## Configurations

All configurations run over the imported guest-memory backend
(`guest_memory_backend: "imported"`), so the artifact and memory backend
are identical across modes and the comparison isolates the execution
topology (the `machine-in-worker-boottime.js` comparability rule).

| Name | Options | Meaning |
| --- | --- | --- |
| `percpu2` | `cpus: 2, smp_workers: true, smp_worker_topology: "percpu"` | the subject: one worker per vCPU, topology (b) |
| `worker1` | `cpus: 1, smp_workers: true, smp_worker_topology: "percpu"` | 1-vCPU worker baseline of gate (1) |
| `timesliced2` | `cpus: 2` | the landed time-sliced scheduler |
| `percpu4` | `cpus: 4, smp_workers: true, "percpu"` | informative, not gated |

## Workloads

The fixture is busybox-only (no compiler), so per design §9 the
"`make -j2` of a small C tree" mixed workload is approximated by two
cooperating pipelines over tmpfs files — multiple processes, mixed
CPU/pipe/VFS/syscall work:

| Name | Command (per job) | Class |
| --- | --- | --- |
| `cpu2` | 2 × (`dd if=/dev/zero bs=1M count=256 \| md5sum`) in background + `wait` | CPU-bound fixed work, negligible device I/O |
| `mixed2` | 2 × (`gzip -c /bench/fN \| zcat \| awk '{s+=$1} END {print s}'`) + `wait`; `f1`/`f2` are 600k-line `seq` outputs on tmpfs | mixed `make -j2`-style proxy |
| `single` | 1 × (`dd \| md5sum`) | single-thread regression probe |
| `cpu4` | 4 × (`dd \| md5sum`) | informative, `percpu4` only |

## Methodology

One boot per configuration; one untimed warmup round (JIT warmup, page
cache); then 5 rounds, workloads interleaved within each round so host
drift spreads across all cells. Wall time is measured on the host between
the serial arrival of unique `ST-n`/`SP-n` marker lines around each
workload. Medians decide the gates; the spread column is min..max over the
5 runs. The machine ran nothing else during the benchmark.

## Results

Medians over 5 runs; spread is min..max. All times are wall-clock seconds.

| Config | `cpu2` | `mixed2` | `single` | `cpu4` |
| --- | --- | --- | --- | --- |
| `percpu2` | **3.67** (3.59..3.77) | **10.77** (10.54..10.92) | **3.11** (2.97..3.18) | — |
| `worker1` | 5.71 (5.68..6.29) | — | 2.83 (2.80..2.88) | — |
| `timesliced2` | 6.36 (6.32..6.57) | 20.76 (20.54..21.09) | 3.44 (3.28..5.14) | — |
| `percpu4` (informative) | 3.76 (3.40..12.06) | 10.90 (10.15..30.39) | — | 5.68 (4.63..15.93) |

Resolved `smp_mode` per config (evidence the intended mode ran): `percpu2`/
`worker1`/`percpu4` reported `{execution: "workers", topology: "percpu",
memory_model: "relaxed", guest_memory: {backend: "imported", shared: true}}`
with the respective `cpus_effective`; `timesliced2` reported
`{execution: "time-sliced", topology: null}` over the same backend.

## Acceptance verdict

| # | Gate (design §9) | Bar | Measured | Verdict |
| --- | --- | --- | --- | --- |
| 1a | CPU-bound 2-process vs `cpus: 1` worker | ≥ 1.5× | 5.71 / 3.67 = **1.56×** | **PASS** |
| 1b | CPU-bound 2-process vs `cpus: 2` time-sliced | ≥ 1.4× | 6.36 / 3.67 = **1.74×** | **PASS** |
| 2 | mixed 2-process pipeline vs time-sliced | ≥ 1.15× | 20.76 / 10.77 = **1.93×** | **PASS** |
| 3 | single-thread regression vs time-sliced | ≤ 10 % | 3.11 vs 3.44 = **−9.6 %** (faster) | **PASS** |
| 4 | zero lost updates across Layer C | zero | see next section | **PASS** |

Notes, honestly stated:

- Gate 1a is the narrowest margin (1.56× vs the 1.5× bar). The `worker1`
  baseline runs the same 2-process workload serialized on one worker vCPU;
  its per-process throughput benefits from zero cross-vCPU interference,
  which is exactly what the gate is designed to price in.
- Gate 3 is *negative*: the single-thread probe is FASTER under per-vCPU
  workers than time-sliced. Two mechanisms: worker mode has no per-slice
  vCPU rotation (the phase-2 switch tax, incl. its TLB flush, disappears
  when each vCPU owns an instance), and the idle vCPU parks on its
  doorbell instead of burning slices. The time-sliced `single` cell also
  shows the largest relative spread (one 5.14 s outlier round).
- `percpu4` runs 4 workers plus the device-host thread and the Node
  event loop on a 10-core (4P+6E) host; occasional rounds land workers on
  E-cores or contend with host work, producing the large max outliers
  (12–30 s). Medians are representative of the steady state; 4-vCPU
  numbers are informative only and not gated. `cpu4` (4×256 MiB) at
  5.68 s vs `cpu2` at 3.67–3.76 s shows real but sub-linear 4-way
  scaling on this host mix.
- The mixed-workload speedup (1.93×) exceeding the CPU-bound one (1.74×)
  is expected on reflection: the time-sliced scheduler serializes the
  pipeline processes AND pays the vCPU switch tax on every slice, while
  the 9p/device serialization the 1.15× bar priced in is amortized by
  tmpfs (page-cache) I/O that never leaves guest RAM.

## Gate 4: zero lost updates

Not re-measured here — the Layer C suite is the evidence, all green at W5
landing on the same host/artifacts:

- `tests/threads/vcpu-workers-lock.js` — 2×500k concurrent `lock inc`
  exact under an interrupt storm; INIT/SIPI restart adds exactly K; 20k
  misaligned page-crossing locked RMWs exact against 200k concurrent
  aligned ones; 2×20k contending exclusive RMWs exact
- `tests/threads/guest-lock-exactness.js` — interpreter+JIT LOCK lowering
  exact vs a racing JS atomics contender
- `tests/threads/invlpg-storm.js` — 10k guest-driven remap+INVLPG+IPI
  rounds, zero stale translations, every IPI delivered exactly once
- `tests/threads/tso-litmus.js` — histogram sums exact (every trial
  recorded exactly once) in all four passes
- `tests/threads/vcpu-workers-smp.js`, `worker-save-restore.js`,
  `worker-reboot.js`, `worker-failure.js` — no soft-lockup splats, no
  lost wakeups across boot/save/reboot/failure paths
