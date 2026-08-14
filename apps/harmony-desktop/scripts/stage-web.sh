#!/usr/bin/env bash
# Build product-core web client and stage into HAP rawfile for local loopback serving.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT_WEB="$ROOT/out/web"
DEST="$ROOT/apps/harmony-desktop/entry/src/main/resources/rawfile/web"
MARKER="$DEST/.staged-from-product-core"

cd "$ROOT"

if [[ "${SKIP_WEB_BUILD:-0}" != "1" ]]; then
  echo "Building product-core web (vite)…"
  if command -v pnpm >/dev/null 2>&1; then
    NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192" pnpm run build:web
  else
    NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192" npm run build:web
  fi
fi

if [[ ! -f "$OUT_WEB/web-index.html" ]]; then
  echo "Missing $OUT_WEB/web-index.html — run build:web first (or unset SKIP_WEB_BUILD)." >&2
  exit 1
fi

echo "Staging web assets into $DEST …"
rm -rf "$DEST"
mkdir -p "$DEST"
# Preserve relative asset URLs (vite base: './').
cp -R "$OUT_WEB"/. "$DEST"/

# File list so RuntimeHost can copy nested assets without recursive rawfile APIs.
# Why not .filelist: HAP rawfile packaging often drops dotfiles.
if [[ -d "$DEST/assets" ]]; then
  (
    cd "$DEST/assets"
    find . -type f ! -name 'filelist.txt' | sed 's|^\./||' | sort > filelist.txt
  )
fi

# Keep a tiny bootstrap fallback for early frames before gateway is healthy.
if [[ ! -f "$DEST/bootstrap.html" ]]; then
  cat > "$DEST/bootstrap.html" <<'HTML'
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta http-equiv="refresh" content="0;url=./web-index.html"/></head>
<body><p>Redirecting to product-core web… <a href="./web-index.html">open</a></p></body></html>
HTML
fi
date -u +"%Y-%m-%dT%H:%M:%SZ product-core web staged" > "$MARKER"
# Why not a dotfile: HAP rawfile packaging drops them. RuntimeHost uses this
# to skip recopying hundreds of assets on every cold start.
date -u +"%Y-%m-%dT%H:%M:%SZ product-core web staged" > "$DEST/staged-from.txt"

# Why: ArkWeb WebGL canvases stay blank; force the DOM xterm renderer on the
# Harmony shell even before the next product-core web rebuild lands.
python3 - "$DEST/web-index.html" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
html = path.read_text()
needle = "id=\"pebble-harmony-gpu-off\""
if needle not in html:
    snippet = """    <script id="pebble-harmony-gpu-off">
      try {
        if (new URLSearchParams(location.search).get('harmony') === '1') {
          var k = 'pebble.web.settings.v1';
          var s = JSON.parse(localStorage.getItem(k) || '{}');
          if (s.terminalGpuAcceleration !== 'off') {
            s.terminalGpuAcceleration = 'off';
            localStorage.setItem(k, JSON.stringify(s));
          }
        }
      } catch (e) {}
    </script>
"""
    html = html.replace("<head>", "<head>\n" + snippet, 1)
    path.write_text(html)
PY

du -sh "$DEST"
ls -la "$DEST" | head -20
echo "Staged. Gateway serves filesDir/web after RuntimeHost copies rawfile."
echo "Next: assembleHap / sign / install on PebblePC."
