import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { CustomPet } from '../../../packages/product-core/shared/types'

type PetReadResult = { contentBase64: string }

export function createPebblePetApi(): PreloadApi['pet'] {
  return {
    import: () => invoke<CustomPet | null>('pet_import'),
    importPetBundle: () => invoke<CustomPet | null>('pet_import_bundle'),
    read: async (id, fileName, kind) => {
      const result = await invoke<PetReadResult | null>('pet_read', {
        input: { id, fileName, kind: kind ?? null }
      })
      return result ? decodeBase64(result.contentBase64) : null
    },
    delete: (id, fileName, kind) =>
      invoke<void>('pet_delete', { input: { id, fileName, kind: kind ?? null } })
  }
}

function decodeBase64(content: string): ArrayBuffer {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}
