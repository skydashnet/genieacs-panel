'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { authAPI } from '@/lib/api'
import { useRouter, usePathname } from 'next/navigation'
import type { User } from '@/types'

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  loading: boolean
  login: (username: string, password: string) => Promise<boolean>
  logout: () => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    const checkAuthStatus = async () => {
      const token = localStorage.getItem('token')
      if (token) {
        try {
          const res = await authAPI.getCurrentUser()
          if (res.success && res.data) {
            setUser(res.data as User)
            setIsAuthenticated(true)
          } else {
            localStorage.removeItem('token')
            setUser(null)
            setIsAuthenticated(false)
          }
        } catch (error) {
          console.error("Auth check failed:", error)
          localStorage.removeItem('token')
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
    if (loading) return

    const isAuthPage = pathname === '/login';

    if (!isAuthenticated && !isAuthPage) {
      router.push('/login');
    }
    
    if (isAuthenticated && isAuthPage) {
      router.push('/dashboard');
    }
  }, [isAuthenticated, loading, pathname, router])

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const res = await authAPI.login(username, password)
      if (res.success && res.data) {
        const { token, user } = res.data as { token: string; user: User };
        
        localStorage.setItem('token', token)
        
        setUser(user)
        setIsAuthenticated(true)
        
        router.push('/dashboard')
        return true
      } else {
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

  const logout = () => {
    localStorage.removeItem('token')
    setUser(null)
    setIsAuthenticated(false)
    router.push('/login')
  }
  
  const value = { user, isAuthenticated, loading, login, logout }
  
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