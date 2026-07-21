import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const requiredLibraries = ['libonnxruntime.1.17.1.dylib', 'libsherpa-onnx-c-api.dylib']

export function stageMacosSpeechLibraries({ sourceRoot, stagingRoot }) {
  const sourceDirectory = findReleaseLibraryDirectory(sourceRoot)
  rmSync(stagingRoot, { force: true, recursive: true })
  mkdirSync(stagingRoot, { recursive: true })
  for (const library of requiredLibraries) {
    copyFileSync(resolve(sourceDirectory, library), resolve(stagingRoot, library))
  }
  return { libraries: [...requiredLibraries], sourceDirectory, stagingRoot }
}

export function findReleaseLibraryDirectory(sourceRoot) {
  const candidates = collectReleaseDirectories(sourceRoot)
    .filter((directory) => requiredLibraries.every((name) => existsSync(resolve(directory, name))))
    .sort((left, right) => candidateScore(right) - candidateScore(left))
  if (candidates.length === 0) {
    throw new Error(
      `Could not find the compiled macOS speech libraries below ${sourceRoot}. ` +
        'Build Pebble with the local-speech feature before bundling.'
    )
  }
  return candidates[0]
}

function collectReleaseDirectories(root) {
  if (!existsSync(root)) {
    return []
  }
  const matches = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const path = resolve(root, entry.name)
    if (entry.name === 'release' || entry.name === 'deps') {
      matches.push(path)
    }
    if (entry.name !== 'bundle' && entry.name !== 'staged-macos-libraries') {
      matches.push(...collectReleaseDirectories(path))
    }
  }
  return matches
}

function candidateScore(directory) {
  const directReleaseBonus = directory.endsWith('/release') ? 1_000_000_000_000_000 : 0
  const newestLibrary = Math.max(
    ...requiredLibraries.map((name) => statSync(resolve(directory, name)).mtimeMs)
  )
  return directReleaseBonus + newestLibrary
}

function isDirectExecution() {
  return process.argv[1] && resolve(process.argv[1]) === import.meta.filename
}

if (isDirectExecution()) {
  if (process.platform !== 'darwin') {
    process.exit(0)
  }
  const desktopRoot = resolve(import.meta.dirname, '..')
  const result = stageMacosSpeechLibraries({
    sourceRoot: resolve(desktopRoot, 'src-tauri/target'),
    stagingRoot: resolve(desktopRoot, 'src-tauri/staged-macos-libraries')
  })
  console.log(
    `Staged ${result.libraries.length} macOS speech libraries from ${result.sourceDirectory}.`
  )
}
