import type { TranslationKey } from '@/lib/i18n/dictionary'
import type { Permission } from '@/lib/permissions'

/**
 * Quais telas este painel tem.
 *
 * A lista morava dentro de `components/sidebar.tsx`, onde servia só para
 * desenhar o menu. Saiu de lá quando a tela do mapa passou a precisar dela: uma
 * segunda lista de telas, redigitada ao lado, seria uma segunda verdade sobre o
 * que existe no produto — e a maneira como ela erra é a silenciosa. Ninguém
 * descobre que o mapa envelheceu; ele só vai ficando menos verdadeiro que o
 * menu, e quem consulta "onde fica X" não encontra o X que foi acrescentado
 * depois.
 *
 * `frontend/test/screens.test.ts` lê as rotas da fonte de `app.tsx` e exige que
 * toda tela autenticada esteja classificada aqui. É a mesma guarda que
 * `backend/test/lgpd-inventario.test.js` faz do outro lado, pelo mesmo motivo.
 */

/** Em que parte do produto a tela mora — os grupos do mapa. */
export type ScreenGroup = 'operation' | 'administration' | 'platform'

export type MenuScreen = {
  href: string
  labelKey: TranslationKey
  descriptionKey: TranslationKey
  icon: string
  /**
   * A capacidade que a tela precisa para ABRIR, a mesma que guarda a rota em
   * `app.tsx`: um item que aparece e leva a um redirecionamento é pior do que
   * item nenhum.
   */
  permission: Permission
  group: ScreenGroup
  /** Tela sobre assinatura não tem o que mostrar num install sem assinatura. */
  saasOnly?: true
  /**
   * Um portão A MAIS, sobre um fato DIFERENTE: o plano de controle fica acima do
   * administrador do provedor, e nenhuma capacidade da matriz responde por ele.
   * Guardado só pela capacidade, este item apareceria para quase todo
   * administrador do painel e levaria a rotas que respondem 404 para eles — e,
   * numa instalação self-hosted, a rotas que não estão montadas.
   */
  platformOnly?: true
}

/**
 * Os itens do menu, na ordem em que a barra lateral os desenha. A ordem é a do
 * menu e não a dos grupos: mudar de lugar um item que o operador procura no
 * mesmo canto desde sempre não é ganho nenhum. O mapa reagrupa na tela dele.
 */
export const MENU_SCREENS: readonly MenuScreen[] = [
  { href: '/dashboard', labelKey: 'sidebar.nav.dashboard', descriptionKey: 'sidebar.nav.dashboardDescription', icon: 'dashboard', permission: 'devices.list', group: 'operation' },
  { href: '/whatsapp', labelKey: 'sidebar.nav.whatsapp', descriptionKey: 'sidebar.nav.whatsappDescription', icon: 'chat', permission: 'whatsapp.read', group: 'operation' },
  { href: '/devices', labelKey: 'sidebar.nav.devices', descriptionKey: 'sidebar.nav.devicesDescription', icon: 'devices', permission: 'devices.list', group: 'operation' },
  { href: '/contacts', labelKey: 'sidebar.nav.contacts', descriptionKey: 'sidebar.nav.contactsDescription', icon: 'contacts', permission: 'whatsapp.read', group: 'operation' },
  { href: '/network-map', labelKey: 'sidebar.nav.networkMap', descriptionKey: 'sidebar.nav.networkMapDescription', icon: 'map', permission: 'map.read', group: 'operation' },
  { href: '/audit', labelKey: 'sidebar.nav.audit', descriptionKey: 'sidebar.nav.auditDescription', icon: 'trail', permission: 'audit.read', group: 'administration' },
  { href: '/plan', labelKey: 'sidebar.nav.plan', descriptionKey: 'sidebar.nav.planDescription', icon: 'invoice', permission: 'settings.read', group: 'administration', saasOnly: true },
  { href: '/platform', labelKey: 'sidebar.nav.platform', descriptionKey: 'sidebar.nav.platformDescription', icon: 'settings', permission: 'settings.read', group: 'platform', platformOnly: true },
  { href: '/settings', labelKey: 'sidebar.nav.settings', descriptionKey: 'sidebar.nav.settingsDescription', icon: 'settings', permission: 'settings.read', group: 'administration' },
]

/**
 * Quais itens esta sessão abre.
 *
 * Era um filtro de cinco linhas dentro do corpo de `SidebarContent`, e o
 * comentário que o acompanhava contava um acidente: `isSaas` lido DEPOIS do
 * filtro caía na zona morta temporal e matava toda tela autenticada com
 * "Cannot access 'isSaas' before initialization" — página preta, para todo
 * operador, em toda rota, e o `tsc` não vê porque a leitura acontece dentro de
 * um callback. Fora do componente a armadilha deixa de existir: os três fatos
 * chegam como argumento, e não há ordem de declaração para acertar.
 */
export function visibleMenuScreens(
  { can, isSaas, isPlatformAdmin }: {
    can: (permission: Permission) => boolean
    isSaas: boolean
    isPlatformAdmin: boolean
  }
): readonly MenuScreen[] {
  return MENU_SCREENS.filter((item) => can(item.permission)
    && (!item.platformOnly || isPlatformAdmin)
    && (!item.saasOnly || isSaas))
}

