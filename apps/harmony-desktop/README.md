# Pebble — HarmonyOS PC desktop shell

ArkTS HAP shell for Pebble on HarmonyOS NEXT **2in1 / PC**. Does **not** use Electron or Tauri.

## Decision (read this)

**Normal HAP cannot host Go `pebble-runtime`** (SELinux blocks exec; musl rejects Go `c-shared` dlopen).  
We do **not** grow a C++ fake control plane.

| Layer | Role |
|-------|------|
| **This HAP** | Shell only: lifecycle, product-core web, packaging smoke probe |
| **Real brain** | Go `pebble-runtime` via **hybrid host** (V1) or **privileged local host** (mid-term) |

Full write-up: [`docs/reference/investigations/harmony-runtime-host.md`](../../docs/reference/investigations/harmony-runtime-host.md).

```text
EntryAbility
  → stage product-core web → filesDir
  → C++ shell probe :18777 (static UI + /v1/status smoke — NOT Go)
  → WebView → http://127.0.0.1:18777/web-index.html?pairing=<code>
       └─ pairs over E2EE WS to host Go on :17778 (hybrid; not Pebble.app :17777)
```

## Prerequisites

- DevEco Studio 6.x + PebblePC emulator (or device)
- Go 1.26+ (hybrid host + optional stage-runtime)
- pnpm/npm (product-core web)

## One-time / iterative workflow

### 1) Stage product-core web into the HAP

```bash
./apps/harmony-desktop/scripts/stage-web.sh
```

### 2) Start **real** Go runtime on the host (hybrid V1)

```bash
./apps/harmony-desktop/scripts/run-hybrid-runtime.sh
# sets hdc rport, mints pairing, seeds demo project+session by default
./apps/harmony-desktop/scripts/stage-hybrid-pairing.sh
```

### 3) Build, sign, install HAP

```bash
./apps/harmony-desktop/scripts/install-hap.sh
# or DevEco Run
```

After install, status bar should show `hybrid_ready` when pairing code is packaged, and product-core WebConnect should auto-save the **runtime** offer.

### Emulator → host

Default path is **reliable reverse port forward**:

```bash
# run-hybrid-runtime.sh already does:
hdc rport tcp:17778 tcp:17778   # device 127.0.0.1:17778 → host Go
# pairing endpoint: ws://127.0.0.1:17778/v1/shared-control
```

LAN / physical device (no rport):

```bash
HARMONY_PAIRING_HOST=192.168.x.x HARMONY_SKIP_RPORT=1 ./apps/harmony-desktop/scripts/run-hybrid-runtime.sh
```

## Ports

| Port | Process |
|------|---------|
| **18777** | HAP C++ shell probe + static web |
| **17778** | Host Go `pebble-runtime` (Harmony hybrid) |
| **17777** | Reserved — macOS `Pebble.app` desktop runtime |

## What this scaffold does today

| Feature | Status |
|---------|--------|
| HAP module for 2in1/PC | Yes |
| product-core web staged + loopback HTTP | Yes |
| Honest shell probe (not fake Go) | Yes |
| Hybrid script → real Go + pairing inject | Yes |
| Local Go under normal HAP sandbox | **Blocked** (by design decision) |
| Privileged local host | Planned (docs) |

## Bundle identity

- `bundleName`: `nebutra.pebble.desktop`
- Module: `entry` / `EntryAbility`
