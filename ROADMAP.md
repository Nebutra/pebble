# Pebble Roadmap

## Tauri desktop mainline migration

Pebble's desktop target is Tauri as the primary app shell, backed by the Go
runtime, Rust host boundary, and Zig low-level system modules. Electron is a
parity reference only while migration is in progress; new desktop-shell work
should move toward Tauri commands, Rust host adapters, and Go runtime contracts
instead of deepening Electron main-process ownership.

Mainline rules:

- `pebble/desktop-tauri/` is the desktop-shell migration track and must load the
  same React workbench renderer, not a reduced or mock UI.
- Electron is a parity reference only; it is not the destination desktop shell.
- The Tauri shell must keep pixel-level parity with the Electron reference
  while Electron remains available for comparison.
- Existing renderer features should be backed by runtime contracts before the
  corresponding Electron IPC path is retired.
- `node config/scripts/verify-tauri-mainline.mjs` must pass when changing the
  Tauri shell, renderer entry, or migration contract.

Migration gates:

| Area | Target owner | Current status | Exit criterion |
| --- | --- | --- | --- |
| Window shell, sizing, and app identity | Tauri/Rust | Tauri config uses Pebble identity and Electron fallback window dimensions. | Tauri window controls, titlebar behavior, traffic-light placement, menus, and shortcuts match Electron screenshots on macOS, Windows, and Linux. |
| Renderer parity | React in Tauri | Tauri renderer imports the canonical `@/App` and root renderer stylesheet. | Desktop Tauri screenshots match Electron reference views for landing, workspace, terminal, browser, source control, checks, settings, update dialogs, and crash surfaces. |
| File/project pickers | Tauri commands + Rust host | Native folder picker commands exist for local project add flows. | Project add/remove, folder workspaces, SSH project setup, and trusted hook prompts run without Electron IPC. |
| Runtime RPC and PTY/session control | Go runtime + Zig PTY/system | Tauri can start/probe the local Go runtime and call bounded runtime resources. | Terminal creation, split panes, agent launch, session tail/input/stop, and SSH relay paths are driven through runtime contracts. |
| Source control and reviews | Go runtime + provider adapters | Go owns source-control projections and diffs for local/relay-fed workspaces. | GitHub, GitLab, and provider-neutral review surfaces work in Tauri with no Electron-only IPC assumptions. |
| Browser/webview/automation | Rust/Tauri browser adapter + Go state | Runtime queues browser actions and Tauri exposes provider polling/completion. | Browser tabs, screenshots, downloads, permissions, design mode, and automation run through native adapters with mobile/CLI parity. |
| Computer use and emulator | Rust/Zig adapters + Go queues | Native/browser/emulator action queues are exposed through Tauri commands. | Accessibility trees, screenshots, safe actions, and iOS/Android device control work through provider queues. |
| Updates, release, diagnostics | Tauri updater/release service + Go release plans | Go release plans and Nebutra routes are tracked; Electron updater remains reference. | Tauri signing, notarization, updater manifests, crash reports, release notes, and diagnostics endpoints are release-blocking checks. |

## Nebutra web route backfill

After the Pebble rename, the app and public assets should treat
`https://www.nebutra.com/pebble` as the product web root. The nebutra.com
project needs to serve these real routes so the app can stop depending on the
old product domain.

Path migration rule:

- Product pages: `https://onpebble.dev/<path>` -> `https://www.nebutra.com/pebble/<path>`
- Product root: `https://onpebble.dev` -> `https://www.nebutra.com/pebble`
- Docs pages: `https://onpebble.dev/docs/<path>` -> `https://www.nebutra.com/pebble/docs/<path>`

Required Nebutra routes:

