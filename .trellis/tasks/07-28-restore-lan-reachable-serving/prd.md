# Restore LAN-reachable runtime serving lost in the Tauri migration

## Background

Upstream Orca serves its shared-control WebSocket on a **wildcard bind**, and the interface picker
in Settings ("This computer / en0 / tailnet / …") exists only to choose which address to *advertise*
in the pairing code. That design is coherent: the socket already accepts traffic on every interface,
so the picker only has to solve "0.0.0.0 is not a connectable address to hand someone".

Upstream evidence (all at the fork baseline commit `dacb84bbb5e2f17ce8a7dc02017663a7e395570e`,
recorded in `config/upstream-sync/state.json` and an ancestor of this repo's HEAD):

- `src/main/runtime/runtime-rpc.ts:700` — `host: '0.0.0.0'`
- `src/main/runtime/rpc/ws-transport.ts:182` — `httpServer.listen(port, this.host, …)`
- `src/main/runtime/runtime-rpc.ts:29` — `DEFAULT_WS_PORT = 6768`
- `src/main/ipc/mobile.ts` — *"the WebSocket transport advertises 0.0.0.0 as its endpoint, which
  isn't connectable from a mobile device. We enumerate all non-internal IPv4 addresses so the user
  can choose which one to advertise in the QR code (e.g. LAN vs Tailscale)."*

The Tauri/Go rewrite kept the advertise-only picker but **changed the bind to loopback**:

- `runtime/go/cmd/pebble-control/serve.go:70` — `net.JoinHostPort("127.0.0.1", port)`, passed to the
  runtime child at `:75` → `runtime/go/internal/runtimehttp/server.go:2073`
- `apps/desktop/src/local-runtime-endpoint.ts:15-19` — actively **throws** on a non-loopback host
- `apps/desktop/src/tauri-mobile-runtime-api.ts:103` — mints `ws://<picked-LAN-IP>:17777/v1/shared-control`
  pairing URLs pointing at a socket nothing can reach

Net effect: the UI invites the user to pick a LAN interface and hands them a pairing link that can
never work. `docs/reference/headless-linux-server.md:179-180` ("Clients cannot connect: make sure
`--pairing-address` is an address reachable") is copied verbatim from upstream, where it was
coherent; here it is not.

This is a migration regression, not a deliberate security decision. A prior analysis in
`.trellis/tasks/archive/2026-07/07-28-remote-runtime-mdns-rediscovery/research/native-lan-serve-feasibility.md`
concluded the loopback bind was an intentional boundary and recorded the history as silent — **both
of those conclusions were wrong** and are corrected here.

## The security constraint that is real

The naive fix (bind `0.0.0.0`) is unsafe **in this fork**, because the Go rewrite put everything
behind one server:

- `runtime/go/cmd/pebble-control/main.go:48` short-circuits the bearer token when serving, so
  `pebble serve` runs with an empty token
- `runtime/go/internal/runtimehttp/server.go:86-88` — `if s.bearerToken == "" { return true }`
  authorizes **every route and method**
- `runtime/go/internal/runtimehttp/server.go:589-594` — `POST /v1/sessions` passes a caller-supplied
  command to `StartSession`
- `runtime/go/internal/runtimehttp/server.go:72` runs the localhost-label reverse proxy **before**
  `authorize`

Upstream did not have this exposure: the wildcard-bound surface was the WebSocket transport, gated
by the pairing `deviceToken` and an X25519-derived box. The unauthenticated HTTP control API is a
fork-specific artifact.

## Goal

Restore upstream's reachability by restoring upstream's **layering**, not by widening the current
bind:

- the pairing-authenticated shared-control WebSocket becomes reachable on the selected interface
- the local control HTTP API stays loopback-only

## Requirements

- R1 — The shared-control WebSocket accepts connections on non-loopback interfaces.
- R2 — `POST /v1/sessions` and every other control-plane route remain unreachable from off-host,
  regardless of R1.
- R3 — The localhost-label reverse proxy (`server.go:72`) must not become reachable off-host.
- R4 — Non-loopback serving is **opt-in**, defaulting to today's loopback behavior.
- R5 — `local-runtime-endpoint.ts:15-19` must stop throwing for the serving path without weakening
  the guarantee it protects for the desktop-owned local runtime.
- R6 — The interface picker's selected address must be the address actually served, not merely
  advertised.
- R7 — `docs/reference/headless-linux-server.md` must describe behavior this implementation actually
  has.

## Non-goals

- Adding authentication to the HTTP control API (worth doing, but separate and larger).
- mDNS/LAN discovery — rejected, see the archived task.
- Changing the E2EE handshake, which matches upstream frame for frame.

## Open questions

- Does upstream's WS transport enforce `deviceToken` on **every** connection, or only at pairing?
  R1's safety depends on the answer; confirm against upstream source before designing.
- `config/upstream-sync/state.json` records `lastAudited v1.4.158` against baseline
  `v1.4.124-rc.8` — 35 releases of shared-control drift are unaudited. Check whether upstream
  changed this area in that window.
- Should the port move back to upstream's 6768, or stay on 17777? Affects compatibility with
  released Orca clients.

## Acceptance criteria

- [ ] With the opt-in enabled, a second machine on the same LAN completes pairing and an RPC call.
- [ ] With the opt-in enabled, `curl http://<lan-ip>:<port>/v1/sessions` from another host fails to
      reach the handler.
- [ ] With the opt-in enabled, the localhost-label proxy is not reachable from another host.
- [ ] Default (no opt-in) behavior is byte-identical to today.
- [ ] Verified end-to-end from a second physical machine, not only by unit tests.
