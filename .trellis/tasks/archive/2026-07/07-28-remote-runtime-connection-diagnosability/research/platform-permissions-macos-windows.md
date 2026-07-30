# Research: macOS / Windows permission gotchas for mDNS from the Tauri app

- **Query**: does the app need `com.apple.developer.networking.multicast`? Does macOS 15 Local Network privacy apply? What must be added to entitlements / Info.plist, and does it affect notarization? Windows firewall implications?
- **Scope**: mixed (repo config + Apple developer documentation)
- **Date**: 2026-07-28

## Short answers

1. **`com.apple.developer.networking.multicast` is NOT needed.** It is iOS/iPadOS/visionOS only. Apple's own words: *"The multicast entitlement isn't required on macOS."*
2. **macOS 15+ Local Network privacy DOES apply** — and it already applies today, before any mDNS work, because dialing `ws://192.168.x.x:...` is itself a gated local-network operation.
3. **What to add**: `NSLocalNetworkUsageDescription` (and `NSBonjourServices` if the discovery path ever goes through the system Bonjour APIs) to `apps/desktop/src-tauri/Info.plist`. **No entitlement change. No notarization impact.**
4. **Windows**: binding UDP 5353 and joining `224.0.0.251` will trigger the Windows Defender Firewall "allow this app" prompt on first run (elevation required). No manifest fix; either accept the prompt or add a firewall rule from the installer.

## Findings

### Current macOS configuration in this repo

| File | Contents relevant here |
|---|---|
| `apps/desktop/src-tauri/Info.plist` | Only `NSCameraUsageDescription` and `NSMicrophoneUsageDescription`. **No `NSLocalNetworkUsageDescription`, no `NSBonjourServices`.** |
| `resources/build/entitlements.mac.plist` | `apple-events`, `device.audio-input`, `device.bluetooth`, `device.camera`, `device.usb`, `personal-information.location`, `cs.allow-dyld-environment-variables`, `cs.allow-jit`, `cs.allow-unsigned-executable-memory`. **No `com.apple.security.app-sandbox`**, and no `com.apple.security.network.client` / `.network.server`. |
| `apps/desktop/src-tauri/tauri.conf.json` `bundle.macOS` | `"entitlements": "../../../resources/build/entitlements.mac.plist"`, `"hardenedRuntime": true` |
| `apps/desktop/src-tauri/tauri.macos.conf.json` | only a `beforeBundleCommand` and the Computer Use helper app resource |

Because the app is **not sandboxed** (no `com.apple.security.app-sandbox` key), the App Sandbox network entitlements (`com.apple.security.network.client` / `.network.server`) are irrelevant — they only gate sandboxed apps. Hardened Runtime does not restrict networking at all. So **the entitlements file needs no change for mDNS.**

### `com.apple.developer.networking.multicast` — not a macOS thing

From Apple's documentation JSON for the entitlement (`developer.apple.com/tutorials/data/documentation/bundleresources/entitlements/com.apple.developer.networking.multicast.json`):

- Abstract: *"A Boolean value that indicates whether an app can send or receive IP multicast traffic."*
- **Platforms: iOS 14.0, iPadOS 14.0, visionOS 1.0. macOS is not listed.**
- Body: *"Your app must have this entitlement to send or receive IP multicast or broadcast **on iOS**. It also allows your app to browse and advertise arbitrary Bonjour service types. This entitlement requires permission from Apple before you can use it in your app."*

And Apple TN3179 *Understanding local network privacy*, "Essentials" section, states outright:

> Additionally, if your **iOS** app performs multicast operations, sign it with the multicast entitlement. […] **The multicast entitlement isn't required on macOS.**

So: do not add it, do not file the Apple request form. (It is a *managed* entitlement — requesting it needlessly would also complicate the provisioning profile.)

### macOS 15 Local Network privacy — this is the real gotcha

TN3179, platform table:

| Platform | Supported | Introduced |
|---|---|---|
| iOS / iPadOS | yes | 14 |
| **macOS** | **yes** | **macOS 15** |
| visionOS | yes | 1 |
| tvOS / watchOS | no | — |

TN3179, "Local network operations":

> A local network is an IP network associated with a broadcast-capable network interface. […] In addition, **all multicast addresses (224.0.0.0/4, ff00::/8)** and the IPv4 broadcast address are local network addresses.

| Operation | Local network access required |
|---|---|
| Making an outgoing TCP connection | **yes** |
| Sending a UDP multicast | **yes** |
| Receiving an incoming UDP multicast | **yes** |
| Receiving an incoming UDP unicast | no |

> The system implements these TCP and UDP checks **deep in the networking stack**, and thus they apply to **all networking APIs**. This includes Network framework, **BSD Sockets**, […] and any APIs implemented on top of those.

Two consequences:

