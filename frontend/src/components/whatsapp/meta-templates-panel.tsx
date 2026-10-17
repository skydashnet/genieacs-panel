'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  whatsappAPI,
  type MetaNoticeBindings,
  type MetaTemplateCreatePayload,
  type MetaNoticeKey,
  type WhatsAppAccount,
  type WhatsAppMetaTemplate
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { MetaTemplateCreateForm } from '@/components/whatsapp/meta-template-create'

const NOTICE_KEYS: MetaNoticeKey[] = ['maintenance', 'outage', 'alert']

/** Se o modelo pede mais que o corpo: mídia no cabeçalho, variável no cabeçalho ou sufixo de botão. */
export const needsExtras = (m: WhatsAppMetaTemplate) =>
  ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(m.headerFormat)
  || (m.headerFormat === 'TEXT' && m.headerParamCount > 0)
  || m.buttons.some((b) => b.urlHasParam)

/** A chave de um modelo no `<select>`: nome e idioma, que juntos o identificam. */
export const metaKey = (m: { name: string; language: string }) => `${m.name}|${m.language}`

/**
 * Os modelos aprovados da Meta dos números oficiais.
 *
 * Aqui o painel sincroniza a lista, pede modelos novos à Meta (que nascem em
 * análise: quem aprova é ela) e liga os avisos automáticos (manutenção, queda,
 * alerta) a um modelo, para o número oficial conseguir mandá-los fora da
 * janela de 24 h. Some sozinho quando o provedor não tem número oficial.
 */
