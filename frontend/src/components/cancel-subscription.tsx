'use client'

import { useEffect, useState } from 'react'
import {
  CANCELLATION_REASONS,
  subscriptionAPI,
  type CancellationOffers,
  type CancellationReason,
  type CancellationStatus,
  type SubscriptionView
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { displayDate } from '@/lib/date-format'
import { formatMoney } from '@/lib/money'

/**
 * "Cancelar assinatura" na tela de Plano (0107): o motivo, depois as ofertas
 * de retenção — desconto ou pausa — e, recusando, o cancelamento no fim do
 * período pago. Com o cancelamento agendado, a nota e o "Desfazer"; com a
 * pausa, até quando.
 *
 * Só o dono: a leitura das opções (`GET .../cancellation`) responde 403 a
 * quem não é, e aí este bloco não aparece — um botão que sempre falharia é
 * pior que botão nenhum. Quem decide tudo é o servidor; a tela só mostra as
 * ofertas que ele disse que valem.
 */
export const CANCELLATION_REASON_KEYS: Record<CancellationReason, TranslationKey> = {
  too_expensive: 'plan.cancel.reason.too_expensive',
  not_using: 'plan.cancel.reason.not_using',
  missing_features: 'plan.cancel.reason.missing_features',
  switching_provider: 'plan.cancel.reason.switching_provider',
  technical_issues: 'plan.cancel.reason.technical_issues',
  business_closed: 'plan.cancel.reason.business_closed',
  temporary: 'plan.cancel.reason.temporary',
  other: 'plan.cancel.reason.other'
}

type Etapa = 'fechado' | 'motivo' | 'ofertas'

export function CancelSubscription({
  subscription,
  canWrite,
  currency,
  onChanged
}: {
  subscription: SubscriptionView
  canWrite: boolean
  currency: string
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [status, setStatus] = useState<CancellationStatus | null>(null)
  const [etapa, setEtapa] = useState<Etapa>('fechado')
  const [motivo, setMotivo] = useState<CancellationReason | ''>('')
  const [comentario, setComentario] = useState('')
  const [ofertas, setOfertas] = useState<CancellationOffers | null>(null)
  const [meses, setMeses] = useState(1)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  // Recarrega quando a assinatura muda (o pai redesenha depois de cada passo).
  const chave = `${subscription.cancelAt ?? ''}|${subscription.pausedUntil ?? ''}|${subscription.status}`
  useEffect(() => {
    if (!canWrite) return undefined
    let vivo = true
    void subscriptionAPI.cancellation().then((res) => {
      if (!vivo) return
      setStatus(res.success && res.data ? res.data : null)
    })
    return () => { vivo = false }
  }, [canWrite, chave])

  if (!canWrite || !status) return null

  const executar = async (fn: () => Promise<{ success: boolean; message?: string }>, fallback: string) => {
    setEnviando(true)
    setErro(null)
    try {
      const res = await fn()
      if (res.success) {
        toast.success(res.message || fallback)
        setEtapa('fechado')
        setOfertas(null)
        onChanged()
        return true
      }
      setErro(res.message || t('plan.cancel.failed'))
      return false
    } finally {
      setEnviando(false)
    }
  }

  if (subscription.cancelAt) {
    return (
      <section role="status" className="modern-card mt-6 p-5 sm:p-6">
        <h2 className="section-heading">{t('plan.cancel.title')}</h2>
        <p className="mt-2 flex items-start gap-2 text-sm text-foreground">
          <Icon name="info" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
          {t('plan.cancel.scheduledNote', { date: displayDate(subscription.cancelAt) ?? '—' })}
        </p>
        <button
          type="button"
          className="modern-button-secondary mt-4"
          disabled={enviando}
          onClick={() => void executar(subscriptionAPI.revertCancellation, t('plan.cancel.reverted'))}
        >
          {enviando ? t('plan.cancel.reverting') : t('plan.cancel.revert')}
        </button>
        {erro && <p role="alert" className="mt-2 text-sm text-destructive">{erro}</p>}
      </section>
    )
  }

  if (subscription.pausedUntil) {
    return (
      <section role="status" className="modern-card mt-6 p-5 sm:p-6">
        <h2 className="section-heading">{t('plan.cancel.pausedTitle')}</h2>
        <p className="mt-2 flex items-start gap-2 text-sm text-foreground">
          <Icon name="info" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-info))]" />
          {t('plan.cancel.pausedNote', {
            from: displayDate(subscription.renewsAt) ?? '—',
            date: displayDate(subscription.pausedUntil) ?? '—'
          })}
        </p>
        <p className="field-hint mt-2">{t('plan.cancel.pausedResume')}</p>
      </section>
    )
  }

  if (!status.canCancel) return null

  const pedir = async () => {
    if (!motivo) return
    setEnviando(true)
    setErro(null)
    try {
      const res = await subscriptionAPI.requestCancellation(motivo, comentario.trim() || undefined)
      if (res.success && res.data) {
        setOfertas(res.data.offers)
        setMeses(Math.max(1, res.data.offers.pause.maxMonths))
        setEtapa('ofertas')
      } else {
        setErro(res.message || t('plan.cancel.failed'))
      }
    } finally {
      setEnviando(false)
    }
  }

  const confirmar = async () => {
    const quando = status.cancelWouldTakeEffectAt
    const pergunta = quando
      ? t('plan.cancel.confirmScheduled', { date: displayDate(quando) ?? '—' })
      : t('plan.cancel.confirmNow')
    if (!window.confirm(pergunta)) return
    await executar(subscriptionAPI.confirmCancellation, t('plan.cancel.title'))
  }

  const desconto = ofertas?.discount
  const pausa = ofertas?.pause

  return (
    <section className="modern-card mt-6 p-5 sm:p-6">
      <h2 className="section-heading">{t('plan.cancel.title')}</h2>
      <p className="section-description">{t('plan.cancel.description')}</p>

      {etapa === 'fechado' && (
        <button type="button" className="modern-button-secondary mt-4" onClick={() => setEtapa('motivo')}>
          {t('plan.cancel.title')}
        </button>
      )}

      {etapa === 'motivo' && (
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void pedir()
          }}
        >
          <fieldset>
            <legend className="field-label">{t('plan.cancel.reasonLabel')}</legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CANCELLATION_REASONS.map((razao) => (
                <label key={razao} className="flex min-w-0 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="cancel-reason"
                    value={razao}
                    checked={motivo === razao}
                    onChange={() => setMotivo(razao)}
                  />
                  <span className="min-w-0 wrap-break-word">{t(CANCELLATION_REASON_KEYS[razao])}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="cancel-comment" className="field-label">{t('plan.cancel.commentLabel')}</label>
            <textarea
              id="cancel-comment"
              className="modern-input w-full min-w-0"
              rows={3}
              maxLength={2000}
              value={comentario}
              onChange={(e) => setComentario(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="modern-button" disabled={!motivo || enviando}>
              {enviando ? t('plan.cancel.working') : t('plan.cancel.continue')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={enviando} onClick={() => setEtapa('fechado')}>
              {t('common.back')}
            </button>
          </div>
        </form>
      )}

      {etapa === 'ofertas' && ofertas && (
        <div className="mt-4 space-y-4">
          {(desconto?.available || pausa?.available) ? (
            <p className="text-sm font-medium text-foreground">{t('plan.cancel.offersTitle')}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('plan.cancel.noOffers')}</p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {desconto?.available && (
              <div className="flex min-w-0 flex-col rounded-lg border border-primary p-4">
                <h3 className="wrap-break-word font-semibold text-foreground">
                  {desconto.billingCycle === 'annual'
                    ? t('plan.cancel.discountTitleAnnual', { percent: desconto.percent })
                    : t('plan.cancel.discountTitle', { percent: desconto.percent, months: desconto.months })}
                </h3>
                <p className="mt-1 flex-1 text-sm text-muted-foreground">
                  {t('plan.cancel.discountPrice', { price: formatMoney(desconto.priceCents, currency) })}
                  {subscription.coupon ? ` ${t('plan.cancel.discountReplaces')}` : ''}
                </p>
                <button
                  type="button"
                  className="modern-button mt-3 w-full justify-center"
                  disabled={enviando}
                  onClick={() => void executar(() => subscriptionAPI.acceptRetention('discount'), t('plan.cancel.discountAccept'))}
                >
                  {t('plan.cancel.discountAccept')}
                </button>
              </div>
            )}
            {pausa?.available && (
              <div className="flex min-w-0 flex-col rounded-lg border border-border p-4">
                <h3 className="font-semibold text-foreground">{t('plan.cancel.pauseTitle')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('plan.cancel.pauseHint', { max: pausa.maxMonths, date: displayDate(pausa.from) ?? '—' })}
                </p>
                <label htmlFor="cancel-pause-months" className="field-label mt-3">{t('plan.cancel.pauseMonths')}</label>
                <select
                  id="cancel-pause-months"
                  className="modern-input w-full min-w-0"
                  value={meses}
                  onChange={(e) => setMeses(Number(e.target.value))}
                >
                  {Array.from({ length: pausa.maxMonths }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="modern-button-secondary mt-3 w-full justify-center"
                  disabled={enviando}
                  onClick={() => void executar(() => subscriptionAPI.acceptRetention('pause', meses), t('plan.cancel.pauseAccept'))}
                >
                  {t('plan.cancel.pauseAccept')}
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="modern-button-secondary text-destructive" disabled={enviando} onClick={() => void confirmar()}>
              {enviando ? t('plan.cancel.working') : t('plan.cancel.confirmButton')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={enviando} onClick={() => setEtapa('fechado')}>
              {t('plan.cancel.keep')}
            </button>
          </div>
        </div>
      )}

      {erro && <p role="alert" className="mt-3 text-sm text-destructive">{erro}</p>}
    </section>
  )
}

export default CancelSubscription
