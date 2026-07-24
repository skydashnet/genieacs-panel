'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { apiClient, authAPI } from '@/lib/api'
import { useRouter, usePathname } from 'next/navigation'
import type { User } from '@/types'

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  loading: boolean
  needsSetup: boolean
  login: (username: string, password: string) => Promise<boolean>
  completeSetup: (username: string, password: string) => Promise<boolean>
  logout: () => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [needsSetup, setNeedsSetup] = useState(false)
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        const setupRes = await authAPI.getSetupStatus()
        if (setupRes.success && (setupRes.data as any)?.needsSetup) {
          setNeedsSetup(true)
          setUser(null)
          setIsAuthenticated(false)
          setLoading(false)
          return
        }
      } catch (error) {
        console.error("Setup status check failed:", error)
      }

      setNeedsSetup(false)
      const token = localStorage.getItem('token')
      if (token) {
        try {
          const res = await authAPI.getCurrentUser()
          if (res.success && res.data) {
            setUser(res.data as User)
            setIsAuthenticated(true)
          } else {
            apiClient.clearTokens()
            setUser(null)
            setIsAuthenticated(false)
          }
        } catch (error) {
          console.error("Auth check failed:", error)
          apiClient.clearTokens()
          setUser(null)
          setIsAuthenticated(false)
        }
      } else {
        setUser(null)
        setIsAuthenticated(false)
      }
      setLoading(false)
    }
    checkAuthStatus()
  }, [])

  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null)
      setIsAuthenticated(false)
      if (!needsSetup) {
        router.push('/login')
      }
    }
    window.addEventListener('auth:unauthorized', handleUnauthorized)
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized)
  }, [needsSetup, router])

  useEffect(() => {
    if (loading) return

    const isSetupPage = pathname === '/setup'
    const isAuthPage = pathname === '/login'

    if (needsSetup) {
      if (!isSetupPage) router.push('/setup')
      return
    }

    if (isSetupPage) {
      router.push(isAuthenticated ? '/dashboard' : '/login')
      return
    }

    if (!isAuthenticated && !isAuthPage) {
      router.push('/login');
    }
    
    if (isAuthenticated && isAuthPage) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, needsSetup, loading, pathname, router])

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const res = await authAPI.login(username, password)
      if (res.success && res.data) {
        const { token, refreshToken, user } = res.data as {
          token: string
          refreshToken: string
          user: User
        }
        apiClient.setTokens(token, refreshToken)
        
        setUser(user)
        setIsAuthenticated(true)
        
        router.push('/dashboard')
        return true
      } else {
        apiClient.clearTokens()
        setIsAuthenticated(false)
        setUser(null)
        return false
      }
    } catch (error) {
      console.error("Login failed:", error)
      setIsAuthenticated(false)
      setUser(null)
      return false
    }
  }

  const completeSetup = async (username: string, password: string): Promise<boolean> => {
    try {
      const res = await authAPI.setupAdmin(username, password)
      if (res.success && res.data) {
        const { token, refreshToken, user } = res.data as {
          token: string
          refreshToken: string
          user: User
        }
        apiClient.setTokens(token, refreshToken)
        setUser(user)
        setIsAuthenticated(true)
        setNeedsSetup(false)
        router.push('/dashboard')
        return true
      }
      return false
    } catch (error) {
      console.error("Setup failed:", error)
      return false
    }
  }

  const logout = () => {
    void authAPI.logout()
    apiClient.clearTokens()
    setUser(null)
    setIsAuthenticated(false)
    router.push('/login')
  }
  
  const value = { user, isAuthenticated, loading, needsSetup, login, completeSetup, logout }
  
  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
