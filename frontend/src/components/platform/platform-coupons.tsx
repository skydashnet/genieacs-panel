'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { platformAPI, type CouponDuration, type CouponKind, type CouponView, type Plan } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { couponDiscountLabel, couponDurationLabel, couponFormError } from '@/lib/coupon'
import { displayDate } from '@/lib/date-format'
import { parseAmountToCents } from '@/lib/utils'

/** Uma data do `<input type="date">` como o fim daquele dia, no fuso de quem digita. */
function fimDoDia(valor: string) {
  if (!valor) return null
  const data = new Date(`${valor}T23:59:59`)
  return Number.isNaN(data.getTime()) ? null : data.toISOString()
}

/** O inverso, para preencher o campo: a data local de um instante ISO. */
function diaDe(valor: string | null) {
  if (!valor) return ''
  const data = new Date(valor)
  if (Number.isNaN(data.getTime())) return ''
  const doisDigitos = (n: number) => String(n).padStart(2, '0')
  return `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}-${doisDigitos(data.getDate())}`
}

/** Vazio é nulo; o resto, inteiro ≥ 1 — ou `undefined` quando não dá para ler. */
function inteiroOuNulo(valor: string): number | null | undefined {
  const texto = valor.trim()
  if (!texto) return null
  const n = Number(texto)
  return Number.isInteger(n) && n >= 1 ? n : undefined
}

const VAZIO = {
  code: '',
  kind: 'percent' as CouponKind,
  value: '',
  duration: 'once' as CouponDuration,
  cycles: '3',
  maxRedemptions: '',
  validUntil: '',
  planIds: [] as number[]
}

/**
 * A aba Cupons do console: o catálogo de cupons de desconto.
 *
 * Código, desconto e duração não mudam depois de criados — são o que o
 * extrato de quem já resgatou nomeia. O que muda são as portas do resgate:
 * ativo, validade e limite de usos. Excluir só apaga o cupom nunca usado; o
 * usado é desativado (quem já o tem continua com o desconto).
 */
