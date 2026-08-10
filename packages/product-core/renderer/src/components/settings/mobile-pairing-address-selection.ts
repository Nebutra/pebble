import {
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'

export type PairingAddressSelection = {
  address: string | undefined
  isManual: boolean
}

// Why: only a user-typed address is worth remembering across restarts. An
// OS-enumerated one comes back on the next refresh, and persisting it would pin
// a LAN address DHCP has since moved — so the stored value doubles as the
// "this selection is manual" flag when the pane first mounts.
export function refreshPairingAddressSelection(
  current: PairingAddressSelection | null,
  storedManualAddress: string | null,
  interfaces: readonly MobileNetworkInterface[]
): PairingAddressSelection {
  const seed = current ?? {
    address: storedManualAddress ?? undefined,
    isManual: storedManualAddress !== null
  }
  const address = selectRefreshedNetworkAddress(seed.address, interfaces, seed.isManual)
  return { address, isManual: seed.isManual && address === seed.address }
}

// Why: the picker fires one callback for a dropdown pick and for a typed
// address, and membership in the enumerated list is the only thing that tells
// them apart — accurate at the moment of the pick, not on a later refresh.
export function choosePairingAddress(
  address: string,
  interfaces: readonly MobileNetworkInterface[]
): PairingAddressSelection {
  return { address, isManual: !interfaces.some((iface) => iface.address === address) }
}

export function persistedManualAddress(selection: PairingAddressSelection): string | null {
  return selection.isManual && selection.address ? selection.address : null
}
