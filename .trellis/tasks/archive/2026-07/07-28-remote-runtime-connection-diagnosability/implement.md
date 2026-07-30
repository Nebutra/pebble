# Implementation plan — remote-runtime connection diagnosability

Three independent tracks. Land as three commits. No ordering dependency; D2 is the cheapest and can
go first to get a quick win on disk.

## Track D2 — Info.plist (smallest, do first)

- [ ] Add `NSLocalNetworkUsageDescription` to `apps/desktop/src-tauri/Info.plist`.
- [ ] Confirm **no** entitlement file gained `com.apple.developer.networking.multicast`.
- [ ] Validate the plist parses: `plutil -lint apps/desktop/src-tauri/Info.plist`.

**Review gate:** diff must be plist-only.

## Track D1 — Preserve the real dial error

- [ ] Add `describe_dial_failure(endpoint, &tungstenite::Error) -> String` in
      `apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs`, mapping per the table in
      `design.md`. Include a `_` arm — the error enums are `#[non_exhaustive]`.
- [ ] Replace the `map_err(|_| ...)` at `:229`. Then `:242`, `:275`, `:299`, preserving each site's
      existing message prefix.
- [ ] Rust unit tests: one per class (`ConnectionRefused`, `HostUnreachable`, `TimedOut`, `Url`,
      `Http`), asserting the message starts with the canonical prefix and names the endpoint.
- [ ] Rust test asserting a formatted message never contains a device token.
- [ ] Node: accept the error argument in `onError` at
      `packages/product-core/shared/remote-runtime-request-websocket.ts:46-52` and
      `packages/product-core/shared/remote-runtime-client.ts:160-168`, `:464-471`; thread the
      message through.
- [ ] **Regression guard:** add a test in
      `packages/product-core/shared/remote-runtime-tailscale-hint.test.ts` asserting the hint still
      fires against a *new-shape* message
      (`"Could not connect to the remote Pebble runtime: no route to host (ws://100.64.1.20:6768)"`).
      This is the specific thing that would silently break.

**Review gate:** confirm `REMOTE_RUNTIME_UNREACHABLE_RE` still matches every new message shape
before moving on.

Validation:
```bash
cd apps/desktop/src-tauri && cargo test remote_runtime
pnpm vitest run packages/product-core/shared/remote-runtime-tailscale-hint.test.ts
```

## Track D3 — Edit a saved server's address

- [ ] `RuntimeEnvironmentUpdateEndpointInput { selector, endpoint }` next to the other input structs
      (`runtime_environments.rs:38-49`).
- [ ] `runtime_environments_update_endpoint` command: `resolve_environment` →
      `normalize_websocket_endpoint` → mutate the `preferred_endpoint_id` endpoint in place (fallback
      to first `kind == "websocket"`) → `updated_at` → `write_store` → return
      `redact_environment`.
- [ ] **Assert in code review:** `device_token` and `public_key_b64` are not assigned anywhere in the
      new command.
- [ ] Register in `apps/desktop/src-tauri/src/main.rs` near line 340.
- [ ] Rust tests: happy path; `http://` → `ws://` coercion; invalid URL rejected; secrets preserved
      across the edit; non-existent selector errors.
- [ ] `updateEndpoint` on `PreloadApi['runtimeEnvironments']`
      (`packages/product-core/shared/preload-api-types.ts:2481-2516`).
- [ ] Desktop impl in `apps/desktop/src/pebble-tauri-runtime-control-api.ts` next to
      `addFromPairingCode` (`:280-284`).
- [ ] Web impl in `packages/product-core/renderer/src/web/web-preload-api.ts:1083` — explicit
      unsupported error if desktop-only is chosen (resolve the PRD open question first).
- [ ] UI affordance in
      `packages/product-core/renderer/src/components/settings/RuntimeEnvironmentsPane.tsx` per
      `research/settings-pane-edit-address-ui.md` + `docs/STYLEGUIDE.md`. Reuse existing primitives.
- [ ] Verify no `gen/schemas/*.json` change is needed (expected: none — see
      `research/tauri-command-acl.md`). If the build regenerates them, that is unrelated churn; do
      not commit it in this task.

Validation:
```bash
cd apps/desktop/src-tauri && cargo test runtime_environments
pnpm typecheck
pnpm lint
```

## End-to-end verification (required before calling this done)

Static tests cannot show the user-visible outcome. Drive the real app:

1. Pair against any endpoint, then edit the saved address to a host that is not on the network
   (e.g. `ws://172.16.1.155:6768`) and connect. **Expect** an error naming the endpoint and
   `no route to host` / `timed out` — not the bare sentence.
2. Edit the address to a live host with nothing listening. **Expect** `connection refused`.
3. Edit an address and confirm connecting afterwards uses the new address with the same pairing
   credentials (no re-pair prompt, no duplicate-name error).
4. On macOS, confirm the Local Network prompt appears / the app is listed under
   System Settings → Privacy & Security → Local Network.

Use the `verify` skill for the driving.

## Rollback

Each track is a standalone commit; `git revert` any one independently. No schema/migration to undo
(`RuntimeEnvironmentStore.version` stays `1`).

## Out of scope — do not drift into these

- mDNS / auto-discovery (rejected; see the archived task
  `.trellis/tasks/archive/2026-07/07-28-remote-runtime-mdns-rediscovery/prd.md`).
- Changing the runtime's loopback bind (unsafe until `pebble serve` requires a token; see
  `research/native-lan-serve-feasibility.md`).
- Removing the `orca://` compat shims — separate migration work.
