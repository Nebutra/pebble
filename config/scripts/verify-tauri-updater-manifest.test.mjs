import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchReleaseUpdaterData,
  fetchReleaseUpdaterManifest,
  validatePublishedUpdaterManifest,
  validateUpdaterManifest,
  verifyPublishedUpdaterPayloadSignatures
} from './verify-tauri-updater-manifest.mjs'

const repository = 'nebutra/pebble'
const tag = 'v1.2.3'
const assetName = 'pebble-tauri-darwin-universal.app.tar.gz'

function publishedManifestOptions(overrides = {}) {
  return {
    repository,
    tag,
    requiredPlatforms: ['darwin-aarch64'],
    releaseAssets: [{ name: assetName, state: 'uploaded', size: 123 }],
    ...overrides
  }
}

function publishedManifest(overrides = {}) {
  return {
    version: '1.2.3',
    platforms: {
      'darwin-aarch64': {
        url: `https://github.com/${repository}/releases/download/${tag}/${assetName}`,
        signature: 'signed-value',
        ...overrides
      }
    }
  }
}

test('accepts signed Nebutra Pebble updater platforms', () => {
  const manifest = {
    version: '1.2.3',
    platforms: {
      'darwin-aarch64': {
        url: 'https://github.com/nebutra/pebble/releases/download/v1.2.3/Pebble.app.tar.gz',
        signature: 'signed-value'
      }
    }
  }
  assert.equal(validateUpdaterManifest(manifest), manifest)
})

test('rejects unsigned or foreign updater assets', () => {
  assert.throws(() =>
    validateUpdaterManifest({
      version: '1.2.3',
      platforms: { 'windows-x86_64': { url: 'https://example.test/Pebble.zip', signature: '' } }
    })
  )
})

test('requires the release version and complete desktop platform matrix', () => {
  const manifest = {
    version: '1.2.3-rc.2',
    platforms: {
      'darwin-aarch64': {
        url: 'https://github.com/nebutra/pebble/releases/download/v1.2.3-rc.2/Pebble.app.tar.gz',
        signature: 'signed-value'
      }
    }
  }
  assert.throws(() =>
    validateUpdaterManifest(manifest, {
      expectedVersion: 'v1.2.3-rc.2',
      requiredPlatforms: ['darwin-aarch64', 'windows-x86_64']
    })
  )
  assert.equal(
    validateUpdaterManifest(manifest, {
      expectedVersion: 'v1.2.3-rc.2',
      requiredPlatforms: ['darwin-aarch64']
    }),
    manifest
  )
})

test('requires published updater URLs to target uploaded non-empty assets in the exact release', () => {
  const manifest = publishedManifest()
  assert.equal(validatePublishedUpdaterManifest(manifest, publishedManifestOptions()), manifest)
})

test('rejects updater URLs for another release tag or an ambiguous URL', () => {
  assert.throws(
    () =>
      validatePublishedUpdaterManifest(
        publishedManifest({
          url: `https://github.com/${repository}/releases/download/v1.2.2/${assetName}`
        }),
        publishedManifestOptions()
      ),
    /does not target nebutra\/pebble release v1\.2\.3/
  )
  assert.throws(
    () =>
      validatePublishedUpdaterManifest(
        publishedManifest({
          url: `https://github.com/${repository}/releases/download/${tag}/${assetName}?redirect=1`
        }),
        publishedManifestOptions()
      ),
    /ambiguous download URL/
  )
})

test('rejects missing, incomplete, or empty updater target assets', () => {
  const manifest = publishedManifest()
  assert.throws(
    () =>
      validatePublishedUpdaterManifest(manifest, publishedManifestOptions({ releaseAssets: [] })),
    /references missing release asset/
  )
  assert.throws(
    () =>
      validatePublishedUpdaterManifest(
        manifest,
        publishedManifestOptions({
          releaseAssets: [{ name: assetName, state: 'new', size: 123 }]
        })
      ),
    /in state new/
  )
  assert.throws(
    () =>
      validatePublishedUpdaterManifest(
        manifest,
        publishedManifestOptions({
          releaseAssets: [{ name: assetName, state: 'uploaded', size: 0 }]
        })
      ),
    /references empty release asset/
  )
})

test('reads latest.json from a draft release asset through the GitHub API', async () => {
  const manifest = { version: '1.2.3', platforms: {} }
  const releaseAssets = [
    { name: 'latest.json', url: 'asset-url', state: 'uploaded', size: 10 },
    { name: assetName, state: 'uploaded', size: 123 }
  ]
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (String(url).includes('/releases/tags/')) {
      return new Response(JSON.stringify({ assets: releaseAssets }))
    }
    return new Response(JSON.stringify(manifest))
  }

  assert.deepEqual(
    await fetchReleaseUpdaterManifest({
      repository: 'nebutra/pebble',
      tag: 'v1.2.3',
      token: 'test-token',
      fetchImpl
    }),
    manifest
  )
  assert.deepEqual(
    await fetchReleaseUpdaterData({
      repository,
      tag,
      token: 'test-token',
      fetchImpl
    }),
    {
      manifest,
      releaseAssets,
      requestHeaders: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer test-token',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  )
  assert.equal(calls.length, 4)
  assert.equal(calls[3].options.headers.Accept, 'application/octet-stream')
})

test('downloads and cryptographically verifies every published updater payload', async () => {
  const manifest = publishedManifest()
  const releaseAssets = [
    { name: assetName, url: 'https://api.github.test/assets/42', state: 'uploaded', size: 7 }
  ]
  const signatureVerifierCalls = []
  const fetchCalls = []
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ options, url })
    return new Response(Buffer.from('payload'))
  }

  const verified = await verifyPublishedUpdaterPayloadSignatures({
    fetchImpl,
    manifest,
    publicKey: 'production-public-key',
    releaseAssets,
    requestHeaders: { Authorization: 'Bearer token' },
    signatureVerifier: (input) => signatureVerifierCalls.push(input)
  })

  assert.deepEqual(verified, ['darwin-aarch64'])
  assert.equal(fetchCalls[0].url, releaseAssets[0].url)
  assert.equal(fetchCalls[0].options.headers.Accept, 'application/octet-stream')
  assert.equal(signatureVerifierCalls[0].publicKey, 'production-public-key')
  assert.match(signatureVerifierCalls[0].payloadPath, /pebble-updater-verification-/)
  assert.equal(signatureVerifierCalls[0].signaturePath, `${signatureVerifierCalls[0].payloadPath}.sig`)
})

test('fails closed when a published updater payload signature is invalid', async () => {
  await assert.rejects(
    verifyPublishedUpdaterPayloadSignatures({
      fetchImpl: async () => new Response(Buffer.from('tampered')),
      manifest: publishedManifest(),
      publicKey: 'production-public-key',
      releaseAssets: [
        { name: assetName, url: 'https://api.github.test/assets/42', state: 'uploaded', size: 8 }
      ],
      requestHeaders: {},
      signatureVerifier: () => {
        throw new Error('updater signature verification failed')
      }
    }),
    /signature verification failed/
  )
})
