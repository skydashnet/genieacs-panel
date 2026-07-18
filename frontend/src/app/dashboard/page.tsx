'use client'

import { useState, useEffect, useMemo } from 'react'
import { devicesAPI, vendorsAPI } from '@/lib/api'
import { useLoading } from '@/components/ui/loading'
import { useToast } from '@/components/ui/toast'
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
  const [devices, setDevices] = useState<ProcessedDevice[]>([])
  const [stats, setStats] = useState([
    { name: 'Total Devices', value: 0, change: 0, icon: 'server' },
    { name: 'Online', value: 0, change: 0, icon: 'check' },
    { name: 'Offline', value: 0, change: 0, icon: 'x' },
    { name: 'New Devices (24h)', value: 0, change: 0, icon: 'bell' },
  ])
  const [loading, setLoading] = useState(true)
  const [topProductClasses, setTopProductClasses] = useState<{name: string, count: number}[]>([])
  const [rxPieData, setRxPieData] = useState<PieChartData[]>([])
  const [showWelcomeModal, setShowWelcomeModal] = useState(false)  
  const loadingCtl = useLoading()
  const toast = useToast()
  const { user } = useAuth()

  useEffect(() => {
    const hasSeenModal = sessionStorage.getItem('welcomeModalSeen');
    if (!hasSeenModal) {
      setShowWelcomeModal(true);
      sessionStorage.setItem('welcomeModalSeen', 'true');
    }
  }, []);

  const findBrand = (manufacturer: string, productClass: string, vendors: Vendor[]) => {
    manufacturer = manufacturer?.toLowerCase() || ''
    productClass = productClass?.toLowerCase() || ''
    
    const sortedVendors = vendors.sort((a, b) => (b.priority || 0) - (a.priority || 0))
    
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
  }

  const processDeviceData = (devices: Device[], vendors: Vendor[]) => {
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
      const isOnline = lastInform ? (now.getTime() - lastInform.getTime()) < 10 * 60 * 1000 : false
      
      if (isOnline) stats.online++
      else stats.offline++

      const registered = item._registered ? new Date(item._registered) : null
      if (registered && (now.getTime() - registered.getTime()) < 24 * 60 * 60 * 1000) {
        stats.new24h++
      }
      
      const manufacturer = item.manufacturer || ''
      const productClass = item.productclass || 'Unknown'
      const brand = findBrand(manufacturer, productClass, vendors)
      
      const rxPower = item.rxpower
      
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
  }
  
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    
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
          const { processed, stats, topProductClasses, rxDistribution } = processDeviceData(devices, vendors)
          setDevices(processed)
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
          
        } else {
          toast.error(devicesRes.message || vendorsRes.message || 'Failed to load data')
        }
      } catch (error) {
        if (!cancelled) {
          toast.error('Network error loading dashboard')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    
    fetchData()
    
    return () => { cancelled = true }
  }, [toast])

  const barChartData = useMemo(() => {
    return topProductClasses.map(item => ({
      name: item.name,
      value: item.count
    })).reverse();
  }, [topProductClasses])

  if (loading) {
    return (
      <div className="p-6">
        <div className="max-w-7xl mx-auto flex justify-center items-center h-[60vh]">
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 border-4 border-gray-200 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin"></div>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">Loading Dashboard...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">Dashboard</h1>
          <p className="text-gray-600 dark:text-gray-400">Welcome back, {user?.username || 'Admin'}. Here's what's happening.</p>
        </div>

        {/* Metric Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {stats.map((stat, index) => (
            <div key={index} className="modern-card p-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600 dark:text-gray-400">{stat.name}</span>
                <Icon name={stat.icon} size={20} className="text-gray-400 dark:text-gray-500" />
              </div>
              <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">{stat.value}</p>
            </div>
          ))}
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Pie Chart RX Power */}
          <div className="modern-card p-6 lg:col-span-1">
            <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Redaman (RX Power)</h2>
            {rxPieData.length > 0 ? (
              <PieChart data={rxPieData} />
            ) : (
              <div className="flex items-center justify-center h-64">
                <p className="text-gray-500 dark:text-gray-400">No RX power data available.</p>
              </div>
            )}
          </div>
          
          {/* Bar Chart Product Class */}
          <div className="modern-card p-6 lg:col-span-2">
            <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Device Product Classes</h2>
            {barChartData.length > 0 ? (
              <BarChart data={barChartData} />
            ) : (
               <div className="flex items-center justify-center h-64">
                <p className="text-gray-500 dark:text-gray-400">No device data available.</p>
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Modal Welcome */}
      {showWelcomeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowWelcomeModal(false)}>
          <div className="modern-card w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Selamat Datang, {user?.username || 'Skydash.NET'}!
              </h3>
              <button
                onClick={() => setShowWelcomeModal(false)}
                className="p-1 rounded-md text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300"
                aria-label="Close"
              >
                <Icon name="x" size={22} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-gray-700 dark:text-gray-300">
                Ini adalah panel GenieACS baru Anda. Anda dapat memantau perangkat, memeriksa redaman, dan mengelola konfigurasi ONT dari sini.
              </p>
              <p className="text-gray-700 dark:text-gray-300">
                Semoga harimu menyenangkan!
              </p>
            </div>
            <div className="flex justify-end p-5 border-t border-gray-200 dark:border-gray-700">
              <button onClick={() => setShowWelcomeModal(false)} className="modern-button">
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}