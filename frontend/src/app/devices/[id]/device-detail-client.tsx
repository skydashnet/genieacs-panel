'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/toast'

interface DeviceDetail {
  _id: string
  SerialNumber: string
  productclass: string
  manufacturer: string
  oui: string
  pppoe: string
  wanbridge: string
  rxpower: number
  temperature: number
  activedevices: number
  ssid1: string
  ssid2: string
  ssid3: string
  ssid4: string
  _lastInform: string
  _lastBoot: string
  _connectionState: string
  _deviceId: {
    _Manufacturer: string
    _OUI: string
    _ProductClass: string
    _SerialNumber: string
  }
  InternetGatewayDevice: {
    DeviceInfo: {
      Manufacturer: string
      ProductClass: string
      SerialNumber: string
      HardwareVersion: string
      SoftwareVersion: string
    }
    LANDevice: {
      Hosts: {
        Host: Array<{
          IPAddress: string
          MACAddress: string
          HostName: string
          Active: boolean
        }>
      }
    }
    WANDevice: {
      WANConnectionDevice: Array<{
        Name: string
        ConnectionStatus: string
        ExternalIPAddress: string
        MACAddress: string
      }>
    }
  }
}

export default function DeviceDetailClient({ deviceId }: { deviceId: string }) {
  const router = useRouter()
  const [device, setDevice] = useState<DeviceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')
  const [rebooting, setRebooting] = useState(false)
  const toast = useToast()

  useEffect(() => {
    const fetchDeviceDetails = async () => {
      try {
        setLoading(true)
        // Simulate API call to fetch device details
        const timer = setTimeout(() => {
          const mockDevice: DeviceDetail = {
            _id: deviceId,
            SerialNumber: 'SN123456789',
            productclass: 'HG8245H',
            manufacturer: 'Huawei',
            oui: '00E0FC',
            pppoe: 'user123@isp.com',
            wanbridge: 'Enabled',
            rxpower: -25,
            temperature: 45,
            activedevices: 12,
            ssid1: 'HomeNetwork_5G',
            ssid2: 'GuestNetwork',
            ssid3: 'IoT_Devices',
            ssid4: '',
            _lastInform: '2024-01-15 14:30:25',
            _lastBoot: '2024-01-10 09:15:00',
            _connectionState: 'Connected',
            _deviceId: {
              _Manufacturer: 'Huawei',
              _OUI: '00E0FC',
              _ProductClass: 'HG8245H',
              _SerialNumber: 'SN123456789'
            },
            InternetGatewayDevice: {
              DeviceInfo: {
                Manufacturer: 'Huawei Technologies Co., Ltd.',
                ProductClass: 'HG8245H',
                SerialNumber: 'SN123456789',
                HardwareVersion: 'VER.A',
                SoftwareVersion: 'V5R15C10S100'
              },
              LANDevice: {
                Hosts: {
                  Host: [
                    {
                      IPAddress: '192.168.100.10',
                      MACAddress: 'AA:BB:CC:DD:EE:01',
                      HostName: 'iPhone-John',
                      Active: true
                    },
                    {
                      IPAddress: '192.168.100.11',
                      MACAddress: 'AA:BB:CC:DD:EE:02',
                      HostName: 'Laptop-Jane',
                      Active: true
                    },
                    {
                      IPAddress: '192.168.100.12',
                      MACAddress: 'AA:BB:CC:DD:EE:03',
                      HostName: 'Smart-TV',
                      Active: false
                    }
                  ]
                }
              },
              WANDevice: {
                WANConnectionDevice: [
                  {
                    Name: 'WANConnectionDevice',
                    ConnectionStatus: 'Connected',
                    ExternalIPAddress: '203.0.113.123',
                    MACAddress: '00:11:22:33:44:55'
                  }
                ]
              }
            }
          }
          setDevice(mockDevice)
          setLoading(false)
        }, 1500)

        return () => clearTimeout(timer)
      } catch (error) {
        console.error('Error fetching device details:', error)
        setLoading(false)
        // Handle error state here
      }
    }

    fetchDeviceDetails()
  }, [deviceId])

  const handleReboot = () => {
    setRebooting(true)
    // Simulate reboot command
    setTimeout(() => {
      setRebooting(false)
      toast.success('Device reboot command sent successfully!')
    }, 3000)
  }

  const getSignalStrengthColor = (rxpower: number) => {
    if (rxpower >= -25) return 'text-green-600 dark:text-green-400'
    if (rxpower >= -50) return 'text-yellow-600 dark:text-yellow-400'
    if (rxpower >= -75) return 'text-orange-600 dark:text-orange-400'
    return 'text-red-600 dark:text-red-400'
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'Connected':
        return <span className="modern-badge-success">Connected</span>
      case 'Disconnected':
        return <span className="modern-badge-error">Disconnected</span>
      case 'Connecting':
        return <span className="modern-badge-warning">Connecting</span>
      default:
        return <span className="modern-badge">Unknown</span>
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-4 border-gray-200 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin"></div>
            <p className="ml-4 text-gray-500 dark:text-gray-400">Loading device details...</p>
          </div>
        </div>
      </div>
    )
  }

  if (!device) {
    return (
      <div className="p-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center py-20">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Device Not Found</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-4">The device you're looking for doesn't exist or has been removed.</p>
            <button
              onClick={() => router.push('/devices')}
              className="modern-button"
            >
              Back to Devices
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2 mb-2">
              <button
                onClick={() => router.push('/devices')}
                className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
              >
                ← Back to Devices
              </button>
            </div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              Device Details: {device._id}
            </h1>
            <div className="flex items-center space-x-4">
              {getStatusBadge(device._connectionState)}
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Last seen: {device._lastInform}
              </span>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleReboot}
              disabled={rebooting}
              className="modern-button-secondary"
            >
              {rebooting ? 'Rebooting...' : 'Reboot Device'}
            </button>
            <button className="modern-button">
              Edit Configuration
            </button>
            <button
              onClick={() => toast.success('Summon Device sent')}
              className="modern-button"
              title="Summon Device"
            >
              🛎 Summon
            </button>
          </div>
        </div>

        {/* Device Info Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <div className="modern-card p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Signal Strength</span>
              <span className="text-2xl">📡</span>
            </div>
            <div className={`text-2xl font-bold ${getSignalStrengthColor(device.rxpower)}`}>
              {device.rxpower} dBm
            </div>
          </div>
          <div className="modern-card p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Temperature</span>
              <span className="text-2xl">🌡️</span>
            </div>
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {device.temperature}°C
            </div>
          </div>
          <div className="modern-card p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Active Devices</span>
              <span className="text-2xl">📱</span>
            </div>
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {device.activedevices}
            </div>
          </div>
          <div className="modern-card p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Model</span>
              <span className="text-2xl">🏠</span>
            </div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {device.productclass}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-8">
          <div className="flex space-x-1 border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'overview'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab('network')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'network'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Network
            </button>
            <button
              onClick={() => setActiveTab('wifi')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'wifi'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              WiFi
            </button>
            <button
              onClick={() => setActiveTab('advanced')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'advanced'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Advanced
            </button>
          </div>
        </div>

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="modern-card p-6">
              <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Device Information</h2>
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Device ID:</span>
                  <span className="font-mono text-sm">{device._id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Serial Number:</span>
                  <span className="font-mono text-sm">{device.SerialNumber}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Manufacturer:</span>
                  <span>{device.manufacturer}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Product Class:</span>
                  <span>{device.productclass}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Hardware Version:</span>
                  <span>{device.InternetGatewayDevice.DeviceInfo.HardwareVersion}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Software Version:</span>
                  <span>{device.InternetGatewayDevice.DeviceInfo.SoftwareVersion}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Last Boot:</span>
                  <span>{device._lastBoot}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">PPPoE Username:</span>
                  <span>{device.pppoe}</span>
                </div>
              </div>
            </div>

            <div className="modern-card p-6">
              <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">WAN Service & Interface Bindings</h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-gray-600 dark:text-gray-400">WAN Bridge</span>
                  <span className="font-medium">{device.wanbridge}</span>
                </div>
                <div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">Interface Bindings</div>
                  <div className="grid grid-cols-4 gap-2">
                    {['LAN1','LAN2','LAN3','LAN4'].map((ifc, idx) => (
                      <div key={idx} className={`rounded-md p-2 text-center ${idx % 2 === 0 ? 'bg-green-100 dark:bg-green-900/30' : 'bg-gray-100 dark:bg-gray-800'}`}>
                        <div className="text-xs">{ifc}</div>
                        <div className="text-sm font-semibold">{idx % 2 === 0 ? 'ON' : 'OFF'}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600 dark:text-gray-400">NAT</span>
                  <span className="font-medium">Enabled</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Type WAN</span>
                  <span className="font-medium">PPPoE</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'network' && (
          <div className="modern-card p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Network Configuration</h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <h3 className="text-md font-medium mb-3 text-gray-900 dark:text-gray-100">WAN Configuration</h3>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Connection Status:</span>
                    {getStatusBadge(device.InternetGatewayDevice.WANDevice.WANConnectionDevice[0].ConnectionStatus)}
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">External IP:</span>
                    <span className="font-mono text-sm">{device.InternetGatewayDevice.WANDevice.WANConnectionDevice[0].ExternalIPAddress}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">MAC Address:</span>
                    <span className="font-mono text-sm">{device.InternetGatewayDevice.WANDevice.WANConnectionDevice[0].MACAddress}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">WAN Bridge:</span>
                    <span>{device.wanbridge}</span>
                  </div>
                </div>
              </div>
              <div>
                <h3 className="text-md font-medium mb-3 text-gray-900 dark:text-gray-100">Signal Information</h3>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">RX Power:</span>
                    <span className={`font-medium ${getSignalStrengthColor(device.rxpower)}`}>
                      {device.rxpower} dBm
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Temperature:</span>
                    <span className="font-medium">{device.temperature}°C</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Connection State:</span>
                    {getStatusBadge(device._connectionState)}
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Last Inform:</span>
                    <span className="text-sm">{device._lastInform}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'wifi' && (
          <div className="modern-card p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">WiFi Configuration</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {device.ssid1 && (
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <h3 className="font-medium mb-2 text-gray-900 dark:text-gray-100">SSID 1</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Network Name:</span>
                      <span>{device.ssid1}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Security:</span>
                      <span>WPA2-PSK</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Frequency:</span>
                      <span>5 GHz</span>
                    </div>
                  </div>
                </div>
              )}
              {device.ssid2 && (
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <h3 className="font-medium mb-2 text-gray-900 dark:text-gray-100">SSID 2</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Network Name:</span>
                      <span>{device.ssid2}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Security:</span>
                      <span>WPA2-PSK</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Frequency:</span>
                      <span>2.4 GHz</span>
                    </div>
                  </div>
                </div>
              )}
              {device.ssid3 && (
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <h3 className="font-medium mb-2 text-gray-900 dark:text-gray-100">SSID 3</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Network Name:</span>
                      <span>{device.ssid3}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Security:</span>
                      <span>WPA2-PSK</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Frequency:</span>
                      <span>2.4 GHz</span>
                    </div>
                  </div>
                </div>
              )}
              {device.ssid4 && (
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <h3 className="font-medium mb-2 text-gray-900 dark:text-gray-100">SSID 4</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Network Name:</span>
                      <span>{device.ssid4}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Security:</span>
                      <span>WPA2-PSK</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Frequency:</span>
                      <span>2.4 GHz</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'advanced' && (
          <div className="modern-card p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Advanced Configuration</h2>
            <div className="space-y-6">
              <div>
                <h3 className="text-md font-medium mb-3 text-gray-900 dark:text-gray-100">System Control</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                    <h4 className="font-medium mb-2 text-gray-900 dark:text-gray-100">Firewall Level</h4>
                    <select className="modern-input w-full">
                      <option>Low</option>
                      <option>Medium</option>
                      <option>High</option>
                    </select>
                  </div>
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                    <h4 className="font-medium mb-2 text-gray-900 dark:text-gray-100">HTTP WAN Status</h4>
                    <select className="modern-input w-full">
                      <option>Disabled</option>
                      <option>Enabled</option>
                    </select>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-md font-medium mb-3 text-gray-900 dark:text-gray-100">Change Credentials</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                    <h4 className="font-medium mb-2 text-gray-900 dark:text-gray-100">Superadmin (ISP)</h4>
                    <input className="modern-input w-full" placeholder="New Username" />
                    <input className="modern-input w-full mt-2" type="password" placeholder="New Password" />
                    <button className="modern-button mt-3">Update Superadmin</button>
                  </div>
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                    <h4 className="font-medium mb-2 text-gray-900 dark:text-gray-100">Useradmin (Client)</h4>
                    <input className="modern-input w-full" placeholder="New Username" />
                    <input className="modern-input w-full mt-2" type="password" placeholder="New Password" />
                    <button className="modern-button mt-3">Update Useradmin</button>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-md font-medium mb-3 text-gray-900 dark:text-gray-100">System Information</h3>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                  <pre className="text-xs overflow-x-auto">
                    {JSON.stringify(device._deviceId, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}