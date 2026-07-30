# Research: LAN pairing — upstream Orca vs. this fork

- **Query**: Is LAN pairing broken because this fork changed it, or because of how it's being used?
- **Scope**: mixed (fork source + upstream Orca source recovered from git history + live upstream repo via `gh api` + official Orca docs on the web)
- **Date**: 2026-07-28

## TL;DR

**The fork changed it.** Upstream Orca binds its pairing WebSocket to `0.0.0.0:6768` (verified in this repo's own git history at the fork baseline **and** at upstream `HEAD` today). Pebble's Tauri/Go rewrite replaced that with a hard `127.0.0.1` bind, and kept the upstream address-picker UI, the upstream `--pairing-address` flag, and the upstream headless-server doc verbatim — all of which were written assuming a wildcard bind.

**But that does not explain the user's failure**, because in the reported scenario the *server* is the released upstream Orca app on Air, which does bind `0.0.0.0`. The fork's loopback bind is only decisive when **Pebble is the server**. For the Orca-as-server case, the fault is elsewhere (candidates in §6, none confirmed by observation).

Correcting a claim in the sibling research file `native-lan-serve-feasibility.md:100-108` ("Commit history: silent"): the history is *not* silent — the entire pre-fork Orca Electron implementation is reachable in this repo, and it answers the bind question directly. See §2.

---

## 1. Upstream Orca binds `0.0.0.0`, not loopback

### Upstream source is available in this repo

`config/upstream-sync/state.json` names the upstream repo (`github.com` / `stablyai` / `"or"+"ca"`) and pins `forkBaseline.commit = dacb84bbb5e2f17ce8a7dc02017663a7e395570e` (tag `v1.4.124-rc.8`). That commit **is an ancestor of `HEAD`**:

```
$ git merge-base --is-ancestor dacb84bbb5e2f17ce8a7dc02017663a7e395570e HEAD && echo YES
YES
$ git log --oneline | wc -l
6178
$ git log --oneline --reverse | head -5
224ab0b14 Initial commit
...
483118e9d orca icon smallish
```

So upstream Orca's full Electron tree (`src/main/**`, `src/renderer/**`, `mobile/**`) can be read with `git show dacb84b…:<path>`.

### The bind, at the fork baseline

`src/main/runtime/runtime-rpc.ts` (upstream, at `dacb84b…`):

```ts
const DEFAULT_WS_PORT = 6768                                    // :29

    if (this.enableWebSocket) {                                 // :694
        const wsTransport = new WebSocketTransport({
          host: '0.0.0.0',                                      // :700
          port: this.wsPort,
          staticRoot: this.webClientRoot
        })
        ...
        transportsMeta.push({
          kind: 'websocket',
          endpoint: `ws://0.0.0.0:${wsTransport.resolvedPort}`   // :788
        })
```

`src/main/runtime/rpc/ws-transport.ts:182` (upstream, at `dacb84b…`) — `this.host` is that `'0.0.0.0'`:

```ts
      httpServer.listen(port, this.host, () => { ... })
```

`enableWebSocket` is **always on in the packaged app** — `src/main/index.ts:2020` passes `enableWebSocket: true` unconditionally (the `= false` at `runtime-rpc.ts:431` is only the constructor default used by tests).

Upstream's *only* loopback-ish transport is the **Unix domain socket** for the local CLI (`runtime-rpc.ts:~662`, "the existing security model for CLI connections — the token lives in a `0o600`-permissioned file"). There is no loopback TCP listener in the pairing path.

### The bind, at upstream HEAD today

Fetched live (repo is public, 31.2k stars, not archived):

```
$ gh api repos/stablyai/orca/contents/src/main/runtime/runtime-rpc.ts | base64 -d | grep -n "0\.0\.0\.0\|DEFAULT_WS_PORT"
50:const DEFAULT_WS_PORT = 6768
929:            host: '0.0.0.0',
994:            endpoint: `ws://0.0.0.0:${wsTransport.resolvedPort}`

