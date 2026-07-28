# Research: existing reconnect/backoff logic and where re-discovery slots in

- **Query**: `remote-runtime-shared-control-reconnect.ts`, `web-runtime-client.ts:607`, and how a re-discovery step fits without fighting the backoff
- **Scope**: internal
- **Date**: 2026-07-28

## There are three separate transports, and only two of them back off

| Transport | Where | Backoff? | Endpoint source |
|---|---|---|---|
| **Tauri desktop** (the one this task is about) | `apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs` + `runtime_environments.rs` | **No.** One dial per call/subscribe. | Read fresh from disk on every call — `runtime_environment_pairing_for_selector`, `runtime_environments.rs:759-781` |
| **Web client** | `packages/product-core/renderer/src/web/web-runtime-client.ts` | Yes — `RECONNECT_DELAYS_MS` | `this.pairing.endpoint`, captured in the constructor |
| **Shared control (Node/`ws`)** | `packages/product-core/shared/remote-runtime-shared-control-connection.ts` | Yes — inline delay array | `this.pairing`, captured in the constructor |

That split matters: **the desktop path has no backoff to fight.** Each `runtime_environments_call` / `runtime_environments_subscribe` is a fresh `connect_authenticated_socket` (`remote_runtime_rpc.rs:222-258`) that re-reads the store. Re-discovery there is a plain retry-once-after-repair, not a state-machine change.

## Findings

### A. Web client (`web-runtime-client.ts`)

```ts
:65   const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000]
:85   private reconnectAttempt = 0
:348  private openConnection(): void {
:354      ws = new WebSocket(this.pairing.endpoint)
:450      this.reconnectAttempt = 0            // on successful connect
:586  private handleSocketClosed(closedWs: WebSocket): void { … this.scheduleReconnect() }
:607  private scheduleReconnect(): void {
:608    if (this.reconnectTimer || this.intentionallyClosed) return
:611    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
:613    this.reconnectAttempt += 1
:614    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = null; this.openConnection() }, delay)
```

Key properties:

- **Unbounded** — `Math.min(...)` clamps the *index*, so it retries forever at 15 s. There is no give-up.
- Guarded by a single `reconnectTimer` (re-entrancy safe) and by `intentionallyClosed`.
- `reconnectAttempt` resets to 0 at `:450` on a successful connect.
- `handleSocketClosed` (`:586-601`) clears connect/handshake/heartbeat timers, rejects pending, notifies subscriptions closed, then schedules — and skips scheduling entirely when `state === 'auth-failed'` (`:596-600`). **That is the existing precedent for "don't retry when the failure is not a transport failure"** — the same distinction the error taxonomy needs to make for mDNS.
- Connect-timeout errors run through `withRemoteRuntimeTailscaleHint(msg, this.pairing.endpoint)` at `:413` and `:568`.
- `this.pairing.endpoint` is read at `:354` on **every** `openConnection()`, so if the `pairing` object were mutated in place, the next attempt would pick up the new address for free.

### B. Shared control connection (`remote-runtime-shared-control-connection.ts`)

```ts
:262  private handleSocketClosed(error) {
:265    if (this.subscriptions.size > 0 && !this.intentionallyClosed) this.scheduleReconnect()
:271  private scheduleReconnect(): void {
:272    const scheduled = scheduleSharedControlReconnectOrFinish({
:273      current: this.reconnectTimer, intentionallyClosed: this.intentionallyClosed,
:275      reconnectAttempt: this.reconnectAttempt,
:276      delaysMs: [250, 500, 1000, 2000, 4000, 8000, 15_000],
:277      subscriptions: this.subscriptions,
:278      open: () => { this.reconnectTimer = null; this.open() }
:281    this.reconnectTimer = scheduled.timer
:282    this.reconnectAttempt = scheduled.reconnectAttempt
```

`packages/product-core/shared/remote-runtime-shared-control-reconnect.ts` (whole file, 26 lines):

```ts
export function scheduleSharedControlReconnectOrFinish(args): { timer; reconnectAttempt } {
  if (args.reconnectAttempt >= args.delaysMs.length) {           // :16
    const error = remoteRuntimeUnavailableError(
      'Remote Pebble runtime connection could not be restored.') // :17-19
    for (const subscription of Array.from(args.subscriptions.values())) {
      finishSharedControlSubscription(args.subscriptions, subscription, true, error)
    }
    return { timer: null, reconnectAttempt: args.reconnectAttempt }
  }
  return scheduleSharedControlReconnect(args)                    // :25
}
```

