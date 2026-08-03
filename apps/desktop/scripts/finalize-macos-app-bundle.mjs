import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { resolveMacosCodeSigningIdentity } from './macos-code-signing-identity.mjs'

function discoverAppPath({ cwd = process.cwd(), environment = process.env } = {}) {
  if (environment.PEBBLE_MACOS_APP_PATH?.trim()) {
    return resolve(environment.PEBBLE_MACOS_APP_PATH.trim())
  }
  const candidates = [
    resolve(cwd, 'src-tauri/target/universal-apple-darwin/release/bundle/macos/Pebble.app'),
    resolve(cwd, 'src-tauri/target/release/bundle/macos/Pebble.app'),
    resolve(cwd, 'src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Pebble.app'),
    resolve(cwd, 'src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Pebble.app')
  ]
  return candidates.find((path) => existsSync(path)) ?? candidates[0]
}

function runCodesign(args) {
  execFileSync('codesign', args, { stdio: 'inherit' })
}

function isMachO(path) {
  try {
    const out = execFileSync('file', ['-b', path], { encoding: 'utf8' })
    return out.includes('Mach-O')
  } catch {
    return false
  }
}

function walkFiles(directory) {
  if (!existsSync(directory)) {
    return []
  }
  const entries = readdirSync(directory)
  return entries.flatMap((entry) => {
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      return walkFiles(path)
    }
    return stat.isFile() ? [path] : []
  })
}

function signingArgs(identity, path) {
  return identity
    ? ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', path]
    : ['--force', '--sign', '-', '--timestamp=none', path]
}

export function finalizeMacosAppBundle({
  appPath = discoverAppPath(),
  identity = resolveMacosCodeSigningIdentity(),
  run = runCodesign
} = {}) {
  if (!existsSync(appPath)) {
    throw new Error(`Expected macOS app bundle at ${appPath}`)
  }

  const contentsPath = resolve(appPath, 'Contents')
  const nestedRoots = [
    resolve(contentsPath, 'Frameworks'),
    resolve(contentsPath, 'MacOS'),
    resolve(contentsPath, 'Resources')
  ]

  const nestedPaths = nestedRoots
    .flatMap((root) => walkFiles(root))
    // Nested helpers and vendor bins must carry Developer ID + hardened runtime
    // before the outer resource seal, or Apple notary returns Invalid (serve-sim-bin).
    .filter((path) => isMachO(path))
    // Sign leaves first: deeper paths before parents (string length heuristic).
    .sort((a, b) => b.length - a.length)

  for (const path of nestedPaths) {
    run(signingArgs(identity, path))
  }

  // Outer seal last so the resource directory includes nested signatures.
  run(signingArgs(identity, appPath))
  run(['--verify', '--deep', '--strict', '--verbose=2', appPath])
  return { appPath, nestedSigned: nestedPaths.length, identity }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  if (process.platform !== 'darwin') {
    process.exit(0)
  }
  const result = finalizeMacosAppBundle()
  console.log(
    `Finalized ${result.appPath} (nested Mach-O signed: ${result.nestedSigned}, identity: ${result.identity ?? 'ad-hoc'})`
  )
}
