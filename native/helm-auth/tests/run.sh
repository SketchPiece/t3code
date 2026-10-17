#!/bin/bash
# pam_helm against a fake Helm that signs like the phone: approve, deny, bad signature, no Helm.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"; rm -f "$HOME/.helm-pam-test.sock"' EXIT
xcrun swiftc -o "$work/fake" "$here/fake.swift"
clang -w -o "$work/harness" "$here/stubs.c" "$here/../pam_helm.c" \
  -DKEYS_PATH="\"$work/approvers\"" -DKEYS_OWNER="$(id -u)" -DSOCKET_NAME='".helm-pam-test.sock"' \
  -framework Security -framework CoreFoundation
sock="$HOME/.helm-pam-test.sock"
expect() {
  local mode=$1 want=$2
  "$work/fake" "$mode" "$sock" "$work" >/dev/null &
  sleep 0.5
  local got; got="$("$work/harness" | tail -1)"
  wait || true
  if [[ "$got" == *"($want)"* ]]; then echo "ok   $mode → $want"; else echo "FAIL $mode: $got"; exit 1; fi
}
expect approve SUCCESS
expect deny FAIL
expect badsig FAIL
rm -f "$sock"
got="$("$work/harness" | tail -1)"
[[ "$got" == *"(IGNORE)"* ]] && echo "ok   no Helm → IGNORE" || { echo "FAIL no Helm: $got"; exit 1; }
