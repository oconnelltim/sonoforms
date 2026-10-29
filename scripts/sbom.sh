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
# Needs Docker. The Syft version is pinned below.

set -euo pipefail
cd "$(dirname "$0")/.."

SYFT=anchore/syft:v1.55.0

docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again." >&2; exit 2; }

version=$(node -p "require('./package.json').version")
out="sbom/v$version"
mkdir -p "$out"

echo "Building the images for version $version…"
docker build -q -t "sonoforms-app:$version" . >/dev/null
docker build -q -t "sonoforms-web:$version" docker/apache >/dev/null

for name in app web; do
  img="sonoforms-$name:$version"
  echo "SBOM for $img"
  # Packages only, not every file they own (which would add thousands of entries).
  docker run --rm -e SYFT_FILE_METADATA_SELECTION=none \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/$out:/out" "$SYFT" scan "docker:$img" \
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
    fs.writeFileSync(f, JSON.stringify(d, null, 1));
  ' "$f"
done

echo "SBOM for the npm dependency tree"
npm sbom --omit dev --sbom-format cyclonedx --sbom-type application > "$out/npm-packages.cdx.json"
npm sbom --omit dev --sbom-format spdx > "$out/npm-packages.spdx.json"

docker image rm -f "sonoforms-app:$version" "sonoforms-web:$version" >/dev/null

echo
echo "SBOMs written to $out:"
ls -1 "$out"
