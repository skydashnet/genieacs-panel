'use client'

import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '@/contexts/theme-context'
import { useAuth } from '@/contexts/auth-context'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'
import { APP_RELEASE, ReleaseNotesModal } from '@/components/release-notes-modal'

const menuItems = [
  { href: '/dashboard', label: 'Operations', description: 'Fleet health', icon: 'dashboard' },
  { href: '/devices', label: 'Device Inventory', description: 'ONT and CPE', icon: 'devices' },
  { href: '/network-map', label: 'Network Topology', description: 'Physical nodes', icon: 'map' },
  { href: '/settings', label: 'Configuration', description: 'ACS and vendors', icon: 'settings' },
]

export default function Sidebar() {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isMobileOpen, setIsMobileOpen] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => {
    setIsMobileOpen(false)
  }, [pathname])

  const hideOnRoutes = ['/login', '/setup']
  if (hideOnRoutes.some((route) => pathname.startsWith(route))) return null

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-[1200] flex h-16 items-center justify-between border-b border-border bg-card px-4 md:hidden">
        <Link to="/dashboard" className="flex min-w-0 items-center gap-2.5" aria-label="SkyGenPanel operations">
          <BrandMark className="size-8 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-sm font-bold leading-tight">SkyGenPanel</div>
            <div className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">ACS operations</div>
          </div>
        </Link>
        <button
          type="button"
          onClick={() => setIsMobileOpen(true)}
          className="icon-button"
          aria-label="Open navigation"
          aria-expanded={isMobileOpen}
        >
          <Icon name="menu" size={23} />
        </button>
      </header>

      {isMobileOpen && (
        <div className="fixed inset-0 z-[2000] md:hidden" role="dialog" aria-modal="true" aria-label="Main navigation">
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            onClick={() => setIsMobileOpen(false)}
            aria-label="Close navigation"
          />
          <aside className="relative flex h-full w-[min(86vw,19rem)] flex-col bg-[#18211d] text-[#f4f3ed] shadow-2xl">
            <SidebarContent isCollapsed={false} isActive={isActive} closeMobile={() => setIsMobileOpen(false)} />
          </aside>
        </div>
      )}

      <aside
        className={`sticky top-0 z-[1000] hidden h-screen max-h-screen shrink-0 self-start flex-col overflow-visible bg-[#18211d] text-[#f4f3ed] transition-[width] duration-200 md:flex ${
          isCollapsed ? 'w-[4.75rem]' : 'w-[16.5rem]'
        }`}
      >
        <SidebarContent isCollapsed={isCollapsed} isActive={isActive} />
        <button
          type="button"
          onClick={() => setIsCollapsed((value) => !value)}
          aria-label={isCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          className="absolute -right-3 top-[5.1rem] z-10 flex size-7 items-center justify-center rounded-full border border-[#3a4942] bg-[#202c27] text-[#cad3ce] shadow-sm transition-colors hover:bg-[#2b3933] hover:text-white"
        >
          <Icon name={isCollapsed ? 'chevron-right' : 'chevron-left'} size={15} />
        </button>
      </aside>
    </>
  )
}

