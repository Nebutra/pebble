import { describe, expect, it } from 'vitest'

import {
  validateMacosCodeSignatureMetadata,
  validateMacosEntitlements
} from './verify-tauri-release-artifacts.mjs'

describe('macOS release signing metadata', () => {
  const developerIdMetadata = [
    'Authority=Developer ID Application: Pebble Test (TESTTEAM)',
    'TeamIdentifier=TESTTEAM',
    'flags=0x10000(runtime)'
  ].join('\n')

  it('requires Developer ID, the expected team, and hardened runtime', () => {
    expect(() => validateMacosCodeSignatureMetadata(developerIdMetadata, 'TESTTEAM')).not.toThrow()
    expect(() =>
      validateMacosCodeSignatureMetadata(
        developerIdMetadata.replace('Developer ID', 'Apple'),
        'TESTTEAM'
      )
    ).toThrow(/Developer ID/)
    expect(() => validateMacosCodeSignatureMetadata(developerIdMetadata, 'OTHERTEAM')).toThrow(
      /team identifier/
    )
    expect(() =>
      validateMacosCodeSignatureMetadata(
        developerIdMetadata.replace('(runtime)', '(none)'),
        'TESTTEAM'
      )
    ).toThrow(/hardened runtime/)
  })

  it('requires an embedded plist containing every repository entitlement', () => {
    const plist = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>'
    expect(() =>
      validateMacosEntitlements(plist, ['com.apple.security.cs.allow-jit'], 'Pebble')
    ).not.toThrow()
    expect(() =>
      validateMacosEntitlements(plist, ['com.apple.security.device.camera'], 'Pebble')
    ).toThrow(/missing required entitlement/)
    expect(() => validateMacosEntitlements('', [], 'Pebble helper')).toThrow(
      /no embedded entitlements plist/
    )
  })
})
