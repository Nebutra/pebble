# HarmonyOS PC desktop — mid/long-term architecture

**Status:** **Decision locked** — HAP is shell only; brain is real Go via hybrid
(V1) or privileged host (mid-term). C++ is packaging smoke on **:18777**, not a
second control plane. See
[`investigations/harmony-runtime-host.md`](./investigations/harmony-runtime-host.md).
Client: [`apps/harmony-desktop/`](../../apps/harmony-desktop/). Phase 0 evidence:
[`investigations/harmony-phase0-gates.md`](./investigations/harmony-phase0-gates.md).

**Constraints:** No Electron. No official Tauri Harmony target. Local complete desktop
is a **new client**, not a Tauri build flavor.

---

## 1. Product definition

| Item | Decision |
|------|----------|
| Form factor | HarmonyOS NEXT **PC** HAP (desktop), not phone companion |
| V1 success | Local `pebble-runtime` + React UI can list projects/worktrees and run **at least one** interactive session path (local PTY **or** SSH execution host) |
| Non-goals (V1) | Browser guest WebView parity, computer-use, iOS/Android emulator, full agent-hook matrix, macOS menu/tray parity |
| Shell | ArkTS Ability + system Web component |
| Brain | Existing Go `pebble-runtime` / `packages/contracts` |
| UI | Existing `product-core` **web** path (`web-preload-api`, `web-runtime-*`) with Tauri shell detection **false** |

Default V1 posture (until device spikes prove otherwise):

> **Local control plane + hybrid execution** — runtime and UI on Harmony PC;
> agent CLIs may run on a paired Linux/macOS host via existing SSH/remote paths
> when native agent binaries are missing.

---

## 2. Layering (ownership)

Matches language ownership in the implementation map, with a **third desktop shell**:

```text
product-core (React)
  └─ web preload / runtime HTTP+WS clients   ← Harmony path (not Tauri invoke)
        │
        ▼  packages/contracts + /v1/*
pebble-runtime (Go)                          ← same control plane as desktop/serve
        │
        ├─ local PTY (creack/pty, !windows)  ← Phase 0 Spike B
        ├─ git / worktree / files
        └─ SSH targets / relay-worker        ← hybrid execution

ArkTS shell (new apps/harmony-desktop)
  · Ability lifecycle, permissions, packaging
  · spawn/keep pebble-runtime sidecar
  · load UI bundle into Web component
  · thin native bridges only (clipboard, file picker, notifications)
```

| Layer | Today (macOS/Win/Linux) | Harmony mid/long-term |
|-------|-------------------------|------------------------|
| Desktop shell | Rust / Tauri | **ArkTS** (new app) |
| Renderer | React in Tauri WebView | Same React; **Web component** + web preload |
| Runtime gateway | Go `pebble-runtime` | Same binary target (if buildable) |
| Terminal | Go + `creack/pty` (`process_session_unix.go`) | Same, **if** pts works on OH |
| Platform-only | Large `src-tauri/commands/*` | **Do not port**; cut V1 scope |
| Contracts | `packages/contracts` | Single source of truth |

---

## 3. Why not Tauri-on-OH

- Upstream Tauri has **no** supported HarmonyOS/OpenHarmony target.
- Community ports are spikes; they do not absorb Pebble’s Go host, PTY, or release matrix.
- Tauri command surface (browser guest, computer-use, emulators) is the wrong cost center for V1.

**Rule:** Never add `#[cfg(harmony)]` to `apps/desktop/src-tauri`. Ship `apps/harmony-desktop/` (or equivalent) as an isolated client that speaks `/v1/*`.

---

## 4. Renderer strategy

### Prefer existing web stack

| Module | Role on Harmony |
|--------|-----------------|
| `renderer/src/web/web-preload-api.ts` | `window.api` without Electron/Tauri IPC |
| `renderer/src/web/web-runtime-client.ts` | E2EE WS / JSON-RPC to runtime |
| `renderer/src/runtime/web-runtime-session.ts` | Terminal/session via runtime, not local `pty.spawn` |
| `renderer/src/lib/tauri-shell-detection.ts` | Must report **non-Tauri** |

