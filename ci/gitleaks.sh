#!/usr/bin/env bash
# Scans the whole git history for committed secrets (API keys, tokens) with gitleaks. Used by both pipelines.
# Needs a full clone (not a shallow one) and a Linux x64 agent. The download is pinned by version and SHA-256:
# to upgrade, change both from the release's gitleaks_<version>_checksums.txt.
set -euo pipefail

VERSION=8.30.1
SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb

archive="gitleaks_${VERSION}_linux_x64.tar.gz"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

curl -sSfL --retry 3 -o "$dir/$archive" "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${archive}"
echo "${SHA256}  ${dir}/${archive}" | sha256sum --check --quiet
tar -xzf "$dir/$archive" -C "$dir" gitleaks

# Exits 1 when a secret is found. Values are redacted in the log. A false positive is silenced by adding its
# fingerprint (printed with the finding) to a .gitleaksignore file in the repository root.
"$dir/gitleaks" git --redact --no-banner --verbose .
