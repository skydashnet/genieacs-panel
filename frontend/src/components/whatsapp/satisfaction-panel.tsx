'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type SatisfactionReport } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

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
 * O relatório da pesquisa de satisfação: a nota que os clientes deram ao
 * atendimento humano, por atendente, e o que disseram quem deu nota baixa.
 */
export function SatisfactionPanel() {
  const { t, intlLocale, formatDateTime } = useTranslation()
  const [days, setDays] = useState<Period>(30)
  const [report, setReport] = useState<SatisfactionReport | null>(null)
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
    const res = await whatsappAPI.getSatisfactionReport(periodo)
    if (!alive.current) return
    if (res.success && res.data) setReport(res.data)
    else setError(whatsappErrorMessage(t, res.code))
  }, [t])

  useEffect(() => {
    void load(days)
  }, [days, load])

  const pct = (v: number | null) => (v === null ? '—' : new Intl.NumberFormat(intlLocale, { style: 'percent' }).format(v))
  const nota = (v: number | null) => (v === null ? '—' : new Intl.NumberFormat(intlLocale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v))
  const vazio = report !== null && report.asked === 0
  const maior = report ? Math.max(...report.distribution, 1) : 1

  return (
    <section className="grid gap-5">
      <div className="modern-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-heading">{t('whatsapp.satisfaction.title')}</h2>
            <p className="field-hint mt-1">{t('whatsapp.satisfaction.description')}</p>
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
        {vazio && <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.satisfaction.empty')}</p>}
      </div>

      {report && !vazio && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
            <Tile label={t('whatsapp.satisfaction.average')} value={report.average === null ? '—' : `${nota(report.average)} / 5`} />
            <Tile label={t('whatsapp.satisfaction.satisfied')} value={pct(report.satisfiedRate)} hint={t('whatsapp.satisfaction.satisfiedHint')} />
            <Tile
              label={t('whatsapp.satisfaction.answered')}
              value={`${report.answered} / ${report.asked}`}
              hint={t('whatsapp.satisfaction.responseRate', { rate: pct(report.responseRate) })}
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <div className="modern-card p-5 sm:p-6">
              <h3 className="section-heading">{t('whatsapp.satisfaction.distribution')}</h3>
              <div className="mt-4 grid gap-2">
                {[5, 4, 3, 2, 1].map((n) => {
                  const valor = report.distribution[n - 1]
                  return (
                    <div key={n} className="flex items-center gap-3 text-sm">
                      <span className="w-6 shrink-0 tabular-nums text-muted-foreground">{n}</span>
                      <div className="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-[hsl(var(--surface-subtle))]">
                        <div
                          className={`h-full rounded-full ${n >= 4 ? 'bg-primary' : n === 3 ? 'bg-[hsl(var(--status-warning))]' : 'bg-[hsl(var(--status-danger))]'}`}
                          style={{ width: `${(valor / maior) * 100}%` }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right tabular-nums">{valor}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="modern-card p-5 sm:p-6">
              <h3 className="section-heading">{t('whatsapp.satisfaction.byAgent')}</h3>
              <table className="mt-3 w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 font-medium">{t('whatsapp.satisfaction.agent')}</th>
                    <th className="py-1 pl-3 text-right font-medium">{t('whatsapp.satisfaction.answeredShort')}</th>
                    <th className="py-1 pl-3 text-right font-medium">{t('whatsapp.satisfaction.averageShort')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byAgent.map((a) => (
                    <tr key={a.userId ?? 'none'} className="border-t border-border">
                      <td className="py-1.5">{a.name ?? t('whatsapp.satisfaction.unknownAgent')}</td>
                      <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">{a.answered} / {a.asked}</td>
                      <td className="py-1.5 pl-3 text-right tabular-nums font-medium">{nota(a.average)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="modern-card p-5 sm:p-6">
            <h3 className="section-heading">{t('whatsapp.satisfaction.lowScores')}</h3>
            <p className="field-hint mt-1">{t('whatsapp.satisfaction.lowScoresHint')}</p>
            {report.lowScores.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.satisfaction.noLowScores')}</p>
            ) : (
              <ul className="mt-3 grid gap-3">
                {report.lowScores.map((item) => (
                  <li key={`${item.conversationId}-${item.answeredAt}`} className="rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="rounded bg-[hsl(var(--status-danger)/0.12)] px-1.5 py-0.5 text-xs font-semibold text-[hsl(var(--status-danger))]">
                        {t('whatsapp.satisfaction.score', { score: item.score })}
                      </span>
                      <span className="font-medium">{item.contact ?? '—'}</span>
                      {item.contract && <span className="text-muted-foreground">{t('whatsapp.satisfaction.contract', { contract: item.contract })}</span>}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {[item.agent, item.answeredAt ? formatDateTime(item.answeredAt) : null].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <p className={`mt-2 whitespace-pre-wrap wrap-anywhere ${item.comment ? '' : 'text-muted-foreground'}`}>
                      {item.comment ?? t('whatsapp.satisfaction.noComment')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}

export default SatisfactionPanel
