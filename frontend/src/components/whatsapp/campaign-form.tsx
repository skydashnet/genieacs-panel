'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  whatsappAPI,
  type WhatsAppCampaignAudienceOptions,
  type WhatsAppCampaignFilters,
  type WhatsAppCampaignOption,
  type WhatsAppCampaignPreview,
  type WhatsAppAccount,
  type WhatsAppBroadcast,
  type WhatsAppTemplate
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { errorText } from './dunning-rule-panel'
import type { TranslationKey } from '@/lib/i18n'
import { bulkPerHour } from '@/lib/wa-pace'
import { ContactLink } from './contact-link'
import { estimatedHours, localInputToIso, parseContracts, toggleValue } from './campaign-audience'

/**
 * "Nova campanha": um aviso para um grupo de clientes.
 *
 * O público sai do cadastro (situação, plano, bairro, cidade ou uma lista de
 * contratos), a mensagem de um modelo ou de um texto livre com as variáveis
 * do cadastro, e o envio é o mesmo das outras campanhas — no ritmo das
 * mensagens automáticas. Nada sai daqui: o formulário cria um rascunho (que
 * alguém ainda precisa iniciar) ou uma campanha agendada.
 *
 * A prévia é obrigatória. Criar só fica disponível depois de ver quantos e
 * quem vão receber, e qualquer mudança no público ou no texto a descarta.
 */

const VARIABLES = ['nome', 'primeiro_nome', 'contrato', 'plano', 'link_indicacao'] as const

export const STATE_LABEL: Record<string, TranslationKey> = {
  active: 'whatsapp.campaign.stateActive',
  blocked: 'whatsapp.campaign.stateBlocked',
  cancelled: 'whatsapp.campaign.stateCancelled',
  unknown: 'whatsapp.campaign.stateUnknown',
  none: 'whatsapp.campaign.stateNone'
}

type Group = 'states' | 'plans' | 'districts' | 'cities'

const GROUPS: [Group, TranslationKey][] = [
  ['states', 'whatsapp.campaign.filterStates'],
  ['plans', 'whatsapp.campaign.filterPlans'],
  ['districts', 'whatsapp.campaign.filterDistricts'],
  ['cities', 'whatsapp.campaign.filterCities']
]

const EMPTY_SELECTION: Record<Group, string[]> = { states: [], plans: [], districts: [], cities: [] }

/** Uma campanha editável: ainda não saiu, é de aviso e, se tinha lista de contratos, a lista foi guardada. */
export function canEditCampaign(broadcast: WhatsAppBroadcast): boolean {
  if (broadcast.kind !== 'general' || !['draft', 'queued'].includes(broadcast.status)) return false
  const audience = broadcast.audience
  return !audience || audience.contracts === 0 || Boolean(audience.contractList)
}

function paceOf(perHour: number | null | undefined): 'default' | 'slow' | 'very_slow' {
  if (perHour === 30) return 'slow'
  if (perHour === 12) return 'very_slow'
  return 'default'
}

