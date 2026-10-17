'use client'

import { useCallback, useEffect, useState } from 'react'
import { referralsAPI, type TenantReferrals } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatMoney } from '@/lib/money'
import { displayDate } from '@/lib/date-format'
import { REFERRAL_STATUS_KEYS, referralBadgeClass, referralLink } from '@/lib/referrals'

/**
 * "Indique e ganhe" na tela de Plano (0106): o link de indicação do provedor,
 * o saldo de créditos e quem ele indicou — com o nome mascarado, que é o que o
 * servidor manda.
 *
 * O crédito é abatido sozinho na próxima fatura (nunca abaixo de R$ 5,00);
 * aqui não há botão para isso, só a explicação. Com o programa desligado, o
 * bloco aparece só se ainda houver saldo ou indicados para mostrar.
 */
export function ReferralCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const [dados, setDados] = useState<TenantReferrals | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  const carregar = useCallback(async () => {
    const res = await referralsAPI.mine()
    if (res.success && res.data) {
      setDados(res.data)
      setErro(null)
    } else {
      setErro(res.message || t('referrals.loadFailed'))
    }
  }, [t])

  useEffect(() => {
    void carregar()
  }, [carregar])

  if (erro) {
    return (
      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('referrals.title')}</h2>
        <p className="mt-3 text-sm text-destructive">{erro}</p>
      </section>
    )
  }
  if (!dados) return null
  if (!dados.enabled && dados.balanceCents <= 0 && dados.reservedCents <= 0 && !dados.referrals.length) return null

  const link = referralLink(dados.signupUrl, dados.code, typeof window === 'undefined' ? '' : window.location.origin)
  const dinheiro = (cents: number) => formatMoney(cents, 'BRL')

  const copiar = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      toast.success(t('referrals.copied'))
    } catch {
      toast.error(t('referrals.copyFailed'))
    }
  }

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-heading">{t('referrals.title')}</h2>
        <button type="button" className="modern-button-secondary" onClick={() => void carregar()}>
          <Icon name="refresh" size={17} />
          {t('common.refresh')}
        </button>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {dados.enabled ? t('referrals.subtitle', { amount: dinheiro(dados.rewardCents) }) : t('referrals.disabled')}
      </p>

      {dados.enabled && link && (
        <div className="mt-4">
          <label htmlFor="referral-link" className="field-label">{t('referrals.link')}</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="referral-link"
              className="modern-input min-w-0 flex-1 font-mono text-sm"
              value={link}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="modern-button" onClick={() => void copiar()}>
              <Icon name="copy" size={17} />
              {t('referrals.copy')}
            </button>
          </div>
          {dados.code && <p className="field-hint">{t('referrals.code', { code: dados.code })}</p>}
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('referrals.balance')}</p>
          <p className="mt-1 text-2xl font-semibold text-foreground">{dinheiro(dados.balanceCents)}</p>
          {dados.reservedCents > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">{t('referrals.reserved', { amount: dinheiro(dados.reservedCents) })}</p>
          )}
        </div>
        <p className="self-center text-xs leading-5 text-muted-foreground">{t('referrals.floorHint')}</p>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-foreground">{t('referrals.listTitle')}</h3>
      {!dados.referrals.length ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('referrals.empty')}</p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {dados.referrals.map((linha) => (
            <li key={linha.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{linha.name}</p>
                {linha.createdAt && <p className="text-xs text-muted-foreground">{displayDate(linha.createdAt)}</p>}
              </div>
              <div className="flex items-center gap-2">
                {linha.status === 'credited' && linha.amountCents > 0 && (
                  <span className="text-sm font-medium text-foreground">{dinheiro(linha.amountCents)}</span>
                )}
                <span className={referralBadgeClass(linha.status)}>
                  {REFERRAL_STATUS_KEYS[linha.status] ? t(REFERRAL_STATUS_KEYS[linha.status]) : linha.status}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default ReferralCard
