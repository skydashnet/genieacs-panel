'use client'

import { useEffect, useState } from 'react'
import { tenantAPI, type TenantBilling } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

/**
 * O cadastro fiscal do provedor: razão social, CNPJ, endereço e o contato que
 * recebe a cobrança.
 *
 * Fica na tela de plano e uso, e não nas configurações, porque é a parte
 * COMERCIAL do provedor — a mesma tela que diz em que plano ele está e até
 * quando pagou. Nas configurações ele dividiria espaço com ACS, fabricantes e
 * WiFi, que é o outro lado do produto.
 *
 * Quem edita é o próprio provedor, não o console. Um endereço que o cliente
 * mantém é um endereço que ele corrige no dia em que muda — o console tem só a
 * leitura, para faturar.
 */
export type BillingField = {
  chave: keyof TenantBilling
  label: TranslationKey
  hint?: TranslationKey
  largura: 'full' | 'half' | 'third'
  maxLength: number
  inputMode?: 'numeric'
}

/**
 * Os campos do endereço. Estas listas também montam o painel "Cadastro do
 * provedor" das configurações — o mesmo registro, editável nos dois lugares.
 */
export const ADDRESS_FIELDS: BillingField[] = [
  { chave: 'postalCode', label: 'billing.postalCode', largura: 'third', maxLength: 9, inputMode: 'numeric' },
  { chave: 'addressLine', label: 'billing.addressLine', largura: 'full', maxLength: 160 },
  { chave: 'addressNumber', label: 'billing.addressNumber', largura: 'third', maxLength: 16 },
  { chave: 'addressExtra', label: 'billing.addressExtra', largura: 'third', maxLength: 80 },
  { chave: 'district', label: 'billing.district', largura: 'third', maxLength: 80 },
  { chave: 'city', label: 'billing.city', largura: 'half', maxLength: 80 },
  { chave: 'state', label: 'billing.state', largura: 'third', maxLength: 2 }
]

/** Quem é o provedor: razão social, CNPJ e inscrição estadual. */
export const IDENTITY_FIELDS: BillingField[] = [
  { chave: 'legalName', label: 'billing.legalName', largura: 'full', maxLength: 160 },
  { chave: 'taxId', label: 'billing.taxId', hint: 'billing.taxIdHint', largura: 'half', maxLength: 20, inputMode: 'numeric' },
  { chave: 'stateRegistration', label: 'billing.stateRegistration', hint: 'billing.stateRegistrationHint', largura: 'half', maxLength: 32 }
]

/** Para onde vai a cobrança. */
export const CONTACT_FIELDS: BillingField[] = [
  { chave: 'email', label: 'billing.email', hint: 'billing.emailHint', largura: 'half', maxLength: 160 },
  { chave: 'phone', label: 'billing.phone', largura: 'half', maxLength: 32 }
]

const CAMPOS: BillingField[] = [...IDENTITY_FIELDS, ...ADDRESS_FIELDS, ...CONTACT_FIELDS]

export const CLASSE_LARGURA = {
  full: 'sm:col-span-6',
  half: 'sm:col-span-3',
  third: 'sm:col-span-2'
} as const

const VAZIO: TenantBilling = {
  legalName: null, taxId: null, stateRegistration: null, postalCode: null,
  addressLine: null, addressNumber: null, addressExtra: null, district: null,
  city: null, state: null, email: null, phone: null
}

function comoTexto(billing: TenantBilling | null) {
  const saida: Record<string, string> = {}
  for (const { chave } of CAMPOS) saida[chave] = (billing?.[chave] ?? '') as string
  return saida
}

export function BillingProfile({ billing, onSaved }: {
  billing: TenantBilling | null
  onSaved: (billing: TenantBilling) => void
}) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const podeEscrever = can('settings.write')

  const [form, setForm] = useState(() => comoTexto(billing))
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [salvo, setSalvo] = useState(false)

  // O cadastro chega junto do plano, numa busca que a página refaz; sem isto o
  // formulário ficaria com o que veio na primeira renderização.
  useEffect(() => { setForm(comoTexto(billing)) }, [billing])

  const mudar = (chave: string, valor: string) => {
    setForm((atual) => ({ ...atual, [chave]: valor }))
    setSalvo(false)
  }

  const salvar = async () => {
    setSalvando(true)
    setErro(null)
    // Manda o formulário inteiro, e é o único lugar que o faz: aqui a pessoa vê
    // os doze campos ao mesmo tempo, então apagar um campo na tela É o pedido
    // de apagá-lo no banco. A distinção entre ausente e vazio que a rota mantém
    // serve a quem chama com um campo só.
    const patch: Record<string, string> = {}
    for (const { chave } of CAMPOS) patch[chave] = form[chave] ?? ''
    const res = await tenantAPI.updateBilling(patch as Partial<TenantBilling>)
    if (res.success && res.data) {
      onSaved(res.data.billing ?? VAZIO)
      setSalvo(true)
    } else {
      setErro(res.message || t('billing.saveFailed'))
    }
    setSalvando(false)
  }

  return (
    <section className="modern-card p-5 sm:p-6">
      <h2 className="section-heading">{t('billing.title')}</h2>
      <p className="section-description mb-5">{t('billing.description')}</p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        {CAMPOS.map(({ chave, label, hint, largura, maxLength, inputMode }) => (
          <div key={chave} className={CLASSE_LARGURA[largura]}>
            <label htmlFor={`billing-${chave}`} className="field-label">{t(label)}</label>
            <input
              id={`billing-${chave}`}
              className="modern-input w-full"
              value={form[chave] ?? ''}
              maxLength={maxLength}
              inputMode={inputMode}
              disabled={!podeEscrever || salvando}
              onChange={(e) => mudar(chave, e.target.value)}
            />
            {hint && <p className="field-hint">{t(hint)}</p>}
          </div>
        ))}
      </div>

      {erro && <p className="mt-4 text-sm text-destructive">{erro}</p>}

      {podeEscrever && (
        <div className="mt-5 flex items-center gap-3">
          <button type="button" className="modern-button" disabled={salvando} onClick={() => void salvar()}>
            {salvando ? t('common.saving') : t('common.save')}
          </button>
          {salvo && <span className="text-sm text-muted-foreground">{t('billing.saved')}</span>}
        </div>
      )}
      {!podeEscrever && <p className="field-hint mt-4">{t('billing.readOnly')}</p>}
    </section>
  )
}

export default BillingProfile
