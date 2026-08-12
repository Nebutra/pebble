import { describe, expect, it } from 'vitest'
import { runtimeTransportFailure } from './runtime-transport-failure'
import type { RuntimeResourceGetResult } from './runtime-command-shapes'

function result(overrides: Partial<RuntimeResourceGetResult>): RuntimeResourceGetResult {
  return {
    transport: 'http-error',
    httpStatus: null,
    body: null,
    error: null,
    ...overrides
  } as RuntimeResourceGetResult
}

describe('runtimeTransportFailure', () => {
  it('keeps the explanation an http-error carries in its body', () => {
    // Why: a foreign runtime holding the port answers exactly this. Reporting
    // only the transport name told the operator nothing about the real cause.
    expect(
      runtimeTransportFailure(
        result({ httpStatus: 401, body: '{"error":"missing or invalid bearer token"}' })
      ).message
    ).toBe('missing or invalid bearer token')
  })

  it('falls back to the raw body when it is not the runtime error envelope', () => {
    expect(
      runtimeTransportFailure(result({ httpStatus: 502, body: 'upstream died' })).message
    ).toBe('upstream died')
  })

  it('names the status when an http-error carries no body', () => {
    expect(runtimeTransportFailure(result({ httpStatus: 503 })).message).toBe(
      'Runtime request failed with HTTP 503'
    )
  })

  it('prefers a transport error over the generic transport name', () => {
    expect(
      runtimeTransportFailure(result({ transport: 'unreachable', error: 'connection refused' }))
        .message
    ).toBe('connection refused')
  })

  it('falls back to the transport name when nothing else is known', () => {
    expect(runtimeTransportFailure(result({ transport: 'unreachable' })).message).toBe(
      'Runtime transport failed: unreachable'
    )
  })
})
