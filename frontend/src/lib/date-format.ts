import { getIntlLocale } from '@/lib/i18n/runtime'
/**
 * How the panel writes a date — one place for every screen.
 *
 * The provider picks the order in Settings (`dateFormat`); `auto` keeps the
 * old behaviour and follows the viewer's language. The choice lives in a
 * module-level store, like the active locale in `lib/i18n/runtime`, so the
 * plain helpers outside React (`lib/utils`, `lib/sgp`) follow it too.
 * `LanguageProvider` listens for changes and re-renders the tree.
 */

export const DATE_FORMATS = ['auto', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'dd-MM-yyyy', 'dd.MM.yyyy'] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

export const DATE_FORMAT_CHANGED_EVENT = 'panel:date-format-changed'

export function isDateFormat(value: unknown): value is DateFormat {
  return typeof value === 'string' && (DATE_FORMATS as readonly string[]).includes(value)
}

let activeDateFormat: DateFormat = 'auto'

export function getActiveDateFormat(): DateFormat {
  return activeDateFormat
}

/** Sets the provider's choice and tells the React tree to re-render. */
export function setActiveDateFormat(value: unknown) {
  const next: DateFormat = isDateFormat(value) ? value : 'auto'
  if (next === activeDateFormat) return
  activeDateFormat = next
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<DateFormat>(DATE_FORMAT_CHANGED_EVENT, { detail: next }))
  }
}

export type DateInput = Date | string | number | null | undefined

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A `Date`, or `null` when the value is empty or unreadable.
 *
 * A bare `2026-05-02` is a day on the calendar, not an instant: `new Date()`
 * reads it as UTC midnight, which west of Greenwich — all of Brazil — is the
 * evening BEFORE. It is built at local midnight instead, so the day shown is
 * the day stored.
 */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'string') {
    const day = DATE_ONLY.exec(value.trim())
    if (day) {
      const date = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
      return Number.isNaN(date.getTime()) ? null : date
    }
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Whether the value names a day and no time (so a time part would be invented). */
export function isDateOnly(value: DateInput): boolean {
  return typeof value === 'string' && DATE_ONLY.test(value.trim())
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The date part in the chosen order; `auto` is the locale's own short date. */
export function formatDayPart(date: Date, format: DateFormat, intlLocale: string): string {
  if (format === 'auto') return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'short' }).format(date)
  return format
    .replace('yyyy', String(date.getFullYear()))
    .replace('MM', pad(date.getMonth() + 1))
    .replace('dd', pad(date.getDate()))
}

export interface FormatOptions {
  format?: DateFormat
  intlLocale: string
  /** `none` (date only), `short` (hh:mm) or `seconds` (hh:mm:ss). */
  time?: 'none' | 'short' | 'seconds'
}

/**
 * A date (and optionally its time) as the provider wants it written, or
 * `null` for an empty or unreadable value — the caller picks the placeholder.
 * A date-only value never gets a time part, whatever `time` says.
 */
export function formatDateValue(value: DateInput, { format = activeDateFormat, intlLocale, time = 'none' }: FormatOptions): string | null {
  const date = toDate(value)
  if (!date) return null
  const day = formatDayPart(date, format, intlLocale)
  if (time === 'none' || isDateOnly(value)) return day
  const clock = new Intl.DateTimeFormat(intlLocale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(time === 'seconds' ? { second: '2-digit' } : {})
  }).format(date)
  return `${day} ${clock}`
}

/** A sample of the format, for the settings screen. */
export function dateFormatExample(format: DateFormat, intlLocale: string): string {
  return formatDayPart(new Date(2026, 11, 31), format, intlLocale)
}

const ISO_DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:[ T]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/

/**
 * The calendar day of a value that is meant as a day — `2026-05-02`, or the
 * same at midnight as some ERPs send it — or `null` for anything else. Lets a
 * screen format what it recognises and leave free text from the SGP as is.
 */
export function isoDay(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = ISO_DAY_PREFIX.exec(value.trim())
  return match ? match[1] : null
}

/**
 * For code outside React: a date (or date and time) in the provider's format
 * and the active language, or `null` when there is nothing to show. Screens
 * inside React use `formatDate`/`formatDateTime` from `useTranslation()`.
 */
export function displayDate(value: DateInput): string | null {
  return formatDateValue(value, { intlLocale: getIntlLocale(), time: 'none' })
}

export function displayDateTime(value: DateInput): string | null {
  const date = toDate(value)
  if (!date) return null
  if (activeDateFormat === 'auto' && !isDateOnly(value)) {
    return new Intl.DateTimeFormat(getIntlLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(date)
  }
  return formatDateValue(value, { intlLocale: getIntlLocale(), time: 'short' })
}

/**
 * For code outside React: day and month only (`formatDayMonth`) in the
 * provider's order, or `null` when there is nothing to show.
 */
export function displayDayMonth(value: DateInput): string | null {
  const date = toDate(value)
  return date ? formatDayMonth(date, activeDateFormat, getIntlLocale()) : null
}

/**
 * Day and month only, for the compact stamps (a message, a conversation, a
 * chart axis), in the provider's order: 02/10, 10/02, 10-02 or 02.10.
 */
export function formatDayMonth(date: Date, format: DateFormat, intlLocale: string): string {
  if (format === 'auto') return new Intl.DateTimeFormat(intlLocale, { day: '2-digit', month: '2-digit' }).format(date)
  const d = pad(date.getDate())
  const m = pad(date.getMonth() + 1)
  switch (format) {
    case 'MM/dd/yyyy': return `${m}/${d}`
    case 'yyyy-MM-dd': return `${m}-${d}`
    case 'dd-MM-yyyy': return `${d}-${m}`
    case 'dd.MM.yyyy': return `${d}.${m}`
    default: return `${d}/${m}`
  }
}
