# Pebble

This directory is the new implementation track for Pebble.
The target stack is:

- Go: runtime services, concurrency, orchestration, provider integrations, relay server.
- Rust: Tauri host, native security boundary, typed IPC bridge, performance-sensitive adapters.
- Zig: low-level process, PTY, signal, file-watching, and platform control surfaces.
- Tauri: desktop shell and app lifecycle.
- React Native: mobile companion app.

The Pebble goal is product parity with the existing Electron/TypeScript Pebble,
not a reduced MVP. Work is split by stable subsystem boundaries so each area can
be replaced without translating the old `src/main` composition root one file at
a time.

## Product Surface

The full target includes:

- Desktop workbench: tabs, splits, terminal, browser, editor/file preview, emulator, settings.
- Runtime RPC: local authenticated control plane, streaming events, mobile allowlist.
- CLI: project/worktree/terminal/browser/orchestration control commands.
- Repo and worktree management: local, SSH, GitHub, GitLab, Bitbucket, Azure DevOps.
- Agent orchestration: Codex, Claude, OpenCode, Gemini, Cursor, Copilot, Devin, Droid, and command agents.
- Terminal and PTY: local and remote processes, foreground process detection, shell integration.
- Browser automation: controlled browser tabs, screenshots, downloads, permissions, profiles, CDP-equivalent adapter.
- Computer use: accessibility tree, screenshots, safe actions, platform providers.
- Emulator integration: iOS and Android device control streams.
- Mobile relay: React Native app pairing, E2EE websocket transport,
  terminal/browser/source-control/file/orchestration/automation/external-task/release/provider/computer/emulator/settings views.
- Automations and scheduled work.
- External task systems: Linear, Jira, Git provider review surfaces.
- Release system: macOS notarization, Windows signing, Linux package naming, updater manifests.

## Pebble Layout

- `architecture/`: subsystem boundaries, migration map, language ownership.
- `contracts/`: versioned runtime API and event contracts.
- `go-runtime/`: Go runtime daemon and CLI control plane.
- `desktop-tauri/`: Tauri shell and desktop UI bridge.
- `mobile-rn/`: React Native mobile app.
- `rust-host/`: Rust native host probes and shared host-side code outside Tauri.
- `zig-system/`: Zig low-level process and platform modules.

## Build Expectations

The Go and Rust portions are intentionally dependency-light first so they can be
verified in restricted environments. Tauri, React Native, and Zig require their
own toolchains and package installs before they can be built.

Current verification status:

- Go runtime and `pebble-control` tests pass with `go test ./...`.
- Rust host tests pass with `cargo test`.
- Tauri Rust host checks pass with `cargo check`.
- React Native protocol/app types pass with `npm run typecheck`.
- React Native native crypto contracts pass with `npm run verify:native-crypto`.
- Zig system tests pass with Zig 0.16 via `zig build test`.
- The Zig public C ABI header passes `cc -fsyntax-only`.
- `pnpm` is not available in this environment, so npm is used for JavaScript verification.

## Implemented Runtime Loop

The Go runtime now exposes a runnable local control plane with:

- Optional bearer-token protection for runtime HTTP APIs. `PEBBLE_RUNTIME_TOKEN` is the preferred
  path for CLI and relay workers so tokens stay out of process arguments; `--token` remains
  available for short interactive runs, and the desktop host token input uses the same Authorization
  header.
- Persisted projects, worktrees, agent profiles/runs, orchestration tasks/messages/dispatches,
  browser tab state, computer action queues, emulator devices/sessions, and mobile pairings.
- Project metadata update/delete and worktree metadata delete semantics; destructive filesystem
  removal remains outside these metadata-only endpoints.
- SSH projects require an explicit `hostId` so remote workspaces do not collapse onto ambiguous
  local-looking paths.
- Browser tab create/update/close state transitions plus tab-scoped command queuing for native
  browser providers, with mobile projection replacement for removed tabs and download progress.
- Browser profile, permission, and download state APIs are persisted in Go and surfaced through
  the runtime gateway for desktop, CLI, mobile projection, and native browser providers.
- Browser download records can queue explicit `browser.download` provider actions through HTTP and
  `pebble-control browser download-start`, keeping binary transfer execution inside native adapters.
  CLI download updates can also report filename, path, byte progress, and error metadata.
- Browser tab screenshot references are recorded on tab updates and flow into mobile browser
  projections while binary capture remains owned by the native browser adapter; `pebble-control
  browser update` can report screenshot URI/capture metadata for provider debugging.
- Process-backed sessions with input, tailing, stop, and event streaming.
- Agent run supervision through profile-defined commands and prompt injection modes, including
  profile update/delete and run stop endpoints.
- Orchestration dispatch completion/failure updates that propagate terminal worker outcome to the
  parent task state.
- Automations with persisted definitions, manual and interval schedule triggers, auditable run
  records, and actions that create tasks, send messages, dispatch tasks, start agents, or queue
  computer actions through the same runtime control plane.
