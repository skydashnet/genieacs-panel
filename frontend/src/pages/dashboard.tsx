'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { devicesAPI } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'
import { useToast } from '@/components/ui/toast'
import { PieChart } from '@/components/charts/pie-chart'
import { BarChart } from '@/components/charts/bar-chart'
import { TrendChart } from '@/components/charts/trend-chart'

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

const DASHBOARD_SESSION_KEY = 'skygenpanel.dashboard.snapshot.v1'

function readDashboardSession(): DashboardData | null {
  try {
    const raw = sessionStorage.getItem(DASHBOARD_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.stats && parsed?.rxDistribution ? parsed as DashboardData : null
  } catch {
    return null
  }
}

function writeDashboardSession(data: DashboardData) {
  try {
    sessionStorage.setItem(DASHBOARD_SESSION_KEY, JSON.stringify(data))
  } catch {
    // Storage can be disabled by browser privacy settings.
  }
}

function pieData(distribution: Record<string, number>, palette: Record<string, string>) {
  return Object.entries(distribution)
    .map(([name, value]) => ({ name, value: Number(value) || 0, color: palette[name] || '#64748b' }))
    .filter((entry) => entry.value > 0)
}

function formatFaultTime(timestamp: string | null) {
  if (!timestamp) return 'Unknown time'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return date.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })
}

