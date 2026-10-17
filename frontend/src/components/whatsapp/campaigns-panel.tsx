'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { whatsappAPI, type WhatsAppBroadcast } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import type { TranslationKey } from '@/lib/i18n'
import { useAuth } from '@/contexts/auth-context'
import { CampaignForm, STATE_LABEL, canEditCampaign } from './campaign-form'
import { CampaignDetail } from './campaign-detail'

/**
 * The campaigns list.
 *
 * A campaign is born a draft and never sends on its own; the dispatch loop only
 * ever looks at the ones an operator moved to `running`. So this screen is
 * where the deliberate click lives, and both of the irreversible ones — the
 * start that reaches hundreds of phones and the cancel that cannot recall what
 * already left — go through a confirmation naming the campaign.
 */

type BroadcastStatus = WhatsAppBroadcast['status']

const STATUS_LABEL: Record<BroadcastStatus, TranslationKey> = {
  draft: 'whatsapp.broadcast.status.draft',
  queued: 'whatsapp.broadcast.status.queued',
  running: 'whatsapp.broadcast.status.running',
  paused: 'whatsapp.broadcast.status.paused',
  done: 'whatsapp.broadcast.status.done',
  canceled: 'whatsapp.broadcast.status.canceled',
  failed: 'whatsapp.broadcast.status.failed'
}

const STATUS_BADGE: Record<BroadcastStatus, string> = {
  draft: 'modern-badge',
  queued: 'modern-badge-info',
  running: 'modern-badge-info',
  paused: 'modern-badge-warning',
  done: 'modern-badge-success',
  canceled: 'modern-badge',
  failed: 'modern-badge-error'
}

/**
 * Which moves a state allows — the server's transition table, mirrored so the
 * screen offers only what the server would accept. A finished campaign offers
 * nothing at all: restarting one would send again to everyone it already
 * reached, which is why `done`, `canceled` and `failed` are terminal.
 */
const ALLOWED: Record<BroadcastStatus, ('running' | 'paused' | 'canceled')[]> = {
  draft: ['running', 'canceled'],
  queued: ['running', 'paused', 'canceled'],
  paused: ['running', 'canceled'],
  running: ['paused', 'canceled'],
  done: [],
  canceled: [],
  failed: []
}

