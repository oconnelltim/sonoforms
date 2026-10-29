#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Makes the install bundle for the version in package.json: just the files a
# server needs (no source code), to attach to the GitHub release.
#
#   npm run bundle                         dist/sonoforms-<version>.tar.gz
#   npm run bundle -- --with-images        also the images, for servers without internet:
#                                          dist/sonoforms-<version>-images-amd64.tar.gz
#
# The images are taken from the registry (publish them first with
# npm run release:images). ARCHES=amd64,arm64 adds an ARM image file too.

set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY="${SONOFORMS_REGISTRY:-ghcr.io/oconnelltim}"
ARCHES="${ARCHES:-amd64}"
POSTGRES=postgres:17-alpine

with_images=0
[ "${1:-}" = "--with-images" ] && with_images=1

version=$(node -p "require('./package.json').version")
name="sonoforms-$version"
out="dist/$name"
rm -rf "$out" "dist/$name.tar.gz"
mkdir -p "$out"

cp docker-compose.yml docker-compose.trial.yml .env.example install.sh manage.sh README.md LICENSE CHANGELOG.md "$out/"
cp -R docs "$out/docs"
if [ -d "sbom/v$version" ]; then
  mkdir -p "$out/sbom" && cp -R "sbom/v$version" "$out/sbom/"
else
  echo "Note: no sbom/v$version yet (npm run release:images makes it)." >&2
fi
tar -czf "dist/$name.tar.gz" -C dist "$name"
echo "Bundle: dist/$name.tar.gz"

if [ "$with_images" = 1 ]; then
  docker info >/dev/null 2>&1 || { echo "Docker is not running." >&2; exit 2; }
  images=("$REGISTRY/sonoforms-app:$version" "$REGISTRY/sonoforms-web:$version" "$POSTGRES")
  IFS=, read -r -a arches <<<"$ARCHES"
  for arch in "${arches[@]}"; do
    for img in "${images[@]}"; do docker pull -q --platform "linux/$arch" "$img" >/dev/null; done
    file="dist/$name-images-$arch.tar.gz"
    docker image save --platform "linux/$arch" "${images[@]}" | gzip > "$file"
    echo "Images ($arch): $file"
  done
  echo
  echo "On a server without internet: unpack the bundle, put the images file in an"
  echo "images/ folder inside it, and run ./install.sh (it loads images from there)."
fi
rm -rf "$out"
