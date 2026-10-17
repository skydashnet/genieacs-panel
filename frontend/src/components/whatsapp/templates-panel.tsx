'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { whatsappAPI, type MetaHeaderBinding, type WhatsAppMetaTemplate, type WhatsAppTemplate } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import type { TranslationKey } from '@/lib/i18n'
import { copyName } from './template-copy'
import { MetaTemplatesPanel, metaKey } from './meta-templates-panel'
import { TemplateAiAssist } from './template-ai-assist'
import {
  TEMPLATE_CATEGORIES,
  asCategory,
  citedVariables,
  classify,
  filterTemplates,
  isFiltering,
  NO_FILTER,
  templateCounts,
  type BillingKind,
  type TemplateCategory,
  type TemplateFilter
} from './template-filter'

// ─────────────────────────────────────────────────────────────────────────────
// The variables the dispatcher knows how to fill.
//
// SOURCE OF TRUTH: `backend/src/utils/wa/waCobranca.js`, `VARIAVEIS_DE_COBRANCA`
// (also re-exported from `backend/src/services/waTemplateService.js`). No route
// publishes the list, so it is copied here rather than fetched; if the backend
// grows a variable, this array is the second place to change.
//
// The copy earns its keep: the server refuses a body citing anything outside
// this list with `unknown_variable`, and an operator typing `{{nome_cliente}}`
// from memory only finds out at save time. The chips below turn that recall
// into recognition.
// ─────────────────────────────────────────────────────────────────────────────
const VARIABLES = [
  'nome',
  'valor',
  'vencimento',
  'dias_atraso',
  'dias_para_vencer',
  'pix',
  'linha_digitavel',
  'link_boleto'
] as const

/**
 * As variáveis de uma resposta rápida (categoria `atendimento`): quem preenche
 * é a tela da conversa, não o disparo de cobrança. Espelho de
 * `VARIAVEIS_DE_ATENDIMENTO` no backend (`waTemplateService.js`).
 */
const QUICK_REPLY_VARIABLES = ['nome', 'primeiro_nome', 'contrato', 'atendente'] as const

export { TEMPLATE_CATEGORIES }

const CATEGORY_LABEL = {
  cobranca: 'whatsapp.templates.categoryCobranca',
  atendimento: 'whatsapp.templates.categoryAtendimento',
  suporte: 'whatsapp.templates.categorySuporte',
  alerta: 'whatsapp.templates.categoryAlerta',
  geral: 'whatsapp.templates.categoryGeral'
} as const satisfies Record<TemplateCategory, string>

/** As variáveis que a categoria aceita — a mesma regra do servidor. */
const variablesFor = (category: TemplateCategory): readonly string[] =>
  category === 'atendimento' ? QUICK_REPLY_VARIABLES : VARIABLES

/** What the server will refuse the body for, computed before asking it. */
function unknownVariables(body: string, category: TemplateCategory): string[] {
  const allowed = variablesFor(category)
  return citedVariables(body).filter((name) => !allowed.includes(name))
}

const KIND_FILTERS: [BillingKind, TranslationKey][] = [
  ['reminder', 'whatsapp.templates.filterReminder'],
  ['dunning', 'whatsapp.templates.filterDunning']
]

const CLASSIFICATION_LABEL: Record<'reminder' | 'dunning', TranslationKey> = {
  reminder: 'whatsapp.templates.isReminder',
  dunning: 'whatsapp.templates.isDunning'
}

/**
 * The classification as a badge. `none` draws nothing: a template citing
 * neither mirror is simply not a billing text, and an extra "neither" chip on
 * every support template would be noise.
 */
function ClassificationBadge({ body }: { body: string }) {
  const { t } = useTranslation()
  const kind = classify(body)
  if (kind === 'none') return null
  if (kind === 'both') {
    return (
      <span className="modern-badge-error" title={t('whatsapp.billing.templateMismatch')}>
        <Icon name="warning" size={12} />
        {t('common.warning')}
      </span>
    )
  }
  return (
    <span className={kind === 'reminder' ? 'modern-badge-info' : 'modern-badge-warning'}>
      <Icon name="invoice" size={12} />
      {t(CLASSIFICATION_LABEL[kind])}
    </span>
  )
}

