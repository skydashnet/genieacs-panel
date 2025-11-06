'use client'

import { useState, useEffect } from 'react'

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
    // Simulate loading settings from API
    const timer = setTimeout(() => {
      setTestResult(null)
    }, 500)
    return () => clearTimeout(timer)
  }, [])

  const handleTestConnection = async () => {
    setLoading(true)
    // Simulate API call
    setTimeout(() => {
      setTestResult({
        success: true,
        message: 'Connection successful!',
        deviceCount: 1247
      })
      setLoading(false)
    }, 2000)
  }

  const [notification, setNotification] = useState<{success: boolean, message: string} | null>(null)

  const handleSaveSettings = async () => {
    setLoading(true)
    // Simulate API call
    setTimeout(() => {
      setNotification({
        success: true,
        message: 'Settings saved successfully!'
      })
      setLoading(false)
      // Auto-hide notification after 3 seconds
      setTimeout(() => setNotification(null), 3000)
    }, 1500)
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
          <div className="flex space-x-1 border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={() => setActiveTab('general')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'general'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              General
            </button>
            <button
              onClick={() => setActiveTab('virtual-params')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'virtual-params'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Virtual Parameters
            </button>
            <button
              onClick={() => setActiveTab('security')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'security'
                  ? 'border-b-2 border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Security
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
        <div className="flex justify-end mt-8">
          <button
            onClick={handleSaveSettings}
            disabled={loading}
            className="modern-button"
          >
            {loading ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  )
}