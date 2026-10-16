'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { contactsAPI, type ContactImportResult, type ContactGoogleImportResult, type ContactWhatsappImportResult, whatsappAPI, type WhatsAppContactCounts, type ContactDeviceFilter, type WhatsAppContact, type WhatsAppContactState, type WhatsAppConversation } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n/dictionary'
import { useAuth } from '@/contexts/auth-context'
import { formatBrPhone } from '@/lib/phone'
import { isSafeExternalUrl } from '@/lib/sgp'
import { loadContactFilters, saveContactFilters } from '@/lib/contact-filters'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { SGP_CONTACTS_HREF } from '@/components/settings/sgp-contacts-sync-panel'
import { NewContactModal } from '@/components/whatsapp/new-contact-modal'
import { TeiahPhonesModal } from '@/components/contacts/teiah-phones-modal'

/** Same pause as the inbox search: one request per word, not per letter. */
const SEARCH_DEBOUNCE_MS = 350
const PAGE = 50

/**
 * The status filter, in the order an operator reaches for it. `none` is a
 * client the SGP has with no contract at all, which the full sync brings in.
 */
const STATE_FILTERS = [
  ['', 'whatsapp.contacts.filterAll'],
  ['active', 'whatsapp.contacts.filterActive'],
  ['blocked', 'whatsapp.contacts.filterBlocked'],
  ['cancelled', 'whatsapp.contacts.filterCancelled'],
  ['none', 'whatsapp.contacts.filterNoContract']
] as const

export type StateFilter = (typeof STATE_FILTERS)[number][0]

interface ContactsPanelProps {
  /** Called with the thread to show — the page switches to the inbox with it open. */
  onOpenConversation: (conversation: WhatsAppConversation) => void
  /** The tab the list opens on. The Contacts menu entry opens on the active subscribers. */
  defaultState?: StateFilter
  /** When set, the filters survive leaving the page (kept per tab under this key). */
  persistKey?: string
}

/**
 * The SGP's subscribers as WhatsApp contacts.
 *
 * The inbox only ever knew someone after they wrote in. This is the other
 * direction: look a subscriber up by name, contract, document or number, see
 * whether a thread with them already exists, and open it — or start one.
 * Starting sends nothing; the operator lands in an empty thread and writes.
 */
