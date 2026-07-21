import { describe, expect, it } from 'vitest'

import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

describe('localized product name', () => {
  it('keeps the Pebble brand token identical in every locale', () => {
    for (const locale of [en, es, ja, ko, zh]) {
      expect(locale.auto.components.Landing['6ca6ff404e']).toBe('Pebble')
    }
  })
})
