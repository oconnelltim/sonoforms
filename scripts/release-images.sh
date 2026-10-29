#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Builds and publishes the release images for the version in package.json:
#   ghcr.io/oconnelltim/sonoforms-app:<version>  (and :latest)
#   ghcr.io/oconnelltim/sonoforms-web:<version>  (and :latest)
# for x86-64 servers and ARM machines (e.g. Apple Silicon laptops).
#
#   npm run release:images
#
# Steps: checks that the version is set everywhere, runs the tests, builds
# the x86-64 images and scans them (nothing is pushed if a scan fails), then
# builds both architectures from the same build cache and pushes them, and
# finally writes the SBOM from the published images into sbom/v<version>/.
#
# Before the first run, sign in to GitHub's registry as the repo owner with a
# token that has the write:packages permission:
#   docker login ghcr.io -u oconnelltim
#
# Overrides (mainly for testing): SONOFORMS_REGISTRY (default
# ghcr.io/oconnelltim), PLATFORMS (default linux/amd64,linux/arm64), BUILDER
# (the docker buildx builder to use; created if missing).

set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY="${SONOFORMS_REGISTRY:-ghcr.io/oconnelltim}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-sonoforms-builder}"
GRYPE=anchore/grype:v0.121.0
SOURCE_URL=https://github.com/oconnelltim/sonoforms

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
step() { printf '\n=== %s\n' "$1"; }

docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker Desktop and try again."
version=$(node -p "require('./package.json').version")

step "Checking that version $version is set everywhere"
grep -qx "SONOFORMS_VERSION=$version" .env.example || fail ".env.example must say SONOFORMS_VERSION=$version"
grep -q "SONOFORMS_VERSION:-$version}" docker-compose.trial.yml || fail "docker-compose.trial.yml must default to version $version"
grep -q "^## \[$version\]" CHANGELOG.md || fail "CHANGELOG.md has no section for $version"
echo "ok"

step "Running the tests"
npm run -s check

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi

# The same labels on every build, so the cache is shared between the scan
# build and the push build. The source label links the packages to the repo.
build() {   # build NAME CONTEXT [buildx options…]
  local name="$1" context="$2"; shift 2
  docker buildx build --builder "$BUILDER" \
    --label "org.opencontainers.image.source=$SOURCE_URL" \
    --label "org.opencontainers.image.version=$version" \
    --label "org.opencontainers.image.licenses=GPL-3.0-or-later" \
    --label "org.opencontainers.image.title=sonoforms-$name" \
    "$@" "$context"
}

step "Building and scanning the x86-64 images (nothing is pushed yet)"
for spec in "app ." "web docker/apache"; do
  read -r name context <<<"$spec"
  build "$name" "$context" --platform linux/amd64 --tag "sonoforms-$name:$version-scan" --load --quiet >/dev/null
  echo "--- sonoforms-$name"
  docker run --rm -v sonoforms-grype-db:/.cache/grype -v /var/run/docker.sock:/var/run/docker.sock "$GRYPE" \
    "docker:sonoforms-$name:$version-scan" --only-fixed --fail-on high -q \
    || fail "sonoforms-$name has vulnerabilities that need fixing; nothing was pushed."
  docker image rm -f "sonoforms-$name:$version-scan" >/dev/null
done

step "Building $PLATFORMS and pushing to $REGISTRY"
for spec in "app ." "web docker/apache"; do
  read -r name context <<<"$spec"
  echo "--- sonoforms-$name"
  build "$name" "$context" --platform "$PLATFORMS" \
    --tag "$REGISTRY/sonoforms-$name:$version" --tag "$REGISTRY/sonoforms-$name:latest" \
    --provenance=mode=max --sbom=true --push \
    || fail "pushing sonoforms-$name failed. Are you signed in (docker login ghcr.io -u oconnelltim)?"
done

step "SBOM from the published images"
SBOM_FROM_REGISTRY="$REGISTRY" bash scripts/sbom.sh

cat <<EOF

Published version $version:
  $REGISTRY/sonoforms-app:$version
  $REGISTRY/sonoforms-web:$version

Next:
  1. Commit sbom/v$version, then tag and push the release (v$version).
  2. First release only: on GitHub, open each package (your profile > Packages),
     choose Package settings > Change visibility > Public, so hospitals can
     pull without signing in.
  3. Optional: npm run bundle -- --with-images  for an offline install bundle.
EOF
