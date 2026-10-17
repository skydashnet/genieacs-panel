'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { referralsAPI, type ConsoleReferrals } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { displayDate } from '@/lib/date-format'
import { REFERRAL_STATUS_KEYS, parseSignedAmountToCents, referralBadgeClass } from '@/lib/referrals'

/**
 * A indicação e os créditos de UM provedor, no console (0106): o código, quem
 * o indicou, quem ele indicou (com o nome inteiro), o saldo, os créditos e o
 * ajuste manual — positivo dá, negativo tira, sempre com motivo, e o servidor
 * grava nas duas trilhas.
 */
export function TenantReferrals({ tenantId }: { tenantId: number }) {
  const { t } = useTranslation()
  const toast = useToast()
  const ids = useId()
  const [dados, setDados] = useState<ConsoleReferrals | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [valor, setValor] = useState('')
  const [motivo, setMotivo] = useState('')
  const [salvando, setSalvando] = useState(false)

  const carregar = useCallback(async () => {
    const res = await referralsAPI.ofTenant(tenantId)
    if (res.success && res.data) {
      setDados(res.data)
      setErro(null)
    } else {
      setErro(res.message || t('referrals.loadFailed'))
    }
  }, [tenantId, t])

  useEffect(() => {
    void carregar()
  }, [carregar])

  const dinheiro = (cents: number) => formatMoney(cents, 'BRL')

  const ajustar = async (event: React.FormEvent) => {
    event.preventDefault()
    const centavos = parseSignedAmountToCents(valor)
    if (centavos === null || !motivo.trim()) {
      toast.error(t('platform.referrals.adjustInvalid'))
      return
    }
    setSalvando(true)
    try {
      const res = await referralsAPI.adjust(tenantId, { amountCents: centavos, reason: motivo.trim() })
      if (res.success && res.data) {
        setDados(res.data.referrals)
        setValor('')
        setMotivo('')
        toast.success(t('platform.referrals.adjusted'))
      } else if (res.code === 'insufficient_credit') {
        toast.error(t('platform.referrals.insufficient', { amount: dinheiro(dados?.balanceCents ?? 0) }))
      } else {
        toast.error(res.message || t('platform.referrals.adjustInvalid'))
      }
    } finally {
      setSalvando(false)
    }
  }

  if (erro) return <p className="text-sm text-destructive">{erro}</p>
  if (!dados) return null

  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">{t('platform.referrals.title')}</h4>
        <span className="text-xs text-muted-foreground">
          {t('platform.referrals.code')}: <span className="font-mono">{dados.code ?? t('platform.referrals.noCode')}</span>
        </span>
      </div>
      <p className="text-sm text-foreground">
        {t('platform.referrals.balance', { amount: dinheiro(dados.balanceCents) })}
        {dados.reservedCents > 0 && (
          <span className="ml-2 text-xs text-muted-foreground">
            {t('platform.referrals.reserved', { amount: dinheiro(dados.reservedCents) })}
          </span>
        )}
      </p>
      {dados.referredBy && (
        <p className="text-xs text-muted-foreground">
          {t('platform.referrals.referredBy', { name: dados.referredBy.name ?? `#${dados.referredBy.tenantId}` })}
          {' · '}
          <span className={referralBadgeClass(dados.referredBy.status)}>{t(REFERRAL_STATUS_KEYS[dados.referredBy.status])}</span>
        </p>
      )}

      {dados.referrals.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('platform.referrals.referrals')}</p>
          <ul className="mt-1 divide-y divide-border">
            {dados.referrals.map((linha) => (
              <li key={linha.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0 truncate">{linha.name ?? `#${linha.tenantId}`}</span>
                <span className="flex items-center gap-2">
                  {linha.amountCents > 0 && <span>{dinheiro(linha.amountCents)}</span>}
                  <span className={referralBadgeClass(linha.status)}>{t(REFERRAL_STATUS_KEYS[linha.status])}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="text-xs font-medium text-muted-foreground">{t('platform.referrals.credits')}</p>
        {!dados.credits.length ? (
          <p className="mt-1 text-sm text-muted-foreground">{t('platform.referrals.noCredits')}</p>
        ) : (
          <ul className="mt-1 divide-y divide-border">
            {dados.credits.map((credito) => (
              <li key={credito.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0">
                  <span className="modern-badge mr-2">{t(credito.source === 'referral' ? 'referrals.source.referral' : 'referrals.source.manual')}</span>
                  {dinheiro(credito.amountCents)}
                  {credito.reference && <span className="ml-2 text-xs text-muted-foreground">{credito.reference}</span>}
                </span>
                <span className="text-xs text-muted-foreground">
                  {credito.canceled
                    ? t('platform.referrals.canceled')
                    : t('platform.referrals.remaining', { amount: dinheiro(credito.remainingCents) })}
                  {credito.createdAt && ` · ${displayDate(credito.createdAt)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-end" onSubmit={ajustar}>
        <div>
          <label htmlFor={`${ids}-valor`} className="field-label">{t('platform.referrals.adjustAmount')}</label>
          <input
            id={`${ids}-valor`}
            className="modern-input w-full min-w-0"
            inputMode="decimal"
            value={valor}
            placeholder="-10,00"
            onChange={(e) => setValor(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`${ids}-motivo`} className="field-label">{t('platform.referrals.adjustReason')}</label>
          <input
            id={`${ids}-motivo`}
            className="modern-input w-full min-w-0"
            value={motivo}
            maxLength={255}
            onChange={(e) => setMotivo(e.target.value)}
          />
        </div>
        <button type="submit" className="modern-button-secondary" disabled={salvando}>
          {salvando ? t('common.saving') : t('platform.referrals.adjustSubmit')}
        </button>
      </form>
    </div>
  )
}

export default TenantReferrals
