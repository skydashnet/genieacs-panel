'use client'

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './icon'

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
    base: 'border-[hsl(var(--status-success)/.3)] bg-[hsl(var(--status-success)/.08)] text-[hsl(var(--status-success))]',
    icon: 'check'
  },
  error: {
    base: 'border-[hsl(var(--status-danger)/.3)] bg-[hsl(var(--status-danger)/.08)] text-[hsl(var(--status-danger))]',
    icon: 'x'
  },
  info: {
    base: 'border-[hsl(var(--status-info)/.3)] bg-[hsl(var(--status-info)/.08)] text-[hsl(var(--status-info))]',
    icon: 'info'
  },
  warning: {
    base: 'border-[hsl(var(--status-warning)/.3)] bg-[hsl(var(--status-warning)/.08)] text-[hsl(var(--status-warning))]',
    icon: 'warning'
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
      <div className="fixed left-4 right-4 top-20 z-[2200] flex flex-col gap-2 sm:left-auto sm:right-5 sm:top-5 sm:w-[24rem]">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex min-h-14 items-start gap-3 rounded-md border px-4 py-3 shadow-lg animate-in fade-in slide-in-from-right-4 ${typeStyles[t.type].base}`}
            role={t.type === 'error' ? 'alert' : 'status'}
            aria-live={t.type === 'error' ? 'assertive' : 'polite'}
          >
            <Icon name={typeStyles[t.type].icon} size={19} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              {t.title ? (
                <div className="font-semibold mb-0.5">{t.title}</div>
              ) : null}
              <div className="text-sm">{t.message}</div>
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="flex size-8 shrink-0 items-center justify-center rounded text-current opacity-70 transition hover:bg-black/5 hover:opacity-100"
              aria-label="Dismiss notification"
            >
              <Icon name="x" size={16} />
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