/** ISO → valor de um `datetime-local` (hora local do navegador). */
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function CampaignForm({ onClose, onCreated, editing }: {
  onClose: () => void
  onCreated: () => void
  /** Presente: edita esta campanha em vez de criar uma. */
  editing?: WhatsAppBroadcast
}) {
  const { t } = useTranslation()
  const toast = useToast()

  const [options, setOptions] = useState<WhatsAppCampaignAudienceOptions | null>(null)
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([])
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [pace, setPace] = useState<'default' | 'slow' | 'very_slow'>(paceOf(editing?.pacePerHour))
  const [perHour, setPerHour] = useState(0)

  const [title, setTitle] = useState(editing?.title ?? '')
  const [selection, setSelection] = useState<Record<Group, string[]>>(() => ({
    states: editing?.audience?.states ?? [],
    plans: editing?.audience?.plans ?? [],
    districts: editing?.audience?.districts ?? [],
    cities: editing?.audience?.cities ?? []
  }))
  const [contractsText, setContractsText] = useState((editing?.audience?.contractList ?? []).join('\n'))
  const [mode, setMode] = useState<'template' | 'text'>(editing?.templateId ? 'template' : 'text')
  const [templateId, setTemplateId] = useState(editing?.templateId ? String(editing.templateId) : '')
  const [body, setBody] = useState(editing && !editing.templateId ? editing.body : '')
  const [attachment, setAttachment] = useState<{ path: string; name: string } | null>(null)
  // Na edição, o anexo que já está na campanha fica até alguém trocar ou tirar.
  const [keepOldAttachment, setKeepOldAttachment] = useState(Boolean(editing?.attachment))
  const [uploading, setUploading] = useState(false)
  const [when, setWhen] = useState<'draft' | 'schedule'>(editing?.status === 'queued' ? 'schedule' : 'draft')
  const [scheduleLocal, setScheduleLocal] = useState(isoToLocalInput(editing?.scheduledAt))

  const [preview, setPreview] = useState<WhatsAppCampaignPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const editingAccountId = editing?.accountId ?? null

  useEffect(() => {
    let alive = true
    void (async () => {
      const [opts, tpls, config, accs] = await Promise.all([
        whatsappAPI.getCampaignAudienceOptions(),
        whatsappAPI.listTemplates(),
        whatsappAPI.getConfig(),
        whatsappAPI.listAccounts()
      ])
      if (!alive) return
      if (accs.success && accs.data) {
        const connected = accs.data.filter((acc) => acc.status === 'connected')
        setAccounts(connected)
        // Pré-seleciona o número de cobrança (ou o padrão), o que sai hoje.
        const saved = editingAccountId ? connected.find((acc) => acc.id === editingAccountId) : undefined
        const preferred = saved ?? connected.find((acc) => acc.purpose === 'billing') ?? connected.find((acc) => acc.isDefault) ?? connected[0]
        if (preferred) setAccountId(String(preferred.id))
      }
      if (opts.success && opts.data) setOptions(opts.data)
      else toast.error(whatsappErrorMessage(t, opts.code))
      if (tpls.success && tpls.data) {
        setTemplates(tpls.data.filter((tpl) => tpl.active && tpl.category !== 'cobranca' && tpl.category !== 'atendimento'))
      }
      if (config.success && config.data) {
        setPerHour(bulkPerHour({
          bulkIntervalMinSec: config.data.bulkIntervalMinSec ?? 20,
          bulkIntervalMaxSec: config.data.bulkIntervalMaxSec ?? 45,
          bulkBurstSize: config.data.bulkBurstSize ?? 30,
          bulkBurstPauseMin: config.data.bulkBurstPauseMin ?? 5
        }))
      }
    })()
    return () => { alive = false }
  }, [t, toast, editingAccountId])

  const filters: WhatsAppCampaignFilters = useMemo(() => ({
    ...selection,
    contracts: parseContracts(contractsText)
  }), [selection, contractsText])

  const message = mode === 'template'
    ? (templateId ? { templateId: Number(templateId) } : null)
    : (body.trim() ? { body } : null)

  // Qualquer mudança no público ou no texto torna a prévia velha.
  useEffect(() => { setPreview(null) }, [filters, mode, templateId, body])

  const optionLabel = (group: Group, option: WhatsAppCampaignOption) => (
    group === 'states' && STATE_LABEL[option.value] ? t(STATE_LABEL[option.value]) : option.value
  )

  const insertVariable = (name: string) => {
    const tag = `{{${name}}}`
    const el = bodyRef.current
    if (!el) {
      setBody((current) => current + tag)
      return
    }
    const start = el.selectionStart ?? body.length
    const end = el.selectionEnd ?? body.length
    const next = body.slice(0, start) + tag + body.slice(end)
    setBody(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + tag.length, start + tag.length)
    })
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    try {
      const res = await whatsappAPI.uploadAttachment(file)
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      setAttachment({ path: res.data.path, name: res.data.name || file.name })
    } finally {
      setUploading(false)
    }
  }

  const runPreview = async () => {
    if (!message) {
      toast.error(t('whatsapp.campaign.messageRequired'))
      return
    }
    setPreviewing(true)
    try {
      const res = await whatsappAPI.previewCampaign({ filters, ...message })
      if (!res.success || !res.data) {
        toast.error(errorText(res, t, 'whatsapp.campaign.createFailed'))
        return
      }
      setPreview(res.data)
    } finally {
      setPreviewing(false)
    }
  }

  const paceCap = pace === 'slow' ? 30 : pace === 'very_slow' ? 12 : 0
  const effectivePerHour = paceCap > 0 && perHour > 0 ? Math.min(perHour, paceCap) : perHour
  const scheduledIso = when === 'schedule' ? localInputToIso(scheduleLocal) : null
  const canCreate = Boolean(preview && preview.counts.reachable > 0 && message && title.trim()
    && (when === 'draft' || scheduledIso))

  const create = async () => {
    if (!canCreate || !message) return
    setSaving(true)
    try {
      const input = {
        title: title.trim(),
        filters,
        ...message,
        scheduledAt: scheduledIso,
        accountId: accountId ? Number(accountId) : null,
        pace
      }
      const res = editing
        ? await whatsappAPI.updateCampaign(editing.id, {
          ...input,
          // Ausente mantém o anexo da campanha; nulo tira; um objeto troca.
          ...(attachment ? { attachment } : keepOldAttachment ? {} : { attachment: null })
        })
        : await whatsappAPI.createCampaign({ ...input, attachment })
      if (!res.success || !res.data) {
        toast.error(errorText(res, t, 'whatsapp.campaign.createFailed'))
        return
      }
      toast.success(t(editing ? 'whatsapp.campaign.updatedToast' : when === 'schedule' ? 'whatsapp.campaign.scheduled' : 'whatsapp.campaign.createdDraft', {
        count: res.data.recipients
      }))
      onCreated()
    } finally {
      setSaving(false)
    }
  }

  const templateBody = templates.find((tpl) => String(tpl.id) === templateId)?.body ?? ''

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="campaign-form-title">
      <div className="modal-panel modern-card max-h-[92vh] w-full max-w-3xl overflow-y-auto p-5 sm:p-6" data-testid="campaign-form">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 id="campaign-form-title" className="section-heading mb-1">{t(editing ? 'whatsapp.campaign.edit' : 'whatsapp.campaign.new')}</h2>
            <p className="section-description">{t(editing ? 'whatsapp.campaign.editHint' : 'whatsapp.campaign.newHint')}</p>
          </div>
          <button type="button" className="modern-button-secondary" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="space-y-6">
          <div>
            <label htmlFor="campaign-title" className="field-label">{t('whatsapp.campaign.titleLabel')}</label>
            <input
              id="campaign-title"
              className="modern-input w-full"
              maxLength={200}
              value={title}
              placeholder={t('whatsapp.campaign.titlePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <fieldset className="space-y-4">
            <legend className="field-label">{t('whatsapp.campaign.audience')}</legend>
            <p className="field-hint">{t('whatsapp.campaign.audienceHint')}</p>
            {GROUPS.map(([group, labelKey]) => {
              const list = options?.[group] ?? []
              if (list.length === 0) return null
              return (
                <div key={group}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(labelKey)}</p>
                  <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto">
                    {list.map((option) => {
                      const on = selection[group].includes(option.value)
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={on}
                          className={on ? 'modern-badge-info' : 'modern-badge'}
                          onClick={() => setSelection((current) => ({
                            ...current,
                            [group]: toggleValue(current[group], option.value)
                          }))}
                        >
                          {optionLabel(group, option)} · {option.count}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            <div>
              <label htmlFor="campaign-contracts" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('whatsapp.campaign.filterContracts')}
              </label>
              <textarea
                id="campaign-contracts"
                className="modern-input min-h-20 w-full font-mono text-xs"
                value={contractsText}
                placeholder={t('whatsapp.campaign.contractsPlaceholder')}
                onChange={(event) => setContractsText(event.target.value)}
              />
              {filters.contracts.length > 0 && (
                <p className="field-hint">{t('whatsapp.campaign.contractsCount', { count: filters.contracts.length })}</p>
              )}
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="field-label mb-3">{t('whatsapp.campaign.message')}</legend>
            <div className="tab-rail" role="tablist">
              {(['text', 'template'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  className="tab-button"
                  data-active={mode === id}
                  aria-selected={mode === id}
                  onClick={() => setMode(id)}
                >
                  {t(id === 'text' ? 'whatsapp.campaign.freeText' : 'whatsapp.campaign.useTemplate')}
                </button>
              ))}
            </div>
            {mode === 'template' ? (
              <div className="space-y-2">
                <select
                  className="modern-input w-full"
                  aria-label={t('whatsapp.campaign.useTemplate')}
                  value={templateId}
                  onChange={(event) => setTemplateId(event.target.value)}
                >
                  <option value="">{t('whatsapp.campaign.pickTemplate')}</option>
                  {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
                </select>
                {templateBody && (
                  <pre className="whitespace-pre-wrap wrap-break-word rounded-md border border-border surface-subtle p-3 text-xs text-muted-foreground">{templateBody}</pre>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  ref={bodyRef}
                  className="modern-input min-h-28 w-full"
                  aria-label={t('whatsapp.campaign.message')}
                  value={body}
                  placeholder={t('whatsapp.campaign.bodyPlaceholder')}
                  onChange={(event) => setBody(event.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  {VARIABLES.map((name) => (
                    <button key={name} type="button" className="modern-button-secondary text-xs" onClick={() => insertVariable(name)}>
                      {`{{${name}}}`}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="field-hint">{t('whatsapp.campaign.variablesHint')}</p>
          </fieldset>

          <div>
            <p className="field-label">{t('whatsapp.campaign.attachment')}</p>
            {attachment || (keepOldAttachment && editing?.attachment) ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Icon name="document" size={16} />
                <span className="break-all">{attachment ? attachment.name : editing?.attachment?.name}</span>
                <button type="button" className="modern-button-secondary text-xs" onClick={() => { setAttachment(null); setKeepOldAttachment(false) }}>
                  {t('whatsapp.campaign.removeAttachment')}
                </button>
              </div>
            ) : (
              <label className="modern-button-secondary cursor-pointer">
                <Icon name="paperclip" size={16} />
                {uploading ? t('common.loading') : t('whatsapp.campaign.addAttachment')}
                <input
                  type="file"
                  className="sr-only"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  disabled={uploading}
                  onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = '' }}
                />
              </label>
            )}
            <p className="field-hint">{t('whatsapp.campaign.attachmentHint')}</p>
          </div>

          {accounts.length > 0 && (
            <div className="space-y-2">
              <label className="field-label" htmlFor="campaign-account">{t('whatsapp.campaign.sendFrom')}</label>
              <select
                id="campaign-account"
                className="modern-input w-full"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.label || acc.name}{acc.phoneE164 ? ` · +${acc.phoneE164}` : ''}
                  </option>
                ))}
              </select>
              <p className="field-hint">{t('whatsapp.campaign.sendFromHint')}</p>
            </div>
          )}

          <div className="space-y-2">
            <label className="field-label" htmlFor="campaign-pace">{t('whatsapp.campaign.pace')}</label>
            <select
              id="campaign-pace"
              className="modern-input w-full"
              value={pace}
              onChange={(event) => setPace(event.target.value as typeof pace)}
            >
              <option value="default">{t('whatsapp.campaign.paceDefault')}</option>
              <option value="slow">{t('whatsapp.campaign.paceSlow')}</option>
              <option value="very_slow">{t('whatsapp.campaign.paceVerySlow')}</option>
            </select>
            <p className="field-hint">{t('whatsapp.campaign.paceHint')}</p>
          </div>

          <fieldset className="space-y-2">
            <legend className="field-label mb-2">{t('whatsapp.campaign.when')}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="campaign-when" checked={when === 'draft'} onChange={() => setWhen('draft')} />
              {t('whatsapp.campaign.whenDraft')}
            </label>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <input type="radio" name="campaign-when" checked={when === 'schedule'} onChange={() => setWhen('schedule')} />
              {t('whatsapp.campaign.whenSchedule')}
              <input
                type="datetime-local"
                className="modern-input"
                aria-label={t('whatsapp.campaign.whenSchedule')}
                value={scheduleLocal}
                disabled={when !== 'schedule'}
                onChange={(event) => setScheduleLocal(event.target.value)}
              />
            </label>
          </fieldset>

          <div className="space-y-3 rounded-md border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold">{t('whatsapp.campaign.previewTitle')}</p>
              <button type="button" className="modern-button-secondary" disabled={previewing} onClick={() => void runPreview()}>
                <Icon name="eye" size={16} />
                {previewing ? t('common.loading') : t('whatsapp.campaign.preview')}
              </button>
            </div>
            {preview ? (
              <>
                <p className="text-sm" data-testid="campaign-preview-summary">
                  {t('whatsapp.campaign.previewSummary', {
                    reachable: preview.counts.reachable,
                    noPhone: preview.counts.noPhone,
                    optOut: preview.counts.optOut,
                    duplicate: preview.counts.duplicate,
                    incomplete: preview.counts.templateIncomplete
                  })}
                </p>
                {preview.counts.reachable > 0 && effectivePerHour > 0 && (
                  <p className="field-hint">
                    {t('whatsapp.campaign.previewDuration', {
                      hours: estimatedHours(preview.counts.reachable, effectivePerHour),
                      perHour: effectivePerHour
                    })}
                  </p>
                )}
                {preview.counts.reachable > preview.max && (
                  <p className="text-sm text-destructive">{t('whatsapp.campaign.overMax', { max: preview.max })}</p>
                )}
                {preview.sample.length > 0 && (
                  <div className="max-h-64 overflow-auto">
                    <table className="modern-table w-full text-sm">
                      <thead>
                        <tr>
                          <th scope="col">{t('whatsapp.inbox.contract')}</th>
                          <th scope="col">{t('whatsapp.campaign.recipient')}</th>
                          <th scope="col">{t('whatsapp.campaign.message')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.sample.map((row, index) => (
                          <tr key={`${row.contract ?? 'sem'}-${index}`}>
                            <td className="font-mono text-xs">{row.contract}</td>
                            <td><ContactLink contract={row.contract} name={row.clientName} /></td>
                            <td className="whitespace-pre-wrap text-xs text-muted-foreground">{row.body}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : (
              <p className="field-hint">{t('whatsapp.campaign.previewRequired')}</p>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" disabled={!canCreate || saving} onClick={() => void create()}>
            <Icon name={when === 'schedule' ? 'bell' : 'check'} size={16} />
            {t(editing ? 'whatsapp.campaign.saveChanges' : when === 'schedule' ? 'whatsapp.campaign.createScheduled' : 'whatsapp.campaign.createDraft')}
          </button>
        </div>
      </div>
    </div>
  )
}
