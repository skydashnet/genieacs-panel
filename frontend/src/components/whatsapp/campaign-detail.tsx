'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  whatsappAPI,
  type WhatsAppBroadcast,
  type WhatsAppBroadcastRecipient,
  type WhatsAppBroadcastSummary
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { ContactLink } from './contact-link'

/**
 * Who a campaign reached, one row per person.
 *
 * The card only says "120 of 300 sent"; this answers the questions that come
 * after: did Maria get it, did she read it, did anybody answer, and who asked
 * to stop because of it.
 */

const PAGE = 100

const FILTERS: { value: string; label: TranslationKey }[] = [
  { value: '', label: 'whatsapp.campaign.detail.filterAll' },
  { value: 'sent', label: 'whatsapp.campaign.detail.status.sent' },
  { value: 'replied', label: 'whatsapp.campaign.detail.replied' },
  { value: 'pending', label: 'whatsapp.campaign.detail.status.pending' },
  { value: 'skipped', label: 'whatsapp.campaign.detail.status.skipped' },
  { value: 'failed', label: 'whatsapp.campaign.detail.status.failed' }
]

const STATUS: Record<WhatsAppBroadcastRecipient['status'], { label: TranslationKey; badge: string }> = {
  pending: { label: 'whatsapp.campaign.detail.status.pending', badge: 'modern-badge' },
  sending: { label: 'whatsapp.campaign.detail.status.pending', badge: 'modern-badge' },
  sent: { label: 'whatsapp.campaign.detail.status.sent', badge: 'modern-badge-success' },
  skipped: { label: 'whatsapp.campaign.detail.status.skipped', badge: 'modern-badge-warning' },
  failed: { label: 'whatsapp.campaign.detail.status.failed', badge: 'modern-badge-error' }
}

/** The reasons the flush loop writes in `error_msg` itself. */
const ERRORS: Record<string, TranslationKey> = {
  opt_out: 'whatsapp.campaign.detail.error.optOut',
  paid: 'whatsapp.campaign.detail.error.paid',
  no_destination: 'whatsapp.campaign.detail.error.noDestination'
}

const DELIVERY: Record<string, TranslationKey> = {
  queued: 'whatsapp.delivery.queued',
  sending: 'whatsapp.delivery.sending',
  sent: 'whatsapp.delivery.sent',
  delivered: 'whatsapp.delivery.delivered',
  read: 'whatsapp.delivery.read',
  failed: 'whatsapp.delivery.failed'
}

