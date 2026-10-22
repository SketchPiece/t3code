#!/usr/bin/env bash
# Brings node_modules in line with pnpm-lock.yaml before a build. An upstream
# merge changes the lockfile; building Helm before `vp i` bundles the old
# dependencies with the new code, and the app breaks at runtime (2026-10-17:
# React error #301 on every draft, GitHub calls failing with "Invalid URL").
# Comparing the lockfile with pnpm's installed copy (node_modules/.pnpm/lock.yaml)
# isn't reliable: pnpm 12 leaves out its own header document and orphaned
# entries. A frozen install is quick when nothing changed, and fails when the
# lockfile doesn't match package.json.
#
#   scripts/helm-check-deps.sh   (from anywhere in the checkout)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if ! PATH="$PWD/node_modules/.bin:$PATH" vp i --frozen-lockfile >/tmp/helm-check-deps.log 2>&1; then
  echo "helm: \`vp i --frozen-lockfile\` failed in $PWD (log: /tmp/helm-check-deps.log)." >&2
  exit 1
fi