1. **A pure-Rust mDNS crate does not escape the check.** `mdns-sd` uses `socket2`/BSD sockets; the kernel gate applies just the same. There is no "bypass by not using Bonjour".
2. **Pebble already trips this gate today.** `tokio_tungstenite::connect_async("ws://192.168.1.9:6768")` at `apps/desktop/src-tauri/src/commands/remote_runtime_rpc.rs:229` is an outgoing TCP connection to a local-network address, so on macOS 15+ the user is *already* being prompted (or silently denied) for Local Network. This is a plausible contributing cause of the very bug this task is chasing — see the "first operation may be denied" note below.

TN3179, "DNS operations": resolving a `.local` name **also** requires local network access. If the stored endpoint were ever `ws://host.local:6768`, that resolution is gated too.

TN3179, "Bonjour operations": registering, browsing, and resolving via Bonjour all require local network access, and if you use the *system* Bonjour APIs (`NWBrowser`, `NSNetService`, `dns-sd`) you must list your service types in `NSBonjourServices`.

TN3179, "Essentials", the retry note — **directly relevant to the reconnect design**:

> If the system presents a local network alert in response to one of your local network operations, it **may deny the operation immediately, before the user has responded to the alert**. To handle this smoothly, use an API that supports waiting for connectivity […] If you can't use one of these preferred APIs, **add appropriate retry logic.**

Rust's `TcpStream::connect` and `mdns-sd` are not "wait for connectivity" APIs, so the very first mDNS browse (and the very first WebSocket dial) on a fresh macOS 15 install will fail while the alert is on screen. The retry/backoff already present (see `reconnect-backoff-integration.md`) covers this, but a re-discovery attempt must not conclude "not found" from a single sub-second browse.

TN3179, "macOS considerations":

- macOS keeps **per-user** local-network state.
- Automatically allowed: launchd daemons, anything running as root, and command-line tools run from Terminal or over SSH *including child processes*. **A GUI .app is none of these** — so Pebble is subject to the prompt.
- macOS attributes the operation to the "responsible code": *"if your app spawns a helper tool and the helper tool performs a local network operation, macOS considers the app to be the responsible code"*. This matters because Pebble spawns Go sidecars (`bundle.externalBin`: `binaries/pebble-runtime`, `pebble-control`, `pebble-relay-worker` in `tauri.conf.json`) — their local-network traffic is attributed to Pebble.app, and the grant is recorded for the whole app.
- Known bug: macOS does not show the alert for very short-lived processes (FB16131937). Not our case for the main app, but relevant if discovery were ever shelled out to a short-lived helper.
- macOS supports the `PrivacyLocalNetworkExemptEthernetSubnets` / `…ExemptWiFiSubnets` user defaults for exempting CIDR ranges — useful as a support workaround, not something to ship.

### Exactly what to add on macOS

To `apps/desktop/src-tauri/Info.plist` (Tauri merges this file into the generated bundle `Info.plist` — confirmed by `tauri-build-2.6.3/src/codegen/context.rs:119-128` and by `tauri-utils-2.9.3/src/config.rs:663-666`: *"Path to a Info.plist file to merge with the default Info.plist. Note that Tauri also looks for a `Info.plist` file in the same directory as the Tauri configuration file."* — and empirically by the fact that `NSCameraUsageDescription` already lives there):

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Pebble finds and reconnects to Pebble runtimes on your local network.</string>
```

Only if the implementation goes through the **system** Bonjour stack (`NWBrowser` / `dns-sd` / `zeroconf` / `astro-dnssd`) additionally:

```xml
<key>NSBonjourServices</key>
<array>
  <string>_pebble-runtime._tcp</string>
