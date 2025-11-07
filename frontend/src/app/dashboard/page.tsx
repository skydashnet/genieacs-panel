'use client'

import { useState, useEffect, useMemo } from 'react'
import { Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { useTheme } from '@/contexts/theme-context'
import { devicesAPI, vendorsAPI } from '@/lib/api'
import { useLoading } from '@/components/ui/loading'

export default function Dashboard() {
  const { isDarkMode } = useTheme()
  const { show, hide } = useLoading()
  const [metrics, setMetrics] = useState([
    { name: "Total Devices", value: 0, status: "up", change: 0 },
    { name: "Online", value: 0, status: "up", change: 0 },
    { name: "Offline", value: 0, status: "down", change: 0 },
    { name: "Faults", value: 0, status: "warning", change: 0 }
  ])

  const [attenuationData, setAttenuationData] = useState<{ name: string; value: number; color: string }[]>([])
  const [productClasses, setProductClasses] = useState<{ name: string; value: number; color: string }[]>([])
  const [devices, setDevices] = useState<any[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      show('Loading dashboard...')
      try {
        const [devRes, vendRes] = await Promise.all([devicesAPI.getDevices(), vendorsAPI.getAll()])
        const devs = (devRes.success && Array.isArray(devRes.data)) ? (devRes.data as any[]) : []
        const vendors = (vendRes.success && Array.isArray(vendRes.data)) ? (vendRes.data as any[]) : []

        if (cancelled) return

        setDevices(devs)

        // Metrics
        const total = devs.length
        const now = Date.now()
        const online = devs.filter(d => {
          const li = d._lastInform ? new Date(d._lastInform).getTime() : 0
          return li && (now - li) < 10 * 60 * 1000
        }).length
        const offline = total - online
        setMetrics([
          { name: "Total Devices", value: total, status: "up", change: 0 },
          { name: "Online", value: online, status: "up", change: 0 },
          { name: "Offline", value: offline, status: "down", change: 0 },
          { name: "Faults", value: 0, status: "warning", change: 0 }
        ])

        // RxPower distribution buckets
        const buckets: Record<string, number> = { Excellent: 0, Fair: 0, Poor: 0 }
        devs.forEach(d => {
          const rx = typeof d.rxpower === 'number' ? d.rxpower : null
          if (rx === null) return
          if (rx >= -30) buckets.Excellent++
          else if (rx >= -50) buckets.Fair++
          else buckets.Poor++
        })
        const colors = { Excellent: '#10B981', Fair: '#F59E0B', Poor: '#EF4444' }
        setAttenuationData([
          { name: 'Excellent', value: buckets.Excellent, color: colors.Excellent },
          { name: 'Fair', value: buckets.Fair, color: colors.Fair },
          { name: 'Poor', value: buckets.Poor, color: colors.Poor },
        ])

        // Product Classes: "Merk - Type" menggunakan vendor.product_patterns
        const palette = ['#3B82F6','#60A5FA','#10B981','#F59E0B','#8B5CF6','#F472B6','#14B8A6','#FB7185']
        const findBrand = (productclass: string): string => {
          const pc = (productclass || '').toLowerCase()
          for (const v of vendors) {
            const pats = (v.product_patterns || []) as string[]
            if (Array.isArray(pats) && pats.some((p: string) => pc.includes(String(p).toLowerCase()))) {
              return v.name || 'Others'
            }
          }
          return 'Others'
        }
        const counter = new Map<string, number>()
        devs.forEach(d => {
          const brand = findBrand(d.productclass || '')
          const key = `${brand} - ${d.productclass || '-'}`
          counter.set(key, (counter.get(key) || 0) + 1)
        })
        const classesArr = Array.from(counter.entries()).map(([name, value], idx) => ({
          name, value, color: palette[idx % palette.length]
        }))
        setProductClasses(classesArr)
      } finally {
        hide()
      }
    })()
    return () => { cancelled = true }
  }, [show, hide])

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">Dashboard</h1>
          <p className="text-gray-600 dark:text-gray-400">Network Device Management Overview</p>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {metrics.map((metric, index) => (
            <div key={index} className="metric-card p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="metric-label">{metric.name}</h3>
                <div className={`metric-change ${metric.status}`}>
                  {metric.status === 'up' && ''}
                  {metric.status === 'down' && ''}
                  {metric.status === 'warning' && '⚠'}
                  {Math.abs(metric.change)}%
                </div>
              </div>
              <div className="metric-value">{metric.value.toLocaleString()}</div>
            </div>
          ))}
        </div>

        {/* Charts Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <div className="modern-card p-6">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Redaman (Rx Power)</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                {attenuationData.length > 0 ? (
                  <PieChart>
                    <Pie
                      data={attenuationData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                      outerRadius={80}
                      dataKey="value"
                    >
                      {attenuationData.map((entry, index) => (
                        <Cell key={`attenuation-cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: isDarkMode ? '#1F2937' : '#FFFFFF',
                        border: 'none',
                        borderRadius: '8px',
                        color: isDarkMode ? '#F9FAFB' : '#1F2937'
                      }}
                    />
                  </PieChart>
                ) : (
                  <div className="h-full flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-lg">
                    <p className="text-gray-500 dark:text-gray-400">Tidak ada data redaman</p>
                  </div>
                )}
              </ResponsiveContainer>
            </div>
          </div>

          {/* Device Product Classes Chart */}
          <div className="modern-card p-6">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Device Product Classes</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                {productClasses.length > 0 ? (
                  <PieChart>
                    <Pie
                      data={productClasses}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                      outerRadius={80}
                      dataKey="value"
                    >
                      {productClasses.map((entry, index) => (
                        <Cell key={`productclass-cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: isDarkMode ? '#1F2937' : '#FFFFFF',
                        border: 'none',
                        borderRadius: '8px',
                        color: isDarkMode ? '#F9FAFB' : '#1F2937'
                      }}
                    />
                  </PieChart>
                ) : (
                  <div className="h-full flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-lg">
                    <p className="text-gray-500 dark:text-gray-400">Unable to load chart data</p>
                  </div>
                )}
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Recent Devices Table */}
        <div className="modern-card p-6">
          <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Recent Devices</h3>
          <div className="overflow-x-auto">
            <table className="modern-table">
              <thead>
                <tr>
                  <th>Device ID</th>
                  <th>Model</th>
                  <th>Serial Number</th>
                  <th>Last Seen</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {devices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-6 text-gray-500 dark:text-gray-400">No recent devices</td>
                  </tr>
                ) : (
                  [...devices]
                    .sort((a, b) => new Date(b._lastInform || 0).getTime() - new Date(a._lastInform || 0).getTime())
                    .slice(0, 5)
                    .map((d) => {
                      const last = d._lastInform ? new Date(d._lastInform) : null
                      const diffMin = last ? Math.floor((Date.now() - last.getTime()) / 60000) : null
                      const when = diffMin === null ? '-' : diffMin < 1 ? 'just now' : diffMin < 60 ? `${diffMin} minutes ago` : `${Math.floor(diffMin/60)} hours ago`
                      const online = last ? (Date.now() - last.getTime()) < 10*60*1000 : false
                      return (
                        <tr key={d._id}>
                          <td className="font-mono">{d._id}</td>
                          <td>{d.productclass || '-'}</td>
                          <td className="font-mono">{d.SerialNumber || '-'}</td>
                          <td>{when}</td>
                          <td>
                            <div className={online ? 'status-online' : 'status-offline'}></div>
                          </td>
                        </tr>
                      )
                    })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}