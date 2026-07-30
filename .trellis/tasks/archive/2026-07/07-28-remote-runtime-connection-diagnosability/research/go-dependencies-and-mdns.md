# Research: Go module state — existing deps, Go version, mDNS libraries, dependency policy

- **Query**: Read `runtime/go/go.mod`; is any mDNS/zeroconf library already present? Go version? Project policy on new deps?
- **Scope**: internal
- **Date**: 2026-07-28

## Findings

### Module facts (`runtime/go/go.mod`)

- Module path: `github.com/nebutra/pebble/runtime/go` (`:1`)
- **Go version: `go 1.26`** (`:3`)
- No `vendor/` directory (`runtime/go` contains only `cmd`, `internal`, `go.mod`, `go.sum`).

Direct requires (`:5-19`):

| Module | Version |
|---|---|
| `github.com/aymanbagabas/go-pty` | v0.2.3 |
| `github.com/charmbracelet/ultraviolet` | v0.0.0-20260303162955-… |
| `github.com/charmbracelet/x/ansi` | v0.11.7 |
| `github.com/charmbracelet/x/vt` | v0.0.0-20260719004043-… |
| `github.com/creack/pty` | v1.1.24 |
| `github.com/google/uuid` | v1.6.0 |
| `github.com/tailscale/hujson` | v0.0.0-20260302212456-… |
| `github.com/teambition/rrule-go` | v1.8.2 |
| `golang.org/x/crypto` | v0.51.0 |
| `golang.org/x/sys` | v0.44.0 |
| `golang.org/x/text` | v0.40.0 |
| `gopkg.in/yaml.v3` | v3.0.1 |
| `modernc.org/sqlite` | v1.53.0 |

Indirect requires of note (`:21-43`): `golang.org/x/sync v0.22.0` is present **as indirect only** — `errgroup` is therefore available in the module graph but is not used by any first-party code (no `errgroup` import anywhere in `runtime/go`).

### mDNS / zeroconf libraries: none present

Verified by grep over `runtime/go/go.mod`, `runtime/go/go.sum`, and the whole repo (excluding `node_modules` and `.trellis`) for `mdns`, `zeroconf`, `dnssd`, `bonjour`, `avahi`, `_tcp.local`, `miekg`:

- `hashicorp/mdns` — **not present**
- `grandcat/zeroconf` — **not present**
- `libp2p` mdns — **not present**
- `brutella/dnssd` — **not present**
- `miekg/dns` (transitive DNS lib) — **not present**

The only repo-wide hits are unrelated to networking code:

- `packages/product-core/renderer/src/components/settings/developer-permissions-search.ts:168-175` — the words `bonjour` and `mdns` as **search keywords** for the macOS "Local Network, USB, and Bluetooth" permissions settings row (`:146-181`).
- Corresponding i18n strings: `packages/product-core/renderer/src/i18n/locales/en.json:7252-7253` (and `ja`/`es`/`ko` equivalents).
- `config/scripts/locale-ko-key-overrides.json:3240` — the Korean rendering of "Bonjour".

There is also **no Rust mDNS dependency**: `apps/desktop/src-tauri/Cargo.toml` has no mdns/zeroconf crate (grep over `Cargo.toml`/`Cargo.lock` for those names returns nothing), and `apps/desktop/src-tauri/Info.plist:1-10` declares only `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` — **no `NSLocalNetworkUsageDescription`, no `NSBonjourServices`**, which macOS 15+ requires for local-network multicast from a sandboxed/notarized app.

### Dependency policy

No written policy found. Searched `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/STYLEGUIDE.md` for "dependency"/"third-party"/"new deps" — the only hit is `docs/STYLEGUIDE.md:246`, which is about translation of third-party product nouns, not code dependencies.

Observable de-facto signals instead:

- The direct-dependency list is small and purposeful (PTY, terminal emulation, crypto, sqlite, yaml, uuid, rrule). No general-purpose networking frameworks; the HTTP server, the WebSocket implementation, and the NaCl-box protocol are hand-rolled on top of stdlib + `golang.org/x/crypto` (`runtime/go/internal/runtimehttp/legacy_shared_control*.go`).
- User memory note for this repo: prefer removing Orca-era shims and moving toward native Rust/Go/Zig implementations rather than patching shims.
- Cross-platform is a hard constraint (`AGENTS.md` → "Cross-Platform Support"): macOS, Linux, Windows all ship the same Go binaries.

### CI / test surface for Go

- `go test ./...` runs from `runtime/go` in the release workflow — asserted by `config/scripts/tauri-release-workflow.test.mjs:148-149` and `config/scripts/verify-tauri-mainline.mjs:125`.
- The e2e workflow watches `runtime/go/**` (`config/scripts/e2e-workflow.test.mjs:18`).
- `config/scripts/verify-tauri-mainline.mjs:1828` pins `runtime/go/internal/runtimehttp/legacy_shared_control_test.go` as a mainline-invariant file — changes near the shared-control protocol are checked by that verifier.

## External References

Not verified — no web-search tool was available in this session. The library names above were checked only for *presence in this repo*, not for their current upstream status, maintenance, or API.

## Caveats / Not Found

- Go 1.26 in `go.mod` is a forward-looking toolchain line; `config/scripts/repository-verifier-portability.test.mjs:11-18` still references `go 1.25` in fixture strings, so the pinned toolchain has moved recently.
- No `go.work`, no vendoring, no dependency-review GitHub Action (`.github/workflows/` has no such job).
