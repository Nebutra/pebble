import { describe, expect, it } from 'vitest'

import { tauriBrowserInterceptionScopes } from './tauri-browser-navigation-interception'

describe('Tauri browser interception capability scope', () => {
  it('names the bounded WebKit document APIs without claiming all subresources', () => {
    expect(
      tauriBrowserInterceptionScopes(
        'native-top-level-and-webkit-main-frame-fetch-async-xhr-request-control'
      )
    ).toEqual([
      'native-top-level-and-webkit-main-frame-fetch-async-xhr-request-control',
      'document-main-frame-fetch-async-xhr'
    ])
  })

  it('keeps the broader Windows native scope distinct from document instrumentation', () => {
    expect(tauriBrowserInterceptionScopes('native-top-level-and-windows-request-control')).toEqual([
      'native-top-level-and-windows-request-control',
      'document-main-frame-fetch-async-xhr'
    ])
  })
})
