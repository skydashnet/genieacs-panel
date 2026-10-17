'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ContactLink } from './contact-link'
import { variableLabel } from './wa-variables'
import {
  whatsappAPI,
  type WhatsAppOverdueSubscriber,
  type WhatsAppSkipCounts,
  type WhatsAppTemplate
} from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { whatsappErrorMessage } from '@/components/whatsapp-connection'
import type { TranslationKey } from '@/lib/i18n'

/**
 * The billing cadence.
 *
 * This screen exists to make one rule visible: BUILDING IS NOT SENDING.
 * `buildBillingCampaign` returns a draft and queues nothing, so the button is
 * "Build campaign" and the only thing that comes back is a draft plus the
 * reasons some subscribers did not make it into it. The click that actually
 * reaches hundreds of phones lives on the campaigns screen, behind its own
 * confirmation — messaging a town is never the side effect of a listing.
 */

/** Days of arrears the window opens on by default — the server's own defaults. */
const DEFAULT_DAYS_MIN = 1
const DEFAULT_DAYS_MAX = 90
const DEFAULT_LIMIT = 50

/**
 * The six skip reasons, in the order the operator can act on them.
 *
 * They are SIX NUMBERS, never one. "412 left out" tells whoever is running the
 * cadence nothing they can do something about; "83 with no mobile on record,
 * 12 asked not to be contacted" names one problem for the cadastre and another
 * that must be respected. Each reason therefore carries its own key, and the
 * panel never adds them together.
 */
type SkipCountKey = Exclude<keyof WhatsAppSkipCounts, 'missing'>

const SKIP_REASONS: { key: SkipCountKey; label: TranslationKey }[] = [
  { key: 'noPhone', label: 'whatsapp.billing.skippedNoPhone' },
  { key: 'optOut', label: 'whatsapp.billing.skippedOptOut' },
  { key: 'noInvoice', label: 'whatsapp.billing.skippedNoInvoice' },
  { key: 'futureOnly', label: 'whatsapp.billing.skippedFutureOnly' },
  { key: 'sgpRefused', label: 'whatsapp.billing.skippedSgpRefused' },
  { key: 'templateIncomplete', label: 'whatsapp.billing.skippedTemplateIncomplete' }
]

/** A célula da tabela de devedores quando, no celular, ela vira lista. */
const MOBILE_CELL = 'max-md:block max-md:border-0! max-md:px-1! max-md:py-0.5!'

/**
 * A body citing `{{dias_para_vencer}}` IS a reminder — the same test the
 * dispatcher runs (`modeloEhLembrete`, utils/wa/waCobranca.js). The two
 * variables are exclusive mirrors: on an overdue invoice `dias_para_vencer`
 * renders empty and on a future one `dias_atraso` does, and a body with an
 * empty required variable is discarded rather than sent half-written. Mirroring
 * the regex here lets the panel say which kind a template is BEFORE the build,
 * instead of leaving the operator to infer it from a skip count afterwards.
 */
function isReminderTemplate(body: string): boolean {
  return /\{\{\s*dias_para_vencer\s*\}\}/.test(body)
}

/** Matches the panel's other money, which is the provider's own currency. */
function currency(amount: number | null, intlLocale: string): string {
  if (amount === null || Number.isNaN(amount)) return '—'
  return amount.toLocaleString(intlLocale, { style: 'currency', currency: 'BRL' })
}

