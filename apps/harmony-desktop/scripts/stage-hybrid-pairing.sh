#!/usr/bin/env bash
# Copy hybrid pairing code into HAP rawfile so the next install auto-injects it.
# Run after run-hybrid-runtime.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CODE_FILE="$ROOT/apps/harmony-desktop/.harmony-hybrid-pairing.code"
DEST_DIR="$ROOT/apps/harmony-desktop/entry/src/main/resources/rawfile/hybrid"
DEST="$DEST_DIR/pairing.code"

if [[ ! -f "$CODE_FILE" ]]; then
  echo "Missing $CODE_FILE — run scripts/run-hybrid-runtime.sh first." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$CODE_FILE" "$DEST"
echo "Staged hybrid pairing code → $DEST"
echo "Next: assembleHap / reinstall HAP so RuntimeHost injects ?pairing= into web-index."
