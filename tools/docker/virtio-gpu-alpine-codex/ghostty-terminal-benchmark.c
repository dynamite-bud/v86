#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#define TOTAL_RUNS 7U
#define WARMUP_RUNS 2U
#define SCROLL_LINES 512U
#define FINAL_LINES 24U

static int serial_fd = -1;

static void fail(const char *reason)
{
    if(serial_fd >= 0)
    {
        dprintf(serial_fd, "V86_GHOSTTY_BENCHMARK_FAILURE=%s\n", reason);
    }
    exit(1);
}

static void serial_printf(const char *format, ...)
{
    va_list arguments;
    va_start(arguments, format);
    if(vdprintf(serial_fd, format, arguments) < 0)
    {
        va_end(arguments);
        fail("serial-write");
    }
    va_end(arguments);
}

static void write_all(const char *bytes, size_t length, size_t *total)
{
    size_t offset = 0;
    while(offset < length)
    {
        const ssize_t written = write(STDOUT_FILENO, bytes + offset, length - offset);
        if(written < 0)
        {
            if(errno == EINTR)
            {
                continue;
            }
            fail("terminal-write");
        }
        offset += (size_t)written;
    }
    *total += length;
}

static void write_formatted(size_t *total, const char *format, ...)
{
    char buffer[256];
    va_list arguments;
    va_start(arguments, format);
    const int length = vsnprintf(buffer, sizeof(buffer), format, arguments);
    va_end(arguments);
    if(length < 0 || (size_t)length >= sizeof(buffer))
    {
        fail("format-overflow");
    }
    write_all(buffer, (size_t)length, total);
}

static uint64_t guest_cpu_ticks(void)
{
    FILE *stat = fopen("/proc/stat", "r");
    if(!stat)
    {
        fail("proc-stat-open");
    }

    uint64_t user = 0;
    uint64_t nice = 0;
    uint64_t system = 0;
    uint64_t idle = 0;
    uint64_t iowait = 0;
    uint64_t irq = 0;
    uint64_t softirq = 0;
    uint64_t steal = 0;
    const int fields = fscanf(stat,
        "cpu %llu %llu %llu %llu %llu %llu %llu %llu",
        (unsigned long long *)&user,
        (unsigned long long *)&nice,
        (unsigned long long *)&system,
        (unsigned long long *)&idle,
        (unsigned long long *)&iowait,
        (unsigned long long *)&irq,
        (unsigned long long *)&softirq,
        (unsigned long long *)&steal);
    fclose(stat);
    if(fields != 8)
    {
        fail("proc-stat-parse");
    }

    return user + nice + system + irq + softirq + steal;
}

static void expect_command(const char *prefix, unsigned run)
{
    char input[32];
    char expected[32];
    if(!fgets(input, sizeof(input), stdin))
    {
        fail("terminal-input");
    }
    const int length = snprintf(expected, sizeof(expected), "%s-%u\n", prefix, run);
    if(length < 0 || (size_t)length >= sizeof(expected) || strcmp(input, expected) != 0)
    {
        fail("unexpected-command");
    }
}

static size_t emit_workload(unsigned run)
{
    size_t total = 0;
    static const char begin[] = "\033[2J\033[H\033[?25l";
    write_all(begin, sizeof(begin) - 1, &total);

    for(unsigned line = 0; line < SCROLL_LINES; line++)
    {
        const unsigned color = 31U + line % 6U;
        write_formatted(&total,
            "\033[%um%04u v86 Ghostty benchmark run %u | "
            "0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\033[0m\r\n",
            color, line, run);
    }

    static const char final_begin[] =
        "\033[2J\033[H\033[1;36mv86 Ghostty deterministic terminal benchmark\033[0m\r\n"
        "\033[2mreference frame: ANSI colors, fixed text, and scroll history\033[0m\r\n\r\n";
    write_all(final_begin, sizeof(final_begin) - 1, &total);
    for(unsigned row = 0; row < FINAL_LINES; row++)
    {
        const unsigned color = 31U + row % 6U;
        write_formatted(&total,
            "\033[%umrow %02u | 0123456789 | abcdefghijklmnopqrstuvwxyz | terminal-reference\033[0m\r\n",
            color, row);
    }
    static const char final_end[] = "\033[0m\033[?25l";
    write_all(final_end, sizeof(final_end) - 1, &total);
    return total;
}

int main(void)
{
    serial_fd = open("/dev/ttyS0", O_WRONLY | O_NOCTTY);
    if(serial_fd < 0)
    {
        fail("serial-open");
    }
    const long clock_ticks = sysconf(_SC_CLK_TCK);
    if(clock_ticks <= 0)
    {
        fail("clock-ticks");
    }

    const int marker_fd = open("/tmp/v86-appliance-benchmark-ready",
        O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if(marker_fd < 0 || close(marker_fd) < 0)
    {
        fail("ready-marker");
    }

    serial_printf(
        "V86_GHOSTTY_BENCHMARK_READY=PASS RUNS=%u WARMUP=%u SCROLL_LINES=%u FINAL_LINES=%u\n",
        TOTAL_RUNS, WARMUP_RUNS, SCROLL_LINES, FINAL_LINES);

    for(unsigned run = 0; run < TOTAL_RUNS; run++)
    {
        serial_printf("V86_GHOSTTY_BENCHMARK_WAIT=%u\n", run);
        expect_command("run", run);
        const uint64_t cpu_before = guest_cpu_ticks();
        serial_printf("V86_GHOSTTY_BENCHMARK_BEGIN=%u\n", run);
        const size_t output_bytes = emit_workload(run);
        if(tcdrain(STDOUT_FILENO) < 0)
        {
            fail("terminal-drain");
        }
        serial_printf("V86_GHOSTTY_BENCHMARK_STREAM_DONE=%u\n", run);
        expect_command("ack", run);
        const uint64_t cpu_after = guest_cpu_ticks();
        if(cpu_after < cpu_before)
        {
            fail("cpu-counter-regressed");
        }
        serial_printf(
            "V86_GHOSTTY_BENCHMARK_RUN=%u GUEST_CPU_TICKS=%llu CLK_TCK=%ld "
            "OUTPUT_BYTES=%zu LINES=%u\n",
            run,
            (unsigned long long)(cpu_after - cpu_before),
            clock_ticks,
            output_bytes,
            SCROLL_LINES + FINAL_LINES);
    }

    serial_printf("V86_GHOSTTY_BENCHMARK_DONE=PASS\n");
    for(;;)
    {
        pause();
    }
}