export type InnerScreen = {
  /** Sem link, de propósito — ver abaixo. */
  path: string
  labelKey: TranslationKey
  /** Como se chega: é essa frase que responde onde a tela mora. */
  reachedKey: TranslationKey
  permission: Permission
}

/**
 * As telas que existem e não são destino.
 *
 * Nenhuma delas abre sozinha: `/devices/detail` sem `?id=` é a tela de "não deu
 * para abrir o aparelho", e `/contacts/:key` sem chave não é rota. Um link para
 * elas no mapa seria um botão que não funciona — pior do que a ausência, porque
 * parece navegação. Entram nomeadas, com a frase de como se chega.
 *
 * `/onboarding` é outro caso: tem endereço próprio e abre, mas quem o alcança é
 * levado por `OnboardingGate`, não por um menu. Linkar seria convidar a refazer
 * uma configuração que já está feita.
 */
export const INNER_SCREENS: readonly InnerScreen[] = [
  { path: '/devices/detail', labelKey: 'siteMap.inner.device', reachedKey: 'siteMap.inner.deviceReached', permission: 'devices.list' },
  { path: '/contacts/:key', labelKey: 'siteMap.inner.contact', reachedKey: 'siteMap.inner.contactReached', permission: 'whatsapp.read' },
  { path: '/onboarding', labelKey: 'siteMap.inner.onboarding', reachedKey: 'siteMap.inner.onboardingReached', permission: 'settings.write' },
]

/**
 * As seções de Configuração, que são abas e não rotas — e mesmo assim têm
 * endereço: `settings.tsx` lê `?tab=` justamente para que outra tela possa
 * apontar para uma seção em vez de descrever onde ela fica. O mapa é a primeira
 * tela a usar isso para as quinze.
 *
 * Os ids são os de `SETTINGS_TABS` em `pages/settings.tsx`, e as chaves são as
 * que a trilha de abas já mostra — nenhuma tradução nova.
 */
export type SettingsSection = {
  tab: string
  labelKey: TranslationKey
  /**
   * Uma capacidade A MAIS, onde a seção tem a sua. São as duas que
   * `IntegrationsHub` já esconde de quem não as tem — e esconder o cartão lá
   * enquanto o mapa oferece o link seria contornar a regra pela porta nova.
   */
  permission?: Permission
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { tab: 'provider', labelKey: 'settings.tab.provider' },
  { tab: 'general', labelKey: 'settings.tab.general' },
  { tab: 'virtual-params', labelKey: 'settings.tab.virtualParams' },
  { tab: 'customer-portal', labelKey: 'settings.tab.customerPortal' },
  { tab: 'integrations', labelKey: 'settings.tab.integrations' },
  { tab: 'sgp', labelKey: 'settings.tab.sgp' },
  { tab: 'teiah', labelKey: 'settings.tab.teiah', permission: 'teiah.read' },
  { tab: 'focuschat', labelKey: 'settings.tab.focuschat', permission: 'settings.write' },
  { tab: 'provisioning', labelKey: 'settings.tab.provisioning' },
  // O rótulo é o do menu, e é o mesmo que o cartão de integrações usa: não
  // existe `settings.tab.whatsapp`, e inventar um daria dois nomes para a
  // mesma seção em 13 idiomas.
  { tab: 'whatsapp', labelKey: 'sidebar.nav.whatsapp' },
  { tab: 'chatbot', labelKey: 'settings.tab.chatbot', permission: 'whatsapp.config' },
  { tab: 'security', labelKey: 'settings.tab.security' },
  { tab: 'vendors', labelKey: 'settings.tab.vendors' },
  { tab: 'wifi-security', labelKey: 'settings.tab.wifiSecurity' },
  { tab: 'database', labelKey: 'settings.tab.database' },
  { tab: 'about', labelKey: 'settings.tab.about' },
]

/**
 * Quais seções de Configuração o mapa oferece.
 *
 * `database` sai na edição hospedada, porque lá a aba não existe — a rota do
 * banco não é montada, e o link abriria uma aba vazia. TeiaH e chatbot saem de
 * quem não tem a capacidade delas, que é o que o cartão de integrações já faz.
 *
 * `virtual-params` FICA, mesmo quando o ACS é da plataforma e a aba não aparece
 * na trilha. Não é esquecimento: `settings.tsx` já tira dali quem não tem a aba
 * e manda para a primeira que tem, depois de descobrir de quem é o ACS. Um
 * `?tab=` que não se aplica degrada para "abriu Configuração", nunca para tela
 * branca. Replicar a condição aqui exigiria buscar de quem é o ACS só para
 * desenhar um link — e seriam duas leituras da mesma regra, livres para
 * discordar.
 */
export function visibleSettingsSections(
  { can, isSaas }: { can: (permission: Permission) => boolean, isSaas: boolean }
): readonly SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => (section.tab !== 'database' || !isSaas)
    && (!section.permission || can(section.permission)))
}
