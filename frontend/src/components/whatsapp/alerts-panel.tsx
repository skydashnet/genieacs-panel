'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  whatsappAPI,
  type WhatsAppAlertRule,
  type WhatsAppAlertSettings
} from '@/lib/api'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { telegramCanTest, telegramPatch, telegramWillNotify, type TelegramForm } from '@/lib/alert-telegram'

/**
 * The four rules, in the order the service evaluates them, each with the ONE
 * thing this screen exists to keep straight: what its threshold is counting.
 *
 * A form with four boxes all labelled "Threshold" is a form that gets a dBm
 * typed into a minutes field, and the operator never finds out — a threshold
 * of -27 minutes simply means every ONT is offline, forever, at 3 a.m. So the
 * unit sentence is not a tooltip and not a footnote: it sits under its own box,
 * and `step`/`min`/`max` are per rule too so the widget itself refuses most of
 * the confusions the label is warning about.
 *
 * `min`/`max` mirror what `waAlertService` would accept, they do not invent a
 * second opinion:
 *   · rx_power_low is the only NEGATIVE threshold, so it is the only one
 *     without a `min` of 0 — a spinner that cannot reach -27 would be a form
 *     fighting its own default;
 *   · mass_outage floors at 2 because the service floors it at 2
 *     (`Math.max(2, …)`); offering 1 would be offering a number that silently
 *     becomes another one.
 */
const RULES: ReadonlyArray<{
  rule: WhatsAppAlertRule
  icon: string
  label: TranslationKey
  /** Says what the number MEANS — minutes, dBm, °C, or a count of ONTs. */
  hint: TranslationKey
  min?: number
  max?: number
  step: number
}> = [
  {
    rule: 'ont_offline',
    icon: 'power',
    label: 'whatsapp.alerts.ontOffline',
    hint: 'whatsapp.alerts.ontOfflineHint',
    min: 1,
    max: 1440,
    step: 1
  },
  {
    rule: 'rx_power_low',
    icon: 'signal',
    label: 'whatsapp.alerts.rxPowerLow',
    hint: 'whatsapp.alerts.rxPowerLowHint',
    max: 0,
    step: 0.5
  },
  {
    rule: 'temperature_high',
    icon: 'thermometer',
    label: 'whatsapp.alerts.temperatureHigh',
    hint: 'whatsapp.alerts.temperatureHighHint',
    min: 0,
    max: 120,
    step: 1
  },
  {
    rule: 'mass_outage',
    icon: 'warning',
    label: 'whatsapp.alerts.massOutage',
    hint: 'whatsapp.alerts.massOutageHint',
    min: 2,
    max: 500,
    step: 1
  },
  {
    // O limite é a carência em minutos: uma queda que se resolve sozinha
    // antes dela não avisa ninguém.
    rule: 'wa_disconnected',
    icon: 'chat',
    label: 'whatsapp.alerts.waDisconnected',
    hint: 'whatsapp.alerts.waDisconnectedHint',
    min: 0,
    max: 120,
    step: 1
  },
  {
    // Minutos de espera por gente, no horário de atendimento.
    rule: 'wa_waiting',
    icon: 'contacts',
    label: 'whatsapp.alerts.waWaitingRule',
    hint: 'whatsapp.alerts.waWaitingHint',
    min: 1,
    max: 240,
    step: 1
  }
]

/** The service clamps to these; the inputs say so rather than letting the
 *  operator type a number that is quietly replaced on the way in. */
const INTERVAL_MIN_S = 60
const INTERVAL_MAX_S = 3600
const COOLDOWN_MIN_MIN = 1
const COOLDOWN_MAX_MIN = 7 * 24 * 60

