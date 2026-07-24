'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { devicesAPI, vendorsAPI } from '@/lib/api'
import type { Device, Vendor } from '@/types'
import { PieChart } from '@/components/charts/pie-chart'
import { BarChart } from '@/components/charts/bar-chart'
import { Icon } from '@/components/ui/icon'
import { useAuth } from '@/contexts/auth-context'

interface ProcessedDevice extends Device {
  isOnline: boolean
  brand: string
  productClassOnly: string
  rxCategory: 'Excellent' | 'Good' | 'Poor' | 'Danger' | 'Unknown'
}

interface PieChartData {
  name: string
  value: number
  color: string
}

export default function DashboardPage() {
  const [stats, setStats] = useState([
    { name: 'Total Devices', value: 0, change: 0, icon: 'server' },
    { name: 'Online', value: 0, change: 0, icon: 'check' },
    { name: 'Offline', value: 0, change: 0, icon: 'x' },
    { name: 'New Devices (24h)', value: 0, change: 0, icon: 'bell' },
  ])
  const [loading, setLoading] = useState(true)
  const [topProductClasses, setTopProductClasses] = useState<{name: string, count: number}[]>([])
  const [rxPieData, setRxPieData] = useState<PieChartData[]>([])
  const [loadError, setLoadError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const { user } = useAuth()

  const findBrand = useCallback((manufacturer: string, productClass: string, vendors: Vendor[]) => {
    manufacturer = manufacturer?.toLowerCase() || ''
    productClass = productClass?.toLowerCase() || ''

    const sortedVendors = [...vendors].sort((a, b) => (b.priority || 0) - (a.priority || 0))

    for (const vendor of sortedVendors) {
      const manPatterns = vendor.manufacturer_patterns || []
      const prodPatterns = vendor.product_patterns || []

      const manMatch = manPatterns.some((p: string) => manufacturer.includes(p.toLowerCase()))
      const prodMatch = prodPatterns.some((p: string) => productClass.includes(p.toLowerCase()))

      if (manMatch || prodMatch) {
        return { name: vendor.name }
      }
    }

    return { name: manufacturer || 'Unknown' }
  }, [])

  const processDeviceData = useCallback((devices: Device[], vendors: Vendor[]) => {
    const stats = {
      total: devices.length,
      online: 0,
      offline: 0,
      new24h: 0,
    }

    const now = new Date()

    const getRxCategory = (rxPowerNum: number | null | undefined): ProcessedDevice['rxCategory'] => {
      if (rxPowerNum === null || rxPowerNum === undefined || isNaN(rxPowerNum)) return 'Unknown';

      if (rxPowerNum >= -21.99) return 'Excellent';
      if (rxPowerNum >= -24.99) return 'Good';
      if (rxPowerNum >= -26.99) return 'Poor';
      return 'Danger';
    }

    const processed: ProcessedDevice[] = devices.map((item: Device) => {
      const lastInform = item._lastInform ? new Date(item._lastInform) : null
      const lastInformMs = lastInform?.getTime()
      const ageMs = lastInformMs === undefined ? Number.NaN : now.getTime() - lastInformMs
      const isOnline = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 10 * 60 * 1000

      if (isOnline) stats.online++
      else stats.offline++

      const registered = item._registered ? new Date(item._registered) : null
      const registeredAge = registered ? now.getTime() - registered.getTime() : Number.NaN
      if (Number.isFinite(registeredAge) && registeredAge >= 0 && registeredAge < 24 * 60 * 60 * 1000) {
        stats.new24h++
      }

      const manufacturer = item.manufacturer || ''
      const productClass = item.productclass || 'Unknown'
      const brand = findBrand(manufacturer, productClass, vendors)

      const rxPower = item.rxpower === null || item.rxpower === undefined
        ? null
        : Number(item.rxpower)

      return {
        ...item,
        isOnline,
        brand: brand.name,
        productClassOnly: productClass,
        rxCategory: getRxCategory(rxPower)
      }
    })

    const productClassDistribution = processed.reduce((acc, device) => {
      if (device.productClassOnly && device.productClassOnly !== 'Unknown') {
        const key = device.productClassOnly;

        if (!acc[key]) {
          acc[key] = { name: key, count: 0 };
        }
        acc[key].count++;
      }
      return acc;
    }, {} as { [key: string]: { name: string, count: number } });

    const topProductClasses = Object.values(productClassDistribution)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const rxDistribution = { Excellent: 0, Good: 0, Poor: 0, Danger: 0, Unknown: 0 };
    processed.forEach(device => {
      rxDistribution[device.rxCategory]++;
    });

    return { processed, stats, topProductClasses, rxDistribution }
  }, [findBrand])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')

    const fetchData = async () => {
      try {
        const [devicesRes, vendorsRes] = await Promise.all([
          devicesAPI.getDevices(),
          vendorsAPI.getAll()
        ]);
        if (cancelled) return
        if (devicesRes.success && vendorsRes.success) {
          const devices = devicesRes.data as Device[]
          const vendors = vendorsRes.data as Vendor[]
          const { stats, topProductClasses, rxDistribution } = processDeviceData(devices, vendors)
          setStats([
            { name: 'Total Devices', value: stats.total, change: 0, icon: 'server' },
            { name: 'Online', value: stats.online, change: 0, icon: 'check' },
            { name: 'Offline', value: stats.offline, change: 0, icon: 'x' },
            { name: 'New Devices (24h)', value: stats.new24h, change: 0, icon: 'bell' },
          ])
          setTopProductClasses(topProductClasses)

          const pieData: PieChartData[] = [
            { name: 'Excellent', value: rxDistribution.Excellent, color: '#22c55e' },
            { name: 'Good', value: rxDistribution.Good, color: '#3b82f6' },
            { name: 'Poor', value: rxDistribution.Poor, color: '#eab308' },
            { name: 'Danger', value: rxDistribution.Danger, color: '#ef4444' },
            { name: 'Unknown', value: rxDistribution.Unknown, color: '#6b7280' },
          ].filter(d => d.value > 0);

          setRxPieData(pieData);
          setLastUpdated(new Date())
        } else {
          const message = 'GenieACS did not return the device list. Verify the ACS URL and network access, then retry.'
          setLoadError(message)
        }
      } catch {
        if (!cancelled) {
          const message = 'Panel could not reach GenieACS. Check the ACS connection, then retry.'
          setLoadError(message)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchData()

    return () => { cancelled = true }
  }, [processDeviceData, refreshNonce])

  const barChartData = useMemo(() => {
    return topProductClasses.map(item => ({
      name: item.name,
      value: item.count
    })).reverse();
  }, [topProductClasses])

  const totalDevices = stats[0]?.value || 0
  const onlineDevices = stats[1]?.value || 0
  const offlineDevices = stats[2]?.value || 0
  const newDevices = stats[3]?.value || 0
  const availability = totalDevices > 0 ? Math.round((onlineDevices / totalDevices) * 100) : 0
  const signalRisk = rxPieData
    .filter((item) => item.name === 'Poor' || item.name === 'Danger')
    .reduce((total, item) => total + item.value, 0)

  if (loading) {
    return (
      <div className="page-shell">
        <div className="page-frame">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Loading fleet status">
            {[0, 1, 2, 3].map((item) => (
              <div key={item} className="modern-card h-28 animate-pulse bg-muted" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <p className="page-kicker">Fleet operations</p>
            <h1 className="page-title">Network condition</h1>
            <p className="page-description">
              Status ONT yang dilaporkan GenieACS untuk membantu {user?.username || 'operator'} menentukan perangkat yang perlu diperiksa.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for data'}
            </span>
            <button type="button" onClick={() => setRefreshNonce((value) => value + 1)} className="modern-button-secondary">
              <Icon name="refresh" size={17} />
              Refresh fleet
            </button>
          </div>
        </header>

        {loadError ? (
          <section className="modern-card empty-state" role="alert">
            <div className="empty-state-icon text-[hsl(var(--status-danger))]">
              <Icon name="warning" size={22} />
            </div>
            <h2 className="empty-state-title">Fleet data is unavailable</h2>
            <p className="empty-state-copy">{loadError}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => setRefreshNonce((value) => value + 1)} className="modern-button">Retry connection</button>
              <Link to="/settings" className="modern-button-secondary">Open ACS configuration</Link>
            </div>
          </section>
        ) : totalDevices === 0 ? (
          <section className="modern-card empty-state">
            <div className="empty-state-icon"><Icon name="server" size={22} /></div>
            <h2 className="empty-state-title">No devices have reported yet</h2>
            <p className="empty-state-copy">Pastikan GenieACS URL benar dan ONT telah mengirim Inform. Setelah perangkat masuk, kondisi fleet akan muncul di sini.</p>
            <Link to="/settings" className="modern-button mt-5">Check ACS connection</Link>
          </section>
        ) : (
          <>
            <section className="mb-6 grid gap-4 lg:grid-cols-[1.35fr_0.65fr]" aria-labelledby="availability-heading">
              <div className="modern-card overflow-hidden">
                <div className="grid min-h-56 sm:grid-cols-[1fr_1.3fr]">
                  <div className="flex flex-col justify-between bg-[#173f35] p-6 text-[#f4f3ed] sm:p-7">
                    <div>
                      <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[#b7c7be]">Online availability</p>
                      <div className="mt-3 font-mono text-5xl font-semibold tracking-[-0.05em]">{availability}%</div>
                    </div>
                    <p className="mt-8 text-sm leading-6 text-[#c8d4ce]">
                      {onlineDevices} dari {totalDevices} perangkat melapor dalam 10 menit terakhir.
                    </p>
                  </div>
                  <div className="grid grid-cols-2">
                    <div className="border-b border-r border-border p-5">
                      <p className="metric-label">Online now</p>
                      <p className="metric-value text-[hsl(var(--status-success))]">{onlineDevices}</p>
                    </div>
                    <div className="border-b border-border p-5">
                      <p className="metric-label">Needs contact</p>
                      <p className="metric-value text-[hsl(var(--status-danger))]">{offlineDevices}</p>
                    </div>
                    <div className="border-r border-border p-5">
                      <p className="metric-label">Signal risk</p>
                      <p className="metric-value text-[hsl(var(--status-warning))]">{signalRisk}</p>
                    </div>
                    <div className="p-5">
                      <p className="metric-label">New in 24h</p>
                      <p className="metric-value">{newDevices}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="modern-card p-5 sm:p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 id="availability-heading" className="section-heading">Operator queue</h2>
                    <p className="section-description">Mulai dari gangguan yang berpotensi berdampak ke pelanggan.</p>
                  </div>
                  <Icon name="bell" size={21} className="text-muted-foreground" />
                </div>
                <div className="mt-6 divide-y divide-border">
                  <Link to="/devices" className="flex min-h-16 items-center justify-between gap-4 py-3 hover:text-primary">
                    <span>
                      <span className="block text-sm font-semibold">Offline devices</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">Review last Inform and summon</span>
                    </span>
                    <span className="data-value text-[hsl(var(--status-danger))]">{offlineDevices}</span>
                  </Link>
                  <Link to="/devices" className="flex min-h-16 items-center justify-between gap-4 py-3 hover:text-primary">
                    <span>
                      <span className="block text-sm font-semibold">Weak optical signal</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">Poor or danger RX level</span>
                    </span>
                    <span className="data-value text-[hsl(var(--status-warning))]">{signalRisk}</span>
                  </Link>
                </div>
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
              <div className="modern-card p-5 sm:p-6">
                <h2 className="section-heading">Optical signal distribution</h2>
                <p className="section-description mb-3">Jumlah perangkat pada setiap ambang RX power.</p>
                {rxPieData.length > 0 ? <PieChart data={rxPieData} /> : (
                  <div className="empty-state"><p className="empty-state-copy">Perangkat belum melaporkan nilai RX power.</p></div>
                )}
              </div>
              <div className="modern-card p-5 sm:p-6">
                <h2 className="section-heading">Largest device groups</h2>
                <p className="section-description mb-3">Product class dengan jumlah ONT terbanyak.</p>
                {barChartData.length > 0 ? <BarChart data={barChartData} /> : (
                  <div className="empty-state"><p className="empty-state-copy">Product class belum tersedia dari GenieACS.</p></div>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
