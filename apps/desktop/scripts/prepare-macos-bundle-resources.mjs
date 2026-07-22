import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

export function prepareMacosBundleResources({
  desktopRoot,
  environment,
  platform = process.platform,
  run = execFileSync
}) {
  if (platform !== 'darwin') {
    return { prepared: false }
  }

  const runNodeScript = (path) =>
    run(process.execPath, [path], {
      cwd: desktopRoot,
      env: environment,
      stdio: 'inherit'
    })

  runNodeScript(resolve(desktopRoot, 'scripts/stage-macos-speech-libraries.mjs'))
  // Why: the helper must carry its dedicated entitlements before Tauri seals
  // the outer app; copying it after bundling invalidates notarization ownership.
  runNodeScript(resolve(desktopRoot, '../../config/scripts/build-computer-macos.mjs'))
  return { prepared: true }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  prepareMacosBundleResources({
    desktopRoot: resolve(import.meta.dirname, '..'),
    environment: process.env
  })
}
