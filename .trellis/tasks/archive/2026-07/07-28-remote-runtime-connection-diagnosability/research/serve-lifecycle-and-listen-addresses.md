# Research: `pebble-control serve` lifecycle, bind vs. advertised address, advertiser hook points

- **Query**: Full lifecycle of `pebble-control serve`; where it binds, what it listens on vs. advertises; where a background advertiser goroutine could start/stop cleanly.
- **Scope**: internal
- **Date**: 2026-07-28

## Findings

### Two processes are involved

`pebble serve` is a **two-process** arrangement. There is no Node or Rust server; both hops end in Go.

| Hop | File | Notes |
|---|---|---|
| `pebble serve` (Node CLI) | `packages/product-core/cli/handlers/core.ts:88`, `packages/product-core/cli/runtime/launch.ts:39-83` | Spawns `PEBBLE_APP_EXECUTABLE` (the Tauri binary) with `--serve …` legacy flags. |
| Tauri packaged CLI | `apps/desktop/src-tauri/src/packaged_cli.rs:94-110`, `:158-171` | `requested_command` maps `--serve` → `serve` (`:123`), `translate_legacy_serve_args` rewrites `--serve-pairing-address` → `--pairing-address`, then `run_control(...)` execs the sibling `pebble-control` binary (`:194-205`). |
| Control process | `runtime/go/cmd/pebble-control/serve.go:58` (`runServe`) | Parses flags, picks port, spawns runtime child, does pairing, prints. |
| Runtime process | `runtime/go/cmd/pebble-runtime/main.go:18` | The actual HTTP/WebSocket server. |

The desktop app's own (non-`serve`) runtime spawn takes the same runtime binary with `--listen`: `apps/desktop/src-tauri/src/commands/runtime_process.rs:300-308` (default `127.0.0.1:17777` in the test plans at `:540`, `:547`, `:553`).

### Control process lifecycle, step by step (`runtime/go/cmd/pebble-control/serve.go`)

| Line | What happens |
|---|---|
| `:58` | `runServe(args, token, output, errorOutput)` entry. |
| `:59-69` | `parseServeOptions`; `--port` default `17777` (`:154`, `:157`); port `0` → ephemeral port reserved via a throwaway loopback listener (`reserveLoopbackPort`, `:251-258`). |
| **`:70`** | **`listen := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))`** — the child runtime is always told to bind **loopback only**. |
| `:71` | `runtimeHTTP := "http://" + listen` — the control process's own client base URL. |
| `:72-73` | `ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)`; `defer stop()`. This ctx is the process-wide lifetime handle. |
| `:75-78` | `runtimeCommand(ctx, listen)` → `exec.CommandContext(ctx, <pebble-runtime>, "--listen", listen)` (`:195-210`). Falls back to `go run ./cmd/pebble-runtime` from the repo (`:207`) when no sibling binary is found. |
| `:82-86` | Bearer token passed via `PEBBLE_RUNTIME_TOKEN` env (never argv). |
| `:87-91` | `command.Start()`, then `go func() { wait <- command.Wait() }()` — the only long-lived goroutine today. |
| `:92-97` | `waitForRuntime` polls `GET /v1/status` every 50 ms up to 15 s (`:260-290`). Readiness gate; also observes early child exit. |
| `:100-126` | Pairing block, skipped when `--no-pairing`. `requestPairing` POSTs `/v1/shared-control/pairing` (`:292-321`) and receives `{deviceToken, publicKeyB64}`. `sharedControlEndpoint(options.pairingAddress, port)` (`:111`, `:323-355`) builds the advertised URL. `encodePairingOffer` (`:117-120`, `:357-363`) emits `pebble://pair?code=<base64url(JSON)>`. |
| `:127-149` | Output: `--recipe-json` (one JSON line, `:127-137`), `--json` (`:138-143`), or human text (`:144-149`). |
| **`:150`** | `return <-wait` — blocks until the runtime child exits. This is the single normal exit point. |

### Bind address vs. advertised address (the core mismatch)

- **Bound**: `127.0.0.1:<port>` — `serve.go:70`. Never `0.0.0.0`, never a LAN IP. The runtime child's `--listen` value is exactly this string.
- **Advertised**: whatever `--pairing-address` says, defaulting to `127.0.0.1` — `sharedControlEndpoint` at `serve.go:323-355`:
  - empty → `127.0.0.1` (`:326`)
  - contains `://` → parsed as URL; `http`→`ws`, `https`→`wss`; empty path replaced with `/v1/shared-control` (`:328-345`)
  - bare host/IP → `ws://host:port/v1/shared-control`, with IPv6 bracketing (`:347-354`)
  - `sharedControlPath = "/v1/shared-control"` (`:26`)
- The advertised value is copied verbatim into `pairingOffer.Endpoint` (`:43-49`, `:117-120`) and the client stores it as-is (`packages/product-core/shared/pairing.ts:6-16`, `:93-97`).
- Git history shows the loopback bind was introduced with the file in `4b6a2d2c1 refactor: finish Tauri migration closure` (single commit touching that line).
- Consequence to keep in mind: `docs/reference/headless-linux-server.md:45-52` and `:81` tell users to pass a Tailscale/LAN address to `--pairing-address`, but the listener itself is loopback-bound at `serve.go:70`. Any advertised LAN address only works if something else (tunnel, sandbox port publishing, reverse proxy) fronts the loopback port. There is no code path today that binds a non-loopback address.

