import i18next, {
  type BackendModule,
  type i18n as I18nInstance,
  type ReadCallback,
  type TOptions
} from 'i18next'
import { initReactI18next } from 'react-i18next'

import { isPseudoLocalizationLocale, pseudoLocalizeString } from './pseudo-localization'
import { DEFAULT_LOCALE, resolveUiLocale } from './supported-languages'
import type { SupportedUiLocale } from '../../../shared/ui-locale'
import type { UiLanguage } from '../../../shared/ui-language'
import { getLoadingMicrocopy } from '../../../shared/loading-microcopy'

export const i18n: I18nInstance = i18next.createInstance()

// Why: every English callsite carries its source fallback, so bundling the
// generated English catalog duplicates about 500 KB of startup text. Only
// translated catalogs need loading; English renders synchronously from those
// fallbacks without fetching or parsing a locale chunk.
const NON_DEFAULT_LOCALE_LOADERS: Record<
  Exclude<SupportedUiLocale, 'en'>,
  () => Promise<{ default: Record<string, unknown> }>
> = {
  es: () => import('./locales/es.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  zh: () => import('./locales/zh.json')
}

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    const loader = NON_DEFAULT_LOCALE_LOADERS[language as Exclude<SupportedUiLocale, 'en'>]
    if (!loader) {
      // English is predeclared as an empty namespace and uses callsite
      // fallbacks. Unknown locales fall back through i18next as before.
      callback(null, false)
      return
    }
    loader().then(
      (mod) => callback(null, mod.default),
      (error) => callback(error instanceof Error ? error : new Error(String(error)), false)
    )
  }
}

void i18n
  .use(lazyLocaleBackend)
  .use(initReactI18next)
  .init({
    fallbackLng: DEFAULT_LOCALE,
    lng: DEFAULT_LOCALE,
    // Why: the empty English namespace marks the default locale ready without
    // embedding a duplicate catalog. The backend supplies translated locales.
    partialBundledLanguages: true,
    resources: {
      en: {
        translation: {}
      }
    },
    interpolation: {
      escapeValue: false
    },
    react: {
      useSuspense: false
    }
  })

function getTranslateFallback(key: string, fallback: string): string {
  const microcopySeed = `${key}:${fallback}`
  if (/\(loading(?:\.{3}|…)\)/i.test(fallback)) {
    return fallback.replace(
      /\(loading(?:\.{3}|…)\)/i,
      `(${getLoadingMicrocopy(microcopySeed, i18n.language)})`
    )
  }
  if (
    /^Loading(?:\b|\s|[.…])/.test(fallback) ||
    /^loading$/i.test(fallback) ||
    /still loading/i.test(fallback) ||
    /^Scanning sessions$/i.test(fallback)
  ) {
    return getLoadingMicrocopy(microcopySeed, i18n.language)
  }
  return fallback
}

export function translate(key: string, fallback: string, options?: TOptions): string {
  const value = i18n.t(key, { defaultValue: getTranslateFallback(key, fallback), ...options })
  return isPseudoLocalizationLocale(i18n.language) ? pseudoLocalizeString(value) : value
}

export async function setRendererUiLanguage(language: UiLanguage): Promise<void> {
  const locale = resolveUiLocale(language)
  if (i18n.language !== locale) {
    // changeLanguage triggers the lazy backend load for non-English locales and
    // resolves once the catalog is in memory.
    await i18n.changeLanguage(locale)
  }
}
