'use client'

import React, { createContext, useCallback, useContext, useMemo, useState, useEffect } from 'react'
import clsx from 'clsx'
import { usePathname } from 'next/navigation'

type LoadingContextType = {
  visible: boolean
  message?: string
  show: (message?: string) => void
  hide: () => void
}

const LoadingContext = createContext<LoadingContextType | null>(null)

export function LoadingProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  const show = useCallback((msg?: string) => {
    setMessage(msg)
    setVisible(true)
  }, [])

  const hide = useCallback(() => {
    setVisible(false)
    setMessage(undefined)
  }, [])

  const value = useMemo<LoadingContextType>(() => ({ visible, message, show, hide }), [visible, message, show, hide])

  return (
    <LoadingContext.Provider value={value}>
      {children}
      {visible && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40">
          <div className="flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 shadow-lg">
            <Spinner />
            <div className="text-sm text-gray-700 dark:text-gray-300">{message || 'Loading...'}</div>
          </div>
        </div>
      )}
    </LoadingContext.Provider>
  )
}

export function useLoading() {
  const ctx = useContext(LoadingContext)
  if (!ctx) {
    throw new Error('useLoading must be used within LoadingProvider')
  }
  return ctx
}

type SpinnerProps = {
  className?: string
  size?: number
}

export function Spinner({ className, size = 24 }: SpinnerProps) {
  const style: React.CSSProperties = { width: size, height: size, borderWidth: Math.max(2, Math.floor(size / 6)) }
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx('rounded-full border-gray-200 dark:border-gray-700 border-t-blue-600 animate-spin', className)}
      style={style}
    />
  )
}

type SkeletonProps = {
  className?: string
  width?: number | string
  height?: number | string
  rounded?: string
}

export function Skeleton({ className, width = '100%', height = 12, rounded = 'rounded-md' }: SkeletonProps) {
  const style: React.CSSProperties = { width, height }
  return <div className={clsx('bg-gray-200 dark:bg-gray-700 animate-pulse', rounded, className)} style={style} />
}

/**
 * Global route change loader that shows on pathname changes.
 * Should be used inside LoadingProvider (already wrapped in layout).
 */
export function RouteChangeLoader() {
  const pathname = usePathname()
  const { show, hide } = useLoading()

  useEffect(() => {
    let cancelled = false
    show('Loading...')
    const t = setTimeout(() => {
      if (!cancelled) hide()
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
      hide()
    }
  }, [pathname, show, hide])

  return null
}