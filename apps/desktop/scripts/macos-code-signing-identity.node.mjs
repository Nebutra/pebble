import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseCodeSigningIdentities,
  resolveMacosCodeSigningIdentity
} from './macos-code-signing-identity.mjs'

const SECURITY_OUTPUT = `
  1) ABCDEF0123456789 "Apple Development: Example (TEAMID)"
  2) 0123456789ABCDEF "Developer ID Application: Example, Inc. (TEAMID)"
     2 valid identities found
`

test('parses code-signing identities from macOS security output', () => {
  assert.deepEqual(parseCodeSigningIdentities(SECURITY_OUTPUT), [
    'Apple Development: Example (TEAMID)',
    'Developer ID Application: Example, Inc. (TEAMID)'
  ])
})

test('prefers an explicit signing identity', () => {
  assert.equal(
    resolveMacosCodeSigningIdentity({
      environment: {
        APPLE_CERTIFICATE: 'base64-certificate',
        APPLE_SIGNING_IDENTITY: 'Explicit Identity'
      },
      runSecurity: () => {
        throw new Error('security should not run')
      }
    }),
    'Explicit Identity'
  )
})

test('discovers the Developer ID identity imported by the release action', () => {
  assert.equal(
    resolveMacosCodeSigningIdentity({
      environment: { APPLE_CERTIFICATE: 'base64-certificate' },
      runSecurity: () => SECURITY_OUTPUT
    }),
    'Developer ID Application: Example, Inc. (TEAMID)'
  )
})

test('fails release packaging when an imported certificate has no identity', () => {
  assert.throws(
    () =>
      resolveMacosCodeSigningIdentity({
        environment: { APPLE_CERTIFICATE: 'base64-certificate' },
        runSecurity: () => '0 valid identities found'
      }),
    /no code-signing identity is available/
  )
})
