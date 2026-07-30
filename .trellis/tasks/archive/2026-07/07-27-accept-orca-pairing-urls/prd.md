# Accept Orca pairing URLs for remote servers

## Goal

Let Pebble clients add a remote runtime by pasting an Orca-style pairing URL (`orca://pair?code=…`), so users can connect Pebble to an Orca remote server that exposes a compatible runtime pairing offer.

## Background

- Orca (stablyai/orca) and Pebble share the same pairing-offer wire shape (`v: 2`, `endpoint`, `deviceToken`, `publicKeyB64`, optional `scope`).
- Orca emits `orca://pair?code=<base64url>` while Pebble only accepts `pebble://pair?code=…` (or a bare payload).
- Pasting an `orca://…` URL into **Settings → Remote Pebble Servers** fails with “无法保存运行时环境” / “Unable to save runtime environment” because `parsePairingCode` rejects the scheme before the payload is decoded.

## Requirements

1. **Parse Orca pairing URLs** wherever Pebble accepts remote pairing codes:
   - desktop/shared `parsePairingCode` / `decodePairingOffer` (Settings + CLI + environment store)
   - web client pairing parser
   - mobile paste/QR pairing parser
   - desktop deep-link pair action parser (when the URL reaches the app)
2. **Accept only the pairing route** `orca://pair` (query `code` or hash), matching existing host/path strictness for `pebble://pair`. Reject `orca://pairing`, `orca://pair-extra`, etc.
3. **Keep encoding as Pebble-native**: newly generated pairing URLs from Pebble still use `pebble://pair?code=…`.
4. **Do not claim full product interop**: this task only unblocks pairing-URL import. SSH relay branding (`ORCA-RELAY` vs `PEBBLE-RELAY`) and any post-connect RPC drift are out of scope unless a follow-up finds a hard break after scheme acceptance.
5. **Preserve bare-payload paste**: a base64url offer without a scheme still works (existing behavior / workaround).

## Non-goals

- Registering the OS-level `orca://` protocol handler for Pebble.
- Rebranding Pebble UI/copy to say “Orca servers”.
- Making Pebble’s Go `serve` emit `orca://` URLs.
- Full protocol parity with every Orca version (relay invite field, mobile relay director, etc.) beyond ignoring unknown offer fields already allowed by Zod/default parse.

## Acceptance Criteria

- [x] Pasting a valid `orca://pair?code=…` offer into Remote Pebble Servers creates a runtime environment (no invalid-pairing-code save error).
- [x] `orca://pair#…` legacy hash form also parses.
- [x] Invalid routes (`orca://pairing?…`, wrong host) still fail.
- [x] Existing `pebble://pair?…` and bare-payload paths keep working.
- [x] Unit tests cover Orca scheme accept/reject cases in shared + web + mobile pairing parsers.
- [x] Desktop deep-link pair parser accepts `orca://pair` for the pair action only (other deep-link hosts stay `pebble:`-only).

## Notes / risks

- Pairing URLs that embed `endpoint: ws://127.0.0.1…` only reach a server on the same machine; users still need a reachable `--pairing-address` / connection address on the Orca host.
- If Orca’s remote WebSocket runtime has diverged from Pebble’s E2EE handshake, save will succeed but connect/status may still fail — track as a follow-up interop task if observed.
