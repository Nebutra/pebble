# Harmony Phase 0 — gates, evidence, go/no-go

**Package date:** 2026-08-04 (updated 2026-08-10)  
**Architecture:** [`../harmony-desktop.md`](../harmony-desktop.md)  
**F-matrix:** [`harmony-phase0-f-matrix.md`](./harmony-phase0-f-matrix.md)  
**Harness:** [`../../../tools/spikes/harmony-phase0/README.md`](../../../tools/spikes/harmony-phase0/README.md)

---

## Executive status

| Track | Status | Notes |
|-------|--------|--------|
| Offline / codebase (F, static Go inventory, local macOS gateway smoke) | **Complete** | This document + F-matrix + harness |
| OH **userland proxy** (dockerharmony mini rootfs) | **Complete 2026-08-04** | See “OH container evidence” below |
| DevEco Studio + **2in1 PC emulator** | **Installed 2026-08-10** | Image + AVD `PebblePC`; hdc `127.0.0.1:5555` |
| hdc shell push of `pebble-runtime` | **Partial** | Binary runs (`-h`); **cannot** bind listen sockets or open `/dev/ptmx` as `shell` uid |
| Phase 1 engineering (`apps/harmony-desktop`) | **Not started** | Needs HAP-packaged process, not hdc shell |

**Interpretation:**  
- dockerharmony still shows runtime+PTY can work under a permissive OH-like userland.  
- **Public HarmonyOS PC emulator is undebuggable**: `hdc smode` → *Cannot set root run mode in undebuggable version*; shell (`uid=2000`) is SELinux-restricted. Product must ship as **HAP native/sidecar**, not adb-style shell daemon.

---

## Gate summary

| Gate | Meaning | Offline / proxy | Real Harmony PC emulator (hdc shell) |
|------|---------|-----------------|--------------------------------------|
| **G-Runtime** | Go runtime on OH | **Pass** (dockerharmony) | **Partial** — binary runs; **cannot bind listen** as shell |
| **G-Session** | Interactive PTY | **Pass** (dockerharmony) | **Fail** via shell — `/dev/ptmx` denied |
| **G-Workspace** | git + worktree | **Partial** | untested on emulator |
| **G-Agent** | Local CLI or SSH hybrid | **Fail local** | untested |
| **G-UI** | Web in OH Web component | Static web path only | ☐ need HAP Web component |
| **G-Shell** | HAP embed sidecar | N/A | ☐ DevEco ready; HAP not scaffolded |
| **G-Map** | Known gaps | **Pass** | ✅ |

### Provisional product decision (2026-08-10)

```text
DevEco + 2in1 PC emulator: operational (PebblePC / hdc 127.0.0.1:5555)
hdc shell: push OK; listen TCP + PTY blocked (undebuggable public image)
  → Phase 1 must be HAP (ArkTS Ability + native/network entitlements)
dockerharmony still valid for pure Go/PTY unit spikes

Next:
  1. Scaffold apps/harmony-desktop HAP that owns runtime process privileges
  2. Web component → loopback once listen works inside app sandbox
  3. Hybrid SSH for agents until OH CLI ecosystem exists

Clash: DIRECT for Huawei CDN (overseas nodes break mainland-only downloads)
Do not port Tauri.
```

### Go / No-Go rules

```text
IF G-Runtime == Fail → No-Go local host; remote shell only
ELSE IF G-Session == Fail AND G-Agent == Fail → No-Go
ELSE IF G-Runtime && G-UI && G-Shell && G-Session∈{Pass,Partial}
         && G-Agent∈{Pass,Partial} && G-Map → Go Phase 1
         (document every Partial in V1 PRD)
ELSE → retest ≤1 week; do not open apps/harmony-desktop
```

---

## Offline evidence completed 2026-08-04

### O1 — Local `pebble-runtime` gateway smoke (macOS arm64)

**Purpose:** Prove control-plane routes used by a future OH shell (not OH ABI).

```text
go build -o /tmp/pebble-runtime-probe ./cmd/pebble-runtime   # OK, ~22MB
pebble-runtime -listen 127.0.0.1:18777 -token phase0probe -data-dir /tmp/...

GET /v1/status + Bearer     → 200
  capabilities include projects, worktrees, sessions, agents, files, ...
GET /v1/status without token → 401 {"error":"missing or invalid bearer token"}
GET /v1/host/terminal-capabilities + Bearer → 200
  {"wslAvailable":false,...,"hostPlatform":"darwin"}
```

