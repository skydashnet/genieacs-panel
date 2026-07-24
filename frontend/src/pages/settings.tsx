'use client'

import { useState, useEffect } from 'react'
import { apiClient, vendorsAPI, settingsAPI, authAPI, databaseAPI, type DbConfigPayload } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useLoading } from '@/components/ui/loading'
import { Icon } from '@/components/ui/icon'
import type { Vendor as VendorType, WifiSecurityConfig as WifiSecurityConfigType } from '@/types'

const INSTALLER_VIRTUAL_PARAMETERS = {
  vpPppoeUsername: 'VirtualParameters.PPPUsername',
  vpWanBridge: 'VirtualParameters.WANBridge',
  vpRxPower: 'VirtualParameters.OpticalRXPower',
  vpTemperature: 'VirtualParameters.OpticalTemperature',
  vpActiveDevices: 'VirtualParameters.TotalStations',
  vpSuperAdmin: 'VirtualParameters.LoginSuperUser',
  vpSuperPassword: 'VirtualParameters.LoginSuperPass',
  vpUserAdmin: '',
  vpUserPassword: ''
}

const VIRTUAL_PARAMETER_FIELDS = [
  { key: 'vpPppoeUsername', label: 'PPPoE username', description: 'PPPUsername' },
  { key: 'vpWanBridge', label: 'WAN bridge status', description: 'WANBridge' },
  { key: 'vpRxPower', label: 'Optical RX power', description: 'OpticalRXPower' },
  { key: 'vpTemperature', label: 'Optical temperature', description: 'OpticalTemperature' },
  { key: 'vpActiveDevices', label: 'Connected stations', description: 'TotalStations' },
  { key: 'vpSuperAdmin', label: 'Super-admin username', description: 'LoginSuperUser' },
  { key: 'vpSuperPassword', label: 'Super-admin password', description: 'LoginSuperPass' },
  { key: 'vpUserAdmin', label: 'Operator username', description: 'Optional; not supplied by genieacs-installer' },
  { key: 'vpUserPassword', label: 'Operator password', description: 'Optional; not supplied by genieacs-installer' }
] as const

