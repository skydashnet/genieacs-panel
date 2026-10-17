'use client'

import { useEffect, useState } from 'react'
import {
  CANCELLATION_REASONS,
  platformReportsAPI,
  type CancellationReport,
  type CancellationRequestView
} from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { displayDate } from '@/lib/date-format'
import { CANCELLATION_REASON_KEYS } from '@/components/cancel-subscription'

/**
 * Os cancelamentos, na aba Receita do console (0107): quantos provedores
 * pediram para sair, por quê, quantas ofertas de retenção foram aceitas, a
 * taxa de retenção e os pedidos recentes — desde o início do período da aba.
 *
 * Retido é quem ficou: aceitou o desconto, a pausa, ou desfez o cancelamento
 * agendado. A taxa é retidos ÷ decididos; o pedido ainda sem decisão não entra.
 */
type Desfecho = keyof CancellationReport['byOutcome']

export const CANCELLATION_OUTCOME_KEYS: Record<Desfecho, TranslationKey> = {
  retained_discount: 'platform.cancellations.outcome.retained_discount',
  retained_pause: 'platform.cancellations.outcome.retained_pause',
  canceled: 'platform.cancellations.outcome.canceled',
  reverted: 'platform.cancellations.outcome.reverted',
  pending: 'platform.cancellations.outcome.pending'
}

/** A taxa de retenção como porcentagem inteira, ou travessão sem nenhum decidido. */
export function retentionRateLabel(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

function desfechoDe(pedido: Pick<CancellationRequestView, 'outcome'>): Desfecho {
  return pedido.outcome ?? 'pending'
}

export function PlatformCancellations({ from }: { from?: string }) {
  const { t } = useTranslation()
  const [report, setReport] = useState<CancellationReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    void platformReportsAPI.cancellations(from).then((res) => {
      if (!vivo) return
      if (res.success && res.data) {
        setReport(res.data)
        setError(null)
      } else {
        setError(res.message || t('platform.cancellations.loadFailed'))
      }
    })
    return () => { vivo = false }
  }, [from, t])

  return (
    <section className="space-y-3" aria-labelledby="cancellations-title">
      <div>
        <h2 id="cancellations-title" className="section-heading">{t('platform.cancellations.title')}</h2>
        <p className="section-description">{t('platform.cancellations.description')}</p>
      </div>

      {error !== null && <p className="modern-card py-6 text-center text-sm text-destructive" role="alert">{error}</p>}
      {!report && error === null && (
        <p className="modern-card py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Numero label={t('platform.cancellations.total')} value={String(report.total)} />
            <Numero label={t('platform.cancellations.retentionRate')} value={retentionRateLabel(report.retentionRate)}
              hint={t('platform.cancellations.retainedOf', { retained: report.retained, decided: report.decided })} />
            <Numero label={t('platform.cancellations.offerDiscount')} value={String(report.offers.discount.accepted)}
              hint={t('platform.cancellations.offerAccepted', {
                accepted: report.offers.discount.accepted, presented: report.offers.discount.presented
              })} />
            <Numero label={t('platform.cancellations.offerPause')} value={String(report.offers.pause.accepted)}
              hint={t('platform.cancellations.offerAccepted', {
                accepted: report.offers.pause.accepted, presented: report.offers.pause.presented
              })} />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="modern-card p-4">
              <h3 className="mb-2 text-sm font-semibold text-foreground">{t('platform.cancellations.byReason')}</h3>
              <ul className="space-y-1 text-sm">
                {CANCELLATION_REASONS.map((motivo) => (
                  <li key={motivo} className="flex justify-between gap-3">
                    <span className="min-w-0 wrap-break-word text-muted-foreground">{t(CANCELLATION_REASON_KEYS[motivo])}</span>
                    <span className="font-mono tabular-nums">{report.byReason[motivo] ?? 0}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="modern-card p-4">
              <h3 className="mb-2 text-sm font-semibold text-foreground">{t('platform.cancellations.byOutcome')}</h3>
              <ul className="space-y-1 text-sm">
                {(Object.keys(CANCELLATION_OUTCOME_KEYS) as Desfecho[]).map((desfecho) => (
                  <li key={desfecho} className="flex justify-between gap-3">
                    <span className="min-w-0 wrap-break-word text-muted-foreground">{t(CANCELLATION_OUTCOME_KEYS[desfecho])}</span>
                    <span className="font-mono tabular-nums">{report.byOutcome[desfecho] ?? 0}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* No celular, cartões: com quatro colunas o motivo virava uma
              palavra por linha e o desfecho ficava fora da tela. */}
          <ul className="mobile-card-list modern-card divide-y divide-border" aria-label={t('platform.cancellations.list')}>
            {report.requests.length === 0 ? (
              <li className="py-6 text-center text-sm text-muted-foreground">{t('platform.cancellations.empty')}</li>
            ) : report.requests.map((pedido) => (
              <li key={pedido.id} className="p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 wrap-break-word font-semibold text-foreground">
                    {pedido.tenant.name ?? pedido.tenant.slug ?? `#${pedido.tenant.id}`}
                  </span>
                  <span className="text-xs whitespace-nowrap text-muted-foreground">{displayDate(pedido.createdAt) ?? '—'}</span>
                </div>
                <p className="mt-1 wrap-break-word">{t(CANCELLATION_REASON_KEYS[pedido.reason] ?? 'plan.cancel.reason.other')}</p>
                {pedido.comment && <p className="mt-0.5 text-xs wrap-break-word text-muted-foreground">{pedido.comment}</p>}
                <p className="mt-1 font-medium">
                  {t(CANCELLATION_OUTCOME_KEYS[desfechoDe(pedido)])}
                  {pedido.cancelAt && pedido.outcome === 'canceled' && (
                    <span className="ms-2 text-xs font-normal text-muted-foreground">
                      {t('platform.subs.cancelsOn', { date: displayDate(pedido.cancelAt) ?? '—' })}
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
          <div className="desktop-table modern-card overflow-x-auto">
            <table className="modern-table">
              <caption className="sr-only">{t('platform.cancellations.list')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('platform.cancellations.date')}</th>
                  <th scope="col">{t('platform.cancellations.provider')}</th>
                  <th scope="col">{t('platform.cancellations.reason')}</th>
                  <th scope="col">{t('platform.cancellations.outcomeColumn')}</th>
                </tr>
              </thead>
              <tbody>
                {report.requests.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-sm text-muted-foreground">{t('platform.cancellations.empty')}</td>
                  </tr>
                ) : report.requests.map((pedido) => (
                  <tr key={pedido.id}>
                    <td className="whitespace-nowrap">{displayDate(pedido.createdAt) ?? '—'}</td>
                    <td className="min-w-0 wrap-break-word">{pedido.tenant.name ?? pedido.tenant.slug ?? `#${pedido.tenant.id}`}</td>
                    <td className="min-w-0 wrap-break-word">
                      {t(CANCELLATION_REASON_KEYS[pedido.reason] ?? 'plan.cancel.reason.other')}
                      {pedido.comment && <span className="block text-xs text-muted-foreground">{pedido.comment}</span>}
                    </td>
                    <td>
                      {t(CANCELLATION_OUTCOME_KEYS[desfechoDe(pedido)])}
                      {pedido.cancelAt && pedido.outcome === 'canceled' && (
                        <span className="block text-xs text-muted-foreground">
                          {t('platform.subs.cancelsOn', { date: displayDate(pedido.cancelAt) ?? '—' })}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function Numero({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="modern-card p-3">
      <p className="metric-label">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}

export default PlatformCancellations
