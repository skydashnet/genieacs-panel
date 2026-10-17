import { useCallback, useEffect, useRef, useState } from 'react'
import { contactsAPI, type ContactTeiahPending } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { formatBrPhone } from '@/lib/phone'

/**
 * "Buscar telefones na TeiaH": the active clients with no phone, asked of the
 * TeiaH a block at a time, then listed with what it found. Asking only files
 * the answers on the records; nothing reaches a client's phones until the
 * operator ticks rows and applies — and applying reads those saved answers, it
 * never asks (or pays) again.
 */
export function TeiahPhonesModal({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const { t, formatNumber } = useTranslation()
  const toast = useToast()
  const [rows, setRows] = useState<ContactTeiahPending[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; remaining: number | null } | null>(null)
  const [applying, setApplying] = useState(false)
  const stop = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadRows = useCallback(async () => {
    const res = await contactsAPI.teiahPending()
    if (!alive.current) return
    if (!res.success || !res.data) {
      toast.error(res.message || t('contacts.teiahPhones.failed'))
      return
    }
    setRows(res.data.rows)
    setSelected(new Set(res.data.rows.map((row) => row.key)))
  }, [t, toast])

  useEffect(() => { void loadRows() }, [loadRows])

  const scan = async () => {
    stop.current = false
    setScanning(true)
    let done = 0
    try {
      for (;;) {
        const res = await contactsAPI.teiahScan()
        if (!alive.current) return
        if (!res.success || !res.data) {
          toast.error(res.message || t('contacts.teiahPhones.failed'))
          break
        }
        done += res.data.processed
        setProgress({ done, remaining: res.data.remaining })
        if (res.data.remaining === 0 || res.data.processed === 0 || stop.current) break
      }
    } catch {
      if (alive.current) toast.error(t('contacts.teiahPhones.failed'))
    } finally {
      if (alive.current) {
        setScanning(false)
        await loadRows()
      }
    }
  }

  const apply = async () => {
    if (selected.size === 0) return
    setApplying(true)
    try {
      const res = await contactsAPI.teiahApplyMany([...selected])
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.teiahPhones.failed'))
        return
      }
      toast.success(t('contacts.teiahPhones.applied', {
        clients: res.data.clients, phones: res.data.phonesAdded, emails: res.data.emailsAdded
      }))
      onApplied()
    } catch {
      toast.error(t('contacts.teiahPhones.failed'))
    } finally {
      if (alive.current) setApplying(false)
    }
  }

  const toggle = (key: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const allSelected = rows !== null && rows.length > 0 && selected.size === rows.length

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="teiah-phones-title">
      <div className="modal-panel modern-card max-w-3xl p-5 sm:p-6" data-testid="teiah-phones">
        <h2 id="teiah-phones-title" className="section-heading">{t('contacts.teiahPhones.title')}</h2>
        <p className="field-hint mt-1">{t('contacts.teiahPhones.intro')}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {scanning ? (
            <button type="button" className="modern-button-secondary" onClick={() => { stop.current = true }}>
              <Icon name="stop" size={16} /> {t('contacts.teiahPhones.stop')}
            </button>
          ) : (
            <button type="button" className="modern-button" disabled={applying} onClick={() => void scan()}>
              <Icon name="search" size={16} /> {t(progress ? 'contacts.teiahPhones.more' : 'contacts.teiahPhones.start')}
            </button>
          )}
          {scanning && <Icon name="refresh" size={16} className="animate-spin text-muted-foreground" />}
          {progress && (
            <span className="text-sm text-muted-foreground" role="status">
              {t('contacts.teiahPhones.progress', { done: formatNumber(progress.done), remaining: formatNumber(progress.remaining ?? 0) })}
            </span>
          )}
        </div>

        <div className="mt-4">
          {rows === null && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
          {rows !== null && rows.length === 0 && <p className="text-sm text-muted-foreground">{t('contacts.teiahPhones.none')}</p>}
          {rows !== null && rows.length > 0 && (
            <>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.key)))}
                  />
                  {t('contacts.teiahPhones.selectAll')}
                </label>
                <span className="text-muted-foreground">{t('contacts.teiahPhones.found', { count: formatNumber(rows.length) })}</span>
              </div>
              <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
                <table className="modern-table w-full text-sm">
                  <thead>
                    <tr>
                      <th scope="col" className="w-8" />
                      <th scope="col">{t('contacts.teiahPhones.client')}</th>
                      <th scope="col">{t('contacts.teiahPhones.phones')}</th>
                      <th scope="col">{t('contacts.teiahPhones.emails')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={row.name ?? row.key}
                            checked={selected.has(row.key)}
                            onChange={() => toggle(row.key)}
                          />
                        </td>
                        <td className="font-medium wrap-anywhere">{row.name || '—'}</td>
                        <td className="font-mono">{row.phones.map((phone) => <div key={phone}>{formatBrPhone(phone)}</div>)}</td>
                        <td className="break-all">{row.emails.map((email) => <div key={email}>{email}</div>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" disabled={applying} onClick={onClose}>{t('common.close')}</button>
          <button
            type="button"
            className="modern-button"
            disabled={applying || scanning || selected.size === 0}
            onClick={() => void apply()}
          >
            {t('contacts.teiahPhones.apply', { count: formatNumber(selected.size) })}
          </button>
        </div>
      </div>
    </div>
  )
}
