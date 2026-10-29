#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Software bills of materials (SBOMs) for a release: every component and
# version SonoForms ships, in the two standard formats hospitals ask for.
#
#   npm run sbom
#
# Writes to sbom/v<version>/, which is committed with each release:
#   sonoforms-app.cdx.json / .spdx.json   the app image: Alpine packages, Node.js, npm packages
#   sonoforms-web.cdx.json / .spdx.json   the Apache image
#   npm-packages.cdx.json / .spdx.json    the app's npm dependency tree (production only), with licenses
# Commit them with the release, attach them to the GitHub release, or hand
# them to hospital IT.
#
# By default the images are built here from the source. npm run release:images
# instead sets SBOM_FROM_REGISTRY (e.g. ghcr.io/oconnelltim) so the SBOM is
# made from the published x86-64 images themselves.
# Needs Docker. The Syft version is pinned below.

set -euo pipefail
cd "$(dirname "$0")/.."

SYFT=anchore/syft:v1.55.0

docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again." >&2; exit 2; }

version=$(node -p "require('./package.json').version")
out="sbom/v$version"
# Start clean. Files written by the Syft container are owned by root on Linux,
# so they're replaced (written anew, renamed into place), never edited.
rm -rf "$out"
mkdir -p "$out"

registry="${SBOM_FROM_REGISTRY:-}"
syft_opts=()
if [ -n "$registry" ]; then
  # A registry on this computer (for testing) is plain HTTP and reached via the host network.
  case "$registry" in localhost*|127.0.0.1*) syft_opts=(--network host -e SYFT_REGISTRY_INSECURE_USE_HTTP=true) ;; esac
else
  # x86-64, like the servers it will run on.
  echo "Building the images for version $version…"
  docker build -q --platform linux/amd64 -t "sonoforms-app:$version" . >/dev/null
  docker build -q --platform linux/amd64 -t "sonoforms-web:$version" docker/apache >/dev/null
fi

for name in app web; do
  if [ -n "$registry" ]; then src="registry:$registry/sonoforms-$name:$version"; else src="docker:sonoforms-$name:$version"; fi
  echo "SBOM for $src"
  # Packages only, not every file they own (which would add thousands of entries).
  docker run --rm -e SYFT_FILE_METADATA_SELECTION=none ${syft_opts[@]+"${syft_opts[@]}"} \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/$out:/out" "$SYFT" scan "$src" --platform linux/amd64 \
    --source-name "sonoforms-$name" --source-version "$version" --quiet \
    -o "cyclonedx-json=/out/sonoforms-$name.cdx.json" -o "spdx-json=/out/sonoforms-$name.spdx.json"
done

# SPDX output also lists every file inside each Alpine package; keep packages only.
for f in "$out"/sonoforms-*.spdx.json; do
  node -e '
    const fs = require("fs"), f = process.argv[1], d = JSON.parse(fs.readFileSync(f, "utf8"));
    const files = new Set((d.files || []).map(x => x.SPDXID));
    delete d.files;
    d.relationships = (d.relationships || []).filter(r => !files.has(r.spdxElementId) && !files.has(r.relatedSpdxElement));
    for (const p of d.packages || []) { delete p.hasFiles; }
    fs.writeFileSync(f + ".tmp", JSON.stringify(d, null, 1));
    fs.renameSync(f + ".tmp", f);
  ' "$f"
done

echo "SBOM for the npm dependency tree"
npm sbom --omit dev --sbom-format cyclonedx --sbom-type application > "$out/npm-packages.cdx.json"
npm sbom --omit dev --sbom-format spdx > "$out/npm-packages.spdx.json"

[ -n "$registry" ] || docker image rm -f "sonoforms-app:$version" "sonoforms-web:$version" >/dev/null

echo
echo "SBOMs written to $out:"
ls -1 "$out"