export function ContactsPanel({ onOpenConversation, defaultState = '', persistKey }: ContactsPanelProps) {
  const { t, intlLocale, formatDateTime, formatNumber } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()

  const [contacts, setContacts] = useState<WhatsAppContact[]>([])
  const [total, setTotal] = useState(0)
  // Where the filters were left, when this panel keeps them between visits.
  const [saved] = useState(() => {
    const base = { search: '', state: defaultState, noPhone: false, imported: false, device: '' as ContactDeviceFilter }
    return persistKey ? loadContactFilters(persistKey, base) : base
  })
  const [search, setSearch] = useState(saved.search)
  const [debounced, setDebounced] = useState(saved.search.trim())
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [openingContract, setOpeningContract] = useState<string | null>(null)
  // What the SGP answered for a CPF/CNPJ or contract. While set, it is what the
  // table shows — the panel's own directory comes back when the search changes.
  const [sgpResult, setSgpResult] = useState<{ term: string; contacts: WhatsAppContact[] } | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [stateFilter, setStateFilter] = useState<StateFilter>(saved.state)
  // Só quem está sem telefone — combina com a aba: "Ativos sem telefone" é a
  // lista para corrigir primeiro, porque quem está nela fica fora da cobrança.
  const [noPhone, setNoPhone] = useState(saved.noPhone)
  // Só os cadastros que vieram de uma importação (agenda do WhatsApp ou planilha).
  const [imported, setImported] = useState(saved.imported)
  // Só quem tem (ou não tem) equipamento gerenciado vinculado ao contrato.
  const [device, setDevice] = useState<ContactDeviceFilter>(saved.device)
  useEffect(() => {
    if (persistKey) saveContactFilters(persistKey, { search, state: stateFilter, noPhone, imported, device })
  }, [persistKey, search, stateFilter, noPhone, imported, device])
  // Quantos contatos cada filtro mostraria; vazio até a primeira leitura.
  const [counts, setCounts] = useState<WhatsAppContactCounts | null>(null)

  const alive = useRef(true)
  // The newest request wins: a slow answer for "ben" must not overwrite the
  // answer for "benedita" that arrived first.
  const requestSeq = useRef(0)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  /**
   * Asks the SGP for what the panel's directory does not have: a subscriber
   * with no ONT here. The SGP answers by CPF/CNPJ or contract only, never by
   * name, and the button says so.
   */
  const lookupSgp = useCallback(async () => {
    const term = search.trim()
    if (!term) return
    setLookingUp(true)
    try {
      const res = await whatsappAPI.lookupContacts(term)
      if (!alive.current) return
      if (!res.success || !res.data) {
        // The server's own sentence: an SGP refusal ("integration off",
        // "unreachable") is already translated there, and a generic failure
        // would hide which one it was.
        toast.error(res.message || whatsappErrorMessage(t, res.code))
        return
      }
      setSgpResult({ term, contacts: res.data.contacts })
    } catch {
      if (alive.current) toast.error(t('api.requestFailed'))
    } finally {
      if (alive.current) setLookingUp(false)
    }
  }, [search, t, toast])

  const load = useCallback(async (term: string, state: StateFilter, onlyNoPhone: boolean, onlyImported: boolean, deviceFilter: ContactDeviceFilter) => {
    const seq = ++requestSeq.current
    setLoading(true)
    const res = await whatsappAPI.listContacts({
      search: term || undefined,
      limit: PAGE,
      state: (state || undefined) as WhatsAppContactState | undefined,
      noPhone: onlyNoPhone,
      imported: onlyImported,
      device: deviceFilter
    })
    if (!alive.current || seq !== requestSeq.current) return
    if (res.success && res.data) {
      setContacts(res.data.contacts)
      setTotal(res.data.total)
      setCounts(res.data.counts ?? null)
      setLoadError('')
    } else {
      setLoadError(whatsappErrorMessage(t, res.code))
    }
    setLoading(false)
  }, [t])

  useEffect(() => { void load(debounced, stateFilter, noPhone, imported, device) }, [debounced, stateFilter, noPhone, imported, device, load])

  const loadMore = useCallback(async () => {
    const seq = requestSeq.current
    setLoadingMore(true)
    const res = await whatsappAPI.listContacts({
      search: debounced || undefined,
      limit: PAGE,
      offset: contacts.length,
      state: (stateFilter || undefined) as WhatsAppContactState | undefined,
      noPhone,
      imported,
      device
    })
    if (!alive.current) return
    setLoadingMore(false)
    if (seq !== requestSeq.current) return
    if (!res.success || !res.data) {
      toast.error(whatsappErrorMessage(t, res.code))
      return
    }
    const page = res.data.contacts
    setContacts((current) => [
      ...current,
      ...page.filter((row) => !current.some((held) => held.key === row.key))
    ])
    setTotal(res.data.total)
  }, [contacts.length, debounced, stateFilter, noPhone, imported, device, t, toast])

  const open = useCallback(async (contact: WhatsAppContact) => {
    setOpeningContract(contact.key)
    try {
      const res = await whatsappAPI.openContactConversation(contact.key)
      if (!alive.current) return
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      onOpenConversation(res.data)
    } catch {
      if (alive.current) toast.error(t('api.requestFailed'))
    } finally {
      if (alive.current) setOpeningContract(null)
    }
  }, [onOpenConversation, t, toast])

  const stamp = (iso: string | null) => {
    if (!iso) return ''
    return formatDateTime(iso)
  }

  const canSend = can('whatsapp.send')
  const canOpenProfile = can('contacts.read')
  const canCreate = can('contacts.edit')
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [teiahPhones, setTeiahPhones] = useState(false)
  const [exporting, setExporting] = useState(false)
  const canExport = can('contacts.export')
  const canImport = can('contacts.import')
  // Asking the TeiaH sends a CPF/CNPJ out and costs a call, so it is its own capability.
  const canTeiahPhones = can('teiah.act') && canCreate && stateFilter === 'active' && noPhone

  const exportSheet = async () => {
    setExporting(true)
    try {
      const res = await contactsAPI.exportSheet({ search: debounced, state: stateFilter, noPhone, imported, device })
      if (!res.success || !res.blob) {
        toast.error(res.message || t('contacts.sheet.exportFailed'))
        return
      }
      const url = URL.createObjectURL(res.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = res.filename || 'contatos.csv'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }
  const canLookup = can('sgp.read')
  const shown = sgpResult ? sgpResult.contacts : contacts

  // Pedaços de cada linha, os mesmos na tabela e nos cartões do celular.
  // O número ao lado do rótulo do filtro; nada até a lista ter sido lida uma vez.
  const countBadge = (value: number | undefined) => (value === undefined ? null : (
    <span className="ml-1.5 text-xs font-normal opacity-70" data-testid="wa-contacts-count">{formatNumber(value)}</span>
  ))

  const nameOf = (contact: WhatsAppContact) => (canOpenProfile ? (
    <Link
      to={`/contacts/${encodeURIComponent(contact.key)}`}
      className="block wrap-break-word font-semibold hover:text-primary hover:underline"
    >
      {contact.clientName || '—'}
    </Link>
  ) : (
    <span className="block wrap-break-word font-semibold">{contact.clientName || '—'}</span>
  ))

  const tagsOf = (contact: WhatsAppContact) => (
    <span className="flex flex-wrap items-center gap-1.5">
      {contact.document && (
        <span className="text-xs text-muted-foreground">{contact.document}</span>
      )}
      {contact.importSource && (
        <span className="modern-badge-info" title={t('whatsapp.contacts.importedHint')}>
          {t(contact.importSource === 'google'
            ? 'whatsapp.contacts.importedGoogle'
            : contact.importSource === 'focuschat' ? 'whatsapp.contacts.importedFocusChat' : 'whatsapp.contacts.imported')}
        </span>
      )}
      {contact.state === 'blocked' && (
        <span className="modern-badge-warning">{t('whatsapp.contacts.stateBlocked')}</span>
      )}
      {contact.state === 'cancelled' && (
        <span className="modern-badge-error">{t('whatsapp.contacts.stateCancelled')}</span>
      )}
    </span>
  )

  // The managed ONT linked to the contract, opening its page; or the plain
  // "no equipment" for a subscriber the panel has no ONT of.
  const deviceOf = (contact: WhatsAppContact) => (contact.deviceId ? (
    <Link
      className="inline-flex max-w-56 items-center gap-1 truncate text-sm text-primary hover:underline"
      to={`/devices/detail?id=${encodeURIComponent(contact.deviceId)}`}
      title={contact.deviceId}
    >
      <Icon name="wifi" size={14} />
      <span className="truncate font-mono text-xs">{contact.deviceId}</span>
    </Link>
  ) : (
    <span className="text-sm text-muted-foreground" title={t('whatsapp.contacts.noDeviceHint')}>
      {t('whatsapp.contacts.withoutDevice')}
    </span>
  ))

  const phoneOf = (contact: WhatsAppContact) => (contact.phone ? (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono" title={contact.phone}>{formatBrPhone(contact.phone)}</span>
      {contact.phoneSource === 'manual' && (
        <span className="modern-badge" title={t('whatsapp.contacts.phoneManualHint')}>
          {t('whatsapp.contacts.phoneManual')}
        </span>
      )}
      {contact.optedOut && (
        <span className="modern-badge-warning" title={t('whatsapp.inbox.optedOutHint')}>
          <Icon name="bell" size={12} />
          {t('whatsapp.inbox.optedOut')}
        </span>
      )}
    </span>
  ) : (
    <span className="text-muted-foreground">{t('whatsapp.contacts.noPhone')}</span>
  ))

  const sgpOf = (contact: WhatsAppContact, extra = '') => (
    contact.sgpUrl && isSafeExternalUrl(contact.sgpUrl) ? (
      <a
        className={`modern-button-secondary${extra ? ` ${extra}` : ''}`}
        href={contact.sgpUrl}
        target="_blank"
        rel="noreferrer"
        title={t('contacts.profile.openInSgp')}
      >
        <Icon name="external" size={16} />
        <span className="max-xl:sr-only">{t('contacts.profile.openInSgp')}</span>
      </a>
    ) : null
  )

  const actionOf = (contact: WhatsAppContact, extra = '') => (
    canSend && (contact.conversationId || contact.phone) ? (
      <button
        type="button"
        className={`${contact.conversationId ? 'modern-button-secondary' : 'modern-button'}${extra ? ` ${extra}` : ''}`}
        disabled={openingContract !== null}
        onClick={() => void open(contact)}
      >
        <Icon
          name={openingContract === contact.key ? 'refresh' : 'chat'}
          size={16}
          className={openingContract === contact.key ? 'animate-spin' : ''}
        />
        {t(contact.conversationId
          ? 'whatsapp.contacts.openConversation'
          : 'whatsapp.contacts.startConversation')}
      </button>
    ) : null
  )

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="section-heading">{t('whatsapp.contacts.title')}</h2>
          <p className="section-description">{t('whatsapp.contacts.subtitle')}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0 sm:flex-wrap">
          {canExport && (
            <button type="button" className="modern-button-secondary" disabled={exporting} onClick={() => void exportSheet()}>
              <Icon name="external" size={16} />
              {t('contacts.sheet.export')}
            </button>
          )}
          {canImport && (
            <button type="button" className="modern-button-secondary" onClick={() => setImporting(true)}>
              <Icon name="copy" size={16} />
              {t('contacts.sheet.import')}
            </button>
          )}
          {canTeiahPhones && (
            <button type="button" className="modern-button-secondary" onClick={() => setTeiahPhones(true)}>
              <Icon name="search" size={16} />
              {t('contacts.teiahPhones.title')}
            </button>
          )}
          {canCreate && (
            <button type="button" className="modern-button" onClick={() => setCreating(true)}>
              <Icon name="contacts" size={16} />
              {t('contacts.profile.new')}
            </button>
          )}
          <button
            type="button"
            className="modern-button-secondary"
            onClick={() => void load(debounced, stateFilter, noPhone, imported, device)}
            disabled={loading}
          >
            <Icon name="refresh" size={16} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
      </header>
      {creating && <NewContactModal onClose={() => setCreating(false)} />}
      {teiahPhones && (
        <TeiahPhonesModal
          onClose={() => setTeiahPhones(false)}
          onApplied={() => {
            setTeiahPhones(false)
            void load(debounced, stateFilter, noPhone, imported, device)
          }}
        />
      )}
      {importing && (
        <ImportSheetModal
          onClose={() => setImporting(false)}
          onApplied={() => {
            setImporting(false)
            void load(debounced, stateFilter, noPhone, imported, device)
          }}
        />
      )}

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          if (canLookup) void lookupSgp()
        }}
      >
        <input
          type="search"
          className="modern-input flex-1"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setSgpResult(null)
          }}
          placeholder={t('whatsapp.contacts.searchPlaceholder')}
          aria-label={t('whatsapp.contacts.searchPlaceholder')}
        />
        {canLookup && (
          <button
            type="submit"
            className="modern-button-secondary shrink-0"
            disabled={!search.trim() || lookingUp}
            title={t('whatsapp.contacts.lookupHint')}
          >
            <Icon name={lookingUp ? 'refresh' : 'search'} size={16} className={lookingUp ? 'animate-spin' : ''} />
            {t('whatsapp.contacts.lookup')}
          </button>
        )}
      </form>

      {!sgpResult && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="tab-rail" role="tablist" aria-label={t('whatsapp.contacts.title')}>
            {STATE_FILTERS.map(([id, labelKey]) => (
              <button
                key={id || 'all'}
                type="button"
                className="tab-button"
                data-active={stateFilter === id}
                role="tab"
                aria-selected={stateFilter === id}
                onClick={() => setStateFilter(id)}
              >
                {t(labelKey)}
                {countBadge(counts?.states[id || 'all'])}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={noPhone ? 'modern-button' : 'modern-button-secondary'}
            aria-pressed={noPhone}
            data-testid="wa-contacts-no-phone"
            onClick={() => setNoPhone((current) => !current)}
          >
            <Icon name="phone" size={16} />
            {t('whatsapp.contacts.filterNoPhone')}
            {countBadge(counts?.noPhone)}
            {noPhone && <Icon name="x" size={14} />}
          </button>
          <button
            type="button"
            className={imported ? 'modern-button' : 'modern-button-secondary'}
            aria-pressed={imported}
            data-testid="wa-contacts-imported"
            onClick={() => setImported((current) => !current)}
          >
            <Icon name="copy" size={16} />
            {t('whatsapp.contacts.filterImported')}
            {countBadge(counts?.imported)}
            {imported && <Icon name="x" size={14} />}
          </button>
          {(['with', 'without'] as const).map((which) => (
            <button
              key={which}
              type="button"
              className={device === which ? 'modern-button' : 'modern-button-secondary'}
              aria-pressed={device === which}
              data-testid={`wa-contacts-device-${which}`}
              onClick={() => setDevice((current) => (current === which ? '' : which))}
            >
              <Icon name="wifi" size={16} />
              {t(which === 'with' ? 'whatsapp.contacts.filterWithDevice' : 'whatsapp.contacts.filterWithoutDevice')}
              {countBadge(which === 'with' ? counts?.withDevice : counts?.withoutDevice)}
              {device === which && <Icon name="x" size={14} />}
            </button>
          ))}
        </div>
      )}

      {sgpResult && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <span>{t('whatsapp.contacts.lookupResult', { term: sgpResult.term, count: sgpResult.contacts.length })}</span>
          <button type="button" className="modern-button-secondary" onClick={() => setSgpResult(null)}>
            {t('whatsapp.contacts.lookupBack')}
          </button>
        </div>
      )}

      {loadError && (
        <p className="flex items-center gap-2 text-sm text-[hsl(var(--status-danger))]" role="alert">
          <Icon name="warning" size={16} />
          {loadError}
        </p>
      )}

      <section className="modern-card overflow-hidden">
        {shown.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name={debounced || sgpResult ? 'search' : 'phone'} size={22} /></div>
            <p className="empty-state-title">
              {sgpResult
                ? t('whatsapp.contacts.lookupNone')
                : loading
                  ? t('common.loading')
                  : t(debounced ? 'whatsapp.contacts.noMatch' : 'whatsapp.contacts.empty')}
            </p>
            {!sgpResult && !loading && canLookup && (
              <p className="empty-state-copy">{t('whatsapp.contacts.lookupHint')}</p>
            )}
            {!sgpResult && !loading && !debounced && stateFilter === defaultState && can('sgp.config') && (
              <>
                <p className="empty-state-copy">{t('whatsapp.contacts.syncHint')}</p>
                <Link to={SGP_CONTACTS_HREF} className="modern-button-secondary mt-4">
                  <Icon name="settings" size={16} />
                  {t('settings.whatsapp.sgpContacts.open')}
                </Link>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="desktop-table overflow-x-auto">
              <table className="modern-table">
                <thead>
                  <tr>
                    <th scope="col">{t('whatsapp.inbox.subscriber')}</th>
                    <th scope="col">{t('whatsapp.inbox.contract')}</th>
                    <th scope="col">{t('whatsapp.optOut.phone')}</th>
                    <th scope="col">{t('whatsapp.contacts.device')}</th>
                    <th scope="col">{t('whatsapp.contacts.lastMessage')}</th>
                    <th scope="col"><span className="sr-only">{t('whatsapp.contacts.actions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((contact) => (
                    <tr key={contact.key} data-contract={contact.contract ?? ''}>
                      <td>
                        {nameOf(contact)}
                        {tagsOf(contact)}
                      </td>
                      <td className="font-mono">
                        {contact.contract ?? <span className="font-sans text-muted-foreground">{t('whatsapp.contacts.noContract')}</span>}
                      </td>
                      <td>{phoneOf(contact)}</td>
                      <td>{deviceOf(contact)}</td>
                      <td className="text-sm text-muted-foreground">
                        {contact.conversationId ? stamp(contact.lastMessageAt) || '—' : '—'}
                      </td>
                      <td className="text-end">
                        <div className="flex items-center justify-end gap-2">
                          {sgpOf(contact)}
                          {actionOf(contact)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* No celular, um cartão por assinante: a tabela de cinco colunas
                rolava de lado e o nome virava uma coluna de cinco linhas. */}
            <ul className="mobile-card-list divide-y divide-border" role="list">
              {shown.map((contact) => (
                <li key={contact.key} className="space-y-2 p-4" data-contract={contact.contract ?? ''}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {nameOf(contact)}
                      {tagsOf(contact)}
                    </div>
                    {contact.contract ? (
                      <span className="shrink-0 font-mono text-sm">{contact.contract}</span>
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">{t('whatsapp.contacts.noContract')}</span>
                    )}
                  </div>
                  <div className="text-sm">{phoneOf(contact)}</div>
                  <div>{deviceOf(contact)}</div>
                  {contact.conversationId && contact.lastMessageAt && (
                    <p className="text-xs text-muted-foreground">
                      {t('whatsapp.contacts.lastMessage')}: {stamp(contact.lastMessageAt)}
                    </p>
                  )}
                  <div className="flex flex-col gap-2">
                    {sgpOf(contact, 'w-full')}
                    {actionOf(contact, 'w-full')}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {!sgpResult && contacts.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{t('whatsapp.contacts.showing', { shown: contacts.length, total })}</span>
          {contacts.length < total && (
            <button
              type="button"
              className="modern-button-secondary"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {t('whatsapp.contacts.loadMore')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/** The record's field names as the preview shows them. */
const FIELD_LABELS: Record<string, TranslationKey> = {
  name: 'contacts.profile.name',
  personType: 'contacts.profile.personType',
  document: 'contacts.profile.document',
  birthDate: 'contacts.profile.birthDate',
  gender: 'contacts.profile.gender',
  address: 'contacts.profile.address',
  phones: 'contacts.profile.phones',
  emails: 'contacts.profile.emails',
  whatsappPhone: 'contacts.profile.whatsappPhone',
  notes: 'contacts.profile.notes'
}

/**
 * The import, in two steps: the preview says what the sheet would change and
 * which lines are wrong; nothing is written until Apply.
 */
type ImportSource = 'sheet' | 'whatsapp' | 'focuschat'

const SOURCE_LABEL: Record<ImportSource, TranslationKey> = {
  sheet: 'contacts.sheet.sourceSheet',
  whatsapp: 'contacts.sheet.sourceWhatsapp',
  focuschat: 'contacts.sheet.sourceFocusChat'
}

const SOURCE_TITLE: Record<ImportSource, TranslationKey> = {
  sheet: 'contacts.sheet.importTitle',
  whatsapp: 'contacts.sheet.whatsappTitle',
  focuschat: 'contacts.sheet.focusChatTitle'
}

function ImportSheetModal({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [csv, setCsv] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState<ContactImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<ImportSource>('sheet')
  // The WhatsApp phone book and the Focus Chat contact book share a preview:
  // only new people come in. Focus Chat also counts groups and other channels.
  const [book, setBook] = useState<(ContactWhatsappImportResult & { ignored?: number }) | null>(null)
  const fromBook = source !== 'sheet'
  const bookFailedKey = source === 'focuschat' ? 'contacts.sheet.focusChatFailed' : 'contacts.sheet.whatsappFailed'
  const importBook = (mode: 'preview' | 'apply') => (source === 'focuschat'
    ? contactsAPI.importFocusChat(mode)
    : contactsAPI.importWhatsapp(mode))
  // A Google Contacts export only brings new people in, so its preview is the
  // phone-book kind, not the sheet's.
  const [google, setGoogle] = useState<ContactGoogleImportResult | null>(null)

  const switchSource = (next: ImportSource) => {
    if (busy) return
    setSource(next)
    setPreview(null)
    setBook(null)
    setGoogle(null)
    setCsv(null)
  }

  const readBook = async () => {
    setBook(null)
    setBusy(true)
    const res = await importBook('preview')
    setBusy(false)
    if (!res.success || !res.data) {
      toast.error(res.message || t(bookFailedKey))
      return
    }
    setBook(res.data)
  }

  const readFile = async (file: File | undefined) => {
    setPreview(null)
    setGoogle(null)
    if (!file) return
    setFileName(file.name)
    const text = await file.text()
    setCsv(text)
    setBusy(true)
    const res = await contactsAPI.importSheet(text, 'preview')
    setBusy(false)
    if (!res.success || !res.data) {
      toast.error(res.message || t('contacts.sheet.importFailed'))
      return
    }
    if ('format' in res.data) setGoogle(res.data)
    else setPreview(res.data)
  }

  const apply = async () => {
    if (fromBook) {
      setBusy(true)
      const done = await importBook('apply')
      setBusy(false)
      if (!done.success || !done.data) {
        toast.error(done.message || t(bookFailedKey))
        return
      }
      toast.success(done.message || t('contacts.sheet.applied'))
      onApplied()
      return
    }
    if (!csv) return
    setBusy(true)
    const res = await contactsAPI.importSheet(csv, 'apply')
    setBusy(false)
    if (!res.success || !res.data) {
      toast.error(res.message || t('contacts.sheet.importFailed'))
      return
    }
    toast.success(res.message || t('contacts.sheet.applied'))
    onApplied()
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="import-sheet-title">
      <div className="modal-panel modern-card max-w-2xl p-5 sm:p-6" data-testid="import-sheet">
        <h2 id="import-sheet-title" className="section-heading mb-1">{t(SOURCE_TITLE[source])}</h2>
        <div className="tab-rail mb-4" role="tablist">
          {(['sheet', 'whatsapp', 'focuschat'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={source === id}
              data-active={source === id}
              className="tab-button"
              data-testid={`import-source-${id}`}
              onClick={() => switchSource(id)}
            >
              {t(SOURCE_LABEL[id])}
            </button>
          ))}
        </div>

        {fromBook ? (
          <>
            <p className="section-description mb-4">{t(source === 'focuschat' ? 'contacts.sheet.focusChatHint' : 'contacts.sheet.whatsappHint')}</p>
            <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => void readBook()} data-testid="import-whatsapp-load">
              {t('contacts.sheet.whatsappLoad')}
            </button>
            {busy && <p className="mt-3 text-sm text-muted-foreground" role="status">{t('contacts.sheet.whatsappReading')}</p>}
            {book && (
              <div className="mt-5 space-y-3 text-sm" data-testid="import-whatsapp-summary">
                <p className="font-semibold">{t('contacts.sheet.whatsappSummary', {
                  total: book.total,
                  creates: book.creates,
                  existing: book.existing,
                  duplicated: book.duplicated,
                  invalid: book.invalid
                })}</p>
                {book.ignored ? <p className="text-muted-foreground">{t('contacts.sheet.focusChatIgnored', { count: book.ignored })}</p> : null}
                {book.truncated && <p className="text-muted-foreground">{t('contacts.sheet.whatsappTruncated', { max: book.maxCreates })}</p>}
                {book.rows.length === 0 ? (
                  <p className="text-muted-foreground">{t('contacts.sheet.whatsappEmpty')}</p>
                ) : (
                  <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-3">
                    {book.rows.map((row) => (
                      <li key={row.phone}>
                        <span className="modern-badge-info">{t('contacts.sheet.create')}</span> {row.name}{' '}
                        <span className="font-mono text-xs text-muted-foreground">{row.phone}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        ) : (
          <>
        <p className="section-description mb-2">{t('contacts.sheet.importHint')}</p>
        <p className="section-description mb-5">{t('contacts.sheet.googleHint')}</p>

        <label className="field-label" htmlFor="import-sheet-file">{t('contacts.sheet.file')}</label>
        <input
          id="import-sheet-file"
          type="file"
          accept=".csv,.vcf,text/csv,text/vcard,text/x-vcard"
          className="modern-input"
          disabled={busy}
          onChange={(event) => void readFile(event.target.files?.[0])}
        />
        {busy && <p className="mt-3 text-sm text-muted-foreground" role="status">{t('contacts.sheet.reading')}</p>}

        {google && (
          <div className="mt-5 space-y-3 text-sm" data-testid="import-google-summary">
            <p className="font-semibold">{t('contacts.sheet.googleSummary', {
              file: fileName,
              total: google.total,
              creates: google.creates,
              existing: google.existing,
              duplicated: google.duplicated,
              invalid: google.invalid
            })}</p>
            {google.defaultDdd && <p className="text-muted-foreground">{t('contacts.sheet.googleDdd', { ddd: google.defaultDdd })}</p>}
            {google.truncated && <p className="text-muted-foreground">{t('contacts.sheet.whatsappTruncated', { max: google.maxCreates })}</p>}
            {google.rows.length === 0 ? (
              <p className="text-muted-foreground">{t('contacts.sheet.googleEmpty')}</p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-3">
                {google.rows.map((row) => (
                  <li key={row.phone}>
                    <span className="modern-badge-info">{t('contacts.sheet.create')}</span> {row.name}{' '}
                    <span className="font-mono text-xs text-muted-foreground">{row.phone}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {preview && (
          <div className="mt-5 space-y-4 text-sm">
            <p className="font-semibold">
              {t('contacts.sheet.summary', {
                file: fileName,
                total: preview.total,
                updates: preview.updates,
                creates: preview.creates,
                unchanged: preview.unchanged,
                errors: preview.errors.length
              })}
            </p>
            {preview.rows.length > 0 && (
              <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-3">
                {preview.rows.map((row) => (
                  <li key={row.line}>
                    <span className="font-mono text-xs text-muted-foreground">{t('contacts.sheet.line', { line: row.line })}</span>{' '}
                    <span className={row.kind === 'create' ? 'modern-badge-info' : 'modern-badge'}>
                      {t(row.kind === 'create' ? 'contacts.sheet.create' : 'contacts.sheet.update')}
                    </span>{' '}
                    {row.name || row.key} <span className="text-muted-foreground">· {row.fields.map((field) => (FIELD_LABELS[field] ? t(FIELD_LABELS[field]) : field)).join(', ')}</span>
                  </li>
                ))}
              </ul>
            )}
            {preview.errors.length > 0 && (
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-3 text-[hsl(var(--status-danger))]">
                {preview.errors.map((error) => (
                  <li key={error.line}>{t('contacts.sheet.line', { line: error.line })}: {error.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
          </>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button
            type="button"
            className="modern-button"
            disabled={busy || (fromBook
              ? !book || book.creates === 0
              : google ? google.creates === 0 : !preview || preview.updates + preview.creates === 0)}
            onClick={() => void apply()}
          >
            {t('contacts.sheet.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
