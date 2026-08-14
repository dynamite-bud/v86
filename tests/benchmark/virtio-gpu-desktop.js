const DEFAULT_DURATION_MS = 15000;
const DEFAULT_WARMUP_MS = 2000;
const WORKLOAD_SETTLE_MS = 150000;
const WORKLOAD_ACTIVITY_UPLOADS = 10;
const WORKLOAD_START_TIMEOUT_MS = 30000;
const READINESS_TIMEOUT_MS = 300000;
const TIMER_INTERVAL_MS = 50;
const COPY_BYTES_PER_ROW_ALIGNMENT = 256;
const BYTES_PER_PIXEL = 4;

export function create_virtio_gpu_desktop_benchmark(options)
{
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
            this.done = run_benchmark(emulator, options, diagnostics).then(result =>
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

async function run_benchmark(emulator, options, diagnostics)
{
    const mode = options.mode;
    const renderer_name = options.renderer;
    const duration_ms = positive_integer(options.duration_ms, DEFAULT_DURATION_MS);
    const warmup_ms = nonnegative_integer(options.warmup_ms, DEFAULT_WARMUP_MS);

    await wait_until(() =>
    {
        if(document.body.dataset.result === "fail")
        {
            throw new Error(document.getElementById("status")?.textContent ||
                "Desktop reported readiness failure");
        }
        const serial_text = document.getElementById("serial")?.textContent || "";
        const fatal_boot = serial_text.match(
            /Mounting root: failed|switch_root: can't execute.*|Kernel panic.*/);
        if(fatal_boot)
        {
            throw new Error(`Guest boot failed: ${fatal_boot[0].trim()}`);
        }
        return document.body.dataset.result === "pass";
    }, READINESS_TIMEOUT_MS, "desktop readiness");
    const readiness_ms = performance.now();

    const device = emulator && emulator.v86 && emulator.v86.cpu &&
        emulator.v86.cpu.devices && emulator.v86.cpu.devices.virtio_gpu;
    if(!device || !device.backend)
    {
        throw new Error("The live virtio-gpu device is unavailable");
    }
    const backend = device.backend;
    await wait_until(() => backend.renderer, WORKLOAD_START_TIMEOUT_MS,
        "WebGPU renderer initialization");
    const renderer = backend.renderer;
    const metrics = instrument_gpu_path(device, backend, renderer);

    let health;
    let sample_started;
    let sample_ended;
    try
    {
        await start_workload(emulator, metrics, mode);
        await sleep(warmup_ms);
        metrics.reset();
        health = start_health_metrics();
        sample_started = performance.now();
        await sleep(duration_ms);
        sample_ended = performance.now();
        if(metrics.renderer_upload_ms.length < WORKLOAD_ACTIVITY_UPLOADS)
        {
            throw new Error("Terminal workload was inactive during the sampling window");
        }
        health.stop();
        await stop_workload(emulator);
    }
    finally
    {
        if(health)
        {
            health.stop();
        }
        metrics.restore();
    }

    const elapsed_ms = sample_ended - sample_started;
    const scanout = device.scanouts && device.scanouts[0] ?
        { ...device.scanouts[0] } : null;
    const result = {
        schema_version: 1,
        status: "pass",
        scenario: { desktop: mode, renderer: renderer_name },
        machine: await machine_info(options.machine),
        method: {
            workload: "xfce4-terminal running a fixed 62-character line loop with 20 ms guest sleeps",
            readiness: "V86_DESKTOP_READY=PASS plus visible WebGPU scanout",
            workload_settle_ms: WORKLOAD_SETTLE_MS,
            activity_upload_threshold: WORKLOAD_ACTIVITY_UPLOADS,
            warmup_ms,
            requested_duration_ms: duration_ms,
            duration_ms: elapsed_ms,
            readiness_ms,
            sample_start_after_readiness_ms: sample_started - readiness_ms,
        },
        scanout,
        gpu: summarize_gpu_metrics(metrics, elapsed_ms, scanout),
        browser_health: health.summarize(elapsed_ms),
        failures: diagnostics.snapshot(backend, renderer),
    };
    return result;
}

async function start_workload(emulator, metrics, mode)
{
    await sleep(WORKLOAD_SETTLE_MS);
    const upload_count = metrics.renderer_upload_ms.length;
    const environment = mode === "wayland" ?
        "env HOME=/root XDG_RUNTIME_DIR=/run/user/0 WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland" :
        "env HOME=/root XDG_RUNTIME_DIR=/run/user/0 DISPLAY=:0";
    emulator.serial0_send(
        "printf '%s\\n' '#!/bin/sh' " +
        "\"while :; do echo 'v86 virtio gpu benchmark 0123456789 abcdefghijklmnopqrstuvwxyz'; " +
        "sleep 0.02; done\" > /tmp/v86-gpu-benchmark-workload; " +
        "chmod +x /tmp/v86-gpu-benchmark-workload; " +
        "DBUS_SESSION_BUS_ADDRESS=$(xargs -0 -n1 < /proc/$(pidof xfce4-panel)/environ | " +
        "sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p'); " +
        `${environment} DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" ` +
        "xfce4-terminal --disable-server " +
        "--command=/tmp/v86-gpu-benchmark-workload " +
        ">/tmp/v86-gpu-benchmark.log 2>&1 &\n"
    );
    await wait_until(
        () => metrics.renderer_upload_ms.length >= upload_count + WORKLOAD_ACTIVITY_UPLOADS,
        WORKLOAD_START_TIMEOUT_MS,
        "active terminal workload uploads"
    );
}

async function stop_workload(emulator)
{
    emulator.serial0_send("killall xfce4-terminal >/dev/null 2>&1\n");
    await sleep(250);
}

function instrument_gpu_path(device, backend, renderer)
{
    const restorers = [];
    const metrics = {
        transfer_ms: [],
        flush_command_ms: [],
        backend_upload_ms: [],
        backend_flush_ms: [],
        renderer_upload_ms: [],
        renderer_flush_ms: [],
        upload_bytes: 0,
        padded_upload_bytes: 0,
        full_frame_uploads: 0,
        upload_rects: new Map(),
        reset()
        {
            this.transfer_ms.length = 0;
            this.flush_command_ms.length = 0;
            this.backend_upload_ms.length = 0;
            this.backend_flush_ms.length = 0;
            this.renderer_upload_ms.length = 0;
            this.renderer_flush_ms.length = 0;
            this.upload_bytes = 0;
            this.padded_upload_bytes = 0;
            this.full_frame_uploads = 0;
            this.upload_rects.clear();
        },
        restore()
        {
            while(restorers.length)
            {
                restorers.pop()();
            }
        },
    };

    patch_async(device, "transfer_to_host_2d", metrics.transfer_ms, restorers);
    patch_async(device, "flush_resource", metrics.flush_command_ms, restorers);
    patch_async(backend, "uploadResource2D", metrics.backend_upload_ms, restorers);
    patch_async(backend, "flush", metrics.backend_flush_ms, restorers);
    patch_sync(renderer, "upload_resource_2d", metrics.renderer_upload_ms, restorers, args =>
    {
        const width = args[3];
        const height = args[4];
        const data = args[6];
        const row_bytes = width * BYTES_PER_PIXEL;
        metrics.upload_bytes += data.byteLength;
        metrics.padded_upload_bytes += align_to(row_bytes,
            COPY_BYTES_PER_ROW_ALIGNMENT) * height;
        const key = `${width}x${height}`;
        metrics.upload_rects.set(key, (metrics.upload_rects.get(key) || 0) + 1);
        const scanout = device.scanouts && device.scanouts[0];
        if(scanout && args[1] === scanout.x && args[2] === scanout.y &&
           width === scanout.width && height === scanout.height)
        {
            metrics.full_frame_uploads++;
        }
    });
    patch_sync(renderer, "flush", metrics.renderer_flush_ms, restorers);
    return metrics;
}

function patch_async(object, name, samples, restorers)
{
    const original = object[name];
    replace_method(object, name, async function(...args)
    {
        const started = performance.now();
        try
        {
            return await original.apply(this, args);
        }
        finally
        {
            samples.push(performance.now() - started);
        }
    }, restorers);
}

function patch_sync(object, name, samples, restorers, before_call)
{
    const original = object[name];
    replace_method(object, name, function(...args)
    {
        if(before_call)
        {
            before_call(args);
        }
        const started = performance.now();
        try
        {
            return original.apply(this, args);
        }
        finally
        {
            samples.push(performance.now() - started);
        }
    }, restorers);
}

function replace_method(object, name, replacement, restorers)
{
    if(!object || typeof object[name] !== "function")
    {
        throw new Error(`Cannot instrument missing ${name} method`);
    }
    const own_descriptor = Object.getOwnPropertyDescriptor(object, name);
    Object.defineProperty(object, name, {
        configurable: true,
        writable: true,
        value: replacement,
    });
    restorers.push(() =>
    {
        if(own_descriptor)
        {
            Object.defineProperty(object, name, own_descriptor);
        }
        else
        {
            delete object[name];
        }
    });
}

function summarize_gpu_metrics(metrics, elapsed_ms, scanout)
{
    const uploads = metrics.renderer_upload_ms.length;
    const flushes = metrics.renderer_flush_ms.length;
    const core_copy_total_ms = Math.max(0,
        sum(metrics.transfer_ms) - sum(metrics.backend_upload_ms));
    const adapter_upload_total_ms = Math.max(0,
        sum(metrics.backend_upload_ms) - sum(metrics.renderer_upload_ms));
    return {
        upload: {
            count: uploads,
            rate_hz: rate(uploads, elapsed_ms),
            logical_bytes: metrics.upload_bytes,
            logical_bandwidth_mib_s: bandwidth(metrics.upload_bytes, elapsed_ms),
            webgpu_bytes: metrics.padded_upload_bytes,
            webgpu_bandwidth_mib_s: bandwidth(metrics.padded_upload_bytes, elapsed_ms),
            full_frame_count: metrics.full_frame_uploads,
            full_frame_rate_hz: rate(metrics.full_frame_uploads, elapsed_ms),
            rect_counts: Object.fromEntries(metrics.upload_rects),
            command_total_ms: stats(metrics.transfer_ms),
            guest_read_copy_estimate_ms: estimate_stats(core_copy_total_ms, uploads),
            backend_adapter_estimate_ms: estimate_stats(adapter_upload_total_ms, uploads),
            renderer_enqueue_ms: stats(metrics.renderer_upload_ms),
        },
        flush: {
            count: flushes,
            rate_hz: rate(flushes, elapsed_ms),
            command_total_ms: stats(metrics.flush_command_ms),
            backend_total_ms: stats(metrics.backend_flush_ms),
            renderer_enqueue_ms: stats(metrics.renderer_flush_ms),
        },
        presentation: {
            frame_count: flushes,
            frame_rate_hz: rate(flushes, elapsed_ms),
            scanout_pixels: scanout ? scanout.width * scanout.height : null,
        },
    };
}

function start_health_metrics()
{
    const raf_deltas = [];
    const timer_delays = [];
    const long_tasks = [];
    let raf_previous;
    let raf_id;
    let stopped = false;
    const on_raf = timestamp =>
    {
        if(raf_previous !== undefined)
        {
            raf_deltas.push(timestamp - raf_previous);
        }
        raf_previous = timestamp;
        raf_id = requestAnimationFrame(on_raf);
    };
    raf_id = requestAnimationFrame(on_raf);

    let timer_previous = performance.now();
    const timer_id = setInterval(() =>
    {
        const now = performance.now();
        timer_delays.push(Math.max(0, now - timer_previous - TIMER_INTERVAL_MS));
        timer_previous = now;
    }, TIMER_INTERVAL_MS);

    let observer = null;
    const PerformanceObserverConstructor = globalThis["PerformanceObserver"];
    if(typeof PerformanceObserverConstructor === "function" &&
       PerformanceObserverConstructor.supportedEntryTypes &&
       PerformanceObserverConstructor.supportedEntryTypes.includes("longtask"))
    {
        observer = new PerformanceObserverConstructor(list =>
        {
            for(const entry of list.getEntries())
            {
                long_tasks.push(entry.duration);
            }
        });
        observer.observe({ type: "longtask", buffered: false });
    }

    return {
        stop()
        {
            if(stopped)
            {
                return;
            }
            stopped = true;
            cancelAnimationFrame(raf_id);
            clearInterval(timer_id);
            if(observer)
            {
                observer.disconnect();
            }
        },
        summarize(elapsed_ms)
        {
            return {
                raf: {
                    count: raf_deltas.length,
                    rate_hz: rate(raf_deltas.length, elapsed_ms),
                    interval_ms: stats(raf_deltas),
                    intervals_over_50ms: raf_deltas.filter(value => value > 50).length,
                },
                event_loop: {
                    timer_interval_ms: TIMER_INTERVAL_MS,
                    delay_ms: stats(timer_delays),
                    delays_over_50ms: timer_delays.filter(value => value > 50).length,
                },
                long_tasks: {
                    ...stats(long_tasks),
                    total_ms: sum(long_tasks),
                },
            };
        },
    };
}

function capture_diagnostics()
{
    const messages = [];
    const restorers = [];
    const capture = (kind, values) =>
    {
        messages.push({
            at_ms: performance.now(),
            kind,
            message: values.map(format_message_value).join(" "),
        });
    };

    for(const kind of ["error", "warn"])
    {
        const original = console[kind];
        console[kind] = function(...values)
        {
            capture(`console.${kind}`, values);
            return original.apply(this, values);
        };
        restorers.push(() => { console[kind] = original; });
    }
    const error_handler = event => capture("window.error",
        [event.error || event.message || "Unknown window error"]);
    const rejection_handler = event => capture("unhandledrejection",
        [event.reason || "Unknown rejected promise"]);
    window.addEventListener("error", error_handler);
    window.addEventListener("unhandledrejection", rejection_handler);
    restorers.push(() => window.removeEventListener("error", error_handler));
    restorers.push(() => window.removeEventListener("unhandledrejection", rejection_handler));

    return {
        snapshot(backend, renderer)
        {
            const validation_messages = messages.filter(entry =>
                /webgpu|validation|device[ -]?lost|uncaptured/i.test(entry.message));
            return {
                backend_fatal: backend && backend.fatal_error ?
                    String(backend.fatal_error) : null,
                renderer_fault: renderer && renderer.fault ? String(renderer.fault) : null,
                console_or_window_messages: messages.slice(),
                validation_message_count: validation_messages.length,
            };
        },
        restore()
        {
            while(restorers.length)
            {
                restorers.pop()();
            }
        },
    };
}

function failure_result(options, diagnostics, error)
{
    return {
        schema_version: 1,
        status: "fail",
        scenario: { desktop: options.mode, renderer: options.renderer },
        method: {
            requested_duration_ms: positive_integer(options.duration_ms, DEFAULT_DURATION_MS),
            warmup_ms: nonnegative_integer(options.warmup_ms, DEFAULT_WARMUP_MS),
        },
        error: format_message_value(error),
        failures: diagnostics.snapshot(null, null),
    };
}

async function machine_info(label)
{
    let adapter_info = null;
    try
    {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if(adapter && adapter.info)
        {
            adapter_info = {};
            for(const key of ["vendor", "architecture", "device", "description"])
            {
                if(adapter.info[key])
                {
                    adapter_info[key] = adapter.info[key];
                }
            }
        }
    }
    catch(error)
    {
        adapter_info = { error: format_message_value(error) };
    }

    return {
        label: label || null,
        user_agent: navigator.userAgent,
        platform: navigator.platform,
        hardware_concurrency: navigator.hardwareConcurrency,
        device_memory_gib: navigator.deviceMemory === undefined ? null : navigator.deviceMemory,
        device_pixel_ratio: globalThis["devicePixelRatio"],
        webgpu_adapter: adapter_info,
        captured_at: new Date().toISOString(),
        url: location.href,
    };
}

function publish_result(result)
{
    let details = document.getElementById("virtio-gpu-benchmark-output");
    if(!details)
    {
        details = document.createElement("details");
        details.id = "virtio-gpu-benchmark-output";
        details.open = true;
        const summary = document.createElement("summary");
        summary.textContent = "VirtIO GPU benchmark JSON";
        const output = document.createElement("pre");
        details.append(summary, output);
        document.querySelector("main").appendChild(details);
    }
    details.querySelector("pre").textContent = JSON.stringify(result, null, 2);
    console.log("V86_VIRTIO_GPU_BENCHMARK=" + JSON.stringify(result));
}

function stats(values)
{
    if(!values.length)
    {
        return { count: 0, total_ms: 0, mean_ms: null, p95_ms: null, max_ms: null };
    }
    const sorted = values.slice().sort((left, right) => left - right);
    return {
        count: values.length,
        total_ms: sum(values),
        mean_ms: sum(values) / values.length,
        p95_ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
        max_ms: sorted[sorted.length - 1],
    };
}

function estimate_stats(total_ms, count)
{
    return {
        count,
        total_ms,
        mean_ms: count ? total_ms / count : null,
    };
}

function sum(values)
{
    let total = 0;
    for(const value of values)
    {
        total += value;
    }
    return total;
}

function rate(count, elapsed_ms)
{
    return elapsed_ms ? count * 1000 / elapsed_ms : 0;
}

function bandwidth(bytes, elapsed_ms)
{
    return elapsed_ms ? bytes * 1000 / elapsed_ms / (1024 * 1024) : 0;
}

function align_to(value, alignment)
{
    return Math.ceil(value / alignment) * alignment;
}

function positive_integer(value, fallback)
{
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonnegative_integer(value, fallback)
{
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function format_message_value(value)
{
    if(value instanceof Error)
    {
        return value.stack || value.message;
    }
    if(typeof value === "string")
    {
        return value;
    }
    try
    {
        return JSON.stringify(value);
    }
    catch(error)
    {
        return String(value);
    }
}

async function wait_until(predicate, timeout_ms, description)
{
    const deadline = performance.now() + timeout_ms;
    while(performance.now() < deadline)
    {
        if(predicate())
        {
            return;
        }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${description}`);
}

function sleep(delay_ms)
{
    return new Promise(resolve => setTimeout(resolve, delay_ms));
}


export {
    capture_diagnostics,
    machine_info,
    publish_result,
    sleep,
    start_health_metrics,
    stats,
    wait_until,
};
