import { useMemo, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { conversationTitle } from '@/components/whatsapp/conversation-list'
import type { WhatsAppConversation, WhatsAppMessage } from '@/lib/api'

/** Encaminhar o texto de uma mensagem para outra conversa já aberta no painel. */
export function ForwardDialog({ message, conversations, currentId, onClose, onForward }: {
  message: WhatsAppMessage
  conversations: WhatsAppConversation[]
  currentId: number | null
  onClose: () => void
  onForward: (target: WhatsAppConversation) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const [term, setTerm] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)

  const options = useMemo(() => {
    const needle = term.trim().toLowerCase()
    return conversations
      .filter((c) => c.id !== currentId)
      .filter((c) => {
        if (!needle) return true
        const hay = `${conversationTitle(c)} ${c.waPhoneE164 ?? ''} ${c.contract ?? ''}`.toLowerCase()
        return hay.includes(needle)
      })
      .slice(0, 50)
  }, [conversations, currentId, term])

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="forward-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal-panel modern-card w-full max-w-md p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="forward-title" className="text-base font-semibold">{t('whatsapp.msg.forwardTitle')}</h2>
          <button type="button" className="icon-button" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <p className="mb-3 line-clamp-3 whitespace-pre-wrap rounded border border-border bg-[hsl(var(--surface-subtle))] px-2 py-1.5 text-xs text-muted-foreground wrap-anywhere">{message.body}</p>
        <input
          type="search"
          className="modern-input mb-2"
          autoFocus
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('whatsapp.msg.forwardSearch')}
          aria-label={t('whatsapp.msg.forwardSearch')}
        />
        <ul className="max-h-72 overflow-y-auto" role="list">
          {options.length === 0 && <li className="px-2 py-4 text-center text-sm text-muted-foreground">{t('whatsapp.msg.forwardEmpty')}</li>}
          {options.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-start text-sm hover:bg-[hsl(var(--surface-subtle))] disabled:opacity-60"
                disabled={busyId !== null}
                onClick={() => {
                  setBusyId(c.id)
                  void onForward(c).then((ok) => { if (ok) onClose(); else setBusyId(null) })
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{conversationTitle(c)}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{c.waPhoneE164}</span>
                </span>
                <Icon name={busyId === c.id ? 'refresh' : 'forward'} size={16} className={busyId === c.id ? 'animate-spin' : 'text-muted-foreground'} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
