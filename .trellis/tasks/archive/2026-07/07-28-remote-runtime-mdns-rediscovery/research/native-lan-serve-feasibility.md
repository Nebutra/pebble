# Research: Native LAN Serve Feasibility

- **Query**: What would it take for Pebble's own native runtime to be reachable from another machine on the LAN, so the user can stop using Orca entirely? Is the loopback bind a deliberate security boundary? What auth actually protects the endpoints?
- **Scope**: internal (Go runtime, Rust desktop, TS renderer, docs, specs, git history)
- **Date**: 2026-07-28

## Established facts (verified)

| Claim | Verified at |
|---|---|
| `pebble-control serve` hardcodes the loopback bind | `runtime/go/cmd/pebble-control/serve.go:70` — `listen := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))` |
| That string is passed to the runtime child | `serve.go:75` → `runtimeCommand(ctx, listen)` → `serve.go:199` / `:207` `exec.CommandContext(..., "--listen", listen)` |
| Runtime binds it verbatim | `runtime/go/internal/runtimehttp/server.go:2073` — `net.Listen("tcp", listen)` |
| `--pairing-address` only affects the *advertised* string | `serve.go:158` (flag), `serve.go:111` → `sharedControlEndpoint(...)` at `serve.go:323-355`; never reaches `listen` |
| `EndpointForListen` already maps wildcard → loopback | `runtime/go/internal/runtimeauth/credential.go:40-49` |
| Test exercises `"0.0.0.0:6768"` | `runtime/go/internal/runtimeauth/credential_test.go:86-92` (`TestEndpointForListenUsesLoopbackForWildcard`) |

Additional fact not in the brief: **the runtime binary itself already accepts any listen address.** `runtime/go/cmd/pebble-runtime/main.go:25` — `flag.String("listen", "127.0.0.1:17777", ...)`. Only the two *callers* hardcode loopback:

- `runtime/go/cmd/pebble-control/serve.go:70`
- `apps/desktop/src-tauri/src/commands/runtime_process.rs:481-483` — `fn default_listen_address() -> String { "127.0.0.1:17777".to_string() }`

---

## 1. Is the loopback bind deliberate or an unexamined default?

**Verdict: deliberate at the design/doc level, and load-bearing in code — but the surrounding product surface contradicts it, and there is no threat-model document.**

### Evidence FOR "deliberate security boundary"

**(a) The code names the trust model explicitly.** `runtime/go/internal/runtimehttp/server.go:2064-2071`:

```go
func StartWithOptions(ctx context.Context, listen string, manager *runtimecore.Manager, options ServerOptions) error {
	// Hook scripts refuse to post without a token, so mint one when the
	// runtime itself is running tokenless (localhost trust model).
```

and `server.go:2101-2103`:

```go
// randomAgentHookToken returns a fresh per-process hook ingest token. On the
// (practically impossible) rand failure it returns "", which keeps ingest in
// the same open localhost-trust mode as a tokenless bearer config.
```

"localhost trust model" / "open localhost-trust mode" is the codebase's own words. It is the justification for allowing a **fully tokenless runtime** (see §3).

**(b) The infra spec states the remote-access policy outright.** `docs/reference/infra-index.md:89-103`:

| Surface | Port | Bind |
|---------|------|------|
| Local `pebble-runtime` | **17777** | `127.0.0.1` |
| `pebble serve` / pairing | **6768** | `127.0.0.1` |

> Remote access is by SSH tunnel, not by exposing the local ports:
> ```bash
> ssh -L 17777:127.0.0.1:17777 user@host
> ssh -L 6768:127.0.0.1:6768 user@host
> ```

And `infra-index.md:141-145` lists under **Non-goals**: "Pairing / LAN discovery (tracked separately)."

**(c) The credential contract is loopback-only and tested.** `.trellis/spec/desktop-tauri/frontend/quality-guidelines.md:173-174`:

> The runtime publishes a **loopback endpoint** and token through an owner-only, atomically replaced credential file.

`quality-guidelines.md:182` (Validation & Error Matrix): "**Non-loopback endpoint -> reject credential.**"

Enforced at `runtimeauth/credential.go:56-58` (`Publish`) and `:150-157` (`isLocalEndpoint`), tested at `credential_test.go:78-84` (`TestPublishRejectsNonLoopbackEndpoint`).

### Evidence AGAINST / contradicting

