# Research: Existing background-service / goroutine-lifecycle patterns in the Go runtime

- **Query**: What goroutine-lifecycle pattern (context cancellation, errgroup, logging) should a new advertiser imitate?
- **Scope**: internal
- **Date**: 2026-07-28

## Findings

### There is no errgroup, no supervisor, no service registry

- `golang.org/x/sync` is an **indirect** dependency only (`runtime/go/go.mod:39`); `errgroup` is imported nowhere in first-party code.
- No `log` or `log/slog` import anywhere in `runtime/go` (grep for `"log"` / `log/slog` hits only git-subcommand strings and test helpers).
- Long-lived work is started with a bare `go f(ctx, …)` from `main`, or with a per-object `context.WithCancel` stored next to the object.

### Pattern A — process-lifetime ticker loop (closest analogue for an advertiser)

`runtime/go/internal/runtimecore/automation.go:447-465`:

```go
func (m *Manager) RunAutomationScheduler(ctx context.Context, interval time.Duration) {
	if interval <= 0 { interval = time.Minute }
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := m.EvaluateScheduledAutomations(ctx, time.Now().UTC()); err != nil {
				// Run-level failures are already recorded on the run; this
				// surfaces storage-level evaluation errors without crashing.
				m.emit("automation.scheduler.error", map[string]interface{}{"error": err.Error()})
			}
		}
	}
}
```

Traits worth copying: exported method on `*Manager`, takes `ctx` + tuning parameter, defaults an invalid parameter instead of erroring, `defer ticker.Stop()`, `ctx.Done()` as the only exit, errors reported as a runtime **event** rather than a log line or a crash.

Started at `runtime/go/cmd/pebble-runtime/main.go:53-54`, with a one-line "why" comment above the `go` statement:

```go
// Due automations must fire without a desktop shell polling /evaluate.
go manager.RunAutomationScheduler(ctx, time.Minute)
```

### Pattern B — ref-counted, cancellable background stream keyed by id

`runtime/go/internal/runtimehttp/remote_workspace_watch.go:21-70`:

- Registry struct holds `mu sync.Mutex` + `watches map[string]*remoteWorkspaceWatch`; constructed once in `NewServerWithOptions` (`server.go:61`).
- `retain(targetID)` (`:25-55`): bumps `refs` if already running; otherwise `ctx, cancel := context.WithCancel(context.Background())` (`:32`), stores the `cancel` on the watch struct, starts `go func(){…}()`, and the goroutine **removes itself from the map on exit** (`:49-53`).
- Errors are suppressed when `ctx.Err() != nil` (deliberate cancel) and otherwise published as events: `r.manager.PublishRemoteWorkspaceEvent("workspace.watch-status", …)` (`:46-48`).
- `release(targetID)` (`:57+`) decrements and cancels at zero.

### Pattern C — cancel handle stored in a manager map

`runtime/go/internal/runtimecore/ephemeral_vm_lifecycle.go:93-98` and `manager.go:101-104`:

```go
ctx, cancel := context.WithCancel(parent)
defer cancel()
if input.ProvisionID != "" {
	m.registerEphemeralVMCancel(input.ProvisionID, cancel)
	defer m.unregisterEphemeralVMCancel(input.ProvisionID)
}
```

with `ephemeralVMMu sync.Mutex` + `ephemeralVMCancels map[string]context.CancelFunc` on the Manager, and `CancelEphemeralVMProvision` (`:120-132`) doing lookup-delete-cancel under the mutex. The same shape is used for `textGenerationCancels` (`manager.go:103-104`) and `nestedScanCancels` (`runtimehttp/server.go:58`, `:67-69`).

### Pattern D — listener + graceful shutdown (the HTTP server itself)

`runtime/go/internal/runtimehttp/server.go:2064-2099`:

```go
listener, err := net.Listen("tcp", listen)
…
server := &http.Server{Handler: NewServerWithOptions(manager, options)}
errCh := make(chan error, 1)
go func() { errCh <- server.Serve(listener) }()
select {
case <-ctx.Done():
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	return ctx.Err()
case err := <-errCh:
	if errors.Is(err, http.ErrServerClosed) { return nil }
	return err
}
```

Traits: the blocking call owns the process lifetime; shutdown is bounded by `shutdownTimeout = 5 * time.Second` (`runtime/go/internal/runtimehttp/timeout.go:5`); a fresh `context.Background()` is used for the shutdown deadline because the parent ctx is already cancelled.

`Manager.Shutdown` follows the same bounded-teardown discipline — `manager.go:4227-4246`, with `shutdownExitHandlingLimit = 5 * time.Second` (`manager.go:31`) and a "why" comment explaining that a stuck OS wait must not hang exit.

### Pattern E — cancel-on-reader-exit for hijacked connections

`runtime/go/internal/runtimehttp/legacy_shared_control.go:186-196` — worth noting because the comment states a rule that generalizes:

```go
go func() {
	readLegacySharedControlRequests(conn, sharedKey, incoming, errorsChannel)
	// Why: hijacked WebSockets do not inherit HTTP disconnect cancellation;
	// cancel relay work as soon as the connection reader exits.
	cancel()
}()
```

### Pattern F — parent-process watchdog that cancels root ctx

`runtime/go/cmd/pebble-runtime/main.go:65-77` — `monitorDesktopParent` starts a goroutine that calls `stop()` (the `signal.NotifyContext` cancel) when the desktop parent PID disappears. Shows that root-ctx cancellation has more than one trigger: SIGINT/SIGTERM (`main.go:49`) and parent death (`main.go:51`).

### Logging conventions

| Channel | Use | Citation |
|---|---|---|
| `fmt.Fprintf/Fprintln(os.Stderr, …)` | **`main` packages only** — fatal startup errors and the one startup banner | `cmd/pebble-runtime/main.go:33`, `:39`, `:44`, `:56`, `:60`; `cmd/pebble-relay-worker/main.go:30` |
| `m.emit(topic, payload)` | Internal packages — every notable background event | `manager.go:4394-4406`; scheduler error at `automation.go:461` |
| `PublishRemoteWorkspaceEvent` | Same idea from the HTTP layer | `remote_workspace_watch.go:42`, `:47` |
| stdout | Reserved for CLI machine output (`--json`, `--recipe-json`); the control process explicitly sets the runtime child's `Stdout = io.Discard` | `cmd/pebble-control/serve.go:80-81` |

`emit` builds a `RuntimeEvent{Version: "pebble.events.v1", ID: newID("evt"), Timestamp, Topic, Payload}` and fans it out to subscribers (`manager.go:4394-4406`); topics are dotted lowercase, e.g. `automation.scheduler.error`, `workspace.watch-status`.

**Important constraint for a mDNS advertiser in the control process**: `cmd/pebble-control/serve.go` writes machine-readable JSON to `output` (stdout) at `:133` and `:139`, and the recipe-JSON consumer parses the **first stdout line** (`packages/product-core/cli/runtime/launch.ts:147-158`). Anything an advertiser prints must go to stderr, not stdout.

### Tests

Background-service tests in this repo use `t.TempDir()` + a real `NewManager` and drive the loop deterministically rather than sleeping (`runtime/go/internal/runtimecore/legacy_shared_control_test.go:18-48` for state persistence; `automation` tests call `EvaluateScheduledAutomations` directly rather than starting the ticker).

## Caveats / Not Found

- No existing component opens a UDP socket or joins a multicast group anywhere in `runtime/go`; there is no precedent for non-TCP networking in the runtime.
- No structured logger, no log levels, no debug-flag convention to hook into.
