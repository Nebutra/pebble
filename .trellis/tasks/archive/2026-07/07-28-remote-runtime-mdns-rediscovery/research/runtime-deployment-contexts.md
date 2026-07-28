# Research: Where the runtime actually runs — containers, ephemeral VMs, SSH, CI

- **Query**: Does the runtime ever run in contexts where mDNS advertising would be wrong or harmful? How are ephemeral VM runtimes launched?
- **Scope**: internal
- **Date**: 2026-07-28

## Findings

### Inventory of launch contexts

| # | Context | How the runtime starts | LAN-multicast relevance |
|---|---|---|---|
| 1 | Desktop app (default) | Tauri spawns `pebble-runtime --listen 127.0.0.1:17777` — `apps/desktop/src-tauri/src/commands/runtime_process.rs:300-308` | Same-machine; client is in-process |
| 2 | Local `pebble serve` | Node CLI → Tauri `--serve` → `pebble-control serve` → child on `127.0.0.1:<port>` — `runtime/go/cmd/pebble-control/serve.go:70` | The LAN case the task targets |
| 3 | Headless Linux server / VPS | systemd unit running the AppImage with `serve --port 6768 --pairing-address <tailscale-ip>` — `docs/reference/headless-linux-server.md:69-87`, `:128-146` | Often reached over Tailscale/WAN, **not** the same L2 segment |
| 4 | Cloud sandbox (per-workspace env, "Pebble-server" mode) | `pebble-dev serve … --pairing-address "$PEBBLE_PAIRING_ADDRESS" --recipe-json` inside a Vercel Sandbox — `skill-guides/pebble-per-workspace-env.md:408` | Container; pairing address is a public `wss://…vercel.run` URL (`:380-384`) |
| 5 | Ephemeral VM (recipe-driven) | `Manager.ProvisionEphemeralVM` shells out to the repo's own `create` script — `runtime/go/internal/runtimecore/ephemeral_vm_lifecycle.go:83-118` | Provider-defined; usually cloud, not LAN |
| 6 | SSH remote host | **No remote runtime at all** — a stateless `pebble-relay-worker` CLI is deployed and invoked per command — `runtime/go/internal/runtimecore/ssh_relay_worker_deploy.go:29-55`, `runtime/go/cmd/pebble-relay-worker/main.go:25-50` | N/A — nothing listens remotely |
| 7 | CI | `go test ./...` from `runtime/go` (`config/scripts/tauri-release-workflow.test.mjs:148-149`); real-runtime e2e under `xvfb-run` (`.github/workflows/e2e.yml:102`, `tauri-desktop-release.yml:163`) | Shared runner networks; tests construct `NewManager(t.TempDir(), nil)` freely |

### Contexts where multicast would be wrong or ineffective

