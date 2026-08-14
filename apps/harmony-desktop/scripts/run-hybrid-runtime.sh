#!/usr/bin/env bash
# Hard-correct V1 path: real Go pebble-runtime on the host; HAP web pairs to it.
# Why: normal HAP cannot exec/dlopen Go (SELinux + musl TLS). See
# docs/reference/investigations/harmony-runtime-host.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DATA_DIR="${HARMONY_RUNTIME_DATA_DIR:-$ROOT/apps/harmony-desktop/.runtime-data-hybrid}"
TOKEN="${PEBBLE_RUNTIME_TOKEN:-pebble-harmony-hybrid}"
# Prefer loopback-on-device via `hdc rport` (reliable). Override for LAN device:
#   HARMONY_PAIRING_HOST=192.168.x.x HARMONY_SKIP_RPORT=1
PAIR_HOST="${HARMONY_PAIRING_HOST:-127.0.0.1}"
LISTEN_HOST="${HARMONY_LISTEN_HOST:-0.0.0.0}"
# Why 17778: 17777 is Pebble.app's desktop runtime on the same Mac.
PORT="${HARMONY_RUNTIME_PORT:-17778}"
LISTEN="${LISTEN_HOST}:${PORT}"
CTRL="http://127.0.0.1:${PORT}"
OUT_JSON="$ROOT/apps/harmony-desktop/.harmony-hybrid-pairing.json"
OUT_CODE="$ROOT/apps/harmony-desktop/.harmony-hybrid-pairing.code"
BIN="$ROOT/apps/harmony-desktop/entry/build/stage/pebble-runtime-host"
MATERIAL_JSON="$DATA_DIR/pairing-material.json"
HDC_BIN="${HDC:-/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc}"
HDC_TARGET="${HDC_TARGET:-127.0.0.1:5555}"

mkdir -p "$DATA_DIR" "$(dirname "$BIN")"

echo "Building host pebble-runtime (native GOOS/GOARCH)…"
(
  cd "$ROOT/runtime/go"
  CGO_ENABLED=0 go build -o "$BIN" ./cmd/pebble-runtime
)

PID_FILE="$DATA_DIR/runtime.pid"
if [[ -f "$PID_FILE" ]]; then
  old="$(cat "$PID_FILE" || true)"
  if [[ -n "${old:-}" ]] && kill -0 "$old" 2>/dev/null; then
    echo "Stopping previous hybrid runtime pid=$old"
    kill "$old" 2>/dev/null || true
    sleep 0.5
  fi
fi

echo "Starting pebble-runtime listen=$LISTEN lan-shared-control dataDir=$DATA_DIR"
"$BIN" \
  -listen "$LISTEN" \
  -data-dir "$DATA_DIR" \
  -token "$TOKEN" \
  -lan-shared-control \
  >"$DATA_DIR/runtime.log" 2>&1 &
echo $! >"$PID_FILE"
pid="$(cat "$PID_FILE")"
echo "pid=$pid log=$DATA_DIR/runtime.log"

for _ in $(seq 1 40); do
  if curl -fsS -m 1 -H "Authorization: Bearer $TOKEN" "$CTRL/v1/status" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "runtime exited early; tail log:" >&2
    tail -40 "$DATA_DIR/runtime.log" >&2 || true
    exit 1
  fi
done

echo "status: $(curl -fsS -m 2 -H "Authorization: Bearer $TOKEN" "$CTRL/v1/status")"

# Device 127.0.0.1:PORT → host :PORT so HAP web can pair to real Go on loopback.
if [[ "${HARMONY_SKIP_RPORT:-0}" != "1" && -x "$HDC_BIN" ]]; then
  if "$HDC_BIN" -t "$HDC_TARGET" list targets 2>/dev/null | grep -q .; then
    echo "Setting hdc rport tcp:${PORT} tcp:${PORT} (device → host)…"
    "$HDC_BIN" -t "$HDC_TARGET" rport "tcp:${PORT}" "tcp:${PORT}" 2>/dev/null \
      || "$HDC_BIN" -t "$HDC_TARGET" rport "tcp:${PORT}" "tcp:${PORT}" 2>&1 || true
    "$HDC_BIN" -t "$HDC_TARGET" fport ls 2>&1 | head -10 || true
  else
    echo "No hdc target; skip rport (set HDC_TARGET or HARMONY_SKIP_RPORT=1)."
  fi
fi

# Why: minting a new device token every restart invalidates the HAP rawfile
# pairing and the WebView reconnects as a stranger. Reuse unless asked.
if [[ -f "$MATERIAL_JSON" && "${HARMONY_ROTATE_PAIRING:-0}" != "1" ]]; then
  echo "Reusing existing pairing material $MATERIAL_JSON"
else
  curl -fsS -m 5 -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"Harmony hybrid","scope":"runtime","rotate":false}' \
    "$CTRL/v1/shared-control/pairing" >"$MATERIAL_JSON"
fi

endpoint="ws://${PAIR_HOST}:${PORT}/v1/shared-control"

python3 - "$MATERIAL_JSON" "$endpoint" "$CTRL" "$TOKEN" "$pid" "$OUT_JSON" "$OUT_CODE" <<'PY'
import json, base64, pathlib, sys
material_path, endpoint, ctrl, token, pid, out_json, out_code = sys.argv[1:8]
material = json.loads(pathlib.Path(material_path).read_text())
offer = {
    "v": 2,
    "endpoint": endpoint,
    "deviceToken": material["deviceToken"],
    "publicKeyB64": material["publicKeyB64"],
    "scope": "runtime",
}
raw = json.dumps(offer, separators=(",", ":")).encode()
code = base64.urlsafe_b64encode(raw).decode().rstrip("=")
pairing_url = f"pebble://pair?code={code}"
out = {
    "pairingUrl": pairing_url,
    "code": code,
    "endpoint": endpoint,
    "control": ctrl,
    "token": token,
    "deviceId": material.get("deviceId"),
    "pid": int(pid),
}
pathlib.Path(out_json).write_text(json.dumps(out, indent=2) + "\n")
pathlib.Path(out_code).write_text(code + "\n")
print(json.dumps(out, indent=2))
print()
print("Hybrid runtime is up.")
print("  1) ./apps/harmony-desktop/scripts/stage-hybrid-pairing.sh")
print("  2) ./apps/harmony-desktop/scripts/seed-hybrid-demo.sh   # project+worktree+session")
print("  3) rebuild/reinstall HAP if pairing rawfile changed")
print("  4) product-core web auto-pairs via ?pairing=code")
print(f"Stop: kill {pid}")
PY

# Optional demo data for UI (project + running shell session on host).
if [[ "${HARMONY_SKIP_SEED:-0}" != "1" ]]; then
  "$ROOT/apps/harmony-desktop/scripts/seed-hybrid-demo.sh" || true
fi
