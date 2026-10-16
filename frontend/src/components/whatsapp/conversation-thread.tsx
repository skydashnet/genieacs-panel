'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { AssigneeControl } from '@/components/whatsapp/assignment'
import { TagPicker } from '@/components/whatsapp/tags'
import { Icon } from '@/components/ui/icon'
import { ContactLink } from '@/components/whatsapp/contact-link'
import { useTranslation } from '@/contexts/language-context'
import type { WhatsAppAccount, WhatsAppConversation, WhatsAppMessage } from '@/lib/api'
import { AccountChip, conversationAddress, conversationTitle } from '@/components/whatsapp/conversation-list'
import { accountTag } from '@/lib/wa-account-color'
import { BILLING_BADGE, billingLabel } from '@/lib/wa-billing-status'
import { MessageBubble } from '@/components/whatsapp/message-bubble'
import { SubscriberLinker } from '@/components/whatsapp/subscriber-linker'
import { useAuth } from '@/contexts/auth-context'
import { useToast } from '@/components/ui/toast'
import { copyToClipboard } from '@/lib/utils'
import { isSafeExternalUrl } from '@/lib/sgp'
import { showActionLabels } from '@/lib/wa-thread-actions'
import { callHref } from '@/lib/wa-call'

/** How close to the foot counts as "the operator is at the bottom". */
const STICK_PX = 120

interface ConversationThreadProps {
  conversation: WhatsAppConversation
  /** Os números do provedor, por id: a conversa diz por qual deles chegou. */
  accounts: ReadonlyMap<number, WhatsAppAccount>
  /** Newest first, exactly as the API hands them over. */
  messages: WhatsAppMessage[]
  loading: boolean
  canLoadMore: boolean
  onLoadMore: () => void
  onResend: (message: WhatsAppMessage) => void
  resendingId: number | null
  onReply?: (message: WhatsAppMessage) => void
  onForward?: (message: WhatsAppMessage) => void
  onReact?: (message: WhatsAppMessage, emoji: string) => void
  onDelete?: (message: WhatsAppMessage) => void
  /** A close or reopen is in flight; the button must not be pressed twice. */
  filing: boolean
  onFile: (status: 'open' | 'closed') => void
  /** Undefined when the operator may not read the ERP: then there is no button. */
  sgpPanelOpen?: boolean
  onToggleSgpPanel?: () => void
  /** The operator linked the thread to an SGP subscriber by hand. */
  onLinked: (conversation: WhatsAppConversation) => void
  /**
   * Back to the list. Only drawn below `lg`, where the inbox shows one pane at
   * a time; on a wide screen the list is right there.
   */
  onBack?: () => void
  /** Teclado aberto no celular: o cabeçalho vira uma linha (voltar + nome). */
  compact?: boolean
}

/**
 * The right pane: who this is, then everything that was said.
 *
 * The header is where the two facts that change an operator's next move live —
 * whether the number resolved to a subscriber, and whether that subscriber
 * asked not to be contacted. Neither is a wall: an unresolved number is still
 * answerable and an opted-out one still gets replies, so both read as context,
 * not as a refusal.
 */
