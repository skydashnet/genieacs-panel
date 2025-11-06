'use client'

import { useState, useEffect } from 'react'

interface Vendor {
  id: number
  name: string
  manufacturer_patterns: string[]
  product_patterns: string[]
  parameter_prefix: string
  service_list_path: string | null
  lan_binding_path: string | null
  vlan_id_path: string | null
  wifi_password_path: string
  http_wan_enable_path?: string
  firewall_level_path?: string
  priority: number
  enabled: number
  description: string
  created_at: string
  updated_at: string
}

export default function Vendors() {
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('vendors')
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null)

  useEffect(() => {
    // Simulate API call
    const timer = setTimeout(() => {
      const mockVendors: Vendor[] = [
        {
          id: 1,
          name: 'Huawei',
          manufacturer_patterns: ['huawei', 'hw'],
          product_patterns: ['eg8', 'hg8', 'hs8'],
          parameter_prefix: 'X_HW',
          service_list_path: 'X_HW_SERVICELIST',
          lan_binding_path: 'X_HW_LANBIND',
          vlan_id_path: 'X_HW_VLAN',
          wifi_password_path: 'PreSharedKey.1.KeyPassphrase',
          http_wan_enable_path: 'InternetGatewayDevice.X_HW_Security.AclServices.HTTPWanEnable',
          firewall_level_path: 'InternetGatewayDevice.X_HW_Security.X_HW_FirewallLevel',
          priority: 10,
          enabled: 1,
          description: 'Huawei Technologies ONT devices',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z'
        },
        {
          id: 2,
          name: 'ZTE CT-COM',
          manufacturer_patterns: ['zte', 'zicg', 'ciot', 'ggcl', 'hwtc'],
          product_patterns: ['f663nv3a', 'f6600', 'zxhn'],
          parameter_prefix: 'X_CT-COM',
          service_list_path: 'X_CT-COM_ServiceList',
          lan_binding_path: 'X_CT-COM_LanInterface',
          vlan_id_path: 'X_CT-COM_WANEponLinkConfig.VLANIDMark',
          wifi_password_path: 'KeyPassphrase',
          priority: 10,
          enabled: 1,
          description: 'ZTE China Telecom variant',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z'
        },
        {
          id: 3,
          name: 'ZTE CMCC',
          manufacturer_patterns: ['zte', 'zicg', 'ciot'],
          product_patterns: ['f663nv9', 'f677'],
          parameter_prefix: 'X_CMCC',
          service_list_path: 'X_CMCC_ServiceList',
          lan_binding_path: 'X_CMCC_LanInterface',
          vlan_id_path: 'X_CMCC_VLANID',
          wifi_password_path: 'KeyPassphrase',
          priority: 9,
          enabled: 1,
          description: 'ZTE China Mobile variant',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z'
        },
        {
          id: 4,
          name: 'FiberHome',
          manufacturer_patterns: ['fh'],
          product_patterns: ['an5506', 'hg6145'],
          parameter_prefix: 'X_FH',
          service_list_path: null,
          lan_binding_path: null,
          vlan_id_path: 'VLANID',
          wifi_password_path: 'KeyPassphrase',
          priority: 10,
          enabled: 1,
          description: 'FiberHome Telecommunication Technologies ONT devices',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z'
        }
      ]
      setVendors(mockVendors)
      setLoading(false)
    }, 1500)

    return () => clearTimeout(timer)
  }, [])

  const handleEditVendor = (vendor: Vendor) => {
    setEditingVendor(vendor)
    // TODO: Open edit modal/form
    console.log('Editing vendor:', vendor)
  }

  const handleDeleteVendor = (vendor: Vendor) => {
    if (window.confirm(`Are you sure you want to delete ${vendor.name}?`)) {
      // TODO: Implement delete API call
      console.log('Deleting vendor:', vendor)
      // For now, just remove from state
      setVendors(vendors.filter(v => v.id !== vendor.id))
    }
  }

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">Vendor Management</h1>
          <p className="text-gray-600 dark:text-gray-400">Configure vendor-specific parameters and settings</p>
        </div>

        {/* Tabs */}
        <div className="mb-8">
          <div className="flex space-x-1 border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={() => setActiveTab('vendors')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'vendors'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Vendors
            </button>
            <button
              onClick={() => setActiveTab('parameters')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'parameters'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Parameters
            </button>
            <button
              onClick={() => setActiveTab('wifi-security')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'wifi-security'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              WiFi Security
            </button>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-4 border-gray-200 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin"></div>
            <p className="ml-4 text-gray-500 dark:text-gray-400">Loading vendor data...</p>
          </div>
        ) : (
          <>
            {activeTab === 'vendors' && (
              <div className="modern-card p-6">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Vendor Configuration</h2>
                  <button className="modern-button">
                    + Add Vendor
                  </button>
                </div>
                
                <div className="overflow-x-auto">
                  <table className="modern-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Manufacturer Patterns</th>
                        <th>Product Patterns</th>
                        <th>Parameter Prefix</th>
                        <th>Priority</th>
                        <th>Enabled</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vendors.map((vendor) => (
                        <tr key={vendor.id}>
                          <td className="font-medium">{vendor.name}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {vendor.manufacturer_patterns.map((pattern, idx) => (
                                <span key={idx} className="modern-badge">{pattern}</span>
                              ))}
                            </div>
                          </td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {vendor.product_patterns.map((pattern, idx) => (
                                <span key={idx} className="modern-badge">{pattern}</span>
                              ))}
                            </div>
                          </td>
                          <td className="font-mono text-sm">{vendor.parameter_prefix}</td>
                          <td>{vendor.priority}</td>
                          <td>
                            <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                              vendor.enabled
                                ? 'modern-badge-success'
                                : 'modern-badge-error'
                            }`}>
                              {vendor.enabled ? '✓ Enabled' : '✗ Disabled'}
                            </span>
                          </td>
                          <td>
                            <div className="flex space-x-2">
                              <button
                                onClick={() => handleEditVendor(vendor)}
                                className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                                title="Edit"
                              >
                                ✏️
                              </button>
                              <button
                                onClick={() => handleDeleteVendor(vendor)}
                                className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                                title="Delete"
                              >
                                🗑️
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === 'parameters' && (
              <div className="modern-card p-6">
                <h2 className="text-lg font-semibold mb-6 text-gray-900 dark:text-gray-100">Vendor Parameters</h2>
                <div className="text-center py-20">
                  <div className="text-6xl mb-4">⚙️</div>
                  <p className="text-gray-500 dark:text-gray-400">Parameter configuration interface</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">Configure vendor-specific parameters for different device categories</p>
                </div>
              </div>
            )}

            {activeTab === 'wifi-security' && (
              <div className="modern-card p-6">
                <h2 className="text-lg font-semibold mb-6 text-gray-900 dark:text-gray-100">WiFi Security Mappings</h2>
                <div className="text-center py-20">
                  <div className="text-6xl mb-4">🔐</div>
                  <p className="text-gray-500 dark:text-gray-400">WiFi security configuration</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">Map raw security values to normalized security types</p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}