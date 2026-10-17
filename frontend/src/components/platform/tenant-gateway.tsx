'use client'

import { useEffect, useState } from 'react'
import { platformAPI, type Tenant } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

/** Os providers que o backend sabe correlacionar. */
const GATEWAYS: Array<{ value: string; label: TranslationKey }> = [
  { value: 'asaas', label: 'platform.gateway.asaas' },
  { value: 'manual', label: 'platform.gateway.manual' }
]

interface Props {
  tenant: Tenant
  onTenantChange: () => void
}

/**
 * Quem este provedor é dentro do gateway de pagamento.
 *
 * É a correlação que o webhook lê para saber de quem é o dinheiro que entrou.
 * Enquanto ela não existir, o pagamento desse cliente cai numa linha de log
 * dizendo "não sei de quem é isto" e alguém continua marcando pago à mão.
 *
 * No console e não na tela do provedor, ao contrário do cadastro fiscal — e a
 * diferença é de segurança, não de arrumação. O fiscal é dado que o cliente
 * mantém e corrige sozinho quando muda de endereço; isto decide **para quem vai
 * o crédito**. Um provedor que pudesse escrever o próprio id de cliente
 * apontaria para o cliente de gateway de outro e receberia o pagamento alheio.
 */
export function TenantGateway({ tenant, onTenantChange }: Props) {
  const { t } = useTranslation()
  const toast = useToast()

  const atual = {
    gateway: tenant.gateway?.gateway ?? '',
    customerRef: tenant.gateway?.customerRef ?? ''
  }
  const [form, setForm] = useState(atual)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    setForm({
      gateway: tenant.gateway?.gateway ?? '',
      customerRef: tenant.gateway?.customerRef ?? ''
    })
  }, [tenant.id, tenant.gateway?.gateway, tenant.gateway?.customerRef])

  const gateway = form.gateway.trim()
  const customerRef = form.customerRef.trim()
  const mudou = gateway !== atual.gateway || customerRef !== atual.customerRef
  // Os dois preenchidos, ou os dois vazios. Meia correlação não resolve provedor
  // nenhum no webhook, e o backend recusa — a tela diz isso antes de o pedido
  // sair, que é mais barato do que um 400 para ler.
  const completo = Boolean(gateway) === Boolean(customerRef)
  const podeSalvar = !saving && mudou && completo

  const salvar = async () => {
    if (!podeSalvar) return
    if (!gateway && !window.confirm(t('platform.gateway.unlinkConfirm', { provider: tenant.name }))) {
      return
    }
    setSaving(true)
    try {
      const res = await platformAPI.setTenantGateway(tenant.id, { gateway, customerRef })
      if (res.success) {
        toast.success(gateway
          ? t('platform.gateway.linked', { provider: tenant.name })
          : t('platform.gateway.unlinked', { provider: tenant.name }))
        onTenantChange()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  /**
   * Cria o cliente na Asaas e já grava a correlação — o caminho de quem ainda
   * não tem cadastro lá, e que antes exigia abrir a Asaas, criar à mão e colar
   * o id aqui. O cadastro fiscal do provedor é a fonte: sem CPF/CNPJ o backend
   * recusa com 400 e a mensagem dele diz o que falta, então a tela só repassa.
   */
  const criarCliente = async () => {
    if (creating) return
    setCreating(true)
    try {
      const res = await platformAPI.createAsaasCustomer(tenant.id)
      if (res.success) {
        toast.success(t('platform.gateway.customerCreated', { provider: tenant.name }))
        onTenantChange()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setCreating(false)
    }
  }

  const ligado = Boolean(tenant.gateway?.customerRef)

  return (
    <div className="space-y-4 py-3">
      <div>
        <h3 className="font-semibold text-foreground">{t('platform.gateway.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.gateway.description')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor={`tenant-${tenant.id}-gateway`} className="block text-sm font-medium mb-1">
            {t('platform.gateway.name')}
          </label>
          {/* Lista fechada e não texto livre: o nome aqui tem de ser um provider
              que o backend conhece, e um "Asaas" com maiúscula não casava com
              webhook nenhum. Um valor antigo fora da lista continua aparecendo
              como opção, para a tela não trocá-lo em silêncio. */}
          <select
            id={`tenant-${tenant.id}-gateway`}
            value={form.gateway}
            onChange={(e) => setForm((f) => ({ ...f, gateway: e.target.value }))}
            className="modern-input w-full"
          >
            <option value="">{t('platform.gateway.none')}</option>
            {GATEWAYS.map((g) => (
              <option key={g.value} value={g.value}>{t(g.label)}</option>
            ))}
            {form.gateway && !GATEWAYS.some((g) => g.value === form.gateway) && (
              <option value={form.gateway}>{form.gateway}</option>
            )}
          </select>
        </div>
        <div>
          <label htmlFor={`tenant-${tenant.id}-customer`} className="block text-sm font-medium mb-1">
            {t('platform.gateway.customerRef')}
          </label>
          <input
            id={`tenant-${tenant.id}-customer`}
            value={form.customerRef}
            onChange={(e) => setForm((f) => ({ ...f, customerRef: e.target.value }))}
            className="modern-input w-full font-mono"
            placeholder="cus_000000000000"
            autoComplete="off"
          />
          <p className="field-hint">{t('platform.gateway.customerRefHint')}</p>
        </div>
      </div>

      {mudou && !completo && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          {t('platform.gateway.bothOrNeither')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void salvar()} disabled={!podeSalvar} className="modern-button">
          {saving ? t('common.saving') : t('platform.data.save')}
        </button>
        <button
          type="button"
          onClick={() => setForm(atual)}
          disabled={saving || !mudou}
          className="modern-button-secondary"
        >
          {t('common.cancel')}
        </button>
      </div>

      {!ligado && (
        <div className="border-t border-border pt-4">
          <button
            type="button"
            onClick={() => void criarCliente()}
            disabled={creating || saving || mudou}
            className="modern-button-secondary"
          >
            {creating ? t('platform.gateway.creatingCustomer') : t('platform.gateway.createAsaasCustomer')}
          </button>
          <p className="field-hint">{t('platform.gateway.createAsaasCustomerHint')}</p>
        </div>
      )}
    </div>
  )
}
