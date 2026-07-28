# Research: cross-platform mDNS crate options for Rust

- **Query**: compare `mdns-sd`, `zeroconf`, `astro-dnssd`, `simple-mdns` — pure-Rust vs system daemon, Windows quality, maintenance, license, dependency weight; recommend one
- **Scope**: external (crates.io + GitHub APIs, upstream READMEs)
- **Date**: 2026-07-28

## Findings

Data pulled from the crates.io and GitHub REST APIs on 2026-07-28.

| Crate | Latest | License | Last push | Stars / open issues | Implementation |
|---|---|---|---|---|---|
| `mdns-sd` | 0.20.3 (2026-07-26) | Apache-2.0 OR MIT | 2026-07-26 | 212 / 16 | **Pure Rust**, own UDP sockets, own daemon thread |
| `zeroconf` | 0.18.0 (2026-04-07) | MIT (crates.io reports "non-standard") | 2026-04-07 | 94 / 5 | **FFI binding**: `avahi-sys` on Linux, `bonjour-sys` on macOS/Windows/FreeBSD |
| `astro-dnssd` | 0.3.6 (2025-06-16) | MIT OR Apache-2.0 | 2026-06-15 | 26 / 8 | **FFI binding** to the platform `dns_sd` C API (mDNSResponder / Bonjour) |
| `simple-mdns` | 0.7.0 (2026-05-15) | MIT | 2026-07-26 (monorepo `simple-dns`) | 81 / 0 | **Pure Rust**, built on the `simple-dns` parser |

Downloads: `mdns-sd` 3.64M total / 1.38M recent; `zeroconf` 315K / 34K; `simple-mdns` 80K / 2.5K; `astro-dnssd` 67K / 9K. Also surveyed: `libmdns` (responder-only, no browsing — not applicable), `mdns` v3.0.0 (unmaintained since 2021), `searchlight` (194 recent downloads, last push 2023 — effectively abandoned).

### Dependency weight (direct, non-optional, latest versions)

```
mdns-sd 0.20.3   : fastrand ^2.4, flume ^0.12, if-addrs ^0.15, mio ^1.2,
                   socket-pktinfo ^0.4, socket2 ^0.6
simple-mdns 0.7  : log, radix_trie ^0.3, simple-dns 0.*, socket2 ^0.6
zeroconf 0.18    : avahi-sys ^0.10 (unix), bonjour-sys ^0.4 (apple/pc/freebsd),
                   derive-getters, derive-new, derive_builder ^0.9, libc, log,
                   zeroconf-macros
astro-dnssd 0.3.6: libc (non-windows), log, thiserror ^2, widestring (windows),
                   winapi ^0.3 (windows)
```

Against this repo's existing `apps/desktop/src-tauri/Cargo.lock`, `mdns-sd` adds only **three new crates plus their transitives**:

| New crate | Transitive additions |
|---|---|
| `flume 0.12` | `spin 0.9` (new); `fastrand` already at 2.4.1; `futures-core`/`futures-sink` already at 0.3.32 |
| `if-addrs 0.15` | `libc` (present), `windows-sys 0.61.2` (**already in the lock**) |
| `socket-pktinfo 0.4` | `socket2 ^0.6` (already at 0.6.4), `libc`, `windows-sys 0.61.2` |

`mio` is already in the lock at 0.8.11 and 1.2.1; `mdns-sd` wants `^1.2`, which is satisfied. Net cost is roughly **4 new crates**, no build scripts touching C, no new system libraries. That is unusually cheap for this crate class.

### Windows support

- **`mdns-sd`** — README states "supports macOS, Linux and Windows" and CI runs on all three. It binds its own sockets with `SO_REUSEADDR` + `SO_REUSEPORT` (`src/service_daemon.rs:879-895`), so it coexists with the OS's own mDNS stack rather than fighting it for UDP 5353. Historical Windows issues (#33, #106) were traced to VM bridged-networking / interface selection, not to the crate; both are closed. Issue #478 ("Hang on Windows") is closed. No native deps means no MSVC/vcpkg step in CI.
- **`zeroconf`** — on Windows it links `bonjour-sys`, i.e. **Apple's Bonjour SDK for Windows**. That SDK is deprecated by Apple, the `Bonjour Service` is not installed on a stock Windows machine (it ships with iTunes / Bonjour Print Services), and it must be redistributed or the user must install it. This is a hard blocker for Pebble's Windows target. On Linux it needs `libavahi-client-dev` at build time and a running `avahi-daemon` at run time.
- **`astro-dnssd`** — same story: on Windows it p/invokes `dnssd.dll` from the Bonjour installation. Works well on macOS (mDNSResponder is always present), fine on Linux with Avahi's compat shim, unreliable to impossible on stock Windows.
- **`simple-mdns`** — pure Rust and cross-platform in principle, but far lower adoption (2.5K recent downloads vs 1.38M) and a much thinner RFC 6762 story than `mdns-sd`. Its `OneShotMdnsResolver` / `ServiceDiscovery` API is minimal and it has no explicit conflict-resolution, known-answer-suppression, or cache-flush handling.

