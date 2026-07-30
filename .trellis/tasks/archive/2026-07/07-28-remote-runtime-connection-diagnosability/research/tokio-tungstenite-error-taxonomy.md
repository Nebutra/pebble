# Research: tokio-tungstenite 0.26 error taxonomy — which failures mean "address moved"

- **Query**: which `connect_async` error variants distinguish host-unreachable / connection-refused / TLS failure / handshake rejection, so mDNS re-discovery fires only on "address moved"
- **Scope**: mixed (vendored crate source + repo config)
- **Date**: 2026-07-28

## Findings

### Versions in this repo

- `apps/desktop/src-tauri/Cargo.toml:72-75` — `tokio-tungstenite = { version = "0.26", default-features = false, features = ["connect", "rustls-tls-webpki-roots"] }`
- `apps/desktop/src-tauri/Cargo.lock:6052-6054` — `tokio-tungstenite 0.26.2`
- `apps/desktop/src-tauri/Cargo.lock:6316-6318` — `tungstenite 0.26.2`
- Toolchain in use: `rustc 1.96.1`
- Both `connect` and `__rustls-tls` imply `handshake` (tokio-tungstenite `Cargo.toml` features block), so the `Http` and `HttpFormat` variants **are** compiled in.

### Call site

`apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs:229-231`

```rust
let (mut ws, _) = connect_async(&pairing.endpoint)
    .await
    .map_err(|_| "Could not connect to the remote Pebble runtime.".to_string())?;
```

The `map_err(|_| ...)` discards the entire error. Same pattern again at `:242` (post-connect `send` failure) and at `:275` / `:299` for stream errors.

### The error enum (`tungstenite 0.26.2`, `src/error.rs:15-76`)

```rust
#[non_exhaustive]
pub enum Error {
    ConnectionClosed,                    // :28
    AlreadyClosed,                       // :37
    Io(io::Error),                       // :41
    Tls(TlsError),                       // :47   (variant exists unconditionally)
    Capacity(CapacityError),             // :52
    Protocol(ProtocolError),             // :55
    WriteBufferFull(Message),            // :58
    Utf8,                                // :61
    AttackAttempt,                       // :63
    Url(UrlError),                       // :67
    Http(Response<Option<Vec<u8>>>),     // :71  #[cfg(feature = "handshake")]
    HttpFormat(http::Error),             // :75  #[cfg(feature = "handshake")]
}
```

`src/error.rs:260-279`:

```rust
#[non_exhaustive]
pub enum UrlError {
    TlsFeatureNotEnabled, NoHostName, UnableToConnect(String),
    UnsupportedUrlScheme, EmptyHostName, NoPathOrQuery,
}
```

`src/error.rs:288-301`:

```rust
#[non_exhaustive]
pub enum TlsError {
    #[cfg(feature = "native-tls")]  Native(native_tls_crate::Error),
    #[cfg(feature = "__rustls-tls")] Rustls(rustls::Error),
    #[cfg(feature = "__rustls-tls")] InvalidDnsName,
}
```

With this repo's feature set only `Rustls(rustls::Error)` and `InvalidDnsName` are constructible.

### What `connect_async` actually produces

`tokio-tungstenite-0.26.2/src/connect.rs`, `async fn connect(...)`:

1. `domain(&request)?` → `Error::Url(UrlError::NoHostName)` / `EmptyHostName`.
2. Port derivation → `Error::Url(UrlError::UnsupportedUrlScheme)` when the scheme is neither `ws` nor `wss` and no explicit port is present.
3. **`TcpStream::connect(addr).await.map_err(Error::Io)?`** — this is where every network-layer failure lands, as `Error::Io(io::Error)`. It includes DNS resolution failure, because `TcpStream::connect` takes a `String` `"{domain}:{port}"` and runs `ToSocketAddrs` internally.
4. `crate::tls::client_async_tls_with_config(...)` → TLS handshake (`Error::Tls(...)`) then the HTTP/1.1 Upgrade handshake (`Error::Http(...)`, `Error::HttpFormat(...)`, `Error::Protocol(...)`).

So the *interesting* discrimination happens one level down, inside `io::ErrorKind`.

### Recommended classification

