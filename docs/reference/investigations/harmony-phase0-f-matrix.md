# Harmony Phase 0 — F-matrix (renderer & preload)

**Date:** 2026-08-04  
**Method:** Static audit of `packages/product-core` (no Harmony device).  
**Goal:** Know which P0 product surfaces already work via **web/runtime HTTP**, which
need work for local Harmony desktop, and which are **explicitly out of V1**.

Legend:

| Symbol | Meaning |
|--------|---------|
| ✅ | Usable via web preload + runtime gateway (Harmony can reuse) |
| 🟡 | Partial / needs extension for **local** OH shell (not pure remote pair) |
| ❌ | Web stub / Tauri-only; must rewrite, bridge, or cut |
| 🚫 | Out of V1 by product decision |

---

## F1.1 — P0 product capabilities

| Capability | Web/HTTP path today | Tauri-only pieces | Harmony V1 | Action |
|------------|---------------------|-------------------|------------|--------|
| Pair / connect to runtime | `web-pairing.ts`, `web-runtime-client.ts`, `web-preload-api` environment APIs | Tauri launches runtime process | 🟡 | ArkTS spawn local runtime; point web client at `127.0.0.1` (loopback pair or fixed local env) |
| Runtime status / health | `/v1/status`, events | `runtime_process.rs` start/stop | ✅ / 🟡 | HTTP ✅; process lifecycle = shell |
| Project list / metadata | `/v1/projects`, web preload project routes | Some local folder pickers | ✅ | File picker may need ArkTS |
| Worktree list / create / remove | `/v1/worktrees*`, `web-runtime-session`, repo clients | — | ✅ | Needs git on host (Spike C) |
| Terminal session (via runtime) | `createWebRuntimeSessionTerminal`, terminal stream RPCs | Local `pty.*` IPC on desktop | ✅ | Depends on Go PTY (Spike B), **not** web `pty.spawn` |
| Local renderer PTY IPC | — | Desktop preload `pty.spawn` | 🚫 | Web correctly rejects; do not implement on OH |
| Interactive agent in terminal | Runtime session + agent launch routes | Agent account native bridges | 🟡 | Needs CLI on PATH or SSH host |
| SSH target CRUD | **Stubbed** in web preload (`SSH target management is unavailable`) | Tauri + `/v1/ssh-targets*` | ❌→🟡 | **Phase 1 gap:** wire web preload to existing Go SSH HTTP routes |
| SSH port forwards | Stubbed in web | Tauri + Go | 🚫/P1 | After SSH CRUD |
| File tree / read / write | `/v1/files/*`, `runtime-file-client.ts` | Tauri shell special-cases local+connectionId | ✅ | Confirm `isTauriDesktopShell()` false path |
| Git status / base refs | Go git routes + `runtime-git-client.ts` | — | ✅ | Needs `git` binary |
| Settings persistence | Web local fallback + runtime settings routes | Native settings store commands | 🟡 | Prefer runtime settings when paired local |
| Keybindings | Web keybinding platforms `darwin\|linux\|win32` only | — | 🟡 | Treat OH as `linux` for V1 |
| Notifications | `/v1/notifications/dispatch` partial | OS notification commands | 🟡 | Optional V1 |
| Clipboard | Browser clipboard APIs in web preload | Native clipboard commands | 🟡 | Probe Web component; ArkTS fallback |
| Native chat | Web implements subset via runtime RPC | Desktop IPC transcripts | 🟡 | Use runtime path |
| Dictation / speech | Gated on `isPebbleTauriShell()` | Speech commands | 🚫 | Out of V1 |
| Browser guest WebView | Remote browser tabs partial; **child webview** is Tauri `invoke` | `tauri-browser-page-webview.ts`, `browser_*` commands | 🚫 | Out of V1 |
| Computer-use | Web unsupported | `computer_use_*` | 🚫 | Out of V1 |
| Mobile emulators | Web rejects | `emulator_*` | 🚫 | Out of V1 |
| Codex/MiniMax native auth storage | Web rejects / server-side | AccountsPane Tauri branches | 🟡 | Use server/runtime auth only |
| CLI registration | Unsupported on web | `cli_registration*` | 🚫 | Out of V1 |
| Updater | N/A | Tauri updater | 🟡 | AppGallery / manual V1 |
| Grab mode / screenshots / cookie import | Web rejects | Desktop | 🚫 | Out of V1 |
| Commit/PR text generation on web | Some “unavailable in web client” | Provider routes exist in Go | 🟡 | Prefer Go provider routes when local runtime |

---

## F1.2 — Tauri hard-dependency inventory (renderer)

### Direct `@tauri-apps` / `invoke` (production)

| File | Dependency | V1 |
|------|------------|-----|
| `components/browser-pane/tauri-browser-page-webview.ts` | `@tauri-apps/api` core/event/webview/dpi, many `invoke('browser_*')` | 🚫 Do not load on Harmony |
| Tests under `browser-pane/*tauri*` | mocks only | N/A |

