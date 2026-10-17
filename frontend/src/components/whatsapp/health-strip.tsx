'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { whatsappAPI, type WhatsAppHealth } from '@/lib/api'
import type { TranslationKey, TranslationVars } from '@/lib/i18n'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { formatRelativeTime } from '@/lib/utils'
import { healthActions, type HealthActions } from '@/lib/wa-health-actions'
import { healthBadge, type HealthTone } from '@/lib/wa-health-badge'

// ─────────────────────────────────────────────────────────────────────────────
// Polling
//
// Slower than anything else on this page, and it should be: the inbox list at
// 15 s is the screen's freshness promise, and this is a summary of the last day.
// A minute is fast enough that an operator who breaks something and comes back
// to look sees it, and slow enough that leaving `/whatsapp` open in a
// background tab all afternoon costs the panel almost nothing.
//
// The four rules are the ones the pairing block and the inbox already prove,
// and they are not optional for a screen that runs unattended for hours:
// single-flight so a slow round trip is never queued behind itself, a hidden
// tab skips the tick entirely, a failing server is backed off
// `2 ** failures - 1` ticks instead of hammered, and the timer is owned by an
// effect that clears on unmount — an interval that outlived this component
// would poll the panel forever.
// ─────────────────────────────────────────────────────────────────────────────
const HEALTH_POLL_MS = 60_000
const BACKOFF_CAP = 6

/**
 * How long a message may sit in the queue before the strip says so loudly.
 *
 * The outbox worker ticks every five seconds, so a message still waiting after
 * half an hour is not the worker being busy — it is the worker being stopped,
 * the Evolution server being unreachable, or the number being logged out.
 *
 * It CAN fire honestly on a large campaign held back by the per-minute rate
 * limit, and that is the bias on purpose. The cost of an operator glancing at a
 * queue that turns out to be draining normally is a glance. The cost of the
 * other error — a stuck queue that looks calm — is the failure this whole strip
 * exists to end: nobody finds out until a customer complains.
 */
const STUCK_QUEUE_MS = 30 * 60 * 1000

/**
 * How long the panel may hear nothing before silence becomes an alarm.
 *
 * An ISP with subscribers does not go a full day without one person writing in.
 * Nothing for 24 h is a webhook that stopped, and the queue cannot report it —
 * an empty outbox is exactly what a dead webhook looks like.
 */
const SILENCE_MS = 24 * 60 * 60 * 1000

/** Loud, worth noticing, or background. Nothing in between. */
type Tone = HealthTone

/** One thing the strip has to say. */
interface Note {
  key: string
  tone: Tone
  icon: string
  text: string
}

const TONE_CLASS: Record<Tone, string> = {
  // A number that cannot send, or a queue that stopped: this is why the
  // operator came to look, and it must not be able to hide next to a file
  // count. Filled rather than tinted, because a red-on-white outline reads as
  // decoration once there are three of them on a row.
  alarm:
    'border-[hsl(var(--status-danger)/0.45)] bg-[hsl(var(--status-danger)/0.12)] '
    + 'text-[hsl(var(--status-danger))] font-semibold',
  warn:
    'border-[hsl(var(--status-warning)/0.4)] bg-[hsl(var(--status-warning)/0.1)] '
    + 'text-[hsl(var(--status-warning))] font-medium',
  // Everything is fine. Fine is not news, so it is drawn like a caption.
  calm: 'border-border bg-transparent text-muted-foreground'
}

const TONE_ICON: Record<Tone, string> = {
  alarm: 'warning',
  warn: 'info',
  calm: 'check'
}

/**
 * Bytes as an operator reads them.
 *
 * Binary steps with the decimal names everyone actually uses; the precision
 * drops as the unit grows because "1.4 GB" is the whole message and "1.44 GB"
 * is noise. `Intl` does the decimal separator, so this reads correctly in
 * pt-BR and de as well as en.
 */
