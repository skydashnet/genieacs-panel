'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  whatsappAPI,
  type WhatsAppAccount,
  type WhatsAppConfig,
  type WhatsAppPurpose,
  type WhatsAppStatus
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { copyToClipboard, formatRelativeTime } from '@/lib/utils'
import { metaWebhookAuto, metaWebhookState } from '@/lib/meta-webhook'
import {
  WA_ACCOUNT_CLASS,
  WA_ACCOUNT_COLORS,
  WA_ACCOUNT_COLOR_LABEL,
  accountColor,
  type WaAccountColor
} from '@/lib/wa-account-color'

const PURPOSES: WhatsAppPurpose[] = ['general', 'billing', 'support', 'sales', 'alerts']

/**
 * The machine `code` from the API is the only thing this screen is allowed to
 * translate. The `message` that comes with it can carry the Evolution server's
 * own words, and a JSON dump on screen sends an operator off re-checking a URL
 * and a key that were never the problem — `license_required` above all.
 * A code we do not know yet reads as the generic failure, never as raw text.
 */
const ERROR_KEYS: Record<string, TranslationKey> = {
  // Não é erro da integração, e está aqui por isso: cada chamada desta tela
  // resolve o código por este mapa, e um `missing_permission` fora dele lia
  // como "a requisição falhou" — a única frase que não diz à pessoa que o
  // problema é o papel dela e que tentar de novo não resolve.
  missing_permission: 'api.missingPermission',
  ai_timeout: 'whatsapp.ai.err.timeout',
  ai_unauthorized: 'whatsapp.ai.err.unauthorized',
  ai_rate_limited: 'whatsapp.ai.err.rateLimited',
  ai_no_balance: 'whatsapp.ai.err.noBalance',
  ai_bad_response: 'whatsapp.ai.err.badResponse',
  ai_unreachable: 'whatsapp.ai.err.unreachable',
  ai_blocked_host: 'whatsapp.ai.err.blockedHost',
  ai_invalid_url: 'whatsapp.ai.err.invalidUrl',
  ai_key_required: 'whatsapp.ai.err.keyRequired',
  ai_key_required_for_new_url: 'whatsapp.ai.err.keyRequiredForNewUrl',
  ai_disabled: 'whatsapp.ai.err.disabled',
  ai_failed: 'whatsapp.ai.err.failed',
  not_configured: 'whatsapp.error.notConfigured',
  incomplete_config: 'whatsapp.error.incompleteConfig',
  invalid_webhook_url: 'whatsapp.error.invalidWebhookUrl',
  invalid_portal_url: 'whatsapp.error.invalidPortalUrl',
  invalid_base_url: 'whatsapp.error.invalidBaseUrl',
  insecure_base_url: 'whatsapp.error.insecureBaseUrl',
  host_not_allowed: 'whatsapp.error.hostNotAllowed',
  blocked_host: 'whatsapp.error.blockedHost',
  unauthorized: 'whatsapp.error.unauthorized',
  license_required: 'whatsapp.error.licenseRequired',
  timeout: 'whatsapp.error.timeout',
  unreachable: 'whatsapp.error.unreachable',
  no_session: 'whatsapp.error.noSession',
  no_account: 'whatsapp.error.noAccount',
  no_destination: 'whatsapp.error.noDestination',
  // A API oficial da Meta.
  meta_window_closed: 'whatsapp.error.metaWindowClosed',
  cloud_requires_v2: 'whatsapp.error.cloudRequiresV2',
  invalid_meta_credentials: 'whatsapp.error.invalidMetaCredentials',
  not_applicable_cloud: 'whatsapp.error.notApplicableCloud',
  not_cloud: 'whatsapp.error.notCloud',
  cloud_instance_still_exists: 'whatsapp.error.cloudInstanceStillExists',
  // Trocar o token no self-host recria a instância com a chave global do
  // servidor, que a tela pede só para isso.
  admin_key_missing: 'settings.whatsapp.test.config.adminKeyMissing',
  not_supported_cloud: 'whatsapp.error.notSupportedCloud',
  invalid_cloud_callback_url: 'whatsapp.error.invalidCloudCallbackUrl',
  meta_templates_cloud_only: 'whatsapp.error.metaTemplatesCloudOnly',
  meta_template_unavailable: 'whatsapp.error.metaTemplateUnavailable',
  meta_param_mismatch: 'whatsapp.error.metaParamMismatch',
  meta_header_mismatch: 'whatsapp.error.metaHeaderMismatch',
  meta_button_mismatch: 'whatsapp.error.metaButtonMismatch',
  meta_header_missing: 'whatsapp.error.metaHeaderMissing',
  invalid_meta_template: 'whatsapp.error.invalidMetaTemplate',
  invalid_meta_price: 'whatsapp.error.invalidMetaPrice',
  // Both reachable only from the inbox, and both were missing until the screen
  // that provokes them was built: an unknown code degrades to the generic
  // failure, which is not wrong but tells the operator nothing.
  message_empty: 'whatsapp.error.messageEmpty',
  conversation_not_found: 'whatsapp.error.conversationNotFound',
  invalid_conversation_status: 'whatsapp.error.invalidConversationStatus',
  // Attachments. `attachment_too_large` reads `{max}`, which is why the helper
  // above takes vars at all.
  attachment_too_large: 'whatsapp.error.attachmentTooLarge',
  attachment_type_not_allowed: 'whatsapp.error.attachmentTypeNotAllowed',
  tag_name_taken: 'whatsapp.tags.nameTaken',
  too_many_tags: 'whatsapp.tags.tooMany',
  invalid_tag: 'whatsapp.tags.invalid',
  invalid_tag_color: 'whatsapp.tags.invalid',
  tag_not_found: 'whatsapp.tags.notFound',
  attachment_content_mismatch: 'whatsapp.error.attachmentContentMismatch',
  attachment_not_allowed: 'whatsapp.error.attachmentNotAllowed',
  attachment_empty: 'whatsapp.error.attachmentEmpty',
  attachment_not_found: 'whatsapp.error.attachmentNotFound',
  no_public_url: 'whatsapp.error.noPublicUrl',
  subscriber_not_found: 'whatsapp.error.subscriberNotFound',
  subscriber_no_phone: 'whatsapp.error.subscriberNoPhone',
  lookup_term_required: 'whatsapp.error.lookupTermRequired',
  // Templates, campaigns and the alert rules. `no_recipients` is the campaign's
  // — the alert scan raises `no_alert_recipients` precisely so one code does
  // not have to mean both "nobody is on duty" and "the filters left nobody".
  template_empty: 'whatsapp.error.templateEmpty',
  template_mirrors: 'whatsapp.error.templateMirrors',
  template_not_found: 'whatsapp.templates.notFound',
  name_taken: 'whatsapp.templates.nameTaken',
  unknown_variable: 'whatsapp.error.unknownVariable',
  invalid_phone: 'whatsapp.error.invalidPhone',
  no_recipients: 'whatsapp.error.noRecipients',
  too_many_recipients: 'whatsapp.error.tooManyRecipients',
  invalid_status: 'whatsapp.error.invalidStatus',
  rate_limited: 'whatsapp.error.rateLimited',
  broadcast_not_found: 'whatsapp.broadcast.notFound',
  no_alert_recipients: 'whatsapp.alerts.noRecipients',
  invalid_email: 'whatsapp.alerts.invalidEmail',
  mail_not_configured: 'whatsapp.alerts.mailNotConfigured',
  invalid_telegram_token: 'whatsapp.alerts.telegramTokenInvalid',
  invalid_telegram_chat: 'whatsapp.alerts.telegramChatInvalid',
  telegram_not_configured: 'whatsapp.alerts.telegramNotConfigured',
  telegram_invalid_token: 'whatsapp.alerts.telegramInvalidToken',
  telegram_bot_not_in_chat: 'whatsapp.alerts.telegramBotNotInChat',
  telegram_chat_not_found: 'whatsapp.alerts.telegramChatNotFound',
  telegram_unreachable: 'whatsapp.alerts.telegramUnreachable',
  telegram_failed: 'whatsapp.alerts.telegramFailed',
  no_alert_number: 'whatsapp.alerts.noAlertNumber',
  alerts_disabled: 'whatsapp.alerts.disabledSkip',
  no_devices: 'whatsapp.alerts.noDevices',
  scan_failed: 'whatsapp.error.scanFailed',
  meta_webhook_failed: 'whatsapp.error.metaWebhookFailed'
}

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string

