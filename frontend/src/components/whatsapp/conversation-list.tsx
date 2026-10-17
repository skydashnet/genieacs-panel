'use client'

import { TagChip } from '@/components/whatsapp/tags'
import { BILLING_BADGE, BILLING_FRAME, billingLabel } from '@/lib/wa-billing-status'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { WhatsAppAccount, WhatsAppConversation } from '@/lib/api'
import { accountTag } from '@/lib/wa-account-color'
import { formatDayMonth, getActiveDateFormat } from '@/lib/date-format'
import { isSafeExternalUrl } from '@/lib/sgp'
import { formatBrPhone } from '@/lib/phone'

/** A Brazilian number (55 + DDD + number) as people read it; any other number as it came. */
function maskNumber(number: string): string {
  return /^55\d{10,11}$/.test(number.replace(/\D/g, '')) ? formatBrPhone(number) : number
}

/**
 * What to call the person on the other end.
 *
 * Ordered by how much the name is worth: the subscriber name the ERP knows
 * beats the profile name they set on their own phone, which beats the raw
 * address. The chain never ends nameless — a contact WhatsApp handed us only a
 * LID for still has to be clickable, and the id is the last resort so that a
 * row can never render as an empty button.
 */
export function conversationTitle(conversation: WhatsAppConversation): string {
  return (
    conversation.clientName
    || conversation.pushName
    || (conversation.waPhoneE164 ? maskNumber(conversation.waPhoneE164) : null)
    || conversation.waLid
    || `#${conversation.id}`
  )
}

/**
 * The address, only when it is not already the title. Showing
 * "+5511999999999 · +5511999999999" on an unnamed thread is noise.
 */
export function conversationAddress(conversation: WhatsAppConversation): string | null {
  const address = conversation.waPhoneE164 ? maskNumber(conversation.waPhoneE164) : conversation.waLid
  if (!address) return null
  return address === conversationTitle(conversation) ? null : address
}

/**
 * A chat list stamp, not a log stamp: today collapses to the clock and anything
 * older to the day. Built from `Intl` alone so it needs no vocabulary of its
 * own — every word here would be a word to translate five times.
 */
