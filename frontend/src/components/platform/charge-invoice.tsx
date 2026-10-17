'use client'

import { useState } from 'react'
import { platformAPI, type InvoiceConsoleView, type TenantInvoiceView } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { invoiceBadgeClass, invoiceStatusKey, safeInvoiceUrl } from '@/lib/invoice'

/**
 * A NFS-e de uma cobrança, como uma célula "Nota": o estado, o número e o
 * PDF quando emitida — e, no console, o erro, que é o que diz por que ela não
 * saiu. Uma peça só para a aba Assinaturas, o Extrato e a tela do provedor.
 */
export function InvoiceSummary({ invoice }: { invoice: TenantInvoiceView | InvoiceConsoleView | null | undefined }) {
  const { t } = useTranslation()
  if (!invoice) return <span className="text-xs text-muted-foreground">{t('nfse.none')}</span>
  const chave = invoiceStatusKey(invoice.status)
  const erro = 'error' in invoice ? invoice.error : null
  const pdf = safeInvoiceUrl(invoice.pdfUrl)
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={invoiceBadgeClass(invoice.status)} title={erro ?? undefined}>
        {chave ? t(chave) : invoice.status}
      </span>
      {invoice.number && (
        <span className="font-mono text-xs text-muted-foreground">{t('nfse.number', { number: invoice.number })}</span>
      )}
      {pdf && (
        /* Endereço de terceiro: `noopener`, pelo motivo de sempre. */
        <a
          href={pdf}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <Icon name="document" size={14} />
          {t('nfse.pdf')}
        </a>
      )}
      {erro && invoice.status !== 'authorized' && (
        <span className="text-xs text-destructive wrap-anywhere">{t('nfse.error', { error: erro })}</span>
      )}
    </span>
  )
}

/**
 * "Emitir nota" — só põe na fila; quem fala com a Asaas é o agendador. A
 * recusa do backend (nota desligada, cobrança não paga, nota viva) vem com a
 * mensagem dele, que é a que diz o que fazer.
 */
export function IssueInvoiceButton({
  tenantId,
  chargeId,
  reissue = false,
  onDone
}: {
  tenantId: number
  chargeId: number
  reissue?: boolean
  onDone: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const emitir = async () => {
    setBusy(true)
    try {
      const res = await platformAPI.issueChargeInvoice(tenantId, chargeId)
      if (res.success) {
        toast.success(t('nfse.queued'))
        await onDone()
      } else {
        toast.error(res.message || t('nfse.issueFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => void emitir()}>
      <Icon name="invoice" size={16} />
      {t(reissue ? 'nfse.reissue' : 'nfse.issue')}
    </button>
  )
}