**(d) Shipped documentation describes a LAN/public serve that cannot currently work.** `docs/reference/headless-linux-server.md:45-52`:

> For remote clients, pass the address they should use to reach this server.
> ```
> .../pebble-linux-x86_64.AppImage serve --port 6768 --pairing-address 100.64.1.20
> ```

`headless-linux-server.md:89-90`: "Replace `100.64.1.20` with the **LAN**, Tailscale, tunnel, or public hostname that clients should use."
`headless-linux-server.md:179-180` (Troubleshooting): "make sure **firewalls allow the selected `--port`**."

The firewall advice is meaningless against a `127.0.0.1` listener. This whole doc assumes a reachable bind.

**(e) The desktop UI already sells LAN reachability.** `packages/product-core/renderer/src/components/settings/RuntimePairingGeneratorForm.tsx:96-99`:

> "Advertise an address another device can reach — a **LAN** or Tailscale host, or a full ws(s):// URL."

and `apps/desktop/src/tauri-mobile-runtime-api.ts:103`:

```ts
const endpoint = `ws://${formatPairingHost(address)}:17777/v1/shared-control`
```

The desktop mints a pairing URL pointing at `ws://<LAN-IP>:17777` while the runtime is bound to `127.0.0.1:17777`. Same for the mobile QR flow (`docs/reference/2026-06-27-pebble-mobile-manual-network-address-design.md:9` — "manual LAN IP"; `docs/reference/plans/2026-06-27-pebble-mobile-manual-network-address.md:677` — "Use your LAN address for same-network pairing").

**(f) The wildcard bind was anticipated.** `EndpointForListen` (`credential.go:45-48`) special-cases `0.0.0.0` and `::`, and `credential_test.go:88` uses `"0.0.0.0:6768"` — port `6768` is the exact `pebble serve` port from the headless doc. Someone planned for a wildcard-bound `serve`.

### Commit history: silent

```
$ git log --oneline -S '127.0.0.1' -- runtime/go/cmd/pebble-control/serve.go
4b6a2d2c1 refactor: finish Tauri migration closure
```

`serve.go` has exactly one commit in its history (`git log --oneline -- runtime/go/cmd/pebble-control/serve.go`): `4b6a2d2c1 refactor: finish Tauri migration closure` (2026-07-22, squashed monolithic migration commit touching hundreds of files). **The commit message contains no rationale for the bind.** No design doc under `docs/` or `.trellis/spec/` discusses the runtime listen address as a security decision.

### Not found

- **No threat model document exists.** Grep across `docs/`, `.trellis/spec/`, `README.md`, `.github/` found no threat-model, security-model, or attack-surface file.
- No `SECURITY.md`, no security section in `AGENTS.md` / `CONTRIBUTING.md` covering the runtime listener.

**Summary answer:** The infra spec (`infra-index.md:98`) and the in-code "localhost trust model" comments (`server.go:2065`, `:2103`) are real, explicit, deliberate statements that loopback is the boundary. But there is **no threat model**, no commit-level rationale, and the docs/UI for `serve`, mobile pairing, and server sharing were all written assuming a reachable bind. The best characterization: **a deliberate boundary that the product has since outgrown, never revisited, and now silently contradicts.**

---

## 2. What actually protects `/v1/shared-control`?

### Request path

`server.go:71-83`:

```go
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.localhostLabels.serve(w, r) {   // :72  ← runs BEFORE auth
		return
	}
	if !s.authorize(r) {                  // :75
		writeError(w, http.StatusUnauthorized, "missing or invalid bearer token")
		return
	}
	if s.relayRemoteProviderRequest(w, r) { // :79
		return
	}
	s.mux.ServeHTTP(w, r)                 // :82
}
```

`server.go:85-105` — `authorize` **explicitly exempts the shared-control WebSocket**:

```go
	if r.URL.Path == "/v1/shared-control" && isWebSocketUpgrade(r) {
		return true                       // :92-94
	}
```

So the bearer token does **not** guard the socket; the handler owns its own auth.

### The handshake — `legacy_shared_control.go:122-184`