**Anchor:** `runtime/go/cmd/pebble-runtime/main.go`, `runtimehttp/server.go`.

### O2 — PTY implementation inventory

| Item | Evidence |
|------|----------|
| Unix PTY | `runtimecore/process_session_unix.go` → `creack/pty.StartWithSize` |
| Windows PTY | `process_session_windows.go` → `go-pty` |
| go.mod | `github.com/creack/pty v1.1.24`, `github.com/aymanbagabas/go-pty` |
| Build deps (darwin) | `go list -deps` includes `creack/pty`, `golang.org/x/sys/unix` |
| Minimal probe (macOS) | `./tools/spikes/harmony-phase0/run-pty-probe.sh` → **PASS pty echo** (2026-08-04) |

OH must exercise **unix** path (`//go:build !windows`). macOS Pass ≠ OH Pass.

### O3 — Platform-split Go files (complete list under `runtime/go`)

```
cmd/pebble-relay-worker/file_replace_{unix,windows}.go
cmd/pebble-runtime/parent_monitor_{unix,windows}.go
internal/remotehooks/atomic_replace_{unix,windows}.go
internal/runtimeauth/credential_replace_{unix,windows}.go
internal/runtimeauth/credential_{unix,windows}.go
internal/runtimecore/ephemeral_vm_process_{unix,windows}.go
internal/runtimecore/foreground_process_{unix,windows}.go
internal/runtimecore/local_terminal_artifact_identity_{unix,windows}.go
internal/runtimecore/notebook_process_{unix,windows}.go
internal/runtimecore/process_session_signal_{unix,windows}.go
internal/runtimecore/process_session_{unix,windows}.go
internal/runtimecore/provider_text_generation_process_{unix,windows}.go
internal/runtimecore/remote_workspace_replace_{unix,windows}.go
internal/runtimecore/ssh_control_socket_{unix,windows}.go  # unix build tag: unix
internal/runtimecore/store_file_{unix,windows}.go
internal/runtimecore/workspace_ports_{unix,windows}.go
internal/runtimecore/worktree_hook_process_{unix,windows}.go
```

Syscall-heavy behaviors: `Setpgid`, process-group `SIGKILL`, `syscall.Kill` for liveness,
PTY ioctl resize, private SSH control sockets.

### O4 — Startup tool probes

`detectUnavailableTools()` looks for `git`, `zig`, `pnpm` via lookpath. OH images without
these mark tools unavailable; product must degrade (no worktree git ops without git).

### O5 — Renderer / web path (G-Map Pass)

| Finding | Result |
|---------|--------|
| Production `@tauri-apps` usage | Essentially **browser guest** only |
| Web preload + web runtime session | Primary Harmony UI path |
| Local `pty.spawn` on web | Intentionally unavailable — use runtime sessions |
| SSH CRUD on web | **Gap** for hybrid V1 — see F-matrix |
| F2 exclusions documented | browser / CU / emulator / speech / CLI reg |

### O6 — Host platform labeling

`nodePlatform` default returns raw `GOOS`. Renderer assumes `win32|darwin|linux`.
**V1 policy:** emit `linux` (or map unknown → linux) + capability flags (F3).

### O7 — OH container evidence (dockerharmony, 2026-08-04)

**Environment**

- Image: `hqzing/dockerharmony:latest` (OpenHarmony mini rootfs, arm64, musl + toybox)
- Host kernel: Docker Desktop Linuxkit (not OH kernel) — **userland proxy only**
- Binaries: `CGO_ENABLED=0 GOOS=linux GOARCH=arm64` `pebble-runtime` + `probe-pty-minimal`
- Reproduce: `./tools/spikes/harmony-phase0/run-ohos-container-probe.sh`
- DevEco limits: `tools/spikes/harmony-phase0/out/ohos-probe/DEVENV-LIMITS.md`