function SidebarContent({
  isCollapsed,
  isActive,
  closeMobile,
}: {
  isCollapsed: boolean
  isActive: (href: string) => boolean
  closeMobile?: () => void
}) {
  const { isDarkMode, toggleDarkMode } = useTheme()
  const { user, logout } = useAuth()
  const displayName = user?.username || 'Operator'
  const initial = displayName.slice(0, 1).toUpperCase()
  const [appName, setAppName] = useState('SkyGenPanel')
  const [showReleaseNotes, setShowReleaseNotes] = useState(false)

  useEffect(() => {
    const syncName = (event?: Event) => {
      const detail = (event as CustomEvent<string> | undefined)?.detail
      setAppName(detail || localStorage.getItem('appName') || 'SkyGenPanel')
    }
    syncName()
    window.addEventListener('appNameChanged', syncName)
    return () => window.removeEventListener('appNameChanged', syncName)
  }, [])

  return (
    <>
      <div className={`flex h-[4.75rem] items-center border-b border-white/10 ${isCollapsed ? 'justify-center px-2' : 'px-4'}`}>
        <Link to="/dashboard" onClick={closeMobile} className="flex min-w-0 items-center gap-3" title={isCollapsed ? appName : undefined}>
          <BrandMark className="size-10 shrink-0" />
          {!isCollapsed && (
            <div className="min-w-0">
              <div className="truncate text-[0.95rem] font-bold leading-tight text-white">{appName}</div>
              <div className="mt-0.5 text-[0.63rem] font-bold uppercase tracking-[0.14em] text-[#9aa9a2]">ACS operations</div>
            </div>
          )}
        </Link>
      </div>

      <nav className={`min-h-0 flex-1 overflow-y-auto py-5 ${isCollapsed ? 'px-2.5' : 'px-3'}`} aria-label="Primary">
        {!isCollapsed && <div className="mb-2 px-3 text-[0.62rem] font-bold uppercase tracking-[0.16em] text-[#829188]">Monitor & manage</div>}
        <ul className="space-y-1">
          {menuItems.map((item) => {
            const active = isActive(item.href)
            return (
              <li key={item.href}>
                <Link
                  to={item.href}
                  onClick={closeMobile}
                  title={isCollapsed ? item.label : undefined}
                  aria-current={active ? 'page' : undefined}
                  className={`group flex min-h-12 items-center rounded-md transition-colors ${
                    isCollapsed ? 'justify-center px-2' : 'gap-3 px-3'
                  } ${
                    active
                      ? 'bg-[#eef0e8] text-[#173f35]'
                      : 'text-[#c9d2cd] hover:bg-white/7 hover:text-white'
                  }`}
                >
                  <Icon name={item.icon} size={20} className="shrink-0" />
                  {!isCollapsed && (
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold leading-tight">{item.label}</span>
                      <span className={`mt-0.5 block truncate text-[0.68rem] ${active ? 'text-[#52665d]' : 'text-[#839189]'}`}>
                        {item.description}
                      </span>
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className={`border-t border-white/10 ${isCollapsed ? 'p-2.5' : 'p-3'}`}>
        <button
          type="button"
          onClick={() => setShowReleaseNotes(true)}
          className={`mb-2 flex min-h-11 w-full items-center rounded-md text-[#aab8b0] transition-colors hover:bg-white/8 hover:text-white ${
            isCollapsed ? 'justify-center px-1' : 'justify-between gap-3 px-2.5'
          }`}
          aria-label={`Open release notes for SkyGenPanel version ${APP_RELEASE.version}`}
          title={isCollapsed ? `Version ${APP_RELEASE.version} · What’s new` : undefined}
        >
          {isCollapsed ? (
            <span className="font-mono text-[0.62rem] font-bold">v{APP_RELEASE.version.split('.').slice(0, 2).join('.')}</span>
          ) : (
            <>
              <span className="flex items-center gap-2 text-xs font-semibold"><Icon name="info" size={17} />What’s new</span>
              <span className="rounded bg-white/8 px-2 py-1 font-mono text-[0.65rem] font-bold text-[#d7dfda]">v{APP_RELEASE.version}</span>
            </>
          )}
        </button>
        <div className={`mb-2 flex items-center ${isCollapsed ? 'justify-center' : 'gap-3 px-2 py-2'}`}>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#d97706] text-sm font-bold text-[#1f251f]">
            {initial}
          </div>
          {!isCollapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-white">{displayName}</div>
              <div className="text-[0.68rem] text-[#91a098]">Administrator</div>
            </div>
          )}
        </div>
        <div className={`grid gap-1 ${isCollapsed ? 'grid-cols-1' : 'grid-cols-2'}`}>
          <button
            type="button"
            onClick={toggleDarkMode}
            className={`flex min-h-11 items-center justify-center rounded-md text-[#bdc8c2] transition-colors hover:bg-white/8 hover:text-white ${isCollapsed ? '' : 'gap-2 px-2 text-xs font-semibold'}`}
            aria-label={isDarkMode ? 'Use light theme' : 'Use dark theme'}
            title={isCollapsed ? (isDarkMode ? 'Light theme' : 'Dark theme') : undefined}
          >
            <Icon name={isDarkMode ? 'sun' : 'moon'} size={18} />
            {!isCollapsed && <span>{isDarkMode ? 'Light' : 'Dark'}</span>}
          </button>
          <button
            type="button"
            onClick={logout}
            className={`flex min-h-11 items-center justify-center rounded-md text-[#e8afa8] transition-colors hover:bg-[#9e3930]/25 hover:text-[#ffd8d3] ${isCollapsed ? '' : 'gap-2 px-2 text-xs font-semibold'}`}
            aria-label="Sign out"
            title={isCollapsed ? 'Sign out' : undefined}
          >
            <Icon name="logout" size={18} />
            {!isCollapsed && <span>Sign out</span>}
          </button>
        </div>
      </div>
      <ReleaseNotesModal open={showReleaseNotes} onClose={() => setShowReleaseNotes(false)} />
    </>
  )
}
