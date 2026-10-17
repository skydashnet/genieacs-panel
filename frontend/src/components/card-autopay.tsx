'use client'

import { useState } from 'react'
import { subscriptionAPI, type SubscriptionCard, type SubscriptionUsage } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { displayDate } from '@/lib/date-format'
import { cardSummary } from '@/lib/card-autopay'

/**
 * O cartão recorrente na tela de Plano: "Cobrar automaticamente no cartão",
 * o cartão salvo (bandeira e quatro dígitos), a recusa e o "Remover cartão".
 *
 * O cartão nunca é digitado aqui: ligar só registra a intenção, e o cartão é
 * salvo quando o provedor paga uma fatura com cartão na página do Asaas. Para
 * trocar de cartão, paga-se a próxima fatura com o outro.
 *
 * `canWrite` é o `settings.write` (dono e admin); `canEnable` diz se a
 * assinatura aceita ligar agora — desligar e remover passam sempre.
 */
export function CardAutopay({
  card,
  canWrite,
  canEnable,
  onChanged
}: {
  card: SubscriptionCard
  canWrite: boolean
  canEnable: boolean
  onChanged: (data: SubscriptionUsage) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [salvando, setSalvando] = useState(false)
  const [removendo, setRemovendo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const resumo = cardSummary(card)

  const alternar = async (enabled: boolean) => {
    setSalvando(true)
    setErro(null)
    try {
      const res = await subscriptionAPI.setCardAutopay(enabled)
      if (res.success && res.data) {
        onChanged(res.data)
        toast.success(res.message || t('plan.card.title'))
      } else {
        setErro(res.message || t('plan.card.updateFailed'))
      }
    } finally {
      setSalvando(false)
    }
  }

  const remover = async () => {
    if (!window.confirm(t('plan.card.removeConfirm'))) return
    setRemovendo(true)
    setErro(null)
    try {
      const res = await subscriptionAPI.removeCard()
      if (res.success && res.data) {
        onChanged(res.data)
        toast.success(res.message || t('plan.card.remove'))
      } else {
        setErro(res.message || t('plan.card.updateFailed'))
      }
    } finally {
      setRemovendo(false)
    }
  }

  const ocupado = salvando || removendo

  return (
    <div className="mt-4 rounded-lg border border-border p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-foreground">
        <Icon name="invoice" size={16} className="shrink-0" />
        {t('plan.card.title')}
      </p>
      <p className="field-hint mt-1">{t('plan.card.description')}</p>
      {canWrite && (canEnable || card.autopayEnabled) && (
        <label className="mt-3 flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={card.autopayEnabled}
            disabled={ocupado}
            onChange={(e) => void alternar(e.target.checked)}
          />
          <span>{salvando ? t('plan.card.saving') : t('plan.card.enable')}</span>
        </label>
      )}
      {resumo && <p className="mt-2 break-words text-foreground">{t(resumo.key, resumo.vars)}</p>}
      {card.failedAt && (
        <p role="status" className="mt-2 text-[hsl(var(--status-warning))]">
          {t('plan.card.failed', { date: displayDate(card.failedAt) ?? '—' })}
        </p>
      )}
      {canWrite && card.saved && (
        <button
          type="button"
          className="mt-3 text-sm font-medium text-destructive underline-offset-2 hover:underline disabled:opacity-60"
          disabled={ocupado}
          onClick={() => void remover()}
        >
          {removendo ? t('plan.card.removing') : t('plan.card.remove')}
        </button>
      )}
      {erro && <p role="alert" className="mt-2 text-destructive">{erro}</p>}
    </div>
  )
}
