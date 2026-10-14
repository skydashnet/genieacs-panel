import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { activeFilters, type AssigneeFilter } from '@/lib/inbox-filters'
import type { WhatsAppTag } from '@/lib/api'

const ASSIGNEES = [
  ['all', 'whatsapp.assign.filterAll'],
  ['me', 'whatsapp.assign.filterMine'],
  ['unassigned', 'whatsapp.assign.filterUnassigned']
] as const

/** Botão "Filtros" (atendente e etiqueta) e os chips de quem está ligado. */
export function InboxFilterButton({ assignee, tagId, tags, onAssignee, onTag }: {
  assignee: AssigneeFilter
  tagId: number | null
  tags: WhatsAppTag[]
  onAssignee: (value: AssigneeFilter) => void
  onTag: (value: number | null) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const count = activeFilters(assignee, tagId).length

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        className="icon-button relative"
        aria-label={t('whatsapp.inbox.filters')}
        title={t('whatsapp.inbox.filters')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="filter" size={18} />
        {count > 0 && (
          <span className="absolute -end-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">{count}</span>
        )}
      </button>
      {open && (
        <div className="absolute end-0 top-full z-20 mt-1 w-60 space-y-3 rounded-md border border-border bg-background p-3 shadow-lg">
          <div role="radiogroup" aria-label={t('whatsapp.assign.agent')} className="flex flex-wrap gap-1.5">
            {ASSIGNEES.map(([id, labelKey]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={assignee === id}
                onClick={() => onAssignee(id)}
                className={`min-h-7 rounded-full border px-2.5 text-xs font-medium transition-colors ${
                  assignee === id
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-[hsl(var(--surface-subtle))]'
                }`}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
          {tags.length > 0 && (
            <select
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
              aria-label={t('whatsapp.tags.filter')}
              value={tagId ?? ''}
              onChange={(event) => onTag(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">{t('whatsapp.tags.filterAll')}</option>
              {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
          )}
        </div>
      )}
    </div>
  )
}

export function InboxFilterChips({ assignee, tagId, tags, onAssignee, onTag }: {
  assignee: AssigneeFilter
  tagId: number | null
  tags: WhatsAppTag[]
  onAssignee: (value: AssigneeFilter) => void
  onTag: (value: number | null) => void
}) {
  const { t } = useTranslation()
  const active = activeFilters(assignee, tagId)
  if (active.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {active.map((filter) => {
        const label = filter.kind === 'tag'
          ? tags.find((tag) => tag.id === filter.value)?.name ?? t('whatsapp.tags.filter')
          : t(filter.value === 'me' ? 'whatsapp.assign.filterMine' : 'whatsapp.assign.filterUnassigned')
        return (
          <button
            key={filter.kind}
            type="button"
            className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-full border border-primary bg-primary/10 px-2.5 text-xs font-medium text-primary"
            title={t('whatsapp.inbox.clearFilter')}
            aria-label={`${t('whatsapp.inbox.clearFilter')}: ${label}`}
            onClick={() => (filter.kind === 'tag' ? onTag(null) : onAssignee('all'))}
          >
            <span className="truncate">{label}</span>
            <Icon name="x" size={12} className="shrink-0" />
          </button>
        )
      })}
    </div>
  )
}
