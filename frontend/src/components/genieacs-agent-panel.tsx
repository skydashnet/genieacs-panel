'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiResponse, GenieAcsAgentStatus, GenieAcsAgentToken, GenieAcsConnectionMode } from '@/lib/api'
import {
  AGENT_POLL_MS,
  agentFileUrl,
  agentPhase,
  connectedSince,
  installCommand,
  keyAction,
  keyButtonState,
  pollBackoffMs,
  type AgentPhase
} from '@/lib/genieacs-agent'
import type { TranslationKey } from '@/lib/i18n'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { copyToClipboard, formatRelativeTime } from '@/lib/utils'

interface Props {
  /** Prefixo dos `id` dos campos: a tela do console tem um bloco por provedor aberto. */
  idPrefix: string
  /** O estado que a tela já leu — o bloco o usa até a primeira leitura própria. */
  initialStatus: GenieAcsAgentStatus | null
  /** O modo GRAVADO: é ele, e não o do seletor, que o servidor confere ao gerar a chave. */
  savedMode: GenieAcsConnectionMode
  /** Quem pode gravar o GenieACS deste provedor. Sem isso, o bloco é só leitura. */
  canWrite: boolean
  /** Relê o estado. Serve as duas rotas: as duas respondem um objeto com `agent`. */
  fetchStatus: () => Promise<ApiResponse<{ agent?: GenieAcsAgentStatus }>>
  /** Gera a chave. A resposta traz a chave inteira uma vez só. */
  generateToken: () => Promise<ApiResponse<GenieAcsAgentToken>>
  /** Avisa a tela de cima quando o estado muda, para ela não guardar um velho. */
  onStatus?: (agent: GenieAcsAgentStatus) => void
}

const PHASE_LABELS: Record<AgentPhase, TranslationKey> = {
  connected: 'genieacsAgent.phase.connected',
  disconnected: 'genieacsAgent.phase.disconnected',
  never: 'genieacsAgent.phase.never',
  'no-key': 'genieacsAgent.phase.noKey'
}

const PHASE_DOT: Record<AgentPhase, string> = {
  connected: 'bg-[hsl(var(--status-success))]',
  disconnected: 'bg-[hsl(var(--status-danger))]',
  never: 'bg-[hsl(var(--status-warning))]',
  'no-key': 'bg-muted-foreground/50'
}

/**
 * O bloco "Agente": o estado da conexão, a chave e como instalar.
 *
 * Um componente só para as duas telas que cuidam disso — o console da
 * plataforma e as Configurações do provedor —, com as chamadas de API vindas
 * por props: as rotas são outras, a pergunta e o desenho são os mesmos, e duas
 * cópias deste bloco divergiriam na primeira correção.
 *
 * A chave inteira aparece UMA vez, logo depois de gerada, e mora só no estado
 * deste componente: sair da tela, trocar de aba ou mudar o modo o desmonta, e
 * ela some. O servidor guarda só o hash — não há como mostrá-la de novo, e a
 * tela diz isso ao lado dela, porque é agora que a pessoa precisa copiar.
 *
 * O estado se relê sozinho a cada 15 s enquanto o bloco está na tela e a aba
 * está visível: quem abre isto está, quase sempre, instalando o agente na outra
 * máquina e esperando a bolinha ficar verde. As quatro regras de toda leitura
 * periódica do painel (ver a tira de saúde do WhatsApp): uma leitura por vez,
 * aba escondida pula o passo, servidor falhando recua em exponencial, e o
 * relógio é de um efeito que limpa ao desmontar.
 */
