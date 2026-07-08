# Pebble React Native

This directory contains the Pebble React Native companion app.
It targets the runtime gateway and mobile relay contracts under
`../contracts/` and intentionally does not depend on the legacy `mobile/`
implementation.

The initial surface includes:

- Pairing state and persisted device identity.
- A reconnecting mobile relay websocket client that only sends `client.hello`
  after a pairing secret is available; first-time pairing uses `pair.start`.
- Relay protocol and projection types for terminal, source-control, browser,
  agent, file, orchestration, automation, external task, release, provider, and settings views.
- File projection, read, and write commands over the paired mobile relay.
- A local Expo `PebbleRelayCrypto` native module for iOS/Android relay encryption,
  with the TypeScript runtime still able to fall back to WebCrypto where present.
- A relay crypto diagnostic that exercises native or WebCrypto X25519, HKDF, and
  AES-GCM locally before pairing or reconnecting.
- Pairing secrets are stored only through SecureStore; when SecureStore is unavailable,
  reconnect secrets are not persisted in AsyncStorage.
- A React Native app shell with projection screens wired to relay state.

Build checks require the React Native/Expo toolchain and package installation:

```sh
npm install
npm run typecheck
npm run verify:native-crypto
npm run start
```
