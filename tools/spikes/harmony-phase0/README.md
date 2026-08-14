# Harmony Phase 0 probe harness

Executable checklist for mid/long-term **HarmonyOS PC desktop** (no Electron, no Tauri port).

| Doc | Path |
|-----|------|
| Architecture | `docs/reference/harmony-desktop.md` |
| Gates + offline evidence | `docs/reference/investigations/harmony-phase0-gates.md` |
| F-matrix | `docs/reference/investigations/harmony-phase0-f-matrix.md` |

## What runs where

| Script | Machine | Purpose |
|--------|---------|---------|
| `run-offline-audit.sh` | macOS/Linux dev | Renderer Tauri surface, Go file inventory, local runtime HTTP smoke |
| `probe-runtime-http.sh` | Any host with curl + running runtime | A3-style gateway checks |
| `run-pty-probe.sh` / `probe-pty-minimal.go` | Host with Go + pts | B1 creack/pty minimal (unix; uses `runtime/go` module) |
| `run-ohos-container-probe.sh` | Docker arm64 | OH mini rootfs proxy (dockerharmony): runtime + PTY + session |
| `device-checklist.md` | Real Harmony PC / DevEco | Fill Pass/Partial/Fail by hand |

Container proxy validates **runtime/PTY on OH-like userland**. It cannot substitute for DevEco/HAP packaging (G-UI/G-Shell).

## Quick start (dev machine)

From repository root:

```bash
chmod +x tools/spikes/harmony-phase0/*.sh
./tools/spikes/harmony-phase0/run-offline-audit.sh
```

Expect: local `pebble-runtime` build, `/v1/status` 200 with bearer, 401 without, terminal-capabilities JSON, audit excerpts written under `tools/spikes/harmony-phase0/out/`.

## OpenHarmony container proxy (installed path when DevEco unavailable)

```bash
./tools/spikes/harmony-phase0/run-ohos-container-probe.sh
```

Requires Docker Desktop (arm64). Pulls `hqzing/dockerharmony:latest`.  
**Does not** replace DevEco PC emulator for HAP/Web UI gates.

## On Harmony device (after binary exists)

```bash
# Push pebble-runtime + set executable, then:
./probe-runtime-http.sh http://127.0.0.1:17777 "$PEBBLE_RUNTIME_TOKEN"

# Optional PTY micro-probe (uses runtime/go module for creack/pty):
./tools/spikes/harmony-phase0/run-pty-probe.sh
```

Fill `device-checklist.md` and paste into the gates decision log.

## Rules

- Offline macOS smoke ≠ OH Pass; dockerharmony Pass ≠ HarmonyOS NEXT PC / HAP Pass.
- Do **not** start `apps/harmony-desktop` until G-UI/G-Shell can be tested (DevEco or real PC).
- Prefer fixing contracts + web preload gaps over forking Tauri.
