import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractTauriManifestAssetNames,
  getRequiredReleaseAssetNames,
  verifyRequiredReleaseAssets
} from './verify-release-required-assets.mjs'

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body)))
  }
}

function releaseWithAssets(tag, assetNames) {
  return {
    tag_name: tag,
    draft: true,
    prerelease: false,
    assets: assetNames.map((name, index) => ({
      id: index + 1,
      name,
      state: 'uploaded',
      size: 123
    }))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tauri release asset gate', () => {
  it('requires every stable direct-download installer in addition to the updater manifest', () => {
    expect(getRequiredReleaseAssetNames('v1.4.27')).toEqual([
      'latest.json',
      'pebble-linux-aarch64.deb',
      'pebble-linux-x86_64.deb',
      'pebble-macos-universal.dmg',
      'pebble-windows-x86_64-setup.exe',
      'pebble-windows-x86_64.msi'
    ])
  })

  it('extracts every platform updater payload from latest.json', () => {
    expect(
      extractTauriManifestAssetNames(
        JSON.stringify({
          platforms: {
            'darwin-aarch64': { url: 'https://example.com/pebble-macos.tar.gz' },
            'windows-x86_64': { url: 'pebble-windows.nsis.zip' }
          }
        })
      )
    ).toEqual(['pebble-macos.tar.gz', 'pebble-windows.nsis.zip'])
  })

  it('rejects a manifest-referenced updater payload that was not uploaded', async () => {
    const tag = 'v1.4.27'
    const release = releaseWithAssets(tag, [
      ...getRequiredReleaseAssetNames(tag),
      'pebble-macos.tar.gz'
    ])
    const latestJson = release.assets.find(({ name }) => name === 'latest.json')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([release]))
        .mockImplementation((url) =>
          url.endsWith(`/assets/${latestJson.id}`)
            ? jsonResponse({
                platforms: {
                  'darwin-aarch64': { url: 'pebble-macos.tar.gz' },
                  'windows-x86_64': { url: 'pebble-windows.nsis.zip' }
                }
              })
            : jsonResponse({})
        )
    )

    await expect(
      verifyRequiredReleaseAssets({ repo: 'nebutra/pebble', tag, token: 'token' })
    ).rejects.toThrow('Missing: pebble-windows.nsis.zip')
  })

  it('accepts a complete non-empty Tauri updater payload set', async () => {
    const tag = 'v1.4.27'
    const release = releaseWithAssets(tag, [
      ...getRequiredReleaseAssetNames(tag),
      'pebble-macos.tar.gz',
      'pebble-windows.nsis.zip'
    ])
    const latestJson = release.assets.find(({ name }) => name === 'latest.json')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([release]))
        .mockImplementation((url) =>
          url.endsWith(`/assets/${latestJson.id}`)
            ? jsonResponse({
                platforms: {
                  'darwin-aarch64': { url: 'pebble-macos.tar.gz' },
                  'windows-x86_64': { url: 'pebble-windows.nsis.zip' }
                }
              })
            : jsonResponse({})
        )
    )

    await expect(
      verifyRequiredReleaseAssets({ repo: 'nebutra/pebble', tag, token: 'token' })
    ).resolves.toMatchObject({
      checked: [
        ...getRequiredReleaseAssetNames(tag),
        'pebble-macos.tar.gz',
        'pebble-windows.nsis.zip'
      ].sort()
    })
  })
})
