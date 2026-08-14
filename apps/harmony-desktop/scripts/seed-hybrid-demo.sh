#!/usr/bin/env bash
# Seed a local git project + PTY session on the hybrid Go runtime for UI demos.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DATA_DIR="${HARMONY_RUNTIME_DATA_DIR:-$ROOT/apps/harmony-desktop/.runtime-data-hybrid}"
TOKEN="${PEBBLE_RUNTIME_TOKEN:-pebble-harmony-hybrid}"
CTRL="${HARMONY_RUNTIME_CTRL:-http://127.0.0.1:17778}"
DEMO_REPO="${HARMONY_DEMO_REPO:-$DATA_DIR/demo-repo}"
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

if ! curl -fsS -m 2 -H "Authorization: Bearer $TOKEN" "$CTRL/v1/status" >/dev/null; then
  echo "Hybrid runtime not reachable at $CTRL — run run-hybrid-runtime.sh first." >&2
  exit 1
fi

if [[ ! -d "$DEMO_REPO/.git" ]]; then
  mkdir -p "$DEMO_REPO"
  git -C "$DEMO_REPO" init -b main
  printf '# harmony hybrid demo\n' >"$DEMO_REPO/README.md"
  git -C "$DEMO_REPO" add README.md
  git -C "$DEMO_REPO" -c user.email=demo@pebble.local -c user.name=Demo commit -m 'init'
fi

# Idempotent: if project already exists for this path, reuse it.
projects="$(curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" "$CTRL/v1/projects")"
proj_id="$(python3 - "$projects" "$DEMO_REPO" <<'PY'
import json,sys
projects=json.loads(sys.argv[1]); path=sys.argv[2]
for p in projects:
  if p.get("path")==path:
    print(p["id"]); break
PY
)"

if [[ -z "$proj_id" ]]; then
  created="$(curl -fsS -m 5 -X POST "$CTRL/v1/projects" "${AUTH[@]}" \
    -d "$(python3 -c "import json; print(json.dumps({'name':'harmony-demo','path':'''$DEMO_REPO''','locationKind':'local'}))")")"
  proj_id="$(python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" <<<"$created")"
  echo "Created project $proj_id"
else
  echo "Reusing project $proj_id"
fi

worktrees="$(curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" "$CTRL/v1/worktrees")"
wt_id="$(python3 - "$worktrees" "$proj_id" <<'PY'
import json,sys
wts=json.loads(sys.argv[1]); pid=sys.argv[2]
for w in wts:
  if w.get("projectId")==pid:
    print(w["id"]); break
PY
)"
echo "worktree $wt_id"

sessions="$(curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" "$CTRL/v1/sessions")"
running="$(python3 - "$sessions" "$proj_id" <<'PY'
import json,sys
ss=json.loads(sys.argv[1]); pid=sys.argv[2]
for s in ss:
  if s.get("projectId")==pid and s.get("status")=="running":
    print(s["id"]); break
PY
)"

if [[ -z "$running" ]]; then
  body="$(python3 - <<PY
import json
print(json.dumps({
  "projectId": "$proj_id",
  "worktreeId": "$wt_id",
  "cwd": "$DEMO_REPO",
  "command": ["/bin/zsh", "-l"],
  "cols": 80,
  "rows": 24,
}))
PY
)"
  sess="$(curl -fsS -m 15 -X POST "$CTRL/v1/sessions" "${AUTH[@]}" -d "$body")"
  running="$(python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" <<<"$sess")"
  echo "Started session $running"
else
  echo "Reusing session $running"
fi

curl -fsS -m 2 -H "Authorization: Bearer $TOKEN" "$CTRL/v1/status" | python3 -c \
  'import sys,json; d=json.load(sys.stdin); print("status projects=%s worktrees=%s sessions=%s" % (d["projectCount"], d["worktreeCount"], d["sessionCount"]))'
