#!/usr/bin/env bash
# Launch check for a built Helm update. Installed apps update from the .zip, so
# this unpacks that zip and starts the app the way an update restarts it:
#
#   1. on a fresh profile;
#   2. on a pruned copy of the real Helm database (~/.helm/userdata), so the
#      new build's migrations run against data shaped like the user's, and a
#      copy of the window's saved state (local storage), so the app reopens
#      the screen and panels the user had open, as it does after an update.
#
# Each run passes once the window's renderer talks to its own backend over the
# WebSocket, scripts/helm-smoke-renderer.ts finds no crash screen or React
# error on the restored screen, a new draft, a thread and settings, and the app
# is still alive a few seconds later. A crashed React tree keeps the process
# and backend up, so the renderer check is what catches a broken UI.
#
# It also refuses a tree whose node_modules don't match pnpm-lock.yaml: a
# build from stale dependencies after an upstream merge ships a broken app
# (React error #301 on every draft, 2026-10-17). Every run uses a
# throwaway HOME, so the installed Helm, its profile, data and single-instance
# lock are never touched. --use-mock-keychain keeps Electron's safe storage out
# of the login Keychain, whose access prompt would block an unattended run.
# Exits non-zero when any run fails.
#
#   scripts/helm-smoke-mac.sh <Helm-<version>-arm64.zip>
set -euo pipefail

zip="${1:?usage: helm-smoke-mac.sh <update .zip>}"
READY_TIMEOUT_S=120
STAY_UP_S=8
REAL_DB="$HOME/.helm/userdata/statev2.sqlite"
REAL_PROFILE="$HOME/Library/Application Support/helm"

cd "$(git rev-parse --show-toplevel)"
scripts/helm-check-deps.sh
work=$(mktemp -d /tmp/helm-smoke.XXXXXX)
mkdir -p "$work/app"
ditto -x -k "$zip" "$work/app"
binary="$work/app/Helm.app/Contents/MacOS/Helm"
[[ -x "$binary" ]] || { echo "helm-smoke: no Helm.app in $zip" >&2; exit 1; }

app_pid=""
stop_app() {
  [[ -n "$app_pid" ]] || return 0
  local children
  children=$(pgrep -P "$app_pid" || true)
  kill -TERM "$app_pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$app_pid" 2>/dev/null || break
    sleep 0.5
  done
  # Only the PID we spawned and its direct children, never a name match.
  for pid in $app_pid $children; do kill -KILL "$pid" 2>/dev/null || true; done
  app_pid=""
}
trap stop_app EXIT

# run <name> <home>: launch the app with HOME=<home> and wait for it to settle.
run() {
  local name="$1" home="$2"
  local log="$work/$name.log"
  local trace="$home/.helm/userdata/logs/server.trace.ndjson"
  local devtools_port
  devtools_port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  echo "helm-smoke: $name: launching"
  env -u ELECTRON_RUN_AS_NODE -u T3CODE_HOME HOME="$home" T3CODE_DISABLE_AUTO_UPDATE=1 \
    "$binary" --use-mock-keychain --remote-debugging-port="$devtools_port" >"$log" 2>&1 &
  app_pid=$!

  local waited=0
  until grep -q '"name":"ws\.rpc\.server\.' "$trace" 2>/dev/null; do
    if ! kill -0 "$app_pid" 2>/dev/null; then
      echo "helm-smoke: $name: app exited before it was ready. Log: $log" >&2
      tail -40 "$log" >&2
      app_pid=""
      return 1
    fi
    if ((waited >= READY_TIMEOUT_S)); then
      echo "helm-smoke: $name: not ready after ${READY_TIMEOUT_S}s. Log: $log" >&2
      tail -40 "$log" >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if ! node scripts/helm-smoke-renderer.ts "$devtools_port" 2>&1 | tee "$work/$name.renderer.log"; then
    echo "helm-smoke: $name: the window crashed. Log: $work/$name.renderer.log" >&2
    return 1
  fi

  sleep "$STAY_UP_S"
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "helm-smoke: $name: app crashed after start. Log: $log" >&2
    tail -40 "$log" >&2
    app_pid=""
    return 1
  fi
  stop_app
  echo "helm-smoke: $name: ok (ready in ${waited}s)"
}

run fresh "$work/fresh"

if [[ -f "$REAL_DB" ]]; then
  # Recent stopped threads only; scheduled tasks, queued work and auth
  # sessions are dropped, so the copy never runs the user's agents.
  mkdir -p "$work/seeded"
  env -u ELECTRON_RUN_AS_NODE node apps/server/scripts/migrate-dev-db.ts \
    --source "$REAL_DB" --base-dir "$work/seeded/.helm" >"$work/seed.log" 2>&1 || {
    echo "helm-smoke: copying the real database failed. Log: $work/seed.log" >&2
    tail -40 "$work/seed.log" >&2
    exit 1
  }
  # Only the window's saved state: no cookies, caches or credentials.
  profile="$work/seeded/Library/Application Support/helm"
  mkdir -p "$profile"
  for item in "Local Storage" "Session Storage" "IndexedDB"; do
    if [[ -e "$REAL_PROFILE/$item" ]]; then cp -R "$REAL_PROFILE/$item" "$profile/"; fi
  done
  rm -f "$profile/Local Storage/leveldb/LOCK" "$profile/IndexedDB/"*/LOCK
  run real-data "$work/seeded"
else
  echo "helm-smoke: no $REAL_DB, skipping the real-data run"
fi

rm -rf "$work"
echo "helm-smoke: passed"
