# Make remote-runtime connection failures diagnosable and repairable

## Background

A user repeatedly hit `Could not connect to the remote Pebble runtime.` when connecting to a
saved remote server. Investigation found **three distinct root causes that all surface as that
one identical sentence**, which is why the failure kept recurring without ever becoming
diagnosable:

1. The peer's DHCP address changed. The pairing offer's `endpoint` is frozen at pair time
   (`apps/desktop/src-tauri/src/commands/runtime_environments.rs:629`) and there is no way to
   edit it — the only recourse is deleting the server and re-pairing.
2. macOS 15+ Local Network privacy can block the outgoing connection to a LAN address.
   `apps/desktop/src-tauri/Info.plist` declares no `NSLocalNetworkUsageDescription`.
3. Genuine connection refusal / TLS / handshake failures.

`apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs:229` collapses all of them:

```rust
connect_async(&pairing.endpoint).await
    .map_err(|_| "Could not connect to the remote Pebble runtime.".to_string())?
```

This task makes the failure self-explanatory and gives the user a repair path short of re-pairing.

## Non-goals

- **mDNS / LAN auto-discovery.** Rejected: the advertiser would have to live in the peer server,
  which for the reporting user is the legacy Orca app, outside this repo. See
  `research/go-dependencies-and-mdns.md` and `research/rust-mdns-crate-comparison.md`.
- **Binding the runtime to a non-loopback address.** Rejected as unsafe: `pebble serve` runs with
  **no authentication at all** (`runtime/go/cmd/pebble-control/main.go:48` short-circuits the
  token when serving; `runtime/go/internal/runtimehttp/server.go:86-88` then authorizes every
  route), so the loopback bind is a load-bearing security boundary. Exposing it would yield
  unauthenticated remote command execution via `POST /v1/sessions`
  (`runtime/go/internal/runtimehttp/server.go:589-594`). Tracked separately — see
  `research/native-lan-serve-feasibility.md`.
- Changing the remote-access model. SSH tunnel / Tailscale remains the supported path
  (`docs/reference/infra-index.md:98`).

## Requirements

### R1 — Preserve the real dial error

- The error surfaced from `remote_runtime_rpc.rs` must carry the underlying failure cause and the
  endpoint that was dialed.
- **Constraint:** `packages/product-core/shared/remote-runtime-tailscale-hint.ts:14-15` matches the
  message with a literal regex, gated at `:64`. The string
  `Could not connect to the remote Pebble runtime` must remain matchable, or the regex and its
  tests must be updated in the same change. Losing the Tailscale hint while "improving" the error
  is a regression.
- The Node path must stop discarding the error argument
  (`packages/product-core/shared/remote-runtime-request-websocket.ts:46-52` and
  `packages/product-core/shared/remote-runtime-client.ts:160-168`, `:464-471` all declare
  `function onError(): void`).
- Secrets must never appear in a surfaced error: `deviceToken` must not be included.

### R2 — Declare macOS Local Network usage

- `apps/desktop/src-tauri/Info.plist` must declare `NSLocalNetworkUsageDescription` with a string
  explaining that Pebble connects to Pebble runtimes on the local network.
- No entitlement change: `com.apple.developer.networking.multicast` is iOS-only and must **not**
  be added (Apple TN3179: "The multicast entitlement isn't required on macOS").

### R3 — Repair a saved server's address without re-pairing

- Settings must offer a way to change a saved server's endpoint in place.
- `runtime_environments_update_pairing_code` must **not** be reused: it requires a full base64
  offer and rebuilds the entry, replacing `public_key_b64` and resetting the endpoints vec
  (see `research/runtime-environment-store.md`). A narrow endpoint-only mutation is required.
- The new endpoint must be validated before being persisted.
- Editing the address must preserve the existing `deviceToken` and `publicKeyB64` — it is the same
  runtime at a new address, not a new pairing.

## Acceptance Criteria

- [ ] Dialing an address with no host present yields an error naming the endpoint and the
      underlying cause (e.g. no route to host), not the bare sentence.
- [ ] Dialing a Tailscale endpoint that fails still produces the Tailscale hint; a test covers this
      explicitly against the new message shape.
- [ ] No surfaced error contains a `deviceToken`.
- [ ] `Info.plist` declares `NSLocalNetworkUsageDescription`; `codesign`/notarization config is
      unchanged and no new entitlement is present.
- [ ] A saved server's address can be changed from Settings and a subsequent connect uses the new
      address, with the same pairing credentials.
- [ ] Changing the address of a server whose name is unchanged does not trip the duplicate-name
      rejection in `packages/product-core/shared/runtime-environment-store.ts:51-56`.
- [ ] Existing tests pass; `RuntimeEnvironmentsPane` UI follows `docs/STYLEGUIDE.md`.

## Resolved decisions

- **Desktop-only for the endpoint edit** (decided 2026-07-28). The web/renderer settings pane is out
  of scope for this task. `packages/product-core/renderer/src/web/web-preload-api.ts` must implement
  `updateEndpoint` as an explicit "not supported in the web client" error — never a silent no-op,
  which would look like a successful edit that does nothing.
