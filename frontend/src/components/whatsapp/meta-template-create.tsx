'use client'

import { useRef, useState } from 'react'
import type { MetaTemplateCreatePayload } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

// ── Lógica pura (testada em test/wa-meta-template-create.test.ts) ──────
//
// As mesmas regras do servidor (`validateMetaTemplateInput`): o botão de
// enviar só acende quando a Meta não teria motivo de formato para recusar, e o
// servidor confere de novo — esta cópia existe para o formulário apontar o
// campo enquanto a pessoa digita, não para ser a guarda.

export const META_BODY_LIMIT = 1024
export const META_HEADER_LIMIT = 60
export const META_FOOTER_LIMIT = 60
export const META_BUTTON_TEXT_LIMIT = 25
export const META_BUTTONS_MAX = 3

export type MetaButtonDraft = { type: 'URL' | 'QUICK_REPLY'; text: string; url: string }

export interface MetaTemplateDraft {
  name: string
  category: 'UTILITY' | 'MARKETING'
  language: string
  headerText: string
  bodyText: string
  /** Um por variável, na ordem; pode sobrar no fim quando a pessoa apaga uma variável. */
  examples: string[]
  footerText: string
  buttons: MetaButtonDraft[]
}

export type MetaDraftField =
  | 'name'
  | 'category'
  | 'language'
  | 'headerText'
  | 'bodyText'
  | 'variables'
  | 'examples'
  | 'footerText'
  | 'buttons'

export const emptyMetaDraft = (): MetaTemplateDraft => ({
  name: '',
  category: 'UTILITY',
  language: 'pt_BR',
  headerText: '',
  bodyText: '',
  examples: [],
  footerText: '',
  buttons: []
})

/** O nome como a Meta aceita: minúsculas, dígitos e `_`; espaço vira `_`. */
export function normalizeMetaName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 512)
}

/**
 * As variáveis do corpo: quantas (o maior `{{n}}`) e se estão em ordem — de
 * 1 até o maior, sem pular, e nenhuma nomeada.
 */
export function bodyVariables(body: string): { count: number; ok: boolean } {
  const numeros = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]))
  const nomeadas = /\{\{\s*[A-Za-z_]\w*\s*\}\}/.test(body)
  const count = numeros.length ? Math.max(...numeros) : 0
  const vistos = new Set(numeros)
  let ok = !nomeadas && !vistos.has(0)
  for (let n = 1; n <= count; n += 1) if (!vistos.has(n)) ok = false
  return { count, ok }
}

/** A próxima variável a inserir: uma depois da maior que já existe. */
export function nextVariable(body: string): string {
  return `{{${bodyVariables(body).count + 1}}}`
}

function httpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:' && !raw.includes('{{')
  } catch {
    return false
  }
}

/** Os campos com problema, na ordem do formulário. Lista vazia = pode enviar. */
export function validateDraft(d: MetaTemplateDraft): MetaDraftField[] {
  const out: MetaDraftField[] = []
  if (!/^[a-z0-9_]{1,512}$/.test(normalizeMetaName(d.name.trim()))) out.push('name')
  if (d.category !== 'UTILITY' && d.category !== 'MARKETING') out.push('category')
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(d.language.trim())) out.push('language')
  const header = d.headerText.trim()
  if (header.length > META_HEADER_LIMIT || header.includes('{{')) out.push('headerText')
  const body = d.bodyText.trim()
  if (!body || body.length > META_BODY_LIMIT) out.push('bodyText')
  const vars = bodyVariables(body)
  if (!vars.ok) out.push('variables')
  else if (d.examples.slice(0, vars.count).filter((v) => v.trim()).length !== vars.count) out.push('examples')
  if (d.footerText.trim().length > META_FOOTER_LIMIT) out.push('footerText')
  const botoesRuins = d.buttons.length > META_BUTTONS_MAX || d.buttons.some((b) => {
    const text = b.text.trim()
    if (!text || text.length > META_BUTTON_TEXT_LIMIT) return true
    return b.type === 'URL' ? !httpsUrl(b.url.trim()) : b.type !== 'QUICK_REPLY'
  })
  if (botoesRuins) out.push('buttons')
  return out
}

