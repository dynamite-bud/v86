# v86 Tools

Repository utilities live here; image-specific build inputs and scripts live under `tools/docker/`.

## Filesystem image utilities

| Utility | Purpose |
|---|---|
| `fs2json.py` | Generate a v86 filesystem manifest from a directory or tar archive. |
| `copy-to-sha256.py` | Generate content-addressed flat chunks, optionally compressed with zstd. |
| `split-image.py` | Split a disk image into browser-loadable parts. |
| `utils/patch_image_file.py` | Replace one existing file in a generated manifest and flat chunk directory for fast local iteration. |

For a one-file experiment, use `utils/patch_image_file.py` instead of extracting and recompressing the full image. See [`utils/README.md`](utils/README.md) for the CLI, Python API, constraints, and test command.

Patched images are iteration artifacts, not reproducible release outputs. Before updating locks, checksums, or an image contract, run the canonical `tools/docker/<image>/build.sh` flow.

Scoped agent guidance is in [`AGENTS.md`](AGENTS.md).
