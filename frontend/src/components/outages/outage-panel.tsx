'use client'

import { useCallback, useEffect, useState } from 'react'
import { outagesAPI, type OutageFilters, type OutageIncident, type OutageIncidentDetail } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'

/** De quanto em quanto tempo a lista é relida: a varredura dos alertas roda a cada poucos minutos. */
const POLL_MS = 60_000
/** Mesma pausa da busca de contatos: uma consulta por palavra, não por letra. */
const SEARCH_DEBOUNCE_MS = 350
const PERIODS = [1, 7, 30, 90] as const

function Incidente({ incident, onChange }: { incident: OutageIncident; onChange: () => void }) {
  const { t, formatDateTime } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const podeAvisar = can('whatsapp.send')
  const [eta, setEta] = useState(incident.eta ?? '')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<OutageIncidentDetail | null>(null)
  const aberto = incident.status === 'open'
  const pendentes = Math.max(0, incident.withPhone - incident.notified)

  const avisar = async () => {
    if (!window.confirm(t('outage.confirmNotify', { count: pendentes }))) return
    setBusy(true)
    try {
      const res = await outagesAPI.notify(incident.id, { eta: eta.trim(), body: body.trim() })
      if (res.success && res.data) {
        toast.success(t('outage.notifiedToast', { count: res.data.sent }))
        setBody('')
        onChange()
      } else {
        toast.error(res.message || t('outage.failed'))
      }
    } finally {
      setBusy(false)
    }
  }

  const encerrar = async () => {
    if (!window.confirm(t('outage.confirmResolve'))) return
    setBusy(true)
    try {
      const res = await outagesAPI.resolve(incident.id)
      if (res.success) onChange()
      else toast.error(res.message || t('outage.failed'))
    } finally {
      setBusy(false)
    }
  }

  const alternarLista = async () => {
    if (detail) {
      setDetail(null)
      return
    }
    const res = await outagesAPI.get(incident.id)
    if (res.success && res.data) setDetail(res.data)
  }

  return (
    <div className={`rounded-md border p-3 sm:p-4 ${aberto ? 'border-[hsl(var(--status-danger))]/50 bg-[hsl(var(--status-danger))]/5' : 'border-border'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-start gap-2 font-semibold wrap-anywhere">
            <Icon name="warning" size={16} className={`mt-1 shrink-0 ${aberto ? 'text-[hsl(var(--status-danger))]' : 'text-muted-foreground'}`} />
            {t('outage.cardTitle', { node: incident.nodeName })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {aberto
              ? t('outage.since', { when: formatDateTime(incident.startedAt) })
              : t('outage.resolvedAt', { when: formatDateTime(incident.resolvedAt) })}
            {' · '}
            {t('outage.counts', { affected: incident.affected, phones: incident.withPhone, notified: incident.notified })}
          </p>
          {incident.noticeSentAt && (
            <p className="mt-1 text-sm text-[hsl(var(--status-success))]">
              {t('outage.noticeSent', { when: formatDateTime(incident.noticeSentAt) })}
              {incident.recoverySentAt ? ` · ${t('outage.recoverySent')}` : ''}
            </p>
          )}
        </div>
        <span className={aberto ? 'modern-badge-error' : 'modern-badge-success'}>
          {t(aberto ? 'outage.statusOpen' : 'outage.statusResolved')}
        </span>
      </div>

      {aberto && podeAvisar && (
        <div className="mt-4 grid gap-3">
          <div className="max-w-sm">
            <label htmlFor={`outage-eta-${incident.id}`} className="mb-1 block text-sm font-medium">{t('outage.eta')}</label>
            <input
              id={`outage-eta-${incident.id}`}
              className="modern-input w-full"
              value={eta}
              maxLength={255}
              placeholder={t('outage.etaPlaceholder')}
              onChange={(event) => setEta(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`outage-body-${incident.id}`} className="mb-1 block text-sm font-medium">{t('outage.message')}</label>
            <textarea
              id={`outage-body-${incident.id}`}
              className="modern-input w-full text-sm"
              rows={3}
              maxLength={1000}
              value={body}
              placeholder={incident.defaultNotice}
              onChange={(event) => setBody(event.target.value)}
            />
            <p className="field-hint">{t('outage.messageHint')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="modern-button" disabled={busy || pendentes === 0} onClick={() => void avisar()}>
              {t(incident.noticeSentAt ? 'outage.notifyNew' : 'outage.notify', { count: pendentes })}
            </button>
            <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => void encerrar()}>
              {t('outage.resolve')}
            </button>
          </div>
        </div>
      )}

      <button type="button" className="mt-1 inline-flex min-h-10 items-center text-sm underline md:mt-3 md:min-h-0" onClick={() => void alternarLista()}>
        {t(detail ? 'outage.hideAffected' : 'outage.showAffected')}
      </button>
      {detail && (
        <ul className="mt-2 grid gap-2 text-sm md:gap-1">
          {detail.devices.map((d) => (
            <li key={d.deviceId} className="flex flex-wrap gap-x-3">
              <span className="min-w-0 font-medium wrap-anywhere">{d.clientName || d.deviceId}</span>
              {d.contract && <span className="text-muted-foreground">{t('outage.contract', { contract: d.contract })}</span>}
              {!d.hasPhone && <span className="text-muted-foreground">{t('outage.noPhone')}</span>}
              {d.notifiedAt && <span className="text-[hsl(var(--status-success))]">{t('outage.notifiedMark')}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * As quedas em massa que o alerta viu. `onlyOpen` é o Dashboard: só aparece
 * quando há queda em andamento, e some sozinho quando ela acaba.
 */
export function OutagePanel({ onlyOpen = false }: { onlyOpen?: boolean }) {
  const { t } = useTranslation()
  const [incidents, setIncidents] = useState<OutageIncident[] | null>(null)
  const [days, setDays] = useState<NonNullable<OutageFilters['days']>>(1)
  const [status, setStatus] = useState<NonNullable<OutageFilters['status']>>('')
  const [notified, setNotified] = useState<NonNullable<OutageFilters['notified']>>('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search])

  const filtered = days !== 1 || status !== '' || notified !== '' || debounced !== ''

  const load = useCallback(async () => {
    // O Dashboard pede só os abertos; o quadro do WhatsApp, o que os filtros dizem.
    const res = await outagesAPI.list(onlyOpen ? { status: 'open' } : { days, status, notified, search: debounced })
    if (res.success && res.data) setIncidents(res.data.incidents)
  }, [onlyOpen, days, status, notified, debounced])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const lista = (incidents ?? []).filter((i) => !onlyOpen || i.status === 'open')
  if (onlyOpen && lista.length === 0) return null

  return (
    <section className="modern-card mb-5 p-5 sm:p-6">
      <h2 className="section-heading">{t('outage.title')}</h2>
      <p className="field-hint mt-1">{t('outage.description')}</p>
      {!onlyOpen && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="outage-filters">
          <select
            className="modern-input"
            aria-label={t('outage.filter.period')}
            value={days}
            onChange={(event) => setDays(Number(event.target.value) as NonNullable<OutageFilters['days']>)}
          >
            {PERIODS.map((period) => (
              <option key={period} value={period}>
                {period === 1 ? t('outage.filter.last24h') : t('outage.filter.lastDays', { count: period })}
              </option>
            ))}
          </select>
          <select
            className="modern-input"
            aria-label={t('outage.filter.status')}
            value={status}
            onChange={(event) => setStatus(event.target.value as NonNullable<OutageFilters['status']>)}
          >
            <option value="">{t('outage.filter.allStatus')}</option>
            <option value="open">{t('outage.statusOpen')}</option>
            <option value="resolved">{t('outage.statusResolved')}</option>
          </select>
          <select
            className="modern-input"
            aria-label={t('outage.filter.notified')}
            value={notified}
            onChange={(event) => setNotified(event.target.value as NonNullable<OutageFilters['notified']>)}
          >
            <option value="">{t('outage.filter.allNotified')}</option>
            <option value="pending">{t('outage.filter.notNotified')}</option>
            <option value="sent">{t('outage.filter.notifiedOnly')}</option>
          </select>
          <input
            type="search"
            className="modern-input"
            aria-label={t('outage.filter.search')}
            placeholder={t('outage.filter.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      )}
      <div className="mt-4 grid gap-3">
        {incidents === null && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
        {incidents !== null && lista.length === 0 && (
          <p className="text-sm text-muted-foreground">{t(filtered ? 'outage.emptyFiltered' : 'outage.empty')}</p>
        )}
        {lista.map((incident) => (
          <Incidente key={`${incident.id}-${incident.status}-${incident.noticeSentAt ?? ''}`} incident={incident} onChange={() => void load()} />
        ))}
      </div>
    </section>
  )
}

export default OutagePanel