/** Parses a signed day bound, keeping the field usable while it is being typed. */
function toDays(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

export function BillingPanel() {
  const { t, intlLocale, formatDate } = useTranslation()
  const toast = useToast()

  const [daysMin, setDaysMin] = useState(String(DEFAULT_DAYS_MIN))
  const [daysMax, setDaysMax] = useState(String(DEFAULT_DAYS_MAX))
  const [search, setSearch] = useState('')

  const [rows, setRows] = useState<WhatsAppOverdueSubscriber[]>([])
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [templateName, setTemplateName] = useState('')
  const [campaignTitle, setCampaignTitle] = useState('')

  const [loading, setLoading] = useState(true)
  const [building, setBuilding] = useState(false)
  const [built, setBuilt] = useState<{ recipients: number; skipped: WhatsAppSkipCounts } | null>(null)

  // Re-armed on mount, not just cleared on unmount: this panel lives in a tab
  // strip, so it is mounted again every time the operator comes back to it, and
  // a flag left false would leave every later response quietly dropped.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  /**
   * The listing is the slowest route in the panel ON PURPOSE — one round trip
   * to the ERP per subscriber, paced at ~150 ms, against the same box that is
   * answering the phone queue right now. So it is fetched when the operator
   * asks for a window, never on every keystroke.
   */
  const loadOverdue = useCallback(async () => {
    setLoading(true)
    try {
      const res = await whatsappAPI.listOverdue({
        daysMin: toDays(daysMin, DEFAULT_DAYS_MIN),
        daysMax: toDays(daysMax, DEFAULT_DAYS_MAX),
        search: search.trim() || undefined,
        limit: DEFAULT_LIMIT
      })
      if (!alive.current) return
      if (!res.success || !res.data) {
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      setRows(res.data)
      // A selection is only meaningful against the rows it was made on: keeping
      // contracts that the new window no longer lists would build a campaign
      // for people the operator can no longer see.
      setSelected(new Set())
      setBuilt(null)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [daysMax, daysMin, search, t, toast])

  const loadTemplates = useCallback(async () => {
    const res = await whatsappAPI.listTemplates()
    if (!alive.current) return
    if (!res.success || !res.data) {
      toast.error(whatsappErrorMessage(t, res.code))
      return
    }
    setTemplates(res.data)
  }, [t, toast])

  useEffect(() => {
    void loadOverdue()
    void loadTemplates()
    // Mount only: re-running on every keystroke is what the Apply button is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const template = useMemo(
    () => templates.find((entry) => entry.name === templateName) ?? null,
    [templateName, templates]
  )

  const toggle = useCallback((contract: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(contract)) next.delete(contract)
      else next.add(contract)
      return next
    })
  }, [])

  const allSelected = rows.length > 0 && selected.size === rows.length
  const toggleAll = useCallback(() => {
    setSelected((current) => (current.size === rows.length
      ? new Set<string>()
      : new Set(rows.map((row) => row.contract))))
  }, [rows])

  /**
   * How many of the CURRENT selection have no number to dial. Shown before the
   * build, with the same words the skip count uses afterwards, because a
   * cadastre gap is worth fixing rather than discovering at the end.
   */
  const selectedWithoutPhone = useMemo(
    () => rows.filter((row) => selected.has(row.contract) && !row.phone).length,
    [rows, selected]
  )

  // ── Correcting the number ────────────────────────────────────────────
  //
  // The whole cadence hangs off this field, and until this editor existed the
  // only way to fix a number the ERP had wrong was an UPDATE typed against the
  // database. It is edited HERE, in the row that already shows the number and
  // says where it came from, because this listing is where an operator finds
  // out a number is wrong — a subscriber sitting in `noPhone` run after run.
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [savingPhone, setSavingPhone] = useState(false)

  const openEditor = useCallback((row: WhatsAppOverdueSubscriber) => {
    setEditing(row.contract)
    // Seeded with the override only. Prefilling the ERP's number would turn
    // "leave it blank to use the ERP record" into a value the operator has to
    // delete, and the first save would copy the stale number into the override
    // — freezing exactly the thing this field exists to correct.
    setDraft(row.phoneSource === 'manual' ? (row.phone ?? '') : '')
  }, [])

  const closeEditor = useCallback(() => {
    setEditing(null)
    setDraft('')
  }, [])

  const savePhone = useCallback(async (contract: string) => {
    setSavingPhone(true)
    try {
      // An empty draft is a CLEAR, not a skipped save: it withdraws the
      // override and hands the contract back to the ERP record.
      const res = await whatsappAPI.setSubscriberPhone(contract, draft.trim())
      if (!alive.current) return
      if (!res.success || !res.data) {
        // The machine code, never the server's message: the operator reads the
        // panel's language, and the server answers in its own.
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      const saved = res.data
      // Patched in place rather than reloaded. A reload here would be one SGP
      // round trip per subscriber — the slowest route in the panel — to
      // re-answer a question about invoices that correcting a phone number
      // cannot have changed. Only the two fields the write touches are taken;
      // the amount and due date on screen stay the ones already fetched.
      setRows((current) => current.map((row) => (row.contract === contract
        ? { ...row, phone: saved.phone, phoneSource: saved.phoneSource }
        : row)))
      // Both are said out loud, and they say different things. A clear replaces
      // what was typed with the ERP's number, which looks like the save went
      // wrong unless the swap is named; a set is worth confirming because what
      // it really did is take precedence over the ERP from now on — the row
      // alone cannot say that.
      toast.success(t(saved.phoneSource === 'manual'
        ? 'whatsapp.billing.phoneSaved'
        : 'whatsapp.billing.phoneCleared'))
      closeEditor()
    } finally {
      if (alive.current) setSavingPhone(false)
    }
  }, [closeEditor, draft, t, toast])

  const build = useCallback(async () => {
    if (!template || selected.size === 0) return
    setBuilding(true)
    try {
      const res = await whatsappAPI.buildBillingCampaign({
        template: template.name,
        contracts: [...selected],
        title: campaignTitle.trim() || undefined
      })
      if (!alive.current) return
      if (!res.success || !res.data) {
        // The server attaches `skipped` to a 409 `no_recipients` so that "every
        // one of them is on the do-not-disturb list" survives the refusal. The
        // shared api client rebuilds the envelope from `success/message/code`
        // on a non-2xx and drops it, so this read is defensive: it renders the
        // breakdown the day the client forwards it, and costs nothing until.
        const carried = (res as { skipped?: WhatsAppSkipCounts }).skipped
        if (carried) setBuilt({ recipients: 0, skipped: carried })
        toast.error(whatsappErrorMessage(t, res.code))
        return
      }
      setBuilt({ recipients: res.data.recipients, skipped: res.data.skipped })
      toast.success(t('whatsapp.broadcast.draftCreated', { count: res.data.recipients }))
      // A second, quieter toast for the ones who did not make it, naming the
      // reasons rather than a total. It survives scrolling away from the panel.
      const left = SKIP_REASONS
        .filter((reason) => res.data!.skipped[reason.key] > 0)
        .map((reason) => t(reason.label, { count: res.data!.skipped[reason.key] }))
      if (left.length > 0) toast.warning(t('whatsapp.billing.skipped', { reasons: left.join(', ') }))
    } finally {
      if (alive.current) setBuilding(false)
    }
  }, [campaignTitle, selected, t, template, toast])

  // "Missing: PIX (12), boleto link (3)" — which field to fix in the SGP.
  const missingBreakdown = useMemo(() => {
    const entries = Object.entries(built?.skipped.missing ?? {}).filter(([, count]) => count > 0)
    if (entries.length === 0) return null
    return t('whatsapp.dunning.skip.templateMissing', {
      names: entries.map(([name, count]) => `${variableLabel(t, name)} (${count})`).join(', ')
    })
  }, [built, t])

  const skippedReasons = useMemo(() => {
    if (!built) return []
    return SKIP_REASONS
      .map((reason) => ({ ...reason, count: built.skipped[reason.key] }))
      .filter((reason) => reason.count > 0)
  }, [built])

  return (
    <section className="space-y-5">
      <header>
        <h2 className="section-heading">{t('whatsapp.billing.title')}</h2>
        <p className="section-description">{t('whatsapp.billing.description')}</p>
      </header>

      {/* ── The window ────────────────────────────────────────────────── */}
      <div className="modern-card p-4 sm:p-5">
        <h3 className="field-label mb-3">{t('whatsapp.billing.dueWindow')}</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="wa-billing-min" className="field-label">
              {t('whatsapp.billing.windowFrom')}
            </label>
            <input
              id="wa-billing-min"
              type="number"
              className="modern-input"
              value={daysMin}
              onChange={(event) => setDaysMin(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="wa-billing-max" className="field-label">
              {t('whatsapp.billing.windowTo')}
            </label>
            <input
              id="wa-billing-max"
              type="number"
              className="modern-input"
              value={daysMax}
              onChange={(event) => setDaysMax(event.target.value)}
            />
          </div>
          <div className="lg:col-span-2">
            <label htmlFor="wa-billing-search" className="field-label">
              {t('whatsapp.billing.searchPlaceholder')}
            </label>
            <input
              id="wa-billing-search"
              type="search"
              className="modern-input"
              placeholder={t('whatsapp.billing.searchPlaceholder')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void loadOverdue() }}
            />
          </div>
        </div>
        {/* The window is one signed line, not two filters: −3 is "due in three
            days" and 30 is "thirty days late". It is what lets the same screen
            prepare a reminder and a dunning run. */}
        <p className="field-hint">{t('whatsapp.billing.windowHint')}</p>
        <div className="mt-4">
          <button
            type="button"
            className="modern-button-secondary"
            disabled={loading}
            onClick={() => void loadOverdue()}
          >
            <Icon name="refresh" size={16} />
            {loading ? t('common.loading') : t('common.apply')}
          </button>
        </div>
      </div>

      {/* ── The template ──────────────────────────────────────────────── */}
      <div className="modern-card p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="wa-billing-template" className="field-label">
              {t('whatsapp.billing.template')}
            </label>
            <select
              id="wa-billing-template"
              className="modern-input"
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
            >
              <option value="">{t('whatsapp.billing.templatePick')}</option>
              {templates.map((entry) => (
                <option key={entry.id} value={entry.name}>{entry.name}</option>
              ))}
            </select>
            {template && (
              <p className="mt-2">
                <span className={isReminderTemplate(template.body) ? 'modern-badge-info' : 'modern-badge-warning'}>
                  {isReminderTemplate(template.body)
                    ? t('whatsapp.templates.isReminder')
                    : t('whatsapp.templates.isDunning')}
                </span>
              </p>
            )}
          </div>
          <div>
            <label htmlFor="wa-billing-title" className="field-label">
              {t('whatsapp.billing.campaignTitle')}
            </label>
            <input
              id="wa-billing-title"
              type="text"
              className="modern-input"
              value={campaignTitle}
              onChange={(event) => setCampaignTitle(event.target.value)}
            />
          </div>
        </div>

        {template && (
          <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-border surface-subtle p-3 text-xs leading-5 text-muted-foreground">
            {template.body}
          </pre>
        )}

        {/* Said HERE, next to the picker, and not left to be inferred from
            `futureOnly` / `templateIncomplete` after four hundred round trips
            to the ERP have already been spent. */}
        <p className="field-hint flex gap-2">
          <Icon name="info" size={16} className="mt-0.5 shrink-0" />
          <span>{t('whatsapp.billing.templateMismatch')}</span>
        </p>
      </div>

      {/* ── Who ───────────────────────────────────────────────────────── */}
      <div className="modern-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <span className="text-sm font-semibold text-foreground">
            {t('whatsapp.billing.selected', { count: selected.size })}
          </span>
          {rows.length > 0 && (
            <button type="button" className="modern-button-secondary" onClick={toggleAll}>
              {t('whatsapp.billing.selectAll')}
            </button>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name="invoice" size={22} /></div>
            <p className="empty-state-title">
              {loading ? t('common.loading') : t('whatsapp.billing.empty')}
            </p>
          </div>
        ) : (
          // No celular a tabela vira uma lista: cada linha é um bloco com a
          // caixa de marcar à esquerda e o resto empilhado ao lado — seis
          // colunas rolando de lado escondiam o valor e o vencimento.
          <div className="overflow-x-auto">
            <table className="modern-table max-md:block">
              <thead className="max-md:hidden">
                <tr>
                  <th scope="col" className="w-12">
                    <input
                      type="checkbox"
                      aria-label={t('whatsapp.billing.selectAll')}
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                  </th>
                  <th scope="col">{t('whatsapp.inbox.contract')}</th>
                  <th scope="col">{t('whatsapp.inbox.subscriber')}</th>
                  <th scope="col">{t('whatsapp.optOut.phone')}</th>
                  <th scope="col">{t('whatsapp.billing.amount')}</th>
                  <th scope="col">{t('whatsapp.billing.dueDate')}</th>
                </tr>
              </thead>
              <tbody className="max-md:block">
                {rows.map((row) => {
                  const days = row.daysOverdue
                  return (
                    <tr
                      key={row.contract}
                      data-contract={row.contract}
                      className="max-md:grid max-md:grid-cols-[2.5rem_minmax(0,1fr)] max-md:border-b max-md:border-border/70 max-md:px-2 max-md:py-2 max-md:last:border-b-0"
                    >
                      <td className={`${MOBILE_CELL} max-md:row-span-5 max-md:pt-1!`}>
                        <input
                          type="checkbox"
                          className="max-md:size-5"
                          aria-label={row.contract}
                          checked={selected.has(row.contract)}
                          onChange={() => toggle(row.contract)}
                        />
                      </td>
                      <td className={`${MOBILE_CELL} font-semibold`}>{row.contract}</td>
                      <td className={MOBILE_CELL}>
                        <span className="block"><ContactLink contract={row.contract} name={row.clientName} /></span>
                        {row.document && (
                          <span className="text-xs text-muted-foreground">{row.document}</span>
                        )}
                      </td>
                      <td className={MOBILE_CELL}>
                        {editing === row.contract ? (
                          <div className="space-y-2" data-testid={`wa-phone-editor-${row.contract}`}>
                            <label htmlFor={`wa-phone-${row.contract}`} className="field-label mb-2">
                              {t('whatsapp.billing.phoneManual')}
                            </label>
                            <input
                              id={`wa-phone-${row.contract}`}
                              type="tel"
                              className="modern-input"
                              autoFocus
                              value={draft}
                              disabled={savingPhone}
                              onChange={(event) => setDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') void savePhone(row.contract)
                                if (event.key === 'Escape') closeEditor()
                              }}
                            />
                            {/* Blank is a documented operation, so the hint says
                                so: it is how an operator withdraws a correction
                                without having to invent a number to overwrite
                                it with. */}
                            <p className="field-hint">{t('whatsapp.billing.phoneManualHint')}</p>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                className="modern-button"
                                data-testid={`wa-phone-save-${row.contract}`}
                                disabled={savingPhone}
                                onClick={() => void savePhone(row.contract)}
                              >
                                {savingPhone ? t('common.saving') : t('common.save')}
                              </button>
                              <button
                                type="button"
                                className="modern-button-secondary"
                                disabled={savingPhone}
                                onClick={closeEditor}
                              >
                                {t('common.cancel')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-2">
                            <div className="min-w-0">
                              {row.phone ? (
                                <>
                                  <span className="block" data-testid={`wa-phone-value-${row.contract}`}>
                                    {row.phone}
                                  </span>
                                  {/* Which record answered matters: `manual` is an
                                      operator correcting the ERP, and it is the one
                                      worth trusting when the two disagree. */}
                                  <span
                                    className="text-xs text-muted-foreground"
                                    data-phone-source={row.phoneSource ?? 'none'}
                                  >
                                    {row.phoneSource === 'manual'
                                      ? t('whatsapp.billing.phoneTyped')
                                      : t('whatsapp.billing.phoneFromSgp')}
                                  </span>
                                </>
                              ) : (
                                // Listed, not hidden — this is exactly the cadastre
                                // that needs fixing, and this row will be skipped.
                                <span className="modern-badge-error" data-phone-source="none">
                                  {t('whatsapp.billing.noPhone')}
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              className="modern-button-secondary shrink-0"
                              data-testid={`wa-phone-edit-${row.contract}`}
                              title={t('whatsapp.billing.editPhone')}
                              aria-label={t('whatsapp.billing.editPhone')}
                              onClick={() => openEditor(row)}
                            >
                              <Icon name="edit" size={14} />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className={`${MOBILE_CELL} max-md:font-semibold`}>{currency(row.amount, intlLocale)}</td>
                      <td className={`${MOBILE_CELL} max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-2`}>
                        <span className="block">{row.dueDate ? formatDate(row.dueDate) : '—'}</span>
                        {days !== null && (
                          <span className={days > 0 ? 'modern-badge-warning' : 'modern-badge-info'}>
                            {days > 0
                              ? t('whatsapp.billing.overdue', { days })
                              : days === 0
                                ? t('whatsapp.billing.beforeDue')
                                : t('whatsapp.billing.dueIn', { days: Math.abs(days) })}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Build ─────────────────────────────────────────────────────── */}
      <div className="modern-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="modern-button"
            data-testid="wa-billing-build"
            disabled={building || !template || selected.size === 0}
            onClick={() => void build()}
          >
            {building ? t('common.saving') : t('whatsapp.billing.build')}
          </button>
          {selectedWithoutPhone > 0 && (
            <span className="modern-badge-warning">
              {t('whatsapp.billing.skippedNoPhone', { count: selectedWithoutPhone })}
            </span>
          )}
        </div>

        {built && (
          <div className="mt-4 space-y-3" data-testid="wa-billing-result">
            <p className="text-sm font-semibold text-foreground">
              {t('whatsapp.broadcast.draftCreated', { count: built.recipients })}
            </p>
            {skippedReasons.length > 0 && (
              // Never a single total: the whole point of six counters is that
              // they are six different things, and only some are fixable.
              <ul className="grid gap-2 sm:grid-cols-2" role="list">
                {skippedReasons.map((reason) => (
                  <li
                    key={reason.key}
                    data-skip-reason={reason.key}
                    className="flex items-start gap-2 rounded-md border border-border surface-subtle px-3 py-2"
                  >
                    <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
                    <span className="text-xs leading-5 text-muted-foreground">
                      {t(reason.label, { count: reason.count })}
                      {reason.key === 'templateIncomplete' && missingBreakdown && ` — ${missingBreakdown}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
