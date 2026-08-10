# Codex first task: v86 virtio-gpu skeleton

Work in my fork of copy/v86 on a new branch named feature/virtio-gpu-2d.
The upstream baseline I inspected was master at commit
f3d4472a9c934b9ad78a311f5849ba711a296d23. Rebase or report drift if
master has changed materially.

Read before editing:
- GitHub issue copy/v86#51
- src/virtio.js
- src/virtio_console.js
- src/virtio_net.js
- src/virtio_balloon.js
- src/cpu.js
- src/browser/starter.js
- src/browser/screen.js
- src/state.js
- Makefile
- v86.d.ts
- tests/devices/virtio_console.js
- Linux include/uapi/linux/virtio_gpu.h
- Linux include/uapi/drm/virtgpu_drm.h
- docs/virtio-gpu-webgpu.md from this project plan

Implement PR 0 and PR 1 only. Do not add wgpu, WebGPU rendering, Mesa,
VirGL, or any 3D command support yet.

Required work:
1. Add an abstract promise-based VirtioGpuBackend interface and a deterministic
   MemoryGpuBackend test implementation.
2. Add src/virtio_gpu.js using v86's existing VirtIO abstraction.
3. Expose modern VirtIO GPU PCI identity 1af4:1050 and subsystem ID 16.
4. Add two queues, controlq and cursorq.
5. Implement virtio_gpu_config with one scanout and zero capsets.
6. Advertise only VIRTIO_F_VERSION_1.
7. Implement VIRTIO_GPU_CMD_GET_DISPLAY_INFO for one configurable 1024x768
   scanout.
8. Return spec error responses for all unsupported or malformed commands.
9. Echo fence metadata correctly in responses.
10. Integrate the device into CPU initialization, reset, state save/restore,
    starter settings, v86.d.ts, and Makefile.
11. If necessary, generalize src/virtio.js so a device can provide PCI class,
    subclass, and programming-interface values without changing existing
    devices' behavior.
12. Add unit tests for parsing, malformed buffers, display info, unsupported
    commands, reset, and state.
13. Add a guest boot test that verifies PCI enumeration and Linux virtio_gpu
    driver probing over serial.

Constraints:
- Treat all guest input as untrusted.
- Do not use assertions or exceptions for malformed guest requests.
- Use checked arithmetic and explicit little-endian parsing.
- Do not assume a PCI slot or I/O port range is free; verify collisions first.
- Do not serialize functions, promises, or backend GPU objects in v86 state.
- Keep all existing tests passing.
- Keep the patch reviewable; do not implement 2D resource transfers in this PR.

Before coding, post a concise implementation outline naming every file you
intend to change. After coding, run the relevant build and test commands and
report exact results, remaining limitations, and follow-up tasks for PR 2.
