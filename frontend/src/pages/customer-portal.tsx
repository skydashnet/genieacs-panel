import { FormEvent, useCallback, useEffect, useState } from 'react'
import { BrandMark } from '@/components/brand-mark'
import { hasContact, mailtoHref, telHref, whatsappHref, type ProviderContact } from '@/lib/portal-contact'
import { Icon } from '@/components/ui/icon'
import { QrCode } from '@/components/qr-code'
import { useWifiStatusFilter, WifiStatusFilterControl } from '@/components/wifi-status-filter'
import { filterWifiByStatus } from '@/lib/wifi-filter'
import { looksLikeBrCode } from '@/lib/qr/encode'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'
import { getActiveLocale, isCustomerSessionCode, translate } from '@/lib/i18n'
import { billingFailure } from '@/lib/portal-billing'
import { setActiveDateFormat } from '@/lib/date-format'

type PortalOverview = {
  customerId: string
  status: 'online' | 'offline'
  lastInform: string | null
  lastBoot: string | null
  registered: string | null
  ont: {
    manufacturer: unknown
    model: unknown
    serialNumber: unknown
    hardwareVersion: unknown
    softwareVersion: unknown
    uptimeSeconds: unknown
  }
  optical: { rxPower: unknown; temperature: unknown }
  connectedDevices: unknown
  wifi: Array<{
    index: number
    ssid: unknown
    enabled: boolean | null
    connectedDevices: unknown
    hasSavedPassword?: boolean
  }>
  generatedAt: string
}

type PortalInvoice = {
  id: string | null
  description: string | null
  amount: number | null
  dueDate: string | null
  status: string | null
  digitableLine: string | null
  barcode: string | null
  link: string | null
  pix: string | null
  paid: boolean
}

type PortalBilling = {
  contract: {
    contract: string
    clientName: string | null
    document: string | null
    plan: string | null
    status: string | null
    statusLabel: string | null
  }
  invoices: PortalInvoice[]
  trustUnlockAvailable: boolean
  generatedAt: string
}

type ApiResult<T> = { success: boolean; message?: string; data?: T; code?: string }

type WifiEditor = { index: number; ssid: string; password: string }

