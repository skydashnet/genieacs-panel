'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  LANGUAGE_CHANGED_EVENT,
  LANGUAGE_STORAGE_KEY,
  LOCALE_METADATA,
  LOCALES,
  detectLocale,
  getDirection,
  isDictionaryLoaded,
  isLocale,
  loadDictionary,
  setActiveLocale,
  translate,
  type Locale,
  type TranslationKey,
  type TranslationVars,
} from '@/lib/i18n'
import {
  DATE_FORMAT_CHANGED_EVENT,
  formatDateValue,
  getActiveDateFormat,
  isDateFormat,
  toDate,
  type DateFormat,
} from '@/lib/date-format'

interface LanguageContextType {
  /** Active locale, e.g. `pt-BR`. */
  locale: Locale
  /** Locale tag to hand to `Intl`, e.g. `pt-BR` for `pt-BR` and `en-US` for `en`. */
  intlLocale: string
  locales: readonly Locale[]
  setLocale: (locale: Locale) => void
  /** Translates a key, interpolating `{placeholder}` slots from `vars`. */
  t: (key: TranslationKey, vars?: TranslationVars) => string
  formatDate: (value: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => string
  formatDateTime: (value: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => string
  formatTime: (value: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => string
  formatNumber: (value: number | null | undefined, options?: Intl.NumberFormatOptions) => string
  /** The provider's date order (Settings → General); `auto` follows the language. */
  dateFormat: DateFormat
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

const EMPTY_VALUE = '—'

/** English ships with the bundle, so it can always be rendered right away. */
const BUNDLED_LOCALE: Locale = 'en'

export function LanguageProvider({ children }: { children: ReactNode }) {
  // The locale the visitor asked for, and the one currently being rendered.
  // They differ only while a lazily loaded dictionary is on its way: children
  // keep rendering a complete dictionary instead of a half-loaded one.
  const [requestedLocale, setRequestedLocale] = useState<Locale>(() => detectLocale())
  const [locale, setRenderedLocale] = useState<Locale>(() => {
    const detected = detectLocale()
    return isDictionaryLoaded(detected) ? detected : BUNDLED_LOCALE
  })
  // Switching language later may briefly fall back to English, which reads as
  // a deliberate response to the click. Doing that on the very first paint
  // would instead look like the panel ignoring the visitor's language, so the
  // initial render waits for the dictionary the entry point already requested.
  const [ready, setReady] = useState<boolean>(() => isDictionaryLoaded(detectLocale()))

  // A dictionary request that never settles must not leave a blank page, so
  // the app is released in English if the chunk has not arrived in time.
  useEffect(() => {
    if (ready) return undefined
    const timer = window.setTimeout(() => setReady(true), 3000)
    return () => window.clearTimeout(timer)
  }, [ready])

  // Render a locale only once its dictionary is in memory. `loadDictionary`
  // resolves even when the chunk fails, and English then stands in for it.
  useEffect(() => {
    if (isDictionaryLoaded(requestedLocale)) {
      setRenderedLocale(requestedLocale)
      setReady(true)
      return
    }
    let cancelled = false
    void loadDictionary(requestedLocale).then(() => {
      if (cancelled) return
      setRenderedLocale(requestedLocale)
      setReady(true)
    })
    return () => { cancelled = true }
  }, [requestedLocale])

  // Keep `<html lang>`, `<html dir>` and the non-React formatters in `lib/utils`
  // in sync. The direction drives every logical Tailwind utility in the app.
  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = getDirection(locale)
    setActiveLocale(locale)
  }, [locale])

  useEffect(() => {
    const syncFromEvent = (event: Event) => {
      const detail = (event as CustomEvent<Locale>).detail
      if (isLocale(detail)) setRequestedLocale(detail)
    }
    const syncFromStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY && isLocale(event.newValue)) setRequestedLocale(event.newValue)
    }
    window.addEventListener(LANGUAGE_CHANGED_EVENT, syncFromEvent)
    window.addEventListener('storage', syncFromStorage)
    return () => {
      window.removeEventListener(LANGUAGE_CHANGED_EVENT, syncFromEvent)
      window.removeEventListener('storage', syncFromStorage)
    }
  }, [])

  // The provider's date format, set from outside React (`setActiveDateFormat`)
  // once the session or the portal knows it.
  const [dateFormat, setDateFormat] = useState<DateFormat>(() => getActiveDateFormat())
  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<DateFormat>).detail
      setDateFormat(isDateFormat(detail) ? detail : 'auto')
    }
    window.addEventListener(DATE_FORMAT_CHANGED_EVENT, sync)
    setDateFormat(getActiveDateFormat())
    return () => window.removeEventListener(DATE_FORMAT_CHANGED_EVENT, sync)
  }, [])

  const setLocale = useCallback((next: Locale) => {
    setRequestedLocale(next)
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, next)
    } catch {
      // Preference stays for this session only when storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent<Locale>(LANGUAGE_CHANGED_EVENT, { detail: next }))
  }, [])

  const value = useMemo<LanguageContextType>(() => {
    const intlLocale = LOCALE_METADATA[locale].intlLocale
    const format = (
      value: Date | string | number | null | undefined,
      options: Intl.DateTimeFormatOptions,
    ) => {
      const date = toDate(value)
      if (!date) return EMPTY_VALUE
      return new Intl.DateTimeFormat(intlLocale, options).format(date)
    }

    // A fixed order replaces the locale's numeric date wherever a screen asked
    // for the plain one (no options, or a `dateStyle`). A screen that spelled
    // out its own parts — "2 de outubro de 2026" — keeps them.
    const numeric = (options?: Intl.DateTimeFormatOptions) =>
      dateFormat !== 'auto' && (!options || (options.dateStyle !== undefined
        && options.dateStyle !== 'full' && options.dateStyle !== 'long'))
    const custom = (
      value: Date | string | number | null | undefined,
      time: 'none' | 'short' | 'seconds',
    ) => formatDateValue(value, { format: dateFormat, intlLocale, time }) ?? EMPTY_VALUE

    return {
      locale,
      intlLocale,
      locales: LOCALES,
      setLocale,
      dateFormat,
      t: (key, vars) => translate(locale, key, vars),
      formatDate: (date, options) => (numeric(options)
        ? custom(date, 'none')
        : format(date, options ?? { dateStyle: 'short' })),
      formatDateTime: (date, options) => (numeric(options)
        ? custom(date, options?.timeStyle === 'medium' ? 'seconds' : 'short')
        : format(date, options ?? { dateStyle: 'short', timeStyle: 'short' })),
      formatTime: (date, options) => format(date, options ?? { hour: '2-digit', minute: '2-digit' }),
      formatNumber: (number, options) =>
        typeof number === 'number' && Number.isFinite(number)
          ? new Intl.NumberFormat(intlLocale, options).format(number)
          : EMPTY_VALUE,
    }
  }, [locale, setLocale, dateFormat])

  return (
    <LanguageContext.Provider value={value}>
      {ready ? children : null}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider')
  }
  return context
}

/** Convenience alias for components that only need `t`. */
export function useTranslation() {
  return useLanguage()
}
