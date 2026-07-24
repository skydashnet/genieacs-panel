'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { devicesAPI, vendorsAPI } from '@/lib/api'
import { useLoading } from '@/components/ui/loading'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
import { formatDate } from '@/lib/utils'
import type { Device, Vendor } from '@/types'

interface ProcessedDevice extends Device {
  isOnline: boolean
  brand: string
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<ProcessedDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [loadError, setLoadError] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)

  const loadingCtl = useLoading()
  const toast = useToast()

  const getSignalStrengthInfo = (rxPowerStr: any) => {
    const rxpower = parseFloat(String(rxPowerStr));

    if (isNaN(rxpower)) {
      return {
        color: 'text-gray-500 dark:text-gray-400',
        label: 'N/A',
        badgeClass: 'modern-badge'
      };
    }

    if (rxpower >= -21.99) {
      return {
        color: 'text-green-600 dark:text-green-400',
        label: 'Excellent',
        badgeClass: 'modern-badge-success'
      };
    }
    if (rxpower >= -24.99) {
      return {
        color: 'text-blue-600 dark:text-blue-400',
        label: 'Good',
        badgeClass: 'modern-badge-info'
      };
    }
    if (rxpower >= -26.99) {
      return {
        color: 'text-yellow-600 dark:text-yellow-400',
        label: 'Poor',
        badgeClass: 'modern-badge-warning'
      };
    }
    return {
      color: 'text-red-600 dark:text-red-400',
      label: 'Danger',
      badgeClass: 'modern-badge-error'
    };
  }

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
        return vendor.name
      }
    }

    return manufacturer || 'Unknown'
  }, [])

  const processDeviceData = useCallback((devices: Device[], vendors: Vendor[]) => {
    const now = new Date()
    return devices.map((item: Device) => {
      const lastInform = item._lastInform ? new Date(item._lastInform) : null
      const lastInformMs = lastInform?.getTime()
      const ageMs = lastInformMs === undefined ? Number.NaN : now.getTime() - lastInformMs
      const isOnline = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 10 * 60 * 1000

      const manufacturer = item.manufacturer || ''
      const productClass = item.productclass || 'Unknown'
      const brand = findBrand(manufacturer, productClass, vendors)

      return {
        ...item,
        isOnline,
        brand: brand,
      }
    })
  }, [findBrand])

  const handleSummon = async (e: React.MouseEvent, deviceId: string) => {
    e.preventDefault();
    e.stopPropagation();

    loadingCtl.show('Summoning device...');
    try {
      const res = await devicesAPI.summonDevice(deviceId);
      if (res.success) {
        toast.success(res.message || 'Summon command sent!');
      } else {
        toast.error(res.message || 'Failed to send summon');
      }
    } catch (error: any) {
      toast.error(error.message || 'Error sending summon command');
    } finally {
      loadingCtl.hide();
    }
  }

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

          const processed = processDeviceData(devices, vendors)
          setDevices(processed)

        } else {
          const message = 'GenieACS did not return the device inventory. Verify the ACS URL and network access, then retry.'
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

  const filteredDevices = useMemo(() => {
    return devices.filter(device => {
      const search = searchTerm.toLowerCase()
      const statusMatch = filterStatus === 'all' ||
                          (filterStatus === 'online' && device.isOnline) ||
                          (filterStatus === 'offline' && !device.isOnline)

      const searchMatch = !search ||
                          (device._id || '').toLowerCase().includes(search) ||
                          (device.SerialNumber || '').toLowerCase().includes(search) ||
                          device.brand.toLowerCase().includes(search) ||
                          (device.productclass || '').toLowerCase().includes(search) ||
                          device.pppoe?.toLowerCase().includes(search) ||
                          device.customerId?.toLowerCase().includes(search)

      return statusMatch && searchMatch
    })
  }, [devices, searchTerm, filterStatus])

  if (loading) {
    return (
      <div className="page-shell">
        <div className="page-frame">
          <div className="mb-5 h-24 animate-pulse rounded-md bg-muted" />
          <div className="modern-card h-[28rem] animate-pulse bg-muted" aria-label="Loading device inventory" />
        </div>
      </div>
    )
  }

  const totalOnline = devices.filter((device) => device.isOnline).length
  const hasFilters = Boolean(searchTerm) || filterStatus !== 'all'

  const DeviceStatus = ({ device }: { device: ProcessedDevice }) => (
    <span className={device.isOnline ? 'modern-badge-success' : 'modern-badge-error'}>
      <span className="status-dot" />
      {device.isOnline ? 'Online' : 'Offline'}
    </span>
  )

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <p className="page-kicker">GenieACS inventory</p>
            <h1 className="page-title">Managed devices</h1>
            <p className="page-description">Cari ONT berdasarkan serial, pelanggan PPPoE, vendor, atau product class lalu buka detail konfigurasi.</p>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span><strong className="data-value">{totalOnline}</strong> online</span>
            <span aria-hidden="true">/</span>
            <span><strong className="data-value">{devices.length}</strong> total</span>
            <button type="button" onClick={() => setRefreshNonce((value) => value + 1)} className="icon-button" aria-label="Refresh device inventory">
              <Icon name="refresh" size={18} />
            </button>
          </div>
        </header>

        {loadError ? (
          <section className="modern-card empty-state" role="alert">
            <div className="empty-state-icon text-[hsl(var(--status-danger))]"><Icon name="warning" size={22} /></div>
            <h2 className="empty-state-title">Device inventory is unavailable</h2>
            <p className="empty-state-copy">{loadError}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => setRefreshNonce((value) => value + 1)} className="modern-button">Retry inventory</button>
              <Link to="/settings" className="modern-button-secondary">Check ACS configuration</Link>
            </div>
          </section>
        ) : (
          <>
            <section className="mb-4 grid gap-3 rounded-[var(--radius)] border border-border bg-card p-3 md:grid-cols-[minmax(18rem,1fr)_13rem_auto] md:items-end">
              <div>
                <label htmlFor="device-search" className="field-label">Search inventory</label>
                <div className="relative">
                  <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="device-search"
                    type="search"
                    placeholder="Serial, Customer ID, PPPoE, brand, or model"
                    className="modern-input pl-10"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="device-status" className="field-label">Connection status</label>
                <select id="device-status" className="modern-input" value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)}>
                  <option value="all">All devices</option>
                  <option value="online">Online only</option>
                  <option value="offline">Offline only</option>
                </select>
              </div>
              <div className="flex min-h-11 items-center justify-between gap-3 px-1 text-sm text-muted-foreground md:justify-end">
                <span><strong className="data-value">{filteredDevices.length}</strong> shown</span>
                {hasFilters && (
                  <button type="button" onClick={() => { setSearchTerm(''); setFilterStatus('all') }} className="font-semibold text-primary hover:underline">
                    Clear filters
                  </button>
                )}
              </div>
            </section>

            {filteredDevices.length === 0 ? (
              <section className="modern-card empty-state">
                <div className="empty-state-icon"><Icon name={hasFilters ? 'search' : 'server'} size={22} /></div>
                <h2 className="empty-state-title">{hasFilters ? 'No devices match these filters' : 'No devices have reported yet'}</h2>
                <p className="empty-state-copy">
                  {hasFilters
                    ? 'Ubah kata pencarian atau tampilkan semua status untuk memperluas hasil.'
                    : 'Periksa koneksi GenieACS dan tunggu Inform pertama dari ONT.'}
                </p>
                {hasFilters ? (
                  <button type="button" onClick={() => { setSearchTerm(''); setFilterStatus('all') }} className="modern-button-secondary mt-5">Clear filters</button>
                ) : (
                  <Link to="/settings" className="modern-button mt-5">Check ACS connection</Link>
                )}
              </section>
            ) : (
              <>
                <section className="modern-card desktop-table overflow-hidden">
                  <div className="max-h-[calc(100vh-18rem)] overflow-auto">
                    <table className="modern-table">
                      <thead>
                        <tr>
                          <th>Status</th>
                          <th>Serial / Device ID</th>
                          <th>Vendor & model</th>
                          <th>Subscriber</th>
                          <th>Customer ID</th>
                          <th>Optical RX</th>
                          <th>Last Inform</th>
                          <th><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDevices.map((device) => {
                          const signalInfo = getSignalStrengthInfo(device.rxpower)
                          return (
                            <tr key={device._id}>
                              <td><DeviceStatus device={device} /></td>
                              <td className="max-w-[18rem]">
                                <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="block truncate font-mono text-sm font-semibold text-primary hover:underline">
                                  {device.SerialNumber || device._id}
                                </Link>
                                {device.SerialNumber && <span className="mt-1 block truncate font-mono text-[0.68rem] text-muted-foreground">{device._id}</span>}
                              </td>
                              <td>
                                <span className="block font-semibold">{device.brand}</span>
                                <span className="mt-0.5 block text-xs text-muted-foreground">{device.productclass || 'Model not reported'}</span>
                              </td>
                              <td className="font-mono text-xs">{device.pppoe || 'Not reported'}</td>
                              <td className="font-mono text-xs font-semibold">{device.customerId || 'Not generated'}</td>
                              <td>
                                <span className={`font-mono text-sm font-semibold ${signalInfo.color}`}>
                                  {device.rxpower !== null && device.rxpower !== undefined ? `${device.rxpower} dBm` : 'N/A'}
                                </span>
                                <span className="mt-0.5 block text-[0.68rem] text-muted-foreground">{signalInfo.label}</span>
                              </td>
                              <td className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(device._lastInform)}</td>
                              <td>
                                <div className="flex justify-end gap-1">
                                  <button onClick={(event) => handleSummon(event, device._id)} className="icon-button" title="Request a new Inform" aria-label={`Summon ${device.SerialNumber || device._id}`}>
                                    <Icon name="bell" size={17} />
                                  </button>
                                  <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="icon-button" aria-label={`Open ${device.SerialNumber || device._id}`}>
                                    <Icon name="chevron-right" size={17} />
                                  </Link>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="mobile-card-list space-y-3" aria-label="Device inventory">
                  {filteredDevices.map((device) => {
                    const signalInfo = getSignalStrengthInfo(device.rxpower)
                    return (
                      <article key={device._id} className="mobile-data-card">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <DeviceStatus device={device} />
                            <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="mt-2 block truncate font-mono text-sm font-semibold text-primary">
                              {device.SerialNumber || device._id}
                            </Link>
                            <p className="mt-1 truncate text-xs text-muted-foreground">{device.brand} · {device.productclass || 'Unknown model'}</p>
                          </div>
                          <Link to={`/devices/detail?id=${encodeURIComponent(device._id)}`} className="icon-button shrink-0" aria-label={`Open ${device.SerialNumber || device._id}`}>
                            <Icon name="chevron-right" size={18} />
                          </Link>
                        </div>
                        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 text-sm">
                          <div><dt className="text-xs text-muted-foreground">PPPoE</dt><dd className="mt-1 truncate font-mono text-xs">{device.pppoe || 'Not reported'}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Customer ID</dt><dd className="mt-1 truncate font-mono text-xs font-semibold">{device.customerId || 'Not generated'}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Optical RX</dt><dd className={`mt-1 font-mono text-xs font-semibold ${signalInfo.color}`}>{device.rxpower ?? 'N/A'}{device.rxpower !== null && device.rxpower !== undefined ? ' dBm' : ''}</dd></div>
                          <div className="col-span-2"><dt className="text-xs text-muted-foreground">Last Inform</dt><dd className="mt-1 text-xs">{formatDate(device._lastInform)}</dd></div>
                        </dl>
                        <button onClick={(event) => handleSummon(event, device._id)} className="modern-button-secondary mt-4 w-full">
                          <Icon name="bell" size={17} /> Request new Inform
                        </button>
                      </article>
                    )
                  })}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