### Runtime process lifecycle (`runtime/go/cmd/pebble-runtime/main.go`)

| Line | What happens |
|---|---|
| `:19-24` | Early `PEBBLE_SSH_ASKPASS_MODE` short-circuit (binary doubles as an askpass helper). |
| `:25-28` | Flags: `--listen` (default `127.0.0.1:17777`), `--data-dir` (default `runtimeauth.DefaultDataDir()`), `--token` (default `$PEBBLE_RUNTIME_TOKEN`). |
| `:31` | `runtimecore.NewManager(*dataDir, unavailable)` — loads persisted state (incl. shared-control keypair). |
| `:36` | `defer manager.Shutdown()` (`runtime/go/internal/runtimecore/manager.go:4227-4246`, bounded by `shutdownExitHandlingLimit = 5s` at `manager.go:31`). |
| `:37-47` | `runtimeauth.EndpointForListen` (`internal/runtimeauth/credential.go:40-49`) normalizes `0.0.0.0`/`::` → `127.0.0.1`; `runtimeauth.Publish` writes `~/.pebble/runtime-credential.json` (0600) and returns `cleanupCredential` (`credential.go:51-105`). |
| **`:49-50`** | `ctx, stop := signal.NotifyContext(...)`; `defer stop()`. |
| `:51` | `monitorDesktopParent(ctx, stop, $PEBBLE_RUNTIME_PARENT_PID)` (`:65-77`) — background goroutine that cancels `ctx` when the desktop parent dies. |
| **`:54`** | `go manager.RunAutomationScheduler(ctx, time.Minute)` — the canonical "start a background service here" line. |
| `:56` | Startup log line to stderr. |
| `:57-62` | `runtimehttp.StartWithOptions(ctx, *listen, manager, opts)` blocks until ctx cancel or server error. |

`StartWithOptions` (`runtime/go/internal/runtimehttp/server.go:2064-2099`):
- `:2073` `net.Listen("tcp", listen)` — the real bind.
- `:2079-2081` the **actual bound port** is read back via `listener.Addr().(*net.TCPAddr)` and handed to `manager.ConfigureSessionHookEndpoint(addr.Port, hookToken)`. This is the existing precedent for "learn the real port after binding".
- `:2084-2086` `go server.Serve(listener)`.
- `:2087-2098` select on `ctx.Done()` → `server.Shutdown` with `shutdownTimeout = 5s` (`internal/runtimehttp/timeout.go:5`), or on serve error.

### Candidate hook points for a background advertiser

Two distinct places, with different information available:

**A. Runtime process (`cmd/pebble-runtime/main.go`)**
- Has: `ctx` (`:49`), the manager (so the Curve25519 identity via `EnsureLegacySharedControlIdentity`), the `--listen` string, and — inside `StartWithOptions` — the real bound port (`server.go:2079`).
- Does **not** have: `--pairing-address`, the pairing scope, or the deviceToken. It never learns what the control process advertised.
- Natural start site: alongside `go manager.RunAutomationScheduler(ctx, time.Minute)` at `main.go:54`; natural stop: ctx cancel (SIGINT/SIGTERM at `:49`, desktop-parent death at `:51`), with `defer` cleanup before `manager.Shutdown()` at `:36`.
- If it must live inside the HTTP layer instead, `StartWithOptions` already has ctx + listener + a shutdown branch (`server.go:2064-2098`).

**B. Control process (`cmd/pebble-control/serve.go`)**
- Has: `ctx` (`:72`), `port`, `options.pairingAddress`, and `material.PublicKeyB64` / `material.DeviceToken` after `requestPairing` (`:105`), plus the final advertised endpoint (`:111`).
- Does **not** have: the real bound port when `--port 0` is used… actually it does (it reserved it at `:65`), but it does not observe the runtime child's listener directly.
- Shutdown paths that would each need a stop: the six early-return blocks that call `stop(); <-wait` (`:94-97`, `:107-110`, `:113-116`, `:122-125`, `:134-137`, `:140-143`) and the normal `return <-wait` at `:150`. `defer stop()` at `:73` covers ctx cancellation on every path, so a ctx-scoped advertiser needs no extra teardown code; anything with its own `Close()` would need a `defer`.
- Note `--no-pairing` (`:100`) skips pairing entirely, so no `publicKeyB64` exists on that path.

### Related client-side storage

`packages/product-core/shared/pairing.ts:6-16` — the offer schema (`v`, `endpoint`, `deviceToken`, `publicKeyB64`, optional `scope`); `decodePairingOffer` at `:32-40`. Renderer entry points that accept a pasted pairing URL: `packages/product-core/renderer/src/web/web-pairing.ts:27-48`, `components/sidebar/AddRemoteHostFields.tsx:166`, `components/settings/RuntimeEnvironmentsPane.tsx:811`.

## Caveats / Not Found

- No code path anywhere binds the runtime to a non-loopback interface. If mDNS is meant to hand a client a reachable LAN address, the bind at `serve.go:70` is the constraint, not the advertisement.
- `pebble-control` has no existing background service other than the `command.Wait()` goroutine at `serve.go:91`.
