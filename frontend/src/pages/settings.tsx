'use client'

import { bulkPerHour } from '@/lib/wa-pace'
import { Fragment, useCallback, useState, useEffect, useRef } from 'react'
import {
  apiClient,
  vendorsAPI,
  settingsAPI,
  authAPI,
  databaseAPI,
  sgpAPI,
  usersAPI,
  whatsappAPI,
  type DbConfigPayload,
  type GenieAcsAuthConfig,
  type GenieAcsAuthPayload,
  type GenieAcsAuthType,
  type EmailReadiness,
  type MfaStatus,
  type Operator,
  type OperatorRole,
  type SgpConfig,
  type SgpSyncSummary,
  type WhatsAppConfig,
  type WhatsAppConfigTest,
  type RetentionCaps,
  subscriptionAPI,
  tenantAPI,
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useLoading } from '@/components/ui/loading'
import { Icon } from '@/components/ui/icon'
import { LanguageSwitcher } from '@/components/language-switcher'
import { ProvisioningTab } from '@/components/settings/provisioning-tab'
import { SgpEventsPanel } from '@/components/settings/sgp-events-panel'
import { TeiahPanel } from '@/components/settings/teiah-panel'
import { FocusChatPanel } from '@/components/settings/focuschat-panel'
import {
  SGP_CONTACTS_ANCHOR,
  SgpContactsShortcut,
  SgpContactsSyncPanel
} from '@/components/settings/sgp-contacts-sync-panel'
import { CustomerIdSyncStatusPanel } from '@/components/settings/customer-id-sync-status'
import { WhatsAppConnection, whatsappErrorMessage } from '@/components/whatsapp-connection'
import { TEST_TONE_CLASS, testNotes, testOutcome } from '@/lib/whatsapp-test'
import { auditRetentionError, waRetentionAboveCap } from '@/lib/settings-validation'
import { useAuth } from '@/contexts/auth-context'
import { useTenant } from '@/contexts/tenant-context'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { OPERATOR_ROLES, ROLE_LABEL_KEYS, ROLE_SUMMARY_KEYS } from '@/lib/permissions'
import { exportFileName } from '@/lib/utils'
import { DATE_FORMATS, dateFormatExample, setActiveDateFormat, type DateFormat } from '@/lib/date-format'
import { InvitePanel } from '@/components/settings/invite-panel'
import { ProviderAddressPanel } from '@/components/settings/provider-address-panel'
import { GenieAcsConnectionCard } from '@/components/settings/genieacs-connection-card'
import { FirmwareFilesCard } from '@/components/settings/firmware-files'
import { INSTALLER_VIRTUAL_PARAMETERS, VIRTUAL_PARAMETER_FIELDS } from '@/lib/virtual-parameters'

/** O que a SaaS grava pelo console e não por esta tela: o ACS e os parâmetros TR-069. */
const PLATFORM_MANAGED_KEYS = new Set<string>(['genieAcsUrl', ...Object.keys(INSTALLER_VIRTUAL_PARAMETERS)])
import type { Vendor as VendorType, WifiSecurityConfig as WifiSecurityConfigType } from '@/types'
import { MfaCard } from '@/components/mfa-card'
import { AboutTab } from '@/components/settings/about-tab'
import { ChatbotTab } from '@/components/settings/chatbot-tab'
import { IntegrationsHub } from '@/components/settings/integrations-hub'
import { MfaPolicyCard } from '@/components/mfa-policy-card'
import { canOfferMfaReset, canOfferPasswordReset } from '@/lib/mfa-enrollment'

/**
 * Mapas em vez de nome de chave montado com template literal.
 *
 * `TranslationKey` é derivado de `en.ts`, então uma chave escrita por inteiro é
 * conferida na compilação; uma montada com `as TranslationKey` só falharia em
 * runtime, virando texto cru na tela do operador.
 */
const GENIE_AUTH_TYPE_LABELS: Record<GenieAcsAuthType, TranslationKey> = {
  none: 'settings.genieAuth.typeNone',
  basic: 'settings.genieAuth.typeBasic',
  bearer: 'settings.genieAuth.typeBearer'
}

type GenieSecretState = 'pendingClear' | 'typed' | 'configured' | 'empty'

const GENIE_SECRET_STATE_LABELS: Record<GenieSecretState, TranslationKey> = {
  configured: 'settings.genieAuth.statusConfigured',
  empty: 'settings.genieAuth.statusEmpty',
  pendingClear: 'settings.genieAuth.statusPendingClear',
  typed: 'settings.genieAuth.statusTyped'
}

const GENIE_SECRET_STATE_BADGES: Record<GenieSecretState, string> = {
  configured: 'modern-badge-success',
  empty: 'modern-badge',
  pendingClear: 'modern-badge-warning',
  typed: 'modern-badge-info'
}

/** The tabs `?tab=` may open. */
const SETTINGS_TABS = [
  'provider', 'general', 'virtual-params', 'customer-portal', 'integrations', 'sgp', 'teiah', 'focuschat', 'provisioning',
  'whatsapp', 'chatbot', 'security', 'vendors', 'wifi-security', 'database', 'about'
]

/**
 * As abas que moram dentro de "Integrações": saem da trilha e viram cards.
 * Continuam abrindo por `?tab=sgp` etc., e a trilha acende "Integrações"
 * enquanto uma delas está aberta.
 */
const INTEGRATION_TABS = ['sgp', 'teiah', 'focuschat', 'whatsapp', 'chatbot']

// Botão só de ícone nas listas: 40px de alvo abaixo do desktop, onde o toque
// precisa; no lg a linha da tabela volta ao tamanho do ícone.
const ICON_ACTION = 'inline-flex h-10 w-10 items-center justify-center rounded-md lg:h-auto lg:w-auto'

/**
 * Scrolls to a section once its tab has rendered it. The tab loads its data
 * first, so the element may not exist yet on the first frames; a few short
 * retries cover that without a timer that outlives the page.
 */
function scrollToSection(id: string, attempts = 20) {
  const element = document.getElementById(id)
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  if (attempts > 0) window.setTimeout(() => scrollToSection(id, attempts - 1), 150)
}

/**
 * How a fixed order reads to the operator: "DD/MM/AAAA" in Portuguese,
 * "DD/MM/YYYY" in English. `tokens` is the translated "day|month|year".
 */
function dateFormatLabel(format: DateFormat, tokens: string) {
  const [day = 'DD', month = 'MM', year = 'YYYY'] = tokens.split('|')
  return format.replace('yyyy', year).replace('MM', month).replace('dd', day)
}

