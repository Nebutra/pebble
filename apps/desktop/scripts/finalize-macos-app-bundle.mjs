import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { resolveMacosCodeSigningIdentity } from './macos-code-signing-identity.mjs'

const appPath = resolve('src-tauri/target/release/bundle/macos/Pebble.app')
const repoRoot = resolve('../..')
const computerUseHelperName = 'Pebble Computer Use.app'

function stageComputerUseHelper() {
  execFileSync(process.execPath, [resolve(repoRoot, 'config/scripts/build-computer-macos.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  const source = resolve(
    repoRoot,
    'native/computer-use-macos/.build/release',
    computerUseHelperName
  )
  if (!existsSync(source)) {
    throw new Error(`Expected macOS computer-use helper at ${source}`)
  }
  const destination = resolve(appPath, 'Contents/Resources', computerUseHelperName)
  rmSync(destination, { recursive: true, force: true })
  cpSync(source, destination, { recursive: true })
}

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

  // Tauri validates the outer seal but does not replace an upstream ad-hoc
  // signature on executable resources, so nested code is always signed first.
  stageComputerUseHelper()
  signBundle(resolveMacosCodeSigningIdentity())
  verifyBundle()
}