async function portalRequest<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const response = await fetch(`/api/customer${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      // Answer in the language the subscriber picked, not the browser default.
      'Accept-Language': getActiveLocale(),
      ...init?.headers,
    },
  })
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json')
    ? await response.json()
    : { success: false, message: translate(getActiveLocale(), 'portal.invalidResponse') }
  if (!response.ok) return { ...result, success: false }
  return result
}

/** Formats an SGP invoice amount in the subscriber's locale as BRL. */
function currency(amount: number | null, intlLocale: string) {
  if (amount === null || !Number.isFinite(amount)) return '—'
  return amount.toLocaleString(intlLocale, { style: 'currency', currency: 'BRL' })
}

function isOverdue(value: string | null) {
  if (!value) return false
  const due = new Date(`${value}T23:59:59`)
  return !Number.isNaN(due.getTime()) && due.getTime() < Date.now()
}

function safeBoletoUrl(value: string | null) {
  if (!value) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

function MetricCard({
  icon, label, value, helper
}: {
  icon: string
  label: string
  value: string
  helper?: string
}) {
  return (
    <article className="modern-card p-4 sm:p-5">
      <div className="mb-5 flex items-center justify-between">
        <p className="metric-label">{label}</p>
        <span className="rounded-md bg-secondary p-2 text-primary"><Icon name={icon} size={18} /></span>
      </div>
      <p className="wrap-break-word text-xl font-bold tracking-tight">{value}</p>
      {helper && <p className="mt-1 text-xs text-muted-foreground">{helper}</p>}
    </article>
  )
}

export default function CustomerPortal() {
  const { t, formatDate, formatDateTime, intlLocale } = useTranslation()
  const [checkingSession, setCheckingSession] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [customerId, setCustomerId] = useState('')
  const [password, setPassword] = useState('')
  const [showLoginPassword, setShowLoginPassword] = useState(false)
  const [overview, setOverview] = useState<PortalOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [wifiEditor, setWifiEditor] = useState<WifiEditor | null>(null)
  const [wifiFilter, setWifiFilter] = useWifiStatusFilter('customerPortal.wifiFilter')
  const [wifiSaving, setWifiSaving] = useState(false)
  const [showWifiPassword, setShowWifiPassword] = useState(false)
  const [visibleSavedPasswordIndex, setVisibleSavedPasswordIndex] = useState<number | null>(null)
  const [revealedWifiPasswords, setRevealedWifiPasswords] = useState<Record<number, string>>({})
  const [revealingWifiPasswordIndex, setRevealingWifiPasswordIndex] = useState<number | null>(null)
  const [billing, setBilling] = useState<PortalBilling | null>(null)
  const [providerContact, setProviderContact] = useState<ProviderContact | null>(null)
  const [billingLoading, setBillingLoading] = useState(false)
  const [billingError, setBillingError] = useState('')
  const [unlockPending, setUnlockPending] = useState(false)
  const [billingFeedback, setBillingFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)
  // Keyed by row and by which of the two codes was copied. Keying it on
  // `invoice.id` alone made every id-less invoice light up at once, because
  // `null === null` matched all of them.
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [wifiFeedback, setWifiFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  const notReported = t('portal.notReported')

  /** Values arrive from the ONT as unknown JSON, so anything unusable reads as "not reported". */
  const text = (value: unknown) => {
    if (value === null || value === undefined || value === '') return notReported
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    return notReported
  }

  const dateTime = (value: string | null) => {
    if (!value) return notReported
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? notReported
      : formatDateTime(date, { dateStyle: 'medium', timeStyle: 'short' })
  }

  const uptime = (value: unknown) => {
    const seconds = Number(value)
    if (!Number.isFinite(seconds) || seconds < 0) return notReported
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return [
      days ? t('portal.uptime.days', { count: days }) : '',
      hours ? t('portal.uptime.hours', { count: hours }) : '',
      t('portal.uptime.minutes', { count: minutes }),
    ].filter(Boolean).join(' ')
  }

  const loadOverview = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await portalRequest<PortalOverview>('/overview')
      if (!result.success || !result.data) {
        if (isCustomerSessionCode(result.code)) setAuthenticated(false)
        setError(result.message || t('portal.error.overview'))
        return
      }
      setOverview(result.data)
    } catch {
      setError(t('portal.error.unreachable'))
    } finally {
      setLoading(false)
    }
  }, [t])

  // An SGP due date is a plain YYYY-MM-DD; anchor it to local midnight so the
  // reader's locale, not UTC, decides the displayed day.
  const invoiceDueDate = (value: string | null) => (value ? formatDate(value) : '—')

  // O contato é opcional e secundário: falhar aqui não vira erro na tela,
  // o cartão simplesmente não aparece.
  const loadProvider = useCallback(async () => {
    try {
      const result = await portalRequest<ProviderContact>('/provider')
      setProviderContact(result.success && result.data ? result.data : null)
    } catch {
      setProviderContact(null)
    }
  }, [])

  const loadBilling = useCallback(async () => {
    setBillingLoading(true)
    try {
      const result = await portalRequest<PortalBilling>('/billing')
      if (!result.success || !result.data) {
        if (isCustomerSessionCode(result.code)) setAuthenticated(false)
        setBilling(null)
        const falha = billingFailure(result, t('portal.billing.temporaryFailure'))
        setBillingError(falha.kind === 'error' ? falha.message : '')
        return
      }
      setBilling(result.data)
      setBillingError('')
    } catch {
      // A rede caiu no meio. Antes isto zerava a mensagem e a seção sumia:
      // o assinante lia "não há fatura". Agora é falha, e falha aparece.
      setBilling(null)
      const falha = billingFailure(null, t('portal.billing.temporaryFailure'))
      setBillingError(falha.kind === 'error' ? falha.message : '')
    } finally {
      setBillingLoading(false)
    }
  }, [t])

  const requestTrustUnlock = async () => {
    if (!confirm(t('portal.billing.trustUnlockConfirm'))) return
    setUnlockPending(true)
    setBillingFeedback(null)
    try {
      const result = await portalRequest('/billing/trust-unlock', { method: 'POST' })
      setBillingFeedback({
        type: result.success ? 'success' : 'error',
        message: result.message || t(result.success
          ? 'portal.billing.trustUnlockSent'
          : 'portal.billing.trustUnlockFailed')
      })
      if (result.success) await loadBilling()
    } catch {
      setBillingFeedback({ type: 'error', message: t('portal.error.retry') })
    } finally {
      setUnlockPending(false)
    }
  }

  const copyCode = async (key: string, code: string | null) => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(key)
      setBillingFeedback(null)
      window.setTimeout(() => setCopiedCode((current) => (current === key ? null : current)), 4000)
    } catch {
      setBillingFeedback({ type: 'error', message: t('portal.billing.copyFailed') })
    }
  }

  useEffect(() => {
    let cancelled = false
    void portalRequest<{ customerId: string; dateFormat?: string }>('/session')
      .then((result) => {
        if (cancelled) return
        setAuthenticated(result.success)
        if (result.success) {
          // As datas do portal saem no formato que o provedor escolheu.
          setActiveDateFormat(result.data?.dateFormat)
          void loadOverview()
          void loadBilling()
          void loadProvider()
        }
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false)
      })
    return () => { cancelled = true }
  }, [loadOverview, loadBilling, loadProvider])

  useEffect(() => {
    if (!authenticated) return
    const timer = window.setInterval(() => void loadOverview(), 60_000)
    return () => window.clearInterval(timer)
  }, [authenticated, loadOverview])

  useEffect(() => {
    if (authenticated) return
    setOverview(null)
    setWifiEditor(null)
    setShowWifiPassword(false)
    setVisibleSavedPasswordIndex(null)
    setRevealedWifiPasswords({})
    setRevealingWifiPasswordIndex(null)
    setWifiFeedback(null)
    setBilling(null)
    setProviderContact(null)
    setBillingError('')
    setBillingFeedback(null)
    setCopiedCode(null)
  }, [authenticated])

  const login = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const result = await portalRequest<{ customerId: string }>('/login', {
        method: 'POST',
        body: JSON.stringify({ customerId, password }),
      })
      if (!result.success) {
        setError(result.message || t('portal.login.invalidCredentials'))
        return
      }
      setAuthenticated(true)
      setPassword('')
      setShowLoginPassword(false)
      void portalRequest<{ dateFormat?: string }>('/session')
        .then((session) => { if (session.success) setActiveDateFormat(session.data?.dateFormat) })
      await loadOverview()
      void loadBilling()
      void loadProvider()
    } catch {
      setError(t('portal.error.retry'))
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    await portalRequest('/logout', { method: 'POST' })
    setAuthenticated(false)
    setOverview(null)
    setCustomerId('')
    setPassword('')
    setShowLoginPassword(false)
  }

  const openWifiEditor = (index: number, ssid: unknown) => {
    setWifiEditor({ index, ssid: text(ssid), password: '' })
    setShowWifiPassword(false)
    setVisibleSavedPasswordIndex(null)
    setWifiFeedback(null)
  }

  const toggleSavedWifiPassword = async (index: number) => {
    if (visibleSavedPasswordIndex === index) {
      setVisibleSavedPasswordIndex(null)
      return
    }
    if (revealedWifiPasswords[index]) {
      setVisibleSavedPasswordIndex(index)
      return
    }

    setRevealingWifiPasswordIndex(index)
    setWifiFeedback(null)
    try {
      const result = await portalRequest<{ password: string }>(`/wifi/${index}/password`)
      if (!result.success || !result.data?.password) {
        if (isCustomerSessionCode(result.code)) setAuthenticated(false)
        setWifiFeedback({
          type: 'error',
          message: result.message || t('portal.wifi.error.revealFailed')
        })
        return
      }
      setRevealedWifiPasswords((current) => ({
        ...current,
        [index]: result.data!.password
      }))
      setVisibleSavedPasswordIndex(index)
    } catch {
      setWifiFeedback({
        type: 'error',
        message: t('portal.error.retry')
      })
    } finally {
      setRevealingWifiPasswordIndex(null)
    }
  }

  const saveWifi = async (event: FormEvent) => {
    event.preventDefault()
    if (!wifiEditor) return
    const ssid = wifiEditor.ssid.trim()
    if (!ssid || ssid.length > 32) {
      setWifiFeedback({ type: 'error', message: t('portal.wifi.error.ssidLength') })
      return
    }
    if (wifiEditor.password && !/^[\x20-\x7e]{8,63}$/.test(wifiEditor.password)) {
      setWifiFeedback({ type: 'error', message: t('portal.wifi.error.passwordLength') })
      return
    }

    setWifiSaving(true)
    setWifiFeedback(null)
    try {
      const result = await portalRequest<{ index: number; ssid: string }>('/wifi', {
        method: 'PUT',
        body: JSON.stringify({
          index: wifiEditor.index,
          ssid,
          password: wifiEditor.password
        }),
      })
      if (!result.success) {
        if (isCustomerSessionCode(result.code)) setAuthenticated(false)
        setWifiFeedback({
          type: 'error',
          message: result.message || t('portal.wifi.error.saveFailed')
        })
        return
      }
      setOverview((current) => current ? {
        ...current,
        wifi: current.wifi.map((network) => (
          network.index === wifiEditor.index
            ? {
                ...network,
                ssid,
                hasSavedPassword: Boolean(wifiEditor.password) || network.hasSavedPassword
              }
            : network
        ))
      } : current)
      setWifiEditor(null)
      setShowWifiPassword(false)
      setWifiFeedback({
        type: 'success',
        message: result.message || t('portal.wifi.success')
      })
    } catch {
      setWifiFeedback({
        type: 'error',
        message: t('portal.error.retry')
      })
    } finally {
      setWifiSaving(false)
    }
  }

  const { visible: visibleWifi, counts: wifiCounts } = filterWifiByStatus(
    overview?.wifi ?? [],
    wifiFilter,
    (network) => network.enabled
  )

  if (checkingSession) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-5">
        <div className="text-center" aria-live="polite">
          <BrandMark className="mx-auto h-12 w-12" title="TR69 Controle" />
          <Icon name="refresh" className="mx-auto mt-5 animate-spin text-primary" />
          <p className="mt-2 text-sm text-muted-foreground">{t('portal.checkingSession')}</p>
        </div>
      </main>
    )
  }

  if (!authenticated) {
    return (
      <main className="min-h-screen bg-background px-4 py-8 sm:flex sm:items-center sm:justify-center">
        <div className="mx-auto w-full max-w-md">
          <header className="mb-8 flex items-center gap-3">
            <BrandMark className="h-12 w-12 shrink-0" title="TR69 Controle" />
            <div className="min-w-0">
              <p className="text-lg font-bold">TR69 Controle</p>
              <p className="text-sm text-muted-foreground">{t('portal.name')}</p>
            </div>
            <LanguageSwitcher collapseOnMobile className="ms-auto shrink-0" />
          </header>
          <section className="modern-card p-5 sm:p-7">
            <p className="page-kicker">{t('portal.login.kicker')}</p>
            <h1 className="text-2xl font-bold">{t('portal.login.title')}</h1>
            <p className="mb-6 mt-2 text-sm leading-6 text-muted-foreground">
              {t('portal.login.subtitle')}
            </p>
            <form className="space-y-4" onSubmit={login}>
              <div>
                <label className="field-label" htmlFor="customer-id">{t('portal.login.customerId')}</label>
                <input
                  id="customer-id"
                  className="modern-input font-mono uppercase"
                  value={customerId}
                  onChange={(event) => setCustomerId(event.target.value.toUpperCase())}
                  autoComplete="username"
                  maxLength={19}
                  placeholder="CSG-XXXXXXX-XXXXXX"
                  required
                />
              </div>
              <div>
                <label className="field-label" htmlFor="customer-password">{t('portal.login.password')}</label>
                <div className="relative">
                  <input
                    id="customer-password"
                    className="modern-input pe-12 font-mono"
                    type={showLoginPassword ? 'text' : 'password'}
                    inputMode="text"
                    pattern="[A-Za-z0-9]{6,32}"
                    maxLength={32}
                    value={password}
                    onChange={(event) => setPassword(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 32))}
                    autoComplete="current-password"
                    placeholder={t('portal.login.passwordPlaceholder')}
                    required
                  />
                  <button
                    type="button"
                    className="absolute inset-e-1 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                    onClick={() => setShowLoginPassword((visible) => !visible)}
                    aria-label={showLoginPassword ? t('portal.login.hidePassword') : t('portal.login.showPassword')}
                    aria-pressed={showLoginPassword}
                  >
                    <Icon name={showLoginPassword ? 'eye-off' : 'eye'} size={18} />
                  </button>
                </div>
              </div>
              {error && (
                <div className="rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-foreground" role="alert">
                  {error}
                </div>
              )}
              <button className="modern-button w-full" type="submit" disabled={loading}>
                {loading ? <Icon name="refresh" size={17} className="animate-spin" /> : <Icon name="lock" size={17} />}
                {loading ? t('portal.login.submitting') : t('portal.login.submit')}
              </button>
            </form>
          </section>
          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            {t('portal.login.footer')}
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="h-10 w-10 shrink-0" title="TR69 Controle" />
            <div className="min-w-0">
              <p className="line-clamp-2 wrap-break-word font-bold leading-tight">{providerContact?.enabled && providerContact.name ? providerContact.name : t('portal.name')}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{overview?.customerId || customerId}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* No celular, só o globo e a sigla: o nome do provedor precisa do espaço. */}
            <LanguageSwitcher compact className="w-11 sm:hidden" />
            <LanguageSwitcher className="hidden sm:flex" />
            <button type="button" className="modern-button-secondary shrink-0 px-3" onClick={logout}>
              <Icon name="logout" size={17} /> <span className="hidden sm:inline">{t('portal.signOut')}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="page-kicker">{t('portal.overview.kicker')}</p>
            <h1 className="page-title">{t('portal.overview.title')}</h1>
            <p className="page-description">{t('portal.overview.description')}</p>
          </div>
          <button type="button" className="modern-button-secondary" onClick={() => void loadOverview()} disabled={loading}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
            {t('portal.overview.refresh')}
          </button>
        </div>

        {error && (
          <section className="modern-card mb-5 border-destructive/40 p-4" role="alert">
            <div className="flex items-start gap-3">
              <Icon name="warning" className="mt-0.5 shrink-0 text-destructive" />
              <div>
                <h2 className="font-semibold">{t('portal.overview.errorTitle')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                <button type="button" className="mt-3 text-sm font-semibold text-primary hover:underline" onClick={() => void loadOverview()}>
                  {t('common.retry')}
                </button>
              </div>
            </div>
          </section>
        )}

        {!overview && loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('portal.overview.loadingAria')}>
            {[0, 1, 2, 3].map((item) => <div key={item} className="h-36 animate-pulse rounded-(--radius) bg-muted" />)}
          </div>
        ) : overview ? (
          <>
            {overview.status === 'offline' && (
              <div className="mb-4 rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/10 p-4 text-sm">
                {t('portal.overview.offlineWarning')}
              </div>
            )}
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('portal.overview.metricsAria')}>
              <MetricCard
                icon="power"
                label={t('portal.metric.status')}
                value={overview.status === 'online' ? t('portal.metric.statusOnline') : t('portal.metric.statusOffline')}
                helper={t('portal.metric.lastInform', { time: dateTime(overview.lastInform) })}
              />
              <MetricCard icon="signal" label={t('portal.metric.rxPower')} value={`${text(overview.optical.rxPower)}${text(overview.optical.rxPower) === notReported ? '' : ' dBm'}`} />
              <MetricCard icon="thermometer" label={t('portal.metric.temperature')} value={`${text(overview.optical.temperature)}${text(overview.optical.temperature) === notReported ? '' : ' °C'}`} />
              <MetricCard icon="phone" label={t('portal.metric.connectedDevices')} value={text(overview.connectedDevices)} helper={t('portal.metric.connectedDevicesHelper')} />
            </section>

            {/* min-w-0: sem ele o item da grade cresce até o número de série e a página rola de lado no celular */}
            <div className="mt-5 grid gap-5 lg:grid-cols-[1.05fr_.95fr]">
              <section className="modern-card min-w-0 p-5 sm:p-6">
                <h2 className="section-heading">{t('portal.ont.title')}</h2>
                <p className="section-description mb-5">{t('portal.ont.description')}</p>
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  {[
                    [t('portal.ont.manufacturer'), text(overview.ont.manufacturer)],
                    [t('portal.ont.model'), text(overview.ont.model)],
                    [t('portal.ont.serialNumber'), text(overview.ont.serialNumber)],
                    [t('portal.ont.hardware'), text(overview.ont.hardwareVersion)],
                    [t('portal.ont.software'), text(overview.ont.softwareVersion)],
                    [t('portal.ont.uptime'), uptime(overview.ont.uptimeSeconds)],
                    [t('portal.ont.lastBoot'), dateTime(overview.lastBoot)],
                    [t('portal.ont.registered'), dateTime(overview.registered)],
                  ].map(([label, value]) => (
                    <div key={label} className="border-b border-border pb-3">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
                      <dd className="mt-1 break-all font-mono text-sm">{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section className="modern-card min-w-0 p-5 sm:p-6">
                <h2 className="section-heading">{t('portal.wifi.title')}</h2>
                <p className="section-description mb-5">{t('portal.wifi.description')}</p>
                {overview.wifi.length > 0 && (
                  <WifiStatusFilterControl value={wifiFilter} onChange={setWifiFilter} counts={wifiCounts} className="mb-4" />
                )}
                {wifiFeedback && (
                  <div
                    className={`mb-4 rounded-md border p-3 text-sm ${
                      wifiFeedback.type === 'success'
                        ? 'border-[hsl(var(--status-success))]/40 bg-[hsl(var(--status-success))]/10'
                        : 'border-destructive/40 bg-destructive/10'
                    }`}
                    role={wifiFeedback.type === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                  >
                    {wifiFeedback.message}
                  </div>
                )}
                {overview.wifi.length && !visibleWifi.length ? (
                  <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                    {t('detail.wifi.filterEmpty')}
                  </p>
                ) : overview.wifi.length ? (
                  <div className="space-y-3">
                    {visibleWifi.map((network) => (
                      <article key={network.index} className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{text(network.ssid)}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{t('portal.wifi.networkLabel', { index: network.index })}</p>
                          </div>
                          <span className={
                            network.enabled === false
                              ? 'modern-badge-error'
                              : network.enabled === true
                                ? 'modern-badge-success'
                                : 'modern-badge'
                          }>
                            {
                              network.enabled === false
                                ? t('portal.wifi.disabled')
                                : network.enabled === true
                                  ? t('portal.wifi.enabled')
                                  : t('portal.wifi.statusUnknown')
                            }
                          </span>
                        </div>
                        <p className="mt-3 text-sm text-muted-foreground">
                          <strong className="text-foreground">{text(network.connectedDevices)}</strong> {t('portal.wifi.connectedDevices')}
                        </p>
                        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">{t('portal.wifi.savedPassword')}</p>
                            <p className="mt-1 truncate font-mono text-sm">
                              {network.hasSavedPassword
                                ? (
                                    visibleSavedPasswordIndex === network.index &&
                                    revealedWifiPasswords[network.index]
                                      ? revealedWifiPasswords[network.index]
                                      : '••••••••••••'
                                  )
                                : t('portal.wifi.noSavedPassword')}
                            </p>
                          </div>
                          {network.hasSavedPassword && (
                            <button
                              type="button"
                              className="inline-flex size-10 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                              disabled={revealingWifiPasswordIndex === network.index}
                              onClick={() => void toggleSavedWifiPassword(network.index)}
                              aria-label={
                                visibleSavedPasswordIndex === network.index
                                  ? t('portal.wifi.hideSavedPassword')
                                  : t('portal.wifi.showSavedPassword')
                              }
                              aria-pressed={visibleSavedPasswordIndex === network.index}
                            >
                              <Icon
                                name={
                                  revealingWifiPasswordIndex === network.index
                                    ? 'refresh'
                                    : visibleSavedPasswordIndex === network.index
                                      ? 'eye-off'
                                      : 'eye'
                                }
                                size={18}
                                className={revealingWifiPasswordIndex === network.index ? 'animate-spin' : ''}
                              />
                            </button>
                          )}
                        </div>
                        <p className="mt-1.5 text-[0.68rem] leading-5 text-muted-foreground">
                          {t('portal.wifi.savedPasswordHint')}
                        </p>
                        {wifiEditor?.index === network.index ? (
                          <form className="mt-4 space-y-4 border-t border-border pt-4" onSubmit={saveWifi}>
                            <div>
                              <label className="field-label" htmlFor={`wifi-ssid-${network.index}`}>{t('portal.wifi.ssidLabel')}</label>
                              <input
                                id={`wifi-ssid-${network.index}`}
                                className="modern-input"
                                value={wifiEditor.ssid}
                                maxLength={32}
                                onChange={(event) => setWifiEditor((current) => (
                                  current ? { ...current, ssid: event.target.value } : current
                                ))}
                                autoComplete="off"
                                required
                              />
                              <p className="field-hint">{t('portal.wifi.ssidHint')}</p>
                            </div>
                            <div>
                              <label className="field-label" htmlFor={`wifi-password-${network.index}`}>{t('portal.wifi.newPassword')}</label>
                              <div className="relative">
                                <input
                                  id={`wifi-password-${network.index}`}
                                  className="modern-input pe-12 font-mono"
                                  type={showWifiPassword ? 'text' : 'password'}
                                  value={wifiEditor.password}
                                  minLength={wifiEditor.password ? 8 : undefined}
                                  maxLength={63}
                                  onChange={(event) => setWifiEditor((current) => (
                                    current ? { ...current, password: event.target.value } : current
                                  ))}
                                  autoComplete="new-password"
                                  placeholder={t('portal.wifi.newPasswordPlaceholder')}
                                />
                                <button
                                  type="button"
                                  className="absolute inset-e-1 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                                  onClick={() => setShowWifiPassword((visible) => !visible)}
                                  aria-label={showWifiPassword ? t('portal.wifi.hidePassword') : t('portal.wifi.showPassword')}
                                  aria-pressed={showWifiPassword}
                                >
                                  <Icon name={showWifiPassword ? 'eye-off' : 'eye'} size={18} />
                                </button>
                              </div>
                              <p className="field-hint">{t('portal.wifi.passwordHint')}</p>
                            </div>
                            <div className="rounded-md border border-[hsl(var(--status-warning))]/35 bg-[hsl(var(--status-warning))]/10 p-3 text-xs leading-5">
                              {t('portal.wifi.disconnectWarning')}
                            </div>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                              <button
                                type="button"
                                className="modern-button-secondary"
                                disabled={wifiSaving}
                                onClick={() => setWifiEditor(null)}
                              >
                                {t('common.cancel')}
                              </button>
                              <button
                                type="submit"
                                className="modern-button"
                                disabled={
                                  wifiSaving ||
                                  (!wifiEditor.password && wifiEditor.ssid.trim() === text(network.ssid))
                                }
                              >
                                <Icon name={wifiSaving ? 'refresh' : 'check'} size={17} className={wifiSaving ? 'animate-spin' : ''} />
                                {wifiSaving ? t('portal.wifi.saving') : t('portal.wifi.save')}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="modern-button-secondary mt-4 w-full"
                            onClick={() => openWifiEditor(network.index, network.ssid)}
                          >
                            <Icon name="edit" size={17} /> {t('portal.wifi.edit')}
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border p-6 text-center">
                    <Icon name="wifi" className="mx-auto text-muted-foreground" />
                    <p className="mt-2 text-sm font-semibold">{t('portal.wifi.empty')}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{t('portal.wifi.emptyHint')}</p>
                  </div>
                )}
              </section>
            </div>
            <p className="mt-5 text-center text-xs text-muted-foreground">
              {t('portal.footer.updated', { time: dateTime(overview.generatedAt) })}
            </p>
          </>
        ) : null}

          {billing && (
            <section className="modern-card mt-5 p-5 sm:p-6" aria-label={t('portal.billing.title', { plan: billing.contract.plan || t('portal.billing.yourPlan') })}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="section-heading">
                    {t('portal.billing.title', {
                      plan: billing.contract.plan || t('portal.billing.yourPlan')
                    })}
                  </h2>
                  <p className="section-description">
                    {t('portal.billing.summary', { contract: billing.contract.contract })}
                    {billing.contract.statusLabel ? ` · ${billing.contract.statusLabel}` : ''}
                    {billing.contract.document
                      ? ` · ${t('portal.billing.summaryDocument', { document: billing.contract.document })}`
                      : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="modern-button-secondary"
                    onClick={() => void loadBilling()}
                    disabled={billingLoading}
                  >
                    <Icon name="refresh" size={17} className={billingLoading ? 'animate-spin' : ''} />
                    {t('portal.billing.refresh')}
                  </button>
                  {billing.trustUnlockAvailable && (
                    <button
                      type="button"
                      className="modern-button"
                      onClick={() => void requestTrustUnlock()}
                      disabled={unlockPending}
                    >
                      <Icon name={unlockPending ? 'refresh' : 'unlock'} size={17} className={unlockPending ? 'animate-spin' : ''} />
                      {t(unlockPending ? 'portal.billing.trustUnlockPending' : 'portal.billing.trustUnlock')}
                    </button>
                  )}
                </div>
              </div>

              {billingFeedback && (
                <div
                  className={`mt-4 rounded-md border p-3 text-sm ${
                    billingFeedback.type === 'success'
                      ? 'border-[hsl(var(--status-success))]/40 bg-[hsl(var(--status-success))]/10'
                      : 'border-destructive/40 bg-destructive/10'
                  }`}
                  role={billingFeedback.type === 'error' ? 'alert' : 'status'}
                  aria-live="polite"
                >
                  {billingFeedback.message}
                </div>
              )}

              {billing.invoices.length === 0 ? (
                <div className="mt-5 rounded-md border border-dashed border-border p-6 text-center">
                  <Icon name="check" className="mx-auto text-[hsl(var(--status-success))]" />
                  <p className="mt-2 text-sm font-semibold">{t('portal.billing.none')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('portal.billing.noneHint')}</p>
                </div>
              ) : (
                <ul className="mt-5 space-y-3">
                  {billing.invoices.map((invoice, index) => {
                    // The same key the copy state uses, so a row without an id
                    // is still distinguishable from every other row without one.
                    const rowKey = invoice.id || `${invoice.dueDate}-${index}`
                    const bankLine = invoice.digitableLine || invoice.barcode
                    return (
                    <li
                      key={rowKey}
                      className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-lg font-bold">{currency(invoice.amount, intlLocale)}</span>
                        <span className={isOverdue(invoice.dueDate) ? 'modern-badge-error' : 'modern-badge'}>
                          {t(isOverdue(invoice.dueDate) ? 'portal.billing.overdueOn' : 'portal.billing.dueOn', {
                            date: invoiceDueDate(invoice.dueDate)
                          })}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {invoice.description || t('portal.billing.defaultDescription')}
                        {invoice.status ? ` · ${invoice.status}` : ''}
                      </p>
                      {invoice.pix && (
                        <div className="mt-3 rounded-md border border-border bg-card p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {t('portal.billing.pixLabel')}
                          </p>
                          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
                            {looksLikeBrCode(invoice.pix) && (
                              <div className="shrink-0 self-center rounded-md bg-white p-2 sm:self-start">
                                <QrCode
                                  value={invoice.pix}
                                  size={168}
                                  ariaLabel={t('portal.billing.pixQrAlt')}
                                />
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-xs text-muted-foreground">{t('portal.billing.pixHint')}</p>
                              <p className="mt-2 break-all font-mono text-[0.7rem] leading-5">{invoice.pix}</p>
                              <button
                                type="button"
                                className="modern-button-secondary mt-2"
                                onClick={() => void copyCode(`${rowKey}:pix`, invoice.pix)}
                              >
                                <Icon name={copiedCode === `${rowKey}:pix` ? 'check' : 'copy'} size={17} />
                                {t(copiedCode === `${rowKey}:pix` ? 'portal.billing.copied' : 'portal.billing.copyPix')}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                      {bankLine && (
                        <p className="mt-3 break-all rounded-md border border-border bg-card px-3 py-2 font-mono text-xs">
                          {bankLine}
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {bankLine && (
                          <button
                            type="button"
                            className="modern-button-secondary"
                            onClick={() => void copyCode(`${rowKey}:line`, bankLine)}
                          >
                            <Icon name={copiedCode === `${rowKey}:line` ? 'check' : 'copy'} size={17} />
                            {t(copiedCode === `${rowKey}:line` ? 'portal.billing.copied' : 'portal.billing.copy')}
                          </button>
                        )}
                        {safeBoletoUrl(invoice.link) && (
                          <a
                            className="modern-button-secondary"
                            href={safeBoletoUrl(invoice.link) as string}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Icon name="external" size={17} /> {t('portal.billing.openBoleto')}
                          </a>
                        )}
                      </div>
                    </li>
                    )
                  })}
                </ul>
              )}

              <p className="mt-4 text-xs text-muted-foreground">
                {t('portal.billing.source', { time: dateTime(billing.generatedAt) })}
              </p>
            </section>
          )}

          {!billing && billingError && (
            <section className="modern-card mt-5 border-destructive/40 p-4" role="alert">
              <div className="flex items-start gap-3">
                <Icon name="warning" className="mt-0.5 shrink-0 text-destructive" />
                <div>
                  <h2 className="font-semibold">{t('portal.billing.unavailable')}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{billingError}</p>
                  <button
                    type="button"
                    className="mt-3 text-sm font-semibold text-primary hover:underline"
                    onClick={() => void loadBilling()}
                  >
                    {t('portal.billing.retry')}
                  </button>
                </div>
              </div>
            </section>
          )}

          {hasContact(providerContact) && (
            <section className="modern-card mt-5 p-4 sm:p-5" aria-labelledby="portal-contact-title">
              <p className="page-kicker">{t('portal.contact.kicker')}</p>
              <h2 id="portal-contact-title" className="section-heading">
                {providerContact.name ? t('portal.contact.titleNamed', { name: providerContact.name }) : t('portal.contact.title')}
              </h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {whatsappHref(providerContact.whatsapp) && (
                  <a className="modern-button" href={whatsappHref(providerContact.whatsapp) as string} target="_blank" rel="noopener noreferrer">
                    <Icon name="chat" size={17} /> {t('portal.contact.whatsapp')}
                  </a>
                )}
                {telHref(providerContact.phone) && (
                  <a className="modern-button-secondary max-w-full" href={telHref(providerContact.phone) as string}>
                    <Icon name="phone" size={17} className="shrink-0" /> <span className="min-w-0 break-all">{providerContact.phone}</span>
                  </a>
                )}
                {mailtoHref(providerContact.email) && (
                  <a className="modern-button-secondary max-w-full" href={mailtoHref(providerContact.email) as string}>
                    <Icon name="document" size={17} className="shrink-0" /> <span className="min-w-0 break-all">{providerContact.email}</span>
                  </a>
                )}
              </div>
              {providerContact.address && (
                <p className="mt-4 flex items-start gap-2 text-sm text-muted-foreground">
                  <Icon name="pin" size={16} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 wrap-break-word">{providerContact.address}</span>
                </p>
              )}
            </section>
          )}

      </div>
    </main>
  )
}
