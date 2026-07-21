import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const requiredPaths = [
  'apps/desktop/package.json',
  'apps/mobile/package.json',
  'apps/mobile/src/transport/e2ee.ts',
  'apps/mobile/src/transport/rpc-client.ts',
  'runtime/go/go.mod',
  'runtime/go/internal/runtimehttp/legacy_shared_control_crypto.go',
  'native/rust-host/Cargo.toml',
  'native/zig-system/build.zig',
  'packages/contracts',
  'packages/product-core/package.json',
  'docs/architecture',
  'tests/e2e/baselines/desktop/landing.png',
  'tests/e2e/baselines/desktop/update.png',
  'tests/e2e/baselines/desktop/crash.png',
  'tests/e2e/baselines/desktop/settings.png'
]
const forbiddenPaths = [
  'pebble',
  'pebble/desktop-tauri',
  'pebble/go-runtime',
  'pebble/rust-host',
  'pebble/zig-system',
  'packages/product-core/main',
  'packages/product-core/preload',
  'src',
  'migration/electron-reference',
  'out/electron-dev',
  'electron.vite.config.ts',
  'config/electron-builder.config.cjs',
  'migration/mobile-relay-client',
  '.github/workflows/linux-wayland-gpu-sandbox.yml',
  'config/scripts/linux-wayland-renderer-diagnostics.mjs',
  'config/scripts/linux-wayland-terminal-exercise.mjs',
  'config/scripts/linux-wayland-validation-watchdog.mjs',
  'config/scripts/verify-linux-wayland-gpu-sandbox.mjs',
  'config/scripts/update-desktop-pixel-baselines.mjs',
  'config/scripts/verify-telemetry-constants.mjs'
]

const failures = []
for (const path of requiredPaths) {
  if (!existsSync(resolve(root, path))) {
    failures.push(`missing canonical path: ${path}`)
  }
}
for (const path of forbiddenPaths) {
  if (existsSync(resolve(root, path))) {
    failures.push(`obsolete nested path still exists: ${path}`)
  }
}

const desktopPackage = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'))
if (desktopPackage.name !== '@pebble/desktop') {
  failures.push('apps/desktop must keep the @pebble/desktop package identity')
}
const desktopHtml = readFileSync(resolve(root, 'apps/desktop/index.html'), 'utf8')
if (!desktopHtml.includes('/src/main.tsx')) {
  failures.push('apps/desktop must load the Tauri renderer bootstrap entry')
}

const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
if ('main' in rootPackage) {
  failures.push('the Pebble root package must not expose an Electron main entry')
}
for (const dependency of [
  'electron',
  'electron-builder',
  'electron-vite',
  'electron-updater',
  '@electron/rebuild',
  '@electron-toolkit/preload',
  '@electron-toolkit/tsconfig',
  '@electron-toolkit/utils'
]) {
  if (rootPackage.dependencies?.[dependency] || rootPackage.devDependencies?.[dependency]) {
    failures.push(`Electron-only dependency must not return: ${dependency}`)
  }
}

for (const scriptName of Object.keys(rootPackage.scripts ?? {})) {
  if (scriptName.startsWith('parity:electron:')) {
    failures.push(`Electron parity script must not return: ${scriptName}`)
  }
}

const productCorePackage = JSON.parse(
  readFileSync(resolve(root, 'packages/product-core/package.json'), 'utf8')
)
if (productCorePackage.name !== '@pebble/product-core' || productCorePackage.private !== true) {
  failures.push('packages/product-core must keep its private Pebble package identity')
}

const goModule = readFileSync(resolve(root, 'runtime/go/go.mod'), 'utf8')
if (!goModule.startsWith('module github.com/nebutra/pebble/runtime/go\n')) {
  failures.push('runtime/go must use the Nebutra Pebble module path')
}
const rustHostManifest = readFileSync(resolve(root, 'native/rust-host/Cargo.toml'), 'utf8')
if (!rustHostManifest.includes('path = "src/lib.rs"') || !rustHostManifest.includes('path = "src/bin/pebble-runtime-status.rs"')) {
  failures.push('native/rust-host must resolve its canonical src crate entries')
}
const zigSystemBuild = readFileSync(resolve(root, 'native/zig-system/build.zig'), 'utf8')
if (!zigSystemBuild.includes('b.path("src/pebble_system.zig")')) {
  failures.push('native/zig-system must resolve its canonical src entry')
}

const mobileCrypto = readFileSync(resolve(root, 'apps/mobile/src/transport/e2ee.ts'), 'utf8')
const mobileRpcClient = readFileSync(
  resolve(root, 'apps/mobile/src/transport/rpc-client.ts'),
  'utf8'
)
const runtimeCrypto = readFileSync(
  resolve(root, 'runtime/go/internal/runtimehttp/legacy_shared_control_crypto.go'),
  'utf8'
)
if (
  !mobileCrypto.includes('nacl.box.before') ||
  !mobileCrypto.includes('nacl.box.after') ||
  !mobileCrypto.includes('nacl.box.open.after') ||
  !mobileRpcClient.includes("type: 'e2ee_hello'") ||
  !mobileRpcClient.includes("type: 'e2ee_auth'") ||
  !runtimeCrypto.includes('box.Precompute')
) {
  failures.push('apps/mobile and runtime/go must retain the canonical encrypted RPC handshake')
}

if (failures.length > 0) {
  console.error('Pebble repository layout verification failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Pebble repository layout verification passed.')
