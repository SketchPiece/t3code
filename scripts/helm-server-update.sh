#!/usr/bin/env bash
# Helm fork: builds a Helm release on a Linux server that runs Helm from a git checkout,
# beside the running build, then points $HELM_CURRENT at it. The server runs this from the
# Update button (HELM_SERVER_UPDATE_SCRIPT) and then exits, and systemd starts the new build.
# A failed build leaves the running one in place.
#
# Layout: $HELM_REPO (a clone of SketchPiece/t3code) holds the git objects, each release is a
# worktree in $HELM_RELEASES/<version>, and the systemd user unit runs the current one:
#   Environment=HELM_SERVER_UPDATE_SCRIPT=%h/helm-current/scripts/helm-server-update.sh
#   ExecStart=<node> %h/helm-current/apps/server/dist/bin.mjs serve ...
#   Restart=always
# By hand: scripts/helm-server-update.sh 0.1.4-helm.20261028.1 && systemctl --user restart helm
set -euo pipefail

version="${1:?usage: helm-server-update.sh <helm release version>}"
repo="${HELM_REPO:-$HOME/helm}"
releases="${HELM_RELEASES:-$HOME/helm-releases}"
current="${HELM_CURRENT:-$HOME/helm-current}"
dir="$releases/$version"
log="$releases/$version.log"
mkdir -p "$releases"

build() {
  git -C "$repo" fetch --force origin "refs/tags/v$version:refs/tags/v$version"
  [[ -e "$dir/.helm-build-done" ]] && return
  rm -rf "$dir"
  git -C "$repo" worktree prune
  git -C "$repo" worktree add --detach "$dir" "v$version"
  cd "$dir"
  # The server reports its package version, so stamp the release version into it.
  node -e 'const fs = require("fs"), p = "apps/server/package.json";
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
    fs.writeFileSync(p, JSON.stringify({ ...pkg, version: process.argv[1] }, null, 2) + "\n");' \
    "$version"
  vp i
  APP_VERSION="$version" vp run --filter t3 build
  touch .helm-build-done
}

if ! (build) >"$log" 2>&1; then
  tail -n 2 "$log" >&2
  echo "build log: $log" >&2
  exit 1
fi

previous="$(readlink -f "$current" 2>/dev/null || true)"
ln -sfn "$dir" "$current.next"
mv -Tf "$current.next" "$current"

# Keep the new build and the one still running until the restart.
for old in "$releases"/*/; do
  old="${old%/}"
  [[ "$old" == "$dir" || "$old" == "$previous" ]] && continue
  git -C "$repo" worktree remove --force "$old" 2>/dev/null || rm -rf "$old"
  rm -f "$old.log"
done
git -C "$repo" worktree prune
echo "Helm $version is ready at $dir"