export function PlatformCoupons({ plans }: { plans: Plan[] }) {
  const { t } = useTranslation()
  const toast = useToast()
  const formId = useId()
  const [coupons, setCoupons] = useState<CouponView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(VAZIO)
  const [formErro, setFormErro] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ id: number; validUntil: string; maxRedemptions: string } | null>(null)

  const carregar = useCallback(async () => {
    setLoading(true)
    const res = await platformAPI.listCoupons()
    if (res.success && res.data) {
      setCoupons(res.data.coupons)
      setError(null)
    } else {
      setError(res.message || t('coupons.loadFailed'))
    }
    setLoading(false)
  }, [t])

  useEffect(() => { void carregar() }, [carregar])

  const nomeDoPlano = (id: number) => plans.find((plan) => plan.id === id)?.name ?? `#${id}`

  const criar = async () => {
    setFormErro(null)
    // Percentual é inteiro; o fixo é digitado em reais e vai em centavos.
    const valor = form.kind === 'percent'
      ? (/^\d+$/.test(form.value.trim()) ? Number(form.value.trim()) : null)
      : parseAmountToCents(form.value)
    const ciclos = form.duration === 'repeating' ? inteiroOuNulo(form.cycles) ?? null : null
    const erro = couponFormError({
      code: form.code, kind: form.kind, value: valor, duration: form.duration, durationCycles: ciclos
    })
    if (erro) {
      setFormErro(t(erro))
      return
    }
    const teto = inteiroOuNulo(form.maxRedemptions)
    if (teto === undefined) {
      setFormErro(t('coupons.error.maxRedemptions'))
      return
    }
    setSaving(true)
    try {
      const res = await platformAPI.createCoupon({
        code: form.code.trim().toUpperCase(),
        kind: form.kind,
        value: valor as number,
        duration: form.duration,
        durationCycles: ciclos,
        maxRedemptions: teto,
        validUntil: fimDoDia(form.validUntil),
        planIds: form.planIds.length ? form.planIds : null
      })
      if (res.success) {
        toast.success(t('coupons.created'))
        setForm(VAZIO)
        setCreating(false)
        await carregar()
      } else if (res.code === 'coupon_code_taken') {
        setFormErro(t('coupons.error.codeTaken'))
      } else if (res.code === 'coupon_full_discount') {
        setFormErro(t('coupons.error.fullDiscount'))
      } else {
        setFormErro(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const atualizar = async (coupon: CouponView, patch: Parameters<typeof platformAPI.updateCoupon>[1]) => {
    setBusyId(coupon.id)
    try {
      const res = await platformAPI.updateCoupon(coupon.id, patch)
      if (res.success) {
        toast.success(t('coupons.updated'))
        setEditing(null)
        await carregar()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusyId(null)
    }
  }

  const salvarLimites = async (coupon: CouponView) => {
    if (!editing) return
    const teto = inteiroOuNulo(editing.maxRedemptions)
    if (teto === undefined) {
      toast.error(t('coupons.error.maxRedemptions'))
      return
    }
    await atualizar(coupon, { validUntil: fimDoDia(editing.validUntil), maxRedemptions: teto })
  }

  const excluir = async (coupon: CouponView) => {
    if (!window.confirm(t('coupons.deleteConfirm', { code: coupon.code }))) return
    setBusyId(coupon.id)
    try {
      const res = await platformAPI.deleteCoupon(coupon.id)
      if (res.success && res.data) {
        toast.success(t(res.data.deleted ? 'coupons.deleted' : 'coupons.deactivatedInstead'))
        await carregar()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusyId(null)
    }
  }

  const alternarPlano = (id: number) => setForm((atual) => ({
    ...atual,
    planIds: atual.planIds.includes(id) ? atual.planIds.filter((p) => p !== id) : [...atual.planIds, id]
  }))

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="section-heading">{t('coupons.title')}</h2>
          <p className="section-description">{t('coupons.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="modern-button" onClick={() => setCreating((v) => !v)}>
            <Icon name={creating ? 'x' : 'invoice'} size={17} />
            {t(creating ? 'common.cancel' : 'coupons.new')}
          </button>
          <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void carregar()}>
            <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {creating && (
        <form
          className="modern-card p-5 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault()
            void criar()
          }}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor={`${formId}-code`} className="mb-1 block text-sm font-medium">{t('coupons.code')}</label>
              <input
                id={`${formId}-code`}
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                className="modern-input w-full font-mono"
                maxLength={32}
                autoComplete="off"
                required
              />
            </div>
            <div>
              <label htmlFor={`${formId}-kind`} className="mb-1 block text-sm font-medium">{t('coupons.kind')}</label>
              <select
                id={`${formId}-kind`}
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as CouponKind, value: '' })}
                className="modern-input w-full"
              >
                <option value="percent">{t('coupons.kind.percent')}</option>
                <option value="fixed">{t('coupons.kind.fixed')}</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${formId}-value`} className="mb-1 block text-sm font-medium">{t('coupons.value')}</label>
              <input
                id={`${formId}-value`}
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                className="modern-input w-full"
                inputMode={form.kind === 'percent' ? 'numeric' : 'decimal'}
                required
              />
              <p className="field-hint">
                {t(form.kind === 'percent' ? 'coupons.valueHintPercent' : 'coupons.valueHintFixed')}
              </p>
            </div>
            <div>
              <label htmlFor={`${formId}-duration`} className="mb-1 block text-sm font-medium">{t('coupons.duration')}</label>
              <select
                id={`${formId}-duration`}
                value={form.duration}
                onChange={(e) => setForm({ ...form, duration: e.target.value as CouponDuration })}
                className="modern-input w-full"
              >
                <option value="once">{t('coupons.duration.once')}</option>
                <option value="repeating">{t('coupons.duration.repeatingOption')}</option>
                <option value="forever">{t('coupons.duration.forever')}</option>
              </select>
            </div>
            {form.duration === 'repeating' && (
              <div>
                <label htmlFor={`${formId}-cycles`} className="mb-1 block text-sm font-medium">{t('coupons.cycles')}</label>
                <input
                  id={`${formId}-cycles`}
                  value={form.cycles}
                  onChange={(e) => setForm({ ...form, cycles: e.target.value })}
                  className="modern-input w-full"
                  inputMode="numeric"
                />
              </div>
            )}
            <div>
              <label htmlFor={`${formId}-max`} className="mb-1 block text-sm font-medium">{t('coupons.maxRedemptions')}</label>
              <input
                id={`${formId}-max`}
                value={form.maxRedemptions}
                onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })}
                className="modern-input w-full"
                inputMode="numeric"
              />
              <p className="field-hint">{t('coupons.maxRedemptionsHint')}</p>
            </div>
            <div>
              <label htmlFor={`${formId}-until`} className="mb-1 block text-sm font-medium">{t('coupons.validUntil')}</label>
              <input
                id={`${formId}-until`}
                type="date"
                value={form.validUntil}
                onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                className="modern-input w-full"
              />
              <p className="field-hint">{t('coupons.validUntilHint')}</p>
            </div>
          </div>
          {plans.length > 0 && (
            <fieldset className="mt-4">
              <legend className="mb-1 text-sm font-medium">{t('coupons.plans')}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {plans.map((plan) => (
                  <label key={plan.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form.planIds.includes(plan.id)} onChange={() => alternarPlano(plan.id)} />
                    <span className="wrap-break-word">{plan.name}</span>
                  </label>
                ))}
              </div>
              <p className="field-hint">{t('coupons.plansHint')}</p>
            </fieldset>
          )}
          {formErro && <p role="alert" className="mt-3 text-sm text-destructive">{formErro}</p>}
          <button type="submit" className="modern-button mt-4" disabled={saving}>
            {saving ? t('common.saving') : t('coupons.create')}
          </button>
        </form>
      )}

      {loading && !coupons.length ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : error !== null ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !coupons.length ? (
        <p className="text-sm text-muted-foreground">{t('coupons.empty')}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {coupons.map((coupon) => {
            const duracao = couponDurationLabel(coupon)
            const editando = editing?.id === coupon.id ? editing : null
            return (
              <li key={coupon.id} className="modern-card flex min-w-0 flex-col p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-all font-mono text-base font-semibold text-foreground">{coupon.code}</span>
                  <span className={coupon.active ? 'modern-badge-success' : 'modern-badge'}>
                    {t(coupon.active ? 'coupons.active' : 'coupons.inactive')}
                  </span>
                </div>
                <p className="mt-1 text-lg font-semibold text-foreground">
                  {t('coupons.discountOff', { discount: couponDiscountLabel(coupon) })}
                </p>
                <dl className="mt-2 flex-1 space-y-1 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('coupons.duration')}</dt>
                    <dd className="text-end font-medium">{t(duracao.key, duracao.vars)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('coupons.redemptions')}</dt>
                    <dd className="font-medium tabular-nums">
                      {coupon.redemptions} / {coupon.maxRedemptions ?? '∞'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('coupons.inUse')}</dt>
                    <dd className="font-medium tabular-nums">{coupon.inUse}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('coupons.validUntil')}</dt>
                    <dd className="font-medium">{coupon.validUntil ? displayDate(coupon.validUntil) : t('coupons.noExpiry')}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('coupons.plans')}</dt>
                    <dd className="min-w-0 wrap-break-word text-end font-medium">
                      {coupon.planIds ? coupon.planIds.map(nomeDoPlano).join(', ') : t('coupons.allPlans')}
                    </dd>
                  </div>
                </dl>

                {editando && (
                  <div className="mt-3 grid grid-cols-1 gap-2 border-t border-border pt-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`${formId}-e-until-${coupon.id}`} className="mb-1 block text-xs font-medium">{t('coupons.validUntil')}</label>
                      <input
                        id={`${formId}-e-until-${coupon.id}`}
                        type="date"
                        value={editando.validUntil}
                        onChange={(e) => setEditing({ ...editando, validUntil: e.target.value })}
                        className="modern-input w-full"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${formId}-e-max-${coupon.id}`} className="mb-1 block text-xs font-medium">{t('coupons.maxRedemptions')}</label>
                      <input
                        id={`${formId}-e-max-${coupon.id}`}
                        value={editando.maxRedemptions}
                        onChange={(e) => setEditing({ ...editando, maxRedemptions: e.target.value })}
                        className="modern-input w-full"
                        inputMode="numeric"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                      <button type="button" className="modern-button" disabled={busyId === coupon.id} onClick={() => void salvarLimites(coupon)}>
                        {busyId === coupon.id ? t('common.saving') : t('common.save')}
                      </button>
                      <button type="button" className="modern-button-secondary" onClick={() => setEditing(null)}>
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}

                {!editando && (
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                    <button
                      type="button"
                      className="modern-button-secondary"
                      disabled={busyId === coupon.id}
                      onClick={() => void atualizar(coupon, { active: !coupon.active })}
                    >
                      {t(coupon.active ? 'coupons.deactivate' : 'coupons.activate')}
                    </button>
                    <button
                      type="button"
                      className="modern-button-secondary"
                      disabled={busyId === coupon.id}
                      onClick={() => setEditing({
                        id: coupon.id,
                        validUntil: diaDe(coupon.validUntil),
                        maxRedemptions: coupon.maxRedemptions === null ? '' : String(coupon.maxRedemptions)
                      })}
                    >
                      <Icon name="edit" size={16} />
                      {t('coupons.editLimits')}
                    </button>
                    <button
                      type="button"
                      className="modern-button-secondary text-destructive"
                      disabled={busyId === coupon.id}
                      onClick={() => void excluir(coupon)}
                    >
                      <Icon name="trash" size={16} />
                      {t('common.delete')}
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