### Critical semantic

Web preload **rejects** `pty.spawn` (“Local PTYs are unavailable in the web client”).
That is correct for a **browser** client. On Harmony local desktop, sessions must go
through **runtime session APIs** (same as `pebble serve` + paired web), where Go owns
the PTY — not through renderer-local PTY IPC.

SSH target CRUD is also stubbed in web preload today. Hybrid V1 therefore needs either:

1. HTTP routes already used by Tauri desktop for SSH targets (extend web preload to call them), or
2. Explicit “configure execution host on the server” UX until that gap closes.

See F-matrix: [`investigations/harmony-phase0-f-matrix.md`](./investigations/harmony-phase0-f-matrix.md).

### Platform labels

- `hostprobe.nodePlatform` maps `windows→win32`, `darwin→darwin`, **default→raw GOOS**.
- Renderer helpers (`renderer-app-platform.ts`, keybindings) assume `win32|darwin|linux`.
- Phase 1 decision: map OH → `linux` for Node-compat **or** introduce capability flags and treat unknown as linux-like. Prefer **capability flags** + `hostPlatform: "linux"` compatibility alias for V1.

---

## 5. Runtime / Unix surface (static inventory)

Platform-split Go files under `runtime/go` (non-exhaustive; full list in gates doc):

| Concern | Unix path | Notes |
|---------|-----------|--------|
| PTY session | `runtimecore/process_session_unix.go` | `creack/pty.StartWithSize` |
| Foreground / signals | `foreground_process_unix.go`, `process_session_signal_unix.go` | process groups |
| Worktree hooks | `worktree_hook_process_unix.go` | `Setpgid`, `SIGKILL` group |
| Parent monitor | `cmd/pebble-runtime/parent_monitor_unix.go` | shell must set `PEBBLE_RUNTIME_PARENT_PID` |
| Port kill | `workspace_ports_unix.go` | `SIGTERM` |
| SSH control socket | `ssh_control_socket_unix.go` | `//go:build unix` |
| Auth credential replace | `runtimeauth/credential_*_unix.go` | atomic replace |
| Store files | `store_file_unix.go` | |

External tools probed at startup (`detectUnavailableTools`): `git`, `zig`, `pnpm`.

Default listen: `127.0.0.1:17777` (`-listen`, `-token`, `-data-dir`).

---

## 6. Phases (after Phase 0)

| Phase | Outcome |
|-------|---------|
| **0** | Device + offline gates; go/no-go (this package) |
| **1** | ArkTS shell + bundled runtime + UI loads `/v1/status`; project list |
| **2** | Worktree + interactive session (local PTY or SSH hybrid) + one agent path |
| **3** | Packaging, signing, capability matrix public docs, update story |
| **4** | Optional depth (more agents, notifications, multi-window) — not browser/CU |

---

## 7. Repository layout (when Phase 1 starts)

```text
apps/
  desktop/                 # Tauri only — unchanged ownership
  harmony-desktop/         # NEW: DevEco/ArkTS + packaging (not before G-Go)
packages/
  product-core/            # shared UI + web runtime clients
  contracts/               # API/events
runtime/go/                # ohos/linux-like build tags only as proven
tools/spikes/harmony-phase0/  # Phase 0 harness (checked in)
docs/reference/
  harmony-desktop.md       # this file
  investigations/harmony-phase0-*.md
```

---

## 8. Related docs

- Phase 0 gates + results: [`investigations/harmony-phase0-gates.md`](./investigations/harmony-phase0-gates.md)
- F-matrix (web vs Tauri vs V1): [`investigations/harmony-phase0-f-matrix.md`](./investigations/harmony-phase0-f-matrix.md)
- Probe harness: [`../../tools/spikes/harmony-phase0/README.md`](../../tools/spikes/harmony-phase0/README.md)
- Headless Linux serve (remote fallback): [`headless-linux-server.md`](./headless-linux-server.md)
