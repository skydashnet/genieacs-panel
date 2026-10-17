'use client'

import { useEffect, useMemo, useState } from 'react'
import { whatsappAPI, aiCreditsUrl, BOT_AI_PROVIDERS, type BotAiProvider, type BotConfig, type BotHoursDay, type BotMessageKey, type WhatsAppTag } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { TagsManager } from '@/components/whatsapp/tags'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

const AI_INSTRUCTIONS_MAX = 4000

/** A ordem em que os textos aparecem na tela: do primeiro contato à despedida. */
const MESSAGE_KEYS: BotMessageKey[] = [
  'greeting', 'askDocument', 'notRecognised', 'noOpenInvoice', 'handoffQueued', 'handoff', 'outsideHours'
]

/** Os textos da pesquisa de satisfação, na ordem em que o cliente os recebe. */
const SURVEY_KEYS: BotMessageKey[] = ['surveyQuestion', 'surveyAskComment', 'surveyThanks']

/** Os fusos do Brasil, onde está a base; o gravado entra na lista se for outro. */
const TIMEZONES = [
  'America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Fortaleza', 'America/Recife',
  'America/Bahia', 'America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho', 'America/Boa_Vista',
  'America/Rio_Branco', 'America/Noronha'
]

/** Segunda primeiro, domingo por último: como se lê uma semana de trabalho. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

function Caixa({ checked, onChange, title, hint, disabled = false }: {
  checked: boolean
  onChange: (value: boolean) => void
  title: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label className={`flex min-h-10 items-start gap-3 lg:min-h-0 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block font-semibold">{title}</span>
        {hint && <span className="mt-1 block text-sm leading-6 text-muted-foreground">{hint}</span>}
      </span>
    </label>
  )
}

/**
 * A aba Chatbot: o que o atendimento automático do WhatsApp diz, o que ele
 * oferece e em que horário a passagem para um humano promete resposta.
 *
 * Os dois interruptores (bot ligado, liberação em confiança) moravam na aba do
 * WhatsApp; continuam guardados lá no servidor, e é daqui que se mexe neles.
 */