</array>
```

With the recommended pure-Rust `mdns-sd`, `NSBonjourServices` is not consulted by the kernel gate — but adding it is harmless and future-proofs a later switch, and it is the key the OS reads to render a nicer alert for Bonjour-API users.

**Entitlements: no change. `resources/build/entitlements.mac.plist` stays as-is.**

### Notarization / distribution impact: none

- No new entitlement means no provisioning-profile change and no Apple approval workflow.
- `Info.plist` usage-description strings are not entitlements; they are not evaluated by the notary service. Notarization checks code signing, hardened runtime, and malware scanning — an added `NSLocalNetworkUsageDescription` is inert to all three.
- `hardenedRuntime: true` stays. Multicast sockets need no hardened-runtime exception.
- The only distribution-facing change is behavioral: users on macOS 15+ will see a Local Network alert (they may already be seeing it). Worth a line in release notes.
- The app already surfaces a **Local Network** row in its own "macOS Permissions" pane — see below — so there is a natural place to teach the user about it.

### The app's existing macOS permissions pane

Referenced from `packages/product-core/renderer/src/components/settings/Settings.tsx:1458` ("macOS Permissions").

- UI: `packages/product-core/renderer/src/components/settings/DeveloperPermissionsPane.tsx`. There is **already a `local-network` entry** at `:127-146`, labelled "Local Network", described *"Discovery and access for development servers on your network."*, `actionLabel: 'Trigger Prompt'`, icon `Network`.
- Type: `packages/product-core/shared/developer-permissions-types.ts:8` — `'local-network'`.
- Rust: `apps/desktop/src-tauri/src/commands/developer_permissions.rs`
  - `DeveloperPermissionId::LocalNetwork` — `:14`, listed in `IDS` at `:41`
  - `permission_status` — `:79-95`: everything except `FullDiskAccess`, `Usb`, `Bluetooth` returns `"unknown"`, so Local Network currently reports **"Check manually"** in the UI (`statusLabel`, `DeveloperPermissionsPane.tsx:180-197`).
  - `open_privacy_pane` — `:97-115`: `LocalNetwork` falls into the catch-all `"Privacy"` anchor, i.e. `x-apple.systempreferences:com.apple.preference.security?Privacy` — it opens the *top* of Privacy & Security, not the Local Network list.
- Improvement available (out of scope but cheap): macOS 15 exposes the anchor `Privacy_LocalNetwork`, so `:107` could route `LocalNetwork` there instead of the generic `"Privacy"`. Unverified against a live macOS 15 machine.
- `developer_permissions_request` (`:56-69`) never actually *triggers* the OS prompt — it only opens System Settings. Triggering the Local Network alert requires performing a real local-network operation. An mDNS browse is precisely such an operation, so a "Trigger Prompt" that runs a 1-second browse would finally make that button honest.

### Windows

- **No manifest/entitlement equivalent.** Windows has no per-app multicast permission.
- **Firewall.** Windows Defender Firewall's default inbound policy blocks unsolicited inbound traffic. An mDNS *querier* must bind UDP 5353 and join the `224.0.0.251` group in order to receive responses, which is an inbound listen — so on first run Windows raises the **"Windows Security Alert — allow this app to communicate on these networks"** dialog with Private/Public checkboxes. Approving it requires UAC elevation; declining creates a *block* rule for the executable and mDNS then silently returns nothing forever after.
- Windows' own mDNS resolver (the DNS Client / `svchost.exe` service, present since Win10 1703) has built-in firewall rules, but those rules are scoped to `%SystemRoot%\system32\svchost.exe`, not to third-party executables. You do not inherit them.
- Outbound multicast *sends* are permitted by the default outbound-allow policy; it is only the receive side that needs the rule.
- **Installer option**: Tauri exposes `bundle.windows.nsis.installerHooks` (a path to a custom `.nsh` — `tauri-utils-2.9.3/src/config.rs:939`) and `bundle.windows.wix.template` / `fragmentPaths` (`:759`, `:848`). A `netsh advfirewall firewall add rule name="Pebble mDNS" dir=in action=allow protocol=UDP localport=5353 program="…\Pebble.exe"` in an NSIS hook would pre-create the rule and avoid the runtime prompt. This runs elevated during install. Neither hook is configured today (`tauri.windows.conf.json` only sets window geometry).
- **Practical fallback**: if the firewall blocks receive, mDNS discovery yields zero results and the flow must degrade to the manual "edit address" entry point rather than hanging. This makes the manual fallback (requirement c) non-optional on Windows.
- Corporate/managed Windows networks frequently block mDNS at the switch as well. Same degradation path.

### Linux (for completeness)

No permission gate. `mdns-sd` binds its own socket with `SO_REUSEADDR`+`SO_REUSEPORT` (`mdns-sd/src/service_daemon.rs:879-895`), so it coexists with a running `avahi-daemon` on 5353 instead of failing to bind. `firewalld`/`ufw` may block inbound 5353 on hardened distros.

## External References

- [TN3179: Understanding local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy) — platform table, operation tables, macOS considerations, retry guidance
- [`com.apple.developer.networking.multicast`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.multicast) — platforms iOS 14 / iPadOS 14 / visionOS 1 only
- [`NSLocalNetworkUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocalnetworkusagedescription)
- [`NSBonjourServices`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbonjourservices)
- WWDC24 session 10123 (introduced local network privacy on macOS), WWDC20 session 10110 (iOS)

## Caveats / Not Found

- The `Privacy_LocalNetwork` System Settings anchor is reported by third-party sources but I could not confirm it from Apple documentation; verify on a macOS 15 machine before changing `developer_permissions.rs:107`.
- I did not verify empirically whether macOS attributes the Local Network grant to `Pebble.app` when the *Go sidecar* (rather than the Tauri process) opens the socket. TN3179's "responsible code" language says it should, but the sidecars are `externalBin` executables inside the bundle, and edge cases exist.
- The exact Windows Defender Firewall prompt behavior for a *multicast group join* (vs. a plain `listen()`) was not verified on a live Windows machine; the described behavior is the well-known default-inbound-block policy applied to a UDP bind. Worth a manual test on Windows 11 before committing to the NSIS-hook approach.
- No `NSLocalNetworkUsageDescription` exists anywhere in the tree today; adding it is net-new.
