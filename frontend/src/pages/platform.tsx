'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { platformAPI, type Plan, type PlatformBox, type Tenant } from '@/lib/api'
import { PlanCatalog } from '@/components/platform/plan-catalog'
import { PlatformBoxCard } from '@/components/platform/platform-box'
import { DeploymentHealth } from '@/components/platform/deployment-health'
import { DefaultCatalogueTab } from '@/components/platform/default-catalogue'
import { PlatformAdmins } from '@/components/platform/platform-admins'
import { PlatformAudit } from '@/components/platform/platform-audit'
import { PlatformSettings } from '@/components/platform/platform-settings'
import { PlatformLeads } from '@/components/platform/platform-leads'
import { PlatformSubscriptions } from '@/components/platform/platform-subscriptions'
import { PlatformDelinquency } from '@/components/platform/platform-delinquency'
import { PlatformRevenue } from '@/components/platform/platform-revenue'
import { PlatformCoupons } from '@/components/platform/platform-coupons'
import { PlatformHelp } from '@/components/platform/platform-help'
import { TenantData } from '@/components/platform/tenant-data'
import { TenantGateway } from '@/components/platform/tenant-gateway'
import { TenantGenieAcs } from '@/components/platform/tenant-genieacs'
import { TenantMembers } from '@/components/platform/tenant-members'
import { STATUS_LABEL_KEYS, TenantPlan, statusBadgeClass } from '@/components/platform/tenant-plan'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { exportFileName, formatRelativeTime } from '@/lib/utils'

/**
 * Celular e tablet: a tabela de provedores vira cartões (a coluna de ações
 * espremia nove botões um embaixo do outro). Decidido em JS e não só em CSS
 * porque o painel aberto da linha monta formulários e busca dados — escondido
 * por classe, montaria duas vezes.
 */
const CONSULTA_ESTREITA = '(max-width: 1023px)'

function useEstreito() {
  const [estreito, setEstreito] = useState(() => window.matchMedia?.(CONSULTA_ESTREITA).matches ?? false)
  useEffect(() => {
    const consulta = window.matchMedia?.(CONSULTA_ESTREITA)
    if (!consulta) return
    const mudou = () => setEstreito(consulta.matches)
    consulta.addEventListener('change', mudou)
    return () => consulta.removeEventListener('change', mudou)
  }, [])
  return estreito
}

