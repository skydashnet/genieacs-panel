'use client'

import { useEffect, useRef, useState } from 'react'
import { whatsappAPI, type WhatsAppContact, type WhatsAppConversation } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'

const SEARCH_DEBOUNCE_MS = 350
const RESULTS = 8

interface SubscriberLinkerProps {
  conversation: WhatsAppConversation
  onLinked: (conversation: WhatsAppConversation) => void
  onCancel: () => void
}

/**
 * "Whose number is this?", answered by the operator.
 *
 * For the thread the SGP could not resolve on its own — the subscriber writing
 * from a relative's phone, a new chip, a cadastre with no mobile. The search is
 * the contacts directory; picking a row links the thread. Saving the number on
 * the contract is offered only to whoever may correct numbers on the billing
 * screen, because it is the same write.
 */
export function SubscriberLinker({ conversation, onLinked, onCancel }: SubscriberLinkerProps) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const canSavePhone = can('campaigns.manage') && Boolean(conversation.waPhoneE164)

  const [search, setSearch] = useState('')
  const [results, setResults] = useState<WhatsAppContact[]>([])
  const [loading, setLoading] = useState(false)
  const [savePhone, setSavePhone] = useState(canSavePhone)
  const [linking, setLinking] = useState<string | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const canLookup = can('sgp.read')
  const seq = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    const term = search.trim()
    if (!term) {
      seq.current += 1
      setResults([])
      setLoading(false)
      return
    }
    const timer = setTimeout(async () => {
      const mine = ++seq.current
      setLoading(true)
      const res = await whatsappAPI.listContacts({ search: term, limit: RESULTS })
      if (!alive.current || mine !== seq.current) return
      setLoading(false)
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      setResults(res.data.contacts)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search, t, toast])

  /** The subscriber with no ONT in the panel, asked of the SGP by CPF/CNPJ or contract. */
  const lookupSgp = async () => {
    const term = search.trim()
    if (!term) return
    seq.current += 1
    setLookingUp(true)
    try {
      const res = await whatsappAPI.lookupContacts(term)
      if (!alive.current) return
      if (!res.success || !res.data) {
        toast.error(res.message || whatsappErrorMessage(t, res.code))
        return
      }
      setResults(res.data.contacts)
      if (res.data.contacts.length === 0) toast.info(t('whatsapp.contacts.lookupNone'))
    } catch {
      if (alive.current) toast.error(t('api.requestFailed'))
    } finally {
      if (alive.current) setLookingUp(false)
    }
  }

  const link = async (contact: WhatsAppContact) => {
    setLinking(contact.key)
    try {
      const res = await whatsappAPI.linkConversationSubscriber(
        conversation.id,
        contact.key,
        canSavePhone && savePhone
      )
      if (!alive.current) return
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      toast.success(t('whatsapp.inbox.linked', { name: contact.clientName || contact.contract || contact.key }))
      onLinked(res.data)
    } catch {
      if (alive.current) toast.error(t('api.requestFailed'))
    } finally {
      if (alive.current) setLinking(null)
    }
  }

  return (
    <div className="space-y-3 border-b border-border bg-muted/30 px-4 py-3" data-testid="wa-subscriber-linker">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{t('whatsapp.inbox.linkTitle')}</p>
        <button type="button" className="icon-button" aria-label={t('common.cancel')} onClick={onCancel}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <input
        type="search"
        className="modern-input"
        value={search}
        autoFocus
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('whatsapp.contacts.searchPlaceholder')}
        aria-label={t('whatsapp.contacts.searchPlaceholder')}
      />

      {canSavePhone && (
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={savePhone}
            onChange={(event) => setSavePhone(event.target.checked)}
          />
          <span>
            <span className="block font-medium text-foreground">{t('whatsapp.inbox.linkSavePhone')}</span>
            {t('whatsapp.inbox.linkSavePhoneHint')}
          </span>
        </label>
      )}

      {search.trim() && (
        <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-md border border-border bg-card">
          {results.length === 0 ? (
            <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm text-muted-foreground">
              <span>{loading || lookingUp ? t('common.loading') : t('whatsapp.contacts.noMatch')}</span>
              {!loading && canLookup && (
                <button
                  type="button"
                  className="modern-button-secondary"
                  disabled={lookingUp}
                  title={t('whatsapp.contacts.lookupHint')}
                  onClick={() => void lookupSgp()}
                >
                  <Icon name="search" size={14} />
                  {t('whatsapp.contacts.lookup')}
                </button>
              )}
            </li>
          ) : results.map((contact) => (
            <li key={contact.key}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start hover:bg-muted/50 disabled:opacity-60"
                disabled={linking !== null}
                onClick={() => void link(contact)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {contact.clientName || '—'}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {contact.contract
                      ? `${t('whatsapp.inbox.contract')}: ${contact.contract}`
                      : t('whatsapp.contacts.noContract')}
                    {contact.phone ? ` · ${contact.phone}` : ''}
                    {contact.hasDevice ? '' : ` · ${t('whatsapp.contacts.noDevice')}`}
                  </span>
                </span>
                <span className="modern-badge shrink-0">
                  <Icon
                    name={linking === contact.key ? 'refresh' : 'check'}
                    size={12}
                    className={linking === contact.key ? 'animate-spin' : ''}
                  />
                  {t('whatsapp.inbox.linkChoose')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
