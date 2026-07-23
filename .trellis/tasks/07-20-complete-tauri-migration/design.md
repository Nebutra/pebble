# Complete Tauri Migration Design

## Boundary

The migration removes the Electron execution and evidence planes, not merely the
directory. Deletion is last. Each consumer first moves to a Tauri, Rust, Go, CLI,
or immutable-baseline owner, then repository verification flips from requiring
the reference to forbidding it.

## Workstreams

### 1. Canonical Contracts And Computer CI

Move shared protocol constants and hook integration tests out of Electron source.
Remove redundant Electron builds from computer-use jobs. Replace Electron main/RPC
tests with the already-shipping Rust command, Go runtime, CLI, and native-provider
tests, adding missing assertions before deleting any coverage.

### 2. Native And Renderer Test Transports

Do not emulate ElectronApplication or promise a universal hidden WebView driver.
macOS WKWebView does not expose the same desktop WebDriver transport as Linux and
Windows. Split ownership by behavior:

- browser Playwright with a typed mock preload owns renderer-only behavior;
- release-excluded embedded Tauri automation owns DOM plus native lifecycle;
- Rust functional gates own native evidence that does not need DOM automation.

The native transport must launch with isolated data, provide graceful quit,
force kill/restart and process-tree cleanup, and remain explicit about visible
versus hidden/throttled WebView behavior on every platform.

No test may reach Rust/Tauri internals through an Electron main-process evaluate.

### 3. Evidence And Performance

Port terminal golden/performance, SSH, startup, idle CPU, and daemon cold-start
launchers to the Tauri driver or native executable. Runtime/pixel comparisons use
reviewed immutable Tauri baselines; baseline refresh is an explicit Tauri capture,
not a release-time second shell launch.

### 4. Dependency Erasure

After all consumers migrate, remove parity scripts, Electron runtime installers,
workspace/config includes, CI steps, dependencies, and the reference directory.
Regenerate the lockfile and make the layout/mainline verifiers reject restoration.

### 5. Release Trust Chain

Keep the updater public key as the immutable verification contract and inject
only private signing material through GitHub Actions secrets. Do not generate or
rotate the updater key automatically because existing Tauri installations pin
that trust root.

For macOS, prepare every nested executable resource before Tauri seals the app.
The computer-use helper keeps its dedicated entitlements, while the main bundle
uses the repository-owned hardened-runtime entitlements. Release preflight owns
credential completeness; artifact inspection owns Developer ID identity,
strict nested signatures, updater signatures, and stapled notarization tickets.

The preferred notarization mode is an App Store Connect team API key. GitHub
stores the key ID, issuer UUID, and `.p8` contents as separate secrets; a
macOS-only step writes the key to `$RUNNER_TEMP` with restrictive permissions
and exports `APPLE_API_KEY_PATH`. Apple ID plus app-specific password remains a
fallback, but partial or mixed credential sets fail preflight.

### 6. Canonical Product Origin

Application code, release workflows, public documentation, mobile links, and
package metadata use `https://pebble.nebutra.com` as the single product origin.
Product paths move from `/pebble/<path>` to `/<path>` on that host. GitHub
Releases and the release Atom feed remain owned by GitHub.

Deployment compatibility is intentionally outside the application: human GET
pages may redirect, while changelog/nudge JSON, media, diagnostics, and feedback
routes are mirrored or reverse-proxied so clients do not rely on redirect method,
body, authorization-header, or cache behavior.

## Compatibility

- Cross-platform behavior stays behind runtime/platform checks.
- SSH and remote-host tests continue using deployed Go/relay contracts.
- Repository paths and text retain no retired product identity or path forms;
  regression fixtures assemble test values without embedding the retired name.
- Historical schema compatibility remains unless an explicit migration proves
  stored data and telemetry consumers no longer need it.
- macOS-only bundle preparation stays behind platform checks so Linux and
  Windows release runners do not require Apple tooling or helper artifacts.

## Rollback

Each workstream lands only after its replacement checks pass. Before final
directory deletion, rollback is limited to the affected Tauri harness or gate.
After deletion, the repository verifier and lockfile provide the authoritative
boundary; restoration of Electron is not an accepted rollback mechanism.