| Probe | Result | Detail |
|-------|--------|--------|
| A1.2 binary runs | **Pass** | `/tmp/pebble-runtime -h` |
| A1.3 / A3 listen | **Pass** | `listening on http://127.0.0.1:17777` |
| A3.1 status + bearer | **Pass** | 200 with token; 401 without |
| A3.3 capabilities | **Pass** | `hostPlatform: "linux"`; after git install `unavailableTools: ["zig","pnpm"]` |
| B1 creack/pty | **Pass** | `PASS pty echo` |
| B2 session create | **Pass** | `POST /v1/sessions` → `status:running`, pid set |
| B2 input/output | **Pass** | `echo p0-session-ok` → tail shows marker + `# ` prompt |
| B2 resize | **Pass** | cols/rows updated to 100×30 |
| C1.1 FS | **Pass** | write/read/delete under `/tmp` |
| C1.2–C1.3 git | **Partial** | `git version 2.49.1`; commit works but logs `BUG: run-command.c … Signal 6` |
| C1.4 worktree | **Fail/Partial** | `git worktree add` unstable (SIGABRT / incomplete checkout) |
| D1 spawn | **Pass** | shell background child |
| D1.4 agent CLI | **Fail** | no node/claude/codex/opencode |
| D2 ssh | **Fail** | no OpenSSH client in image |
| E / G HAP UI | **Skip** | DevEco download 403 |

**Project create:** `POST /v1/projects` with `{"path","name"}` returned `proj_*` for `/tmp/ws/repo`.

### O8 — Real DevEco 2in1 PC emulator (2026-08-10)

**Install path**

- DevEco: `/Applications/DevEco-Studio.app` (Emulator 6.1.1.350, hdc 3.2.0d)
- Host network: **Beijing Unicom** DIRECT works; env `HTTP_PROXY`/`HTTPS_PROXY` to overseas nodes
  made Huawei return *“available only in the Chinese mainland”* even from Beijing
- Fix: `env -i` / unset proxies for Emulator install (Clash rule should **DIRECT** Huawei CDN)
- Image: `HarmonyOS 6.1.1(24)` **2in1** → `~/.Huawei/Emulator/images/system-image/HarmonyOS-6.1.1/pc_all_arm/`
- AVD: `PebblePC` (MateBook Pro profile, arm64, 8GB RAM)
- Device: `hdc list targets` → `127.0.0.1:5555` Connected

**On-device probes (hdc shell uid=2000)**

| Probe | Result | Detail |
|-------|--------|--------|
| `uname` | Pass | Linux localhost 5.10.210 aarch64 Toybox |
| push `pebble-runtime` | Pass | `/data/local/tmp/pebble/` |
| `pebble-runtime -h` | Pass | flags print |
| bind `127.0.0.1:PORT` / `0.0.0.0:PORT` | **Fail** | `bind: permission denied` (log line “listening” is printed *before* bind in main) |
| open `/dev/ptmx` | **Fail** | `Permission denied` |
| `hdc smode` root | **Fail** | *Cannot set root run mode in undebuggable version* |
| `hdc target mount` | **Fail** | needs debug mode |

**Implication:** Phase 0 G-Runtime/G-Session are **not** green on the public PC emulator via shell.  
They remain green only under dockerharmony (or a debuggable/root image). Shipping path is HAP sandbox with proper capabilities.

**Operator notes**

```bash
# Download image (no overseas proxy):
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
EMU=/Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator
"$EMU" -install -deviceType 2in1 -osVersion "HarmonyOS 6.1.1(24)" -force
"$EMU" -create PebblePC -deviceType 2in1 -osVersion "HarmonyOS 6.1.1(24)" -memory 8 -storage 16
"$EMU" -start PebblePC
HDC=/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc
"$HDC" list targets
```

Clash: use **DIRECT** for `*.huawei.com` / emulator CDN; do not force JP/US nodes for image install.

---

## Device spike checklist (A–H)

Run via `tools/spikes/harmony-phase0` on device. Record Pass/Partial/Fail + log paths.

### Spike A — Go runtime on OH

| ID | Probe | Pass |
|----|-------|------|
| A1.1 | Legal Go/OH target or runnable ABI | Binary executes |
| A1.2 | Hello stdout | exit 0 |
| A1.3 | `net/http` listen loopback | reachable |
| A1.4 | sqlite write under data-dir | ok |
| A1.5 | Full `pebble-runtime` link | ok |
| A2.1 | Shell spawns runtime | stderr listening line |
| A2.2 | token + parent pid env | auth + exit-with-parent |
| A2.3 | SIGTERM shutdown | clean |
| A2.4 | Background survival 5–10m | still serves /v1/status |
| A2.5 | data-dir persistence | restart ok |
| A3.1–A3.5 | status, bearer, caps, projects, events | same as O1 semantics |

