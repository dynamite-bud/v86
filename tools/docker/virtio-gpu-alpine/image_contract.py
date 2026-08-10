#!/usr/bin/env python3

import argparse
import hashlib
import json
import pathlib
import tarfile


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def flat_contract(path):
    digest = hashlib.sha256()
    count = 0
    size = 0
    for file in sorted(path.iterdir(), key=lambda item: item.name):
        if not file.is_file():
            continue
        file_digest = sha256(file)
        file_size = file.stat().st_size
        digest.update(f"{file.name} {file_size} {file_digest}\n".encode())
        count += 1
        size += file_size
    return {
        "file_count": count,
        "size": size,
        "manifest_sha256": digest.hexdigest(),
    }


def kernel_release(rootfs):
    with tarfile.open(rootfs, "r") as archive:
        releases = sorted({
            member.name.split("/")[2]
            for member in archive.getmembers()
            if member.name.startswith("lib/modules/") and len(member.name.split("/")) > 2
        })
    if len(releases) != 1:
        raise RuntimeError(f"Expected one kernel release, found {releases}")
    return releases[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rootfs", required=True, type=pathlib.Path)
    parser.add_argument("--fs-json", required=True, type=pathlib.Path)
    parser.add_argument("--flat", required=True, type=pathlib.Path)
    parser.add_argument("--packages", required=True, type=pathlib.Path)
    parser.add_argument("--distribution", default="Alpine Linux 3.21")
    parser.add_argument(
        "--base-image",
        default="docker.io/i386/alpine@sha256:fcc4c908760c4f561a5199f2e53576063b1b8eeaa0c41e6432d705aab4389753",
    )
    parser.add_argument("--artifact-prefix", default="alpine-virtio-gpu")
    parser.add_argument(
        "--probe-success-marker",
        default="V86_GPU_PROBE_STATUS=PASS",
    )
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()

    contract = {
        "schema": 1,
        "architecture": "x86",
        "distribution": args.distribution,
        "base_image": args.base_image,
        "kernel_release": kernel_release(args.rootfs),
        "packages_lock_sha256": sha256(args.packages),
        "artifacts": {
            "rootfs_tar": {
                "path": f"images/{args.artifact_prefix}-rootfs.tar",
                "size": args.rootfs.stat().st_size,
                "sha256": sha256(args.rootfs),
            },
            "filesystem_json": {
                "path": f"images/{args.artifact_prefix}-fs.json",
                "size": args.fs_json.stat().st_size,
                "sha256": sha256(args.fs_json),
            },
            "flat_files": {
                "path": f"images/{args.artifact_prefix}-rootfs-flat",
                **flat_contract(args.flat),
            },
        },
        "probe_success_marker": args.probe_success_marker,
    }
    args.output.write_text(json.dumps(contract, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
