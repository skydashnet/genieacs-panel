'use client'

import { useState } from 'react'
import { useNavigate } from 'react-router'
import { contactsAPI, type ContactDocumentLookup } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import type { TranslationKey } from '@/lib/i18n/dictionary'

type AddressField = 'zip' | 'street' | 'number' | 'complement' | 'district' | 'city' | 'state' | 'reference'

const EMPTY_FORM = {
  name: '',
  tradeName: '',
  responsibleName: '',
  responsibleDocument: '',
  birthDate: '',
  whatsappPhone: '',
  email: '',
  zip: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  state: '',
  reference: '',
  latitude: undefined as number | undefined,
  longitude: undefined as number | undefined
}

type Form = typeof EMPTY_FORM

const ADDRESS_FIELDS: [AddressField, TranslationKey, string][] = [
  ['street', 'contacts.profile.addressPart.street', 'sm:col-span-4'],
  ['number', 'contacts.profile.addressPart.number', 'sm:col-span-2'],
  ['complement', 'contacts.profile.addressPart.complement', 'sm:col-span-3'],
  ['district', 'contacts.profile.addressPart.district', 'sm:col-span-3'],
  ['city', 'contacts.profile.addressPart.city', 'sm:col-span-4'],
  ['state', 'contacts.profile.addressPart.state', 'sm:col-span-2'],
  ['reference', 'contacts.profile.addressPart.reference', 'sm:col-span-6']
]

/** CPF 000.000.000-00, CNPJ 00.000.000/0000-00, as it is typed. */
function maskDocument(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 14)
  if (digits.length <= 11) {
    return digits
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2')
  }
  return digits
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d{1,2})$/, '$1-$2')
}

/**
 * "Novo cliente", in two steps.
 *
 * The CPF/CNPJ first: the panel asks the SGP whether the client is already
 * there (and then offers the record instead of a duplicate) and, for a company
 * nobody has, fills the form from the Receita. A CPF has no public source, so a
 * person is typed by hand. Then the form — and, for whoever may write to the
 * ERP, "Cadastrar também no SGP", which creates the client there first and
 * files it here under the SGP's own id.
 */
