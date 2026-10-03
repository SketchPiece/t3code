#!/bin/sh
# Helm fork: builds libtailscale (tsnet behind a C API) for iOS devices and the
# arm64 simulator, and packs both into ios/libtailscale/Libtailscale.xcframework.
# The podspec runs this when the framework is missing; rerun it by hand after
# bumping LIBTAILSCALE_COMMIT (and copy the matching tailscale.h).
#
# Needs Xcode and Go. libtailscale pins the Go release it builds with, so the
# go command fetches that toolchain on its own (GOTOOLCHAIN below).
set -eu

LIBTAILSCALE_COMMIT=59d4bb82744915815178e0f0776d60026a397ee7
GO_TOOLCHAIN=go1.25.5

HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT="$HERE/ios/libtailscale/Libtailscale.xcframework"
WORK="${TMPDIR:-/tmp}/helm-libtailscale-$LIBTAILSCALE_COMMIT"

if ! command -v go >/dev/null 2>&1; then
  if [ -x "$HOME/.local/go/bin/go" ]; then
    PATH="$HOME/.local/go/bin:$PATH"
  else
    echo "helm-tailscale: Go is required to build libtailscale (https://go.dev/dl)" >&2
    exit 1
  fi
fi

if [ ! -d "$WORK/.git" ]; then
  rm -rf "$WORK"
  git clone --quiet https://github.com/tailscale/libtailscale.git "$WORK"
fi
git -C "$WORK" fetch --quiet origin "$LIBTAILSCALE_COMMIT" 2>/dev/null || true
git -C "$WORK" checkout --quiet "$LIBTAILSCALE_COMMIT"

build() {
  sdk=$1
  output=$2
  cc="$WORK/cc-$sdk.sh"
  cat >"$cc" <<CC
#!/bin/sh
exec "\$(xcrun --sdk $sdk --find clang)" -arch arm64 -isysroot "\$(xcrun --sdk $sdk --show-sdk-path)" -m$3-version-min=15.0 "\$@"
CC
  chmod +x "$cc"
  (cd "$WORK" && GOTOOLCHAIN=$GO_TOOLCHAIN GOOS=ios GOARCH=arm64 CGO_ENABLED=1 CC="$cc" \
    go build -trimpath -ldflags -w -tags ios -buildmode=c-archive -o "$output")
}

build iphoneos "$WORK/device/libtailscale.a" ios
build iphonesimulator "$WORK/simulator/libtailscale.a" ios-simulator

rm -rf "$OUT"
xcodebuild -create-xcframework \
  -library "$WORK/device/libtailscale.a" \
  -library "$WORK/simulator/libtailscale.a" \
  -output "$OUT" >/dev/null
echo "helm-tailscale: built $OUT"