/** O corpo do pedido, com os exemplos cortados para a quantidade de variáveis. */
export function toMetaPayload(d: MetaTemplateDraft): MetaTemplateCreatePayload {
  const body = d.bodyText.trim()
  const { count } = bodyVariables(body)
  const header = d.headerText.trim()
  const footer = d.footerText.trim()
  return {
    name: normalizeMetaName(d.name.trim()),
    category: d.category,
    language: d.language.trim(),
    bodyText: body,
    examples: d.examples.slice(0, count).map((v) => v.trim()),
    ...(header ? { headerText: header } : {}),
    ...(footer ? { footerText: footer } : {}),
    buttons: d.buttons.map((b) => (b.type === 'URL'
      ? { type: 'URL' as const, text: b.text.trim(), url: b.url.trim() }
      : { type: 'QUICK_REPLY' as const, text: b.text.trim() }))
  }
}

/** O corpo como o cliente vai ler: cada `{{n}}` trocado pelo exemplo, quando há. */
export function renderMetaPreview(body: string, examples: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n: string) => examples[Number(n) - 1]?.trim() || m)
}

// ── Formulário ─────────────────────────────────────────────────────────

const FIELD_LABEL: Record<MetaDraftField, TranslationKey> = {
  name: 'whatsapp.metaTemplates.name',
  category: 'whatsapp.metaTemplates.category',
  language: 'whatsapp.metaTemplates.language',
  headerText: 'whatsapp.metaTemplates.header',
  bodyText: 'whatsapp.metaTemplates.body',
  variables: 'whatsapp.metaTemplates.variables',
  examples: 'whatsapp.metaTemplates.variables',
  footerText: 'whatsapp.metaTemplates.footer',
  buttons: 'whatsapp.metaTemplates.buttons'
}

/**
 * Pede um modelo novo à Meta pelo número oficial. Quem envia de fato é o
 * painel de modelos (`onSubmit`), que conhece a conta e o toast; aqui ficam os
 * campos, a prévia e a regra de quando o botão acende. `onSubmit` devolve o
 * texto da recusa (ou `null` quando deu certo) para o formulário mostrá-lo sem
 * se fechar — o motivo da Meta é o que a pessoa precisa para corrigir.
 */
