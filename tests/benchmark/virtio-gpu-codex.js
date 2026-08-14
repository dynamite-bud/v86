import {
    capture_diagnostics,
    machine_info,
    publish_result,
    sleep,
    start_health_metrics,
    wait_until,
} from "./virtio-gpu-desktop.js";

const TOTAL_RUNS = 7;
const WARMUP_RUNS = 2;
const MEASURED_RUNS = TOTAL_RUNS - WARMUP_RUNS;
const READY_TIMEOUT_MS = 300000;
const RUN_TIMEOUT_MS = 60000;
const PRESENT_QUIET_MS = 250;

export function create_virtio_gpu_codex_benchmark(options)
{
    const page_started = performance.now();
    const diagnostics = capture_diagnostics();
    const benchmark = {
        result: null,
        done: null,
        run(emulator)
        {
            if(this.done)
            {
                return this.done;
            }
            this.done = run_benchmark(emulator, options, diagnostics, page_started).then(result =>
            {
                this.result = result;
                publish_result(result);
                return result;
            }, error =>
            {
                const result = failure_result(options, diagnostics, error);
                this.result = result;
                publish_result(result);
                return result;
            }).finally(() => diagnostics.restore());
            return this.done;
        },
    };
    return benchmark;
}

async function run_benchmark(emulator, options, diagnostics, page_started)
{
    await wait_until(() =>
    {
        if(document.body.dataset.result === "fail")
        {
            throw new Error(document.getElementById("status")?.textContent ||
                "Appliance reported readiness failure");
        }
        return document.body.dataset.result === "pass" &&
            serial_text().includes("V86_GHOSTTY_BENCHMARK_READY=PASS");
    }, READY_TIMEOUT_MS, "Ghostty benchmark readiness");
    const readiness_ms = performance.now() - page_started;

    const device = emulator?.v86?.cpu?.devices?.virtio_gpu;
    if(!device || !device.backend)
    {
        throw new Error("The live virtio-gpu device is unavailable");
    }
    await device.backend_ready;
    const backend = device.backend;
    const presentation_probe = instrument_present_completion(backend);
    const runs = [];
    let reference_hash = null;

    try
    {
        document.getElementById("screen_container").focus();
        for(let run = 0; run < TOTAL_RUNS; run++)
        {
            await wait_for_serial(`V86_GHOSTTY_BENCHMARK_WAIT=${run}`, RUN_TIMEOUT_MS);
            device.get_performance_stats(true);
            presentation_probe.begin();
            const health = start_health_metrics();
            const input_started = performance.now();
            try
            {
                await emulator.keyboard_send_text(`run-${run}\n`);
                await wait_for_serial(`V86_GHOSTTY_BENCHMARK_BEGIN=${run}`, RUN_TIMEOUT_MS);
                await wait_for_serial(`V86_GHOSTTY_BENCHMARK_STREAM_DONE=${run}`, RUN_TIMEOUT_MS);
                const first_presentation_at = await presentation_probe.wait_for_first(RUN_TIMEOUT_MS);
                const quiet_at = await presentation_probe.wait_for_quiet(
                    PRESENT_QUIET_MS, RUN_TIMEOUT_MS);
                const frame = await capture_canvas_hash(backend.canvas);
                await emulator.keyboard_send_text(`ack-${run}\n`);
                const marker = await wait_for_run_result(run, RUN_TIMEOUT_MS);
                const ended = performance.now();
                health.stop();
                const guest_cpu_ms = marker.guest_cpu_ticks * 1000 / marker.clock_ticks;
                const measured = run >= WARMUP_RUNS;
                if(measured)
                {
                    if(reference_hash === null)
                    {
                        reference_hash = frame.sha256;
                    }
                    else if(frame.sha256 !== reference_hash)
                    {
                        throw new Error(
                            `Terminal reference changed: ${frame.sha256} != ${reference_hash}`);
                    }
                    const elapsed_ms = quiet_at - input_started;
                    runs.push({
                        run: run - WARMUP_RUNS + 1,
                        guest_cpu_ms,
                        keystroke_to_present_ms: first_presentation_at - input_started,
                        output_to_last_present_ms: elapsed_ms,
                        output_bytes: marker.output_bytes,
                        output_lines: marker.lines,
                        text_throughput_mib_s: marker.output_bytes * 1000 /
                            elapsed_ms / (1024 * 1024),
                        scroll_throughput_lines_s: marker.lines * 1000 / elapsed_ms,
                        host_elapsed_ms: ended - input_started,
                        terminal_reference: frame,
                        gpu: device.get_performance_stats(),
                        browser_health: health.summarize(ended - input_started),
                    });
                }
            }
            finally
            {
                health.stop();
                presentation_probe.end();
            }
        }
    }
    finally
    {
        presentation_probe.restore();
    }

    if(runs.length !== MEASURED_RUNS)
    {
        throw new Error(`Expected ${MEASURED_RUNS} measured runs, received ${runs.length}`);
    }
    const failures = diagnostics.snapshot(backend, backend.renderer);
    if(failures.backend_fatal || failures.renderer_fault || failures.validation_message_count)
    {
        throw new Error(`GPU diagnostics failed: ${JSON.stringify(failures)}`);
    }

    return {
        schema_version: 1,
        status: "pass",
        scenario: {
            appliance: "openbox-ghostty-codex",
            renderer: options.renderer,
            guest_renderer: options.accelerated ? "webgpuvirt" : "llvmpipe",
            accelerated_3d: options.accelerated,
        },
        machine: await machine_info(options.machine),
        method: {
            workload: "Ghostty PTY consumes a fixed ANSI stream, 512 scrolling lines, and a 24-line reference frame",
            synchronization: "two warmups plus five keyboard-triggered runs; each run acknowledges after WebGPU presentations quiesce",
            readiness: "V86_APPLIANCE_READY=PASS plus V86_GHOSTTY_BENCHMARK_READY=PASS",
            warmup_runs: WARMUP_RUNS,
            measured_runs: MEASURED_RUNS,
            presentation_quiet_ms: PRESENT_QUIET_MS,
            readiness_ms,
        },
        summary: {
            guest_cpu_ms: distribution(runs.map(run => run.guest_cpu_ms)),
            keystroke_to_present_ms: distribution(
                runs.map(run => run.keystroke_to_present_ms)),
            output_to_last_present_ms: distribution(
                runs.map(run => run.output_to_last_present_ms)),
            text_throughput_mib_s: distribution(
                runs.map(run => run.text_throughput_mib_s)),
            scroll_throughput_lines_s: distribution(
                runs.map(run => run.scroll_throughput_lines_s)),
        },
        terminal_reference_sha256: reference_hash,
        raw_runs: runs,
        failures,
    };
}

