'use client'

import { useState, useEffect } from 'react'
import { vendorsAPI, settingsAPI, authAPI } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useLoading } from '@/components/ui/loading'
import type { Vendor as VendorType, WifiSecurityConfig as WifiSecurityConfigType } from '@/types' // Hapus WifiSecurityMappingType

export default function Settings() {
  const [settings, setSettings] = useState({
    appName: 'GenieACS Panel',
    genieAcsUrl: 'http://localhost:7557/devices',
    vpPppoeUsername: 'VirtualParameters.pppoeUsername',
    vpWanBridge: 'VirtualParameters.WANBRIDGE',
    vpRxPower: 'VirtualParameters.RXPower',
    vpTemperature: 'VirtualParameters.gettemp',
    vpActiveDevices: 'VirtualParameters.activedevices',
    vpSuperAdmin: 'VirtualParameters.superAdmin',
    vpSuperPassword: 'VirtualParameters.superPassword',
    vpUserAdmin: 'VirtualParameters.userAdmin',
    vpUserPassword: 'VirtualParameters.userPassword'
  })
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [testResult, setTestResult] = useState<{success: boolean, message: string, deviceCount?: number} | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await settingsAPI.getAll()
      if (!cancelled && res.success && res.data) {
        setSettings(prev => ({ ...prev, ...(res.data as any) }))
      }
      setTestResult(null)
    })()
    return () => { cancelled = true }
  }, [])

  const handleTestConnection = async () => {
    setLoading(true)
    loadingCtl.show('Testing GenieACS connection...')
    try {
      const res = await settingsAPI.testGenieAcs(settings.genieAcsUrl)
      if (res.success) {
        setTestResult({
          success: true,
          message: res.message || 'Connection successful!',
          deviceCount: (res.data as any)?.deviceCount
        })
        toast.success('GenieACS connection OK')
      } else {
        setTestResult({
          success: false,
          message: res.message || 'Connection failed'
        })
        toast.error(res.message || 'Connection failed')
      }
    } finally {
      setLoading(false)
      loadingCtl.hide()
    }
  }

  const [notification, setNotification] = useState<{success: boolean, message: string} | null>(null)
  const toast = useToast()
  const loadingCtl = useLoading()

  // Change Username & Password forms
  const [usernameForm, setUsernameForm] = useState<{ currentUsername: string; newUsername: string }>({
    currentUsername: '',
    newUsername: ''
  })
  const [passwordForm, setPasswordForm] = useState<{ currentPassword: string; newPassword: string; confirmNewPassword: string }>({
    currentPassword: '',
    newPassword: '',
    confirmNewPassword: ''
  })

  const submitChangeUsername = async () => {
    const res = await authAPI.changeUsername(usernameForm.currentUsername, usernameForm.newUsername)
    if (res.success) {
      toast.success(res.message || 'Username updated successfully')
      setUsernameForm({ currentUsername: '', newUsername: '' })
    } else {
      toast.error(res.message || 'Failed to update username')
    }
  }

  const submitChangePassword = async () => {
    if (!passwordForm.newPassword || passwordForm.newPassword !== passwordForm.confirmNewPassword) {
      toast.error('New password and confirmation do not match')
      return
    }
    const res = await authAPI.changePassword(passwordForm.currentPassword, passwordForm.newPassword)
    if (res.success) {
      toast.success(res.message || 'Password updated successfully')
      setPasswordForm({ currentPassword: '', newPassword: '', confirmNewPassword: '' })
    } else {
      toast.error(res.message || 'Failed to update password')
    }
  }

  const handleSaveSettings = async () => {
    setLoading(true)
    loadingCtl.show('Saving settings...')
    let ok = true
    try {
      const entries = Object.entries(settings)
      for (const [key, value] of entries) {
        const res = await settingsAPI.update(key, String(value))
        if (!res.success) {
          ok = false
          break
        }
      }
      setNotification({
        success: ok,
        message: ok ? 'Settings saved successfully!' : 'Failed to save some settings'
      })
      toast[ok ? 'success' : 'error'](ok ? 'Settings saved' : 'Some settings failed to save')
      if (ok) {
        try {
          localStorage.setItem('appName', settings.appName)
          window.dispatchEvent(new CustomEvent('appNameChanged', { detail: settings.appName }))
        } catch {}
      }
    } finally {
      setLoading(false)
      loadingCtl.hide()
      setTimeout(() => setNotification(null), 3000)
    }
  }

  // ===== Vendor Management State/Actions =====
  const [vendorList, setVendorList] = useState<VendorType[]>([])
  const [vendorsLoading, setVendorsLoading] = useState(false)
  const [creatingVendor, setCreatingVendor] = useState(false)
  const [editingVendor, setEditingVendor] = useState<VendorType | null>(null)
  
  const [vendorForm, setVendorForm] = useState<{
    name: string
    parameter_prefix: string
    manufacturer_patterns: string
    product_patterns: string
    service_list_path: string
    lan_binding_path: string
    vlan_id_path: string
    wifi_password_path: string
    http_wan_enable_path: string
    firewall_level_path: string
    priority: number
    enabled: number
    description: string
  }>({
    name: '',
    parameter_prefix: '',
    manufacturer_patterns: '',
    product_patterns: '',
    service_list_path: '',
    lan_binding_path: '',
    vlan_id_path: '',
    wifi_password_path: '',
    http_wan_enable_path: '',
    firewall_level_path: '',
    priority: 10,
    enabled: 1,
    description: '',
  })

  const fetchVendors = async () => {
    setVendorsLoading(true)
    const res = await vendorsAPI.getAll()
    if (res.success && Array.isArray(res.data)) {
      setVendorList(res.data as unknown as VendorType[])
    }
    setVendorsLoading(false)
  }

  useEffect(() => {
    if (activeTab === 'vendors') {
      fetchVendors()
    }
  }, [activeTab])

  const resetVendorForm = () => {
    setVendorForm({
      name: '',
      parameter_prefix: '',
      manufacturer_patterns: '',
      product_patterns: '',
      service_list_path: '',
      lan_binding_path: '',
      vlan_id_path: '',
      wifi_password_path: '',
      http_wan_enable_path: '',
      firewall_level_path: '',
      priority: 10,
      enabled: 1,
      description: '',
    })
    setEditingVendor(null)
    setCreatingVendor(false)
  }

  const submitVendor = async () => {
    const payload: any = {
      name: vendorForm.name,
      parameter_prefix: vendorForm.parameter_prefix || null,
      manufacturer_patterns: vendorForm.manufacturer_patterns.split(',').map(s => s.trim()).filter(Boolean),
      product_patterns: vendorForm.product_patterns.split(',').map(s => s.trim()).filter(Boolean),
      service_list_path: vendorForm.service_list_path || null,
      lan_binding_path: vendorForm.lan_binding_path || null,
      vlan_id_path: vendorForm.vlan_id_path || null,
      wifi_password_path: vendorForm.wifi_password_path || null,
      http_wan_enable_path: vendorForm.http_wan_enable_path || null,
      firewall_level_path: vendorForm.firewall_level_path || null,
      priority: Number(vendorForm.priority) || 10,
      enabled: Number(vendorForm.enabled) ? 1 : 0,
      description: vendorForm.description || null,
    }
    let res
    if (editingVendor) {
      res = await vendorsAPI.update(editingVendor.id, payload)
    } else {
      res = await vendorsAPI.create(payload)
    }
    if (res.success) {
      const msg = editingVendor ? 'Vendor updated' : 'Vendor created'
      setNotification({ success: true, message: msg })
      toast.success(msg)
      await fetchVendors()
      resetVendorForm()
    } else {
      const msg = res.message || 'Operation failed'
      setNotification({ success: false, message: msg })
      toast.error(msg)
    }
  }

  const deleteVendor = async (id: number) => {
    if (!confirm('Delete this vendor?')) return
    const res = await vendorsAPI.delete(id)
    if (res.success) {
      setVendorList(prev => prev.filter(v => v.id !== id))
      setNotification({ success: true, message: 'Vendor deleted' })
      toast.success('Vendor deleted')
    } else {
      const msg = res.message || 'Failed to delete vendor'
      setNotification({ success: false, message: msg })
      toast.error(msg)
    }
  }

  // ===== WiFi Security Configs =====
  const [wifiConfigs, setWifiConfigs] = useState<WifiSecurityConfigType[]>([])
  const [wifiConfigLoading, setWifiConfigLoading] = useState(false)
  const [creatingConfig, setCreatingConfig] = useState(false) // State buat nampilin form
  const [configForm, setConfigForm] = useState<{ product_class: string; security_types: string; password_param_path: string }>({
    product_class: '',
    security_types: '',
    password_param_path: ''
  })
  const [editingConfig, setEditingConfig] = useState<WifiSecurityConfigType | null>(null)

  const fetchWifiConfigs = async () => {
    setWifiConfigLoading(true)
    const res = await vendorsAPI.getAllWifiSecurityConfigs()
    if (res.success && Array.isArray(res.data)) {
      setWifiConfigs(res.data as unknown as WifiSecurityConfigType[])
    }
    setWifiConfigLoading(false)
  }

  useEffect(() => {
    if (activeTab === 'wifi-security') {
      fetchWifiConfigs()
    }
  }, [activeTab])

  const resetConfigForm = () => {
    setConfigForm({ product_class: '', security_types: '', password_param_path: '' })
    setEditingConfig(null)
    setCreatingConfig(false)
  }

  const submitWifiConfig = async () => {
    const payload = {
      product_class: configForm.product_class,
      security_types: configForm.security_types,
      password_param_path: configForm.password_param_path,
    }
    let res
    if (editingConfig) {
      res = await vendorsAPI.updateWifiSecurityConfig(editingConfig.id, payload)
    } else {
      res = await vendorsAPI.createWifiSecurityConfig(payload)
    }
    if (res.success) {
      const msg = editingConfig ? 'WiFi security config updated' : 'WiFi security config created'
      setNotification({ success: true, message: msg })
      toast.success(msg)
      await fetchWifiConfigs()
      resetConfigForm()
    } else {
      const msg = res.message || 'Operation failed'
      setNotification({ success: false, message: msg })
      toast.error(msg)
    }
  }

  const deleteWifiConfig = async (id: number) => {
    if (!confirm('Delete this config?')) return
    const res = await vendorsAPI.deleteWifiSecurityConfig(id)
    if (res.success) {
      setWifiConfigs(prev => prev.filter(c => c.id !== id))
      setNotification({ success: true, message: 'WiFi security config deleted' })
      toast.success('WiFi security config deleted')
    } else {
      const msg = res.message || 'Failed to delete config'
      setNotification({ success: false, message: msg })
      toast.error(msg)
    }
  }

  return (
    <div className="p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">Settings</h1>
          <p className="text-gray-600 dark:text-gray-400">Configure system settings and virtual parameters</p>
        </div>

        {/* Tabs */}
        <div className="mb-8">
          <div className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={() => setActiveTab('general')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'general'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              General
            </button>
            <button
              onClick={() => setActiveTab('virtual-params')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'virtual-params'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Virtual Parameters
            </button>
            <button
              onClick={() => setActiveTab('security')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'security'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Security
            </button>
            <button
              onClick={() => setActiveTab('vendors')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'vendors'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Vendor Management
            </button>
            <button
              onClick={() => setActiveTab('wifi-security')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'wifi-security'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              WiFi Security Config
            </button>
          </div>
        </div>

        {/* Content */}
        {activeTab === 'general' && (
          <div className="space-y-6">
            {/* App Settings */}
            <div className="modern-card p-6">
              <h2 className="text-lg font-semibold mb-6 text-gray-900 dark:text-gray-100">Application Settings</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Application Name</label>
                  <input
                    type="text"
                    value={settings.appName}
                    onChange={(e) => setSettings({...settings, appName: e.target.value})}
                    className="modern-input w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">GenieACS URL</label>
                  <div className="flex space-x-2">
                    <input
                      type="url"
                      value={settings.genieAcsUrl}
                      onChange={(e) => setSettings({...settings, genieAcsUrl: e.target.value})}
                      className="modern-input flex-1"
                    />
                    <button
                      onClick={handleTestConnection}
                      disabled={loading}
                      className="modern-button"
                    >
                      {loading ? 'Testing...' : 'Test'}
                    </button>
                  </div>
                </div>
              </div>

              {testResult && (
                <div className={`mt-4 p-4 rounded-lg ${
                  testResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800'
                }`}>
                  <div className="flex items-center">
                    <span className="text-lg mr-2">
                      {testResult.success ? '✅' : '❌'}
                    </span>
                    <span className="font-medium">{testResult.message}</span>
                    {testResult.deviceCount && (
                      <span className="ml-2 text-sm">
                        ({testResult.deviceCount} devices found)
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'virtual-params' && (
          <div className="modern-card p-6">
            <h2 className="text-lg font-semibold mb-6 text-gray-900 dark:text-gray-100">Virtual Parameters</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Object.entries(settings).filter(([key]) => key.startsWith('vp')).map(([key, value]) => (
                <div key={key}>
                  <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">
                    {key.replace('vp', '').replace(/([A-Z])/g, ' $1')}
                  </label>
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => setSettings({...settings, [key]: e.target.value})}
                    className="modern-input w-full font-mono text-sm"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'security' && (
          <div className="modern-card p-6">
            <h2 className="text-lg font-semibold mb-6 text-gray-900 dark:text-gray-100">Security Settings</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">Session Timeout</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Automatically logout after inactivity</p>
                </div>
                <select className="modern-input w-40">
                  <option>30 minutes</option>
                  <option>1 hour</option>
                  <option>2 hours</option>
                  <option>4 hours</option>
                  <option>Never</option>
                </select>
              </div>
              <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">Two-Factor Authentication</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Add an extra layer of security</p>
                </div>
                <button className="modern-button">
                  Enable 2FA
                </button>
              </div>

              {/* Change Username */}
              <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-3">Change Username</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Current Username</label>
                    <input
                      value={usernameForm.currentUsername}
                      onChange={(e) => setUsernameForm(f => ({ ...f, currentUsername: e.target.value }))}
                      className="modern-input w-full"
                      placeholder="current username"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">New Username</label>
                    <input
                      value={usernameForm.newUsername}
                      onChange={(e) => setUsernameForm(f => ({ ...f, newUsername: e.target.value }))}
                      className="modern-input w-full"
                      placeholder="new username"
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <button onClick={submitChangeUsername} className="modern-button">Update Username</button>
                </div>
              </div>

              {/* Change Password */}
              <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-3">Change Password</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Current Password</label>
                    <input
                      type="password"
                      value={passwordForm.currentPassword}
                      onChange={(e) => setPasswordForm(f => ({ ...f, currentPassword: e.target.value }))}
                      className="modern-input w-full"
                      placeholder="current password"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">New Password</label>
                    <input
                      type="password"
                      value={passwordForm.newPassword}
                      onChange={(e) => setPasswordForm(f => ({ ...f, newPassword: e.target.value }))}
                      className="modern-input w-full"
                      placeholder="new password"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Confirm New Password</label>
                    <input
                      type="password"
                      value={passwordForm.confirmNewPassword}
                      onChange={(e) => setPasswordForm(f => ({ ...f, confirmNewPassword: e.target.value }))}
                      className="modern-input w-full"
                      placeholder="confirm new password"
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <button onClick={submitChangePassword} className="modern-button">Update Password</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Vendors Tab */}
        {activeTab === 'vendors' && (
          <div className="space-y-6">
            {/* Vendor List */}
            <div className="modern-card p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Vendor Management</h2>
                <button
                  onClick={() => { resetVendorForm(); setCreatingVendor(true) }}
                  className="modern-button"
                >
                  + Add Vendor
                </button>
              </div>

              {(creatingVendor || editingVendor) && (
                <div className="mb-6 p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    
                    {/* General Info */}
                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">Name *</label>
                      <input
                        value={vendorForm.name}
                        onChange={(e) => setVendorForm(v => ({ ...v, name: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="Vendor name"
                      />
                    </div>
                    
                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">Manufacturer Patterns (Comma-separated) *</label>
                      <input
                        value={vendorForm.manufacturer_patterns}
                        onChange={(e) => setVendorForm(v => ({ ...v, manufacturer_patterns: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="huawei, hw"
                      />
                    </div>
                    
                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">Product Patterns (Comma-separated) *</label>
                      <input
                        value={vendorForm.product_patterns}
                        onChange={(e) => setVendorForm(v => ({ ...v, product_patterns: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="hg8, eg8, f660"
                      />
                    </div>
                    
                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">Parameter Prefix</label>
                      <input
                        value={vendorForm.parameter_prefix}
                        onChange={(e) => setVendorForm(v => ({ ...v, parameter_prefix: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW"
                      />
                    </div>

                    {/* WAN Connection Parameters */}
                    <h3 className="md:col-span-3 text-md font-semibold text-gray-800 dark:text-gray-200 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">WAN Connection Parameters</h3>
                    
                    <div>
                      <label className="block text-sm font-medium mb-1">Service List Path</label>
                      <input
                        value={vendorForm.service_list_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, service_list_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW_SERVICELIST"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">LAN Binding Path</label>
                      <input
                        value={vendorForm.lan_binding_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, lan_binding_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW_LANBIND"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">VLAN ID Path</label>
                      <input
                        value={vendorForm.vlan_id_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, vlan_id_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. X_HW_VLAN"
                      />
                    </div>

                    {/* WiFi & Security Parameters */}
                    <h3 className="md:col-span-3 text-md font-semibold text-gray-800 dark:text-gray-200 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">WiFi & Security Parameters</h3>

                    <div>
                      <label className="block text-sm font-medium mb-1">WiFi Password Path</label>
                      <input
                        value={vendorForm.wifi_password_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, wifi_password_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. PreSharedKey.1.KeyPassphrase"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">HTTP WAN Enable Path</label>
                      <input
                        value={vendorForm.http_wan_enable_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, http_wan_enable_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. ...AclServices.HTTPWanEnable"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium mb-1">Firewall Level Path</label>
                      <input
                        value={vendorForm.firewall_level_path}
                        onChange={(e) => setVendorForm(v => ({ ...v, firewall_level_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="e.g. ...X_HW_FirewallLevel"
                      />
                    </div>

                    {/* Other Parameters */}
                    <h3 className="md:col-span-3 text-md font-semibold text-gray-800 dark:text-gray-200 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">Other Parameters</h3>

                    <div>
                      <label className="block text-sm font-medium mb-1">Priority</label>
                      <input
                        type="number"
                        value={vendorForm.priority}
                        onChange={(e) => setVendorForm(v => ({ ...v, priority: Number(e.target.value) }))}
                        className="modern-input w-full"
                        placeholder="10"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium mb-1">Status</label>
                      <select
                        value={vendorForm.enabled}
                        onChange={(e) => setVendorForm(v => ({ ...v, enabled: Number(e.target.value) }))}
                        className="modern-input w-full"
                      >
                        <option value={1}>Enabled</option>
                        <option value={0}>Disabled</option>
                      </select>
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-sm font-medium mb-1">Description</label>
                      <textarea
                        value={vendorForm.description}
                        onChange={(e) => setVendorForm(v => ({ ...v, description: e.target.value }))}
                        className="modern-input w-full"
                        rows={2}
                        placeholder="Optional description"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-4">
                    <button onClick={submitVendor} className="modern-button">
                      {editingVendor ? 'Update Vendor' : 'Create Vendor'}
                    </button>
                    <button
                      onClick={resetVendorForm}
                      className="modern-button-secondary"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="modern-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Parameter Prefix</th>
                      <th>Patterns</th>
                      <th>Priority</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendorsLoading ? (
                      <tr>
                        <td colSpan={6} className="text-center py-8">
                          <div className="w-8 h-8 border-4 border-gray-200 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin mx-auto"></div>
                          <p className="mt-2 text-gray-500 dark:text-gray-400">Loading vendors...</p>
                        </td>
                      </tr>
                    ) : vendorList.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-8 text-gray-500 dark:text-gray-400">
                          No vendors
                        </td>
                      </tr>
                    ) : (
                      vendorList.map((v) => (
                        <tr key={v.id}>
                          <td className="font-medium">{v.name}</td>
                          <td className="font-mono text-xs">{v.parameter_prefix || '-'}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {(v.manufacturer_patterns || []).concat(v.product_patterns || []).map((p, idx) => (
                                <span key={idx} className="modern-badge">{p}</span>
                              ))}
                            </div>
                          </td>
                          <td>{v.priority}</td>
                          <td>
                            <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${v.enabled ? 'modern-badge-success' : 'modern-badge-error'}`}>
                              {v.enabled ? 'Enabled' : 'Disabled'}
                            </span>
                          </td>
                          <td>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => {
                                  setEditingVendor(v)
                                  setCreatingVendor(true)
                                  setVendorForm({
                                    name: v.name,
                                    parameter_prefix: v.parameter_prefix || '',
                                    manufacturer_patterns: (v.manufacturer_patterns || []).join(','),
                                    product_patterns: (v.product_patterns || []).join(','),
                                    service_list_path: v.service_list_path || '',
                                    lan_binding_path: v.lan_binding_path || '',
                                    vlan_id_path: v.vlan_id_path || '',
                                    wifi_password_path: v.wifi_password_path || '',
                                    http_wan_enable_path: v.http_wan_enable_path || '',
                                    firewall_level_path: v.firewall_level_path || '',
                                    priority: v.priority,
                                    enabled: v.enabled,
                                    description: v.description || ''
                                  })
                                }}
                                className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                                title="Edit"
                              >
                                ✏️
                              </button>
                              <button
                                onClick={() => deleteVendor(v.id)}
                                className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                                title="Delete"
                              >
                                🗑️
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* WiFi Security Tab */}
        {activeTab === 'wifi-security' && (
          <div className="space-y-6">
            {/* WiFi Security Configs */}
            <div className="modern-card p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">WiFi Security Configuration</h2>
                <button
                  onClick={() => { 
                    resetConfigForm(); 
                    setCreatingConfig(true);
                  }}
                  className="modern-button"
                >
                  + Add WiFi Config
                </button>
              </div>
              {(creatingConfig || editingConfig) && (
                <div className="mb-6 p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">Product Class</label>
                      <input
                        value={configForm.product_class}
                        onChange={(e) => setConfigForm(c => ({ ...c, product_class: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="e.g. HG8245H"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Security Types (comma separated)</label>
                      <input
                        value={configForm.security_types}
                        onChange={(e) => setConfigForm(c => ({ ...c, security_types: e.target.value }))}
                        className="modern-input w-full"
                        placeholder="WPA2-PSK,WPA3-PSK"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Password Param Path</label>
                      <input
                        value={configForm.password_param_path}
                        onChange={(e) => setConfigForm(c => ({ ...c, password_param_path: e.target.value }))}
                        className="modern-input w-full font-mono"
                        placeholder="...KeyPassphrase"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-4">
                    <button onClick={submitWifiConfig} className="modern-button">
                      {editingConfig ? 'Update Config' : 'Create Config'}
                    </button>
                    <button onClick={resetConfigForm} className="modern-button-secondary">Cancel</button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="modern-table">
                  {/* Style Header Tabel Sesuai SS */}
                  <thead>
                    <tr>
                      <th className="uppercase">Product Class</th>
                      <th className="uppercase">Password Path</th>
                      <th className="uppercase">Security Types</th>
                      <th className="uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wifiConfigLoading ? (
                      <tr>
                        <td colSpan={4} className="text-center py-8 text-gray-500 dark:text-gray-400">Loading configs...</td>
                      </tr>
                    ) : wifiConfigs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center py-8 text-gray-500 dark:text-gray-400">No configs</td>
                      </tr>
                    ) : (
                      wifiConfigs.map(cfg => (
                        <tr key={cfg.id}>
                          <td className="font-medium">{cfg.product_class}</td>
                          <td className="font-mono text-xs">{cfg.password_param_path}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {(cfg.security_types_array || []).map((s, idx) => (
                                <span key={idx} className="modern-badge">{s}</span>
                              ))}
                            </div>
                          </td>
                          <td>
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => {
                                  setEditingConfig(cfg);
                                  setCreatingConfig(false);
                                  setConfigForm({
                                    product_class: cfg.product_class,
                                    security_types: cfg.security_types,
                                    password_param_path: cfg.password_param_path
                                  })
                                }}
                                className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 font-medium text-sm"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => deleteWifiConfig(cfg.id)}
                                className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 font-medium text-sm"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Notification */}
        {notification && (
          <div className={`fixed top-4 right-4 z-50 p-4 rounded-lg shadow-lg transition-all duration-300 ${
            notification.success
              ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800'
          }`}>
            <div className="flex items-center">
              <span className="text-lg mr-2">
                {notification.success ? '✅' : '❌'}
              </span>
              <span className="font-medium">{notification.message}</span>
            </div>
          </div>
        )}

        {/* Save Button */}
        {(activeTab === 'general' || activeTab === 'virtual-params') && (
          <div className="flex justify-end mt-8">
            <button
              onClick={handleSaveSettings}
              disabled={loading}
              className="modern-button"
            >
              {loading ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}