- External task and review records for Linear, Jira, and git-provider review surfaces are persisted
  through a provider-neutral API, with optional links to internal orchestration tasks.
- Source-control status projections and file-scoped git diff retrieval for local workspaces, with
  remote workspaces requiring relay transport instead of local path assumptions; CLI projection
  updates can carry provider-neutral changed-file lists for relay-fed SSH views.
- File tree, read, and write APIs for local project/worktree file preview and editor surfaces, with
  path traversal and symlink escape protection plus relay-required errors for SSH workspaces.
- Remote relay workers can upsert file tree and content snapshots for SSH workspaces, letting the
  same file preview endpoints serve cached remote state once worker data arrives; relay file reads
  also resolve symlinks and reject paths that escape the remote workspace root.
- Mobile file projections, read, and write commands reuse the runtime file service so phone-side
  editing keeps the same workspace-relative path validation as desktop and CLI surfaces.
- Mobile runtime-object projections expose orchestration tasks/messages/dispatches, automations,
  external tasks, release plan readiness, browser download progress, native provider readiness,
  computer action queues, and emulator device/session state without leaking full internal service
  payloads into the React Native client.
- Mobile settings projections expose setting keys and keybinding metadata while leaving setting
  values in the runtime settings API.
- `pebble-relay-worker` provides a deployable Go command that scans a remote workspace and posts file
  tree/content snapshots and git status projections back to the runtime.
- Remote source-control workers can upsert projection snapshots for SSH workspaces through the
  runtime gateway, replacing unknown remote status once relay data arrives.
- Emulator device registration, provider status updates, attach/detach semantics, and
  session-scoped command queuing with JSON payloads for iOS/Android adapters.
- Mobile relay pairing codes, persisted paired devices, WebSocket `pair.start`,
  pairing-secret-authenticated `client.hello`, `crypto.handshake`, `projection.subscribe`,
  X25519 + HKDF + AES-256-GCM encrypted envelopes,
  terminal input forwarding, browser command queuing, and projection snapshots for terminal,
  agents, structured source-control dirty state, browser tabs/downloads, files, orchestration
  tasks, automations, external tasks, releases, providers, computer actions, emulator
  devices/sessions, and settings; HTTP/CLI projection reads can request specific projection kinds
  and terminal output limits.
- React Native relay client support for optional encrypted reconnects through a local native
  `PebbleRelayCrypto` Expo module with a WebCrypto fallback and an in-app crypto self-test for
  local X25519, HKDF, and AES-GCM diagnostics.
- Pairing secrets are stored through Expo SecureStore when platform support is available. When
  SecureStore is unavailable, reconnect secrets are not written to AsyncStorage and the pairing is
  treated as session-only after reload.
- Native action polling and completion bridges from Rust/Tauri into Go runtime computer-action
  queues, including a browser-specific provider bridge that atomically claims only `browser.*`
  actions and writes completion through the shared action contract; CLI queueing can include JSON
  payloads, and the Tauri desktop shell now exposes native/browser/emulator action polling and
  completion controls against those commands.
- The Tauri desktop host can probe runtime status and request fixed or custom GET resource paths
  for contract/resource inspection during migration.
- The Tauri desktop shell can start, stop, and inspect a local `pebble-runtime` process, deriving
  the listen address from the configured runtime URL while keeping bearer-token handling consistent
  with the Go runtime and Rust host bridge; development builds fall back to
  `go run ./cmd/pebble-runtime` from `go-runtime` when a packaged `pebble-runtime` binary is not on
  `PATH`.
- The Tauri desktop host can read a bounded batch from the `/v1/events` SSE stream through the Rust
  host bridge, using the same runtime URL and bearer-token input as status/resource probes, with
  optional topic filtering in the desktop event panel.
- `pebble-control events` streams `/v1/events` from the CLI with bearer-token support, server-side
  topic filtering, bounded `--limit` reads, and raw SSE frame output for transport debugging.
- Native provider registration lets browser, computer, and emulator adapters report validated,
  TTL-bound readiness states and capabilities so subsystem status is no longer hard-coded.
- Release/update planning records required artifacts, signing/notarization/update-manifest checks,
  a generated `/v1/releases/{id}/manifest` payload, and a publish gate so CI can keep releases
  draft-blocked until every platform requirement passes. Release artifacts are constrained to
  generic, Linux, macOS, and Windows platforms with non-negative sizes and valid SHA-256 digests
  when a digest is provided, and the default check set includes iOS/Android mobile packaged builds
  plus native relay crypto validation.
- Settings and keybindings are persisted through a runtime API, including project/workspace scopes
  and platform-neutral accelerators such as `CmdOrCtrl`.

The native `PebbleRelayCrypto` bridge now exists in the Pebble track with an app-level self-test and
release-gated iOS/Android packaged-build checks.
