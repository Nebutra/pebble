import * as SecureStore from 'expo-secure-store'

const pairingSecretRefKey = 'pebble.mobile.pairingSecretRef'

export async function loadStoredPairingSecretRef(): Promise<string | null> {
  if (!(await canUseSecureStore())) {
    return null
  }

  return SecureStore.getItemAsync(pairingSecretRefKey)
}

export async function saveStoredPairingSecretRef(secretRef: string): Promise<boolean> {
  if (!(await canUseSecureStore())) {
    return false
  }

  await SecureStore.setItemAsync(pairingSecretRefKey, secretRef)
  return true
}

export async function clearStoredPairingSecretRef(): Promise<void> {
  if (!(await canUseSecureStore())) {
    return
  }

  await SecureStore.deleteItemAsync(pairingSecretRefKey)
}

async function canUseSecureStore(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync()
  } catch {
    return false
  }
}