function instrument_present_completion(backend)
{
    if(typeof backend.flush !== "function")
    {
        throw new Error("Cannot instrument missing backend flush method");
    }
    const own_descriptor = Object.getOwnPropertyDescriptor(backend, "flush");
    const original = backend.flush;
    let active = null;
    Object.defineProperty(backend, "flush", {
        configurable: true,
        writable: true,
        async value(...args)
        {
            const result = await original.apply(this, args);
            if(active)
            {
                const completed_at = performance.now();
                active.count++;
                active.last_completed_at = completed_at;
                if(active.first_completed_at === null)
                {
                    active.first_completed_at = completed_at;
                }
            }
            return result;
        },
    });

    return {
        begin()
        {
            active = {
                count: 0,
                first_completed_at: null,
                last_completed_at: null,
            };
        },
        end()
        {
            active = null;
        },
        async wait_for_first(timeout_ms)
        {
            const sample = active;
            await wait_for(() => sample.first_completed_at !== null,
                timeout_ms, "first workload presentation");
            return sample.first_completed_at;
        },
        async wait_for_quiet(quiet_ms, timeout_ms)
        {
            const sample = active;
            await wait_for(() => sample.last_completed_at !== null &&
                performance.now() - sample.last_completed_at >= quiet_ms,
            timeout_ms, "presentation quiescence");
            return sample.last_completed_at;
        },
        restore()
        {
            active = null;
            if(own_descriptor)
            {
                Object.defineProperty(backend, "flush", own_descriptor);
            }
            else
            {
                delete backend.flush;
            }
        },
    };
}

async function capture_canvas_hash(canvas)
{
    if(!(canvas instanceof HTMLCanvasElement))
    {
        throw new Error("The VirtIO GPU canvas is unavailable");
    }
    const bitmap = await createImageBitmap(canvas);
    try
    {
        const copy = new OffscreenCanvas(canvas.width, canvas.height);
        const context = copy.getContext("2d", { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const digest = await crypto.subtle.digest("SHA-256", pixels);
        return {
            width: canvas.width,
            height: canvas.height,
            sha256: Array.from(new Uint8Array(digest),
                byte => byte.toString(16).padStart(2, "0")).join(""),
        };
    }
    finally
    {
        bitmap.close();
    }
}

async function wait_for_serial(marker, timeout_ms)
{
    await wait_for(() =>
    {
        const serial = serial_text();
        const failure = /V86_GHOSTTY_BENCHMARK_FAILURE=([^\r\n]+)/.exec(serial);
        if(failure)
        {
            throw new Error(`Guest benchmark failed: ${failure[1]}`);
        }
        return serial.includes(marker);
    }, timeout_ms, marker);
}

async function wait_for_run_result(run, timeout_ms)
{
    let result = null;
    await wait_for(() =>
    {
        const failure = /V86_GHOSTTY_BENCHMARK_FAILURE=([^\r\n]+)/.exec(serial_text());
        if(failure)
        {
            throw new Error(`Guest benchmark failed: ${failure[1]}`);
        }
        const match = new RegExp(
            `V86_GHOSTTY_BENCHMARK_RUN=${run} GUEST_CPU_TICKS=(\\d+) ` +
            "CLK_TCK=(\\d+) OUTPUT_BYTES=(\\d+) LINES=(\\d+)").exec(serial_text());
        if(!match)
        {
            return false;
        }
        result = {
            guest_cpu_ticks: Number(match[1]),
            clock_ticks: Number(match[2]),
            output_bytes: Number(match[3]),
            lines: Number(match[4]),
        };
        return true;
    }, timeout_ms, `benchmark run ${run} result`);
    return result;
}

async function wait_for(predicate, timeout_ms, description)
{
    const deadline = performance.now() + timeout_ms;
    while(performance.now() < deadline)
    {
        if(predicate())
        {
            return;
        }
        await sleep(10);
    }
    throw new Error(`Timed out waiting for ${description}`);
}

function serial_text()
{
    return window.applianceSerialText || "";
}

function distribution(values)
{
    const sorted = values.slice().sort((left, right) => left - right);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
        count: values.length,
        total,
        mean: values.length ? total / values.length : null,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.length ? sorted[sorted.length - 1] : null,
    };
}

function percentile(sorted, quantile)
{
    if(!sorted.length)
    {
        return null;
    }
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function failure_result(options, diagnostics, error)
{
    return {
        schema_version: 1,
        status: "fail",
        scenario: {
            appliance: "openbox-ghostty-codex",
            renderer: options.renderer,
            guest_renderer: options.accelerated ? "webgpuvirt" : "llvmpipe",
            accelerated_3d: options.accelerated,
        },
        error: error instanceof Error ? error.stack || error.message : String(error),
        failures: diagnostics.snapshot(null, null),
    };
}
