'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { platformAPI, type AsaasIntegration, type AsaasIntegrationUpdate } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { copyToClipboard, formatRelativeTime } from '@/lib/utils'
import { absoluteWebhookUrl } from '@/lib/webhook-url'
import { parsePercent } from '@/lib/subscription-console'
import {
  CHARGE_TERMS_LIMITS, chargeTermsFormOf, chargeTermsPayload, type ChargeTermsField, type ChargeTermsForm
} from '@/lib/charge-terms'

/**
 * As integrações da PLATAFORMA — os serviços de terceiro com que o SaaS cobra
 * e atende os provedores, e não os de um provedor com os clientes dele (esses
 * moram na Configuração de cada ISP).
 *
 * Um cartão por integração. Hoje só a Asaas; a próxima entra como outro
 * cartão ao lado, sem mexer neste.
 *
 * Ao contrário da Saúde do deploy, esta tela ESCREVE: a chave e o token da
 * Asaas deixaram de morar só em variável de ambiente. A variável continua
 * valendo enquanto o painel não grava nada por cima — é o `*Source` que diz
 * qual das duas está valendo, e a tela mostra, porque "configurado" sem dizer
 * de onde esconde justamente o caso que confunde: apagar aqui e continuar
 * configurado, porque a variável de ambiente ainda está lá.
 */
export function PlatformIntegrations() {
  return (
    <div className="grid grid-cols-1 gap-6">
      <AsaasCard />
    </div>
  )
}

/** Os eventos que o webhook de cobrança precisa receber. Nomes da Asaas, não se traduzem. */
const EVENTOS_ASAAS = [
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
  'PAYMENT_DELETED',
  'PAYMENT_REFUNDED',
  // A recusa do cartão salvo (0100): sem ele, a fatura de cartão recusada não
  // volta sozinha para Pix/boleto.
  'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED'
]

/** Os eventos da nota fiscal, para quem ligou a NFS-e. Nomes da Asaas. */
const EVENTOS_NFSE = [
  'INVOICE_AUTHORIZED',
  'INVOICE_ERROR',
  'INVOICE_CANCELED',
  'INVOICE_CANCELLATION_DENIED',
  'INVOICE_UPDATED'
]

/** De onde veio o valor que vale — o painel ou a variável de ambiente. */
function origem(source: AsaasIntegration['apiKeySource']): TranslationKey | null {
  if (source === 'db') return 'integrations.sourceDb'
  if (source === 'env') return 'integrations.sourceEnv'
  return null
}

function Selo({ ligado, sim, nao, source }: {
  ligado: boolean
  sim: TranslationKey
  nao: TranslationKey
  source: AsaasIntegration['apiKeySource']
}) {
  const { t } = useTranslation()
  const chave = ligado ? origem(source) : null
  return (
    <span className={ligado ? 'modern-badge-success' : 'modern-badge-warning'}>
      {t(ligado ? sim : nao)}
      {chave && <span className="ms-1 font-normal opacity-80">· {t(chave)}</span>}
    </span>
  )
}

/**
 * Um "balão" dentro do cartão da integração: uma parte com ícone e título
 * próprios. Antes as partes eram separadas só por uma linha fina, e a tela
 * longa da Asaas virava uma coluna só de campos.
 */
function Balao({ icon, title, children }: { icon: string; title: TranslationKey; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-border bg-[hsl(var(--surface-subtle))] p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon name={icon} size={18} />
        </span>
        <h3 className="text-base font-semibold text-foreground">{t(title)}</h3>
      </div>
      {children}
    </div>
  )
}

function AsaasCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const [info, setInfo] = useState<AsaasIntegration | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [environment, setEnvironment] = useState<AsaasIntegration['environment']>('sandbox')
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [generating, setGenerating] = useState(false)
  /**
   * O token recém-gerado. Vive só no estado desta tela: o backend não o
   * devolve de novo, e é por isso que ele fica à mostra até a pessoa sair —
   * perder o token aqui é ter de gerar outro e colar outra vez na Asaas.
   */
  const [newToken, setNewToken] = useState<string | null>(null)

  const aplicar = useCallback((dados: AsaasIntegration) => {
    setInfo(dados)
    setEnvironment(dados.environment)
    setApiKey('')
    setClearApiKey(false)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const res = await platformAPI.asaasIntegration()
    if (res.success && res.data) {
      aplicar(res.data)
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [aplicar])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !info) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  if (error !== null && !info) {
    return <p className="text-sm text-destructive">{error || t('integrations.loadFailed')}</p>
  }
  if (!info) return null

  /* Manda só o que mudou: a rota distingue campo ausente (não mexe) de campo
     vazio (apaga), e mandar tudo a cada salvamento jogaria a diferença fora. */
  const corpo: AsaasIntegrationUpdate = {}
  if (environment !== info.environment) corpo.environment = environment
  if (clearApiKey) corpo.apiKey = ''
  else if (apiKey.trim()) corpo.apiKey = apiKey.trim()
  const mudou = Object.keys(corpo).length > 0

  const salvar = async () => {
    if (!mudou || saving) return
    setSaving(true)
    try {
      const res = await platformAPI.saveAsaasIntegration(corpo)
      if (res.success && res.data) {
        aplicar(res.data)
        toast.success(t('integrations.saved'))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const testar = async () => {
    setTesting(true)
    try {
      const res = await platformAPI.testAsaasIntegration()
      if (res.success && res.data?.ok) {
        toast.success(res.data.accountName
          ? t('integrations.asaas.testOk', { account: res.data.accountName })
          : t('integrations.asaas.testOkNoName'))
      } else {
        // `ok: false` e o 400 de `not_configured` trazem o motivo em `message`.
        toast.error(res.message || t('integrations.asaas.testFailed'))
      }
    } finally {
      setTesting(false)
    }
  }

  const gerarToken = async () => {
    // Trocar o token derruba as entregas até o novo chegar à Asaas; só pede
    // confirmação quando HÁ um token a derrubar.
    if (info.webhookTokenConfigured && !window.confirm(t('integrations.asaas.generateConfirm'))) return
    setGenerating(true)
    try {
      const res = await platformAPI.generateAsaasWebhookToken()
      if (res.success && res.data) {
        setNewToken(res.data.webhookToken)
        toast.success(t('integrations.asaas.tokenGenerated'))
        // Recarrega para o selo passar a "configurado · pelo painel".
        const atual = await platformAPI.asaasIntegration()
        if (atual.success && atual.data) setInfo(atual.data)
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setGenerating(false)
    }
  }

  const copiar = async (texto: string) => {
    if (await copyToClipboard(texto)) toast.success(t('common.copied'))
  }

  return (
    <section className="modern-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-heading">{t('integrations.asaas.title')}</h2>
          <p className="field-hint mt-1">{t('integrations.asaas.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Selo
            ligado={info.apiKeyConfigured}
            sim="integrations.asaas.apiKeyConfigured"
            nao="integrations.asaas.apiKeyMissing"
            source={info.apiKeySource}
          />
          <Selo
            ligado={info.webhookTokenConfigured}
            sim="integrations.asaas.webhookTokenConfigured"
            nao="integrations.asaas.webhookTokenMissing"
            source={info.webhookTokenSource}
          />
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <Balao icon="lock" title="integrations.asaas.connectionTitle">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="asaas-environment" className="field-label">{t('integrations.asaas.environment')}</label>
              <select
                id="asaas-environment"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as AsaasIntegration['environment'])}
                className="modern-input w-full"
              >
                <option value="sandbox">{t('integrations.asaas.sandbox')}</option>
                <option value="production">{t('integrations.asaas.production')}</option>
              </select>
              <p className="field-hint">{t('integrations.asaas.environmentHint')}</p>
            </div>
            <div>
              <label htmlFor="asaas-api-key" className="field-label">{t('integrations.asaas.apiKey')}</label>
              <input
                id="asaas-api-key"
                type="password"
                autoComplete="new-password"
                value={apiKey}
                disabled={clearApiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="modern-input w-full font-mono"
                placeholder={t(info.apiKeyConfigured
                  ? 'integrations.asaas.placeholderStored'
                  : 'integrations.asaas.placeholderEmpty')}
              />
              {/* Apagar só existe para o que o painel gravou: a variável de
                  ambiente não se apaga por aqui, e a caixa prometeria isso. */}
              {info.apiKeySource === 'db' && (
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={clearApiKey} onChange={(e) => setClearApiKey(e.target.checked)} />
                  {t('integrations.asaas.clearApiKey')}
                </label>
              )}
              <p className="field-hint">
                {t(info.apiKeySource === 'env' ? 'integrations.asaas.envOverrideHint' : 'integrations.asaas.apiKeyHint')}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" className="modern-button" disabled={!mudou || saving} onClick={() => void salvar()}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
            {/* Testa o que está GRAVADO, não o que está digitado: é a chave que as
                cobranças vão usar. Por isso fica desligado com alteração pendente. */}
            <button
              type="button"
              className="modern-button-secondary"
              disabled={testing || mudou || !info.apiKeyConfigured}
              onClick={() => void testar()}
            >
              <Icon name="refresh" size={17} className={testing ? 'animate-spin' : ''} />
              {testing ? t('integrations.asaas.testing') : t('integrations.asaas.test')}
            </button>
            {info.updatedAt && (
              <span className="text-xs text-muted-foreground">
                {t('integrations.updatedAt', { when: formatRelativeTime(info.updatedAt) })}
              </span>
            )}
          </div>
        </Balao>

        <Balao icon="globe" title="integrations.asaas.webhookTitle">
          <div className="space-y-4">
            <div>
              <label htmlFor="asaas-webhook-url" className="field-label">{t('integrations.asaas.webhookUrl')}</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="asaas-webhook-url"
                  type="text"
                  readOnly
                  className="modern-input w-full font-mono text-xs"
                  value={absoluteWebhookUrl(info.webhookUrl, window.location.origin)}
                />
                <button type="button" className="modern-button-secondary shrink-0" onClick={() => void copiar(absoluteWebhookUrl(info.webhookUrl, window.location.origin))}>
                  <Icon name="copy" size={16} /> {t('common.copy')}
                </button>
              </div>
              <p className="field-hint">{t('integrations.asaas.webhookUrlHint')}</p>
            </div>

            <div>
              <p className="field-label">{t('integrations.asaas.webhookToken')}</p>
              {!info.webhookTokenConfigured && (
                <p className="field-hint">{t('integrations.asaas.webhookTokenMissingHint')}</p>
              )}
              <button
                type="button"
                className="modern-button-secondary mt-2"
                disabled={generating}
                onClick={() => void gerarToken()}
              >
                {generating ? t('common.saving') : t('integrations.asaas.generateToken')}
              </button>
              {newToken && (
                <div className="mt-3 rounded-md border border-border p-3">
                  <label htmlFor="asaas-new-token" className="field-label">{t('integrations.asaas.newTokenLabel')}</label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      id="asaas-new-token"
                      type="text"
                      readOnly
                      className="modern-input w-full font-mono text-xs"
                      value={newToken}
                      onFocus={(e) => e.target.select()}
                    />
                    <button type="button" className="modern-button-secondary shrink-0" onClick={() => void copiar(newToken)}>
                      <Icon name="copy" size={16} /> {t('common.copy')}
                    </button>
                  </div>
                  <p className="field-hint">{t('integrations.asaas.newTokenHint')}</p>
                </div>
              )}
            </div>
          </div>
        </Balao>

        <Balao icon="invoice" title="nfse.title">
          <NfseSection info={info} onSaved={setInfo} />
        </Balao>

        <Balao icon="invoice" title="chargeTerms.title">
          <ChargeTermsSection info={info} onSaved={setInfo} />
        </Balao>

        <Balao icon="document" title="integrations.asaas.stepsTitle">
          <ol className="list-decimal space-y-1.5 ps-5 text-sm text-muted-foreground">
            <li>{t('integrations.asaas.step1')}</li>
            <li>{t('integrations.asaas.step2')}</li>
            <li>{t('integrations.asaas.step3')}</li>
            <li>
              {t('integrations.asaas.step4')}{' '}
              <span className="wrap-break-word font-mono text-xs text-foreground">{EVENTOS_ASAAS.join(', ')}</span>
            </li>
            <li>{t('integrations.asaas.step5')}</li>
          </ol>
          {info.nfseEnabled && (
            <p className="mt-2 text-sm text-muted-foreground">
              {t('nfse.webhookEvents')}{' '}
              <span className="wrap-break-word font-mono text-xs text-foreground">{EVENTOS_NFSE.join(', ')}</span>
            </p>
          )}
        </Balao>
      </div>
    </section>
  )
}

/** O formulário da NFS-e, como texto: o que está na tela antes de salvar. */
interface NfseForm {
  nfseEnabled: boolean
  serviceDescription: string
  municipalServiceId: string
  municipalServiceCode: string
  municipalServiceName: string
  issPercent: string
  retainIss: boolean
  observations: string
}

function nfseFormOf(info: AsaasIntegration): NfseForm {
  return {
    nfseEnabled: Boolean(info.nfseEnabled),
    serviceDescription: info.serviceDescription ?? '',
    municipalServiceId: info.municipalServiceId ?? '',
    municipalServiceCode: info.municipalServiceCode ?? '',
    municipalServiceName: info.municipalServiceName ?? '',
    issPercent: String(info.issPercent ?? 0),
    retainIss: Boolean(info.retainIss),
    observations: info.observations ?? ''
  }
}

/**
 * A NFS-e pela Asaas: ligada, todo pagamento confirmado de uma cobrança com
 * pagamento no gateway põe a nota na fila do agendador. Salva à parte da
 * chave — e o backend recusa ligar sem a descrição e o serviço municipal.
 */
function NfseSection({ info, onSaved }: { info: AsaasIntegration; onSaved: (dados: AsaasIntegration) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [form, setForm] = useState<NfseForm>(() => nfseFormOf(info))
  const [saving, setSaving] = useState(false)

  const original = nfseFormOf(info)
  const mudou = JSON.stringify(form) !== JSON.stringify(original)
  const iss = parsePercent(form.issPercent)
  const issValido = iss !== null && iss <= 100
  const faltaObrigatorio = form.nfseEnabled
    && (!form.serviceDescription.trim() || (!form.municipalServiceId.trim() && !form.municipalServiceCode.trim()))

  const campo = <K extends keyof NfseForm>(nome: K, valor: NfseForm[K]) => setForm((atual) => ({ ...atual, [nome]: valor }))

  const salvar = async () => {
    if (!mudou || saving || !issValido || faltaObrigatorio) return
    setSaving(true)
    try {
      const res = await platformAPI.saveAsaasIntegration({
        nfseEnabled: form.nfseEnabled,
        serviceDescription: form.serviceDescription.trim(),
        municipalServiceId: form.municipalServiceId.trim(),
        municipalServiceCode: form.municipalServiceCode.trim(),
        municipalServiceName: form.municipalServiceName.trim(),
        issPercent: iss ?? 0,
        retainIss: form.retainIss,
        observations: form.observations.trim()
      })
      if (res.success && res.data) {
        onSaved(res.data)
        setForm(nfseFormOf(res.data))
        toast.success(t('integrations.saved'))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="field-hint">{t('nfse.description')}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.nfseEnabled}
          onChange={(e) => campo('nfseEnabled', e.target.checked)}
        />
        {t('nfse.enabled')}
      </label>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <label htmlFor="nfse-description" className="field-label">{t('nfse.serviceDescription')}</label>
          <textarea
            id="nfse-description"
            rows={2}
            maxLength={1000}
            value={form.serviceDescription}
            onChange={(e) => campo('serviceDescription', e.target.value)}
            className="modern-input w-full"
          />
        </div>
        <div>
          <label htmlFor="nfse-service-id" className="field-label">{t('nfse.municipalServiceId')}</label>
          <input
            id="nfse-service-id"
            type="text"
            maxLength={64}
            value={form.municipalServiceId}
            onChange={(e) => campo('municipalServiceId', e.target.value)}
            className="modern-input w-full font-mono"
          />
        </div>
        <div>
          <label htmlFor="nfse-service-code" className="field-label">{t('nfse.municipalServiceCode')}</label>
          <input
            id="nfse-service-code"
            type="text"
            maxLength={64}
            value={form.municipalServiceCode}
            onChange={(e) => campo('municipalServiceCode', e.target.value)}
            className="modern-input w-full font-mono"
          />
        </div>
        <p className="field-hint md:col-span-2">{t('nfse.municipalServiceHint')}</p>
        <div>
          <label htmlFor="nfse-service-name" className="field-label">{t('nfse.municipalServiceName')}</label>
          <input
            id="nfse-service-name"
            type="text"
            maxLength={255}
            value={form.municipalServiceName}
            onChange={(e) => campo('municipalServiceName', e.target.value)}
            className="modern-input w-full"
          />
        </div>
        <div>
          <label htmlFor="nfse-iss" className="field-label">{t('nfse.issPercent')}</label>
          <input
            id="nfse-iss"
            type="text"
            inputMode="decimal"
            value={form.issPercent}
            onChange={(e) => campo('issPercent', e.target.value)}
            className="modern-input w-full"
            aria-invalid={!issValido}
          />
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.retainIss} onChange={(e) => campo('retainIss', e.target.checked)} />
            {t('nfse.retainIss')}
          </label>
        </div>
        <div className="md:col-span-2">
          <label htmlFor="nfse-observations" className="field-label">{t('nfse.observations')}</label>
          <textarea
            id="nfse-observations"
            rows={2}
            maxLength={1000}
            value={form.observations}
            onChange={(e) => campo('observations', e.target.value)}
            className="modern-input w-full"
          />
          <p className="field-hint">{t('nfse.observationsHint')}</p>
        </div>
      </div>
      {faltaObrigatorio && <p className="text-sm text-destructive">{t('nfse.requiredHint')}</p>}
      <button
        type="button"
        className="modern-button"
        disabled={!mudou || saving || !issValido || faltaObrigatorio}
        onClick={() => void salvar()}
      >
        {saving ? t('common.saving') : t('common.save')}
      </button>
    </div>
  )
}

/**
 * Multa, juros e desconto por antecipação das cobranças da plataforma no
 * Asaas. Salva à parte, como a NFS-e: o backend confere as faixas e o piso de
 * R$ 5,00 é aplicado na emissão de cada cobrança.
 */
function ChargeTermsSection({ info, onSaved }: { info: AsaasIntegration; onSaved: (dados: AsaasIntegration) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [form, setForm] = useState<ChargeTermsForm>(() => chargeTermsFormOf(info))
  const [saving, setSaving] = useState(false)

  const original = chargeTermsFormOf(info)
  const mudou = JSON.stringify(form) !== JSON.stringify(original)
  const conferido = chargeTermsPayload(form)
  const invalido = (campo: ChargeTermsField) => !conferido.ok && conferido.invalid.includes(campo)

  const campo = <K extends keyof ChargeTermsForm>(nome: K, valor: ChargeTermsForm[K]) =>
    setForm((atual) => ({ ...atual, [nome]: valor }))

  const salvar = async () => {
    if (!mudou || saving || !conferido.ok) return
    setSaving(true)
    try {
      const res = await platformAPI.saveAsaasIntegration(conferido.body)
      if (res.success && res.data) {
        onSaved(res.data)
        setForm(chargeTermsFormOf(res.data))
        toast.success(t('integrations.saved'))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="field-hint">{t('chargeTerms.description')}</p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="charge-fine" className="field-label">{t('chargeTerms.finePercent')}</label>
          <input
            id="charge-fine"
            type="text"
            inputMode="decimal"
            value={form.finePercent}
            onChange={(e) => campo('finePercent', e.target.value)}
            className="modern-input w-full"
            aria-invalid={invalido('finePercent')}
          />
          <p className="field-hint">{t('chargeTerms.rangeHint', { max: CHARGE_TERMS_LIMITS.finePercent })}</p>
        </div>
        <div>
          <label htmlFor="charge-interest" className="field-label">{t('chargeTerms.interestMonthlyPercent')}</label>
          <input
            id="charge-interest"
            type="text"
            inputMode="decimal"
            value={form.interestMonthlyPercent}
            onChange={(e) => campo('interestMonthlyPercent', e.target.value)}
            className="modern-input w-full"
            aria-invalid={invalido('interestMonthlyPercent')}
          />
          <p className="field-hint">
            {t('chargeTerms.rangeHint', { max: CHARGE_TERMS_LIMITS.interestMonthlyPercent })}
          </p>
        </div>
        <div>
          <label htmlFor="charge-discount-kind" className="field-label">{t('chargeTerms.discountKind')}</label>
          <select
            id="charge-discount-kind"
            value={form.discountKind}
            onChange={(e) => campo('discountKind', e.target.value === 'fixed' ? 'fixed' : 'percent')}
            className="modern-input w-full"
          >
            <option value="percent">{t('chargeTerms.discountPercent')}</option>
            <option value="fixed">{t('chargeTerms.discountFixed')}</option>
          </select>
        </div>
        <div>
          <label htmlFor="charge-discount-value" className="field-label">
            {form.discountKind === 'fixed' ? t('chargeTerms.discountValueFixed') : t('chargeTerms.discountValuePercent')}
          </label>
          <input
            id="charge-discount-value"
            type="text"
            inputMode="decimal"
            value={form.discountValue}
            onChange={(e) => campo('discountValue', e.target.value)}
            className="modern-input w-full"
            aria-invalid={invalido('discountValue')}
          />
        </div>
        <div className="md:col-span-2">
          <label htmlFor="charge-discount-days" className="field-label">{t('chargeTerms.discountDaysBefore')}</label>
          <input
            id="charge-discount-days"
            type="text"
            inputMode="numeric"
            value={form.discountDaysBefore}
            onChange={(e) => campo('discountDaysBefore', e.target.value)}
            className="modern-input w-full md:w-40"
            aria-invalid={invalido('discountDaysBefore')}
          />
          <p className="field-hint">{t('chargeTerms.discountHint')}</p>
        </div>
      </div>
      <p className="field-hint">{t('chargeTerms.cardHint')}</p>
      {!conferido.ok && mudou && <p className="text-sm text-destructive">{t('chargeTerms.invalid')}</p>}
      <button
        type="button"
        className="modern-button"
        disabled={!mudou || saving || !conferido.ok}
        onClick={() => void salvar()}
      >
        {saving ? t('common.saving') : t('common.save')}
      </button>
    </div>
  )
}

export default PlatformIntegrations