export function ConversationThread({
  conversation,
  accounts,
  messages,
  loading,
  canLoadMore,
  onLoadMore,
  onResend,
  onReply,
  onForward,
  onReact,
  onDelete,
  resendingId,
  filing,
  onFile,
  sgpPanelOpen,
  onToggleSgpPanel,
  onLinked,
  onBack,
  compact = false
}: ConversationThreadProps) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const [linkerOpen, setLinkerOpen] = useState(false)
  const closed = Boolean(conversation.closedAt)
  const scrollRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const [headerWidth, setHeaderWidth] = useState(0)
  const stick = useRef(true)

  const address = conversationAddress(conversation)
  const toast = useToast()
  // Copies the number as stored (country code and digits only), the form every
  // other system accepts; the screen shows it masked.
  const copyNumber = async () => {
    const number = conversation.waPhoneE164
    if (number && await copyToClipboard(number)) toast.success(t('common.copied'))
  }
  const numero = accountTag(accounts, conversation)
  // The API hands the history back newest first; a conversation reads the other
  // way round.
  const ordered = [...messages].reverse()
  const lastId = ordered.length > 0 ? ordered[ordered.length - 1].id : null

  // Os botões do cabeçalho levam texto só quando a coluna da conversa tem
  // largura para os quatro (`lib/wa-thread-actions.ts`). A primeira medida é
  // antes da pintura, para o texto não aparecer e sumir ao abrir a conversa; a
  // partir daí o observador acompanha a janela e o módulo SGP abrindo ao lado.
  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return
    setHeaderWidth(header.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setHeaderWidth(entry.contentRect.width))
    observer.observe(header)
    return () => observer.disconnect()
  }, [])
  const withLabels = showActionLabels(headerWidth)
  const actionClass = `${withLabels ? 'modern-button-secondary' : 'modern-button-secondary px-3'} max-lg:min-h-9 max-lg:px-2.5`
  const labelClass = withLabels ? 'inline' : 'hidden'

  // A new thread always opens at its foot: the newest message is the one the
  // operator came here for.
  useEffect(() => {
    const box = scrollRef.current
    setLinkerOpen(false)
    if (!box) return
    stick.current = true
    box.scrollTop = box.scrollHeight
  }, [conversation.id])

  // A message arriving while the operator is reading further up must not yank
  // the viewport out from under them — the poll below runs on its own clock,
  // and scrolling someone away mid-sentence is how a screen loses trust.
  // Loading older messages never trips this: it does not change the last id.
  //
  // Duas exceções que levam ao fim de qualquer jeito: a mensagem que o próprio
  // atendente acabou de mandar (ele quer vê-la saindo) e a que chegou com o
  // operador a menos de uma tela do fim — antes só valia 120 px, e com um
  // áudio ou uma imagem no meio o recém-chegado ficava fora da vista.
  const lastOutbound = ordered.length > 0 ? ordered[ordered.length - 1].direction === 'out' : false
  useEffect(() => {
    const box = scrollRef.current
    if (!box || lastId === null) return
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight
    if (!stick.current && !lastOutbound && distance > box.clientHeight) return
    stick.current = true
    box.scrollTop = box.scrollHeight
  }, [lastId, lastOutbound])

  // Imagem, áudio e mídia mudam de altura DEPOIS de pintados, e o fim sai de
  // baixo do operador; o campo de resposta que cresce (citação, vários
  // anexos) encolhe a janela. Enquanto ele está no fim, o fim o acompanha.
  const listRef = useRef<HTMLUListElement>(null)
  const hasMessages = ordered.length > 0
  useEffect(() => {
    const box = scrollRef.current
    const list = listRef.current
    if (!box || !list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stick.current) box.scrollTop = box.scrollHeight
    })
    observer.observe(list)
    observer.observe(box)
    return () => observer.disconnect()
  }, [hasMessages, conversation.id])

  return (
    <>
      <header
        ref={headerRef}
        className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 max-lg:gap-y-1.5 border-b border-border bg-card px-3 sm:px-4 lg:items-start lg:gap-3 lg:py-3 ${compact ? 'flex-nowrap py-1.5' : 'py-2.5'}`}
      >
        {/* No celular o cabeçalho tem duas linhas: voltar (só a seta), o nome e as
            ações na primeira; o telefone e os selos, numa faixa que rola de lado,
            na segunda. O bloco do título vira `contents` ali para o nome e a faixa
            serem filhos diretos do cabeçalho; do `lg` para cima ele é o bloco de
            sempre. */}
        {onBack && (
          <button
            type="button"
            className="-ms-1 inline-flex min-h-10 items-center gap-1.5 rounded-md px-1 text-sm font-semibold text-primary hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            data-testid="inbox-back"
            onClick={onBack}
          >
            <Icon name="back" size={16} />
            <span className="max-lg:sr-only">{t('whatsapp.inbox.title')}</span>
          </button>
        )}
        <div className={compact ? 'min-w-0 flex-1' : 'min-w-0 max-lg:contents lg:order-0 lg:w-auto'}>
          <h2 className="truncate text-base font-semibold text-foreground max-lg:order-1 max-lg:min-w-0 max-lg:flex-1">
            <ContactLink contract={conversation.contract} name={conversationTitle(conversation)} className="" />
          </h2>
          {!compact && address && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground max-lg:hidden">
              <span className="truncate font-mono">{address}</span>
              {conversation.waPhoneE164 && (
                <button
                  type="button"
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
                  aria-label={t('common.copy')}
                  title={t('common.copy')}
                  onClick={() => void copyNumber()}
                >
                  <Icon name="copy" size={14} />
                </button>
              )}
            </p>
          )}

          {/* Com o teclado aberto os selos e as ações saem: a altura vai para as mensagens. */}
          {!compact && (
            <div className={`mt-2 flex flex-wrap items-center gap-1.5 max-lg:order-3 max-lg:mt-0 max-lg:w-full max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:[scrollbar-width:none] max-lg:[&::-webkit-scrollbar]:hidden max-lg:[&>*]:shrink-0 max-lg:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] ${numero?.className ?? ''}`}>
              {address && (
                <span className="modern-badge font-mono lg:hidden">
                  {address}
                  {conversation.waPhoneE164 && (
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center rounded hover:bg-muted"
                      aria-label={t('common.copy')}
                      title={t('common.copy')}
                      onClick={() => void copyNumber()}
                    >
                      <Icon name="copy" size={12} />
                    </button>
                  )}
                </span>
              )}
              {numero?.showName && <AccountChip name={numero.name} />}
              {conversation.contract ? (
                <ContractBadgeLink
                  href={can('sgp.read') && isSafeExternalUrl(conversation.sgpUrl ?? null) ? conversation.sgpUrl! : null}
                  linkTitle={t('whatsapp.sgp.openSgp')}
                  className={conversation.billing
                    ? `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${BILLING_BADGE[conversation.billing.status]}`
                    : 'modern-badge-info'}
                  title={conversation.billing
                    ? t(billingLabel(conversation.billing.status, conversation.billing.daysOverdue).key,
                      billingLabel(conversation.billing.status, conversation.billing.daysOverdue).vars)
                    : undefined}
                >
                  <Icon name="invoice" size={12} />
                  {t('whatsapp.inbox.contract')}: <span className="font-mono">{conversation.contract}</span>
                  {conversation.billing && (
                    <span className="font-normal">
                      · {t(billingLabel(conversation.billing.status, conversation.billing.daysOverdue).key,
                        billingLabel(conversation.billing.status, conversation.billing.daysOverdue).vars)}
                    </span>
                  )}
                </ContractBadgeLink>
              ) : (
                <span className="modern-badge">
                  <Icon name="info" size={12} />
                  {t('whatsapp.inbox.unknownContact')}
                </span>
              )}
              {conversation.clientName && (
                <span className="modern-badge max-w-full max-lg:hidden">
                  <span className="truncate">
                    {t('whatsapp.inbox.subscriber')}: <ContactLink contract={conversation.contract} name={conversation.clientName} className="" />
                  </span>
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
              {conversation.waitingSince && !conversation.assignedUserId && (
                <span className="modern-badge-warning" title={t('whatsapp.assign.waitingHint')}>
                  <Icon name="contacts" size={12} />
                  {t('whatsapp.assign.waiting')}
                </span>
              )}
              <AssigneeControl conversation={conversation} onChange={onLinked} />
              <TagPicker conversation={conversation} onChange={onLinked} />
              {closed && (
                <span className="modern-badge" title={t('whatsapp.inbox.closeHint')}>
                  <Icon name="check" size={12} />
                  {t('whatsapp.inbox.closed')}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Com a coluna estreita (celular, notebook, módulo SGP aberto) os
            quatro viram só ícone, com o nome no `aria-label` e no `title`; e o
            grupo quebra linha em vez de sair da tela. */}
        {!compact && (
          <div className="flex flex-wrap items-center gap-2 max-lg:order-2 max-lg:flex-nowrap max-lg:gap-1">
            {can('whatsapp.send') && (
              <button
                type="button"
                className={actionClass}
                aria-expanded={linkerOpen}
                aria-label={t(conversation.contract ? 'whatsapp.inbox.changeSubscriber' : 'whatsapp.inbox.linkSubscriber')}
                title={t(conversation.contract ? 'whatsapp.inbox.changeSubscriber' : 'whatsapp.inbox.linkSubscriber')}
                onClick={() => setLinkerOpen((open) => !open)}
              >
                <Icon name="edit" size={16} />
                <span className={labelClass}>
                  {t(conversation.contract ? 'whatsapp.inbox.changeSubscriber' : 'whatsapp.inbox.linkSubscriber')}
                </span>
              </button>
            )}

            {/* Closing is not a destructive act and is not offered as one: the
                hint says what it does, and the same button undoes it. */}
            <button
              type="button"
              className={actionClass}
              disabled={filing}
              aria-label={t(closed ? 'whatsapp.inbox.reopen' : 'whatsapp.inbox.close')}
              title={t('whatsapp.inbox.closeHint')}
              onClick={() => onFile(closed ? 'open' : 'closed')}
            >
              <Icon name={closed ? 'refresh' : 'check'} size={16} className={filing ? 'animate-spin' : ''} />
              <span className={labelClass}>{t(closed ? 'whatsapp.inbox.reopen' : 'whatsapp.inbox.close')}</span>
            </button>

            {/* Ligar pelo aparelho do atendente: o painel não carrega voz. */}
            {callHref(conversation.waPhoneE164) && (
              <a
                href={callHref(conversation.waPhoneE164)!}
                className={actionClass}
                aria-label={t('whatsapp.inbox.call')}
                title={t('whatsapp.inbox.callHint')}
              >
                <Icon name="phone" size={16} />
                <span className={labelClass}>{t('whatsapp.inbox.call')}</span>
              </a>
            )}

            {onToggleSgpPanel && (
              <button
                type="button"
                className={actionClass}
                aria-pressed={Boolean(sgpPanelOpen)}
                aria-label={t('whatsapp.sgp.toggle')}
                title={t('whatsapp.sgp.toggle')}
                onClick={onToggleSgpPanel}
              >
                <Icon name="database" size={16} />
                <span className={labelClass}>{t('whatsapp.sgp.toggle')}</span>
              </button>
            )}

            {conversation.deviceId && (
              <Link
                to={`/devices/detail?id=${encodeURIComponent(conversation.deviceId)}`}
                className={actionClass}
                aria-label={t('whatsapp.inbox.openDevice')}
                title={t('whatsapp.inbox.openDevice')}
              >
                <Icon name="server" size={16} />
                <span className={labelClass}>{t('whatsapp.inbox.openDevice')}</span>
              </Link>
            )}
          </div>
        )}
      </header>

      {linkerOpen && (
        <SubscriberLinker
          conversation={conversation}
          onCancel={() => setLinkerOpen(false)}
          onLinked={(linked) => {
            setLinkerOpen(false)
            onLinked(linked)
          }}
        />
      )}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[hsl(var(--surface-subtle))] px-3 py-3 sm:px-4 sm:py-4"
        onScroll={(event) => {
          const box = event.currentTarget
          stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX
        }}
      >
        {canLoadMore && (
          <div className="mb-3 flex justify-center">
            <button type="button" className="modern-button-secondary min-h-9 px-3 py-1 text-xs" disabled={loading} onClick={onLoadMore}>
              <Icon name="refresh" size={13} className={loading ? 'animate-spin' : ''} />
              {t('whatsapp.inbox.loadMore')}
            </button>
          </div>
        )}

        {ordered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name="chat" size={22} /></div>
            <p className="empty-state-copy">{loading ? t('common.loading') : t('whatsapp.inbox.noMessages')}</p>
          </div>
        ) : (
          // A classe do número fica na lista, e o balão RECEBIDO lê a cor dela:
          // é a mensagem que chegou por aquele número. O que o provedor mandou
          // continua na cor do painel.
          <ul ref={listRef} className={`flex flex-col gap-2 ${numero?.className ?? ''}`} role="list">
            {ordered.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onResend={onResend}
                resending={resendingId === message.id}
                onReply={onReply}
                onForward={onForward}
                onReact={onReact}
                onDelete={onDelete}
                accountTinted={numero !== null}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

/**
 * O selo do contrato no cabeçalho: com o endereço do cadastro no SGP, é um
 * link (nova aba) e o `title` diz para onde vai; sem ele, o selo de sempre,
 * com o `title` da situação financeira.
 */
function ContractBadgeLink({
  href,
  linkTitle,
  title,
  className,
  children
}: { href: string | null; linkTitle: string; title?: string; className?: string; children: ReactNode }) {
  if (!href) return <span className={className} title={title}>{children}</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className ?? ''} hover:underline`}
      title={title ? `${linkTitle} · ${title}` : linkTitle}
    >
      {children}
      <Icon name="external" size={10} />
    </a>
  )
}