export function MetaTemplatesPanel({ onSynced }: { onSynced?: () => void }) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([])
  const [accountId, setAccountId] = useState<number | null>(null)
  const [templates, setTemplates] = useState<WhatsAppMetaTemplate[]>([])
  const [syncing, setSyncing] = useState(false)
  const [bindings, setBindings] = useState<Record<MetaNoticeKey, string>>({ maintenance: '', outage: '', alert: '' })
  const [savingBindings, setSavingBindings] = useState(false)
  const [creating, setCreating] = useState(false)

  const loadAccounts = useCallback(async () => {
    const res = await whatsappAPI.listAccounts()
    if (!res.success || !res.data) return
    const cloud = res.data.filter((a) => a.integration === 'cloud')
    setAccounts(cloud)
    setAccountId((atual) => atual ?? cloud[0]?.id ?? null)
  }, [])

  const loadTemplates = useCallback(async (id: number) => {
    const res = await whatsappAPI.listMetaTemplates({ accountId: id })
    if (res.success && res.data) setTemplates(res.data)
  }, [])

  const loadBindings = useCallback(async () => {
    const res = await whatsappAPI.getMetaNoticeBindings()
    if (!res.success || !res.data) return
    const data: MetaNoticeBindings = res.data
    setBindings({
      maintenance: data.maintenance ? metaKey(data.maintenance) : '',
      outage: data.outage ? metaKey(data.outage) : '',
      alert: data.alert ? metaKey(data.alert) : ''
    })
  }, [])

  useEffect(() => {
    void loadAccounts()
    void loadBindings()
  }, [loadAccounts, loadBindings])

  useEffect(() => {
    if (accountId) void loadTemplates(accountId)
  }, [accountId, loadTemplates])

  const account = accounts.find((a) => a.id === accountId) ?? null
  // Um aviso é texto livre: só serve modelo com no máximo um parâmetro, que
  // recebe o aviso inteiro — e sem cabeçalho de mídia/variável nem botão
  // dinâmico, que o aviso não teria de onde preencher.
  const forNotices = useMemo(() => templates.filter((m) => m.usable && m.paramCount <= 1 && !needsExtras(m)), [templates])

  const sync = async () => {
    if (!accountId) return
    setSyncing(true)
    try {
      const res = await whatsappAPI.syncMetaTemplates(accountId)
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
      } else {
        toast.success(t('whatsapp.metaTemplates.synced', { count: res.data?.length ?? 0 }))
        if (res.data) setTemplates(res.data)
        onSynced?.()
      }
      await loadAccounts()
    } finally {
      setSyncing(false)
    }
  }

  /**
   * Devolve o texto da recusa para o formulário mostrar sem fechar. A recusa da
   * Meta (`http_error`) traz o motivo dela — nome repetido, texto proibido —, e
   * é com ele que a pessoa corrige; as outras viram a frase traduzida.
   */
  const createTemplate = async (payload: MetaTemplateCreatePayload): Promise<string | null> => {
    if (!accountId) return null
    const res = await whatsappAPI.createMetaTemplate(accountId, payload)
    if (!res.success) {
      const texto = whatsappErrorMessage(t, res.code)
      toast.error(texto)
      return res.code === 'http_error' && res.message ? res.message : texto
    }
    toast.success(t('whatsapp.metaTemplates.createSent'))
    setCreating(false)
    await loadTemplates(accountId)
    await loadAccounts()
    onSynced?.()
    return null
  }

  const saveBindings = async () => {
    setSavingBindings(true)
    try {
      const payload: Partial<Record<MetaNoticeKey, { name: string; language: string } | null>> = {}
      for (const key of NOTICE_KEYS) {
        const [name, language] = bindings[key] ? bindings[key].split('|') : []
        payload[key] = name ? { name, language } : null
      }
      const res = await whatsappAPI.saveMetaNoticeBindings(payload)
      if (res.success) toast.success(t('common.success'))
      else toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setSavingBindings(false)
    }
  }

  if (accounts.length === 0) return null

  return (
    <section className="modern-card flex flex-col gap-4 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="section-heading">{t('whatsapp.metaTemplates.title')}</h3>
          <p className="section-description">{t('whatsapp.metaTemplates.description')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {accounts.length > 1 && (
            <select
              aria-label={t('whatsapp.metaTemplates.account')}
              className="modern-input"
              value={accountId ?? ''}
              onChange={(event) => setAccountId(Number(event.target.value))}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.label || a.metaPhoneNumberId || a.name}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="modern-button-secondary"
            disabled={creating || !accountId}
            onClick={() => setCreating(true)}
          >
            <Icon name="edit" size={16} />
            {t('whatsapp.metaTemplates.create')}
          </button>
          <button type="button" className="modern-button" disabled={syncing || !accountId} onClick={() => void sync()}>
            <Icon name="refresh" size={16} className={syncing ? 'animate-spin' : ''} />
            {syncing ? t('whatsapp.metaTemplates.syncing') : t('whatsapp.metaTemplates.sync')}
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {account?.metaTemplatesSyncedAt
          ? t('whatsapp.metaTemplates.lastSync', { when: formatDateTime(account.metaTemplatesSyncedAt) })
          : t('whatsapp.metaTemplates.neverSynced')}
        {' · '}
        {t('whatsapp.metaTemplates.costHint')}
      </p>
      <a
        href="https://business.facebook.com/wa/manage/message-templates/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1 text-xs font-semibold text-primary hover:underline"
      >
        <Icon name="external" size={12} />
        {t('whatsapp.cloud.linkTemplates')}
      </a>
      {account?.metaTemplatesError && (
        <p className="break-all font-mono text-xs text-[hsl(var(--status-danger))]">{account.metaTemplatesError}</p>
      )}

      {creating && accountId && (
        <MetaTemplateCreateForm
          key={accountId}
          onSubmit={createTemplate}
          onCancel={() => setCreating(false)}
        />
      )}

      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('whatsapp.metaTemplates.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2" role="list">
          {templates.map((m) => (
            <li key={m.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-foreground">{m.name}</span>
                <span className="modern-badge">{m.language}</span>
                {m.category && <span className="modern-badge">{m.category}</span>}
                <span className={m.usable ? 'modern-badge-success' : 'modern-badge-warning'}>
                  {m.usable
                    ? t('whatsapp.metaTemplates.usable')
                    : m.status !== 'APPROVED'
                      ? t('whatsapp.metaTemplates.notApproved', { status: m.status || '—' })
                      : t('whatsapp.metaTemplates.unsupported')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('whatsapp.metaTemplates.params', { count: m.paramCount })}
                </span>
                {m.headerFormat !== 'NONE' && (
                  <span className="modern-badge-info">
                    {t('whatsapp.metaTemplates.headerBadge', { format: t(`whatsapp.metaTemplates.headerFormat.${m.headerFormat}`) })}
                  </span>
                )}
                {m.buttons.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t('whatsapp.metaTemplates.buttonsBadge', {
                      list: m.buttons
                        .map((b) => (b.urlHasParam ? t('whatsapp.metaTemplates.buttonDynamic') : b.type))
                        .join(', ')
                    })}
                  </span>
                )}
              </div>
              {m.bodyText && (
                <p className="mt-2 whitespace-pre-wrap wrap-break-word font-mono text-[0.78rem] leading-6 text-muted-foreground">
                  {m.bodyText}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border pt-4">
        <h4 className="text-sm font-semibold text-foreground">{t('whatsapp.metaTemplates.noticesTitle')}</h4>
        <p className="field-hint">{t('whatsapp.metaTemplates.noticesHint')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {NOTICE_KEYS.map((key) => (
            <div key={key}>
              <label htmlFor={`meta-notice-${key}`} className="field-label">
                {t(`whatsapp.metaTemplates.notice.${key}`)}
              </label>
              <select
                id={`meta-notice-${key}`}
                className="modern-input w-full"
                value={bindings[key]}
                onChange={(event) => setBindings((c) => ({ ...c, [key]: event.target.value }))}
              >
                <option value="">{t('whatsapp.metaTemplates.noneOption')}</option>
                {/* Uma ligação salva que não está mais na lista continua visível. */}
                {bindings[key] && !forNotices.some((m) => metaKey(m) === bindings[key]) && (
                  <option value={bindings[key]}>{bindings[key].replace('|', ' · ')}</option>
                )}
                {forNotices.map((m) => (
                  <option key={m.id} value={metaKey(m)}>{`${m.name} · ${m.language}`}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="modern-button-secondary mt-3"
          disabled={savingBindings}
          onClick={() => void saveBindings()}
        >
          {savingBindings ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </section>
  )
}

export default MetaTemplatesPanel
