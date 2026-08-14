#!/usr/bin/env bash
# Phase 0 proxy environment: OpenHarmony mini rootfs via dockerharmony.
# This is NOT HarmonyOS NEXT PC / DevEco emulator / HAP packaging.
# It validates Go runtime + PTY + basic git/session on OH-like musl userland.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/tools/spikes/harmony-phase0/out/ohos-probe"
NAME="${OHOS_CONTAINER_NAME:-ohos-phase0}"
IMAGE="${OHOS_IMAGE:-hqzing/dockerharmony:latest}"
TOKEN="${PEBBLE_RUNTIME_TOKEN:-ohosphase0}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="$OUT/ohos-container-probe-$STAMP.md"

mkdir -p "$OUT"
exec > >(tee "$REPORT") 2>&1

echo "# OpenHarmony container probe (dockerharmony)"
echo
echo "- stamp: \`$STAMP\`"
echo "- image: \`$IMAGE\`"
echo "- caveat: OH mini rootfs on Linuxkit host kernel — not HAP / DevEco PC emulator"
echo

if ! command -v docker >/dev/null; then
  echo "FAIL: docker not installed"
  exit 1
fi

echo "## 1. Image + container"
docker pull "$IMAGE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name="$NAME" --platform linux/arm64 --privileged "$IMAGE" sleep 7200
sleep 1
docker exec "$NAME" sh -c 'uname -a; ls /dev/pts; id'

echo
echo "## 2. Cross-build linux/arm64 binaries"
(
  cd "$ROOT/runtime/go"
  CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o "$OUT/pebble-runtime-linux-arm64" ./cmd/pebble-runtime
  CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o "$OUT/probe-pty-minimal-linux-arm64" \
    "$ROOT/tools/spikes/harmony-phase0/probe-pty-minimal.go"
)
docker cp "$OUT/pebble-runtime-linux-arm64" "$NAME:/tmp/pebble-runtime"
docker cp "$OUT/probe-pty-minimal-linux-arm64" "$NAME:/tmp/probe-pty"
docker exec "$NAME" sh -c 'chmod +x /tmp/pebble-runtime /tmp/probe-pty'

echo
echo "## 3. B1 PTY"
docker exec "$NAME" /tmp/probe-pty

echo
echo "## 4. Optional Alpine git (musl)"
docker exec "$NAME" sh -c '
set -e
alpine_repository="http://dl-cdn.alpinelinux.org/alpine/v3.22/main/aarch64"
curl -fsSL ${alpine_repository}/APKINDEX.tar.gz | tar -zx -C /tmp
install_apk() {
  name="$1"
  ver=$(grep -A1 "^P:${name}$" /tmp/APKINDEX | sed -n "s/^V://p" | head -1)
  curl -fsSL -o /tmp/${name}.apk ${alpine_repository}/${name}-${ver}.apk
  tar -zxf /tmp/${name}.apk -C / 2>/dev/null || tar -xf /tmp/${name}.apk -C /
}
for p in ca-certificates-bundle libexpat pcre2 zlib libcurl nghttp2-libs libidn2 libpsl brotli-libs c-ares zstd-libs git; do
  install_apk "$p" || true
done
export PATH=/usr/bin:/bin:$PATH
git --version
mkdir -p /tmp/ws/repo && cd /tmp/ws/repo
git init -b main
git config user.email p0@example.com
git config user.name phase0
printf "hello\n" > README.md
git add README.md
# git may SIGABRT after commit on some OH containers; still often succeeds
git commit -m init || true
git log --oneline | head -3
git worktree add /tmp/ws/wt HEAD || echo "worktree Partial/Fail"
' || echo "git install/ops Partial"

echo
echo "## 5. Runtime + session (A3/B2)"
docker exec "$NAME" sh -c "pkill pebble-runtime 2>/dev/null || true; mkdir -p /tmp/pdata; /tmp/pebble-runtime -listen 127.0.0.1:17777 -data-dir /tmp/pdata -token $TOKEN > /tmp/rt.log 2>&1 &"
sleep 2
docker exec "$NAME" sh -c "
set -e
export PATH=/usr/bin:/bin:\$PATH
AUTH=\"Authorization: Bearer $TOKEN\"
BASE=http://127.0.0.1:17777
cat /tmp/rt.log
echo STATUS:
curl -sS -H \"\$AUTH\" \$BASE/v1/status
echo
echo CAPS:
curl -sS -H \"\$AUTH\" \$BASE/v1/host/terminal-capabilities
echo
PROJ=\$(curl -sS -H \"\$AUTH\" -H 'Content-Type: application/json' -d '{\"path\":\"/tmp/ws/repo\",\"name\":\"phase0\"}' \$BASE/v1/projects)
echo PROJ=\$PROJ
PID=\$(echo \"\$PROJ\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p')
SID=\$(curl -sS -H \"\$AUTH\" -H 'Content-Type: application/json' \
  -d \"{\\\"projectId\\\":\\\"\$PID\\\",\\\"command\\\":[\\\"/bin/sh\\\"],\\\"cols\\\":80,\\\"rows\\\":24}\" \
  \$BASE/v1/sessions | sed -n 's/.*\\\"id\\\":\\\"\\([^\\\"]*\\)\\\".*/\\1/p')
echo SID=\$SID
curl -sS -H \"\$AUTH\" -H 'Content-Type: application/json' \
  -d '{\"text\":\"echo p0-session-ok\",\"appendNewline\":true}' \
  \$BASE/v1/sessions/\$SID/input
echo
sleep 1
echo TAIL:
curl -sS -H \"\$AUTH\" \$BASE/v1/sessions/\$SID/tail
echo
"

echo
echo "## 6. Agent CLI presence"
docker exec "$NAME" sh -c 'for c in node npm claude codex opencode ssh git; do command -v $c >/dev/null 2>&1 && echo HAVE $c || echo MISS $c; done'

echo
echo "## Result"
echo "- report: \`$REPORT\`"
echo "- G-UI / G-Shell / HAP still require DevEco + HarmonyOS PC emulator (not this container)"
