# v86 Tool Utilities

## Patch a file in a filesystem image

`patch_image_file.py` replaces one existing regular file in a generated v86 `fs.json` image without rebuilding the complete guest. It writes a content-addressed chunk, updates the file node, and adjusts the manifest's uncompressed `size` total.

Use this only for local iteration. A final reproducible image must come from its canonical build script so package locks, artifact checksums, normalized metadata, and the image contract are regenerated together.

### Requirements

- Python 3
- Python 3.14 or newer, or the `zstandard` package for `.bin.zst` images

```sh
python3 -m pip install zstandard
```

### Command line

```sh
python3 tools/utils/patch_image_file.py \
    --manifest images/alpine-virtio-gpu-codex-fs.json \
    --chunks images/alpine-virtio-gpu-codex-rootfs-flat \
    /usr/local/bin/v86-appliance-session \
    tools/docker/virtio-gpu-alpine-codex/appliance-session
```

The guest path must be absolute and must already identify a regular file. File mode, ownership, and modification time stay unchanged. The old content chunk is retained because another manifest node or image may still reference it.

### Python API

```python
from tools.utils.patch_image_file import patch_image_file

result = patch_image_file(
    "images/alpine-virtio-gpu-codex-fs.json",
    "images/alpine-virtio-gpu-codex-rootfs-flat",
    "/home/codex/.xinitrc",
    "tools/docker/virtio-gpu-alpine-codex/xinitrc",
)
```

The result reports the old and new chunk names and sizes. Reapplying identical bytes reuses the existing content-addressed chunk.

### Verification

```sh
TMPDIR=/Volumes/Xorcist-SSD/tmp python3 tools/utils/test_patch_image_file.py
```
