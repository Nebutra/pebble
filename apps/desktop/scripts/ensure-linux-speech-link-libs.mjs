/**
 * Stage sherpa-onnx Linux shared libraries into a stable workspace path and
 * print cargo/env hints so rust-lld can resolve -lonnxruntime /
 * -lsherpa-onnx-c-api during release links.
 *
 * Why: GitHub Actions restores the Rust target/ cache (including sherpa-rs-sys
 * link metadata that points at ~/.cache/sherpa-rs/...) without restoring that
 * cache directory. The final pebble-desktop-tauri link then fails with
 * "unable to find library -lonnxruntime" even though download-binaries would
 * have worked on a cold build. Staging into the workspace and exporting
 * SHERPA_LIB_PATH + GITHUB_ENV keeps the libs next to the build.
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
const REQUIRED_LIBS = ['libonnxruntime.so', 'libsherpa-onnx-c-api.so']

const TARGET_ARCHIVES = {
  'x86_64-unknown-linux-gnu': {
    archive: `sherpa-onnx-${SHERPA_TAG}-linux-x64-shared.tar.bz2`,
    rootName: `sherpa-onnx-${SHERPA_TAG}-linux-x64-shared`
  },
  'aarch64-unknown-linux-gnu': {
    archive: `sherpa-onnx-${SHERPA_TAG}-linux-aarch64-shared-cpu.tar.bz2`,
    rootName: `sherpa-onnx-${SHERPA_TAG}-linux-aarch64-shared-cpu`
  }
}

export function resolveLinuxSpeechTarget(triple = process.env.TAURI_RELEASE_TARGET_TRIPLE) {
  if (triple && TARGET_ARCHIVES[triple]) {
    return triple
  }
  if (process.arch === 'arm64') {
    return 'aarch64-unknown-linux-gnu'
  }
  return 'x86_64-unknown-linux-gnu'
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

  const cacheRoot = join(home, '.cache', 'sherpa-rs', triple)
  if (existsSync(cacheRoot)) {
    const hit = findLibDirRecursive(cacheRoot)
    if (hit) {
      return hit
    }
  }

  const targetRelease = resolve(desktopRoot, 'src-tauri', 'target', 'release')
  if (libraryDirectoryHasRequiredLibs(targetRelease)) {
    return targetRelease
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
  triple = resolveLinuxSpeechTarget(),
  fetchImpl = globalThis.fetch
}) {
  const spec = TARGET_ARCHIVES[triple]
  if (!spec) {
    throw new Error(`Unsupported Linux speech triple: ${triple}`)
  }

  const stagingRoot = speechLibRootFor(desktopRoot, triple)
  const libDir = join(stagingRoot, 'lib')
  if (libraryDirectoryHasRequiredLibs(libDir)) {
    return { libDir, stagingRoot, skippedDownload: true }
  }

  rmSync(stagingRoot, { force: true, recursive: true })
  mkdirSync(stagingRoot, { recursive: true })

  const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_TAG}/${spec.archive}`
  const archivePath = join(stagingRoot, spec.archive)
  await downloadFile(url, archivePath, fetchImpl)

  // tar.bz2: prefer system tar (available on GitHub-hosted Linux runners).
  execFileSync('tar', ['-xjf', archivePath, '-C', stagingRoot], { stdio: 'inherit' })

  const extractedLib = join(stagingRoot, spec.rootName, 'lib')
  if (!libraryDirectoryHasRequiredLibs(extractedLib)) {
    throw new Error(
      `Extracted sherpa archive is missing required libs under ${extractedLib}. ` +
        `Have: ${existsSync(extractedLib) ? readdirSync(extractedLib).join(', ') : '(missing dir)'}`
    )
  }

  mkdirSync(libDir, { recursive: true })
  for (const name of REQUIRED_LIBS) {
    const dest = join(libDir, name)
    copyFileSync(join(extractedLib, name), dest)
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
  // a restored target/ cache keeps a stale ~/.cache path in sherpa metadata.
  return `SHERPA_LIB_PATH=${dirname(libDir)}\nPEBBLE_LINUX_SPEECH_LIB_DIR=${libDir}\n`
}

function isDirectExecution() {
  const entry = process.argv[1] && resolve(process.argv[1])
  return entry === import.meta.filename
}

if (isDirectExecution()) {
  if (process.platform !== 'linux') {
    console.log('ensure-linux-speech-link-libs: skip (not Linux)')
    process.exit(0)
  }

  const desktopRoot = resolve(import.meta.dirname, '..')
  const triple = resolveLinuxSpeechTarget()
  const existing = findExistingSpeechLibDir({ desktopRoot, triple })
  const result = existing
    ? { libDir: existing, stagingRoot: dirname(existing), skippedDownload: true }
    : await downloadAndExtractSpeechLibs({ desktopRoot, triple })

  // Mirror into target/release so deb packaging and runtime rpath can find them.
  const releaseDir = resolve(desktopRoot, 'src-tauri', 'target', 'release')
  if (existsSync(dirname(releaseDir))) {
    mkdirSync(releaseDir, { recursive: true })
    for (const name of REQUIRED_LIBS) {
      const dest = join(releaseDir, name)
      copyFileSync(join(result.libDir, name), dest)
      try {
        chmodSync(dest, 0o755)
      } catch {
        // ignore
      }
    }
  }

  const envBlock = writeGithubEnv({ libDir: result.libDir })
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, envBlock)
  }

  console.log(
    `ensure-linux-speech-link-libs: ${result.skippedDownload ? 'reused' : 'staged'} ${result.libDir}`
  )
  console.log(envBlock.trim())
}
