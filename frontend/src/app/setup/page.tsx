'use client'

import { useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'

export default function Setup() {
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    confirmPassword: ''
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { completeSetup } = useAuth()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (formData.username.length < 3) {
      setError('Username must be at least 3 characters')
      return
    }
    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)
    try {
      const ok = await completeSetup(formData.username, formData.password)
      if (!ok) {
        setError('Failed to create admin account')
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value })
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <BrandMark className="mx-auto h-14 w-14 drop-shadow-lg" title="SkyGenPanel" />
          <h2 className="mt-6 text-center text-3xl font-bold text-gray-900 dark:text-gray-100">
            Welcome to GenieACS Panel
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
            Create your administrator account to get started
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          {error && (
            <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4">
              <div className="flex items-center">
                <Icon name="warning" size={20} className="text-red-500 mr-2" />
                <span className="text-sm text-red-700 dark:text-red-400">{error}</span>
              </div>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Username
              </label>
              <input
                id="username"
                name="username"
                type="text"
                required
                value={formData.username}
                onChange={handleChange}
                className="modern-input mt-1"
                placeholder="Choose an admin username"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                value={formData.password}
                onChange={handleChange}
                className="modern-input mt-1"
                placeholder="At least 8 characters"
              />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Confirm Password
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                required
                value={formData.confirmPassword}
                onChange={handleChange}
                className="modern-input mt-1"
                placeholder="Re-enter your password"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="modern-button w-full justify-center"
          >
            {loading ? 'Creating account...' : 'Create Admin Account'}
          </button>
        </form>
      </div>
    </div>
  )
}