/** Os filtros de uma campanha de aviso, numa linha: "Situação: active · Bairro: Centro · 12 contratos". */
function audienceSummary(
  broadcast: WhatsAppBroadcast,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
): string {
  const audience = broadcast.audience
  if (!audience) return ''
  const parts: string[] = []
  if (audience.states?.length) {
    const states = audience.states.map((state) => (STATE_LABEL[state] ? t(STATE_LABEL[state]) : state))
    parts.push(`${t('whatsapp.campaign.filterStates')}: ${states.join(', ')}`)
  }
  if (audience.plans?.length) parts.push(`${t('whatsapp.campaign.filterPlans')}: ${audience.plans.join(', ')}`)
  if (audience.districts?.length) parts.push(`${t('whatsapp.campaign.filterDistricts')}: ${audience.districts.join(', ')}`)
  if (audience.cities?.length) parts.push(`${t('whatsapp.campaign.filterCities')}: ${audience.cities.join(', ')}`)
  if (audience.contracts) parts.push(t('whatsapp.campaign.contractsCount', { count: audience.contracts }))
  return parts.length ? parts.join(' · ') : t('whatsapp.campaign.audienceAll')
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling
//
// The dispatch loop wakes once a minute, so progress moves in steps, not in a
// stream. The list is therefore polled only while something is actually
// `running`, on the same three rules the pairing screen established:
//
//   · single-flight — a tick landing on an open request is dropped, never
//     queued, so a slow server cannot accumulate a backlog of list calls;
//   · a hidden tab skips the tick entirely — an operator leaves this open all
//     afternoon and a progress bar nobody is looking at is pure load;
//   · a failing server is backed off as `2 ** failures - 1` skipped ticks and
//     abandoned after three in a row.
//
// Every timer is owned by the effect that created it and cleared on unmount.
// ─────────────────────────────────────────────────────────────────────────────
const POLL_MS = 10_000
const MAX_FAILURES = 3

export function CampaignsPanel() {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()

  const [broadcasts, setBroadcasts] = useState<WhatsAppBroadcast[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<WhatsAppBroadcast | null>(null)
  const [editingBroadcast, setEditingBroadcast] = useState<WhatsAppBroadcast | null>(null)
  const { can } = useAuth()
  const canManage = can('campaigns.manage')

  const alive = useRef(true)
  const inFlight = useRef(false)
  const failures = useRef(0)
  const blockedUntil = useRef(0)

  // Re-armed on mount: the panel is remounted every time its tab is selected,
  // and a flag left false would drop every response from then on.
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async (manual: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await whatsappAPI.listBroadcasts()
      if (!alive.current) return
      if (!res.success || !res.data) {
        failures.current += 1
        blockedUntil.current = Date.now() + (2 ** failures.current - 1) * POLL_MS
        // A background tick that fails is not the operator's business; a button
        // they just pressed is.
        if (manual) toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      failures.current = 0
      blockedUntil.current = 0
      setBroadcasts(res.data)
    } finally {
      inFlight.current = false
      if (alive.current && manual) setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    setLoading(true)
    void load(true)
  }, [load])

  /** Nothing is moving unless something is `running`; then, and only then, poll. */
  const anyRunning = useMemo(
    () => broadcasts.some((broadcast) => broadcast.status === 'running'),
    [broadcasts]
  )

  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (failures.current >= MAX_FAILURES) return
      if (Date.now() < blockedUntil.current) return
      void load(false)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [anyRunning, load])

  const move = useCallback(async (
    broadcast: WhatsAppBroadcast,
    status: 'running' | 'paused' | 'canceled'
  ) => {
    // The two that cannot be taken back ask first, by name. Pausing is
    // reversible and does not: a confirmation on every button teaches the
    // operator to click through the one that matters.
    if (status === 'running' && !window.confirm(
      t('whatsapp.broadcast.confirmStart', { title: broadcast.title, count: broadcast.totalCount })
    )) return
    if (status === 'canceled' && !window.confirm(
      t('whatsapp.broadcast.confirmCancel', { title: broadcast.title })
    )) return

    setBusyId(broadcast.id)
    try {
      const res = await whatsappAPI.setBroadcastStatus(broadcast.id, status)
      if (!alive.current) return
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        // The refusal is usually `invalid_status`: another tab, or the dispatch
        // loop finishing the campaign, moved it while this list was stale.
        // Re-reading is what makes the buttons honest again.
        await load(false)
        return
      }
      await load(false)
    } finally {
      if (alive.current) setBusyId(null)
    }
  }, [load, t, toast])

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="section-heading">{t('whatsapp.broadcast.title')}</h2>
          <p className="section-description">{t('whatsapp.broadcast.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && (
            <button type="button" className="modern-button" data-testid="wa-campaign-new" onClick={() => setCreating(true)}>
              <Icon name="chat" size={16} />
              {t('whatsapp.campaign.new')}
            </button>
          )}
          <button
            type="button"
            className="modern-button-secondary"
            onClick={() => { setLoading(true); void load(true) }}
          >
            <Icon name="refresh" size={16} />
            {t('common.refresh')}
          </button>
        </div>
      </header>

      {creating && (
        <CampaignForm
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); void load(true) }}
        />
      )}

      {editingBroadcast && (
        <CampaignForm
          editing={editingBroadcast}
          onClose={() => setEditingBroadcast(null)}
          onCreated={() => { setEditingBroadcast(null); void load(true) }}
        />
      )}

      {viewing && <CampaignDetail broadcast={viewing} onClose={() => setViewing(null)} />}

      {broadcasts.length === 0 ? (
        <div className="modern-card">
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name="chat" size={22} /></div>
            <p className="empty-state-title">
              {loading ? t('common.loading') : t('whatsapp.broadcast.empty')}
            </p>
          </div>
        </div>
      ) : (
        <ul className="space-y-4" role="list">
          {broadcasts.map((broadcast) => {
            const allowed = ALLOWED[broadcast.status]
            const busy = busyId === broadcast.id
            // `sent` counts what left; `failed` folds in the skipped, because
            // from the header's side both mean "not delivered".
            const done = broadcast.sentCount + broadcast.failedCount
            const pct = broadcast.totalCount > 0
              ? Math.min(100, Math.round((done / broadcast.totalCount) * 100))
              : 0
            return (
              <li
                key={broadcast.id}
                className="modern-card p-4 sm:p-5"
                data-broadcast-id={broadcast.id}
                data-status={broadcast.status}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-foreground">
                      {broadcast.title}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDateTime(broadcast.createdAt)}
                    </p>
                    {broadcast.status === 'queued' && broadcast.scheduledAt && (
                      <p className="mt-1 text-xs font-semibold text-foreground" data-testid="wa-broadcast-scheduled">
                        {t('whatsapp.campaign.scheduledFor', { when: formatDateTime(broadcast.scheduledAt) })}
                      </p>
                    )}
                    {audienceSummary(broadcast, t) && (
                      <p className="mt-1 text-xs text-muted-foreground">{audienceSummary(broadcast, t)}</p>
                    )}
                    {broadcast.attachment && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Icon name="paperclip" size={14} />
                        {broadcast.attachment.name || t('whatsapp.campaign.attachment')}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="modern-badge">
                      {t(broadcast.kind === 'general' ? 'whatsapp.campaign.kindGeneral' : 'whatsapp.campaign.kindBilling')}
                    </span>
                    <span className={STATUS_BADGE[broadcast.status]} data-testid="wa-broadcast-status">
                      <span className="status-dot" />
                      {t(STATUS_LABEL[broadcast.status])}
                    </span>
                    {broadcast.rateLimitPerMin !== null && (
                      <span className="modern-badge">
                        {t('whatsapp.broadcast.rate', { count: broadcast.rateLimitPerMin })}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-4">
                  <p className="text-sm text-muted-foreground" data-testid="wa-broadcast-progress">
                    {t('whatsapp.broadcast.progress', {
                      sent: broadcast.sentCount,
                      total: broadcast.totalCount,
                      failed: broadcast.failedCount
                    })}
                  </p>
                  <div
                    className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>

                <div className="mt-4">
                  <p className="field-label">{t('whatsapp.broadcast.body')}</p>
                  {/* The rendered text, readable before the start rather than
                      after: this is the thing hundreds of people will get. */}
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-border surface-subtle p-3 text-xs leading-5 text-muted-foreground">
                    {broadcast.body}
                  </pre>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="modern-button-secondary"
                      data-testid="wa-broadcast-recipients"
                      onClick={() => setViewing(broadcast)}
                    >
                      <Icon name="contacts" size={16} />
                      {t('whatsapp.campaign.detail.open')}
                    </button>
                    {canManage && canEditCampaign(broadcast) && (
                      <button
                        type="button"
                        className="modern-button-secondary"
                        data-testid="wa-broadcast-edit"
                        disabled={busy}
                        onClick={() => setEditingBroadcast(broadcast)}
                      >
                        <Icon name="edit" size={16} />
                        {t('whatsapp.campaign.editAction')}
                      </button>
                    )}
                    {allowed.includes('running') && (
                      <button
                        type="button"
                        className="modern-button"
                        data-testid="wa-broadcast-start"
                        disabled={busy}
                        onClick={() => void move(broadcast, 'running')}
                      >
                        <Icon name="power" size={16} />
                        {t('whatsapp.broadcast.start')}
                      </button>
                    )}
                    {allowed.includes('paused') && (
                      <button
                        type="button"
                        className="modern-button-secondary"
                        data-testid="wa-broadcast-pause"
                        disabled={busy}
                        onClick={() => void move(broadcast, 'paused')}
                      >
                        {t('whatsapp.broadcast.pause')}
                      </button>
                    )}
                    {allowed.includes('canceled') && (
                      <button
                        type="button"
                        className="modern-button-danger"
                        data-testid="wa-broadcast-cancel"
                        disabled={busy}
                        onClick={() => void move(broadcast, 'canceled')}
                      >
                        <Icon name="x" size={16} />
                        {t('whatsapp.broadcast.cancel')}
                      </button>
                    )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
