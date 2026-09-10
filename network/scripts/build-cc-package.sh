#!/usr/bin/env bash
# Assembles a self-contained chaincode directory and builds its image.
#
# @haazir/shared is a workspace symlink, which does not exist inside a
# container, so it is built and vendored as a file: dependency.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BUILD="$ROOT/build/chaincode"
IMAGE="${CC_IMAGE:-haazir-cc:latest}"

echo "==> Building workspace packages"
( cd "$ROOT" && npm run build --workspace @haazir/shared \
             && npm run build --workspace @haazir/chaincode )

echo "==> Assembling self-contained package at $BUILD"
rm -rf "$BUILD"
mkdir -p "$BUILD/vendor"
cp -r "$ROOT/packages/chaincode/dist" "$BUILD/dist"
cp "$ROOT/packages/chaincode/package.json" "$BUILD/package.json"
cp "$ROOT/packages/chaincode/Dockerfile" "$BUILD/Dockerfile"
cp -r "$ROOT/packages/shared/dist" "$ROOT/packages/shared/package.json" "$BUILD/vendor/"

# Repoint @haazir/shared at the vendored copy.
jq '.dependencies["@haazir/shared"] = "file:./vendor"' \
  "$BUILD/package.json" > "$BUILD/package.json.tmp"
mv "$BUILD/package.json.tmp" "$BUILD/package.json"

echo "==> Building image $IMAGE"
# Legacy builder: BuildKit is not required and this matches what is proven
# to work on this host.
DOCKER_BUILDKIT=0 docker build -t "$IMAGE" "$BUILD" 2>&1 | tail -5

echo "==> Image $IMAGE ready."
