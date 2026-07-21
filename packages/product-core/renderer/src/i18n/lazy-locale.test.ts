import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_SPANISH
} from '../../../shared/ui-language'
import { i18n, setRendererUiLanguage } from './i18n'

// Why: the renderer uses callsite fallbacks for English and lazy-loads translated
// catalogs through an i18next backend. This guards the
// invariant that switching language (I18nProvider effect / Settings) resolves
// real translations once changeLanguage() settles — and that any direct
// i18n.changeLanguage() call (used across the codebase and tests) transparently
// loads its catalog. A regression would silently show English to a user who
// picked another language.

describe('renderer i18n lazy locale loading', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('serves English synchronously from the callsite fallback', () => {
    expect(i18n.getResourceBundle('en', 'translation')).toEqual({})
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('File')
  })

  it('keeps the generated English catalog out of the startup module graph', () => {
    const source = readFileSync(fileURLToPath(new URL('./i18n.ts', import.meta.url)), 'utf8')
    expect(source).not.toContain("from './locales/en.json'")
  })

  it('lazy-loads Spanish via setRendererUiLanguage before it resolves', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(i18n.language).toBe('es')
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('Archivo')
  })

  it('lazy-loads a catalog through a direct changeLanguage call', async () => {
    await i18n.changeLanguage(UI_LANGUAGE_CHINESE)
    expect(i18n.t('menu.file', { defaultValue: 'File' })).not.toBe('File')
  })

  it('returns to English from a lazily-loaded locale', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('Archivo')

    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('File')
  })
})
