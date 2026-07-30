# Prevent renderer bootstrap logging crash

## Goal

Prevent renderer bootstrap diagnostics from terminating the desktop process and
ensure the Tauri renderer reaches its shell-specific bootstrap entry.

## Background

The macOS crash report for `1.4.124-rc.8` shows a Rust panic in
`std::io::stdio::__eprint`, called by `renderer_bootstrap_log.rs:17`. The command
currently uses `eprintln!`, whose failed stderr write can panic and abort the
application while handling a renderer diagnostic.

After the logging crash was fixed, live startup diagnostics exposed the original
white-screen cause: `apps/desktop/index.html` requested
`/packages/product-core/renderer/src/main.tsx`, which Vite resolved below the
desktop package root and could not load. The page therefore completed with an
empty React root. `apps/desktop/src/main.tsx` is the Tauri-specific bootstrap
that installs shell diagnostics and dynamically loads `renderer-entry.ts`.

## Requirements

- Preserve the existing renderer bootstrap log format and bounded, sanitized
  renderer input.
- Treat diagnostic output as best effort: an stderr write failure must not
  propagate or panic.
- Keep the behavior platform-neutral and independent of local-only execution.
- Limit the change to the renderer bootstrap logging command and focused tests.
- Load the Tauri-specific renderer bootstrap from the desktop HTML entry.
- Make the repository-layout check reject a return to the unreachable shared
  renderer path.

## Acceptance Criteria

- [x] Successful writes retain the `[renderer-bootstrap:<stage>] <message>`
  format.
- [x] A writer that returns an I/O error does not cause the logging path to
  return an error or panic.
- [x] The focused Rust tests pass.
- [x] Vite serves the Tauri bootstrap without a missing-module error and React
  mounts content under `#root`.
- [x] The repository-layout verification accepts the corrected desktop entry.

## Out Of Scope

- Replacing every other diagnostic `eprintln!` call in the desktop application.
- Changing renderer diagnostic collection, transport, or persistence.
