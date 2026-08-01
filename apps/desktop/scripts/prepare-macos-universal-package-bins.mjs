/**
 * Tauri `build --target universal-apple-darwin` lipos the primary package
 * binary into target/universal-apple-darwin/release/, but secondary [[bin]]
 * targets (auto-discovered under src/bin/) stay only under the arch-specific
 * release dirs. Bundle then fails copying them from the universal path.
 *
 * Lipo every secondary package binary that exists for both slices so bundling
 * can proceed. No-op when not building universal or when slices are missing.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

// Only package secondary cargo bins we know must ship next to the main app.
// Do not scan the release dir — it contains directories like `binaries/` that
// lipo cannot open (`can't map input file: .../release/binaries`).
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
  for (const name of SECONDARY_BINARIES) {
    const arm = resolve(armDir, name)
    const intel = resolve(intelDir, name)
    if (!isRegularFile(arm) || !isRegularFile(intel)) {
      continue
    }
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

function isRegularFile(path) {
  return existsSync(path) && statSync(path).isFile()
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const result = prepareMacosUniversalPackageBins({
    desktopRoot: resolve(import.meta.dirname, '..')
  })
  if (result.lipo.length > 0) {
    console.log(`Lipo'd universal package bins: ${result.lipo.join(', ')}`)
  }
}
