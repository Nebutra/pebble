// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { getSourceControlTextGenerationUnavailableReason } from './source-control-text-generation-availability'

type TauriTextGenerationTestWindow = Window & {
  __TAURI_INTERNALS__?: unknown
}

describe('source control text-generation availability', () => {
  afterEach(() => {
    delete (window as TauriTextGenerationTestWindow).__TAURI_INTERNALS__
  })

  it('keeps Electron source-control text generation enabled', () => {
    expect(getSourceControlTextGenerationUnavailableReason()).toBeNull()
  })

  it('keeps Tauri local source-control text generation enabled', () => {
    ;(window as TauriTextGenerationTestWindow).__TAURI_INTERNALS__ = {}

    expect(getSourceControlTextGenerationUnavailableReason()).toBeNull()
  })
})
