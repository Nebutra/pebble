#!/usr/bin/env bash
# A3-style gateway probe against a running pebble-runtime.
# Usage: probe-runtime-http.sh [base_url] [bearer_token]
set -euo pipefail

BASE="${1:-http://127.0.0.1:17777}"
TOKEN="${2:-${PEBBLE_RUNTIME_TOKEN:-}}"

auth_args=()
if [[ -n "$TOKEN" ]]; then
  auth_args=(-H "Authorization: Bearer $TOKEN")
fi

probe() {
  local path="$1"
  local need_auth="${2:-yes}"
  local args=(-sS -o /tmp/harmony-p0-body -w "%{http_code}" "$BASE$path")
  if [[ "$need_auth" == "yes" && -n "$TOKEN" ]]; then
    args=(-sS -o /tmp/harmony-p0-body -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$BASE$path")
  fi
  code="$(curl "${args[@]}" || true)"
  echo "$path -> HTTP $code"
  head -c 300 /tmp/harmony-p0-body 2>/dev/null || true
  echo
  echo "---"
}

echo "base=$BASE token_set=$([[ -n "$TOKEN" ]] && echo yes || echo no)"
probe /v1/status yes
probe /v1/status no
probe /v1/host/terminal-capabilities yes
probe /v1/projects yes
probe /v1/events yes
