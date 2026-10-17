'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type TagsReport } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { TagChip } from '@/components/whatsapp/tags'
import { tagClass } from '@/lib/wa-tags'

const PERIODS = [7, 30, 90] as const
type Period = (typeof PERIODS)[number]

/** Quantas conversas cada etiqueta marcou no período, e quantas seguem abertas. */
export function TagsReportPanel() {
  const { t, intlLocale } = useTranslation()
  const [days, setDays] = useState<Period>(30)
  const [report, setReport] = useState<TagsReport | null>(null)
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async (periodo: Period) => {
    setError('')
    const res = await whatsappAPI.tagsReport(periodo)
    if (!alive.current) return
    if (res.success && res.data) setReport(res.data)
    else setError(whatsappErrorMessage(t, res.code))
  }, [t])

  useEffect(() => { void load(days) }, [days, load])

  const numero = (n: number) => new Intl.NumberFormat(intlLocale).format(n)
  const linhas = [...(report?.tags ?? [])].sort((a, b) => b.taggedInPeriod - a.taggedInPeriod || a.name.localeCompare(b.name))
  const maior = Math.max(1, ...linhas.map((l) => l.taggedInPeriod))
  const vazio = report !== null && linhas.every((l) => l.taggedInPeriod === 0 && l.openNow === 0)

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="section-heading">{t('whatsapp.tags.reportTitle')}</h2>
          <p className="field-hint mt-1">{t('whatsapp.tags.reportHint')}</p>
        </div>
        <div className="tab-rail" role="radiogroup" aria-label={t('whatsapp.botReport.period')}>
          {PERIODS.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={days === p} data-active={days === p} className="tab-button" onClick={() => setDays(p)}>
              {t('whatsapp.botReport.lastDays', { count: p })}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-[hsl(var(--status-danger))]">{error}</p>}
      {report === null && !error && <p className="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>}
      {vazio && <p className="mt-3 text-sm text-muted-foreground">{t('whatsapp.tags.reportEmpty')}</p>}
      {report && !vazio && (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 font-medium">{t('whatsapp.tags.name')}</th>
              <th className="w-1/2 py-1 font-medium">{t('whatsapp.tags.taggedInPeriod')}</th>
              <th className="py-1 text-right font-medium">{t('whatsapp.tags.openNow')}</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((linha) => (
              <tr key={linha.id} className="border-t border-border">
                <td className="py-2 pr-3"><TagChip tag={linha} /></td>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[hsl(var(--surface-subtle))]">
                      <div className={`${tagClass(linha.color)} h-full rounded-full bg-[hsl(var(--wa-account))]`} style={{ width: `${(linha.taggedInPeriod / maior) * 100}%` }} />
                    </div>
                    <span className="w-8 shrink-0 text-right tabular-nums">{numero(linha.taggedInPeriod)}</span>
                  </div>
                </td>
                <td className="py-2 text-right tabular-nums font-medium">{numero(linha.openNow)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default TagsReportPanel