### RFC compliance (`mdns-sd` README table)

Implemented: one-shot queries, randomized initial query delay, multicast rate limiting, shared-record response delay, known-answer suppression (querier and multipacket-querier), probing, simultaneous-probe tiebreaking, conflict resolution, goodbye packets, cache-flush announcements, cache-flush-on-failure (`ServiceDaemon::verify()`).
Not implemented: unicast responses (RFC 6762 §5.4) and multipacket known-answer suppression on the *responder* side. Neither matters for a client that only browses.

`ServiceDaemon::verify()` is directly relevant: it is the RFC 6762 §10.4 "cache flush on failure indication" API, i.e. exactly the "I just failed to reach this thing, re-check it" primitive this task needs.

### Recommendation: `mdns-sd`

1. **Pure Rust, no system daemon, no C toolchain.** The other three (except `simple-mdns`) bind to Bonjour/Avahi and would either break the Windows build or require shipping Apple's deprecated Bonjour installer.
2. **Cheapest dependency delta of any option that actually works on all three targets** — ~4 new crates, all of which are already partly in the lock.
3. **Actively maintained**, released the same week as this research, 1.38M recent downloads, dual Apache-2.0/MIT (matching the licence posture of the rest of the tree).
4. **No async-runtime coupling.** It runs its own thread and hands you a `flume` channel that has both blocking and `.recv_async()` sides, so it drops into `remote_runtime_rpc.rs`'s tokio context without a runtime bridge and without forcing an executor choice.
5. `ServiceDaemon::verify()` and `ServiceEvent::ServiceResolved` map cleanly onto "connect failed → re-verify/browse → read the new `SocketAddr` → rewrite the stored endpoint".

Runner-up if a hard "no new dependency threads" constraint appears: `simple-mdns` (pure Rust, 4 deps) — but it is far less battle-tested and you would be reimplementing cache and conflict handling.

Note the crate is **browse-side only for our purposes**; the Go runtime currently advertises nothing (see `runtime-environment-store.md`), so an advertiser must be added there — likely `github.com/grandcat/zeroconf` or `github.com/libp2p/zeroconf/v2` on the Go side, which is out of scope for this document.

### API sketch (for the design doc)

```rust
use mdns_sd::{ServiceDaemon, ServiceEvent};

let daemon = ServiceDaemon::new()?;                 // spawns its own thread
let receiver = daemon.browse("_pebble-runtime._tcp.local.")?;
// receiver: flume::Receiver<ServiceEvent>, has .recv_async() / .recv_timeout()
while let Ok(event) = receiver.recv_async().await {
    if let ServiceEvent::ServiceResolved(info) = event {
        // info.get_addresses(), info.get_port(), info.get_property_val_str("pk")
    }
}
daemon.shutdown()?;
```

Key points for the design: `ServiceDaemon` is `Clone` and cheap to share; browsing is continuous until you `stop_browse`, so a lazy re-discovery should browse with a short deadline (a few seconds) and then shut down or stop the browse to avoid a permanently-open multicast socket (which matters for the permission story — see `platform-permissions-macos-windows.md`).

## External References

- <https://crates.io/api/v1/crates/mdns-sd> / `.../zeroconf` / `.../astro-dnssd` / `.../simple-mdns> — versions, licences, download counts, dependency lists
- <https://github.com/keepsimple1/mdns-sd> — README (compliance table, platform claims), `src/service_daemon.rs` socket setup
- <https://docs.rs/mdns-sd> — API
- RFC 6762 (mDNS), RFC 6763 (DNS-SD)

## Caveats / Not Found

- crates.io reports `zeroconf`'s licence as "non-standard"; GitHub reports MIT. Anyone adopting it should read `LICENSE` directly.
- I did not benchmark discovery latency or measure binary-size delta; the dependency count is a proxy.
- `mdns-sd` bumped `socket2` to `^0.6` and `mio` to `^1.2` in recent releases; if any other crate in this tree pins `socket2 0.5` (it does — 0.5.10 is in the lock alongside 0.6.4) Cargo will keep both, which is already the status quo.
