#!/usr/bin/env bash
# Phase 0 offline audit: codebase surfaces + local pebble-runtime HTTP smoke.
# Not a substitute for HarmonyOS device spikes A–G.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/tools/spikes/harmony-phase0/out"
mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="$OUT/offline-audit-$STAMP.md"
LISTEN="127.0.0.1:18778"
TOKEN="phase0-offline-$STAMP"
DATA_DIR="$OUT/runtime-data-$STAMP"
RUNTIME_BIN="$OUT/pebble-runtime-$STAMP"
LOG="$OUT/runtime-$STAMP.log"

exec > >(tee "$REPORT") 2>&1

echo "# Harmony Phase 0 offline audit"
echo
echo "- stamp: \`$STAMP\`"
echo "- root: \`$ROOT\`"
echo "- host: \`$(uname -a)\`"
echo

section() { echo; echo "## $1"; echo; }

section "Go toolchain"
if ! command -v go >/dev/null 2>&1; then
  echo "FAIL: go not on PATH"
  exit 1
fi
go version

section "F-audit: Tauri / shell flags in renderer"
rg -n "from '@tauri-apps|invoke\\(|isPebbleTauriShell|isTauriDesktopShell|__PEBBLE_TAURI" \
  "$ROOT/packages/product-core/renderer/src" \
  --glob '!**/*.{test,spec}.*' \
  --glob '!**/node_modules/**' \
  || true

section "F-audit: web PTY/SSH stubs"
rg -n "Local PTYs are unavailable|SSH target management is unavailable|createWebRuntimeSession" \
  "$ROOT/packages/product-core/renderer/src/web" \
  "$ROOT/packages/product-core/renderer/src/runtime" \
  --glob '!**/*test*' \
  || true

section "Go platform-split files"
find "$ROOT/runtime/go" \( -name '*_unix.go' -o -name '*_windows.go' -o -name '*_linux.go' -o -name '*_darwin.go' \) \
  | sed "s|$ROOT/||" | sort

section "Build pebble-runtime"
(
  cd "$ROOT/runtime/go"
  go build -o "$RUNTIME_BIN" ./cmd/pebble-runtime
)
ls -la "$RUNTIME_BIN"

section "HTTP smoke"
mkdir -p "$DATA_DIR"
"$RUNTIME_BIN" -listen "$LISTEN" -data-dir "$DATA_DIR" -token "$TOKEN" >"$LOG" 2>&1 &
RPID=$!
cleanup() {
  if kill -0 "$RPID" 2>/dev/null; then
    kill "$RPID" 2>/dev/null || true
    wait "$RPID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -o /dev/null -H "Authorization: Bearer $TOKEN" "http://$LISTEN/v1/status"; then
    break
  fi
  sleep 0.2
done

echo "### runtime log (head)"
echo '```'
head -n 20 "$LOG" || true
echo '```'
echo

smoke() {
  local name="$1" url="$2" auth="${3:-}"
  local args=(-sS -w "\nhttp_code=%{http_code}\n" "$url")
  if [[ -n "$auth" ]]; then
    args=(-sS -w "\nhttp_code=%{http_code}\n" -H "Authorization: Bearer $TOKEN" "$url")
  fi
  echo "#### $name"
  echo '```'
  curl "${args[@]}" | head -c 800
  echo
  echo '```'
  echo
}

smoke "GET /v1/status (bearer)" "http://$LISTEN/v1/status" auth
smoke "GET /v1/status (no token)" "http://$LISTEN/v1/status"
smoke "GET /v1/host/terminal-capabilities" "http://$LISTEN/v1/host/terminal-capabilities" auth
smoke "GET /v1/projects" "http://$LISTEN/v1/projects" auth

section "PTY dependency presence"
(
  cd "$ROOT/runtime/go"
  go list -deps ./cmd/pebble-runtime | rg -i 'creack/pty|go-pty|golang.org/x/sys' || true
)

section "Result"
echo "- report: \`$REPORT\`"
echo "- runtime log: \`$LOG\`"
echo "- **Reminder:** this is not G-Runtime Pass for HarmonyOS."
echo "- Next: run device checklist in \`device-checklist.md\`."
