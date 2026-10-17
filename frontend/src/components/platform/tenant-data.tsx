'use client'

import { useEffect, useState } from 'react'
import { platformAPI, type Tenant } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

interface Props {
  tenant: Tenant
  /** Nome e subdomínio estão os dois na linha da lista, e a linha vem do pedido dela. */
  onTenantChange: () => void
}

/**
 * O cadastro de um provedor: o nome dele e o subdomínio em que o painel dele
 * responde.
 *
 * Existe porque criar era definitivo. Um nome digitado errado ou um subdomínio
 * escolhido antes de o ISP fechar a marca só saíam apagando o provedor e
 * recriando — o que leva os assinantes, os aparelhos e as conversas junto.
 *
 * As duas metades não têm o mesmo peso, e a tela mostra isso. Trocar o nome é
 * correção de texto. Trocar o subdomínio MUDA O ENDEREÇO do painel: o antigo
 * para de responder na hora, quem estiver logado nele cai, e todo convite ou
 * link de redefinição de senha já enviado aponta para um host que não existe
 * mais. Por isso o aviso aparece assim que o campo muda, e a confirmação só é
 * pedida quando é o subdomínio que está mudando — a mesma regra que a tela já
 * segue ao perguntar na suspensão e calar na reativação.
 *
 * A regra do endereço NÃO é repetida aqui. Ela mora em `backend/src/utils/slug.js`
 * — com a lista de labels reservados, que é do deployment e não do navegador —,
 * e o frontend já carrega uma cópia mais fraca dela no cadastro próprio
 * (`pages/signup.tsx`). Uma terceira cópia só multiplicaria a divergência: o
 * que este formulário faz é impedir o pedido vazio e o pedido que não mudou
 * nada, e deixar o backend nomear o resto.
 */
export function TenantData({ tenant, onTenantChange }: Props) {
  const { t } = useTranslation()
  const toast = useToast()

  const [form, setForm] = useState({ name: tenant.name, slug: tenant.slug })
  const [saving, setSaving] = useState(false)

  // A página relê a lista depois de salvar e desce objetos novos; sem isto o
  // painel seguiria mostrando o texto de antes do salvamento. Também é o que
  // troca o conteúdo quando o painel é aberto em outra linha.
  useEffect(() => {
    setForm({ name: tenant.name, slug: tenant.slug })
  }, [tenant.id, tenant.name, tenant.slug])

  const name = form.name.trim()
  // O espaço nas pontas sai aqui, como no cadastro. O backend recusaria o slug
  // com espaço em vez de apará-lo — de propósito, para não devolver um endereço
  // diferente do que foi digitado —, mas espaço nas pontas de um campo de
  // subdomínio é sempre escorregão de teclado, nunca intenção, e a tela de
  // criação já o descarta do mesmo jeito.
  const slug = form.slug.trim()
  const nomeMudou = name !== tenant.name
  const slugMudou = slug !== tenant.slug
  const podeSalvar = !saving && name !== '' && slug !== '' && (nomeMudou || slugMudou)

  const salvar = async () => {
    if (!podeSalvar) return
    if (slugMudou && !window.confirm(
      t('platform.data.slugConfirm', { provider: tenant.name, from: tenant.slug, to: slug })
    )) return

    setSaving(true)
    try {
      // Só o que mudou: mandar o slug atual de volta num salvamento que apenas
      // corrige o nome faria o backend conferir um endereço que ninguém pediu
      // para trocar.
      const res = await platformAPI.updateTenant(tenant.id, {
        ...(nomeMudou ? { name } : {}),
        ...(slugMudou ? { slug } : {})
      })
      if (res.success) {
        toast.success(t('platform.data.saved', { provider: name }))
        onTenantChange()
      } else {
        // 400 para um subdomínio que não é um host — ou reservado —, 409 para um
        // que outro provedor já tem: o backend diz qual, e diz mais do que uma
        // frase genérica diria.
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 py-3">
      <div>
        <h3 className="font-semibold text-foreground">{t('platform.data.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.data.description')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor={`tenant-${tenant.id}-name`} className="block text-sm font-medium mb-1">
            {t('platform.name')}
          </label>
          <input
            id={`tenant-${tenant.id}-name`}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="modern-input w-full"
            autoComplete="off"
          />
        </div>
        <div>
          <label htmlFor={`tenant-${tenant.id}-slug`} className="block text-sm font-medium mb-1">
            {t('platform.slug')}
          </label>
          <input
            id={`tenant-${tenant.id}-slug`}
            value={form.slug}
            // Minúsculo à digitação, como no cadastro: o slug vira um hostname, e
            // uma maiúscula digitada aqui só voltaria como 400.
            onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }))}
            className="modern-input w-full font-mono"
            autoComplete="off"
          />
          <p className="field-hint">{t('platform.slugHint')}</p>
        </div>
      </div>

      {/* Assim que o campo muda, e não só na confirmação: quem está digitando um
          endereço novo tem que ler a consequência antes de terminar de digitar. */}
      {slugMudou && (
        <p className="text-sm text-amber-600 dark:text-amber-400">{t('platform.data.addressHint')}</p>
      )}

      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void salvar()} disabled={!podeSalvar} className="modern-button">
          {saving ? t('common.saving') : t('platform.data.save')}
        </button>
        <button
          type="button"
          onClick={() => setForm({ name: tenant.name, slug: tenant.slug })}
          disabled={saving || (!nomeMudou && !slugMudou)}
          className="modern-button-secondary"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

export default TenantData
