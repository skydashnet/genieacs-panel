'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BILLING_BADGE, BILLING_BORDER, billingLabel, invoiceStatus } from '@/lib/wa-billing-status'
import { Link } from 'react-router'
import { whatsappAPI, type SgpInvoice, type WaSubscriberPanel, type WaSubscriberPartError, type WhatsAppMessage, type WhatsAppTemplate } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { ContactLink } from '@/components/whatsapp/contact-link'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import { copyToClipboard, formatBrl, formatSgpDate, isSafeExternalUrl, sgpBadge } from '@/lib/sgp'
import type { TranslationKey } from '@/lib/i18n'

/**
 * The "SGP module" beside a WhatsApp thread.
 *
 * The same cards an attendant kept open in the chat tool — who is writing,
 * the contracts found, router access, trust unlock, contract data — with the
 * router half read from the ONT through GenieACS instead of from the ERP, which
 * never knew the address.
 *
 * Nothing here decides who the subscriber is. The server finds the contracts,
 * the server refuses an act on a contract it did not find, and this component
 * only offers what the payload says is there: a card with missing data is not
 * drawn half-filled, it says what is missing.
 */

interface SubscriberPanelProps {
  conversationId: number
  /** The contract the thread shows right now; the panel says when it differs. */
  boundContract?: string | null
  onClose: () => void
  /** The thread's binding changed; the list and header should reload. */
  onBound?: () => void
  /** Hands a text to the reply box. Absent where there is no box to fill. */
  onDraft?: (text: string) => void
  /** Mensagens que o painel acabou de mandar, para o fio mostrar sem recarregar. */
  onSent?: (messages: WhatsAppMessage[]) => void
}

function Card({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-card p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon name={icon} size={16} />
        {title}
      </h3>
      {children}
    </section>
  )
}

function Field({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="metric-label">{label}</p>
      <p className={`mt-0.5 wrap-break-word text-sm text-foreground ${mono ? 'font-mono' : ''}`}>{children}</p>
    </div>
  )
}

function PartError({ error }: { error: WaSubscriberPartError | null | undefined }) {
  if (!error) return null
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-[hsl(var(--status-warning))]" role="status">
      <Icon name="warning" size={13} className="mt-0.5 shrink-0" />
      {error.message}
    </p>
  )
}

const MATCHED_ON: Record<string, TranslationKey> = {
  manual: 'whatsapp.sgp.matchedManual',
  sgp: 'whatsapp.sgp.matchedSgp',
  conversation: 'whatsapp.sgp.matchedConversation'
}

