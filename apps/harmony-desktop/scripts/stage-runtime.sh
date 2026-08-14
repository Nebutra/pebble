#!/usr/bin/env bash
# Cross-compile pebble-runtime (static linux/arm64) for HarmonyOS HAP memfd/fexecve.
#
# Why static ET_EXEC + memfd (not filesDir exec / not Go c-shared dlopen):
# - SELinux blocks execve of filesDir and of packaged ET_EXEC under libs/ (errno 13).
# - musl rejects dlopen of Go c-shared ("initial-exec TLS resolves to dynamic definition").
# - Go 1.26 c-archive cross-build produces empty .a from darwin; unusable for NAPI link.
# - memfd_create + fexecve runs the static binary without a SELinux-labeled data file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT_DIR="$ROOT/apps/harmony-desktop/entry/build/stage"
RAW_DIR="$ROOT/apps/harmony-desktop/entry/src/main/resources/rawfile/runtime"
RAW_DEST="$RAW_DIR/pebble-runtime"
CPP_THIRD="$ROOT/apps/harmony-desktop/entry/src/main/cpp/third_party"
LIB_DIR="$ROOT/apps/harmony-desktop/entry/libs/arm64-v8a"

mkdir -p "$OUT_DIR" "$RAW_DIR"

echo "Building pebble-runtime (linux/arm64, CGO off, static)…"
(
  cd "$ROOT/runtime/go"
  CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o "$OUT_DIR/pebble-runtime" ./cmd/pebble-runtime
)

cp "$OUT_DIR/pebble-runtime" "$RAW_DEST"
chmod 755 "$RAW_DEST"

# Clean failed alternative packaging paths so HAP stays lean.
rm -f "$LIB_DIR/libpebble_runtime.so"
rm -f "$CPP_THIRD/libpebble_runtime.a" "$CPP_THIRD/libpebble_runtime.h"

ls -lah "$RAW_DEST"
file "$RAW_DEST"
echo "Staged rawfile binary for memfd fexecve: $RAW_DEST"
echo "Next: assembleHap / sign / install on PebblePC."
