#!/usr/bin/env bash
# B1 minimal PTY probe using the runtime Go module (creack/pty).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/runtime/go"
go run "$ROOT/tools/spikes/harmony-phase0/probe-pty-minimal.go"
