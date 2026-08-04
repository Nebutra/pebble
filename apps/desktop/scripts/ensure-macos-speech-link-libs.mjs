/**
 * Stage sherpa-onnx macOS shared libraries into a stable workspace path and
 * print cargo/env hints so the final link can resolve -lonnxruntime.1.17.1 /
 * -lsherpa-onnx-c-api during universal release builds.
 *
 * Why: GitHub Actions restores the Rust target/ cache (including sherpa-rs-sys
 * link metadata that points at ~/Library/Caches/sherpa-rs/...) without restoring
 * that cache directory. The final pebble-desktop-tauri link then fails with
 * "library 'onnxruntime.1.17.1' not found" even though download-binaries would
 * have worked on a cold build. Staging into the workspace and exporting
 * SHERPA_LIB_PATH + GITHUB_ENV keeps the libs next to the build.
 *
 * Both aarch64-apple-darwin and x86_64-apple-darwin use the same
 * osx-universal2-shared archive (sherpa-rs-sys 0.6.8 dist.json).
 */
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'

// Keep in lockstep with sherpa-rs-sys 0.6.8 dist.json tag.
const SHERPA_TAG = 'v1.12.9'
const REQUIRED_LIBS = ['libonnxruntime.1.17.1.dylib', 'libsherpa-onnx-c-api.dylib']
// Optional unversioned name some linkers resolve first.
const OPTIONAL_LIBS = ['libonnxruntime.dylib']

const ARCHIVE = `sherpa-onnx-${SHERPA_TAG}-osx-universal2-shared.tar.bz2`
const ROOT_NAME = `sherpa-onnx-${SHERPA_TAG}-osx-universal2-shared`

const MAC_TRIPLES = ['aarch64-apple-darwin', 'x86_64-apple-darwin']

export function resolveMacosSpeechTarget(triple = process.env.TAURI_RELEASE_TARGET_TRIPLE) {
  if (triple === 'universal-apple-darwin' || triple === 'aarch64-apple-darwin') {
    return 'aarch64-apple-darwin'
  }
  if (triple === 'x86_64-apple-darwin') {
    return 'x86_64-apple-darwin'
  }
  if (process.arch === 'x64') {
    return 'x86_64-apple-darwin'
  }
  return 'aarch64-apple-darwin'
}

export function speechLibRootFor(desktopRoot, triple) {
  return resolve(desktopRoot, 'src-tauri', 'speech-libs', triple)
}

export function libraryDirectoryHasRequiredLibs(directory) {
  return REQUIRED_LIBS.every((name) => existsSync(join(directory, name)))
}

export function findExistingSpeechLibDir({ desktopRoot, triple, home = homedir() }) {
  const staged = join(speechLibRootFor(desktopRoot, triple), 'lib')
  if (libraryDirectoryHasRequiredLibs(staged)) {
    return staged
  }

  // Host cache used by sherpa-rs-sys download-binaries on macOS.
  for (const cacheBase of [
    join(home, 'Library', 'Caches', 'sherpa-rs', triple),
    join(home, '.cache', 'sherpa-rs', triple)
  ]) {
    if (existsSync(cacheBase)) {
      const hit = findLibDirRecursive(cacheBase)
      if (hit) {
        return hit
      }
    }
  }

  // Sibling triple may already hold the universal archive (same dylibs).
  for (const other of MAC_TRIPLES) {
    if (other === triple) {
      continue
    }
    const otherStaged = join(speechLibRootFor(desktopRoot, other), 'lib')
    if (libraryDirectoryHasRequiredLibs(otherStaged)) {
      return otherStaged
    }
  }

  return null
}

function findLibDirRecursive(root, depth = 0) {
  if (depth > 6 || !existsSync(root)) {
    return null
  }
  if (libraryDirectoryHasRequiredLibs(root)) {
    return root
  }
  const libChild = join(root, 'lib')
  if (libraryDirectoryHasRequiredLibs(libChild)) {
    return libChild
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const hit = findLibDirRecursive(join(root, entry.name), depth + 1)
    if (hit) {
      return hit
    }
  }
  return null
}