/**
 * The form holds STRINGS, not numbers.
 *
 * An emptied box has to survive as "empty" while it is being retyped — a
 * `number` state turns the first keystroke of "-27" into a value, and coercing
 * on every change makes the field impossible to clear.
 *
 * What must NOT survive is an empty box at save time. `WhatsAppAlertSettings`
 * types `threshold` as `number | null` and `waAlertService.normalizeRules`
 * documents `null` as "use the default", but it does not do that: the check is
 * `Number.isFinite(Number(value.threshold))`, and `Number(null)` is `0`, which
 * is finite. So a `null` threshold is stored as ZERO — "alert above 0 °C" is
 * every ONT on the network, forever, at 3 a.m. (`undefined` is what actually
 * reaches the default, because `Number(undefined)` is `NaN`; JSON cannot carry
 * it without dropping the key entirely.)
 *
 * Rather than send a value the service mis-reads, an emptied box is refilled
 * on blur with what the server last said was stored — so the number the
 * operator can see is always the number that is really in force, and clearing
 * a field can never quietly arm every rule at zero.
 */
interface RuleForm {
  enabled: boolean
  threshold: string
  cooldownMinutes: string
}

interface AlertsForm {
  enabled: boolean
  intervalSeconds: string
  digestMinutes: string
  /** The textarea verbatim, one number per line. Parsed only on save. */
  recipients: string
  /** O mesmo, um e-mail por linha. */
  emailRecipients: string
  /** O bloco do Telegram — ver `lib/alert-telegram.ts`. */
  telegram: TelegramForm
  rules: Record<WhatsAppAlertRule, RuleForm>
}

function toForm(settings: WhatsAppAlertSettings): AlertsForm {
  const rules = {} as Record<WhatsAppAlertRule, RuleForm>
  for (const { rule } of RULES) {
    const stored = settings.rules?.[rule]
    rules[rule] = {
      enabled: stored?.enabled ?? false,
      threshold: stored?.threshold === null || stored?.threshold === undefined
        ? ''
        : String(stored.threshold),
      cooldownMinutes: stored?.cooldownMinutes === undefined
        ? ''
        : String(stored.cooldownMinutes)
    }
  }
  return {
    enabled: settings.enabled,
    intervalSeconds: String(settings.intervalSeconds),
    digestMinutes: String(settings.digestMinutes ?? 0),
    recipients: (settings.recipients ?? []).join('\n'),
    emailRecipients: (settings.emailRecipients ?? []).join('\n'),
    // O token nunca vem: o campo começa vazio, que quer dizer "manter".
    telegram: { token: '', chatId: settings.telegram?.chatId ?? '', remove: false },
    rules
  }
}

