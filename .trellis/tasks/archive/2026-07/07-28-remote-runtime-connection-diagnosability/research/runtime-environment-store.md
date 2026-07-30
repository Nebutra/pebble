# Research: runtime-environment store shape and endpoint mutation path

- **Query**: exact persisted shape, read/write sites, cleanest endpoint-only mutation; can `runtime_environments_update_pairing_code` be reused?
- **Scope**: internal
- **Date**: 2026-07-28

## Findings

### Files Found

| File Path | Description |
|---|---|
| `apps/desktop/src-tauri/src/commands/runtime_environments.rs` | The whole store: types, all commands, read/write, redaction |
| `apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs` | Dial + E2EE handshake; consumes `RemoteRuntimePairing` |
| `apps/desktop/src-tauri/src/main.rs:339-341` | `invoke_handler` registration of the runtime-environment commands |
| `apps/desktop/src/pebble-tauri-runtime-control-api.ts:241-297` | Renderer bridge (`window.api.runtimeEnvironments.*`) |
| `packages/product-core/shared/preload-api-types.ts:2481-2516` | `PreloadApi['runtimeEnvironments']` type contract |
| `apps/desktop/src/tauri-ephemeral-vm-api.ts:214-221` | Sole caller of `runtime_environments_update_pairing_code` |
| `packages/product-core/shared/runtime-environments.ts` | Renderer-side `PublicKnownRuntimeEnvironment` type + `isUserManagedRuntimeEnvironment` |

### On-disk shape

File: `<app_data_dir>/pebble-environments.json` (`ENVIRONMENTS_FILE`, `runtime_environments.rs:25`; path resolved at `:536-542`).

```rust
// runtime_environments.rs:134-165
struct RuntimeEnvironmentStore { version: u8, environments: Vec<KnownRuntimeEnvironment> }

struct KnownRuntimeEnvironment {
    id: String,
    name: String,
    created_at: u64,
    updated_at: u64,
    last_used_at: Option<u64>,
    runtime_id: Option<String>,
    source: Option<String>,          // skip_serializing_if = None; "ephemeral-vm" is the only value set today
    endpoints: Vec<RuntimeAccessEndpoint>,
    preferred_endpoint_id: String,
}

struct RuntimeAccessEndpoint {
    id: String,              // format!("ws-{id}")  — runtime_environments.rs:616
    kind: String,            // always "websocket"
    label: String,           // always "WebSocket"
    endpoint: String,        // <-- the mutable target; written verbatim at :629
    device_token: String,    // secret, redacted from the renderer
    public_key_b64: String,  // secret, redacted; STABLE server identity (see below)
}
```

- `version` must be `1` or `read_store` errors (`:553-558`). Note the mismatch: the *pairing offer* version constant is `PAIRING_OFFER_VERSION = 2` (`:26`) — different thing.
- `redact_environment` (`:791-812`) strips `deviceToken` / `publicKeyB64`; the renderer only ever sees `PublicRuntimeAccessEndpoint { id, kind, label, endpoint }` (`:182-189`).
- Environments are always kept sorted by `name` (`:828-837`), on both read and write.
- Only ever one endpoint is created (`create_environment_from_pairing_offer`, `:610-635`), and `preferred_endpoint_id == endpoints[0].id`.

### Read / write sites

| Site | Line | Notes |
|---|---|---|
| `read_store` | `:544-563` | Only reader. Hardens perms (0600/ACL), parses, sorts. Returns empty store if file absent. |
| `write_store` | `:565-601` | Only writer. Atomic: writes `*.json.<pid>.<ms>.tmp` with `create_new(true)` + mode 0600, `sync_all`, `fs::rename`, then re-hardens. |
| `runtime_environments_list` | `:200-209` | read only |
| `runtime_environments_add_from_pairing_code` | `:211-243` | read → push → sort → write |
| `runtime_environments_resolve` | `:245-255` | read only |
| `runtime_environments_update_pairing_code` | `:257-294` | read → rebuild whole environment from a new pairing offer → map-replace by id → sort → write |
| `runtime_environments_remove` | `:296-313` | read → retain → write → close subscriptions |
| `runtime_environments_disconnect` | `:315-327` | read only + close subscriptions |
| `runtime_environment_pairing_for_selector` | `:759-781` | read → pick `preferred_endpoint_id`, else first `kind == "websocket"` → build `RemoteRuntimePairing` |

There is **no `RwLock`/`Mutex` guarding the file** — every command does a fresh `read_store` → mutate → `write_store`. Concurrent writers are last-write-wins (the rename is atomic, but the read-modify-write is not). A background mDNS re-discovery task writing the store while the user edits it in Settings is a real (if narrow) race; worth an in-process `Mutex<()>` around the read-modify-write if the mutation becomes async/background-triggered.

### `resolve_environment` semantics (`:734-757`)

Selector matches `id` first, then falls back to unique `name`; ambiguous names error out. Every mutating command takes `selector: String`, not `id`.