No other production renderer files import `@tauri-apps/*` (audit 2026-08-04). Browser guest is the main hard Tauri UI dependency.

### Shell detection / flags

| File | Behavior | Harmony requirement |
|------|----------|---------------------|
| `lib/tauri-shell-detection.ts` | `__PEBBLE_TAURI_SHELL__`, `__TAURI_*`, `tauri:` protocol | Must remain **false** |
| `lib/web-client-location.ts` | Uses `__PEBBLE_TAURI_SHELL__` | false |
| `runtime/runtime-file-client.ts` | `isTauriDesktopShell()` via flag only | false → correct remote/local HTTP behavior |
| `terminal-pane/terminal-native-file-drop.ts` | Native drop only if Tauri | Skip native drop |
| `hooks/useSettingsNavigationMetadata.ts` | Tauri-specific settings entries | Hide desktop-only |
| `components/settings/Settings.tsx` | Legacy compatibility when not Tauri | OK |
| `components/settings/AccountsPane.tsx` | Tauri-only account UI branches | Prefer non-Tauri |
| `components/dictation/speech-feature-availability.ts` | Requires Tauri shell | Feature off |
| `App.tsx` | Reads shell flag | Ensure not set |

### Web preload explicit gaps (must not surprise V1)

From `web-preload-api.ts` (non-exhaustive):

| API area | Error / behavior | Phase 0 note |
|----------|------------------|--------------|
| `pty.spawn` | Reject local PTY | Sessions via runtime only |
| `ssh.*` target/port-forward mutations | Reject / empty | **Blocker for hybrid UX** unless wired to `/v1/ssh-targets` |
| SSH clone / create project on SSH host | Reject | Same |
| Remote file download helpers | Reject | Optional |
| Commit message / PR detail generation | Unavailable messages | Use Go routes later |
| Computer-use / emulator / grab / cookies | Unsupported | 🚫 |
| CLI registration | unsupported | 🚫 |
| MiniMax cookie store | Desktop only | 🚫/server |

---

## F2 — Explicit V1 exclusions (signed scope cut)

Do **not** schedule for Harmony V1:

1. Tauri child browser WebView and all `browser_*` native commands  
2. Computer-use desktop providers  
3. iOS Simulator / Android emulator bridges  
4. Local speech / dictation engines  
5. CLI path registration on OH  
6. Full settings parity with macOS (menu bar, tray, traffic lights)  
7. Electron-era compatibility settings  

---

## F3 — `hostPlatform` / Node platform assumptions

| Location | Assumption | OH risk |
|----------|------------|---------|
| `runtime/go/internal/hostprobe/capabilities.go` `nodePlatform` | default returns raw `GOOS` | Exotic GOOS string breaks TS `NodeJS.Platform` |
| `renderer/src/lib/renderer-app-platform.ts` | UA → win32/darwin/linux | WebView UA on OH may look like Linux/Android — verify |
| `web-preload-api.ts` keybinding platforms | only darwin/linux/win32 | Map OH → linux |
| `App.tsx` `shortcutPlatform` | isMac / isWindows / else linux | Likely linux — OK |
| Relay (`packages/product-core/relay/*`) | Node process.platform | Only if relay runs **on** OH (optional) |

**V1 recommendation:**

1. Force `hostPlatform: "linux"` from OH runtime probe until a dedicated value is designed.  
2. Extend capabilities JSON later (`ptyAvailable`, `agentCli[]`, `executionMode`) instead of proliferating OS names.  
3. Never key product logic on string `"harmony"` without caps.

---

## F4 — Preferred end-to-end path for Harmony V1

```text
ArkTS shell
  → start pebble-runtime (-listen 127.0.0.1:PORT -token … -data-dir …)
  → load product-core web bundle (no __PEBBLE_TAURI_SHELL__)
  → web client treats local runtime as paired environment (loopback)
  → createWebRuntimeSessionTerminal → Go PTY or SSH-backed session
  → UI never calls window.api.pty.spawn
```

Parity reference: remote web client + `pebble serve`, documented operationally in
`docs/reference/headless-linux-server.md` and terminal persistence investigation.

---

## Audit commands (reproducible)

```bash
# Tauri surface in renderer (expect browser-pane + detection only)
rg -n "from '@tauri-apps|invoke\(|isPebbleTauriShell|isTauriDesktopShell|__PEBBLE_TAURI" \
  packages/product-core/renderer/src --glob '!**/*.{test,spec}.*'

# Web session / preload
rg -n "createWebRuntimeSession|Local PTYs are unavailable|SSH target management" \
  packages/product-core/renderer/src/web packages/product-core/renderer/src/runtime

# Platform labels
rg -n "hostPlatform|nodePlatform|getRendererAppPlatform" packages/product-core runtime/go \
  --glob '!**/*test*'
```

Re-run after large renderer refactors; attach new hits to this matrix.
