import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_SOURCE = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
const CSS_SOURCE = readFileSync(join(__dirname, 'assets/main.css'), 'utf8')
const SETTINGS_OVERLAY_SOURCE = readFileSync(
  join(__dirname, 'components/settings/SettingsOverlay.tsx'),
  'utf8'
)
const SETTINGS_SOURCE = readFileSync(join(__dirname, 'components/settings/Settings.tsx'), 'utf8')

describe('Settings layer retention', () => {
  it('keeps Settings and the workbench mounted as independent compositor layers', () => {
    expect(APP_SOURCE).toContain('<SettingsOverlay />')
    expect(APP_SOURCE).toContain('app-workbench-layer')
    expect(APP_SOURCE).not.toContain("activeView === 'settings' ? <Settings />")

    expect(CSS_SOURCE).toMatch(
      /\.settings-overlay-layer\s*{[^}]*transform:\s*translate3d\(0, 0, 0\)[^}]*backface-visibility:\s*hidden/s
    )
    expect(CSS_SOURCE).toMatch(/\.settings-overlay-layer--hidden\s*{[^}]*opacity:\s*0/s)
    expect(CSS_SOURCE).not.toMatch(/\.settings-overlay-layer--hidden\s*{[^}]*visibility:/s)
    expect(SETTINGS_OVERLAY_SOURCE).toContain('inert={!settingsVisible}')
    expect(SETTINGS_OVERLAY_SOURCE).toContain('aria-hidden={!settingsVisible}')
    expect(SETTINGS_OVERLAY_SOURCE).toContain(
      '<Suspense fallback={<SettingsLoadingFallback />}>{children}</Suspense>'
    )
    expect(SETTINGS_OVERLAY_SOURCE).toContain(
      '<RetainedSettingsRoute onPrepared={markSettingsCommitted} />'
    )
    expect(CSS_SOURCE).toMatch(
      /\.app-workbench-layer\s*{[^}]*transform:\s*translateZ\(0\)[^}]*will-change:\s*transform/s
    )
  })

  it('reuses startup-hydrated settings and keybindings instead of reloading on open', () => {
    expect(SETTINGS_SOURCE).not.toContain('s.fetchSettings')
    expect(SETTINGS_SOURCE).not.toContain('s.fetchKeybindings')
  })
})
