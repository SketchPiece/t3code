#!/usr/bin/env bash
# Builds the signed Helm macOS app from HEAD and publishes it as a GitHub
# release on SketchPiece/t3code, where installed Helm apps look for updates.
#
#   scripts/helm-release.sh            build + publish
#   scripts/helm-release.sh --dry-run  build only, print what would be published
#
# Version: <upstream base>-helm.<YYYYMMDD>.<n>, e.g. 0.0.46-helm.20261008.1.
# The base comes from the newest upstream nightly tag merged into HEAD. The
# "-helm." suffix keeps the stable ("latest") update channel, product name and
# icon; a "-nightly." version would turn the build into "Helm (Nightly)".
set -euo pipefail

REPO="SketchPiece/t3code"
SIGN_IDENTITY="${HELM_MAC_SIGN_IDENTITY:-Apple Development: Andrew Liubkin (Z6693LCFL6)}"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain --untracked-files=no -- . ':!.repos')" ]]; then
  echo "helm-release: tracked files have uncommitted changes; commit them first." >&2
  exit 1
fi

base_tag=$(git describe --tags --match 'v*-nightly*' --abbrev=0 HEAD)
base=$(sed -E 's/^v([0-9]+\.[0-9]+\.[0-9]+).*/\1/' <<<"$base_tag")
day=$(date +%Y%m%d)
n=1
while gh release view "v$base-helm.$day.$n" -R "$REPO" >/dev/null 2>&1; do n=$((n + 1)); done
version="$base-helm.$day.$n"
tag="v$version"
out="release/helm/$version"

echo "helm-release: $tag from $(git rev-parse --short HEAD) (upstream $base_tag)"

rm -rf "$out"
PATH="$PWD/node_modules/.bin:$PATH" \
  RUSTUP_TOOLCHAIN=1.95.0 \
  T3CODE_DESKTOP_UPDATE_REPOSITORY="$REPO" \
  HELM_MAC_SIGN_IDENTITY="$SIGN_IDENTITY" \
  env -u ELECTRON_RUN_AS_NODE \
  node scripts/build-desktop-artifact.ts \
  --platform mac --target dmg --arch arm64 \
  --build-version "$version" --output-dir "$out"

assets=("$out"/*.dmg "$out"/*.zip "$out"/*.blockmap "$out"/latest-mac.yml)
for asset in "${assets[@]}"; do
  [[ -f "$asset" ]] || { echo "helm-release: missing $asset" >&2; exit 1; }
done

if ((DRY_RUN)); then
  printf 'helm-release: dry run, would publish %s with:\n' "$tag"
  printf '  %s\n' "${assets[@]}"
  exit 0
fi

# The release tag must point at a commit GitHub has.
git push origin HEAD:helm
gh release create "$tag" "${assets[@]}" -R "$REPO" \
  --target "$(git rev-parse HEAD)" \
  --title "Helm $version" \
  --notes "Helm on upstream T3 Code $base_tag."

echo "helm-release: published https://github.com/$REPO/releases/tag/$tag"
