# Alpine i386 VirtIO GPU Guest

This directory contains the reproducible Linux bring-up environment for virtio-gpu. It uses Alpine 3.21 on i386 with Linux 6.12 LTS, serial autologin, a boot-time PCI/driver probe, and packages needed for later DRM/KMS and Xorg/Fluxbox validation.

The guest is test-only. It has a blank root password and automatic root login on the VGA and serial consoles. Do not deploy it or expose it to an untrusted network.

## What Docker Does

Docker assembles a Linux/386 root filesystem from reviewed inputs; Docker is not part of the v86 runtime or test process after the image is generated.

`build.sh` performs these steps:

1. Build `Dockerfile` for `linux/386` from the pinned Alpine manifest digest.
2. Install the exact direct packages in `world.lock`.
3. Compare the complete installed dependency closure with `packages.lock`.
4. Add the probe, OpenRC service, kernel module configuration, Xorg configuration, and serial autologin.
5. Generate an initramfs with Alpine's `base`, `virtio`, and `9p` feature sets.
6. Export the container root filesystem.
7. Sort tar entries and normalize mtimes, ownership, names, and PAX metadata.
8. Convert the tar to v86's filesystem JSON and content-addressed zstd chunks.
9. Generate an artifact and package checksum contract.

The named container is removed after export. The local image `v86-virtio-gpu-alpine` remains available for inspection or subsequent cached builds.

## Prerequisites

- Docker with `linux/386` image support. Docker Desktop provides architecture emulation on Apple silicon.
- Python 3.
- The Python `zstandard` package used by `tools/fs2json.py` and `tools/copy-to-sha256.py`.
- Enough free space for the Docker layers, an intermediate raw tar, the normalized rootfs tar, and the content-addressed filesystem.

If the Python module is missing:

```sh
python3 -m pip install --user zstandard
```

## Build

From the repository root:

```sh
tools/docker/virtio-gpu-alpine/build.sh
```

Generated artifacts are ignored under `images/`:

- `alpine-virtio-gpu-rootfs.tar`
- `alpine-virtio-gpu-fs.json`
- `alpine-virtio-gpu-rootfs-flat/`
- `alpine-virtio-gpu-image-contract.json`

The generated contract records the base image, kernel release, package-lock checksum, artifact sizes and SHA-256 values, flat-file content-manifest checksum, and required serial success marker.

Compare a successful generated contract with the reviewed contract:

```sh
cmp \
  tools/docker/virtio-gpu-alpine/image-contract.json \
  images/alpine-virtio-gpu-image-contract.json
```

If an intentional dependency or fixture update changes the result, review the package closure and all artifact checksums before replacing the committed contract:

```sh
cp \
  images/alpine-virtio-gpu-image-contract.json \
  tools/docker/virtio-gpu-alpine/image-contract.json
```

Do not commit the generated `images/` tree. Commit the Docker inputs, locks, scripts, and reviewed contract.

## Dependency Locks

`world.lock` is the direct package request passed to `apk add`. `packages.lock` is the sorted output of `apk info -v` after installation, including transitive dependencies. The Docker build fails at `cmp` if Alpine resolves a closure different from the reviewed lock.

To update dependencies:

1. Change exact package versions in `world.lock`.
2. Build a temporary image or container from the same pinned Alpine base.
3. Install the new direct package set.
4. Replace `packages.lock` with sorted `apk info -v` output.
5. Rebuild through `build.sh`.
6. Review the kernel release, package checksum, artifact checksums, and probe result before updating `image-contract.json`.

Changing only the base image digest is insufficient: the direct and transitive package locks must still match the repositories configured by that image.

## Runtime Contract

Boot with `bzimage_initrd_from_filesystem: true`, the generated filesystem, and:

```text
rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose
console=ttyS0,115200 modules=virtio_pci,9p,9pnet,9pnet_virtio,virtio_gpu tsc=reliable drm_kms_helper.fbdev_emulation=0
```

`drm_kms_helper.fbdev_emulation=0` is required for the PR 1 device. Linux may enumerate DRM, but framebuffer creation needs the PR 2 resource and scanout commands.

`virtio-gpu-probe` emits delimited serial records:

```text
V86_GPU_PROBE_BEGIN
V86_GPU_PROBE_KERNEL=6.12...
V86_GPU_PROBE_LSPCI_BEGIN
...
V86_GPU_PROBE_LSPCI_END
V86_GPU_PROBE_DRIVER=virtioN
V86_GPU_PROBE_DRM=/dev/dri/card0
V86_GPU_PROBE_STATUS=PASS
V86_GPU_PROBE_END
```

Success requires PCI ID `1af4:1050`, a device bound under `/sys/bus/virtio/drivers/virtio_gpu`, and `/dev/dri/card0`. `lspci` showing `Kernel driver in use: virtio-pci` is expected: `virtio-pci` owns the PCI transport while `virtio_gpu` owns the child VirtIO device.

## Running the Tests

After generating the image:

```sh
make virtio-gpu-test
make virtio-gpu-test-release
```

Both targets first run the ACPI GPE, PCI shared-IRQ, and virtio-gpu protocol unit tests. The source target imports `src/main.js`; the release target imports `build/libv86.mjs`.

The harness uses a quiet kernel and `log_level: 0` so debug tracing does not dominate runtime. It fails immediately if the 9p root mount enters initramfs recovery, and otherwise waits up to 90 seconds multiplied by `TIMEOUT_EXTRA_FACTOR` for the probe contract.

## Troubleshooting

### Docker cannot run `linux/386`

Confirm that Docker's architecture emulation is enabled and that this works:

```sh
docker run --rm --platform linux/386 i386/alpine:3.21 uname -m
```

Expected output is `i386`, `i486`, `i586`, or `i686`.

### The package closure comparison fails

Do not remove the comparison or use an unpinned install. Determine whether `world.lock`, the pinned base digest, or Alpine's configured repositories changed. Regenerate `packages.lock` only after reviewing every added, removed, and version-changed package.

### The root filesystem does not mount

`9pnet_virtio: no channels available for device host9p` means the test never reached the GPU probe. Verify that the generated kernel/initramfs matches the committed contract, the initramfs contains the `virtio` and `9p` feature sets, and the command line includes `root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose`.

### PCI appears but virtio-gpu does not bind

Inspect the delimited `lspci -nnk` output and:

```sh
find /sys/bus/virtio/drivers/virtio_gpu -maxdepth 1 -name 'virtio*' -print
dmesg | grep -E 'virtio|drm'
```

If the kernel log initially enumerates `00:0d.0` but a later `lspci` omits it, verify that the JS bundle is current. Older bundles mishandled ACPI GPE status writes and could generate phantom PCI hotplug removals.

The PCI transport line alone is not proof of a GPU driver bind. The sysfs `virtioN` link and DRM card are the authoritative checks.

### The test emits excessive logs or takes too long

Keep kernel `quiet` and emulator `log_level: 0` for routine probes. Debug logging changes emulator timing and can obscure interrupt races. Increase `TIMEOUT_EXTRA_FACTOR` only for a demonstrably slow environment; do not mask an initramfs recovery shell or a missing probe marker.

## Included Bring-up Tools

The rootfs includes `lspci`, `modetest`, `drm_info`, `kmscube`, Mesa utilities, Xorg's modesetting driver, libinput, Fluxbox, and `xinit`. `/etc/X11/xorg.conf.d/20-virtio-gpu.conf` disables acceleration for the first software-rendered desktop path.

Run `startx` only after the standard 2D resource, transfer, scanout, and flush commands are implemented. The current probe validates enumeration, driver binding, and DRM discovery—not rendered output.
