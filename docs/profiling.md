v86 has a built-in profiler, which instruments generated code to count certain
events and types of instructions. It can be used by building with `make
debug-with-profiler` and opening debug.html.

See [jit-profile-2026-08.md](jit-profile-2026-08.md) for the current single-core
JIT/run-loop performance baseline, methodology, and ranked optimization candidates (XWAH-11).

For debugging networking, packet logging is available in the UI in both debug
and release builds. The resulting `traffic.hex` file can be loaded in Wireshark
using file -> import from hex -> tick direction indication, timestamp %s.%f.
