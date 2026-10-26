#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Security scans, run locally in Docker so nothing needs installing:
#   Semgrep     static analysis of the JavaScript and Dockerfiles
#   Gitleaks    secrets committed anywhere in the git history
#   Hadolint    Dockerfile mistakes
#   ShellCheck  shell script mistakes (install.sh, manage.sh, …)
#   Grype       known vulnerabilities in the npm packages and the Docker images
#
#   npm run security                  everything (builds the images to scan them)
#   npm run security -- --no-images   skip building and scanning the images
#
# Reports go to reports/security-<date>/ (git-ignored); the exit status is
# non-zero if anything needs attention. The scanners download their rules and
# vulnerability databases from the internet; the app itself isn't involved.
# Scanner versions are pinned below; update them deliberately.

set -euo pipefail
cd "$(dirname "$0")/.."

SEMGREP=semgrep/semgrep:1.181.1
GITLEAKS=zricethezav/gitleaks:v8.30.1
HADOLINT=hadolint/hadolint:v2.15.1
SHELLCHECK=koalaman/shellcheck:v0.11.0
GRYPE=anchore/grype:v0.121.0

scan_images=1
[ "${1:-}" = "--no-images" ] && scan_images=0

docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again." >&2; exit 2; }

out="reports/security-$(date +%Y-%m-%d-%H%M%S)"
mkdir -p "$out"
failed=()
step() { printf '\n=== %s\n' "$1"; }

step "Semgrep (static analysis)"
# --metrics=off: no usage data is sent. Exclusions are in .semgrepignore.
if ! docker run --rm -v "$PWD:/src:ro" -v "$PWD/$out:/out" -w /src "$SEMGREP" \
  semgrep scan --metrics=off --error --quiet \
    --config p/javascript --config p/nodejs --config p/owasp-top-ten --config p/secrets \
    --config p/dockerfile \
    --text --json-output=/out/semgrep.json; then
  failed+=("Semgrep")
fi

step "Gitleaks (secrets in git history)"
if [ -d .git ]; then
  if ! docker run --rm -v "$PWD:/repo:ro" -v "$PWD/$out:/out" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$GITLEAKS" git /repo --redact --no-banner --report-format json --report-path /out/gitleaks.json; then
    failed+=("Gitleaks")
  fi
else
  echo "No .git folder here; skipped."
fi

step "Hadolint (Dockerfiles)"
for f in Dockerfile docker/apache/Dockerfile; do
  echo "--- $f"
  if ! docker run --rm -i -v "$PWD/.hadolint.yaml:/hadolint.yaml:ro" "$HADOLINT" hadolint --config /hadolint.yaml - < "$f" | tee -a "$out/hadolint.txt"; then
    failed+=("Hadolint ($f)")
  fi
done

step "ShellCheck (shell scripts)"
if ! docker run --rm -v "$PWD:/mnt:ro" -w /mnt "$SHELLCHECK" install.sh manage.sh docker/apache/entrypoint.sh scripts/*.sh | tee "$out/shellcheck.txt"; then
  failed+=("ShellCheck")
fi

# Grype keeps its vulnerability database in a Docker volume between runs.
grype() { docker run --rm -v sonoforms-grype-db:/.cache/grype -v /var/run/docker.sock:/var/run/docker.sock "$@"; }

step "Grype (npm packages, from package-lock.json)"
if ! grype -v "$PWD:/src:ro" -v "$PWD/$out:/out" "$GRYPE" dir:/src \
  --exclude './node_modules/**' --exclude './.dev/**' --exclude './reports/**' \
  --fail-on high -o table -o json=/out/grype-npm.json; then
  failed+=("Grype (npm)")
fi

if [ "$scan_images" = 1 ]; then
  step "Grype (Docker images: app and web)"
  docker build -q -t sonoforms-scan-app . >/dev/null
  docker build -q -t sonoforms-scan-web docker/apache >/dev/null
  for img in sonoforms-scan-app sonoforms-scan-web; do
    echo "--- $img"
    if ! grype -v "$PWD/$out:/out" "$GRYPE" "docker:$img" --only-fixed --fail-on high -o table -o "json=/out/grype-$img.json"; then
      failed+=("Grype ($img)")
    fi
  done
  docker image rm -f sonoforms-scan-app sonoforms-scan-web >/dev/null
fi

printf '\nReports: %s\n' "$out"
if [ "${#failed[@]}" -gt 0 ]; then
  list=$(printf '%s, ' "${failed[@]}")
  printf 'Needs attention: %s\n' "${list%, }"
  exit 1
fi
echo "All scans passed."