$ gh api repos/stablyai/orca/contents/src/main/runtime/rpc/ws-transport.ts | base64 -d | grep -n "listen("
179:      httpServer.listen(port, this.host, () => {
```

**Unchanged.** Upstream still binds all interfaces on 6768.

### Why the picker is advertise-only *upstream* — and why that's correct there

`src/main/ipc/mobile.ts:14-17` (upstream, at `dacb84b…`) states the design in one comment:

```ts
// Why: the WebSocket transport advertises 0.0.0.0 as its endpoint, which isn't
// connectable from a mobile device. We enumerate all non-internal IPv4
// addresses so the user can choose which one to advertise in the QR code
// (e.g. LAN vs Tailscale).
function getNetworkInterfaces(): NetworkInterface[] { ... }
```

and `:32` sorts tailnet addresses first (`isTailnetIPv4Address`). The picker is *only* an advertising choice **because the socket is already listening on every interface**. Upstream's `--pairing-address` is likewise advertise-only (`src/cli/specs/serve.ts:22`: "Use `--pairing-address` when clients should connect through a LAN, Tailscale, SSH-forward, or public tunnel address") — and it is coherent there.

Note also upstream's `--port` semantics: `src/cli/runtime/launch.ts` forwards `--port` → `--serve-port` → `src/main/index.ts:1320-1330` → `wsPort` → the **`0.0.0.0`-bound** WS transport. Upstream's `serve --port 6768` really does open a LAN-reachable port.

---

## 2. Yes — the loopback bind is a fork regression, introduced in the Tauri/Go rewrite

Two squashed migration commits removed the Node WS transport and introduced the Go runtime:

```
$ git log --all --oneline --diff-filter=D -- src/main/runtime/rpc/ws-transport.ts
dc9657e5f refactor: complete Tauri repository migration

$ git log --all --oneline --diff-filter=A -- runtime/go/internal/runtimehttp/server.go
6d4078174 chore: complete Pebble migration

$ git log --all --oneline -S'127.0.0.1' -- runtime/go/cmd/pebble-control/serve.go
4b6a2d2c1 refactor: finish Tauri migration closure
```

None of the three commit messages give a rationale for narrowing the bind. Post-migration state in this fork:

| Concern | Upstream Orca | This fork |
|---|---|---|
| Pairing socket bind | `0.0.0.0` (`runtime-rpc.ts:700`, `ws-transport.ts:182`) | `127.0.0.1` (`runtime/go/cmd/pebble-control/serve.go:70` → `runtime/go/internal/runtimehttp/server.go:2073`) |
| Default port | 6768 (`runtime-rpc.ts:29`) | 17777 (`serve.go:150`, `apps/desktop/src/local-runtime-endpoint.ts:1`) |
| `serve --port` means | the LAN-reachable WS port | the loopback HTTP port |
| `--pairing-address` | advertise-only, over a wildcard bind | advertise-only, over a loopback bind (`serve.go:158` → `sharedControlEndpoint` `:111`, `:322`) |
| Transport split | Unix socket (CLI) + TCP WS (remote) | one TCP listener for both |
| Interface enumeration | all non-internal IPv4, tailnet-first (`ipc/mobile.ts:18-33`) | one "Default route" address only (`apps/desktop/src-tauri/src/commands/network_interfaces.rs:12-28`) |

The fork additionally made the loopback constraint an **enforced invariant** on the desktop path — `apps/desktop/src/local-runtime-endpoint.ts:15-19`:

```ts
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
    // Why: the desktop-owned runtime has local-machine authority and must never
    // become reachable from another host through a build-time override.
    throw new Error('Pebble runtime URL must use HTTP on a loopback host.')
  }
```

So this is not an unexamined default at the desktop layer; it is an asserted boundary that diverges from upstream. (The Go `serve` path at `serve.go:70` has no comparable comment.)

---

## 3. The desktop/GUI path (the user's actual flow): advertise-only over a loopback socket

Full trace of "Settings → Runtime Environments → Share this Pebble server":

1. **Address picker** — `packages/product-core/renderer/src/components/settings/RuntimePairingUrlGenerator.tsx:10` (`LOOPBACK_ADDRESS = '127.0.0.1'`), `:20` (default selection), `:352-353` (passes `loopbackAddress` + `networkInterfaces` to the form). Interfaces come from `apps/desktop/src/tauri-mobile-runtime-api.ts:31-34` → Tauri command `network_list_interfaces`.
2. **Interface enumeration** — `apps/desktop/src-tauri/src/commands/network_interfaces.rs:12-28` returns **at most one** entry, labelled `"Default route"`, derived from a UDP-connect route probe to `1.1.1.1:80`. It does not enumerate `en0`/`utun*`/etc. the way upstream's `ipc/mobile.ts:18-33` does.
3. **Offer construction** — `apps/desktop/src/tauri-mobile-runtime-api.ts:83-112`. The chosen address is interpolated into the endpoint string and **nothing else**:

```ts
  const endpoint = `ws://${formatPairingHost(address)}:17777/v1/shared-control`   // :103
  const pairingUrl = encodePairingOffer({ v: 2, endpoint, deviceToken, publicKeyB64, scope })
  ...
  return `pebble://pair?code=${code}`                                             // :162
```

Port `17777` is hardcoded here; the picked address never reaches any bind call.

4. **Actual bind** — `apps/desktop/src/pebble-tauri-runtime-transport.ts:96-100` starts the sidecar with `listen: LOCAL_RUNTIME_ENDPOINT.listen`, which `local-runtime-endpoint.ts:43-46` resolves from `http://127.0.0.1:17777` and *rejects* if non-loopback. → `apps/desktop/src-tauri/src/commands/runtime_process.rs:95-96` (`default_listen_address()` at `:481-483` is `"127.0.0.1:17777"`) → `runtime_process_args` `:300-301` emits `--listen 127.0.0.1:17777` → `runtime/go/internal/runtimehttp/server.go:2073` `net.Listen("tcp", listen)`.
5. **Self-report** — `apps/desktop/src/tauri-mobile-runtime-api.ts:49-52` hardcodes `isWebSocketReady() → { ready: true, endpoint: 'ws://127.0.0.1:17777/v1/shared-control' }`, i.e. it reports "ready" unconditionally regardless of the advertised address.

**Answer to the central question:** in this fork the GUI path **only advertises** the selected address. Picking `en0` changes a string in the pairing URL; the listening socket stays on `127.0.0.1`. A Pebble-hosted server can never accept a LAN connection today.

---

## 4. What the docs claim

### This fork's docs (inherited from upstream, now incoherent)

`docs/reference/headless-linux-server.md` is a near-verbatim copy of upstream's `docs/reference/headless-linux-server.md` with branding swapped — line numbers match one-for-one:

| Line | Pebble copy | Upstream `dacb84b…` copy |
|---|---|---|
| 51 / 51 | `--pairing-address 100.64.1.20` | identical |
| 81, 140 | `ExecStart=… serve --port 6768 --pairing-address 100.64.1.20` | identical (`/opt/orca/orca-linux.AppImage`) |
| 89 | "Replace `100.64.1.20` with the LAN, Tailscale, tunnel, or public hostname" | identical |
| 179-180 | "Clients cannot connect: make sure `--pairing-address` is an address reachable from the client, and make sure firewalls allow the selected `--port`." | identical |

Both docs describe an **AppImage** (`pebble-linux-x86_64.AppImage serve`), an Electron artifact — the doc was never rewritten for the Go `pebble-control serve` binary. The firewall advice at `:180` is meaningful upstream (a real `0.0.0.0` bind) and meaningless in this fork.

`docs/reference/2026-06-27-pebble-mobile-manual-network-address-design.md` (193 lines) is the interface-picker design. It is purely a **client-side UI** doc — `buildComboboxEntries` (`:60-80`, examples at `:169-173`), address validation (`:51-58`), rendering (`:115-123`). It never discusses binding; its premise (`:9`) is: *"The QR ends up pointing at an interface the phone cannot actually reach"* — i.e. it assumes the interface **is** reachable if picked correctly. Its own upstream counterpart is `docs/reference/2026-06-27-orca-mobile-manual-network-address-design.md`, present at `dacb84b…`.

`docs/reference/infra-index.md:94` is the one place that documents the fork's real behavior: `| pebble serve / pairing | **6768** | 127.0.0.1 |`, with `:98-103` "Remote access is by SSH tunnel, not by exposing the local ports". (Note it also says 6768, not the 17777 the desktop actually uses.)

### Upstream's official docs (https://www.onorca.dev)

`/docs/remote-servers` ("Remote Orca Servers"):

- Recommended path is **Tailscale**: *"The easiest setup is the Orca desktop app on both computers, connected through Tailscale. You do not need to run `orca serve` for this path."*
- LAN is **explicitly supported**, not excluded: *"Keep the server and client on a private network path you control, such as the same Tailscale tailnet **or LAN**."* and *"Prefer Tailscale, WireGuard, **a trusted LAN**, SSH forwarding, or an authenticated tunnel."*
- *"Do not select `127.0.0.1` for another computer. That address only works on the server itself."*
- Server-side flow: *"Settings → Remote Orca Servers → **Advertise this app as a server** → New Link → For **Connection address**, select the Tailscale address → Generate Access Link."* (This is the picker the user is describing; upstream's label is "Advertise this app as a server", the fork's is "Share this Pebble server" — `RuntimePairingUrlGenerator.tsx:339`, `RuntimeEnvironmentsPane.tsx:1283`.)
- `orca serve` troubleshooting: *"`orca serve` advertises the wrong address — restart it with an address the client can reach… Do not use a wildcard address or `127.0.0.1` for a remote client."*
- Failure modes listed: Tailscale address missing, server asleep/offline, tailnet ACLs, **"incompatible protocol version"**, revoked grant, missing agent CLI. **No firewall / macOS Local Network guidance anywhere.**

`/docs/ways-to-run` repeats the same framing (Tailscale as easiest, LAN implicit).

**Answer to Q4:** raw-LAN pairing is a documented, supported flow upstream. Tailscale is *recommended*, not mandatory. Upstream's docs are consistent with its `0.0.0.0` bind.

---

## 5. macOS firewall / Local Network privacy

### Server side (Air, running released Orca)

Nothing in upstream's source or docs handles the macOS Application Firewall. Because released Orca is Developer-ID-signed and notarized, the default ALF setting ("automatically allow downloaded signed software to receive incoming connections") admits it silently. It would only block if the user turned that off, enabled "Block all incoming connections", or dismissed the incoming-connection prompt with Deny. **No repo evidence either way; unverified.**

### Client side (Pebble) — this is handled, but recently and narrowly

`apps/desktop/src-tauri/Info.plist:9-12`:

```xml
  <!-- Why: macOS 15+ gates outgoing TCP to local-network addresses; without this string
       dialing a saved runtime at ws://192.168.x.x is denied with no explanation. -->
  <key>NSLocalNetworkUsageDescription</key>
  <string>Pebble connects to Pebble runtimes running on your local network.</string>
```

Background and limits are already documented in this task's `research/platform-permissions-macos-windows.md:1-60`:

- macOS 15+ Local Network privacy gates **outgoing TCP to local-network addresses** (Apple TN3179) — the WebSocket dial in `apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs:286` is exactly such an operation.
- `com.apple.developer.networking.multicast` is iOS-only; no entitlement change needed. `resources/build/entitlements.mac.plist` has no sandbox key, so `network.client`/`network.server` are irrelevant.
- TN3179 defines a local network as one on a **broadcast-capable** interface. A `utun`-based overlay (Tailscale/NetBird) is point-to-point and therefore **not** gated; a plain LAN (`en0`, `172.16.1.155`) **is**.

This yields a clean discriminator for the user's failure: *if the NetBird address `100.77.78.147` connects but the `en0` address `172.16.1.155` does not, the fault is macOS Local Network privacy on the Pebble client, not the server.* An ad-hoc-signed dev build carries a different code-signing identity than an installed release, so a prior TCC denial (or a build that predates the `Info.plist` line) fails silently.

---

## 6. Why "Orca-as-server on Air" could still fail — candidate causes, none confirmed

The server binds `0.0.0.0:6768` (§1), so the fork's loopback regression is **not** the cause here. Remaining candidates, in rough order of how cheaply they can be discriminated:

1. **macOS Local Network privacy on the Pebble client** (§5). Discriminator: LAN address fails, overlay address works.
2. **macOS Application Firewall on Air** blocking inbound to Orca. Discriminator: `nc -vz 172.16.1.155 6768` from the other machine.
3. **Wi-Fi AP client isolation** on the `172.16.1.0/24` network. Same discriminator as (2).
4. **Wrong picker entry** — selecting `This computer (127.0.0.1)` produces a link that upstream's own docs call out as non-working (`/docs/remote-servers`: "Do not select 127.0.0.1 for another computer").
5. **Post-handshake protocol drift.** The pairing wire shape and E2EE handshake match exactly:

   | Frame | Fork (`remote_runtime_rpc.rs`) | Upstream (`rpc/e2ee-channel.ts` @ `dacb84b…`) |
   |---|---|---|
   | client → `e2ee_hello` + `publicKeyB64` | `:292-293` | `:162` |
   | server → `e2ee_ready` (plaintext) | `assert_ready_frame` `:302`, `:440-446` | `:181` |
   | client → encrypted `e2ee_auth` + `deviceToken` | `:306-307` | `:195` |
   | server → encrypted `e2ee_authenticated` | `assert_authenticated_frame` `:449-461` | `:214` |
   | error → `unauthorized` | `:457` | `:201` |

   So `connect` should reach `e2ee_authenticated`. But the fork baseline is `v1.4.124-rc.8` while `config/upstream-sync/state.json` records upstream `lastObserved` at `v1.4.159` / `v1.4.160-rc.2` — **35 releases of unaudited drift** in the shared-control RPC method table. Upstream's own docs list "incompatible protocol version" as a real server-row state. `.trellis/tasks/07-27-accept-orca-pairing-urls/prd.md` flagged this explicitly: *"If Orca's remote WebSocket runtime has diverged from Pebble's E2EE handshake, save will succeed but connect/status may still fail — track as a follow-up interop task if observed."*
6. **Diagnostic misdirection makes (1)-(3) hard to tell apart.** NetBird's `100.77.78.147` sits inside `100.64.0.0/10`, so `isTailscaleEndpoint()` (`packages/product-core/shared/remote-runtime-tailscale-hint.ts:44-58`, CGNAT regex at `:24`) classifies it as Tailscale and `withRemoteRuntimeTailscaleHint` `:72-76` appends *"The server may be offline on your tailnet, or its Tailscale Funnel reverted to tailnet-only"* — for a NetBird endpoint with no tailnet involved. The underlying cause string from `describe_ws_error` (`remote_runtime_rpc.rs:232-258`) is the load-bearing part: `connection refused` (nothing listening) vs `no route to host` vs `timed out` (silently dropped — the signature of a firewall or Local Network denial).

---

## Files Found

### This fork

| File:line | Relevance |
|---|---|
| `runtime/go/cmd/pebble-control/serve.go:70` | `net.JoinHostPort("127.0.0.1", …)` — the CLI loopback bind |
| `runtime/go/cmd/pebble-control/serve.go:111`, `:158`, `:322` | `--pairing-address` → advertised string only |
| `runtime/go/internal/runtimehttp/server.go:2073` | `net.Listen("tcp", listen)` — single listener, whatever it's handed |
| `apps/desktop/src/local-runtime-endpoint.ts:1`, `:15-19`, `:43-46` | desktop runtime URL; **rejects** non-loopback with an explicit rationale |
| `apps/desktop/src/pebble-tauri-runtime-transport.ts:96-100` | passes `LOCAL_RUNTIME_ENDPOINT.listen` to the sidecar |
| `apps/desktop/src-tauri/src/commands/runtime_process.rs:95-96`, `:300-301`, `:481-483` | `--listen`, `default_listen_address() = "127.0.0.1:17777"` |
| `apps/desktop/src/tauri-mobile-runtime-api.ts:49-52`, `:83-112` | `isWebSocketReady` hardcoded; advertised endpoint built from picked address + hardcoded `:17777` |
| `apps/desktop/src-tauri/src/commands/network_interfaces.rs:12-28` | returns one "Default route" address (upstream returns all) |
| `packages/product-core/renderer/src/components/settings/RuntimePairingUrlGenerator.tsx:10`, `:20`, `:339`, `:352-353` | "Share this Pebble server" picker |
| `apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs:232-258`, `:279-317`, `:440-461` | client dial, error taxonomy, E2EE handshake |
| `apps/desktop/src-tauri/src/commands/runtime_environments.rs:1053-1062` | test fixture already uses `ws://100.77.78.147:6768` (the user's NetBird address) |
| `packages/product-core/shared/remote-runtime-tailscale-hint.ts:24`, `:44-58`, `:72-79` | CGNAT classifier that swallows NetBird addresses |
| `apps/desktop/src-tauri/Info.plist:9-12` | `NSLocalNetworkUsageDescription` (present) |
| `config/upstream-sync/state.json` | fork baseline / last-audited / last-observed upstream tags |

### Upstream Orca (via `git show dacb84bbb5e2f17ce8a7dc02017663a7e395570e:<path>`)

| File:line | Relevance |
|---|---|
| `src/main/runtime/runtime-rpc.ts:29`, `:694-700`, `:788` | `DEFAULT_WS_PORT = 6768`, `host: '0.0.0.0'` |
| `src/main/runtime/rpc/ws-transport.ts:182` | `httpServer.listen(port, this.host, …)` |
| `src/main/index.ts:1302-1340`, `:2020-2023` | `--serve-port` → `wsPort`; `enableWebSocket: true` |
| `src/main/ipc/mobile.ts:14-37`, `:55-70` | the "advertises 0.0.0.0" comment; full interface enumeration; `mobile:getPairingQR` |
| `src/cli/specs/serve.ts:22`, `:30` | `--pairing-address` semantics, the `--port 6768` example |
| `src/cli/runtime/launch.ts` (`serveOrcaApp`) | `--port` → `--serve-port` |
| `src/main/runtime/rpc/e2ee-channel.ts:162`, `:181`, `:195`, `:201`, `:214` | handshake frames matching the fork's Rust client |
| `docs/reference/headless-linux-server.md:51`, `:81`, `:140`, `:179-180` | the doc this fork inherited verbatim |

### External

- https://www.onorca.dev/docs/remote-servers — official "Remote Orca Servers" guide (Tailscale-recommended, LAN supported, `127.0.0.1` warned against, no firewall guidance)
- https://www.onorca.dev/docs/ways-to-run — run-mode comparison
- https://www.onorca.dev/docs/mobile — mobile pairing ("no cloud relay")
- https://www.onorca.dev/docs/troubleshooting — no networking/firewall entries
- https://github.com/stablyai/orca — public, 31.2k stars, not archived; `src/main/runtime/runtime-rpc.ts` and `src/main/runtime/rpc/ws-transport.ts` fetched at HEAD via `gh api`
- Apple TN3179, *Understanding local network privacy* — cited in this task's `platform-permissions-macos-windows.md`

### Related task research

- `.trellis/tasks/07-28-remote-runtime-connection-diagnosability/research/native-lan-serve-feasibility.md` — security analysis of flipping the bind; §"Commit history: silent" is superseded by §2 above
- `.trellis/tasks/07-28-remote-runtime-connection-diagnosability/research/serve-lifecycle-and-listen-addresses.md` — two-process `serve` lifecycle
- `.trellis/tasks/07-28-remote-runtime-connection-diagnosability/research/platform-permissions-macos-windows.md` — macOS 15 Local Network privacy detail
- `.trellis/tasks/07-27-accept-orca-pairing-urls/prd.md` — `orca://pair` scheme acceptance; already flagged both the loopback-endpoint caveat and possible post-connect RPC drift
- `docs/upstream-semantic-sync.md` — the audit pipeline; it deliberately does **not** merge upstream code, which is how a bind-semantics regression can pass unnoticed

---

## Caveats / Not Found

- **Confirmed by source, not by observation.** I did not run either app, dial anything, or reproduce the failure. Everything in §6 is a candidate list, not a diagnosis.
- **Upstream source verified at two points only**: the fork baseline `v1.4.124-rc.8` (in-repo) and current `HEAD` (two files via `gh api`). I did not diff the intervening ~35 releases, so I cannot say whether the shared-control RPC surface drifted — only that it was not audited (`state.json` `lastAudited` = `v1.4.158`, and `docs/upstream-semantic-sync.md` says the checkpoint advances on *review*, not on port).
- **The released Orca build the user runs was not identified.** I read upstream *source*; I did not inspect the shipped `.app` bundle on Air, its `Info.plist`, its signature, or its actual listening sockets.
- **No macOS firewall handling exists in either codebase**, and neither upstream nor fork docs mention it. The §5 server-side reasoning about ALF defaults is general macOS behavior, not repo-sourced.
- **Whether the user picked `en0` or the NetBird address for the failing attempt is second-hand.** The task brief says en0 was chosen; I could not verify which address is embedded in the actual failing pairing URL.
- `docs/reference/infra-index.md:94` documents the pairing port as **6768**, but the desktop path actually uses **17777** (`local-runtime-endpoint.ts:1`, `tauri-mobile-runtime-api.ts:103`). Noting the inconsistency; not resolving it.