export default function DashboardPage() {
  const [cachedDashboard] = useState<DashboardData | null>(() => readDashboardSession())
  const [data, setData] = useState<DashboardData>(cachedDashboard || EMPTY)
  const [initialLoading, setInitialLoading] = useState(!cachedDashboard)
  const [refreshing, setRefreshing] = useState(false)
  const [faultsLoading, setFaultsLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [clearingFault, setClearingFault] = useState<string | null>(null)
  const faultsLoadedRef = useRef(false)
  const { user } = useAuth()
  const toast = useToast()
  const isAdmin = user?.role === 'admin'

  const loadDashboard = useCallback(async (force = false) => {
    setLoadError('')
    setRefreshing(true)
    try {
      const response = await devicesAPI.getDashboard(force)
      if (!response.success || !response.data) {
        throw new Error(response.message || 'Dashboard data is unavailable')
      }
      const incoming = response.data as DashboardData
      setData((current) => {
        const next = faultsLoadedRef.current
          ? { ...incoming, faults: current.faults, faultsError: current.faultsError }
          : incoming
        writeDashboardSession(next)
        return next
      })
      const generatedAt = incoming.generatedAt ? new Date(incoming.generatedAt) : new Date()
      setLastUpdated(Number.isNaN(generatedAt.getTime()) ? new Date() : generatedAt)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Panel could not reach GenieACS')
    } finally {
      setInitialLoading(false)
      setRefreshing(false)
    }
  }, [])

  const loadFaults = useCallback(async () => {
    setFaultsLoading(true)
    try {
      const response = await devicesAPI.getFaults(50)
      if (!response.success || !Array.isArray(response.data)) {
        throw new Error(response.message || 'Fault list is unavailable')
      }
      faultsLoadedRef.current = true
      setData((current) => {
        const next = { ...current, faults: response.data as Fault[], faultsError: null }
        writeDashboardSession(next)
        return next
      })
    } catch {
      faultsLoadedRef.current = true
      setData((current) => ({ ...current, faultsError: 'Fault list could not be loaded from GenieACS.' }))
    } finally {
      setFaultsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (cachedDashboard?.generatedAt) {
      const cachedDate = new Date(cachedDashboard.generatedAt)
      if (!Number.isNaN(cachedDate.getTime())) setLastUpdated(cachedDate)
    }
    void loadDashboard(false)
    void loadFaults()
  }, [cachedDashboard, loadDashboard, loadFaults])

  const rxData = useMemo(() => pieData(data.rxDistribution, PALETTES.rx), [data.rxDistribution])
  const freshnessData = useMemo(() => pieData(data.informFreshness, PALETTES.freshness), [data.informFreshness])
  const temperatureData = useMemo(() => pieData(data.temperatureDistribution, PALETTES.temperature), [data.temperatureDistribution])
  const clientData = useMemo(() => pieData(data.clientDistribution, PALETTES.clients), [data.clientDistribution])
  const productData = useMemo(() => [...data.productClasses].reverse(), [data.productClasses])
  const manufacturerData = useMemo(() => [...data.manufacturers].reverse(), [data.manufacturers])

  const availability = data.stats.total ? Math.round((data.stats.online / data.stats.total) * 100) : 0
  const signalRisk = (data.rxDistribution.Poor || 0) + (data.rxDistribution.Danger || 0)

  const clearFault = async (fault: Fault) => {
    if (!window.confirm(`Clear fault ${fault.code} for ${fault.deviceId || 'unknown device'}?`)) return
    try {
      setClearingFault(fault.id)
      const response = await devicesAPI.clearFault(fault.id)
      if (!response.success) throw new Error(response.message || 'Fault could not be cleared')
      setData((current) => ({ ...current, faults: current.faults.filter((entry) => entry.id !== fault.id) }))
      toast.success('Fault cleared from GenieACS')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Fault could not be cleared')
    } finally {
      setClearingFault(null)
    }
  }

  if (initialLoading) {
    return (
      <div className="page-shell"><div className="page-frame">
        <header className="page-header"><div><p className="page-kicker">Fleet operations</p><h1 className="page-title">Network condition</h1><p className="page-description">Loading compact operational summary from GenieACS…</p></div></header>
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
            <p className="page-kicker">Fleet operations</p>
            <h1 className="page-title">Network condition</h1>
            <p className="page-description">Ringkasan fleet, optical health, client load, dan fault untuk {user?.username || 'operator'}.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}` : 'No update yet'}</span>
            <button type="button" className="modern-button-secondary" disabled={refreshing} onClick={() => void loadDashboard(true)}>
              <Icon name="refresh" size={17} className={refreshing ? 'animate-spin' : ''} />{refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </header>

        {loadError && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[hsl(var(--status-danger))]/40 bg-[hsl(var(--status-danger))]/10 p-4" role="alert">
            <div className="flex items-center gap-3"><Icon name="warning" className="text-[hsl(var(--status-danger))]" /><span className="text-sm font-semibold">{loadError}</span></div>
            <button className="modern-button-secondary" onClick={() => void loadDashboard(true)}>Retry</button>
          </div>
        )}

        <section className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ['Total devices', data.stats.total, 'server', 'text-foreground'],
            ['Online now', data.stats.online, 'check', 'text-[hsl(var(--status-success))]'],
            ['Needs contact', data.stats.offline, 'warning', 'text-[hsl(var(--status-danger))]'],
            ['New in 24h', data.stats.new24h, 'bell', 'text-primary'],
          ].map(([label, value, icon, color]) => (
            <div key={String(label)} className="modern-card p-5">
              <div className="flex items-start justify-between"><p className="metric-label">{label}</p><Icon name={String(icon)} size={19} className="text-muted-foreground" /></div>
              <p className={`metric-value mt-4 ${color}`}>{value}</p>
            </div>
          ))}
        </section>

        <section className="mb-5 grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
          <div className="modern-card overflow-hidden">
            <div className="grid min-h-56 sm:grid-cols-[1fr_1.3fr]">
              <div className="flex flex-col justify-between bg-[#173f35] p-6 text-[#f4f3ed] sm:p-7">
                <div><p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[#b7c7be]">Online availability</p><p className="mt-3 font-mono text-5xl font-semibold tracking-[-0.05em]">{availability}%</p></div>
                <p className="mt-8 text-sm leading-6 text-[#c8d4ce]">{data.stats.online} dari {data.stats.total} perangkat melapor dalam 10 menit terakhir.</p>
              </div>
              <div className="grid grid-cols-2">
                <div className="border-b border-r border-border p-5"><p className="metric-label">Optical risk</p><p className="metric-value text-[hsl(var(--status-warning))]">{signalRisk}</p></div>
                <div className="border-b border-border p-5"><p className="metric-label">Active faults</p><p className="metric-value text-[hsl(var(--status-danger))]">{data.faults.length}</p></div>
                <div className="border-r border-border p-5"><p className="metric-label">Hot devices</p><p className="metric-value">{data.temperatureDistribution.Hot || 0}</p></div>
                <div className="p-5"><p className="metric-label">16+ clients</p><p className="metric-value">{data.clientDistribution['16+'] || 0}</p></div>
              </div>
            </div>
          </div>
          <div className="modern-card p-5">
            <div className="flex items-start justify-between"><div><h2 className="section-heading">Operator queue</h2><p className="section-description">Prioritas gangguan pelanggan.</p></div><Icon name="bell" /></div>
            <div className="mt-5 divide-y divide-border">
              <Link to="/devices" className="flex min-h-16 items-center justify-between py-3 hover:text-primary"><span><strong className="block text-sm">Offline devices</strong><small className="text-muted-foreground">Review last Inform</small></span><span className="data-value text-[hsl(var(--status-danger))]">{data.stats.offline}</span></Link>
              <div className="flex min-h-16 items-center justify-between py-3"><span><strong className="block text-sm">GenieACS faults</strong><small className="text-muted-foreground">Provisioning failures</small></span><span className="data-value text-[hsl(var(--status-danger))]">{data.faults.length}</span></div>
              <Link to="/devices" className="flex min-h-16 items-center justify-between py-3 hover:text-primary"><span><strong className="block text-sm">Weak optical signal</strong><small className="text-muted-foreground">Poor or danger RX</small></span><span className="data-value text-[hsl(var(--status-warning))]">{signalRisk}</span></Link>
            </div>
          </div>
        </section>

        <section className="mb-5 grid gap-4 xl:grid-cols-2">
          <div className="modern-card p-5"><h2 className="section-heading">Optical signal distribution</h2><p className="section-description mb-3">RX power health across the fleet.</p>{rxData.length ? <PieChart data={rxData} /> : <p className="empty-state-copy py-16 text-center">No RX power data.</p>}</div>
          <div className="modern-card p-5"><h2 className="section-heading">Inform freshness</h2><p className="section-description mb-3">How recently devices contacted GenieACS.</p>{freshnessData.length ? <PieChart data={freshnessData} /> : <p className="empty-state-copy py-16 text-center">No Inform data.</p>}</div>
          <div className="modern-card p-5"><h2 className="section-heading">Temperature health</h2><p className="section-description mb-3">Reported ONT temperature buckets.</p>{temperatureData.length ? <PieChart data={temperatureData} /> : <p className="empty-state-copy py-16 text-center">No temperature data.</p>}</div>
          <div className="modern-card p-5"><h2 className="section-heading">Connected client load</h2><p className="section-description mb-3">Active subscriber devices per ONT.</p>{clientData.length ? <PieChart data={clientData} /> : <p className="empty-state-copy py-16 text-center">No client count data.</p>}</div>
        </section>

        <section className="mb-5 grid gap-4 xl:grid-cols-3">
          <div className="modern-card p-5 xl:col-span-2"><h2 className="section-heading">7-day registrations</h2><p className="section-description mb-3">New CPE registrations reported per day.</p><TrendChart data={data.registrations} valueLabel="Registrations" /></div>
          <div className="modern-card p-5"><h2 className="section-heading">Manufacturers</h2><p className="section-description mb-3">Largest vendor groups.</p>{manufacturerData.length ? <BarChart data={manufacturerData} /> : <p className="empty-state-copy py-16 text-center">No manufacturer data.</p>}</div>
          <div className="modern-card p-5 xl:col-span-3"><h2 className="section-heading">Product classes</h2><p className="section-description mb-3">Largest device model families.</p>{productData.length ? <BarChart data={productData} /> : <p className="empty-state-copy py-16 text-center">No product class data.</p>}</div>
        </section>

        <section className="modern-card overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div><h2 className="section-heading">GenieACS fault list</h2><p className="section-description">Active provisioning and connection faults from the NBI.</p></div>
            <span className={data.faults.length ? 'modern-badge-error' : 'modern-badge-success'}>{faultsLoading ? 'Refreshing…' : `${data.faults.length} active`}</span>
          </div>
          {data.faultsError && <div className="border-b border-border bg-[hsl(var(--status-warning))]/10 px-5 py-3 text-sm">{data.faultsError}</div>}
          <div className="overflow-x-auto">
            <table className="modern-table">
              <thead><tr><th>Time</th><th>Device</th><th>Channel / code</th><th>Message</th>{isAdmin && <th>Action</th>}</tr></thead>
              <tbody>
                {data.faults.slice(0, 25).map((fault) => (
                  <tr key={fault.id}>
                    <td className="whitespace-nowrap text-xs">{formatFaultTime(fault.timestamp)}</td>
                    <td className="max-w-60 break-all font-mono text-xs">{fault.deviceId || '—'}</td>
                    <td><span className="modern-badge-error">{fault.code}</span><small className="mt-1 block text-muted-foreground">{fault.channel}{fault.retries ? ` · retry ${fault.retries}` : ''}</small></td>
                    <td className="min-w-72 max-w-xl text-sm">{fault.message}</td>
                    {isAdmin && <td><button type="button" className="modern-button-secondary" disabled={clearingFault === fault.id} onClick={() => void clearFault(fault)}>{clearingFault === fault.id ? 'Clearing…' : 'Clear fault'}</button></td>}
                  </tr>
                ))}
                {!data.faults.length && <tr><td colSpan={isAdmin ? 5 : 4} className="py-12 text-center text-muted-foreground">No active GenieACS faults.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
