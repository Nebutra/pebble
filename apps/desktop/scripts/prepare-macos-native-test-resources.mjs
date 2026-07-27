import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { macosSpeechLibraryNames } from './macos-speech-library-names.mjs'

export function prepareMacosNativeTestResources({ desktopRoot, platform = process.platform }) {
  if (platform !== 'darwin') {
    return { prepared: false, paths: [] }
  }

  const stagingRoot = resolve(desktopRoot, 'src-tauri/staged-macos-libraries')
  mkdirSync(stagingRoot, { recursive: true })
  const paths = macosSpeechLibraryNames.map((name) => resolve(stagingRoot, name))
  for (const path of paths) {
    if (!existsSync(path)) {
      closeSync(openSync(path, 'wx', 0o600))
    }
  }
  return { prepared: true, paths }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const result = prepareMacosNativeTestResources({
    desktopRoot: resolve(import.meta.dirname, '..')
  })
  if (result.prepared) {
    console.log(`Prepared ${result.paths.length} macOS native-test resource placeholders.`)
  }
}
