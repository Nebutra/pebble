/**
 * CI wrapper for `tauri-action` on macOS:
 * 1) Build with codesign only (no notarytool) so nested binaries can be fixed first.
 * 2) Finalize nested Developer ID + hardened-runtime signatures (serve-sim-bin, etc.).
 * 3) Notarize + staple app and DMG when ASC API credentials are present.
 *
 * Usage (from apps/desktop): node scripts/tauri-release-build.mjs build --target ... --bundles ...
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { finalizeMacosAppBundle } from './finalize-macos-app-bundle.mjs'

const desktopRoot = resolve(import.meta.dirname, '..')
const tauriArgs = process.argv.slice(2)

function run(command, args, { env = process.env, cwd = desktopRoot } = {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function discoverBundleDir() {
  const candidates = [
    resolve(desktopRoot, 'src-tauri/target/universal-apple-darwin/release/bundle'),
    resolve(desktopRoot, 'src-tauri/target/release/bundle'),
    resolve(desktopRoot, 'src-tauri/target/aarch64-apple-darwin/release/bundle'),
    resolve(desktopRoot, 'src-tauri/target/x86_64-apple-darwin/release/bundle')
  ]
  return candidates.find((path) => existsSync(path))
}

/** Prefer app-only during Tauri build; DMG is rebuilt from the stapled app. */
function rewriteBundlesForNestedSign(args) {
  const out = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--bundles' && args[i + 1]) {
      out.push('--bundles', 'app')
      i += 1
      continue
    }
    out.push(args[i])
  }
  return out
}

function notarizePath({ path, keyId, issuer, keyPath, staple = true }) {
  console.log(`Submitting ${path} to Apple notary service…`)
  run('xcrun', [
    'notarytool',
    'submit',
    path,
    '--key',
    keyPath,
    '--key-id',
    keyId,
    '--issuer',
    issuer,
    '--wait'
  ])
  if (!staple) {
    return
  }
  console.log(`Stapling notarization ticket onto ${path}…`)
  run('xcrun', ['stapler', 'staple', path])
}

function buildDmgFromApp(appPath, bundleDir) {
  const dmgDir = resolve(bundleDir, 'dmg')
  execFileSync('mkdir', ['-p', dmgDir], { stdio: 'inherit' })
  // Name must match releaseAssetNamePattern pebble-macos-universal[ext] for tauri-action upload.
  const dmgPath = resolve(dmgDir, 'pebble-macos-universal.dmg')
  // Replace any pre-finalize DMG so users never get nested-unsigned installers.
  for (const stale of ['Pebble.dmg', 'pebble-macos-universal.dmg']) {
    const candidate = resolve(dmgDir, stale)
    if (existsSync(candidate)) {
      execFileSync('rm', ['-f', candidate], { stdio: 'inherit' })
    }
  }
  console.log(`Creating DMG from notarized app at ${dmgPath}…`)
  run('hdiutil', [
    'create',
    '-volname',
    'Pebble',
    '-srcfolder',
    appPath,
    '-ov',
    '-format',
    'UDZO',
    dmgPath
  ])
  return dmgPath
}

function notarizeIfConfigured({ appPath, bundleDir, environment, wantDmg }) {
  const keyId = environment.APPLE_API_KEY?.trim()
  const issuer = environment.APPLE_API_ISSUER?.trim()
  const keyPath = environment.APPLE_API_KEY_PATH?.trim()
  if (!keyId || !issuer || !keyPath) {
    console.log('Skipping notarization (APPLE_API_KEY / ISSUER / KEY_PATH not fully set).')
    if (wantDmg) {
      buildDmgFromApp(appPath, bundleDir)
    }
    return
  }
  if (!existsSync(keyPath)) {
    throw new Error(`APPLE_API_KEY_PATH does not exist: ${keyPath}`)
  }

  const zipPath = resolve(bundleDir, 'macos', 'Pebble-for-notary.zip')
  execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath], { stdio: 'inherit' })
  // Notary the zip payload; staple the live .app bundle for Gatekeeper.
  notarizePath({ path: zipPath, keyId, issuer, keyPath, staple: false })
  run('xcrun', ['stapler', 'staple', appPath])

  if (wantDmg) {
    const dmgPath = buildDmgFromApp(appPath, bundleDir)
    notarizePath({ path: dmgPath, keyId, issuer, keyPath, staple: true })
  }
}

const wantDmg = tauriArgs.some(
  (arg, i) => arg === '--bundles' && String(tauriArgs[i + 1] ?? '').includes('dmg')
)
const buildArgs = rewriteBundlesForNestedSign(tauriArgs)

// Build without notary credentials so tauri-cli codesigns only; we notarize after nested fixup.
const buildEnv = { ...process.env }
delete buildEnv.APPLE_API_KEY
delete buildEnv.APPLE_API_ISSUER
delete buildEnv.APPLE_API_KEY_PATH
delete buildEnv.APPLE_ID
delete buildEnv.APPLE_PASSWORD
delete buildEnv.APPLE_APP_SPECIFIC_PASSWORD

run('pnpm', ['exec', 'tauri', ...buildArgs], { env: buildEnv })

if (process.platform === 'darwin') {
  const finalized = finalizeMacosAppBundle()
  console.log(
    `Nested codesign complete for ${finalized.appPath} (${finalized.nestedSigned} Mach-O files)`
  )
  const bundleDir = discoverBundleDir()
  if (!bundleDir) {
    throw new Error('Could not locate Tauri bundle directory after build')
  }
  notarizeIfConfigured({
    appPath: finalized.appPath,
    bundleDir,
    environment: process.env,
    wantDmg
  })
}