export function NewContactModal({ onClose }: { onClose: () => void }) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { can } = useAuth()

  const [document, setDocument] = useState('')
  const [looking, setLooking] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookup, setLookup] = useState<ContactDocumentLookup | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [inSgp, setInSgp] = useState(true)
  const [saving, setSaving] = useState(false)
  const [cepLooking, setCepLooking] = useState(false)

  const isCompany = lookup?.personType === 'PJ'
  const canCreateInSgp = can('sgp.act') && Boolean(lookup?.sgpChecked)
  const toSgp = canCreateInSgp && inSgp
  const set = (field: keyof Form, value: string) => setForm((current) => ({ ...current, [field]: value }))

  const open = (key: string) => navigate(`/contacts/${encodeURIComponent(key)}`)

  const runLookup = async (fresh = false) => {
    // A new consultation is a paid call; ask first when the panel already holds one.
    if (fresh && !window.confirm(t('contacts.new.teiahRefreshConfirm', { date: lookup?.teiahConsultedAt ? formatDateTime(lookup.teiahConsultedAt) : '' }))) return
    setLooking(true)
    setLookupError(null)
    setLookup(null)
    setShowForm(false)
    try {
      const res = await contactsAPI.lookupDocument(document, fresh)
      if (!res.success || !res.data) {
        setLookupError(res.message || t('contacts.new.invalidDocument'))
        return
      }
      const found = res.data
      setLookup(found)
      if (found.inSgp.length > 0 || found.inPanel) return
      const prefill = found.prefill
      setForm({
        ...EMPTY_FORM,
        ...(prefill ? {
          name: prefill.name ?? '',
          tradeName: prefill.tradeName ?? '',
          birthDate: prefill.birthDate ?? '',
          email: prefill.email ?? '',
          whatsappPhone: prefill.phone ?? '',
          zip: (prefill.address.zip ?? '').replace(/\D/g, '').slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2'),
          street: prefill.address.street ?? '',
          number: prefill.address.number ?? '',
          complement: prefill.address.complement ?? '',
          district: prefill.address.district ?? '',
          city: prefill.address.city ?? '',
          state: prefill.address.state ?? ''
        } : {})
      })
      setShowForm(true)
    } finally {
      setLooking(false)
    }
  }

  const fillFromCep = async () => {
    const digits = form.zip.replace(/\D/g, '')
    if (digits.length !== 8) return
    setCepLooking(true)
    try {
      const res = await contactsAPI.lookupCep(digits)
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.new.cepNotFound'))
        return
      }
      const data = res.data
      // What the CEP knows replaces only what is still empty: an address the
      // Receita or the operator already wrote stays.
      setForm((current) => ({
        ...current,
        street: current.street || data.addressLine || '',
        district: current.district || data.district || '',
        city: current.city || data.city || '',
        state: current.state || data.state || '',
        latitude: data.lat ?? current.latitude,
        longitude: data.lng ?? current.longitude
      }))
    } finally {
      setCepLooking(false)
    }
  }

  const missingForSgp = !form.name.trim() || !form.street.trim() || !form.district.trim() || !form.city.trim()
    || !/^[A-Za-z]{2}$/.test(form.state.trim()) || form.zip.replace(/\D/g, '').length !== 8

  const save = async () => {
    setSaving(true)
    const address = {
      street: form.street.trim(),
      number: form.number.trim(),
      complement: form.complement.trim(),
      district: form.district.trim(),
      city: form.city.trim(),
      state: form.state.trim().toUpperCase(),
      zip: form.zip.replace(/\D/g, ''),
      reference: form.reference.trim()
    }
    const res = toSgp
      ? await contactsAPI.createInSgp({
        document: lookup?.document ?? '',
        name: form.name.trim(),
        ...(isCompany ? {
          tradeName: form.tradeName.trim(),
          responsibleName: form.responsibleName.trim(),
          responsibleDocument: form.responsibleDocument.trim()
        } : {}),
        email: form.email.trim(),
        whatsappPhone: form.whatsappPhone.trim(),
        birthDate: form.birthDate,
        address: { ...address, latitude: form.latitude, longitude: form.longitude }
      })
      : await contactsAPI.create({
        name: form.name.trim(),
        ...(lookup?.document ? { document: lookup.document, personType: lookup.personType } : {}),
        ...(form.whatsappPhone.trim() ? { whatsappPhone: form.whatsappPhone.trim() } : {}),
        ...(form.email.trim() ? { emails: [form.email.trim()] } : {}),
        ...(form.birthDate ? { birthDate: form.birthDate } : {}),
        ...(Object.values(address).some(Boolean)
          ? { address: Object.fromEntries(Object.entries(address).filter(([, value]) => value)) }
          : {})
      })
    setSaving(false)
    if (!res.success || !res.data) {
      toast.error(res.message || t('contacts.profile.saveFailed'))
      return
    }
    toast.success(t(toSgp ? 'contacts.new.createdInSgp' : 'contacts.profile.created'))
    open(res.data.key)
  }

  const documentDigits = document.replace(/\D/g, '')

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-contact-title">
      <div className="modal-panel modern-card max-h-[92vh] w-full max-w-2xl overflow-y-auto p-5 sm:p-6" data-testid="new-contact-modal">
        <h2 id="new-contact-title" className="section-heading mb-1">{t('contacts.profile.new')}</h2>
        <p className="section-description mb-5">{t('contacts.new.documentHint')}</p>

        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => { event.preventDefault(); void runLookup() }}
        >
          <div className="flex-1">
            <label className="field-label" htmlFor="new-contact-document">{t('contacts.profile.document')}</label>
            <input
              id="new-contact-document"
              className="modern-input font-mono"
              inputMode="numeric"
              autoComplete="off"
              value={document}
              placeholder="000.000.000-00"
              onChange={(event) => {
                setDocument(maskDocument(event.target.value))
                setLookup(null)
                setLookupError(null)
              }}
            />
          </div>
          <button
            type="submit"
            className="modern-button"
            disabled={looking || (documentDigits.length !== 11 && documentDigits.length !== 14)}
          >
            <Icon name="search" size={16} className={looking ? 'animate-spin' : ''} />
            {t('contacts.new.lookup')}
          </button>
        </form>
        {lookupError && (
          <p className="mt-2 text-sm text-destructive" role="alert">{lookupError}</p>
        )}

        {lookup && lookup.inSgp.length > 0 && (
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3" data-testid="new-contact-in-sgp">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Icon name="check" size={16} />
              {t('contacts.new.inSgp')}
            </p>
            <ul className="mt-2 space-y-2">
              {lookup.inSgp.map((client) => (
                <li key={client.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    {client.name || '—'}
                    {client.contract && <span className="ms-2 font-mono text-xs text-muted-foreground">{client.contract}</span>}
                  </span>
                  <button type="button" className="modern-button-secondary" onClick={() => open(client.key)}>
                    <Icon name="external" size={16} />
                    {t('contacts.new.open')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {lookup && lookup.inSgp.length === 0 && lookup.inPanel && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
            <span><span className="font-semibold">{t('contacts.new.inPanel')}</span> · {lookup.inPanel.name || '—'}</span>
            <button type="button" className="modern-button-secondary" onClick={() => open(lookup.inPanel!.key)}>
              <Icon name="external" size={16} />
              {t('contacts.new.open')}
            </button>
          </div>
        )}

        {!lookup && !showForm && (
          <button type="button" className="mt-3 text-sm text-muted-foreground underline max-sm:min-h-10" onClick={() => { setForm(EMPTY_FORM); setShowForm(true) }}>
            {t('contacts.new.withoutDocument')}
          </button>
        )}

        {showForm && (
          <>
            {lookup && (
              <p className="mt-4 flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
                <Icon name="info" size={16} />
                <span>
                  {!lookup.sgpChecked
                    ? t('contacts.new.sgpNotChecked')
                    : lookup.prefill?.source === 'teiah'
                      ? t('contacts.new.teiahPrefilled')
                      : isCompany
                        ? t(lookup.prefill ? 'contacts.new.cnpjPrefilled' : 'contacts.new.cnpjFailed')
                        : t(lookup.teiahConsulted ? 'contacts.new.teiahNotFound' : 'contacts.new.cpfNoSource')}
                </span>
              </p>
            )}
            {lookup?.teiahCached && lookup.teiahConsultedAt && (
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="new-contact-teiah-cached">
                <span>{t('contacts.new.teiahCachedNote', { date: formatDateTime(lookup.teiahConsultedAt) })}</span>
                <button type="button" className="font-semibold text-primary hover:underline" disabled={looking} onClick={() => void runLookup(true)}>
                  {t('contacts.new.teiahRefresh')}
                </button>
              </p>
            )}
            {lookup?.deceased && (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                <Icon name="warning" size={16} />
                <span>{t('contacts.new.teiahDeceased')}</span>
              </p>
            )}
            {lookup?.teiahScore && (
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border p-3 text-sm" data-testid="new-contact-teiah-score">
                <span className="font-semibold">
                  {t('contacts.new.teiahScore', { score: lookup.teiahScore.score ?? '—' })}
                </span>
                {lookup.teiahScore.risk && (
                  <span className="text-muted-foreground">{t('contacts.new.teiahRisk', { risk: lookup.teiahScore.risk })}</span>
                )}
                {lookup.teiahScore.paymentDescription && (
                  <span className="text-muted-foreground">{lookup.teiahScore.paymentDescription}</span>
                )}
                {lookup.teiahScore.paymentProbability && (
                  <span className="text-muted-foreground">
                    {t('contacts.new.teiahPaymentProbability', { value: lookup.teiahScore.paymentProbability })}
                  </span>
                )}
              </div>
            )}

            <div className="mt-4 grid gap-4 sm:grid-cols-6">
              <div className="sm:col-span-6">
                <label className="field-label" htmlFor="new-contact-name">
                  {t(isCompany ? 'contacts.new.legalName' : 'contacts.profile.name')}
                </label>
                <input id="new-contact-name" className="modern-input" value={form.name} onChange={(event) => set('name', event.target.value)} />
              </div>
              {isCompany && (
                <>
                  <div className="sm:col-span-6">
                    <label className="field-label" htmlFor="new-contact-trade">{t('contacts.new.tradeName')}</label>
                    <input id="new-contact-trade" className="modern-input" value={form.tradeName} onChange={(event) => set('tradeName', event.target.value)} />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="field-label" htmlFor="new-contact-resp">{t('contacts.new.responsibleName')}</label>
                    <input id="new-contact-resp" className="modern-input" value={form.responsibleName} onChange={(event) => set('responsibleName', event.target.value)} />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="field-label" htmlFor="new-contact-resp-doc">{t('contacts.new.responsibleDocument')}</label>
                    <input
                      id="new-contact-resp-doc"
                      className="modern-input font-mono"
                      inputMode="numeric"
                      value={form.responsibleDocument}
                      onChange={(event) => set('responsibleDocument', maskDocument(event.target.value).slice(0, 14))}
                    />
                  </div>
                </>
              )}
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="new-contact-birth">
                  {t(isCompany ? 'contacts.new.foundedAt' : 'contacts.profile.birthDate')}
                </label>
                <input id="new-contact-birth" type="date" className="modern-input" value={form.birthDate} onChange={(event) => set('birthDate', event.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="new-contact-whatsapp">{t('contacts.profile.whatsappPhone')}</label>
                <input id="new-contact-whatsapp" className="modern-input" inputMode="tel" value={form.whatsappPhone} onChange={(event) => set('whatsappPhone', event.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="new-contact-email">{t('contacts.new.email')}</label>
                <input id="new-contact-email" type="email" className="modern-input" value={form.email} onChange={(event) => set('email', event.target.value)} />
              </div>

              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="new-contact-zip">{t('contacts.profile.addressPart.zip')}</label>
                <input
                  id="new-contact-zip"
                  className="modern-input font-mono"
                  inputMode="numeric"
                  value={form.zip}
                  onChange={(event) => set('zip', event.target.value.replace(/\D/g, '').slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2'))}
                  onBlur={() => void fillFromCep()}
                />
              </div>
              <p className="self-end pb-2 text-xs text-muted-foreground sm:col-span-4">
                {cepLooking ? t('contacts.profile.loading') : t('contacts.new.zipHint')}
              </p>
              {ADDRESS_FIELDS.map(([field, labelKey, span]) => (
                <div key={field} className={span}>
                  <label className="field-label" htmlFor={`new-contact-${field}`}>{t(labelKey)}</label>
                  <input
                    id={`new-contact-${field}`}
                    className="modern-input"
                    value={form[field]}
                    maxLength={field === 'state' ? 2 : undefined}
                    onChange={(event) => set(field, field === 'state' ? event.target.value.toUpperCase() : event.target.value)}
                  />
                </div>
              ))}
            </div>

            {canCreateInSgp && (
              <label className="mt-5 flex items-start gap-3">
                <input type="checkbox" className="mt-1" checked={inSgp} onChange={(event) => setInSgp(event.target.checked)} />
                <span className="text-sm">
                  <span className="block font-semibold">{t('contacts.new.createInSgp')}</span>
                  <span className="text-muted-foreground">{t('contacts.new.createInSgpHint')}</span>
                </span>
              </label>
            )}
            {toSgp && missingForSgp && (
              <p className="mt-2 text-xs text-[hsl(var(--status-warning))]">{t('contacts.new.requiredForSgp')}</p>
            )}
          </>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          {showForm && (
            <button
              type="button"
              className="modern-button"
              disabled={saving || !form.name.trim() || (toSgp && missingForSgp)}
              onClick={() => void save()}
            >
              {toSgp ? t('contacts.new.createInSgp') : t('common.save')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
