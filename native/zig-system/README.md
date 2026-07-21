# native/zig-system

## Status: linked into the Tauri desktop host

`apps/desktop/src-tauri/build.rs` builds this library for the active
Cargo target and links it statically into the Tauri host. Universal macOS
builds combine arm64 and x86_64 archives with `lipo`. The Rust host validates
ABI version 1 during startup, and release CI runs the Zig tests before bundling.

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

Go still owns terminal session lifecycle. Zig currently supplies the linked
systems ABI and is the staged boundary for measured PTY transport or platform
accessibility hotspots; moving ownership requires benchmarks and parity tests.

## Intended targets (future, not current)

- macOS, Linux, Windows, called from Rust (Tauri host) or Go via a C ABI
  (`include/pebble_system.h`).
- No renderer/JS-facing surface; this is a native-only layer.
