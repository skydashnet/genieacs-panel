'use client'

import { linkify } from '@/lib/linkify'
import { MessageMenu } from '@/components/whatsapp/message-menu'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { whatsappAPI, type WhatsAppMessage } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n'
import { formatDayMonth, getActiveDateFormat, toDate } from '@/lib/date-format'
import { isAudioType } from '@/lib/wa-audio'

type DeliveryStatus = NonNullable<WhatsAppMessage['deliveryStatus']>

const DELIVERY_LABEL: Record<DeliveryStatus, TranslationKey> = {
  queued: 'whatsapp.delivery.queued',
  sending: 'whatsapp.delivery.sending',
  sent: 'whatsapp.delivery.sent',
  delivered: 'whatsapp.delivery.delivered',
  read: 'whatsapp.delivery.read',
  failed: 'whatsapp.delivery.failed'
}

/**
 * The rung of `queued → sending → sent → delivered → read` gets a shape of its
 * own, because "it left the panel" and "the customer opened it" are different
 * facts and an operator deciding whether to call someone reads them
 * differently. Only `failed` is coloured: everything else is progress, and a
 * screen where five of six states shout has no way left to shout.
 */
const DELIVERY_ICON: Record<DeliveryStatus, 'refresh' | 'check' | 'eye' | 'warning'> = {
  queued: 'refresh',
  sending: 'refresh',
  sent: 'check',
  delivered: 'check',
  read: 'eye',
  failed: 'warning'
}

/**
 * `delivery_error` is 500 characters of whatever the Evolution server said. It
 * belongs on the screen — the operator has to know a message did not go out and
 * roughly why — but not as a wall of JSON in the middle of a conversation. The
 * full text stays reachable in the tooltip.
 */
const REASON_MAX = 140

