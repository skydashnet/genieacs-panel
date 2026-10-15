import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { WhatsAppMessage } from '@/lib/api'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Sem permissão da área de transferência (página sem HTTPS, iframe): o
    // caminho antigo, por um campo escondido.
    try {
      const box = document.createElement('textarea')
      box.value = text
      box.style.position = 'fixed'
      box.style.opacity = '0'
      document.body.appendChild(box)
      box.select()
      const ok = document.execCommand('copy')
      box.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** O menu "⋯" de uma mensagem: Responder, Copiar e Encaminhar. */
export function MessageMenu({ message, onReply, onForward }: {
  message: WhatsAppMessage
  onReply?: (message: WhatsAppMessage) => void
  onForward?: (message: WhatsAppMessage) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const hasText = Boolean(message.body)

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const items: Array<{ key: string; icon: 'reply' | 'copy' | 'forward'; label: string; run: () => void }> = []
  if (onReply) items.push({ key: 'reply', icon: 'reply', label: t('whatsapp.msg.reply'), run: () => onReply(message) })
  if (hasText) {
    items.push({
      key: 'copy',
      icon: 'copy',
      label: t('whatsapp.msg.copy'),
      run: () => {
        void copyText(message.body ?? '').then((ok) => {
          if (ok) toast.success(t('whatsapp.msg.copied'))
          else toast.error(t('whatsapp.msg.copyFailed'))
        })
      }
    })
  }
  if (onForward && hasText) items.push({ key: 'forward', icon: 'forward', label: t('whatsapp.msg.forward'), run: () => onForward(message) })
  if (items.length === 0) return null

  return (
    <div ref={box} className="relative shrink-0 self-start">
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-[hsl(var(--surface-subtle))] hover:text-foreground focus-visible:opacity-100 group-hover/msg:opacity-100 max-lg:opacity-100"
        aria-label={t('whatsapp.msg.menu')}
        title={t('whatsapp.msg.menu')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute z-20 mt-1 min-w-36 rounded-md border border-border bg-background py-1 shadow-lg data-[side=out]:start-0 data-[side=in]:end-0" data-side={message.direction}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-xs text-foreground hover:bg-[hsl(var(--surface-subtle))]"
              onClick={() => { setOpen(false); item.run() }}
            >
              <Icon name={item.icon} size={14} className="shrink-0 text-muted-foreground" />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
