# Auto-rediscover remote Pebble runtime via mDNS when its address changes

## Status: REJECTED during planning (2026-07-28). Not implemented.

Superseded by `.trellis/tasks/07-28-remote-runtime-connection-diagnosability`, which carries a
copy of this task's `research/` directory.

## Why it was rejected

**1. There is no advertiser to build against.** mDNS re-discovery requires the runtime to advertise
itself. The reporting user's peer server is the **legacy Orca app**, which is not in this
repository, so no advertiser can be added for that setup. Pebble's own Go runtime advertises
nothing (`research/go-dependencies-and-mdns.md`: zero `mdns|zeroconf|dns-sd|bonjour` hits under
`runtime/go/internal`).

**2. Pebble's native runtime is not reachable over LAN anyway.**
`runtime/go/cmd/pebble-control/serve.go:70` hardcodes the bind to `127.0.0.1` and passes it to the
runtime child; `--pairing-address` only changes the advertised string. Advertising a LAN address
would point at a socket nothing can reach.

**3. Making it reachable is unsafe.** `pebble serve` runs with **no authentication**:
`runtime/go/cmd/pebble-control/main.go:48` short-circuits the token when serving, and
`runtime/go/internal/runtimehttp/server.go:86-88` then authorizes every route and method. The
loopback bind is a load-bearing security boundary, not an unexamined default. Binding non-loopback
would expose unauthenticated remote command execution via `POST /v1/sessions`
(`runtime/go/internal/runtimehttp/server.go:589-594`), plus a pre-auth reverse proxy
(`server.go:72` runs `localhostLabels.serve` before `authorize`). Full analysis and a 10-item
prerequisite list: `research/native-lan-serve-feasibility.md`.

**4. It would not have helped the reporting user regardless.** Their network is a large shared
subnet (118 ARP entries, randomized MACs) of the kind that commonly enables AP client isolation
and drops multicast.

## Retained value

The `research/` directory is worth keeping. `native-lan-serve-feasibility.md` in particular
documents the unauthenticated-`serve` finding and is the basis for any future hardening work.
