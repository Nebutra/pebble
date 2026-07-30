# Research index — remote-runtime mDNS re-discovery (Rust/Tauri client side)

Date: 2026-07-28. All findings are file:line-cited inside each document.

| File | Covers | One-line answer |
|---|---|---|
| `runtime-environment-store.md` | Q1 — store shape, read/write sites, endpoint-only mutation | Add a narrow `runtime_environments_update_endpoint`; do **not** reuse `update_pairing_code` (it demands a full pairing code and re-keys E2EE identity) |
| `tokio-tungstenite-error-taxonomy.md` | Q2 — which failures mean "address moved" | Everything network-level lands in `Error::Io(io::Error)`; re-discover on `HostUnreachable/NetworkUnreachable/NetworkDown/TimedOut/ConnectionRefused`, never on `Error::Http`/`Protocol`/`Url` |
| `rust-mdns-crate-comparison.md` | Q3 — crate choice | **`mdns-sd`** — pure Rust, Apache-2.0 OR MIT, ~4 new lockfile crates, real Windows support. `zeroconf`/`astro-dnssd` need Apple's deprecated Bonjour SDK on Windows |
| `platform-permissions-macos-windows.md` | Q4 — permission gotchas | Multicast entitlement is **iOS-only, not needed**. macOS 15 Local Network privacy **does** apply (and already applies to the existing WebSocket dial). Add `NSLocalNetworkUsageDescription` to `Info.plist`; no entitlement change, no notarization impact. Windows Defender Firewall will prompt on UDP 5353 bind |
| `tauri-command-acl.md` | Q5 — capability/ACL | **Nothing to declare.** App commands bypass the ACL gate unless `src-tauri/permissions/` exists or the origin is remote — neither is true here |
| `settings-pane-edit-address-ui.md` | Q6 — settings UI | Row-level `ghost`/`icon` pencil → inline edit form (mirroring Add Server at `:766-849`) or `Popover`; **not** a `Dialog` (reserved for destructive confirm per STYLEGUIDE) |
| `reconnect-backoff-integration.md` | Q7 — reconnect/backoff | The desktop Tauri path has **no backoff to fight** — it re-reads the store on every call. Add one repair-and-retry per call, gated by a per-environment cooldown |

## Cross-cutting caveats worth reading before design

1. **The Go runtime advertises nothing over mDNS today.** `grep -i 'mdns|zeroconf|dns-sd|bonjour'` over `runtime/go/internal` returns zero hits. A server-side advertiser is a hard prerequisite. Details in `runtime-environment-store.md` §"Stable identity available for mDNS matching".
2. **The identity to match on is `public_key_b64`** — the runtime's NaCl box public key, persisted once by `EnsureLegacySharedControlIdentity` (`runtime/go/internal/runtimecore/legacy_shared_control.go:39-58`) and stable across restarts. `device_token` is per-device and must never be advertised.
3. **Changing the error string at `remote_runtime_rpc.rs:231` silently disables the Tailscale hint** — `remote-runtime-tailscale-hint.ts` regex-matches the literal phrase. Keep the prefix or update the regex + tests.
4. **Never re-discover a Tailscale endpoint.** `isTailscaleEndpoint()` in `remote-runtime-tailscale-hint.ts` already gives the predicate.
5. **macOS 15 may deny the first local-network operation before the user answers the alert** (Apple TN3179). A single short mDNS browse on a fresh install will legitimately find nothing.
6. **`RuntimeEnvironmentsPane.tsx` already carries an `eslint-disable max-lines`.** Per `AGENTS.md`, new UI must go into a new sibling module, not into that file.
7. **The store has no lock.** Every command does read → mutate → write. A background re-discovery writer racing the Settings pane is possible; consider an in-process mutex.
