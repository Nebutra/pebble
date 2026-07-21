import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyReleaseUpdaterConfig,
  validateSigningPrivateKey,
  validateReleaseVersion,
  validateUpdaterPublicKey
} from './prepare-tauri-release-config.mjs'

const productionPublicKey = 'UlNJRzAxRkFLRVBST0RVQ1RJT05LRVkxMjM0NTY3ODkw'

test('release updater config enables signed updater artifacts', () => {
  const config = applyReleaseUpdaterConfig(
    {
      bundle: { active: true },
      plugins: { updater: { endpoints: ['https://example.test/latest.json'], pubkey: 'old' } }
    },
    productionPublicKey,
    '1.4.128'
  )

  assert.equal(config.bundle.createUpdaterArtifacts, true)
  assert.equal(config.plugins.updater.pubkey, productionPublicKey)
  assert.equal(config.version, '1.4.128')
})

test('release updater config rejects the checked-in placeholder key', () => {
  assert.throws(
    () =>
      validateUpdaterPublicKey(
        'UlNJRzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA='
      ),
    /production updater public key/
  )
})

test('release updater config requires updater endpoints', () => {
  assert.throws(
    () => applyReleaseUpdaterConfig({ bundle: {}, plugins: { updater: {} } }, productionPublicKey, '1.4.128'),
    /endpoints must be configured/
  )
})

test('release version accepts tags but rejects placeholder package versions', () => {
  assert.equal(validateReleaseVersion('v1.4.128-rc.1'), '1.4.128-rc.1')
  assert.throws(() => validateReleaseVersion('release-latest'), /valid semver/)
})

test('release updater config requires a signing private key without persisting it', () => {
  assert.throws(() => validateSigningPrivateKey(''), /must be configured/)
  assert.equal(validateSigningPrivateKey('private-key-material'), undefined)
})

test('Windows release config derives signing metadata from the imported certificate', () => {
  const config = applyReleaseUpdaterConfig(
    {
      bundle: { active: true },
      plugins: { updater: { endpoints: ['https://example.test/latest.json'], pubkey: 'old' } }
    },
    productionPublicKey,
    '1.4.128',
    { platform: 'windows', windowsCertificateThumbprint: 'A'.repeat(40) }
  )

  assert.deepEqual(config.bundle.windows, {
    certificateThumbprint: 'A'.repeat(40),
    digestAlgorithm: 'sha256',
    timestampUrl: 'http://timestamp.digicert.com'
  })
  assert.throws(
    () =>
      applyReleaseUpdaterConfig(
        {
          bundle: {},
          plugins: { updater: { endpoints: ['https://example.test/latest.json'] } }
        },
        productionPublicKey,
        '1.4.128',
        { platform: 'windows', windowsCertificateThumbprint: '' }
      ),
    /certificate thumbprint/
  )
})