### Assessment: reuse `runtime_environments_update_pairing_code`?

**No — a narrower endpoint-only command is cleaner.** Reasons, all grounded in the existing code:

1. **It requires a full pairing code, not an address.** `:265` calls `parse_pairing_code`, which requires a base64 payload carrying `endpoint` + `deviceToken` + `publicKeyB64` and rejects anything missing one (`decode_pairing_payload`, `:706-722`). mDNS re-discovery only recovers the *address*; the device token and server public key are unchanged and already stored. Synthesizing a fake pairing code just to reuse this command would mean re-encoding the secrets we already hold.
2. **It rebuilds the environment from scratch** via `create_environment_from_pairing_offer` (`:267-272`), which mints a *new* `endpoint_id` (`ws-{id}` — same value in practice since `id` is preserved) and resets `endpoints` to a single-element vec. It also drops nothing today only because there is exactly one endpoint. Any future multi-endpoint support would silently lose endpoints.
3. **It re-keys the E2EE identity.** Replacing `public_key_b64` from a stale/wrong offer would break the `SalsaBox` handshake (`remote_runtime_rpc.rs:225-231`). An address-only mutation must *not* touch the key.
4. **Its only caller is orthogonal.** `apps/desktop/src/tauri-ephemeral-vm-api.ts:214-221` calls it on ephemeral-VM resume, where the VM legitimately produced a brand-new pairing offer. That path is not the mDNS path.
5. **It is not on the `PreloadApi` surface at all.** It is invoked raw (`invoke('runtime_environments_update_pairing_code', ...)`) — see `preload-api-types.ts:2481-2516`, which has no `updatePairingCode`. So there is no established renderer contract to extend.

### Shape of a narrower mutation

The minimal change that keeps every existing invariant:

- New input struct next to the others (`:38-49`):
  `RuntimeEnvironmentUpdateEndpointInput { selector: String, endpoint: String }`.
- Reuse `normalize_websocket_endpoint` (`:724-732`) so `http://`/`https://` are coerced to `ws`/`wss` exactly as pairing codes are.
- Mutate in place rather than rebuilding: locate the environment by `resolve_environment`, then update the endpoint whose `id == preferred_endpoint_id` (falling back to the first `kind == "websocket"`, mirroring `runtime_environment_pairing_for_selector:765-775`), set `updated_at = current_time_millis()`, `write_store`.
- Return `RuntimeEnvironmentResult { environment: redact_environment(&updated) }` to match the shape `add`/`update_pairing_code` already return (`:87-91`).
- Register in `main.rs` next to line 340.
- For the renderer, add `updateEndpoint` to `PreloadApi['runtimeEnvironments']` (`preload-api-types.ts:2481`) and implement it in `pebble-tauri-runtime-control-api.ts` alongside `addFromPairingCode` (`:280-284`). The web implementation lives at `packages/product-core/renderer/src/web/web-preload-api.ts:1083`.

If the Rust dial path itself performs the re-discovery, it needs a `&tauri::AppHandle` to reach the store — `remote_runtime_rpc.rs` currently takes only a `RemoteRuntimePairing` and has no `AppHandle`, so either the caller (`runtime_environments_call` / `_subscribe`, `:329-346` / `:348-461`) does the retry loop, or `RemoteRuntimePairing` gains the selector/env-id so the RPC layer can call back.

### Stable identity available for mDNS matching

`RuntimeAccessEndpoint.public_key_b64` is the server's long-lived NaCl box public key. It is generated once and persisted in the runtime's manager state — `runtime/go/internal/runtimecore/legacy_shared_control.go:39-58` (`EnsureLegacySharedControlIdentity` returns the existing keypair when valid, else generates + `saveLocked()`). So a client can match a discovered mDNS record to a saved environment by comparing the advertised public key (or a hash of it) to the stored `public_key_b64`. `device_token` is per-device and must never be advertised.

Note the runtime advertises nothing today — grep for `mdns|zeroconf|dns-sd|bonjour` over `runtime/go/internal` returns zero hits. The server-side advertiser is a prerequisite that does not exist yet. The pairing endpoint is built by `sharedControlEndpoint` (`runtime/go/cmd/pebble-control/serve.go:326-355`) with path `sharedControlPath = "/v1/shared-control"` (`:26`).

### `runtime_id` is dead today

`KnownRuntimeEnvironment.runtime_id` (`:149`) is set to `None` on creation (`:623`) and only ever carried forward (`:276`). Nothing writes it. It is a natural slot for a discovered mDNS instance name / stable runtime identifier if one is added.

## Caveats / Not Found

- No test coverage for `runtime_environments_update_pairing_code`; the `#[cfg(test)] mod tests` block (`:955-1012`) only covers pairing-code parsing and redaction.
- No file-level locking; see the race note above.
- `write_store` uses `create_new(true)` on a pid+millis-suffixed temp name, so two writes in the same millisecond from the same process would collide and error rather than corrupt.