export function CampaignDetail({ broadcast, onClose }: { broadcast: WhatsAppBroadcast; onClose: () => void }) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()

  const [summary, setSummary] = useState<WhatsAppBroadcastSummary | null>(null)
  const [items, setItems] = useState<WhatsAppBroadcastRecipient[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true)
    try {
      const res = await whatsappAPI.getBroadcastRecipients(broadcast.id, { status, limit: PAGE, offset })
      if (!alive.current) return
      if (res.success && res.data) {
        const page = res.data
        setSummary(page.summary)
        setItems((current) => (offset === 0 ? page.items : [...current, ...page.items]))
        setHasMore(page.hasMore)
      } else {
        toast.error(whatsappErrorMessage(t, res.code))
      }
    } finally {
      if (alive.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcast.id, status])

  useEffect(() => { void loadPage(0) }, [loadPage])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const outcome = (row: WhatsAppBroadcastRecipient) => {
    if (row.status === 'sent') {
      const delivery = row.deliveryStatus ? DELIVERY[row.deliveryStatus] : undefined
      return delivery ? t(delivery) : t(STATUS.sent.label)
    }
    if (!row.error) return null
    const key = ERRORS[row.error]
    return key ? t(key) : row.error
  }

  const result = (row: WhatsAppBroadcastRecipient) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={STATUS[row.status]?.badge ?? 'modern-badge'}>
        {outcome(row) ?? t(STATUS[row.status]?.label ?? 'whatsapp.campaign.detail.status.pending')}
      </span>
      {row.replied && <span className="modern-badge-info">{t('whatsapp.campaign.detail.replied')}</span>}
      {row.optedOut && <span className="modern-badge-warning">{t('whatsapp.campaign.detail.optedOut')}</span>}
    </div>
  )

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="campaign-detail-title">
      <div className="modal-panel modern-card max-h-[92vh] w-full max-w-4xl overflow-y-auto p-5 sm:p-6" data-testid="campaign-detail">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="campaign-detail-title" className="section-heading mb-1 truncate">{broadcast.title}</h2>
            <p className="section-description">{t('whatsapp.campaign.detail.hint')}</p>
          </div>
          <button type="button" className="modern-button-secondary" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {summary && (
          <div className="mb-5 grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="campaign-detail-summary">
            <Tile label={t('whatsapp.campaign.detail.status.sent')} value={summary.sent} total={summary.total} />
            <Tile label={t('whatsapp.delivery.delivered')} value={summary.delivered} total={summary.sent} />
            <Tile label={t('whatsapp.delivery.read')} value={summary.read} total={summary.sent} />
            <Tile label={t('whatsapp.campaign.detail.replied')} value={summary.replied} total={summary.sent} />
            <Tile label={t('whatsapp.campaign.detail.optedOut')} value={summary.optedOut} total={summary.sent} />
            <Tile
              label={t('whatsapp.campaign.detail.notSent')}
              value={summary.failed + summary.skipped}
              hint={summary.paid > 0 ? t('whatsapp.campaign.detail.paidCount', { count: summary.paid }) : undefined}
            />
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <select
            className="modern-input w-full sm:w-56"
            aria-label={t('whatsapp.campaign.detail.filter')}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>{t(filter.label)}</option>
            ))}
          </select>
          {summary && summary.pending > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('whatsapp.campaign.detail.pendingCount', { count: summary.pending })}
            </span>
          )}
        </div>

        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name="chat" size={22} /></div>
            <p className="empty-state-title">{loading ? t('common.loading') : t('whatsapp.campaign.detail.empty')}</p>
          </div>
        ) : (
          <>
            <div className="desktop-table overflow-x-auto rounded-md border border-border">
              <table className="modern-table">
                <thead>
                  <tr>
                    <th scope="col">{t('whatsapp.inbox.subscriber')}</th>
                    <th scope="col">{t('whatsapp.inbox.contract')}</th>
                    <th scope="col">{t('whatsapp.campaign.detail.sentAt')}</th>
                    <th scope="col">{t('whatsapp.dunning.result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id} data-recipient-status={row.status}>
                      <td>
                        <ContactLink contract={row.contract} name={row.clientName || row.phone} />
                      </td>
                      <td className="font-mono text-xs">{row.contract || '—'}</td>
                      <td className="whitespace-nowrap">{row.sentAt ? formatDateTime(row.sentAt) : '—'}</td>
                      <td>{result(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* No celular, um cartão por destinatário: a tabela espremia o nome
                numa coluna de seis linhas e cortava a hora do envio. */}
            <ul className="mobile-card-list divide-y divide-border rounded-md border border-border" role="list">
              {items.map((row) => (
                <li key={row.id} className="space-y-1.5 p-3 text-sm" data-recipient-status={row.status}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 wrap-break-word font-medium">
                      <ContactLink contract={row.contract} name={row.clientName || row.phone} />
                    </div>
                    <span className="shrink-0 font-mono text-xs">{row.contract || '—'}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{row.sentAt ? formatDateTime(row.sentAt) : '—'}</p>
                  {result(row)}
                </li>
              ))}
            </ul>
          </>
        )}

        {hasMore && (
          <div className="mt-4">
            <button
              type="button"
              className="modern-button-secondary"
              disabled={loading}
              onClick={() => void loadPage(items.length)}
            >
              {loading ? t('common.loading') : t('whatsapp.dunning.loadMore')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, total, hint }: { label: string; value: number; total?: number; hint?: string }) {
  const pct = total && total > 0 ? Math.round((value / total) * 100) : null
  return (
    <div className="rounded-md border border-border surface-subtle p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground">
        {value}
        {pct !== null && <span className="ml-1 text-xs font-normal text-muted-foreground">{pct}%</span>}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
