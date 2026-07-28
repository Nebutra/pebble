import { describe, expect, it } from 'vitest'
import { describeRemoteRuntimeDialFailure } from './remote-runtime-dial-failure'
import { withRemoteRuntimeTailscaleHint } from './remote-runtime-tailscale-hint'

const ENDPOINT = 'ws://192.168.1.9:6768'

function syscallError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('describeRemoteRuntimeDialFailure', () => {
  it('names the cause and the endpoint for each transport failure class', () => {
    expect(
      describeRemoteRuntimeDialFailure(
        ENDPOINT,
        syscallError('ECONNREFUSED', 'connect ECONNREFUSED 192.168.1.9:6768')
      )
    ).toBe(
      `Could not connect to the remote Pebble runtime: connection refused — the address is reachable but nothing is listening (${ENDPOINT})`
    )
    expect(
      describeRemoteRuntimeDialFailure(
        ENDPOINT,
        syscallError('EHOSTUNREACH', 'connect EHOSTUNREACH')
      )
    ).toContain('no route to host')
    expect(
      describeRemoteRuntimeDialFailure(ENDPOINT, syscallError('ENETUNREACH', 'connect ENETUNREACH'))
    ).toContain('no route to host')
    expect(
      describeRemoteRuntimeDialFailure(ENDPOINT, syscallError('ETIMEDOUT', 'connect ETIMEDOUT'))
    ).toContain('timed out')
    expect(
      describeRemoteRuntimeDialFailure(ENDPOINT, syscallError('ENOTFOUND', 'getaddrinfo ENOTFOUND'))
    ).toContain('could not be resolved')
  })

  it('falls back to the raw error message for unmapped failures', () => {
    expect(
      describeRemoteRuntimeDialFailure(ENDPOINT, new Error('Unexpected server response: 502'))
    ).toBe(
      `Could not connect to the remote Pebble runtime: Unexpected server response: 502 (${ENDPOINT})`
    )
    expect(describeRemoteRuntimeDialFailure(ENDPOINT, undefined)).toBe(
      `Could not connect to the remote Pebble runtime: the connection failed (${ENDPOINT})`
    )
  })

  it('omits the parenthetical when no endpoint is known', () => {
    expect(describeRemoteRuntimeDialFailure(null, syscallError('ECONNREFUSED', 'refused'))).toBe(
      'Could not connect to the remote Pebble runtime: connection refused — the address is reachable but nothing is listening'
    )
  })

  it('keeps the message matchable by the Tailscale hint', () => {
    // Why: the hint gates on a literal regex over this prefix; the appended detail must
    // not break it.
    const message = describeRemoteRuntimeDialFailure(
      'ws://100.64.1.20:6768',
      syscallError('EHOSTUNREACH', 'connect EHOSTUNREACH')
    )
    expect(withRemoteRuntimeTailscaleHint(message, 'ws://100.64.1.20:6768')).toContain(
      'Funnel reverted to tailnet-only'
    )
  })
})
