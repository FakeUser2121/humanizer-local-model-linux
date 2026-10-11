#!/usr/bin/env bash
# Build Humanizer-<version>-<arch>.AppImage
#
#   ./build.sh                      # build for this machine (x86_64 or aarch64)
#   VERSION=1.2.3 ./build.sh        # choose the version string
#   ARCH=aarch64 ./build.sh         # cross-build for ARM64 from an x86_64 machine
#   SKIP_TESTS=1 ./build.sh         # skip `go test`
#
# Needs: bash, curl, tar, Go >= 1.21. Internet access for the first build
# (Go module downloads + appimagetool download, both cached in .cache/).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

VERSION="${VERSION:-1.0.0}"
HOST_ARCH="$(uname -m)"
ARCH="${ARCH:-$HOST_ARCH}"
case "$ARCH" in
  x86_64|amd64)  ARCH=x86_64;  GOARCH=amd64 ;;
  aarch64|arm64) ARCH=aarch64; GOARCH=arm64 ;;
  *) echo "Unsupported ARCH '$ARCH' (use x86_64 or aarch64)" >&2; exit 1 ;;
esac
case "$HOST_ARCH" in
  x86_64|amd64)  HOST_GOARCH=amd64 ;;
  aarch64|arm64) HOST_GOARCH=arm64 ;;
  *) HOST_GOARCH=amd64 ;;
esac

CACHE="$ROOT/.cache"; BUILD="$ROOT/build"; DIST="$ROOT/dist"
mkdir -p "$CACHE" "$DIST"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }; }
need curl; need tar; need go

say "Using $(go version)"

if [ -z "${SKIP_TESTS:-}" ]; then
  say "Running tests (Go + web logic)"
  go test ./...
  if command -v node >/dev/null 2>&1; then
    node devtools/webtest.mjs | tail -3
  fi
fi

say "Compiling humanizer ($ARCH)"
rm -rf "$BUILD"; mkdir -p "$BUILD/AppDir/usr/bin"
CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" \
  go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$BUILD/AppDir/usr/bin/humanizer" .

say "Assembling AppDir"
AD="$BUILD/AppDir"
install -m 0755 packaging/appimage/AppRun "$AD/AppRun"
install -m 0644 packaging/appimage/humanizer.desktop "$AD/humanizer.desktop"
install -m 0644 packaging/humanizer.png "$AD/humanizer.png"
cp "$AD/humanizer.png" "$AD/.DirIcon"
mkdir -p "$AD/usr/share/icons/hicolor/256x256/apps" "$AD/usr/share/applications" "$AD/usr/share/licenses/humanizer"
cp packaging/humanizer.png "$AD/usr/share/icons/hicolor/256x256/apps/humanizer.png"
cp packaging/appimage/humanizer.desktop "$AD/usr/share/applications/humanizer.desktop"
cp LICENSE NOTICE "$AD/usr/share/licenses/humanizer/"

TOOL="$CACHE/appimagetool-$HOST_ARCH.AppImage"
if [ ! -x "$TOOL" ]; then
  say "Downloading appimagetool"
  curl -fL --retry 3 -o "$TOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${HOST_ARCH}.AppImage"
  chmod +x "$TOOL"
fi

OUT="$DIST/Humanizer-$VERSION-$ARCH.AppImage"
say "Packing $OUT"
ARCH="$ARCH" "$TOOL" --appimage-extract-and-run --no-appstream "$AD" "$OUT"
chmod +x "$OUT"

say "Done"
ls -lh "$OUT"
echo
echo "Run it:   $OUT"
echo "Or:       $OUT --server http://127.0.0.1:8080"