1. `handleLegacySharedControl` (`:122`) upgrades (`:127`), loads the server's long-lived NaCl box keypair (`:133` `EnsureLegacySharedControlIdentity`), then calls `authenticateLegacySharedControl` (`:141`).
2. `authenticateLegacySharedControl` (`:149-184`):
   - reads `{"type":"e2ee_hello","publicKeyB64":...}` (`:150-157`)
   - `deriveLegacySharedControlKey` (`:158`) → `legacy_shared_control_crypto.go:13-23` → `box.Precompute(&shared, &clientPublicKey, serverSecretKey)` = **X25519 + HSalsa20**, i.e. NaCl `crypto_box_beforenm`
   - replies `{"type":"e2ee_ready"}` (`:159`)
   - reads and decrypts an `e2ee_auth` frame (`:162-174`) — XSalsa20-Poly1305, `crypto.go:34-46`
   - `s.manager.ValidateLegacySharedControlToken(auth.DeviceToken)` (`:175`)
   - on success replies `e2ee_authenticated` (`:180`)
3. Per-request re-check: `legacy_shared_control.go:215-218` — if a request carries a `deviceToken` it must equal `device.Token`, else `"unauthorized"`.

### Answers to the sub-questions

- **Is `deviceToken` checked on every connection?** Yes — once per connection at `legacy_shared_control.go:175`, before any RPC dispatch. Per-request it is re-checked only if present (`:215`); the connection-level identity is authoritative.
- **Is there a Curve25519 challenge/response?** **No.** There is a Curve25519 (X25519) **key agreement**, but no challenge/response and **no proof of client key possession**. The server does DH with *whatever* public key the client sends, so any anonymous client gets a working session key. Client→server authentication is **solely the bearer-style `deviceToken`**. Server→client authentication is implicit: the client got the server's `publicKeyB64` in the pairing offer (`serve.go:117-120`, `pairingOffer.PublicKeyB64`) and will fail to decrypt if it talks to an impostor.
- **Is there transport encryption?** Yes, application-layer NaCl box over plaintext `ws://` (not `wss://`). No TLS. The advertised scheme is `ws://` (`serve.go:354`, `tauri-mobile-runtime-api.ts:103`). The E2EE layer covers frame payloads; WebSocket metadata, timing, and sizes are in the clear.
- **Token strength:** `runtime/go/internal/runtimecore/legacy_shared_control.go:93` — `randomLegacySharedControlHex(24)` = 24 crypto-random bytes (192 bits). Not brute-forceable.
- **Weaknesses in the check:** `runtimecore/legacy_shared_control.go:106-115` — `ValidateLegacySharedControlToken` uses plain `device.Token == token` (**not** `subtle.ConstantTimeCompare`, unlike `server.go:104` and `agent_hook_routes.go:59`). Timing side channel; low practical risk over a network + NaCl decrypt, but it is an inconsistency. There is **no rate limiting, no lockout, no connection cap, and no failed-attempt logging** anywhere in the handshake.
- **No `Origin` check on any WebSocket upgrade.** `runtime/go/internal/runtimehttp/websocket_frames.go:35-67` validates only method, `Upgrade`/`Connection`, `Sec-WebSocket-Version: 13`, and `Sec-WebSocket-Key`. Browsers allow cross-origin WS, so any web page the user visits can already open `ws://127.0.0.1:17777/v1/shared-control` today (it still needs a `deviceToken`, so this is a DoS/probe surface, not RCE — but LAN binding widens it to DNS-rebinding-style attacks against `/v1/*`).

### What an unauthenticated LAN attacker could do if `0.0.0.0`-bound

Against `/v1/shared-control` **alone**: nothing without a `deviceToken`. That endpoint's auth is sound.

**The danger is not `/v1/shared-control`.** See §3.

### Capability granted by a *stolen* `deviceToken` (for calibration)

An authenticated shared-control peer gets full host control. Method dispatch (grepped from `legacy_shared_control*.go`) includes:

- `terminal.create` → `legacy_shared_control.go:1903` — `Command: params.Command` passed straight to `runtimecore.StartSessionRequest` = **arbitrary process execution with arbitrary env** (`Environment: params.Environment`)
- `terminal.send`, `terminal.read`, `terminal.subscribe` — read/write any PTY
- `files.read`, `files.write`, `files.delete`, `files.rename`, `files.copy`, `files.listAll`, `files.search`, `files.commitUpload` — arbitrary filesystem access
- `repo.clone`, `repo.add`, `repo.rm`, `worktree.create`, `worktree.rm`
- `github.*` / `gitlab.*` (≈60 methods) — act as the user via stored provider credentials
- `aiVault.listSessions`, `storage.local.get/set`, `accounts.list`, `provider.list/register`
- `browser.*`, `cookie.get/set/clear`, `intercept.*` — drive the managed browser and read its cookies
- `emulator.*`, `host.platform`, `preflight.*`

