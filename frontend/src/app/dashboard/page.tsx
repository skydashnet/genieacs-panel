'use client'

import { useState, useEffect } from 'react'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { useTheme } from '@/contexts/theme-context'

export default function Dashboard() {
  const { isDarkMode } = useTheme()
  const [metrics, setMetrics] = useState([
    { name: "Total Devices", value: 0, status: "up", change: 0 },
    { name: "Online", value: 0, status: "up", change: 0 },
    { name: "Offline", value: 0, status: "down", change: 0 },
    { name: "Faults", value: 0, status: "warning", change: 0 }
  ])

  const [connectionHistory, setConnectionHistory] = useState([
    { time: '00:00', online: 1020, offline: 180 },
    { time: '04:00', online: 980, offline: 220 },
    { time: '08:00', online: 1100, offline: 100 },
    { time: '12:00', online: 1150, offline: 50 },
    { time: '16:00', online: 1089, offline: 158 },
    { time: '20:00', online: 1050, offline: 150 },
    { time: '23:59', online: 1030, offline: 170 }
  ])

  const [deviceTypes, setDeviceTypes] = useState([
    { name: 'Huawei', value: 450, color: '#3B82F6' },
    { name: 'ZTE', value: 320, color: '#10B981' },
    { name: 'FiberHome', value: 280, color: '#F59E0B' },
    { name: 'Others', value: 197, color: '#8B5CF6' }
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
          {/* Connection History Chart */}
          <div className="modern-card p-6">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Connection History</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                {connectionHistory.length > 0 ? (
                  <LineChart data={connectionHistory}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                    <XAxis
                      dataKey="time"
                      tick={{ fill: '#6B7280', fontSize: 12 }}
                      axisLine={{ stroke: '#E5E7EB' }}
                    />
                    <YAxis
                      tick={{ fill: '#6B7280', fontSize: 12 }}
                      axisLine={{ stroke: '#E5E7EB' }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: isDarkMode ? '#1F2937' : '#FFFFFF',
                        border: 'none',
                        borderRadius: '8px',
                        color: isDarkMode ? '#F9FAFB' : '#1F2937'
                      }}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="online"
                      stroke="#10B981"
                      strokeWidth={2}
                      name="Online"
                      dot={{ fill: '#10B981', r: 4 }}
                      activeDot={{ r: 6 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="offline"
                      stroke="#EF4444"
                      strokeWidth={2}
                      name="Offline"
                      dot={{ fill: '#EF4444', r: 4 }}
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                ) : (
                  <div className="h-full flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-lg">
                    <p className="text-gray-500 dark:text-gray-400">Unable to load chart data</p>
                  </div>
                )}
              </ResponsiveContainer>
            </div>
          </div>

          {/* Device Types Chart */}
          <div className="modern-card p-6">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Device Types</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                {deviceTypes.length > 0 ? (
                  <PieChart>
                    <Pie
                      data={deviceTypes}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {deviceTypes.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
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