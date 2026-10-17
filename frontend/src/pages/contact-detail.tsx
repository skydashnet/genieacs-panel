'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  contactsAPI,
  whatsappAPI,
  type ContactAddress,
  type ContactField,
  type ContactProfile,
  type ContactProfileField,
  type ContactProfilePatch,
  type ContactInvoiceMessage,
  type ContactInvoiceSettled,
  type SgpInvoice
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/contexts/auth-context'
import { sessionOwner } from '@/lib/session-owner'
import { useTranslation } from '@/contexts/language-context'
import { copyToClipboard, formatBrl, formatSgpDate, isSafeExternalUrl } from '@/lib/sgp'
import { isoDay } from '@/lib/date-format'
import { formatBrPhone } from '@/lib/phone'
import { ServiceStatusCard } from '@/components/contacts/service-status-card'
import { TeiahCard } from '@/components/contacts/teiah-card'
import { parseAmountToCents } from '@/lib/utils'

const ADDRESS_PARTS = ['street', 'number', 'complement', 'district', 'city', 'state', 'zip', 'reference'] as const

/** An address on one line, from its parts or as the SGP sent it. */
export function addressText(address: ContactAddress | null | undefined) {
  if (!address) return ''
  if (address.line) return address.line
  const street = [address.street, address.number].filter(Boolean).join(', ')
  const place = [address.district, [address.city, address.state].filter(Boolean).join('/')].filter(Boolean).join(' - ')
  return [street, address.complement, place, address.zip].filter(Boolean).join(' · ')
}

const phoneText = formatBrPhone

/**
 * A phone as it is typed: digits only, masked as it grows — (93) 9885-1993
 * becomes (93) 98851-9934 at the eleventh digit. A stored number (55 + DDD +
 * number) drops the country code; typing stops at eleven digits, so a DDD 55
 * typed by hand is never mistaken for it.
 */
function maskPhone(value: string) {
  let digits = value.replace(/\D/g, '')
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) digits = digits.slice(2)
  digits = digits.slice(0, 11)
  if (digits.length === 0) return ''
  if (digits.length <= 2) return `(${digits}`
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
}

const phoneDigits = (value: string) => value.replace(/\D/g, '')

function documentText(document: string | null) {
  const digits = String(document ?? '')
  if (digits.length === 11) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
  if (digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
  }
  return digits
}