/**
 * `vars` because some of these sentences carry a number the operator needs —
 * "larger than {max} MB" is the whole message. Without it the placeholder
 * reached the screen literally, so the composer had been keeping its own copy
 * of two entries from this map rather than render `{max}` to somebody.
 */
export function whatsappErrorMessage(
  t: Translate,
  code?: string,
  vars?: Record<string, string | number>
): string {
  return t(ERROR_KEYS[code ?? ''] ?? 'api.requestFailed', vars)
}

const STATUS_BADGE: Record<WhatsAppStatus, string> = {
  pending: 'modern-badge',
  connecting: 'modern-badge-warning',
  connected: 'modern-badge-success',
  disconnected: 'modern-badge-error',
  expired: 'modern-badge-error'
}

const STATUS_LABEL: Record<WhatsAppStatus, TranslationKey> = {
  pending: 'whatsapp.status.pending',
  connecting: 'whatsapp.status.connecting',
  connected: 'whatsapp.status.connected',
  disconnected: 'whatsapp.status.disconnected',
  expired: 'whatsapp.status.expired'
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling
//
// These numbers are MEASURED against a real Evolution server, not picked to
// look tidy, and the three rules under them are what keeps a pairing screen
// from becoming load on a box that is already struggling:
//
//   · a `get_qr` round trip was timed at ~5.4 s — LONGER than its own 8 s
//     interval once the server is busy — so every poll is single-flight and a
//     tick that lands on an open call is dropped, never queued;
//   · a hidden tab skips the tick entirely: an operator leaves this open in a
//     background tab all afternoon, and a QR nobody is looking at is pure cost;
//   · a failing server is backed off as `2 ** failures - 1` skipped ticks and
//     abandoned after three in a row, because the failure that matters here is
//     the one that never ends.
// ─────────────────────────────────────────────────────────────────────────────
const QR_POLL_MS = 8_000
const QR_POLL_BUDGET_MS = 45_000
const STATUS_POLL_MS = 10_000
const STATUS_POLL_BUDGET_MS = 4 * 60_000
const QR_LIFETIME_S = 60
const QR_REFRESH_AT_S = 5
const MAX_FAILURES = 3

/** When the code in hand was issued, or null when there is no code. */
function seedQrAt(account: WhatsAppAccount, seedQr: string | null): number | null {
  if (!seedQr) return null
  const stamped = account.qrUpdatedAt ? Date.parse(account.qrUpdatedAt) : Number.NaN
  return Number.isNaN(stamped) ? Date.now() : stamped
}

function secondsLeft(since: number): number {
  return Math.max(0, QR_LIFETIME_S - Math.floor((Date.now() - since) / 1000))
}

interface QrPairingProps {
  account: WhatsAppAccount
  /**
   * O código que a criação da conta acabou de devolver, quando houve uma.
   *
   * Vem por aqui e não no objeto da conta porque o QR é credencial de
   * pareamento: ele saiu do serializador compartilhado, que serve rotas de
   * `whatsapp.read`, e agora só a rota dedicada — `whatsapp.config` — o
   * entrega. Sem semente, este bloco simplesmente busca o primeiro código no
   * seu próprio laço, que é o que ele já fazia para todos os seguintes.
   */
  seedQr?: string | null
  busy: boolean
  onAccount: (account: WhatsAppAccount) => void
  onForceNew: (account: WhatsAppAccount) => void
}

/**
 * The pairing block for one number. Every timer it starts is owned by an effect
 * and cleared on unmount: the settings page is lazy-loaded and an operator
 * flips between tabs constantly, and an interval that survives the card would
 * keep hitting the Evolution server from a screen nobody is on.
 */
function QrPairing({ account, seedQr = null, busy, onAccount, onForceNew }: QrPairingProps) {
  const { t } = useTranslation()
  const toast = useToast()

  const [qr, setQr] = useState<string | null>(seedQr)
  // Both seeded from the server's own timestamp, so a card rebuilt from a stale
  // listing shows the code's real age instead of a fresh sixty for a second.
  const [qrAt, setQrAt] = useState<number | null>(() => seedQrAt(account, seedQr))
  const [remaining, setRemaining] = useState(() => {
    const stamped = seedQrAt(account, seedQr)
    return stamped === null ? QR_LIFETIME_S : secondsLeft(stamped)
  })
  const [silent, setSilent] = useState(false)
  const [checking, setChecking] = useState(false)

  const qrInFlight = useRef(false)
  const qrFailures = useRef(0)
  // The backoff is held as an instant rather than a counter of skipped ticks
  // because two different clocks ask for a QR — the 8 s acquisition poll and
  // the 1 s countdown, once the code on screen is about to die. A counter is
  // only decremented by the poll, and a failing refresh would then retry every
  // second with no backoff at all. `2 ** failures - 1` intervals is the same
  // number of ticks, expressed in a way both callers can honour.
  // Armed on mount, not at declaration: a clock read during render is not
  // idempotent.
  const qrBlockedUntil = useRef(0)
  const qrDeadline = useRef(0)
  const statusInFlight = useRef(false)
  const statusFailures = useRef(0)
  const statusBlockedUntil = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    qrDeadline.current = Date.now() + QR_POLL_BUDGET_MS
    return () => { alive.current = false }
  }, [])

  const runQr = useCallback(async () => {
    if (qrInFlight.current) return
    qrInFlight.current = true
    try {
      const res = await whatsappAPI.getQr(account.id)
      if (!alive.current) return
      if (!res.success) {
        qrFailures.current += 1
        if (qrFailures.current >= MAX_FAILURES) {
          setSilent(true)
          return
        }
        qrBlockedUntil.current = Date.now() + (2 ** qrFailures.current - 1) * QR_POLL_MS
        return
      }
      qrFailures.current = 0
      qrBlockedUntil.current = 0
      if (res.data?.account) onAccount(res.data.account)
      const next = res.data?.qr ?? null
      if (next) {
        setQr(next)
        setQrAt(Date.now())
        setRemaining(QR_LIFETIME_S)
        // A QR in hand opens a fresh acquisition window: the budget below only
        // bounds the wait for the NEXT one.
        qrDeadline.current = Date.now() + QR_POLL_BUDGET_MS
        return
      }
      // `pending: true` with a null `qr` is a "not yet", not a failure — the GO
      // client answers `400 no QR code available` for its first few seconds.
      setQr(null)
      setQrAt(null)
    } finally {
      qrInFlight.current = false
    }
  }, [account.id, onAccount])

  const runStatus = useCallback(async (manual: boolean) => {
    if (statusInFlight.current) return
    statusInFlight.current = true
    if (manual) setChecking(true)
    try {
      const res = await whatsappAPI.getStatus(account.id)
      if (!alive.current) return
      if (!res.success) {
        statusFailures.current += 1
        statusBlockedUntil.current = Date.now() + (2 ** statusFailures.current - 1) * STATUS_POLL_MS
        if (manual) toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      statusFailures.current = 0
      statusBlockedUntil.current = 0
      // The parent decides what to render from the status; a promotion to
      // `connected` unmounts this block and clears every timer with it.
      if (res.data?.account) onAccount(res.data.account)
    } finally {
      statusInFlight.current = false
      if (manual) setChecking(false)
    }
  }, [account.id, onAccount, t, toast])

  // Acquisition: runs only while there is no QR on screen. When the budget
  // runs out without one, the server is almost certainly resuming an old
  // session instead of issuing a code — that is what the silent block explains.
  useEffect(() => {
    if (silent || qr) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() < qrBlockedUntil.current) return
      if (Date.now() > qrDeadline.current) {
        setSilent(true)
        return
      }
      void runQr()
    }, QR_POLL_MS)
    return () => clearInterval(timer)
  }, [silent, qr, runQr])

  // Countdown. It also drives the refresh at five seconds left, which is finer
  // than the 8 s cadence above and has to be: a QR that dies on screen is a
  // camera pointed at nothing.
  useEffect(() => {
    if (silent || !qr || qrAt === null) return
    const timer = setInterval(() => {
      const left = secondsLeft(qrAt)
      setRemaining(left)
      if (left > QR_REFRESH_AT_S) return
      if (document.visibilityState !== 'visible') return
      if (Date.now() < qrBlockedUntil.current) return
      void runQr()
    }, 1_000)
    return () => clearInterval(timer)
  }, [silent, qr, qrAt, runQr])

  // Status. The budget is generous because the four minutes are the operator's,
  // not the server's — finding the phone and the menu takes that long. When it
  // runs out the polling stops but the card stays as it is: the "already
  // scanned" button below is still there, and it is the way out of an amber
  // card left behind by a lost connection_update.
  useEffect(() => {
    if (silent) return
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - startedAt > STATUS_POLL_BUDGET_MS) {
        clearInterval(timer)
        return
      }
      if (document.visibilityState !== 'visible') return
      if (Date.now() < statusBlockedUntil.current) return
      if (statusFailures.current >= MAX_FAILURES) {
        clearInterval(timer)
        return
      }
      void runStatus(false)
    }, STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [silent, runStatus])

  const checkStatusButton = (
    <div>
      <button
        type="button"
        className="modern-button-secondary"
        disabled={checking}
        onClick={() => void runStatus(true)}
      >
        <Icon name="refresh" size={16} className={checking ? 'animate-spin' : ''} />
        {t('whatsapp.qr.checkStatus')}
      </button>
      <p className="field-hint">{t('whatsapp.qr.checkStatusHint')}</p>
    </div>
  )

  if (silent) {
    return (
      <div className="mt-4 rounded-md border border-amber-500/50 bg-amber-500/10 p-4">
        <p className="text-sm leading-6 text-foreground">{t('whatsapp.qr.silent')}</p>
        <div className="mt-3 flex flex-wrap items-start gap-3">
          <button
            type="button"
            className="modern-button"
            disabled={busy}
            onClick={() => onForceNew(account)}
          >
            {t('whatsapp.qr.forceNew')}
          </button>
          {checkStatusButton}
        </div>
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
      <p className="text-sm font-semibold text-foreground">{t('whatsapp.qr.scan')}</p>
      <p className="field-hint">{t('whatsapp.qr.path')}</p>

      {qr ? (
        <div className="mt-3 flex flex-col items-center gap-3 text-center sm:flex-row sm:items-center sm:text-start">
          {/* The white plate is not decoration: a QR rendered on the dark theme's
              background is not readable by a phone camera. */}
          <img
            src={qr}
            alt={t('whatsapp.qr.scan')}
            className="size-48 rounded-md bg-white p-2 sm:size-56"
          />
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {remaining <= 0
              ? t('whatsapp.qr.expired')
              : remaining <= QR_REFRESH_AT_S
                ? t('whatsapp.qr.expiring', { seconds: remaining })
                : t('whatsapp.qr.expiresIn', { seconds: remaining })}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
          {t('whatsapp.qr.waiting')}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-start gap-3">
        <button
          type="button"
          className="modern-button-secondary"
          disabled={busy}
          onClick={() => onForceNew(account)}
        >
          {t('whatsapp.qr.forceNew')}
        </button>
        {checkStatusButton}
      </div>
    </div>
  )
}

interface Props {
  config: WhatsAppConfig | null
  /** Sem a margem e a linha de cima: para quando o bloco é o único da tela (o assistente de boas-vindas). */
  compact?: boolean
}

/**
 * Os endereços da Meta que o passo a passo cita. São páginas fixas da Meta,
 * e não do painel: abrir em outra aba, sem `referrer`.
 */
const META_LINKS: { href: string; label: TranslationKey }[] = [
  { href: 'https://developers.facebook.com/apps/creation/', label: 'whatsapp.cloud.linkCreateApp' },
  { href: 'https://business.facebook.com/settings/system-users', label: 'whatsapp.cloud.linkSystemUsers' },
  { href: 'https://business.facebook.com/wa/manage/message-templates/', label: 'whatsapp.cloud.linkTemplates' },
  { href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started', label: 'whatsapp.cloud.linkDocs' }
]

/** Uma linha com valor e botão de copiar, para colar no app da Meta. */
function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation()
  const toast = useToast()
  return (
    <div>
      <p className="field-label">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
          {value}
        </code>
        <button
          type="button"
          className="modern-button-secondary shrink-0"
          onClick={() => void copyToClipboard(value).then((ok) => {
            if (ok) toast.success(t('common.copied'))
          })}
        >
          <Icon name="copy" size={16} />
          {t('common.copy')}
        </button>
      </div>
    </div>
  )
}

/** O selo do registro do webhook de um número, com a explicação e o "registrar de novo". */
function MetaWebhookStatus({
  account,
  busy,
  onRetry
}: {
  account: WhatsAppAccount
  busy: boolean
  onRetry: () => void
}) {
  const { t, formatDateTime } = useTranslation()
  const state = metaWebhookState(account)
  const badge = state.tone === 'ok'
    ? 'modern-badge-success'
    : state.tone === 'error' ? 'modern-badge-error' : 'modern-badge'
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-foreground">{t('whatsapp.cloud.webhookStatus')}</span>
        <span className={badge}>{t(state.label)}</span>
        {account.metaWebhookAt && (
          <span className="text-xs text-muted-foreground">{formatDateTime(account.metaWebhookAt)}</span>
        )}
        <button
          type="button"
          className="modern-button-secondary min-h-9 px-3 py-1 text-xs"
          disabled={busy}
          onClick={onRetry}
        >
          <Icon name="refresh" size={14} />
          {t('whatsapp.cloud.webhookRetry')}
        </button>
      </div>
      {state.tone === 'error' && (state.detailKey || state.detailText) && (
        <p className="break-words text-xs text-[hsl(var(--status-danger))]">
          {state.detailKey ? t(state.detailKey) : state.detailText}
        </p>
      )}
    </div>
  )
}

/**
 * O webhook da Meta de um número oficial. A Meta não fala com o painel: ela
 * chama o `/webhook/meta` do servidor Evolution, que repassa ao painel.
 *
 * Com `auto` (SaaS) o painel registra o webhook na conta WABA pela Graph API,
 * e o token de verificação do servidor — um só para todos os provedores —
 * nem chega ao navegador: aqui só aparece o resultado e o "registrar de
 * novo". No self-host o servidor é de quem opera o painel, e a URL e o token
 * continuam aqui para colar no app da Meta.
 */
export function MetaWebhookGuide({
  callbackUrl,
  verifyToken,
  auto = false,
  account,
  busy = false,
  onRetry
}: {
  callbackUrl: string
  verifyToken: string
  auto?: boolean
  account?: WhatsAppAccount
  busy?: boolean
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
      <p className="text-sm font-semibold text-foreground">
        {t(auto ? 'whatsapp.cloud.autoTitle' : 'whatsapp.cloud.guideTitle')}
      </p>
      {auto ? (
        <p className="text-xs text-muted-foreground">{t('whatsapp.cloud.autoHint')}</p>
      ) : callbackUrl && verifyToken ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <CopyField label={t('whatsapp.cloud.callbackUrl')} value={callbackUrl} />
          <CopyField label={t('whatsapp.cloud.verifyToken')} value={verifyToken} />
        </div>
      ) : (
        <p className="text-xs text-[hsl(var(--status-warning))]">{t('whatsapp.cloud.notConfigured')}</p>
      )}
      {account && onRetry && <MetaWebhookStatus account={account} busy={busy} onRetry={onRetry} />}
      <div className="flex flex-wrap gap-2">
        {META_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="modern-button-secondary min-h-9 px-3 py-1 text-xs"
          >
            <Icon name="external" size={14} />
            {t(link.label)}
          </a>
        ))}
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        <li>{t('whatsapp.cloud.step0')}</li>
        {auto ? (
          <>
            <li>{t('whatsapp.cloud.step2')}</li>
            <li>{t('whatsapp.cloud.step4')}</li>
            <li>{t('whatsapp.cloud.autoStep')}</li>
          </>
        ) : (
          <>
            <li>{t('whatsapp.cloud.step1')}</li>
            <li>{t('whatsapp.cloud.step2')}</li>
            <li>{t('whatsapp.cloud.step3')}</li>
            <li>{t('whatsapp.cloud.step4')}</li>
          </>
        )}
      </ol>
    </div>
  )
}

