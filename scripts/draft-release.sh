#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Last step of the "Release images" GitHub workflow: creates a *draft* GitHub
# release for the current version, with its changelog section as the notes
# and these files attached (or replaces them if the draft already exists):
#   sonoforms-<version>.tar.gz                  install bundle
#   sonoforms-<version>-images-amd64.tar.gz     images for servers without internet
#   sonoforms-<version>-sbom.zip                SBOM (CycloneDX and SPDX)
# Review the draft on GitHub, then publish it. Uses the gh CLI with GH_TOKEN.

set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
tag="v$version"

# The changelog section for this version, without its heading.
awk -v h="## [$version]" 'index($0, h) == 1 { on = 1; next } /^## \[/ { if (on) exit } on' CHANGELOG.md > dist/release-notes.md
[ -s dist/release-notes.md ] || { echo "No CHANGELOG.md section for $version." >&2; exit 1; }

(cd sbom && zip -qr "../dist/sonoforms-$version-sbom.zip" "v$version")

files=(dist/sonoforms-"$version".tar.gz dist/sonoforms-"$version"-images-*.tar.gz dist/sonoforms-"$version"-sbom.zip)
if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "${files[@]}" --clobber
  echo "Updated the files on the existing release $tag."
else
  gh release create "$tag" --draft --verify-tag --title "SonoForms $version" --notes-file dist/release-notes.md "${files[@]}"
  echo "Drafted release $tag. Review it on GitHub, then publish it."
fi
