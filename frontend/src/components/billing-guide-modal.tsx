import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { HelpDocument } from '@/components/help-document'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { PROVIDER_BILLING_GUIDE } from '@/lib/help-docs'

/**
 * O "Como funciona" da tela de Plano: o guia curto do provedor
 * (`docs/guia-provedor-cobranca.md`) numa janela por cima da tela.
 *
 * Janela e não página porque quem abre está no meio de uma decisão — trocar
 * de ciclo, aplicar cupom, cancelar — e fechar o guia deve devolvê-lo ao
 * mesmo lugar da tela. Esc e o fundo fecham, como as outras janelas do painel.
 */
export function BillingGuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const titleId = useId()
  const fechar = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const overflowAntes = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    fechar.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflowAntes
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label={t('common.close')} tabIndex={-1} />
      <section className="modern-card relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden sm:max-h-[calc(100dvh-2rem)]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border p-5">
          <h2 id={titleId} className="text-lg font-semibold text-foreground">{t('help.providerGuideTitle')}</h2>
          <button
            ref={fechar}
            type="button"
            onClick={onClose}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('common.close')}
          >
            <Icon name="x" size={20} />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-5">
          <HelpDocument source={PROVIDER_BILLING_GUIDE} layout="modal" />
        </div>
      </section>
    </div>,
    document.body
  )
}

export default BillingGuideModal
