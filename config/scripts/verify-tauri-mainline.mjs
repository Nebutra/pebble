import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')

const checks = [
  {
    name: 'Tauri renderer imports the root React app',
    file: 'pebble/desktop-tauri/src/main.tsx',
    expect: (text) =>
      /import\s+App\s+from\s+['"]@\/App['"]/.test(text) &&
      text.includes("import { installTauriWindowApi } from './tauri-window-api'") &&
      text.includes('installTauriWindowApi()')
  },
  {
    name: 'Tauri preload installs the web-compatible API bridge',
    file: 'pebble/desktop-tauri/src/pebble-tauri-preload-api.ts',
    expect: (text) =>
      text.includes("import { installWebPreloadApi } from '@/web/web-preload-api'") &&
      text.includes('installWebPreloadApi()') &&
      text.includes('void ensurePebbleRuntimeProcess()')
  },
  {
    name: 'Tauri window API bridges native window controls',
    file: 'pebble/desktop-tauri/src/tauri-window-api.ts',
    expect: (text) =>
      text.includes("import { getCurrentWindow } from '@tauri-apps/api/window'") &&
      text.includes('export function installTauriWindowApi') &&
      text.includes('toggleMaximize()') &&
      text.includes('installTauriWindowCloseInterceptor') &&
      text.includes('event.preventDefault()')
  },
  {
    name: 'Tauri Vite aliases @ to the canonical renderer source',
    file: 'pebble/desktop-tauri/vite.config.ts',
    expect: (text) =>
      text.includes("const rendererSource = resolve(repoRoot, 'src/renderer/src')") &&
      text.includes("'@': rendererSource") &&
      text.includes("dedupe: ['react', 'react-dom']")
  },
  {
    name: 'Tauri CSS imports the canonical renderer stylesheet',
    file: 'pebble/desktop-tauri/src/pebble-renderer.css',
    expect: (text) =>
      text.includes("@import '../../../src/renderer/src/assets/main.css';") &&
      text.includes("@source '../../../src/renderer/src';")
  },
  {
    name: 'Roadmap declares Tauri as the desktop mainline and Electron as parity-only',
    file: 'ROADMAP.md',
    expect: (text) =>
      text.includes('Tauri desktop mainline migration') &&
      text.includes('Electron is a parity reference only')
  },
  {
    name: 'Root package exposes the Tauri mainline verifier',
    file: 'package.json',
    expect: (text) =>
      text.includes('"verify:tauri-mainline": "node config/scripts/verify-tauri-mainline.mjs"')
  },
  {
    name: 'PR workflow runs the Tauri mainline verifier',
    file: '.github/workflows/pr.yml',
    expect: (text) =>
      text.includes('Verify Tauri desktop mainline contract') &&
      text.includes('pnpm verify:tauri-mainline')
  }
]

const failures = []

for (const check of checks) {
  const text = await readFile(resolve(repoRoot, check.file), 'utf8')
  if (!check.expect(text)) {
    failures.push(`${check.name}: ${check.file}`)
  }
}

const tauriConfig = JSON.parse(
  await readFile(resolve(repoRoot, 'pebble/desktop-tauri/src-tauri/tauri.conf.json'), 'utf8')
)
const mainWindow = tauriConfig.app?.windows?.[0]
const tauriConfigFailures = [
  ['productName', tauriConfig.productName, 'Pebble'],
  ['identifier', tauriConfig.identifier, 'nebutra.pebble'],
  ['devUrl', tauriConfig.build?.devUrl, 'http://127.0.0.1:5174'],
  ['width', mainWindow?.width, 1200],
  ['height', mainWindow?.height, 800],
  ['minWidth', mainWindow?.minWidth, 600],
  ['minHeight', mainWindow?.minHeight, 400]
].filter(([, actual, expected]) => actual !== expected)

for (const [field, actual, expected] of tauriConfigFailures) {
  failures.push(
    `Tauri config ${field} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

if (failures.length > 0) {
  console.error('Tauri mainline verification failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Tauri mainline verification passed.')
