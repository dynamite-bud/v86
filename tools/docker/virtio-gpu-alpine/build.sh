#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

IMAGES=../../../images
RAW_ROOTFS_TAR="$IMAGES/alpine-virtio-gpu-rootfs.raw.tar"
OUT_ROOTFS_TAR="$IMAGES/alpine-virtio-gpu-rootfs.tar"
OUT_ROOTFS_FLAT="$IMAGES/alpine-virtio-gpu-rootfs-flat"
OUT_FSJSON="$IMAGES/alpine-virtio-gpu-fs.json"
OUT_CONTRACT="$IMAGES/alpine-virtio-gpu-image-contract.json"
CONTAINER_NAME=v86-virtio-gpu-alpine
IMAGE_NAME=v86-virtio-gpu-alpine

mkdir -p "$IMAGES"
docker build --build-context color=../virtio-gpu-color . --platform linux/386 --rm --tag "$IMAGE_NAME"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker create --platform linux/386 --name "$CONTAINER_NAME" "$IMAGE_NAME" >/dev/null
docker export "$CONTAINER_NAME" -o "$RAW_ROOTFS_TAR"
docker rm "$CONTAINER_NAME" >/dev/null

python3 normalize_rootfs.py "$RAW_ROOTFS_TAR" "$OUT_ROOTFS_TAR"
rm "$RAW_ROOTFS_TAR"

../../../tools/fs2json.py --zstd --out "$OUT_FSJSON" "$OUT_ROOTFS_TAR"
rm -rf "$OUT_ROOTFS_FLAT"
mkdir -p "$OUT_ROOTFS_FLAT"
../../../tools/copy-to-sha256.py --zstd "$OUT_ROOTFS_TAR" "$OUT_ROOTFS_FLAT"

python3 image_contract.py \
    --rootfs "$OUT_ROOTFS_TAR" \
    --fs-json "$OUT_FSJSON" \
    --flat "$OUT_ROOTFS_FLAT" \
    --packages packages.lock \
    --output "$OUT_CONTRACT"

printf 'Created %s, %s, %s, and %s\n' \
    "$OUT_ROOTFS_TAR" "$OUT_ROOTFS_FLAT" "$OUT_FSJSON" "$OUT_CONTRACT"
