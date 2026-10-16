import { useState } from 'react'
import { contactsAPI, type ContactProfile } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatBrPhone } from '@/lib/phone'

function addressLine(address: { street?: string; number?: string; district?: string; city?: string; state?: string; zip?: string }) {
  const street = [address.street, address.number].filter(Boolean).join(', ')
  const place = [address.district, [address.city, address.state].filter(Boolean).join('/')].filter(Boolean).join(' - ')
  return [street, place, address.zip].filter(Boolean).join(' · ')
}

function riskBadge(risk: string | null) {
  const value = (risk ?? '').toUpperCase()
  if (value.startsWith('BAIX')) return 'modern-badge-success'
  if (value.startsWith('ALT')) return 'modern-badge-error'
  return 'modern-badge-warning'
}

/**
 * "TeiaH Valid" on the record: what the TeiaH knows about this CPF/CNPJ — score
 * and risk, the mother's name, other addresses, and the phones and e-mails it
 * has that the record lacks. Asking is an operator's act (it costs a call and
 * sends the document out); adding to the record is a second, explicit click.
 */
export function TeiahCard({ profile, onProfile, onReload }: {
  profile: ContactProfile
  onProfile: (profile: ContactProfile) => void
  onReload: () => Promise<void>
}) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const teiah = profile.teiah ?? null

  const knownPhones = new Set(profile.fields.phones.value)
  const knownEmails = new Set(profile.fields.emails.value)
  const newPhones = teiah ? teiah.phones.filter((phone) => !knownPhones.has(phone)) : []
  const newEmails = teiah ? teiah.emails.filter((email) => !knownEmails.has(email)) : []
  const canAdd = newPhones.length > 0 || newEmails.length > 0 || (teiah?.phones.length && !profile.whatsappPhone)

  const consult = async () => {
    setBusy(true)
    try {
      const res = await contactsAPI.teiahConsult(profile.key)
      if (!res.success) {
        toast.error(res.message || t('contacts.profile.teiahFailed'))
        return
      }
      await onReload()
    } catch {
      toast.error(t('contacts.profile.teiahFailed'))
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    setBusy(true)
    try {
      const res = await contactsAPI.teiahApply(profile.key)
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.profile.teiahFailed'))
        return
      }
      onProfile(res.data.profile)
      toast.success(t('contacts.profile.teiahApplied', { phones: res.data.phonesAdded, emails: res.data.emailsAdded }))
    } catch {
      toast.error(t('contacts.profile.teiahFailed'))
    } finally {
      setBusy(false)
    }
  }

  const line = (label: string, value: string | null | undefined) => (
    value ? (
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-muted-foreground">{label}:</dt>
        <dd className="font-medium wrap-anywhere">{value}</dd>
      </div>
    ) : null
  )

  return (
    <section className="modern-card mt-5 p-5 sm:p-6" data-testid="teiah-card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-heading">{t('contacts.profile.teiah')}</h2>
        <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => void consult()}>
          <Icon name="refresh" size={16} className={busy ? 'animate-spin' : ''} />
          {' '}{t(teiah ? 'contacts.profile.teiahRefresh' : 'contacts.profile.teiahConsult')}
        </button>
      </div>

      {!teiah && <p className="text-sm text-muted-foreground">{t('contacts.profile.teiahNever')}</p>}
      {teiah && !teiah.found && <p className="text-sm text-muted-foreground">{t('contacts.profile.teiahNotFound')}</p>}

      {teiah?.found && (
        <div className="space-y-3 text-sm">
          {teiah.deceased && (
            <p className="text-[hsl(var(--status-warning))]" role="status">{t('contacts.profile.teiahDeceased')}</p>
          )}
          <dl className="grid gap-1 sm:grid-cols-2">
            {teiah.score && (
              <div className="flex flex-wrap items-center gap-x-2">
                <dt className="text-muted-foreground">{t('contacts.profile.teiahScore')}:</dt>
                <dd className="flex items-center gap-2 font-medium">
                  {teiah.score.score ?? '—'}
                  {teiah.score.risk && <span className={riskBadge(teiah.score.risk)}>{teiah.score.risk}</span>}
                </dd>
              </div>
            )}
            {line(t('contacts.profile.teiahPayment'), teiah.score?.paymentProbability ?? teiah.score?.paymentDescription)}
            {line(t('contacts.profile.teiahMother'), teiah.motherName)}
          </dl>

          {teiah.addresses.length > 0 && (
            <div>
              <p className="mb-1 text-muted-foreground">{t('contacts.profile.teiahAddresses')}:</p>
              <ul className="space-y-1">{teiah.addresses.map((address, index) => <li key={index} className="wrap-anywhere">{addressLine(address)}</li>)}</ul>
            </div>
          )}

          {(teiah.phones.length > 0 || teiah.emails.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-muted-foreground">{t('contacts.profile.teiahPhones')}:</p>
                <ul className="space-y-1">
                  {teiah.phones.map((phone) => (
                    <li key={phone} className="flex items-center gap-2">
                      <span className="font-mono">{formatBrPhone(phone)}</span>
                      {knownPhones.has(phone) && <span className="modern-badge">{t('contacts.profile.teiahInRecord')}</span>}
                    </li>
                  ))}
                  {teiah.phones.length === 0 && <li className="text-muted-foreground">—</li>}
                </ul>
              </div>
              <div>
                <p className="mb-1 text-muted-foreground">{t('contacts.profile.teiahEmails')}:</p>
                <ul className="space-y-1">
                  {teiah.emails.map((email) => (
                    <li key={email} className="flex items-center gap-2 break-all">
                      <span>{email}</span>
                      {knownEmails.has(email) && <span className="modern-badge">{t('contacts.profile.teiahInRecord')}</span>}
                    </li>
                  ))}
                  {teiah.emails.length === 0 && <li className="text-muted-foreground">—</li>}
                </ul>
              </div>
            </div>
          )}

          {canAdd ? (
            <button type="button" className="modern-button" disabled={busy} onClick={() => void apply()}>
              <Icon name="check" size={16} /> {t('contacts.profile.teiahApply')}
            </button>
          ) : null}
        </div>
      )}

      {teiah && <p className="mt-3 text-xs text-muted-foreground">{t('contacts.profile.teiahConsultedAt', { date: formatDateTime(teiah.consultedAt) })}</p>}
    </section>
  )
}