`scheduleSharedControlReconnect` is `remote-runtime-shared-control-state.ts:177-195`; it clamps the delay index at `:188`.

Key differences from the web client:

- **Bounded**: 7 attempts, then it hard-fails every subscription with `remoteRuntimeUnavailableError('Remote Pebble runtime connection could not be restored.')`. **This exhaustion point is the single cleanest hook for re-discovery in this transport.**
- Reconnect only happens if there are live subscriptions (`:265`).
- `scheduleReconnectAttemptReset()` (`:288-296`) resets `reconnectAttempt` after `reconnectStableResetMs ?? 30_000` of a stable open connection, via `scheduleSharedControlStableReset` (`remote-runtime-shared-control-stability.ts`).
- `this.pairing` is a constructor-captured `PairingOffer` (`:50`), used for `deviceToken` at `:232` and by `openSharedControlSocket`. It is `private readonly` — mutating the endpoint requires either making it mutable or an options callback.

`RemoteRuntimeSharedControlConnection` is currently only instantiated in `remote-runtime-shared-control-connection.test.ts`. No production call site was found in the tree — worth confirming before investing in this path.

### C. Tauri desktop path (the target)

```
runtime_environments_call        runtime_environments.rs:329-346
  └ runtime_environment_pairing_for_selector   :759-781   ← reads the store, fresh, every time
      └ call_remote_runtime      remote_runtime_rpc.rs:44-57   (tokio::time::timeout, 500..120_000 ms)
          └ call_remote_runtime_inner :59-95
              └ connect_authenticated_socket :222-258
                  └ connect_async(&pairing.endpoint) :229   ← the failure point
```

Same shape for `runtime_environments_subscribe` (`runtime_environments.rs:348-461` → `subscribe_remote_runtime_request`, `remote_runtime_rpc.rs:97-111`).

Renderer side:

- `pebble-tauri-runtime-control-api.ts:258-278` — `getStatus` and `call` catch the invoke rejection and convert it to `failRuntimeRpc('remote_runtime_unavailable', getErrorMessage(error))`. **No retry.**
- `apps/desktop/src/tauri-runtime-environment-subscription-api.ts:69` — emits `code: 'remote_runtime_unavailable'` on subscribe failure. No retry.
- `apps/desktop/src/runtime-poll-backoff.ts` (3 lines) — `nextRuntimePollDelay(currentMs, minMs, maxMs) => Math.min(maxMs, Math.max(minMs, currentMs * 2))`. Simple doubling, used by pollers, not by the remote-runtime dial path.
- `RuntimeEnvironmentsPane` drives `getStatus({ selector })` per row to render the connected/disconnected dot (`pebble-tauri-runtime-control-api.ts:258-274`), so a stale endpoint produces one failed dial per status refresh per saved server.

## How re-discovery should slot in

### Recommended: inside the Rust dial, one repair attempt per user-initiated call

Because the desktop transport re-reads the store on every call and has no backoff, the natural placement is a **single repair-and-retry inside `connect_authenticated_socket`'s caller**, not a loop:

```
connect fails
  └ classify (see tokio-tungstenite-error-taxonomy.md)
      ├ not "address moved"  → return the (now preserved) real error
      └ "address moved"      → if a repair was already attempted for this env within N seconds, return the real error
                               else browse mDNS with a short deadline (2–4 s)
                                 ├ no match      → return the real error
                                 └ match by public_key_b64
                                     ├ same address as stored → return the real error
                                     └ new address → write the store, retry connect ONCE, then return
```

Why this shape:

1. **It does not fight any backoff, because there is none on this path.** Each renderer-initiated call gets at most one repair.
2. **A per-environment cooldown is what prevents a storm**, not a delay ladder. Without it, a Settings pane with 5 saved servers polling `status.get` would launch 5 concurrent mDNS browses on every refresh. Suggested: an in-process `Mutex<HashMap<String /*env id*/, Instant>>` in Tauri managed state (same pattern as `RuntimeEnvironmentSubscriptionsState`, `runtime_environments.rs:124-132`), skipping re-discovery if the last attempt was < 30 s ago.
3. **The retry must be bounded to one**, or an environment whose runtime is genuinely down will do connect → browse → connect → browse forever inside the outer `timeout()` (`remote_runtime_rpc.rs:50-57`, default 15 s from `runtime_environments.rs:343`). Budget: the mDNS deadline plus one dial must fit inside `timeout_ms`. With a 15 s default and a 2–4 s browse that is fine; with the 500 ms floor (`.clamp(500, 120_000)`) it is not — so re-discovery should be skipped when the remaining budget is too small, or moved out of the timeout envelope entirely.
4. **The macOS 15 first-run denial** (see `platform-permissions-macos-windows.md`) means the *first* browse on a fresh install can return nothing while the Local Network alert is on screen. A single browse with a 2 s deadline will report "not found" in that case. Either use a longer first-attempt deadline or let the cooldown expire quickly on a "zero results, permission undetermined" outcome.

