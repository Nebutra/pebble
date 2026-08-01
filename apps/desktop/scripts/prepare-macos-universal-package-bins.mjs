/**
 * Tauri `build --target universal-apple-darwin` lipos the primary package
 * binary into target/universal-apple-darwin/release/, but secondary [[bin]]
 * targets (auto-discovered under src/bin/) stay only under the arch-specific
 * release dirs. Bundle then fails copying them from the universal path.
 *
 * Lipo every secondary package binary that exists for both slices so bundling
 * can proceed. No-op when not building universal or when slices are missing.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const SECONDARY_BINARIES = ['pebble-updater-signature-verifier']

export function prepareMacosUniversalPackageBins({ desktopRoot, platform = process.platform }) {
  if (platform !== 'darwin') {
    return { prepared: false, lipo: [] }
  }

  const targetRoot = resolve(desktopRoot, 'src-tauri/target')
  const armDir = resolve(targetRoot, 'aarch64-apple-darwin/release')
  const intelDir = resolve(targetRoot, 'x86_64-apple-darwin/release')
  const universalDir = resolve(targetRoot, 'universal-apple-darwin/release')

  if (!existsSync(armDir) || !existsSync(intelDir)) {
    return { prepared: false, lipo: [] }
  }

  mkdirSync(universalDir, { recursive: true })
  const lipo = []
  for (const name of discoverSecondaryBinaries(armDir, intelDir)) {
    const arm = resolve(armDir, name)
    const intel = resolve(intelDir, name)
    const out = resolve(universalDir, name)
    const result = spawnSync('lipo', ['-create', '-output', out, arm, intel], {
      encoding: 'utf8'
    })
    if (result.status !== 0) {
      throw new Error(
        `lipo failed for ${name}: ${result.stderr?.trim() || result.stdout?.trim() || 'unknown error'}`
      )
    }
    lipo.push(name)
  }
  return { prepared: lipo.length > 0, lipo }
}

function discoverSecondaryBinaries(armDir, intelDir) {
  const known = SECONDARY_BINARIES.filter(
    (name) => existsSync(resolve(armDir, name)) && existsSync(resolve(intelDir, name))
  )
  // Also pick up any future src/bin/* that cargo placed in both slices.
  const extras = readdirSync(armDir)
    .filter((name) => !name.includes('.') && !name.startsWith('deps') && !name.startsWith('build'))
    .filter((name) => name !== 'pebble-desktop-tauri')
    .filter((name) => existsSync(resolve(intelDir, name)))
    .filter((name) => !known.includes(name))
  return [...new Set([...known, ...extras])]
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const result = prepareMacosUniversalPackageBins({
    desktopRoot: resolve(import.meta.dirname, '..')
  })
  if (result.lipo.length > 0) {
    console.log(`Lipo'd universal package bins: ${result.lipo.join(', ')}`)
  }
}
