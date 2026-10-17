'use client'

import { useState } from 'react'
import { platformAPI, type Plan } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { parseAmountToCents } from '@/lib/utils'
import { overagePriceFromInput } from '@/lib/overage'

interface Props {
  plans: Plan[]
  /** A lista de provedores mostra o plano de cada um; mudar aqui muda lá. */
  onChange: () => void
}

/** O que os três campos de limite guardam enquanto são texto na tela. */
interface Rascunho {
  code: string
  name: string
  maxOperators: string
  maxSubscribers: string
  maxDevices: string
  /** O preço por unidade acima do teto (0105), em reais. Vazio é "sem preço": o teto bloqueia. */
  overageOperators: string
  overageSubscribers: string
  overageDevices: string
  price: string
  currency: string
  trialDays: string
  /** Quanto tempo um pagamento compra. Trinta é mensal, 365 é anual. */
  periodDays: string
  /** Tetos de retenção, em dias. Vazio é sem teto. */
  maxAuditRetentionDays: string
  maxMessageRetentionDays: string
  maxMediaRetentionDays: string
  active: boolean
  /** A vitrine: página pública, destaque, ordem, texto e recursos. */
  public: boolean
  featured: boolean
  sortOrder: string
  pitch: string
  /** Um recurso por linha. */
  features: string
  priceYearly: string
}

const VAZIO: Rascunho = {
  code: '', name: '', maxOperators: '', maxSubscribers: '', maxDevices: '',
  overageOperators: '', overageSubscribers: '', overageDevices: '',
  price: '', currency: 'BRL', trialDays: '14', periodDays: '30',
  maxAuditRetentionDays: '', maxMessageRetentionDays: '', maxMediaRetentionDays: '', active: true,
  public: false, featured: false, sortOrder: '0', pitch: '', features: '', priceYearly: ''
}

/**
 * Teto de retenção: vazio é sem teto (`null`), e zero também — "zero dias" não
 * é teto que faça sentido, e o backend o recusa.
 */
function teto(texto: string): number | null {
  const n = limite(texto)
  return n === null || n < 1 ? null : n
}

/**
 * Campo de limite vazio quer dizer SEM LIMITE, e é por isso que ele vira
 * `null` e não zero.
 *
 * A diferença não é de estilo: `null` é o que o backend lê como ilimitado, e
 * zero é um limite de zero — um plano que não deixa cadastrar nem um operador.
 * Um campo em branco entendido como zero transformaria "não quero limitar
 * isto" em "proíba tudo", e o erro só apareceria no dia em que alguém
 * assinasse o plano.
 */
function limite(texto: string): number | null {
  const cru = texto.trim()
  if (!cru) return null
  const numero = Number(cru)
  return Number.isFinite(numero) && numero >= 0 ? Math.floor(numero) : null
}

/** Centavos como o campo os mostra ("10.00"); nulo é o campo vazio. */
function reaisOuVazio(cents: number | null | undefined): string {
  return cents == null ? '' : (cents / 100).toFixed(2)
}

function paraRascunho(plan: Plan): Rascunho {
  return {
    code: plan.code,
    name: plan.name,
    maxOperators: plan.limits.operators === null ? '' : String(plan.limits.operators),
    maxSubscribers: plan.limits.subscribers === null ? '' : String(plan.limits.subscribers),
    maxDevices: plan.limits.devices === null ? '' : String(plan.limits.devices),
    overageOperators: reaisOuVazio(plan.overagePriceCents?.operators),
    overageSubscribers: reaisOuVazio(plan.overagePriceCents?.subscribers),
    overageDevices: reaisOuVazio(plan.overagePriceCents?.devices),
    price: (plan.priceCents / 100).toFixed(2),
    currency: plan.currency,
    trialDays: String(plan.trialDays),
    periodDays: String(plan.periodDays),
    maxAuditRetentionDays: plan.retention?.audit == null ? '' : String(plan.retention.audit),
    maxMessageRetentionDays: plan.retention?.messages == null ? '' : String(plan.retention.messages),
    maxMediaRetentionDays: plan.retention?.media == null ? '' : String(plan.retention.media),
    active: plan.active,
    public: plan.public ?? false,
    featured: plan.featured ?? false,
    sortOrder: String(plan.sortOrder ?? 0),
    pitch: plan.description ?? '',
    features: (plan.features ?? []).join('\n'),
    priceYearly: plan.priceYearlyCents == null ? '' : (plan.priceYearlyCents / 100).toFixed(2)
  }
}

