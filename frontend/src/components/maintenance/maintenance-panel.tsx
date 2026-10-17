'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  maintenanceAPI,
  type MaintenanceNode,
  type MaintenancePreview,
  type MaintenanceWindow,
  type MaintenanceWindowDetail
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'

/** A lista é relida de minuto em minuto: é a cadência do agendador que avisa. */
const POLL_MS = 60_000
const LEAD_OPTIONS = [2, 12, 24, 48] as const
/** O cartão do Dashboard só aparece para o que começa nas próximas 48 h. */
const DASHBOARD_WINDOW_MS = 48 * 60 * 60 * 1000

/** `YYYY-MM-DDTHH:mm` no fuso do navegador, o formato do `datetime-local`. */
function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Amanhã, das 02h às 04h: o horário mais comum de uma manutenção. */
function janelaPadrao() {
  const inicio = new Date()
  inicio.setDate(inicio.getDate() + 1)
  inicio.setHours(2, 0, 0, 0)
  const fim = new Date(inicio)
  fim.setHours(4)
  return { inicio: localInput(inicio), fim: localInput(fim) }
}

/**
 * O formulário de agendamento. Exportado porque o mapa abre o mesmo, com o
 * nó já escolhido.
 */
export function MaintenanceForm({ presetNodeId = '', onDone, onCancel }: {
  presetNodeId?: string
  onDone: (window: MaintenanceWindowDetail) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [padrao] = useState(janelaPadrao)
  const [nodes, setNodes] = useState<MaintenanceNode[] | null>(null)
  const [filtro, setFiltro] = useState('')
  const [nodeId, setNodeId] = useState(presetNodeId)
  const [inicio, setInicio] = useState(padrao.inicio)
  const [fim, setFim] = useState(padrao.fim)
  const [lead, setLead] = useState<number>(24)
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState<MaintenancePreview | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void maintenanceAPI.nodes().then((res) => setNodes(res.success && res.data ? res.data.nodes : []))
  }, [])

  useEffect(() => {
    if (!nodeId) return
    let vivo = true
    const inicioData = new Date(inicio)
    const fimData = new Date(fim)
    const janela = Number.isNaN(inicioData.getTime()) || Number.isNaN(fimData.getTime())
      ? undefined
      : { startsAt: inicioData.toISOString(), endsAt: fimData.toISOString() }
    // Um respiro enquanto a pessoa digita a hora, para não pedir a cada tecla.
    const timer = window.setTimeout(() => {
      void maintenanceAPI.preview(nodeId, janela).then((res) => {
        if (vivo && res.success && res.data) setPreview(res.data)
      })
    }, 300)
    return () => {
      vivo = false
      window.clearTimeout(timer)
    }
  }, [nodeId, inicio, fim])

  const visiveis = (nodes ?? []).filter((n) => {
    const busca = filtro.trim().toLowerCase()
    return !busca || n.name.toLowerCase().includes(busca) || n.nodeId.toLowerCase().includes(busca) || n.nodeId === nodeId
  })

  const salvar = async () => {
    setBusy(true)
    try {
      const res = await maintenanceAPI.create({
        nodeId,
        startsAt: new Date(inicio).toISOString(),
        endsAt: new Date(fim).toISOString(),
        leadHours: lead,
        message: message.trim() || undefined
      })
      if (res.success && res.data) {
        toast.success(t('maintenance.saved'))
        onDone(res.data)
      } else {
        toast.error(res.message || t('maintenance.failed'))
      }
    } finally {
      setBusy(false)
    }
  }

  const invalido = !nodeId || !inicio || !fim || new Date(fim) <= new Date(inicio)

  return (
    <div className="grid gap-4">
      <div>
        <label htmlFor="maintenance-node" className="mb-1 block text-sm font-medium">{t('maintenance.node')}</label>
        {nodes !== null && nodes.length > 12 && (
          <input
            className="modern-input mb-2 w-full"
            value={filtro}
            placeholder={t('maintenance.nodeFilter')}
            aria-label={t('maintenance.nodeFilter')}
            onChange={(event) => setFiltro(event.target.value)}
          />
        )}
        <select
          id="maintenance-node"
          className="modern-input w-full"
          value={nodeId}
          onChange={(event) => setNodeId(event.target.value)}
        >
          <option value="">{nodes === null ? t('common.loading') : t('maintenance.nodePick')}</option>
          {visiveis.map((n) => (
            <option key={n.nodeId} value={n.nodeId}>{`${n.name} (${n.type.toUpperCase()})`}</option>
          ))}
        </select>
        {nodes !== null && nodes.length === 0 && <p className="field-hint">{t('maintenance.noNodes')}</p>}
        {preview && nodeId && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t('maintenance.preview', { affected: preview.affected, phones: preview.withPhone })}
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="maintenance-start" className="mb-1 block text-sm font-medium">{t('maintenance.start')}</label>
          <input id="maintenance-start" type="datetime-local" className="modern-input w-full" value={inicio} onChange={(event) => setInicio(event.target.value)} />
        </div>
        <div>
          <label htmlFor="maintenance-end" className="mb-1 block text-sm font-medium">{t('maintenance.end')}</label>
          <input id="maintenance-end" type="datetime-local" className="modern-input w-full" value={fim} onChange={(event) => setFim(event.target.value)} />
        </div>
        <div>
          <label htmlFor="maintenance-lead" className="mb-1 block text-sm font-medium">{t('maintenance.lead')}</label>
          <select id="maintenance-lead" className="modern-input w-full" value={lead} onChange={(event) => setLead(Number(event.target.value))}>
            {LEAD_OPTIONS.map((h) => <option key={h} value={h}>{t('maintenance.leadOption', { count: h })}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="maintenance-message" className="mb-1 block text-sm font-medium">{t('maintenance.message')}</label>
        <textarea
          id="maintenance-message"
          className="modern-input w-full text-sm"
          rows={3}
          maxLength={1000}
          value={message}
          placeholder={nodeId ? preview?.sampleNotice ?? '' : ''}
          onChange={(event) => setMessage(event.target.value)}
        />
        <p className="field-hint">{t('maintenance.messageHint')}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="modern-button-secondary" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="modern-button" disabled={busy || invalido} onClick={() => void salvar()}>
          {t('maintenance.save')}
        </button>
      </div>
    </div>
  )
}

const STATUS_BADGE: Record<MaintenanceWindow['status'], string> = {
  scheduled: 'modern-badge-info',
  active: 'modern-badge-warning',
  done: 'modern-badge-success',
  cancelled: 'inline-flex items-center rounded bg-muted px-2 py-1 text-xs font-semibold leading-none text-muted-foreground'
}
const STATUS_KEY = {
  scheduled: 'maintenance.statusScheduled',
  active: 'maintenance.statusActive',
  done: 'maintenance.statusDone',
  cancelled: 'maintenance.statusCancelled'
} as const satisfies Record<MaintenanceWindow['status'], string>

function Janela({ item, agora, onChange }: { item: MaintenanceWindow; agora: number; onChange: () => void }) {
  const { t, formatDateTime } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const podeAvisar = can('whatsapp.send')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<MaintenanceWindowDetail | null>(null)
  const aberta = item.status === 'scheduled' || item.status === 'active'
  const pendentes = Math.max(0, item.withPhone - item.notified)

  const executar = async (confirmacao: string, fazer: () => Promise<{ success: boolean; message?: string }>, ok?: string) => {
    if (!window.confirm(confirmacao)) return
    setBusy(true)
    try {
      const res = await fazer()
      if (res.success) {
        if (ok) toast.success(ok)
        onChange()
      } else {
        toast.error(res.message || t('maintenance.failed'))
      }
    } finally {
      setBusy(false)
    }
  }

  const alternarLista = async () => {
    if (detail) {
      setDetail(null)
      return
    }
    const res = await maintenanceAPI.get(item.id)
    if (res.success && res.data) setDetail(res.data)
  }

  return (
    <div className={`rounded-md border p-3 sm:p-4 ${item.status === 'active' ? 'border-[hsl(var(--status-warning))]/60 bg-[hsl(var(--status-warning))]/5' : 'border-border'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-start gap-2 font-semibold wrap-anywhere">
            <Icon name="settings" size={16} className="mt-1 shrink-0 text-muted-foreground" />
            {t('maintenance.cardTitle', { node: item.nodeName })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('maintenance.window', { start: formatDateTime(item.startsAt), end: formatDateTime(item.endsAt) })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('maintenance.counts', { affected: item.affected, phones: item.withPhone, notified: item.notified })}
          </p>
          <p className={`mt-1 text-sm ${item.noticeSentAt ? 'text-[hsl(var(--status-success))]' : 'text-muted-foreground'}`}>
            {item.noticeSentAt
              ? t('maintenance.noticeSent', { when: formatDateTime(item.noticeSentAt) })
              : !aberta ? t('maintenance.noNotice')
                // Passou da hora e não saiu: só acontece sem número de atendimento conectado.
                : new Date(item.noticeAt).getTime() < agora ? t('maintenance.noticePending')
                  : t('maintenance.noticeAt', { when: formatDateTime(item.noticeAt) })}
            {item.closingSentAt ? ` · ${t(item.status === 'cancelled' ? 'maintenance.cancelSent' : 'maintenance.doneSent')}` : ''}
          </p>
        </div>
        <span className={STATUS_BADGE[item.status]}>{t(STATUS_KEY[item.status])}</span>
      </div>

      {aberta && podeAvisar && (
        <div className="mt-4 flex flex-wrap gap-2">
          {pendentes > 0 && (
            <button
              type="button"
              className="modern-button"
              disabled={busy}
              onClick={() => void executar(
                t('maintenance.confirmNotify', { count: pendentes }),
                async () => {
                  const res = await maintenanceAPI.notify(item.id)
                  if (res.success && res.data) toast.success(t('maintenance.notifiedToast', { count: res.data.sent }))
                  return res
                }
              )}
            >
              {t('maintenance.notifyNow', { count: pendentes })}
            </button>
          )}
          {item.status === 'active' && (
            <button
              type="button"
              className="modern-button-secondary"
              disabled={busy}
              onClick={() => void executar(t('maintenance.confirmConclude'), () => maintenanceAPI.conclude(item.id), t('maintenance.concludedToast'))}
            >
              {t('maintenance.conclude')}
            </button>
          )}
          <button
            type="button"
            className="modern-button-secondary text-[hsl(var(--status-danger))]"
            disabled={busy}
            onClick={() => void executar(
              t(item.noticeSentAt ? 'maintenance.confirmCancelNotified' : 'maintenance.confirmCancel'),
              () => maintenanceAPI.cancel(item.id),
              t('maintenance.cancelledToast')
            )}
          >
            {t('maintenance.cancel')}
          </button>
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
 * As manutenções programadas. `compact` é o Dashboard: só aparece com
 * manutenção em andamento ou começando nas próximas 48 h, sem o formulário.
 */
export function MaintenancePanel({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const [items, setItems] = useState<MaintenanceWindow[] | null>(null)
  // O relógio da última leitura, para o recorte das 48 h do Dashboard.
  const [lidoEm, setLidoEm] = useState(0)
  const [agendando, setAgendando] = useState(false)

  const load = useCallback(async () => {
    const res = await maintenanceAPI.list()
    if (res.success && res.data) {
      setItems(res.data.windows)
      setLidoEm(Date.now())
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const lista = (items ?? []).filter((item) => !compact
    || item.status === 'active'
    || (item.status === 'scheduled' && new Date(item.startsAt).getTime() - lidoEm <= DASHBOARD_WINDOW_MS))
  if (compact && lista.length === 0) return null

  return (
    <section className="modern-card mb-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="section-heading">{t('maintenance.title')}</h2>
          {!compact && <p className="field-hint mt-1">{t('maintenance.description')}</p>}
        </div>
        {!compact && can('whatsapp.send') && !agendando && (
          <button type="button" className="modern-button" onClick={() => setAgendando(true)}>
            {t('maintenance.schedule')}
          </button>
        )}
      </div>
      {agendando && (
        <div className="mt-4 rounded-md border border-border p-3 sm:p-4">
          <h3 className="mb-3 font-semibold">{t('maintenance.formTitle')}</h3>
          <MaintenanceForm
            onCancel={() => setAgendando(false)}
            onDone={() => {
              setAgendando(false)
              void load()
            }}
          />
        </div>
      )}
      <div className="mt-4 grid gap-3">
        {items === null && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
        {items !== null && lista.length === 0 && <p className="text-sm text-muted-foreground">{t('maintenance.empty')}</p>}
        {lista.map((item) => (
          <Janela key={`${item.id}-${item.status}-${item.noticeSentAt ?? ''}-${item.closingSentAt ?? ''}`} item={item} agora={lidoEm} onChange={() => void load()} />
        ))}
      </div>
    </section>
  )
}

export default MaintenancePanel