**A-Pass:** A1.3 + A2.1 + A3.1 + A3.2

### Spike B — PTY

| ID | Probe | Pass |
|----|-------|------|
| B1.1 | openpty / pts + shell | echo works |
| B1.2 | creack/pty StartWithSize | ok |
| B1.3 | resize | ok |
| B2.1–B2.4 | runtime session stream I/O kill | ok |
| B3.1 | pipe-only commands | Partial |
| B3.2 | UI local + SSH exec | Partial hybrid |
| B3.3 | remote-only | fallback product |

**B-Pass:** B1.1 + B2.1–B2.3

### Spike C — FS / git / worktree

| ID | Pass |
|----|------|
| C1.1 user-visible FS R/W | |
| C1.2 `git --version` | |
| C1.3 git init/commit | |
| C1.4 git worktree add | |
| C1.5–C1.6 via /v1 projects/worktrees | |
| C1.7 unavailable tools list sensible | |

### Spike D — Spawn / agents

| ID | Pass |
|----|------|
| D1.1–D1.3 exec + long life + PATH | |
| D1.4–D1.5 any agent CLI | Local-Pass |
| D2.1–D2.2 ssh client + remote session | Hybrid-Pass |

### Spike E — UI Web component

| ID | Pass |
|----|------|
| E1.1 static HTML | |
| E1.2 product-core web bundle | |
| E1.3 `isPebbleTauriShell()===false` | |
| E1.4 loopback /v1/status from Web | |
| E1.5–E1.7 keyboard / clipboard / scroll | |
| E1.8 no tauri-browser module | |

### Spike F — already offline Complete

See F-matrix. Re-run audit commands after major merges.

### Spike G — HAP shell

| ID | Pass |
|----|------|
| G1.1 empty Ability installs | |
| G1.2 embed binary + web assets | |
| G1.3 permissions for net/files | |
| G1.4 hilog runtime + web | |
| G1.5 resign/reinstall | |

### Spike H — security

| ID | Pass |
|----|------|
| H1.1 listen loopback only | |
| H1.2 Web → 127.0.0.1 allowed | |
| H1.3 token not in logs | |
| H1.4 LAN shared-control policy if used | |

---

## Recommended V1 scope sentence (pre-device)

> Harmony PC ships an ArkTS shell that runs local `pebble-runtime` and the
> product-core **web** UI against loopback `/v1/*`. Interactive work uses
> runtime-owned sessions. If PTY or agent CLIs are missing on-device, V1
> documents **SSH/remote execution host** as first-class. Browser guest,
> computer-use, emulators, and Tauri-only features are out of scope.

Revise after device Partial/Fail results.

---

## Phase 1 entry criteria (checklist)

- [ ] Device Gate table filled  
- [ ] Go/No-Go decision recorded below  
- [ ] Partial list copied into PRD  
- [ ] F1.2 SSH web gap scheduled or hybrid UX designed  
- [ ] No commits under `apps/desktop/src-tauri` for Harmony  

### Decision log

| Date | Decision | Author |
|------|----------|--------|
| 2026-08-04 | Offline Phase 0 package landed | agent |
| 2026-08-04 | DevEco/HAP PC emulator **not installable** here (403 / login). Installed **dockerharmony** OH userland proxy instead. | agent |
| 2026-08-04 | G-Runtime + G-Session **Pass on OH userland proxy**. G-Agent local Fail. G-Workspace Partial. G-UI/G-Shell still open → **defer `apps/harmony-desktop`**. | agent |
| 2026-08-10 | Fixed image download: use **DIRECT** (Beijing IP); overseas Clash nodes blocked Huawei. Installed 2in1 image + AVD `PebblePC`; hdc online. | agent |
| 2026-08-10 | Public emulator undebuggable: shell cannot bind TCP or open PTY. Product path = **HAP-packaged runtime**, not hdc shell. | agent |
| | | |

---

## Reproduce offline smoke

```bash
./tools/spikes/harmony-phase0/run-offline-audit.sh
```