### Alternative / complementary: a `ServiceDaemon` kept warm

`mdns-sd::ServiceDaemon` is `Clone` and runs its own thread. Holding one in Tauri managed state and keeping a browse open would make re-discovery instant (read from cache) instead of costing a 2–4 s round trip. Trade-off: a permanently-open multicast socket, which is exactly what the macOS Local Network prompt and the Windows firewall rule are about — it makes the permission ask unavoidable at app start rather than lazy at failure time. Given the task says "**lazy** mDNS re-discovery", the cold-browse-on-failure shape is the right default; `ServiceDaemon::verify()` (RFC 6762 §10.4 cache-flush-on-failure) is the API to reach for if a warm daemon is later added.

### If the web / shared-control transports also need it

- **Web client**: hook at `web-runtime-client.ts:607` before computing the delay — but the web build cannot do mDNS from a browser at all, so this transport can only ever re-read a server-provided address. Out of scope.
- **Shared control**: hook at `remote-runtime-shared-control-reconnect.ts:16`, the exhaustion branch, *before* finishing the subscriptions with `remoteRuntimeUnavailableError`. Re-discover, and on success reset `reconnectAttempt` to 0 and `open()` again instead of failing. That keeps the whole delay ladder untouched and only changes what happens at the end of it. Requires `this.pairing` (`:50`) to become mutable.

### Don't break the Tailscale hint

`packages/product-core/shared/remote-runtime-tailscale-hint.ts` matches the literal phrase *"could not connect to the remote pebble runtime"* (case-insensitive) to decide whether to append a Tailscale suggestion. Preserving the underlying error at `remote_runtime_rpc.rs:231` must keep that prefix, or `web-runtime-client.ts:413`/`:568` silently stop hinting. Detail in `tokio-tungstenite-error-taxonomy.md`.

Related: `isTailscaleEndpoint()` in the same file already classifies endpoints as Tailscale CGNAT / MagicDNS / ULA. **A Tailscale endpoint should never trigger mDNS re-discovery** — a `100.64/10` or `*.ts.net` address is not going to be found on the local multicast segment, and the existing helper gives you the predicate for free.

## Files Found

| File Path | Description |
|---|---|
| `packages/product-core/shared/remote-runtime-shared-control-reconnect.ts` | 26 lines; bounded reconnect-or-give-up |
| `packages/product-core/shared/remote-runtime-shared-control-state.ts:177-195` | `scheduleSharedControlReconnect` — the timer itself |
| `packages/product-core/shared/remote-runtime-shared-control-connection.ts:262-296` | close handling, `scheduleReconnect`, stable-reset |
| `packages/product-core/shared/remote-runtime-shared-control-stability.ts` | `scheduleSharedControlStableReset` |
| `packages/product-core/renderer/src/web/web-runtime-client.ts:65,348-360,586-615` | web transport backoff |
| `apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs:44-57,97-111,222-258` | desktop dial path |
| `apps/desktop/src-tauri/src/commands/runtime_environments.rs:329-461,759-781` | desktop call/subscribe commands |
| `apps/desktop/src/pebble-tauri-runtime-control-api.ts:258-278` | renderer error surface for the desktop path |
| `apps/desktop/src/tauri-runtime-environment-subscription-api.ts:60-75` | subscribe error surface |
| `apps/desktop/src/runtime-poll-backoff.ts` | 3-line doubling helper (unrelated to dialing) |
| `packages/product-core/shared/remote-runtime-tailscale-hint.ts` | message-regex hint + `isTailscaleEndpoint` predicate |

## Caveats / Not Found

- No production instantiation of `RemoteRuntimeSharedControlConnection` was found — only tests. Confirm whether that class is live before designing around its exhaustion hook.
- The web client's reconnect is unbounded and the shared-control one is bounded at 7; that asymmetry is pre-existing and I did not find a doc explaining it.
- I did not trace how often `RuntimeEnvironmentsPane` refreshes `getStatus` per row (the `loadEnvironments` / details-refresh cadence), which determines how aggressive the re-discovery cooldown needs to be.
