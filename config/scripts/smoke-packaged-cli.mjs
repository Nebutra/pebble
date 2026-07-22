import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const REQUIRED_SIDECARS = ['pebble-control', 'pebble-runtime', 'pebble-relay-worker']

function readOption(argv, name) {
  const prefix = `--${name}=`
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

export function readAppDirArg(argv) {
  return readOption(argv, 'app-dir') ?? 'apps/desktop/src-tauri/target/release'
}

export function packagedExecutableName(platform) {
  return platform === 'win32' ? 'pebble-desktop-tauri.exe' : 'pebble-desktop-tauri'
}

export function packagedSidecarName(name, platform) {
  return platform === 'win32' ? `${name}.exe` : name
}

export function getPackagedCliPath(appDir, platform) {
  if (extname(appDir) === '.app') {
    return join(appDir, 'Contents', 'MacOS', packagedExecutableName('darwin'))
  }
  return join(appDir, packagedExecutableName(platform))
}

async function requireFile(path, description) {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    throw new Error(`Missing ${description}: ${path}`)
  }
  return path
}

async function findPreparedSidecar(sidecarDir, name, platform) {
  const extension = platform === 'win32' ? '.exe' : ''
  const prefix = `${name}-`
  const candidates = (await readdir(sidecarDir, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(extension)
    )
    .map((entry) => join(sidecarDir, entry.name))

  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one target-qualified ${name} sidecar in ${sidecarDir}, found ${candidates.length}`
    )
  }
  return candidates[0]
}

async function copyRuntimeLibraries(sourceDir, destinationDir, platform) {
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const isRuntimeLibrary =
    platform === 'darwin'
      ? (name) => name.endsWith('.dylib')
      : platform === 'win32'
        ? (name) => name.endsWith('.dll')
        : (name) => name.includes('.so')

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isRuntimeLibrary(entry.name))
      .map((entry) => cp(join(sourceDir, entry.name), join(destinationDir, entry.name)))
  )
}

export async function stagePackagedCli({ appDir, sidecarDir, tempRoot, platform }) {
  if (extname(appDir) === '.app') {
    const copiedAppDir = join(tempRoot, basename(appDir))
    await cp(appDir, copiedAppDir, { recursive: true, verbatimSymlinks: true })
    const cliPath = await requireFile(
      getPackagedCliPath(copiedAppDir, platform),
      'Tauri desktop executable'
    )
    const executableDir = join(copiedAppDir, 'Contents', 'MacOS')
    // Keep validation order deterministic so release failures identify the
    // first missing contract instead of whichever stat promise rejects first.
    for (const name of REQUIRED_SIDECARS) {
      await requireFile(join(executableDir, packagedSidecarName(name, platform)), `${name} sidecar`)
    }
    return cliPath
  }

  const copiedArtifactDir = join(tempRoot, 'pebble-tauri-artifact')
  await mkdir(copiedArtifactDir)
  const executable = await requireFile(
    getPackagedCliPath(appDir, platform),
    'Tauri desktop executable'
  )
  const copiedExecutable = join(copiedArtifactDir, packagedExecutableName(platform))
  await cp(executable, copiedExecutable)

  await Promise.all(
    REQUIRED_SIDECARS.map(async (name) => {
      const packagedName = packagedSidecarName(name, platform)
      const sibling = join(appDir, packagedName)
      const siblingInfo = await stat(sibling).catch(() => null)
      const source = siblingInfo?.isFile()
        ? sibling
        : await findPreparedSidecar(sidecarDir, name, platform)
      await cp(source, join(copiedArtifactDir, packagedName))
    })
  )
  await copyRuntimeLibraries(appDir, copiedArtifactDir, platform)
  return copiedExecutable
}

export async function main(argv = process.argv.slice(2)) {
  const appDir = resolve(readAppDirArg(argv))
  const sidecarDir = resolve(readOption(argv, 'sidecar-dir') ?? 'apps/desktop/src-tauri/binaries')
  const tempRoot = await mkdtemp(join(tmpdir(), 'pebble-packaged-cli-smoke-'))

  try {
    const cliPath = await stagePackagedCli({
      appDir,
      sidecarDir,
      tempRoot,
      platform: process.platform
    })
    await execFileAsync(cliPath, ['--help'], {
      env: { ...process.env, NODE_PATH: '' }
    })
    console.log(`[packaged-cli-smoke] ${cliPath} --help succeeded outside the repo`)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
