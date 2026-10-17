'use client'

import { useId, useState } from 'react'
import { platformAPI, type SubscriptionCoupon, type SubscriptionStatus } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { couponDiscountLabel, couponDurationLabel } from '@/lib/coupon'
import { formatMoney } from '@/lib/money'

/**
 * O selo do cupom: o código e o desconto. Usado na linha da aba Assinaturas,
 * no painel Plano do console e na tela de Plano do provedor.
 */
export function CouponBadge({ coupon, currency }: { coupon: SubscriptionCoupon; currency?: string | null }) {
  const { t } = useTranslation()
  const duracao = couponDurationLabel(coupon)
  return (
    <span
      className={coupon.appliesToPlan ? 'modern-badge-info' : 'modern-badge'}
      title={`${t(duracao.key, duracao.vars)}${coupon.appliesToPlan ? '' : ` — ${t('coupons.notApplicable')}`}`}
    >
      {t('coupons.badge', { code: coupon.code, discount: couponDiscountLabel(coupon, currency) })}
    </span>
  )
}

/**
 * O cupom de um provedor, do lado do console: o que está aplicado, o campo
 * para aplicar outro (que substitui) e o botão de tirar. A fatura em aberto é
 * reprecificada pelo servidor; a tela só recarrega depois da resposta.
 */
export function CouponControl({
  tenantId,
  coupon,
  currency,
  storedStatus,
  onChanged
}: {
  tenantId: number
  coupon: SubscriptionCoupon | null | undefined
  currency?: string | null
  storedStatus: SubscriptionStatus | null | undefined
  onChanged: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const inputId = useId()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  // Cancelada não tem fatura a descontar (o backend recusa `not_changeable`).
  const disabled = !storedStatus || storedStatus === 'canceled'

  const enviar = async (valor: string | null) => {
    setBusy(true)
    setErro(null)
    try {
      const res = await platformAPI.setSubscriptionCoupon(tenantId, valor)
      if (res.success) {
        toast.success(t(valor === null ? 'coupons.removed' : 'coupons.applied'))
        setCode('')
        await onChanged()
      } else {
        // As recusas do cupom (e o gateway que não cancelou a fatura) vêm já
        // traduzidas pelo servidor; ficam no campo, onde se corrige.
        setErro(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  const tirar = () => {
    if (!coupon || !window.confirm(t('coupons.removeConfirm', { code: coupon.code }))) return
    void enviar(null)
  }

  const duracao = coupon ? couponDurationLabel(coupon) : null
  return (
    <div className="mt-3 border-t border-border pt-3 text-sm">
      <p className="mb-2 font-medium text-foreground">{t('coupons.label')}</p>
      {coupon && duracao && (
        <div className="mb-2 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CouponBadge coupon={coupon} currency={currency} />
            <button
              type="button"
              className="modern-button-secondary px-2 py-1 text-xs"
              disabled={busy}
              onClick={tirar}
            >
              <Icon name="x" size={14} />
              {t('coupons.remove')}
            </button>
          </div>
          <p className="text-muted-foreground">
            {t(duracao.key, duracao.vars)}
            {coupon.cyclesLeft !== null && ` · ${t('coupons.cyclesLeft', { count: coupon.cyclesLeft })}`}
          </p>
          <p className="text-muted-foreground">
            {coupon.appliesToPlan
              ? t('coupons.priceWithCoupon', { price: formatMoney(coupon.priceCents, currency) })
              : t('coupons.notApplicable')}
          </p>
        </div>
      )}
      <label htmlFor={inputId} className="sr-only">{t('coupons.code')}</label>
      <div className="flex flex-wrap gap-2">
        <input
          id={inputId}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          className="modern-input min-w-0 flex-1"
          placeholder={t('coupons.codePlaceholder')}
          maxLength={32}
          disabled={disabled || busy}
          autoComplete="off"
        />
        <button
          type="button"
          className="modern-button-secondary"
          disabled={disabled || busy || !code.trim()}
          onClick={() => void enviar(code.trim())}
        >
          {busy ? t('coupons.applying') : t('coupons.apply')}
        </button>
      </div>
      {coupon && <p className="field-hint">{t('coupons.replaceHint')}</p>}
      {erro && <p role="alert" className="mt-1 text-destructive">{erro}</p>}
    </div>
  )
}