interface Draft {
  id: number | null
  name: string
  body: string
  category: TemplateCategory
  /** `nome|idioma` do modelo da Meta ligado, ou vazio. */
  meta: string
  /** Nossa variável para cada `{{n}}` do modelo da Meta, em ordem. */
  metaParams: string[]
  /** De onde vem o cabeçalho, quando o modelo da Meta tem mídia ou texto com variável. */
  metaHeader: MetaHeaderBinding | null
  /** A variável que completa a URL do botão dinâmico. */
  metaButtonParam: string
}

const EMPTY_DRAFT: Draft = {
  id: null, name: '', body: '', category: 'cobranca', meta: '', metaParams: [], metaHeader: null, metaButtonParam: ''
}

/** Cabeçalhos que saem por link de mídia. */
const MEDIA_HEADERS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT'])

/** O que o modelo da Meta pede além do corpo: origem do cabeçalho e variável do botão. */
const metaNeeds = (m: WhatsAppMetaTemplate | null) => ({
  mediaHeader: Boolean(m && MEDIA_HEADERS.has(m.headerFormat)),
  textHeader: Boolean(m && m.headerFormat === 'TEXT' && m.headerParamCount > 0),
  button: Boolean(m && m.buttons.some((b) => b.urlHasParam))
})

/** Se a ligação do cabeçalho está completa para o modelo escolhido. */
const headerReady = (m: WhatsAppMetaTemplate | null, h: MetaHeaderBinding | null) => {
  const needs = metaNeeds(m)
  if (needs.textHeader) return h?.source === 'variable' && Boolean(h.value)
  if (!needs.mediaHeader) return true
  if (!h) return false
  if (h.source === 'attachment') return true
  if (h.source === 'url') return /^https:\/\/\S+$/i.test(h.value ?? '')
  return Boolean(h.value)
}

/** O texto inteiro da mensagem, como parâmetro de um modelo da Meta. */
const FULL_TEXT = 'texto'

const draftFrom = (template: WhatsAppTemplate) => ({
  meta: template.metaTemplateName ? `${template.metaTemplateName}|${template.metaLanguage ?? ''}` : '',
  metaParams: template.metaParams ?? [],
  metaHeader: template.metaHeader ?? null,
  metaButtonParam: template.metaButtonParam ?? ''
})

/**
 * The message-template editor.
 *
 * Self-contained: it owns its own fetch, its own draft and its own refusals,
 * and the page only has to mount it.
 */
