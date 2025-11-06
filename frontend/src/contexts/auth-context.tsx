'use client'

import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { User, LoginResponse } from '@/types'
import { authAPI } from '@/lib/api'

interface AuthContextType {
  user: User | null
  token: string | null
  login: (username: string, password: string) => Promise<boolean>
  logout: () => void
  loading: boolean
  isAuthenticated: boolean
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

interface AuthProviderProps {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const isAuthenticated = !!user && !!token

  useEffect(() => {
    // Check for existing session on mount
    const savedToken = localStorage.getItem('token')
    const savedUser = localStorage.getItem('user')
    
    if (savedToken && savedUser) {
      try {
        const parsedUser = JSON.parse(savedUser)
        setToken(savedToken)
        setUser(parsedUser)
      } catch (error) {
        console.error('Error parsing saved user:', error)
        // Clear invalid data
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        localStorage.removeItem('refreshToken')
      }
    }
  }, [])

  const login = async (username: string, password: string): Promise<boolean> => {
    setLoading(true)
    try {
      const response = await authAPI.login(username, password)
      
      if (response.success && response.data) {
        const { user: userData, token: userToken, refreshToken } = response.data as LoginResponse
        
        // Save to state and localStorage
        setUser(userData)
        setToken(userToken)
        
        localStorage.setItem('token', userToken)
        localStorage.setItem('refreshToken', refreshToken)
        localStorage.setItem('user', JSON.stringify(userData))
        
        return true
      } else {
        return false
      }
    } catch (error) {
      console.error('Login error:', error)
      return false
    } finally {
      setLoading(false)
    }
  }

  const logout = () => {
    setUser(null)
    setToken(null)
    
    // Clear localStorage
    localStorage.removeItem('token')
    localStorage.removeItem('refreshToken')
    localStorage.removeItem('user')
    
    // Redirect to login page
    router.push('/login')
  }

  const value: AuthContextType = {
    user,
    token,
    login,
    logout,
    loading,
    isAuthenticated
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}