#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Rehearses the "Release images" GitHub workflow under the conditions of
# GitHub's Linux runner, without publishing anything:
#   - native Linux Docker (Docker-in-Docker), so file ownership behaves as on
#     the runner (Docker Desktop for Mac hides ownership differences)
#   - the steps run as a normal, non-root user in a Debian container with
#     Node.js 26 (like the runner's Ubuntu), sharing the workspace with that
#     Docker host at the same path
#   - a throwaway registry in place of ghcr.io, and a stand-in for gh
# It runs the same scripts as the workflow: release-images.sh (tests, scan,
# x86-64 and ARM build and push, SBOM), bundle.sh --with-images and
# draft-release.sh. Run it after changing any release script, before tagging.
#
#   npm run check:release        (needs Docker; 15-30 minutes)

set -euo pipefail
cd "$(dirname "$0")/.."

DIND=docker:29.9.2-dind
RUNNER_IMAGE=node:26
BINFMT=tonistiigi/binfmt:qemu-v10.2.3-68@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0
P=sonoforms-release-check
REGISTRY=localhost:5000/oconnelltim

docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again." >&2; exit 2; }
version=$(node -p "require('./package.json').version")
tools=$(mktemp -d)

cleanup() {
  docker rm -f "$P-runner" "$P-docker" >/dev/null 2>&1 || true
  docker volume rm "$P-work" >/dev/null 2>&1 || true
  docker network rm "$P-net" >/dev/null 2>&1 || true
  rm -rf "$tools"
}
trap cleanup EXIT
cleanup
tools=$(mktemp -d)

echo "Starting a Linux Docker host and a runner for the rehearsal…"
docker network create "$P-net" >/dev/null
docker volume create "$P-work" >/dev/null
docker run -d --privileged --name "$P-docker" --network "$P-net" -e DOCKER_TLS_CERTDIR= -v "$P-work:/work" "$DIND" >/dev/null
for _ in $(seq 1 60); do docker exec "$P-docker" docker info >/dev/null 2>&1 && break; sleep 1; done

# The runner gets the Docker host's own (static) docker and buildx binaries.
docker cp -q "$P-docker:/usr/local/bin/docker" "$tools/docker"
docker cp -q "$P-docker:/usr/local/libexec/docker/cli-plugins/docker-buildx" "$tools/docker-buildx"
docker run -d --name "$P-runner" --network "$P-net" -v "$P-work:/work" -e DOCKER_HOST="tcp://$P-docker:2375" \
  "$RUNNER_IMAGE" sleep infinity >/dev/null
docker cp -q "$tools/docker" "$P-runner:/usr/local/bin/docker"
docker exec "$P-runner" mkdir -p /usr/local/libexec/docker/cli-plugins
docker cp -q "$tools/docker-buildx" "$P-runner:/usr/local/libexec/docker/cli-plugins/docker-buildx"

# The workspace, as the runner's checkout would be (no local build outputs,
# and no macOS "._" metadata files).
COPYFILE_DISABLE=1 tar --exclude=./node_modules --exclude=./.dev --exclude=./.git --exclude=./reports --exclude=./dist -cf - . \
  | docker exec -i "$P-runner" tar xf - -C /work

docker exec "$P-runner" bash -c '
  set -e
  apt-get update -qq >/dev/null && apt-get install -y -qq zip >/dev/null
  useradd -m -u 1001 runner && chown -R runner /work
  mkdir -p /opt/fakegh
  printf "#!/bin/sh\necho \"gh \$*\" >> /tmp/gh-calls\n[ \"\$1 \$2\" = \"release view\" ] && exit 1\nexit 0\n" > /opt/fakegh/gh
  chmod 755 /opt/fakegh/gh
'
docker exec "$P-docker" sh -c "
  set -e
  docker run -d --name registry -p 5000:5000 registry:2 >/dev/null
  printf '[registry.\"localhost:5000\"]\n  http = true\n  insecure = true\n' > /work/.buildkitd.toml
  docker run --privileged --rm $BINFMT --install arm64 >/dev/null 2>&1 || echo '(binfmt not installed here; using the host kernel'\"'\"'s emulation)'
"

echo "Running the release workflow's steps as a normal user…"
docker exec -u runner -w /work \
  -e GITHUB_ACTIONS=true -e GITHUB_REF_NAME="v$version" -e SONOFORMS_REGISTRY="$REGISTRY" -e BUILDER=release-check \
  "$P-runner" bash -c '
    set -euo pipefail
    docker buildx create --name release-check --driver docker-container --driver-opt network=host --buildkitd-config /work/.buildkitd.toml >/dev/null
    npm ci --no-audit --no-fund >/dev/null 2>&1
    bash scripts/release-images.sh
    bash scripts/bundle.sh --with-images
    PATH=/opt/fakegh:$PATH bash scripts/draft-release.sh
    echo
    echo "gh was asked to:"; sed "s/^/  /" /tmp/gh-calls
    echo "Release files:"; ls -l dist | tail -n +2 | awk "{print \"  \" \$5 \"  \" \$9}"
  '

echo
echo "Release rehearsal for $version passed. Nothing was published."
