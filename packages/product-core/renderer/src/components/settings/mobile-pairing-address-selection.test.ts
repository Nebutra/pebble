import { describe, expect, it } from 'vitest'
import {
  choosePairingAddress,
  persistedManualAddress,
  refreshPairingAddressSelection
} from './mobile-pairing-address-selection'

const interfaces = [
  { name: 'en0', address: '192.168.1.50' },
  { name: 'utun4', address: '100.101.102.103' }
]

describe('refreshPairingAddressSelection', () => {
  it('seeds the first selection from the remembered manual address', () => {
    expect(refreshPairingAddressSelection(null, 'my-mac.ts.net', interfaces)).toEqual({
      address: 'my-mac.ts.net',
      isManual: true
    })
  })

  it('falls back to discovery when nothing was remembered', () => {
    expect(refreshPairingAddressSelection(null, null, interfaces)).toEqual({
      address: '100.101.102.103',
      isManual: false
    })
  })

  it('keeps a manual address a refresh did not enumerate', () => {
    const current = { address: 'home.example.com:9443', isManual: true }
    expect(refreshPairingAddressSelection(current, null, interfaces)).toEqual(current)
  })

  it('moves an enumerated address that the refresh dropped', () => {
    const current = { address: '10.0.0.9', isManual: false }
    expect(refreshPairingAddressSelection(current, null, interfaces)).toEqual({
      address: '100.101.102.103',
      isManual: false
    })
  })

  it('holds a manual address through an empty enumeration', () => {
    const current = { address: 'my-mac.ts.net', isManual: true }
    expect(refreshPairingAddressSelection(current, 'my-mac.ts.net', [])).toEqual(current)
  })
})

describe('choosePairingAddress', () => {
  it('marks an address the OS did not enumerate as manual', () => {
    expect(choosePairingAddress('my-mac.ts.net', interfaces)).toEqual({
      address: 'my-mac.ts.net',
      isManual: true
    })
    expect(choosePairingAddress('192.168.1.50', interfaces)).toEqual({
      address: '192.168.1.50',
      isManual: false
    })
  })
})

describe('persistedManualAddress', () => {
  it('remembers only a manual address', () => {
    expect(persistedManualAddress({ address: 'my-mac.ts.net', isManual: true })).toBe(
      'my-mac.ts.net'
    )
    expect(persistedManualAddress({ address: '192.168.1.50', isManual: false })).toBeNull()
    expect(persistedManualAddress({ address: undefined, isManual: true })).toBeNull()
  })
})
