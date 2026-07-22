# Release Signing

## Scenario: macOS Notarization And Tauri Updater Signing

### 1. Scope / Trigger

- Trigger: changing Tauri bundle configuration, macOS nested resources,
  release credentials, updater manifests, or release artifact verification.
- The release trust chain spans `tauri.conf.json`, `tauri.macos.conf.json`, the
  reusable GitHub workflow, platform bundle preparation, and artifact evidence.

### 2. Signatures

- Pre-bundle hook: `node scripts/prepare-macos-bundle-resources.mjs`.
- API-key preparation: `node config/scripts/prepare-apple-api-key.mjs`.
- Release preparation: `node config/scripts/prepare-tauri-release-config.mjs`.
- Preflight: `node config/scripts/verify-tauri-release-preflight.mjs <platform>`.
- Artifact inspection: `node config/scripts/verify-tauri-release-artifacts.mjs
--platform <platform> --target-triple <triple> --output <path>`.

### 3. Contracts

- Updater environment, required on release runners:
  `TAURI_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY`, and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- macOS environment: `MAC_CERTS` maps to `APPLE_CERTIFICATE`,
  `MAC_CERTS_PASSWORD` maps to `APPLE_CERTIFICATE_PASSWORD`, and
  `APPLE_TEAM_ID` plus `PEBBLE_MAC_RELEASE=1` are required. Notarization uses
  exactly one complete mode: preferred `APPLE_API_KEY`, `APPLE_API_ISSUER`, and
  runner-temporary `APPLE_API_KEY_PATH`, or fallback `APPLE_ID` and
  `APPLE_APP_SPECIFIC_PASSWORD` (as `APPLE_PASSWORD`).
- GitHub stores `.p8` contents only in `APPLE_API_KEY_P8`. The macOS preparation
  step creates a unique directory below absolute `RUNNER_TEMP`, writes the key
  with exclusive creation and mode `0600`, and exports only its absolute path
  through absolute `GITHUB_ENV`.
- `bundle.createUpdaterArtifacts` must be `true` in the prepared release config.
- The main app uses `resources/build/entitlements.mac.plist`; the nested
  computer-use helper uses `resources/build/entitlements.computer-use.mac.plist`.
- `tauri.macos.conf.json` adds the helper app as a macOS-only resource. Tauri's
  RFC 7396 merge preserves the base resource map.
- Updater public-key rotation is not routine maintenance: installed clients pin
  the key, so rotation requires an explicit compatibility and rollout plan.

### 4. Validation & Error Matrix

- Missing or placeholder updater value -> fail before packaging and name only
  the invalid environment keys; never print their values.
- Prepared config public key differs from the environment -> fail preflight.
- Missing, partial, or mixed Apple notarization mode, or
  `PEBBLE_MAC_RELEASE != 1` -> fail the macOS leg without printing values.
- Non-UUID `APPLE_API_ISSUER`, relative/newline-containing runner paths, or an
  unsafe `APPLE_API_KEY_PATH` -> fail without echoing the rejected value.
- `APPLE_API_KEY_P8` on a non-macOS runner -> fail before writing any file.
- Missing macOS pre-bundle hook, helper resource, hardened runtime, or main
  entitlements path -> fail preflight.
- Ad-hoc signature, wrong Team ID, missing entitlement, invalid updater
  signature, or unstapled app/DMG -> fail artifact inspection.

### 5. Good/Base/Bad Cases

- Good: the helper is signed before Tauri seals the outer app; the app and DMG
  carry stapled tickets; updater payload signatures verify against the pinned key.
- Base: Linux and Windows merge only the base config and never invoke Swift or
  Apple signing tools.
- Bad: copying the helper after bundling invalidates the outer resource seal;
  rotating the updater key without migration strands installed clients.
- Bad: writing the `.p8` to a predictable path permits symlink replacement;
  placing its contents in `GITHUB_ENV` persists secret material across steps.

### 6. Tests Required

- `prepare-tauri-release-config.test.mjs`: assert all updater signing values are
  present, non-placeholder, and never persisted into Tauri config.
- `prepare-macos-bundle-resources.test.mjs`: assert speech libraries and the
  helper are prepared in order on macOS and skipped elsewhere.
- `prepare-apple-api-key.test.mjs`: assert unique runner-temp containment,
  exclusive `0600` creation, exact multiline P8 preservation, path-only
  `GITHUB_ENV` export, missing variables, path injection, and non-macOS refusal.
- `verify-tauri-release-preflight.test.mjs`: assert environment, config, helper,
  entitlements, updater, complete/exclusive notarization modes, issuer UUID,
  safe key path, and platform gates.
- `verify-tauri-macos-signing.test.mjs` and artifact tests: assert Developer ID
  metadata, required entitlements, strict nested signatures, updater signatures,
  and stapled app/DMG tickets.
- `tauri-release-workflow.test.mjs`: assert platform-gated credential wiring and
  `PEBBLE_MAC_RELEASE=1`, including runner-temporary API-key materialization.
- Run `verify:tauri-mainline`, relevant lint/typecheck, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```yaml
env:
  APPLE_CERTIFICATE: ${{ secrets.MAC_CERTS }}
```

This exposes Apple-only inputs to every matrix leg and does not place the nested
helper into the bundle before sealing.

#### Correct

```yaml
env:
  APPLE_CERTIFICATE: ${{ matrix.platform == 'macos' && secrets.MAC_CERTS || '' }}
  PEBBLE_MAC_RELEASE: ${{ matrix.platform == 'macos' && '1' || '' }}
```

The macOS platform override owns its pre-bundle helper resource, while shared
updater signing inputs remain available to every updater-producing release leg.
