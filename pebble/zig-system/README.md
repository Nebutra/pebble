# pebble/zig-system

## Status: not linked into any build

Nothing in the Go runtime, Rust/Tauri host, or desktop build scripts
references this directory. `build.zig` exists and the modules under `src/`
(`pty.zig`, `process.zig`, `signal.zig`, `status.zig`, `abi.zig`) compile in
isolation, but no CI job, `Cargo.toml`, `go.mod`/build tag, or packaging
script invokes `zig build` or links the resulting artifact. Treat this as a
design sketch, not shipped code.

## Decision record

PTY ownership went to the Go runtime (`creack/pty`) instead of this Zig
layer, for time-to-value: Go already owns terminal session lifecycle, and a
pure-Go PTY with winsize/resize support shipped faster than standing up a
Zig build, C ABI, and cross-language FFI boundary for the same primitives.

Zig is reserved for two narrower gaps that do genuinely need a systems layer,
once/if the Go+Rust path proves insufficient:

- **Binary terminal output channel** — a lower-overhead framing/transport for
  terminal output than the current JSON/HTTP runtime contract, if PTY output
  throughput becomes a measured bottleneck.
- **Low-level platform accessibility primitives** — OS-level accessibility
  tree/action APIs for the computer-use provider layer, where Rust's
  ecosystem coverage is thin and a small C-ABI surface is easier to bind than
  a full native crate per platform.

Until one of those becomes a measured, real requirement, this directory stays
unlinked. Do not add build/link references to it without updating this file
and `ROADMAP.md`'s migration gates table to match.

## Intended targets (future, not current)

- macOS, Linux, Windows, called from Rust (Tauri host) or Go via a C ABI
  (`include/pebble_system.h`).
- No renderer/JS-facing surface; this is a native-only layer.
