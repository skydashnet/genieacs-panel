import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTACTS_FILTERS_KEY, loadContactFilters, saveContactFilters, type ContactFilters } from '@/lib/contact-filters'
import { clearSessionScopedStorage } from '@/lib/session-owner'

const fallback: ContactFilters = { search: '', state: 'active', noPhone: false, imported: false, device: '' }

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) }
  })
  return data
}

describe('contact filters', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  it('round-trips what was saved', () => {
    stubStorage()
    const chosen: ContactFilters = { search: 'ana', state: 'none', noPhone: true, imported: false, device: 'without' }
    saveContactFilters(CONTACTS_FILTERS_KEY, chosen)
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback)).toEqual(chosen)
  })

  it('falls back when nothing, junk or unknown values are stored', () => {
    stubStorage()
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback)).toEqual(fallback)
    stubStorage({ [CONTACTS_FILTERS_KEY]: '{not json' })
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback)).toEqual(fallback)
    stubStorage({ [CONTACTS_FILTERS_KEY]: JSON.stringify({ state: 'x', device: 'y', noPhone: 'sim', search: 3 }) })
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback)).toEqual(fallback)
  })

  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') }
    })
    expect(loadContactFilters(CONTACTS_FILTERS_KEY, fallback)).toEqual(fallback)
    expect(() => saveContactFilters(CONTACTS_FILTERS_KEY, fallback)).not.toThrow()
  })

  it('is cleared with the session', () => {
    const data = stubStorage({ [CONTACTS_FILTERS_KEY]: '{}' })
    clearSessionScopedStorage()
    expect(data.has(CONTACTS_FILTERS_KEY)).toBe(false)
  })
})
