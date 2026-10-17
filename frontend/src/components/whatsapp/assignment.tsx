'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type WhatsAppAgent, type WhatsAppConversation } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

/** O pulso: o servidor conta como online quem mandou um nos últimos 3 min. */
const PULSE_MS = 60_000

/**
 * O interruptor "Disponível" de quem atende.
 *
 * Disponível, a tela reenvia o estado a cada minuto enquanto a aba está à
 * vista — é esse pulso que faz o servidor entregar conversas. Fechar a aba
 * para o pulso, e em três minutos a pessoa sai do rodízio sozinha.
 */
export function AvailabilityToggle() {
  const { t } = useTranslation()
  const { can, user } = useAuth()
  const toast = useToast()
  const [available, setAvailable] = useState<boolean | null>(null)
  const [open, setOpen] = useState(0)
  const [saving, setSaving] = useState(false)
  const allowed = can('whatsapp.send')
  const availableRef = useRef(false)

  useEffect(() => {
    if (!allowed || !user) return
    let cancelled = false
    void whatsappAPI.listAgents().then((res) => {
      if (cancelled || !res.success || !res.data) return
      const eu = res.data.find((a) => a.userId === user.id)
      setAvailable(Boolean(eu?.available))
      setOpen(eu?.openConversations ?? 0)
    })
    return () => { cancelled = true }
  }, [allowed, user])

  useEffect(() => { availableRef.current = available === true }, [available])

  useEffect(() => {
    if (!allowed) return
    const pulse = () => {
      if (!availableRef.current || document.visibilityState !== 'visible') return
      void whatsappAPI.setAvailability(true).then((res) => {
        if (res.success && res.data) setOpen(res.data.openConversations)
      })
    }
    const timer = window.setInterval(pulse, PULSE_MS)
    document.addEventListener('visibilitychange', pulse)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', pulse)
    }
  }, [allowed])

  if (!allowed || available === null) return null

  const toggle = async () => {
    setSaving(true)
    try {
      const res = await whatsappAPI.setAvailability(!available)
      if (res.success && res.data) {
        setAvailable(res.data.available)
        setOpen(res.data.openConversations)
      } else {
        toast.error(whatsappErrorMessage(t, res.code))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={available}
      disabled={saving}
      onClick={() => void toggle()}
      title={t('whatsapp.assign.availableHint')}
      className={`inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors ${
        available
          ? 'border-[hsl(var(--status-success)/0.4)] bg-[hsl(var(--status-success)/0.12)] text-[hsl(var(--status-success))]'
          : 'border-border text-muted-foreground hover:bg-[hsl(var(--surface-subtle))]'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${available ? 'bg-[hsl(var(--status-success))]' : 'bg-muted-foreground/50'}`} />
      {available ? t('whatsapp.assign.available') : t('whatsapp.assign.unavailable')}
      {available && open > 0 && <span className="tabular-nums opacity-80">· {open}</span>}
    </button>
  )
}

/**
 * Quem atende esta conversa: assumir, transferir para um colega ou soltar.
 * A lista da equipe é lida ao abrir o seletor, não a cada conversa aberta.
 */
export function AssigneeControl({ conversation, onChange }: {
  conversation: WhatsAppConversation
  onChange: (next: WhatsAppConversation) => void
}) {
  const { t } = useTranslation()
  const { can, user } = useAuth()
  const toast = useToast()
  const [agents, setAgents] = useState<WhatsAppAgent[] | null>(null)
  const [saving, setSaving] = useState(false)

  const loadAgents = useCallback(async () => {
    if (agents) return
    const res = await whatsappAPI.listAgents()
    if (res.success && res.data) setAgents(res.data)
  }, [agents])

  if (!can('whatsapp.send')) {
    return conversation.assignedTo
      ? <span className="modern-badge"><Icon name="contacts" size={12} />{conversation.assignedTo}</span>
      : null
  }

  const assign = async (userId: number | null) => {
    setSaving(true)
    try {
      const res = await whatsappAPI.assignConversation(conversation.id, userId)
      if (res.success && res.data) onChange(res.data)
      else toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setSaving(false)
    }
  }

  const mine = user && conversation.assignedUserId === user.id
  const options = agents ?? (conversation.assignedUserId
    ? [{ userId: conversation.assignedUserId, name: conversation.assignedTo ?? null, available: false, online: false, openConversations: 0 }]
    : [])

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {user && !mine && (
        <button
          type="button"
          className="modern-button-secondary min-h-8 px-2.5 py-1 text-xs"
          disabled={saving}
          onClick={() => void assign(user.id)}
        >
          {t('whatsapp.assign.takeOver')}
        </button>
      )}
      <label className="sr-only" htmlFor={`assignee-${conversation.id}`}>{t('whatsapp.assign.agent')}</label>
      <select
        id={`assignee-${conversation.id}`}
        className="h-8 max-w-48 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        value={conversation.assignedUserId ?? ''}
        disabled={saving}
        onFocus={() => void loadAgents()}
        onPointerDown={() => void loadAgents()}
        onChange={(event) => void assign(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">{t('whatsapp.assign.nobody')}</option>
        {options.map((a) => (
          <option key={a.userId} value={a.userId}>
            {(a.name ?? `#${a.userId}`) + (a.online ? ` · ${t('whatsapp.assign.online')}` : '')}
          </option>
        ))}
      </select>
    </div>
  )
}