export function TemplatesPanel() {
  const { t, intlLocale, formatDateTime } = useTranslation()
  const toast = useToast()

  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([])
  const [filter, setFilter] = useState<TemplateFilter>(NO_FILTER)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  // The refusal that has a name, kept on the form instead of only in a toast:
  // it names variables the operator has to go and fix in the text in front of
  // them, and a toast is gone by the time they look.
  const [refusal, setRefusal] = useState('')

  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const formRef = useRef<HTMLFormElement | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Os modelos aprovados da Meta, para ligar um modelo do painel a um deles.
  // Vazio para quem não tem número oficial — e aí a seção nem aparece.
  const [metaTemplates, setMetaTemplates] = useState<WhatsAppMetaTemplate[]>([])
  const loadMeta = useCallback(async () => {
    const res = await whatsappAPI.listMetaTemplates({ usable: true })
    if (alive.current && res.success && Array.isArray(res.data)) {
      // O mesmo modelo em dois números aparece uma vez só.
      const unicos = new Map(res.data.map((m) => [metaKey(m), m]))
      setMetaTemplates([...unicos.values()])
    }
  }, [])
  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  const load = useCallback(async () => {
    setLoading(true)
    const res = await whatsappAPI.listTemplates()
    if (!alive.current) return
    if (res.success && Array.isArray(res.data)) {
      setTemplates(res.data)
      setLoadError('')
    } else {
      setLoadError(whatsappErrorMessage(t, res.code))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const stamp = useCallback(
    (iso: string | null) => {
      if (!iso) return ''
      return formatDateTime(iso)
    },
    [formatDateTime]
  )

  /**
   * Insert `{{name}}` where the caret is.
   *
   * Splicing at the selection rather than appending is the whole point: the
   * operator is mid-sentence ("Hi ", caret, ", your invoice…"), and a variable
   * that lands at the end of the box would have to be cut and pasted back.
   * The caret is put back after the inserted text so typing continues.
   */
  const insertVariable = useCallback((name: string) => {
    const token = `{{${name}}}`
    setDraft((current) => {
      if (!current) return current
      const field = bodyRef.current
      const start = field?.selectionStart ?? current.body.length
      const end = field?.selectionEnd ?? current.body.length
      const next = `${current.body.slice(0, start)}${token}${current.body.slice(end)}`
      // The state update has not painted yet, so the caret is moved on the next
      // frame — before it, the textarea still holds the old value and any
      // selection we set would be clobbered by React's own write.
      requestAnimationFrame(() => {
        const el = bodyRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(start + token.length, start + token.length)
      })
      return { ...current, body: next }
    })
    setRefusal('')
  }, [])

  const save = useCallback(async () => {
    if (!draft) return
    const name = draft.name.trim()
    const body = draft.body.trim()
    // `template_empty` is a refusal this panel can avoid provoking, so the
    // button simply does not arm until there is something to save.
    if (!name || !body) return

    setSaving(true)
    setRefusal('')
    const { category } = draft
    const [metaTemplateName = '', metaLanguage = ''] = draft.meta ? draft.meta.split('|') : []
    // O que o modelo escolhido não pede vai nulo: o servidor descartaria de todo jeito.
    const escolhido = metaTemplates.find((m) => metaKey(m) === draft.meta) ?? null
    const needs = metaNeeds(escolhido)
    const meta = {
      metaTemplateName,
      metaLanguage,
      metaParams: metaTemplateName ? draft.metaParams : [],
      metaHeader: metaTemplateName && (needs.mediaHeader || needs.textHeader) ? draft.metaHeader : null,
      metaButtonParam: metaTemplateName && needs.button ? draft.metaButtonParam : null
    }
    const res = draft.id === null
      ? await whatsappAPI.createTemplate({ name, body, category, ...meta })
      : await whatsappAPI.updateTemplate(draft.id, { name, body, category, ...meta })
    if (!alive.current) return
    setSaving(false)

    if (res.success) {
      setDraft(null)
      toast.success(t('common.success'))
      await load()
      return
    }

    // Only the machine `code` is ever translated. `unknown_variable` is the one
    // refusal that can name what is wrong, and it names it from the body in the
    // box — not by parsing the server's prose back apart.
    if (res.code === 'unknown_variable') {
      const offenders = unknownVariables(body, category).map((v) => `{{${v}}}`)
      const message = t('whatsapp.templates.unknownVariable', {
        name: offenders.length > 0 ? offenders.join(', ') : '{{…}}'
      })
      setRefusal(message)
      toast.error(message)
      return
    }
    const message = whatsappErrorMessage(t, res.code)
    setRefusal(message)
    toast.error(message)
  }, [draft, load, metaTemplates, t, toast])

  const remove = useCallback(
    async (template: WhatsAppTemplate) => {
      if (!window.confirm(t('whatsapp.templates.confirmDelete', { name: template.name }))) return
      setDeletingId(template.id)
      const res = await whatsappAPI.deleteTemplate(template.id)
      if (!alive.current) return
      setDeletingId(null)
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      if (draft?.id === template.id) setDraft(null)
      toast.success(t('common.success'))
      await load()
    },
    [draft, load, t, toast]
  )

  const draftMeta = draft?.meta ? metaTemplates.find((m) => metaKey(m) === draft.meta) ?? null : null
  // O botão só arma com uma variável escolhida para cada parâmetro do modelo.
  const draftNeeds = metaNeeds(draftMeta)
  const metaIncomplete = Boolean(draft?.meta)
    && (!draftMeta || draft!.metaParams.length !== draftMeta.paramCount || draft!.metaParams.some((v) => !v)
      || !headerReady(draftMeta, draft!.metaHeader)
      || (draftNeeds.button && !draft!.metaButtonParam))
  const visible = useMemo(() => filterTemplates(templates, filter), [templates, filter])
  const counts = useMemo(() => templateCounts(templates, filter), [templates, filter])
  const draftBody = draft?.body ?? ''
  const draftKind = useMemo(() => classify(draftBody), [draftBody])
  const canSave = Boolean(draft && draft.name.trim() && draft.body.trim()) && !metaIncomplete

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="section-heading">{t('whatsapp.templates.title')}</h2>
          <p className="section-description">{t('whatsapp.templates.description')}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className="modern-button-secondary" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={16} />
            {t('common.refresh')}
          </button>
          <button
            type="button"
            className="modern-button"
            onClick={() => {
              setRefusal('')
              setDraft({ ...EMPTY_DRAFT })
            }}
          >
            <Icon name="edit" size={16} />
            {t('whatsapp.templates.new')}
          </button>
        </div>
      </header>

      <MetaTemplatesPanel onSynced={() => void loadMeta()} />

      {draft && (
        <form
          ref={formRef}
          className="modern-card flex flex-col gap-4 p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div>
            <label className="field-label" htmlFor="wa-template-name">
              {t('whatsapp.templates.name')}
            </label>
            <input
              id="wa-template-name"
              className="modern-input"
              value={draft.name}
              maxLength={80}
              autoComplete="off"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="wa-template-category">
              {t('whatsapp.templates.category')}
            </label>
            <select
              id="wa-template-category"
              className="modern-input"
              value={draft.category}
              onChange={(event) => {
                setDraft({ ...draft, category: asCategory(event.target.value) })
                setRefusal('')
              }}
            >
              {TEMPLATE_CATEGORIES.map((category) => (
                <option key={category} value={category}>{t(CATEGORY_LABEL[category])}</option>
              ))}
            </select>
            {draft.category === 'atendimento' && (
              <p className="field-hint">{t('whatsapp.templates.quickReplyHint')}</p>
            )}
          </div>

          <TemplateAiAssist
            category={draft.category}
            body={draft.body}
            onApply={(text) => {
              setDraft((current) => (current ? { ...current, body: text } : current))
              setRefusal('')
            }}
          />

          <div>
            <label className="field-label" htmlFor="wa-template-body">
              {t('whatsapp.templates.body')}
            </label>
            <textarea
              id="wa-template-body"
              ref={bodyRef}
              className="modern-input min-h-40 font-mono text-[0.82rem] leading-6"
              value={draft.body}
              onChange={(event) => {
                setDraft({ ...draft, body: event.target.value })
                setRefusal('')
              }}
            />
          </div>

          <div>
            <span className="field-label">{t('whatsapp.templates.variables')}</span>
            <div className="flex flex-wrap gap-1.5">
              {variablesFor(draft.category).map((name) => (
                <button
                  key={name}
                  type="button"
                  title={t('whatsapp.templates.insertVariable')}
                  aria-label={`${t('whatsapp.templates.insertVariable')} {{${name}}}`}
                  onClick={() => insertVariable(name)}
                  className="inline-flex items-center gap-1 rounded border border-border bg-[hsl(var(--surface-subtle))] px-2 py-1 font-mono text-xs font-semibold text-foreground transition-colors hover:border-primary hover:bg-secondary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon name="copy" size={12} />
                  {`{{${name}}}`}
                </button>
              ))}
            </div>
          </div>

          {metaTemplates.length > 0 && draft.category !== 'atendimento' && (
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-semibold text-foreground">{t('whatsapp.metaTemplates.mapTitle')}</legend>
              <p className="field-hint">{t('whatsapp.metaTemplates.mapHint')}</p>
              <select
                aria-label={t('whatsapp.metaTemplates.mapTitle')}
                className="modern-input mt-2"
                value={draft.meta}
                onChange={(event) => {
                  const escolhido = metaTemplates.find((m) => metaKey(m) === event.target.value)
                  setDraft({
                    ...draft,
                    meta: event.target.value,
                    metaParams: Array.from({ length: escolhido?.paramCount ?? 0 }, () => ''),
                    metaHeader: null,
                    metaButtonParam: ''
                  })
                }}
              >
                <option value="">{t('whatsapp.metaTemplates.mapNone')}</option>
                {draft.meta && !draftMeta && <option value={draft.meta}>{draft.meta.replace('|', ' · ')}</option>}
                {metaTemplates.map((m) => (
                  <option key={metaKey(m)} value={metaKey(m)}>{`${m.name} · ${m.language}`}</option>
                ))}
              </select>
              {draftMeta && (
                <>
                  <p className="mt-2 whitespace-pre-wrap wrap-break-word font-mono text-[0.78rem] leading-6 text-muted-foreground">
                    {draftMeta.bodyText}
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {Array.from({ length: draftMeta.paramCount }, (_, i) => (
                      <label key={i} className="text-xs text-muted-foreground">
                        {t('whatsapp.metaTemplates.paramLabel', { n: i + 1 })}
                        <select
                          className="modern-input mt-1 w-full"
                          value={draft.metaParams[i] ?? ''}
                          onChange={(event) => {
                            const next = [...draft.metaParams]
                            next[i] = event.target.value
                            setDraft({ ...draft, metaParams: next })
                          }}
                        >
                          <option value="">—</option>
                          <option value={FULL_TEXT}>{t('whatsapp.metaTemplates.fullText')}</option>
                          {variablesFor(draft.category).map((name) => (
                            <option key={name} value={name}>{`{{${name}}}`}</option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  <MetaExtrasEditor
                    template={draftMeta}
                    variables={variablesFor(draft.category)}
                    header={draft.metaHeader}
                    buttonParam={draft.metaButtonParam}
                    onHeader={(metaHeader) => setDraft({ ...draft, metaHeader })}
                    onButtonParam={(metaButtonParam) => setDraft({ ...draft, metaButtonParam })}
                  />
                </>
              )}
            </fieldset>
          )}

          {/* The badge is the same one the list rows carry, so the operator
              learns what it means here. It is dropped for `both`, where the
              paragraph below says the whole thing in words. */}
          {draftKind === 'reminder' || draftKind === 'dunning' ? (
            <div className="flex flex-wrap items-center gap-2">
              <ClassificationBadge body={draftBody} />
            </div>
          ) : null}

          {draftKind === 'both' && (
            <p className="flex items-start gap-2 rounded-md border border-[hsl(var(--status-danger)/0.3)] bg-[hsl(var(--status-danger)/0.08)] p-3 text-xs leading-5 text-[hsl(var(--status-danger))]">
              <Icon name="warning" size={16} />
              <span>{t('whatsapp.billing.templateMismatch')}</span>
            </p>
          )}

          {refusal && (
            <p className="flex items-start gap-2 rounded-md border border-[hsl(var(--status-danger)/0.3)] bg-[hsl(var(--status-danger)/0.08)] p-3 text-xs leading-5 text-[hsl(var(--status-danger))]">
              <Icon name="warning" size={16} />
              <span>{refusal}</span>
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="submit" className="modern-button" disabled={!canSave || saving}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <button
              type="button"
              className="modern-button-secondary"
              onClick={() => {
                setDraft(null)
                setRefusal('')
              }}
              disabled={saving}
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {loadError && (
        <p className="flex items-center gap-2 text-sm text-[hsl(var(--status-danger))]">
          <Icon name="warning" size={16} />
          {loadError}
        </p>
      )}

      {templates.length > 0 && (
        <div className="flex flex-col gap-3" data-testid="templates-filters">
          <input
            type="search"
            className="modern-input"
            value={filter.search}
            placeholder={t('whatsapp.templates.searchPlaceholder')}
            aria-label={t('whatsapp.templates.searchPlaceholder')}
            onChange={(event) => setFilter((current) => ({ ...current, search: event.target.value }))}
          />
          <div className="flex flex-wrap items-center gap-3">
            <div className="tab-rail" role="tablist" aria-label={t('whatsapp.templates.category')}>
              {(['', ...TEMPLATE_CATEGORIES] as const).map((id) => (
                <button
                  key={id || 'all'}
                  type="button"
                  className="tab-button"
                  role="tab"
                  data-active={filter.category === id}
                  aria-selected={filter.category === id}
                  onClick={() => setFilter((current) => ({ ...current, category: id }))}
                >
                  {id ? t(CATEGORY_LABEL[id]) : t('whatsapp.templates.filterAll')}
                  <span className="ml-1.5 text-xs font-normal opacity-70" data-testid="templates-count">{counts.categories[id || 'all']}</span>
                </button>
              ))}
            </div>
            {KIND_FILTERS.map(([kind, labelKey]) => (
              <button
                key={kind}
                type="button"
                className={filter.kind === kind ? 'modern-button' : 'modern-button-secondary'}
                aria-pressed={filter.kind === kind}
                data-testid={`templates-kind-${kind}`}
                onClick={() => setFilter((current) => ({ ...current, kind: current.kind === kind ? '' : kind }))}
              >
                <Icon name="invoice" size={16} />
                {t(labelKey)}
                <span className="text-xs font-normal opacity-70">{counts.kinds[kind]}</span>
                {filter.kind === kind && <Icon name="x" size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : templates.length === 0 ? (
        <div className="modern-card">
          <div className="empty-state">
            <div className="empty-state-icon">
              <Icon name="chat" size={22} />
            </div>
            <p className="empty-state-title">{t('whatsapp.templates.empty')}</p>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="modern-card" data-testid="templates-no-match">
          <div className="empty-state">
            <div className="empty-state-icon">
              <Icon name="search" size={22} />
            </div>
            <p className="empty-state-title">{t('whatsapp.templates.noMatch')}</p>
            {isFiltering(filter) && (
              <button type="button" className="modern-button-secondary mt-3" onClick={() => setFilter(NO_FILTER)}>
                {t('whatsapp.templates.clearFilters')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-3" role="list">
          {visible.map((template) => (
            <li key={template.id} className="modern-card p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{template.name}</span>
                    <span className="modern-badge">{t(CATEGORY_LABEL[asCategory(template.category)])}</span>
                    {asCategory(template.category) !== 'atendimento' && <ClassificationBadge body={template.body} />}
                    {template.metaTemplateName && (
                      <span className="modern-badge-info">{t('whatsapp.metaTemplates.mapBadge', { name: template.metaTemplateName })}</span>
                    )}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap wrap-break-word font-mono text-[0.78rem] leading-6 text-muted-foreground">
                    {template.body}
                  </p>
                  {template.updatedAt && (
                    <p className="mt-2 font-mono text-[0.68rem] tabular-nums text-muted-foreground">
                      {stamp(template.updatedAt)}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className="modern-button-secondary"
                    onClick={() => {
                      setRefusal('')
                      setDraft({ id: template.id, name: template.name, body: template.body, category: asCategory(template.category), ...draftFrom(template) })
                    }}
                  >
                    <Icon name="edit" size={16} />
                    {t('common.edit')}
                  </button>
                  <button
                    type="button"
                    className="modern-button-secondary"
                    onClick={() => {
                      // A new template, pre-filled: nothing is written until
                      // Save, and the server checks the copy like any other.
                      setRefusal('')
                      setDraft({
                        id: null,
                        name: copyName(template.name, templates.map((entry) => entry.name), t('whatsapp.templates.copySuffix')),
                        body: template.body,
                        category: asCategory(template.category),
                        ...draftFrom(template)
                      })
                      // The editor sits above the list; a click at the bottom
                      // of a long list would otherwise open it off screen.
                      requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
                    }}
                  >
                    <Icon name="copy" size={16} />
                    {t('whatsapp.templates.duplicate')}
                  </button>
                  <button
                    type="button"
                    className="modern-button-danger"
                    onClick={() => void remove(template)}
                    disabled={deletingId === template.id}
                  >
                    <Icon name="trash" size={16} />
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * O que o modelo da Meta pede além do corpo: a origem da mídia do cabeçalho
 * (anexo da campanha, variável com o link, URL fixa), a variável do cabeçalho
 * de texto e a variável que completa a URL do botão dinâmico.
 */
function MetaExtrasEditor({
  template,
  variables,
  header,
  buttonParam,
  onHeader,
  onButtonParam
}: {
  template: WhatsAppMetaTemplate
  variables: readonly string[]
  header: MetaHeaderBinding | null
  buttonParam: string
  onHeader: (header: MetaHeaderBinding | null) => void
  onButtonParam: (value: string) => void
}) {
  const { t } = useTranslation()
  const needs = metaNeeds(template)
  if (!needs.mediaHeader && !needs.textHeader && !needs.button) return null
  const formatLabel = t(`whatsapp.metaTemplates.headerFormat.${template.headerFormat}`)
  const variableOptions = variables.map((name) => (
    <option key={name} value={name}>{`{{${name}}}`}</option>
  ))
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {needs.mediaHeader && (
        <>
          <label className="text-xs text-muted-foreground">
            {t('whatsapp.metaTemplates.headerSource', { format: formatLabel })}
            <select
              className="modern-input mt-1 w-full"
              value={header?.source ?? ''}
              onChange={(event) => {
                const source = event.target.value
                if (source === 'attachment' || source === 'variable' || source === 'url') {
                  onHeader({ source, value: source === 'variable' && variables.includes('link_boleto') ? 'link_boleto' : null })
                } else {
                  onHeader(null)
                }
              }}
            >
              <option value="">—</option>
              <option value="attachment">{t('whatsapp.metaTemplates.headerSourceAttachment')}</option>
              <option value="variable">{t('whatsapp.metaTemplates.headerSourceVariable')}</option>
              <option value="url">{t('whatsapp.metaTemplates.headerSourceUrl')}</option>
            </select>
          </label>
          {header?.source === 'variable' && (
            <label className="text-xs text-muted-foreground">
              {t('whatsapp.metaTemplates.headerSourceVariable')}
              <select
                className="modern-input mt-1 w-full"
                value={header.value ?? ''}
                onChange={(event) => onHeader({ source: 'variable', value: event.target.value || null })}
              >
                <option value="">—</option>
                {variableOptions}
              </select>
            </label>
          )}
          {header?.source === 'url' && (
            <label className="text-xs text-muted-foreground">
              {t('whatsapp.metaTemplates.headerSourceUrl')}
              <input
                type="url"
                inputMode="url"
                className="modern-input mt-1 w-full"
                placeholder="https://"
                value={header.value ?? ''}
                onChange={(event) => onHeader({ source: 'url', value: event.target.value.trim() || null })}
              />
            </label>
          )}
          {header?.source === 'attachment' && (
            <p className="field-hint sm:col-span-2">{t('whatsapp.metaTemplates.headerAttachmentHint')}</p>
          )}
        </>
      )}
      {needs.textHeader && (
        <label className="text-xs text-muted-foreground">
          {t('whatsapp.metaTemplates.headerTextVariable')}
          <select
            className="modern-input mt-1 w-full"
            value={header?.source === 'variable' ? header.value ?? '' : ''}
            onChange={(event) => onHeader(event.target.value ? { source: 'variable', value: event.target.value } : null)}
          >
            <option value="">—</option>
            {variableOptions}
          </select>
        </label>
      )}
      {needs.button && (
        <label className="text-xs text-muted-foreground">
          {t('whatsapp.metaTemplates.buttonParam')}
          <select
            className="modern-input mt-1 w-full"
            value={buttonParam}
            onChange={(event) => onButtonParam(event.target.value)}
          >
            <option value="">—</option>
            {variableOptions}
          </select>
        </label>
      )}
    </div>
  )
}
