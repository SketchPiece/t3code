#!/usr/bin/env bash
# Fails when node_modules wasn't installed from the current pnpm-lock.yaml.
# An upstream merge changes the lockfile; building Helm before `vp i` bundles
# the old dependencies with the new code, and the app breaks at runtime
# (2026-10-17: React error #301 on every draft, GitHub calls failing with
# "Invalid URL"). pnpm keeps a copy of the lockfile it installed from in
# node_modules/.pnpm/lock.yaml.
#
#   scripts/helm-check-deps.sh   (from anywhere in the checkout)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if ! cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml; then
  echo "helm: node_modules doesn't match pnpm-lock.yaml in $PWD; run \`vp i\` and build again." >&2
  exit 1
fi
