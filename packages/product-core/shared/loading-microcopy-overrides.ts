import type { LoadingMicrocopyLocale } from './loading-microcopy-types'
import { LOADING_MICROCOPY_OVERRIDES_EN } from './loading-microcopy-overrides-en'
import { LOADING_MICROCOPY_OVERRIDES_ZH } from './loading-microcopy-overrides-zh'

// Seed-pattern → phrase overrides, split out of loading-microcopy.ts.
export const LOADING_MICROCOPY_OVERRIDES: Record<
  LoadingMicrocopyLocale,
  [RegExp, readonly string[]][]
> = {
  en: LOADING_MICROCOPY_OVERRIDES_EN,
  zh: LOADING_MICROCOPY_OVERRIDES_ZH,
  es: [],
  ja: [],
  ko: []
}
