'use client'

import { useCallback, useEffect, useState } from 'react'
import { platformAPI, type DeploymentInfo } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

/**
 * A saúde do deploy: o que é do DEPLOY e não de provedor nenhum.
 *
 * As dez abas de Configuração do painel são de um ISP — o ACS dele, o ERP
 * dele, a conexão de WhatsApp dele. Esta é a outra metade, e até agora ela não
 * tinha tela: em que edição o processo está, contra que banco, em que endereços
 * atende, e o que está ou não configurado.
 *
 * **Só leitura, de propósito.** O que aparece aqui mora em variáveis de
 * ambiente, e variável de ambiente se muda no servidor e reiniciando. Um
 * formulário nesta tela prometeria o que a rota não entrega.
 *
 * E **configurado sim/não, nunca o valor**: a decisão é do backend, e o motivo
 * está lá — a chave da Asaas não muda nada que quem olha possa fazer, e passa a
 * existir no histórico do navegador e na captura de tela do chamado.
 */

/** O que a ausência de cada variável causa — é o que a tela precisa dizer. */
const CONFIGURADO: Array<{
  chave: keyof DeploymentInfo['configured']
  rotulo: TranslationKey
  ausente: TranslationKey
}> = [
  { chave: 'mail', rotulo: 'deployment.mail', ausente: 'deployment.mailAbsent' },
  { chave: 'metricsToken', rotulo: 'deployment.metrics', ausente: 'deployment.metricsAbsent' },
  { chave: 'billingWebhookToken', rotulo: 'deployment.webhook', ausente: 'deployment.webhookAbsent' },
  { chave: 'billingGateway', rotulo: 'deployment.gateway', ausente: 'deployment.gatewayAbsent' },
  { chave: 'rls', rotulo: 'deployment.rls', ausente: 'deployment.rlsAbsent' }
]

/** O nome do dialeto como um humano o chama, e não como o knex o chama. */
const BANCO: Record<DeploymentInfo['database']['client'], string> = {
  'better-sqlite3': 'SQLite',
  mysql2: 'MySQL',
  pg: 'PostgreSQL'
}

function Linha({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-2">
      <dt className="text-sm text-muted-foreground">{rotulo}</dt>
      <dd className="min-w-0 text-sm font-medium break-all text-foreground">{children}</dd>
    </div>
  )
}

export function DeploymentHealth() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<DeploymentInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await platformAPI.deployment()
    if (res.success && res.data) {
      setInfo(res.data)
      setError(null)
    } else {
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  if (error !== null) return <p className="text-sm text-destructive">{error || t('deployment.loadFailed')}</p>
  if (!info) return null

  /* Endereço nulo não é falha: num deploy de host único não HÁ subdomínio por
     provedor, e dizer isso com um travessão é mais honesto que deixar vazio. */
  const endereco = (valor: string | null) => valor || '—'

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('deployment.processTitle')}</h2>
        <dl className="mt-2 divide-y divide-border">
          <Linha rotulo={t('deployment.edition')}>
            {t(info.edition === 'saas' ? 'deployment.editionSaas' : 'deployment.editionSelfHosted')}
          </Linha>
          <Linha rotulo={t('deployment.database')}>
            {BANCO[info.database.client] ?? info.database.client}
            {/* De onde veio a conexão. Um deploy apontado para o banco errado é
                quase sempre `DATABASE_URL` ganhando de um `db-config.json`
                esquecido no volume — e sem esta linha os dois casos são
                idênticos na tela. */}
            <span className="ms-2 text-xs font-normal text-muted-foreground">
              {t(info.database.source === 'env' ? 'deployment.dbFromEnv' : 'deployment.dbFromFile')}
            </span>
          </Linha>
        </dl>
      </section>

      <section className="modern-card p-5 sm:p-6">
        <h2 className="section-heading">{t('deployment.addressingTitle')}</h2>
        <dl className="mt-2 divide-y divide-border">
          <Linha rotulo="TENANT_BASE_DOMAIN">{endereco(info.addressing.panelBaseDomain)}</Linha>
          <Linha rotulo="PORTAL_BASE_DOMAIN">{endereco(info.addressing.portalBaseDomain)}</Linha>
          <Linha rotulo="PUBLIC_BASE_URL">{endereco(info.addressing.publicBaseUrl)}</Linha>
          {/* Inteiro, e não "configurado sim/não": é o molde de um endereço, e
              um molde só se confere lendo. Um `{slug}` que não aparece aqui é
              a explicação de por que o onboarding não sugere nada. */}
          <Linha rotulo="GENIEACS_URL_TEMPLATE">
            <span className="font-mono text-xs">{endereco(info.addressing.genieAcsTemplate)}</span>
          </Linha>
        </dl>
        <p className="field-hint mt-4">
          {t(info.addressing.tenantSubdomains ? 'deployment.bySubdomain' : 'deployment.byLogin')}
        </p>
        <p className="field-hint mt-2">
          {t(info.addressing.genieAcsTemplate ? 'deployment.acsTemplateOn' : 'deployment.acsTemplateOff')}
        </p>
      </section>

      <section className="modern-card p-5 sm:p-6 lg:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-heading">{t('deployment.configuredTitle')}</h2>
          <button type="button" className="modern-button-secondary" onClick={() => void load()}>
            <Icon name="refresh" size={17} />
            {t('common.refresh')}
          </button>
        </div>
        <p className="field-hint mt-1">{t('deployment.configuredHint')}</p>
        <ul className="mt-4 space-y-3">
          {CONFIGURADO.map(({ chave, rotulo, ausente }) => {
            const ligado = info.configured[chave]
            return (
              <li key={chave} className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{t(rotulo)}</p>
                  {/* O que a AUSÊNCIA causa, e só quando ela é o caso. É a razão
                      de a tela existir: os sintomas não se parecem com "falta
                      uma variável de ambiente", e são exatamente isso. */}
                  {!ligado && <p className="mt-0.5 text-xs text-muted-foreground">{t(ausente)}</p>}
                </div>
                <span className={ligado ? 'modern-badge-success' : 'modern-badge-warning'}>
                  {t(ligado ? 'deployment.on' : 'deployment.off')}
                </span>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

export default DeploymentHealth