**Cloud sandbox (#4).** The per-workspace-env guide's Vercel example derives the pairing address from the sandbox's published HTTPS URL and converts it to `wss://` (`skill-guides/pebble-per-workspace-env.md:380-384`):

```bash
public_url="$(… sed -nE 's#.*(https://[^[:space:]]+\.vercel\.run).*#\1#p' | head -1)"
pairing_ws="${public_url/https:\/\//wss://}"
```

then starts serve with `--pairing-address "$PEBBLE_PAIRING_ADDRESS" --recipe-json` in the background (`:408`). The guide is explicit that the pairing code must be passed through unchanged: "`pairingCode` is the pairing URL, already pointing at whatever you passed as `--pairing-address` — so set `--pairing-address` to the externally reachable address and **pass `pairingCode` through unchanged; never** …" (`:302-303`). The client here is nowhere near the sandbox's L2 network.

**Headless VPS / Tailscale (#3).** `docs/reference/headless-linux-server.md:89-90`: "Replace `100.64.1.20` with the LAN, Tailscale, tunnel, or public hostname that clients should use." Tailscale (CGNAT `100.64/10`) and tunnels are overlay networks; mDNS on the physical interface would advertise an address that is not the one clients use, and the tailnet interface does not carry link-local multicast in the usual way.

**Ephemeral VMs (#5).** `ProvisionEphemeralVM` (`ephemeral_vm_lifecycle.go:83-118`) runs the repo-owned `recipe.Create` script (`:101`) and parses one JSON object from stdout (`:105`) that carries either a `pairingCode` (Pebble-server mode) or SSH connection details. The runtime instance lives inside the provider's VM/container with its **own fresh data dir**, therefore a **fresh Curve25519 identity** each provision (see `runtime-identity-fields.md`). Recipe modes are documented in `skill-guides/pebble-per-workspace-env.md` §7c/§7f (Pebble-server) and §7g (SSH). Recipe results are redacted before diagnostics (`packages/product-core/shared/ephemeral-vm-recipe-diagnostics.ts:42`, `:62`, `:69` replace the pairing code with `[redacted]`), i.e. the pairing code is treated as sensitive.

**SSH mode (#6).** Explicitly *not* a remote runtime: "`create` does NOT run `pebble serve` and does NOT emit a `pairingCode`. Pebble itself connects to the host over its SSH relay" (`skill-guides/pebble-per-workspace-env.md`, §7g intro). The deployed artifact is `pebble-relay-worker`, a one-shot subcommand CLI over an SSH pipe (`cmd/pebble-relay-worker/main.go:35-50`), with the port-forward machinery in `runtime/go/internal/runtimecore/ssh_port_forwards.go`.

**CI (#7).** Go unit tests build a real `Manager` against `t.TempDir()` (e.g. `runtime/go/internal/runtimecore/legacy_shared_control_test.go:9`, `:19-21`), and the e2e workflows start a real runtime process under `xvfb-run` on shared GitHub-hosted runners. Anything started unconditionally from `NewManager`/`main` would therefore also start in every CI job. Note the existing precedent that background work is started from `main` (`cmd/pebble-runtime/main.go:54`) and **not** from `NewManager`, so unit tests never spin the scheduler.

**Containers generally.** There is no Dockerfile and no `.devcontainer` in the repo (`find . -name "Dockerfile*"` and `ls .devcontainer` both empty), so container behavior is defined entirely by user-owned recipes (#4/#5).

### macOS platform gate

`apps/desktop/src-tauri/Info.plist:1-10` declares only `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` — there is **no `NSLocalNetworkUsageDescription` and no `NSBonjourServices`** entry today. The renderer's settings search already anticipates a "Local Network, USB, and Bluetooth" permission row with `bonjour`/`mdns` keywords (`packages/product-core/renderer/src/components/settings/developer-permissions-search.ts:146-181`), described as "Allow device and local-network tools used from terminal sessions." (`:151-154`) — i.e. it exists to explain *terminal-session* tools needing the permission, not Pebble's own advertising.

### Signals that could distinguish contexts (facts, not recommendations)

Existing environment variables and flags that a context check could read, all already present:

| Signal | Meaning | Citation |
|---|---|---|
| `--pairing-address` non-empty and contains `://` | operator supplied an explicit external URL (tunnel/cloud) | `serve.go:158`, `:328-345` |
| `--recipe-json` | invoked by a VM/sandbox recipe | `serve.go:161`, `:127-137` |
| `--no-pairing` | no pairing material produced at all | `serve.go:159`, `:100` |
| `PEBBLE_RUNTIME_PARENT_PID` | launched by a desktop shell | `cmd/pebble-runtime/main.go:51` |
| `PEBBLE_RUNTIME_DATA_DIR` | non-default data dir (dev/sandbox) | `internal/runtimeauth/credential.go:31` |
| `PEBBLE_SSH_ASKPASS_MODE` | binary invoked as an askpass helper, exits immediately | `cmd/pebble-runtime/main.go:19-24` |

### The overriding fact

Across **all** contexts the listener is loopback-bound (`serve.go:70`; `--listen` default `127.0.0.1:17777` at `cmd/pebble-runtime/main.go:25`; `runtimeauth.isLocalEndpoint` rejects non-loopback at `credential.go:150-157`). Every remote-client story today therefore depends on something in front of the loopback port — a tunnel, sandbox port publishing, or SSH forwarding. Context #2 (local `pebble serve`, LAN client) is the only one where an mDNS record could point at a directly reachable socket, and even there only if the bind address changes.

## Caveats / Not Found

- No Dockerfile, no devcontainer, no Kubernetes manifests in the repo — container behavior is entirely recipe-defined by users.
- No existing "am I in CI / a container / a VM" detection anywhere in `runtime/go`.
- I did not audit the mobile app (`apps/mobile/`) launch paths; the mobile client pairs via QR to the same shared-control endpoint (`apps/desktop/src/tauri-mobile-runtime-api.ts:51`, `:103`).
