import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

import { installLinuxBarePebbleDispatcher } from './linux-bare-pebble-dispatcher'

const created: string[] = []

async function makeFixture(): Promise<{ homePath: string; resourcesPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pebble-bare-dispatcher-'))
  created.push(root)
  const resourcesPath = join(root, 'resources')
  // The bundled pebble-ide launcher must exist for the dispatcher to be written.
  await mkdir(join(resourcesPath, 'bin'), { recursive: true })
  await writeFile(join(resourcesPath, 'bin', 'pebble-ide'), '#!/usr/bin/env bash\n', 'utf8')
  return { homePath: join(root, 'home'), resourcesPath }
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('installLinuxBarePebbleDispatcher', () => {
  it('writes an executable bare-pebble dispatcher that execs the bundled pebble-ide launcher', async () => {
    const { homePath, resourcesPath } = await makeFixture()

    const result = await installLinuxBarePebbleDispatcher({
      resourcesPath,
      homePath,
      appImagePath: null
    })

    const expectedTarget = join(resourcesPath, 'bin', 'pebble-ide')
    expect(result.state).toBe('installed')
    expect(result.target).toBe(expectedTarget)
    expect(result.dispatcherPath).toBe(join(homePath, '.local', 'bin', 'pebble'))

    const content = await readFile(result.dispatcherPath, 'utf8')
    expect(content).toContain('#!/usr/bin/env bash')
    // Single-quoted so a resources path with shell metacharacters can't break out.
    expect(content).toContain(`exec '${expectedTarget}' "$@"`)

    const mode = (await stat(result.dispatcherPath)).mode & 0o777
    expect(mode & 0o111).not.toBe(0)
  })

  it('is idempotent — a second install rewrites its own dispatcher without throwing', async () => {
    const { homePath, resourcesPath } = await makeFixture()

    const first = await installLinuxBarePebbleDispatcher({
      resourcesPath,
      homePath,
      appImagePath: null
    })
    const second = await installLinuxBarePebbleDispatcher({
      resourcesPath,
      homePath,
      appImagePath: null
    })

    expect(second).toEqual(first)
    expect(second.state).toBe('installed')
  })

  it('quotes a resources path containing spaces so the exec line cannot be split', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pebble-bare-dispatcher-space-'))
    created.push(root)
    const resourcesPath = join(root, 'App Support', 'resources')
    await mkdir(join(resourcesPath, 'bin'), { recursive: true })
    await writeFile(join(resourcesPath, 'bin', 'pebble-ide'), '#!/usr/bin/env bash\n', 'utf8')

    const result = await installLinuxBarePebbleDispatcher({
      resourcesPath,
      homePath: join(root, 'home'),
      appImagePath: null
    })

    const content = await readFile(result.dispatcherPath, 'utf8')
    expect(content).toContain(`exec '${join(resourcesPath, 'bin', 'pebble-ide')}' "$@"`)
  })

  it('execs the stable AppImage (not the ephemeral mount) when running from an AppImage', async () => {
    const { homePath, resourcesPath } = await makeFixture()
    const appImagePath = join(homePath, 'Applications', 'Pebble.AppImage')

    const result = await installLinuxBarePebbleDispatcher({ resourcesPath, homePath, appImagePath })

    expect(result.state).toBe('installed')
    expect(result.target).toBe(appImagePath)
    const content = await readFile(result.dispatcherPath, 'utf8')
    // The AppImage wrapper references the stable outer path, never resourcesPath.
    expect(content).toContain(appImagePath)
    expect(content).not.toContain(resourcesPath)
  })

  it('skips (does not clobber) a user-owned pebble already at ~/.local/bin', async () => {
    const { homePath, resourcesPath } = await makeFixture()
    const dispatcherPath = join(homePath, '.local', 'bin', 'pebble')
    await mkdir(join(homePath, '.local', 'bin'), { recursive: true })
    await writeFile(dispatcherPath, '#!/bin/sh\necho my own pebble\n', 'utf8')

    const result = await installLinuxBarePebbleDispatcher({
      resourcesPath,
      homePath,
      appImagePath: null
    })

    expect(result.state).toBe('skipped-foreign')
    expect(await readFile(dispatcherPath, 'utf8')).toBe('#!/bin/sh\necho my own pebble\n')
  })

  it('skips when the bundled pebble-ide launcher is missing from the build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pebble-bare-dispatcher-nolauncher-'))
    created.push(root)

    const result = await installLinuxBarePebbleDispatcher({
      resourcesPath: join(root, 'resources'),
      homePath: join(root, 'home'),
      appImagePath: null
    })

    expect(result.state).toBe('skipped-launcher-missing')
    expect(result.target).toBeNull()
  })
})