| Legacy route | Nebutra route | Surface | Status |
| --- | --- | --- | --- |
| `https://onpebble.dev` | `https://www.nebutra.com/pebble` | Product landing page | App/README/Homebrew links migrated; nebutra.com must serve it. |
| `https://onpebble.dev/download` | `https://www.nebutra.com/pebble/download` | Download page | App/README links migrated; nebutra.com must serve it. |
| `https://onpebble.dev/docs/*` | `https://www.nebutra.com/pebble/docs/*` | Mintlify docs | App/README/mobile links migrated; route list below. |
| `https://onpebble.dev/whats-new/changelog.json` | `https://www.nebutra.com/pebble/whats-new/changelog.json` | Update changelog feed | App now reads the Nebutra route; nebutra.com must serve static JSON. |
| `https://onpebble.dev/whats-new/nudge.json` | `https://www.nebutra.com/pebble/whats-new/nudge.json` | Update nudge feed | App now reads the Nebutra route; nebutra.com must serve static JSON. |
| `https://onpebble.dev/media/*` | `https://www.nebutra.com/pebble/media/*` | Changelog media assets | Feed media should use this static bucket/object-prefix route. |
| `https://www.onpebble.dev/diagnostics/token` | `https://www.nebutra.com/pebble/diagnostics/token` | Crash diagnostics token | Release workflows now compile official builds against the Nebutra route; nebutra.com must serve or proxy it. |
| `https://www.onpebble.dev/v1/feedback` | `https://www.nebutra.com/pebble/v1/feedback` | Feedback submission API | App now posts only to the Nebutra route; dynamic POST route or proxy required. |
| `https://api.onpebble.dev/v1/feedback` | `https://www.nebutra.com/pebble/v1/feedback` | Feedback fallback API | Legacy fallback removed from app; keep this listed only for external redirect/proxy cleanup. |

## Mintlify docs route backfill

Canonical docs base:

- `https://www.nebutra.com/pebble/docs`

Routes currently referenced by the app, README, localized READMEs, telemetry surfaces, mobile settings, and feature-wall entry points:

- `/pebble/docs`
- `/pebble/docs/mobile`
- `/pebble/docs/model/worktrees`
- `/pebble/docs/terminal`
- `/pebble/docs/browser/design-mode`
- `/pebble/docs/review/linear`
- `/pebble/docs/ssh`
- `/pebble/docs/review/annotate-ai-diff`
- `/pebble/docs/editing/file-explorer`
- `/pebble/docs/cli/overview`
- `/pebble/docs/model/quick-open`
- `/pebble/docs/agents/usage-tracking`
- `/pebble/docs/editing/markdown`
- `/pebble/docs/editing/viewers`
- `/pebble/docs/cli/computer-use`
- `/pebble/docs/notifications`
- `/pebble/docs/telemetry`
- `/pebble/docs/privacy`
- `/pebble/docs/agents/supported`
- `/pebble/docs/tasks`

## Product web/static feed gaps

These are not normal docs pages. The app now points at these Nebutra routes, so the nebutra.com project must serve them before public release:

- `https://www.nebutra.com/pebble/whats-new/changelog.json`
- `https://www.nebutra.com/pebble/whats-new/nudge.json`
- Changelog media URLs should move to `https://www.nebutra.com/pebble/media/*`
- `https://www.nebutra.com/pebble/diagnostics/token`

This feedback endpoint still needs a Nebutra-owned dynamic POST handler or proxy:

- `https://www.nebutra.com/pebble/v1/feedback`

The in-app changelog and update card currently link release notes to GitHub Releases:

- `https://github.com/nebutra/pebble/releases`
- `https://github.com/nebutra/pebble/releases/tag/<tag>`

## Remaining rename/productization gaps

These are outside the product-site/docs route migration above:

- Nebutra.com must implement or proxy these runtime routes now referenced by the app:
  - `GET /pebble/whats-new/changelog.json`
  - `GET /pebble/whats-new/nudge.json`
  - `GET /pebble/media/*`
  - `GET /pebble/diagnostics/token`
  - `POST /pebble/v1/feedback`
- Brand assets now use a Pebble candidate mark instead of the legacy whale glyph. Final brand QA should still settle the source-of-truth vector/bitmap set and regenerate any marketing-only collateral.
- Historical/internal design docs have been migrated from legacy product
  wording, CLI examples, local paths, and reference links to Pebble naming.
