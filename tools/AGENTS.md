# Tooling Agent Instructions

## Fast filesystem-image iteration

Use `tools/utils/patch_image_file.py` when a browser or guest experiment needs one changed file in an already-generated v86 filesystem image. This is faster than rebuilding a Docker rootfs for every source edit.

1. Edit the canonical source file under `tools/docker/`.
2. Patch the matching existing guest file with explicit `--manifest` and `--chunks` paths.
3. Run the browser or guest scenario that exercises the changed file.
4. Rebuild through the image's canonical `build.sh` before treating the artifact as reproducible or updating locks and checksums.

The utility patches regular files only. Never use it to add paths, change metadata, update packages, or bypass a package/artifact lock. It intentionally retains the old content-addressed chunk because chunks may be shared.

Generated filesystem manifests and chunk directories under `images/` are local artifacts unless a release workflow explicitly requires them. Do not commit them as source changes.

See `tools/utils/README.md` for CLI, Python API, dependencies, and verification.
