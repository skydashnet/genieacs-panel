'use client'

import type { PlatformBox as PlatformBoxData } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTenant } from '@/contexts/tenant-context'
import { useTranslation } from '@/contexts/language-context'
import { platformBoxUrl } from '@/lib/shell'

/**
 * A caixa da plataforma, na aba de Provedores e fora da lista deles.
 *
 * Fora da lista porque não é um cliente: sem plano, sem cadastro fiscal, sem
 * botão de suspender. Misturá-la ali convidaria a primeira confusão óbvia —
 * alguém suspendendo a própria caixa achando que mexia num cliente.
 *
 * O que ela é: a linha em `tenants` que dá dono ao WhatsApp com que a
 * plataforma atende os provedores. Toda tabela daquele subsistema exige
 * `tenant_id`, e a sessão do console não tem provedor — então sem esta linha o
 * console não podia ter caixa nenhuma.
 *
 * O caminho até ela depende do arranjo do deploy, e as duas metades estão
 * escritas abaixo: onde há domínio-base ela tem endereço próprio; onde não há,
 * chega-se por ela pelo seletor de destino do login, que é o mesmo caminho de
 * qualquer provedor num deploy de host único.
 */
export function PlatformBoxCard({ box }: { box: PlatformBoxData | null }) {
  const { t } = useTranslation()
  const { tenant } = useTenant()
  const base = tenant?.panelBaseDomain ?? null

  if (!box) {
    return (
      <section className="modern-card mb-6 border-dashed p-5 sm:p-6">
        <h2 className="section-heading">{t('platform.box.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('platform.box.absent')}</p>
        {/* O comando, e não um botão. Criar esta linha é operação de uma vez por
            deploy, feita por quem tem o servidor — a mesma regra de
            `grant-platform-admin`. */}
        <code className="mt-3 block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
          node scripts/create-platform-tenant.js
        </code>
      </section>
    )
  }

  const endereco = platformBoxUrl({ slug: box.slug, panelBaseDomain: base, path: '/whatsapp' })
  // O servidor Evolution de TODOS os provedores mora na configuração da caixa:
  // é lá, e só lá, que endereço, chave e webhook são editados na SaaS.
  const servidor = platformBoxUrl({ slug: box.slug, panelBaseDomain: base, path: '/settings?tab=whatsapp' })

  return (
    <section className="modern-card mb-6 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-heading">{t('platform.box.title')}</h2>
          <p className="mt-1 text-lg font-semibold text-foreground">{box.name}</p>
          <p className="text-xs text-muted-foreground">
            {box.slug} · {t('platform.operators', { count: box.operators })}
          </p>
        </div>
        {endereco ? (
          <a href={endereco} target="_blank" rel="noopener noreferrer" className="modern-button">
            <Icon name="chat" size={17} />
            {t('platform.box.open')}
          </a>
        ) : null}
        {servidor ? (
          <a href={servidor} target="_blank" rel="noopener noreferrer" className="modern-button-secondary">
            <Icon name="settings" size={17} />
            {t('platform.box.whatsappServer')}
          </a>
        ) : null}
      </div>
      <p className="field-hint mt-4">
        {endereco ? t('platform.box.hint') : t('platform.box.hintSingleHost')}
      </p>
      <p className="field-hint mt-1">{t('platform.box.whatsappServerHint')}</p>
    </section>
  )
}

export default PlatformBoxCard
