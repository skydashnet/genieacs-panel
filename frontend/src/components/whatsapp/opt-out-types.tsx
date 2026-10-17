'use client'

import { useTranslation } from '@/contexts/language-context'
import {
  ALL_OPT_OUT_TYPES,
  OPT_OUT_TYPES,
  selectionFor,
  toggleType,
  type OptOutType
} from '@/lib/wa-optout-types'

/**
 * Which kinds of message to stop sending. Ticked means "do not send": the
 * default, everything ticked, is the "do not disturb" this screen always was.
 */
export function OptOutTypePicker({
  value,
  onChange,
  idPrefix
}: {
  value: OptOutType[]
  onChange: (next: OptOutType[]) => void
  idPrefix: string
}) {
  const { t } = useTranslation()
  const all = value.length === ALL_OPT_OUT_TYPES.length
  return (
    <fieldset className="flex flex-col gap-2" data-testid="wa-optout-types">
      <legend className="field-label">{t('whatsapp.optOut.types.title')}</legend>
      <div className="flex flex-wrap gap-2">
        {OPT_OUT_TYPES.map(([id, labelKey]) => {
          const checked = value.includes(id)
          return (
            <label
              key={id}
              htmlFor={`${idPrefix}-${id}`}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${checked ? 'border-primary bg-primary/10 font-semibold' : 'border-border'}`}
            >
              <input
                id={`${idPrefix}-${id}`}
                type="checkbox"
                className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={checked}
                onChange={() => onChange(toggleType(value, id))}
              />
              {t(labelKey)}
            </label>
          )
        })}
        <button
          type="button"
          className="modern-button-secondary"
          onClick={() => onChange(all ? [] : [...ALL_OPT_OUT_TYPES])}
        >
          {t(all ? 'whatsapp.optOut.types.clear' : 'whatsapp.optOut.types.all')}
        </button>
      </div>
      <p className="field-hint">{t('whatsapp.optOut.types.hint')}</p>
    </fieldset>
  )
}

/** The kinds an entry blocks, as badges; "Everything" when it has no restriction. */
export function OptOutTypeBadges({ categories }: { categories: readonly string[] | null | undefined }) {
  const { t } = useTranslation()
  const selected = selectionFor(categories)
  const everything = !categories || selected.length === ALL_OPT_OUT_TYPES.length
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-testid="wa-optout-badges">
      {everything ? (
        <span className="modern-badge-error">{t('whatsapp.optOut.types.everything')}</span>
      ) : (
        OPT_OUT_TYPES.filter(([id]) => selected.includes(id)).map(([id, labelKey]) => (
          <span key={id} className="modern-badge-warning">{t(labelKey)}</span>
        ))
      )}
    </span>
  )
}
