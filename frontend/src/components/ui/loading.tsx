'use client'

import React, { createContext, useCallback, useContext, useMemo, useState, useEffect } from 'react'
import clsx from 'clsx'
import { useLocation } from 'react-router-dom'

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
        <div className="fixed bottom-4 left-4 right-4 z-[2190] flex justify-center sm:left-auto sm:right-5" role="status" aria-live="polite">
          <div className="flex min-h-12 w-full items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-foreground shadow-lg sm:w-auto sm:min-w-64">
            <Spinner />
            <div>
              <div className="text-sm font-semibold">{message || 'Processing request'}</div>
              <div className="text-xs text-muted-foreground">You can keep reviewing this page.</div>
            </div>
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
      className={clsx('animate-spin rounded-full border-border border-t-primary', className)}
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
  return <div className={clsx('animate-pulse bg-muted', rounded, className)} style={style} />
}

/**
 * Global route change loader that shows on pathname changes.
 * Should be used inside LoadingProvider (already wrapped in layout).
 */
export function RouteChangeLoader() {
  const { pathname } = useLocation()

  useEffect(() => {
    document.documentElement.dataset.route = pathname
  }, [pathname])

  return null
}
