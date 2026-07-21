import { describe, expect, it } from 'vitest'
import { renderUniversalMacCask } from './render-tauri-homebrew-cask.mjs'

const SHA = 'a'.repeat(64)
const LEGACY_CASK = `cask "pebble" do
  arch arm: "arm64", intel: "x64"

  version "1.3.24"
  sha256 arm:   "${'b'.repeat(64)}",
         intel: "${'c'.repeat(64)}"

  url "https://github.com/nebutra/pebble/releases/download/v#{version}/pebble-macos-#{arch}.dmg"
end
`

describe('Tauri Homebrew cask renderer', () => {
  it('migrates the legacy split-architecture cask to one universal DMG', () => {
    expect(renderUniversalMacCask(LEGACY_CASK, { version: '1.4.128', sha256: SHA })).toBe(
      `cask "pebble" do
  version "1.4.128"
  sha256 "${SHA}"

  url "https://github.com/nebutra/pebble/releases/download/v#{version}/pebble-macos-universal.dmg"
end
`
    )
  })

  it('rejects malformed release input before rewriting the cask', () => {
    expect(() => renderUniversalMacCask(LEGACY_CASK, { version: '', sha256: SHA })).toThrow(
      'non-empty cask version'
    )
    expect(() => renderUniversalMacCask(LEGACY_CASK, { version: '1.4.128', sha256: 'bad' })).toThrow(
      '64 lowercase hexadecimal'
    )
  })
})
