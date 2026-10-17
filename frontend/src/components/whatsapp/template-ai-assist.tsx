'use client'

import { useEffect, useRef, useState } from 'react'
import { whatsappAPI } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

const TONES: [string, TranslationKey][] = [
  ['amigavel', 'whatsapp.templates.ai.toneFriendly'],
  ['formal', 'whatsapp.templates.ai.toneFormal'],
  ['firme', 'whatsapp.templates.ai.toneFirm']
]

const GOAL_MAX = 500

interface Props {
  category: string
  /** O texto que já está na caixa; com ele, o botão melhora em vez de escrever do zero. */
  body: string
  /** Põe o texto da IA na caixa do editor. */
  onApply: (text: string) => void
}

/**
 * "Escrever com IA", acima da caixa de texto do modelo.
 *
 * Só aparece quando a IA está configurada (aba Chatbot). O texto vai para a
 * caixa do editor, onde o atendente revisa; "Desfazer" devolve o que estava
 * antes. Nada é gravado até o Salvar do próprio modelo.
 */
export function TemplateAiAssist({ category, body, onApply }: Props) {
  const { t } = useTranslation()
  const [available, setAvailable] = useState(false)
  const [goal, setGoal] = useState('')
  const [tone, setTone] = useState('amigavel')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [previous, setPrevious] = useState<string | null>(null)
  const [removed, setRemoved] = useState<string[]>([])
  const [mirrors, setMirrors] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void whatsappAPI.getAiStatus().then((res) => {
      if (alive.current) setAvailable(Boolean(res.success && res.data?.templates))
    })
    return () => { alive.current = false }
  }, [])

  if (!available) return null

  const improving = body.trim().length > 0
  const canRun = !busy && (goal.trim().length > 0 || improving)

  const run = async () => {
    setBusy(true)
    setError('')
    const res = await whatsappAPI.draftTemplate({ category, goal: goal.trim(), tone, current: body })
    if (!alive.current) return
    setBusy(false)
    if (!res.success || !res.data) {
      setError(res.message || whatsappErrorMessage(t, res.code) || t('whatsapp.templates.ai.failed'))
      return
    }
    setPrevious(body)
    setRemoved(res.data.warnings.removed)
    setMirrors(res.data.warnings.mirrors)
    onApply(res.data.text)
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3" data-testid="template-ai">
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon name="sparkles" size={16} />
        {t('whatsapp.templates.ai.title')}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label className="field-label" htmlFor="wa-template-ai-goal">{t('whatsapp.templates.ai.goal')}</label>
          <input
            id="wa-template-ai-goal"
            className="modern-input"
            value={goal}
            maxLength={GOAL_MAX}
            placeholder={t('whatsapp.templates.ai.goalPlaceholder')}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (canRun) void run()
              }
            }}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="wa-template-ai-tone">{t('whatsapp.templates.ai.tone')}</label>
          <select id="wa-template-ai-tone" className="modern-input" value={tone} onChange={(event) => setTone(event.target.value)}>
            {TONES.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
          </select>
        </div>
        <button type="button" className="modern-button-secondary shrink-0" disabled={!canRun} onClick={() => void run()} data-testid="template-ai-run">
          <Icon name={busy ? 'refresh' : 'sparkles'} size={16} className={busy ? 'animate-spin' : ''} />
          {busy ? t('whatsapp.templates.ai.working') : improving ? t('whatsapp.templates.ai.improve') : t('whatsapp.templates.ai.generate')}
        </button>
      </div>

      {error && (
        <p className="flex items-start gap-2 text-xs leading-5 text-[hsl(var(--status-danger))]">
          <Icon name="warning" size={14} />
          <span>{error}</span>
        </p>
      )}
      {previous !== null && !error && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="template-ai-notice">
          <span>{t('whatsapp.templates.ai.draftNotice')}</span>
          <button
            type="button"
            className="font-semibold text-foreground underline underline-offset-2"
            onClick={() => {
              onApply(previous)
              setPrevious(null)
              setRemoved([])
              setMirrors(false)
            }}
          >
            {t('whatsapp.templates.ai.undo')}
          </button>
        </div>
      )}
      {removed.length > 0 && (
        <p className="text-xs leading-5 text-[hsl(var(--status-warning))]">
          {t('whatsapp.templates.ai.removed', { names: removed.map((name) => `{{${name}}}`).join(', ') })}
        </p>
      )}
      {mirrors && (
        <p className="text-xs leading-5 text-[hsl(var(--status-danger))]">{t('whatsapp.templates.ai.mirrors')}</p>
      )}
    </div>
  )
}
