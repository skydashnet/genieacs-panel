'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  whatsappAPI,
  type WhatsAppDunningPreview,
  type WhatsAppDunningRule,
  type WhatsAppDunningSkipReason,
  type WhatsAppDunningWindowDay,
  type WhatsAppTemplate
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import type { TranslationKey } from '@/lib/i18n'
import { ContactLink } from './contact-link'
import { missingText } from './wa-variables'
import {
  MAX_STEPS,
  OFFSET_MAX,
  OFFSET_MIN,
  isReminderBody,
  nextOffset,
  stepProblems,
  toSavedSteps,
  type StepProblem
} from './dunning-rules'

/**
 * The AUTOMATIC billing cadence — the half that sends.
 *
 * The screen is built around the three things that make leaving it on safe:
 * the switch is its own button with its own confirmation (saving never turns it
 * on), the preview shows who would get what TODAY before anything leaves, and
 * the send window and the per-invoice ceiling sit next to the steps rather than
 * in a settings page nobody opens.
 */

const TIMEZONES = [
  'America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Fortaleza', 'America/Recife',
  'America/Bahia', 'America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho', 'America/Boa_Vista',
  'America/Rio_Branco', 'America/Noronha'
]

/** Monday first, Sunday last: how a working week reads. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export const SKIP_LABELS: Record<WhatsAppDunningSkipReason, TranslationKey> = {
  noPhone: 'whatsapp.dunning.skip.noPhone',
  optOut: 'whatsapp.dunning.skip.optOut',
  templateIncomplete: 'whatsapp.dunning.skip.templateIncomplete',
  maxReached: 'whatsapp.dunning.skip.maxReached',
  interval: 'whatsapp.dunning.skip.interval',
  paused: 'whatsapp.dunning.skip.paused',
  sgpRefused: 'whatsapp.dunning.skip.sgpRefused'
}

const PROBLEM_LABELS: Record<StepProblem, TranslationKey> = {
  noTemplate: 'whatsapp.dunning.problem.noTemplate',
  offsetRange: 'whatsapp.dunning.problem.offsetRange',
  duplicate: 'whatsapp.dunning.problem.duplicate',
  needsDunning: 'whatsapp.dunning.problem.needsDunning',
  needsReminder: 'whatsapp.dunning.problem.needsReminder'
}

/**
 * The server's sentence, which already arrives in the operator's language and
 * names the step at fault ("the step on day 5…"); the shared code map is the
 * fallback for a response that carried none.
 */
export function errorText(
  res: { message?: string; code?: string },
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
  fallback: TranslationKey
): string {
  if (res.message) return res.message
  return res.code ? whatsappErrorMessage(t, res.code) : t(fallback)
}

interface DraftStep {
  key: number
  offsetDays: number
  templateId: number | null
}

interface Draft {
  steps: DraftStep[]
  maxPerInvoice: string
  minIntervalHours: string
  maxPerRun: string
  receiptPauseDays: string
  thanksTemplateId: number | null
  window: { timezone: string; week: WhatsAppDunningWindowDay[] }
}

let stepKeys = 0

function toDraft(rule: WhatsAppDunningRule): Draft {
  return {
    steps: rule.steps.map((step) => ({ key: ++stepKeys, offsetDays: step.offsetDays, templateId: step.templateId })),
    maxPerInvoice: String(rule.maxPerInvoice),
    minIntervalHours: String(rule.minIntervalHours),
    maxPerRun: String(rule.maxPerRun),
    receiptPauseDays: String(rule.receiptPauseDays ?? 3),
    thanksTemplateId: rule.thanksTemplateId,
    window: rule.window
  }
}