export function SubscriberPanel({ conversationId, boundContract = null, onClose, onBound, onDraft, onSent }: SubscriberPanelProps) {
  const { t, formatDateTime, intlLocale } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const canAct = can('sgp.act')
  // The second copy needs the templates (campaigns.read) and ends in a reply
  // (whatsapp.send); the manual phone is the billing screen's own write.
  const canSecondCopy = Boolean(onDraft) && can('whatsapp.send') && can('campaigns.read')
  const canSendInvoice = can('whatsapp.send')
  const canSavePhone = can('campaigns.manage')

  const [panel, setPanel] = useState<WaSubscriberPanel | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [contract, setContract] = useState<string | null>(null)
  const [document, setDocument] = useState('')
  const [searchedDocument, setSearchedDocument] = useState<string | null>(null)
  const [busy, setBusy] = useState<'unlock' | 'resume' | 'ticket' | 'bind' | 'secondCopy' | 'phone' | `invoice:${string}` | null>(null)
  const [templates, setTemplates] = useState<WhatsAppTemplate[] | null>(null)
  const [templateId, setTemplateId] = useState('')
  const [ticketOpen, setTicketOpen] = useState(false)
  const [ticketText, setTicketText] = useState('')
  // The answer to an older request must not overwrite a newer one: switching
  // threads while SGP is slow is exactly when the two cross.
  const requestRef = useRef(0)
  // The panel answer the list was last told about, so one answer is one reload.
  const notifiedRef = useRef<WaSubscriberPanel | null>(null)

  const load = useCallback(async (params: { contract?: string | null; document?: string | null } = {}) => {
    const request = ++requestRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const res = await whatsappAPI.getSubscriberPanel(conversationId, {
        contract: params.contract ?? undefined,
        document: params.document ?? undefined
      })
      if (request !== requestRef.current) return
      if (!res.success || !res.data) {
        setLoadError(res.message || t('detail.sgp.queryFailed'))
        return
      }
      setPanel(res.data)
      setContract(res.data.ready ? res.data.contracts.selected : null)
    } catch {
      if (request === requestRef.current) setLoadError(t('api.requestFailed'))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [conversationId, t])

  useEffect(() => {
    setPanel(null)
    setContract(null)
    setDocument('')
    setSearchedDocument(null)
    setTicketOpen(false)
    setTicketText('')
    void load()
  }, [conversationId, load])

  // Loaded once per panel, not per thread: the templates are the provider's,
  // not the subscriber's.
  useEffect(() => {
    if (!canSecondCopy) return
    let alive = true
    whatsappAPI.listTemplates({ category: 'cobranca' })
      .then((res) => {
        if (!alive) return
        const rows = res.success && res.data ? res.data.filter((row) => row.active) : []
        setTemplates(rows)
        setTemplateId((current) => current || (rows[0] ? String(rows[0].id) : ''))
      })
      .catch(() => { if (alive) setTemplates([]) })
    return () => { alive = false }
  }, [canSecondCopy])

  // Opening the panel can bind a thread the inbound path had not: the server
  // resolves the number on the way in. The list and the header would say "not
  // linked" until their next poll; they hear it now instead.
  useEffect(() => {
    if (!panel || notifiedRef.current === panel) return
    notifiedRef.current = panel
    if ((panel.attendance.contract ?? null) !== (boundContract ?? null)) onBound?.()
  }, [panel, boundContract, onBound])

  const selectContract = (value: string) => {
    setContract(value)
    setTicketOpen(false)
    void load({ contract: value, document: searchedDocument })
  }

  const search = () => {
    const digits = document.replace(/\D/g, '')
    if (!digits) return
    setSearchedDocument(digits)
    void load({ document: digits })
  }

  const bind = async () => {
    if (!contract) return
    setBusy('bind')
    try {
      const res = await whatsappAPI.bindSubscriber(conversationId, {
        contract,
        document: searchedDocument ?? undefined
      })
      if (!res.success || !res.data) {
        toast.error(res.message || t('detail.sgp.linkFailed'))
        return
      }
      toast.success(t('whatsapp.sgp.bound', { contract }))
      // The effect above tells the list: the new answer carries the new contract.
      setPanel(res.data)
      setSearchedDocument(null)
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setBusy(null)
    }
  }

  const unlock = async () => {
    if (!contract) return
    if (!window.confirm(t('whatsapp.sgp.unlockConfirm', { contract }))) return
    setBusy('unlock')
    try {
      const res = await whatsappAPI.subscriberUnlock(conversationId, contract)
      if (!res.success) {
        toast.error(res.message || t('detail.sgp.queryFailed'))
        return
      }
      toast.success(res.message || t('detail.sgp.unlockSent'))
      void load({ contract, document: searchedDocument })
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setBusy(null)
    }
  }

  // O comprovante pausou a régua; quem confere no SGP devolve o contrato a ela.
  const resumeDunning = async () => {
    if (!contract) return
    setBusy('resume')
    try {
      const res = await whatsappAPI.subscriberResumeDunning(conversationId, contract)
      if (!res.success) {
        toast.error(res.message || t('api.requestFailed'))
        return
      }
      toast.success(res.message || t('whatsapp.sgp.dunningResumed'))
      setPanel((atual) => (atual && atual.ready ? { ...atual, dunningPause: null } : atual))
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setBusy(null)
    }
  }

  const prepareSecondCopy = async () => {
    if (!contract || !templateId || !onDraft) return
    setBusy('secondCopy')
    try {
      const res = await whatsappAPI.subscriberSecondCopy(conversationId, { contract, template: templateId })
      if (!res.success || !res.data) {
        // The server's own sentence: "no open invoice" and "the template cites
        // a field this invoice lacks" are different fixes.
        toast.error(res.message || t('detail.sgp.queryFailed'))
        return
      }
      onDraft(res.data.text)
      toast.success(t('whatsapp.sgp.secondCopyReady'))
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setBusy(null)
    }
  }

  /**
   * "Enviar na conversa": o servidor relê a fatura no SGP e manda o resumo
   * com o boleto, o PIX e a linha em mensagens separadas. Daqui só vão o
   * contrato e o id da fatura.
   */
  const sendInvoice = async (invoice: SgpInvoice) => {
    if (!contract || invoice.id === null || invoice.id === undefined) return
    const count = 1 + (invoice.pix ? 1 : 0) + (invoice.digitableLine ? 1 : 0)
    if (!window.confirm(t('whatsapp.sgp.sendInvoiceConfirm', {
      amount: formatBrl(invoice.amount, intlLocale),
      due: formatSgpDate(invoice.dueDate, intlLocale),
      count
    }))) return
    setBusy(`invoice:${invoice.id}`)
    try {
      const res = await whatsappAPI.subscriberSendInvoice(conversationId, { contract, invoiceId: String(invoice.id) })
      if (!res.success || !res.data) {
        toast.error(res.message || t('api.requestFailed'))
        return
      }
      onSent?.(res.data.messages)
      toast.success(t('whatsapp.sgp.invoiceSent'))
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setBusy(null)
    }
  }

  const savePhone = async () => {
    if (!contract) return
    if (!window.confirm(t('whatsapp.sgp.savePhoneConfirm', { contract }))) return
    setBusy('phone')
    try {
      const res = await whatsappAPI.subscriberSavePhone(conversationId, contract)
      if (!res.success || !res.data) {
        toast.error(res.message || t('api.requestFailed'))
        return
      }
      toast.success(t('whatsapp.sgp.phoneSaved', { contract }))
      setPanel(res.data)
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setBusy(null)
    }
  }

  const openTicket = async () => {
    if (!contract || !ticketText.trim()) return
    setBusy('ticket')
    try {
      const res = await whatsappAPI.subscriberTicket(conversationId, { contract, content: ticketText.trim() })
      if (!res.success || !res.data) {
        toast.error(res.message || t('detail.sgp.ticketFailed'))
        return
      }
      toast.success(res.data.ticket
        ? t('detail.sgp.ticketOpenedWithNumber', { number: res.data.ticket })
        : res.message || t('detail.sgp.ticketOpened'))
      setTicketOpen(false)
      setTicketText('')
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setBusy(null)
    }
  }

  const copy = async (value: string, done: TranslationKey) => {
    if (await copyToClipboard(value)) toast.success(t(done))
    else toast.error(t('detail.sgp.copyFailed'))
  }

  const header = (
    <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon name="database" size={16} />
        {t('whatsapp.sgp.title')}
      </h2>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="icon-button"
          aria-label={t('common.refresh')}
          disabled={loading}
          onClick={() => void load({ contract, document: searchedDocument })}
        >
          <Icon name="refresh" size={16} className={loading ? 'animate-spin' : ''} />
        </button>
        <button type="button" className="icon-button" aria-label={t('common.close')} onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
    </header>
  )

  if (!panel) {
    return (
      <aside className="flex h-full min-h-0 flex-col bg-[hsl(var(--surface-subtle))]">
        {header}
        <div className="p-4 text-sm text-muted-foreground">
          {loadError ? (
            <div role="alert" className="space-y-3">
              <p>{loadError}</p>
              <button type="button" className="modern-button-secondary" onClick={() => void load()}>
                {t('common.retry')}
              </button>
            </div>
          ) : t('common.loading')}
        </div>
      </aside>
    )
  }

  const { attendance } = panel
  const phone = attendance.phone

  return (
    <aside className="flex h-full min-h-0 flex-col bg-[hsl(var(--surface-subtle))]" aria-label={t('whatsapp.sgp.title')}>
      {header}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] xl:pb-3">
        {loadError && <p className="text-xs text-[hsl(var(--status-danger))]" role="alert">{loadError}</p>}

        <Card icon="chat" title={t('whatsapp.sgp.attendance')}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                <ContactLink
                  contract={panel.ready ? panel.attendance.contract : null}
                  name={(panel.ready && panel.attendance.clientName) || attendance.pushName || phone || '—'}
                  className=""
                />
              </p>
              {phone && <p className="font-mono text-xs text-muted-foreground">{phone}</p>}
              {panel.ready && panel.attendance.matchedOn && (
                <p className="mt-1 text-xs text-muted-foreground">{t(MATCHED_ON[panel.attendance.matchedOn])}</p>
              )}
            </div>
            {phone && (
              <button
                type="button"
                className="icon-button"
                aria-label={t('common.copy')}
                onClick={() => void copy(phone, 'common.copied')}
              >
                <Icon name="copy" size={15} />
              </button>
            )}
          </div>
          {/* Only where it would change something: a number already saved by
              hand, or a contract with no ONT row to write it on, has nothing
              to gain from the button. */}
          {canSavePhone && phone && panel.ready && panel.contract
            && panel.attendance.matchedOn !== 'manual'
            && panel.router.deviceIds.length > 0 && (
            <button
              type="button"
              className="modern-button-secondary mt-2 w-full"
              disabled={busy !== null}
              onClick={() => void savePhone()}
            >
              <Icon name="phone" size={15} />
              {t('whatsapp.sgp.savePhone', { contract: panel.contract.contract })}
            </button>
          )}
        </Card>

        {!panel.ready ? (
          <Card icon="info" title={t('whatsapp.sgp.title')}>
            <p className="text-sm text-muted-foreground">{t('whatsapp.sgp.notConfigured')}</p>
          </Card>
        ) : (
          <>
            <Card icon="search" title={t('whatsapp.sgp.contractsFound')}>
              {panel.contract && (
                <div className="mb-2 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-2">
                  <p className="metric-label">{t('whatsapp.sgp.selectedContract')}</p>
                  <p className="mt-0.5 text-sm font-semibold">
                    {/* O contrato abre o cadastro do cliente no SGP, como o botão "Abrir no SGP". */}
                    {isSafeExternalUrl(panel.sgpUrl) ? (
                      <a
                        href={panel.sgpUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t('whatsapp.sgp.openSgp')}
                        className="inline-flex max-w-full items-center gap-1 hover:text-primary hover:underline"
                      >
                        <span className="min-w-0 wrap-break-word">
                          <span className="font-mono">#{panel.contract.contract}</span>
                          {panel.contract.name ? ` · ${panel.contract.name}` : ''}
                        </span>
                        <Icon name="external" size={13} className="shrink-0 text-muted-foreground" />
                      </a>
                    ) : (
                      <>
                        <span className="font-mono">#{panel.contract.contract}</span>
                        {panel.contract.name ? ` · ${panel.contract.name}` : ''}
                      </>
                    )}
                  </p>
                  {(() => {
                    const selo = sgpBadge(panel.contract)
                    return <span className={`${selo.className} mt-1`}>{selo.text ?? t(selo.fallbackKey)}</span>
                  })()}
                </div>
              )}

              {panel.contracts.items.length > 1 && (
                <select
                  className="modern-input w-full"
                  aria-label={t('whatsapp.sgp.selectedContract')}
                  value={contract ?? ''}
                  disabled={loading}
                  onChange={(event) => selectContract(event.target.value)}
                >
                  {!contract && <option value="">—</option>}
                  {panel.contracts.items.map((item) => (
                    <option key={item.contract} value={item.contract}>
                      #{item.contract}
                      {item.statusLabel || item.status ? ` · ${item.statusLabel || item.status}` : ''}
                      {item.plan ? ` · ${item.plan}` : ''}
                    </option>
                  ))}
                </select>
              )}

              {panel.contracts.items.length > 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t('whatsapp.sgp.contractsCount', { count: panel.contracts.items.length })}
                </p>
              )}
              {panel.contracts.missing && (
                <p className="mt-1.5 text-xs text-[hsl(var(--status-warning))]">{t('whatsapp.sgp.contractMissing')}</p>
              )}
              {panel.contracts.stale && (
                <p className="mt-1.5 text-xs text-[hsl(var(--status-warning))]">{t('whatsapp.sgp.stale')}</p>
              )}
              <PartError error={panel.contracts.error} />

              {panel.contracts.items.length === 0 && !panel.contracts.error && (
                <p className="text-sm text-muted-foreground">
                  {t(panel.contracts.searched ? 'whatsapp.sgp.noContracts' : 'whatsapp.sgp.unknownNumber')}
                </p>
              )}

              {/* The manual search: for a number the panel does not know, or
                  an operator who knows it is someone else's. The binding is
                  still checked on the server against this same search. */}
              {canAct && (
                <div className="mt-2 flex gap-2">
                  <input
                    className="modern-input min-w-0 flex-1"
                    inputMode="numeric"
                    value={document}
                    placeholder={t('whatsapp.sgp.documentPlaceholder')}
                    aria-label={t('whatsapp.sgp.documentPlaceholder')}
                    onChange={(event) => setDocument(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') search() }}
                  />
                  <button
                    type="button"
                    className="modern-button-secondary"
                    disabled={loading || !document.replace(/\D/g, '')}
                    onClick={search}
                  >
                    <Icon name="search" size={15} />
                    {t('whatsapp.sgp.search')}
                  </button>
                </div>
              )}

              {canAct && contract && contract !== attendance.contract && (
                <button
                  type="button"
                  className="modern-button mt-2 w-full"
                  disabled={busy !== null}
                  onClick={() => void bind()}
                >
                  <Icon name="check" size={15} />
                  {t('whatsapp.sgp.bind', { contract })}
                </button>
              )}
            </Card>

            <Card icon="wifi" title={t('whatsapp.sgp.router')}>
              {!panel.router.available ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t(panel.router.reason === 'unlinked' ? 'whatsapp.sgp.routerUnlinked' : 'whatsapp.sgp.routerUnreachable')}
                  </p>
                  <PartError error={panel.router.error} />
                  {isSafeExternalUrl(panel.sgpUrl) && (
                    <a
                      className="modern-button-secondary mt-2"
                      href={panel.sgpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Icon name="external" size={15} />
                      {t('whatsapp.sgp.openSgp')}
                    </a>
                  )}
                </>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {panel.router.status && (
                      <span className={panel.router.status === 'online' ? 'modern-badge-success' : 'modern-badge-error'}>
                        {t(panel.router.status === 'online' ? 'whatsapp.sgp.online' : 'whatsapp.sgp.offline')}
                      </span>
                    )}
                    {panel.router.ont?.model && <span className="modern-badge">{panel.router.ont.model}</span>}
                  </div>
                  <div className="flex items-end justify-between gap-2">
                    <Field label={t('whatsapp.sgp.wanIp')} mono>
                      {panel.router.ipAddress || t('whatsapp.sgp.noIp')}
                    </Field>
                    {panel.router.ipAddress && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t('common.copy')}
                        onClick={() => void copy(panel.router.available ? panel.router.ipAddress ?? '' : '', 'common.copied')}
                      >
                        <Icon name="copy" size={15} />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t('whatsapp.sgp.rxPower')}>
                      {panel.router.rxPower !== null && panel.router.rxPower !== '' ? `${panel.router.rxPower} dBm` : '—'}
                    </Field>
                    <Field label={t('whatsapp.sgp.lastInform')}>
                      {panel.router.lastInform ? formatDateTime(panel.router.lastInform) : '—'}
                    </Field>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isSafeExternalUrl(panel.sgpUrl) && (
                      <a
                        className="modern-button-secondary"
                        href={panel.sgpUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Icon name="external" size={15} />
                        {t('whatsapp.sgp.openSgp')}
                      </a>
                    )}
                    <Link
                      to={`/devices/detail?id=${encodeURIComponent(panel.router.deviceId)}`}
                      className="modern-button-secondary"
                    >
                      <Icon name="server" size={15} />
                      {t('whatsapp.inbox.openDevice')}
                    </Link>
                  </div>
                </div>
              )}
            </Card>

            {/* Offered only with an exact contract, and never for a cancelled one:
                SGP would refuse it, and the button would be a promise the ERP
                does not keep. */}
            {canAct && panel.contract && panel.contract.state !== 'cancelled' && (
              <Card icon="unlock" title={t('detail.sgp.unlock')}>
                <button
                  type="button"
                  className="modern-button w-full"
                  disabled={busy !== null}
                  onClick={() => void unlock()}
                >
                  <Icon name="unlock" size={15} />
                  {busy === 'unlock' ? t('detail.sgp.unlocking') : t('detail.sgp.unlock')}
                </button>
                {panel.contract.state === 'active' && (
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('whatsapp.sgp.unlockActiveHint')}</p>
                )}
                {panel.ticketEnabled && (
                  <div className="mt-2">
                    {!ticketOpen ? (
                      <button type="button" className="modern-button-secondary w-full" onClick={() => setTicketOpen(true)}>
                        <Icon name="chat" size={15} />
                        {t('detail.sgp.ticket')}
                      </button>
                    ) : (
                      <div>
                        <label className="metric-label" htmlFor={`wa-ticket-${conversationId}`}>
                          {t('detail.sgp.ticketLabel')}
                        </label>
                        <textarea
                          id={`wa-ticket-${conversationId}`}
                          className="modern-input mt-1 min-h-20 w-full"
                          value={ticketText}
                          maxLength={4000}
                          onChange={(event) => setTicketText(event.target.value)}
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('detail.sgp.ticketHint', { contract: panel.contract.contract })}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            className="modern-button"
                            disabled={busy !== null || !ticketText.trim()}
                            onClick={() => void openTicket()}
                          >
                            {busy === 'ticket' ? t('detail.sgp.ticketSending') : t('detail.sgp.ticketSend')}
                          </button>
                          <button
                            type="button"
                            className="modern-button-secondary"
                            disabled={busy === 'ticket'}
                            onClick={() => setTicketOpen(false)}
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )}

            {panel.contract && (
              <Card icon="invoice" title={t('whatsapp.sgp.contractData')}>
                <div className="grid gap-2">
                  <Field label={t('detail.sgp.plan')}>{panel.contract.plan || '—'}</Field>
                  <Field label={t('whatsapp.sgp.address')}>{panel.contract.address || '—'}</Field>
                  <Field label={t('whatsapp.sgp.login')} mono>{panel.contract.login || '—'}</Field>
                  {panel.contract.document && (
                    <Field label={t('whatsapp.sgp.document')} mono>{panel.contract.document}</Field>
                  )}
                </div>
              </Card>
            )}

            {panel.contract && (
              <Card icon="invoice" title={t('detail.sgp.openInvoices')}>
                {panel.dunningPause && (
                  <div
                    role="status"
                    className="mb-3 rounded-md border border-[hsl(var(--status-warning)/0.4)] bg-[hsl(var(--status-warning)/0.1)] p-2 text-xs"
                  >
                    <p className="font-semibold text-foreground">
                      {t('whatsapp.sgp.dunningPaused', { until: formatDateTime(panel.dunningPause.until) })}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      {t(panel.dunningPause.reason === 'receipt' ? 'whatsapp.sgp.dunningPausedReceipt' : 'whatsapp.sgp.dunningPausedManual')}
                    </p>
                    {canSendInvoice && (
                      <button
                        type="button"
                        className="modern-button-secondary mt-2 min-h-8 px-2 py-1 text-xs"
                        disabled={busy !== null}
                        onClick={() => void resumeDunning()}
                      >
                        {t('whatsapp.sgp.dunningResume')}
                      </button>
                    )}
                  </div>
                )}
                {canSecondCopy && !panel.invoices.error && panel.invoices.items.length > 0 && (
                  <div className="mb-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-2">
                    {templates && templates.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('whatsapp.sgp.noTemplates')}</p>
                    ) : (
                      <>
                        <label className="metric-label" htmlFor={`wa-second-copy-${conversationId}`}>
                          {t('whatsapp.sgp.secondCopyTemplate')}
                        </label>
                        <select
                          id={`wa-second-copy-${conversationId}`}
                          className="modern-input mt-1 w-full"
                          value={templateId}
                          disabled={!templates}
                          onChange={(event) => setTemplateId(event.target.value)}
                        >
                          {(templates ?? []).map((row) => (
                            <option key={row.id} value={String(row.id)}>{row.name}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="modern-button mt-2 w-full"
                          disabled={busy !== null || !templateId}
                          onClick={() => void prepareSecondCopy()}
                        >
                          <Icon name="invoice" size={15} />
                          {t('whatsapp.sgp.secondCopy')}
                        </button>
                        <p className="mt-1 text-xs text-muted-foreground">{t('whatsapp.sgp.secondCopyHint')}</p>
                      </>
                    )}
                  </div>
                )}
                {panel.invoices.error ? (
                  <PartError error={panel.invoices.error} />
                ) : panel.invoices.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('detail.sgp.noInvoices')}</p>
                ) : (
                  <ul className="space-y-2" role="list">
                    {panel.invoices.items.map((invoice, index) => {
                      const highlighted = invoice.id !== null && invoice.id === panel.invoices.highlight
                      // A borda pela data: verde a vencer, amarela vence hoje, vermelha vencida.
                      const situacao = invoiceStatus(invoice.dueDate)
                      return (
                        <li
                          key={invoice.id ?? `invoice-${index}`}
                          className={`rounded-md border-2 p-2 ${situacao ? BILLING_BORDER[situacao.status] : 'border-border'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold">{formatBrl(invoice.amount, intlLocale)}</span>
                            {invoice.dueDate && (
                              <span className="text-xs text-muted-foreground">
                                {t('detail.sgp.dueOn', { date: formatSgpDate(invoice.dueDate, intlLocale) })}
                              </span>
                            )}
                          </div>
                          {situacao && (
                            <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[0.68rem] font-semibold ${BILLING_BADGE[situacao.status]}`}>
                              {t(billingLabel(situacao.status, situacao.daysOverdue).key, billingLabel(situacao.status, situacao.daysOverdue).vars)}
                            </span>
                          )}
                          {highlighted && (
                            <p className="mt-0.5 text-xs text-muted-foreground">{t('whatsapp.sgp.highlight')}</p>
                          )}
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {invoice.digitableLine && (
                              <button
                                type="button"
                                className="modern-button-secondary min-h-10 px-2 py-1 text-xs lg:min-h-8"
                                onClick={() => void copy(invoice.digitableLine ?? '', 'detail.sgp.copiedLine')}
                              >
                                <Icon name="copy" size={13} />
                                {t('detail.sgp.copyLine')}
                              </button>
                            )}
                            {invoice.pix && (
                              <button
                                type="button"
                                className="modern-button-secondary min-h-10 px-2 py-1 text-xs lg:min-h-8"
                                onClick={() => void copy(invoice.pix ?? '', 'detail.sgp.copiedPix')}
                              >
                                <Icon name="copy" size={13} />
                                {t('detail.sgp.copyPix')}
                              </button>
                            )}
                            {canSendInvoice && contract && (invoice.pix || invoice.digitableLine || invoice.link) && (
                              <button
                                type="button"
                                className="modern-button min-h-10 px-2 py-1 text-xs lg:min-h-8"
                                disabled={busy !== null}
                                onClick={() => void sendInvoice(invoice)}
                              >
                                <Icon name="chat" size={13} />
                                {busy === `invoice:${invoice.id}` ? t('whatsapp.sgp.sending') : t('whatsapp.sgp.sendInvoice')}
                              </button>
                            )}
                            {isSafeExternalUrl(invoice.link) && (
                              <a
                                className="modern-button-secondary min-h-10 px-2 py-1 text-xs lg:min-h-8"
                                href={invoice.link}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <Icon name="external" size={13} />
                                {t('detail.sgp.openBoleto')}
                              </a>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </Card>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
