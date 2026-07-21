import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export function assertTauriVersionsMatch(versions) {
  const entries = Object.entries(versions)
  const expected = versions.rootPackage
  const mismatches = entries.filter(([, version]) => version !== expected)
  if (mismatches.length === 0) return expected
  const details = entries.map(([source, version]) => `${source}=${version}`).join(', ')
  throw new Error(`Pebble desktop versions must match: ${details}`)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function readCargoPackageVersion(manifestPath) {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', manifestPath],
      { encoding: 'utf8' }
    )
  )
  const packageRecord = metadata.packages.find((entry) => entry.name === 'pebble-desktop-tauri')
  if (!packageRecord?.version) throw new Error('Cargo metadata omitted pebble-desktop-tauri')
  return packageRecord.version
}

export async function verifyTauriVersionSync(root = repoRoot) {
  const manifestPath = resolve(root, 'apps/desktop/src-tauri/Cargo.toml')
  const [rootPackage, desktopPackage, tauriConfig] = await Promise.all([
    readJson(resolve(root, 'package.json')),
    readJson(resolve(root, 'apps/desktop/package.json')),
    readJson(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'))
  ])
  return assertTauriVersionsMatch({
    rootPackage: rootPackage.version,
    desktopPackage: desktopPackage.version,
    tauriConfig: tauriConfig.version,
    cargoPackage: readCargoPackageVersion(manifestPath)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = await verifyTauriVersionSync()
  console.log(`Pebble Tauri version sync verified: ${version}`)
}
