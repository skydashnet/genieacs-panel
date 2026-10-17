'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { storedSession, whatsappAPI } from '@/lib/api'
import { sessionOwner } from '@/lib/session-owner'
import {
  focusedConversation,
  latestPerConversation,
  notifierActive,
  playChime,
  readNotifyPref,
  shouldNotify,
  writeNotifyPref
} from '@/lib/wa-notify'

/** Meio minuto. Em segundo plano o navegador pode espaçar para um. */
const POLL_MS = 30_000

/** Avisado pelo sino quando a pessoa liga ou desliga, para o vigia não esperar o próximo ciclo. */
const PREF_EVENT = 'wa-notify-change'

const suportado = () => typeof window !== 'undefined' && 'Notification' in window

const ligado = (owner: string | null) => suportado() && readNotifyPref(owner) && Notification.permission === 'granted'

/**
 * O dono da sessão desta aba e se o vigia vale para ela. A aba de
 * personificação fica de fora: a sessão é da aba (`storedSession`), e o
 * `user.impersonation` confirma mesmo antes de a gaveta ser lida de novo.
 */
function useNotifierSession() {
  const { user } = useAuth()
  const owner = sessionOwner(user)
  const tabScoped = Boolean(user?.impersonation) || storedSession().tabScoped
  return { owner, active: notifierActive({ owner, tabScoped }) }
}

/**
 * O vigia das mensagens novas: toca e mostra a notificação do sistema quando
 * um cliente escreve numa conversa sua — ou numa sem atendente que espera
 * gente —, mesmo com o painel em outra aba. Fica na casca para valer em
 * qualquer tela; não desenha nada.
 *
 * A primeira leitura só pega o cursor do servidor: abrir o painel não
 * despeja o atrasado em notificações.
 */
export function WhatsAppMessageNotifier() {
  const { can } = useAuth()
  const { owner, active } = useNotifierSession()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const allowed = can('whatsapp.read') && active
  const cursor = useRef<string | null>(null)
  const inFlight = useRef(false)
  const montado = useRef(false)
  const ownerRef = useRef(owner)
  // As notificações que este vigia abriu: fechadas ao sair da sessão, para o
  // aviso do provedor A não ficar na tela de quem entra depois.
  const abertas = useRef(new Set<Notification>())
  const tRef = useRef(t)
  const navigateRef = useRef(navigate)
  useEffect(() => { tRef.current = t }, [t])
  useEffect(() => { navigateRef.current = navigate }, [navigate])
  useEffect(() => { ownerRef.current = owner }, [owner])

  const fecharTodas = useCallback(() => {
    for (const n of abertas.current) {
      try { n.close() } catch { /* já fechada */ }
    }
    abertas.current.clear()
  }, [])

  const tick = useCallback(async () => {
    const dono = ownerRef.current
    if (!ligado(dono)) {
      // Desligado, esquece o cursor: religar começa do agora, não do passado.
      cursor.current = null
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await whatsappAPI.getNotifications(cursor.current)
      // A resposta é da sessão que perguntou: se o vigia saiu de cena ou a
      // sessão trocou de dono no meio, ela não vale para quem está aqui agora.
      if (!montado.current || ownerRef.current !== dono) return
      if (!res.success || !res.data) return
      const primeira = cursor.current === null
      cursor.current = res.data.cursor
      if (primeira || !ligado(dono)) return
      const visible = document.visibilityState === 'visible'
      const avisar = latestPerConversation(res.data.items)
        .filter((item) => shouldNotify(item, { focusedConversationId: focusedConversation.id, visible }))
      if (!avisar.length) return
      playChime()
      for (const item of avisar) {
        const tr = tRef.current
        const n = new Notification(item.contact || tr('whatsapp.notify.unknownContact'), {
          body: item.preview || (item.hasAttachment ? tr('whatsapp.notify.attachment') : ''),
          tag: `wa-conv-${item.conversationId}`
        })
        abertas.current.add(n)
        n.onclose = () => { abertas.current.delete(n) }
        n.onclick = () => {
          window.focus()
          navigateRef.current(`/whatsapp?conversation=${item.conversationId}`)
          n.close()
        }
      }
    } finally {
      inFlight.current = false
    }
  }, [])

  // Saiu da sessão (logout, token expirado, outra aba saiu): fecha o que ficou aberto.
  useEffect(() => {
    montado.current = true
    window.addEventListener('auth:unauthorized', fecharTodas)
    return () => {
      montado.current = false
      window.removeEventListener('auth:unauthorized', fecharTodas)
      fecharTodas()
    }
  }, [fecharTodas])

  useEffect(() => {
    if (!allowed || !suportado()) return
    // Dono novo, cursor novo: o da sessão anterior não diz nada a esta.
    cursor.current = null
    void tick()
    const timer = window.setInterval(() => void tick(), POLL_MS)
    const mudou = () => void tick()
    window.addEventListener(PREF_EVENT, mudou)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(PREF_EVENT, mudou)
      fecharTodas()
    }
  }, [allowed, owner, tick, fecharTodas])

  return null
}

type Estado = 'on' | 'off' | 'blocked'

function estadoAtual(owner: string | null): Estado {
  if (Notification.permission === 'denied') return 'blocked'
  return ligado(owner) ? 'on' : 'off'
}

/**
 * O sino ao lado de "Disponível": liga e desliga as notificações neste
 * navegador, para a sessão de quem está nele. Ligar pede a permissão do
 * sistema na primeira vez; bloqueada, o botão diz como liberar. Sem suporte
 * no navegador, ou numa aba de personificação, não aparece.
 */
export function NotifyToggle() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const { owner, active } = useNotifierSession()
  const [estado, setEstado] = useState<Estado>(() => (suportado() ? estadoAtual(owner) : 'off'))

  // Trocou o dono, relê a preferência dele.
  useEffect(() => {
    if (suportado()) setEstado(estadoAtual(owner))
  }, [owner])

  if (!suportado() || !active || !can('whatsapp.read')) return null

  const alternar = async () => {
    if (estado === 'on') {
      writeNotifyPref(owner, false)
    } else {
      let permissao = Notification.permission
      if (permissao === 'default') permissao = await Notification.requestPermission()
      writeNotifyPref(owner, permissao === 'granted')
      // Um toque agora: confirma o som e destrava o áudio do navegador.
      if (permissao === 'granted') playChime()
    }
    setEstado(estadoAtual(owner))
    window.dispatchEvent(new Event(PREF_EVENT))
  }

  const dica = estado === 'on'
    ? t('whatsapp.notify.onHint')
    : estado === 'blocked' ? t('whatsapp.notify.blockedHint') : t('whatsapp.notify.offHint')

  return (
    <button
      type="button"
      role="switch"
      aria-checked={estado === 'on'}
      aria-label={t('whatsapp.notify.button')}
      title={dica}
      onClick={() => void alternar()}
      className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors ${
        estado === 'on'
          ? 'border-[hsl(var(--status-success)/0.4)] bg-[hsl(var(--status-success)/0.12)] text-[hsl(var(--status-success))]'
          : estado === 'blocked'
            ? 'border-[hsl(var(--status-warning)/0.4)] text-[hsl(var(--status-warning))]'
            : 'border-border text-muted-foreground hover:bg-[hsl(var(--surface-subtle))]'
      }`}
    >
      <Icon name="bell" size={14} />
      <span className="hidden sm:inline">
        {estado === 'on' ? t('whatsapp.notify.on') : estado === 'blocked' ? t('whatsapp.notify.blocked') : t('whatsapp.notify.off')}
      </span>
    </button>
  )
}
