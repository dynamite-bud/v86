#!/usr/bin/env python3

import argparse
import hashlib
import importlib
import io
import json
import os
import stat
import tempfile
from pathlib import Path, PurePosixPath

IDX_NAME = 0
IDX_SIZE = 1
IDX_MODE = 3
IDX_TARGET = 6
HASH_LENGTH = 8


def _find_node(root, image_path):
    path = PurePosixPath(image_path)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("image path must be absolute and must not contain '..'")

    children = root
    node = None
    for part in path.parts[1:]:
        node = next((candidate for candidate in children if candidate[IDX_NAME] == part), None)
        if node is None:
            raise ValueError("image path does not exist: {}".format(image_path))
        children = node[IDX_TARGET] if isinstance(node[IDX_TARGET], list) else []

    if node is None:
        raise ValueError("image path must identify a file")
    if stat.S_IFMT(node[IDX_MODE]) != stat.S_IFREG:
        raise ValueError("image path is not a regular file: {}".format(image_path))
    if len(node) <= IDX_TARGET or not isinstance(node[IDX_TARGET], str):
        raise ValueError("image file has no content chunk: {}".format(image_path))
    return node


def _zstd_module():
    try:
        return "zstandard", importlib.import_module("zstandard")
    except ImportError:
        try:
            return "stdlib", importlib.import_module("compression.zstd")
        except ImportError as error:
            raise RuntimeError(
                "zstandard module required for .zst chunks; install with: pip install zstandard"
            ) from error


def _encode_chunk(data, suffix):
    if suffix == ".bin":
        return data
    if suffix != ".bin.zst":
        raise ValueError("unsupported image chunk suffix: {}".format(suffix))

    implementation, module = _zstd_module()
    if implementation == "zstandard":
        return module.ZstdCompressor(level=19).compress(data)
    return module.compress(data, level=19)


def _decode_chunk(data, suffix):
    if suffix == ".bin":
        return data

    implementation, module = _zstd_module()
    if implementation == "zstandard":
        with module.ZstdDecompressor().stream_reader(io.BytesIO(data)) as reader:
            return reader.read()
    return module.decompress(data)


def _chunk_suffix(filename):
    if filename.endswith(".bin.zst"):
        return ".bin.zst"
    if filename.endswith(".bin"):
        return ".bin"
    raise ValueError("unsupported image chunk filename: {}".format(filename))


def _write_chunk(chunk_path, encoded, source_data, suffix):
    if chunk_path.exists():
        if _decode_chunk(chunk_path.read_bytes(), suffix) != source_data:
            raise RuntimeError("content-addressed chunk collision: {}".format(chunk_path))
        return False

    chunk_path.parent.mkdir(parents=False, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=chunk_path.parent, delete=False) as temporary:
        temporary.write(encoded)
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    try:
        os.replace(temporary_path, chunk_path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    return True


def _write_manifest(manifest_path, manifest):
    mode = stat.S_IMODE(manifest_path.stat().st_mode)
    with tempfile.NamedTemporaryFile(
        dir=manifest_path.parent,
        mode="w",
        encoding="utf-8",
        delete=False,
    ) as temporary:
        json.dump(manifest, temporary, check_circular=False, separators=(",", ":"))
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    try:
        os.chmod(temporary_path, mode)
        os.replace(temporary_path, manifest_path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def patch_image_file(manifest_path, chunks_path, image_path, source_path):
    """Replace one regular file in a v86 fs.json image with host file contents."""
    manifest_path = Path(manifest_path)
    chunks_path = Path(chunks_path)
    source_path = Path(source_path)

    if not chunks_path.is_dir():
        raise ValueError("chunk directory does not exist: {}".format(chunks_path))
    if not source_path.is_file():
        raise ValueError("source file does not exist: {}".format(source_path))

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest.get("fsroot"), list) or not isinstance(manifest.get("size"), int):
        raise ValueError("manifest must contain fsroot and size fields")

    node = _find_node(manifest["fsroot"], image_path)
    old_size = node[IDX_SIZE]
    old_chunk = node[IDX_TARGET]
    suffix = _chunk_suffix(old_chunk)
    source_data = source_path.read_bytes()
    digest = hashlib.sha256(source_data).hexdigest()
    new_chunk = digest[:HASH_LENGTH] + suffix
    encoded = _encode_chunk(source_data, suffix)
    created = _write_chunk(chunks_path / new_chunk, encoded, source_data, suffix)

    node[IDX_SIZE] = len(source_data)
    node[IDX_TARGET] = new_chunk
    manifest["size"] += len(source_data) - old_size
    _write_manifest(manifest_path, manifest)

    return {
        "image_path": image_path,
        "old_chunk": old_chunk,
        "new_chunk": new_chunk,
        "old_size": old_size,
        "new_size": len(source_data),
        "chunk_created": created,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Patch one existing regular file in a v86 fs.json image"
    )
    parser.add_argument("--manifest", required=True, help="v86 fs.json manifest")
    parser.add_argument("--chunks", required=True, help="content-addressed chunk directory")
    parser.add_argument("image_path", help="absolute path of the existing guest file")
    parser.add_argument("source_path", help="host file containing the replacement bytes")
    args = parser.parse_args()

    try:
        result = patch_image_file(
            args.manifest,
            args.chunks,
            args.image_path,
            args.source_path,
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        parser.exit(1, "patch_image_file.py: error: {}\n".format(error))

    print(
        "{image_path}: {old_chunk} ({old_size}) -> {new_chunk} ({new_size})".format(
            **result
        )
    )


if __name__ == "__main__":
    main()
