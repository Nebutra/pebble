# Research: Multi-homed hosts, listen addresses, and where Pebble already knows its LAN IP

- **Query**: How does the runtime handle multiple listen addresses / multi-homed hosts? Does it know its own LAN IP anywhere?
- **Scope**: internal
- **Date**: 2026-07-28

## Findings

### The Go runtime never enumerates interfaces

Grep across `runtime/go` for `net.Interfaces`, `net.InterfaceAddrs`, `LookupIP`, `os.Hostname` → **zero hits**. The Go runtime has no concept of "my addresses".

There is exactly **one** listen address, threaded through as a single string:

| Layer | Value | Citation |
|---|---|---|
| Runtime flag | `--listen`, default `127.0.0.1:17777` | `runtime/go/cmd/pebble-runtime/main.go:25` |
| Bind | `net.Listen("tcp", listen)` — one listener, one address | `runtime/go/internal/runtimehttp/server.go:2073` |
| Real port readback | `listener.Addr().(*net.TCPAddr).Port` → `ConfigureSessionHookEndpoint` | `server.go:2079-2081` |
| Control process | always `127.0.0.1:<port>` | `runtime/go/cmd/pebble-control/serve.go:70` |
| Desktop (Tauri) spawn | `["--listen", listen]` (+ optional `--data-dir`) | `apps/desktop/src-tauri/src/commands/runtime_process.rs:300-308` |

`0.0.0.0` handling exists only as a **normalization to loopback**, never as an actual bind:

- `runtimeauth.EndpointForListen` maps `""`, `0.0.0.0`, `::` → `127.0.0.1` before writing the credential file (`runtime/go/internal/runtimeauth/credential.go:40-49`; test at `credential_test.go:88`).
- `runtimeauth.isLocalEndpoint` rejects anything that is not `127.0.0.1`/`localhost`/`::1`, so `Publish` refuses a non-loopback endpoint outright (`credential.go:56-57`, `:150-157`).

So there is no multi-homed handling at all: one string in, one socket out, and the credential/endpoint machinery actively assumes loopback.

### Where `0.0.0.0` *does* appear — port detection of other people's servers

These are about dev servers discovered inside workspaces, not about Pebble's own socket:

- `runtime/go/internal/runtimecore/workspace_ports.go:264`, `:334` — a detected wildcard bind (`*`, `0.0.0.0`, `::`) is rewritten to a connectable host.
- `runtime/go/internal/runtimecore/ssh_port_forwards.go:49`, `:105` — same normalization for SSH-forwarded remote ports; `ssh_port_forwards_test.go:110` shows a real LAN address (`192.168.1.4`) arriving from remote port detection.
- `runtime/go/internal/runtimehttp/localhost_label_proxy.go:179`, `:189` — loopback-host recognition for the `*.localhost` label reverse proxy.

### The one place Pebble computes its own LAN IP: the Tauri Rust side

`apps/desktop/src-tauri/src/commands/network_interfaces.rs` — the whole file (29 lines):

```rust
let socket = UdpSocket::bind("0.0.0.0:0")?;
// Why: UDP connect performs local route selection without sending packets,
// giving every supported OS a reachable default-route address.
socket.connect("1.1.1.1:80")?;
let address = socket.local_addr()?.ip();
```

- Returns **at most one** address, labeled `"Default route"` (`:20-28`), and only IPv4 that is neither loopback nor unspecified.
- Registered as the Tauri command `network_list_interfaces` — `apps/desktop/src-tauri/src/main.rs:349`, module at `apps/desktop/src-tauri/src/commands/mod.rs:83`.
- Deliberately *not* a full interface enumeration: multi-homed hosts (LAN + Tailscale + Docker bridge) collapse to whichever address the default route picks, and it requires an outbound-routable default route to return anything at all.

### Consumer of that address, and the DHCP problem it already documents

`docs/reference/2026-06-27-pebble-mobile-manual-network-address-design.md` is the design doc for `MobileNetworkInterfaceSection`, the Settings → Mobile UI that bakes an address into the mobile pairing QR:

- Problem statement (`:9`): the only options come from `networkInterfaces`; a user wanting a Tailscale MagicDNS name or a manual LAN IP has no way to type one, so "the QR ends up pointing at an interface the phone cannot actually reach."
- Decision: a combobox with manual entry, validated by `parseManualNetworkAddress` accepting IPv4 or `*.ts.net` (`:38-58`).
- Edge case 4 (`:153`): "Manual address becomes unreachable at pair time — Not handled here."
- Edge case 2 (`:151`): if the OS later surfaces the manually typed address, both remain valid; no merge.

The endpoint built from that selection is a literal template — `apps/desktop/src/tauri-mobile-runtime-api.ts:103`:

```ts
const endpoint = `ws://${formatPairingHost(address)}:17777/v1/shared-control`
```

with the loopback default at `:51` (`ws://127.0.0.1:17777/v1/shared-control`). Port `17777` is hardcoded on this path.

### Summary of what is and isn't known at advertise time

| Question | Answer | Where |
|---|---|---|
| Which port is really bound? | Known, post-bind, in the runtime process | `server.go:2079` |
| Which interface/IP is bound? | Always loopback, by construction | `serve.go:70`, `main.go:25` |
| Does any Go code know a LAN IP? | No | grep: no `net.Interfaces`/`InterfaceAddrs` in `runtime/go` |
| Does any Pebble code know a LAN IP? | Yes, Rust only, one default-route IPv4 | `commands/network_interfaces.rs:12-28` |
| Does the runtime know its hostname? | No | grep: no `os.Hostname` in `runtime/go` |

## Caveats / Not Found

- `network_list_interfaces` is a *desktop* command. A headless `pebble serve` (no Tauri window, `docs/reference/headless-linux-server.md`) never invokes it; the Go processes have no equivalent.
- Nothing in the repo watches for address changes (DHCP lease change, VPN up/down, interface flap). The Rust command is pull-only, triggered by a Refresh button (`docs/reference/2026-06-27-…-design.md:126`).