/**
 * The connected numbers, one card each. It lives outside `settings.tsx` so the
 * pairing state machine does not have to share a component with nine other
 * tabs' worth of form state.
 */
export function WhatsAppConnection({ config, compact = false }: Props) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()

  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([])
  /**
   * O QR que a criação de cada número devolveu, por id.
   *
   * Fica aqui e não dentro da conta porque o servidor não o manda mais junto:
   * ele é credencial de pareamento e só a rota dedicada o entrega. Isto é só a
   * semente do primeiro código; os seguintes o próprio bloco de pareamento
   * busca.
   */
  const [qrSeeds, setQrSeeds] = useState<Record<number, string>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  /** O formulário de "Atualizar token" aberto num número oficial, um por vez. */
  const [tokenEdit, setTokenEdit] = useState<{ id: number; metaToken: string; adminKey: string } | null>(null)
  const emptyForm = {
    kind: 'baileys' as 'baileys' | 'cloud',
    label: '',
    purpose: 'general' as WhatsAppPurpose,
    baseUrl: '',
    adminKey: '',
    metaToken: '',
    phoneNumberId: '',
    wabaId: ''
  }
  const [form, setForm] = useState(emptyForm)
  const [edit, setEdit] = useState<{ label: string; purpose: WhatsAppPurpose; color: WaAccountColor }>({
    label: '',
    purpose: 'general',
    color: WA_ACCOUNT_COLORS[0]
  })

  const managed = Boolean(config?.managed)
  /** O callback da Meta: o publicado pela configuração, ou o do servidor próprio. */
  const metaCallback = (baseUrl: string) =>
    config?.cloudWebhook?.callbackUrl || (baseUrl ? `${baseUrl.replace(/\/+$/, '')}/webhook/meta` : '')
  const metaVerifyToken = config?.cloudWebhook?.verifyToken ?? ''
  /** SaaS: o painel registra o webhook na Meta, e URL e token não vêm. */
  const metaAuto = metaWebhookAuto(config)

  const load = useCallback(async () => {
    const res = await whatsappAPI.listAccounts()
    if (res.success && res.data) setAccounts(res.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Stable: the pairing block keys its intervals off this callback, and a new
  // identity on every render would reset the 8 s cadence before it ever fired.
  const mergeAccount = useCallback((account: WhatsAppAccount) => {
    setAccounts((current) => current.map((row) => (row.id === account.id ? account : row)))
  }, [])

  const createAccount = useCallback(async () => {
    setCreating(true)
    try {
      const res = await whatsappAPI.createAccount({
        label: form.label || undefined,
        purpose: form.purpose,
        // Ignored in managed mode, where the panel owns the server and the
        // operator never sees its address or its key.
        ...(managed ? {} : {
          ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}),
          ...(form.adminKey ? { adminKey: form.adminKey } : {})
        }),
        ...(form.kind === 'cloud' ? {
          kind: 'cloud' as const,
          metaToken: form.metaToken.trim(),
          phoneNumberId: form.phoneNumberId.trim(),
          wabaId: form.wabaId.trim()
        } : {})
      })
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      // O QR da criação é guardado à parte, e não no objeto da conta: ele não
      // vem mais do servidor dentro dela.
      const created = res.data.account
      const qrDaCriacao = res.data.qr
      if (qrDaCriacao) setQrSeeds((current) => ({ ...current, [created.id]: qrDaCriacao }))
      setAccounts((current) => [...current, created])
      setAdding(false)
      setForm(emptyForm)
    } finally {
      setCreating(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `emptyForm` é constante
  }, [form, managed, t, toast])

  /**
   * "Unpair and generate a new QR". A server still holding a session RESUMES it
   * instead of issuing a code, so a logout is the only escape — and after the
   * logout the pairing has to start from a new instance. The old row is dropped
   * only once the new one exists: it is the panel's single handle on the
   * instance, and losing it early would leave something running on the server
   * with no way to reach it.
   */
  const forceNew = useCallback(async (account: WhatsAppAccount) => {
    setBusyId(account.id)
    try {
      const out = await whatsappAPI.disconnectAccount(account.id)
      if (!out.success) {
        toast.error(whatsappErrorMessage(t, out.code))
        return
      }
      const res = await whatsappAPI.createAccount({
        label: account.label || undefined,
        purpose: account.purpose,
        ...(managed ? {} : { baseUrl: account.baseUrl })
      })
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        await load()
        return
      }
      await whatsappAPI.deleteAccount(account.id)
      await load()
    } finally {
      setBusyId(null)
    }
  }, [load, managed, t, toast])

  const act = useCallback(async (
    account: WhatsAppAccount,
    run: () => Promise<{ success: boolean; code?: string; message?: string }>
  ) => {
    setBusyId(account.id)
    try {
      const res = await run()
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      await load()
    } finally {
      setBusyId(null)
    }
  }, [load, t, toast])

  const removeAccount = useCallback(async (account: WhatsAppAccount) => {
    const title = account.label || account.phoneE164 || account.name
    if (!window.confirm(`${t('whatsapp.actions.delete')} — ${title}`)) return
    setBusyId(account.id)
    try {
      const res = await whatsappAPI.deleteAccount(account.id)
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      // The row goes either way; the server may have kept the instance. The
      // reason it gives is the Evolution server's own words, so the warning
      // says what the operator has to DO about it instead of quoting them.
      if (res.data && !res.data.removedOnServer) {
        toast.warning(t('whatsapp.accounts.removedLocallyOnly'))
      }
      await load()
    } finally {
      setBusyId(null)
    }
  }, [load, t, toast])

  /**
   * Troca o token da Meta. Na falha a linha continua (o servidor grava o
   * motivo em `last_error`), então a lista é relida para mostrá-lo; o
   * formulário fica aberto para a pessoa tentar de novo sem colar tudo outra vez.
   */
  const saveMetaToken = useCallback(async (account: WhatsAppAccount) => {
    if (!tokenEdit || tokenEdit.id !== account.id) return
    setBusyId(account.id)
    try {
      const res = await whatsappAPI.updateMetaToken(
        account.id,
        tokenEdit.metaToken.trim(),
        managed ? undefined : tokenEdit.adminKey.trim() || undefined
      )
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        await load()
        return
      }
      toast.success(t('whatsapp.cloud.tokenUpdated'))
      setTokenEdit(null)
      await load()
    } finally {
      setBusyId(null)
    }
  }, [load, managed, t, toast, tokenEdit])

  const retryMetaWebhook = useCallback(async (account: WhatsAppAccount) => {
    setBusyId(account.id)
    try {
      const res = await whatsappAPI.registerMetaWebhook(account.id)
      if (!res.success) {
        toast.error(res.message || whatsappErrorMessage(t, res.code))
        await load()
        return
      }
      toast.success(t('whatsapp.cloud.webhookRegistered'))
      await load()
    } finally {
      setBusyId(null)
    }
  }, [load, t, toast])

  const saveEdit = useCallback(async (account: WhatsAppAccount) => {
    setBusyId(account.id)
    try {
      const res = await whatsappAPI.updateAccount(account.id, {
        label: edit.label,
        purpose: edit.purpose,
        color: edit.color
      })
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      setEditing(null)
      await load()
    } finally {
      setBusyId(null)
    }
  }, [edit, load, t, toast])

  return (
    <div className={compact ? '' : 'mt-8 border-t border-border pt-6'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="section-heading">{t('whatsapp.accounts.title')}</h3>
        <div className="flex gap-2">
          <button type="button" className="modern-button-secondary" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            {t('common.refresh')}
          </button>
          <button
            type="button"
            className="modern-button"
            disabled={!config?.ready}
            onClick={() => setAdding((current) => !current)}
          >
            {t('whatsapp.accounts.add')}
          </button>
        </div>
      </div>

      {!config?.ready && (
        <p className="field-hint">{t('whatsapp.error.notConfigured')}</p>
      )}

      {adding && (
        <div className="mt-4 space-y-4 rounded-md border border-border p-4">
          <fieldset>
            <legend className="field-label">{t('whatsapp.cloud.kindTitle')}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['baileys', 'cloud'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={form.kind === kind}
                  onClick={() => setForm((c) => ({ ...c, kind }))}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    form.kind === kind
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Icon name={kind === 'cloud' ? 'lock' : 'phone'} size={16} />
                    {t(kind === 'cloud' ? 'whatsapp.cloud.kindCloud' : 'whatsapp.cloud.kindQr')}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t(kind === 'cloud' ? 'whatsapp.cloud.kindCloudHint' : 'whatsapp.cloud.kindQrHint')}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="wa-new-label" className="field-label">
                {t('whatsapp.accounts.label')}
              </label>
              <input
                id="wa-new-label"
                type="text"
                className="modern-input w-full"
                value={form.label}
                onChange={(event) => setForm((c) => ({ ...c, label: event.target.value }))}
              />
            </div>
            <div className="flex flex-col justify-end">
              {/* The dictionary ships the purpose VALUES but no field label for
                  them, and inventing one would mean editing five locales another
                  agent owns. The control is named by the value it carries rather
                  than by an untranslated string invented here. */}
              <select
                aria-label={t(`whatsapp.purpose.${form.purpose}`)}
                className="modern-input w-full"
                value={form.purpose}
                onChange={(event) =>
                  setForm((c) => ({ ...c, purpose: event.target.value as WhatsAppPurpose }))}
              >
                {PURPOSES.map((purpose) => (
                  <option key={purpose} value={purpose}>{t(`whatsapp.purpose.${purpose}`)}</option>
                ))}
              </select>
            </div>
          </div>

          {!managed && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="wa-new-base-url" className="field-label">
                  {t('whatsapp.accounts.serverUrl')}
                </label>
                <input
                  id="wa-new-base-url"
                  type="url"
                  className="modern-input w-full"
                  placeholder="https://evolution.exemplo.com"
                  value={form.baseUrl}
                  onChange={(event) => setForm((c) => ({ ...c, baseUrl: event.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="wa-new-admin-key" className="field-label">
                  {t('settings.whatsapp.adminKey')}
                </label>
                <input
                  id="wa-new-admin-key"
                  type="password"
                  autoComplete="new-password"
                  className="modern-input w-full"
                  value={form.adminKey}
                  onChange={(event) => setForm((c) => ({ ...c, adminKey: event.target.value }))}
                />
                <p className="field-hint">{t('settings.whatsapp.adminKeyHint')}</p>
              </div>
            </div>
          )}

          {form.kind === 'cloud' && (
            <>
              <div>
                <label htmlFor="wa-new-meta-token" className="field-label">
                  {t('whatsapp.cloud.token')}
                </label>
                <input
                  id="wa-new-meta-token"
                  type="password"
                  autoComplete="new-password"
                  className="modern-input w-full"
                  value={form.metaToken}
                  onChange={(event) => setForm((c) => ({ ...c, metaToken: event.target.value }))}
                />
                <p className="field-hint">{t('whatsapp.cloud.tokenHint')}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="wa-new-phone-number-id" className="field-label">
                    {t('whatsapp.cloud.phoneNumberId')}
                  </label>
                  <input
                    id="wa-new-phone-number-id"
                    type="text"
                    inputMode="numeric"
                    className="modern-input w-full font-mono"
                    value={form.phoneNumberId}
                    onChange={(event) => setForm((c) => ({ ...c, phoneNumberId: event.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="wa-new-waba-id" className="field-label">
                    {t('whatsapp.cloud.wabaId')}
                  </label>
                  <input
                    id="wa-new-waba-id"
                    type="text"
                    inputMode="numeric"
                    className="modern-input w-full font-mono"
                    value={form.wabaId}
                    onChange={(event) => setForm((c) => ({ ...c, wabaId: event.target.value }))}
                  />
                </div>
                <p className="field-hint sm:col-span-2">{t('whatsapp.cloud.idsHint')}</p>
              </div>
              <MetaWebhookGuide
                callbackUrl={metaAuto ? '' : metaCallback(form.baseUrl)}
                verifyToken={metaVerifyToken}
                auto={metaAuto}
              />
            </>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="modern-button"
              disabled={creating || (form.kind === 'cloud'
                && !(form.metaToken.trim() && form.phoneNumberId.trim() && form.wabaId.trim()))}
              onClick={() => void createAccount()}
            >
              {creating ? t('common.saving') : t(form.kind === 'cloud' ? 'whatsapp.cloud.connect' : 'whatsapp.actions.connect')}
            </button>
            <button
              type="button"
              className="modern-button-secondary"
              onClick={() => setAdding(false)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : accounts.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('whatsapp.accounts.empty')}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {accounts.map((account) => {
            const busy = busyId === account.id
            // Número oficial não pareia nem tem sessão: nada de QR, reconectar,
            // reiniciar ou desconectar — o estado vem da Meta.
            const cloud = account.integration === 'cloud'
            const pairing = !cloud && (account.status === 'pending' || account.status === 'connecting')
            const down = !cloud && (account.status === 'disconnected' || account.status === 'expired')
            return (
              <li key={account.id} className="rounded-md border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    {/* A cor aparece aqui, onde ela é configurada, para o
                        operador aprender o mapa antes de vê-lo na caixa. */}
                    <p className={`flex items-center gap-2 text-sm font-semibold text-foreground ${WA_ACCOUNT_CLASS[accountColor(account)]}`}>
                      <span
                        className="size-3 shrink-0 rounded-full bg-[hsl(var(--wa-account))]"
                        title={t(WA_ACCOUNT_COLOR_LABEL[accountColor(account)])}
                        aria-hidden="true"
                      />
                      {account.label || account.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {account.phoneE164
                        || (cloud && account.metaPhoneNumberId
                          ? t('whatsapp.cloud.phoneId', { id: account.metaPhoneNumberId })
                          : t('common.notAvailable'))}
                      {' · '}
                      {t(`whatsapp.purpose.${account.purpose}`)}
                      {' · '}
                      {account.lastSeenAt ? formatDateTime(account.lastSeenAt) : t('common.never')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {cloud && (
                      <span className="modern-badge-info">{t('whatsapp.cloud.badge')}</span>
                    )}
                    {account.isDefault && (
                      <span className="modern-badge-info">{t('whatsapp.accounts.isDefault')}</span>
                    )}
                    <span className={STATUS_BADGE[account.status]}>
                      <span className="status-dot" />
                      {t(STATUS_LABEL[account.status])}
                    </span>
                  </div>
                </div>

                {account.lastError && (
                  /* The stored diagnostic, shown on purpose: it is the only
                     record of why a number stopped, and it is already in the
                     row rather than in a response we are translating. */
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                    {account.lastError}
                  </p>
                )}

                {/* O webhook como o servidor Evolution o guarda.
                    Fica ao lado do estado da conexão porque é a OUTRA metade
                    da mesma pergunta: um número conectado é o painel falando
                    com o WhatsApp, e o webhook é o WhatsApp falando com o
                    painel. Sem esta linha, "conectado" e "nada chega" eram
                    dois fatos sem relação visível na tela. */}
                {account.webhookVerdict && account.webhookVerdict !== 'ok' && (
                  /* Amarelo para `events_unknown` e vermelho para o resto: ali
                     o painel não viu nada quebrado, viu que não consegue
                     conferir a lista de eventos. Pintar de vermelho um servidor
                     possivelmente são é o erro mais caro deste cartão. */
                  <p className={`mt-2 text-xs ${account.webhookVerdict === 'events_unknown'
                    ? 'text-[hsl(var(--status-warning))]'
                    : 'text-[hsl(var(--status-danger))]'}`}>
                    {t(`whatsapp.webhook.verdict.${account.webhookVerdict}`)}
                    {account.webhookServerUrl && (
                      <span className="ml-2 break-all font-mono text-muted-foreground">
                        {account.webhookServerUrl}
                      </span>
                    )}
                  </p>
                )}
                {account.webhookProbeVerdict && account.webhookProbeVerdict !== 'reached' && (
                  /* A volta. Fica ABAIXO do veredito de configuração porque é
                     a leitura mais forte das duas: aquele diz o que está
                     gravado, este diz o que acontece. Os dois se contradizendo
                     — `ok` em cima, `wrong_target` aqui — é exatamente o caso
                     que a comparação sozinha não pegava, e é o que o operador
                     precisa ler. */
                  <p className="mt-1 text-xs text-[hsl(var(--status-danger))]">
                    {t(`whatsapp.webhook.probe.${account.webhookProbeVerdict}`)}
                  </p>
                )}
                {account.webhookProbeVerdict === 'reached' && (
                  <p className="mt-1 text-xs text-[hsl(var(--status-success))]">
                    {t('whatsapp.webhook.probe.reached')}
                  </p>
                )}
                {account.webhookRefusedAt && (
                  /* Um evento chegou e levou 401. É o fato mais forte que o
                     painel tem sobre o webhook — prova que o Evolution ESTÁ
                     chamando — e por isso aparece mesmo quando o veredito
                     acima diz `ok`: os dois se contradizendo é exatamente o
                     que o operador precisa ver. */
                  <p className="mt-1 text-xs text-[hsl(var(--status-danger))]">
                    {t(`whatsapp.webhook.refused.${account.webhookRefusedReason || 'bad_token'}`)}
                    {' — '}
                    {formatRelativeTime(account.webhookRefusedAt)}
                  </p>
                )}

                {editing === account.id ? (
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`wa-label-${account.id}`} className="field-label">
                        {t('whatsapp.accounts.label')}
                      </label>
                      <input
                        id={`wa-label-${account.id}`}
                        type="text"
                        className="modern-input w-full"
                        value={edit.label}
                        onChange={(event) => setEdit((c) => ({ ...c, label: event.target.value }))}
                      />
                    </div>
                    <div className="flex flex-col justify-end">
                      <select
                        aria-label={t(`whatsapp.purpose.${edit.purpose}`)}
                        className="modern-input w-full"
                        value={edit.purpose}
                        onChange={(event) =>
                          setEdit((c) => ({ ...c, purpose: event.target.value as WhatsAppPurpose }))}
                      >
                        {PURPOSES.map((purpose) => (
                          <option key={purpose} value={purpose}>
                            {t(`whatsapp.purpose.${purpose}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <fieldset className="sm:col-span-2">
                      <legend className="field-label">{t('whatsapp.accounts.color')}</legend>
                      <div className="flex flex-wrap gap-2">
                        {WA_ACCOUNT_COLORS.map((cor) => (
                          <button
                            key={cor}
                            type="button"
                            aria-pressed={edit.color === cor}
                            onClick={() => setEdit((c) => ({ ...c, color: cor }))}
                            className={`${WA_ACCOUNT_CLASS[cor]} inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                              edit.color === cor
                                ? 'border-[hsl(var(--wa-account))] bg-[hsl(var(--wa-account))]/15 text-[hsl(var(--wa-account))]'
                                : 'border-border text-muted-foreground hover:border-[hsl(var(--wa-account))]/60'
                            }`}
                          >
                            <span className="size-3 shrink-0 rounded-full bg-[hsl(var(--wa-account))]" aria-hidden="true" />
                            {t(WA_ACCOUNT_COLOR_LABEL[cor])}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <div className="flex flex-wrap gap-3 sm:col-span-2">
                      <button
                        type="button"
                        className="modern-button"
                        disabled={busy}
                        onClick={() => void saveEdit(account)}
                      >
                        {busy ? t('common.saving') : t('common.save')}
                      </button>
                      <button
                        type="button"
                        className="modern-button-secondary"
                        onClick={() => setEditing(null)}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {account.status === 'connected' && !account.isDefault && (
                      <button
                        type="button"
                        className="modern-button-secondary"
                        disabled={busy}
                        onClick={() => void act(account, () =>
                          whatsappAPI.updateAccount(account.id, { isDefault: true }))}
                      >
                        {t('whatsapp.accounts.makeDefault')}
                      </button>
                    )}
                    {down && (
                      <button
                        type="button"
                        className="modern-button-secondary"
                        disabled={busy}
                        onClick={() => void act(account, () => whatsappAPI.restartAccount(account.id))}
                      >
                        {t('whatsapp.actions.reconnect')}
                      </button>
                    )}
                    {/* Conferir sempre, reescrever só quando há o que
                        consertar. Um botão que reescreve um webhook correto
                        não conserta nada e conversa com o servidor à toa —
                        e, pior, ensina o operador a apertá-lo por reflexo. */}
                    <button
                      type="button"
                      className="modern-button-secondary"
                      disabled={busy}
                      onClick={() => void act(account, () => whatsappAPI.checkWebhook(account.id))}
                    >
                      {t('whatsapp.actions.checkWebhook')}
                    </button>
                    {/* Sempre disponível, e não só quando algo parece errado:
                        é justamente quando TUDO parece certo que ela tem algo
                        a dizer. */}
                    <button
                      type="button"
                      className="modern-button-secondary"
                      disabled={busy}
                      onClick={() => void act(account, () => whatsappAPI.probeWebhook(account.id))}
                    >
                      {t('whatsapp.actions.probeWebhook')}
                    </button>
                    {account.webhookVerdict && account.webhookVerdict !== 'ok' && (
                      <button
                        type="button"
                        className="modern-button-secondary"
                        disabled={busy}
                        onClick={() => void act(account, () => whatsappAPI.reapplyWebhook(account.id))}
                      >
                        {t('whatsapp.actions.reapplyWebhook')}
                      </button>
                    )}
                    {cloud && account.status !== 'connected' && (
                      <button
                        type="button"
                        className="modern-button-secondary"
                        disabled={busy}
                        onClick={() => void act(account, () => whatsappAPI.getStatus(account.id))}
                      >
                        {t('whatsapp.cloud.checkStatus')}
                      </button>
                    )}
                    {/* Token vencido ou revogado na Meta: a troca recria a
                        instância no servidor, por isso fica atrás de um
                        formulário e não é um clique só. */}
                    {cloud && (
                      <button
                        type="button"
                        className="modern-button-secondary"
                        disabled={busy}
                        aria-expanded={tokenEdit?.id === account.id}
                        onClick={() => setTokenEdit((current) =>
                          current?.id === account.id ? null : { id: account.id, metaToken: '', adminKey: '' })}
                      >
                        <Icon name="lock" size={16} />
                        {t('whatsapp.cloud.updateToken')}
                      </button>
                    )}
                    {!cloud && account.status === 'connected' && (
                      <>
                        <button
                          type="button"
                          className="modern-button-secondary"
                          disabled={busy}
                          onClick={() => void act(account, () => whatsappAPI.restartAccount(account.id))}
                        >
                          {t('whatsapp.actions.restart')}
                        </button>
                        <button
                          type="button"
                          className="modern-button-secondary"
                          disabled={busy}
                          onClick={() => void act(account, () => whatsappAPI.disconnectAccount(account.id))}
                        >
                          {t('whatsapp.actions.disconnect')}
                        </button>
                      </>
                    )}
                    {down && (
                      <button
                        type="button"
                        className="modern-button-secondary"
                        disabled={busy}
                        onClick={() => void forceNew(account)}
                      >
                        {t('whatsapp.qr.forceNew')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="modern-button-secondary"
                      disabled={busy}
                      onClick={() => {
                        setEdit({ label: account.label ?? '', purpose: account.purpose, color: accountColor(account) })
                        setEditing(account.id)
                      }}
                    >
                      <Icon name="edit" size={16} />
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      className="modern-button-danger"
                      disabled={busy}
                      onClick={() => void removeAccount(account)}
                    >
                      <Icon name="trash" size={16} />
                      {t('whatsapp.actions.delete')}
                    </button>
                  </div>
                )}

                {cloud && tokenEdit?.id === account.id && (
                  <div className="mt-3 space-y-4 rounded-md border border-border p-4">
                    <div>
                      <label htmlFor={`wa-meta-token-${account.id}`} className="field-label">
                        {t('whatsapp.cloud.token')}
                      </label>
                      <input
                        id={`wa-meta-token-${account.id}`}
                        type="password"
                        autoComplete="off"
                        className="modern-input w-full"
                        value={tokenEdit.metaToken}
                        onChange={(event) => {
                          const metaToken = event.target.value
                          setTokenEdit((c) => (c ? { ...c, metaToken } : c))
                        }}
                      />
                      <p className="field-hint">{t('whatsapp.cloud.updateTokenHint')}</p>
                    </div>
                    {!managed && (
                      <div>
                        <label htmlFor={`wa-meta-admin-key-${account.id}`} className="field-label">
                          {t('settings.whatsapp.adminKey')}
                        </label>
                        <input
                          id={`wa-meta-admin-key-${account.id}`}
                          type="password"
                          autoComplete="off"
                          className="modern-input w-full"
                          value={tokenEdit.adminKey}
                          onChange={(event) => {
                            const adminKey = event.target.value
                            setTokenEdit((c) => (c ? { ...c, adminKey } : c))
                          }}
                        />
                        <p className="field-hint">{t('settings.whatsapp.adminKeyHint')}</p>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        className="modern-button"
                        disabled={busy || !tokenEdit.metaToken.trim()}
                        onClick={() => void saveMetaToken(account)}
                      >
                        {busy ? t('common.saving') : t('common.save')}
                      </button>
                      <button
                        type="button"
                        className="modern-button-secondary"
                        onClick={() => setTokenEdit(null)}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}

                {cloud && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-semibold text-muted-foreground hover:text-foreground">
                      {t('whatsapp.cloud.guideTitle')}
                    </summary>
                    <div className="mt-2">
                      <MetaWebhookGuide
                        callbackUrl={metaAuto ? '' : metaCallback(account.baseUrl)}
                        verifyToken={metaVerifyToken}
                        auto={metaAuto}
                        account={account}
                        busy={busy}
                        onRetry={() => void retryMetaWebhook(account)}
                      />
                    </div>
                  </details>
                )}

                {pairing && (
                  <QrPairing
                    account={account}
                    seedQr={qrSeeds[account.id] ?? null}
                    busy={busy}
                    onAccount={mergeAccount}
                    onForceNew={(row) => void forceNew(row)}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default WhatsAppConnection