export function MetaTemplateCreateForm({
  onSubmit,
  onCancel
}: {
  onSubmit: (payload: MetaTemplateCreatePayload) => Promise<string | null>
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<MetaTemplateDraft>(emptyMetaDraft)
  const [submitting, setSubmitting] = useState(false)
  const [refusal, setRefusal] = useState('')
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const problems = validateDraft(draft)
  const vars = bodyVariables(draft.bodyText)
  const invalid = new Set(problems)
  const tocado = draft.name !== '' || draft.bodyText !== ''

  const update = (patch: Partial<MetaTemplateDraft>) => {
    setDraft((atual) => ({ ...atual, ...patch }))
    setRefusal('')
  }

  const insertVariable = () => {
    const el = bodyRef.current
    const token = nextVariable(draft.bodyText)
    const inicio = el?.selectionStart ?? draft.bodyText.length
    const fim = el?.selectionEnd ?? inicio
    const body = draft.bodyText.slice(0, inicio) + token + draft.bodyText.slice(fim)
    update({ bodyText: body })
    // O cursor volta para depois da variável no próximo quadro — antes dele o
    // textarea ainda tem o valor antigo.
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(inicio + token.length, inicio + token.length)
    })
  }

  const setExample = (index: number, value: string) => {
    const examples = [...draft.examples]
    while (examples.length <= index) examples.push('')
    examples[index] = value
    update({ examples })
  }

  const setButton = (index: number, patch: Partial<MetaButtonDraft>) => {
    update({ buttons: draft.buttons.map((b, i) => (i === index ? { ...b, ...patch } : b)) })
  }

  const submit = async () => {
    if (problems.length || submitting) return
    setSubmitting(true)
    try {
      const recusa = await onSubmit(toMetaPayload(draft))
      if (recusa) setRefusal(recusa)
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass = (field: MetaDraftField) =>
    `modern-input w-full${tocado && invalid.has(field) ? ' border-[hsl(var(--status-danger))]' : ''}`

  const preview = renderMetaPreview(draft.bodyText.trim(), draft.examples)
  const camposRuins = [...new Set(problems.map((p) => t(FIELD_LABEL[p])))]

  return (
    <div className="rounded-md border border-border p-4">
      <h4 className="text-sm font-semibold text-foreground">{t('whatsapp.metaTemplates.createTitle')}</h4>
      <p className="field-hint">{t('whatsapp.metaTemplates.createHint')}</p>

      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-1">
              <label htmlFor="meta-create-name" className="field-label">{t('whatsapp.metaTemplates.name')}</label>
              <input
                id="meta-create-name"
                className={`${inputClass('name')} font-mono`}
                value={draft.name}
                autoComplete="off"
                onChange={(event) => update({ name: normalizeMetaName(event.target.value) })}
              />
              <p className="field-hint">{t('whatsapp.metaTemplates.nameHint')}</p>
            </div>
            <div>
              <label htmlFor="meta-create-category" className="field-label">{t('whatsapp.metaTemplates.category')}</label>
              <select
                id="meta-create-category"
                className={inputClass('category')}
                value={draft.category}
                onChange={(event) => update({ category: event.target.value as MetaTemplateDraft['category'] })}
              >
                <option value="UTILITY">{t('whatsapp.metaTemplates.categoryUtility')}</option>
                <option value="MARKETING">{t('whatsapp.metaTemplates.categoryMarketing')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="meta-create-language" className="field-label">{t('whatsapp.metaTemplates.language')}</label>
              <input
                id="meta-create-language"
                className={`${inputClass('language')} font-mono`}
                value={draft.language}
                autoComplete="off"
                onChange={(event) => update({ language: event.target.value.trim() })}
              />
            </div>
          </div>
          <p className="field-hint">{t('whatsapp.metaTemplates.categoryHint')}</p>

          <div>
            <label htmlFor="meta-create-header" className="field-label">{t('whatsapp.metaTemplates.header')}</label>
            <input
              id="meta-create-header"
              className={inputClass('headerText')}
              value={draft.headerText}
              maxLength={META_HEADER_LIMIT}
              onChange={(event) => update({ headerText: event.target.value })}
            />
          </div>

          <div>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label htmlFor="meta-create-body" className="field-label">{t('whatsapp.metaTemplates.body')}</label>
              <button type="button" className="modern-button-secondary text-xs" onClick={insertVariable}>
                {t('whatsapp.metaTemplates.insertVariable')} {nextVariable(draft.bodyText)}
              </button>
            </div>
            <textarea
              id="meta-create-body"
              ref={bodyRef}
              className={`${inputClass('bodyText')} min-h-32 font-mono text-[0.82rem] leading-6`}
              value={draft.bodyText}
              maxLength={META_BODY_LIMIT}
              onChange={(event) => update({ bodyText: event.target.value })}
            />
            <p className={`field-hint${tocado && invalid.has('variables') ? ' text-[hsl(var(--status-danger))]' : ''}`}>
              {t('whatsapp.metaTemplates.variablesHint')}
            </p>
          </div>

          {vars.count > 0 && vars.ok && (
            <div className="grid gap-2 sm:grid-cols-2">
              {Array.from({ length: vars.count }, (_, i) => (
                <div key={i}>
                  <label htmlFor={`meta-create-example-${i + 1}`} className="field-label">
                    {t('whatsapp.metaTemplates.example', { n: i + 1 })}
                  </label>
                  <input
                    id={`meta-create-example-${i + 1}`}
                    className={inputClass('examples')}
                    value={draft.examples[i] ?? ''}
                    onChange={(event) => setExample(i, event.target.value)}
                  />
                </div>
              ))}
            </div>
          )}

          <div>
            <label htmlFor="meta-create-footer" className="field-label">{t('whatsapp.metaTemplates.footer')}</label>
            <input
              id="meta-create-footer"
              className={inputClass('footerText')}
              value={draft.footerText}
              maxLength={META_FOOTER_LIMIT}
              onChange={(event) => update({ footerText: event.target.value })}
            />
          </div>

          <div>
            <span className="field-label">{t('whatsapp.metaTemplates.buttons')}</span>
            <div className="flex flex-col gap-2">
              {draft.buttons.map((b, i) => (
                <div key={i} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.4fr)_auto]">
                  <select
                    aria-label={t('whatsapp.metaTemplates.buttonType')}
                    className="modern-input w-full"
                    value={b.type}
                    onChange={(event) => setButton(i, { type: event.target.value as MetaButtonDraft['type'] })}
                  >
                    <option value="URL">{t('whatsapp.metaTemplates.buttonUrl')}</option>
                    <option value="QUICK_REPLY">{t('whatsapp.metaTemplates.buttonQuickReply')}</option>
                  </select>
                  <input
                    aria-label={t('whatsapp.metaTemplates.buttonText')}
                    placeholder={t('whatsapp.metaTemplates.buttonText')}
                    className={inputClass('buttons')}
                    value={b.text}
                    maxLength={META_BUTTON_TEXT_LIMIT}
                    onChange={(event) => setButton(i, { text: event.target.value })}
                  />
                  {b.type === 'URL' ? (
                    <input
                      aria-label={t('whatsapp.metaTemplates.buttonUrlLabel')}
                      placeholder={t('whatsapp.metaTemplates.buttonUrlLabel')}
                      className={`${inputClass('buttons')} font-mono`}
                      value={b.url}
                      inputMode="url"
                      onChange={(event) => setButton(i, { url: event.target.value })}
                    />
                  ) : <span aria-hidden="true" />}
                  <button
                    type="button"
                    className="modern-button-secondary"
                    aria-label={t('whatsapp.metaTemplates.remove')}
                    title={t('whatsapp.metaTemplates.remove')}
                    onClick={() => update({ buttons: draft.buttons.filter((_, j) => j !== i) })}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
            {draft.buttons.length < META_BUTTONS_MAX && (
              <button
                type="button"
                className="modern-button-secondary mt-2 text-xs"
                onClick={() => update({ buttons: [...draft.buttons, { type: 'URL', text: '', url: 'https://' }] })}
              >
                {t('whatsapp.metaTemplates.addButton')}
              </button>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <span className="field-label">{t('whatsapp.metaTemplates.preview')}</span>
          <div className="rounded-md bg-muted/40 p-3">
            <div className="ml-auto max-w-[95%] rounded-(--radius) border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
              {draft.headerText.trim() && <p className="mb-1 font-semibold">{draft.headerText.trim()}</p>}
              <p className="whitespace-pre-wrap wrap-break-word">{preview || '…'}</p>
              {draft.footerText.trim() && (
                <p className="mt-1 text-xs text-muted-foreground">{draft.footerText.trim()}</p>
              )}
            </div>
            {draft.buttons.length > 0 && (
              <div className="ml-auto mt-1 flex max-w-[95%] flex-col gap-1">
                {draft.buttons.map((b, i) => (
                  <span
                    key={i}
                    className="flex items-center justify-center gap-1 rounded-(--radius) border border-border bg-card px-3 py-1.5 text-xs font-semibold text-primary"
                  >
                    {b.type === 'URL' && <Icon name="external" size={12} />}
                    {b.text.trim() || '…'}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {refusal && (
        <p className="mt-3 wrap-break-word rounded-md border border-[hsl(var(--status-danger)/0.3)] bg-[hsl(var(--status-danger)/0.08)] p-3 font-mono text-xs leading-5 text-[hsl(var(--status-danger))]">
          {refusal}
        </p>
      )}
      {tocado && camposRuins.length > 0 && (
        <p className="mt-3 text-xs text-[hsl(var(--status-warning))]">
          {t('whatsapp.metaTemplates.fixFields', { fields: camposRuins.join(', ') })}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="modern-button"
          disabled={problems.length > 0 || submitting}
          onClick={() => void submit()}
        >
          {submitting ? t('whatsapp.metaTemplates.submitting') : t('whatsapp.metaTemplates.submit')}
        </button>
        <button type="button" className="modern-button-secondary" disabled={submitting} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

export default MetaTemplateCreateForm