export function ChatbotTab() {
  const { t, locale, formatDateTime } = useTranslation()
  const toast = useToast()
  const [config, setConfig] = useState<BotConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [tagOptions, setTagOptions] = useState<WhatsAppTag[]>([])
  // A chave digitada (vazia = manter a salva) e o pedido de apagar a salva.
  const [aiKey, setAiKey] = useState('')
  const [aiKeyRemove, setAiKeyRemove] = useState(false)
  const [aiTesting, setAiTesting] = useState(false)
  const [improving, setImproving] = useState<BotMessageKey | null>(null)

  // As etiquetas para os seletores da etiqueta automática.
  useEffect(() => {
    let vivo = true
    void whatsappAPI.listTags().then((res) => {
      if (vivo && res.success && res.data) setTagOptions(res.data)
    })
    return () => { vivo = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    void whatsappAPI.getBotConfig().then((res) => {
      if (cancelled) return
      if (res.success && res.data) setConfig(res.data)
      else toast.error(res.message || t('settings.chatbot.loadFailed'))
    })
    return () => { cancelled = true }
    // `toast` e `t` mudam de identidade a cada render; recarregar por isso
    // apagaria o que a pessoa está editando.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dayName = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'long' })
    // 2023-01-01 foi um domingo: `day` soma dias a partir dele.
    return (day: number) => fmt.format(new Date(Date.UTC(2023, 0, 1 + day, 12)))
  }, [locale])

  if (!config) return <p className="py-3 text-sm text-muted-foreground">{t('common.loading')}</p>

  const patch = (next: Partial<BotConfig>) => setConfig((current) => (current ? { ...current, ...next } : current))
  const patchAi = (next: Partial<BotConfig['ai']>) => patch({ ai: { ...config.ai, ...next } })
  const setOption = (key: keyof BotConfig['options'], value: boolean) =>
    patch({ options: { ...config.options, [key]: value } })
  const setMessage = (key: BotMessageKey, value: string) =>
    patch({ messages: { ...config.messages, [key]: value } })
  const setDay = (day: number, next: Partial<BotHoursDay>) => patch({
    hours: { ...config.hours, week: config.hours.week.map((d) => (d.day === day ? { ...d, ...next } : d)) }
  })

  const creditsUrl = aiCreditsUrl(config.ai.provider, config.ai.baseUrl)

  const preview = [
    config.messages.greeting || config.defaults.greeting,
    '',
    ...(config.options.invoice ? [`1 — ${t('settings.chatbot.option.invoice')}`] : []),
    ...(config.options.signal ? [`2 — ${t('settings.chatbot.option.signal')}`] : []),
    ...(config.options.human ? [`3 — ${t('settings.chatbot.option.human')}`] : []),
    ...(config.unlockEnabled ? [`4 — ${t('settings.chatbot.option.unlock')}`] : [])
  ].join('\n')

  const melhorarComIa = async (key: BotMessageKey) => {
    setImproving(key)
    try {
      const res = await whatsappAPI.improveBotMessage({ key, text: config.messages[key] || config.defaults[key] })
      if (res.success && res.data) {
        setMessage(key, res.data.text)
        toast.success(t('settings.chatbot.improveDone'))
      } else {
        toast.error(res.message || whatsappErrorMessage(t, res.code))
      }
    } finally {
      setImproving(null)
    }
  }

  const preencherComSugestoes = () => {
    patch({
      messages: Object.fromEntries(
        (Object.keys(config.messages) as BotMessageKey[]).map((k) => [k, config.messages[k] || config.defaults[k]])
      ) as BotConfig['messages'],
    })
    toast.success(t('settings.chatbot.filledSuggestions'))
  }

  const campoDeTexto = (key: BotMessageKey, disabled = false) => (
    <div key={key}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={`bot-msg-${key}`} className="text-sm font-medium">
          {t(`settings.chatbot.message.${key}` as TranslationKey)}
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="text-sm underline disabled:no-underline disabled:opacity-50"
            disabled={disabled || improving !== null || !config.ai.hasApiKey}
            title={config.ai.hasApiKey ? undefined : t('settings.chatbot.improveNeedsKey')}
            onClick={() => void melhorarComIa(key)}
          >
            {improving === key ? t('settings.chatbot.improving') : t('settings.chatbot.improveWithAi')}
          </button>
          {config.messages[key] && !disabled && (
            <button type="button" className="text-sm underline" onClick={() => setMessage(key, '')}>
              {t('settings.chatbot.restoreDefault')}
            </button>
          )}
        </div>
      </div>
      <textarea
        id={`bot-msg-${key}`}
        className="modern-input w-full text-sm"
        rows={2}
        maxLength={1000}
        disabled={disabled}
        value={config.messages[key]}
        placeholder={config.defaults[key]}
        onChange={(event) => setMessage(key, event.target.value)}
      />
    </div>
  )

  const timezones = TIMEZONES.includes(config.hours.timezone) ? TIMEZONES : [config.hours.timezone, ...TIMEZONES]

  const salvar = async () => {
    setSaving(true)
    try {
      const res = await whatsappAPI.updateBotConfig({
        enabled: config.enabled,
        unlockEnabled: config.unlockEnabled,
        options: config.options,
        messages: config.messages,
        hours: config.hours,
        satisfaction: config.satisfaction,
        distribution: config.distribution,
        autoTags: config.autoTags,
        ai: {
          enabled: config.ai.enabled,
          suggest: config.ai.suggest,
          provider: config.ai.provider,
          workspaceId: config.ai.workspaceId,
          baseUrl: config.ai.baseUrl,
          model: config.ai.model,
          instructions: config.ai.instructions,
          ...(aiKey.trim() ? { apiKey: aiKey.trim() } : aiKeyRemove ? { apiKey: '' } : {})
        }
      })
      if (res.success && res.data) {
        setConfig(res.data)
        setAiKey('')
        setAiKeyRemove(false)
        toast.success(t('settings.chatbot.saved'))
      } else {
        toast.error(res.message || t('settings.chatbot.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const testarIa = async () => {
    setAiTesting(true)
    try {
      const res = await whatsappAPI.testBotAi({
        provider: config.ai.provider,
        workspaceId: config.ai.workspaceId,
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
        ...(aiKey.trim() ? { apiKey: aiKey.trim() } : {})
      })
      if (res.success && res.data) toast.success(t('settings.chatbot.aiTestOk', { reply: res.data.reply || '—' }))
      else toast.error(res.message || whatsappErrorMessage(t, res.code))
    } finally {
      setAiTesting(false)
    }
  }

  return (
    <div className="grid max-w-4xl gap-6">
      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.title')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.description')}</p>
        <div className="mt-4 grid gap-4">
          <Caixa
            checked={config.enabled}
            onChange={(value) => patch({ enabled: value })}
            title={t('settings.whatsapp.botEnabled')}
            hint={t('settings.whatsapp.botEnabledHint')}
          />
          <Caixa
            checked={config.unlockEnabled}
            disabled={!config.enabled}
            onChange={(value) => patch({ unlockEnabled: value })}
            title={t('settings.whatsapp.botUnlockEnabled')}
            hint={t('settings.whatsapp.botUnlockEnabledHint')}
          />
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.aiTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.aiIntro')}</p>
        <div className="mt-4 grid gap-4">
          <Caixa
            checked={config.ai.enabled}
            disabled={!config.enabled}
            onChange={(value) => patchAi({ enabled: value })}
            title={t('settings.chatbot.aiEnabled')}
            hint={t('settings.chatbot.aiEnabledHint')}
          />
          <Caixa
            checked={config.ai.suggest}
            onChange={(value) => patchAi({ suggest: value })}
            title={t('settings.chatbot.aiSuggest')}
            hint={t('settings.chatbot.aiSuggestHint')}
          />
          <div>
            <label htmlFor="bot-ai-provider" className="field-label">{t('settings.chatbot.aiProvider')}</label>
            <select
              id="bot-ai-provider"
              className="modern-input w-full"
              value={config.ai.provider}
              onChange={(event) => {
                const provider = event.target.value as BotAiProvider
                patchAi({ provider, ...BOT_AI_PROVIDERS[provider] })
              }}
            >
              <option value="openai-compatible">{t('settings.chatbot.aiProviderOpenai')}</option>
              <option value="anthropic">{t('settings.chatbot.aiProviderAnthropic')}</option>
            </select>
            <p className="field-hint">{t('settings.chatbot.aiProviderHint')}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="bot-ai-url" className="field-label">{t('settings.chatbot.aiBaseUrl')}</label>
              <input
                id="bot-ai-url"
                className="modern-input w-full"
                value={config.ai.baseUrl}
                onChange={(event) => patchAi({ baseUrl: event.target.value })}
              />
              <p className="field-hint">
                {config.ai.provider === 'anthropic'
                  ? t('settings.chatbot.aiBaseUrlHintAnthropic')
                  : t('settings.chatbot.aiBaseUrlHint')}
              </p>
              {creditsUrl && (
                <a
                  href={creditsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-sm underline"
                >
                  {t('settings.chatbot.aiBuyCredits')} ↗
                </a>
              )}
            </div>
            <div>
              <label htmlFor="bot-ai-model" className="field-label">{t('settings.chatbot.aiModel')}</label>
              <input
                id="bot-ai-model"
                className="modern-input w-full"
                maxLength={64}
                value={config.ai.model}
                onChange={(event) => patchAi({ model: event.target.value })}
              />
              <p className="field-hint">
                {config.ai.provider === 'anthropic'
                  ? t('settings.chatbot.aiModelHintAnthropic')
                  : t('settings.chatbot.aiModelHint')}
              </p>
            </div>
          </div>
          <div>
            <label htmlFor="bot-ai-key" className="field-label">{t('settings.chatbot.aiKey')}</label>
            {config.ai.hasApiKey && !aiKeyRemove && (
              <p className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                <span className="modern-badge-success">{t('settings.chatbot.aiKeySaved')}</span>
                {config.ai.keyHint && (
                  <span className="font-mono text-xs text-muted-foreground">{t('settings.chatbot.aiKeyEnds', { hint: config.ai.keyHint })}</span>
                )}
                <button type="button" className="min-h-10 text-sm underline sm:min-h-0" onClick={() => setAiKeyRemove(true)}>
                  {t('settings.chatbot.aiKeyRemove')}
                </button>
              </p>
            )}
            {aiKeyRemove && (
              <p className="mb-1 text-sm text-[hsl(var(--status-warning))]">{t('settings.chatbot.aiKeyWillRemove')}</p>
            )}
            <input
              id="bot-ai-key"
              // Texto mascarado e não `password`: num campo de senha o Chrome
              // ignora o autocomplete e preenche a senha do painel, que aí era
              // gravada como chave da IA.
              type="text"
              name="ai-api-key"
              autoComplete="new-password"
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              className="modern-input w-full font-mono [-webkit-text-security:disc]"
              value={aiKey}
              placeholder={config.ai.hasApiKey ? t('settings.chatbot.aiKeyReplace') : t('settings.chatbot.aiKeyPlaceholder')}
              onChange={(event) => { const v = event.target.value.trim(); setAiKey(v); if (v) setAiKeyRemove(false) }}
            />
          </div>
          {config.ai.provider === 'anthropic' && (
            <div>
              <label htmlFor="bot-ai-workspace" className="field-label">{t('settings.chatbot.aiWorkspaceId')}</label>
              <input
                id="bot-ai-workspace"
                className="modern-input w-full font-mono text-sm"
                maxLength={100}
                autoComplete="off"
                value={config.ai.workspaceId}
                onChange={(event) => patchAi({ workspaceId: event.target.value })}
              />
              <p className="field-hint">{t('settings.chatbot.aiWorkspaceIdHint')}</p>
            </div>
          )}
          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="bot-ai-instructions" className="field-label mb-0">{t('settings.chatbot.aiInstructions')}</label>
              <span className="text-xs tabular-nums text-muted-foreground">{config.ai.instructions.length}/{AI_INSTRUCTIONS_MAX}</span>
            </div>
            <textarea
              id="bot-ai-instructions"
              className="modern-input w-full text-sm"
              rows={6}
              maxLength={AI_INSTRUCTIONS_MAX}
              value={config.ai.instructions}
              placeholder={t('settings.chatbot.aiInstructionsPlaceholder')}
              onChange={(event) => patchAi({ instructions: event.target.value })}
            />
            <p className="field-hint">{t('settings.chatbot.aiInstructionsHint')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="modern-button-secondary"
              disabled={aiTesting || (!config.ai.hasApiKey && !aiKey.trim())}
              onClick={() => void testarIa()}
            >
              {aiTesting ? t('common.loading') : t('settings.chatbot.aiTest')}
            </button>
            {config.ai.lastError && (
              <span className="min-w-0 text-sm text-[hsl(var(--status-danger))] wrap-anywhere">
                {t('settings.chatbot.aiLastError', {
                  when: formatDateTime(config.ai.lastError.at),
                  reason: config.ai.lastError.detail
                    ? `${whatsappErrorMessage(t, config.ai.lastError.code)} (${config.ai.lastError.detail})`
                    : whatsappErrorMessage(t, config.ai.lastError.code)
                })}
              </span>
            )}
          </div>
          <p className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3 text-sm text-muted-foreground">
            {t('settings.chatbot.aiPrivacy')}
          </p>
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.optionsTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.optionsHint')}</p>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div className="grid content-start gap-4">
            <Caixa checked={config.options.invoice} onChange={(v) => setOption('invoice', v)} title={t('settings.chatbot.option.invoice')} />
            <Caixa checked={config.options.signal} onChange={(v) => setOption('signal', v)} title={t('settings.chatbot.option.signal')} />
            <Caixa
              checked={config.options.human}
              onChange={(v) => setOption('human', v)}
              title={t('settings.chatbot.option.human')}
              hint={t('settings.chatbot.option.humanHint')}
            />
            <Caixa
              checked={config.options.document}
              onChange={(v) => setOption('document', v)}
              title={t('settings.chatbot.option.document')}
              hint={t('settings.chatbot.option.documentHint')}
            />
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">{t('settings.chatbot.preview')}</p>
            <pre className="whitespace-pre-wrap wrap-anywhere rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3 text-sm leading-6">
              {preview}
            </pre>
          </div>
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.messagesTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.messagesHint')}</p>
        <div className="mt-3">
          <button type="button" className="modern-button-secondary" onClick={preencherComSugestoes}>
            {t('settings.chatbot.fillSuggestions')}
          </button>
          <p className="field-hint mt-1">{t('settings.chatbot.fillSuggestionsHint')}</p>
        </div>
        <div className="mt-4 grid gap-5">
          {MESSAGE_KEYS.map((key) => campoDeTexto(key))}
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('whatsapp.tags.manageTitle')}</h2>
        <p className="field-hint mt-1">{t('whatsapp.tags.manageHint')}</p>
        <div className="mt-4"><TagsManager /></div>
        <div className="mt-6 grid gap-4 border-t border-border pt-5">
          <Caixa
            checked={config.autoTags.enabled}
            onChange={(value) => patch({ autoTags: { ...config.autoTags, enabled: value } })}
            title={t('settings.chatbot.autoTagsEnabled')}
            hint={t('settings.chatbot.autoTagsHint')}
          />
          {([
            ['invoice', 'settings.chatbot.autoTagsInvoice'],
            ['signal', 'settings.chatbot.autoTagsSignal']
          ] as const).map(([grupo, rotulo]) => (
            <label key={grupo} className="grid max-w-md gap-1 text-sm">
              <span className="font-medium">{t(rotulo)}</span>
              <select
                className="modern-input"
                disabled={!config.autoTags.enabled}
                value={config.autoTags[grupo] ?? ''}
                onChange={(event) => patch({
                  autoTags: { ...config.autoTags, [grupo]: event.target.value ? Number(event.target.value) : null }
                })}
              >
                <option value="">{t('settings.chatbot.autoTagsNone')}</option>
                {tagOptions.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
              </select>
            </label>
          ))}
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.distributionTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.distributionHint')}</p>
        <div className="mt-4">
          <Caixa
            checked={config.distribution.enabled}
            onChange={(value) => patch({ distribution: { ...config.distribution, enabled: value } })}
            title={t('settings.chatbot.distributionEnabled')}
            hint={t('settings.chatbot.distributionEnabledHint')}
          />
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.surveyTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.surveyHint')}</p>
        <div className="mt-4 grid gap-5">
          <Caixa
            checked={config.satisfaction.enabled}
            onChange={(value) => patch({ satisfaction: { ...config.satisfaction, enabled: value } })}
            title={t('settings.chatbot.surveyEnabled')}
            hint={t('settings.chatbot.surveyEnabledHint')}
          />
          {SURVEY_KEYS.map((key) => campoDeTexto(key, !config.satisfaction.enabled))}
        </div>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('settings.chatbot.hoursTitle')}</h2>
        <p className="field-hint mt-1">{t('settings.chatbot.hoursHint')}</p>
        <div className="mt-4 grid gap-4">
          <Caixa
            checked={config.hours.enabled}
            onChange={(value) => patch({ hours: { ...config.hours, enabled: value } })}
            title={t('settings.chatbot.hoursEnabled')}
          />
          <div className="max-w-xs">
            <label htmlFor="bot-timezone" className="mb-1 block text-sm font-medium">{t('settings.chatbot.timezone')}</label>
            <select
              id="bot-timezone"
              className="modern-input w-full"
              value={config.hours.timezone}
              disabled={!config.hours.enabled}
              onChange={(event) => patch({ hours: { ...config.hours, timezone: event.target.value } })}
            >
              {timezones.map((tz) => <option key={tz} value={tz}>{tz.replace('America/', '').replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="grid gap-2">
            {DAY_ORDER.map((day) => {
              const regra = config.hours.week.find((d) => d.day === day)
              if (!regra) return null
              const inativo = !config.hours.enabled || regra.closed
              return (
                // No celular: dia e "Fechado" numa linha, abre — fecha na de baixo.
                <div key={day} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 sm:flex sm:flex-wrap sm:gap-3">
                  <span className="col-span-2 text-sm capitalize sm:w-32">{dayName(day)}</span>
                  <label className="flex min-h-10 items-center gap-2 justify-self-end text-sm sm:min-h-0">
                    <input
                      type="checkbox"
                      checked={regra.closed}
                      disabled={!config.hours.enabled}
                      onChange={(event) => setDay(day, { closed: event.target.checked })}
                    />
                    {t('settings.chatbot.closed')}
                  </label>
                  <input
                    type="time"
                    aria-label={`${dayName(day)} — ${t('settings.chatbot.opens')}`}
                    className="modern-input w-full sm:w-32"
                    value={regra.open}
                    disabled={inativo}
                    onChange={(event) => setDay(day, { open: event.target.value })}
                  />
                  <span className="text-sm text-muted-foreground">—</span>
                  <input
                    type="time"
                    aria-label={`${dayName(day)} — ${t('settings.chatbot.closes')}`}
                    className="modern-input w-full sm:w-32"
                    value={regra.close}
                    disabled={inativo}
                    onChange={(event) => setDay(day, { close: event.target.value })}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </section>

      <div>
        <button type="button" className="modern-button" disabled={saving} onClick={() => void salvar()}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}

export default ChatbotTab
