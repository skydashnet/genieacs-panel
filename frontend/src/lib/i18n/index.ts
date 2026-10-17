import en from '@/lib/i18n/locales/en'
import type { Locale } from '@/lib/i18n/config'
import type { Dictionary, TranslationKey, TranslationVars } from '@/lib/i18n/dictionary'

export * from '@/lib/i18n/config'
export * from '@/lib/i18n/runtime'
export * from '@/lib/i18n/api-messages'
export type { Dictionary, TranslationKey, TranslationVars }

/** English is the fallback because it is the dictionary the other locales are typed against. */
const FALLBACK_LOCALE: Locale = 'en'

type LazyLocale = Exclude<Locale, 'en'>

/**
 * English is bundled: it is the fallback, and `translate()` must stay
 * synchronous for the plain helpers in `lib/utils`. Every other dictionary is
 * fetched on demand so a visitor downloads one locale instead of all of them.
 */
const loaded: Partial<Record<Locale, Dictionary>> = { en }

const loaders: Record<LazyLocale, () => Promise<{ default: Dictionary }>> = {
  ar: () => import('@/lib/i18n/locales/ar'),
  de: () => import('@/lib/i18n/locales/de'),
  es: () => import('@/lib/i18n/locales/es'),
  fr: () => import('@/lib/i18n/locales/fr'),
  hi: () => import('@/lib/i18n/locales/hi'),
  it: () => import('@/lib/i18n/locales/it'),
  ja: () => import('@/lib/i18n/locales/ja'),
  ko: () => import('@/lib/i18n/locales/ko'),
  'pt-BR': () => import('@/lib/i18n/locales/pt-BR'),
  ru: () => import('@/lib/i18n/locales/ru'),
  'zh-CN': () => import('@/lib/i18n/locales/zh-CN'),
  'zh-TW': () => import('@/lib/i18n/locales/zh-TW'),
}

const pending = new Map<Locale, Promise<void>>()

/** True once `locale` renders from its own dictionary instead of the fallback. */
export function isDictionaryLoaded(locale: Locale): boolean {
  return loaded[locale] !== undefined
}

/**
 * Fetches the dictionary for `locale`, if it is not bundled already. Resolves
 * even when the chunk fails to load: English then stands in for that locale.
 */
export function loadDictionary(locale: Locale): Promise<void> {
  if (isDictionaryLoaded(locale)) return Promise.resolve()
  const loader = loaders[locale as LazyLocale]
  if (!loader) return Promise.resolve()
  const inFlight = pending.get(locale)
  if (inFlight) return inFlight

  const request = loader()
    .then((module) => {
      loaded[locale] = module.default
    })
    .catch((error: unknown) => {
      console.error(`Could not load the "${locale}" dictionary; falling back to ${FALLBACK_LOCALE}.`, error)
    })
    .finally(() => {
      pending.delete(locale)
    })
  pending.set(locale, request)
  return request
}

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g

function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Translates `key` into `locale`, falling back to English and finally to the key
 * itself so a missing string is visible instead of rendering as an empty node.
 * Stays synchronous: a locale whose chunk has not arrived reads as English.
 */
export function translate(locale: Locale, key: TranslationKey, vars?: TranslationVars): string {
  const template = loaded[locale]?.[key] ?? en[key] ?? key
  return interpolate(template, vars)
}