function truncateReason(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim()
  return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX - 1)}…` : flat
}

/**
 * Which attachments are worth showing in place.
 *
 * SVG is absent for the same reason the backend refuses to serve it inline: it
 * is a document that can carry script, and an `<img>` is not the only thing a
 * browser might be talked into making of it. Everything not on this list is
 * offered as a download, which is the honest thing to do with bytes we cannot
 * vouch for.
 */
function isInlineImage(type: string | null): boolean {
  const mime = (type || '').split(';')[0].trim().toLowerCase()
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'].includes(mime)
}

/**
 * One message's attachment, fetched as a blob.
 *
 * A blob and not a URL because the route carries the operator's session in an
 * `Authorization` header, and `<img src>` cannot send one. Which means an
 * object URL per image — and a thread of fifty photos is fifty object URLs that
 * live until the tab is closed unless every one of them is revoked. The ref
 * below is what does that: every URL this component ever makes goes into it,
 * and the unmount effect empties it.
 *
 * A non-image is not fetched at all until the operator asks. Prefetching a
 * thread's worth of PDFs to render a button would download files nobody opened.
 */
function Attachment({ message }: { message: WhatsAppMessage }) {
  const { t } = useTranslation()
  const attachment = message.attachment
  const inline = isInlineImage(attachment?.type ?? null)
  const audio = isAudioType(attachment?.type ?? null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [cannotPlay, setCannotPlay] = useState(false)

  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const [busy, setBusy] = useState(false)
  const created = useRef<string[]>([])

  const remember = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob)
    created.current.push(url)
    return url
  }, [])

  // Revokes on unmount, and only on unmount: the URLs have to outlive every
  // render in between, since the `<img>` is still pointing at one of them.
  useEffect(() => () => {
    created.current.forEach((url) => URL.revokeObjectURL(url))
    created.current = []
  }, [])

  useEffect(() => {
    if (!inline) return
    let live = true
    void whatsappAPI.fetchAttachment(message.id).then((result) => {
      if (!live) return
      // A file deleted off the disk, a row from another provider, an expired
      // session: all the same to the operator, and all better as a line of text
      // than as the broken-image glyph that says nothing.
      if (!result.success || !result.blob) return setGone(true)
      setObjectUrl(remember(result.blob))
    })
    return () => { live = false }
  }, [inline, message.id, remember])

  const download = useCallback(async () => {
    setBusy(true)
    try {
      const result = await whatsappAPI.fetchAttachment(message.id)
      if (!result.success || !result.blob) return setGone(true)
      const url = remember(result.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = attachment?.name || `attachment-${message.id}`
      document.body.appendChild(link)
      link.click()
      link.remove()
    } finally {
      setBusy(false)
    }
  }, [attachment?.name, message.id, remember])

  /**
   * Ouvir aqui mesmo. O arquivo só é buscado no clique — uma conversa com
   * trinta áudios não baixa trinta áudios para desenhar a tela —, e vira um
   * `<audio>` com o blob já em memória, o que deixa avançar e voltar sem o
   * servidor precisar responder por pedaços.
   */
  const listen = useCallback(async () => {
    const mime = attachment?.type || ''
    if (document.createElement('audio').canPlayType(mime) === '' && document.createElement('audio').canPlayType(mime.split(';')[0]) === '') {
      setCannotPlay(true)
      return
    }
    setBusy(true)
    try {
      const result = await whatsappAPI.fetchAttachment(message.id)
      if (!result.success || !result.blob) return setGone(true)
      setAudioUrl(remember(result.blob))
    } finally {
      setBusy(false)
    }
  }, [attachment?.type, message.id, remember])

  if (!attachment) return null

  const label = attachment.name || t('whatsapp.inbox.attachment')

  if (audio && !gone) {
    return (
      <span className="mt-2 flex max-w-full flex-wrap items-center gap-2">
        {audioUrl ? (
          <audio controls autoPlay src={audioUrl} className="h-10 w-72 max-w-full" aria-label={label} />
        ) : (
          <button
            type="button"
            onClick={() => { void listen() }}
            disabled={busy || cannotPlay}
            className="modern-button-secondary flex min-h-9 items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <Icon name={busy ? 'refresh' : 'play'} size={14} className={`shrink-0 ${busy ? 'animate-spin' : ''}`} />
            <span className="font-semibold">{t('whatsapp.audio.play')}</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => { void download() }}
          className="text-xs text-muted-foreground underline"
          title={label}
        >
          {t('whatsapp.inbox.attachmentDownload')}
        </button>
        {cannotPlay && <span className="w-full text-xs text-muted-foreground">{t('whatsapp.audio.cannotPlay')}</span>}
      </span>
    )
  }

  if (gone) {
    return (
      <span className="mt-2 flex items-center gap-1.5 rounded border border-border/70 bg-background/40 px-2 py-1.5 text-xs text-muted-foreground">
        <Icon name="warning" size={14} className="shrink-0" />
        <span className="truncate">{t('whatsapp.inbox.attachmentGone')}</span>
      </span>
    )
  }

  if (inline) {
    return (
      <span className="mt-2 block">
        {objectUrl ? (
          <a
            href={objectUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={t('whatsapp.inbox.attachmentOpen')}
            className="block overflow-hidden rounded border border-border/70"
          >
            {/* A plain <img>, not next/image: the source is an object URL for
                bytes already in memory, and there is no remote asset for an
                optimiser to fetch, resize or cache. */}
            <img
              src={objectUrl}
              alt={label}
              className="max-h-72 w-auto max-w-full object-contain"
            />
          </a>
        ) : (
          <span className="flex items-center gap-1.5 rounded border border-border/70 bg-background/40 px-2 py-1.5 text-xs text-muted-foreground">
            <Icon name="refresh" size={14} className="shrink-0 animate-spin" />
            <span className="truncate">{label}</span>
          </span>
        )}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => { void download() }}
      disabled={busy}
      title={label}
      className="modern-button-secondary mt-2 flex min-h-9 max-w-full items-center gap-1.5 px-2 py-1.5 text-xs"
    >
      <Icon name={busy ? 'refresh' : 'box'} size={14} className={`shrink-0 ${busy ? 'animate-spin' : ''}`} />
      <span className="truncate">{label}</span>
      <span className="shrink-0 font-semibold opacity-80">{t('whatsapp.inbox.attachmentDownload')}</span>
    </button>
  )
}

function clock(iso: string | null, intlLocale: string): string {
  if (!iso) return ''
  const date = toDate(iso)
  if (!date) return ''
  const hora = new Intl.DateTimeFormat(intlLocale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  return `${formatDayMonth(date, getActiveDateFormat(), intlLocale)} ${hora}`
}

/**
 * "in four minutes", in the operator's language.
 *
 * Relative and not a clock time because the fact being reported is a wait, and
 * "19:42" makes the reader do the subtraction. It is computed at render and
 * left alone: the thread reloads on its own 45 s timer, and a per-bubble
 * countdown would be fifty timers running so that a number nobody is watching
 * could tick.
 */
/** Whether the row is waiting out a backoff rather than having given up. */
function waitingFor(iso: string | null): boolean {
  if (!iso) return false
  const due = Date.parse(iso)
  return !Number.isNaN(due) && due > Date.now()
}

function relative(iso: string, intlLocale: string): string {
  const ms = Date.parse(iso) - Date.now()
  const format = new Intl.RelativeTimeFormat(intlLocale, { numeric: 'always' })
  const minutes = Math.round(ms / 60_000)
  if (Math.abs(minutes) < 1) return format.format(Math.round(ms / 1000), 'second')
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute')
  return format.format(Math.round(minutes / 60), 'hour')
}

interface MessageBubbleProps {
  message: WhatsAppMessage
  /**
   * Offered only for a failed outbound. It puts THIS row back in the queue —
   * the id, the attachment and the place in the thread are kept — rather than
   * posting the text again as a new message.
   */
  onResend: (message: WhatsAppMessage) => void
  resending: boolean
  onReply?: (message: WhatsAppMessage) => void
  onForward?: (message: WhatsAppMessage) => void
  onReact?: (message: WhatsAppMessage, emoji: string) => void
  onDelete?: (message: WhatsAppMessage) => void
  /**
   * O balão recebido na cor do número que o recebeu. A cor vem de
   * `--wa-account`, definida pela lista em volta; sem número conhecido, o
   * balão fica neutro, como era.
   */
  accountTinted?: boolean
}

export function MessageBubble({ message, onResend, resending, onReply, onForward, onReact, onDelete, accountTinted = false }: MessageBubbleProps) {
  const { t, intlLocale } = useTranslation()
  const stamp = clock(message.createdAt, intlLocale)

  // A send that bounced is not over: it backs off and comes round again, and
  // `nextAttemptAt` is the panel saying so. Without this line the bubble shows
  // an untouched "queued" for minutes at a time and the operator resends by
  // hand something that was always going to go out on its own.
  const due = message.nextAttemptAt
  const waiting = waitingFor(due)

  const attachment = message.attachment && <Attachment message={message} />

  const body = message.deletedAt
    ? <p className="text-sm italic text-muted-foreground">{t('whatsapp.msg.deleted')}</p>
    : message.body
    ? <p className="whitespace-pre-wrap text-sm leading-6 wrap-anywhere">
        {linkify(message.body).map((part, i) => part.href
          ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer" className="text-primary underline">{part.text}</a>
          : part.text)}
      </p>
    : !message.attachment
      // Um tipo que o painel não sabe mostrar (o servidor já descreve reação,
      // localização, contato, enquete e mídia que não baixou).
      ? <p className="text-sm italic text-muted-foreground">{t('whatsapp.inbox.unsupported')}</p>
      : null

  // ── An internal note ──────────────────────────────────────────────────────
  // Not a bubble at all. A note is stored with `deliveryStatus: null` and the
  // outbox worker never sees it, so nothing about it will ever look wrong on
  // its own — the only thing that can go wrong is an operator reading it as a
  // reply and waiting for an answer that the customer was never asked for.
  // That is why it breaks the chat's whole grammar rather than being a sent
  // bubble in another colour: full width instead of aligned, dashed instead of
  // solid, and labelled in words.
  if (message.isNote) {
    return (
      <li className="my-1 w-full">
        <div className="rounded-(--radius) border border-dashed border-[hsl(var(--status-warning))]/60 bg-[hsl(var(--status-warning))]/[0.07] px-3 py-2.5">
          <p className="mb-1.5 flex items-center gap-1.5 text-[0.62rem] font-bold uppercase tracking-[0.14em] text-[hsl(var(--status-warning))]">
            <Icon name="lock" size={12} />
            {t('whatsapp.inbox.note')}
          </p>
          <div className="text-foreground">{body}</div>
          {attachment}
          <p className="mt-1.5 font-mono text-[0.62rem] tabular-nums text-muted-foreground">{stamp}</p>
        </div>
      </li>
    )
  }

  const inbound = message.direction === 'in'
  const failed = message.deliveryStatus === 'failed'

  const quote = message.replyTo && (
    <div className="mb-1.5 rounded border-s-2 border-primary/60 bg-black/10 px-2 py-1 text-xs text-muted-foreground">
      <p className="font-semibold">{message.replyTo.direction === 'in' ? t('whatsapp.msg.theirs') : t('whatsapp.msg.yours')}</p>
      <p className="line-clamp-2 whitespace-pre-wrap wrap-anywhere">{message.replyTo.body || t('whatsapp.msg.attachment')}</p>
    </div>
  )
  const menu = message.deletedAt ? null : <MessageMenu message={message} onReply={onReply} onForward={onForward} onReact={onReact} onDelete={onDelete} />

  return (
    <li className={`group/msg flex w-full items-start gap-1 ${inbound ? 'justify-start' : 'flex-row-reverse justify-start'}`}>
      <div
        className={`min-w-0 max-w-[min(38rem,85%)] rounded-(--radius) border px-3 py-2 ${
          inbound
            ? accountTinted
              ? 'border-[hsl(var(--wa-account))]/40 bg-[hsl(var(--wa-account))]/[0.07] text-card-foreground'
              : 'border-border bg-card text-card-foreground'
            : failed
              ? 'border-[hsl(var(--status-danger))]/45 bg-[hsl(var(--status-danger))]/[0.07] text-foreground'
              : 'border-primary/30 bg-primary/10 text-foreground'
        }`}
      >
        {!message.deletedAt && quote}
        {body}
        {attachment}
        {message.myReaction && (
          <span className="mt-1 inline-flex rounded-full border border-border bg-background/70 px-1.5 text-sm leading-6" title={t('whatsapp.msg.yourReaction')}>{message.myReaction}</span>
        )}

        <div className="mt-1.5 flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {message.sentAs === 'template' && (
            <span className="rounded-full border border-border px-1.5 text-[0.6rem] font-semibold text-muted-foreground">
              {t('whatsapp.cloud.sentAsTemplate')}
            </span>
          )}
          <span className="font-mono text-[0.62rem] tabular-nums text-muted-foreground">{stamp}</span>
          {message.deliveryStatus && (
            <span
              className={`inline-flex items-center gap-1 text-[0.62rem] font-semibold ${
                failed ? 'text-[hsl(var(--status-danger))]' : 'text-muted-foreground'
              }`}
            >
              <Icon
                name={DELIVERY_ICON[message.deliveryStatus]}
                size={12}
                className={message.deliveryStatus === 'sending' ? 'animate-spin' : ''}
              />
              {t(DELIVERY_LABEL[message.deliveryStatus])}
            </span>
          )}
          {waiting && (
            <span
              className="inline-flex items-center gap-1 text-[0.62rem] font-semibold text-muted-foreground"
              title={clock(due, intlLocale)}
            >
              <Icon name="refresh" size={12} />
              {t('whatsapp.inbox.retryingIn', { when: relative(due as string, intlLocale) })}
            </span>
          )}
        </div>

        {failed && (
          <div className="mt-2 border-t border-[hsl(var(--status-danger))]/25 pt-2">
            <p
              className="text-xs leading-5 text-[hsl(var(--status-danger))] wrap-anywhere"
              title={message.deliveryError || undefined}
            >
              {/* A recusa por janela tem frase própria: o código cru não diz ao
                  operador que basta o cliente responder. */}
              {message.deliveryError?.startsWith('meta_window_closed')
                ? t('whatsapp.error.metaWindowClosed')
                : t('whatsapp.inbox.deliveryFailed', {
                  reason: truncateReason(message.deliveryError || t('common.unknown'))
                })}
            </p>
            {/* The queue gave up, and how many times it tried before doing so
                is what separates "the number is wrong" from "the server was
                down for a minute". Only on a row that is actually finished:
                while the backoff is still running, the line above says so. */}
            {message.attempts > 0 && (
              <p className="mt-1 text-[0.68rem] text-muted-foreground">
                {t('whatsapp.inbox.attemptsSpent', { count: message.attempts })}
              </p>
            )}
            <button
              type="button"
              className="modern-button-secondary mt-2 min-h-9 px-3 py-1 text-xs"
              disabled={resending}
              onClick={() => onResend(message)}
            >
              <Icon name="refresh" size={13} className={resending ? 'animate-spin' : ''} />
              {t('whatsapp.inbox.resend')}
            </button>
          </div>
        )}
      </div>
      {menu}
    </li>
  )
}
