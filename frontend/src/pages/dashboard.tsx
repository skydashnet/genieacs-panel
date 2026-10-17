'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { devicesAPI, sgpAPI, type SgpFleetOverview } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'
import { readDashboardSnapshot, writeDashboardSnapshot } from '@/lib/dashboard-snapshot'
import { sessionOwner } from '@/lib/session-owner'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { useToast } from '@/components/ui/toast'
import { PieChart } from '@/components/charts/pie-chart'
import { BarChart } from '@/components/charts/bar-chart'
import { TrendChart } from '@/components/charts/trend-chart'
import { DeviceSwapsCard } from '@/components/device-swaps-card'
import { OnboardingChecklist } from '@/components/onboarding-checklist'
import { OutagePanel } from '@/components/outages/outage-panel'
import { MaintenancePanel } from '@/components/maintenance/maintenance-panel'

interface Fault {
  id: string
  deviceId: string | null
  channel: string
  code: string
  message: string
  timestamp: string | null
  retries: number
}

interface DashboardData {
  generatedAt?: string
  stats: { total: number; online: number; offline: number; new24h: number }
  rxDistribution: Record<string, number>
  informFreshness: Record<string, number>
  temperatureDistribution: Record<string, number>
  clientDistribution: Record<string, number>
  productClasses: { name: string; value: number }[]
  manufacturers: { name: string; value: number }[]
  registrations: { name: string; value: number }[]
  faults: Fault[]
  faultsError: string | null
}

const EMPTY: DashboardData = {
  stats: { total: 0, online: 0, offline: 0, new24h: 0 },
  rxDistribution: {},
  informFreshness: {},
  temperatureDistribution: {},
  clientDistribution: {},
  productClasses: [],
  manufacturers: [],
  registrations: [],
  faults: [],
  faultsError: null,
}

const PALETTES = {
  rx: { Excellent: '#22c55e', Good: '#3b82f6', Poor: '#eab308', Danger: '#ef4444', Unknown: '#64748b' },
  freshness: { 'Under 10m': '#22c55e', '10–60m': '#3b82f6', '1–24h': '#eab308', 'Over 24h': '#ef4444' },
  temperature: { Normal: '#22c55e', Warm: '#eab308', Hot: '#ef4444', Unknown: '#64748b' },
  clients: { '0': '#64748b', '1–5': '#3b82f6', '6–15': '#8b5cf6', '16+': '#f97316', Unknown: '#94a3b8' },
}

const SGP_PREVIEW_ROWS = 4

interface SgpDivergenceGroup {
  key: string
  titleKey: TranslationKey
  hintKey: TranslationKey
  emptyKey: TranslationKey
  tone: string
  total: number
  rows: {
    deviceId: string
    detail: string
    /** Only the stale-active group sets this: `null` means no likely replacement was found. */
    successor?: { deviceId: string } | null
  }[]
}

/** GenieACS reports these bucket names in English; the panel shows them translated. */
const BUCKET_LABEL_KEYS: Record<string, TranslationKey> = {
  Excellent: 'dashboard.bucket.excellent',
  Good: 'dashboard.bucket.good',
  Poor: 'dashboard.bucket.poor',
  Danger: 'dashboard.bucket.danger',
  Unknown: 'dashboard.bucket.unknown',
  'Under 10m': 'dashboard.bucket.under10m',
  '10–60m': 'dashboard.bucket.from10to60m',
  '1–24h': 'dashboard.bucket.from1to24h',
  'Over 24h': 'dashboard.bucket.over24h',
  Normal: 'dashboard.bucket.normal',
  Warm: 'dashboard.bucket.warm',
  Hot: 'dashboard.bucket.hot',
  '0': 'dashboard.bucket.clients0',
  '1–5': 'dashboard.bucket.clients1to5',
  '6–15': 'dashboard.bucket.clients6to15',
  '16+': 'dashboard.bucket.clients16plus',
}

