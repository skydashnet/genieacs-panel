'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from '@/contexts/theme-context'
import { useAuth } from '@/contexts/auth-context'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'

export default function Sidebar() {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [isMobileOpen, setIsMobileOpen] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768)
      if (window.innerWidth < 768) {
        setIsCollapsed(true)
        setIsMobileOpen(false)
      }
    }

    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  const menuItems = [
    { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { href: '/devices', label: 'Devices', icon: 'devices' },
    { href: '/network-map', label: 'Network Map', icon: 'map' },
    { href: '/settings', label: 'Settings', icon: 'settings' },
  ]

  const isActive = (href: string) => pathname === href
  const hideOnRoutes = ['/login', '/setup']
  const shouldHideSidebar = hideOnRoutes.some((route) => pathname.startsWith(route))
  if (shouldHideSidebar) {
    return null
  }
  if (isMobile && isMobileOpen) {
    return (
      <div className="fixed inset-0 z-50 md:hidden">
        <div 
          className="fixed inset-0 bg-black/50" 
          onClick={() => setIsMobileOpen(false)}
        />
        <div className="fixed left-0 top-0 h-full w-64 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700">
          <SidebarContent 
            isCollapsed={false} 
            menuItems={menuItems} 
            isActive={isActive} 
            setIsMobileOpen={setIsMobileOpen}
          />
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Mobile menu button */}
      {isMobile && (
        <button
          onClick={() => setIsMobileOpen(true)}
          className="fixed top-4 left-4 z-40 p-2 bg-white dark:bg-gray-800 rounded-md shadow-md border border-gray-200 dark:border-gray-700 md:hidden"
        >
          <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      )}
      
      {/* Desktop sidebar */}
      <div className={`relative hidden md:flex md:flex-col h-screen bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 transition-all duration-300 ${isCollapsed ? 'w-16' : 'w-56'}`}>
        <SidebarContent
          isCollapsed={isCollapsed}
          menuItems={menuItems}
          isActive={isActive}
        />
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="absolute top-1/2 -right-3 z-10 w-6 h-12 flex items-center justify-center bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full shadow hover:shadow-md hover:scale-105 transform -translate-y-1/2 transition"
        >
          {isCollapsed ? (
            <svg className="w-4 h-4 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          )}
        </button>
      </div>
    </>
  )
}

function SidebarContent({
  isCollapsed,
  menuItems,
  isActive,
  setIsMobileOpen
}: {
  isCollapsed: boolean
  menuItems: { href: string; label: string; icon: string }[]
  isActive: (href: string) => boolean
  setIsMobileOpen?: (open: boolean) => void
}) {
  const themeContext = useTheme()
  const { isDarkMode = false, toggleDarkMode = () => {} } = themeContext || {}
  const { user, logout } = useAuth()
  const displayName = user?.username
  const initial = (displayName?.[0] || 'U').toUpperCase()
  const [appName, setAppName] = useState<string>(() => {
    if (typeof window === 'undefined') return 'GenieACS'
    return localStorage.getItem('appName') || 'GenieACS'
  })

  useEffect(() => {
    const handler = (e: any) => {
      const name = typeof e?.detail === 'string' ? e.detail : localStorage.getItem('appName')
      if (name) setAppName(name)
    }
    try {
      const initial = localStorage.getItem('appName')
      if (initial) setAppName(initial)
    } catch {}
    window.addEventListener('appNameChanged', handler as any)
    return () => window.removeEventListener('appNameChanged', handler as any)
  }, [])
  
  const handleLinkClick = () => {
    if (setIsMobileOpen) {
      setIsMobileOpen(false)
    }
  }

  return (
    <>
      {/* Header */}
      <div className={`flex items-center border-b border-gray-200 dark:border-gray-700 ${isCollapsed ? 'justify-center px-2 py-3' : 'px-4 py-3'}`}>
        <Link
          href="/"
          aria-label={`${appName} home`}
          title={isCollapsed ? appName : undefined}
          className="flex min-w-0 items-center gap-2.5"
        >
          <BrandMark className="h-9 w-9 shrink-0 drop-shadow-sm" />
          {!isCollapsed && (
            <span className="truncate text-base font-semibold tracking-tight text-gray-900 dark:text-gray-100">
              {appName}
            </span>
          )}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4">
        <ul className="space-y-2">
          {menuItems.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={handleLinkClick}
                className={`flex items-center space-x-2 px-2 py-1.5 rounded-md text-sm transition-colors ${
                  isActive(item.href)
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                <Icon name={item.icon} size={20} />
                {!isCollapsed && <span className="text-sm">{item.label}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-gray-200 dark:border-gray-700">

        {/* User Info + Logout */}
        {!isCollapsed ? (
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-semibold">
                {initial}
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {displayName}
                </span>
              </div>
            </div>
            <button
              onClick={logout}
              className="px-2 py-1 rounded-md text-red-600 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              Logout
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center mb-3">
            <button
              onClick={logout}
              title="Logout"
              className="p-2 rounded-md text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7" />
              </svg>
            </button>
          </div>
        )}
        
        {/* Dark Mode Toggle */}
        <button
          onClick={toggleDarkMode}
          className="w-full flex items-center justify-center space-x-2 px-2 py-1.5 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-sm"
        >
          {isDarkMode ? (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              {!isCollapsed && <span>Light Mode</span>}
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
              {!isCollapsed && <span>Dark Mode</span>}
            </>
          )}
        </button>
        {!isCollapsed && (
          <div className="text-xs text-gray-500 dark:text-gray-400 text-center mt-3">
            Copyright © SkydashNET
          </div>
        )}
      </div>
    </>
  )
}
