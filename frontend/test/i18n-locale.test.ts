import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_METADATA,
  detectLocale,
  getDirection,
  isLocale,
  resolveLocale,
  type Locale
} from '@/lib/i18n/config'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolving an arbitrary language tag', () => {
  it('takes an exact match whatever the casing', () => {
    expect(resolveLocale('pt-BR')).toBe('pt-BR')
    expect(resolveLocale('PT-br')).toBe('pt-BR')
    expect(resolveLocale('  en  ')).toBe('en')
  })

  /**
   * Portuguese has no European dictionary here, so `pt-PT` reads Brazilian
   * rather than falling to the English fallback. Same shape for `es-419`.
   */
  it('folds a region it does not carry onto the base language', () => {
    expect(resolveLocale('pt-PT')).toBe('pt-BR')
    expect(resolveLocale('pt')).toBe('pt-BR')
    expect(resolveLocale('es-419')).toBe('es')
    expect(resolveLocale('en-GB')).toBe('en')
    expect(resolveLocale('de-AT')).toBe('de')
  })

  /**
   * The one rule with real subtlety: script, not region, decides Chinese — and
   * the regions that write Traditional have to be listed because the tag does
   * not always carry the script.
   */
  it('sends every Traditional marker to zh-TW and the rest to zh-CN', () => {
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-HK']) {
      expect(resolveLocale(tag), tag).toBe('zh-TW')
    }
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-SG']) {
      expect(resolveLocale(tag), tag).toBe('zh-CN')
    }
  })

  it('answers null for a tag it cannot place, rather than guessing', () => {
    expect(resolveLocale('sv')).toBeNull()
    expect(resolveLocale('klingon')).toBeNull()
    expect(resolveLocale('')).toBeNull()
    expect(resolveLocale('   ')).toBeNull()
    expect(resolveLocale(null)).toBeNull()
    expect(resolveLocale(undefined)).toBeNull()
  })

  it('places every locale it ships', () => {
    for (const locale of LOCALES) {
      expect(resolveLocale(locale), locale).toBe(locale)
    }
  })
})

describe('locale metadata', () => {
  it('describes every locale, with nothing left over', () => {
    expect(Object.keys(LOCALE_METADATA).sort()).toEqual([...LOCALES].sort())
    for (const locale of LOCALES) {
      const meta = LOCALE_METADATA[locale]
      expect(meta.label, locale).toBeTruthy()
      expect(meta.shortLabel, locale).toBeTruthy()
      expect(meta.flag, locale).toBeTruthy()
      // Handed to `Intl`, so it has to be a tag `Intl` accepts.
      expect(() => new Intl.DateTimeFormat(meta.intlLocale), locale).not.toThrow()
    }
  })

  it('marks Arabic right-to-left and everything else the other way', () => {
    expect(getDirection('ar')).toBe('rtl')
    for (const locale of LOCALES.filter((l) => l !== 'ar')) {
      expect(getDirection(locale), locale).toBe('ltr')
    }
  })

  it('recognises its own locales and nothing else', () => {
    for (const locale of LOCALES) expect(isLocale(locale), locale).toBe(true)
    expect(isLocale('sv')).toBe(false)
    expect(isLocale(42)).toBe(false)
    expect(isLocale(null)).toBe(false)
  })
})

describe('detecting the locale of a visitor', () => {
  const withBrowser = (options: {
    stored?: string | null
    languages?: string[]
    throwOnStorage?: boolean
  }) => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          if (options.throwOnStorage) throw new Error('storage is blocked')
          return options.stored ?? null
        }
      }
    })
    vi.stubGlobal('navigator', { languages: options.languages ?? [], language: '' })
  }

  it('prefers what the visitor chose before', () => {
    withBrowser({ stored: 'ja', languages: ['de-DE'] })
    expect(detectLocale()).toBe('ja')
  })

  it('walks the browser languages in order and takes the first it can place', () => {
    withBrowser({ stored: null, languages: ['sv-SE', 'zh-HK', 'en-US'] })
    expect(detectLocale()).toBe('zh-TW')
  })

  /**
   * Private mode and blocked cookies make `localStorage` throw on read, not
   * return null. Falling over there would leave the panel untranslated for the
   * exact visitor who is hardest to debug for.
   */
  it('keeps going when storage itself throws', () => {
    withBrowser({ throwOnStorage: true, languages: ['fr-CA'] })
    expect(detectLocale()).toBe('fr')
  })

  it('ignores a stored value it cannot place', () => {
    withBrowser({ stored: 'klingon', languages: ['ru'] })
    expect(detectLocale()).toBe('ru')
  })

  it('falls back to the default when nothing matches', () => {
    withBrowser({ stored: null, languages: ['sv-SE', 'nb-NO'] })
    expect(detectLocale()).toBe(DEFAULT_LOCALE)
  })

  /** Rendered on a server, or anywhere `window` is absent, it must not throw. */
  it('answers the default with no browser at all', () => {
    expect(detectLocale()).toBe(DEFAULT_LOCALE)
  })
})

describe('the default locale', () => {
  it('is one of the locales that ship', () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE satisfies Locale)
  })
})
