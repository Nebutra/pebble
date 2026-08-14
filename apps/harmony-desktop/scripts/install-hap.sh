#!/usr/bin/env bash
# Assemble, locally sign, and optionally install the Harmony desktop HAP.
# Signing material: apps/harmony-desktop/signing/ (OpenHarmony debug + pebble-app.p12).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/apps/harmony-desktop"
SIGN="$APP/signing"
OUT="$APP/entry/build/default/outputs/default"
UNSIGNED="$OUT/entry-default-unsigned.hap"
SIGNED="$OUT/entry-default-signed.hap"
DEVECO="${DEVECO_HOME:-/Applications/DevEco-Studio.app/Contents}"
JAR="$DEVECO/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar"
HDC="${HDC:-$DEVECO/sdk/default/openharmony/toolchains/hdc}"
HDC_TARGET="${HDC_TARGET:-127.0.0.1:5555}"
# Why 123456: local OpenHarmony debug store created for emulator installs.
KEY_ALIAS="${HAP_KEY_ALIAS:-pebble-app-key}"
KEY_PWD="${HAP_KEY_PWD:-123456}"
STORE_PWD="${HAP_STORE_PWD:-123456}"

export PATH="$DEVECO/tools/node/bin:$DEVECO/tools/ohpm/bin:$DEVECO/tools/hvigor/bin:$PATH"
export DEVECO_SDK_HOME="$DEVECO/sdk"
# Why: Huawei SDK refuses overseas proxy ("only Chinese mainland").
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy

if [[ ! -f "$APP/entry/src/main/resources/rawfile/web/web-index.html" ]]; then
  echo "Staged web missing — running stage-web.sh (SKIP_WEB_BUILD=${SKIP_WEB_BUILD:-1})"
  SKIP_WEB_BUILD="${SKIP_WEB_BUILD:-1}" "$APP/scripts/stage-web.sh"
fi
if [[ ! -f "$APP/entry/src/main/resources/rawfile/hybrid/pairing.code" ]]; then
  echo "Pairing rawfile missing — running stage-hybrid-pairing.sh"
  "$APP/scripts/stage-hybrid-pairing.sh"
fi

echo "assembleHap…"
(
  cd "$APP"
  hvigorw assembleHap -p product=default -p buildMode=debug --no-daemon
)

if [[ ! -f "$UNSIGNED" ]]; then
  echo "unsigned hap missing: $UNSIGNED" >&2
  exit 1
fi
if [[ ! -f "$JAR" ]]; then
  echo "hap-sign-tool.jar missing: $JAR" >&2
  exit 1
fi

echo "sign-app…"
java -jar "$JAR" sign-app \
  -mode localSign \
  -keyAlias "$KEY_ALIAS" \
  -keyPwd "$KEY_PWD" \
  -appCertFile "$SIGN/pebble-app-cert-chain.cer" \
  -profileFile "$SIGN/pebble-debug.p7b" \
  -inFile "$UNSIGNED" \
  -signAlg SHA256withECDSA \
  -keystoreFile "$SIGN/pebble-app.p12" \
  -keystorePwd "$STORE_PWD" \
  -outFile "$SIGNED" \
  -compatibleVersion 12 \
  -signCode 1

ls -lah "$SIGNED"

if [[ "${HARMONY_SKIP_INSTALL:-0}" == "1" ]]; then
  echo "HARMONY_SKIP_INSTALL=1 — signed hap ready, not installing."
  exit 0
fi

if [[ ! -x "$HDC" ]]; then
  echo "hdc not executable: $HDC" >&2
  exit 1
fi

if ! "$HDC" list targets 2>/dev/null | grep -q .; then
  echo "No hdc target. Start PebblePC, then:"
  echo "  $HDC -t $HDC_TARGET install \"$SIGNED\""
  echo "  $HDC -t $HDC_TARGET shell aa start -a EntryAbility -b nebutra.pebble.desktop"
  exit 0
fi

echo "Installing on $($HDC list targets | head -1)…"
"$HDC" -t "$HDC_TARGET" install "$SIGNED"
"$HDC" -t "$HDC_TARGET" shell aa start -a EntryAbility -b nebutra.pebble.desktop || true
echo "Installed and launched nebutra.pebble.desktop"
