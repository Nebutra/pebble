# Design — remote-runtime connection diagnosability

Three independent deliverables. They share a theme but have no ordering dependency between them,
so they can land as separate commits and be verified separately.

## D1 — Preserve the real dial error (Rust + Node)

### Boundary

`apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs`. The error string this returns is what
the UI shows verbatim: `apps/desktop/src/pebble-tauri-runtime-control-api.ts:264-274` wraps it into
`failRuntimeRpc('remote_runtime_unavailable', getErrorMessage(error))`.

### Contract

Add a private formatter:

```rust
fn describe_dial_failure(endpoint: &str, error: &tungstenite::Error) -> String
```

returning `"Could not connect to the remote Pebble runtime: {cause} ({endpoint})"`.

**The prefix `Could not connect to the remote Pebble runtime` is load-bearing** —
`packages/product-core/shared/remote-runtime-tailscale-hint.ts:14-15` regex-matches it and gates the
Tailscale hint at `:64`. Appending after a colon keeps the existing regex matching; do not reword
the prefix.

### Cause mapping

From `research/tokio-tungstenite-error-taxonomy.md`. `connect_async` funnels every network-layer
failure into `Error::Io(io::Error)`; discrimination happens on `io::ErrorKind` (`HostUnreachable`,
`NetworkUnreachable`, `NetworkDown`, `TimedOut`, `ConnectionRefused` — all stable since Rust 1.83,
repo builds 1.96.1). Map to short human phrases:

| Variant | Phrase |
|---|---|
| `Io` / `ConnectionRefused` | `connection refused — the address is reachable but nothing is listening` |
| `Io` / `HostUnreachable`, `NetworkUnreachable`, `NetworkDown` | `no route to host — the machine is not on this network` |
| `Io` / `TimedOut` | `timed out — no response from the address` |
| `Io` / other | the `io::Error` message (covers DNS: `ToSocketAddrs` failures land here as `Uncategorized`) |
| `Url(_)` | `the saved address is not a valid WebSocket URL` |
| `Tls(_)` | `TLS failure` + the inner error |
| `Http(resp)` | `the server rejected the connection (HTTP {status})` |
| `Protocol(_)` / `HttpFormat(_)` / `Capacity(_)` | the `Display` of the error |
| `_` | the `Display` of the error (all these enums are `#[non_exhaustive]`) |

The `no route to host` and `connection refused` phrasings are the ones that would have let the
reporting user self-diagnose, so their wording matters more than the rest.

### Secret safety

`pairing.endpoint` is a bare `ws://host:port[/path]` — it carries no credential, so including it is
safe. `device_token` must not be interpolated anywhere. A test should assert the formatted message
never contains the token.

### Node path

`packages/product-core/shared/remote-runtime-request-websocket.ts:46-52` and
`packages/product-core/shared/remote-runtime-client.ts:160-168`, `:464-471` declare
`function onError(): void`, discarding the `ws` `'error'` event's `Error` (which carries
`ECONNREFUSED`/`EHOSTUNREACH` plus address and port). Accept the parameter and thread the message
through with the same prefix contract.

### Also fix in passing

`remote_runtime_rpc.rs:242`, `:275`, `:299` use the same `map_err(|_| ...)` discard pattern for
post-connect send/stream failures. Same treatment, different prefixes — the existing regex also
matches `remote pebble runtime closed the connection`, so preserve whatever prefix each already has.

## D2 — Declare macOS Local Network usage

`apps/desktop/src-tauri/Info.plist` currently declares only `NSCameraUsageDescription` and
`NSMicrophoneUsageDescription`. Add:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Pebble connects to Pebble runtimes running on your local network.</string>
```

macOS 15+ applies Local Network privacy to outgoing TCP connections to local addresses — exactly
what `remote_runtime_rpc.rs:229` does — so this affects the app today, independent of mDNS.

**Do not** add `com.apple.developer.networking.multicast`: Apple TN3179 states "The multicast
entitlement isn't required on macOS" and lists the entitlement as iOS/iPadOS/visionOS only. Adding
it would be a notarization risk for no benefit. No entitlement file changes at all.

See `research/platform-permissions-macos-windows.md`.

## D3 — Edit a saved server's address

### Why not reuse `runtime_environments_update_pairing_code`

It requires a full base64 pairing offer, rebuilds the environment via
`create_environment_from_pairing_offer`, resets the `endpoints` vec, and replaces `public_key_b64`
— which would break the `SalsaBox` E2EE handshake at `remote_runtime_rpc.rs:225-231`. It is also
not on the `PreloadApi` surface. Full rationale: `research/runtime-environment-store.md`.

### New command

```rust
struct RuntimeEnvironmentUpdateEndpointInput { selector: String, endpoint: String }

#[tauri::command]
fn runtime_environments_update_endpoint(...) -> Result<RuntimeEnvironmentResult, String>
```

- Resolve via the existing `resolve_environment` (`:734-757`) — selector matches id, then unique
  name.
- Normalize through the existing `normalize_websocket_endpoint` (`:724-732`) so `http`/`https` are
  coerced to `ws`/`wss` exactly as pairing codes are. Reject anything it rejects.
- **Mutate in place**: update the endpoint whose `id == preferred_endpoint_id`, falling back to the
  first `kind == "websocket"` — mirroring `runtime_environment_pairing_for_selector:765-775`. Leave
  `device_token` and `public_key_b64` untouched; this is the same runtime at a new address.
- Set `updated_at = current_time_millis()`, then `write_store`.
- Return `RuntimeEnvironmentResult { environment: redact_environment(&updated) }`, matching what
  `add` already returns (`:87-91`).
- Register in `apps/desktop/src-tauri/src/main.rs` next to line 340.

Because this mutates in place and does not touch `name`, it cannot trip the duplicate-name
rejection at `packages/product-core/shared/runtime-environment-store.ts:51-56` — which is precisely
the trap the delete-and-re-pair workaround falls into.

### Renderer contract

- `packages/product-core/shared/preload-api-types.ts:2481-2516` — add `updateEndpoint` to
  `PreloadApi['runtimeEnvironments']`.
- `apps/desktop/src/pebble-tauri-runtime-control-api.ts` — implement alongside `addFromPairingCode`
  (`:280-284`).
- `packages/product-core/renderer/src/web/web-preload-api.ts:1083` — web implementation. **Open
  question in the PRD**: desktop-only is acceptable for a first cut; if so, the web impl throws a
  clear unsupported error rather than silently no-op'ing.
- No Tauri ACL/capability work: `research/tauri-command-acl.md` proves app-level commands need no
  manifest entry (zero occurrences of `runtime_environments` in any `gen/schemas/*.json`).

### UI

`packages/product-core/renderer/src/components/settings/RuntimeEnvironmentsPane.tsx`. Placement and
primitives per `research/settings-pane-edit-address-ui.md` and `docs/STYLEGUIDE.md`. Reuse the
primitives the pane already uses; do not introduce new ones. The affordance sits next to the
existing connect/remove controls on a server row.

## Concurrency note

`research/runtime-environment-store.md` flags that there is no lock around read-modify-write on
`pebble-environments.json`. With only user-initiated edits this is not a new race — the existing
add/remove commands have the same shape. Do not add background/automatic mutation in this task; if
that ever lands, an in-process `Mutex` around read-modify-write is required first.

## Rollout / rollback

Three independent commits, each revertible alone. No schema change (`version` stays `1`), no
migration, no persisted-format change — `endpoint` is an existing field getting a new writer. D2 is
a plist-only change. Rolling back D3 leaves any already-edited endpoint in place and still valid.