So the shared-control device token is effectively **root-on-the-dev-box**. Its 192-bit entropy and the pairing-URL-only distribution are the whole defense.

---

## 3. `PEBBLE_RUNTIME_TOKEN` vs. `deviceToken` — and the endpoints with no auth at all

### They are two entirely separate credentials

| | `PEBBLE_RUNTIME_TOKEN` (bearer) | shared-control `deviceToken` |
|---|---|---|
| Minted by | desktop renderer `apps/desktop/src/local-runtime-auth.ts:1-27` (2× `crypto.randomUUID()`, 64 hex chars, persisted in `localStorage`); passed to Rust as `bearer_token` (`runtime_process.rs:62`) and injected as env at `runtime_process.rs:381-383` | runtime manager, `runtimecore/legacy_shared_control.go:92-96` (`randomLegacySharedControlHex(24)`) |
| Consumed at | `pebble-runtime/main.go:27` → `ServerOptions.BearerToken` (`main.go:57-58`) → `server.go:56` | stored in `Manager.legacySharedControl.Devices` |
| Guards | every `/v1/*` REST route via `server.go:100-104` (`subtle.ConstantTimeCompare`), plus `/hook/` by default (`server.go:49-52`) | the `/v1/shared-control` WebSocket only (`legacy_shared_control.go:175`) |
| Distributed via | owner-only `~/.pebble/runtime-credential.json`, mode `0600`, loopback-endpoint-only (`runtimeauth/credential.go:51-105`) | `pebble://pair?code=<base64>` URL / QR (`serve.go:357-363`) |

`/v1/shared-control/pairing` (POST, which **mints** device tokens) is a normal mux route (`server.go:338`), so it is guarded by the **bearer** token. Bearer → can mint unlimited device tokens.

### The real risk: endpoints with no auth check because "only localhost can reach us"

**(1) `PEBBLE_RUNTIME_TOKEN` is empty in the `pebble serve` path — so *everything* is unauthenticated.**

`runtime/go/cmd/pebble-control/main.go:45-56`:

```go
func resolveRuntimeAuth(endpoint, token string, endpointExplicit, serving bool) (string, string) {
	...
	if serving || token != "" {
		return endpoint, token      // :48-50 — serving short-circuits; token stays ""
	}
	credential, err := runtimeauth.Discover(...)
	...
}
```

`main.go:36` passes `args[0] == "serve"` as `serving`. So `pebble serve` with no `--token` and no `PEBBLE_RUNTIME_TOKEN` env yields `token == ""`. Then `serve.go:82-86`:

```go
	if token != "" {
		command.Env = append(os.Environ(), "PEBBLE_RUNTIME_TOKEN="+token)
	}
```

…so the child gets no token, `ServerOptions.BearerToken == ""`, and `server.go:85-88`:

```go
func (s *Server) authorize(r *http.Request) bool {
	if s.bearerToken == "" {
		return true            // ← every route, every method
	}
```

**Every documented `pebble serve` invocation in `docs/reference/headless-linux-server.md` (lines 42, 49-52, 81, 140) omits the token.** Today the loopback bind is the *only* thing standing between an attacker and:

- `POST /v1/sessions` (`server.go:135`, handler `server.go:585-596`) → `StartSession` with attacker-supplied `Command` = **unauthenticated remote code execution**
- `POST /v1/files/write`, `/v1/files/read`, `/v1/files/delete` (`server.go:188-206`) = arbitrary filesystem read/write
- `POST /v1/shared-control/pairing` (`server.go:338`) = mint a permanent device token for yourself
- `/v1/projects/clone`, `/v1/worktrees`, `/v1/ssh-targets` (`server.go:260-262`), `/v1/ai-vault`, `/v1/providers`, `/v1/settings`, `/v1/automations`, ~200 routes total (`server.go:107-346`)

**This is the single most important finding. Changing the bind without first making the token mandatory converts a local-only design into unauthenticated LAN RCE.**

**(2) The localhost-label reverse proxy runs *before* `authorize` — unauthenticated by construction.**

`server.go:72-74` calls `s.localhostLabels.serve(w, r)` first. `localhost_label_proxy.go:53-72`:

```go
func (proxy *localhostLabelProxy) serve(w http.ResponseWriter, r *http.Request) bool {
	host := strings.ToLower(r.Host)
	...
	if !strings.HasSuffix(host, localhostLabelSuffix) {   // ".pebble.localhost"
		return false
	}
	label := strings.TrimSuffix(host, localhostLabelSuffix)
	registered := proxy.routes[label]
	if registered == nil { http.Error(w, "Unknown Pebble localhost label.", 404); return true }
	registered.ServeHTTP(w, r)                            // :70 — no auth, ever
	return true
}
```

An attacker sends `Host: <label>.pebble.localhost` and is proxied to any registered dev server. Labels are guessable — `localhostWorktreeLabel` (`localhost_label_proxy.go:222-237`) slugifies the project/worktree name, and 404-vs-200 gives a free oracle to enumerate them. Worse, registered routes can point at **SSH-forwarded remote ports** (`localhost_label_proxy.go:90-104` → `EnsureSshLocalhostLabelForward`), so a LAN attacker would reach services on the user's *remote* hosts through the tunnel. Registration itself (`/v1/localhost-worktree-labels/register`, `server.go:163`) is bearer-guarded — but see (1): the bearer is often empty.

**(3) `/hook/*` — token bypass with a "localhost trust" fallback.**

`server.go:95-99` exempts `/hook/` from the bearer gate; `agent_hook_routes.go:51-54`:

```go
func (s *Server) authorizeAgentHook(r *http.Request) bool {
	if s.hookToken == "" {
		return true
	}
```

`StartWithOptions` mints a random hook token when none is configured (`server.go:2067-2072`), so in practice `hookToken != ""` — **except** if `rand.Read` fails, where `randomAgentHookToken` returns `""` (`server.go:2104-2109`) and the comment says this "keeps ingest in the same open localhost-trust mode." A LAN-bound runtime would let anyone forge agent-status/hook events (UI state poisoning, not RCE).

**(4) `/v1/mobile-relay` WebSocket — bypasses the bearer gate.**

`server.go:89-91`. Pre-pairing messages allowed: `crypto.handshake`, `client.hello`, `pair.start` (`mobile_relay_socket.go:194-201`). `pair.start` → `PairMobileRelayDevice` (`runtimecore/mobile_relay.go:455-471`) requires a live, unexpired pairing code, so it is not an open door — but while the user has a QR displayed, a LAN attacker racing for the code would get a permanent `pairingSecretRef`. `client.hello` and `crypto.handshake` are reachable pre-auth and unrated-limited.

**(5) No handler anywhere inspects the peer address.** `grep -rn "RemoteAddr" runtime/go/ --include="*.go"` → **zero matches**. Nothing enforces loopback at request level; the bind is the *entire* enforcement.

**(6) No HTTP server timeouts.** `server.go:2082` — `&http.Server{Handler: ...}` with no `ReadHeaderTimeout` / `ReadTimeout` / `IdleTimeout`. Fine on loopback, Slowloris-exposed on a LAN.

---

## 4. Intended remote-access story

**Documented, in priority order:**

1. **SSH tunnel — the stated policy.** `docs/reference/infra-index.md:98-103`: "Remote access is by SSH tunnel, not by exposing the local ports", with concrete `ssh -L` lines for both 17777 and 6768.
2. **Tailscale — the recommended overlay.** `docs/reference/headless-linux-server.md:45-52`: "A Tailscale address is usually the safest option for private servers."
3. **LAN — mentioned but never given a listener.** `headless-linux-server.md:89-90` and the mobile/pairing UIs (`RuntimePairingGeneratorForm.tsx:98`, mobile QR design doc) offer LAN addresses as *advertised* values only.

**Does `remote-runtime-tailscale-hint.ts` imply Tailscale is the supported path?**

Partly — but read carefully it argues **against** "raw LAN is deliberately unsupported". `packages/product-core/shared/remote-runtime-tailscale-hint.ts:60-79`:

```ts
export function withRemoteRuntimeTailscaleHint(message, endpoint): string {
  if (!REMOTE_RUNTIME_UNREACHABLE_RE.test(message)) { return message }   // :64
  ...
  if (isTailscaleEndpoint(endpoint)) {                                   // :72
    return `${message} The server may be offline on your tailnet, ...`
  }
  return `${message} If the server is on another network, connect both devices to
    Tailscale and pair using its Tailscale address (100.x or a *.ts.net name). ...`  // :79
}
```

