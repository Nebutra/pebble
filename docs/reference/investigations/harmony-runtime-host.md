# HarmonyOS: Go `pebble-runtime` host — decision record

**Status:** Decided  
**Date:** 2026-08-10  
**Related:** [`harmony-desktop.md`](../harmony-desktop.md), `apps/harmony-desktop/`

## Decision (hard, correct)

| Do | Don't |
|----|--------|
| Keep **one** control plane: Go `pebble-runtime` + `packages/contracts` `/v1/*` | Grow the C++ HAP stub into a second business runtime |
| Treat `apps/harmony-desktop` as **shell only** (ArkTS + product-core web) | Call the C++ probe “runtime healthy” as if sessions work |
| **V1 product path:** hybrid — real Go on a paired host (dev Mac/Linux or LAN), web pairs via existing E2EE offer | Pretend local complete desktop ships while Go cannot exec under normal HAP |
| **Mid-term local complete:** privileged **runtime host** process (system/enterprise APL, or OS-approved child) that owns the Go binary | Invent a Harmony-only RPC that diverges from desktop/serve |

### Why this is correct

Phase 0 measurement is conclusive for **normal APL HAP**:

| Approach | Result |
|----------|--------|
| `filesDir` / packaged ET_EXEC / `memfd` + `fexecve` | SELinux **EACCES** (W^X) |
| Go `c-shared` + `dlopen` | musl **initial-exec TLS** failure |
| Go `c-archive` cross-link from darwin | Empty archive (not viable today) |
| In-process C++ bind | Works for a **shell probe** only |

Forking the control plane into C++ would ship a lie: UI that looks connected but cannot PTY, SSH, worktrees, or agents. Hybrid + real Go is honest and reuses the same web stack. Local complete desktop then becomes a **hosting privilege problem**, not a UI problem.

### Non-goals reaffirmed

- No Electron / Tauri-on-Harmony.  
- No port of `apps/desktop/src-tauri` commands into ArkTS.  
- SSH hybrid agents remain first-class when local CLIs are missing.

## Architecture

```text
┌─────────────────────────────────────────┐
│  HAP nebutra.pebble.desktop (shell)     │
│  · ArkTS lifecycle / permissions        │
│  · product-core web (WebView)           │
│  · optional C++ shell probe :18777      │
│    (packaging smoke only — not brain)   │
└──────────────────┬──────────────────────┘
                   │  existing web pairing
                   │  (E2EE WS /v1/shared-control)
                   ▼
┌─────────────────────────────────────────┐
│  Real pebble-runtime (Go)               │
│  · V1: host machine / LAN (hybrid)      │
│  · Later: privileged local host package │
└─────────────────────────────────────────┘
```

## Ports (avoid lying on 17777)

| Port | Owner | Purpose |
|------|--------|---------|
| **18777** | HAP C++ shell probe | Local packaging smoke (`/v1/status` stub only) |
| **17778** | Harmony hybrid Go `pebble-runtime` | Production contracts on a Mac that also runs `Pebble.app` |
| **17777** | Desktop `Pebble.app` runtime | Do not share with Harmony — pairing/token/session collide |

Product-core web **must** pair to the Go runtime endpoint, never to the shell probe.

## V1 workflow (hybrid)

```bash
# Host Mac/Linux next to emulator:
./apps/harmony-desktop/scripts/run-hybrid-runtime.sh
# → builds Go, listens :17778, hdc rport device→host, mints pairing,
# → seeds demo project/worktree/running shell session (seed-hybrid-demo.sh)

./apps/harmony-desktop/scripts/stage-hybrid-pairing.sh
# rebuild/reinstall HAP so rawfile/hybrid/pairing.code is injected as ?pairing=
```

Pairing endpoint default: `ws://127.0.0.1:17778/v1/shared-control` via **`hdc rport`**.  
LAN device: `HARMONY_PAIRING_HOST=… HARMONY_SKIP_RPORT=1`.

Verified on PebblePC emulator (2026-08-13):

- App: `hybrid_connected` + pairing injected; host Go on **:17778**
- `hdc rport tcp:17778 tcp:17778` → ESTABLISHED shared-control from device
- `terminal.multiplex` live: PTY resized 80×24 → 102×30 when the zsh tab opened
- `status.get` now advertises `runtimeProtocolVersion=3` (web no longer treats the host as protocol 0)
- Control plane: seeded `harmony-demo` / `demo-repo` / running zsh

## Mid-term local complete (privileged host)

Track as a separate milestone — not a stub expansion:

1. **Privileged companion** (system/enterprise APL or SA) that may exec or load Go.  
2. Or **NativeChildProcess** entry `.so` once Go/musl TLS packaging is solved (prefer Linux CI OHOS NDK `c-archive` spike before rewriting language).  
3. Same listen/contracts as desktop; HAP only supervises and opens the web shell.

## Phase plan

| Phase | Deliverable |
|-------|-------------|
| **0** | HAP shell + web stage + shell probe (honest labeling) |
| **1 (now)** | Hybrid script + pairing inject; web talks to **real** Go |
| **2** | Privileged host spike (CI + real device) |
| **3** | Local complete V1: projects/worktrees + one session path on device |

## Evidence anchors

- `execv` / `fexecve` errno 13 under app UID  
- musl: `initial-exec TLS resolves to dynamic definition` on Go c-shared  
- Shell probe bind works; shell UID cannot bind loopback for Go smoke
