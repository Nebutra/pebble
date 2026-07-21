import { describe, expect, it } from 'vitest'

import { resolveLocalRuntimeEndpoint } from './local-runtime-endpoint'

describe('resolveLocalRuntimeEndpoint', () => {
  it('uses the production endpoint when no override exists', () => {
    expect(resolveLocalRuntimeEndpoint(undefined, undefined)).toEqual({
      url: 'http://127.0.0.1:17777',
      listen: '127.0.0.1:17777',
      dataDir: null
    })
  })

  it('keeps an isolated endpoint and data directory aligned', () => {
    expect(resolveLocalRuntimeEndpoint('http://127.0.0.1:38123', ' /tmp/pebble-e2e ')).toEqual({
      url: 'http://127.0.0.1:38123',
      listen: '127.0.0.1:38123',
      dataDir: '/tmp/pebble-e2e'
    })
  })

  it.each(['https://127.0.0.1:17777', 'http://0.0.0.0:17777', 'http://example.com:17777'])(
    'rejects a non-local runtime endpoint: %s',
    (url) => {
      expect(() => resolveLocalRuntimeEndpoint(url, undefined)).toThrow(
        'Pebble runtime URL must use HTTP on a loopback host.'
      )
    }
  )
})