export async function downloadAndExtractSpeechLibs({
  desktopRoot,
  triple = resolveMacosSpeechTarget(),
  fetchImpl = globalThis.fetch
}) {
  const stagingRoot = speechLibRootFor(desktopRoot, triple)
  const libDir = join(stagingRoot, 'lib')
  if (libraryDirectoryHasRequiredLibs(libDir)) {
    return { libDir, stagingRoot, skippedDownload: true }
  }

  rmSync(stagingRoot, { force: true, recursive: true })
  mkdirSync(stagingRoot, { recursive: true })

  const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_TAG}/${ARCHIVE}`
  const archivePath = join(stagingRoot, ARCHIVE)
  await downloadFile(url, archivePath, fetchImpl)

  execFileSync('tar', ['-xjf', archivePath, '-C', stagingRoot], { stdio: 'inherit' })

  const extractedLib = join(stagingRoot, ROOT_NAME, 'lib')
  if (!libraryDirectoryHasRequiredLibs(extractedLib)) {
    throw new Error(
      `Extracted sherpa archive is missing required libs under ${extractedLib}. ` +
        `Have: ${existsSync(extractedLib) ? readdirSync(extractedLib).join(', ') : '(missing dir)'}`
    )
  }

  mkdirSync(libDir, { recursive: true })
  for (const name of [...REQUIRED_LIBS, ...OPTIONAL_LIBS]) {
    const src = join(extractedLib, name)
    if (!existsSync(src)) {
      continue
    }
    const dest = join(libDir, name)
    copyFileSync(src, dest)
    try {
      chmodSync(dest, 0o755)
    } catch {
      // non-fatal on filesystems that ignore mode
    }
  }

  return { libDir, stagingRoot, skippedDownload: false, url }
}

async function downloadFile(url, destPath, fetchImpl) {
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  }
  await pipeline(response.body, createWriteStream(destPath))
}

export function writeGithubEnv({ libDir }) {
  // Why: SHERPA_LIB_PATH is read by sherpa-rs-sys build.rs; PEBBLE_* is read by
  // apps/desktop/src-tauri/build.rs so the final binary still gets -L even when
  // a restored target/ cache keeps a stale cache path in sherpa metadata.
  return `SHERPA_LIB_PATH=${dirname(libDir)}\nPEBBLE_MACOS_SPEECH_LIB_DIR=${libDir}\n`
}

function mirrorLibs(libDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  for (const name of [...REQUIRED_LIBS, ...OPTIONAL_LIBS]) {
    const src = join(libDir, name)
    if (!existsSync(src)) {
      continue
    }
    const dest = join(destDir, name)
    copyFileSync(src, dest)
    try {
      chmodSync(dest, 0o755)
    } catch {
      // ignore
    }
  }
}

function isDirectExecution() {
  const entry = process.argv[1] && resolve(process.argv[1])
  return entry === import.meta.filename
}

if (isDirectExecution()) {
  if (process.platform !== 'darwin') {
    console.log('ensure-macos-speech-link-libs: skip (not macOS)')
    process.exit(0)
  }

  const desktopRoot = resolve(import.meta.dirname, '..')
  // Universal release builds both triples; stage for both so cargo clean per
  // target can resolve SHERPA_LIB_PATH / speech-libs/$triple.
  const primary = resolveMacosSpeechTarget()
  const triples = [...new Set([primary, ...MAC_TRIPLES])]

  let primaryLibDir = null
  for (const triple of triples) {
    const existing = findExistingSpeechLibDir({ desktopRoot, triple })
    const result = existing
      ? { libDir: existing, stagingRoot: dirname(existing), skippedDownload: true }
      : await downloadAndExtractSpeechLibs({ desktopRoot, triple })

    // Always mirror into this triple's speech-libs path so build.rs can find it
    // without env when cargo re-invokes for the other arch.
    const stagedLib = join(speechLibRootFor(desktopRoot, triple), 'lib')
    if (result.libDir !== stagedLib) {
      mirrorLibs(result.libDir, stagedLib)
      result.libDir = stagedLib
    }

    if (triple === primary || !primaryLibDir) {
      primaryLibDir = result.libDir
    }

    console.log(
      `ensure-macos-speech-link-libs: ${result.skippedDownload ? 'reused' : 'staged'} ${triple} -> ${result.libDir}`
    )
  }

  // Frameworks path used by tauri.conf.json macOS bundle packing.
  mirrorLibs(primaryLibDir, resolve(desktopRoot, 'src-tauri', 'staged-macos-libraries'))

  // Also seed per-arch release dirs when present so rpath neighbors can load.
  for (const triple of MAC_TRIPLES) {
    const releaseDir = resolve(desktopRoot, 'src-tauri', 'target', triple, 'release')
    if (existsSync(dirname(releaseDir))) {
      mirrorLibs(primaryLibDir, releaseDir)
    }
  }

  const envBlock = writeGithubEnv({ libDir: primaryLibDir })
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, envBlock)
  }

  console.log(envBlock.trim())
}