export default function ContactDetailPage() {
  const { key = '' } = useParams()
  const { t, formatDate, formatDateTime } = useTranslation()
  // Um dia do cadastro (nascimento, cliente desde) no formato do provedor; o
  // que o SGP mandar fora do padrão aparece como veio, para nunca sumir.
  const day = (value: string | null | undefined) => {
    const iso = isoDay(value)
    return iso ? formatDate(iso) : (value || '—')
  }
  const { can, user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [profile, setProfile] = useState<ContactProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [editing, setEditing] = useState(false)
  const [opening, setOpening] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const canEdit = can('contacts.edit')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await contactsAPI.get(key)
    setLoading(false)
    if (!res.success || !res.data) {
      setNotFound(true)
      return
    }
    setNotFound(false)
    setProfile(res.data)
  }, [key])

  useEffect(() => { void load() }, [load])

  // The thread with this client in the panel's inbox: the one that exists, or
  // a new empty one. Opening sends nothing; the operator writes in the inbox.
  const openConversation = async (phone?: string) => {
    if (!profile) return
    setOpening(true)
    try {
      const res = await whatsappAPI.openContactConversation(profile.key, phone)
      if (!res.success || !res.data) {
        toast.error(res.message || t('api.requestFailed'))
        return
      }
      navigate('/whatsapp', { state: { conversation: res.data, owner: sessionOwner(user) } })
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setOpening(false)
    }
  }

  // Manual sync: this client from the SGP, and its ONTs asked to report now
  // (TR-069). The two halves are independent; the toast says how each went.
  const sync = async () => {
    setSyncing(true)
    try {
      const res = await contactsAPI.sync(key)
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.profile.syncFailed'))
        return
      }
      const { profile: fresh, sgp, devices } = res.data
      setProfile(fresh)
      const lines = [
        sgp.error
          ? t('contacts.profile.syncSgpError', { error: sgp.error })
          : sgp.skipped ? t('contacts.profile.syncSgpSkipped') : t('contacts.profile.syncSgpOk', { count: sgp.contracts })
      ]
      if (devices) {
        if (devices.length === 0) lines.push(t('contacts.profile.syncNoDevices'))
        for (const device of devices) {
          lines.push(device.error
            ? t('contacts.profile.syncDeviceError', { device: device.deviceId, error: device.error })
            : t(device.reached ? 'contacts.profile.syncDeviceReached' : 'contacts.profile.syncDeviceQueued', { device: device.deviceId }))
        }
      }
      const failed = Boolean(sgp.error) || Boolean(devices?.some((device) => device.error))
      if (failed) toast.error(lines.join(' · '))
      else toast.success(lines.join(' · '))
    } catch {
      toast.error(t('contacts.profile.syncFailed'))
    } finally {
      setSyncing(false)
    }
  }

  const save = async (patch: ContactProfilePatch) => {
    const res = await contactsAPI.update(key, patch)
    if (!res.success || !res.data) {
      toast.error(res.message || t('contacts.profile.saveFailed'))
      return false
    }
    setProfile(res.data)
    toast.success(t('contacts.profile.saved'))
    return true
  }

  if (!can('contacts.read')) {
    return (
      <div className="page-shell"><div className="page-frame">
        <p className="text-sm text-muted-foreground">{t('contacts.profile.noAccess')}</p>
      </div></div>
    )
  }

  if (loading && !profile) {
    return (
      <div className="page-shell"><div className="page-frame">
        <p className="text-sm text-muted-foreground">{t('contacts.profile.loading')}</p>
      </div></div>
    )
  }

  if (notFound || !profile) {
    return (
      <div className="page-shell"><div className="page-frame">
        <div className="empty-state">
          <h2 className="empty-state-title">{t('contacts.profile.notFound')}</h2>
          <button type="button" className="modern-button mt-5" onClick={() => navigate('/contacts')}>
            {t('contacts.profile.back')}
          </button>
        </div>
      </div></div>
    )
  }

  const { fields } = profile
  const restore = (field: ContactProfileField) => () => void save({ [field]: null })

  return (
    <div className="page-shell">
      <div className="page-frame" data-testid="contact-detail">
        <header className="page-header">
          <div className="min-w-0">
            <Link to="/contacts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground max-sm:-my-2 max-sm:min-h-10">
              <Icon name="back" size={14} /> {t('contacts.profile.back')}
            </Link>
            <h1 className="page-title wrap-break-word">{fields.name.value || '—'}</h1>
            <p className="page-description flex flex-wrap items-center gap-2">
              {profile.source === 'panel'
                ? <span className="modern-badge-info">{t('contacts.profile.sourcePanel')}</span>
                : profile.clientId && <span>{t('contacts.profile.sgpClient', { id: profile.clientId })}</span>}
              {profile.lastSeenAt && (
                <span>{t('contacts.profile.lastSeen', { time: formatDateTime(profile.lastSeenAt) })}</span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {profile.sgpUrl && isSafeExternalUrl(profile.sgpUrl) && (
              <a className="modern-button-secondary" href={profile.sgpUrl} target="_blank" rel="noreferrer">
                <Icon name="external" size={16} /> {t('contacts.profile.openInSgp')}
              </a>
            )}
            {canEdit && (
              <button
                type="button"
                className="modern-button-secondary"
                disabled={syncing}
                title={t('contacts.profile.syncHint')}
                onClick={() => void sync()}
              >
                <Icon name="refresh" size={16} /> {syncing ? t('contacts.profile.syncing') : t('contacts.profile.sync')}
              </button>
            )}
            <DevicesButton contracts={profile.contracts} />
            {can('whatsapp.send') && (
              <button
                type="button"
                className="modern-button-secondary"
                disabled={opening || !profile.whatsappPhone}
                title={profile.whatsappPhone ? undefined : t('contacts.profile.sendInvoiceNoPhone')}
                onClick={() => void openConversation()}
              >
                <Icon name="chat" size={16} /> {t('contacts.profile.openConversation')}
              </button>
            )}
            {canEdit && (
              <button type="button" className="modern-button" onClick={() => setEditing(true)}>
                <Icon name="edit" size={16} /> {t('contacts.profile.edit')}
              </button>
            )}
          </div>
        </header>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card title={t('contacts.profile.personal')}>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <FieldRow label={t('contacts.profile.name')} field={fields.name} canEdit={canEdit} onRestore={restore('name')}>
                {fields.name.value}
              </FieldRow>
              <FieldRow label={t('contacts.profile.personType')} field={fields.personType} canEdit={canEdit} onRestore={restore('personType')}>
                {fields.personType.value}
              </FieldRow>
              <FieldRow label={t('contacts.profile.document')} field={fields.document} canEdit={canEdit} onRestore={restore('document')}>
                {documentText(fields.document.value)}
              </FieldRow>
              <FieldRow label={t('contacts.profile.birthDate')} field={fields.birthDate} canEdit={canEdit} onRestore={restore('birthDate')}>
                {day(fields.birthDate.value)}
              </FieldRow>
              <FieldRow label={t('contacts.profile.gender')} field={fields.gender} canEdit={canEdit} onRestore={restore('gender')}>
                {fields.gender.value}
              </FieldRow>
              <Row label={t('contacts.profile.registeredAt')}>{day(profile.registeredAt)}</Row>
            </dl>
          </Card>

          <Card title={t('contacts.profile.address')}>
            <dl className="grid gap-x-6 gap-y-4">
              <FieldRow label={t('contacts.profile.address')} field={fields.address} canEdit={canEdit} onRestore={restore('address')}>
                {addressText(fields.address.value)}
              </FieldRow>
            </dl>
          </Card>

          <Card title={t('contacts.profile.contacts')}>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Row label={t('contacts.profile.whatsappPhone')}>
                {profile.whatsappPhone && (
                  <span className="flex flex-wrap items-center gap-2">
                    {phoneText(profile.whatsappPhone)}
                    {profile.whatsappPhoneSource === 'manual' && <span className="modern-badge-info">{t('contacts.profile.edited')}</span>}
                  </span>
                )}
              </Row>
              <FieldRow label={t('contacts.profile.phones')} field={fields.phones} canEdit={canEdit} onRestore={restore('phones')}>
                {fields.phones.value.length > 0 && (
                  <ul className="space-y-1">
                    {fields.phones.value.map((phone) => (
                      <li key={phone} className="flex items-center gap-2">
                        {phoneText(phone)}
                        {can('whatsapp.send') && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50 max-sm:-my-2 max-sm:min-h-10 max-sm:px-2"
                            disabled={opening}
                            title={t('contacts.profile.chatThisNumber')}
                            aria-label={`${t('contacts.profile.chatThisNumber')} ${phoneText(phone)}`}
                            onClick={() => void openConversation(phone)}
                          >
                            <Icon name="chat" size={14} /> {t('contacts.profile.chat')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </FieldRow>
              <FieldRow label={t('contacts.profile.emails')} field={fields.emails} canEdit={canEdit} onRestore={restore('emails')}>
                {fields.emails.value.length > 0 && (
                  <ul className="space-y-1 break-all">{fields.emails.value.map((email) => <li key={email}>{email}</li>)}</ul>
                )}
              </FieldRow>
            </dl>
          </Card>

          <Card title={t('contacts.profile.notes')}>
            <p className="whitespace-pre-wrap text-sm wrap-anywhere">{profile.notes || <span className="text-muted-foreground">—</span>}</p>
          </Card>
        </div>

        {can('devices.inspect') && <ServiceStatusCard contactKey={profile.key} hasContracts={profile.contracts.length > 0} />}
        {can('teiah.act') && canEdit && profile.teiahReady && (
          <TeiahCard profile={profile} onProfile={setProfile} onReload={load} />
        )}

        <Card title={t('contacts.profile.contracts')} className="mt-5">
          {profile.contracts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('contacts.profile.noContracts')}</p>
          ) : (
            <>
              <div className="desktop-table overflow-x-auto">
                <table className="modern-table w-full">
                  <thead>
                    <tr>
                      <th>{t('contacts.profile.contract')}</th>
                      <th>{t('contacts.profile.status')}</th>
                      <th>{t('contacts.profile.plan')}</th>
                      <th>{t('contacts.profile.dueDay')}</th>
                      <th>{t('contacts.profile.since')}</th>
                      <th>{t('contacts.profile.device')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.contracts.map((contract) => (
                      <tr key={contract.contract}>
                        <td className="font-mono">{contract.contract}</td>
                        <td>
                          {contract.status || '—'}
                          {contract.statusReason && <span className="block text-xs text-muted-foreground">{contract.statusReason}</span>}
                        </td>
                        <td>{contract.plan || '—'}</td>
                        <td>{contract.dueDay || '—'}</td>
                        <td>{day(contract.createdAt)}</td>
                        <td>
                          {contract.deviceId
                            ? <Link className="text-primary hover:underline wrap-anywhere" to={`/devices/detail?id=${encodeURIComponent(contract.deviceId)}`}>{contract.deviceId}</Link>
                            : <span className="text-muted-foreground">{t('contacts.profile.noDevice')}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* No celular, um bloco por contrato: seis colunas rolando de lado
                  escondiam o equipamento, que é o que se procura aqui. */}
              <ul className="mobile-card-list divide-y divide-border" role="list">
                {profile.contracts.map((contract) => (
                  <li key={contract.contract} className="space-y-1.5 py-3 text-sm first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="font-mono font-semibold">{contract.contract}</span>
                      <span>{contract.status || '—'}</span>
                    </div>
                    {contract.statusReason && <p className="text-xs text-muted-foreground">{contract.statusReason}</p>}
                    <p className="wrap-break-word">{contract.plan || '—'}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('contacts.profile.dueDay')}: {contract.dueDay || '—'} · {t('contacts.profile.since')}: {day(contract.createdAt)}
                    </p>
                    {contract.deviceId
                      ? <Link className="block break-all text-primary hover:underline" to={`/devices/detail?id=${encodeURIComponent(contract.deviceId)}`}>{contract.deviceId}</Link>
                      : <p className="text-muted-foreground">{t('contacts.profile.noDevice')}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        {profile.contracts.length > 0 && <InvoicesCard contactKey={profile.key} whatsappPhone={profile.whatsappPhone} settleMethods={profile.settle?.methods ?? null} />}

        {editing && (
          <EditModal
            profile={profile}
            onClose={() => setEditing(false)}
            onSave={async (patch) => {
              if (Object.keys(patch).length === 0) {
                setEditing(false)
                return
              }
              if (await save(patch)) setEditing(false)
            }}
          />
        )}
      </div>
    </div>
  )
}

function Card({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`modern-card p-5 sm:p-6 ${className}`}>
      <h2 className="section-heading mb-4">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-border pb-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm wrap-anywhere">{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  )
}

/** A field that an operator may have changed: the mark, and the way back to the SGP's value. */
function FieldRow<T>({ label, field, canEdit, onRestore, children }: {
  label: string
  field: ContactField<T>
  canEdit: boolean
  onRestore: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Row label={label}>
      {children}
      {field.edited && (
        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="modern-badge-info" title={field.editedBy ? t('contacts.profile.editedBy', { name: field.editedBy }) : undefined}>
            {t('contacts.profile.edited')}
          </span>
          {canEdit && (
            <button type="button" className="text-primary hover:underline" onClick={onRestore}>
              {t('contacts.profile.restore')}
            </button>
          )}
        </span>
      )}
    </Row>
  )
}

function InvoicesCard({ contactKey, whatsappPhone, settleMethods }: {
  contactKey: string
  whatsappPhone: string | null
  /** The payment methods "Receber" offers; `null` when settling is not set up. */
  settleMethods: string[] | null
}) {
  const { t, intlLocale } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [groups, setGroups] = useState<{ contract: string; invoices: SgpInvoice[] }[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState<string | null>(null)
  const [settling, setSettling] = useState<(SgpInvoice & { contract: string }) | null>(null)
  const canSend = can('whatsapp.send')
  const canSettle = can('contacts.settle') && Boolean(settleMethods?.length)

  const load = async () => {
    setLoading(true)
    const res = await contactsAPI.invoices(contactKey)
    setLoading(false)
    if (!res.success || !res.data) {
      toast.error(res.message || t('contacts.profile.invoicesFailed'))
      return
    }
    setGroups(res.data)
  }

  const all = groups?.flatMap((group) => group.invoices.map((invoice) => ({ ...invoice, contract: group.contract }))) ?? []

  return (
    <Card title={t('contacts.profile.invoices')} className="mt-5">
      {groups === null ? (
        <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void load()}>
          <Icon name="invoice" size={16} /> {loading ? t('contacts.profile.loading') : t('contacts.profile.loadInvoices')}
        </button>
      ) : all.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('contacts.profile.noInvoices')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {all.map((invoice, index) => (
            <li key={`${invoice.contract}-${invoice.id ?? index}`} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <span>
                <span className="font-semibold">{formatBrl(invoice.amount, intlLocale)}</span>
                <span className="ms-2 text-muted-foreground">{t('contacts.profile.dueOn', { date: formatSgpDate(invoice.dueDate, intlLocale) })}</span>
                <span className="ms-2 font-mono text-xs text-muted-foreground">{invoice.contract}</span>
              </span>
              <span className="flex flex-wrap gap-2">
                {invoice.digitableLine && (
                  <button type="button" className="modern-button-secondary" onClick={() => void copyToClipboard(invoice.digitableLine!).then(() => toast.success(t('contacts.profile.copied')))}>
                    <Icon name="copy" size={14} /> {t('contacts.profile.copyLine')}
                  </button>
                )}
                {invoice.pix && (
                  <button type="button" className="modern-button-secondary" onClick={() => void copyToClipboard(invoice.pix!).then(() => toast.success(t('contacts.profile.copied')))}>
                    <Icon name="copy" size={14} /> PIX
                  </button>
                )}
                {canSend && invoice.id && (
                  <button
                    type="button"
                    className="modern-button-secondary"
                    disabled={!whatsappPhone}
                    title={whatsappPhone ? undefined : t('contacts.profile.sendInvoiceNoPhone')}
                    onClick={() => setSending(invoice.id)}
                  >
                    <Icon name="chat" size={14} /> {t('contacts.profile.sendInvoice')}
                  </button>
                )}
                {canSettle && invoice.id && invoice.sgpId && (
                  <button type="button" className="modern-button" onClick={() => setSettling(invoice)}>
                    <Icon name="check" size={14} /> {t('contacts.profile.settle')}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {sending && <SendInvoiceModal contactKey={contactKey} invoiceId={sending} onClose={() => setSending(null)} />}
      {settling && settleMethods && (
        <SettleInvoiceModal
          contactKey={contactKey}
          invoice={settling}
          methods={settleMethods}
          canReceipt={canSend && Boolean(whatsappPhone)}
          onClose={() => setSettling(null)}
          onSettled={() => {
            setSettling(null)
            void load()
          }}
        />
      )}
    </Card>
  )
}

/**
 * The client's managed equipment: one ONT opens its page straight away; more
 * than one (a client with several contracts) opens a short list to pick from.
 */
function DevicesButton({ contracts }: { contracts: ContactProfile['contracts'] }) {
  const { t } = useTranslation()
  const devices = contracts.filter((contract) => contract.deviceId)
  if (devices.length === 0) {
    return (
      <button type="button" className="modern-button-secondary" disabled title={t('contacts.profile.noEquipment')}>
        <Icon name="wifi" size={16} /> {t('contacts.profile.equipment')}
      </button>
    )
  }
  if (devices.length === 1) {
    return (
      <Link className="modern-button-secondary" to={`/devices/detail?id=${encodeURIComponent(devices[0].deviceId!)}`}>
        <Icon name="wifi" size={16} /> {t('contacts.profile.equipment')}
      </Link>
    )
  }
  return (
    <details className="relative">
      <summary className="modern-button-secondary cursor-pointer list-none">
        <Icon name="wifi" size={16} /> {t('contacts.profile.equipments', { count: devices.length })}
      </summary>
      <ul className="modern-card absolute end-0 z-20 mt-2 min-w-64 p-2 text-sm shadow-lg">
        {devices.map((contract) => (
          <li key={contract.key}>
            <Link
              className="block rounded px-3 py-2 hover:bg-muted"
              to={`/devices/detail?id=${encodeURIComponent(contract.deviceId!)}`}
            >
              <span className="block font-semibold">{t('contacts.profile.equipmentContract', { contract: contract.contract })}</span>
              <span className="block break-all font-mono text-xs text-muted-foreground">{contract.deviceId}</span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Today in Brazil, where the SGP keeps its books: the default payment date. */
function todayInBrazil() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
}

/**
 * "Receber": the operator took the payment and settles the invoice on the SGP.
 * The amount starts at the invoice's own and may be changed (interest, a
 * discount); the server finds the invoice again before settling, so a second
 * click on one already paid is refused.
 */
function SettleInvoiceModal({ contactKey, invoice, methods, canReceipt, onClose, onSettled }: {
  contactKey: string
  invoice: SgpInvoice & { contract: string }
  methods: string[]
  canReceipt: boolean
  onClose: () => void
  onSettled: (result: ContactInvoiceSettled) => void
}) {
  const { t, intlLocale } = useTranslation()
  const toast = useToast()
  const [amount, setAmount] = useState(invoice.amount !== null ? invoice.amount.toFixed(2).replace('.', ',') : '')
  const [paidAt, setPaidAt] = useState(todayInBrazil)
  const [method, setMethod] = useState(methods[0] ?? '')
  const [receipt, setReceipt] = useState(canReceipt)
  const [busy, setBusy] = useState(false)
  const cents = parseAmountToCents(amount)
  const value = cents === null ? NaN : cents / 100
  const valid = cents !== null && cents > 0 && Boolean(paidAt) && paidAt <= todayInBrazil() && Boolean(method)

  const confirm = async () => {
    if (!invoice.id || busy) return
    setBusy(true)
    try {
      const res = await contactsAPI.settleInvoice(contactKey, invoice.id, { amount: value, paidAt, method, receipt: canReceipt && receipt })
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.profile.settleFailed'))
        return
      }
      const result = res.data
      if (result.receipt && !result.receipt.sent) {
        toast.error(t('contacts.profile.settleDoneReceiptFailed', { error: result.receipt.error || '' }))
      } else {
        toast.success(result.receipt?.sent ? t('contacts.profile.settleDoneReceipt') : t('contacts.profile.settleDone'))
      }
      onSettled(result)
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="settle-invoice-title">
      <div className="modal-panel modern-card max-w-md p-5 sm:p-6">
        <h2 id="settle-invoice-title" className="section-heading mb-1">{t('contacts.profile.settleTitle')}</h2>
        <p className="section-description mb-4">
          {t('contacts.profile.settleOf', {
            amount: formatBrl(invoice.amount, intlLocale),
            date: formatSgpDate(invoice.dueDate, intlLocale),
            contract: invoice.contract
          })}
        </p>
        <div className="grid gap-4">
          <div>
            <label className="field-label" htmlFor="settle-amount">{t('contacts.profile.settleAmount')}</label>
            <input
              id="settle-amount"
              className="modern-input w-full"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/[^\d.,]/g, ''))}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="settle-date">{t('contacts.profile.settleDate')}</label>
            <input
              id="settle-date"
              type="date"
              className="modern-input w-full"
              value={paidAt}
              max={todayInBrazil()}
              onChange={(event) => setPaidAt(event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="settle-method">{t('contacts.profile.settleMethod')}</label>
            <select id="settle-method" className="modern-input w-full" value={method} onChange={(event) => setMethod(event.target.value)}>
              {methods.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
          </div>
          {canReceipt && (
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={receipt}
                onChange={(event) => setReceipt(event.target.checked)}
              />
              {t('contacts.profile.settleReceipt')}
            </label>
          )}
        </div>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="modern-button" disabled={busy || !valid} onClick={() => void confirm()}>
            <Icon name="check" size={16} /> {busy ? t('contacts.profile.settling') : t('contacts.profile.settleConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The text the server suggests for one invoice, edited if the operator wants,
 * then queued like any reply. The line, the PIX and the link in the preview
 * come from the SGP, asked again when the modal opens.
 */
function SendInvoiceModal({ contactKey, invoiceId, onClose }: { contactKey: string; invoiceId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [preview, setPreview] = useState<ContactInvoiceMessage | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<Awaited<ReturnType<typeof contactsAPI.sendInvoice>>['data'] | null>(null)

  useEffect(() => {
    let alive = true
    contactsAPI.invoiceMessage(contactKey, invoiceId)
      .then((res) => {
        if (!alive) return
        if (!res.success || !res.data) {
          setError(res.message || t('contacts.profile.sendInvoiceFailed'))
          return
        }
        setPreview(res.data)
        setText(res.data.text)
      })
      .catch(() => { if (alive) setError(t('api.requestFailed')) })
    return () => { alive = false }
  }, [contactKey, invoiceId, t])

  const send = async () => {
    setBusy(true)
    try {
      const res = await contactsAPI.sendInvoice(contactKey, invoiceId, text)
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.profile.sendInvoiceFailed'))
        return
      }
      toast.success(t('contacts.profile.sendInvoiceDone'))
      setSent(res.data)
    } catch {
      toast.error(t('api.requestFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="send-invoice-title">
      <div className="modal-panel modern-card max-w-xl p-5 sm:p-6">
        <h2 id="send-invoice-title" className="section-heading mb-1">{t('contacts.profile.sendInvoiceTitle')}</h2>
        {preview?.phone && (
          <p className="section-description mb-4">{t('contacts.profile.sendInvoiceTo', { phone: phoneText(preview.phone) })}</p>
        )}

        {error ? (
          <p className="text-sm text-[hsl(var(--status-warning))]" role="status">{error}</p>
        ) : !preview ? (
          <p className="text-sm text-muted-foreground">{t('contacts.profile.loading')}</p>
        ) : sent ? (
          <p className="text-sm">{t('contacts.profile.sendInvoiceDone')}</p>
        ) : (
          <>
            <label className="field-label" htmlFor="send-invoice-text">{t('contacts.profile.sendInvoiceText')}</label>
            <textarea
              id="send-invoice-text"
              className="modern-input min-h-64 font-mono text-xs"
              value={text}
              maxLength={4000}
              onChange={(event) => setText(event.target.value)}
            />
          </>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>
            {sent ? t('common.close') : t('common.cancel')}
          </button>
          {sent ? (
            <button type="button" className="modern-button" onClick={() => navigate('/whatsapp', { state: { conversation: sent.conversation, owner: sessionOwner(user) } })}>
              <Icon name="chat" size={16} /> {t('contacts.profile.openConversation')}
            </button>
          ) : (
            <button type="button" className="modern-button" disabled={busy || !preview || !text.trim()} onClick={() => void send()}>
              <Icon name="chat" size={16} /> {busy ? t('contacts.profile.sending') : t('contacts.profile.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

interface EditForm {
  name: string
  personType: string
  document: string
  gender: string
  birthDate: string
  address: Record<(typeof ADDRESS_PARTS)[number], string>
  phones: string[]
  emails: string
  whatsappPhone: string
  notes: string
}

function formFrom(profile: ContactProfile): EditForm {
  const address = profile.fields.address.value ?? {}
  return {
    name: profile.fields.name.value ?? '',
    personType: profile.fields.personType.value ?? '',
    document: profile.fields.document.value ?? '',
    gender: profile.fields.gender.value ?? '',
    birthDate: profile.fields.birthDate.value ?? '',
    address: Object.fromEntries(ADDRESS_PARTS.map((part) => [
      part, part === 'street' && !address.street && address.line ? address.line : (address[part] ?? '')
    ])) as EditForm['address'],
    phones: profile.fields.phones.value.length > 0 ? profile.fields.phones.value.map(maskPhone) : [''],
    emails: profile.fields.emails.value.join('\n'),
    whatsappPhone: maskPhone(profile.whatsappPhone ?? ''),
    notes: profile.notes ?? ''
  }
}

const lines = (value: string) => value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean)

/** Only what the operator changed goes to the server: an untouched field stays the SGP's. */
function patchFrom(before: EditForm, after: EditForm): ContactProfilePatch {
  const patch: ContactProfilePatch = {}
  for (const field of ['name', 'personType', 'document', 'gender', 'birthDate'] as const) {
    if (after[field].trim() !== before[field].trim()) patch[field] = after[field].trim() || null
  }
  if (ADDRESS_PARTS.some((part) => after.address[part].trim() !== before.address[part].trim())) {
    patch.address = Object.fromEntries(ADDRESS_PARTS.map((part) => [part, after.address[part].trim()]).filter(([, value]) => value))
  }
  const phonesOf = (form: EditForm) => form.phones.map(phoneDigits).filter(Boolean)
  if (phonesOf(after).join() !== phonesOf(before).join()) patch.phones = phonesOf(after)
  if (lines(after.emails).join() !== lines(before.emails).join()) patch.emails = lines(after.emails)
  if (phoneDigits(after.whatsappPhone) !== phoneDigits(before.whatsappPhone)) patch.whatsappPhone = phoneDigits(after.whatsappPhone) || null
  if (after.notes !== before.notes) patch.notes = after.notes.trim() || null
  return patch
}

function EditModal({ profile, onClose, onSave }: {
  profile: ContactProfile
  onClose: () => void
  onSave: (patch: ContactProfilePatch) => Promise<void>
}) {
  const { t } = useTranslation()
  const [initial] = useState(() => formFrom(profile))
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const set = (field: keyof EditForm) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [field]: event.target.value }))
  const setPhone = (index: number, value: string) =>
    setForm((current) => ({ ...current, phones: current.phones.map((phone, at) => (at === index ? maskPhone(value) : phone)) }))
  // The last field empties instead of going away, so there is always one to type in.
  const removePhone = (index: number) =>
    setForm((current) => {
      const phones = current.phones.filter((_, at) => at !== index)
      return { ...current, phones: phones.length > 0 ? phones : [''] }
    })
  const setAddress = (part: (typeof ADDRESS_PARTS)[number]) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, address: { ...current.address, [part]: event.target.value } }))

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="contact-edit-title">
      <div className="modal-panel modern-card max-w-3xl p-5 sm:p-6">
        <h2 id="contact-edit-title" className="section-heading mb-1">{t('contacts.profile.editTitle')}</h2>
        <p className="section-description mb-5">{t('contacts.profile.editHint')}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput id="contact-name" label={t('contacts.profile.name')} value={form.name} onChange={set('name')} wide />
          <div>
            <label className="field-label" htmlFor="contact-person-type">{t('contacts.profile.personType')}</label>
            <select id="contact-person-type" className="modern-input" value={form.personType} onChange={set('personType')}>
              <option value="">—</option>
              <option value="PF">{t('contacts.profile.personPf')}</option>
              <option value="PJ">{t('contacts.profile.personPj')}</option>
            </select>
          </div>
          <TextInput id="contact-document" label={t('contacts.profile.document')} value={form.document} onChange={set('document')} />
          <TextInput id="contact-birth" label={t('contacts.profile.birthDate')} value={form.birthDate} onChange={set('birthDate')} />
          <TextInput id="contact-gender" label={t('contacts.profile.gender')} value={form.gender} onChange={set('gender')} />

          <h3 className="mt-2 font-semibold sm:col-span-2">{t('contacts.profile.address')}</h3>
          {ADDRESS_PARTS.map((part) => (
            <TextInput
              key={part}
              id={`contact-address-${part}`}
              label={t(`contacts.profile.addressPart.${part}`)}
              value={form.address[part]}
              onChange={setAddress(part)}
              wide={part === 'street' || part === 'reference'}
            />
          ))}

          <h3 className="mt-2 font-semibold sm:col-span-2">{t('contacts.profile.contacts')}</h3>
          <div>
            <label className="field-label" htmlFor="contact-whatsapp">{t('contacts.profile.whatsappPhone')}</label>
            <input
              id="contact-whatsapp"
              className="modern-input"
              type="tel"
              inputMode="numeric"
              placeholder="(00) 00000-0000"
              value={form.whatsappPhone}
              onChange={(event) => setForm((current) => ({ ...current, whatsappPhone: maskPhone(event.target.value) }))}
            />
          </div>
          <div />
          <div>
            <span className="field-label">{t('contacts.profile.phones')}</span>
            <div className="space-y-2">
              {form.phones.map((phone, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    id={index === 0 ? 'contact-phones' : undefined}
                    className="modern-input"
                    type="tel"
                    inputMode="numeric"
                    placeholder="(00) 00000-0000"
                    aria-label={`${t('contacts.profile.phones')} ${index + 1}`}
                    value={phone}
                    onChange={(event) => setPhone(index, event.target.value)}
                  />
                  <button
                    type="button"
                    className="modern-button-secondary shrink-0"
                    aria-label={t('contacts.profile.removePhone')}
                    title={t('contacts.profile.removePhone')}
                    onClick={() => removePhone(index)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="modern-button-secondary"
                disabled={form.phones.length >= 20}
                onClick={() => setForm((current) => ({ ...current, phones: [...current.phones, ''] }))}
              >
                <Icon name="phone" size={14} /> {t('contacts.profile.addPhone')}
              </button>
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor="contact-emails">{t('contacts.profile.emails')}</label>
            <textarea id="contact-emails" className="modern-input min-h-24" value={form.emails} onChange={set('emails')} />
            <p className="field-hint">{t('contacts.profile.onePerLine')}</p>
          </div>
          <div className="sm:col-span-2">
            <label className="field-label" htmlFor="contact-notes">{t('contacts.profile.notes')}</label>
            <textarea id="contact-notes" className="modern-input min-h-24" value={form.notes} onChange={set('notes')} />
          </div>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button
            type="button"
            className="modern-button"
            disabled={saving || !form.name.trim()}
            onClick={async () => {
              setSaving(true)
              await onSave(patchFrom(initial, form))
              setSaving(false)
            }}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function TextInput({ id, label, value, onChange, wide = false }: {
  id: string
  label: string
  value: string
  onChange: (event: { target: { value: string } }) => void
  wide?: boolean
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} className="modern-input" value={value} onChange={onChange} />
    </div>
  )
}
