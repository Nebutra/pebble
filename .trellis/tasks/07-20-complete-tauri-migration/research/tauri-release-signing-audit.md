# Tauri Release Signing Audit

## Existing Ownership

- `.github/workflows/tauri-desktop-release.yml` maps Apple certificate,
  notarization, and Tauri updater signing values into the release action.
- `config/scripts/prepare-tauri-release-config.mjs` enables updater artifacts
  and replaces the checked-in placeholder public key for release builds.
- `config/scripts/verify-tauri-release-preflight.mjs` validates platform release
  inputs before packaging.
- `config/scripts/verify-tauri-release-artifacts.mjs` verifies Developer ID
  metadata, strict nested signatures, updater signatures, and stapled app/DMG
  notarization evidence.
- `resources/build/entitlements.mac.plist` and
  `resources/build/entitlements.computer-use.mac.plist` are the existing
  entitlement owners.

## Gaps Found

- The main macOS entitlements file is not referenced by Tauri configuration.
- The computer-use helper is copied by a post-build local finalizer, but the
  GitHub release action invokes Tauri directly and therefore has no equivalent
  pre-bundle staging contract.
- Release preparation validates the updater private key but not its password.
- The release documentation does not enumerate the Actions secret contract or
  warn that updater key rotation breaks already-installed Tauri clients.

## External State

- The Developer ID certificate matches its CSR and resolves to the valid local
  identity `Developer ID Application: ZiXian Tang (2L5YC85FQ7)`.
- Repository Actions secrets now contain the encrypted Developer ID P12,
  certificate password, Team ID, App Store Connect key ID and `.p8` contents,
  issuer UUID, plus the first Tauri updater private/public key set.
- The team API key ID `LTM7747UGT` and issuer UUID authenticated successfully
  with `notarytool history`, confirming the credentials can reach Apple's
  notarization service without submitting a new artifact.
- Generated certificate/updater recovery values are stored in the login
  Keychain and were not written to the repository.

## Trust Constraint

Do not generate or rotate `TAURI_UPDATER_PUBLIC_KEY` / its private key as part
of this implementation. Existing Tauri clients pin the public key, so rotation
requires an explicit compatibility and rollout plan plus secure key custody.