/** One number per line. Blank lines are not recipients, they are typing. */
function parseRecipients(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * A number, or the fallback when the box holds nothing usable.
 *
 * Never `null` — see the note on `RuleForm` for what the service does with one.
 */
function parseNumber(value: string, fallback: number): number {
  const number = Number(value.trim())
  return value.trim() && Number.isFinite(number) ? number : fallback
}

function parseInteger(value: string, fallback: number): number {
  return Math.round(parseNumber(value, fallback))
}

/**
 * Technical alerts: what the panel watches, and who it wakes.
 *
 * Self-contained — it owns its heading, its own load and its own save — because
 * it is mounted as one tab among several and must not need the page to hold any
 * of its state.
 *
 * Two things on this screen are louder than the rest, and both are about an
 * operator believing the fleet is watched when it is not:
 *
 *  · an EMPTY on-duty list means nothing is sent, however loud the fleet gets.
 *    The dictionary says so in `recipientsHint`, and when the list is actually
 *    empty that sentence is promoted out of the small grey hint into a warning
 *    the eye cannot skip. Enabling with an empty list is refused by the API
 *    (`no_alert_recipients`), so the warning is not a guess about what will
 *    happen.
 *  · "Scan now" is REAL. It runs the sweep against the stored settings and can
 *    put messages on the on-duty phones, so it is never run on mount and never
 *    polled — `waAlertService` already runs itself on its own interval from
 *    `server.js`, and a screen that scanned when it loaded would send alerts
 *    because somebody opened a tab.
 */
export function AlertsPanel() {
  const { t } = useTranslation()
  const toast = useToast()

  const [form, setForm] = useState<AlertsForm | null>(null)
  /**
   * The last settings the SERVER acknowledged, kept beside the form.
   *
   * It is what an emptied box is refilled from, so "empty" is never a value
   * this screen sends — see the note on `RuleForm`.
   */
  const [stored, setStored] = useState<WhatsAppAlertSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  /**
   * The scan's own sentence, as the SERVER rendered it.
   *
   * `whatsapp.alerts.scanDone` — the one line that names {fired} and {cleared}
   * — lives only in the backend dictionary; the browser's `TranslationKey` has
   * no such key, and inventing one here is not this file's call. The API client
   * sends `Accept-Language`, so `res.message` already arrives in the operator's
   * own language; it is kept on screen because a toast that has faded cannot
   * answer "did that do anything?".
   */
  const [scanResult, setScanResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await whatsappAPI.getAlertSettings()
      if (res.success && res.data) {
        setStored(res.data)
        setForm(toForm(res.data))
        return
      }
      toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const recipients = useMemo(
    () => (form ? parseRecipients(form.recipients) : []),
    [form]
  )
  const emailRecipients = useMemo(
    () => (form ? parseRecipients(form.emailRecipients) : []),
    [form]
  )
  // Ninguém em canal nenhum: é esse o estado que o aviso grita, e agora são
  // dois canais — um número OU um e-mail já é alguém para acordar.
  const telegramOn = form ? telegramWillNotify(form.telegram, Boolean(stored?.telegram?.configured)) : false
  const noRecipients = recipients.length === 0 && emailRecipients.length === 0 && !telegramOn
  const [testingTelegram, setTestingTelegram] = useState(false)
  const patchTelegram = (patch: Partial<TelegramForm>) => {
    setForm((current) => (current ? { ...current, telegram: { ...current.telegram, ...patch } } : current))
  }
  const mailOff = stored?.mailConfigured === false

  const patchRule = (rule: WhatsAppAlertRule, patch: Partial<RuleForm>) => {
    setForm((current) => (current
      ? { ...current, rules: { ...current.rules, [rule]: { ...current.rules[rule], ...patch } } }
      : current))
  }

  /** What the server last said this rule's threshold and cooldown are. */
  const storedThreshold = (rule: WhatsAppAlertRule): number =>
    stored?.rules?.[rule]?.threshold ?? 0
  const storedCooldown = (rule: WhatsAppAlertRule): number =>
    stored?.rules?.[rule]?.cooldownMinutes ?? COOLDOWN_MIN_MIN

  /**
   * Refills an emptied box on blur with the stored value.
   *
   * Not cosmetic: a box left empty would be sent as a number the service reads
   * as zero, and zero is a threshold that fires on everything. The operator
   * sees the real value come back the moment they leave the field rather than
   * discovering it after a save.
   */
  const restoreThreshold = (rule: WhatsAppAlertRule) => {
    const raw = form?.rules[rule].threshold ?? ''
    if (raw.trim() && Number.isFinite(Number(raw))) return
    patchRule(rule, { threshold: String(storedThreshold(rule)) })
  }

  const restoreCooldown = (rule: WhatsAppAlertRule) => {
    const raw = form?.rules[rule].cooldownMinutes ?? ''
    if (raw.trim() && Number.isFinite(Number(raw))) return
    patchRule(rule, { cooldownMinutes: String(storedCooldown(rule)) })
  }

  const handleSave = async () => {
    if (!form) return
    setSaving(true)
    try {
      const rules = {} as WhatsAppAlertSettings['rules']
      for (const { rule } of RULES) {
        const value = form.rules[rule]
        rules[rule] = {
          enabled: value.enabled,
          // Never `null` and never an empty box — both are stored as 0. The
          // last acknowledged value is the fallback, so a save can only ever
          // keep a threshold or move it somewhere the operator typed.
          threshold: parseNumber(value.threshold, storedThreshold(rule)),
          cooldownMinutes: parseInteger(value.cooldownMinutes, storedCooldown(rule))
        }
      }
      const res = await whatsappAPI.updateAlertSettings({
        enabled: form.enabled,
        intervalSeconds: parseInteger(form.intervalSeconds, stored?.intervalSeconds ?? INTERVAL_MIN_S),
        digestMinutes: Number(form.digestMinutes) || 0,
        recipients,
        emailRecipients,
        telegram: telegramPatch(form.telegram),
        rules
      })
      if (res.success && res.data) {
        setStored(res.data)
        // Re-seeded from the response, never from the form: the service
        // normalises phone numbers, clamps the interval and the cooldowns and
        // substitutes defaults for the boxes left empty, and the operator has
        // to see what was actually stored rather than what they typed.
        setForm(toForm(res.data))
        toast.success(res.message || t('common.success'))
        return
      }
      // The machine `code`, never the `message`: an unknown code degrades to
      // the generic failure.
      toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setSaving(false)
    }
  }

  const handleTelegramTest = async () => {
    setTestingTelegram(true)
    try {
      const res = await whatsappAPI.testAlertTelegram()
      if (res.success) {
        toast.success(res.message || t('whatsapp.alerts.telegramTestSent'))
        return
      }
      toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setTestingTelegram(false)
    }
  }

  const handleScan = async () => {
    setScanning(true)
    try {
      const res = await whatsappAPI.runAlertScan()
      if (res.success) {
        setScanResult(res.message || t('common.success'))
        toast.success(res.message || t('common.success'))
        return
      }
      setScanResult(null)
      toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setScanning(false)
    }
  }

  return (
    <section className="modern-card max-w-3xl p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="section-heading">{t('whatsapp.alerts.title')}</h2>
          <p className="section-description">{t('whatsapp.alerts.description')}</p>
        </div>
        <button
          type="button"
          onClick={() => void handleScan()}
          disabled={loading || scanning || !form}
          className="modern-button-secondary shrink-0"
        >
          <Icon name="refresh" size={16} className={scanning ? 'animate-spin' : undefined} />
          {t('whatsapp.alerts.runScan')}
        </button>
      </div>

      {loading ? (
        <p className="mt-6 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : !form ? (
        /* The load failed and the toast has faded. Leaving "Loading…" on screen
           forever would say the panel is still trying when it stopped — the
           screen has to admit it has nothing and offer the way out. */
        <div className="mt-6">
          <button type="button" onClick={() => void load()} className="modern-button-secondary">
            <Icon name="refresh" size={16} />
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <>
          {scanResult && (
            <p
              className="mt-5 flex items-start gap-2 rounded-md border border-border bg-[hsl(var(--surface-subtle))] px-3 py-2.5 text-sm text-foreground"
              role="status"
            >
              <Icon name="check" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-success))]" />
              <span>{scanResult}</span>
            </p>
          )}

          <div className="mt-6 space-y-6">
            <div className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                  checked={form.enabled}
                  onChange={(event) => setForm((current) => (current
                    ? { ...current, enabled: event.target.checked }
                    : current))}
                />
                <span className="block font-semibold">{t('whatsapp.alerts.enable')}</span>
              </label>
            </div>

            <div>
              <label htmlFor="wa-alerts-interval" className="field-label">
                {t('whatsapp.alerts.interval')}
              </label>
              <input
                id="wa-alerts-interval"
                type="number"
                inputMode="numeric"
                min={INTERVAL_MIN_S}
                max={INTERVAL_MAX_S}
                step={30}
                className="modern-input sm:max-w-48"
                value={form.intervalSeconds}
                onChange={(event) => setForm((current) => (current
                  ? { ...current, intervalSeconds: event.target.value }
                  : current))}
                onBlur={() => setForm((current) => {
                  if (!current) return current
                  const raw = current.intervalSeconds.trim()
                  if (raw && Number.isFinite(Number(raw))) return current
                  return { ...current, intervalSeconds: String(stored?.intervalSeconds ?? INTERVAL_MIN_S) }
                })}
              />
            </div>

            <div>
              <label htmlFor="wa-alerts-digest" className="field-label">
                {t('whatsapp.alerts.digest')}
              </label>
              <select
                id="wa-alerts-digest"
                className="modern-input sm:max-w-64"
                value={form.digestMinutes}
                aria-describedby="wa-alerts-digest-hint"
                onChange={(event) => setForm((current) => (current
                  ? { ...current, digestMinutes: event.target.value }
                  : current))}
              >
                <option value="0">{t('whatsapp.alerts.digestOff')}</option>
                {[5, 10, 15, 30].map((minutes) => (
                  <option key={minutes} value={String(minutes)}>
                    {t('whatsapp.alerts.digestEvery', { minutes })}
                  </option>
                ))}
              </select>
              <p id="wa-alerts-digest-hint" className="field-hint">
                {t('whatsapp.alerts.digestHint')}
              </p>
            </div>

            {/* ── Who is woken ────────────────────────────────────────────
                The hint is the same sentence either way; where it is drawn is
                not. With nobody on the list it is the loudest thing in this
                block, because "alerts are on" and "somebody will hear about
                it" are two different states and only one of them is visible. */}
            <div>
              <label htmlFor="wa-alerts-recipients" className="field-label">
                {t('whatsapp.alerts.recipients')}
              </label>
              <textarea
                id="wa-alerts-recipients"
                rows={4}
                className="modern-input w-full font-mono text-sm"
                value={form.recipients}
                aria-describedby="wa-alerts-recipients-hint"
                onChange={(event) => setForm((current) => (current
                  ? { ...current, recipients: event.target.value }
                  : current))}
              />
              {noRecipients ? (
                <p
                  id="wa-alerts-recipients-hint"
                  role="alert"
                  className="mt-2 flex items-start gap-2 rounded-md border border-[hsl(var(--status-warning)/0.45)] bg-[hsl(var(--status-warning)/0.11)] px-3 py-2.5 text-sm leading-5 text-foreground"
                >
                  <Icon
                    name="warning"
                    size={16}
                    className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]"
                  />
                  <span>{t('whatsapp.alerts.recipientsHint')}</span>
                </p>
              ) : (
                <p id="wa-alerts-recipients-hint" className="field-hint">
                  {t('whatsapp.alerts.recipientsHint')}
                </p>
              )}
            </div>

            {/* ── Os e-mails da equipe ─────────────────────────────────────
                O segundo canal. Sem SMTP no servidor, o campo continua (a lista
                fica guardada para o dia em que houver), mas diz que nada sai. */}
            <div>
              <label htmlFor="wa-alerts-emails" className="field-label">
                {t('whatsapp.alerts.emailRecipients')}
              </label>
              <textarea
                id="wa-alerts-emails"
                rows={3}
                className="modern-input w-full font-mono text-sm"
                value={form.emailRecipients}
                aria-describedby="wa-alerts-emails-hint"
                placeholder="plantao@provedor.com.br"
                onChange={(event) => setForm((current) => (current
                  ? { ...current, emailRecipients: event.target.value }
                  : current))}
              />
              {mailOff ? (
                <p
                  id="wa-alerts-emails-hint"
                  className="mt-2 flex items-start gap-2 rounded-md border border-[hsl(var(--status-warning)/0.45)] bg-[hsl(var(--status-warning)/0.11)] px-3 py-2.5 text-sm leading-5 text-foreground"
                >
                  <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
                  <span>{t('whatsapp.alerts.mailNotConfigured')}</span>
                </p>
              ) : (
                <p id="wa-alerts-emails-hint" className="field-hint">
                  {t('whatsapp.alerts.emailRecipientsHint')}
                </p>
              )}
            </div>

            {/* ── O Telegram ─────────────────────────────────────────────
                Um bot do provedor mandando para um grupo da equipe. O token
                nunca volta do servidor: o campo vazio mantém o guardado, e
                remover é um botão próprio. */}
            <fieldset className="space-y-3 rounded-md border border-border p-4">
              <legend className="mb-3 px-1 text-sm font-semibold text-foreground">{t('whatsapp.alerts.telegramTitle')}</legend>
              <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
                <li>{t('whatsapp.alerts.telegramStep1')}</li>
                <li>{t('whatsapp.alerts.telegramStep2')}</li>
                <li>{t('whatsapp.alerts.telegramStep3')}</li>
              </ol>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="wa-alerts-telegram-token" className="field-label">{t('whatsapp.alerts.telegramToken')}</label>
                  <input
                    id="wa-alerts-telegram-token"
                    type="password"
                    autoComplete="off"
                    className="modern-input w-full font-mono text-sm"
                    value={form.telegram.token}
                    disabled={form.telegram.remove}
                    placeholder={stored?.telegram?.configured && !form.telegram.remove ? t('whatsapp.alerts.telegramTokenStored') : '123456789:AA…'}
                    onChange={(event) => patchTelegram({ token: event.target.value })}
                  />
                  {stored?.telegram?.configured && (
                    <button
                      type="button"
                      className="mt-1 text-xs font-semibold text-primary hover:underline max-sm:min-h-10"
                      onClick={() => patchTelegram({ remove: !form.telegram.remove, token: '' })}
                    >
                      {form.telegram.remove ? t('whatsapp.alerts.telegramKeep') : t('whatsapp.alerts.telegramRemove')}
                    </button>
                  )}
                </div>
                <div>
                  <label htmlFor="wa-alerts-telegram-chat" className="field-label">{t('whatsapp.alerts.telegramChat')}</label>
                  <input
                    id="wa-alerts-telegram-chat"
                    type="text"
                    className="modern-input w-full font-mono text-sm"
                    value={form.telegram.chatId}
                    placeholder="-1001234567890"
                    onChange={(event) => patchTelegram({ chatId: event.target.value })}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="modern-button-secondary"
                  disabled={testingTelegram || !telegramCanTest(form.telegram, stored?.telegram)}
                  onClick={() => void handleTelegramTest()}
                >
                  {t('whatsapp.alerts.telegramTest')}
                </button>
                {!telegramCanTest(form.telegram, stored?.telegram) && (
                  <span className="field-hint">{t('whatsapp.alerts.telegramSaveFirst')}</span>
                )}
              </div>
            </fieldset>

            {/* ── The four rules ──────────────────────────────────────────
                One row each, and each row carries its own unit sentence under
                its own threshold box. */}
            <div className="space-y-3">
              {RULES.map(({ rule, icon, label, hint, min, max, step }) => {
                const value = form.rules[rule]
                const thresholdId = `wa-alert-${rule}-threshold`
                const cooldownId = `wa-alert-${rule}-cooldown`
                return (
                  <div key={rule} className="rounded-md border border-border p-4">
                    <label className="flex cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        className="h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                        checked={value.enabled}
                        onChange={(event) => patchRule(rule, { enabled: event.target.checked })}
                      />
                      <Icon name={icon} size={18} className="shrink-0 text-muted-foreground" />
                      <span className="font-semibold">{t(label)}</span>
                    </label>

                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor={thresholdId} className="field-label">
                          {t('whatsapp.alerts.threshold')}
                        </label>
                        <input
                          id={thresholdId}
                          type="number"
                          min={min}
                          max={max}
                          step={step}
                          className="modern-input w-full"
                          value={value.threshold}
                          aria-describedby={`${thresholdId}-hint`}
                          onChange={(event) => patchRule(rule, { threshold: event.target.value })}
                          onBlur={() => restoreThreshold(rule)}
                        />
                        {/* The whole point of the row: WHAT this number counts. */}
                        <p id={`${thresholdId}-hint`} className="field-hint">{t(hint)}</p>
                      </div>
                      <div>
                        <label htmlFor={cooldownId} className="field-label">
                          {t('whatsapp.alerts.cooldown')}
                        </label>
                        <input
                          id={cooldownId}
                          type="number"
                          inputMode="numeric"
                          min={COOLDOWN_MIN_MIN}
                          max={COOLDOWN_MAX_MIN}
                          step={5}
                          className="modern-input w-full"
                          value={value.cooldownMinutes}
                          aria-describedby={`${cooldownId}-hint`}
                          onChange={(event) => patchRule(rule, { cooldownMinutes: event.target.value })}
                          onBlur={() => restoreCooldown(rule)}
                        />
                        <p id={`${cooldownId}-hint`} className="field-hint">
                          {t('whatsapp.alerts.cooldownHint')}
                        </p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="modern-button"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

export default AlertsPanel