The fallback branch fires only "**If the server is on another network**". It is a *remedy hint for unreachable endpoints*, not a policy statement, and it is scoped narrowly by `REMOTE_RUNTIME_UNREACHABLE_RE` (`:14-15`) to connection failures — auth/protocol errors pass through untouched (`:12-13`). It presumes same-network (LAN) already works; Tailscale is offered for the cross-network case.

Combined with `infra-index.md:145` listing "Pairing / LAN discovery" as a **tracked-separately non-goal**, the honest reading is: **SSH tunnel is the enforced path, Tailscale is the recommended overlay, and LAN was punted — not rejected.**

---

## 5. What breaks if we add `--listen-address` (loopback default, LAN opt-in)

### Hard breaks

**(a) `runtimeauth.Publish` rejects a specific non-loopback endpoint → process exits.**

`runtime/go/cmd/pebble-runtime/main.go:37-45`:

```go
endpoint, err := runtimeauth.EndpointForListen(*listen)   // :37
...
cleanupCredential, err := runtimeauth.Publish(*dataDir, endpoint, *token)  // :42
if err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }                 // :43-45
```

`credential.go:56-58` → `isLocalEndpoint` (`:150-157`) accepts only `127.0.0.1` / `localhost` / `::1`.

- `--listen 0.0.0.0:17777` → `EndpointForListen` (`credential.go:45-47`) rewrites to `http://127.0.0.1:17777` → **Publish succeeds**, credential file stays loopback. Works.
- `--listen 192.168.1.5:17777` → endpoint is `http://192.168.1.5:17777` → **`Publish` errors → `os.Exit(1)`**. Runtime never starts (only when a token is set; `Publish` early-returns for `token == ""` at `credential.go:53-55` — so the tokenless path silently survives, which is worse).
- Also `Discover` re-validates (`credential.go:129`), so a hand-written non-loopback credential is rejected by the CLI.
- Guarded by spec (`quality-guidelines.md:182`) and test (`credential_test.go:78-84`), so relaxing it is a spec change, not just a code change.

→ **Design implication:** the flag should accept a wildcard/interface bind while keeping the *published credential* on loopback (the `EndpointForListen` wildcard mapping is already the intended mechanism). Do not publish a LAN endpoint into the credential file.

**(b) `waitForRuntime` builds its probe URL from the listen string.**

`serve.go:70-71`:

```go
listen := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
runtimeHTTP := "http://" + listen
```

`serve.go:93` → `waitForRuntime(ctx, client, runtimeHTTP, token, wait)` → `serve.go:266` `GET {endpoint}/v1/status`. With `listen = "0.0.0.0:6768"` the probe becomes `http://0.0.0.0:6768/v1/status`, which resolves to localhost on Linux/macOS but **fails on Windows** (`0.0.0.0` is not a valid connect target on Winsock). `serve.go:99` also returns that string as the user-facing `serveResult.Endpoint`.

→ Must decouple: keep a loopback `runtimeHTTP` for the readiness probe and for `requestPairing` (`serve.go:105`, `:296`), while passing the wildcard string only to `runtimeCommand` (`serve.go:75`).

**(c) `reserveLoopbackPort` picks a free port on loopback only.**

`serve.go:251-258` — `net.Listen("tcp", "127.0.0.1:0")`. A port free on loopback may be occupied on a LAN interface. Only matters for `--port 0`; low risk, but the reservation should match the requested bind.

**(d) The Rust desktop path also hardcodes loopback.** `apps/desktop/src-tauri/src/commands/runtime_process.rs:481-483` (`default_listen_address`). If the flag is meant to reach the desktop's managed runtime too, `RuntimeProcessInput` needs a listen field plumbed through `runtime_process_args` (`runtime_process.rs:305`) and its tests (`:517-553`).

### Does NOT break

**(e) Localhost-label proxy — safe mechanically, dangerous by policy.** `localhost_label_proxy.go:164-170` derives the label URL from `r.Host`'s port, not from the bind, so labels keep working. `parseLocalhostLabelTarget` (`:173-185`) already normalizes `0.0.0.0` → `127.0.0.1` for *targets*. **But** the proxy remains pre-auth (`server.go:72`) — see §3(2). A `--listen-address` flag without also moving `localhostLabels.serve` behind `authorize` (or scoping it to loopback peers) hands the LAN an open reverse proxy into dev servers and SSH-forwarded remote ports.

