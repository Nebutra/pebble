#!/usr/bin/env bash
# Import MAC_CERTS (base64 PKCS#12) into an ephemeral keychain for release
# signing, then export APPLE_SIGNING_IDENTITY for child build scripts.
#
# Why: tauri-action imports APPLE_CERTIFICATE late and does not always expose a
# usable identity to beforeBuildCommand (computer-use helper codesign). This
# step mirrors mobile-ios-release's throwaway keychain pattern and fails early
# with a clear diagnosis when the p12 is missing Developer ID Application.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS certificate import is only supported on Darwin runners." >&2
  exit 1
fi

if [[ -z "${APPLE_CERTIFICATE:-${MAC_CERTS:-}}" ]]; then
  echo "APPLE_CERTIFICATE (or MAC_CERTS) is required for macOS release signing." >&2
  exit 1
fi

CERT_B64="${APPLE_CERTIFICATE:-${MAC_CERTS}}"
CERT_PASSWORD="${APPLE_CERTIFICATE_PASSWORD:-${MAC_CERTS_PASSWORD:-}}"

if [[ -z "${GITHUB_ENV:-}" ]]; then
  echo "GITHUB_ENV is required to publish the resolved signing identity." >&2
  exit 1
fi

KEYCHAIN_PATH="${RUNNER_TEMP:-/tmp}/pebble-macos-release.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -base64 32)"
CERT_PATH="${RUNNER_TEMP:-/tmp}/pebble-macos-release.p12"

cleanup() {
  rm -f "$CERT_PATH" 2>/dev/null || true
}
trap cleanup EXIT

# Decode base64 p12. Accept either pure base64 or base64 with whitespace.
if ! printf '%s' "$CERT_B64" | tr -d '\n\r\t ' | base64 --decode >"$CERT_PATH" 2>/dev/null; then
  echo "Failed to base64-decode APPLE_CERTIFICATE / MAC_CERTS into a PKCS#12 blob." >&2
  exit 1
fi

if [[ ! -s "$CERT_PATH" ]]; then
  echo "Decoded certificate file is empty." >&2
  exit 1
fi

# Best-effort type probe (never print private material).
if command -v openssl >/dev/null 2>&1; then
  if ! openssl pkcs12 -in "$CERT_PATH" -passin "pass:${CERT_PASSWORD}" -nokeys -info -legacy 2>/dev/null \
    | head -n 40 \
    | sed 's/^/[pkcs12] /'; then
    echo "[pkcs12] openssl probe failed (wrong password or not a PKCS#12 file)." >&2
  fi
fi

rm -f "$KEYCHAIN_PATH"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

# Import private key + cert; allow codesign without UI prompts.
if ! security import "$CERT_PATH" \
  -P "$CERT_PASSWORD" \
  -A \
  -t cert \
  -f pkcs12 \
  -k "$KEYCHAIN_PATH" 2>"${RUNNER_TEMP:-/tmp}/pebble-macos-import.err"; then
  echo "security import failed:" >&2
  cat "${RUNNER_TEMP:-/tmp}/pebble-macos-import.err" >&2 || true
  echo "MAC_CERTS must be a base64-encoded Developer ID Application .p12 with the matching MAC_CERTS_PASSWORD." >&2
  exit 1
fi

security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" >/dev/null

# Prefer our throwaway keychain for identity lookup.
security list-keychains -d user -s "$KEYCHAIN_PATH" login.keychain-db

IDENTITIES="$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" || true)"
echo "$IDENTITIES" | sed 's/^/[codesign-identity] /'

IDENTITY="$(
  printf '%s\n' "$IDENTITIES" \
    | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' \
    | head -n 1
)"

if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(
    printf '%s\n' "$IDENTITIES" \
      | sed -n 's/.*[0-9A-F]*)[[:space:]][0-9A-F]*[[:space:]]"\([^"]*\)".*/\1/p' \
      | head -n 1
  )"
fi

if [[ -z "$IDENTITY" ]]; then
  echo "No code-signing identity found after importing MAC_CERTS." >&2
  echo "Expected a Developer ID Application certificate in the p12." >&2
  exit 1
fi

{
  echo "APPLE_SIGNING_IDENTITY=$IDENTITY"
  echo "PEBBLE_COMPUTER_MACOS_SIGN_IDENTITY=$IDENTITY"
  echo "CSC_NAME=$IDENTITY"
  echo "KEYCHAIN_PATH=$KEYCHAIN_PATH"
} >>"$GITHUB_ENV"

echo "Imported macOS release identity: $IDENTITY"
