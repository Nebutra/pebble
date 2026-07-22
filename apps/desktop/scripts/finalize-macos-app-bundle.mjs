import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { resolveMacosCodeSigningIdentity } from './macos-code-signing-identity.mjs'

const appPath = resolve('src-tauri/target/release/bundle/macos/Pebble.app')

function runCodesign(args) {
  execFileSync('codesign', args, { stdio: 'inherit' })
}

function verifyBundle() {
  runCodesign(['--verify', '--deep', '--strict', '--verbose=2', appPath])
}

function signBundle(identity) {
  const contentsPath = resolve(appPath, 'Contents')
  const signablePaths = [
    resolve(contentsPath, 'Frameworks'),
    resolve(contentsPath, 'MacOS'),
    resolve(contentsPath, 'Resources/binaries/relay-workers'),
    resolve(contentsPath, 'Resources/serve-sim')
  ]
    .flatMap((directory) =>
      existsSync(directory) ? readdirSync(directory).map((entry) => resolve(directory, entry)) : []
    )
    .filter((path) => statSync(path).isFile())
    .filter((path) => !path.includes('/relay-workers/') || path.includes('-darwin-'))

  for (const path of signablePaths) {
    runCodesign(signingArgs(identity, path))
  }
  // Tauri may leave a linker-only signature when no identity is configured; sign last so
  // the final resource seal includes frameworks staged by beforeBundleCommand.
  runCodesign(signingArgs(identity, appPath))
}

function signingArgs(identity, path) {
  return identity
    ? ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', path]
    : ['--force', '--sign', '-', '--timestamp=none', path]
}

if (process.platform === 'darwin') {
  if (!existsSync(appPath)) {
    throw new Error(`Expected macOS app bundle at ${appPath}`)
  }

  // The helper is prepared by beforeBundleCommand so release and local bundles
  // share the same nested signing order before the outer resource seal exists.
  signBundle(resolveMacosCodeSigningIdentity())
  verifyBundle()
}
