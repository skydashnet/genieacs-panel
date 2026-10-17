'use client'

import { useCallback, useEffect, useState } from 'react'
import { whatsappAPI, type WhatsAppReferral, type WhatsAppReferralList, type WhatsAppReferralStatus } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { ContactLink } from './contact-link'
import type { TranslationKey } from '@/lib/i18n'

/**
 * "Indique e ganhe": quem cada cliente indicou pelo link dele.
 *
 * O link abre uma página pública no portal do assinante; quem se cadastra cai
 * aqui, ligado ao contrato de quem indicou, e a equipe anda a situação à mão
 * (novo, contatado, virou cliente, recompensa dada).
 */

const STATUSES: WhatsAppReferralStatus[] = ['new', 'contacted', 'won', 'rewarded', 'lost']

const STATUS_LABEL: Record<WhatsAppReferralStatus, TranslationKey> = {
  new: 'whatsapp.referral.sNew',
  contacted: 'whatsapp.referral.sContacted',
  won: 'whatsapp.referral.sWon',
  rewarded: 'whatsapp.referral.sRewarded',
  lost: 'whatsapp.referral.sLost'
}

export function ReferralsPanel() {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const { can } = useAuth()
  const canManage = can('campaigns.manage')

  const [data, setData] = useState<WhatsAppReferralList | null>(null)
  const [filter, setFilter] = useState<WhatsAppReferralStatus | ''>('')
  const [loading, setLoading] = useState(true)
  const [baseUrl, setBaseUrl] = useState('')
  const [savingUrl, setSavingUrl] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await whatsappAPI.listReferrals(filter)
      if (res.success && res.data) {
        setData(res.data)
        setBaseUrl((current) => current || res.data?.baseUrl || '')
      } else {
        toast.error(whatsappErrorMessage(t, res.code))
      }
    } finally {
      setLoading(false)
    }
  }, [filter, t, toast])

  useEffect(() => { void load() }, [load])

  const saveUrl = async () => {
    setSavingUrl(true)
    try {
      const res = await whatsappAPI.setReferralBaseUrl(baseUrl.trim())
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      toast.success(res.message || t('common.save'))
      await load()
    } finally {
      setSavingUrl(false)
    }
  }

  const move = async (referral: WhatsAppReferral, status: WhatsAppReferralStatus) => {
    setBusyId(referral.id)
    try {
      const res = await whatsappAPI.updateReferral(referral.id, { status })
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const total = data ? STATUSES.reduce((sum, status) => sum + (data.counts[status] ?? 0), 0) : 0

  return (
    <section className="space-y-5" data-testid="wa-referrals">
      <header>
        <h2 className="section-heading">{t('whatsapp.referral.title')}</h2>
        <p className="section-description">{t('whatsapp.referral.description')}</p>
      </header>

      <div className="modern-card space-y-2 p-4 sm:p-5">
        <label className="field-label" htmlFor="referral-base-url">{t('whatsapp.referral.baseUrl')}</label>
        <div className="flex flex-wrap gap-2">
          <input
            id="referral-base-url"
            className="modern-input min-w-0 flex-1"
            value={baseUrl}
            disabled={!canManage}
            placeholder="https://portal.seuprovedor.com.br"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          {canManage && (
            <button type="button" className="modern-button" disabled={savingUrl} onClick={() => void saveUrl()}>
              {t('whatsapp.referral.baseUrlSave')}
            </button>
          )}
        </div>
        <p className="field-hint">{t('whatsapp.referral.baseUrlHint')}</p>
        {data && !data.baseUrl && <p className="text-sm text-destructive">{t('whatsapp.referral.baseUrlMissing')}</p>}
        {data && !data.linksReady && <p className="text-sm text-destructive">{t('whatsapp.referral.noSecret')}</p>}
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('whatsapp.referral.title')}>
        <button
          type="button"
          role="tab"
          aria-selected={filter === ''}
          className={filter === '' ? 'modern-badge-info' : 'modern-badge'}
          onClick={() => setFilter('')}
        >
          {t('whatsapp.referral.filterAll')} · {total}
        </button>
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            role="tab"
            aria-selected={filter === status}
            className={filter === status ? 'modern-badge-info' : 'modern-badge'}
            onClick={() => setFilter(status)}
          >
            {t(STATUS_LABEL[status])} · {data?.counts[status] ?? 0}
          </button>
        ))}
      </div>

      {!data || data.referrals.length === 0 ? (
        <div className="modern-card">
          <div className="empty-state">
            <p className="empty-state-title">{loading ? t('common.loading') : t('whatsapp.referral.empty')}</p>
          </div>
        </div>
      ) : (
        <div className="modern-card overflow-x-auto">
          <table className="modern-table w-full text-sm">
            <thead>
              <tr>
                <th scope="col">{t('whatsapp.referral.colReferred')}</th>
                <th scope="col">{t('whatsapp.referral.colPhone')}</th>
                <th scope="col">{t('whatsapp.referral.colNeighborhood')}</th>
                <th scope="col">{t('whatsapp.referral.colReferrer')}</th>
                <th scope="col">{t('whatsapp.referral.colDate')}</th>
                <th scope="col">{t('whatsapp.referral.colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {data.referrals.map((referral) => (
                <tr key={referral.id} data-referral-id={referral.id}>
                  <td className="font-medium">{referral.name}</td>
                  <td className="font-mono text-xs">{referral.phone}</td>
                  <td>{referral.neighborhood ?? '—'}</td>
                  <td><ContactLink contract={referral.referrerContract} name={referral.referrerName ?? referral.referrerContract} /></td>
                  <td className="text-xs text-muted-foreground">{referral.createdAt ? formatDateTime(referral.createdAt) : '—'}</td>
                  <td>
                    <select
                      className="modern-input"
                      aria-label={t('whatsapp.referral.colStatus')}
                      value={referral.status}
                      disabled={!canManage || busyId === referral.id}
                      onChange={(event) => void move(referral, event.target.value as WhatsAppReferralStatus)}
                    >
                      {STATUSES.map((status) => <option key={status} value={status}>{t(STATUS_LABEL[status])}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