function readDashboardSession(owner: string | null): DashboardData | null {
  const parsed = readDashboardSnapshot<DashboardData>(owner)
  return parsed?.stats && parsed?.rxDistribution ? parsed : null
}

function pieData(
  distribution: Record<string, number>,
  palette: Record<string, string>,
  translateBucket: (name: string) => string,
) {
  return Object.entries(distribution)
    .map(([name, value]) => ({
      name: translateBucket(name),
      value: Number(value) || 0,
      color: palette[name] || '#64748b',
    }))
    .filter((entry) => entry.value > 0)
}

/**
 * O dono da cópia guardada: provedor e usuário. A `key` remonta a tela quando
 * ele muda, para nenhum estado de um provedor atravessar para o outro.
 */
export default function DashboardPage() {
  const { user } = useAuth()
  const owner = sessionOwner(user)
  return <DashboardView key={owner ?? 'anon'} owner={owner} />
}

function DashboardView({ owner }: { owner: string | null }) {
  const [cachedDashboard] = useState<DashboardData | null>(() => readDashboardSession(owner))
  const [data, setData] = useState<DashboardData>(cachedDashboard || EMPTY)
  const [initialLoading, setInitialLoading] = useState(!cachedDashboard)
  const [refreshing, setRefreshing] = useState(false)
  const [faultsLoading, setFaultsLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [clearingFault, setClearingFault] = useState<string | null>(null)
  const [sgpOverview, setSgpOverview] = useState<SgpFleetOverview | null>(null)
  const faultsLoadedRef = useRef(false)
  const { user, can } = useAuth()
  const { t, formatDateTime, formatTime } = useTranslation()
  const toast = useToast()
  // Duas capacidades e não uma: a matriz dá `devices.inspect` e `devices.write`
  // ao plantão, e era `role === 'admin'` que escondia dele as duas.
  const canInspect = can('devices.inspect')
  const canWrite = can('devices.write')

  const loadDashboard = useCallback(async (force = false) => {
    setLoadError('')
    setRefreshing(true)
    try {
      const response = await devicesAPI.getDashboard(force)
      if (!response.success || !response.data) {
        throw new Error(response.message || t('dashboard.error.dashboardUnavailable'))
      }
      const incoming = response.data as DashboardData
      setData((current) => {
        const next = faultsLoadedRef.current
          ? { ...incoming, faults: current.faults, faultsError: current.faultsError }
          : incoming
        writeDashboardSnapshot(owner, next)
        return next
      })
      const generatedAt = incoming.generatedAt ? new Date(incoming.generatedAt) : new Date()
      setLastUpdated(Number.isNaN(generatedAt.getTime()) ? new Date() : generatedAt)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('dashboard.error.unreachable'))
    } finally {
      setInitialLoading(false)
      setRefreshing(false)
    }
  }, [owner, t])

  const loadFaults = useCallback(async () => {
    setFaultsLoading(true)
    try {
      const response = await devicesAPI.getFaults(50)
      if (!response.success || !Array.isArray(response.data)) {
        throw new Error(response.message || t('dashboard.error.faultsUnavailable'))
      }
      faultsLoadedRef.current = true
      setData((current) => {
        const next = { ...current, faults: response.data as Fault[], faultsError: null }
        writeDashboardSnapshot(owner, next)
        return next
      })
    } catch {
      faultsLoadedRef.current = true
      setData((current) => ({ ...current, faultsError: t('dashboard.error.faultsLoad') }))
    } finally {
      setFaultsLoading(false)
    }
  }, [owner, t])

  // The reconciliation card disappears when SGP is off or unreachable; there is
  // nothing an operator could do about it from the dashboard.
  const loadSgpOverview = useCallback(async () => {
    const response = await sgpAPI.getOverview()
    setSgpOverview(response.success && response.data?.enabled ? response.data : null)
  }, [])

  useEffect(() => {
    if (cachedDashboard?.generatedAt) {
      const cachedDate = new Date(cachedDashboard.generatedAt)
      if (!Number.isNaN(cachedDate.getTime())) setLastUpdated(cachedDate)
    }
    void loadDashboard(false)
    void loadFaults()
    void loadSgpOverview()
  }, [cachedDashboard, loadDashboard, loadFaults, loadSgpOverview])

  const translateBucket = useCallback(
    (name: string) => (BUCKET_LABEL_KEYS[name] ? t(BUCKET_LABEL_KEYS[name]) : name),
    [t],
  )
  const formatFaultTime = useCallback(
    (timestamp: string | null) => (timestamp ? formatDateTime(timestamp) : t('dashboard.faults.unknownTime')),
    [formatDateTime, t],
  )

  const rxData = useMemo(() => pieData(data.rxDistribution, PALETTES.rx, translateBucket), [data.rxDistribution, translateBucket])
  const freshnessData = useMemo(() => pieData(data.informFreshness, PALETTES.freshness, translateBucket), [data.informFreshness, translateBucket])
  const temperatureData = useMemo(() => pieData(data.temperatureDistribution, PALETTES.temperature, translateBucket), [data.temperatureDistribution, translateBucket])
  const clientData = useMemo(() => pieData(data.clientDistribution, PALETTES.clients, translateBucket), [data.clientDistribution, translateBucket])
  const productData = useMemo(() => [...data.productClasses].reverse(), [data.productClasses])
  const manufacturerData = useMemo(() => [...data.manufacturers].reverse(), [data.manufacturers])

  const sgpGroups = useMemo<SgpDivergenceGroup[]>(() => {
    if (!sgpOverview) return []
    const { onlineBlocked, offlineActive, unlinked } = sgpOverview.divergences
    // `?? []`/`?? 0`: an older backend does not send the stale block yet.
    const staleActive = sgpOverview.divergences.staleActive ?? []
    // The lists are samples; the counts to show come from `totals`.
    const { totals } = sgpOverview
    return [
      {
        key: 'onlineBlocked',
        titleKey: 'dashboard.sgp.onlineBlocked.title',
        hintKey: 'dashboard.sgp.onlineBlocked.hint',
        emptyKey: 'dashboard.sgp.onlineBlocked.empty',
        tone: 'text-[hsl(var(--status-danger))]',
        total: totals.onlineBlocked,
        rows: onlineBlocked.slice(0, SGP_PREVIEW_ROWS).map((row) => ({
          deviceId: row.deviceId,
          detail: [row.clientName, row.statusLabel || row.state, row.contract].filter(Boolean).join(' · '),
        })),
      },
      {
        key: 'offlineActive',
        titleKey: 'dashboard.sgp.offlineActive.title',
        hintKey: 'dashboard.sgp.offlineActive.hint',
        emptyKey: 'dashboard.sgp.offlineActive.empty',
        tone: 'text-[hsl(var(--status-warning))]',
        total: totals.offlineActive,
        rows: offlineActive.slice(0, SGP_PREVIEW_ROWS).map((row) => ({
          deviceId: row.deviceId,
          detail: [row.clientName, row.contract, row.lastInform ? t('dashboard.sgp.lastInform', { time: formatDateTime(row.lastInform) }) : null]
            .filter(Boolean)
            .join(' · '),
        })),
      },
      {
        key: 'staleActive',
        titleKey: 'dashboard.sgp.staleActive.title',
        hintKey: 'dashboard.sgp.staleActive.hint',
        emptyKey: 'dashboard.sgp.staleActive.empty',
        tone: 'text-[hsl(var(--status-warning))]',
        total: totals.staleActive ?? 0,
        rows: staleActive.slice(0, SGP_PREVIEW_ROWS).map((row) => ({
          deviceId: row.deviceId,
          detail: [row.clientName, row.contract, row.lastInform ? t('dashboard.sgp.lastInform', { time: formatDateTime(row.lastInform) }) : null]
            .filter(Boolean)
            .join(' · '),
          successor: row.successor ? { deviceId: row.successor.deviceId } : null,
        })),
      },
      {
        key: 'unlinked',
        titleKey: 'dashboard.sgp.unlinked.title',
        hintKey: 'dashboard.sgp.unlinked.hint',
        emptyKey: 'dashboard.sgp.unlinked.empty',
        tone: 'text-foreground',
        total: totals.unlinked,
        rows: unlinked.slice(0, SGP_PREVIEW_ROWS).map((row) => ({
          deviceId: row.deviceId,
          detail: [row.pppoe, row.customerId].filter(Boolean).join(' · ') || t('dashboard.sgp.noIdentifier'),
        })),
      },
    ]
  }, [formatDateTime, sgpOverview, t])

  const availability = data.stats.total ? Math.round((data.stats.online / data.stats.total) * 100) : 0
  const signalRisk = (data.rxDistribution.Poor || 0) + (data.rxDistribution.Danger || 0)

  const clearFault = async (fault: Fault) => {
    const confirmMessage = t('dashboard.faults.confirmClear', {
      code: fault.code,
      device: fault.deviceId || t('dashboard.faults.unknownDevice'),
    })
    if (!window.confirm(confirmMessage)) return
    try {
      setClearingFault(fault.id)
      const response = await devicesAPI.clearFault(fault.id)
      if (!response.success) throw new Error(response.message || t('dashboard.faults.clearFailed'))
      setData((current) => ({ ...current, faults: current.faults.filter((entry) => entry.id !== fault.id) }))
      toast.success(t('dashboard.faults.cleared'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('dashboard.faults.clearFailed'))
    } finally {
      setClearingFault(null)
    }
  }

  if (initialLoading) {
    return (
      <div className="page-shell"><div className="page-frame">
        <header className="page-header"><div><p className="page-kicker">{t('dashboard.kicker')}</p><h1 className="page-title">{t('dashboard.title')}</h1><p className="page-description">{t('dashboard.loadingDescription')}</p></div></header>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="status">
          {[0, 1, 2, 3].map((item) => <div key={item} className="modern-card h-28 animate-pulse bg-muted" />)}
        </div>
      </div></div>
    )
  }

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <p className="page-kicker">{t('dashboard.kicker')}</p>
            <h1 className="page-title">{t('dashboard.title')}</h1>
            <p className="page-description">{t('dashboard.description', { user: user?.username || t('dashboard.operatorFallback') })}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">{lastUpdated ? t('dashboard.updatedAt', { time: formatTime(lastUpdated) }) : t('dashboard.noUpdate')}</span>
            <button type="button" className="modern-button-secondary" disabled={refreshing} onClick={() => { void loadDashboard(true); void loadSgpOverview() }}>
              <Icon name="refresh" size={17} className={refreshing ? 'animate-spin' : ''} />{refreshing ? t('dashboard.refreshing') : t('common.refresh')}
            </button>
          </div>
        </header>

        {loadError && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[hsl(var(--status-danger))]/40 bg-[hsl(var(--status-danger))]/10 p-4" role="alert">
            <div className="flex items-center gap-3"><Icon name="warning" className="text-[hsl(var(--status-danger))]" /><span className="text-sm font-semibold">{loadError}</span></div>
            <button className="modern-button-secondary" onClick={() => void loadDashboard(true)}>{t('common.retry')}</button>
          </div>
        )}

        {/* Só com queda em andamento; some sozinho quando ela acaba. */}
        {can('whatsapp.read') && <OutagePanel onlyOpen />}
        {can('whatsapp.read') && <MaintenancePanel compact />}

        <OnboardingChecklist />

        {canInspect && <DeviceSwapsCard />}

        {/* Cada número leva à lista que ele conta, e agora todos levam: a API
            de equipamentos passou a cumprir os recortes do painel, então o
            clique em "3 novos em 24h" abre três linhas. As faixas são as
            mesmas dos dois lados porque são o mesmo código — se o número e a
            lista discordassem, o link seria pior que texto parado. */}
        <section className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          {([
            ['dashboard.stat.total', data.stats.total, 'server', 'text-foreground', '/devices'],
            ['dashboard.stat.online', data.stats.online, 'check', 'text-[hsl(var(--status-success))]', '/devices?status=online'],
            ['dashboard.stat.offline', data.stats.offline, 'warning', 'text-[hsl(var(--status-danger))]', '/devices?status=offline'],
            ['dashboard.stat.new24h', data.stats.new24h, 'bell', 'text-primary', '/devices?focus=new24h'],
          ] as const).map(([labelKey, value, icon, color, to]) => {
            const corpo = (
              <>
                <div className="flex items-start justify-between gap-2"><p className="metric-label min-w-0">{t(labelKey)}</p><Icon name={icon} size={19} className="shrink-0 text-muted-foreground" /></div>
                <p className={`metric-value mt-3 truncate text-2xl sm:mt-4 sm:text-3xl ${color}`}>{value}</p>
              </>
            )
            return to
              ? (
                <Link
                  key={labelKey}
                  to={to}
                  className="modern-card block min-w-0 p-4 transition-colors hover:border-primary focus-visible:border-primary sm:p-5"
                >
                  {corpo}
                </Link>
              )
              : <div key={labelKey} className="modern-card min-w-0 p-4 sm:p-5">{corpo}</div>
          })}
        </section>

        <section className="mb-5 grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
          <div className="modern-card overflow-hidden">
            <div className="grid min-h-56 sm:grid-cols-[1fr_1.3fr]">
              <div className="flex flex-col justify-between bg-[#173f35] p-6 text-[#f4f3ed] sm:p-7">
                <div><p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[#b7c7be]">{t('dashboard.availability.label')}</p><p className="mt-3 font-mono text-5xl font-semibold tracking-tighter">{availability}%</p></div>
                <p className="mt-8 text-sm leading-6 text-[#c8d4ce]">{t('dashboard.availability.description', { online: data.stats.online, total: data.stats.total })}</p>
              </div>
              <div className="grid grid-cols-2">
                <Link to="/devices?focus=weak-signal" className="block border-b border-e border-border p-5 transition-colors hover:text-primary"><p className="metric-label">{t('dashboard.metric.opticalRisk')}</p><p className="metric-value text-[hsl(var(--status-warning))]">{signalRisk}</p></Link>
                {/* As falhas continuam apontando para dentro desta página: a
                    tabela delas está logo abaixo, e não há lista de
                    equipamentos que responda por elas. Os três vizinhos agora
                    apontam para o recorte que cada um conta. */}
                <a href="#dashboard-faults" className="block border-b border-border p-5 transition-colors hover:text-primary"><p className="metric-label">{t('dashboard.metric.activeFaults')}</p><p className="metric-value text-[hsl(var(--status-danger))]">{data.faults.length}</p></a>
                <Link to="/devices?focus=hot" className="block border-e border-border p-5 transition-colors hover:text-primary"><p className="metric-label">{t('dashboard.metric.hotDevices')}</p><p className="metric-value">{data.temperatureDistribution.Hot || 0}</p></Link>
                <Link to="/devices?focus=many-clients" className="block p-5 transition-colors hover:text-primary"><p className="metric-label">{t('dashboard.metric.manyClients')}</p><p className="metric-value">{data.clientDistribution['16+'] || 0}</p></Link>
              </div>
            </div>
          </div>
          <div className="modern-card p-5">
            <div className="flex items-start justify-between"><div><h2 className="section-heading">{t('dashboard.queue.title')}</h2><p className="section-description">{t('dashboard.queue.description')}</p></div><Icon name="bell" /></div>
            <div className="mt-5 divide-y divide-border">
              {/* Levava para `/devices` sem filtro: clicar em "7 offline" abria
                  os 29. O recorte agora vai na URL. */}
              <Link to="/devices?status=offline" className="flex min-h-16 items-center justify-between gap-3 py-3 hover:text-primary"><span><strong className="block text-sm">{t('dashboard.queue.offline')}</strong><small className="text-muted-foreground">{t('dashboard.queue.offlineHint')}</small></span><span className="data-value text-[hsl(var(--status-danger))]">{data.stats.offline}</span></Link>
              {/* As falhas não são uma lista de equipamentos: a tabela delas
                  está logo abaixo, nesta mesma página. O destino honesto é
                  ela, e não `/devices`. */}
              <a href="#dashboard-faults" className="flex min-h-16 items-center justify-between gap-3 py-3 hover:text-primary"><span><strong className="block text-sm">{t('dashboard.queue.faults')}</strong><small className="text-muted-foreground">{t('dashboard.queue.faultsHint')}</small></span><span className="data-value text-[hsl(var(--status-danger))]">{data.faults.length}</span></a>
              {/* Voltou a ser link, e só porque o recorte existe: `focus=weak-signal`
                  devolve as faixas Poor e Danger, que são as duas que este
                  número soma. Ele tinha DEIXADO de ser link no dia em que
                  levava a `/devices` sem filtro — prometia "estes com sinal
                  fraco" e entregava o inventário inteiro. */}
              <Link to="/devices?focus=weak-signal" className="flex min-h-16 items-center justify-between gap-3 py-3 hover:text-primary"><span><strong className="block text-sm">{t('dashboard.queue.weakSignal')}</strong><small className="text-muted-foreground">{t('dashboard.queue.weakSignalHint')}</small></span><span className="data-value text-[hsl(var(--status-warning))]">{signalRisk}</span></Link>
            </div>
          </div>
        </section>

        {sgpOverview && (
          <section className="modern-card mb-5 overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 className="section-heading">{t('dashboard.sgp.title')}</h2>
                <p className="section-description">{t('dashboard.sgp.description')}</p>
              </div>
              <p className="text-xs leading-5 text-muted-foreground xl:text-end">
                <span className="block">
                  {t('dashboard.sgp.linkedCount', { linked: sgpOverview.totals.linked, total: sgpOverview.totals.devices })}
                </span>
                <span className="block">
                  {sgpOverview.lastSync
                    ? t('dashboard.sgp.lastSync', {
                        time: formatDateTime(sgpOverview.lastSync.finishedAt),
                        linked: sgpOverview.lastSync.linked,
                        created: sgpOverview.lastSync.created,
                        updated: sgpOverview.lastSync.updated,
                        failed: sgpOverview.lastSync.failed,
                      })
                    : t('dashboard.sgp.neverSynced')}
                </span>
              </p>
            </div>
            <div className="grid grid-cols-1 gap-px bg-border md:grid-cols-2 xl:grid-cols-4">
              {sgpGroups.map((group) => (
                <div key={group.key} className="min-w-0 bg-card p-5">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-sm font-semibold">{t(group.titleKey)}</h3>
                    <span className={`data-value ${group.tone}`}>{group.total}</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(group.hintKey)}</p>
                  {group.rows.length === 0 ? (
                    <p className="mt-4 text-sm text-muted-foreground">{t(group.emptyKey)}</p>
                  ) : (
                    <ul className="mt-4 divide-y divide-border">
                      {group.rows.map((row) => (
                        <li key={row.deviceId}>
                          <Link
                            to={`/devices/detail?id=${encodeURIComponent(row.deviceId)}`}
                            className="flex items-center justify-between gap-2 py-2 hover:text-primary"
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-mono text-xs font-semibold">{row.deviceId}</span>
                              {row.detail && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{row.detail}</span>}
                            </span>
                            <Icon name="chevron-right" size={16} className="shrink-0" />
                          </Link>
                          {row.successor !== undefined && (
                            <p className="-mt-1 flex flex-wrap items-center gap-2 pb-2 text-xs">
                              {row.successor ? (
                                <>
                                  <span className="rounded-full border border-[hsl(var(--status-warning))]/50 bg-[hsl(var(--status-warning))]/10 px-2 py-0.5 text-[hsl(var(--status-warning))]">
                                    {t('dashboard.sgp.staleActive.likelySwap')}
                                  </span>
                                  <Link
                                    to={`/devices/detail?id=${encodeURIComponent(row.successor.deviceId)}`}
                                    className="min-w-0 truncate font-mono hover:text-primary"
                                  >
                                    → {row.successor.deviceId}
                                  </Link>
                                </>
                              ) : (
                                <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                                  {t('dashboard.sgp.staleActive.noSuccessor')}
                                </span>
                              )}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {group.total > group.rows.length && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t('dashboard.sgp.more', { count: group.total - group.rows.length })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mb-5 grid gap-4 xl:grid-cols-2">
          <div className="modern-card p-5"><h2 className="section-heading">{t('dashboard.chart.rx.title')}</h2><p className="section-description mb-3">{t('dashboard.chart.rx.description')}</p>{rxData.length ? <PieChart data={rxData} /> : <p className="empty-state-copy py-16 text-center">{t('dashboard.chart.rx.empty')}</p>}</div>
          <div className="modern-card p-5"><h2 className="section-heading">{t('dashboard.chart.freshness.title')}</h2><p className="section-description mb-3">{t('dashboard.chart.freshness.description')}</p>{freshnessData.length ? <PieChart data={freshnessData} /> : <p className="empty-state-copy py-16 text-center">{t('dashboard.chart.freshness.empty')}</p>}</div>
          <div className="modern-card p-5"><h2 className="section-heading">{t('dashboard.chart.temperature.title')}</h2><p className="section-description mb-3">{t('dashboard.chart.temperature.description')}</p>{temperatureData.length ? <PieChart data={temperatureData} /> : <p className="empty-state-copy py-16 text-center">{t('dashboard.chart.temperature.empty')}</p>}</div>
          <div className="modern-card p-5"><h2 className="section-heading">{t('dashboard.chart.clients.title')}</h2><p className="section-description mb-3">{t('dashboard.chart.clients.description')}</p>{clientData.length ? <PieChart data={clientData} /> : <p className="empty-state-copy py-16 text-center">{t('dashboard.chart.clients.empty')}</p>}</div>
        </section>

        <section className="mb-5 grid gap-4 xl:grid-cols-3">
          <div className="modern-card p-5 xl:col-span-2"><h2 className="section-heading">{t('dashboard.chart.registrations.title')}</h2><p className="section-description mb-3">{t('dashboard.chart.registrations.description')}</p><TrendChart data={data.registrations} valueLabel={t('dashboard.chart.registrations.valueLabel')} /></div>
          <div className="modern-card p-5"><h2 className="section-heading">{t('dashboard.chart.manufacturers.title')}</h2><p className="section-description mb-3">{t('dashboard.chart.manufacturers.description')}</p>{manufacturerData.length ? <BarChart data={manufacturerData} /> : <p className="empty-state-copy py-16 text-center">{t('dashboard.chart.manufacturers.empty')}</p>}</div>
          <div className="modern-card p-5 xl:col-span-3"><h2 className="section-heading">{t('dashboard.chart.products.title')}</h2><p className="section-description mb-3">{t('dashboard.chart.products.description')}</p>{productData.length ? <BarChart data={productData} /> : <p className="empty-state-copy py-16 text-center">{t('dashboard.chart.products.empty')}</p>}</div>
        </section>

        <section id="dashboard-faults" className="modern-card overflow-hidden scroll-mt-4">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div><h2 className="section-heading">{t('dashboard.faults.title')}</h2><p className="section-description">{t('dashboard.faults.description')}</p></div>
            <div className="flex items-center gap-2">
              <span className={data.faults.length ? 'modern-badge-error' : 'modern-badge-success'}>{faultsLoading ? t('dashboard.refreshing') : t('dashboard.faults.activeCount', { count: data.faults.length })}</span>
              <button type="button" className="modern-button-secondary min-h-10 px-3 py-1.5 md:min-h-9" disabled={faultsLoading} onClick={() => void loadFaults()}>
                <Icon name="refresh" size={16} className={faultsLoading ? 'animate-spin' : ''} /> {t('common.refresh')}
              </button>
            </div>
          </div>
          {data.faultsError && <div className="border-b border-border bg-[hsl(var(--status-warning))]/10 px-5 py-3 text-sm">{data.faultsError}</div>}
          <div className="desktop-table overflow-x-auto">
            <table className="modern-table">
              <thead><tr><th>{t('dashboard.faults.time')}</th><th>{t('dashboard.faults.device')}</th><th>{t('dashboard.faults.channelCode')}</th><th>{t('dashboard.faults.message')}</th>{canWrite && <th>{t('dashboard.faults.action')}</th>}</tr></thead>
              <tbody>
                {data.faults.slice(0, 25).map((fault) => (
                  <tr key={fault.id}>
                    <td className="whitespace-nowrap text-xs">{formatFaultTime(fault.timestamp)}</td>
                    <td className="max-w-60 break-all font-mono text-xs">{fault.deviceId || '—'}</td>
                    <td><span className="modern-badge-error">{fault.code}</span><small className="mt-1 block text-muted-foreground">{fault.channel}{fault.retries ? ` · ${t('dashboard.faults.retry', { count: fault.retries })}` : ''}</small></td>
                    <td className="min-w-72 max-w-xl text-sm wrap-anywhere">{fault.message}</td>
                    {canWrite && <td><button type="button" className="modern-button-secondary" disabled={clearingFault === fault.id} onClick={() => void clearFault(fault)}>{clearingFault === fault.id ? t('dashboard.faults.clearing') : t('dashboard.faults.clear')}</button></td>}
                  </tr>
                ))}
                {!data.faults.length && <tr><td colSpan={canWrite ? 5 : 4} className="py-12 text-center text-muted-foreground">{t('dashboard.faults.empty')}</td></tr>}
              </tbody>
            </table>
          </div>
          {/* No celular a mesma lista vira cartões: a tabela obrigava a rolar
              de lado para ler a mensagem, que é o que importa na falha. */}
          <ul className="mobile-card-list divide-y divide-border">
            {data.faults.slice(0, 25).map((fault) => (
              <li key={fault.id} className="space-y-2 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="modern-badge-error">{fault.code}</span>
                  <span className="text-xs text-muted-foreground">{formatFaultTime(fault.timestamp)}</span>
                </div>
                <p className="break-all font-mono text-xs">{fault.deviceId || '—'}</p>
                <p className="wrap-break-word text-sm">{fault.message}</p>
                <p className="text-xs text-muted-foreground">{fault.channel}{fault.retries ? ` · ${t('dashboard.faults.retry', { count: fault.retries })}` : ''}</p>
                {canWrite && (
                  <button type="button" className="modern-button-secondary w-full" disabled={clearingFault === fault.id} onClick={() => void clearFault(fault)}>
                    {clearingFault === fault.id ? t('dashboard.faults.clearing') : t('dashboard.faults.clear')}
                  </button>
                )}
              </li>
            ))}
            {!data.faults.length && <li className="py-12 text-center text-sm text-muted-foreground">{t('dashboard.faults.empty')}</li>}
          </ul>
        </section>
      </div>
    </div>
  )
}
