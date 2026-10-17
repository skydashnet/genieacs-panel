'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type ResponseTimeReport } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { ColumnChart } from '@/components/whatsapp/bot-report-panel'
import { formatDuration, type DurationLabels } from '@/lib/duration'

const PERIODS = [7, 30, 90] as const
type Period = (typeof PERIODS)[number]

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="modern-card min-w-0 p-4 sm:p-5">
      <p className="metric-label">{label}</p>
      <p className="metric-value mt-3 wrap-break-word text-xl text-foreground sm:truncate sm:text-3xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * Quanto o cliente espera por uma pessoa: a mediana, quanto sai em até 15
 * min, por hora do dia e por atendente, e quem está esperando agora.
 */
export function ResponseTimePanel() {
  const { t, intlLocale, formatDateTime } = useTranslation()
  const [days, setDays] = useState<Period>(7)
  const [report, setReport] = useState<ResponseTimeReport | null>(null)
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async (periodo: Period) => {
    setError('')
    const res = await whatsappAPI.getResponseTimeReport(periodo)
    if (!alive.current) return
    if (res.success && res.data) setReport(res.data)
    else setError(whatsappErrorMessage(t, res.code))
  }, [t])

  useEffect(() => {
    void load(days)
  }, [days, load])

  const labels: DurationLabels = {
    seconds: (n) => t('whatsapp.responseTime.seconds', { n }),
    minutes: (n) => t('whatsapp.responseTime.minutes', { n }),
    hours: (h, m) => t('whatsapp.responseTime.hours', { h, m }),
    days: (d, h) => t('whatsapp.responseTime.days', { d, h })
  }
  const dur = (s: number | null) => formatDuration(s, labels)
  const pct = (v: number | null) => (v === null ? '—' : new Intl.NumberFormat(intlLocale, { style: 'percent' }).format(v))
  const vazio = report !== null && report.answered === 0 && report.outsideHours.answered === 0 && report.waitingNow.count === 0
  const em15 = report?.within.find((w) => w.seconds === 15 * 60)?.rate ?? null

  return (
    <section className="grid gap-5">
      <div className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-heading">{t('whatsapp.responseTime.title')}</h2>
            <p className="field-hint mt-1">
              {t('whatsapp.responseTime.description')}
              {report?.hoursEnabled && ` ${t('whatsapp.responseTime.hoursNote')}`}
            </p>
          </div>
          <div className="tab-rail" role="radiogroup" aria-label={t('whatsapp.botReport.period')}>
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={days === p}
                data-active={days === p}
                className="tab-button"
                onClick={() => setDays(p)}
              >
                {t('whatsapp.botReport.lastDays', { count: p })}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-[hsl(var(--status-danger))]">{error}</p>}
        {report === null && !error && <p className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>}
        {vazio && <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.responseTime.empty')}</p>}
      </div>

      {report && !vazio && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <Tile
              label={t('whatsapp.responseTime.median')}
              value={dur(report.medianSeconds)}
              hint={t('whatsapp.responseTime.p90', { value: dur(report.p90Seconds) })}
            />
            <Tile label={t('whatsapp.responseTime.within15')} value={pct(em15)} />
            <Tile label={t('whatsapp.responseTime.answered')} value={new Intl.NumberFormat(intlLocale).format(report.answered)} />
            <Tile
              label={t('whatsapp.responseTime.waitingNow')}
              value={new Intl.NumberFormat(intlLocale).format(report.waitingNow.count)}
              hint={report.waitingNow.oldestSince
                ? t('whatsapp.responseTime.oldestSince', { when: formatDateTime(report.waitingNow.oldestSince) })
                : undefined}
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <div className="modern-card p-5 sm:p-6">
              <h3 className="section-heading">{t('whatsapp.responseTime.byHourTitle')}</h3>
              <p className="field-hint mt-1">{t('whatsapp.responseTime.byHourHint', { timezone: report.timezone })}</p>
              <div className="mt-4">
                <ColumnChart
                  columns={report.byHour.map((h, i) => ({
                    label: `${String(i).padStart(2, '0')}h`,
                    value: h.medianSeconds === null ? 0 : Math.max(1, Math.round(h.medianSeconds / 60))
                  }))}
                  ticks={new Set([0, 6, 12, 18, 23])}
                  ariaLabel={t('whatsapp.responseTime.byHourTitle')}
                  valueLabel={(v) => dur(v * 60)}
                  tableHeader={t('whatsapp.botReport.tableHour')}
                />
              </div>
            </div>

            <div className="modern-card p-5 sm:p-6">
              <h3 className="section-heading">{t('whatsapp.responseTime.byAgent')}</h3>
              <table className="mt-3 w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 font-medium">{t('whatsapp.satisfaction.agent')}</th>
                    <th className="py-1 pl-3 text-right font-medium">{t('whatsapp.responseTime.answeredShort')}</th>
                    <th className="py-1 pl-3 text-right font-medium">{t('whatsapp.responseTime.medianShort')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byAgent.map((a) => (
                    <tr key={a.userId ?? 'phone'} className="border-t border-border">
                      <td className="py-1.5">{a.name ?? t('whatsapp.responseTime.fromPhone')}</td>
                      <td className="py-1.5 pl-3 text-right tabular-nums">{a.answered}</td>
                      <td className="py-1.5 pl-3 text-right tabular-nums font-medium">{dur(a.medianSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="mt-4 grid gap-1 text-sm">
                {report.within.map((w) => (
                  <div key={w.seconds} className="flex justify-between gap-3 border-b border-border py-1">
                    <dt className="text-muted-foreground">{t('whatsapp.responseTime.withinLabel', { value: dur(w.seconds) })}</dt>
                    <dd className="tabular-nums font-medium">{pct(w.rate)}</dd>
                  </div>
                ))}
                {report.hoursEnabled && (
                  <div className="flex justify-between gap-3 py-1">
                    <dt className="text-muted-foreground">{t('whatsapp.responseTime.outsideHours', { count: report.outsideHours.answered })}</dt>
                    <dd className="tabular-nums font-medium">{dur(report.outsideHours.medianSeconds)}</dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

export default ResponseTimePanel
