'use client'

import { useCallback, useEffect, useState } from 'react'
import { platformAPI, type Lead, type LeadStatus } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n/dictionary'
import { displayDateTime } from '@/lib/date-format'

const STATUSES: LeadStatus[] = ['new', 'contacted', 'won', 'lost']

const STATUS_KEYS: Record<LeadStatus, TranslationKey> = {
  new: 'platform.leads.status.new',
  contacted: 'platform.leads.status.contacted',
  won: 'platform.leads.status.won',
  lost: 'platform.leads.status.lost'
}

const STATUS_BADGE: Record<LeadStatus, string> = {
  new: 'modern-badge-info',
  contacted: 'modern-badge-warning',
  won: 'modern-badge-success',
  lost: 'modern-badge-error'
}

function quando(valor: string | null) {
  if (!valor) return '—'
  return displayDateTime(valor) ?? '—'
}

/** Só dígitos, com o 55 do Brasil quando falta — o que o link do WhatsApp quer. */
function whatsappLink(phone: string | null) {
  const d = String(phone ?? '').replace(/\D/g, '')
  if (!d) return null
  const numero = (d.length === 10 || d.length === 11) ? `55${d}` : d
  return `https://wa.me/${numero}`
}

/**
 * Os pedidos de demonstração que a página pública recebe.
 *
 * Um funil curto e de propósito: novo, contatado, ganho, perdido. A anotação é
 * livre — é onde fica "ligar de novo na segunda" — e cada mudança de etapa
 * entra na trilha da plataforma.
 */
export function PlatformLeads() {
  const { t } = useTranslation()
  const toast = useToast()
  const [filtro, setFiltro] = useState<LeadStatus | ''>('')
  const [leads, setLeads] = useState<Lead[]>([])
  const [counts, setCounts] = useState<Partial<Record<LeadStatus, number>>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notas, setNotas] = useState<Record<number, string>>({})
  const [salvando, setSalvando] = useState<number | null>(null)

  const carregar = useCallback(async () => {
    setLoading(true)
    const res = await platformAPI.listLeads(filtro || undefined)
    if (res.success && res.data) {
      setLeads(res.data.leads)
      setCounts(res.data.counts)
      setNotas(Object.fromEntries(res.data.leads.map((lead) => [lead.id, lead.notes ?? ''])))
      setError(null)
    } else {
      setLeads([])
      setError(res.message || t('platform.leads.loadFailed'))
    }
    setLoading(false)
  }, [filtro, t])

  useEffect(() => { void carregar() }, [carregar])

  const salvar = async (lead: Lead, patch: { status?: LeadStatus; notes?: string | null }) => {
    setSalvando(lead.id)
    try {
      const res = await platformAPI.updateLead(lead.id, patch)
      if (!res.success || !res.data) {
        toast.error(res.message || t('platform.leads.saveFailed'))
        return
      }
      const atualizado = res.data.lead
      setLeads((lista) => lista.map((item) => (item.id === atualizado.id ? atualizado : item)))
      if (patch.status) void carregar()
      else toast.success(t('platform.leads.saved'))
    } finally {
      setSalvando(null)
    }
  }

  const total = STATUSES.reduce((soma, status) => soma + (counts[status] ?? 0), 0)

  return (
    <section className="rounded-md border border-border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold text-foreground">{t('platform.leads.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('platform.leads.description')}</p>
        </div>
        <button type="button" className="modern-button-secondary shrink-0" disabled={loading} onClick={() => void carregar()}>
          <Icon name="refresh" size={16} className={loading ? 'animate-spin' : ''} />
          {t('common.refresh')}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={t('platform.leads.filter')}>
        <button
          type="button" onClick={() => setFiltro('')}
          className={filtro === '' ? 'modern-button' : 'modern-button-secondary'}
        >
          {t('platform.leads.all')} ({total})
        </button>
        {STATUSES.map((status) => (
          <button
            key={status} type="button" onClick={() => setFiltro(status)}
            className={filtro === status ? 'modern-button' : 'modern-button-secondary'}
          >
            {t(STATUS_KEYS[status])} ({counts[status] ?? 0})
          </button>
        ))}
      </div>

      {error && <p className="alert-error mt-4 text-sm">{error}</p>}
      {!loading && !error && leads.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">{t('platform.leads.empty')}</p>
      )}

      <div className="mt-4 space-y-3">
        {leads.map((lead) => {
          const wa = whatsappLink(lead.phone)
          return (
            <article key={lead.id} className="rounded-md border border-border p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground wrap-anywhere">{lead.name}</span>
                    {lead.company && <span className="text-sm text-muted-foreground">· {lead.company}</span>}
                    <span className={STATUS_BADGE[lead.status]}>{t(STATUS_KEYS[lead.status])}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">
                    {[
                      lead.city,
                      lead.devicesEstimate != null ? t('platform.leads.devices', { count: lead.devicesEstimate }) : null,
                      lead.planCode ? t('platform.leads.plan', { plan: lead.planCode }) : null,
                      quando(lead.createdAt)
                    ].filter(Boolean).join(' · ')}
                  </p>
                  {lead.message && (
                    <p className="mt-2 whitespace-pre-wrap text-sm text-foreground wrap-anywhere">{lead.message}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-3 text-sm">
                    {lead.email && (
                      <a className="inline-flex min-h-10 items-center underline wrap-anywhere sm:min-h-0" href={`mailto:${lead.email}`}>{lead.email}</a>
                    )}
                    {wa && (
                      <a className="inline-flex min-h-10 items-center underline sm:min-h-0" href={wa} target="_blank" rel="noreferrer">WhatsApp {lead.phone}</a>
                    )}
                  </div>
                </div>
                <div className="shrink-0">
                  <label className="sr-only" htmlFor={`lead-status-${lead.id}`}>{t('common.status')}</label>
                  <select
                    id={`lead-status-${lead.id}`} className="modern-input"
                    value={lead.status} disabled={salvando === lead.id}
                    onChange={(e) => void salvar(lead, { status: e.target.value as LeadStatus })}
                  >
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>{t(STATUS_KEYS[status])}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <label className="sr-only" htmlFor={`lead-notes-${lead.id}`}>{t('platform.leads.notes')}</label>
                <input
                  id={`lead-notes-${lead.id}`} className="modern-input min-w-0 flex-1"
                  placeholder={t('platform.leads.notes')} maxLength={4000}
                  value={notas[lead.id] ?? ''}
                  onChange={(e) => setNotas((n) => ({ ...n, [lead.id]: e.target.value }))}
                />
                <button
                  type="button" className="modern-button-secondary"
                  disabled={salvando === lead.id || (notas[lead.id] ?? '') === (lead.notes ?? '')}
                  onClick={() => void salvar(lead, { notes: notas[lead.id] ?? '' })}
                >
                  {t('common.save')}
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

export default PlatformLeads
