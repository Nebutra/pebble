# Moving the local runtime in-process

Status: proposed. This decides a direction and the seam it is executed through;
it does not authorize a rewrite.

## What forced the question

A day of debugging desktop symptoms produced this list. Every entry was traced
to a cause, and the causes turned out to be the same cause.

| Symptom | Traced to |
| --- | --- |
| Terminal takes ~4s to appear | The runtime is a child process, spawned only once the renderer asks (#150) |
| `Runtime transport failed: http-error` with no cause | An HTTP body that four call sites discarded (#146) |
| A taken port silently produced a dead runtime | Spawning onto a bound address and reporting success anyway (#146) |
| Typing round trip 4.3ms median, 41.9ms worst | Renderer → IPC → HTTP → runtime → PTY, and back |
| Keystrokes dropped under load | A bounded queue between the renderer and the runtime (#151) |
| The bearer token lives in renderer `localStorage` | The renderer must authenticate to its own runtime |

None of these is caused by Go. Every one is caused by **the local runtime being
a separate process reached over HTTP**. That distinction decides the whole
question: rewriting the runtime in Rust *as a sidecar* would preserve all six.

## The decision

**Target: one Rust runtime codebase, compiled two ways.**

- **A library**, linked into the desktop host. Local sessions call it directly —
  no spawn, no port, no HTTP, no bearer token, no serialization on the keystroke
  path.
- **A binary**, for SSH targets, remote hosts, and mobile relays, where a
  separate process on the far side is genuinely what is wanted.

Only Rust can be both, because the desktop host is already Rust. Go can only
ever be the binary — that is its ceiling here, and it is the reason to move.

## What this is not

**Not a big-bang rewrite.** The Go runtime is 64,471 lines of production code
and 32,099 lines of tests across 11 packages. `runtimecore` alone is 34,468
lines. A rewrite that must land whole before anything ships would be wrong on
its own terms: the CLI, mobile, and relay all speak the runtime's HTTP contract
today, and they must keep working the entire time.

**Not a claim that Go was a mistake.** The Go runtime is what made a shared
control plane across desktop, CLI, mobile, and SSH possible in the first place,
and it stays the runtime on every remote host under this plan.

## The seam

The HTTP + shared-control contract is the seam, and it does not move.

A slice is migrated when the desktop calls the Rust library directly for it
while every other consumer still reaches the same behaviour over the same
contract. Nothing observes which side answered. That property is what makes
this reversible slice by slice, and it is the thing to protect if a phase gets
hard.

## Where to start

**Sessions and PTY.** It is the hot path, it is what a user feels, and it is
where five of the six symptoms above converge. `native/zig-system` already has
`pty.zig`, `process.zig`, and `signal.zig` — currently only three ABI symbols
are consumed by Rust, so the platform layer is written and idle rather than
absent.

The Go side to displace is `process_session.go` with its `_unix` and `_windows`
halves plus the session portion of `runtimecore`, not all 34k lines of it.

## What must stay true throughout

- The HTTP contract keeps answering identically for every non-desktop consumer.
- A remote runtime is still a standalone binary; nothing about SSH or mobile
  regresses.
- Windows, macOS, and Linux stay supported at every step — the PTY layer is the
  most platform-divergent code in the product, which is precisely why it is
  worth doing carefully and first.

## Open questions, not yet answered

- Whether the Rust library owns state (the runtime's on-disk store) or defers to
  the Go runtime during the transition. Two writers to one store is the obvious
  way to corrupt it.
- How a desktop that talks to a *remote* runtime shares code with one that talks
  to its in-process library, without growing a second transport abstraction.
- Whether `pebble-control` and `pebble-relay-worker` follow, or stay in Go.
