import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { mappingAPI, type OutageHistory } from '@/lib/api'

/**
 * Histórico de rompimentos: as caixas que mais caem no período (para
 * priorizar manutenção) e cada ocorrência, com início, fim e duração.
 */
const PERIODS = [30, 90, 365] as const

export function formatDuration(minutes: number | null, t: (key: 'map.history.minutes' | 'map.history.hours' | 'map.history.days', vars: Record<string, number>) => string): string {
  if (minutes === null) return '—'
  if (minutes < 60) return t('map.history.minutes', { count: minutes })
  if (minutes < 48 * 60) return t('map.history.hours', { count: Math.round(minutes / 6) / 10 })
  return t('map.history.days', { count: Math.round(minutes / 144) / 10 })
}

export function OutageHistoryView({ onSelectBox }: { onSelectBox: (nodeId: string) => void }) {
  const { t, formatDateTime } = useTranslation()
  const [days, setDays] = useState<number>(90)
  const [data, setData] = useState<OutageHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await mappingAPI.outageHistory(days)
      if (response.success && response.data) { setData(response.data); setError(null) }
      else setError(response.message || t('map.history.failed'))
    } catch {
      setError(t('map.history.failed'))
    } finally {
      setLoading(false)
    }
  }, [days, t])
  useEffect(() => { void load() }, [load])

  const when = (value: string) => formatDateTime(value, { dateStyle: 'short', timeStyle: 'short' })
  const duration = (minutes: number | null) => formatDuration(minutes, t)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('map.history.hint')}</p>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-muted p-1">
            {PERIODS.map((value) => (
              <button key={value} type="button" onClick={() => setDays(value)}
                className={`min-h-10 rounded px-3 text-xs font-semibold sm:min-h-9 ${days === value ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground'}`}>
                {t('map.history.period', { days: value })}
              </button>
            ))}
          </div>
          <button type="button" className="modern-button-secondary min-h-10 sm:min-h-9" disabled={loading} onClick={() => void load()} aria-label={t('common.refresh')}>
            <Icon name="refresh" size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      <div className="modern-card overflow-hidden">
        <div className="border-b border-border px-5 py-4"><h2 className="section-heading">{t('map.history.ranking')}</h2></div>
        {/* No celular, cartões: cinco colunas espremiam o nome da caixa em uma
            palavra por linha e jogavam a ação para fora da tela. */}
        <ul className="mobile-card-list divide-y divide-border">
          {(data?.byNode ?? []).map((entry) => (
            <li key={entry.node_id} className="px-4 py-3">
              <p className="wrap-break-word font-semibold">{entry.node_name || entry.node_id}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('map.history.times')}: {entry.count} · {t('map.history.totalDown')}: {duration(entry.minutes)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('map.history.last')}: {when(entry.last_at)}
              </p>
              <button type="button" className="min-h-10 text-sm font-semibold text-primary hover:underline" onClick={() => onSelectBox(entry.node_id)}>{t('map.outage.show')}</button>
            </li>
          ))}
          {data && !data.byNode.length && <li className="py-10 text-center text-muted-foreground">{t('map.history.empty')}</li>}
        </ul>
        <div className="desktop-table overflow-x-auto">
          <table className="modern-table">
            <thead><tr><th>{t('map.table.name')}</th><th>{t('map.history.times')}</th><th>{t('map.history.totalDown')}</th><th>{t('map.history.last')}</th><th>{t('common.actions')}</th></tr></thead>
            <tbody>
              {(data?.byNode ?? []).map((entry) => (
                <tr key={entry.node_id}>
                  <td><span className="font-semibold">{entry.node_name || entry.node_id}</span></td>
                  <td>{entry.count}</td>
                  <td>{duration(entry.minutes)}</td>
                  <td>{when(entry.last_at)}</td>
                  <td><button type="button" className="min-h-11 font-semibold text-primary hover:underline" onClick={() => onSelectBox(entry.node_id)}>{t('map.outage.show')}</button></td>
                </tr>
              ))}
              {data && !data.byNode.length && <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">{t('map.history.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="modern-card overflow-hidden">
        <div className="border-b border-border px-5 py-4"><h2 className="section-heading">{t('map.history.events')}</h2></div>
        <ul className="mobile-card-list divide-y divide-border">
          {(data?.events ?? []).map((event) => (
            <li key={event.id} className="px-4 py-3 text-sm">
              <p className="wrap-break-word font-semibold">{event.node_name || event.node_id}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {when(event.started_at)} → {event.ended_at ? when(event.ended_at) : (
                  <span className="font-semibold text-[hsl(var(--status-danger))]">{t('map.history.ongoing')}</span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('map.history.duration')}: {duration(event.minutes)} · {t('map.history.peak')}: {t('map.history.peakValue', { count: event.peak_count, total: event.total_clients })}
              </p>
            </li>
          ))}
          {data && !data.events.length && <li className="py-10 text-center text-muted-foreground">{t('map.history.empty')}</li>}
        </ul>
        <div className="desktop-table overflow-x-auto">
          <table className="modern-table">
            <thead><tr><th>{t('map.table.name')}</th><th>{t('map.history.start')}</th><th>{t('map.history.end')}</th><th>{t('map.history.duration')}</th><th>{t('map.history.peak')}</th></tr></thead>
            <tbody>
              {(data?.events ?? []).map((event) => (
                <tr key={event.id}>
                  <td><span className="font-semibold">{event.node_name || event.node_id}</span></td>
                  <td>{when(event.started_at)}</td>
                  <td>
                    {event.ended_at ? when(event.ended_at) : (
                      <span className="inline-flex items-center gap-1 font-semibold text-[hsl(var(--status-danger))]"><Icon name="warning" size={14} />{t('map.history.ongoing')}</span>
                    )}
                  </td>
                  <td>{duration(event.minutes)}</td>
                  <td>{t('map.history.peakValue', { count: event.peak_count, total: event.total_clients })}</td>
                </tr>
              ))}
              {data && !data.events.length && <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">{t('map.history.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
