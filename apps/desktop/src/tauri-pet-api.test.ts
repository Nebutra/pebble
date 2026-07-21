import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createPebblePetApi } from './tauri-pet-api'

beforeEach(() => vi.clearAllMocks())

describe('createPebblePetApi', () => {
  it('imports and decodes native pet resources', async () => {
    invokeMock
      .mockResolvedValueOnce({ id: 'pet-1', label: 'Pebble' })
      .mockResolvedValueOnce({ contentBase64: 'AQID' })
    const api = createPebblePetApi()

    await expect(api.import()).resolves.toMatchObject({ id: 'pet-1' })
    const bytes = await api.read('pet-1', 'pet-1.png', 'image')

    expect(Array.from(new Uint8Array(bytes!))).toEqual([1, 2, 3])
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'pet_read', {
      input: { id: 'pet-1', fileName: 'pet-1.png', kind: 'image' }
    })
  })

  it('routes bundle deletion through the bounded Rust command', async () => {
    invokeMock.mockResolvedValue(undefined)
    await createPebblePetApi().delete('pet-1', 'spritesheet.webp', 'bundle')
    expect(invokeMock).toHaveBeenCalledWith('pet_delete', {
      input: { id: 'pet-1', fileName: 'spritesheet.webp', kind: 'bundle' }
    })
  })
})
