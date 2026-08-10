import { describe, expect, it } from 'vitest'
import { resolvePairingEndpoint } from './pairing-endpoint'

describe('resolvePairingEndpoint', () => {
  it('adds the shared-control port and path to a bare host', () => {
    expect(resolvePairingEndpoint('192.168.1.50')).toBe('ws://192.168.1.50:17777/v1/shared-control')
    expect(resolvePairingEndpoint('my-mac.ts.net')).toBe(
      'ws://my-mac.ts.net:17777/v1/shared-control'
    )
  })

  it('keeps a port the user typed instead of appending a second one', () => {
    expect(resolvePairingEndpoint('home.example.com:9443')).toBe(
      'ws://home.example.com:9443/v1/shared-control'
    )
    expect(resolvePairingEndpoint('home.example.com:9443')).not.toContain(':9443:')
  })

  it('brackets a bare IPv6 literal so its colons are not read as a port', () => {
    expect(resolvePairingEndpoint('fd7a:115c:a1e0::1')).toBe(
      'ws://[fd7a:115c:a1e0::1]:17777/v1/shared-control'
    )
    expect(resolvePairingEndpoint('[fd7a:115c:a1e0::1]:9443')).toBe(
      'ws://[fd7a:115c:a1e0::1]:9443/v1/shared-control'
    )
  })

  it('accepts a WebSocket pairing URL and upgrades an http one', () => {
    expect(resolvePairingEndpoint('ws://10.0.0.4:8080/v1/shared-control')).toBe(
      'ws://10.0.0.4:8080/v1/shared-control'
    )
    expect(resolvePairingEndpoint('http://10.0.0.4:8080')).toBe(
      'ws://10.0.0.4:8080/v1/shared-control'
    )
    expect(resolvePairingEndpoint('https://gateway.example.com')).toBe(
      'wss://gateway.example.com/v1/shared-control'
    )
  })

  it('leaves an explicit proxy path alone', () => {
    expect(resolvePairingEndpoint('wss://gateway.example.com/pebble/socket')).toBe(
      'wss://gateway.example.com/pebble/socket'
    )
  })

  it('rejects an address it cannot dial', () => {
    expect(resolvePairingEndpoint('')).toBeNull()
    expect(resolvePairingEndpoint('   ')).toBeNull()
    expect(resolvePairingEndpoint('host with spaces')).toBeNull()
    expect(resolvePairingEndpoint('host:notaport')).toBeNull()
    expect(resolvePairingEndpoint('host/extra')).toBeNull()
    expect(resolvePairingEndpoint('user:secret@host')).toBeNull()
    expect(resolvePairingEndpoint('ftp://host')).toBeNull()
    expect(resolvePairingEndpoint('file:///etc/passwd')).toBeNull()
    expect(resolvePairingEndpoint('192.168.1.50\nX-Injected: 1')).toBeNull()
  })

  it('honours a caller-supplied default port', () => {
    expect(resolvePairingEndpoint('10.0.0.4', 9999)).toBe('ws://10.0.0.4:9999/v1/shared-control')
  })
})
