import { useCallback, useEffect, useMemo, useState } from 'react'
import { devicesAPI, type DeviceHistory } from '@/lib/api'
import { SeriesChart } from '@/components/charts/series-chart'
import { useTranslation } from '@/contexts/language-context'

type Range = '24h' | '7d' | '30d' | '90d'
type Metric = 'rx' | 'tc' | 'up'

const RANGE_MS: Record<Range, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
  '90d': 90 * 24 * 3600_000
}

/** The RX power the alerter fires at, and the dashboard already paints red. */
const RX_THRESHOLD = -27

export function DeviceHistoryCard({ deviceId }: { deviceId: string }) {
  const { t, formatDateTime } = useTranslation()
  const [range, setRange] = useState<Range>('24h')
  const [metric, setMetric] = useState<Metric>('rx')
  const [history, setHistory] = useState<DeviceHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!deviceId) return
    setLoading(true)
    setFailed(false)
    try {
      const to = new Date()
      const from = new Date(to.getTime() - RANGE_MS[range])
      const res = await devicesAPI.getHistory(deviceId, {
        from: from.toISOString(),
        to: to.toISOString()
      })
      if (res.success && res.data) setHistory(res.data)
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [deviceId, range])

  useEffect(() => {
    void load()
  }, [load])

  const points = useMemo(
    () => (history?.points ?? []).map((point) => ({ t: point.t, value: point[metric] ?? null })),
    [history, metric]
  )

  const formatValue = useCallback((value: number) => {
    if (metric === 'rx') return `${value.toFixed(1)} dBm`
    if (metric === 'tc') return `${value.toFixed(0)} °C`
    // Uptime is stored in seconds; hours is the unit a reboot is legible in.
    return `${(value / 3600).toFixed(0)} h`
  }, [metric])

  const formatTime = useCallback(
    (epochSeconds: number) => formatDateTime(new Date(epochSeconds * 1000).toISOString()),
    [formatDateTime]
  )

  return (
    <div className="modern-card p-5 sm:p-6 lg:col-span-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="page-kicker">{t('detail.history.kicker')}</p>
          <h2 className="section-heading">{t('detail.history.title')}</h2>
          <p className="section-description">{t('detail.history.description')}</p>
        </div>
        <div className="grid grid-cols-1 gap-2 min-[26.25rem]:grid-cols-2 sm:flex sm:flex-wrap">
          <select
            className="modern-input"
            value={metric}
            aria-label={t('detail.history.metricLabel')}
            onChange={(event) => setMetric(event.target.value as Metric)}
          >
            <option value="rx">{t('detail.history.metricRx')}</option>
            <option value="tc">{t('detail.history.metricTemperature')}</option>
            <option value="up">{t('detail.history.metricUptime')}</option>
          </select>
          <select
            className="modern-input"
            value={range}
            aria-label={t('detail.history.rangeLabel')}
            onChange={(event) => setRange(event.target.value as Range)}
          >
            <option value="24h">{t('detail.history.range24h')}</option>
            <option value="7d">{t('detail.history.range7d')}</option>
            <option value="30d">{t('detail.history.range30d')}</option>
            <option value="90d">{t('detail.history.range90d')}</option>
          </select>
        </div>
      </div>

      <div className="mt-4">
        {failed ? (
          <p className="text-sm text-muted-foreground">{t('detail.history.loadFailed')}</p>
        ) : (
          <SeriesChart
            points={points}
            formatValue={formatValue}
            formatTime={formatTime}
            threshold={metric === 'rx' ? RX_THRESHOLD : null}
            thresholdLabel={t('detail.history.threshold')}
            emptyLabel={loading ? t('common.loading') : t('detail.history.empty')}
            ariaLabel={t('detail.history.title')}
          />
        )}
      </div>

      {history && history.points.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t(history.resolution === 'raw'
            ? 'detail.history.resolutionRaw'
            : 'detail.history.resolutionHourly')}
        </p>
      )}
    </div>
  )
}

export default DeviceHistoryCard
