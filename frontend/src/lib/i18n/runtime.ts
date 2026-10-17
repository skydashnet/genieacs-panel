import { DEFAULT_LOCALE, LOCALE_METADATA, type Locale } from '@/lib/i18n/config'

/**
 * Mirror of the active locale for code that runs outside React (plain helpers in
 * `lib/utils`). `LanguageProvider` keeps it in sync; components should read the
 * locale from `useLanguage()` instead of calling this.
 */
let activeLocale: Locale = DEFAULT_LOCALE

export function setActiveLocale(locale: Locale) {
  activeLocale = locale
}

export function getActiveLocale(): Locale {
  return activeLocale
}

/** Locale tag for `Intl` formatters, e.g. `en-US` for `en`. */
export function getIntlLocale(): string {
  return LOCALE_METADATA[activeLocale].intlLocale
}