export function DunningRulePanel() {
  const { t, locale, formatDate, formatDateTime, intlLocale } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const canManage = can('campaigns.manage')

  const [rule, setRule] = useState<WhatsAppDunningRule | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<WhatsAppDunningPreview | null>(null)
  const [previewProgress, setPreviewProgress] = useState<{ checked: number; total: number | null } | null>(null)
  const [starting, setStarting] = useState(false)
  const [installing, setInstalling] = useState(false)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async () => {
    const [ruleRes, templatesRes] = await Promise.all([
      whatsappAPI.getDunningRule(),
      whatsappAPI.listTemplates()
    ])
    if (!alive.current) return
    if (ruleRes.success && ruleRes.data) {
      setRule(ruleRes.data)
      setDraft((current) => current ?? toDraft(ruleRes.data as WhatsAppDunningRule))
      setLoadError(null)
    } else {
      setLoadError(errorText(ruleRes, t, 'whatsapp.dunning.loadFailed'))
    }
    if (templatesRes.success && templatesRes.data) setTemplates(templatesRes.data)
    // `t` changes identity with the language; reloading on that would throw
    // away what the person is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { void load() }, [load])

  // While a pass runs in the background, the summary is what the operator is
  // waiting for: poll the rule until `running` flips back.
  useEffect(() => {
    if (!rule?.running) return undefined
    const timer = window.setInterval(() => {
      void whatsappAPI.getDunningRule().then((res) => {
        if (alive.current && res.success && res.data) setRule(res.data)
      })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [rule?.running])

  const dayName = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'long' })
    // 2023-01-01 was a Sunday: `day` counts from it.
    return (day: number) => fmt.format(new Date(Date.UTC(2023, 0, 1 + day, 12)))
  }, [locale])

  const templateById = useMemo(() => new Map(templates.map((tpl) => [tpl.id, tpl])), [templates])
  const problems = useMemo(
    () => (draft ? stepProblems(draft.steps, templates) : []),
    [draft, templates]
  )
  const thanksOptions = useMemo(
    () => templates.filter((tpl) => !/\{\{\s*(dias_atraso|dias_para_vencer)\s*\}\}/.test(tpl.body)),
    [templates]
  )

  if (loadError) {
    return (
      <div className="modern-card p-4 text-sm text-destructive" role="alert">{loadError}</div>
    )
  }
  if (!rule || !draft) {
    return <p className="py-3 text-sm text-muted-foreground">{t('common.loading')}</p>
  }

  const patch = (next: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...next } : current))
  const setStep = (key: number, next: Partial<DraftStep>) => patch({
    steps: draft.steps.map((step) => (step.key === key ? { ...step, ...next } : step))
  })
  const setDay = (day: number, next: Partial<WhatsAppDunningWindowDay>) => patch({
    window: { ...draft.window, week: draft.window.week.map((d) => (d.day === day ? { ...d, ...next } : d)) }
  })
  const timezones = TIMEZONES.includes(draft.window.timezone) ? TIMEZONES : [draft.window.timezone, ...TIMEZONES]
  const hasProblem = problems.some((problem) => problem !== null)

  const stepLabel = (offset: number) => {
    if (offset < 0) return t('whatsapp.dunning.stepBefore', { count: Math.abs(offset) })
    if (offset === 0) return t('whatsapp.dunning.stepDue')
    return t('whatsapp.dunning.stepAfter', { count: offset })
  }

  const save = async () => {
    if (hasProblem) {
      toast.error(t('whatsapp.dunning.fixSteps'))
      return
    }
    setSaving(true)
    try {
      const res = await whatsappAPI.saveDunningRule({
        steps: toSavedSteps(draft.steps),
        window: draft.window,
        maxPerInvoice: Number(draft.maxPerInvoice),
        minIntervalHours: Number(draft.minIntervalHours),
        maxPerRun: Number(draft.maxPerRun),
        receiptPauseDays: Number(draft.receiptPauseDays),
        thanksTemplateId: draft.thanksTemplateId
      })
      if (!alive.current) return
      if (res.success && res.data) {
        setRule(res.data)
        setDraft(toDraft(res.data))
        setPreview(null)
        toast.success(res.message || t('whatsapp.dunning.saved'))
      } else {
        toast.error(errorText(res, t, 'whatsapp.dunning.saveFailed'))
      }
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  const toggle = async () => {
    const turningOn = !rule.enabled
    // The one click in this panel that makes the panel message subscribers by
    // itself. It says so, in words, before it happens.
    if (!window.confirm(t(turningOn ? 'whatsapp.dunning.confirmOn' : 'whatsapp.dunning.confirmOff'))) return
    setSwitching(true)
    try {
      const res = await whatsappAPI.setDunningEnabled(turningOn)
      if (!alive.current) return
      if (res.success && res.data) {
        setRule(res.data)
        toast.success(res.message || t(turningOn ? 'whatsapp.dunning.statusOn' : 'whatsapp.dunning.statusOff'))
      } else {
        toast.error(errorText(res, t, 'whatsapp.dunning.saveFailed'))
      }
    } finally {
      if (alive.current) setSwitching(false)
    }
  }

  // One click from an empty cadence to a reviewable one: the suggested
  // templates, and the steps that use them. The server never overwrites a
  // template the operator edited and never switches the cadence on.
  const installStarter = async () => {
    if (!window.confirm(t('whatsapp.dunning.starterConfirm'))) return
    setInstalling(true)
    try {
      const res = await whatsappAPI.installDunningStarter()
      if (!alive.current) return
      if (res.success && res.data) {
        const { rule: next, stepsFilled } = res.data
        const templatesRes = await whatsappAPI.listTemplates()
        if (!alive.current) return
        if (templatesRes.success && templatesRes.data) setTemplates(templatesRes.data)
        setRule(next)
        if (stepsFilled) setDraft(toDraft(next))
        setPreview(null)
        toast.success(res.message || t('whatsapp.dunning.starter'))
      } else {
        toast.error(errorText(res, t, 'whatsapp.dunning.saveFailed'))
      }
    } finally {
      if (alive.current) setInstalling(false)
    }
  }

  // The preview runs on the server in the background; this starts it and
  // polls until it is done, showing how many contracts the ERP has answered.
  const simulate = async () => {
    setPreviewing(true)
    setPreview(null)
    setPreviewProgress(null)
    try {
      const started = await whatsappAPI.startDunningPreview()
      if (!alive.current) return
      if (!started.success || !started.data) {
        toast.error(errorText(started, t, 'whatsapp.dunning.previewFailed'))
        return
      }
      let state = started.data
      while (alive.current && state.status === 'running') {
        setPreviewProgress({ checked: state.checked, total: state.total })
        await new Promise((resolve) => { window.setTimeout(resolve, 2000) })
        const res = await whatsappAPI.getDunningPreview()
        if (!res.success || !res.data) {
          toast.error(errorText(res, t, 'whatsapp.dunning.previewFailed'))
          return
        }
        state = res.data
      }
      if (!alive.current) return
      if (state.status === 'done' && state.result) setPreview(state.result)
      else toast.error(state.error?.message || t('whatsapp.dunning.previewFailed'))
    } finally {
      if (alive.current) {
        setPreviewing(false)
        setPreviewProgress(null)
      }
    }
  }

  const runNow = async () => {
    if (!window.confirm(t('whatsapp.dunning.confirmRun'))) return
    setStarting(true)
    try {
      const res = await whatsappAPI.runDunning()
      if (!alive.current) return
      if (res.success) {
        toast.success(res.message || t('whatsapp.dunning.runStarted'))
        setRule((current) => (current ? { ...current, running: true } : current))
      } else {
        toast.error(errorText(res, t, 'whatsapp.dunning.runFailed'))
      }
    } finally {
      if (alive.current) setStarting(false)
    }
  }

  const money = (amount: number | null) => (amount === null
    ? '—'
    : amount.toLocaleString(intlLocale, { style: 'currency', currency: 'BRL' }))

  const lastRun = rule.lastRun
  const skippedInPreview = preview
    ? (Object.keys(SKIP_LABELS) as WhatsAppDunningSkipReason[])
      .map((reason) => ({ reason, count: preview.skipped[reason] ?? 0 }))
      .filter((entry) => entry.count > 0)
    : []

  return (
    <section className="space-y-5">
      <header>
        <h2 className="section-heading">{t('whatsapp.dunning.title')}</h2>
        <p className="section-description">{t('whatsapp.dunning.description')}</p>
      </header>

      {/* ── The switch ─────────────────────────────────────────────────── */}
      <div className="modern-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={rule.enabled ? 'modern-badge-success' : 'modern-badge'}>
                {t(rule.enabled ? 'whatsapp.dunning.statusOn' : 'whatsapp.dunning.statusOff')}
              </span>
              <span className={rule.inWindowNow ? 'modern-badge-info' : 'modern-badge-warning'}>
                {t(rule.inWindowNow ? 'whatsapp.dunning.inWindow' : 'whatsapp.dunning.outWindow')}
              </span>
              {rule.running && <span className="modern-badge-info">{t('whatsapp.dunning.running')}</span>}
            </div>
            <p className="field-hint mt-2">
              {lastRun
                ? t('whatsapp.dunning.lastRun', {
                  date: formatDateTime(lastRun.at),
                  queued: lastRun.queued,
                  paid: lastRun.paid,
                  thanked: lastRun.thanked
                })
                : t('whatsapp.dunning.lastRunNever')}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="modern-button-secondary"
                disabled={previewing || draft.steps.length === 0}
                onClick={() => void simulate()}
              >
                <Icon name="eye" size={16} />
                {previewing ? t('whatsapp.dunning.previewing') : t('whatsapp.dunning.preview')}
              </button>
              <button
                type="button"
                className="modern-button-secondary"
                disabled={starting || rule.running || !rule.enabled || !rule.inWindowNow}
                onClick={() => void runNow()}
              >
                <Icon name="refresh" size={16} />
                {t('whatsapp.dunning.runNow')}
              </button>
              <button
                type="button"
                className={rule.enabled ? 'modern-button-secondary' : 'modern-button'}
                disabled={switching || (!rule.enabled && rule.steps.length === 0)}
                onClick={() => void toggle()}
              >
                <Icon name="power" size={16} />
                {t(rule.enabled ? 'whatsapp.dunning.turnOff' : 'whatsapp.dunning.turnOn')}
              </button>
            </div>
          )}
        </div>
        {!rule.enabled && rule.steps.length === 0 && (
          <p className="field-hint mt-3 flex gap-2">
            <Icon name="info" size={16} className="mt-0.5 shrink-0" />
            <span>{t('whatsapp.dunning.needsSteps')}</span>
          </p>
        )}
      </div>

      {previewing && previewProgress && (
        <div className="modern-card p-4 text-sm text-muted-foreground" role="status">
          {previewProgress.total
            ? t('whatsapp.dunning.previewProgress', { checked: previewProgress.checked, total: previewProgress.total })
            : t('whatsapp.dunning.previewing')}
          {previewProgress.total ? (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.min(100, Math.round((previewProgress.checked / previewProgress.total) * 100))}%` }}
              />
            </div>
          ) : null}
        </div>
      )}

      {/* ── The preview ────────────────────────────────────────────────── */}
      {preview && (
        <div className="modern-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-4">
            <span className="text-sm font-semibold text-foreground">
              {t('whatsapp.dunning.previewTitle', { count: preview.queued, checked: preview.checked })}
            </span>
            <button type="button" className="modern-button-secondary" onClick={() => setPreview(null)}>
              {t('common.close')}
            </button>
          </div>
          {preview.truncated && (
            <p className="field-hint px-4 pt-3">{t('whatsapp.dunning.previewTruncated', { count: preview.checked })}</p>
          )}
          {skippedInPreview.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {skippedInPreview.map(({ reason, count }) => (
                <span key={reason} className="modern-badge-warning">{t(SKIP_LABELS[reason])}: {count}</span>
              ))}
            </div>
          )}
          {preview.items.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('whatsapp.dunning.previewEmpty')}</p>
          ) : (
            <div className="overflow-x-auto p-2">
              <table className="modern-table">
                <thead>
                  <tr>
                    <th scope="col">{t('whatsapp.inbox.contract')}</th>
                    <th scope="col">{t('whatsapp.inbox.subscriber')}</th>
                    <th scope="col">{t('whatsapp.billing.amount')}</th>
                    <th scope="col">{t('whatsapp.billing.dueDate')}</th>
                    <th scope="col">{t('whatsapp.dunning.step')}</th>
                    <th scope="col">{t('whatsapp.dunning.result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.items.map((item) => (
                    <tr key={item.contract}>
                      <td className="font-mono text-xs">{item.contract}</td>
                      <td><ContactLink contract={item.contract} name={item.clientName} /></td>
                      <td>{money(item.amount)}</td>
                      <td>{item.dueDate ? formatDate(`${item.dueDate}T12:00:00`) : '—'}</td>
                      <td>{stepLabel(item.stepOffset)}</td>
                      <td>
                        {item.status === 'queued'
                          ? <span className="modern-badge-success">{t('whatsapp.dunning.wouldSend')}</span>
                          : <span className="modern-badge-warning">{missingText(t, item.missing) ?? (item.reason ? t(SKIP_LABELS[item.reason]) : '—')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── The steps ──────────────────────────────────────────────────── */}
      <div className="modern-card p-4 sm:p-5">
        <h3 className="field-label">{t('whatsapp.dunning.stepsTitle')}</h3>
        <p className="field-hint mb-4">{t('whatsapp.dunning.stepsHint')}</p>

        {canManage && (rule.steps.length === 0 || templates.length === 0) && (
          <div className="mb-4 rounded-md border border-dashed border-border p-3">
            <button
              type="button"
              className="modern-button"
              disabled={installing}
              onClick={() => void installStarter()}
            >
              <Icon name="document" size={16} />
              {installing ? t('common.saving') : t('whatsapp.dunning.starter')}
            </button>
            <p className="field-hint mt-2">{t('whatsapp.dunning.starterHint')}</p>
          </div>
        )}

        {draft.steps.length === 0 && (
          <p className="mb-4 text-sm text-muted-foreground">{t('whatsapp.dunning.noSteps')}</p>
        )}

        <ol className="space-y-3">
          {draft.steps.map((step, index) => {
            const problem = problems[index]
            const template = step.templateId === null ? undefined : templateById.get(step.templateId)
            return (
              <li key={step.key} className="rounded-md border border-border p-3">
                <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-end">
                  <div>
                    <label htmlFor={`dunning-offset-${step.key}`} className="field-label">
                      {t('whatsapp.dunning.stepDay')}
                    </label>
                    <input
                      id={`dunning-offset-${step.key}`}
                      type="number"
                      min={OFFSET_MIN}
                      max={OFFSET_MAX}
                      className="modern-input"
                      value={Number.isNaN(step.offsetDays) ? '' : step.offsetDays}
                      disabled={!canManage}
                      onChange={(event) => setStep(step.key, { offsetDays: Number.parseInt(event.target.value, 10) })}
                    />
                  </div>
                  <div className="min-w-0">
                    <label htmlFor={`dunning-template-${step.key}`} className="field-label">
                      {t('whatsapp.dunning.stepTemplate')}
                    </label>
                    <select
                      id={`dunning-template-${step.key}`}
                      className="modern-input"
                      value={step.templateId ?? ''}
                      disabled={!canManage}
                      onChange={(event) => setStep(step.key, {
                        templateId: event.target.value ? Number(event.target.value) : null
                      })}
                    >
                      <option value="">{t('whatsapp.billing.templatePick')}</option>
                      {templates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name} — {isReminderBody(tpl.body) ? t('whatsapp.templates.isReminder') : t('whatsapp.templates.isDunning')}
                        </option>
                      ))}
                    </select>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      className="modern-button-secondary"
                      aria-label={t('whatsapp.dunning.removeStep')}
                      onClick={() => patch({ steps: draft.steps.filter((s) => s.key !== step.key) })}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  )}
                </div>
                <p className="mt-2 text-sm text-foreground">
                  <span className="font-medium">
                    {Number.isInteger(step.offsetDays) ? stepLabel(step.offsetDays) : '—'}
                  </span>
                  {template && (
                    <span className="ml-2 text-muted-foreground">· {template.name}</span>
                  )}
                </p>
                {problem && (
                  <p className="mt-1 text-sm text-destructive" role="alert">
                    {t(PROBLEM_LABELS[problem], { min: OFFSET_MIN, max: OFFSET_MAX })}
                  </p>
                )}
              </li>
            )
          })}
        </ol>

        {canManage && draft.steps.length < MAX_STEPS && (
          <button
            type="button"
            className="modern-button-secondary mt-4"
            onClick={() => patch({
              steps: [...draft.steps, { key: ++stepKeys, offsetDays: nextOffset(draft.steps), templateId: null }]
            })}
          >
            <Icon name="check" size={16} />
            {t('whatsapp.dunning.addStep')}
          </button>
        )}
      </div>

      {/* ── Limits ─────────────────────────────────────────────────────── */}
      <div className="modern-card p-4 sm:p-5">
        <h3 className="field-label mb-3">{t('whatsapp.dunning.limitsTitle')}</h3>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <label htmlFor="dunning-max-invoice" className="field-label">{t('whatsapp.dunning.maxPerInvoice')}</label>
            <input
              id="dunning-max-invoice"
              type="number"
              min={1}
              max={30}
              className="modern-input"
              value={draft.maxPerInvoice}
              disabled={!canManage}
              onChange={(event) => patch({ maxPerInvoice: event.target.value })}
            />
            <p className="field-hint">{t('whatsapp.dunning.maxPerInvoiceHint')}</p>
          </div>
          <div>
            <label htmlFor="dunning-interval" className="field-label">{t('whatsapp.dunning.minInterval')}</label>
            <input
              id="dunning-interval"
              type="number"
              min={0}
              max={720}
              className="modern-input"
              value={draft.minIntervalHours}
              disabled={!canManage}
              onChange={(event) => patch({ minIntervalHours: event.target.value })}
            />
            <p className="field-hint">{t('whatsapp.dunning.minIntervalHint')}</p>
          </div>
          <div>
            <label htmlFor="dunning-max-run" className="field-label">{t('whatsapp.dunning.maxPerRun')}</label>
            <input
              id="dunning-max-run"
              type="number"
              min={1}
              max={2000}
              className="modern-input"
              value={draft.maxPerRun}
              disabled={!canManage}
              onChange={(event) => patch({ maxPerRun: event.target.value })}
            />
            <p className="field-hint">{t('whatsapp.dunning.maxPerRunHint')}</p>
          </div>
          <div>
            <label htmlFor="dunning-receipt-pause" className="field-label">{t('whatsapp.dunning.receiptPause')}</label>
            <input
              id="dunning-receipt-pause"
              type="number"
              min={0}
              max={15}
              className="modern-input"
              value={draft.receiptPauseDays}
              disabled={!canManage}
              onChange={(event) => patch({ receiptPauseDays: event.target.value })}
            />
            <p className="field-hint">{t('whatsapp.dunning.receiptPauseHint')}</p>
          </div>
        </div>
      </div>

      {/* ── Send window ────────────────────────────────────────────────── */}
      <div className="modern-card p-4 sm:p-5">
        <h3 className="field-label">{t('whatsapp.dunning.windowTitle')}</h3>
        <p className="field-hint mb-4">{t('whatsapp.dunning.windowHint')}</p>
        <div className="mb-4 max-w-xs">
          <label htmlFor="dunning-timezone" className="field-label">{t('settings.chatbot.timezone')}</label>
          <select
            id="dunning-timezone"
            className="modern-input"
            value={draft.window.timezone}
            disabled={!canManage}
            onChange={(event) => patch({ window: { ...draft.window, timezone: event.target.value } })}
          >
            {timezones.map((tz) => <option key={tz} value={tz}>{tz.replace('America/', '').replace('_', ' ')}</option>)}
          </select>
        </div>
        <div className="grid gap-2">
          {DAY_ORDER.map((day) => {
            const rule = draft.window.week.find((d) => d.day === day)
            if (!rule) return null
            return (
              <div key={day} className="flex flex-wrap items-center gap-3">
                <span className="w-32 text-sm capitalize">{dayName(day)}</span>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={rule.closed}
                    disabled={!canManage}
                    onChange={(event) => setDay(day, { closed: event.target.checked })}
                  />
                  {t('whatsapp.dunning.noSending')}
                </label>
                <input
                  type="time"
                  aria-label={`${dayName(day)} — ${t('settings.chatbot.opens')}`}
                  className="modern-input w-32"
                  value={rule.open}
                  disabled={!canManage || rule.closed}
                  onChange={(event) => setDay(day, { open: event.target.value })}
                />
                <span className="text-sm text-muted-foreground">—</span>
                <input
                  type="time"
                  aria-label={`${dayName(day)} — ${t('settings.chatbot.closes')}`}
                  className="modern-input w-32"
                  value={rule.close}
                  disabled={!canManage || rule.closed}
                  onChange={(event) => setDay(day, { close: event.target.value })}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Thank-you ──────────────────────────────────────────────────── */}
      <div className="modern-card p-4 sm:p-5">
        <label htmlFor="dunning-thanks" className="field-label">{t('whatsapp.dunning.thanksTitle')}</label>
        <select
          id="dunning-thanks"
          className="modern-input max-w-md"
          value={draft.thanksTemplateId ?? ''}
          disabled={!canManage}
          onChange={(event) => patch({ thanksTemplateId: event.target.value ? Number(event.target.value) : null })}
        >
          <option value="">{t('whatsapp.dunning.thanksNone')}</option>
          {thanksOptions.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
        </select>
        <p className="field-hint">{t('whatsapp.dunning.thanksHint')}</p>
      </div>

      {canManage && (
        <div>
          <button type="button" className="modern-button" disabled={saving} onClick={() => void save()}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      )}
    </section>
  )
}
