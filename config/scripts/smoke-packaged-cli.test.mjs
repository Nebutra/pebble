import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  getPackagedCliPath,
  packagedExecutableName,
  packagedSidecarName,
  stagePackagedCli
} from './smoke-packaged-cli.mjs'

const sidecars = ['pebble-control', 'pebble-runtime', 'pebble-relay-worker']

describe('packaged CLI smoke layout', () => {
  it('resolves the native executable in every Tauri layout', () => {
    expect(getPackagedCliPath('/tmp/Pebble.app', 'darwin')).toBe(
      '/tmp/Pebble.app/Contents/MacOS/pebble-desktop-tauri'
    )
    expect(getPackagedCliPath('/tmp/release', 'linux')).toBe('/tmp/release/pebble-desktop-tauri')
    expect(getPackagedCliPath('C:\\release', 'win32')).toMatch(/pebble-desktop-tauri\.exe$/)
  })

  it('stages target-qualified no-bundle sidecars under their packaged names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pebble-cli-layout-'))
    const releaseDir = join(root, 'release')
    const sidecarDir = join(root, 'binaries')
    const tempRoot = join(root, 'temp')

    try {
      await Promise.all([mkdir(releaseDir), mkdir(sidecarDir), mkdir(tempRoot)])
      await writeFile(join(releaseDir, packagedExecutableName('linux')), 'desktop')
      await writeFile(join(releaseDir, 'libpebble.so.1'), 'library')
      await Promise.all(
        sidecars.map((name) =>
          writeFile(join(sidecarDir, `${name}-x86_64-unknown-linux-gnu`), name)
        )
      )

      const executable = await stagePackagedCli({
        appDir: releaseDir,
        sidecarDir,
        tempRoot,
        platform: 'linux'
      })

      expect(executable).toBe(join(tempRoot, 'pebble-tauri-artifact', 'pebble-desktop-tauri'))
      await Promise.all(
        sidecars.map((name) =>
          expectFile(join(tempRoot, 'pebble-tauri-artifact', packagedSidecarName(name, 'linux')))
        )
      )
      await expectFile(join(tempRoot, 'pebble-tauri-artifact', 'libpebble.so.1'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects incomplete app bundles instead of falling back to repository files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pebble-cli-app-layout-'))
    const appDir = join(root, 'Pebble.app')
    const executableDir = join(appDir, 'Contents', 'MacOS')
    const tempRoot = join(root, 'temp')

    try {
      await Promise.all([mkdir(executableDir, { recursive: true }), mkdir(tempRoot)])
      await writeFile(join(executableDir, packagedExecutableName('darwin')), 'desktop')
      await expect(
        stagePackagedCli({ appDir, sidecarDir: join(root, 'unused'), tempRoot, platform: 'darwin' })
      ).rejects.toThrow(/pebble-control sidecar/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function expectFile(path) {
  await expect(stat(path)).resolves.toMatchObject({})
}