function formatBytes(bytes: number, format: (value: number, options?: Intl.NumberFormatOptions) => string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 B`
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : 1
  return `${format(value, { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${units[unit]}`
}

/** Milliseconds since an ISO instant, or null when there is no instant. */
function ageOf(iso: string | null): number | null {
  if (!iso) return null
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : Date.now() - at
}

/**
 * The whole strip, decided in one place.
 *
 * Separated from the rendering deliberately: what counts as alarming is the
 * only judgement in this component, and it is easier to argue about — and to
 * change — as a list of rules than as branches inside JSX.
 */
function notesFor(
  health: WhatsAppHealth,
  t: (key: TranslationKey, vars?: TranslationVars) => string,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
): Note[] {
  const notes: Note[] = []
  const anyConnected = health.accounts.connected > 0

  // 1. Can it send at all? Nothing below matters if the answer is no.
  notes.push(anyConnected
    ? {
      key: 'accounts',
      tone: 'calm',
      icon: 'phone',
      text: t('whatsapp.health.connected', {
        connected: health.accounts.connected,
        total: health.accounts.total
      })
    }
    : {
      key: 'accounts',
      tone: 'alarm',
      icon: 'phone',
      text: t('whatsapp.health.noNumbers')
    })

  // 2. The queue, and the timestamp that gives the count its meaning. Forty
  //    queued a minute old is a busy afternoon; one queued since yesterday is
  //    the panel gone silent, and only `oldestQueuedAt` separates them — so the
  //    age, not the count, picks the tone.
  const waiting = health.outbox.queued + health.outbox.sending
  if (waiting > 0) {
    const stuckFor = ageOf(health.outbox.oldestQueuedAt)
    const stuck = stuckFor !== null && stuckFor > STUCK_QUEUE_MS
    const queued = t('whatsapp.health.queued', { count: formatNumber(waiting) })
    // `oldestQueuedAt` counts only rows that are DUE, so a queue whose whole
    // backlog is backing off has no age here and cannot read as stuck. The
    // retry count is what explains the gap between the two numbers — without
    // it, "40 waiting" with no age looks like a bug in the panel.
    const parts = [queued]
    if (health.outbox.oldestQueuedAt) {
      parts.push(t('whatsapp.health.oldestQueued', {
        when: formatRelativeTime(health.outbox.oldestQueuedAt)
      }))
    }
    if (health.outbox.retrying > 0) {
      parts.push(t('whatsapp.health.retrying', { count: formatNumber(health.outbox.retrying) }))
    }
    notes.push({
      key: 'queue',
      tone: stuck ? 'alarm' : 'calm',
      icon: 'refresh',
      text: parts.join(' — ')
    })
  }

  // 3. Failures are always worth a word, and never the loudest one: a failed
  //    message had a destination that refused it, which is a smaller problem
  //    than a queue nobody is draining.
  if (health.outbox.failed24h > 0) {
    notes.push({
      key: 'failed',
      tone: 'warn',
      icon: 'x',
      text: t('whatsapp.health.failed24h', { count: formatNumber(health.outbox.failed24h) })
    })
  }

  // 4. The other half of the honest pair. An empty queue with nothing arriving
  //    for two days is not calm, it is a dead webhook — and every counter above
  //    reads perfectly while it is happening.
  //
  //    Silence is only loud once a number is actually connected. With none
  //    paired, "nothing has arrived" is not news, it is the consequence of the
  //    alarm already showing above, and two red pills for one fault teach an
  //    operator to stop reading them.
  const silentFor = ageOf(health.lastInboundAt)
  if (health.lastInboundAt === null) {
    notes.push({
      key: 'inbound',
      tone: anyConnected ? 'alarm' : 'calm',
      icon: 'chat',
      text: t('whatsapp.health.neverAny')
    })
  } else if (silentFor !== null && silentFor > SILENCE_MS) {
    notes.push({
      key: 'inbound',
      tone: anyConnected ? 'alarm' : 'calm',
      icon: 'chat',
      text: t('whatsapp.health.silent', {
        when: formatRelativeTime(health.lastInboundAt)
      })
    })
  }

  // 4b. Por que nada chega. A nota acima diz QUE o silêncio existe; esta diz de
  //     onde ele vem, e é a diferença entre um operador que abre um chamado e
  //     um que conserta em dois minutos.
  //
  //     A ordem é a da certeza. Uma recusa registrada é o fato mais forte que
  //     o painel tem — o Evolution ESTÁ chamando, e está levando 401 —, e ela
  //     vale mesmo quando alguma coisa já chegou um dia, porque é sempre a
  //     causa de o que chega ter parado. Um veredito divergente vem depois:
  //     ele é o que uma conferência viu. "Nunca conferido" é o mais fraco dos
  //     três e por isso só aparece quando o silêncio já é notícia: oferecer a
  //     conferência a quem está recebendo mensagens normalmente seria ruído.
  if (health.webhook.unreachable > 0) {
    // Primeiro de todos, e acima até da recusa: uma recusa prova que o
    // Evolution chega aqui, e esta diz que o endereço nem chega. Não há
    // conserto a fazer no token de um webhook que não é entregável.
    notes.push({
      key: 'webhook-unreachable',
      tone: 'alarm',
      icon: 'x',
      text: t('whatsapp.health.webhookUnreachable', {
        count: formatNumber(health.webhook.unreachable)
      })
    })
  } else if (health.webhook.refusedAt) {
    notes.push({
      key: 'webhook-refused',
      tone: 'alarm',
      icon: 'x',
      text: t('whatsapp.health.webhookRefused', {
        when: formatRelativeTime(health.webhook.refusedAt)
      })
    })
  } else if (health.webhook.broken > 0) {
    notes.push({
      key: 'webhook-broken',
      tone: 'alarm',
      icon: 'x',
      text: t('whatsapp.health.webhookBroken', { count: formatNumber(health.webhook.broken) })
    })
  } else if (health.webhook.unverifiable > 0) {
    // Entre "quebrado" e "nunca conferido", e é o degrau que faltava: foi
    // conferido, a URL e o token conferem, e a lista de eventos veio vazia. Um
    // v2 antigo não devolve o campo e está são; um webhook sem assinatura
    // nenhuma cala do mesmo jeito. Aviso, porque acusar o primeiro é o erro
    // mais caro — e o conserto dos dois é o mesmo botão.
    notes.push({
      key: 'webhook-unverifiable',
      tone: 'warn',
      icon: 'alert',
      text: t('whatsapp.health.webhookUnverifiable', {
        count: formatNumber(health.webhook.unverifiable)
      })
    })
  } else if (health.webhook.unchecked > 0 && anyConnected && health.lastInboundAt === null) {
    notes.push({
      key: 'webhook-unchecked',
      tone: 'warn',
      icon: 'alert',
      text: t('whatsapp.health.webhookUnchecked', { count: formatNumber(health.webhook.unchecked) })
    })
  }

  // 5. What is on disk. Always the quietest thing here — it is a fact about
  //    storage, not about whether anything works, and the sweeper that deletes
  //    it is somebody else's route. This strip only counts.
  //    O prazo vai JUNTO da contagem, e não numa pilha própria. "9,4 KB" é
  //    irrelevante e "9,4 KB, sem prazo de exclusão" é uma decisão — as duas
  //    metades só dizem alguma coisa juntas. E fica `calm`: guardar para sempre
  //    é escolha legítima do provedor, e uma pilha amarela que aparece todo dia
  //    para sempre é a que ensina o operador a parar de ler a tira.
  notes.push({
    key: 'media',
    tone: 'calm',
    icon: 'database',
    text: health.retention.mediaDays > 0
      ? t('whatsapp.health.media', {
        files: formatNumber(health.media.files),
        size: formatBytes(health.media.bytes, formatNumber)
      })
      : t('whatsapp.health.mediaForever', {
        files: formatNumber(health.media.files),
        size: formatBytes(health.media.bytes, formatNumber)
      })
  })

  return notes
}

/**
 * "Is this working?", as a bell in the top corner of `/whatsapp`.
 *
 * The failure it exists to end: a failed message is visible only inside its own
 * thread, a queue that stopped moving is visible nowhere at all, and the
 * integration being down is something the panel learns from a customer.
 *
 * It reads `GET /api/whatsapp/health` — one aggregate, frozen in
 * `docs/whatsapp-api-contract.md` — and says the alarming things loudly and the
 * calm ones quietly. `whatsapp.health.sweepNow` and `sweepOff` are NOT wired
 * here: deleting old attachments belongs to the media sweeper's route, and a
 * button that called it from a screen that only counts would be a destructive
 * action on a poll surface.
 *
 * Por que um sino, e não mais uma tira: com vários avisos a tira ocupava três
 * linhas acima da caixa de entrada, numa ferramenta que o operador usa o dia
 * todo. Os avisos passaram para um painel que abre no clique; fechado, o sino
 * diz o pior tom e quantos avisos há (`healthBadge`), que é o que precisa ser
 * visto sem pedir.
 *
 * O painel dá LUGAR às ações da página e diz quais delas têm o que fazer
 * (`healthActions`) — porque é ele que tem os números. Os botões continuam
 * sendo da página, com as permissões deles.
 */
export function HealthBell({ actions }: { actions?: (available: HealthActions) => ReactNode } = {}) {
  const { t, formatNumber } = useTranslation()

  const [health, setHealth] = useState<WhatsAppHealth | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)

  const alive = useRef(true)
  const inFlight = useRef(false)
  const failures = useRef(0)
  const blockedUntil = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async () => {
    // Single-flight. A poll that arrives while the last one is still out is
    // dropped rather than queued: the next tick is a minute away and this is a
    // summary, so there is nothing to catch up on.
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await whatsappAPI.getHealth()
      if (!alive.current) return
      if (!res.success || !res.data) {
        failures.current += 1
        blockedUntil.current = Date.now()
          + (2 ** Math.min(failures.current, BACKOFF_CAP) - 1) * HEALTH_POLL_MS
        // A bell that cannot read must say so rather than keep showing the
        // last good numbers: stale reassurance is the exact failure mode this
        // component was built against.
        setFailed(true)
        return
      }
      failures.current = 0
      blockedUntil.current = 0
      setFailed(false)
      setHealth(res.data)
    } catch {
      if (!alive.current) return
      failures.current += 1
      blockedUntil.current = Date.now()
        + (2 ** Math.min(failures.current, BACKOFF_CAP) - 1) * HEALTH_POLL_MS
      setFailed(true)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const timer = setInterval(() => {
      // This page is left open in a background tab for hours. A hidden tab
      // skips the tick entirely rather than catching up on wake.
      if (document.visibilityState !== 'visible') return
      if (Date.now() < blockedUntil.current) return
      void load()
    }, HEALTH_POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  // Aberto, o painel fecha num clique fora ou no Esc — e o Esc devolve o foco
  // ao sino, para quem navega pelo teclado não se perder na página.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('touchstart', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('touchstart', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Uma leitura que falhou não mostra os números velhos: o painel diz que não
  // leu, e o sino fica vermelho.
  const notes = health && !failed ? notesFor(health, t, formatNumber) : []
  const badge = healthBadge(notes.map((note) => note.tone), failed)
  const available = health && !failed ? healthActions(health) : null
  const buttons = actions && available ? actions(available) : null
  const summary = badge.unreadable
    ? t('whatsapp.health.loadFailed')
    : badge.count > 0
      ? t('whatsapp.health.bellLabel', { count: formatNumber(badge.count) })
      : t('whatsapp.health.allGood')

  const badgeClass = badge.tone === 'alarm'
    ? 'bg-[hsl(var(--status-danger))] text-white'
    : 'bg-[hsl(var(--status-warning))] text-black'

  return (
    <div ref={rootRef} className="relative ms-auto">
      <button
        ref={buttonRef}
        type="button"
        className="icon-button relative"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t('whatsapp.health.title')} — ${summary}`}
        title={summary}
        data-testid="health-bell"
        data-tone={badge.tone}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="bell" className="h-5 w-5" />
        {(badge.unreadable || badge.count > 0) && (
          <span
            className={`absolute -inset-e-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[0.6875rem] font-bold leading-none tabular-nums ring-2 ring-background ${badgeClass}`}
            aria-hidden="true"
          >
            {badge.unreadable ? '!' : badge.count > 99 ? '99+' : formatNumber(badge.count)}
          </span>
        )}
      </button>

      {/* Fechado, o leitor de tela ainda ouve quando a situação muda. Polite,
          not assertive: an operator typing a reply must not be interrupted
          mid-sentence. */}
      <span className="sr-only" role="status" aria-live="polite">{summary}</span>

      {open && (
        <div
          role="dialog"
          aria-label={t('whatsapp.health.title')}
          data-testid="health-panel"
          className="absolute inset-e-0 top-full z-40 mt-2 w-[24rem] max-w-[calc(100vw-2rem)] rounded-(--radius) border border-border bg-card p-3 text-card-foreground shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Icon
                name={badge.tone === 'calm' ? 'check' : 'warning'}
                className={badge.tone === 'calm'
                  ? 'h-4 w-4 text-[hsl(var(--status-success))]'
                  : 'h-4 w-4 text-[hsl(var(--status-danger))]'}
              />
              {t('whatsapp.health.title')}
            </p>
            <button
              type="button"
              className="icon-button size-10 lg:size-8"
              aria-label={t('common.close')}
              onClick={() => {
                setOpen(false)
                buttonRef.current?.focus()
              }}
            >
              <Icon name="x" className="h-4 w-4" />
            </button>
          </div>

          {badge.unreadable ? (
            <p className="flex items-center gap-2 rounded-md border border-[hsl(var(--status-danger)/0.35)] bg-[hsl(var(--status-danger)/0.07)] px-2.5 py-1.5 text-xs leading-5 text-[hsl(var(--status-danger))]">
              <Icon name="warning" className="h-4 w-4 shrink-0" />
              <span>{t('whatsapp.health.loadFailed')}</span>
            </p>
          ) : !health ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5" role="list">
              {notes.map((note) => (
                <li
                  key={note.key}
                  className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs leading-5 ${TONE_CLASS[note.tone]}`}
                >
                  <Icon name={TONE_ICON[note.tone]} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 wrap-break-word tabular-nums">{note.text}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Um botão que aparece não é notícia: fica fora da lista de avisos,
              e só existe quando há o que fazer. */}
          {buttons && (
            <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border pt-3">{buttons}</div>
          )}
        </div>
      )}
    </div>
  )
}

export default HealthBell