export default function Settings() {
  const { t, formatDateTime, intlLocale } = useTranslation()
  const { user: currentUser, can, refreshUser } = useAuth()
  const { name: tenantName, isSaas, platformManaged, tenant, refresh: refreshTenant } = useTenant()
  // Lidos aqui em cima, antes de qualquer handler que os feche: um `const`
  // do componente lido dentro de um callback ANTES da linha que o declara é
  // uma ReferenceError se o callback rodar durante a renderização, e a regra
  // de lint não distingue o callback que roda depois do que roda agora — por
  // isso ela exige a ordem, e a ordem custa nada.
  const toast = useToast()
  const loadingCtl = useLoading()
  const isOwner = currentUser?.role === 'owner'
  // Se quem está na tela já usa o 2FA — o cartão da exigência precisa saber,
  // porque ligar a exigência pede isso. Vem do cartão do 2FA, que é quem relê.
  const [meuMfa, setMeuMfa] = useState(Boolean(currentUser?.mfaEnabled))
  const lembrarMeuMfa = useCallback((status: MfaStatus) => setMeuMfa(status.enabled), [])
  const canReadOperators = can('operators.read')
  const canManageOperators = can('operators.manage')
  const canExportTenant = can('tenant.export')
  const [settings, setSettings] = useState({
    appName: tenantName,
    genieAcsUrl: 'http://127.0.0.1:7557',
    autoGenerateCustomerId: 'false',
    customerIdPrefixMode: 'default',
    customerIdCompanyPrefix: 'CSG',
    customerIdSuffixMode: 'random',
    // Por quantos dias a trilha é guardada. O valor real chega do servidor na
    // carga; este é só o que a tela mostra antes dela, e é o mesmo padrão que
    // o agendador usa quando não há nada salvo.
    auditRetentionDays: '365',
    // O contato do provedor no portal do assinante; desligado até o provedor
    // ligar. Telefone, WhatsApp e e-mail vazios usam os do cadastro.
    portalShowProviderContact: 'false',
    portalContactPhone: '',
    portalContactWhatsapp: '',
    portalContactEmail: '',
    // Como as datas aparecem em todo o painel e no portal; `auto` segue o idioma.
    dateFormat: 'auto' as string,
    ...INSTALLER_VIRTUAL_PARAMETERS
  })
  const [loading, setLoading] = useState(false)
  // Muda a cada salvar que dispara a sincronização de IDs, para o quadro de
  // andamento reler na hora em vez de esperar o próximo ciclo.
  const [syncStatusKey, setSyncStatusKey] = useState(0)
  const [exportando, setExportando] = useState(false)
  // The tab can come from the address — `/settings?tab=sgp` — so other screens
  // can link to a section instead of describing where it is. Only the tabs
  // that exist are taken; anything else opens the first one, as before.
  // A aba "Geral" (endereço e mapa do provedor) só existe para quem pode
  // gravar uma das duas metades; quem não pode abre em "Painel e ACS".
  const canEditProvider = can('settings.write') || can('map.write')
  const [activeTab, setActiveTab] = useState(() => {
    const fallback = canEditProvider ? 'provider' : 'general'
    try {
      const wanted = new URLSearchParams(window.location.search).get('tab')
      if (wanted === 'provider' && !canEditProvider) return 'general'
      return wanted && SETTINGS_TABS.includes(wanted) ? wanted : fallback
    } catch {
      return fallback
    }
  })
  // No celular a trilha de abas rola de lado: a aba ativa — a que veio do
  // `?tab=` inclusive — é trazida para a vista, senão a pessoa não vê onde está.
  const tabRailRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const rail = tabRailRef.current
    const ativa = rail?.querySelector<HTMLElement>('[data-active="true"]')
    if (!rail || !ativa || rail.scrollWidth <= rail.clientWidth) return
    const deslocamento = ativa.getBoundingClientRect().left - rail.getBoundingClientRect().left
    rail.scrollTo({ left: rail.scrollLeft + deslocamento - (rail.clientWidth - ativa.offsetWidth) / 2 })
  }, [activeTab, platformManaged, canEditProvider])
  const [testResult, setTestResult] = useState<{success: boolean, message: string, deviceCount?: number} | null>(null)
  const [genieAuthConfig, setGenieAuthConfig] = useState<GenieAcsAuthConfig | null>(null)
  // O ACS é da plataforma (só leitura aqui) — ou é do provedor, na self-hosted
  // e na SaaS quando o console marcou que ele usa o próprio servidor. Até a
  // resposta chegar, vale o lado seguro: só leitura.
  const genieAcsManaged = platformManaged && genieAuthConfig?.platformManaged !== false
  // Com o ACS da plataforma, "Parâmetros TR-069" não existe para o provedor. Um
  // `?tab=` antigo pode apontar para ela: a tela vai para a primeira aba que ele
  // tem — depois de saber de quem é o ACS, para não tirar dali quem tem o próprio.
  useEffect(() => {
    if (genieAcsManaged && genieAuthConfig && activeTab === 'virtual-params') {
      setActiveTab(canEditProvider ? 'provider' : 'customer-portal')
    }
  }, [genieAcsManaged, genieAuthConfig, activeTab, canEditProvider])
  const [genieAuthForm, setGenieAuthForm] = useState<{
    authType: GenieAcsAuthType
    username: string
    secret: string
    /**
     * O terceiro estado do campo de segredo, e o que evita o "salvei e apagou
     * sem querer": apagar é uma intenção declarada, que fica visível na tela
     * até o salvamento e pode ser desfeita antes dele. Sem ela, "campo em
     * branco" teria de significar ao mesmo tempo manter e apagar.
     */
    secretPendingClear: boolean
  }>({ authType: 'none', username: '', secret: '', secretPendingClear: false })
  /**
   * A URL do GenieACS como está SALVA, não como está no campo.
   *
   * O servidor só manda a credencial junto do teste de conexão quando a origem
   * testada é a que ele tem guardada, e essa decisão ele não conta na resposta.
   * Guardando aqui o valor salvo, a tela chega à mesma conclusão que ele e pode
   * avisar antes do clique — enquanto ainda dá para salvar primeiro.
   */
  const [savedGenieAcsUrl, setSavedGenieAcsUrl] = useState('')
  const [dbForm, setDbForm] = useState<DbConfigPayload>({
    client: 'mysql2', host: 'localhost', port: 3306, user: '', password: '', database: '', migrateData: true
  })
  const [activeDb, setActiveDb] = useState<{ client: string; host?: string; database?: string } | null>(null)
  const [sgpConfig, setSgpConfig] = useState<SgpConfig | null>(null)
  const [sgpForm, setSgpForm] = useState({
    enabled: false,
    baseUrl: '',
    app: '',
    token: '',
    linkMode: 'pppoe' as SgpConfig['linkMode'],
    portalBilling: true,
    portalUnlock: false,
    invoiceLimit: 6,
    ticketEnabled: false,
    ticketOccurrenceType: 5,
    settleReceivingPoint: 0,
    settlePaymentMethods: '',
    settleFees: 0,
    settlePath: '',
    sample: ''
  })
  const [sgpSaving, setSgpSaving] = useState(false)
  const [sgpTesting, setSgpTesting] = useState(false)
  const [sgpTestResult, setSgpTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [sgpSyncing, setSgpSyncing] = useState(false)
  const [sgpSyncSummary, setSgpSyncSummary] = useState<SgpSyncSummary | null>(null)
  const [sgpFleetAvailable, setSgpFleetAvailable] = useState(false)
  const [dbTesting, setDbTesting] = useState(false)
  const [dbSwitching, setDbSwitching] = useState(false)
  const [waConfig, setWaConfig] = useState<WhatsAppConfig | null>(null)
  const [waForm, setWaForm] = useState({
    enabled: false,
    webhookBaseUrl: '',
    portalPublicUrl: '',
    allowedHosts: '',
    managedUrl: '',
    managedAdminKey: '',
    cloudCallbackUrl: '',
    cloudVerifyToken: '',
    rejectCallMessage: '',
    rateLimitPerMin: 20,
    bulkIntervalMinSec: 20,
    bulkIntervalMaxSec: 45,
    bulkBurstSize: 30,
    bulkBurstPauseMin: 5,
    // 0 is forever, and it is what an installation that never touches this
    // field keeps. Anything else is a day count after which a stored
    // attachment is deleted off the disk.
    mediaRetentionDays: 0,
    // Its sibling, and the heavier of the two: this one deletes the words of
    // the conversation rather than a file hanging off it. Same default, and
    // the same reason for it.
    messageRetentionDays: 0
  })
  const [waSaving, setWaSaving] = useState(false)
  const [waTesting, setWaTesting] = useState(false)
  // `null` = nunca testado; o resultado guarda os seis passos. A tela nunca
  // reduz isso a um ✓/✗ único: o valor inteiro do botão está em dizer QUAL dos
  // seis falhou.
  const [waTestResult, setWaTestResult] = useState<WhatsAppConfigTest | null>(null)
  const [waTestError, setWaTestError] = useState<string | null>(null)
  // Os tetos de retenção do plano, na SaaS. Nulo enquanto não chegou, e na
  // self-hosted, onde não há plano: aí a tela se comporta como sempre.
  const [retentionCaps, setRetentionCaps] = useState<RetentionCaps | null>(null)

  useEffect(() => {
    if (!isSaas) return
    let cancelled = false
    void subscriptionAPI.current().then((res) => {
      if (!cancelled && res.success && res.data?.retention) setRetentionCaps(res.data.retention)
    })
    return () => { cancelled = true }
  }, [isSaas])

  // The context may resolve after the first render; keep the field in step.
  // Arriving from a link to a section (`#sgp-contacts-sync`): scroll to it once
  // its tab has drawn it.
  useEffect(() => {
    const anchor = window.location.hash.replace(/^#/, '')
    if (anchor) scrollToSection(anchor)
  }, [])

  useEffect(() => {
    setSettings(prev => (prev.appName === tenantName ? prev : { ...prev, appName: tenantName }))
  }, [tenantName])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await settingsAPI.getAll()
      if (!cancelled && res.success && res.data) {
        // `appName` is no longer read from settings: the provider's name lives
        // on the `tenants` row and arrives through the tenant context.
        const { appName: _legacyAppName, ...rest } = res.data as any
        // Só as chaves que esta tela conhece: o salvar regrava cada uma, e uma
        // chave a mais (estado interno de um servidor mais antigo) seria
        // recusada e pararia o salvar no meio.
        setSettings(prev => ({
          ...prev,
          ...Object.fromEntries(Object.entries(rest).filter(([key]) => key in prev))
        }))
        setSavedGenieAcsUrl(String((res.data as any).genieAcsUrl ?? ''))
      }
      setTestResult(null)

      const auth = await settingsAPI.getGenieAcsAuth()
      if (!cancelled && auth.success && auth.data) {
        setGenieAuthConfig(auth.data)
        setGenieAuthForm({
          authType: auth.data.authType,
          username: auth.data.username,
          // O segredo guardado nunca sai do servidor; campo em branco mantém.
          secret: '',
          secretPendingClear: false
        })
      }
    })()
    return () => { cancelled = true }
  }, [])

  /**
   * As abas cujo formulário já foi preenchido com o que o servidor tem.
   *
   * A busca preguiçosa por aba é deliberada — só se pergunta ao servidor o que
   * a aba aberta precisa. O que não era deliberado é ela acontecer DE NOVO a
   * cada reentrada: o componente não desmonta ao trocar de aba, então o efeito
   * disparava outra vez e `setSgpForm`/`setWaForm` sobrescreviam o formulário
   * com o valor gravado. Quem digitasse a URL nova do SGP, fosse à aba do
   * WhatsApp conferir um número e voltasse, encontrava o campo de volta no
   * valor antigo — sem aviso e sem diferença visual, porque um campo que
   * voltou parece um campo que nunca mudou.
   *
   * Perder o digitado é pior que mostrar valor um pouco velho: o salvamento
   * ainda fala com o servidor, e a tela já mostra o gravado ao lado do digitado
   * quando os dois divergem.
   */
  const abasCarregadas = useRef(new Set<string>())

  useEffect(() => {
    if (activeTab !== 'database') return
    let cancelled = false
    ;(async () => {
      const res = await databaseAPI.getConfig()
      if (!cancelled && res.success && res.data) {
        setActiveDb(res.data as any)
      }
    })()
    return () => { cancelled = true }
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== 'sgp') return
    let cancelled = false
    ;(async () => {
      const res = await sgpAPI.getConfig()
      if (cancelled) return
      if (res.success && res.data) {
        const config = res.data
        setSgpConfig(config)
        // `sgpConfig` é o "gravado" que a tela mostra ao lado do digitado, e
        // esse SIM tem que acompanhar o servidor a cada visita.
        const primeiraVez = !abasCarregadas.current.has('sgp')
        abasCarregadas.current.add('sgp')
        if (primeiraVez) setSgpForm((current) => ({
          ...current,
          enabled: config.enabled,
          baseUrl: config.baseUrl,
          app: config.app,
          // The stored token never leaves the server; an empty field keeps it.
          token: '',
          linkMode: config.linkMode,
          portalBilling: config.portalBilling,
          portalUnlock: config.portalUnlock,
          invoiceLimit: config.invoiceLimit,
          ticketEnabled: config.ticketEnabled,
          ticketOccurrenceType: config.ticketOccurrenceType,
          settleReceivingPoint: config.settleReceivingPoint ?? 0,
          settlePaymentMethods: (config.settlePaymentMethods ?? []).join(', '),
          settleFees: config.settleFees ?? 0,
          settlePath: config.endpoints?.invoiceSettle ?? ''
        }))
        if (primeiraVez) setSgpTestResult(null)
      }

      // The fleet block only exists while the integration answers; the overview
      // also carries the summary of the last synchronization that ran.
      const overview = await sgpAPI.getOverview()
      if (cancelled) return
      const fleetReady = overview.success && Boolean(overview.data?.enabled)
      setSgpFleetAvailable(fleetReady)
      setSgpSyncSummary(fleetReady ? overview.data?.lastSync ?? null : null)
    })()
    return () => { cancelled = true }
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== 'whatsapp') return
    let cancelled = false
    ;(async () => {
      const res = await whatsappAPI.getConfig()
      if (cancelled || !res.success || !res.data) return
      const config = res.data
      setWaConfig(config)
      if (abasCarregadas.current.has('whatsapp')) return
      abasCarregadas.current.add('whatsapp')
      setWaForm({
        enabled: config.enabled,
        webhookBaseUrl: config.webhookBaseUrl,
        portalPublicUrl: config.portalPublicUrl,
        allowedHosts: config.allowedHosts.join('\n'),
        managedUrl: config.managedUrl,
        // The stored admin key never leaves the server; an empty field keeps it.
        managedAdminKey: '',
        // O token da Meta, ao contrário da chave, sai: os provedores o colam no
        // app deles na Meta, então mostrá-lo aqui não revela nada novo.
        cloudCallbackUrl: config.cloudCallbackUrl ?? '',
        cloudVerifyToken: config.cloudWebhook?.verifyToken ?? '',
        rejectCallMessage: config.rejectCallMessage,
        rateLimitPerMin: config.rateLimitPerMin,
        // Mesmo cuidado dos campos de retenção: um backend anterior ao ritmo
        // responde sem eles, e o padrão aqui é o mesmo do servidor.
        bulkIntervalMinSec: config.bulkIntervalMinSec ?? 20,
        bulkIntervalMaxSec: config.bulkIntervalMaxSec ?? 45,
        bulkBurstSize: config.bulkBurstSize ?? 30,
        bulkBurstPauseMin: config.bulkBurstPauseMin ?? 5,
        // Defaulted here rather than trusted: a panel talking to a backend
        // from before this field existed answers without it, and `undefined`
        // in a number input makes it uncontrolled from that point on. The
        // fallback is the same one the server keeps — forever.
        mediaRetentionDays: config.mediaRetentionDays ?? 0,
        messageRetentionDays: config.messageRetentionDays ?? 0
      })
    })()
    return () => { cancelled = true }
  }, [activeTab])

  const sgpSamplePayload = () => {
    const sample = sgpForm.sample.trim()
    if (!sample) return {}
    if (/^\d[\d.\-/]*$/.test(sample)) {
      return sample.replace(/\D/g, '').length > 8
        ? { document: sample }
        : { contract: sample }
    }
    return { login: sample }
  }

  const handleSgpTest = async () => {
    setSgpTesting(true)
    setSgpTestResult(null)
    try {
      const res = await sgpAPI.test({
        baseUrl: sgpForm.baseUrl,
        app: sgpForm.app,
        token: sgpForm.token || undefined,
        ...sgpSamplePayload()
      })
      const message = res.message || t(res.success ? 'settings.sgp.testSuccess' : 'settings.sgp.testFailed')
      setSgpTestResult({ success: res.success, message })
      toast[res.success ? 'success' : 'error'](message)
    } finally {
      setSgpTesting(false)
    }
  }

  const handleSgpSave = async () => {
    setSgpSaving(true)
    try {
      const res = await sgpAPI.updateConfig({
        enabled: sgpForm.enabled,
        baseUrl: sgpForm.baseUrl,
        app: sgpForm.app,
        // Only send the token when the operator typed a new one.
        ...(sgpForm.token ? { token: sgpForm.token } : {}),
        linkMode: sgpForm.linkMode,
        portalBilling: sgpForm.portalBilling,
        portalUnlock: sgpForm.portalUnlock,
        invoiceLimit: sgpForm.invoiceLimit,
        ticketEnabled: sgpForm.ticketEnabled,
        ticketOccurrenceType: sgpForm.ticketOccurrenceType,
        settleReceivingPoint: sgpForm.settleReceivingPoint,
        settlePaymentMethods: sgpForm.settlePaymentMethods.split(',').map((entry) => entry.trim()).filter(Boolean),
        settleFees: sgpForm.settleFees,
        ...(sgpForm.settlePath.trim() ? { endpoints: { invoiceSettle: sgpForm.settlePath.trim() } as SgpConfig['endpoints'] } : {})
      })
      if (res.success && res.data) {
        const salvo = res.data
        setSgpConfig(salvo)
        // `baseUrl` volta do servidor NORMALIZADA: `normalizeBaseUrl` força o
        // esquema, apaga query e fragmento, e corta a barra final. Sem devolvê-la
        // ao campo, quem salva `sgp.exemplo.com/api/?x=1` vê o texto intacto,
        // acha que o painel guardou aquilo, e a integração fala com outro
        // endereço. Mesmo defeito que o campo do webhook tinha.
        setSgpForm((current) => ({ ...current, baseUrl: salvo.baseUrl, token: '' }))
      }
      toast[res.success ? 'success' : 'error'](
        res.message || t(res.success ? 'settings.sgp.saved' : 'settings.sgp.saveFailed')
      )
    } finally {
      setSgpSaving(false)
    }
  }

  const handleSgpSyncAll = async () => {
    setSgpSyncing(true)
    try {
      const res = await sgpAPI.syncAll()
      if (res.success && res.data) {
        setSgpSyncSummary(res.data)
        toast.success(res.message || t('settings.sgp.syncDone'))
        return
      }
      if (res.code === 'not_configured') {
        setSgpFleetAvailable(false)
        return
      }
      toast.error(res.message || t('settings.sgp.syncFailed'))
    } finally {
      setSgpSyncing(false)
    }
  }

  const handleSgpClearToken = async () => {
    if (!confirm(t('settings.sgp.clearTokenConfirm'))) return
    setSgpSaving(true)
    try {
      const res = await sgpAPI.updateConfig({ enabled: false, token: '' })
      if (res.success && res.data) {
        setSgpConfig(res.data)
        setSgpForm((current) => ({ ...current, enabled: false, token: '' }))
      }
      toast[res.success ? 'success' : 'error'](res.message || t('settings.sgp.tokenCleared'))
    } finally {
      setSgpSaving(false)
    }
  }

  /**
   * O diagnóstico, que roda com zero números conectados.
   *
   * Sem corpo de propósito: ele testa o que está SALVO. A chave admin nunca
   * volta ao navegador, então mandar o formulário daqui testaria uma
   * configuração sem chave — e a tela diz isso ao lado do botão, senão o
   * operador edita um campo, clica e lê um veredito sobre o valor antigo.
   */
  const handleWhatsappTest = async () => {
    setWaTesting(true)
    setWaTestResult(null)
    setWaTestError(null)
    try {
      const res = await whatsappAPI.testConfig()
      if (res.success && res.data) {
        setWaTestResult(res.data)
      } else {
        setWaTestError(whatsappErrorMessage(t, res.code))
        toast.error(whatsappErrorMessage(t, res.code))
      }
    } finally {
      setWaTesting(false)
    }
  }

  const handleWhatsappSave = async () => {
    setWaSaving(true)
    try {
      const res = await whatsappAPI.updateConfig({
        enabled: waForm.enabled,
        webhookBaseUrl: waForm.webhookBaseUrl,
        portalPublicUrl: waForm.portalPublicUrl,
        // The API takes the textarea verbatim, one host per line.
        allowedHosts: waForm.allowedHosts,
        managedUrl: waForm.managedUrl,
        rejectCallMessage: waForm.rejectCallMessage,
        rateLimitPerMin: waForm.rateLimitPerMin,
        bulkIntervalMinSec: waForm.bulkIntervalMinSec,
        bulkIntervalMaxSec: waForm.bulkIntervalMaxSec,
        bulkBurstSize: waForm.bulkBurstSize,
        bulkBurstPauseMin: waForm.bulkBurstPauseMin,
        mediaRetentionDays: waForm.mediaRetentionDays,
        messageRetentionDays: waForm.messageRetentionDays,
        // Same rule as the SGP token: only send a key the operator typed.
        // Omitting it keeps the stored one, so saving this form can never
        // revoke the integration by accident.
        ...(waForm.managedAdminKey ? { managedAdminKey: waForm.managedAdminKey } : {}),
        cloudCallbackUrl: waForm.cloudCallbackUrl,
        cloudVerifyToken: waForm.cloudVerifyToken
      })
      if (res.success && res.data) {
        const salvo = res.data
        setWaConfig(salvo)
        // O formulário volta a mostrar o que ficou GRAVADO, e não o que foi
        // digitado. O backend normaliza estes dois — o do webhook ganha
        // `/api/whatsapp-webhook` quando só o host é digitado, e ambos perdem
        // a barra final —, então deixar o campo com o texto de quem digitou
        // esconde justamente a correção que acabou de acontecer. Quem salva
        // "https://painel.exemplo.com" precisa VER o caminho aparecer, ou não
        // tem como saber se o conserto pegou.
        setWaForm((current) => ({
          ...current,
          webhookBaseUrl: salvo.webhookBaseUrl,
          portalPublicUrl: salvo.portalPublicUrl,
          // Os outros três que o backend também reescreve, e que a primeira
          // passagem deste conserto deixou de fora: `managedUrl` perde a barra
          // final E o sufixo `/manager` — o caso mais provável de todos, porque
          // o operador cola a URL do Evolution Manager; `allowedHosts` vira
          // minúsculo, perde esquema e caminho e é deduplicada; e a mensagem de
          // recusa de chamada é cortada em 300.
          managedUrl: salvo.managedUrl,
          allowedHosts: salvo.allowedHosts.join('\n'),
          rejectCallMessage: salvo.rejectCallMessage,
          managedAdminKey: '',
          cloudCallbackUrl: salvo.cloudCallbackUrl ?? '',
          cloudVerifyToken: salvo.cloudWebhook?.verifyToken ?? ''
        }))
        toast.success(res.message || t('common.success'))
        return
      }
      // The machine `code` is what gets translated; the message that comes with
      // it can be the Evolution server's own words.
      toast.error(whatsappErrorMessage(t, res.code))
    } finally {
      setWaSaving(false)
    }
  }

  const handleDbTest = async () => {
    setDbTesting(true)
    try {
      const res = await databaseAPI.test(dbForm)
      const message = res.message || (res.success ? t('settings.db.testSuccess') : t('settings.db.testFailed'))
      toast[res.success ? 'success' : 'error'](message)
    } catch (e: any) {
      toast.error(e?.message || t('settings.db.testFailed'))
    } finally {
      setDbTesting(false)
    }
  }

  const handleDbSwitch = async () => {
    const label = dbForm.client === 'sqlite3'
      ? t('settings.db.sqlite')
      : t('settings.db.mysql', { database: String(dbForm.database), host: String(dbForm.host) })
    const dataNotice = dbForm.migrateData ? t('settings.db.confirmCopy') : t('settings.db.confirmNoCopy')
    if (!confirm(t('settings.db.confirmSwitch', { label, dataNotice }))) return
    setDbSwitching(true)
    try {
      const res = await databaseAPI.switch(dbForm)
      const message = res.message || (res.success ? t('settings.db.switched') : t('settings.db.switchFailed'))
      toast[res.success ? 'success' : 'error'](message)
      if (res.success && res.data) setActiveDb(res.data as any)
    } catch (e: any) {
      toast.error(e?.message || t('settings.db.switchFailed'))
    } finally {
      setDbSwitching(false)
    }
  }

  /**
   * Em qual dos quatro estados o campo de segredo está agora.
   *
   * Um campo de senha em branco é ambíguo por natureza — pode significar
   * "mantenha" ou "apague" — e é dessa ambiguidade que nasce o salvamento que
   * revoga a credencial sem ninguém pedir. Aqui ela é resolvida antes de virar
   * texto na tela: cada estado tem um nome, e o rótulo abaixo do campo diz qual
   * é. `typed` vem antes de `configured` porque o que o operador acabou de
   * digitar manda no que está guardado.
   */
  const genieSecretState: GenieSecretState = (() => {
    if (genieAuthForm.secretPendingClear) return 'pendingClear'
    if (genieAuthForm.secret) return 'typed'
    if (genieAuthConfig?.secretConfigured) return 'configured'
    return 'empty'
  })()

  /**
   * Se o teste de conexão vai sair SEM a credencial.
   *
   * Reproduz a regra do servidor: ele só anexa a credencial guardada quando a
   * origem testada é a mesma que está salva em `genieAcsUrl`. Comparar origem
   * (esquema + host + porta), e não a string inteira, é o que ele faz — caminho
   * ou barra final no fim não mudam para onde a requisição vai.
   */
  const genieTestGoesAnonymous = (() => {
    if (genieAuthForm.authType === 'none' && !genieAuthConfig?.secretConfigured) return false
    if (!savedGenieAcsUrl) return true
    try {
      return new URL(savedGenieAcsUrl).origin !== new URL(settings.genieAcsUrl).origin
    } catch {
      // URL que não parseia não é a origem salva, então o teste vai sem nada —
      // e o aviso, que é o assunto aqui, continua sendo o certo a mostrar.
      return true
    }
  })()

  const handleTestConnection = async () => {
    setLoading(true)
    loadingCtl.show(t('settings.general.testingProgress'))
    try {
      const res = await settingsAPI.testGenieAcs(settings.genieAcsUrl)
      if (res.success) {
        setTestResult({
          success: true,
          message: res.message || t('settings.general.connectionOk'),
          deviceCount: (res.data as any)?.deviceCount
        })
        toast.success(t('settings.general.connectionToastOk'))
      } else {
        setTestResult({
          success: false,
          message: res.message || t('settings.general.connectionFailed')
        })
        toast.error(res.message || t('settings.general.connectionFailed'))
      }
    } finally {
      setLoading(false)
      loadingCtl.hide()
    }
  }

  const [usernameForm, setUsernameForm] = useState<{ currentUsername: string; newUsername: string }>({
    currentUsername: '',
    newUsername: ''
  })
  const [passwordForm, setPasswordForm] = useState<{ currentPassword: string; newPassword: string; confirmNewPassword: string }>({
    currentPassword: '',
    newPassword: '',
    confirmNewPassword: ''
  })

  /**
   * Baixa todo o cadastro deste provedor.
   *
   * A rota devolve arquivo e não envelope, então vai por `getBlob`. O nome vem
   * do servidor no `Content-Disposition`; `exportFileName` é a reserva para o
   * deploy que serve o painel de outra origem sem expor o cabeçalho.
   *
   * A URL do blob é revogada logo depois do clique, e não no desmonte: aqui ela
   * serve a um download de uso único, ao contrário do anexo de conversa, onde
   * uma `<img>` continua apontando para ela.
   */
  const exportarDados = async () => {
    setExportando(true)
    try {
      const res = await tenantAPI.export()
      if (!res.success || !res.blob) {
        toast.error(res.message || t('settings.export.failed'))
        return
      }
      const url = URL.createObjectURL(res.blob)
      const link = document.createElement('a')
      link.href = url
      // O slug da sessão: no host compartilhado o do `TenantProvider` é o do
      // primeiro provedor.
      link.download = res.filename || exportFileName(currentUser?.tenant?.slug || tenant?.slug)
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success(t('settings.export.done'))
    } finally {
      setExportando(false)
    }
  }

  const submitChangeUsername = async () => {
    const res = await authAPI.changeUsername(usernameForm.currentUsername, usernameForm.newUsername)
    if (res.success) {
      toast.success(res.message || t('settings.security.usernameUpdated'))
      setUsernameForm({ currentUsername: '', newUsername: '' })
    } else {
      toast.error(res.message || t('settings.security.usernameFailed'))
    }
  }

  /**
   * O e-mail de login da própria pessoa.
   *
   * Fica ao lado da troca de senha porque é a mesma coisa: as duas mexem em
   * como se entra nesta conta, e as duas exigem a senha atual por isso. É por
   * aqui que quem já usava o painel antes desta versão cadastra o endereço que
   * a conta nunca teve — e é o que faz o número de contas sem e-mail cair.
   */
  const [emailForm, setEmailForm] = useState<{ currentPassword: string; email: string }>({
    currentPassword: '',
    email: ''
  })

  /**
   * A prova do endereço, pedida de novo.
   *
   * A conta pode ter um endereço e ele não estar provado — é o estado de toda
   * conta anterior a esta versão e de todo endereço recém-trocado. Enquanto
   * estiver assim, a redefinição de senha por e-mail não funciona para esta
   * pessoa, e o dia em que ela vai descobrir isso é o dia em que ela não vai
   * poder resolver. Daí o aviso ficar visível, e não escondido num menu.
   */
  const [sendingProof, setSendingProof] = useState(false)

  const submitEmailVerification = async () => {
    setSendingProof(true)
    try {
      const res = await authAPI.requestEmailVerification()
      if (res.success) {
        toast.success(res.message || t('settings.security.emailVerifySent'))
        return
      }
      // 503 quando o deploy não tem transporte de correio: a mensagem do
      // backend diz isso, e é melhor que qualquer coisa que a tela invente.
      toast.error(res.message || t('settings.security.emailVerifyFailed'))
    } finally {
      setSendingProof(false)
    }
  }

  const submitChangeEmail = async () => {
    if (!emailForm.currentPassword || !emailForm.email.trim()) {
      toast.error(t('settings.security.emailRequired'))
      return
    }
    const res = await authAPI.changeEmail(emailForm.currentPassword, emailForm.email.trim())
    if (res.success) {
      toast.success(t('settings.security.emailUpdated', { email: res.data?.email ?? emailForm.email.trim() }))
      setEmailForm({ currentPassword: '', email: '' })
      // O endereço novo nasce não provado, e a prova saiu atrás dele. As duas
      // coisas mudam o que esta tela mostra, então ela relê a conta.
      await refreshUser()
      if (res.data?.verificationSent) toast.success(t('settings.security.emailVerifySent'))
      // A conta acabou de deixar de ser uma das que faltam, e o aviso da
      // transição está na mesma tela: sem recarregar, ele seguiria contando
      // quem já cadastrou.
      if (canReadOperators) {
        await refreshEmailReadiness()
        await fetchOperators()
      }
    } else {
      // 401 (senha errada) e 409 (endereço de outra pessoa) chegam com a razão.
      toast.error(res.message || t('settings.security.emailFailed'))
    }
  }

  const submitChangePassword = async () => {
    if (!passwordForm.newPassword || passwordForm.newPassword !== passwordForm.confirmNewPassword) {
      toast.error(t('settings.security.passwordMismatch'))
      return
    }
    const res = await authAPI.changePassword(passwordForm.currentPassword, passwordForm.newPassword)
    if (res.success) {
      toast.success(t('settings.security.passwordUpdated'))
      setPasswordForm({ currentPassword: '', newPassword: '', confirmNewPassword: '' })
      apiClient.clearTokens()
    } else {
      toast.error(res.message || t('settings.security.passwordFailed'))
    }
  }

  const [operators, setOperators] = useState<Operator[]>([])
  const [operatorsLoading, setOperatorsLoading] = useState(false)
  // `null` while the list is fine; otherwise the backend's reason, which may be
  // empty when the request failed without one.
  const [operatorsError, setOperatorsError] = useState<string | null>(null)
  const [creatingOperator, setCreatingOperator] = useState(false)
  const [operatorSaving, setOperatorSaving] = useState(false)
  const [operatorBusyId, setOperatorBusyId] = useState<number | null>(null)
  const [operatorForm, setOperatorForm] = useState<{ username: string; email: string; password: string; role: OperatorRole }>({
    username: '',
    email: '',
    password: '',
    role: 'viewer'
  })
  const [resetPasswordId, setResetPasswordId] = useState<number | null>(null)
  const [resetPasswordValue, setResetPasswordValue] = useState('')

  // A tela não decide nada: quem recusa é o backend, que responde 403 a um
  // `admin` que tente cunhar ou mexer num `owner`. O que ela faz é não oferecer
  // um botão que sempre falharia — e não esconder o papel que a pessoa JÁ tem,
  // senão a linha de um `owner` apareceria com o papel errado no seletor.
  const rolesFor = (current?: OperatorRole) =>
    OPERATOR_ROLES.filter((role) => role !== 'owner' || isOwner || role === current)

  /**
   * Quantas contas ainda entram sem e-mail.
   *
   * É o número que decide quando `LOGIN_REQUIRES_EMAIL` pode ser virado no
   * servidor, e por isso ele mora ao lado da lista de operadores: é a mesma
   * informação, contada. `null` enquanto não se sabe — inclusive para quem não
   * tem `operators.read`, de quem a rota não é pedida.
   */
  const [emailReadiness, setEmailReadiness] = useState<EmailReadiness | null>(null)

  async function refreshEmailReadiness() {
    const res = await authAPI.emailReadiness()
    setEmailReadiness(res.success && res.data ? res.data : null)
  }

  async function fetchOperators() {
    setOperatorsLoading(true)
    const res = await usersAPI.list()
    if (res.success && res.data) {
      setOperators(res.data.users)
      setOperatorsError(null)
    } else {
      setOperators([])
      setOperatorsError(res.message || '')
    }
    setOperatorsLoading(false)
  }

  useEffect(() => {
    if (activeTab === 'security') {
      void fetchOperators()
      // A rota da prontidão exige `operators.read` e responde 403 a quem não
      // tem: pedi-la assim mesmo trocaria um painel ausente por um erro no
      // console de todo `tech` e `viewer` que abrir esta aba.
      if (canReadOperators) void refreshEmailReadiness()
    }
  }, [activeTab, canReadOperators])

  const resetOperatorForm = () => {
    setOperatorForm({ username: '', email: '', password: '', role: 'viewer' })
    setCreatingOperator(false)
  }

  const submitOperator = async () => {
    const username = operatorForm.username.trim()
    if (username.length < 3 || username.length > 64) {
      toast.error(t('settings.operators.usernameLength'))
      return
    }
    if (operatorForm.password.length < 8 || operatorForm.password.length > 128) {
      toast.error(t('settings.operators.passwordLength'))
      return
    }
    const email = operatorForm.email.trim()
    // Frouxa de propósito: quem decide o que é endereço é o servidor, e uma
    // regra mais apertada aqui recusaria e-mail que ele aceitaria. O que se
    // pega é o esquecimento e o erro de digitação óbvio, antes da ida perdida.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error(t('settings.operators.emailInvalid'))
      return
    }
    setOperatorSaving(true)
    try {
      const res = await usersAPI.create({
        username,
        email,
        password: operatorForm.password,
        role: operatorForm.role
      })
      if (res.success) {
        toast.success(t('settings.operators.created', { username }))
        resetOperatorForm()
        await fetchOperators()
        // Uma conta a mais com endereço muda o número da transição.
        if (canReadOperators) await refreshEmailReadiness()
      } else {
        // 400 and 409 carry the reason (duplicate username, invalid input).
        toast.error(res.message || t('settings.operators.createFailed'))
      }
    } finally {
      setOperatorSaving(false)
    }
  }

  const changeOperatorRole = async (operator: Operator, role: OperatorRole) => {
    if (role === operator.role) return
    setOperatorBusyId(operator.id)
    try {
      const res = await usersAPI.update(operator.id, { role })
      const updated = res.success ? res.data?.user : undefined
      if (updated) {
        setOperators((current) => current.map((item) => (item.id === updated.id ? updated : item)))
        toast.success(t('settings.operators.roleUpdated', {
          username: updated.username,
          role: t(ROLE_LABEL_KEYS[updated.role])
        }))
      } else {
        // The backend refuses a demotion that would leave no administrator.
        toast.error(res.message || t('settings.operators.roleFailed'))
      }
    } finally {
      setOperatorBusyId(null)
    }
  }

  const submitOperatorPassword = async (operator: Operator) => {
    if (resetPasswordValue.length < 8 || resetPasswordValue.length > 128) {
      toast.error(t('settings.operators.passwordLength'))
      return
    }
    setOperatorBusyId(operator.id)
    try {
      const res = await usersAPI.update(operator.id, { password: resetPasswordValue })
      if (res.success) {
        toast.success(t('settings.operators.passwordUpdated', { username: operator.username }))
        setResetPasswordId(null)
        setResetPasswordValue('')
      } else {
        toast.error(res.message || t('settings.operators.passwordFailed'))
      }
    } finally {
      setOperatorBusyId(null)
    }
  }

  // Quem perdeu o celular e os códigos. A confirmação nomeia a pessoa e diz o
  // que acontece: o 2FA sai, as sessões caem, e a senha sozinha volta a entrar
  // (num provedor que exige, a pessoa é levada a ativar de novo).
  const resetOperatorMfa = async (operator: Operator) => {
    if (!confirm(t('settings.operators.confirmMfaReset', { username: operator.username }))) return
    setOperatorBusyId(operator.id)
    try {
      const res = await usersAPI.resetMfa(operator.id)
      if (res.success) {
        setOperators((current) => current.map((item) => (item.id === operator.id ? { ...item, mfaEnabled: false } : item)))
        toast.success(t('settings.operators.mfaResetDone', { username: operator.username }))
      } else {
        // Outro provedor, a plataforma, o dono: o servidor explica por quê.
        toast.error(res.message || t('settings.operators.mfaResetFailed'))
      }
    } finally {
      setOperatorBusyId(null)
    }
  }

  const deleteOperator = async (operator: Operator) => {
    if (!confirm(t('settings.operators.confirmDelete', { username: operator.username }))) return
    setOperatorBusyId(operator.id)
    try {
      const res = await usersAPI.remove(operator.id)
      if (res.success) {
        setOperators((current) => current.filter((item) => item.id !== operator.id))
        toast.success(t('settings.operators.deleted', { username: operator.username }))
        // Apagar uma conta sem e-mail é uma das formas de a transição acabar.
        if (canReadOperators) await refreshEmailReadiness()
      } else {
        // Own account or last administrator: the backend explains why.
        toast.error(res.message || t('settings.operators.deleteFailed'))
      }
    } finally {
      setOperatorBusyId(null)
    }
  }

  /**
   * Monta o `secret` do PUT a partir do estado do campo.
   *
   * É aqui que a regra do servidor vira código: omitir a chave mantém o que
   * está guardado, string vazia apaga. Devolver `undefined` e deixar quem chama
   * espalhar condicionalmente é o que garante que "não mexi no campo" nunca
   * chegue ao servidor como "apague".
   */
  const genieAuthSecretPatch = (): string | undefined => {
    if (genieAuthForm.secretPendingClear) return ''
    return genieAuthForm.secret ? genieAuthForm.secret : undefined
  }

  /**
   * `provider` é o Salvar da aba Geral na SaaS: grava só o que aquela aba
   * mostra — o nome e o prazo da trilha. Antes ele gravava todas as chaves,
   * o ACS e ainda disparava a sincronização de IDs de cliente, de outra aba;
   * quando essa falhava, o operador via um erro que não tinha nada com o que
   * ele acabara de editar.
   */
  const handleSaveSettings = async () => {
    // O servidor recusa `basic` sem usuário com 400, e com razão: o header
    // sairia com usuário vazio e o ACS o recusaria sem dizer por quê. Barrar
    // aqui evita a ida perdida e diz qual campo falta, que a resposta não diz.
    if (!genieAcsManaged && genieAuthForm.authType === 'basic' && !genieAuthForm.username.trim()) {
      toast.error(t('settings.genieAuth.usernameRequired'))
      return
    }
    // Mesma ideia, para o primeiro campo numérico livre deste laço: o salvar
    // percorre as chaves e para na primeira recusa com uma mensagem genérica,
    // sem dizer qual campo. Enquanto todo campo vinha de um seletor isso nunca
    // apareceu.
    const prazoRuim = auditRetentionError(settings.auditRetentionDays, retentionCaps?.audit ?? null)
    if (prazoRuim) {
      toast.error(t(prazoRuim))
      return
    }
    setLoading(true)
    loadingCtl.show(t('settings.savingProgress'))
    let ok = true
    try {
      // The provider's name is not a setting any more. It is renamed on its own
      // row, audited, and the context re-reads it so the sidebar follows.
      if (settings.appName.trim() !== tenantName) {
        const renamed = await tenantAPI.rename(settings.appName.trim())
        if (!renamed.success) {
          ok = false
          toast.error(renamed.message || t('settings.saveError'))
          return
        }
        await refreshTenant()
      }
      // Na SaaS a URL do ACS é gravada pelo console; mandá-la daqui seria uma
      // recusa (403) a cada salvar, por um campo que a tela nem deixa editar.
      const entries = Object.entries(settings)
        .filter(([key]) => key !== 'appName' && !(genieAcsManaged && PLATFORM_MANAGED_KEYS.has(key)))
        .sort(([left], [right]) => {
        if (left === 'autoGenerateCustomerId') return 1
        if (right === 'autoGenerateCustomerId') return -1
        return 0
      })
      let successMessage = t('settings.saveSuccess')
      let errorMessage = t('settings.saveError')
      for (const [key, value] of entries) {
        const res = await settingsAPI.update(key, String(value))
        if (!res.success) {
          ok = false
          // A recusa do servidor diz QUAL regra falhou; descartá-la deixava o
          // operador com "não foi possível salvar" e nenhum caminho. Rede de
          // segurança da conferência acima, para o dia em que as duas
          // discordarem.
          errorMessage = res.message || errorMessage
          break
        }
      }

      // O formato da data vale na hora, sem recarregar a página.
      if (ok) setActiveDateFormat(settings.dateFormat)

      if (ok && !genieAcsManaged) {
        // A URL acabou de ser gravada, então é ela que o servidor vai comparar
        // com o endereço testado daqui em diante — o aviso de teste anônimo
        // some sozinho depois de salvar, que é o desfecho que ele pedia.
        setSavedGenieAcsUrl(settings.genieAcsUrl)

        const secret = genieAuthSecretPatch()
        const payload: GenieAcsAuthPayload = {
          authType: genieAuthForm.authType,
          username: genieAuthForm.username.trim(),
          ...(secret !== undefined ? { secret } : {})
        }
        const auth = await settingsAPI.updateGenieAcsAuth(payload)
        if (auth.success && auth.data) {
          setGenieAuthConfig(auth.data)
          setGenieAuthForm({
            authType: auth.data.authType,
            username: auth.data.username,
            secret: '',
            secretPendingClear: false
          })
        } else {
          ok = false
          errorMessage = auth.message || t('settings.genieAuth.saveFailed')
        }
      }

      if (ok && settings.autoGenerateCustomerId === 'true') {
        const sync = await settingsAPI.syncCustomerIds()
        setSyncStatusKey((key) => key + 1)
        if (!sync.success) {
          // As configurações JÁ foram gravadas; o que falhou foi a sincronia
          // com o ACS, que roda depois. Dizer só "não foi possível" fazia
          // parecer que nada tinha sido salvo.
          toast.success(successMessage)
          toast.error(sync.message || t('settings.syncError'))
          return
        } else {
          const result = sync.data as { generated?: number; existing?: number; pending?: number; running?: boolean }
          // Frota grande: o servidor respondeu no prazo e segue gerando em
          // segundo plano. A frase dele já diz isso; não há contagem ainda.
          if (result.running) {
            toast.success(successMessage)
            toast.info(sync.message || t('settings.syncSuccess'))
            return
          }
          successMessage = t('settings.syncSummary', {
            message: sync.message || t('settings.syncSuccess'),
            generated: result.generated || 0,
            existing: result.existing || 0,
          })
        }
      }
      toast[ok ? 'success' : 'error'](ok ? successMessage : errorMessage)
    } finally {
      setLoading(false)
      loadingCtl.hide()
    }
  }

  const [vendorList, setVendorList] = useState<VendorType[]>([])
  const [vendorsLoading, setVendorsLoading] = useState(false)
  /** Não conseguiu carregar — que é diferente de não haver nada cadastrado. */
  const [vendorsError, setVendorsError] = useState<string | null>(null)
  const [creatingVendor, setCreatingVendor] = useState(false)
  const [editingVendor, setEditingVendor] = useState<VendorType | null>(null)

  const [vendorForm, setVendorForm] = useState<{
    name: string
    parameter_prefix: string
    manufacturer_patterns: string
    product_patterns: string
    service_list_path: string
    lan_binding_path: string
    vlan_id_path: string
    wifi_password_path: string
    http_wan_enable_path: string
    firewall_level_path: string
    priority: number
    enabled: number
    description: string
  }>({
    name: '',
    parameter_prefix: '',
    manufacturer_patterns: '',
    product_patterns: '',
    service_list_path: '',
    lan_binding_path: '',
    vlan_id_path: '',
    wifi_password_path: '',
    http_wan_enable_path: '',
    firewall_level_path: '',
    priority: 10,
    enabled: 1,
    description: '',
  })

  const fetchVendors = async () => {
    setVendorsLoading(true)
    const res = await vendorsAPI.getAll()
    if (res.success && Array.isArray(res.data)) {
      setVendorList(res.data as unknown as VendorType[])
      setVendorsError(null)
    } else {
      // Sem isto a tela caía no ramo "nenhum fabricante cadastrado" — afirmando
      // um fato quando na verdade não sabe. Com o backend fora do ar ou um 403,
      // o operador via a tabela vazia e recadastrava o que já existe. A mesma
      // página já fazia certo em `fetchOperators`.
      setVendorsError(res.message || null)
    }
    setVendorsLoading(false)
  }

  useEffect(() => {
    if (activeTab === 'vendors') {
      fetchVendors()
    }
  }, [activeTab])

  const resetVendorForm = () => {
    setVendorForm({
      name: '',
      parameter_prefix: '',
      manufacturer_patterns: '',
      product_patterns: '',
      service_list_path: '',
      lan_binding_path: '',
      vlan_id_path: '',
      wifi_password_path: '',
      http_wan_enable_path: '',
      firewall_level_path: '',
      priority: 10,
      enabled: 1,
      description: '',
    })
    setEditingVendor(null)
    setCreatingVendor(false)
  }

  const submitVendor = async () => {
    const payload: any = {
      name: vendorForm.name,
      parameter_prefix: vendorForm.parameter_prefix || null,
      manufacturer_patterns: vendorForm.manufacturer_patterns.split(',').map(s => s.trim()).filter(Boolean),
      product_patterns: vendorForm.product_patterns.split(',').map(s => s.trim()).filter(Boolean),
      service_list_path: vendorForm.service_list_path || null,
      lan_binding_path: vendorForm.lan_binding_path || null,
      vlan_id_path: vendorForm.vlan_id_path || null,
      wifi_password_path: vendorForm.wifi_password_path || null,
      http_wan_enable_path: vendorForm.http_wan_enable_path || null,
      firewall_level_path: vendorForm.firewall_level_path || null,
      priority: Number(vendorForm.priority) || 10,
      enabled: Number(vendorForm.enabled) ? 1 : 0,
      description: vendorForm.description || null,
    }
    let res
    if (editingVendor) {
      res = await vendorsAPI.update(editingVendor.id, payload)
    } else {
      res = await vendorsAPI.create(payload)
    }
    if (res.success) {
      const msg = editingVendor ? t('settings.vendors.updated') : t('settings.vendors.created')
      toast.success(msg)
      await fetchVendors()
      resetVendorForm()
    } else {
      const msg = res.message || t('settings.operationFailed')
      toast.error(msg)
    }
  }

  const deleteVendor = async (id: number) => {
    const vendor = vendorList.find((item) => item.id === id)
    if (!confirm(t('settings.vendors.confirmDelete', { name: vendor?.name || id }))) return
    const res = await vendorsAPI.delete(id)
    if (res.success) {
      setVendorList(prev => prev.filter(v => v.id !== id))
      toast.success(t('settings.vendors.deleted'))
    } else {
      const msg = res.message || t('settings.vendors.deleteFailed')
      toast.error(msg)
    }
  }

  const [wifiConfigs, setWifiConfigs] = useState<WifiSecurityConfigType[]>([])
  /** Não conseguiu carregar — que é diferente de não haver nada cadastrado. */
  const [wifiConfigError, setWifiConfigError] = useState<string | null>(null)
  const [wifiConfigLoading, setWifiConfigLoading] = useState(false)
  const [creatingConfig, setCreatingConfig] = useState(false)
  const [configForm, setConfigForm] = useState<{ product_class: string; security_types: string; password_param_path: string }>({
    product_class: '',
    security_types: '',
    password_param_path: ''
  })
  const [editingConfig, setEditingConfig] = useState<WifiSecurityConfigType | null>(null)

  const fetchWifiConfigs = async () => {
    setWifiConfigLoading(true)
    const res = await vendorsAPI.getAllWifiSecurityConfigs()
    if (res.success && Array.isArray(res.data)) {
      setWifiConfigs(res.data as unknown as WifiSecurityConfigType[])
      setWifiConfigError(null)
    } else {
      setWifiConfigError(res.message || null)
    }
    setWifiConfigLoading(false)
  }

  useEffect(() => {
    if (activeTab === 'wifi-security') {
      fetchWifiConfigs()
    }
  }, [activeTab])

  const resetConfigForm = () => {
    setConfigForm({ product_class: '', security_types: '', password_param_path: '' })
    setEditingConfig(null)
    setCreatingConfig(false)
  }

  const submitWifiConfig = async () => {
    const payload = {
      product_class: configForm.product_class,
      security_types: configForm.security_types,
      password_param_path: configForm.password_param_path,
    }
    let res
    if (editingConfig) {
      res = await vendorsAPI.updateWifiSecurityConfig(editingConfig.id, payload)
    } else {
      res = await vendorsAPI.createWifiSecurityConfig(payload)
    }
    if (res.success) {
      const msg = editingConfig ? t('settings.wifi.updated') : t('settings.wifi.created')
      toast.success(msg)
      await fetchWifiConfigs()
      resetConfigForm()
    } else {
      const msg = res.message || t('settings.operationFailed')
      toast.error(msg)
    }
  }

  const deleteWifiConfig = async (id: number) => {
    const config = wifiConfigs.find((item) => item.id === id)
    if (!confirm(t('settings.wifi.confirmDelete', { name: config?.product_class || id }))) return
    const res = await vendorsAPI.deleteWifiSecurityConfig(id)
    if (res.success) {
      setWifiConfigs(prev => prev.filter(c => c.id !== id))
      toast.success(t('settings.wifi.deleted'))
    } else {
      const msg = res.message || t('settings.wifi.deleteFailed')
      toast.error(msg)
    }
  }

  /**
   * Volta um perfil ao que está no catálogo padrão da plataforma. Só na SaaS,
   * onde a cópia do provedor nasceu da caixa: na self-hosted não há padrão.
   */
  const resetCatalogueRow = async (kind: 'vendor' | 'wifi', id: number, name: string) => {
    if (!confirm(t('settings.catalogue.resetConfirm', { name }))) return
    const res = kind === 'vendor'
      ? await vendorsAPI.reset(id)
      : await vendorsAPI.resetWifiSecurityConfig(id)
    if (res.success) {
      toast.success(res.message || t('settings.catalogue.resetDone'))
      if (kind === 'vendor') await fetchVendors()
      else await fetchWifiConfigs()
    } else {
      toast.error(res.message || t('settings.operationFailed'))
    }
  }

  // Nome, idioma e prazo da trilha: o que a aba "Painel e ACS" tem do provedor,
  // na self-hosted e na SaaS.
  const identityFields = (
    <>
      <div>
        <label htmlFor="application-name" className="field-label">{t('settings.general.appName')}</label>
        <input
          id="application-name"
          type="text"
          value={settings.appName}
          onChange={(e) => setSettings({...settings, appName: e.target.value})}
          className="modern-input w-full"
        />
      </div>
      <div>
        <p className="field-label">{t('settings.general.language')}</p>
        <LanguageSwitcher className="w-full sm:w-72" />
        <p className="field-hint">{t('settings.general.languageHint')}</p>
      </div>
      <div>
        <label htmlFor="date-format" className="field-label">{t('settings.general.dateFormat')}</label>
        <select
          id="date-format"
          className="modern-input w-full sm:w-72"
          value={settings.dateFormat}
          onChange={(e) => setSettings({ ...settings, dateFormat: e.target.value })}
        >
          {DATE_FORMATS.map((format: DateFormat) => (
            <option key={format} value={format}>
              {format === 'auto'
                ? t('settings.general.dateFormatAuto', { example: dateFormatExample('auto', intlLocale) })
                : `${dateFormatLabel(format, t('settings.general.dateFormatTokens'))} — ${dateFormatExample(format, intlLocale)}`}
            </option>
          ))}
        </select>
        <p className="field-hint">{t('settings.general.dateFormatHint')}</p>
      </div>
    </>
  )

  const auditRetentionSection = (
    <>
    {/* O prazo da trilha.
        Aqui e não na aba "Acesso da conta": aquela é sobre a conta de
        QUEM ESTÁ USANDO o painel — trocar o próprio usuário, a
        própria senha — e tem botões de salvar próprios. Este é
        política do provedor, gravado pelo mesmo Salvar que grava o
        resto desta aba.

        Os dois limites da ajuda não são enfeite: o servidor recusa
        fora deles, e dizer os números aqui é o que evita a ida
        perdida. */}
    <div className="mt-6 border-t border-border pt-6">
      <h3 className="font-semibold">{t('settings.audit.title')}</h3>
      <p className="field-hint mb-4 mt-1">{t('settings.audit.description')}</p>
      <div className="max-w-xs">
        <label htmlFor="audit-retention" className="field-label">
          {t('settings.audit.retention')}
        </label>
        <input
          id="audit-retention"
          type="number"
          min={30}
          max={retentionCaps?.audit ?? 3650}
          step={1}
          className="modern-input w-full"
          value={settings.auditRetentionDays}
          onChange={(event) => setSettings((current) => ({
            ...current,
            auditRetentionDays: event.target.value
          }))}
        />
        <p className="field-hint">{t('settings.audit.retentionHint')}</p>
        {retentionCaps?.audit != null && (
          <p className="field-hint">{t('settings.retentionCap', { max: retentionCaps.audit })}</p>
        )}
      </div>
    </div>
    </>
  )

  // O papel, as ações e a troca de senha de um operador aparecem no cartão
  // (celular) e na linha da tabela (desktop); o sufixo mantém os ids únicos,
  // já que as duas listas existem no DOM ao mesmo tempo.
  const renderOperatorRole = (operator: Operator, lockedByOwner: boolean, largura: string) => (
    <>
      <select
        value={operator.role}
        disabled={operatorBusyId === operator.id || lockedByOwner}
        onChange={(e) => void changeOperatorRole(operator, e.target.value as OperatorRole)}
        className={`modern-input ${largura}`}
        aria-label={t('settings.operators.roleFor', { username: operator.username })}
      >
        {rolesFor(operator.role).map((role) => (
          <option key={role} value={role}>{t(ROLE_LABEL_KEYS[role])}</option>
        ))}
      </select>
      <p className="field-hint max-w-60">
        {lockedByOwner
          ? t('settings.operators.ownerLocked')
          : t(ROLE_SUMMARY_KEYS[operator.role])}
      </p>
    </>
  )

  const renderOperatorActions = (operator: Operator, isSelf: boolean) => (
    <div className="flex shrink-0 items-center gap-1 md:gap-2">
      {canOfferPasswordReset(operator, { isOwner, isSelf }) && (
        <button
          onClick={() => {
            setResetPasswordId((current) => (current === operator.id ? null : operator.id))
            setResetPasswordValue('')
          }}
          className={`${ICON_ACTION} text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300`}
          title={t('settings.operators.resetPassword')}
          aria-label={t('settings.operators.resetPasswordFor', { username: operator.username })}
        >
          <Icon name="lock" size={18} />
        </button>
      )}
      {canOfferMfaReset(operator, { isSelf, isOwner }) && (
        <button
          onClick={() => void resetOperatorMfa(operator)}
          disabled={operatorBusyId === operator.id}
          className={`${ICON_ACTION} text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300`}
          title={t('settings.operators.mfaReset')}
          aria-label={t('settings.operators.mfaResetFor', { username: operator.username })}
        >
          <Icon name="phone" size={18} />
        </button>
      )}
      <button
        onClick={() => void deleteOperator(operator)}
        disabled={operatorBusyId === operator.id}
        className={`${ICON_ACTION} text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300`}
        title={t('common.delete')}
        aria-label={t('settings.operators.deleteFor', { username: operator.username })}
      >
        <Icon name="trash" size={18} />
      </button>
    </div>
  )

  const renderOperatorPasswordForm = (operator: Operator, sufixo: string) => (
    <>
      <div className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center">
        <label className="text-sm font-medium" htmlFor={`operator-new-password-${sufixo}-${operator.id}`}>
          {t('settings.operators.newPassword')}
        </label>
        <input
          id={`operator-new-password-${sufixo}-${operator.id}`}
          type="password"
          value={resetPasswordValue}
          onChange={(e) => setResetPasswordValue(e.target.value)}
          className="modern-input sm:w-72"
          autoComplete="new-password"
          placeholder={t('settings.operators.passwordPlaceholder')}
        />
        <button
          onClick={() => void submitOperatorPassword(operator)}
          disabled={operatorBusyId === operator.id}
          className="modern-button"
        >
          {t('settings.operators.savePassword')}
        </button>
        <button
          onClick={() => { setResetPasswordId(null); setResetPasswordValue('') }}
          className="modern-button-secondary"
        >
          {t('common.cancel')}
        </button>
      </div>
      <p className="field-hint">{t('settings.operators.resetPasswordHint')}</p>
    </>
  )

  const renderVendorActions = (v: VendorType) => (
    <div className="flex shrink-0 items-center gap-1 md:gap-2">
      <button
        onClick={() => {
          setEditingVendor(v)
          setCreatingVendor(true)
          setVendorForm({
            name: v.name,
            parameter_prefix: v.parameter_prefix || '',
            manufacturer_patterns: (v.manufacturer_patterns || []).join(','),
            product_patterns: (v.product_patterns || []).join(','),
            service_list_path: v.service_list_path || '',
            lan_binding_path: v.lan_binding_path || '',
            vlan_id_path: v.vlan_id_path || '',
            wifi_password_path: v.wifi_password_path || '',
            http_wan_enable_path: v.http_wan_enable_path || '',
            firewall_level_path: v.firewall_level_path || '',
            priority: v.priority,
            enabled: v.enabled,
            description: v.description || ''
          })
        }}
        className={`${ICON_ACTION} text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300`}
        title={t('common.edit')}
        aria-label={t('common.edit')}
      >
        <Icon name="edit" size={18} />
      </button>
      {platformManaged && (
        <button
          onClick={() => void resetCatalogueRow('vendor', v.id, v.name)}
          className={`${ICON_ACTION} text-muted-foreground hover:text-foreground`}
          title={t('settings.catalogue.reset')}
          aria-label={t('settings.catalogue.reset')}
        >
          <Icon name="refresh" size={18} />
        </button>
      )}
      <button
        onClick={() => deleteVendor(v.id)}
        className={`${ICON_ACTION} text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300`}
        title={t('common.delete')}
        aria-label={t('common.delete')}
      >
        <Icon name="trash" size={18} />
      </button>
    </div>
  )

  // Ações em texto: no celular ganham a altura de toque; no lg voltam a links.
  const WIFI_ACTION = 'min-h-10 px-1 font-medium text-sm lg:min-h-0 lg:px-0'
  const renderWifiActions = (cfg: WifiSecurityConfigType) => (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={() => {
          setEditingConfig(cfg);
          setCreatingConfig(false);
          setConfigForm({
            product_class: cfg.product_class,
            security_types: cfg.security_types,
            password_param_path: cfg.password_param_path
          })
        }}
        className={`${WIFI_ACTION} text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300`}
      >
        {t('common.edit')}
      </button>
      {platformManaged && (
        <button
          onClick={() => void resetCatalogueRow('wifi', cfg.id, cfg.product_class)}
          className={`${WIFI_ACTION} text-muted-foreground hover:text-foreground`}
        >
          {t('settings.catalogue.reset')}
        </button>
      )}
      <button
        onClick={() => deleteWifiConfig(cfg.id)}
        className={`${WIFI_ACTION} text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300`}
      >
        {t('common.delete')}
      </button>
    </div>
  )

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <p className="page-kicker">{t('settings.kicker')}</p>
            <h1 className="page-title">{t('settings.title')}</h1>
            <p className="page-description">{t('settings.description')}</p>
          </div>
        </header>

        <div className="mb-6">
          <div ref={tabRailRef} className="tab-rail" role="tablist" aria-label={t('settings.sectionsAria')}>
            {canEditProvider && (
              <button
                onClick={() => setActiveTab('provider')}
                className="tab-button"
                data-active={activeTab === 'provider'}
                role="tab"
                aria-selected={activeTab === 'provider'}
              >
                {t('settings.tab.provider')}
              </button>
            )}
            {/* Na SaaS o ACS costuma ser da plataforma: "Painel e ACS" o mostra
                só para leitura, e os parâmetros TR-069 só existem para quem os
                configura — a self-hosted, a caixa da plataforma e o provedor
                que o console marcou como dono do próprio servidor. */}
            <button
              onClick={() => setActiveTab('general')}
              className="tab-button"
              data-active={activeTab === 'general'}
              role="tab"
              aria-selected={activeTab === 'general'}
            >
              {t('settings.tab.general')}
            </button>
            {!genieAcsManaged && (
              <button
                onClick={() => setActiveTab('virtual-params')}
                className="tab-button"
                data-active={activeTab === 'virtual-params'}
                role="tab"
                aria-selected={activeTab === 'virtual-params'}
              >
                {t('settings.tab.virtualParams')}
              </button>
            )}
            <button
              onClick={() => setActiveTab('customer-portal')}
              className="tab-button"
              data-active={activeTab === 'customer-portal'}
              role="tab"
              aria-selected={activeTab === 'customer-portal'}
            >
              {t('settings.tab.customerPortal')}
            </button>
            {/* As integrações (SGP, TeiaH, WhatsApp, chatbot) moram numa aba
                só, em cards; a trilha a acende enquanto uma delas está aberta. */}
            <button
              onClick={() => setActiveTab('integrations')}
              className="tab-button"
              data-active={activeTab === 'integrations' || INTEGRATION_TABS.includes(activeTab)}
              role="tab"
              aria-selected={activeTab === 'integrations' || INTEGRATION_TABS.includes(activeTab)}
            >
              {t('settings.tab.integrations')}
            </button>
            <button
              onClick={() => setActiveTab('provisioning')}
              className="tab-button"
              data-active={activeTab === 'provisioning'}
              role="tab"
              aria-selected={activeTab === 'provisioning'}
            >
              {t('settings.tab.provisioning')}
            </button>
            <button
              onClick={() => setActiveTab('security')}
              className="tab-button"
              data-active={activeTab === 'security'}
              role="tab"
              aria-selected={activeTab === 'security'}
            >
              {t('settings.tab.security')}
            </button>
            <button
              onClick={() => setActiveTab('vendors')}
              className="tab-button"
              data-active={activeTab === 'vendors'}
              role="tab"
              aria-selected={activeTab === 'vendors'}
            >
              {t('settings.tab.vendors')}
            </button>
            <button
              onClick={() => setActiveTab('wifi-security')}
              className="tab-button"
              data-active={activeTab === 'wifi-security'}
              role="tab"
              aria-selected={activeTab === 'wifi-security'}
            >
              {t('settings.tab.wifiSecurity')}
            </button>
            {/* Switching databases wipes the target; the SaaS edition does not
                mount the route, so it does not show the tab either. */}
            {!isSaas && (
              <button
                onClick={() => setActiveTab('database')}
                className="tab-button"
                data-active={activeTab === 'database'}
                role="tab"
                aria-selected={activeTab === 'database'}
              >
                {t('settings.tab.database')}
              </button>
            )}
            <button
              onClick={() => setActiveTab('about')}
              className="tab-button"
              data-active={activeTab === 'about'}
              role="tab"
              aria-selected={activeTab === 'about'}
            >
              {t('settings.tab.about')}
            </button>
          </div>
        </div>

        {/* Content */}
        {activeTab === 'integrations' && (
          <IntegrationsHub
            onOpen={setActiveTab}
            canTeiah={can('teiah.read')}
            canFocusChat={can('settings.write')}
            canChatbot={can('whatsapp.config')}
          />
        )}
        {INTEGRATION_TABS.includes(activeTab) && (
          <button
            type="button"
            onClick={() => setActiveTab('integrations')}
            className="mb-4 inline-flex min-h-10 items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground lg:min-h-0"
          >
            <Icon name="chevron-left" size={16} />
            {t('settings.integrations.back')}
          </button>
        )}
        {activeTab === 'provider' && canEditProvider && (
          <div className="space-y-6">
            <ProviderAddressPanel />
          </div>
        )}

        {activeTab === 'general' && (
          <div className="space-y-6">
            {/* App Settings */}
            <div className="modern-card max-w-3xl p-5 sm:p-6">
              <h2 className="section-heading">{t('settings.general.title')}</h2>
              <p className="section-description mb-6">{t('settings.general.description')}</p>
              <div className="space-y-4">
                {identityFields}
                {genieAcsManaged ? (
                  /* Na SaaS quem aponta este painel para o ACS é a plataforma,
                     pelo console. O provedor vê para onde aponta e se responde
                     — que é o que ele precisa saber quando as ONTs somem —,
                     e o teste usa o endereço gravado, não um digitado. */
                  <div className="rounded-md border border-border bg-muted/40 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="field-label">{t('settings.general.genieAcsUrl')}</p>
                        <p className="break-all font-mono text-sm text-foreground">
                          {settings.genieAcsUrl || t('settings.platformManaged.notConfigured')}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">
                          {t('settings.genieAuth.title')}: {t(GENIE_AUTH_TYPE_LABELS[genieAuthConfig?.authType ?? 'none'])}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleTestConnection}
                        disabled={loading || !settings.genieAcsUrl}
                        className="modern-button"
                      >
                        {loading ? t('settings.general.testing') : t('settings.general.testConnection')}
                      </button>
                    </div>
                    <p className="field-hint mt-3 flex items-center gap-2">
                      <Icon name="lock" size={14} />
                      {t('settings.platformManaged.genieAcs')}
                    </p>
                  </div>
                ) : (
                <>
                <div>
                  <label htmlFor="genieacs-url" className="field-label">{t('settings.general.genieAcsUrl')}</label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id="genieacs-url"
                    type="url"
                    placeholder="http://127.0.0.1:7557"
                    value={settings.genieAcsUrl}
                    onChange={(e) => setSettings({...settings, genieAcsUrl: e.target.value})}
                    className="modern-input flex-1"
                    />
                    <button
                      onClick={handleTestConnection}
                      disabled={loading}
                      className="modern-button"
                    >
                      {loading ? t('settings.general.testing') : t('settings.general.testConnection')}
                    </button>
                  </div>
                  <p className="field-hint">{t('settings.general.urlHint', { path: '/devices' })}</p>
                  {genieTestGoesAnonymous && (
                    <p className="mt-2 rounded-md border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] p-3 text-sm text-foreground">
                      <Icon name="warning" size={16} className="me-2 inline align-[-3px]" />
                      {t('settings.genieAuth.anonymousTestWarning')}
                    </p>
                  )}
                </div>

                <div className="border-t border-border pt-4">
                  <h3 className="font-semibold">{t('settings.genieAuth.title')}</h3>
                  <p className="field-hint mt-1 mb-4">{t('settings.genieAuth.description')}</p>

                  <div className="space-y-4">
                    <div>
                      <label htmlFor="genieacs-auth-type" className="field-label">{t('settings.genieAuth.type')}</label>
                      <select
                        id="genieacs-auth-type"
                        className="modern-input w-full sm:w-72"
                        value={genieAuthForm.authType}
                        onChange={(event) => setGenieAuthForm((current) => ({
                          ...current,
                          authType: event.target.value as GenieAcsAuthType
                        }))}
                      >
                        {(genieAuthConfig?.authTypes ?? ['none', 'basic', 'bearer'])
                          .filter((type) => GENIE_AUTH_TYPE_LABELS[type])
                          .map((type) => (
                            <option key={type} value={type}>{t(GENIE_AUTH_TYPE_LABELS[type])}</option>
                          ))}
                      </select>
                      <p className="field-hint">{t('settings.genieAuth.typeHint')}</p>
                    </div>

                    {genieAuthForm.authType !== 'none' && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        {/* `bearer` não tem usuário: o token é a credencial inteira. */}
                        {genieAuthForm.authType === 'basic' && (
                          <div>
                            <label htmlFor="genieacs-auth-username" className="field-label">
                              {t('settings.genieAuth.username')}
                            </label>
                            <input
                              id="genieacs-auth-username"
                              type="text"
                              className="modern-input w-full"
                              value={genieAuthForm.username}
                              onChange={(event) => setGenieAuthForm((current) => ({
                                ...current,
                                username: event.target.value
                              }))}
                            />
                            <p className="field-hint">{t('settings.genieAuth.usernameHint')}</p>
                          </div>
                        )}

                        <div>
                          <label htmlFor="genieacs-auth-secret" className="field-label">
                            {t(genieAuthForm.authType === 'basic'
                              ? 'settings.genieAuth.password'
                              : 'settings.genieAuth.token')}
                          </label>
                          <input
                            id="genieacs-auth-secret"
                            type="password"
                            autoComplete="new-password"
                            className="modern-input w-full"
                            disabled={genieAuthForm.secretPendingClear}
                            placeholder={t(genieAuthConfig?.secretConfigured
                              ? 'settings.genieAuth.placeholderStored'
                              : 'settings.genieAuth.placeholderEmpty')}
                            value={genieAuthForm.secret}
                            onChange={(event) => setGenieAuthForm((current) => ({
                              ...current,
                              secret: event.target.value
                            }))}
                          />
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className={GENIE_SECRET_STATE_BADGES[genieSecretState]}>
                              {t(GENIE_SECRET_STATE_LABELS[genieSecretState])}
                            </span>
                            {/* Limpar é sempre um pedido explícito, nunca o efeito de deixar o campo em branco. */}
                            {genieAuthForm.secretPendingClear ? (
                              <button
                                type="button"
                                className="modern-button-secondary"
                                onClick={() => setGenieAuthForm((current) => ({
                                  ...current,
                                  secretPendingClear: false
                                }))}
                              >
                                {t('settings.genieAuth.undoClear')}
                              </button>
                            ) : genieAuthConfig?.secretConfigured && (
                              <button
                                type="button"
                                className="modern-button-secondary"
                                onClick={() => setGenieAuthForm((current) => ({
                                  ...current,
                                  secret: '',
                                  secretPendingClear: true
                                }))}
                              >
                                {t('settings.genieAuth.clear')}
                              </button>
                            )}
                          </div>
                          <p className="field-hint mt-2">{t('settings.genieAuth.secretHint')}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                </>
                )}
              </div>

              {auditRetentionSection}

              {testResult && (
                <div className={`mt-4 p-4 rounded-md ${
                  testResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800'
                }`}>
                  <div className="flex items-center">
                    <Icon name={testResult.success ? 'check' : 'x'} size={18} className="me-2" />
                    <span className="font-medium">{testResult.message}</span>
                    {testResult.deviceCount && (
                      <span className="ms-2 text-sm">
                        {t('settings.general.devicesFound', { count: testResult.deviceCount })}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Logo abaixo do endereço do GenieACS, porque é a outra metade da
                mesma pergunta: com o modo Agente, o painel não usa o endereço
                acima — quem fala com o GenieACS é o agente, na rede dele. */}
            <GenieAcsConnectionCard canWrite={can('settings.write')} />

            {/* Os firmwares do GenieACS: quem pode mandar firmware para a ONT
                (`devices.maintain`) pode também subir e apagar o arquivo. */}
            {can('devices.maintain') && <FirmwareFilesCard />}
          </div>
        )}

        {activeTab === 'virtual-params' && !genieAcsManaged && (
          <div className="modern-card p-5 sm:p-6">
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="section-heading">{t('settings.vp.title')}</h2>
                <p className="section-description mt-1">
                  {t('settings.vp.description', { repo: 'skydashnet/genieacs-installer' })}
                </p>
              </div>
              <button
                type="button"
                className="modern-button-secondary shrink-0"
                onClick={() => setSettings((current) => ({ ...current, ...INSTALLER_VIRTUAL_PARAMETERS }))}
              >
                <Icon name="refresh" size={17} />
                {t('settings.vp.usePreset')}
              </button>
            </div>
            <div className="mb-6 rounded-md border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] p-4 text-sm text-foreground">
              {t('settings.vp.readOnlyNotice')}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {VIRTUAL_PARAMETER_FIELDS.map((field) => (
                <div key={field.key}>
                  <label htmlFor={field.key} className="field-label">
                    {t(field.labelKey)}
                  </label>
                  <input
                    id={field.key}
                    type="text"
                    value={settings[field.key]}
                    placeholder={field.hintKey ? t('settings.vp.optionalPlaceholder') : undefined}
                    onChange={(e) => setSettings({...settings, [field.key]: e.target.value})}
                    className="modern-input w-full font-mono text-sm"
                  />
                  <p className="field-hint">{field.hintKey ? t(field.hintKey) : field.parameterName}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'customer-portal' && (
          <div className="modern-card max-w-3xl p-5 sm:p-6">
            <p className="page-kicker">{t('settings.portal.kicker')}</p>
            <h2 className="section-heading">{t('settings.portal.title')}</h2>
            <p className="section-description mb-6">
              {t('settings.portal.description', { port: '5891' })}
            </p>

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                checked={settings.autoGenerateCustomerId === 'true'}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  autoGenerateCustomerId: event.target.checked ? 'true' : 'false'
                }))}
              />
              <span>
                <span className="block font-semibold">{t('settings.portal.autoGenerate')}</span>
                <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                  {t('settings.portal.autoGenerateHint', { format: 'CSG-XXXXXXX-XXXXXX' })}
                </span>
              </span>
            </label>

            <CustomerIdSyncStatusPanel canWrite={can('settings.write')} refreshKey={syncStatusKey} />

            <div className="mt-5 grid gap-5 rounded-md border border-border p-4 sm:grid-cols-2">
              <fieldset>
                <legend className="field-label">{t('settings.portal.prefixLegend')}</legend>
                <div className="space-y-2">
                  <label className="flex min-h-10 items-center gap-2 text-sm lg:min-h-0">
                    <input type="radio" name="customer-prefix" value="default"
                      checked={settings.customerIdPrefixMode === 'default'}
                      onChange={() => setSettings((current) => ({ ...current, customerIdPrefixMode: 'default' }))} />
                    {t('settings.portal.prefixDefault')} <span className="font-mono font-semibold">CSG</span>
                  </label>
                  <label className="flex min-h-10 items-center gap-2 text-sm lg:min-h-0">
                    <input type="radio" name="customer-prefix" value="company"
                      checked={settings.customerIdPrefixMode === 'company'}
                      onChange={() => setSettings((current) => ({ ...current, customerIdPrefixMode: 'company' }))} />
                    {t('settings.portal.prefixCompany')}
                  </label>
                  {settings.customerIdPrefixMode === 'company' && (
                    <input
                      aria-label={t('settings.portal.companyIdAria')}
                      className="modern-input mt-2 font-mono uppercase"
                      minLength={2}
                      maxLength={4}
                      pattern="[A-Za-z]{2,4}"
                      value={settings.customerIdCompanyPrefix}
                      onChange={(event) => setSettings((current) => ({
                        ...current,
                        customerIdCompanyPrefix: event.target.value.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 4)
                      }))}
                      placeholder="ISP"
                    />
                  )}
                </div>
                <p className="field-hint">{t('settings.portal.prefixHint')}</p>
              </fieldset>

              <fieldset>
                <legend className="field-label">{t('settings.portal.suffixLegend')}</legend>
                <div className="space-y-2">
                  <label className="flex min-h-10 items-center gap-2 text-sm lg:min-h-0">
                    <input type="radio" name="customer-suffix" value="random"
                      checked={settings.customerIdSuffixMode === 'random'}
                      onChange={() => setSettings((current) => ({ ...current, customerIdSuffixMode: 'random' }))} />
                    {t('settings.portal.suffixRandom')}
                  </label>
                  <label className="flex min-h-10 items-center gap-2 text-sm lg:min-h-0">
                    <input type="radio" name="customer-suffix" value="installation_date"
                      checked={settings.customerIdSuffixMode === 'installation_date'}
                      onChange={() => setSettings((current) => ({ ...current, customerIdSuffixMode: 'installation_date' }))} />
                    {t('settings.portal.suffixDate')} <span className="font-mono text-xs text-muted-foreground">YYMMDD</span>
                  </label>
                </div>
                <p className="field-hint">{t('settings.portal.suffixHint')}</p>
              </fieldset>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-border p-4">
                <p className="metric-label">{t('settings.portal.loginTitle')}</p>
                <p className="mt-2 text-sm font-semibold">{t('settings.portal.loginValue')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('settings.portal.loginHint')}</p>
              </div>
              <div className="rounded-md border border-border p-4">
                <p className="metric-label">{t('settings.portal.identityTitle')}</p>
                <p className="mt-2 text-sm font-semibold">{t('settings.portal.identityValue')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('settings.portal.identityHint')}</p>
              </div>
            </div>

            <div className="mt-5 rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/10 p-4 text-sm leading-6">
              {t('settings.portal.disabledNotice')}
            </div>

            <div className="mt-5 rounded-md border border-border p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                  checked={settings.portalShowProviderContact === 'true'}
                  onChange={(event) => setSettings((current) => ({
                    ...current,
                    portalShowProviderContact: event.target.checked ? 'true' : 'false'
                  }))}
                />
                <span>
                  <span className="block font-semibold">{t('settings.portal.contactShow')}</span>
                  <span className="mt-1 block text-sm leading-6 text-muted-foreground">{t('settings.portal.contactShowHint')}</span>
                </span>
              </label>
              {settings.portalShowProviderContact === 'true' && (
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <label htmlFor="portal-contact-phone" className="field-label">{t('settings.portal.contactPhone')}</label>
                    <input id="portal-contact-phone" type="tel" inputMode="tel" maxLength={25} className="modern-input w-full"
                      placeholder="(93) 3518-0000" value={settings.portalContactPhone}
                      onChange={(event) => setSettings((current) => ({ ...current, portalContactPhone: event.target.value }))} />
                  </div>
                  <div>
                    <label htmlFor="portal-contact-whatsapp" className="field-label">{t('settings.portal.contactWhatsapp')}</label>
                    <input id="portal-contact-whatsapp" type="tel" inputMode="tel" maxLength={25} className="modern-input w-full"
                      placeholder="(93) 99100-2222" value={settings.portalContactWhatsapp}
                      onChange={(event) => setSettings((current) => ({ ...current, portalContactWhatsapp: event.target.value }))} />
                  </div>
                  <div>
                    <label htmlFor="portal-contact-email" className="field-label">{t('settings.portal.contactEmail')}</label>
                    <input id="portal-contact-email" type="email" maxLength={254} className="modern-input w-full"
                      placeholder="suporte@provedor.com.br" value={settings.portalContactEmail}
                      onChange={(event) => setSettings((current) => ({ ...current, portalContactEmail: event.target.value }))} />
                  </div>
                  <p className="field-hint sm:col-span-3">{t('settings.portal.contactFieldsHint')}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'sgp' && (
          <div className="modern-card max-w-3xl p-5 sm:p-6">
            <p className="page-kicker">{t('settings.sgp.kicker')}</p>
            <h2 className="section-heading">{t('settings.sgp.title')}</h2>
            <p className="section-description mb-6">
              {t('settings.sgp.description', { path: '/api/ura/' })}
            </p>

            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className={sgpConfig?.ready ? 'modern-badge-success' : 'modern-badge'}>
                {t(sgpConfig?.ready ? 'settings.sgp.statusActive' : 'settings.sgp.statusInactive')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(sgpConfig?.tokenConfigured ? 'settings.sgp.tokenStored' : 'settings.sgp.tokenMissing')}
                {sgpConfig?.updatedAt
                  ? ` · ${t('settings.sgp.updatedAt', { time: formatDateTime(sgpConfig.updatedAt) })}`
                  : ''}
              </span>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="sgp-base-url" className="field-label">{t('settings.sgp.baseUrl')}</label>
                <input
                  id="sgp-base-url"
                  type="url"
                  className="modern-input w-full"
                  placeholder="https://provedor.sgp.net.br"
                  value={sgpForm.baseUrl}
                  onChange={(event) => setSgpForm((current) => ({ ...current, baseUrl: event.target.value }))}
                />
                <p className="field-hint">{t('settings.sgp.baseUrlHint')}</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="sgp-app" className="field-label">{t('settings.sgp.app')}</label>
                  <input
                    id="sgp-app"
                    type="text"
                    className="modern-input w-full"
                    placeholder="nome-do-app"
                    value={sgpForm.app}
                    onChange={(event) => setSgpForm((current) => ({ ...current, app: event.target.value }))}
                  />
                  <p className="field-hint">{t('settings.sgp.appHint')}</p>
                </div>
                <div>
                  <label htmlFor="sgp-token" className="field-label">{t('settings.sgp.token')}</label>
                  <input
                    id="sgp-token"
                    type="password"
                    autoComplete="new-password"
                    className="modern-input w-full"
                    placeholder={t(sgpConfig?.tokenConfigured ? 'settings.sgp.tokenPlaceholderStored' : 'settings.sgp.tokenPlaceholderEmpty')}
                    value={sgpForm.token}
                    onChange={(event) => setSgpForm((current) => ({ ...current, token: event.target.value }))}
                  />
                  <p className="field-hint">{t('settings.sgp.tokenHint')}</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="sgp-link-mode" className="field-label">{t('settings.sgp.linkMode')}</label>
                  <select
                    id="sgp-link-mode"
                    className="modern-input w-full"
                    value={sgpForm.linkMode}
                    onChange={(event) => setSgpForm((current) => ({
                      ...current,
                      linkMode: event.target.value as SgpConfig['linkMode']
                    }))}
                  >
                    <option value="pppoe">{t('settings.sgp.linkModePppoe')}</option>
                    <option value="customer_id">{t('settings.sgp.linkModeCustomerId')}</option>
                    <option value="manual">{t('settings.sgp.linkModeManual')}</option>
                  </select>
                  <p className="field-hint">{t('settings.sgp.linkModeHint')}</p>
                </div>
                <div>
                  <label htmlFor="sgp-invoice-limit" className="field-label">{t('settings.sgp.invoiceLimit')}</label>
                  <input
                    id="sgp-invoice-limit"
                    type="number"
                    min={1}
                    max={24}
                    className="modern-input w-full"
                    value={sgpForm.invoiceLimit}
                    onChange={(event) => setSgpForm((current) => ({
                      ...current,
                      invoiceLimit: Number(event.target.value) || 1
                    }))}
                  />
                  <p className="field-hint">{t('settings.sgp.invoiceLimitHint')}</p>
                </div>
              </div>

              <div className="space-y-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                    checked={sgpForm.enabled}
                    onChange={(event) => setSgpForm((current) => ({ ...current, enabled: event.target.checked }))}
                  />
                  <span>
                    <span className="block font-semibold">{t('settings.sgp.enable')}</span>
                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                      {t('settings.sgp.enableHint')}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                    checked={sgpForm.portalBilling}
                    onChange={(event) => setSgpForm((current) => ({ ...current, portalBilling: event.target.checked }))}
                  />
                  <span>
                    <span className="block font-semibold">{t('settings.sgp.portalBilling')}</span>
                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                      {t('settings.sgp.portalBillingHint')}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                    checked={sgpForm.portalUnlock}
                    onChange={(event) => setSgpForm((current) => ({ ...current, portalUnlock: event.target.checked }))}
                  />
                  <span>
                    <span className="block font-semibold">{t('settings.sgp.portalUnlock')}</span>
                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                      {t('settings.sgp.portalUnlockHint')}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                    checked={sgpForm.ticketEnabled}
                    onChange={(event) => setSgpForm((current) => ({ ...current, ticketEnabled: event.target.checked }))}
                  />
                  <span>
                    <span className="block font-semibold">{t('settings.sgp.ticket')}</span>
                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                      {t('settings.sgp.ticketHint')}
                    </span>
                  </span>
                </label>
              </div>

              {sgpForm.ticketEnabled && (
                <div>
                  <label htmlFor="sgp-occurrence-type" className="field-label">
                    {t('settings.sgp.ticketOccurrenceType')}
                  </label>
                  <input
                    id="sgp-occurrence-type"
                    type="number"
                    min={1}
                    className="modern-input w-full"
                    value={sgpForm.ticketOccurrenceType}
                    onChange={(event) => setSgpForm((current) => ({
                      ...current,
                      ticketOccurrenceType: Number(event.target.value) || 1
                    }))}
                  />
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {t('settings.sgp.ticketOccurrenceTypeHint')}
                  </p>
                </div>
              )}

              <fieldset className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
                <legend className="px-1 font-semibold">{t('settings.sgp.settle')}</legend>
                <p className="text-sm leading-6 text-muted-foreground sm:col-span-2">{t('settings.sgp.settleHint')}</p>
                <div>
                  <label htmlFor="sgp-settle-point" className="field-label">{t('settings.sgp.settleReceivingPoint')}</label>
                  <input
                    id="sgp-settle-point"
                    type="number"
                    min={0}
                    className="modern-input w-full"
                    value={sgpForm.settleReceivingPoint || ''}
                    onChange={(event) => setSgpForm((current) => ({ ...current, settleReceivingPoint: Math.max(Number(event.target.value) || 0, 0) }))}
                  />
                </div>
                <div>
                  <label htmlFor="sgp-settle-fees" className="field-label">{t('settings.sgp.settleFees')}</label>
                  <input
                    id="sgp-settle-fees"
                    type="number"
                    min={0}
                    step="0.01"
                    className="modern-input w-full"
                    value={sgpForm.settleFees}
                    onChange={(event) => setSgpForm((current) => ({ ...current, settleFees: Math.max(Number(event.target.value) || 0, 0) }))}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="sgp-settle-methods" className="field-label">{t('settings.sgp.settlePaymentMethods')}</label>
                  <input
                    id="sgp-settle-methods"
                    type="text"
                    className="modern-input w-full"
                    value={sgpForm.settlePaymentMethods}
                    onChange={(event) => setSgpForm((current) => ({ ...current, settlePaymentMethods: event.target.value }))}
                  />
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('settings.sgp.settlePaymentMethodsHint')}</p>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="sgp-settle-path" className="field-label">{t('settings.sgp.settlePath')}</label>
                  <input
                    id="sgp-settle-path"
                    type="text"
                    className="modern-input w-full font-mono"
                    value={sgpForm.settlePath}
                    placeholder="/api/banco/titulo/{id}/baixar/"
                    onChange={(event) => setSgpForm((current) => ({ ...current, settlePath: event.target.value }))}
                  />
                </div>
              </fieldset>

              <div>
                <label htmlFor="sgp-sample" className="field-label">{t('settings.sgp.sample')}</label>
                <input
                  id="sgp-sample"
                  type="text"
                  className="modern-input w-full"
                  placeholder={t('settings.sgp.samplePlaceholder')}
                  value={sgpForm.sample}
                  onChange={(event) => setSgpForm((current) => ({ ...current, sample: event.target.value }))}
                />
                <p className="field-hint">{t('settings.sgp.sampleHint')}</p>
              </div>
            </div>

            {sgpTestResult && (
              <div className={`mt-4 rounded-md p-4 ${
                sgpTestResult.success
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800'
              }`}>
                <div className="flex items-center">
                  <Icon name={sgpTestResult.success ? 'check' : 'x'} size={18} className="me-2" />
                  <span className="font-medium">{sgpTestResult.message}</span>
                </div>
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void handleSgpTest()}
                disabled={sgpTesting}
                className="modern-button-secondary"
              >
                {sgpTesting ? t('settings.sgp.testing') : t('settings.sgp.test')}
              </button>
              <button
                type="button"
                onClick={() => void handleSgpSave()}
                disabled={sgpSaving}
                className="modern-button"
              >
                {sgpSaving ? t('common.saving') : t('settings.sgp.save')}
              </button>
              {sgpConfig?.tokenConfigured && (
                <button
                  type="button"
                  onClick={() => void handleSgpClearToken()}
                  disabled={sgpSaving}
                  className="modern-button-secondary"
                >
                  {t('settings.sgp.clearToken')}
                </button>
              )}
            </div>

            {sgpFleetAvailable && (
              <div className="mt-6 border-t border-border pt-5">
                <h3 className="font-semibold">{t('settings.sgp.fleetTitle')}</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('settings.sgp.fleetHint')}</p>
                <button
                  type="button"
                  onClick={() => void handleSgpSyncAll()}
                  disabled={sgpSyncing}
                  className="modern-button-secondary mt-4"
                >
                  <Icon name="refresh" size={16} className={`me-2 ${sgpSyncing ? 'animate-spin' : ''}`} />
                  {sgpSyncing ? t('settings.sgp.syncing') : t('settings.sgp.syncAll')}
                </button>
                {sgpSyncSummary ? (
                  <>
                    <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-7">
                      {([
                        ['settings.sgp.syncTotal', sgpSyncSummary.total],
                        ['settings.sgp.syncLinked', sgpSyncSummary.linked],
                        ['settings.sgp.syncCreated', sgpSyncSummary.created],
                        ['settings.sgp.syncUpdated', sgpSyncSummary.updated],
                        ['settings.sgp.syncRelinked', sgpSyncSummary.relinked ?? 0],
                        ['settings.sgp.syncSkipped', sgpSyncSummary.skipped],
                        ['settings.sgp.syncFailedCount', sgpSyncSummary.failed]
                      ] as const).map(([labelKey, value]) => (
                        <div key={labelKey}>
                          <dt className="metric-label">{t(labelKey)}</dt>
                          <dd className="data-value mt-1">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t('settings.sgp.syncFinished', {
                        time: formatDateTime(sgpSyncSummary.finishedAt),
                        seconds: (sgpSyncSummary.durationMs / 1000).toFixed(1)
                      })}
                    </p>
                  </>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">{t('settings.sgp.syncNever')}</p>
                )}
              </div>
            )}

            {/* Always there once the config has loaded — hidden until the
                integration was ready, it was simply not found. It says itself
                what is missing. */}
            {sgpConfig && <SgpContactsSyncPanel config={sgpConfig} onConfigChange={setSgpConfig} />}

            <SgpEventsPanel config={sgpConfig} onConfigChange={setSgpConfig} />
          </div>
        )}

        {activeTab === 'teiah' && can('teiah.read') && <TeiahPanel />}
        {activeTab === 'focuschat' && can('settings.write') && <FocusChatPanel />}

        {activeTab === 'provisioning' && <ProvisioningTab />}

        {activeTab === 'whatsapp' && (
          <div className="modern-card max-w-3xl p-5 sm:p-6">
            <p className="page-kicker">{t('settings.whatsapp.kicker')}</p>
            <h2 className="section-heading">{t('settings.whatsapp.title')}</h2>
            <p className="section-description mb-6">
              {t(platformManaged ? 'settings.platformManaged.whatsappDescription' : 'settings.whatsapp.description')}
            </p>

            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className={waConfig?.ready ? 'modern-badge-success' : 'modern-badge'}>
                {t(waConfig?.ready ? 'settings.whatsapp.statusActive' : 'settings.whatsapp.statusInactive')}
              </span>
              {/* Whether a key is stored, never the key: it is encrypted at rest
                  and the API does not return it. */}
              {!platformManaged && (
                <span className="text-xs text-muted-foreground">
                  {t(waConfig?.managedAdminKeyConfigured
                    ? 'settings.whatsapp.adminKeyStored'
                    : 'settings.whatsapp.adminKeyMissing')}
                  {waConfig?.updatedAt ? ` · ${formatDateTime(waConfig.updatedAt)}` : ''}
                </span>
              )}
            </div>

            {/* Na SaaS o servidor Evolution é um só, da plataforma: endereço,
                chave, hosts e webhook são configurados na caixa dela. Aqui fica
                o uso que o provedor faz dele. */}
            {platformManaged && (
              <div className="mb-5 flex items-start gap-2 rounded-md border border-border bg-muted/40 p-4">
                <Icon name="lock" size={16} className="mt-0.5 shrink-0" />
                <p className="text-sm leading-6">
                  {t(waConfig?.managedUrl
                    ? 'settings.platformManaged.whatsapp'
                    : 'settings.platformManaged.whatsappMissing')}
                </p>
              </div>
            )}

            <div className="space-y-4">
              {!platformManaged && (
              <div>
                <label htmlFor="wa-webhook-url" className="field-label">
                  {t('settings.whatsapp.webhookUrl')}
                </label>
                {/* O exemplo mostrava só a origem, e o código usava o que
                    fosse digitado como endereço COMPLETO. Quem seguia o exemplo
                    gravava um endereço apontando para a RAIZ do painel: o POST
                    cai no frontend, que responde 200 com HTML, e o Evolution
                    registra entrega bem-sucedida enquanto nada chega. O backend
                    agora acrescenta o caminho quando falta; o exemplo mostra o
                    endereço inteiro para que a tela e o código digam a mesma
                    coisa. */}
                <input
                  id="wa-webhook-url"
                  type="url"
                  className="modern-input w-full"
                  placeholder="https://painel.exemplo.com/api/whatsapp-webhook"
                  value={waForm.webhookBaseUrl}
                  onChange={(event) => setWaForm((current) => ({ ...current, webhookBaseUrl: event.target.value }))}
                />
                <p className="field-hint">{t('settings.whatsapp.webhookUrlHint')}</p>
              </div>
              )}

              <div>
                <label htmlFor="wa-portal-url" className="field-label">
                  {t('settings.whatsapp.portalUrl')}
                </label>
                <input
                  id="wa-portal-url"
                  type="url"
                  className="modern-input w-full"
                  placeholder="https://portal.exemplo.com"
                  value={waForm.portalPublicUrl}
                  onChange={(event) => setWaForm((current) => ({ ...current, portalPublicUrl: event.target.value }))}
                />
                <p className="field-hint">{t('settings.whatsapp.portalUrlHint')}</p>
              </div>


              {!platformManaged && (
              <>
              <div>
                <label htmlFor="wa-allowed-hosts" className="field-label">
                  {t('settings.whatsapp.allowedHosts')}
                </label>
                <textarea
                  id="wa-allowed-hosts"
                  rows={4}
                  className="modern-input w-full font-mono text-xs"
                  placeholder={'evolution.exemplo.com\n*.exemplo.com'}
                  value={waForm.allowedHosts}
                  onChange={(event) => setWaForm((current) => ({ ...current, allowedHosts: event.target.value }))}
                />
                <p className="field-hint">{t('settings.whatsapp.allowedHostsHint')}</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="wa-managed-url" className="field-label">
                    {t('settings.whatsapp.managedUrl')}
                  </label>
                  <input
                    id="wa-managed-url"
                    type="url"
                    className="modern-input w-full"
                    placeholder="https://evolution.exemplo.com"
                    value={waForm.managedUrl}
                    onChange={(event) => setWaForm((current) => ({ ...current, managedUrl: event.target.value }))}
                  />
                  <p className="field-hint">{t('settings.whatsapp.managedUrlHint')}</p>
                </div>
                <div>
                  <label htmlFor="wa-admin-key" className="field-label">
                    {t('settings.whatsapp.adminKey')}
                  </label>
                  <input
                    id="wa-admin-key"
                    type="password"
                    autoComplete="new-password"
                    className="modern-input w-full"
                    value={waForm.managedAdminKey}
                    onChange={(event) => setWaForm((current) => ({ ...current, managedAdminKey: event.target.value }))}
                  />
                  <p className="field-hint">{t('settings.whatsapp.adminKeyHint')}</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="wa-cloud-callback" className="field-label">
                    {t('settings.whatsapp.cloudCallbackUrl')}
                  </label>
                  <input
                    id="wa-cloud-callback"
                    type="url"
                    className="modern-input w-full"
                    placeholder="https://evolution.exemplo.com/webhook/meta"
                    value={waForm.cloudCallbackUrl}
                    onChange={(event) => setWaForm((current) => ({ ...current, cloudCallbackUrl: event.target.value }))}
                  />
                  <p className="field-hint">{t('settings.whatsapp.cloudCallbackUrlHint')}</p>
                </div>
                <div>
                  <label htmlFor="wa-cloud-verify" className="field-label">
                    {t('settings.whatsapp.cloudVerifyToken')}
                  </label>
                  <input
                    id="wa-cloud-verify"
                    type="text"
                    autoComplete="off"
                    className="modern-input w-full font-mono"
                    value={waForm.cloudVerifyToken}
                    onChange={(event) => setWaForm((current) => ({ ...current, cloudVerifyToken: event.target.value }))}
                  />
                  <p className="field-hint">{t('settings.whatsapp.cloudVerifyTokenHint')}</p>
                </div>
              </div>
              </>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="wa-reject-call" className="field-label">
                    {t('settings.whatsapp.rejectCallMessage')}
                  </label>
                  <input
                    id="wa-reject-call"
                    type="text"
                    className="modern-input w-full"
                    value={waForm.rejectCallMessage}
                    onChange={(event) => setWaForm((current) => ({ ...current, rejectCallMessage: event.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="wa-rate-limit" className="field-label">
                    {t('settings.whatsapp.rateLimit')}
                  </label>
                  <input
                    id="wa-rate-limit"
                    type="number"
                    min={1}
                    max={120}
                    className="modern-input w-full"
                    value={waForm.rateLimitPerMin}
                    onChange={(event) => setWaForm((current) => ({
                      ...current,
                      rateLimitPerMin: Number(event.target.value) || 1
                    }))}
                  />
                  <p className="field-hint">{t('settings.whatsapp.rateLimitHint')}</p>
                </div>
                <div className="sm:col-span-2">
                  <p className="field-label">{t('settings.whatsapp.bulkPace')}</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div>
                      <label htmlFor="wa-bulkIntervalMinSec" className="field-label">
                        {t('settings.whatsapp.bulkPaceMin')}
                      </label>
                      <input
                        id="wa-bulkIntervalMinSec"
                        type="number"
                        min={5}
                        max={600}
                        className="modern-input w-full"
                        value={waForm.bulkIntervalMinSec}
                        onChange={(event) => setWaForm((current) => ({
                          ...current,
                          bulkIntervalMinSec: Math.max(Number(event.target.value) || 5, 5)
                        }))}
                      />
                    </div>
                    <div>
                      <label htmlFor="wa-bulkIntervalMaxSec" className="field-label">
                        {t('settings.whatsapp.bulkPaceMax')}
                      </label>
                      <input
                        id="wa-bulkIntervalMaxSec"
                        type="number"
                        min={5}
                        max={600}
                        className="modern-input w-full"
                        value={waForm.bulkIntervalMaxSec}
                        onChange={(event) => setWaForm((current) => ({
                          ...current,
                          bulkIntervalMaxSec: Math.max(Number(event.target.value) || 5, 5)
                        }))}
                      />
                    </div>
                    <div>
                      <label htmlFor="wa-bulkBurstSize" className="field-label">
                        {t('settings.whatsapp.bulkPaceBurst')}
                      </label>
                      <input
                        id="wa-bulkBurstSize"
                        type="number"
                        min={0}
                        max={500}
                        className="modern-input w-full"
                        value={waForm.bulkBurstSize}
                        onChange={(event) => setWaForm((current) => ({
                          ...current,
                          bulkBurstSize: Math.max(Number(event.target.value) || 0, 0)
                        }))}
                      />
                    </div>
                    <div>
                      <label htmlFor="wa-bulkBurstPauseMin" className="field-label">
                        {t('settings.whatsapp.bulkPacePause')}
                      </label>
                      <input
                        id="wa-bulkBurstPauseMin"
                        type="number"
                        min={1}
                        max={120}
                        className="modern-input w-full"
                        value={waForm.bulkBurstPauseMin}
                        onChange={(event) => setWaForm((current) => ({
                          ...current,
                          bulkBurstPauseMin: Math.max(Number(event.target.value) || 1, 1)
                        }))}
                      />
                    </div>
                  </div>
                  <p className="field-hint">
                    {t('settings.whatsapp.bulkPaceHint', { perHour: bulkPerHour(waForm) })}
                  </p>
                </div>
                <div>
                  <label htmlFor="wa-media-retention" className="field-label">
                    {t('settings.whatsapp.mediaRetention')}
                  </label>
                  <input
                    id="wa-media-retention"
                    type="number"
                    min={0}
                    max={retentionCaps?.media ?? 3650}
                    className="modern-input w-full"
                    value={waForm.mediaRetentionDays}
                    onChange={(event) => setWaForm((current) => ({
                      ...current,
                      // `|| 1` would be wrong here, unlike on the rate limit
                      // above: 0 is a real and meaningful value on this field —
                      // it is the one that deletes nothing — and an emptied box
                      // has to land on it rather than on a day of retention
                      // nobody typed.
                      mediaRetentionDays: Math.max(0, Math.trunc(Number(event.target.value)) || 0)
                    }))}
                  />
                  <p className="field-hint">{t('settings.whatsapp.mediaRetentionHint')}</p>
                  {retentionCaps?.media != null && (
                    <p className={waRetentionAboveCap(waForm.mediaRetentionDays, retentionCaps.media) ? 'field-hint text-[hsl(var(--status-danger))]' : 'field-hint'}>
                      {t('settings.retentionCap', { max: retentionCaps.media })}
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="wa-message-retention" className="field-label">
                    {t('settings.whatsapp.messageRetention')}
                  </label>
                  <input
                    id="wa-message-retention"
                    type="number"
                    min={0}
                    max={retentionCaps?.messages ?? 3650}
                    className="modern-input w-full"
                    value={waForm.messageRetentionDays}
                    onChange={(event) => setWaForm((current) => ({
                      ...current,
                      // Same `|| 0` as its sibling above, for the same reason:
                      // 0 is the value that deletes nothing, so an emptied box
                      // has to land on it.
                      messageRetentionDays: Math.max(0, Math.trunc(Number(event.target.value)) || 0)
                    }))}
                  />
                  {/* Beside the attachment window rather than under its own
                      heading, because the two are read together: a message
                      whose attachment is still on disk is never deleted, so
                      setting this one alone keeps every thread that ever
                      carried a file. The hint is where that is said. */}
                  <p className="field-hint">{t('settings.whatsapp.messageRetentionHint')}</p>
                  {retentionCaps?.messages != null && (
                    <p className={waRetentionAboveCap(waForm.messageRetentionDays, retentionCaps.messages) ? 'field-hint text-[hsl(var(--status-danger))]' : 'field-hint'}>
                      {t('settings.retentionCap', { max: retentionCaps.messages })}
                    </p>
                  )}
                </div>
              </div>

              {/* O aviso só aparece quando algum dos dois é zero, e some no dia
                  em que o operador define um prazo. As duas ajudas acima
                  DESCREVEM o zero ("guarda para sempre, que é o padrão") e não
                  dizem o que ele custa — e o custo é específico: destes dois
                  prazos, e só destes, o padrão é nunca apagar. Telemetria,
                  eventos do ERP, provisionamento e trilha todos nascem com
                  prazo. Aqui é onde ficam o texto das conversas, as fotos e os
                  documentos que o assinante mandou. */}
              {((waForm.mediaRetentionDays === 0 && retentionCaps?.media == null)
                || (waForm.messageRetentionDays === 0 && retentionCaps?.messages == null)) && (
                <div className="mt-4 flex items-start gap-2 rounded-md border border-[hsl(var(--status-warning)/0.4)] bg-[hsl(var(--status-warning)/0.08)] p-4">
                  <Icon name="info" size={18} className="mt-0.5 shrink-0 text-[hsl(var(--status-warning))]" />
                  <p className="text-sm leading-6">{t('settings.whatsapp.retentionForeverWarning')}</p>
                </div>
              )}

              <div className="space-y-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                    checked={waForm.enabled}
                    onChange={(event) => setWaForm((current) => ({ ...current, enabled: event.target.checked }))}
                  />
                  {/* No sub-hint here on purpose: turning this on without a
                      webhook URL is refused by the API with `incomplete_config`,
                      and the reason is already written under that field — saying
                      it twice on one screen is noise, and the dictionary has no
                      hint of its own for this toggle. */}
                  <span className="block font-semibold">{t('settings.whatsapp.enable')}</span>
                </label>
              </div>
            </div>

            {(waTestResult || waTestError) && (
              <div className="mt-4 rounded-md border border-border p-4">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Icon
                    name={waTestError || testOutcome(waTestResult) !== 'passed' ? 'warning' : 'check'}
                    className={
                      waTestError || testOutcome(waTestResult) === 'failed'
                        ? 'h-4 w-4 text-[hsl(var(--status-danger))]'
                        : testOutcome(waTestResult) === 'warned'
                          ? 'h-4 w-4 text-[hsl(var(--status-warning))]'
                          : 'h-4 w-4 text-[hsl(var(--status-success))]'
                    }
                  />
                  {t('settings.whatsapp.test.title')}
                </p>

                {waTestError ? (
                  <p className="mt-2 text-sm text-[hsl(var(--status-danger))]">{waTestError}</p>
                ) : (
                  <>
                    {/* Três estados e não dois: "está tudo certo" com um passo
                        pulado afirma o que este botão existe para não afirmar,
                        e "há passos que não passaram" sobre uma instância órfã
                        manda procurar defeito que pode não existir. */}
                    <p className="mt-2 text-sm font-medium">
                      {t(
                        testOutcome(waTestResult) === 'passed'
                          ? 'settings.whatsapp.test.allPassed'
                          : testOutcome(waTestResult) === 'warned'
                            ? 'settings.whatsapp.test.someWarned'
                            : 'settings.whatsapp.test.someFailed'
                      )}
                    </p>
                    {/* Uma linha por passo, e não um ✓/✗ único: o valor inteiro
                        deste botão está em dizer QUAL dos seis falhou. */}
                    <ul className="mt-3 space-y-2" role="list">
                      {testNotes(waTestResult, t).map((note) => (
                        <li
                          key={note.key}
                          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-5 ${TEST_TONE_CLASS[note.tone]}`}
                        >
                          <Icon name={note.icon} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0">
                            <span className="font-semibold">{note.label}: </span>
                            <span className="wrap-break-word">{note.text}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                    {/* As duas ressalvas ficam no resultado, não num tooltip: um
                        diagnóstico que deixa o operador achar que provou mais do
                        que provou é o defeito que este botão existe para acabar. */}
                    <p className="field-hint mt-3">{t('settings.whatsapp.test.fromPanel')}</p>
                  </>
                )}
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void handleWhatsappTest()}
                disabled={waTesting}
                className="modern-button-secondary"
              >
                {waTesting ? t('settings.whatsapp.test.testing') : t('settings.whatsapp.test.button')}
              </button>
              <button
                type="button"
                onClick={() => void handleWhatsappSave()}
                disabled={waSaving}
                className="modern-button"
              >
                {waSaving ? t('common.saving') : t('common.save')}
              </button>
            </div>
            <p className="field-hint mt-2">{t('settings.whatsapp.test.savedOnly')}</p>

            {/* A âncora da faixa de "número caído" (`#wa-accounts`). */}
            <div id="wa-accounts" className="scroll-mt-24">
              <WhatsAppConnection config={waConfig} />
            </div>

            {can('sgp.read') && (
              <SgpContactsShortcut
                onOpen={() => {
                  setActiveTab('sgp')
                  scrollToSection(SGP_CONTACTS_ANCHOR)
                }}
              />
            )}
          </div>
        )}

        {activeTab === 'security' && (
          <div className="modern-card max-w-5xl p-4 sm:p-6">
            <h2 className="section-heading">{t('settings.security.title')}</h2>
            <p className="section-description mb-6">{t('settings.security.description')}</p>
            <div className="space-y-6">
              <MfaCard onStatusChange={lembrarMeuMfa} />
              {/* A exigência da equipe é do provedor: fora dele (console) não há
                  equipe, e quem não lê a configuração não a vê. */}
              {!currentUser?.platform && can('settings.read') && (
                <MfaPolicyCard selfMfaEnabled={meuMfa} />
              )}
              <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <h3 className="font-semibold text-foreground">{t('settings.security.changeUsername')}</h3>
                <p className="mb-4 mt-1 text-sm text-muted-foreground">{t('settings.security.changeUsernameHint')}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('settings.security.currentUsername')}</label>
                    <input
                      value={usernameForm.currentUsername}
                      onChange={(e) => setUsernameForm(f => ({ ...f, currentUsername: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.currentUsername').toLowerCase()}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('settings.security.newUsername')}</label>
                    <input
                      value={usernameForm.newUsername}
                      onChange={(e) => setUsernameForm(f => ({ ...f, newUsername: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.newUsername').toLowerCase()}
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <button onClick={submitChangeUsername} className="modern-button">{t('settings.security.updateUsername')}</button>
                </div>
              </section>

              <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <h3 className="font-semibold text-foreground">{t('settings.security.changePassword')}</h3>
                <p className="mb-4 mt-1 text-sm text-muted-foreground">{t('settings.security.changePasswordHint')}</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('settings.security.currentPassword')}</label>
                    <input
                      type="password"
                      value={passwordForm.currentPassword}
                      onChange={(e) => setPasswordForm(f => ({ ...f, currentPassword: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.currentPassword').toLowerCase()}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('settings.security.newPassword')}</label>
                    <input
                      type="password"
                      value={passwordForm.newPassword}
                      onChange={(e) => setPasswordForm(f => ({ ...f, newPassword: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.newPassword').toLowerCase()}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t('settings.security.confirmPassword')}</label>
                    <input
                      type="password"
                      value={passwordForm.confirmNewPassword}
                      onChange={(e) => setPasswordForm(f => ({ ...f, confirmNewPassword: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.confirmPassword').toLowerCase()}
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <button onClick={submitChangePassword} className="modern-button">{t('settings.security.updatePassword')}</button>
                </div>
              </section>

              <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <h3 className="font-semibold text-foreground">{t('settings.security.changeEmail')}</h3>
                <p className="mb-4 mt-1 text-sm text-muted-foreground">{t('settings.security.changeEmailHint')}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1" htmlFor="login-email-current-password">
                      {t('settings.security.currentPassword')}
                    </label>
                    <input
                      id="login-email-current-password"
                      type="password"
                      autoComplete="current-password"
                      value={emailForm.currentPassword}
                      onChange={(e) => setEmailForm(f => ({ ...f, currentPassword: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.currentPassword').toLowerCase()}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1" htmlFor="login-email-address">
                      {t('settings.security.newEmail')}
                    </label>
                    <input
                      id="login-email-address"
                      type="email"
                      autoComplete="email"
                      value={emailForm.email}
                      onChange={(e) => setEmailForm(f => ({ ...f, email: e.target.value }))}
                      className="modern-input w-full"
                      placeholder={t('settings.security.emailPlaceholder')}
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <button onClick={submitChangeEmail} className="modern-button">{t('settings.security.updateEmail')}</button>
                </div>

                {/* O estado da prova, logo abaixo do formulário que a desfaz. */}
                {currentUser?.email && (
                  currentUser.emailVerified ? (
                    <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                      <Icon name="check" size={17} className="shrink-0" />
                      {t('settings.security.emailVerified', { email: currentUser.email })}
                    </p>
                  ) : (
                    <div className="mt-4 rounded-md border border-border bg-background p-3">
                      <p className="flex items-start gap-2 text-sm text-foreground">
                        <Icon name="warning" size={17} className="mt-0.5 shrink-0" />
                        <span>{t('settings.security.emailUnverified', { email: currentUser.email })}</span>
                      </p>
                      <p className="mt-1 ps-6 text-sm text-muted-foreground">
                        {t('settings.security.emailUnverifiedHint')}
                      </p>
                      <div className="mt-3 ps-6">
                        <button
                          onClick={() => void submitEmailVerification()}
                          disabled={sendingProof}
                          className="modern-button-secondary"
                        >
                          {sendingProof ? t('common.saving') : t('settings.security.sendEmailProof')}
                        </button>
                      </div>
                    </div>
                  )
                )}
              </section>

              <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-foreground">{t('settings.operators.title')}</h3>
                    <p className="mb-4 mt-1 text-sm text-muted-foreground">{t('settings.operators.description')}</p>
                  </div>
                  <button
                    onClick={() => {
                      if (creatingOperator) {
                        resetOperatorForm()
                      } else {
                        setCreatingOperator(true)
                      }
                    }}
                    className="modern-button shrink-0"
                  >
                    {t(creatingOperator ? 'common.cancel' : 'settings.operators.add')}
                  </button>
                </div>

                {/* Convidar, que é a alternativa a escolher a senha de outra
                    pessoa — e o único caminho para quem já tem conta noutro
                    provedor. Fica acima da lista porque é uma decisão de quem
                    administra, não um detalhe de uma linha dela. */}
                {canManageOperators && <InvitePanel roles={rolesFor()} />}

                {/* O aviso da transição. Fica aqui porque a lista logo abaixo é
                    a resposta longa da mesma pergunta: quem ainda entra sem
                    e-mail. Não há botão para exigir e-mail no login — a chave é
                    variável de ambiente do servidor justamente porque virá-la
                    cedo demais tranca gente do lado de fora e não tem desfazer
                    pela tela; oferecer um botão seria oferecer esse caminho. */}
                {emailReadiness && (
                  <div
                    className={emailReadiness.withoutEmail > 0 ? 'alert-warning mb-6' : 'alert-info mb-6'}
                    role="status"
                  >
                    <p className="font-medium">{t('settings.operators.emailReadinessTitle')}</p>
                    <p className="mt-1">
                      {emailReadiness.withoutEmail > 0
                        ? t('settings.operators.emailReadinessPending', {
                            withoutEmail: emailReadiness.withoutEmail,
                            total: emailReadiness.total
                          })
                        : t('settings.operators.emailReadinessReady', { total: emailReadiness.total })}
                    </p>
                    <p className="mt-1">
                      {emailReadiness.loginRequiresEmail
                        ? t('settings.operators.emailReadinessEnforced')
                        : t('settings.operators.emailReadinessEnv')}
                    </p>
                    {emailReadiness.loginRequiresEmail && emailReadiness.withoutEmail > 0 && (
                      <p className="mt-1 font-medium">
                        {t('settings.operators.emailReadinessLockedOut', { withoutEmail: emailReadiness.withoutEmail })}
                      </p>
                    )}
                  </div>
                )}

                {creatingOperator && (
                  <div className="mb-6 rounded-md border border-border bg-card p-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label htmlFor="operator-username" className="block text-sm font-medium mb-1">
                          {t('settings.operators.username')}
                        </label>
                        <input
                          id="operator-username"
                          value={operatorForm.username}
                          onChange={(e) => setOperatorForm(f => ({ ...f, username: e.target.value }))}
                          className="modern-input w-full"
                          autoComplete="off"
                          placeholder={t('settings.operators.usernamePlaceholder')}
                        />
                        <p className="field-hint">{t('settings.operators.usernameHint')}</p>
                      </div>
                      <div>
                        <label htmlFor="operator-email" className="block text-sm font-medium mb-1">
                          {t('settings.operators.email')}
                        </label>
                        <input
                          id="operator-email"
                          type="email"
                          value={operatorForm.email}
                          onChange={(e) => setOperatorForm(f => ({ ...f, email: e.target.value }))}
                          className="modern-input w-full"
                          autoComplete="off"
                          placeholder={t('settings.operators.emailPlaceholder')}
                        />
                        <p className="field-hint">{t('settings.operators.emailHint')}</p>
                      </div>
                      <div>
                        <label htmlFor="operator-password" className="block text-sm font-medium mb-1">
                          {t('settings.operators.password')}
                        </label>
                        <input
                          id="operator-password"
                          type="password"
                          value={operatorForm.password}
                          onChange={(e) => setOperatorForm(f => ({ ...f, password: e.target.value }))}
                          className="modern-input w-full"
                          autoComplete="new-password"
                          placeholder={t('settings.operators.passwordPlaceholder')}
                        />
                        <p className="field-hint">{t('settings.operators.passwordHint')}</p>
                      </div>
                    </div>
                    {/* O papel saiu da grade de três porque o e-mail entrou
                        nela: os resumos abaixo do seletor são texto para ler, e
                        um terço de largura os espremia em uma palavra por
                        linha. */}
                    <div className="mt-4">
                        <label htmlFor="operator-role" className="block text-sm font-medium mb-1">
                          {t('settings.operators.role')}
                        </label>
                        <select
                          id="operator-role"
                          value={operatorForm.role}
                          onChange={(e) => setOperatorForm(f => ({ ...f, role: e.target.value as OperatorRole }))}
                          className="modern-input w-full md:max-w-xs"
                        >
                          {rolesFor().map((role) => (
                            <option key={role} value={role}>{t(ROLE_LABEL_KEYS[role])}</option>
                          ))}
                        </select>
                        {/* Os quatro juntos, e não só o escolhido: a comparação
                            é a decisão. Quem cria uma conta escolhe entre eles
                            uma vez e não volta à tela para conferir. */}
                        <ul className="mt-2 space-y-1">
                          {rolesFor().map((role) => (
                            <li key={role} className="field-hint">
                              <span className="font-medium text-foreground">{t(ROLE_LABEL_KEYS[role])}</span>
                              {' — '}
                              {t(ROLE_SUMMARY_KEYS[role])}
                            </li>
                          ))}
                        </ul>
                    </div>
                    <div className="flex items-center gap-2 mt-4">
                      <button onClick={() => void submitOperator()} disabled={operatorSaving} className="modern-button">
                        {operatorSaving ? t('common.saving') : t('settings.operators.create')}
                      </button>
                      <button onClick={resetOperatorForm} className="modern-button-secondary">{t('common.cancel')}</button>
                    </div>
                  </div>
                )}

                {/* No celular a conta vira cartão: a tabela de cinco colunas
                    só cabia rolando de lado, com as ações fora da vista — no
                    tablet também, por isso o corte é o lg e não o md. */}
                <ul className="space-y-3 lg:hidden" aria-busy={operatorsLoading}>
                  {operatorsLoading ? (
                    <li className="py-6 text-center text-sm text-muted-foreground">{t('settings.operators.loading')}</li>
                  ) : operatorsError !== null ? (
                    <li className="py-6 text-center text-sm text-destructive">
                      {operatorsError || t('settings.operators.loadFailed')}
                    </li>
                  ) : operators.length === 0 ? (
                    <li className="py-6 text-center text-sm text-muted-foreground">{t('settings.operators.empty')}</li>
                  ) : (
                    operators.map((operator) => {
                      const isSelf = currentUser?.id === operator.id
                      const lockedByOwner = operator.role === 'owner' && !isOwner
                      return (
                        <li key={operator.id} className="rounded-md border border-border bg-card p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="wrap-break-word font-medium text-foreground">{operator.username}</p>
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {isSelf && <span className="modern-badge">{t('settings.operators.you')}</span>}
                                <span className={operator.mfaEnabled ? 'modern-badge-success' : 'modern-badge'}>
                                  {operator.mfaEnabled ? t('settings.operators.mfaOn') : t('settings.operators.mfaOff')}
                                </span>
                              </div>
                            </div>
                            {renderOperatorActions(operator, isSelf)}
                          </div>
                          <p className="mt-2 break-all text-sm">
                            {operator.email
                              ? <span className="text-muted-foreground">{operator.email}</span>
                              : <span className="modern-badge">{t('settings.operators.emailMissing')}</span>}
                          </p>
                          <div className="mt-3">
                            {renderOperatorRole(operator, lockedByOwner, 'w-full')}
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {t('settings.operators.createdAt')}: {formatDateTime(operator.createdAt)}
                          </p>
                          {resetPasswordId === operator.id && (
                            <div className="mt-3 border-t border-border pt-3">
                              {renderOperatorPasswordForm(operator, 'm')}
                            </div>
                          )}
                        </li>
                      )
                    })
                  )}
                </ul>

                <div className="hidden overflow-x-auto lg:block">
                  <table className="modern-table">
                    <thead>
                      <tr>
                        <th>{t('settings.operators.username')} · {t('settings.operators.email')}</th>
                        <th>{t('settings.operators.role')}</th>
                        <th>{t('settings.operators.createdAt')}</th>
                        <th className="text-end">{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {operatorsLoading ? (
                        <tr>
                          <td colSpan={4} className="text-center py-8 text-muted-foreground">
                            {t('settings.operators.loading')}
                          </td>
                        </tr>
                      ) : operatorsError !== null ? (
                        <tr>
                          <td colSpan={4} className="text-center py-8 text-destructive">
                            {operatorsError || t('settings.operators.loadFailed')}
                          </td>
                        </tr>
                      ) : operators.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="text-center py-8 text-muted-foreground">
                            {t('settings.operators.empty')}
                          </td>
                        </tr>
                      ) : (
                        operators.map((operator) => {
                          const isSelf = currentUser?.id === operator.id
                          // Mexer no papel de um `owner` é dele para dele: o
                          // backend responde 403 a qualquer outro, para dar e
                          // para tirar. O seletor fica travado em vez de sumir
                          // porque o papel atual continua sendo informação.
                          const lockedByOwner = operator.role === 'owner' && !isOwner
                          return (
                            <Fragment key={operator.id}>
                              <tr>
                                <td className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-medium wrap-anywhere">{operator.username}</span>
                                    {isSelf && (
                                      <span className="modern-badge">{t('settings.operators.you')}</span>
                                    )}
                                    <span className={operator.mfaEnabled ? 'modern-badge-success' : 'modern-badge'}>
                                      {operator.mfaEnabled ? t('settings.operators.mfaOn') : t('settings.operators.mfaOff')}
                                    </span>
                                  </div>
                                  {/* Vazio é informação, e por isso não some
                                      num travessão: uma conta sem endereço é uma
                                      conta que `LOGIN_REQUIRES_EMAIL` trancaria
                                      do lado de fora, e é aqui que se vê quem
                                      ainda falta. */}
                                  <div className="mt-1 text-sm">
                                    {operator.email
                                      ? <span className="text-muted-foreground wrap-anywhere">{operator.email}</span>
                                      : <span className="modern-badge">{t('settings.operators.emailMissing')}</span>}
                                  </div>
                                </td>
                                <td className="w-56 xl:w-64">{renderOperatorRole(operator, lockedByOwner, 'w-full max-w-60')}</td>
                                <td className="w-28 text-sm text-muted-foreground xl:w-auto xl:whitespace-nowrap">{formatDateTime(operator.createdAt)}</td>
                                <td className="w-px"><div className="flex justify-end">{renderOperatorActions(operator, isSelf)}</div></td>
                              </tr>
                              {resetPasswordId === operator.id && (
                                <tr>
                                  <td colSpan={4}>{renderOperatorPasswordForm(operator, 'd')}</td>
                                </tr>
                              )}
                            </Fragment>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Portabilidade: o cadastro inteiro deste provedor, num arquivo.
                  Fica aqui, e não na tela da trilha, porque a capacidade de
                  quem baixa é `tenant.export` e não `audit.read` — hoje as duas
                  andam com os mesmos papéis, e amarrá-las na interface criaria
                  uma dependência que a matriz não tem. */}
              {canExportTenant && (
                <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                  <h3 className="font-semibold text-foreground">{t('settings.export.title')}</h3>
                  <p className="mb-4 mt-1 text-sm text-muted-foreground">{t('settings.export.description')}</p>
                  <button
                    type="button"
                    className="modern-button"
                    onClick={() => void exportarDados()}
                    disabled={exportando}
                  >
                    <Icon name="database" size={17} />
                    {exportando ? t('settings.export.running') : t('settings.export.action')}
                  </button>
                  <p className="field-hint mt-3">{t('settings.export.hint')}</p>
                </section>
              )}
            </div>
          </div>
        )}

        {/* Vendors Tab */}
        {activeTab === 'vendors' && (
          <div className="space-y-6">
            {/* Vendor List */}
            <div className="modern-card p-4 sm:p-6">
              <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('settings.vendors.title')}</h2>
                <button
                  onClick={() => { resetVendorForm(); setCreatingVendor(true) }}
                  className="modern-button"
                >
                  {t('settings.vendors.add')}
                </button>
              </div>

              {(creatingVendor || editingVendor) && (
                <div className="mb-6 p-4 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                    {/* General Info */}
                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.name')} *</label>
                      <input
                        value={vendorForm.name}
                        onChange={(e) => setVendorForm(v => ({ ...v, name: e.target.value }))}
                        className="modern-input w-full"
                        placeholder={t('settings.vendors.namePlaceholder')}
                      />
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.manufacturerPatterns')} *</label>
                      <input
                        value={vendorForm.manufacturer_patterns}
                        onChange={(e) => setVendorForm(v => ({ ...v, manufacturer_patterns: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="huawei, hw"
                      />
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.productPatterns')} *</label>
                      <input
                        value={vendorForm.product_patterns}
                        onChange={(e) => setVendorForm(v => ({ ...v, product_patterns: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="hg8, eg8, f660"
                      />
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.parameterPrefix')}</label>
                      <input
                        value={vendorForm.parameter_prefix}
                        onChange={(e) => setVendorForm(v => ({ ...v, parameter_prefix: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW"
                      />
                    </div>

                    {/* WAN Connection Parameters */}
                    <h3 className="md:col-span-3 text-md font-semibold text-gray-800 dark:text-gray-200 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">{t('settings.vendors.wanSection')}</h3>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.serviceListPath')}</label>
                      <input
                        value={vendorForm.service_list_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, service_list_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW_SERVICELIST"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.lanBindingPath')}</label>
                      <input
                        value={vendorForm.lan_binding_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, lan_binding_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW_LANBIND"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.vlanIdPath')}</label>
                      <input
                        value={vendorForm.vlan_id_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, vlan_id_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW_VLAN"
                      />
                    </div>

                    {/* WiFi & Security Parameters */}
                    <h3 className="md:col-span-3 text-md font-semibold text-gray-800 dark:text-gray-200 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">{t('settings.vendors.wifiSection')}</h3>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.wifiPasswordPath')}</label>
                      <input
                        value={vendorForm.wifi_password_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, wifi_password_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. PreSharedKey.1.KeyPassphrase"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.httpWanEnablePath')}</label>
                      <input
                        value={vendorForm.http_wan_enable_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, http_wan_enable_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. ...AclServices.HTTPWanEnable"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.firewallLevelPath')}</label>
                      <input
                        value={vendorForm.firewall_level_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, firewall_level_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. ...X_HW_FirewallLevel"
                      />
                    </div>

                    {/* Other Parameters */}
                    <h3 className="md:col-span-3 text-md font-semibold text-gray-800 dark:text-gray-200 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">{t('settings.vendors.otherSection')}</h3>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.priority')}</label>
                      <input
                        type="number"
                        value={vendorForm.priority}
                        onChange={(e) => setVendorForm(v => ({ ...v, priority: Number(e.target.value) }))}
                        className="modern-input w-full"
                        placeholder="10"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.status')}</label>
                      <select
                        value={vendorForm.enabled}
                        onChange={(e) => setVendorForm(v => ({ ...v, enabled: Number(e.target.value) }))}
                        className="modern-input w-full"
                      >
                        <option value={1}>{t('common.enabled')}</option>
                        <option value={0}>{t('common.disabled')}</option>
                      </select>
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">{t('settings.vendors.descriptionLabel')}</label>
                      <textarea
                        value={vendorForm.description}
                        onChange={(e) => setVendorForm(v => ({ ...v, description: e.target.value }))}
                        className="modern-input w-full"
                        rows={2}
                        placeholder={t('settings.vendors.descriptionPlaceholder')}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-4">
                    <button onClick={submitVendor} className="modern-button">
                      {editingVendor ? t('settings.vendors.update') : t('settings.vendors.create')}
                    </button>
                    <button
                      onClick={resetVendorForm}
                      className="modern-button-secondary"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}

              <ul className="mobile-card-list space-y-3" aria-busy={vendorsLoading}>
                {vendorsLoading ? (
                  <li className="py-6 text-center text-sm text-muted-foreground">{t('settings.vendors.loading')}</li>
                ) : vendorsError !== null ? (
                  <li className="py-6 text-center text-sm text-[hsl(var(--status-danger))]">
                    {vendorsError || t('settings.vendors.loadFailed')}
                  </li>
                ) : vendorList.length === 0 ? (
                  <li className="py-6 text-center text-sm text-muted-foreground">{t('settings.vendors.empty')}</li>
                ) : (
                  vendorList.map((v) => (
                    <li key={v.id} className="rounded-md border border-border bg-card p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="wrap-break-word font-medium text-foreground">{v.name}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {t('settings.vendors.priority')}: {v.priority}
                            <span className={`ms-2 ${v.enabled ? 'modern-badge-success' : 'modern-badge-error'}`}>
                              {v.enabled ? t('common.enabled') : t('common.disabled')}
                            </span>
                          </p>
                        </div>
                        {renderVendorActions(v)}
                      </div>
                      {v.parameter_prefix && (
                        <p className="mt-2 break-all font-mono text-xs">{v.parameter_prefix}</p>
                      )}
                      {(v.manufacturer_patterns || []).concat(v.product_patterns || []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {(v.manufacturer_patterns || []).concat(v.product_patterns || []).map((p, idx) => (
                            <span key={idx} className="modern-badge break-all">{p}</span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))
                )}
              </ul>

              <div className="desktop-table overflow-x-auto">
                <table className="modern-table">
                  <thead>
                    <tr>
                      <th>{t('settings.vendors.name')}</th>
                      <th>{t('settings.vendors.parameterPrefix')}</th>
                      <th>{t('settings.vendors.patterns')}</th>
                      <th>{t('settings.vendors.priority')}</th>
                      <th>{t('settings.vendors.status')}</th>
                      <th>{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendorsLoading ? (
                      <tr>
                        <td colSpan={6} className="text-center py-8">
                          <div className="w-8 h-8 border-4 border-gray-200 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin mx-auto"></div>
                          <p className="mt-2 text-gray-500 dark:text-gray-400">{t('settings.vendors.loading')}</p>
                        </td>
                      </tr>
                    ) : vendorsError !== null ? (
                      /* "Não deu para carregar" e "não há nada cadastrado" são
                         fatos diferentes, e a tela afirmava o segundo quando o
                         verdadeiro era o primeiro. */
                      <tr>
                        <td colSpan={6} className="text-center py-8 text-[hsl(var(--status-danger))]">
                          {vendorsError || t('settings.vendors.loadFailed')}
                        </td>
                      </tr>
                    ) : vendorList.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-8 text-gray-500 dark:text-gray-400">
                          {t('settings.vendors.empty')}
                        </td>
                      </tr>
                    ) : (
                      vendorList.map((v) => (
                        <tr key={v.id}>
                          <td className="font-medium">{v.name}</td>
                          <td className="font-mono text-xs">{v.parameter_prefix || '-'}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {(v.manufacturer_patterns || []).concat(v.product_patterns || []).map((p, idx) => (
                                <span key={idx} className="modern-badge">{p}</span>
                              ))}
                            </div>
                          </td>
                          <td>{v.priority}</td>
                          <td>
                            <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${v.enabled ? 'modern-badge-success' : 'modern-badge-error'}`}>
                              {v.enabled ? t('common.enabled') : t('common.disabled')}
                            </span>
                          </td>
                          <td>{renderVendorActions(v)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* WiFi Security Tab */}
        {activeTab === 'wifi-security' && (
          <div className="space-y-6">
            {/* WiFi Security Configs */}
            <div className="modern-card p-4 sm:p-6">
              <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('settings.wifi.title')}</h2>
                <button
                  onClick={() => {
                    resetConfigForm();
                    setCreatingConfig(true);
                  }}
                  className="modern-button"
                >
                  {t('settings.wifi.add')}
                </button>
              </div>
              {(creatingConfig || editingConfig) && (
                <div className="mb-6 p-4 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.wifi.productClass')}</label>
                      <input
                        value={configForm.product_class}
                        onChange={(e) => setConfigForm(c => ({ ...c, product_class: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="e.g. HG8245H"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.wifi.securityTypes')}</label>
                      <input
                        value={configForm.security_types}
                        onChange={(e) => setConfigForm(c => ({ ...c, security_types: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="WPA2-PSK,WPA3-PSK"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t('settings.wifi.passwordPath')}</label>
                      <input
                        value={configForm.password_param_path}
                        onChange={(e) => setConfigForm(c => ({ ...c, password_param_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="...KeyPassphrase"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-4">
                    <button onClick={submitWifiConfig} className="modern-button">
                      {editingConfig ? t('settings.wifi.update') : t('settings.wifi.create')}
                    </button>
                    <button onClick={resetConfigForm} className="modern-button-secondary">{t('common.cancel')}</button>
                  </div>
                </div>
              )}

              <ul className="mobile-card-list space-y-3" aria-busy={wifiConfigLoading}>
                {wifiConfigLoading ? (
                  <li className="py-6 text-center text-sm text-muted-foreground">{t('settings.wifi.loading')}</li>
                ) : wifiConfigError !== null ? (
                  <li className="py-6 text-center text-sm text-[hsl(var(--status-danger))]">
                    {wifiConfigError || t('settings.wifi.loadFailed')}
                  </li>
                ) : wifiConfigs.length === 0 ? (
                  <li className="py-6 text-center text-sm text-muted-foreground">{t('settings.wifi.empty')}</li>
                ) : (
                  wifiConfigs.map(cfg => (
                    <li key={cfg.id} className="rounded-md border border-border bg-card p-3">
                      <p className="break-all font-medium text-foreground">{cfg.product_class}</p>
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{cfg.password_param_path}</p>
                      {(cfg.security_types_array || []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {(cfg.security_types_array || []).map((sec, idx) => (
                            <span key={idx} className="modern-badge">{sec}</span>
                          ))}
                        </div>
                      )}
                      <div className="mt-2">{renderWifiActions(cfg)}</div>
                    </li>
                  ))
                )}
              </ul>

              <div className="desktop-table overflow-x-auto">
                <table className="modern-table">
                  {/* Style Header Tabel Sesuai SS */}
                  <thead>
                    <tr>
                      <th className="uppercase">{t('settings.wifi.productClass')}</th>
                      <th className="uppercase">{t('settings.wifi.passwordPath')}</th>
                      <th className="uppercase">{t('settings.wifi.securityTypes')}</th>
                      <th className="uppercase">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wifiConfigLoading ? (
                      <tr>
                        <td colSpan={4} className="text-center py-8 text-gray-500 dark:text-gray-400">{t('settings.wifi.loading')}</td>
                      </tr>
                    ) : wifiConfigError !== null ? (
                      <tr>
                        <td colSpan={4} className="text-center py-8 text-[hsl(var(--status-danger))]">
                          {wifiConfigError || t('settings.wifi.loadFailed')}
                        </td>
                      </tr>
                    ) : wifiConfigs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center py-8 text-gray-500 dark:text-gray-400">{t('settings.wifi.empty')}</td>
                      </tr>
                    ) : (
                      wifiConfigs.map(cfg => (
                        <tr key={cfg.id}>
                          <td className="font-medium">{cfg.product_class}</td>
                          <td className="font-mono text-xs">{cfg.password_param_path}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {(cfg.security_types_array || []).map((s, idx) => (
                                <span key={idx} className="modern-badge">{s}</span>
                              ))}
                            </div>
                          </td>
                          <td>{renderWifiActions(cfg)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'chatbot' && can('whatsapp.config') && <ChatbotTab />}

        {activeTab === 'about' && <AboutTab appName={tenantName} />}

        {activeTab === 'database' && (
          <div className="modern-card max-w-2xl p-4 sm:p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">{t('settings.db.title')}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t('settings.db.active', {
                database: activeDb
                  ? (activeDb.client === 'mysql2'
                      ? t('settings.db.mysql', { database: String(activeDb.database), host: String(activeDb.host) })
                      : t('settings.db.sqlite'))
                  : '…',
              })}
            </p>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.type')}</label>
              <select
                value={dbForm.client}
                onChange={(e) => setDbForm({ ...dbForm, client: e.target.value as DbConfigPayload['client'] })}
                className="modern-input w-full"
              >
                <option value="mysql2">MySQL / MariaDB</option>
                <option value="sqlite3">{t('settings.db.sqlite')}</option>
              </select>
            </div>

            {dbForm.client === 'mysql2' && (
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.host')}</label>
                  <input className="modern-input w-full" value={dbForm.host || ''}
                    onChange={(e) => setDbForm({ ...dbForm, host: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.port')}</label>
                  <input type="number" className="modern-input w-full" value={dbForm.port || 3306}
                    onChange={(e) => setDbForm({ ...dbForm, port: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.user')}</label>
                  <input className="modern-input w-full" value={dbForm.user || ''}
                    onChange={(e) => setDbForm({ ...dbForm, user: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.password')}</label>
                  <input type="password" className="modern-input w-full" value={dbForm.password || ''}
                    onChange={(e) => setDbForm({ ...dbForm, password: e.target.value })} />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('settings.db.database')}</label>
                  <input className="modern-input w-full" value={dbForm.database || ''}
                    onChange={(e) => setDbForm({ ...dbForm, database: e.target.value })} />
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 mb-6 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={Boolean(dbForm.migrateData)}
                onChange={(e) => setDbForm({ ...dbForm, migrateData: e.target.checked })} />
              {t('settings.db.copyData')}
            </label>

            <div className="flex gap-3">
              <button onClick={handleDbTest} disabled={dbTesting} className="modern-button-secondary">
                {dbTesting ? t('settings.db.testing') : t('settings.db.test')}
              </button>
              <button onClick={handleDbSwitch} disabled={dbSwitching} className="modern-button">
                {dbSwitching ? t('settings.db.switching') : t('settings.db.switch')}
              </button>
            </div>

            <p className="text-xs text-gray-400 mt-4">
              {t('settings.db.restartHint')}
            </p>
          </div>
        )}

        {/* Save Button */}
        {(activeTab === 'general' || activeTab === 'virtual-params' || activeTab === 'customer-portal') && (
          <div className="flex justify-end mt-8">
            <button
              onClick={() => void handleSaveSettings()}
              disabled={loading}
              className="modern-button"
            >
              {loading ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
