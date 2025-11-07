'use client'

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastOptions {
  id?: string
  title?: string
  message: string
  type?: ToastType
  durationMs?: number
}

interface ToastItem extends Required<Omit<ToastOptions, 'durationMs' | 'type'>> {
  type: ToastType
  durationMs: number
}

interface ToastContextValue {
  show: (opts: ToastOptions) => string
  success: (message: string, opts?: Omit<ToastOptions, 'message' | 'type'>) => string
  error: (message: string, opts?: Omit<ToastOptions, 'message' | 'type'>) => string
  info: (message: string, opts?: Omit<ToastOptions, 'message' | 'type'>) => string
  warning: (message: string, opts?: Omit<ToastOptions, 'message' | 'type'>) => string
  dismiss: (id: string) => void
  clearAll: () => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

const typeStyles: Record<ToastType, { base: string; icon: string }> = {
  success: {
    base: 'border-green-200 dark:border-green-900/40 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300',
    icon: '✅'
  },
  error: {
    base: 'border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300',
    icon: '❌'
  },
  info: {
    base: 'border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300',
    icon: 'ℹ️'
  },
  warning: {
    base: 'border-yellow-200 dark:border-yellow-900/40 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-300',
    icon: '⚠️'
  }
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timersRef = useRef<Record<string, any>>({})

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
    if (timersRef.current[id]) {
      clearTimeout(timersRef.current[id])
      delete timersRef.current[id]
    }
  }, [])

  const show = useCallback((opts: ToastOptions) => {
    const id = opts.id || genId()
    const item: ToastItem = {
      id,
      title: opts.title ?? '',
      message: opts.message,
      type: opts.type ?? 'info',
      durationMs: opts.durationMs ?? 3500
    }
    setToasts(prev => [...prev, item])

    if (item.durationMs > 0) {
      timersRef.current[id] = setTimeout(() => dismiss(id), item.durationMs)
    }

    return id
  }, [dismiss])

  const success = useCallback<ToastContextValue['success']>((message, opts) => {
    return show({ ...opts, message, type: 'success' })
  }, [show])

  const error = useCallback<ToastContextValue['error']>((message, opts) => {
    return show({ ...opts, message, type: 'error' })
  }, [show])

  const info = useCallback<ToastContextValue['info']>((message, opts) => {
    return show({ ...opts, message, type: 'info' })
  }, [show])

  const warning = useCallback<ToastContextValue['warning']>((message, opts) => {
    return show({ ...opts, message, type: 'warning' })
  }, [show])

  const clearAll = useCallback(() => {
    Object.values(timersRef.current).forEach(t => clearTimeout(t))
    timersRef.current = {}
    setToasts([])
  }, [])

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach(t => clearTimeout(t))
      timersRef.current = {}
    }
  }, [])

  const value = useMemo<ToastContextValue>(() => ({
    show, success, error, info, warning, dismiss, clearAll
  }), [show, success, error, info, warning, dismiss, clearAll])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Toast Container */ }
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 w-[90vw] max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`border rounded-lg shadow-sm px-4 py-3 flex items-start gap-3 animate-in fade-in slide-in-from-right-4 ${typeStyles[t.type].base}`}
            role="status"
            aria-live="polite"
          >
            <div className="text-lg">{typeStyles[t.type].icon}</div>
            <div className="flex-1">
              {t.title ? (
                <div className="font-semibold mb-0.5">{t.title}</div>
              ) : null}
              <div className="text-sm">{t.message}</div>
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="text-sm opacity-70 hover:opacity-100 transition"
              aria-label="Dismiss"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider')
  }
  return ctx
}