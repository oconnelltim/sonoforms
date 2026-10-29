#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Runs `npm run check` (tests, form check, npm audit) in a clean Linux x64
# container in UTC, the way a Linux server or CI machine would, without
# touching this folder's node_modules. Needs Docker.
#
#   npm run check:linux

set -euo pipefail
cd "$(dirname "$0")/.."

NODE_IMAGE=node:26

docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again." >&2; exit 2; }

docker run --rm --platform linux/amd64 -e TZ=UTC -v "$PWD:/src:ro" "$NODE_IMAGE" bash -c '
  set -e
  mkdir -p /app
  cd /src && tar --exclude=./node_modules --exclude=./.dev --exclude=./.git --exclude=./reports -cf - . | (cd /app && tar xf -)
  chown -R node:node /app
  # The embedded test database refuses to run as root.
  cd /app && su node -c "npm ci --no-audit --no-fund && npm run check"
'
