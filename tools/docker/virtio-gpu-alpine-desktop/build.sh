#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

IMAGES=../../../images
PREFIX=alpine-virtio-gpu-desktop
RAW_ROOTFS_TAR="$IMAGES/$PREFIX-rootfs.raw.tar"
OUT_ROOTFS_TAR="$IMAGES/$PREFIX-rootfs.tar"
OUT_ROOTFS_FLAT="$IMAGES/$PREFIX-rootfs-flat"
OUT_FSJSON="$IMAGES/$PREFIX-fs.json"
OUT_CONTRACT="$IMAGES/$PREFIX-image-contract.json"
CONTAINER_NAME=v86-virtio-gpu-alpine-desktop
IMAGE_NAME=v86-virtio-gpu-alpine-desktop
BASE_IMAGE=docker.io/library/alpine@sha256:6f5908cdf811d574b30ec394e405ef74ee293bed5af1620a5187d604604a90a8

mkdir -p "$IMAGES"
docker build . --platform linux/386 --rm --tag "$IMAGE_NAME"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker create --platform linux/386 --name "$CONTAINER_NAME" "$IMAGE_NAME" >/dev/null
docker export "$CONTAINER_NAME" -o "$RAW_ROOTFS_TAR"
docker rm "$CONTAINER_NAME" >/dev/null

python3 ../virtio-gpu-alpine/normalize_rootfs.py "$RAW_ROOTFS_TAR" "$OUT_ROOTFS_TAR"
rm "$RAW_ROOTFS_TAR"

../../../tools/fs2json.py --zstd --out "$OUT_FSJSON" "$OUT_ROOTFS_TAR"
rm -rf "$OUT_ROOTFS_FLAT"
mkdir -p "$OUT_ROOTFS_FLAT"
../../../tools/copy-to-sha256.py --zstd "$OUT_ROOTFS_TAR" "$OUT_ROOTFS_FLAT"

python3 ../virtio-gpu-alpine/image_contract.py \
    --rootfs "$OUT_ROOTFS_TAR" \
    --fs-json "$OUT_FSJSON" \
    --flat "$OUT_ROOTFS_FLAT" \
    --packages packages.lock \
    --distribution "Alpine Linux 3.24.1" \
    --base-image "$BASE_IMAGE" \
    --artifact-prefix "$PREFIX" \
    --probe-success-marker "V86_DESKTOP_READY=PASS" \
    --output "$OUT_CONTRACT"

printf 'Created %s, %s, %s, and %s\n' \
    "$OUT_ROOTFS_TAR" "$OUT_ROOTFS_FLAT" "$OUT_FSJSON" "$OUT_CONTRACT"