**(f) SSH port forwards — unaffected.** `runtime/go/internal/runtimecore/ssh_port_forwards.go:82` binds the local end of each forward at `127.0.0.1:0`, and `:233` builds `ssh -L 127.0.0.1:<local>:<remote-host>:<remote-port>`. Those stay loopback regardless of the runtime bind; `:105` (`case "localhost", "127.0.0.1", "0.0.0.0", "::1", "::"`) is target-side normalization. **However** these loopback-only forwards become reachable *indirectly* via the label proxy (e), which is the amplification path.

**(g) Advertised-endpoint plumbing.** `sharedControlEndpoint` (`serve.go:323-355`) is already fully address-agnostic, and `parseServeOptions` (`serve.go:153-193`) has no coupling between `--pairing-address` and the bind. Adding `--listen-address` is additive there.

**(h) Desktop/renderer transport.** `apps/desktop/src/pebble-tauri-runtime-transport.ts` and `pebble-tauri-runtime-control-api.ts` contain no `127.0.0.1` / `localhost` literals; they read the endpoint from config. No breakage.

### Prerequisites before the bind is safe to change

Ordered by severity:

1. **Make the bearer token mandatory whenever the bind is non-loopback.** `resolveRuntimeAuth` (`pebble-control/main.go:45-56`) must stop returning `""` for `serve`, or `serve.go` must auto-mint a token, or `StartWithOptions` must refuse a tokenless non-loopback bind. Without this, §3(1) is unauthenticated RCE.
2. **Move `localhostLabels.serve` behind `authorize`, or restrict it to loopback peers** (`server.go:72`). Currently pre-auth.
3. **Fail closed on `hookToken == ""`** for non-loopback binds (`agent_hook_routes.go:52-54`, `server.go:2104-2109`).
4. **Add an `Origin` / `Host` check to `upgradeWebSocket`** (`websocket_frames.go:35-67`) — none exists today, so DNS-rebinding reaches `/v1/shared-control` and `/v1/mobile-relay`.
5. **Add HTTP server timeouts** (`server.go:2082`).
6. **Use `subtle.ConstantTimeCompare` in `ValidateLegacySharedControlToken`** (`runtimecore/legacy_shared_control.go:110`) for consistency with `server.go:104`.
7. **Add rate limiting / connection caps** on both WebSocket handshakes — none exist.
8. **Keep the published credential loopback-only** (`credential.go:56-58`) — rely on the existing `EndpointForListen` wildcard mapping (`:45-47`) rather than relaxing `isLocalEndpoint`.
9. **Decide on transport encryption.** Shared-control has NaCl E2EE over `ws://`; the plain REST surface (`/v1/*`) would be **cleartext HTTP on the LAN**, including bearer tokens in `Authorization` headers, file contents, and provider credentials.
10. **Reconcile the docs.** `infra-index.md:98` ("Remote access is by SSH tunnel, not by exposing the local ports") and `infra-index.md:145` (LAN discovery = non-goal) would have to be amended; `headless-linux-server.md` would finally match reality.

---

## Files Found