| Class | Match | mDNS re-discovery? |
|---|---|---|
| **Address moved / host gone** | `Error::Io(e)` where `e.kind()` is `HostUnreachable`, `NetworkUnreachable`, `NetworkDown`, `TimedOut`, or `ConnectionRefused` | **yes** |
| **Name no longer resolves** | `Error::Io(e)` with an unmatched kind whose `raw_os_error()` is a getaddrinfo/WSA lookup failure (see caveat) | **yes** |
| **Bad stored URL** | `Error::Url(_)` | no — the stored string is malformed; surface it and offer the manual "edit address" path |
| **Wrong host answered / TLS identity mismatch** | `Error::Tls(TlsError::Rustls(_))`, `Error::Tls(TlsError::InvalidDnsName)` | **arguably yes** — a certificate mismatch is a strong signal that a *different* machine now owns the address (DHCP reuse). But it is also what a MITM looks like, so re-discovery here should still verify the runtime's public key before rewriting the store. |
| **Runtime is there but rejecting** | `Error::Http(resp)` (401/403/404/426/5xx), `Error::HttpFormat(_)`, `Error::Protocol(_)`, `Error::Capacity(_)` | **no** — the address is correct; something else (auth, revoked pairing, version skew, wrong path) is wrong. Re-discovery would just re-find the same box and mask a real error. |
| **Post-connect** | `ConnectionClosed`, `AlreadyClosed`, `WriteBufferFull`, `Utf8`, `AttackAttempt` | no — not reachable from `connect_async` |

`ConnectionRefused` is the debatable one. It means *a machine answered at that IP but nothing is listening on that port*. On a LAN with DHCP churn that is the single most common symptom of "the runtime's IP got reassigned to a different device", so it belongs in the re-discovery bucket. It is also what you get when the runtime is simply stopped on the same host — in which case re-discovery finds nothing and you fall through to the original error. That fallthrough makes including it safe.

### `io::ErrorKind` availability

`HostUnreachable`, `NetworkUnreachable`, `NetworkDown` were stabilized in **Rust 1.83.0** (`RELEASES.md`, 1.83.0 "Stabilized APIs" list). The repo builds with 1.96.1, so they are usable directly. Platform mapping is std's: POSIX `EHOSTUNREACH`/`ENETUNREACH`/`ECONNREFUSED`/`ETIMEDOUT` and Windows `WSAEHOSTUNREACH`/`WSAENETUNREACH`/`WSAECONNREFUSED`/`WSAETIMEDOUT`.

### Caveat: DNS failures are not classifiable by `ErrorKind`

`ToSocketAddrs` lookup failures surface as `io::Error` with kind `Uncategorized` (unstable, so it can only be matched by the `_` arm) and a message like `failed to lookup address information: nodename nor servname provided`. On Windows they arrive as `from_raw_os_error(11001 /* WSAHOST_NOT_FOUND */)`, which std also leaves uncategorized. Two workarounds:

- Resolve the host yourself (`tokio::net::lookup_host`) before `connect_async` so you own the error classification, or
- Treat "unmatched `Error::Io` kind" as re-discoverable, since every *deterministic* failure has already been routed to a `Url`/`Http`/`Tls`/`Protocol` variant.

### Preserving the error changes downstream behavior

`packages/product-core/shared/remote-runtime-tailscale-hint.ts` appends a Tailscale suggestion by **regex-matching the message text**:

```ts
const REMOTE_RUNTIME_UNREACHABLE_RE =
  /could not connect to the remote pebble runtime|remote pebble runtime closed the connection|timed out (?:waiting for|while connecting to) the remote pebble runtime/i
```

If the Rust error string at `remote_runtime_rpc.rs:231` stops starting with "Could not connect to the remote Pebble runtime", that hint silently stops firing. Consumers: `packages/product-core/renderer/src/web/web-runtime-client.ts:413` and `:568`. Keep the canonical prefix and append the detail (e.g. `"Could not connect to the remote Pebble runtime: connection refused (ws://192.168.1.9:6768)"`), or update the regex and its tests (`remote-runtime-tailscale-hint.test.ts`).

Also note `pebble-tauri-runtime-control-api.ts:264-274` and `:270-278` wrap invoke failures into `failRuntimeRpc('remote_runtime_unavailable', getErrorMessage(error))`, so whatever string Rust returns is what the UI shows.

## External References

- Vendored source read directly from `~/.cargo/registry/src/rsproxy.cn-e3de039b2554c837/tungstenite-0.26.2/src/error.rs` and `.../tokio-tungstenite-0.26.2/src/connect.rs`.
- <https://doc.rust-lang.org/stable/std/io/enum.ErrorKind.html> — variant list and stabilization.

## Caveats / Not Found

- `Error` and its sub-enums are `#[non_exhaustive]`; any `match` needs a `_` arm and will keep compiling across patch bumps but may silently mis-classify new variants.
- Did not verify empirically which `ErrorKind` macOS returns for a host that is powered off vs. one that is present-but-not-listening; on a LAN the former typically yields `TimedOut` (ARP timeout) and the latter `ConnectionRefused`.
