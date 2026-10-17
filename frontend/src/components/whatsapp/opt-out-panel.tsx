'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type WhatsAppContact, type WhatsAppOptOut } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import { OptOutTypeBadges, OptOutTypePicker } from './opt-out-types'
import { ALL_OPT_OUT_TYPES, categoriesFor, selectionFor, type OptOutType } from '@/lib/wa-optout-types'

/** Same pause as the contacts search: one request per word, not per letter. */
const SEARCH_DEBOUNCE_MS = 350

/**
 * What to call the entry.
 *
 * The phone is what the campaign asks about, so it leads. A row that only ever
 * had a LID — someone who wrote in from an account WhatsApp gave us no number
 * for — still has to be revocable, so the chain never ends empty.
 */
function optOutAddress(entry: WhatsAppOptOut): string {
  return entry.waPhoneE164 || entry.waLid || `#${entry.id}`
}

/**
 * The list of people the provider must not open a conversation with.
 *
 * Self-contained: it owns its own fetch, its own form and its own refusals.
 */
export function OptOutPanel() {
  const { t, intlLocale, formatDateTime } = useTranslation()
  const toast = useToast()

  const [entries, setEntries] = useState<WhatsAppOptOut[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [phone, setPhone] = useState('')
  const [reason, setReason] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')
  const [revokingId, setRevokingId] = useState<number | null>(null)
  // Which kinds to stop sending. All ticked is the "do not disturb" of old.
  const [types, setTypes] = useState<OptOutType[]>([...ALL_OPT_OUT_TYPES])
  // The client picked from the search, instead of a typed number.
  const [picked, setPicked] = useState<WhatsAppContact | null>(null)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [results, setResults] = useState<WhatsAppContact[]>([])
  const [searching, setSearching] = useState(false)
  // The entry whose kinds are being edited, and its pending selection.
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editTypes, setEditTypes] = useState<OptOutType[]>([])
  const [savingEdit, setSavingEdit] = useState(false)

  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const res = await whatsappAPI.listOptOuts()
    if (!alive.current) return
    if (res.success && Array.isArray(res.data)) {
      setEntries(res.data)
      setLoadError('')
    } else {
      setLoadError(whatsappErrorMessage(t, res.code))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  // The newest request wins: a slow answer for "ben" must not overwrite the
  // answer for "benedita" that arrived first.
  const searchSeq = useRef(0)
  useEffect(() => {
    if (debounced.length < 2) {
      setResults([])
      return
    }
    const seq = ++searchSeq.current
    setSearching(true)
    void whatsappAPI.listContacts({ search: debounced, limit: 8 }).then((res) => {
      if (!alive.current || seq !== searchSeq.current) return
      setResults(res.success && res.data ? res.data.contacts : [])
      setSearching(false)
    })
  }, [debounced])

  const stamp = useCallback(
    (iso: string | null) => {
      if (!iso) return ''
      return formatDateTime(iso)
    },
    [formatDateTime]
  )

  const add = useCallback(async () => {
    // The picked client's number wins over whatever is typed.
    const typed = (picked?.phone || phone).trim()
    if (!typed || types.length === 0) return
    setAdding(true)
    setAddError('')
    // The number is normalised by the SERVER, not here: the campaign asks in
    // the normalised form, and a second normaliser in the browser is a second
    // thing to drift. What comes back is what was stored.
    const res = await whatsappAPI.createOptOut({
      phone: typed,
      reasonText: reason.trim() || undefined,
      categories: categoriesFor(types)
    })
    if (!alive.current) return
    setAdding(false)
    if (!res.success) {
      const message = whatsappErrorMessage(t, res.code)
      setAddError(message)
      toast.error(message)
      return
    }
    setPhone('')
    setReason('')
    setPicked(null)
    setSearch('')
    setTypes([...ALL_OPT_OUT_TYPES])
    toast.success(t('common.success'))
    await load()
  }, [load, phone, picked, reason, t, toast, types])

  const saveEdit = useCallback(async (entry: WhatsAppOptOut) => {
    if (editTypes.length === 0) return
    setSavingEdit(true)
    const res = await whatsappAPI.updateOptOut(entry.id, categoriesFor(editTypes))
    if (!alive.current) return
    setSavingEdit(false)
    if (!res.success) {
      toast.error(whatsappErrorMessage(t, res.code))
      return
    }
    setEditingId(null)
    toast.success(t('common.success'))
    await load()
  }, [editTypes, load, t, toast])

  const revoke = useCallback(
    async (entry: WhatsAppOptOut) => {
      // A confirm, because the outcome is not "a row disappears": it is that
      // the provider may again START a conversation with somebody who asked for
      // silence. That is the sentence the dialog says out loud.
      if (!window.confirm(t('whatsapp.optOut.confirmRevoke', { phone: optOutAddress(entry) }))) return
      setRevokingId(entry.id)
      const res = await whatsappAPI.revokeOptOut(entry.id)
      if (!alive.current) return
      setRevokingId(null)
      if (!res.success) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      toast.success(t('common.success'))
      await load()
    },
    [load, t, toast]
  )

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="section-heading">{t('whatsapp.optOut.title')}</h2>
          <p className="section-description">{t('whatsapp.optOut.description')}</p>
        </div>
        <button
          type="button"
          className="modern-button-secondary shrink-0"
          onClick={() => void load()}
          disabled={loading}
        >
          <Icon name="refresh" size={16} />
          {t('common.refresh')}
        </button>
      </header>

      <form
        className="modern-card flex flex-col gap-4 p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <div>
          <label className="field-label" htmlFor="wa-optout-search">
            {t('whatsapp.optOut.search')}
          </label>
          {picked ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-[hsl(var(--surface-subtle))] px-3 py-2" data-testid="wa-optout-picked">
              <span className="min-w-0 text-sm">
                <span className="font-semibold">{picked.clientName || picked.contract}</span>
                {picked.contract && <span className="text-muted-foreground"> · {t('whatsapp.optOut.contract', { contract: picked.contract })}</span>}
                <span className="font-mono text-muted-foreground"> · {picked.phone}</span>
              </span>
              <button type="button" className="modern-button-secondary" onClick={() => setPicked(null)}>
                <Icon name="x" size={14} />
                {t('whatsapp.optOut.clearClient')}
              </button>
            </div>
          ) : (
            <>
              <input
                id="wa-optout-search"
                type="search"
                className="modern-input"
                value={search}
                placeholder={t('whatsapp.optOut.searchPlaceholder')}
                autoComplete="off"
                onChange={(event) => setSearch(event.target.value)}
              />
              {debounced.length >= 2 && (
                <ul className="mt-2 divide-y divide-border rounded-md border border-border" role="list" data-testid="wa-optout-results">
                  {results.length === 0 ? (
                    <li className="px-3 py-2 text-sm text-muted-foreground">
                      {searching ? t('common.loading') : t('whatsapp.optOut.searchEmpty')}
                    </li>
                  ) : results.map((contact) => (
                    <li key={contact.key}>
                      <button
                        type="button"
                        className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={!contact.phone}
                        onClick={() => {
                          setPicked(contact)
                          setSearch('')
                          setAddError('')
                        }}
                      >
                        <span className="min-w-0">
                          <span className="font-semibold">{contact.clientName || contact.contract}</span>
                          {contact.contract && <span className="text-muted-foreground"> · {t('whatsapp.optOut.contract', { contract: contact.contract })}</span>}
                        </span>
                        <span className="flex items-center gap-2">
                          {contact.optedOut && <span className="modern-badge-error">{t('whatsapp.optOut.types.everything')}</span>}
                          {!contact.optedOut && contact.optOutCategories && <span className="modern-badge-warning">{t('whatsapp.optOut.alreadyPartial')}</span>}
                          <span className="font-mono text-xs text-muted-foreground">{contact.phone || t('whatsapp.optOut.noPhone')}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="wa-optout-phone">
              {t(picked ? 'whatsapp.optOut.phoneOrPicked' : 'whatsapp.optOut.phone')}
            </label>
            <input
              id="wa-optout-phone"
              className="modern-input font-mono"
              value={picked?.phone ?? phone}
              disabled={Boolean(picked)}
              inputMode="tel"
              autoComplete="off"
              onChange={(event) => {
                setPhone(event.target.value)
                setAddError('')
              }}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="wa-optout-reason">
              {t('whatsapp.optOut.reason')}
            </label>
            <input
              id="wa-optout-reason"
              className="modern-input"
              value={reason}
              autoComplete="off"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>

        <OptOutTypePicker value={types} onChange={setTypes} idPrefix="wa-optout-new" />

        {addError && (
          <p className="flex items-start gap-2 rounded-md border border-[hsl(var(--status-danger)/0.3)] bg-[hsl(var(--status-danger)/0.08)] p-3 text-xs leading-5 text-[hsl(var(--status-danger))]">
            <Icon name="warning" size={16} />
            <span>{addError}</span>
          </p>
        )}

        <div>
          <button type="submit" className="modern-button" disabled={!(picked?.phone || phone).trim() || types.length === 0 || adding}>
            <Icon name="bell" size={16} />
            {t('whatsapp.optOut.add')}
          </button>
        </div>
      </form>

      {loadError && (
        <p className="flex items-center gap-2 text-sm text-[hsl(var(--status-danger))]">
          <Icon name="warning" size={16} />
          {loadError}
        </p>
      )}

      {loading && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : entries.length === 0 ? (
        <div className="modern-card">
          <div className="empty-state">
            <div className="empty-state-icon">
              <Icon name="bell" size={22} />
            </div>
            <p className="empty-state-title">{t('whatsapp.optOut.empty')}</p>
          </div>
        </div>
      ) : (
        <ul className="modern-card divide-y divide-border" role="list">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {entry.clientName && (
                    <span className="truncate text-sm font-semibold text-foreground">{entry.clientName}</span>
                  )}
                  <span className={`truncate font-mono text-sm ${entry.clientName ? 'text-muted-foreground' : 'font-semibold text-foreground'}`}>
                    {optOutAddress(entry)}
                  </span>
                  {/* Who put them here changes what revoking means: a customer
                      who wrote "PARAR" asked for this themselves. */}
                  <span className={entry.origin === 'customer' ? 'modern-badge-warning' : 'modern-badge'}>
                    <Icon name={entry.origin === 'customer' ? 'chat' : 'settings'} size={12} />
                    {t(entry.origin === 'customer' ? 'whatsapp.optOut.originCustomer' : 'whatsapp.optOut.originOperator')}
                  </span>
                </div>
                <div className="mt-1.5">
                  <OptOutTypeBadges categories={entry.categories} />
                </div>
                {editingId === entry.id && (
                  <div className="mt-3 flex flex-col gap-3 rounded-md border border-border p-3">
                    <OptOutTypePicker value={editTypes} onChange={setEditTypes} idPrefix={`wa-optout-edit-${entry.id}`} />
                    <div className="flex gap-2">
                      <button type="button" className="modern-button" disabled={savingEdit || editTypes.length === 0} onClick={() => void saveEdit(entry)}>
                        <Icon name="check" size={16} />
                        {t('whatsapp.optOut.editSave')}
                      </button>
                      <button type="button" className="modern-button-secondary" onClick={() => setEditingId(null)}>
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}
                {entry.reasonText && (
                  <p className="mt-1.5 wrap-break-word text-sm leading-5 text-muted-foreground">{entry.reasonText}</p>
                )}
                {entry.createdAt && (
                  <p className="mt-1.5 font-mono text-[0.68rem] tabular-nums text-muted-foreground">
                    {stamp(entry.createdAt)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  className="modern-button-secondary"
                  data-testid="wa-optout-edit"
                  onClick={() => {
                    setEditingId(entry.id)
                    setEditTypes(selectionFor(entry.categories))
                  }}
                >
                  <Icon name="edit" size={16} />
                  {t('whatsapp.optOut.edit')}
                </button>
                <button
                  type="button"
                  className="modern-button-secondary"
                  onClick={() => void revoke(entry)}
                  disabled={revokingId === entry.id}
                >
                  <Icon name="x" size={16} />
                  {t('whatsapp.optOut.revoke')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
