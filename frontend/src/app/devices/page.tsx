'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { debounce } from '@/lib/utils'
import { devicesAPI } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useLoading } from '@/components/ui/loading'

interface Device {
  _id: string
  SerialNumber: string
  productclass: string
  pppoe: string
  wanbridge: string
  rxpower: number
  temperature: number
  activedevices: number
  ssid1: string
  ssid2: string
  _lastInform: string
}

export default function Devices() {
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)
  const toast = useToast()
  const loadingCtl = useLoading()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      loadingCtl.show('Loading devices...')
      const res = await devicesAPI.getDevices()
      if (!cancelled) {
        if (res.success && Array.isArray(res.data)) {
          setDevices(res.data as any)
        } else {
          toast.error(res.message || 'Failed to load devices')
          setDevices([])
        }
        setLoading(false)
        loadingCtl.hide()
      }
    })()
    return () => { cancelled = true }
  }, [])

  const filteredDevices = devices.filter((device: any) =>
    device._id.toLowerCase().includes(searchTerm.toLowerCase()) ||
    device.SerialNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
    device.productclass.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const indexOfLastItem = currentPage * itemsPerPage
  const indexOfFirstItem = indexOfLastItem - itemsPerPage
  const currentItems = filteredDevices.slice(indexOfFirstItem, indexOfLastItem)
  const totalPages = Math.ceil(filteredDevices.length / itemsPerPage)
  const debouncedSearch = debounce((term: string) => {
    setSearchTerm(term)
    setCurrentPage(1)
  }, 300)

  const getSignalStrengthColor = (rxpower: number) => {
    if (rxpower >= -25) return 'text-green-600 dark:text-green-400'
    if (rxpower >= -50) return 'text-yellow-600 dark:text-yellow-400'
    if (rxpower >= -75) return 'text-orange-600 dark:text-orange-400'
    return 'text-red-600 dark:text-red-400'
  }

  const getStatusBadge = (lastInform: string) => {
    const lastSeen = new Date(lastInform)
    const now = new Date()
    const diffMinutes = Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60))
    
    if (diffMinutes < 10) {
      return <span className="modern-badge-success">Online</span>
    } else if (diffMinutes < 60) {
      return <span className="modern-badge-warning">Away</span>
    } else {
      return <span className="modern-badge-error">Offline</span>
    }
  }


  const handleSummon = async (deviceId: string) => {
    const res = await devicesAPI.summonDevice(deviceId)
    if (res.success) {
      toast.success(res.message || 'Summon sent')
    } else {
      toast.error(res.message || 'Failed to send summon')
    }
  }

  const handleDelete = async (deviceId: string) => {
    if (!confirm('Delete this device?')) return
    const res = await devicesAPI.deleteDevice(deviceId)
    if (res.success) {
      setDevices(prev => prev.filter(d => d._id !== deviceId))
      toast.success('Device deleted')
    } else {
      toast.error(res.message || 'Failed to delete device')
    }
  }

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="handwritter text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">Device Management</h1>
            <p className="text-gray-600 dark:text-gray-400">Manage and monitor your network devices</p>
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="text"
              placeholder="Search devices..."
              onChange={(e) => debouncedSearch(e.target.value)}
              className="modern-input w-64"
            />
            <button className="modern-button">
              Search
            </button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <div className="modern-card p-6">
            <div className="metric-value">{devices.length}</div>
            <div className="metric-label">Total Devices</div>
          </div>
          <div className="modern-card p-6">
            <div className="metric-value text-green-600 dark:text-green-400">
              {devices.filter((d: any) => {
                const lastSeen = new Date(d._lastInform)
                const now = new Date()
                return (now.getTime() - lastSeen.getTime()) < 10 * 60 * 1000
              }).length}
            </div>
            <div className="metric-label">Online Now</div>
          </div>
          <div className="modern-card p-6">
            <div className="metric-value text-yellow-600 dark:text-yellow-400">
              {devices.filter((d: any) => {
                const lastSeen = new Date(d._lastInform)
                const now = new Date()
                const diff = (now.getTime() - lastSeen.getTime()) / (1000 * 60)
                return diff >= 10 && diff < 60
              }).length}
            </div>
            <div className="metric-label">Idle</div>
          </div>
          <div className="modern-card p-6">
            <div className="metric-value text-red-600 dark:text-red-400">
              {devices.filter((d: any) => {
                const lastSeen = new Date(d._lastInform)
                const now = new Date()
                return (now.getTime() - lastSeen.getTime()) >= 60 * 60 * 1000
              }).length}
            </div>
            <div className="metric-label">Offline</div>
          </div>
        </div>

        {/* Devices Table */}
        <div className="modern-card p-6">
          <div className="overflow-x-auto">
            <table className="modern-table">
              <thead>
                <tr>
                  <th>Product Type</th>
                  <th>RxPower</th>
                  <th>Status</th>
                  <th>PPPoE</th>
                  <th>SSID</th>
                  <th>Total Connected</th>
                  <th>Wan Bridge</th>
                  <th>Last Inform</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={11} className="text-center py-8">
                      <div className="w-8 h-8 border-4 border-gray-200 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin mx-auto"></div>
                      <p className="mt-4 text-gray-500 dark:text-gray-400">Loading devices...</p>
                    </td>
                  </tr>
                ) : filteredDevices.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="text-center py-8">
                      <p className="text-gray-500 dark:text-gray-400">No devices found</p>
                    </td>
                  </tr>
                ) : currentItems.map((device: Device) => (
                  <tr key={device._id}>
                    <td>{device.productclass}</td>
                    <td className={`text-sm font-medium ${getSignalStrengthColor(device.rxpower)}`}>
                      {device.rxpower} dBm
                    </td>
                    <td>{getStatusBadge(device._lastInform)}</td>
                    <td className="text-sm">{device.pppoe}</td>
                    <td>
                      <div className="space-y-1">
                        {device.ssid1 && <div className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 px-2 py-1 rounded">{device.ssid1}</div>}
                        {device.ssid2 && <div className="text-xs bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 px-2 py-1 rounded">{device.ssid2}</div>}
                      </div>
                    </td>
                    <td className="text-sm">{device.activedevices}</td>
                    <td className="text-sm">{device.wanbridge}</td>
                    <td className="text-sm">{device._lastInform}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleSummon(device._id)}
                          className="px-2 py-1 rounded-md text-blue-600 border border-blue-200 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors text-xs"
                          title="Summon"
                        >
                          Summon
                        </button>
                        <Link href={`/devices/${device._id}`} className="px-2 py-1 rounded-md text-green-600 border border-green-200 dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors text-xs" title="View Details">
                          Details
                        </Link>
                        <button
                          onClick={() => handleDelete(device._id)}
                          className="px-2 py-1 rounded-md text-red-600 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-xs"
                          title="Delete"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-6 px-2">
              <div className="text-sm text-gray-700 dark:text-gray-300">
                Showing {indexOfFirstItem + 1} to {Math.min(indexOfLastItem, filteredDevices.length)} of {filteredDevices.length} results
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="px-3 py-1 text-sm">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                  disabled={currentPage === totalPages}
                  className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}