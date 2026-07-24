import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { BrandMark } from '@/components/brand-mark'
import { Icon } from '@/components/ui/icon'
import release from '@/generated/release.json'

const CATEGORY_STYLE: Record<string, { icon: string; className: string }> = {
  Breaking: { icon: 'warning', className: 'modern-badge-error' },
  New: { icon: 'check', className: 'modern-badge-success' },
  Improved: { icon: 'chart', className: 'modern-badge-info' },
  Fixed: { icon: 'check', className: 'modern-badge-warning' },
  Changed: { icon: 'refresh', className: 'modern-badge-info' },
  Security: { icon: 'lock', className: 'modern-badge-error' },
  Maintenance: { icon: 'settings', className: 'modern-badge' },
}

export const APP_RELEASE = release

export function ReleaseNotesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose, open])

  if (!open) return null

  const releaseDate = new Date(`${release.releasedAt}T00:00:00`)
  const formattedDate = releaseDate.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  })

  return createPortal(
    <div className="fixed inset-0 z-[3000] flex items-end justify-center bg-[#07100c]/75 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      role="dialog" aria-modal="true" aria-labelledby="release-notes-title">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="Close release notes" />
      <section className="modern-card relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-b-none shadow-2xl sm:rounded-[var(--radius)]">
        <header className="relative overflow-hidden border-b border-border bg-[#173f35] px-5 py-6 text-[#f4f3ed] sm:px-7">
          <div className="absolute -right-16 -top-24 size-64 rounded-full border-[42px] border-white/5" aria-hidden="true" />
          <div className="relative flex items-start justify-between gap-5">
            <div className="flex min-w-0 items-start gap-4">
              <BrandMark className="size-11 shrink-0" />
              <div className="min-w-0">
                <p className="text-[0.66rem] font-bold uppercase tracking-[0.16em] text-[#aebfb6]">Latest release</p>
                <h2 id="release-notes-title" className="mt-1 text-xl font-bold tracking-tight text-white">What’s new in SkyGenPanel</h2>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#c8d5cf]">
                  <span className="rounded bg-white/12 px-2 py-1 font-mono font-semibold text-white">v{release.version}</span>
                  <span>{formattedDate}</span>
                </div>
              </div>
            </div>
            <button ref={closeButtonRef} type="button" onClick={onClose}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-[#cad5cf] transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Close release notes">
              <Icon name="x" size={21} />
            </button>
          </div>
        </header>

        <div className="overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          <div className="mb-5">
            <h3 className="section-heading">Release highlights</h3>
            <p className="section-description">Generated from the Git commits included since {release.basedOnTag}.</p>
          </div>
          <ol className="space-y-3">
            {release.changes.map((change) => {
              const style = CATEGORY_STYLE[change.category] || CATEGORY_STYLE.Maintenance
              return (
                <li key={`${change.shortHash}-${change.title}`} className="rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-card text-primary">
                      <Icon name={style.icon} size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={style.className}>{change.category}</span>
                        <span className="font-mono text-[0.68rem] text-muted-foreground">{change.shortHash}</span>
                      </div>
                      <p className="mt-2 text-sm font-semibold leading-6 text-foreground">{change.title}</p>
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>

        <footer className="flex flex-col gap-3 border-t border-border bg-[hsl(var(--surface-subtle))] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Build <strong className="font-mono text-foreground">#{release.build}</strong></span>
            <span>Source <strong className="font-mono text-foreground">{release.sourceCommit}</strong></span>
          </div>
          <a href={release.compareUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-primary hover:underline">
            View Git history <Icon name="external" size={16} />
          </a>
        </footer>
      </section>
    </div>,
    document.body
  )
}