export default function Settings() {
  const [settings, setSettings] = useState({
    appName: 'SkyGenPanel',
    genieAcsUrl: 'http://127.0.0.1:7557',
    autoGenerateCustomerId: 'false',
    ...INSTALLER_VIRTUAL_PARAMETERS
  })
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('general')
  const [testResult, setTestResult] = useState<{success: boolean, message: string, deviceCount?: number} | null>(null)
  const [dbForm, setDbForm] = useState<DbConfigPayload>({
    client: 'mysql2', host: 'localhost', port: 3306, user: '', password: '', database: '', migrateData: true
  })
  const [activeDb, setActiveDb] = useState<{ client: string; host?: string; database?: string } | null>(null)
  const [dbTesting, setDbTesting] = useState(false)
  const [dbSwitching, setDbSwitching] = useState(false)

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

  useEffect(() => {
    if (activeTab !== 'database') return
    let cancelled = false
    ;(async () => {
      const res = await databaseAPI.getConfig()
      if (!cancelled && res.success && res.data) {
        setActiveDb(res.data as any)
      }
    })()
    return () => { cancelled = true }
  }, [activeTab])

  const handleDbTest = async () => {
    setDbTesting(true)
    try {
      const res = await databaseAPI.test(dbForm)
      setNotification({ success: res.success, message: res.message || (res.success ? 'Connection successful' : 'Connection failed') })
    } catch (e: any) {
      setNotification({ success: false, message: e?.message || 'Test failed' })
    } finally {
      setDbTesting(false)
      setTimeout(() => setNotification(null), 4000)
    }
  }

  const handleDbSwitch = async () => {
    const label = dbForm.client === 'sqlite3' ? 'SQLite (local file)' : `MySQL ${dbForm.database}@${dbForm.host}`
    if (!confirm(`Switch database to ${label}?\n\n${dbForm.migrateData ? 'Existing data WILL be copied to the new database.' : 'The target database will be used without copying existing data.'}\n\nThe change takes effect immediately.`)) return
    setDbSwitching(true)
    try {
      const res = await databaseAPI.switch(dbForm)
      setNotification({ success: res.success, message: res.message || (res.success ? 'Database switched' : 'Switch failed') })
      if (res.success && res.data) setActiveDb(res.data as any)
    } catch (e: any) {
      setNotification({ success: false, message: e?.message || 'Switch failed' })
    } finally {
      setDbSwitching(false)
      setTimeout(() => setNotification(null), 6000)
    }
  }

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
      toast.success('Password updated. Sign in again with the new password.')
      setPasswordForm({ currentPassword: '', newPassword: '', confirmNewPassword: '' })
      apiClient.clearTokens()
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
    const vendor = vendorList.find((item) => item.id === id)
    if (!confirm(`Delete vendor profile "${vendor?.name || id}"?\n\nDevices will no longer use this profile for parameter discovery. This cannot be undone.`)) return
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

  const [wifiConfigs, setWifiConfigs] = useState<WifiSecurityConfigType[]>([])
  const [wifiConfigLoading, setWifiConfigLoading] = useState(false)
  const [creatingConfig, setCreatingConfig] = useState(false)
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
    const config = wifiConfigs.find((item) => item.id === id)
    if (!confirm(`Delete WiFi mapping for "${config?.product_class || id}"?\n\nPassword and security parameters for this product class will no longer be resolved. This cannot be undone.`)) return
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
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <p className="page-kicker">System administration</p>
            <h1 className="page-title">Panel configuration</h1>
            <p className="page-description">Kelola koneksi GenieACS, jalur parameter vendor, akun administrator, dan penyimpanan data panel.</p>
          </div>
        </header>

        <div className="mb-6">
          <div className="tab-rail" role="tablist" aria-label="Configuration sections">
            <button
              onClick={() => setActiveTab('general')}
              className="tab-button"
              data-active={activeTab === 'general'}
              role="tab"
              aria-selected={activeTab === 'general'}
            >
              Panel & ACS
            </button>
            <button
              onClick={() => setActiveTab('virtual-params')}
              className="tab-button"
              data-active={activeTab === 'virtual-params'}
              role="tab"
              aria-selected={activeTab === 'virtual-params'}
            >
              TR-069 parameters
            </button>
            <button
              onClick={() => setActiveTab('customer-portal')}
              className="tab-button"
              data-active={activeTab === 'customer-portal'}
              role="tab"
              aria-selected={activeTab === 'customer-portal'}
            >
              Customer portal
            </button>
            <button
              onClick={() => setActiveTab('security')}
              className="tab-button"
              data-active={activeTab === 'security'}
              role="tab"
              aria-selected={activeTab === 'security'}
            >
              Account access
            </button>
            <button
              onClick={() => setActiveTab('vendors')}
              className="tab-button"
              data-active={activeTab === 'vendors'}
              role="tab"
              aria-selected={activeTab === 'vendors'}
            >
              Vendor profiles
            </button>
            <button
              onClick={() => setActiveTab('wifi-security')}
              className="tab-button"
              data-active={activeTab === 'wifi-security'}
              role="tab"
              aria-selected={activeTab === 'wifi-security'}
            >
              WiFi mappings
            </button>
            <button
              onClick={() => setActiveTab('database')}
              className="tab-button"
              data-active={activeTab === 'database'}
              role="tab"
              aria-selected={activeTab === 'database'}
            >
              Data store
            </button>
          </div>
        </div>

        {/* Content */}
        {activeTab === 'general' && (
          <div className="space-y-6">
            {/* App Settings */}
            <div className="modern-card max-w-3xl p-5 sm:p-6">
              <h2 className="section-heading">Panel identity and ACS endpoint</h2>
              <p className="section-description mb-6">Nama tampil panel dan alamat northbound API GenieACS.</p>
              <div className="space-y-4">
                <div>
                  <label htmlFor="application-name" className="field-label">Application name</label>
                  <input
                    id="application-name"
                    type="text"
                    value={settings.appName}
                    onChange={(e) => setSettings({...settings, appName: e.target.value})}
                    className="modern-input w-full"
                  />
                </div>
                <div>
                  <label htmlFor="genieacs-url" className="field-label">GenieACS URL</label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id="genieacs-url"
                    type="url"
                    placeholder="http://127.0.0.1:7557"
                    value={settings.genieAcsUrl}
                    onChange={(e) => setSettings({...settings, genieAcsUrl: e.target.value})}
                    className="modern-input flex-1"
                    />
                    <button
                      onClick={handleTestConnection}
                      disabled={loading}
                      className="modern-button"
                    >
                      {loading ? 'Testing…' : 'Test connection'}
                    </button>
                  </div>
                  <p className="field-hint">Masukkan base URL northbound API (NBI), biasanya port 7557. Path <code>/devices</code> ditambahkan otomatis.</p>
                </div>
              </div>

              {testResult && (
                <div className={`mt-4 p-4 rounded-md ${
                  testResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800'
                }`}>
                  <div className="flex items-center">
                    <Icon name={testResult.success ? 'check' : 'x'} size={18} className="mr-2" />
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
          <div className="modern-card p-5 sm:p-6">
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="section-heading">Virtual parameter mappings</h2>
                <p className="section-description mt-1">
                  Preset ini mengikuti nama virtual parameter dari repository <span className="font-mono">skydashnet/genieacs-installer</span>.
                </p>
              </div>
              <button
                type="button"
                className="modern-button-secondary shrink-0"
                onClick={() => setSettings((current) => ({ ...current, ...INSTALLER_VIRTUAL_PARAMETERS }))}
              >
                <Icon name="refresh" size={17} />
                Use installer preset
              </button>
            </div>
            <div className="mb-6 rounded-md border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] p-4 text-sm text-foreground">
              SkyGenPanel hanya membaca mapping ini. Script virtual parameter harus sudah diimpor ke GenieACS menggunakan installer tersebut.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {VIRTUAL_PARAMETER_FIELDS.map((field) => (
                <div key={field.key}>
                  <label htmlFor={field.key} className="field-label">
                    {field.label}
                  </label>
                  <input
                    id={field.key}
                    type="text"
                    value={settings[field.key]}
                    placeholder={field.description.startsWith('Optional') ? 'Leave empty if unavailable' : undefined}
                    onChange={(e) => setSettings({...settings, [field.key]: e.target.value})}
                    className="modern-input w-full font-mono text-sm"
                  />
                  <p className="field-hint">{field.description}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'customer-portal' && (
          <div className="modern-card max-w-3xl p-5 sm:p-6">
            <p className="page-kicker">Self-service access</p>
            <h2 className="section-heading">Portal pelanggan</h2>
            <p className="section-description mb-6">
              Portal berjalan terpisah pada port <span className="font-mono font-semibold">5891</span> dan hanya menampilkan ringkasan ONT yang aman untuk pelanggan.
            </p>

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                checked={settings.autoGenerateCustomerId === 'true'}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  autoGenerateCustomerId: event.target.checked ? 'true' : 'false'
                }))}
              />
              <span>
                <span className="block font-semibold">Auto Generate ID Customer</span>
                <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                  Buat ID permanen berformat <span className="font-mono">CSG-XXXXXXX-XXXXXX</span> untuk ONT yang memiliki SoftwareVersion dan PPPoE username.
                </span>
              </span>
            </label>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-border p-4">
                <p className="metric-label">Login pelanggan</p>
                <p className="mt-2 text-sm font-semibold">ID Customer</p>
                <p className="mt-1 text-xs text-muted-foreground">Password awal: enam digit terakhir ID Customer.</p>
              </div>
              <div className="rounded-md border border-border p-4">
                <p className="metric-label">Identitas permanen</p>
                <p className="mt-2 text-sm font-semibold">SoftwareID + PPPoE</p>
                <p className="mt-1 text-xs text-muted-foreground">ID yang sudah tersimpan tidak berubah ketika proses sinkronisasi dijalankan ulang.</p>
              </div>
            </div>

            <div className="mt-5 rounded-md border border-[hsl(var(--status-warning))]/40 bg-[hsl(var(--status-warning))]/10 p-4 text-sm leading-6">
              Jika opsi dimatikan, SkyGenPanel tidak membuat ID baru. ID yang sudah ada tetap disimpan agar akses pelanggan tidak berubah.
            </div>
          </div>
        )}

        {activeTab === 'security' && (
          <div className="modern-card max-w-5xl p-5 sm:p-6">
            <h2 className="section-heading">Administrator credentials</h2>
            <p className="section-description mb-6">Perubahan berlaku pada sesi login panel, bukan kredensial perangkat atau GenieACS.</p>
            <div className="space-y-6">
              <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <h3 className="font-semibold text-foreground">Change username</h3>
                <p className="mb-4 mt-1 text-sm text-muted-foreground">Masukkan username saat ini untuk mengonfirmasi kepemilikan akun.</p>
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
                <div className="mt-4">
                  <button onClick={submitChangeUsername} className="modern-button">Update Username</button>
                </div>
              </section>

              <section className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                <h3 className="font-semibold text-foreground">Change password</h3>
                <p className="mb-4 mt-1 text-sm text-muted-foreground">Gunakan minimal 8 karakter dan password yang berbeda dari akun ONT.</p>
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
                <div className="mt-4">
                  <button onClick={submitChangePassword} className="modern-button">Update Password</button>
                </div>
              </section>
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
                <div className="mb-6 p-4 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
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
                                aria-label="Edit"
                              >
                                <Icon name="edit" size={18} />
                              </button>
                              <button
                                onClick={() => deleteVendor(v.id)}
                                className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                                title="Delete"
                                aria-label="Delete"
                              >
                                <Icon name="trash" size={18} />
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
                <div className="mb-6 p-4 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
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

        {activeTab === 'database' && (
          <div className="modern-card p-6 max-w-2xl">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Database</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Active: <span className="font-mono font-semibold">
                {activeDb ? (activeDb.client === 'mysql2' ? `MySQL (${activeDb.database}@${activeDb.host})` : 'SQLite (local file)') : '...'}
              </span>
            </p>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
              <select
                value={dbForm.client}
                onChange={(e) => setDbForm({ ...dbForm, client: e.target.value as DbConfigPayload['client'] })}
                className="modern-input w-full"
              >
                <option value="mysql2">MySQL / MariaDB</option>
                <option value="sqlite3">SQLite (local file)</option>
              </select>
            </div>

            {dbForm.client === 'mysql2' && (
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Host</label>
                  <input className="modern-input w-full" value={dbForm.host || ''}
                    onChange={(e) => setDbForm({ ...dbForm, host: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Port</label>
                  <input type="number" className="modern-input w-full" value={dbForm.port || 3306}
                    onChange={(e) => setDbForm({ ...dbForm, port: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">User</label>
                  <input className="modern-input w-full" value={dbForm.user || ''}
                    onChange={(e) => setDbForm({ ...dbForm, user: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                  <input type="password" className="modern-input w-full" value={dbForm.password || ''}
                    onChange={(e) => setDbForm({ ...dbForm, password: e.target.value })} />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Database</label>
                  <input className="modern-input w-full" value={dbForm.database || ''}
                    onChange={(e) => setDbForm({ ...dbForm, database: e.target.value })} />
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 mb-6 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={Boolean(dbForm.migrateData)}
                onChange={(e) => setDbForm({ ...dbForm, migrateData: e.target.checked })} />
              Copy existing data to the new database
            </label>

            <div className="flex gap-3">
              <button onClick={handleDbTest} disabled={dbTesting} className="modern-button-secondary">
                {dbTesting ? 'Testing...' : 'Test Connection'}
              </button>
              <button onClick={handleDbSwitch} disabled={dbSwitching} className="modern-button">
                {dbSwitching ? 'Switching...' : 'Switch Database'}
              </button>
            </div>

            <p className="text-xs text-gray-400 mt-4">
              After switching, restart the service (skygenpanel restart) for the change to take effect.
            </p>
          </div>
        )}

        {/* Notification */}
        {notification && (
          <div className={`fixed top-4 right-4 z-50 p-4 rounded-md shadow-lg transition-all duration-300 ${
            notification.success
              ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800'
          }`}>
            <div className="flex items-center">
              <Icon name={notification.success ? 'check' : 'x'} size={18} className="mr-2" />
              <span className="font-medium">{notification.message}</span>
            </div>
          </div>
        )}

        {/* Save Button */}
        {(activeTab === 'general' || activeTab === 'virtual-params' || activeTab === 'customer-portal') && (
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
