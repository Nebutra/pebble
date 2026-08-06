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

test('finds the release while it is still a draft awaiting verification', async () => {
  // Why: publish-release only publishes after this check passes, so the release
  // under verification is always a draft — and `GET /releases/tags/{tag}` does
  // not return drafts. Looking it up by tag alone made the check 404 on the
  // exact release it exists to verify.
  const manifest = { version: '1.2.3', platforms: {} }
  const draft = { tag_name: tag, draft: true, assets: [{ name: 'latest.json', url: 'asset-url' }] }
  const requested = []
  const fetchImpl = async (url) => {
    requested.push(String(url))
    if (String(url).includes('/releases/tags/')) {
      return new Response('{"message":"Not Found"}', { status: 404 })
    }
    if (String(url).includes('/releases?')) {
      return new Response(JSON.stringify([{ tag_name: 'v9.9.9', draft: false }, draft]))
    }
    return new Response(JSON.stringify(manifest))
  }

  assert.deepEqual(
    await fetchReleaseUpdaterManifest({ repository, tag, token: 'test-token', fetchImpl }),
    manifest
  )
  assert.ok(
    requested.some((url) => url.includes('/releases?')),
    'must fall back to the list endpoint when the tag lookup 404s'
  )
})

test('accepts the API asset URLs tauri-action actually emits', () => {
  // Shape taken from the published v1.4.131 latest.json.
  const manifest = {
    version: '1.4.131',
    platforms: {
      'linux-aarch64': {
        url: 'https://api.github.com/repos/Nebutra/pebble/releases/assets/502403757',
        signature: 'signed-value'
      }
    }
  }
  assert.equal(validateUpdaterManifest(manifest), manifest)
})

test('resolves an API asset URL by id rather than by path basename', () => {
  const manifest = {
    version: '1.2.3',
    platforms: {
      'darwin-aarch64': {
        url: `https://api.github.com/repos/${repository}/releases/assets/502403757`,
        signature: 'signed-value'
      }
    }
  }
  assert.equal(
    validatePublishedUpdaterManifest(
      manifest,
      publishedManifestOptions({
        releaseAssets: [{ id: 502403757, name: assetName, state: 'uploaded', size: 123 }]
      })
    ),
    manifest
  )
})

test('rejects an API asset id that belongs to another release', () => {
  const manifest = {
    version: '1.2.3',
    platforms: {
      'darwin-aarch64': {
        url: `https://api.github.com/repos/${repository}/releases/assets/999`,
        signature: 'signed-value'
      }
    }
  }
  assert.throws(
    () =>
      validatePublishedUpdaterManifest(
        manifest,
        publishedManifestOptions({
          releaseAssets: [{ id: 502403757, name: assetName, state: 'uploaded', size: 123 }]
        })
      ),
    /is not part of v1\.2\.3/
  )
})

test('treats the owner and repository as case-insensitive', () => {
  const manifest = publishedManifest({
    url: `https://github.com/Nebutra/Pebble/releases/download/${tag}/${assetName}`
  })
  assert.equal(validatePublishedUpdaterManifest(manifest, publishedManifestOptions()), manifest)
})

test('still rejects a host that is neither github.com nor its API', () => {
  const manifest = {
    version: '1.2.3',
    platforms: {
      'darwin-aarch64': {
        url: 'https://api.github.com.evil.test/repos/nebutra/pebble/releases/assets/1',
        signature: 'signed-value'
      }
    }
  }
  assert.throws(() => validateUpdaterManifest(manifest), /unexpected download URL/)
})

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
    // A query string is now rejected by the shared URL classifier, one stage
    // earlier than before, so the message is "unexpected" rather than
    // "ambiguous". Still rejected.
    /unexpected download URL/
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
  assert.equal(
    signatureVerifierCalls[0].signaturePath,
    `${signatureVerifierCalls[0].payloadPath}.sig`
  )
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
