'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { devicesAPI, vendorsAPI } from '@/lib/api'
import { useLoading } from '@/components/ui/loading'
import { useToast } from '@/components/ui/toast'
import { Icon } from '@/components/ui/icon'
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
        return vendor.name
      }
    }
    
    return manufacturer || 'Unknown'
  }
  
  const processDeviceData = (devices: Device[], vendors: Vendor[]) => {
    const now = new Date()
    return devices.map((item: Device) => {
      const lastInform = item._lastInform ? new Date(item._lastInform) : null
      const isOnline = lastInform ? (now.getTime() - lastInform.getTime()) < 10 * 60 * 1000 : false
      
      const manufacturer = item.manufacturer || ''
      const productClass = item.productclass || 'Unknown'
      const brand = findBrand(manufacturer, productClass, vendors)
      
      return {
        ...item,
        isOnline,
        brand: brand,
      }
    })
  }

  const handleSummon = async (e: React.MouseEvent, deviceId: string) => {
    e.preventDefault();
    e.stopPropagation();
    
    loadingCtl.show('Summoning device...');
    try {
      const res = await devicesAPI.summonDevice(deviceId);
      if (res.success) {
        toast.success(res.message || 'Summon command sent!');
        setDevices(prevDevices => 
          prevDevices.map(device => {
            if (device._id === deviceId) {
              return {
                ...device,
                isOnline: true,
                _lastInform: new Date().toISOString()
              };
            }
            return device;
          })
        );
        
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
          toast.error(devicesRes.message || vendorsRes.message || 'Failed to load data')
        }
      } catch (error) {
        if (!cancelled) {
          toast.error('Network error loading devices')
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

  const filteredDevices = useMemo(() => {
    return devices.filter(device => {
      const search = searchTerm.toLowerCase()
      const statusMatch = filterStatus === 'all' || 
                          (filterStatus === 'online' && device.isOnline) || 
                          (filterStatus === 'offline' && !device.isOnline)

      const searchMatch = !search ||
                          device._id.toLowerCase().includes(search) ||
                          device.SerialNumber.toLowerCase().includes(search) ||
                          device.brand.toLowerCase().includes(search) ||
                          device.productclass.toLowerCase().includes(search) ||
                          device.pppoe?.toLowerCase().includes(search)
                          
      return statusMatch && searchMatch
    })
  }, [devices, searchTerm, filterStatus])

  if (loading) {
    return (
      <div className="p-6">
        <div className="max-w-7xl mx-auto flex justify-center items-center h-[60vh]">
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 border-4 border-gray-200 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin"></div>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">Loading Devices...</p>
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
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">Device Management</h1>
          <p className="text-gray-600 dark:text-gray-400">View, search, and manage all connected devices.</p>
        </div>

        {/* Filters */}
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <input
            type="text"
            placeholder="Search (Serial, Brand, PPPoE...)"
            className="modern-input flex-1"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <select
            className="modern-input md:w-48"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="all">All Status</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
          </select>
        </div>

        {/* Table */}
        <div className="modern-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="modern-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Serial Number / ID</th>
                  <th>Brand</th>
                  <th>Product Class</th>
                  <th>PPPoE</th>
                  <th>RX Power</th>
                  <th>Last Inform</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredDevices.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-12">
                      <p className="text-gray-500 dark:text-gray-400">No devices found matching your criteria.</p>
                    </td>
                  </tr>
                ) : (
                  filteredDevices.map((device) => {
                    const signalInfo = getSignalStrengthInfo(device.rxpower);
                    
                    return (
                      <tr key={device._id}>
                        <td>
                          <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                            device.isOnline ? 'modern-badge-success' : 'modern-badge-error'
                          }`}>
                            {device.isOnline ? 'Online' : 'Offline'}
                          </span>
                        </td>
                        <td>
                          <Link href={`/devices/detail?id=${encodeURIComponent(device._id)}`}>
                            <span className="font-mono text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                              {device.SerialNumber || device._id}
                            </span>
                          </Link>
                        </td>
                        <td>{device.brand}</td>
                        <td>{device.productclass}</td>
                        <td>{device.pppoe || 'N/A'}</td>
                        <td className={`font-semibold ${signalInfo.color}`}>
                          {device.rxpower ? `${device.rxpower} dBm` : 'N/A'}
                        </td>
                        <td className="text-xs text-gray-500 dark:text-gray-400">
                          {device._lastInform ? new Date(device._lastInform).toLocaleString('id-ID') : 'N/A'}
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <Link href={`/devices/detail?id=${encodeURIComponent(device._id)}`}>
                              <span className="modern-button-secondary text-xs px-3 py-1">
                                Details
                              </span>
                            </Link>
                            <button
                              onClick={(e) => handleSummon(e, device._id)}
                              className="modern-button text-xs px-3 py-1 inline-flex items-center"
                              title="Summon Device"
                              aria-label="Summon Device"
                            >
                              <Icon name="bell" size={14} />
                            </button>
                          </div>
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