| File Path | Relevance |
|---|---|
| `runtime/go/cmd/pebble-control/serve.go` | `:70` loopback bind; `:75` child listen; `:82-86` token env; `:93` readiness probe; `:111`/`:323-355` advertised endpoint; `:158` `--pairing-address`; `:251-258` port reservation |
| `runtime/go/cmd/pebble-control/main.go` | `:21` token flag; `:45-56` `resolveRuntimeAuth` — `serve` keeps an empty token |
| `runtime/go/cmd/pebble-runtime/main.go` | `:25` `--listen` already free-form; `:27` token; `:37-45` `EndpointForListen`+`Publish`→`os.Exit(1)`; `:57-58` `BearerToken` |
| `runtime/go/internal/runtimehttp/server.go` | `:71-83` `ServeHTTP` order; `:85-105` `authorize` + all bypasses; `:107-346` route table; `:585-596` `/v1/sessions` POST → `StartSession`; `:2064-2073` `StartWithOptions` + "localhost trust model"; `:2082` no timeouts; `:2101-2109` hook-token fallback |
| `runtime/go/internal/runtimehttp/legacy_shared_control.go` | `:122-147` WS handler; `:149-184` deviceToken handshake; `:215-218` per-request check; `:1903` `Command: params.Command` |
| `runtime/go/internal/runtimehttp/legacy_shared_control_crypto.go` | `:13-23` X25519 `box.Precompute`; `:25-67` XSalsa20-Poly1305 frames |
| `runtime/go/internal/runtimehttp/localhost_label_proxy.go` | `:53-72` pre-auth reverse proxy; `:74-117` register (bearer-gated); `:90-104` SSH-forward targets; `:222-237` guessable labels |
| `runtime/go/internal/runtimehttp/mobile_relay_socket.go` | `:87-139` socket; `:194-201` pre-pairing message allowlist; `:267-313` `client.hello` / `pair.start` |
| `runtime/go/internal/runtimehttp/agent_hook_routes.go` | `:48-60` hook-token auth, `:52-54` empty-token fallthrough |
| `runtime/go/internal/runtimehttp/websocket_frames.go` | `:30-67` upgrade — **no Origin/Host validation** |
| `runtime/go/internal/runtimeauth/credential.go` | `:40-49` `EndpointForListen` wildcard mapping; `:51-105` `Publish`; `:150-157` `isLocalEndpoint` |
| `runtime/go/internal/runtimeauth/credential_test.go` | `:78-84` rejects non-loopback; `:86-92` wildcard→loopback |
| `runtime/go/internal/runtimecore/legacy_shared_control.go` | `:60-104` pairing mint; `:93` 24-byte token; `:106-115` non-constant-time compare |
| `runtime/go/internal/runtimecore/mobile_relay.go` | `:455-499` `PairMobileRelayDevice` code consumption |
| `runtime/go/internal/runtimecore/ssh_port_forwards.go` | `:82` loopback forward bind; `:105` target normalization; `:233` `ssh -L` string |
| `apps/desktop/src-tauri/src/commands/runtime_process.rs` | `:381-383` `PEBBLE_RUNTIME_TOKEN` env; `:481-483` `default_listen_address` |
| `apps/desktop/src/local-runtime-auth.ts` | `:1-27` bearer token minting/persistence |
| `apps/desktop/src/tauri-mobile-runtime-api.ts` | `:83-112` pairing material; `:103` `ws://<addr>:17777/v1/shared-control` |
| `packages/product-core/shared/remote-runtime-tailscale-hint.ts` | `:12-15` unreachable-only gating; `:60-79` hint text |
| `packages/product-core/renderer/src/components/settings/RuntimePairingGeneratorForm.tsx` | `:96-99` "LAN or Tailscale host" copy |
| `packages/product-core/renderer/src/components/settings/RuntimePairingUrlGenerator.tsx` | `:10` `LOOPBACK_ADDRESS` default; `:175-232` generate flow |

## Related Specs & Docs

- `.trellis/spec/desktop-tauri/frontend/quality-guidelines.md:160-197` — runtime-auth contract; `:173-174` loopback endpoint; `:182` "Non-loopback endpoint -> reject credential"
- `docs/reference/infra-index.md:89-103` — port/bind table and SSH-tunnel policy; `:141-145` non-goals incl. "Pairing / LAN discovery"
- `docs/reference/headless-linux-server.md:42-52, 79-98, 179-180` — `pebble serve` remote guidance assuming a reachable bind
- `docs/reference/2026-06-27-pebble-mobile-manual-network-address-design.md` and `docs/reference/plans/2026-06-27-pebble-mobile-manual-network-address.md:677` — LAN/Tailscale address entry for mobile QR

## Caveats / Not Found

- **No threat model exists.** No `SECURITY.md`, no security-model doc under `docs/` or `.trellis/spec/`. §1's conclusion rests on the `infra-index.md:98` policy line, the `server.go:2065`/`:2103` "localhost trust model" comments, and the tested `credential.go` loopback constraint — nothing more explicit.
- **Git history is uninformative.** `serve.go` exists in exactly one commit (`4b6a2d2c1`, a squashed Tauri-migration commit) with no bind rationale in the message.
- I did not exhaustively audit all ~200 mux routes in `server.go:107-346` for handler-level auth; the analysis relies on the single choke point at `server.go:75` plus the four enumerated bypasses (`:89-99`) and the pre-auth proxy (`:72`). Spot checks (`/v1/sessions`, `/v1/files/*`, `/v1/shared-control/pairing`) found no additional per-handler auth.
- The full shared-control RPC method table was enumerated by grepping `case "…"` across `legacy_shared_control*.go`; a few methods may be dispatched via maps or helper indirection and thus missed.
- I did not run the Go test suite or attempt an actual non-loopback bind; the break analysis in §5 is read-only static tracing.
