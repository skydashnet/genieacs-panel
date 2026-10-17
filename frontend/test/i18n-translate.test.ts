import { describe, expect, it } from 'vitest'

import en from '@/lib/i18n/locales/en'
import {
  isCustomerSessionCode,
  isDictionaryLoaded,
  loadDictionary,
  translate,
  type TranslationKey
} from '@/lib/i18n'

/**
 * `translate` is the one function every screen goes through, and it stays
 * synchronous while the dictionaries load on demand. The whole design rests on
 * a fallback chain that must never produce an empty node: locale, then English,
 * then the key itself — a missing string should look wrong, not look like
 * nothing.
 */
describe('translating', () => {
  it('reads the bundled English dictionary', () => {
    expect(translate('en', 'common.na')).toBe(en['common.na'])
  })

  /**
   * A locale whose chunk has not arrived reads as English rather than blank.
   * This is the normal state for the first paint in every locale but English.
   */
  it('falls back to English while a dictionary is still on the way', () => {
    expect(isDictionaryLoaded('ja')).toBe(false)
    expect(translate('ja', 'common.na')).toBe(en['common.na'])
  })

  it('reads the locale once its dictionary has loaded', async () => {
    await loadDictionary('pt-BR')
    expect(isDictionaryLoaded('pt-BR')).toBe(true)

    const translated = translate('pt-BR', 'common.na')
    expect(translated).toBeTruthy()
    // Not proof of a good translation, but proof it stopped reading English.
    const ptDictionary = (await import('@/lib/i18n/locales/pt-BR')).default
    expect(translated).toBe(ptDictionary['common.na'])
  })

  /**
   * The last link in the chain. A key that exists in no dictionary renders as
   * itself, which is ugly on screen and therefore reported — the point.
   */
  it('renders an unknown key as the key, never as empty', () => {
    const missing = 'nobody.declared.this' as TranslationKey
    expect(translate('en', missing)).toBe(missing)
    expect(translate('pt-BR', missing)).toBe(missing)
  })

  it('is idempotent about loading: asking twice does not reload', async () => {
    await loadDictionary('es')
    const first = translate('es', 'common.na')
    await loadDictionary('es')
    expect(translate('es', 'common.na')).toBe(first)
  })

  it('resolves rather than throwing for a locale with no loader', async () => {
    await expect(loadDictionary('en')).resolves.toBeUndefined()
  })
})

describe('interpolating variables', () => {
  /**
   * The key is found in the shipped dictionary rather than invented, so this
   * breaks if the string loses its placeholders instead of testing a fiction
   * that no screen renders.
   */
  const keyContaining = (placeholder: string): TranslationKey => {
    const found = (Object.entries(en) as [TranslationKey, string][])
      .find(([, value]) => value.includes(placeholder))
    expect(found, `no English string carries ${placeholder}`).toBeTruthy()
    return found![0]
  }

  it('substitutes a placeholder', () => {
    const key = keyContaining('{count}')
    const rendered = translate('en', key, { count: 7 })
    expect(rendered).toContain('7')
    expect(rendered).not.toContain('{count}')
  })

  it('substitutes several in one string', () => {
    const key = keyContaining('{total}')
    const rendered = translate('en', key, { online: 3, total: 9, count: 9 })
    expect(rendered).not.toContain('{total}')
    expect(rendered).toContain('9')
  })

  /**
   * A variable the caller forgot leaves the placeholder standing. Dropping it
   * instead would turn "3 of 9 devices" into "3 of devices", which reads as a
   * finished sentence and says something false.
   */
  it('leaves a placeholder the caller did not supply', () => {
    const key = keyContaining('{count}')
    expect(translate('en', key, { other: 1 })).toContain('{count}')
    expect(translate('en', key)).toContain('{count}')
  })

  it('substitutes an empty string, which is a value like any other', () => {
    const key = keyContaining('{count}')
    expect(translate('en', key, { count: '' })).not.toContain('{count}')
  })

  it('substitutes zero, which a falsy check would have dropped', () => {
    const key = keyContaining('{count}')
    expect(translate('en', key, { count: 0 })).toContain('0')
  })
})

describe('the codes that end a portal session', () => {
  it('recognises exactly the three, and nothing adjacent', () => {
    expect(isCustomerSessionCode('customer_session_required')).toBe(true)
    expect(isCustomerSessionCode('customer_session_invalid')).toBe(true)
    expect(isCustomerSessionCode('customer_session_expired')).toBe(true)

    expect(isCustomerSessionCode('session_expired')).toBe(false)
    expect(isCustomerSessionCode('rate_limited')).toBe(false)
    expect(isCustomerSessionCode(undefined)).toBe(false)
    expect(isCustomerSessionCode('')).toBe(false)
  })
})
