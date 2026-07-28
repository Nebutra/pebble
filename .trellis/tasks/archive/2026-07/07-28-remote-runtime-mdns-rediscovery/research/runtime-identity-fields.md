# Research: Stable identity fields for a runtime instance (publicKeyB64, deviceToken, relayID)

- **Query**: What stable identity exists per runtime? Is `publicKeyB64` stable across restarts or regenerated? Where is the keypair persisted? Is `deviceToken` per-runtime or per-client-pairing? Is publicKey safe in a TXT record?
- **Scope**: internal
- **Date**: 2026-07-28

## Findings

### Field inventory

| Field | Kind | Stable across restart? | Secret? | Defined at |
|---|---|---|---|---|
| `publicKeyB64` | Curve25519 (NaCl `box`) public key, base64 **std** encoding, 32 bytes → 44 chars | **Yes** (persisted; only regenerated if missing/corrupt) | **No** — public half of the pair | `runtime/go/internal/runtimecore/legacy_shared_control.go:14-17`, `:46-53` |
| `secretKeyB64` | Curve25519 secret key | Yes (same record) | **Yes** — never leaves the runtime | `legacy_shared_control.go:16`, `:52` |
| `deviceToken` | 24 random bytes hex (48 chars) | Yes, but **per paired client**, not per runtime | **Yes** — it *is* the bearer credential | `legacy_shared_control.go:19-26`, `:93` (`randomLegacySharedControlHex(24)` at `:171-177`) |
| `deviceId` | `device_<24 hex>` | Per pairing | No | `legacy_shared_control.go:93` via `newID` (`manager.go:4440-4446`) |
| `relayID` | `relay_<24 hex>`, one per runtime data dir | **Yes** (persisted; minted once if empty) | No (exposed in `MobileRelayStatus`/pairing records) | `manager.go:93`, `:172`, `:174-176`; persisted as `relayId` in `store_file.go:14` |

### Where the keypair is persisted

- Struct: `LegacySharedControlState{Keypair, Devices}` — `runtime/go/internal/runtimecore/legacy_shared_control.go:28-31`.
- Persisted field: `LegacySharedControl LegacySharedControlState \`json:"legacySharedControl,omitempty"\`` — `runtime/go/internal/runtimecore/store_file.go:50`.
- File: `<dataDir>/runtime-state.json`, dir mode `0700`, atomic temp-file + rename write — `store_file.go:57-62`, `:85-97`.
- `dataDir` resolution: `$PEBBLE_RUNTIME_DATA_DIR`, else `~/.pebble`, else `.pebble` — `runtime/go/internal/runtimeauth/credential.go:30-38`; passed to the runtime as `--data-dir` (`cmd/pebble-runtime/main.go:26`).
- Load path: `NewManager` → `store.load()` → `manager.legacySharedControl = state.LegacySharedControl` (`manager.go:107-115`, `:168`).

### Stability semantics of `publicKeyB64`

`EnsureLegacySharedControlIdentity` (`legacy_shared_control.go:40-58`):

```go
if validLegacySharedControlKeypair(m.legacySharedControl.Keypair) {
    return m.legacySharedControl.Keypair, nil          // :43-45  reuse
}
publicKey, secretKey, err := box.GenerateKey(rand.Reader)  // :46  only when missing/invalid
```

`validLegacySharedControlKeypair` (`:165-169`) only checks base64-decodability and 32-byte lengths. So the key is regenerated **only** when the state file is absent, the field is empty, or the encoded value is malformed.

There is **no rotation path**. The only writers of `m.legacySharedControl.Keypair` are `:50` (first generation) and the JSON load at `manager.go:168`. `rotate: true` on `CreateLegacySharedControlPairing` (`:74-81`) rotates only *pending device records*, never the keypair. No HTTP route mutates it; `runtime/go/internal/runtimehttp/legacy_shared_control.go` only reads it (`:133`).

Test that pins this behavior: `runtime/go/internal/runtimecore/legacy_shared_control_test.go:18-48` — `TestLegacySharedControlIdentityAndDevicePersist` reloads a `Manager` from the same dir and asserts `reloadedIdentity == identity` ("expected stable E2EE identity after restart").

Practical caveats on stability: the identity is stable **per data dir**, so it changes if `~/.pebble/runtime-state.json` is deleted, if `PEBBLE_RUNTIME_DATA_DIR` differs between launches (dev vs. packaged; `config/scripts/pebble-dev.mjs:36-49` uses a separate `pebble-dev` user-data path), or on a fresh VM/container. It is not tied to hardware or hostname.

