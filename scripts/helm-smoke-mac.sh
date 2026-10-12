#!/usr/bin/env bash
# Launch check for a built Helm update. Installed apps update from the .zip, so
# this unpacks that zip and starts the app the way an update restarts it:
#
#   1. on a fresh profile;
#   2. on a pruned copy of the real Helm database (~/.helm/userdata), so the
#      new build's migrations run against data shaped like the user's.
#
# Each run passes once the window's renderer talks to its own backend over the
# WebSocket and the app is still alive a few seconds later. Every run uses a
# throwaway HOME, so the installed Helm, its profile, data and single-instance
# lock are never touched. Exits non-zero when any run fails.
#
#   scripts/helm-smoke-mac.sh <Helm-<version>-arm64.zip>
set -euo pipefail

zip="${1:?usage: helm-smoke-mac.sh <update .zip>}"
READY_TIMEOUT_S=120
STAY_UP_S=8
REAL_DB="$HOME/.helm/userdata/statev2.sqlite"

cd "$(git rev-parse --show-toplevel)"
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
  echo "helm-smoke: $name: launching"
  env -u ELECTRON_RUN_AS_NODE -u T3CODE_HOME HOME="$home" T3CODE_DISABLE_AUTO_UPDATE=1 \
    "$binary" >"$log" 2>&1 &
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
  run real-data "$work/seeded"
else
  echo "helm-smoke: no $REAL_DB, skipping the real-data run"
fi

rm -rf "$work"
echo "helm-smoke: passed"