function stamp(iso: string | null, intlLocale: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return sameDay
    ? new Intl.DateTimeFormat(intlLocale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    : formatDayMonth(date, getActiveDateFormat(), intlLocale)
}

interface ConversationListProps {
  conversations: WhatsAppConversation[]
  /** Os números do provedor, por id: cada linha diz por qual deles chegou. */
  accounts: ReadonlyMap<number, WhatsAppAccount>
  selectedId: number | null
  onSelect: (conversation: WhatsAppConversation) => void
  /** A search term or a non-default pile is narrowing what is drawn here. */
  filtered: boolean
  /** Conversa → minutos esperando gente além do limite (o selo vermelho). */
  waiting?: ReadonlyMap<number, number>
  /** Quem pode ver o SGP: o número do contrato abre o cadastro do cliente lá. */
  canOpenSgp?: boolean
}

/**
 * The left pane. Pure presentation: it neither fetches nor reconciles the
 * unread counts it draws, because the badge shown here and the badge the server
 * clears when a thread is opened have to be settled in one place, and that
 * place is the page.
 */
/** Minutos inteiros desde `iso`, nunca negativo. */
export function minutesSince(iso: string, now = Date.now()): number {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : 0
}

export function ConversationList({ conversations, accounts, selectedId, onSelect, filtered, waiting, canOpenSgp = false }: ConversationListProps) {
  const { t, intlLocale } = useTranslation()

  if (conversations.length === 0) {
    // "Nothing matches that" sends the operator back to the search box;
    // "no conversation yet" tells them the panel is simply new. Reading the
    // first as the second is how a working search looks broken.
    return (
      <div className="empty-state">
        <div className="empty-state-icon"><Icon name={filtered ? 'search' : 'chat'} size={22} /></div>
        <p className="empty-state-title">{t(filtered ? 'whatsapp.inbox.noMatch' : 'whatsapp.inbox.empty')}</p>
      </div>
    )
  }

  return (
    <ul className="divide-y divide-border" role="list">
      {conversations.map((conversation) => {
        const active = conversation.id === selectedId
        const address = conversationAddress(conversation)
        const numero = accountTag(accounts, conversation)
        // A faixa da esquerda é a cor do NÚMERO que recebeu, sempre que ele é
        // conhecido — e a linha aberta continua reconhecível pelo fundo. Sem
        // número conhecido, a faixa volta a ser só a da seleção, como antes.
        // O cliente falou por último e ninguém respondeu: a linha pisca até
        // alguém (ou o bot) responder. `motion-safe`: quem pediu menos
        // movimento ao sistema vê a marca parada.
        const aguardando = conversation.awaitingSince ? minutesSince(conversation.awaitingSince) : null
        // A moldura da situação financeira: verde em dia, amarela vence hoje,
        // vermelha atrasado. Sem consulta ao SGP ainda, sem moldura.
        const situacao = conversation.billing ?? null
        const rotulo = situacao ? billingLabel(situacao.status, situacao.daysOverdue) : null
        const faixa = numero
          ? `${numero.className} shadow-[inset_4px_0_0_0_hsl(var(--wa-account))]`
          : active ? 'shadow-[inset_3px_0_0_0_hsl(var(--primary))]' : ''
        return (
          <li key={conversation.id}>
            <button
              type="button"
              onClick={() => onSelect(conversation)}
              aria-current={active ? 'true' : undefined}
              className={`flex w-full flex-col gap-1.5 px-3 py-3 text-start transition-colors ${faixa} ${situacao ? BILLING_FRAME[situacao.status] : ''} ${
                active
                  ? 'bg-[hsl(var(--surface-subtle))]'
                  : aguardando !== null
                    ? 'bg-[hsl(var(--status-warning)/0.08)] hover:bg-[hsl(var(--status-warning)/0.14)]'
                    : 'hover:bg-[hsl(var(--surface-subtle))]'
              }`}
            >
              <span className="flex items-baseline gap-2">
                {aguardando !== null && (
                  <span className="relative inline-flex size-2.5 shrink-0 self-center" aria-hidden="true">
                    <span className="absolute inline-flex size-full rounded-full bg-[hsl(var(--status-warning))] opacity-75 motion-safe:animate-ping" />
                    <span className="relative inline-flex size-2.5 rounded-full bg-[hsl(var(--status-warning))]" />
                  </span>
                )}
                <span
                  className={`min-w-0 flex-1 truncate text-sm text-foreground ${
                    conversation.unreadCount > 0 ? 'font-bold' : 'font-semibold'
                  }`}
                >
                  {conversationTitle(conversation)}
                </span>
                <span className="shrink-0 font-mono text-[0.68rem] tabular-nums text-muted-foreground">
                  {stamp(conversation.lastMessageAt, intlLocale)}
                </span>
              </span>

              {address && (
                <span className="block truncate font-mono text-[0.68rem] text-muted-foreground">{address}</span>
              )}

              <span className="flex flex-wrap items-center gap-1.5">
                {numero?.showName && <AccountChip name={numero.name} />}
                {/* Only ever visible under the closed or the all pile, which is
                    exactly where a row's state stops being obvious. */}
                {conversation.closedAt && (
                  <span className="modern-badge" title={t('whatsapp.inbox.closeHint')}>
                    <Icon name="check" size={12} />
                    {t('whatsapp.inbox.closed')}
                  </span>
                )}
                {situacao && rotulo && situacao.status !== 'ok' && (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.68rem] font-semibold ${BILLING_BADGE[situacao.status]}`}>
                    {t(rotulo.key, rotulo.vars)}
                  </span>
                )}
                {aguardando !== null && !waiting?.has(conversation.id) && (
                  <span className="modern-badge-warning" title={t('whatsapp.inbox.awaitingHint')}>
                    {t('whatsapp.inbox.awaiting', { minutes: aguardando })}
                  </span>
                )}
                {conversation.unreadCount > 0 && (
                  <span className="modern-badge-success">
                    {t('whatsapp.inbox.unread', { count: conversation.unreadCount })}
                  </span>
                )}
                {conversation.botPausedUntil && (
                  <span className="modern-badge-warning" title={t('whatsapp.inbox.wantsHumanHint')}>
                    <Icon name="contacts" size={12} />
                    {t('whatsapp.inbox.wantsHuman')}
                  </span>
                )}
                {conversation.optedOut && (
                  <span className="modern-badge-warning" title={t('whatsapp.inbox.optedOutHint')}>
                    <Icon name="bell" size={12} />
                    {t('whatsapp.inbox.optedOut')}
                  </span>
                )}
                {waiting?.has(conversation.id) && (
                  <span className="modern-badge-error" title={t('whatsapp.waiting.badgeHint')}>
                    <Icon name="warning" size={12} />
                    {t('whatsapp.waiting.badge', { minutes: waiting.get(conversation.id) ?? 0 })}
                  </span>
                )}
                {(conversation.tags ?? []).map((tag) => <TagChip key={tag.id} tag={tag} />)}
                {conversation.assignedTo ? (
                  <span className="modern-badge" title={t('whatsapp.assign.agent')}>
                    <Icon name="contacts" size={12} />
                    {conversation.assignedTo}
                  </span>
                ) : conversation.waitingSince ? (
                  <span className="modern-badge-warning" title={t('whatsapp.assign.waitingHint')}>
                    {t('whatsapp.assign.waiting')}
                  </span>
                ) : null}
                {conversation.contract && canOpenSgp && isSafeExternalUrl(conversation.sgpUrl ?? null) ? (
                  // A linha inteira é um <button>, e um <a> dentro dele não é
                  // HTML válido: o selo abre o SGP pelo clique, sem abrir a
                  // conversa junto. No teclado, o mesmo link está no Módulo SGP.
                  <span
                    role="link"
                    className="modern-badge cursor-pointer hover:border-primary hover:text-primary hover:underline"
                    title={t('whatsapp.sgp.openSgp')}
                    onClick={(event) => {
                      event.stopPropagation()
                      window.open(conversation.sgpUrl!, '_blank', 'noopener,noreferrer')
                    }}
                  >
                    <Icon name="invoice" size={12} />
                    <span className="font-mono">{conversation.contract}</span>
                    <Icon name="external" size={10} />
                  </span>
                ) : conversation.contract ? (
                  <span className="modern-badge">
                    <Icon name="invoice" size={12} />
                    <span className="font-mono">{conversation.contract}</span>
                  </span>
                ) : (
                  <span className="modern-badge" title={t('whatsapp.inbox.unknownContact')}>
                    <Icon name="info" size={12} />
                    {t('whatsapp.inbox.unknownContact')}
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * O nome do número que recebeu a conversa, na cor dele.
 *
 * Vai dentro de um elemento que já carrega a classe do número (`accountTag`),
 * então só lê `--wa-account`. Exportado porque o cabeçalho da conversa mostra o
 * mesmo chip.
 */
export function AccountChip({ name }: { name: string }) {
  const { t } = useTranslation()
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-[hsl(var(--wa-account))]/35 bg-[hsl(var(--wa-account))]/10 px-2 py-0.5 text-[0.68rem] font-semibold text-[hsl(var(--wa-account))]"
      title={t('whatsapp.inbox.receivedBy', { number: name })}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-[hsl(var(--wa-account))]" aria-hidden="true" />
      <span className="truncate">{name}</span>
    </span>
  )
}
