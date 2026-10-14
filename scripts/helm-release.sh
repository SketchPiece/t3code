#!/usr/bin/env bash
# Builds the signed Helm macOS app from HEAD and publishes it as a GitHub
# release on SketchPiece/t3code, where installed Helm apps look for updates.
#
#   scripts/helm-release.sh            build + publish
#   scripts/helm-release.sh --dry-run  build and launch check only, print what would be published
#
# Before publishing it runs scripts/helm-smoke-mac.sh, which launches the built
# update on a fresh profile and on a copy of the real data, and stops the
# release when either launch fails.
#
# The release is uploaded as a draft and published once every file is up. The
# upload runs in its own session, so it outlives a Helm restart; running the
# script again for the same commit reuses that draft and build and uploads only
# what is missing. Only the update files go up (zip, blockmap, latest-mac.yml);
# the DMG for a first install stays in release/helm/<version>/.
#
# Version: <upstream base>-helm.<YYYYMMDD>.<n>, e.g. 0.0.46-helm.20261008.1.
# The base comes from the newest upstream nightly tag merged into HEAD. The
# "-helm." suffix keeps the stable ("latest") update channel, product name and
# icon; a "-nightly." version would turn the build into "Helm (Nightly)".
set -euo pipefail

REPO="SketchPiece/t3code"
# Publish as the repo's owner even when another gh account is the active one.
GH_TOKEN="${GH_TOKEN:-$(gh auth token --user SketchPiece 2>/dev/null || true)}"
[[ -n "$GH_TOKEN" ]] && export GH_TOKEN || unset GH_TOKEN
# Absolute, because the detached upload re-runs this script after the cd below.
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SIGN_IDENTITY="${HELM_MAC_SIGN_IDENTITY:-Apple Development: Andrew Liubkin (Z6693LCFL6)}"

cd "$(git rev-parse --show-toplevel)"

# Internal: the detached upload. Uploads the files the draft lacks, then publishes it.
if [[ "${1:-}" == "--upload" ]]; then
  tag="$2"
  shift 2
  uploaded=$(gh release view "$tag" -R "$REPO" --json assets \
    -q '.assets[] | select(.state == "uploaded") | .name')
  for asset in "$@"; do
    if ! grep -qxF "$(basename "$asset")" <<<"$uploaded"; then
      echo "helm-release: uploading $(basename "$asset")"
      gh release upload "$tag" "$asset" -R "$REPO" --clobber
    fi
  done
  gh release edit "$tag" -R "$REPO" --draft=false --latest
  echo "helm-release: published https://github.com/$REPO/releases/tag/$tag"
  exit 0
fi

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

if [[ -n "$(git status --porcelain --untracked-files=no -- . ':!.repos')" ]]; then
  echo "helm-release: tracked files have uncommitted changes; commit them first." >&2
  exit 1
fi

head=$(git rev-parse HEAD)
base_tag=$(git describe --tags --match 'v*-nightly*' --abbrev=0 HEAD)
base=$(sed -E 's/^v([0-9]+\.[0-9]+\.[0-9]+).*/\1/' <<<"$base_tag")

# A draft for this commit means an earlier run was cut off: finish that one.
tag=$(gh api "repos/$REPO/releases" \
  -q ".[] | select(.draft and .target_commitish == \"$head\") | .tag_name" 2>/dev/null | head -1)
if [[ -n "$tag" ]]; then
  version="${tag#v}"
else
  day=$(date +%Y%m%d)
  n=1
  while gh release view "v$base-helm.$day.$n" -R "$REPO" >/dev/null 2>&1; do n=$((n + 1)); done
  version="$base-helm.$day.$n"
  tag="v$version"
fi
out="release/helm/$version"

echo "helm-release: $tag from $(git rev-parse --short HEAD) (upstream $base_tag)"

if [[ -f "$out/latest-mac.yml" ]]; then
  echo "helm-release: reusing the build in $out"
else
  rm -rf "$out"
  PATH="$PWD/node_modules/.bin:$PATH" \
    RUSTUP_TOOLCHAIN=1.95.0 \
    T3CODE_DESKTOP_UPDATE_REPOSITORY="$REPO" \
    HELM_MAC_SIGN_IDENTITY="$SIGN_IDENTITY" \
    env -u ELECTRON_RUN_AS_NODE \
    node scripts/build-desktop-artifact.ts \
    --platform mac --target dmg --arch arm64 \
    --build-version "$version" --output-dir "$out"
fi

assets=("$out"/*.zip "$out"/*.zip.blockmap "$out"/latest-mac.yml)
for asset in "${assets[@]}"; do
  [[ -f "$asset" ]] || { echo "helm-release: missing $asset" >&2; exit 1; }
done

# Never publish a build that can't start: installed apps restart into it on
# their own.
scripts/helm-smoke-mac.sh "$out"/*.zip

if ((DRY_RUN)); then
  printf 'helm-release: dry run, would publish %s with:\n' "$tag"
  printf '  %s\n' "${assets[@]}"
  exit 0
fi

# The release tag must point at a commit GitHub has.
git push origin HEAD:helm
gh release view "$tag" -R "$REPO" >/dev/null 2>&1 ||
  gh release create "$tag" -R "$REPO" --draft --target "$head" \
    --title "Helm $version" --notes "Helm on upstream T3 Code $base_tag."

# One uploader per release: wait on a running one instead of starting another.
pid_file="$out/upload.pid"
log="$out/upload.log"
if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  echo "helm-release: an upload is already running, waiting for it"
else
  # setsid detaches the upload from this process group, so it survives the
  # caller being killed.
  perl -MPOSIX=setsid -e 'setsid(); exec @ARGV or die' \
    "$self" --upload "$tag" "${assets[@]}" >"$log" 2>&1 </dev/null &
  echo $! >"$pid_file"
fi
echo "helm-release: uploading in the background (log: $log)"
while kill -0 "$(cat "$pid_file")" 2>/dev/null; do sleep 5; done
cat "$log"
grep -q "helm-release: published" "$log"