Also note: the keypair is **lazily created**. It only exists after the first call to `EnsureLegacySharedControlIdentity`, i.e. on the first pairing request (`legacy_shared_control.go:61`) or the first shared-control WebSocket upgrade (`runtimehttp/legacy_shared_control.go:133`). A runtime started with `--no-pairing` that never receives a shared-control connection may have no key yet.

### `deviceToken` is per-client-pairing, not per-runtime

- One `LegacySharedControlDevice` record per paired client, each with its own `Token` — `legacy_shared_control.go:19-26`, appended at `:92-96`.
- `CreateLegacySharedControlPairing` reuses an existing *pending* (`LastSeenAt == 0`) device of the same scope instead of minting a new one (`:83-91`); `rotate: true` drops pending ones first (`:74-81`).
- Auth is `ValidateLegacySharedControlToken` — a linear scan for a matching token (`:106-115`).
- Revocation is per device id (`:123-135`).
- So: **a runtime has N deviceTokens (one per paired client) and exactly one keypair.** The token is the secret; it must never be broadcast.

### Is `publicKeyB64` safe to put in a TXT record?

Facts that bear on the question (no recommendation implied):

1. **It is the public half of a Curve25519 pair.** `box.GenerateKey` returns `(publicKey, secretKey)`; only `PublicKeyB64` is ever sent to clients, embedded in the pairing offer (`serve.go:117-120`), and returned by `POST /v1/shared-control/pairing` (`runtimehttp/legacy_shared_control.go:84-99`).
2. **It is already published in the pairing URL**, which is pasted around, QR-encoded, and written into VM recipe JSON (`skill-guides/pebble-per-workspace-env.md:302-303`). The renderer schema comments it as "the desktop's Curve25519 public key, base64-encoded" (`packages/product-core/shared/pairing.ts:10-12`).
3. **Knowing it does not grant access.** The handshake is: client sends `e2ee_hello{publicKeyB64}` → server derives the shared key with *its* secret (`runtimehttp/legacy_shared_control.go:149-161`, `legacy_shared_control_crypto.go:13-14`) → client sends an encrypted `e2ee_auth{deviceToken}` → server authorizes **solely** from `ValidateLegacySharedControlToken` (`legacy_shared_control.go:175-179`). The schema comment says the same: "the runtime still authorizes solely from deviceToken" (`packages/product-core/shared/pairing.ts:13-14`).
4. **It functions as a runtime-identity proof in the other direction.** Because the client encrypts its `deviceToken` to the server's public key, only a process holding the matching secret can complete the handshake. A client that remembers `publicKeyB64` from pairing can therefore verify "this is the runtime I paired with" — the check is implicit in a successful auth, and comparing the advertised key to the stored one is a cheap pre-filter.
5. **Size fits DNS-SD.** 32 bytes → 44 base64 chars (with `=` padding, std alphabet, `:51`), well under the 255-byte limit of a single TXT character-string. Note the encoding is base64 **std** (`+`/`/`, padded), not base64url — `/` and `+` are legal bytes in a TXT string but not URL-safe.
6. **Privacy, not secrecy, is the residual issue.** Broadcasting a stable per-runtime identifier on multicast lets anyone on the LAN see that a given machine runs Pebble and correlate it across sessions; `relayID` (`manager.go:93`) has the same property. Nothing in the codebase currently emits either onto the network unsolicited.

### `relayID` as an alternative/parallel identifier

`relayID` is a persisted, per-data-dir, non-secret opaque id (`manager.go:172-176`, `store_file.go:14`). It is already surfaced publicly in `MobileRelayStatus.RelayID` (`mobile_relay.go:76-86`, `:381-390`) and inside mobile pairing records (`mobile_relay.go:64-73`, `:478`). It is also used as a session-tab "publication epoch" (`session_tabs_snapshot.go:15`, `:34`). It is **not** exposed in the runtime `/v1/status` payload (`manager.go:299-314` has no identity fields) and it is **not** part of the pairing offer, so a client that paired via `pebble://pair` has never seen it.

## Caveats / Not Found

- No hostname/machine-id/serial-based identity exists anywhere in the Go runtime; `os.Hostname()` is never called (grep across `runtime/go` and `apps/desktop/src-tauri/src` returns nothing).
- `/v1/status` carries no runtime identity (`manager.go:299-314`), so there is currently no unauthenticated way for a client to ask "which runtime are you?" over HTTP.
- The naming (`Legacy…`) is from the Orca-era shared-control protocol; the offer version is still `2` (`serve.go:118`, `packages/product-core/shared/pairing.ts:3`).