function dinheiro(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'BRL' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

/**
 * O catálogo de planos: o que a plataforma vende.
 *
 * A API de criar e editar plano existe desde a Fase 5 e não tinha tela — quem
 * operava o SaaS escolhia entre os planos que a migração semeou, ou chamava a
 * rota na mão. Esta é a tela.
 *
 * **O código de um plano não se edita depois de criado**, e é a única restrição
 * de forma aqui. Ele é a chave estável pela qual `subscriptions` aponta para o
 * plano e pela qual a tela de bloqueio decide o que dizer; trocá-lo renomearia
 * o que os provedores já assinam sem que nada na tela sugira isso. Preço,
 * limites e período de teste mudam à vontade — mas só valem para quem assinar
 * DEPOIS, porque a assinatura guarda o plano, não uma cópia dos números dele.
 *
 * Desativar não apaga: um plano inativo some da lista de escolha e continua
 * valendo para quem já o assina. É o que permite parar de vender um plano sem
 * mexer em contrato de ninguém — e é por isso que não há botão de excluir.
 */
export function PlanCatalog({ plans, onChange }: Props) {
  const { t } = useTranslation()
  const toast = useToast()

  const [criando, setCriando] = useState(false)
  const [editandoId, setEditandoId] = useState<number | null>(null)
  const [rascunho, setRascunho] = useState<Rascunho>(VAZIO)
  const [salvando, setSalvando] = useState(false)

  const abrirCriacao = () => {
    setEditandoId(null)
    setRascunho(VAZIO)
    setCriando(true)
  }

  const abrirEdicao = (plan: Plan) => {
    setCriando(false)
    setEditandoId(plan.id)
    setRascunho(paraRascunho(plan))
  }

  const fechar = () => {
    setCriando(false)
    setEditandoId(null)
    setRascunho(VAZIO)
  }

  const salvar = async () => {
    const nome = rascunho.name.trim()
    if (!nome) {
      toast.error(t('platform.plans.nameRequired'))
      return
    }
    const codigo = rascunho.code.trim().toLowerCase()
    if (criando && !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(codigo)) {
      toast.error(t('platform.plans.codeInvalid'))
      return
    }
    // O preço passa pela MESMA leitura que o pagamento já usa, e recusa o que
    // ela recusa. Aqui havia uma cópia antiga dela, com o `replace` que troca
    // só a primeira vírgula: "1.234,56" virava NaN e o `: 0` do fim fazia do
    // NaN um plano de GRAÇA, sem erro nenhum na tela; "1.234" virava R$ 1,23.
    // E o campo vazio também valia zero. Plano gratuito agora se digita: "0".
    const precoCentavos = parseAmountToCents(rascunho.price)
    if (precoCentavos === null) {
      toast.error(t('platform.plans.priceInvalid'))
      return
    }

    // Preço anual: vazio é "sem opção anual", e não zero.
    const anualCentavos = rascunho.priceYearly.trim() ? parseAmountToCents(rascunho.priceYearly) : null
    if (rascunho.priceYearly.trim() && anualCentavos === null) {
      toast.error(t('platform.plans.priceInvalid'))
      return
    }

    // Os preços de excedente (0105): vazio é "sem preço", inválido para tudo.
    const excedente = {
      operators: overagePriceFromInput(rascunho.overageOperators),
      subscribers: overagePriceFromInput(rascunho.overageSubscribers),
      devices: overagePriceFromInput(rascunho.overageDevices)
    }
    if (Object.values(excedente).some((valor) => valor === undefined)) {
      toast.error(t('platform.plans.overageInvalid'))
      return
    }

    const comum = {
      name: nome,
      overagePriceCents: excedente as { operators: number | null; subscribers: number | null; devices: number | null },
      maxOperators: limite(rascunho.maxOperators),
      maxSubscribers: limite(rascunho.maxSubscribers),
      maxDevices: limite(rascunho.maxDevices),
      priceCents: precoCentavos,
      currency: rascunho.currency.trim().toUpperCase() || 'BRL',
      trialDays: Math.max(0, Math.floor(Number(rascunho.trialDays) || 0)),
      // Piso 1 e não 0: período zero é uma assinatura que vence no instante em
      // que é paga. O backend recusa; a tela não deixa chegar lá.
      periodDays: Math.max(1, Math.floor(Number(rascunho.periodDays) || 30)),
      maxAuditRetentionDays: teto(rascunho.maxAuditRetentionDays),
      maxMessageRetentionDays: teto(rascunho.maxMessageRetentionDays),
      maxMediaRetentionDays: teto(rascunho.maxMediaRetentionDays),
      active: rascunho.active,
      public: rascunho.public,
      featured: rascunho.featured,
      sortOrder: Math.trunc(Number(rascunho.sortOrder) || 0),
      description: rascunho.pitch.trim() || null,
      features: rascunho.features.split('\n').map((linha) => linha.trim()).filter(Boolean),
      priceYearlyCents: anualCentavos
    }

    setSalvando(true)
    try {
      const res = criando
        ? await platformAPI.createPlan({ code: codigo, ...comum })
        : await platformAPI.updatePlan(editandoId as number, comum)
      if (!res.success) {
        // 409 quando o código já existe, 400 quando um número não serve: o
        // backend diz qual, e isso ajuda mais do que uma frase genérica. O
        // preço anual em uso (0104) tem frase própria, traduzida.
        toast.error(res.code === 'plan_has_annual_subscriptions'
          ? t('platform.plans.annualInUse')
          : res.message || t('platform.plans.saveFailed'))
        return
      }
      fechar()
      onChange()
    } finally {
      setSalvando(false)
    }
  }

  /** Ligar e desligar sem abrir o formulário — é o que mais se faz aqui. */
  const alternarAtivo = async (plan: Plan) => {
    if (plan.active && (plan.subscribers ?? 0) > 0
      && !window.confirm(t('platform.plans.deactivateConfirm', { count: plan.subscribers ?? 0 }))) return
    setSalvando(true)
    try {
      const res = await platformAPI.updatePlan(plan.id, { active: !plan.active })
      if (!res.success) {
        toast.error(res.message || t('platform.plans.saveFailed'))
        return
      }
      onChange()
    } finally {
      setSalvando(false)
    }
  }

  const editandoEste = (plan: Plan) => editandoId === plan.id

  /** "excedente: R$ 10,00/operador, R$ 3,00/ONT" — vazio sem preço nenhum. */
  const resumoDoExcedente = (plan: Plan) => {
    const precos = plan.overagePriceCents
    if (!precos) return ''
    const itens = ([
      ['operators', 'platform.plans.overagePerOperator'],
      ['subscribers', 'platform.plans.overagePerSubscriber'],
      ['devices', 'platform.plans.overagePerDevice']
    ] as const)
      .filter(([recurso]) => precos[recurso] != null)
      .map(([recurso, chave]) => t(chave, { price: dinheiro(precos[recurso] as number, plan.currency) }))
    return itens.length ? t('platform.plans.summaryOverage', { items: itens.join(', ') }) : ''
  }

  const formulario = (
    <div className="mt-4 space-y-4 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="plan-code">{t('platform.plans.code')}</label>
          <input
            id="plan-code" className="modern-input w-full" value={rascunho.code}
            disabled={!criando}
            onChange={(e) => setRascunho((r) => ({ ...r, code: e.target.value }))}
            placeholder="starter"
          />
          {/* O aviso só aparece na edição, que é quando ele significa algo. */}
          <p className="field-hint">{t(criando ? 'platform.plans.codeHint' : 'platform.plans.codeLocked')}</p>
        </div>
        <div>
          <label className="field-label" htmlFor="plan-name">{t('platform.plans.name')}</label>
          <input
            id="plan-name" className="modern-input w-full" value={rascunho.name}
            onChange={(e) => setRascunho((r) => ({ ...r, name: e.target.value }))}
            placeholder={t('platform.plans.namePlaceholder')}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {([
          ['maxOperators', 'platform.plans.maxOperators'],
          ['maxSubscribers', 'platform.plans.maxSubscribers'],
          ['maxDevices', 'platform.plans.maxDevices']
        ] as const).map(([campo, chave]) => (
          <div key={campo}>
            <label className="field-label" htmlFor={`plan-${campo}`}>{t(chave)}</label>
            <input
              id={`plan-${campo}`} type="number" min={0} className="modern-input w-full"
              value={rascunho[campo]}
              onChange={(e) => setRascunho((r) => ({ ...r, [campo]: e.target.value }))}
              placeholder={t('platform.plans.unlimited')}
            />
          </div>
        ))}
      </div>
      <p className="field-hint">{t('platform.plans.limitHint')}</p>

      <fieldset>
        <legend className="field-label">{t('platform.plans.overageTitle')}</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {([
            ['overageOperators', 'platform.plans.overageOperators'],
            ['overageSubscribers', 'platform.plans.overageSubscribers'],
            ['overageDevices', 'platform.plans.overageDevices']
          ] as const).map(([campo, chave]) => (
            <div key={campo}>
              <label className="field-label" htmlFor={`plan-${campo}`}>{t(chave)}</label>
              <input
                id={`plan-${campo}`} className="modern-input w-full" inputMode="decimal"
                value={rascunho[campo]}
                onChange={(e) => setRascunho((r) => ({ ...r, [campo]: e.target.value }))}
                placeholder={t('platform.plans.overagePlaceholder')}
              />
            </div>
          ))}
        </div>
        <p className="field-hint">{t('platform.plans.overageHint')}</p>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="field-label" htmlFor="plan-price">{t('platform.plans.price')}</label>
          <input
            id="plan-price" className="modern-input w-full" inputMode="decimal"
            value={rascunho.price}
            onChange={(e) => setRascunho((r) => ({ ...r, price: e.target.value }))}
            placeholder="0,00"
          />
        </div>
        <div>
          <label className="field-label" htmlFor="plan-currency">{t('platform.plans.currency')}</label>
          <input
            id="plan-currency" className="modern-input w-full" maxLength={3}
            value={rascunho.currency}
            onChange={(e) => setRascunho((r) => ({ ...r, currency: e.target.value }))}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="plan-trial">{t('platform.plans.trialDays')}</label>
          <input
            id="plan-trial" type="number" min={0} className="modern-input w-full"
            value={rascunho.trialDays}
            onChange={(e) => setRascunho((r) => ({ ...r, trialDays: e.target.value }))}
          />
        </div>
        <div>
          {/* O preço já dizia por quanto se vende; este diz por quanto TEMPO. Os
              dois juntos são o plano — sem este campo, "R$ 1.999" não distingue
              um plano caro de um plano anual. */}
          <label className="field-label" htmlFor="plan-period">{t('platform.plans.periodDays')}</label>
          <input
            id="plan-period" type="number" min={1} className="modern-input w-full"
            value={rascunho.periodDays}
            onChange={(e) => setRascunho((r) => ({ ...r, periodDays: e.target.value }))}
          />
          <p className="field-hint">{t('platform.plans.periodDaysHint')}</p>
        </div>
      </div>

      {/* O preço anual é COBRADO (0104): o provedor que escolhe o ciclo anual
          paga este valor por 365 dias. Por isso mora junto do preço, e não na
          vitrine. Vazio é "sem opção anual". */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="plan-price-yearly">{t('platform.plans.priceYearly')}</label>
          <input
            id="plan-price-yearly" className="modern-input w-full" inputMode="decimal"
            value={rascunho.priceYearly}
            onChange={(e) => setRascunho((r) => ({ ...r, priceYearly: e.target.value }))}
            placeholder={t('platform.plans.priceYearlyPlaceholder')}
          />
          <p className="field-hint">{t('platform.plans.priceYearlyHint')}</p>
        </div>
      </div>

      {/* Até quando o provedor pode guardar o que é dado pessoal. Com teto, o
          valor que ele escolher continua valendo quando é menor; "para sempre"
          passa a ser o teto. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {([
          ['maxAuditRetentionDays', 'platform.plans.maxAuditRetention'],
          ['maxMessageRetentionDays', 'platform.plans.maxMessageRetention'],
          ['maxMediaRetentionDays', 'platform.plans.maxMediaRetention']
        ] as const).map(([campo, chave]) => (
          <div key={campo}>
            <label className="field-label" htmlFor={`plan-${campo}`}>{t(chave)}</label>
            <input
              id={`plan-${campo}`} type="number" min={1} max={3650} className="modern-input w-full"
              value={rascunho[campo]}
              onChange={(e) => setRascunho((r) => ({ ...r, [campo]: e.target.value }))}
              placeholder={t('platform.plans.noCap')}
            />
          </div>
        ))}
      </div>
      <p className="field-hint">{t('platform.plans.retentionHint')}</p>

      {/* A vitrine: o que a página pública do ápice mostra deste plano. */}
      <fieldset className="space-y-4 rounded-md border border-border p-4">
        <legend className="mb-4 px-1 text-sm font-semibold text-foreground">{t('platform.plans.showcase')}</legend>
        <p className="field-hint">{t('platform.plans.showcaseHint')}</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox" checked={rascunho.public}
              onChange={(e) => setRascunho((r) => ({ ...r, public: e.target.checked }))}
            />
            {t('platform.plans.public')}
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox" checked={rascunho.featured}
              onChange={(e) => setRascunho((r) => ({ ...r, featured: e.target.checked }))}
            />
            {t('platform.plans.featured')}
          </label>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="plan-sort">{t('platform.plans.sortOrder')}</label>
            <input
              id="plan-sort" type="number" className="modern-input w-full"
              value={rascunho.sortOrder}
              onChange={(e) => setRascunho((r) => ({ ...r, sortOrder: e.target.value }))}
            />
          </div>
        </div>
        <div>
          <label className="field-label" htmlFor="plan-pitch">{t('platform.plans.pitch')}</label>
          <input
            id="plan-pitch" className="modern-input w-full" maxLength={1000}
            value={rascunho.pitch}
            onChange={(e) => setRascunho((r) => ({ ...r, pitch: e.target.value }))}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="plan-features">{t('platform.plans.features')}</label>
          <textarea
            id="plan-features" rows={5} className="modern-input w-full"
            value={rascunho.features}
            onChange={(e) => setRascunho((r) => ({ ...r, features: e.target.value }))}
          />
          <p className="field-hint">{t('platform.plans.featuresHint')}</p>
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox" checked={rascunho.active}
          onChange={(e) => setRascunho((r) => ({ ...r, active: e.target.checked }))}
        />
        {t('platform.plans.active')}
      </label>

      <div className="flex gap-2">
        <button type="button" className="modern-button" disabled={salvando} onClick={() => void salvar()}>
          {salvando ? t('common.saving') : t('common.save')}
        </button>
        <button type="button" className="modern-button-secondary" onClick={fechar}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )

  return (
    <section className="rounded-md border border-border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold text-foreground">{t('platform.plans.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('platform.plans.description')}</p>
        </div>
        <button type="button" className="modern-button shrink-0" onClick={abrirCriacao}>
          {t('platform.plans.create')}
        </button>
      </div>

      {criando && formulario}

      <div className="mt-4 space-y-3">
        {plans.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('platform.plans.empty')}</p>
        )}
        {plans.map((plan) => (
          <div key={plan.id} className="rounded-md border border-border p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{plan.name}</span>
                  <code className="rounded bg-[hsl(var(--surface-subtle))] px-1.5 py-0.5 text-xs">{plan.code}</code>
                  {/* `capitalize` porque `platform.plans.inactive` já existia
                      em minúsculas, como sufixo de um item de lista — e uma
                      chave quase igual só para a maiúscula seria pior do que
                      uma regra de estilo. */}
                  <span className={`capitalize ${plan.active ? 'modern-badge-success' : 'modern-badge-error'}`}>
                    {t(plan.active ? 'platform.plans.active' : 'platform.plans.inactive')}
                  </span>
                  {plan.public && <span className="modern-badge-info">{t('platform.plans.publicBadge')}</span>}
                  {plan.featured && <span className="modern-badge-warning">{t('platform.plans.featuredBadge')}</span>}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('platform.plans.summaryPrice', {
                    price: dinheiro(plan.priceCents, plan.currency),
                    days: plan.periodDays
                  })}
                  {plan.priceYearlyCents != null && plan.priceYearlyCents > 0
                    && ` · ${t('platform.plans.summaryYearly', { price: dinheiro(plan.priceYearlyCents, plan.currency) })}`}
                  {' · '}
                  {t('platform.plans.summaryLimits', {
                    operators: plan.limits.operators ?? '∞',
                    subscribers: plan.limits.subscribers ?? '∞',
                    devices: plan.limits.devices ?? '∞'
                  })}
                  {resumoDoExcedente(plan) && ` · ${resumoDoExcedente(plan)}`}
                  {' · '}
                  {t('platform.plans.summaryTrial', { days: plan.trialDays })}
                  {plan.subscribers !== undefined && ` · ${t('platform.plans.summarySubscribers', { count: plan.subscribers })}`}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button" className="modern-button-secondary"
                  onClick={() => (editandoEste(plan) ? fechar() : abrirEdicao(plan))}
                >
                  <Icon name="settings" size={16} />
                  {t(editandoEste(plan) ? 'common.cancel' : 'common.edit')}
                </button>
                <button
                  type="button" className="modern-button-secondary" disabled={salvando}
                  onClick={() => void alternarAtivo(plan)}
                >
                  {t(plan.active ? 'platform.plans.deactivate' : 'platform.plans.activate')}
                </button>
              </div>
            </div>
            {editandoEste(plan) && formulario}
          </div>
        ))}
      </div>
    </section>
  )
}

export default PlanCatalog