export default function PlatformPage() {
  const { t } = useTranslation()
  const toast = useToast()

  const [tenants, setTenants] = useState<Tenant[]>([])
  const [loading, setLoading] = useState(true)
  // `null` while the list is fine; otherwise the backend's reason, which may be
  // empty when the request failed without one.
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  // Which panel the expanded row shows: the registry data, the team, or the
  // plan and its statement.
  const [expandedPanel, setExpandedPanel] = useState<'members' | 'plan' | 'data' | 'gateway' | 'genieacs'>('members')
  const [plans, setPlans] = useState<Plan[]>([])
  /** A caixa da plataforma, que vem ao lado da lista e não dentro dela. */
  const [platformBox, setPlatformBox] = useState<PlatformBox | null>(null)
  const [form, setForm] = useState({ slug: '', name: '' })
  /**
   * Qual metade do console está na tela.
   *
   * Abas e não quatro telas porque as quatro respondem à mesma pergunta —
   * "como está a plataforma" — e porque o catálogo de planos só faz sentido ao
   * lado de quem os assina. Provedores é o padrão: é o que se abre para fazer
   * alguma coisa; as outras três são consulta ou manutenção rara.
   */
  const estreito = useEstreito()
  const [aba, setAba] = useState<'tenants' | 'plans' | 'subscriptions' | 'delinquency' | 'revenue' | 'coupons' | 'leads' | 'admins' | 'audit' | 'settings' | 'deployment' | 'catalogue' | 'help'>('tenants')

  const loadTenants = useCallback(async () => {
    const plansRes = await platformAPI.listPlans()
    if (plansRes.success && plansRes.data) setPlans(plansRes.data.plans)
    setLoading(true)
    const res = await platformAPI.listTenants()
    if (res.success && res.data) {
      setTenants(res.data.tenants)
      setPlatformBox(res.data.platformBox)
      setError(null)
    } else {
      setTenants([])
      setPlatformBox(null)
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadTenants()
  }, [loadTenants])

  /**
   * Abre o painel pedido na linha pedida, e fecha quando já era esse o painel
   * aberto ali.
   *
   * Escrito uma vez porque são três botões agora. O estado é lido FORA do
   * atualizador de propósito: `painel` é o que se quer e `expandedPanel` é o que
   * está, e comparar um com o outro dentro do atualizador leria o valor já
   * trocado.
   */
  const abrirPainel = (id: number, painel: 'members' | 'plan' | 'data' | 'gateway' | 'genieacs') => {
    const fechando = expandedId === id && expandedPanel === painel
    setExpandedPanel(painel)
    setExpandedId(fechando ? null : id)
  }

  const resetForm = () => {
    setForm({ slug: '', name: '' })
    setCreating(false)
  }

  const submitTenant = async () => {
    const slug = form.slug.trim()
    const name = form.name.trim()
    if (!slug || !name) return
    setSaving(true)
    try {
      const res = await platformAPI.createTenant({ slug, name })
      if (res.success) {
        resetForm()
        await loadTenants()
      } else {
        // 400 for a slug that is not a subdomain, 409 for one already taken:
        // the backend names which, and it says more than a generic line would.
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  /**
   * Abre uma sessão de leitura no painel de um provedor, em OUTRA ABA.
   *
   * O que volta é um endereço com um bilhete no fragmento, e o que se faz com
   * ele é ir para lá. Em outra aba porque quem olha o painel de um cliente
   * está no meio de um atendimento: voltar para a lista de provedores depois
   * custava um login novo no console, e a aba de trás guarda o lugar.
   *
   * A aba é aberta ANTES da chamada, ainda dentro do clique. Um `window.open`
   * depois do `await` chega sem gesto do usuário e o navegador o trata como
   * pop-up — o Safari bloqueia sempre, os outros às vezes. Ela nasce em branco
   * e recebe o endereço quando o bilhete volta; se o bilhete falhar, fecha.
   *
   * Sem `noopener`: com ele o navegador devolve `null` em vez da janela, e sem
   * a referência não há como levá-la ao endereço. O destino é o nosso próprio
   * `/impersonate`, não uma página de terceiro, então o que `noopener` protege
   * aqui não está em jogo.
   *
   * Vale para os dois tipos de instalação, com subdomínio por provedor ou num
   * host só. Nesta última o painel divide o origin com o console, e é por isso
   * que a sessão de personificação vive no `sessionStorage` — ver `tabOnly` em
   * `adoptSession`: sem isso a aba nova trocaria a sessão do console pela do
   * provedor e quebraria em silêncio a aba que se queria preservar.
   *
   * Uma única saída volta a navegar aqui mesmo: pop-up bloqueado, porque ir
   * para o painel nesta aba é melhor que não ir.
   *
   * Confirma antes porque a ação deixa rastro nos dois lados — na nossa trilha
   * e na do cliente — e porque entrar no painel de um cliente é coisa que se
   * faz de propósito, nunca por um clique errado numa linha vizinha.
   */
  const impersonar = async (tenant: Tenant) => {
    if (!window.confirm(t('platform.impersonateConfirm', { provider: tenant.name }))) return
    const aba = window.open('', '_blank')
    // Corta o `window.opener` enquanto a aba ainda é `about:blank` e do mesmo
    // origin: depois de navegar ela vira outro origin e a atribuição não pega
    // mais. Sem isso o painel do provedor poderia redirecionar esta aba do
    // console (reverse tabnabbing). Não dá para usar `noopener` no `open`,
    // porque aí ele devolve null e perderíamos a detecção de pop-up bloqueado.
    if (aba) aba.opener = null
    setBusyId(tenant.id)
    try {
      const res = await platformAPI.impersonate(tenant.id)
      if (!res.success || !res.data) {
        aba?.close()
        toast.error(res.message || t('platform.impersonateFailed'))
        return
      }
      const url = res.data.url
      if (aba) {
        // `replace` e não `assign`: a aba nova não tem histórico que valha, e o
        // `about:blank` no lugar dela deixaria um "voltar" que não volta.
        aba.location.replace(url)
        aba.focus()
        return
      }
      window.location.assign(url)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Baixa o cadastro inteiro de um provedor.
   *
   * Fica ao lado de suspender e apagar, e não escondido numa aba, porque é o
   * passo que vem ANTES do apagar. A ordem obrigatória do console é suspender e
   * só então excluir — e suspenso o provedor perde o acesso ao painel dele,
   * inclusive à exportação própria. Este botão é a janela que aquela ordem
   * fechava, e por isso ele aparece nos dois estados.
   *
   * Sem confirmação: é leitura, e o que ela produz fica no computador de quem
   * clicou. O que ela tem de sério é o registro, e esse o servidor grava nas
   * duas trilhas — a da plataforma e a do próprio provedor.
   */
  const exportar = async (tenant: Tenant) => {
    setBusyId(tenant.id)
    try {
      const res = await platformAPI.exportTenant(tenant.id)
      if (!res.success || !res.blob) {
        toast.error(res.message || t('platform.exportFailed'))
        return
      }
      const url = URL.createObjectURL(res.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = res.filename || exportFileName(tenant.slug)
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success(t('platform.exported', { provider: tenant.name }))
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Apaga um provedor e tudo o que é dele.
   *
   * A confirmação pede o SLUG digitado, e não um "tem certeza?". A diferença
   * importa: um `confirm` é um Enter distraído, e isto não tem volta — leva os
   * assinantes, os equipamentos, as conversas e a trilha DELE. Digitar o nome
   * obriga a pessoa a olhar qual linha ela está prestes a apagar, que é
   * exatamente o erro que a tela precisa impedir.
   *
   * A comparação é frouxa de propósito (espaços e caixa), porque o que se quer
   * provar é atenção, não datilografia.
   */
  const apagar = async (tenant: Tenant) => {
    const digitado = window.prompt(t('platform.deletePrompt', { slug: tenant.slug, provider: tenant.name }))
    if (digitado === null) return
    if (digitado.trim().toLowerCase() !== tenant.slug.toLowerCase()) {
      toast.error(t('platform.deleteMismatch'))
      return
    }
    setBusyId(tenant.id)
    try {
      // O slug EXATO da linha, e não o digitado: a conferência acima tolera
      // espaço e maiúscula, e a do servidor não.
      const res = await platformAPI.deleteTenant(tenant.id, tenant.slug)
      if (!res.success) {
        toast.error(res.message || t('platform.deleteFailed'))
        return
      }
      toast.success(t('platform.deleted', { provider: tenant.name }))
      // A linha expandida pode ser justamente a que sumiu.
      setExpandedId(null)
      await loadTenants()
    } finally {
      setBusyId(null)
    }
  }

  const toggleStatus = async (tenant: Tenant) => {
    const next = tenant.status === 'active' ? 'suspended' : 'active'
    // Only suspending is asked about: it stops every background job for that
    // provider and locks its people out, while reactivating merely undoes it.
    if (next === 'suspended' && !window.confirm(t('platform.suspendConfirm'))) return
    setBusyId(tenant.id)
    try {
      const res = await platformAPI.setTenantStatus(tenant.id, next)
      const updated = res.success ? res.data?.tenant : undefined
      if (updated) {
        // The row itself flipping is the confirmation; there is no toast to
        // dismiss on top of it.
        setTenants((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusyId(null)
    }
  }

  // As células e os botões de uma linha, escritos uma vez: a tabela e os
  // cartões do celular mostram as mesmas coisas.
  const statusDe = (tenant: Tenant) => {
    const active = tenant.status === 'active'
    return (
      <>
        <span className={active ? 'modern-badge-success' : 'modern-badge-warning'}>
          {t(active ? 'platform.statusActive' : 'platform.statusSuspended')}
        </span>
        {/* Desde quando, e só para o suspenso: num ativo a
            informação não existe. "Suspenso" sozinho não
            distingue quem parou semana passada de quem está
            parado há dois anos guardando CPF e contrato dos
            assinantes — e era essa a diferença invisível. */}
        {!active && (
          <span className="mt-1 block text-xs text-muted-foreground">
            {tenant.suspendedAt
              ? t('platform.suspendedHowLong', {
                when: formatRelativeTime(tenant.suspendedAt)
              })
              : t('platform.suspendedHowLongUnknown')}
          </span>
        )}
      </>
    )
  }

  const planoDe = (tenant: Tenant) => (
    tenant.subscription ? (
      <span className="flex flex-wrap items-center gap-2">
        <span>{tenant.subscription.planName ?? tenant.subscription.planCode ?? '—'}</span>
        <span className={statusBadgeClass(tenant.subscription.status)}>
          {t(STATUS_LABEL_KEYS[tenant.subscription.status])}
        </span>
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    )
  )

  const acoesDe = (tenant: Tenant) => {
    const active = tenant.status === 'active'
    const expanded = expandedId === tenant.id
    return (
      <div className="flex flex-wrap items-center gap-2">
        {/* Primeiro do grupo: é o que responde "o que está
            cadastrado aqui", e é a pergunta que se faz da
            linha antes de mexer em equipe ou em plano. */}
        <button
          type="button"
          onClick={() => abrirPainel(tenant.id, 'data')}
          className="modern-button-secondary"
          aria-expanded={expanded && expandedPanel === 'data'}
        >
          <Icon name="edit" size={17} />
          {t('platform.data.edit')}
        </button>
        <button
          type="button"
          onClick={() => abrirPainel(tenant.id, 'members')}
          className="modern-button-secondary"
          aria-expanded={expanded && expandedPanel === 'members'}
        >
          {t('platform.members')}
        </button>
        <button
          type="button"
          onClick={() => abrirPainel(tenant.id, 'plan')}
          className="modern-button-secondary"
          aria-expanded={expanded && expandedPanel === 'plan'}
        >
          {t('platform.subscription.plan')}
        </button>
        {/* A correlação com o gateway mora aqui e não na
            aba de plano: plano é o que o cliente comprou,
            isto é quem ele é num sistema de fora — e quem
            mexe num não está necessariamente mexendo no
            outro. */}
        <button
          type="button"
          onClick={() => abrirPainel(tenant.id, 'gateway')}
          className="modern-button-secondary"
          aria-expanded={expanded && expandedPanel === 'gateway'}
        >
          {t('platform.gateway.tab')}
        </button>
        {/* Na SaaS é a plataforma quem aponta o painel de
            cada provedor para o ACS dele; a tela de
            Configuração do provedor só mostra e testa. */}
        <button
          type="button"
          onClick={() => abrirPainel(tenant.id, 'genieacs')}
          className="modern-button-secondary"
          aria-expanded={expanded && expandedPanel === 'genieacs'}
        >
          {t('platform.genieacs.tab')}
        </button>
        {/* Só de um provedor ativo: o painel de um suspenso
            está fora do ar para os operadores dele, e é
            isso que a personificação mostraria. */}
        {active && (
          <button
            type="button"
            onClick={() => void impersonar(tenant)}
            disabled={busyId === tenant.id}
            className="modern-button-secondary"
          >
            <Icon name="eye" size={17} />
            {t('platform.impersonate')}
          </button>
        )}
        <button
          type="button"
          onClick={() => void toggleStatus(tenant)}
          disabled={busyId === tenant.id}
          className="modern-button-secondary"
        >
          <Icon name="power" size={17} />
          {t(active ? 'platform.suspend' : 'platform.reactivate')}
        </button>
        {/* Nos DOIS estados, e é o ponto: suspenso, o
            provedor não alcança a exportação dele — e
            suspender é o que a exclusão exige antes. Vem
            ANTES do apagar porque é a ordem em que se
            usa. */}
        <button
          type="button"
          onClick={() => void exportar(tenant)}
          disabled={busyId === tenant.id}
          className="modern-button-secondary"
        >
          <Icon name="database" size={17} />
          {t('platform.export')}
        </button>
        {/* Só de um provedor SUSPENSO: apagar é o fim de
            uma conversa que começou com a suspensão, e
            exigir os dois passos dá ao cliente a janela
            entre "seu painel parou" e "seus dados foram
            embora" — janela que agora tem porta, no botão
            acima. */}
        {!active && (
          <button
            type="button"
            onClick={() => void apagar(tenant)}
            disabled={busyId === tenant.id}
            className="modern-button-secondary text-destructive"
          >
            <Icon name="trash" size={17} />
            {t('platform.delete')}
          </button>
        )}
      </div>
    )
  }

  const painelDe = (tenant: Tenant) => (
    expandedPanel === 'data' ? (
      <TenantData tenant={tenant} onTenantChange={() => void loadTenants()} />
    ) : expandedPanel === 'members' ? (
      <TenantMembers tenant={tenant} onMembershipChange={() => void loadTenants()} />
    ) : expandedPanel === 'gateway' ? (
      <TenantGateway tenant={tenant} onTenantChange={() => void loadTenants()} />
    ) : expandedPanel === 'genieacs' ? (
      <TenantGenieAcs tenant={tenant} />
    ) : (
      <TenantPlan tenant={tenant} plans={plans} onSubscriptionChange={() => void loadTenants()} />
    )
  )

  return (
    <div className="page-shell pb-8">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <h1 className="page-title">{t('platform.title')}</h1>
            <p className="page-description">{t('platform.subtitle')}</p>
          </div>
          {/* Os dois botões são da aba de provedores; nas outras eles
              agiriam sobre o que não está na tela. */}
          {aba === 'tenants' && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => (creating ? resetForm() : setCreating(true))}
                className="modern-button"
              >
                <Icon name="building" size={17} />
                {t(creating ? 'common.cancel' : 'platform.newTenant')}
              </button>
              <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void loadTenants()}>
                <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
                {t('common.refresh')}
              </button>
            </div>
          )}
        </header>

        {/* No celular, uma faixa que rola de lado: as onze abas quebradas em
            linhas ocupavam a primeira tela inteira antes do conteúdo. */}
        <nav className="-mx-4 mb-6 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0" aria-label={t('platform.title')}>
          {([
            ['tenants', 'platform.tabs.tenants'],
            ['plans', 'platform.tabs.plans'],
            // Ao lado de Planos: é o catálogo visto do lado de quem paga — quem
            // está em dia, quem deve, e a mão para dar baixa ou renegociar.
            ['subscriptions', 'platform.tabs.subscriptions'],
            // Logo depois: o recorte de quem deve, com as ações em massa.
            ['delinquency', 'platform.tabs.delinquency'],
            // Depois de Assinaturas: a mesma carteira, somada — quanto entra por
            // mês, quanto entrou e voltou, e de que plano vem.
            ['revenue', 'platform.tabs.revenue'],
            // Os cupons de desconto, ao lado de quem os usa.
            ['coupons', 'platform.tabs.coupons'],
            // Quem pediu demonstração pela página pública — o funil antes da
            // assinatura.
            ['leads', 'platform.tabs.leads'],
            ['admins', 'platform.tabs.admins'],
            ['audit', 'platform.tabs.audit'],
            // Configurações: os dados da empresa que vende o SaaS (o que o site
            // mostra) e as integrações (a conta Asaas). Telas de configurar
            // uma vez, antes das de consulta.
            ['settings', 'platform.tabs.settings'],
            // As duas últimas são as de consulta mais rara: não se abre o
            // console para olhar variável de ambiente nem catálogo de
            // fabricante, abre-se quando alguma coisa não chegou ou um
            // provedor não está reconhecendo os aparelhos dele.
            ['deployment', 'platform.tabs.deployment'],
            ['catalogue', 'platform.tabs.catalogue'],
            // O manual de cobrança, por último: é o que se abre quando não se
            // sabe em qual das outras abas está a resposta.
            ['help', 'platform.tabs.help']
          ] as const).map(([chave, rotulo]) => (
            <button
              key={chave}
              type="button"
              onClick={() => setAba(chave)}
              aria-current={aba === chave ? 'page' : undefined}
              className={`shrink-0 whitespace-nowrap ${aba === chave ? 'modern-button' : 'modern-button-secondary'}`}
            >
              {t(rotulo)}
            </button>
          ))}
        </nav>

        {aba === 'plans' && <PlanCatalog plans={plans} onChange={() => void loadTenants()} />}
        {aba === 'subscriptions' && <PlatformSubscriptions plans={plans} estreito={estreito} />}
        {aba === 'delinquency' && <PlatformDelinquency />}
        {aba === 'revenue' && <PlatformRevenue />}
        {aba === 'coupons' && <PlatformCoupons plans={plans} />}
        {aba === 'leads' && <PlatformLeads />}
        {aba === 'admins' && <PlatformAdmins />}
        {aba === 'audit' && <PlatformAudit />}
        {aba === 'settings' && <PlatformSettings />}
        {aba === 'deployment' && <DeploymentHealth />}
        {aba === 'catalogue' && <DefaultCatalogueTab />}
        {aba === 'help' && <PlatformHelp />}

        {aba === 'tenants' && <PlatformBoxCard box={platformBox} />}

        {aba === 'tenants' && creating && (
          <div className="modern-card mb-6 p-5 sm:p-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="tenant-slug" className="block text-sm font-medium mb-1">{t('platform.slug')}</label>
                <input
                  id="tenant-slug"
                  value={form.slug}
                  // Lower cased as it is typed: the slug becomes a hostname, and
                  // a capital typed here would only come back as a 400.
                  onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }))}
                  className="modern-input w-full"
                  autoComplete="off"
                />
                <p className="field-hint">{t('platform.slugHint')}</p>
              </div>
              <div>
                <label htmlFor="tenant-name" className="block text-sm font-medium mb-1">{t('platform.name')}</label>
                <input
                  id="tenant-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="modern-input w-full"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void submitTenant()}
                disabled={saving || form.slug.trim() === '' || form.name.trim() === ''}
                className="modern-button"
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
              <button type="button" onClick={resetForm} className="modern-button-secondary">{t('common.cancel')}</button>
            </div>
          </div>
        )}

        {aba === 'tenants' && estreito && (
          <div className="space-y-3">
            {loading ? (
              <p className="modern-card py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
            ) : error !== null ? (
              <p className="modern-card py-8 text-center text-sm text-destructive">{error || t('platform.loadFailed')}</p>
            ) : tenants.length === 0 ? (
              <p className="modern-card py-8 text-center text-sm text-muted-foreground">{t('platform.empty')}</p>
            ) : (
              tenants.map((tenant) => (
                <article key={tenant.id} className="modern-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="wrap-break-word font-semibold text-foreground">{tenant.name}</h2>
                      <p className="break-all font-mono text-xs text-muted-foreground">{tenant.slug}</p>
                    </div>
                    <div className="sm:text-end">{statusDe(tenant)}</div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                    {planoDe(tenant)}
                    <span className="text-muted-foreground">{t('platform.operators', { count: tenant.operators })}</span>
                  </div>
                  <div className="mt-4 border-t border-border pt-4">{acoesDe(tenant)}</div>
                  {expandedId === tenant.id && (
                    <div className="mt-4 min-w-0 border-t border-border pt-4">{painelDe(tenant)}</div>
                  )}
                </article>
              ))
            )}
          </div>
        )}

        {aba === 'tenants' && !estreito && (
        <div className="modern-card overflow-x-auto">
          <table className="modern-table">
            <thead>
              <tr>
                <th>{t('platform.name')}</th>
                <th>{t('platform.slug')}</th>
                <th>{t('common.status')}</th>
                <th>{t('platform.subscription.plan')}</th>
                <th>{t('platform.members')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">{t('common.loading')}</td>
                </tr>
              ) : error !== null ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-destructive">{error || t('platform.loadFailed')}</td>
                </tr>
              ) : tenants.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">{t('platform.empty')}</td>
                </tr>
              ) : (
                tenants.map((tenant) => {
                  const expanded = expandedId === tenant.id
                  return (
                    <Fragment key={tenant.id}>
                      <tr>
                        <td className="font-medium">{tenant.name}</td>
                        <td className="font-mono text-sm">{tenant.slug}</td>
                        <td>{statusDe(tenant)}</td>
                        <td className="text-sm">{planoDe(tenant)}</td>
                        <td className="text-sm text-muted-foreground">
                          {t('platform.operators', { count: tenant.operators })}
                        </td>
                        <td>{acoesDe(tenant)}</td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={6}>{painelDe(tenant)}</td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </div>
  )
}
