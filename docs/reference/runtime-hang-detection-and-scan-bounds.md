# Runtime Hang Detection and Scan Bounds

How Pebble keeps a long-lived machine responsive, and where that deliberately
differs from the Electron predecessor this runtime replaced. Ported
semantically for [#84]; no Electron code was carried over.

## Hang detection

**Before.** A worker thread pinged the Electron main process on an interval; a
late acknowledgement meant the main process was wedged, because that process
owned both the window and the app's state.

**Pebble.** The Tauri host owns almost nothing: runtime state lives in the Go
runtime, and every request that reads or mutates it queues behind one
`sync.RWMutex`. That lock — not a UI thread — is the serialization point a user
experiences as a frozen app, so it is what the watchdog watches.

`runtime/go/internal/runtimecore/hang_watchdog.go`:

- A goroutine started by `NewManager` probes the state lock every **250 ms**
  with `TryRLock`. A read lock that can be taken means no writer is holding or
  waiting, which is the only state in which queued requests make progress.
- An episode is declared once the lock has been continuously unavailable for
  **5 s** — 20 consecutive failed probes — so a burst of ordinary short writes
  cannot be mistaken for a hang.
- One episode is recorded per stretch, carrying the *worst* stall observed, not
  the stall at the moment the probe finally succeeded. History is capped at 20
  episodes.
- On recovery the runtime emits `runtime.hang`. Announcing it any earlier is not
  possible from inside the runtime: `Manager.emit` takes the same lock, so a
  report during the hang would queue behind the thing being reported.
  `Manager.HangEpisodes()` uses only the watchdog's own mutex and therefore
  stays readable while the state lock is stuck.

**Known difference.** Electron could report a hang while it was still
happening, from a thread outside the wedged one. Pebble reports on recovery. A
runtime that never recovers produces no event — the watchdog is a diagnostic for
stalls the runtime survives, not a liveness beacon for one it does not. External
liveness is still the client's job: the HTTP request that never returns is the
signal.

**Not ported.** No worker thread, no main-thread sampling in the Tauri host, and
no automatic recovery action. The watchdog observes and reports; it never
force-releases a lock or restarts anything.

## Workspace and usage scan bounds

**Before.** Transcript scanning grew with the machine's whole history — every
transcript found, every turn parsed, all retained.

**Pebble.** The scan is bounded at three independent points, so no single
oversized input can spend the whole budget
(`runtime/go/internal/runtimecore/usage_scan_bounds.go`):

| Bound | Value | Effect |
| --- | --- | --- |
| `usageScanMaxFiles` | 4000 | Discovery keeps only the newest transcripts by mtime; older ones are not opened. |
| `usageScanMaxFileTurns` | 20000 | One transcript stops being read past this many turns, which also caps its dedupe index. |
| `usageScanMaxTurns` | 150000 | The retained result stops growing here, while the collector keeps draining workers so they cannot deadlock. |

Discovery stays bounded *while walking*, not only at the end: candidates are
compacted back to the newest `usageScanMaxFiles` whenever the buffer reaches
twice that, so a directory with millions of entries never materialises in
memory.

When any bound is reached the scan says so in `result.Issues` (`scan limited to
the N most recent transcripts`, `scan retained the first N turns`) rather than
silently returning a truncated answer.

**Concurrency.** File reads run on **4 worker goroutines** with a bounded
results channel, so the scan is bounded in memory rather than strictly serial.
Serial execution was not required to hold the memory ceiling, and four workers
keep a cold scan off the UI's critical path.

`TestScanClaudeUsageStaysBoundedOnAnOversizedHistory` is the stress proof: 400
transcripts × 500 turns, asserting the retained turn count, the reported issue,
and a heap ceiling.

[#84]: https://github.com/Nebutra/pebble/issues/84
