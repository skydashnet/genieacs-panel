'use client'

import { useState, useEffect } from 'react'
import { Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { useTheme } from '@/contexts/theme-context'

export default function Dashboard() {
  const { isDarkMode } = useTheme()
  const [metrics, setMetrics] = useState([
    { name: "Total Devices", value: 0, status: "up", change: 0 },
    { name: "Online", value: 0, status: "up", change: 0 },
    { name: "Offline", value: 0, status: "down", change: 0 },
    { name: "Faults", value: 0, status: "warning", change: 0 }
  ])

  const [attenuationData, setAttenuationData] = useState([
    { name: 'Poor', value: 197, color: '#EF4444' },
    { name: 'Excellent', value: 620, color: '#10B981' },
    { name: 'Fair', value: 430, color: '#F59E0B' },
  ])

  const [productClasses, setProductClasses] = useState([
    { name: 'Huawei - HG8245H', value: 300, color: '#3B82F6' },
    { name: 'Huawei - EG8145V5', value: 150, color: '#60A5FA' },
    { name: 'ZTE - F660', value: 220, color: '#10B981' },
    { name: 'FiberHome - AN5506', value: 120, color: '#F59E0B' },
    { name: 'Others - Misc', value: 197, color: '#8B5CF6' },
  ])

  useEffect(() => {
    // Simulate data loading
    const timer = setTimeout(() => {
      setMetrics([
        { name: "Total Devices", value: 1247, status: "up", change: 12 },
        { name: "Online", value: 1089, status: "up", change: 8 },
        { name: "Offline", value: 158, status: "down", change: -5 },
        { name: "Faults", value: 23, status: "warning", change: -3 }
      ])
    }, 1000)

    return () => clearTimeout(timer)
  }, [])

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
                  {metric.status === 'up' && '↑'}
                  {metric.status === 'down' && '↓'}
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
          {/* Attenuation (Rx Power) Pie */}
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
                <tr>
                  <td className="font-mono">ONT-001</td>
                  <td>HG8245H</td>
                  <td className="font-mono">SN123456789</td>
                  <td>2 minutes ago</td>
                  <td>
                    <div className="status-online"></div>
                  </td>
                </tr>
                <tr>
                  <td className="font-mono">ONT-002</td>
                  <td>F660</td>
                  <td className="font-mono">SN987654321</td>
                  <td>5 minutes ago</td>
                  <td>
                    <div className="status-online"></div>
                  </td>
                </tr>
                <tr>
                  <td className="font-mono">ONT-003</td>
                  <td>EG8145V5</td>
                  <td className="font-mono">SN456789123</td>
                  <td>1 hour ago</td>
                  <td>
                    <div className="status-offline"></div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-8">
          <div className="modern-card p-6 text-center hover:shadow-md transition-shadow duration-200 cursor-pointer">
            <div className="text-4xl mb-3">🔧</div>
            <h4 className="text-lg font-semibold mb-2 text-gray-900 dark:text-gray-100">Device Management</h4>
            <p className="text-gray-600 dark:text-gray-400">Configure and manage your network devices</p>
          </div>
          <div className="modern-card p-6 text-center hover:shadow-md transition-shadow duration-200 cursor-pointer">
            <div className="text-4xl mb-3">📡</div>
            <h4 className="text-lg font-semibold mb-2 text-gray-900 dark:text-gray-100">Vendor Settings</h4>
            <p className="text-gray-600 dark:text-gray-400">Manage vendor configurations</p>
          </div>
          <div className="modern-card p-6 text-center hover:shadow-md transition-shadow duration-200 cursor-pointer">
            <div className="text-4xl mb-3">🗺</div>
            <h4 className="text-lg font-semibold mb-2 text-gray-900 dark:text-gray-100">Network Map</h4>
            <p className="text-gray-600 dark:text-gray-400">Visualize network topology</p>
          </div>
        </div>
      </div>
    </div>
  )
}