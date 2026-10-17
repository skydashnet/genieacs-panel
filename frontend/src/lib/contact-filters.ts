import type { ContactDeviceFilter } from '@/lib/api'

/** The Contacts filters an operator has chosen, kept while the tab stays open. */
export interface ContactFilters {
  search: string
  state: '' | 'active' | 'blocked' | 'cancelled' | 'none'
  noPhone: boolean
  imported: boolean
  device: ContactDeviceFilter
}

/** Where the Contacts menu entry keeps them; cleared with the rest of the session. */
export const CONTACTS_FILTERS_KEY = 'contacts-filters'

const STATES: readonly ContactFilters['state'][] = ['', 'active', 'blocked', 'cancelled', 'none']
const DEVICES: readonly ContactDeviceFilter[] = ['', 'with', 'without']

/** What was saved under `key`, field by field; anything unknown falls to `fallback`. */
export function loadContactFilters(key: string, fallback: ContactFilters): ContactFilters {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return fallback
    const saved = JSON.parse(raw) as Partial<Record<keyof ContactFilters, unknown>> | null
    if (!saved || typeof saved !== 'object') return fallback
    return {
      search: typeof saved.search === 'string' ? saved.search.slice(0, 200) : fallback.search,
      state: STATES.find((s) => s === saved.state) ?? fallback.state,
      noPhone: typeof saved.noPhone === 'boolean' ? saved.noPhone : fallback.noPhone,
      imported: typeof saved.imported === 'boolean' ? saved.imported : fallback.imported,
      device: DEVICES.find((d) => d === saved.device) ?? fallback.device
    }
  } catch {
    return fallback
  }
}

export function saveContactFilters(key: string, filters: ContactFilters) {
  try {
    sessionStorage.setItem(key, JSON.stringify(filters))
  } catch {
    // Without storage the choice lasts only for this visit.
  }
}
