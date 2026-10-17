import { useMemo, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { allBoxOccupancy, occupancyCsv, type BoxRow, type OccupancyEdge, type OccupancyLevel, type OccupancyNode } from '@/lib/box-occupancy'

/**
 * Todas as caixas da rede por ocupação — lotadas, quase lotadas, com portas
 * livres —, para planejar expansão. Clicar abre a caixa; a planilha leva a
 * mesma lista, já filtrada.
 */
const LEVEL_COLORS: Record<OccupancyLevel, string> = {
  over: '#ef4444',
  full: '#ef4444',
  almost: '#f59e0b',
  free: '#22c55e',
  unknown: '#94a3b8'
}
const FILTERS = ['all', 'over', 'full', 'almost', 'free', 'unknown', 'weak'] as const
const WEAK_COLOR = '#f59e0b'
const NO_WEAK: Set<string> = new Set()
type Filter = typeof FILTERS[number]

export function BoxOccupancyView<T extends OccupancyNode>({
  nodes, edges, outageIds, weakIds = NO_WEAK, onSelect, onBulkLink, fileName
}: {
  nodes: T[]
  edges: OccupancyEdge[]
  /** Caixas com provável rompimento agora — marcadas na lista. */
  outageIds: Set<string>
  /** Caixas com vários clientes de sinal fraco agora (`weakBoxes`). */
  weakIds?: Set<string>
  onSelect: (node: T) => void
  /** "Ligar clientes às caixas" — só para quem edita o mapa. */
  onBulkLink?: () => void
  fileName: string
}) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const rows = useMemo(() => allBoxOccupancy(nodes, edges), [edges, nodes])
  const counts = useMemo(() => {
    const result: Record<Filter, number> = { all: rows.length, over: 0, full: 0, almost: 0, free: 0, unknown: 0, weak: 0 }
    for (const row of rows) {
      result[row.level] += 1
      if (weakIds.has(row.box.node_id)) result.weak += 1
    }
    return result
  }, [rows, weakIds])
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return rows.filter((row) => (filter === 'all' || (filter === 'weak' ? weakIds.has(row.box.node_id) : row.level === filter))
      && (!term || row.box.name.toLowerCase().includes(term) || row.box.node_id.toLowerCase().includes(term)))
  }, [filter, query, rows, weakIds])
  const totals = useMemo(() => rows.reduce((sum, row) => ({
    used: sum.used + row.used,
    capacity: sum.capacity + (row.capacity ?? 0),
    free: sum.free + (row.free ?? 0)
  }), { used: 0, capacity: 0, free: 0 }), [rows])

  const levelLabel = (level: OccupancyLevel) => t(`map.boxes.level.${level}`)
  const download = () => {
    const csv = occupancyCsv(visible as BoxRow[], [
      t('map.table.id'), t('map.table.name'), t('map.table.type'), t('map.boxes.used'), t('map.node.capacity'),
      t('map.boxes.free'), t('map.boxes.percent'), t('map.boxes.situation'), 'latitude', 'longitude'
    ], levelLabel)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="modern-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="section-heading">{t('map.boxes.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('map.boxes.summary', { boxes: rows.length, used: totals.used, capacity: totals.capacity, free: totals.free })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="search" className="modern-input min-h-10 w-full text-sm sm:min-h-9 sm:w-48" placeholder={t('map.boxes.search')} aria-label={t('map.boxes.search')}
            value={query} onChange={(event) => setQuery(event.target.value)} />
          {onBulkLink && (
            <button type="button" className="modern-button min-h-10 sm:min-h-9" onClick={onBulkLink} title={t('map.link.hint')}>
              <Icon name="signal" size={16} />{t('map.link.button')}
            </button>
          )}
          <button type="button" className="modern-button-secondary min-h-10 sm:min-h-9" disabled={!visible.length} onClick={download}>
            <Icon name="document" size={16} />{t('map.boxes.export')}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-b border-border px-5 py-3">
        {FILTERS.map((value) => (
          <button key={value} type="button" onClick={() => setFilter(value)}
            className={`modern-badge min-h-9 sm:min-h-0 ${filter === value ? 'ring-2 ring-primary' : ''}`}>
            {value === 'weak' && <span style={{ color: WEAK_COLOR }}><Icon name="signal" size={13} /></span>}
            {value !== 'all' && value !== 'weak' && <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: LEVEL_COLORS[value] }} />}
            {value === 'all' ? t('map.boxes.all') : value === 'weak' ? t('map.weak.filter') : levelLabel(value)} {counts[value]}
          </button>
        ))}
      </div>
      {/* No celular, cartões: seis colunas não cabem e a ação ficava fora da tela. */}
      <ul className="mobile-card-list divide-y divide-border">
        {visible.map((row) => (
          <li key={row.box.node_id}>
            <button type="button" className="block w-full px-4 py-3 text-start hover:bg-[hsl(var(--surface-subtle))]" onClick={() => onSelect(row.box)}>
              <span className="block wrap-break-word font-semibold">{row.box.name}</span>
              <span className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">{row.box.node_id} · {row.box.type.toUpperCase()}</span>
              <span className="mt-2 flex items-center gap-3 text-sm">
                <span className="shrink-0">{row.capacity === null ? row.used : `${row.used}/${row.capacity}`}</span>
                {row.percent !== null && (
                  <span className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                    <span className="block h-full rounded" style={{ width: `${Math.min(100, row.percent)}%`, background: LEVEL_COLORS[row.level] }} />
                  </span>
                )}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: LEVEL_COLORS[row.level] }} />
                  {levelLabel(row.level)}
                </span>
                {outageIds.has(row.box.node_id) && (
                  <span className="inline-flex items-center gap-1 font-semibold" style={{ color: LEVEL_COLORS.over }}>
                    <Icon name="warning" size={13} />{t('map.boxes.outageNow')}
                  </span>
                )}
                {weakIds.has(row.box.node_id) && (
                  <span className="inline-flex items-center gap-1 font-semibold" style={{ color: WEAK_COLOR }}>
                    <Icon name="signal" size={13} />{t('map.weak.filter')}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
        {!visible.length && <li className="py-10 text-center text-muted-foreground">{t('map.boxes.empty')}</li>}
      </ul>
      <div className="desktop-table overflow-x-auto">
        <table className="modern-table">
          <thead>
            <tr>
              <th>{t('map.table.name')}</th><th>{t('map.table.type')}</th><th>{t('map.boxes.usage')}</th>
              <th>{t('map.boxes.free')}</th><th>{t('map.boxes.situation')}</th><th>{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.box.node_id}>
                <td>
                  <span className="font-semibold">{row.box.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{row.box.node_id}</span>
                </td>
                <td>{row.box.type.toUpperCase()}</td>
                <td className="min-w-40">
                  <span className="text-sm">{row.capacity === null ? row.used : `${row.used}/${row.capacity}`}</span>
                  {row.percent !== null && (
                    <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
                      <div className="h-full rounded" style={{ width: `${Math.min(100, row.percent)}%`, background: LEVEL_COLORS[row.level] }} />
                    </div>
                  )}
                </td>
                <td>{row.free ?? '—'}</td>
                <td>
                  <span className="inline-flex items-center gap-1.5 text-sm">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: LEVEL_COLORS[row.level] }} />
                    {levelLabel(row.level)}
                  </span>
                  {outageIds.has(row.box.node_id) && (
                    <span className="mt-1 flex items-center gap-1 text-xs font-semibold" style={{ color: LEVEL_COLORS.over }}>
                      <Icon name="warning" size={13} />{t('map.boxes.outageNow')}
                    </span>
                  )}
                  {weakIds.has(row.box.node_id) && (
                    <span className="mt-1 flex items-center gap-1 text-xs font-semibold" style={{ color: WEAK_COLOR }}>
                      <Icon name="signal" size={13} />{t('map.weak.filter')}
                    </span>
                  )}
                </td>
                <td><button type="button" className="min-h-11 font-semibold text-primary hover:underline" onClick={() => onSelect(row.box)}>{t('common.details')}</button></td>
              </tr>
            ))}
            {!visible.length && <tr><td colSpan={6} className="py-10 text-center text-muted-foreground">{t('map.boxes.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
