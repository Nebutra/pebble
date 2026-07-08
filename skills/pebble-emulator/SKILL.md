---
name: pebble-emulator
description: >
  Control a mobile (iOS) emulator / simulator stream from inside Pebble using the `pebble` CLI.
  Use for taps, gestures, typing, hardware buttons, camera injection, permissions, accessibility tree, and more — all while seeing the live view in Pebble's emulator pane.
  Prefer this over raw `npx serve-sim` or direct simctl when running agents inside Pebble (the pebble surface handles device scoping, helper lifecycle, and worktree context).
  Complements the pebble-cli skill for terminals, worktrees, and the built-in browser.
license: Apache-2.0
---

# Pebble Emulator (serve-sim powered)

Drive an Apple Simulator (iOS / iPad / Watch) **from within Pebble** using `pebble emulator ...` commands (or `pebble emulator exec` for raw power). This wraps the excellent [serve-sim](https://github.com/EvanBacon/serve-sim) open-source tool so agents get a consistent Pebble-native CLI surface, automatic helper management, and seamless integration with Pebble's live emulator pane (the visual "preview" surface).

The underlying serve-sim helper captures the real simulator framebuffer (via private SimulatorKit / IOSurface for low-latency 60fps H.264 or MJPEG) and exposes a WebSocket control channel. Pebble's bridge owns the helper processes and per-worktree "active emulator" state so unqualified commands "just work" on whatever device/pane is current for the worktree.

## When to use

- The user/agent wants to **tap, swipe, drag, pinch, or press hardware buttons** on a running iOS simulator while seeing the live result in Pebble.
- You want **camera injection** (placeholder, webcam, or file loop) for testing camera flows.
- You need to **grant/revoke app permissions** (camera, photos, notifications, location, etc.) or read the **accessibility tree**.
- Rotate the device, simulate memory warnings, toggle CoreAnimation debug overlays, etc.
- You are inside an Pebble worktree/terminal and want the emulator to be **workspace-scoped** (like browser tabs) with explicit targeting when needed.
- The agent should use Pebble's preview pane instead of external Simulator.app or raw serve-sim URLs.

**When NOT to use**
- Android emulators → use the `pebble-emulator-android` skill (same `pebble emulator` namespace, cross-platform via adb/emulator).
- Building or installing the app itself → use `xcodebuild`, `xcrun simctl install`, `expo run:ios`, etc. (launch the app, then use `pebble emulator` to drive it).
- In-app debugging (state, network, views) → use the app's own tools or the browser pane if it's a webview.
- Remote/SSH worktrees for emulator control (currently out of scope / unsupported; simulator hardware is local to a Mac).

## Prerequisites (enforced / surfaced by Pebble)

- macOS host (with Xcode Command Line Tools: `xcrun --version`).
- A booted simulator (`xcrun simctl list devices booted` or let Pebble/attach help boot one).
- Node available (for the serve-sim bits; Pebble bundles the CLI surface).
- macOS 14+ recommended for full camera injection features.

Pebble will give clear errors if these are missing (e.g. "emulator commands require macOS + Xcode tools").

An active emulator "session" for the worktree is required for most commands. Use `pebble emulator list` / `attach` or open the emulator pane in the UI.

## Mental model

```
┌────────────────────┐
│ Pebble worktree      │
│  - active emulator │◄── pebble emulator tap / type / ...
│  - live pane (UI)  │
└─────────┬──────────┘
          │ (registers active stream)
          ▼
┌────────────────────┐   WS / control   ┌─────────────────┐  framebuffer  ┌──────────────┐
│ Pebble EmulatorBridge│ ───────────────► │ serve-sim-bin   │ ────────────► │ iOS Simulator│
│ (main process)     │ (or exec serve-sim) (per-device)   │               └──────────────┘
└────────────────────┘                  └─────────────────┘
          ▲
          │ (state + lifecycle)
┌────────────────────┐
│ pebble CLI (agents)  │  e.g. pebble emulator tap 0.5 0.7
│ pebble-emulator skill│
└────────────────────┘
```

Pebble owns:
- Starting/stopping the serve-sim helper (via --detach or direct).
- Per-worktree "active" emulator (like active browser tab).
- Explicit targeting with `--worktree`, `--device`, `--emulator <id>`.
- The visual live pane (renderer uses serve-sim-client for the stream).

Agents use the `pebble` / `pebble-dev` binary (on PATH in Pebble terminals; `pebble-dev` for dev builds) and never have to manage PIDs, state files in /tmp, or raw WS URLs themselves.

**For `pnpm dev` testing:** run `pnpm build:cli` first (rebuilds the CLI + ensures the `pebble-dev` shim points at *this* worktree). Then inside the dev app use `pebble-dev emulator ...` (or the direct `./config/scripts/pebble-dev.mjs emulator ...` from the repo root). The orchestration preambles and dev launchers automatically select the dev command name so the CLI reaches your in-memory EmulatorBridge / runtime. Plain `pebble` reaches a packaged install instead.

## Common operations

Use `--json` for agent-friendly output. Commands are workspace-scoped by default (current worktree's active emulator).

| Goal                        | Command                                      | Notes |
|-----------------------------|----------------------------------------------|-------|
| List available / running   | `pebble emulator list [--worktree <sel>]`     | Shows Pebble-managed + raw serve-sim streams. Use output for explicit --device/--emulator. |
| Attach / make active       | `pebble emulator attach "iPhone 16 Pro" [--worktree <sel>] [--focus]` | Starts helper if needed (serve-sim --detach). Sets active for unqualified commands. --focus optional (does not auto-steal UI focus by default). |
| Single tap                 | `pebble emulator tap <x> <y> [--device <id>]` | Normalized 0..1 coords. **Preferred over gesture for simple taps.** |
| Multi-step gesture         | `pebble emulator gesture '<json>'`            | See gestures reference (begin/move/end). Use tap for singles. |
| Type text                  | `pebble emulator type "text" [--device <id>]` | US ASCII only. Supports stdin/file via exec if needed. |
| Hardware button            | `pebble emulator button home [--device <id>]` | home, swipe_home, app_switcher, lock, siri, side_button. |
| Rotate device              | `pebble emulator rotate landscape_left`       | Remembers orientation for subsequent gestures. |
| Camera injection           | `pebble emulator camera com.acme.App --webcam` | Or --file, placeholder. Hot-swap with switch. May (re)launch app. |
| Permissions                | `pebble emulator permissions grant camera com.acme.App` | grant/revoke/reset/list. See full subcommand help. |
| Accessibility tree         | `pebble emulator ax [--device <id>]`          | Or via exec for raw endpoint. |
| Raw / advanced             | `pebble emulator exec --command "tap 0.5 0.7"` | Or "ca-debug blended on", "memory-warning", full serve-sim subcommands (no "serve-sim" prefix needed in the command string). Bridge injects active device context. |
| Stop                       | `pebble emulator kill [--device <id>]`        | Or let pane close / Pebble quit clean up. |

Most support `--worktree <selector>` and explicit `--device <udid|name>` or `--emulator <id>` (from list) for targeting.

## Critical gotchas (teach agents)

- **Prefer `tap` over `gesture` for single taps** (same as raw serve-sim). Separate gesture begin/end can be interpreted as long-press due to WS overhead. The pebble wrapper uses the reliable quick sequence.
- All coords normalized 0..1 (top-left origin). Never pixels.
- One "active" emulator per worktree for unqualified commands (like active browser tab). Discover ids with `list`, use explicit flags for multi-device or cross-worktree.
- Type = US keyboard only. Unsupported chars error clearly.
- Camera injection often requires (re)launching the target app bundle.
- The visual pane and CLI share the same underlying stream/helper. Closing the pane can stop the stream (configurable).
- Stale helpers / state are cleaned by Pebble on quit, but agents should `kill` when done.
- Private APIs under the hood (SimulatorKit etc.) — version sensitive (Xcode updates can affect).

## Targeting devices & worktrees

- Default: current worktree's active emulator (resolved from shell cwd or Pebble context).
- Explicit worktree: `--worktree id:abc123` or `--worktree active`.
- Explicit device: `--device "iPhone 16 Pro"` or `--device <udid>` (after `list`).
- Pebble-generated emulator id (for stability, like browserPageId): use `--emulator <id>` returned by list (recommended for scripts that persist ids).

`--worktree all` only for listing.

## Integration with the live pane (UI)

- Opening the emulator pane in Pebble (or `attach`) makes that stream the "active" one for the worktree → CLI commands target it automatically.
- The pane shows the real 60fps stream (device frame, touch forwarding, toolbar).
- Agents can drive via CLI while the human watches/interacts in the pane.
- No automatic focus steal on CLI attach (use `--focus` if you really want the UI to switch; matches browser behavior).
- Multiple devices: list shows them; pane can grid; CLI uses active or explicit selector.

## Cleanup

```sh
pebble emulator kill --device "iPhone 16 Pro"
# or let Pebble quit / close the pane
```

Orphans are cleaned by Pebble (like agent-browser sessions).

## Examples (agent-friendly)

```sh
pebble status --json
pebble emulator list --json
pebble emulator attach "iPhone 16 Pro" --json
pebble emulator tap 0.5 0.8 --json
pebble emulator type "user@example.com" --json
pebble emulator button home --json
pebble emulator camera com.acme.MyApp --file /tmp/test.mp4 --json
pebble emulator permissions grant camera com.acme.MyApp --json
pebble emulator ax --json
pebble emulator exec --command "ca-debug blended on" --json
```

After changes, re-snapshot / wait as needed (analogous to browser snapshot-interact loop).

## Next action

Confirm `pebble status --json` and `pebble emulator list --json`, then drive the emulator while the live view is visible in Pebble.

See also: pebble-cli skill (terminals, worktrees, built-in browser), computer-use for desktop outside the simulator.

This skill is the Pebble-native replacement for raw serve-sim when you want the visual + control integrated in the IDE.