export function GenieAcsAgentPanel({
  idPrefix,
  initialStatus,
  savedMode,
  canWrite,
  fetchStatus,
  generateToken,
  onStatus
}: Props) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [agent, setAgent] = useState<GenieAcsAgentStatus | null>(initialStatus)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  // A tela de cima releu (salvou, trocou de provedor): o que ela tem é mais
  // novo que o nosso.
  useEffect(() => { setAgent(initialStatus) }, [initialStatus])

  const alive = useRef(true)
  const inFlight = useRef(false)
  const failures = useRef(0)
  const blockedUntil = useRef(0)
  // `fetchStatus` e `onStatus` chegam como funções novas a cada render da tela
  // de cima; guardadas em ref, o relógio não é recriado por isso.
  const fetchRef = useRef(fetchStatus)
  const onStatusRef = useRef(onStatus)
  useEffect(() => {
    fetchRef.current = fetchStatus
    onStatusRef.current = onStatus
  })

  const reload = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await fetchRef.current()
      if (!alive.current) return
      if (res.success && res.data?.agent) {
        failures.current = 0
        blockedUntil.current = 0
        setAgent(res.data.agent)
        onStatusRef.current?.(res.data.agent)
      } else {
        failures.current += 1
        blockedUntil.current = Date.now() + pollBackoffMs(failures.current)
      }
    } catch {
      if (!alive.current) return
      failures.current += 1
      blockedUntil.current = Date.now() + pollBackoffMs(failures.current)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    alive.current = true
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() < blockedUntil.current) return
      void reload()
    }, AGENT_POLL_MS)
    // Voltar à aba relê na hora, sem esperar o próximo passo: é o momento em
    // que a pessoa volta da outra máquina para ver se conectou.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() >= blockedUntil.current) void reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [reload])

  const phase = agentPhase(agent)
  const action = keyAction(agent)
  const button = keyButtonState({ canWrite, savedMode })
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const comando = installCommand(origin)

  const copiar = async (texto: string) => {
    if (await copyToClipboard(texto)) toast.success(t('common.copied'))
    else toast.error(t('genieacsAgent.copyFailed'))
  }

  const gerar = async () => {
    // Só pergunta quando há um agente a derrubar: a primeira chave não
    // desconecta ninguém.
    if (action === 'regenerate' && !window.confirm(t('genieacsAgent.regenerateConfirm'))) return
    setGenerating(true)
    try {
      const res = await generateToken()
      if (!alive.current) return
      if (res.success && res.data) {
        setNewToken(res.data.token)
        setAgent(res.data.agent)
        onStatusRef.current?.(res.data.agent)
        toast.success(t('genieacsAgent.keyGenerated'))
      } else {
        toast.error(res.message || t('genieacsAgent.keyFailed'))
      }
    } finally {
      if (alive.current) setGenerating(false)
    }
  }

  const estadoDetalhe = (() => {
    if (!agent) return null
    if (phase === 'connected') {
      return [
        agent.version ? t('genieacsAgent.version', { version: agent.version }) : null,
        connectedSince(agent) ? t('genieacsAgent.connectedSince', { when: formatDateTime(connectedSince(agent) as string) }) : null
      ].filter(Boolean).join(' · ')
    }
    if (phase === 'disconnected' && agent.lastSeenAt) {
      return t('genieacsAgent.lastSeen', { when: formatRelativeTime(agent.lastSeenAt) })
    }
    if (phase === 'never') return t('genieacsAgent.neverHint')
    return t('genieacsAgent.noKeyHint')
  })()

  return (
    <section
      className="rounded-md border border-border bg-muted/30 p-4"
      aria-labelledby={`${idPrefix}-agent-title`}
    >
      <h4 id={`${idPrefix}-agent-title`} className="font-semibold text-foreground">{t('genieacsAgent.title')}</h4>

      <div className="mt-3 flex items-start gap-3" role="status" aria-live="polite">
        <span className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${PHASE_DOT[phase]}`} aria-hidden="true" />
        <div className="min-w-0 text-sm">
          <p className="font-medium text-foreground">{t(PHASE_LABELS[phase])}</p>
          {estadoDetalhe && <p className="mt-0.5 text-muted-foreground">{estadoDetalhe}</p>}
        </div>
      </div>

      {agent?.tokenHint && (
        <p className="mt-3 text-sm text-muted-foreground">
          {agent.tokenCreatedAt
            ? t('genieacsAgent.keyHint', { hint: agent.tokenHint, when: formatDateTime(agent.tokenCreatedAt) })
            : t('genieacsAgent.keyHintNoDate', { hint: agent.tokenHint })}
        </p>
      )}

      {button !== 'hidden' && (
        <div className="mt-3">
          <button
            type="button"
            className={action === 'regenerate' ? 'modern-button-secondary' : 'modern-button'}
            disabled={generating || button === 'save-first'}
            onClick={() => void gerar()}
          >
            <Icon name="lock" size={16} />
            {generating
              ? t('genieacsAgent.generating')
              : t(action === 'regenerate' ? 'genieacsAgent.regenerate' : 'genieacsAgent.generate')}
          </button>
          {button === 'save-first' && <p className="field-hint">{t('genieacsAgent.saveFirst')}</p>}
        </div>
      )}

      {newToken && (
        <div className="mt-3 rounded-md border border-[hsl(var(--status-warning)/0.45)] bg-[hsl(var(--status-warning)/0.08)] p-3">
          <label htmlFor={`${idPrefix}-agent-key`} className="field-label">{t('genieacsAgent.newKeyLabel')}</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={`${idPrefix}-agent-key`}
              type="text"
              readOnly
              className="modern-input w-full font-mono text-xs"
              value={newToken}
              onFocus={(e) => e.target.select()}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" className="modern-button-secondary shrink-0" onClick={() => void copiar(newToken)}>
              <Icon name="copy" size={16} /> {t('common.copy')}
            </button>
          </div>
          <p className="mt-2 flex items-start gap-2 text-sm font-medium text-foreground">
            <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
            {t('genieacsAgent.newKeyWarning')}
          </p>
        </div>
      )}

      <div className="mt-4 border-t border-border pt-4">
        <h5 className="text-sm font-semibold text-foreground">{t('genieacsAgent.installTitle')}</h5>
        <p className="mt-1 text-sm text-muted-foreground">{t('genieacsAgent.installHint')}</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <code
            className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
            aria-label={t('genieacsAgent.installTitle')}
          >
            {comando}
          </code>
          <button type="button" className="modern-button-secondary shrink-0" onClick={() => void copiar(comando)}>
            <Icon name="copy" size={16} /> {t('common.copy')}
          </button>
        </div>
        <p className="field-hint mt-2">{t('genieacsAgent.installKeyNote')}</p>
        <p className="mt-2 text-sm">
          <a
            href={agentFileUrl(origin)}
            download
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
          >
            <Icon name="document" size={15} />
            {t('genieacsAgent.downloadFile')}
          </a>
        </p>
      </div>
    </section>
  )
}
