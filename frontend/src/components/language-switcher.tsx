'use client'

import { useLanguage } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { LOCALE_METADATA, type Locale } from '@/lib/i18n'

type LanguageSwitcherProps = {
  /** `dark` matches the sidebar and the marketing panels; `light` matches cards and forms. */
  variant?: 'dark' | 'light'
  /** Renders the two-letter badge only, for the collapsed sidebar. */
  compact?: boolean
  /** Below `sm`, collapses to the badge too: the auth headers share the row with the brand name. */
  collapseOnMobile?: boolean
  className?: string
}

export function LanguageSwitcher({ variant = 'light', compact = false, collapseOnMobile = false, className = '' }: LanguageSwitcherProps) {
  const { locale, locales, setLocale, t } = useLanguage()
  const isDark = variant === 'dark'

  const shellClass = isDark
    ? 'border-white/12 bg-white/5 text-[#e2e9e5] hover:bg-white/10'
    : 'border-border bg-card text-foreground hover:bg-muted'

  return (
    <div
      className={`relative flex min-h-11 items-center rounded-md border transition-colors ${shellClass} ${
        compact ? 'justify-center gap-1 px-1' : collapseOnMobile ? 'min-w-11 justify-center gap-1 px-1.5 sm:justify-start sm:gap-2 sm:px-2.5' : 'gap-2 px-2.5'
      } ${className}`}
      title={t('language.current', { language: LOCALE_METADATA[locale].label })}
    >
      <Icon name="globe" size={17} className="shrink-0" aria-hidden="true" />
      {compact ? (
        <span className="text-[0.62rem] font-bold">{LOCALE_METADATA[locale].shortLabel}</span>
      ) : collapseOnMobile ? (
        <>
          <span className="text-[0.62rem] font-bold sm:hidden">{LOCALE_METADATA[locale].shortLabel}</span>
          <span className="hidden truncate text-xs font-semibold sm:inline">{LOCALE_METADATA[locale].label}</span>
        </>
      ) : (
        <span className="truncate text-xs font-semibold">{LOCALE_METADATA[locale].label}</span>
      )}
      {!compact && <Icon name="chevron-down" size={14} className={`ms-auto shrink-0 opacity-70 ${collapseOnMobile ? 'hidden sm:block' : ''}`} aria-hidden="true" />}
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        aria-label={t('language.select')}
        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
      >
        {locales.map((code) => (
          <option key={code} value={code} className="bg-card text-foreground">
            {`${LOCALE_METADATA[code].flag} ${LOCALE_METADATA[code].label}`}
          </option>
        ))}
      </select>
    </div>
  )
}
