'use client'

import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTheme } from '@/contexts/theme-context'
import { useAuth } from '@/contexts/auth-context'
import { useTenant } from '@/contexts/tenant-context'
import { useTranslation } from '@/contexts/language-context'
import { LanguageSwitcher } from '@/components/language-switcher'
import { Icon } from '@/components/ui/icon'
import { BrandMark } from '@/components/brand-mark'
import { APP_RELEASE, ReleaseNotesModal } from '@/components/release-notes-modal'

/** "1.17.0 (3acef98)": a versão e o commit do build, quando há. */
const APP_VERSION_LABEL = __APP_COMMIT__ ? `${APP_RELEASE.version} (${__APP_COMMIT__})` : APP_RELEASE.version
import { normalizeRole, ROLE_LABEL_KEYS } from '@/lib/permissions'
import { visibleMenuScreens } from '@/lib/screens'
import { wearingPlatformHat } from '@/lib/shell'


/**
 * O que os dois cabeçalhos (o do menu e a barra do celular) dizem sobre de
 * quem é o painel aberto.
 *
 * Pelo TOKEN (`user.tenant`), e não pelo host: num host único o perfil público
 * nomeia sempre o primeiro provedor, e o cabeçalho diria o nome de um
 * provedor enquanto a sessão é de outro. Até `/auth/user` responder, vale o
 * nome do host.
 */
function useSessionHeader(naPlataforma: boolean) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { name: appName } = useTenant()
  const sessionName = user?.tenant?.name || appName
  const platformSession = naPlataforma || Boolean(user?.platform)
  const headerSubtitle = platformSession
    ? t('sidebar.platformAdmin')
    : user?.tenant?.slug
      ? t('sidebar.providerSlug', { slug: user.tenant.slug })
      : t('app.tagline')
  return { sessionName, platformSession, headerSubtitle }
}

export default function Sidebar() {
  const { t } = useTranslation()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isMobileOpen, setIsMobileOpen] = useState(false)
  const { pathname } = useLocation()
  const { user: sessionUser } = useAuth()
  const { tenant: hostTenant } = useTenant()
  const mobileHeader = useSessionHeader(wearingPlatformHat({
    pathname, panelBaseDomain: hostTenant?.panelBaseDomain, isPlatformAdmin: Boolean(sessionUser?.isPlatformAdmin)
  }))

  useEffect(() => {
    setIsMobileOpen(false)
  }, [pathname])

  // Gaveta aberta: Esc fecha, e a página de trás não rola junto com o dedo.
  useEffect(() => {
    if (!isMobileOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setIsMobileOpen(false) }
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      window.removeEventListener('keydown', onKey)
    }
  }, [isMobileOpen])

  const hideOnRoutes = ['/login', '/setup']
  if (hideOnRoutes.some((route) => pathname.startsWith(route))) return null

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)


  return (
    <>
      <header className="fixed inset-x-0 top-0 z-1200 flex h-16 items-center justify-between border-b border-border bg-card pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] lg:hidden">
        <Link to="/dashboard" className="flex min-h-11 min-w-0 items-center gap-2.5" aria-label={t('sidebar.operationsAria')}>
          <BrandMark className="size-8 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-sm font-bold leading-tight">{mobileHeader.sessionName}</div>
            <div className="truncate text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{mobileHeader.headerSubtitle}</div>
          </div>
        </Link>
        <button
          type="button"
          onClick={() => setIsMobileOpen(true)}
          className="icon-button shrink-0"
          aria-label={t('sidebar.openNavigation')}
          aria-expanded={isMobileOpen}
        >
          <Icon name="menu" size={23} />
        </button>
      </header>

      {isMobileOpen && (
        <div className="fixed inset-0 z-2000 lg:hidden" role="dialog" aria-modal="true" aria-label={t('sidebar.mainNavigation')}>
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            onClick={() => setIsMobileOpen(false)}
            aria-label={t('sidebar.closeNavigation')}
          />
          <aside className="relative flex h-full w-[min(86vw,19rem)] flex-col overscroll-contain bg-[#18211d] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-[#f4f3ed] shadow-2xl">
            <SidebarContent isCollapsed={false} isActive={isActive} closeMobile={() => setIsMobileOpen(false)} />
          </aside>
        </div>
      )}

      <aside
        className={`sticky top-0 z-1000 hidden h-screen max-h-screen shrink-0 self-start flex-col overflow-visible bg-[#18211d] text-[#f4f3ed] transition-[width] duration-200 lg:flex ${
          isCollapsed ? 'w-19' : 'w-66'
        }`}
      >
        <SidebarContent isCollapsed={isCollapsed} isActive={isActive} />
        <button
          type="button"
          onClick={() => setIsCollapsed((value) => !value)}
          aria-label={isCollapsed ? t('sidebar.expandNavigation') : t('sidebar.collapseNavigation')}
          className="absolute -inset-e-3 top-[5.1rem] z-10 flex size-7 items-center justify-center rounded-full border border-[#3a4942] bg-[#202c27] text-[#cad3ce] shadow-xs transition-colors hover:bg-[#2b3933] hover:text-white"
        >
          <Icon name={isCollapsed ? 'chevron-right' : 'chevron-left'} size={15} />
        </button>
      </aside>
    </>
  )
}

function SidebarContent({
  isCollapsed,
  isActive,
  closeMobile,
}: {
  isCollapsed: boolean
  isActive: (href: string) => boolean
  closeMobile?: () => void
}) {
  const { isDarkMode, toggleDarkMode } = useTheme()
  const { user, logout, can } = useAuth()
  // The provider's name, from the row that IS the provider. It used to come
  // from `settings.appName` through `localStorage` and a custom event — three
  // places that agreed in none of them for the first second after a change.
  //
  // Este `isSaas` já custou uma tela preta para todo operador, em toda rota:
  // enquanto o filtro do menu era um callback aqui dentro, ele LIA `isSaas` do
  // escopo, e com esta linha declarada depois a leitura caía na zona morta
  // temporal — "Cannot access 'isSaas' before initialization" —, que o `tsc`
  // não vê porque acontece dentro de um callback.
  //
  // Agora o filtro é `visibleMenuScreens`, que recebe os três fatos como
  // argumento. A ordem continua importando, mas pelo motivo banal (não se passa
  // o que ainda não foi declarado) e com o compilador avisando.
  const { name: appName, isSaas, tenant } = useTenant()
  const isPlatformAdmin = Boolean(user?.isPlatformAdmin)
  /**
   * O console vive no endereço da plataforma, que é OUTRO host.
   *
   * Onde há domínio-base, este item deixa de ser uma rota desta casca e passa a
   * ser um link para fora — para `https://<base>/platform`. Um `Link` do
   * roteador não atravessa origin, e continuar apontando para `/platform` aqui
   * levaria a uma tela cujas requisições o próprio endereço recusa.
   */
  const consoleForaDaqui = tenant?.panelBaseDomain ? `https://${tenant.panelBaseDomain}/platform` : null
  /**
   * O chapéu que esta barra está usando agora — ver `wearingPlatformHat`.
   *
   * `useLocation` aqui e não o `isActive` que vem de fora: aquele responde "é
   * esta a rota ativa?" item a item, e a pergunta desta linha é outra, sobre a
   * tela inteira. Dá no mesmo hoje; misturar as duas faria o próximo a mexer
   * num dos lados mover o outro sem querer.
   */
  const { pathname } = useLocation()
  const naPlataforma = wearingPlatformHat({
    pathname, panelBaseDomain: tenant?.panelBaseDomain, isPlatformAdmin
  })
  const visibleItems = visibleMenuScreens({ can, isSaas, isPlatformAdmin })
  const { t } = useTranslation()
  const displayName = user?.username || t('sidebar.defaultOperator')
  const initial = displayName.slice(0, 1).toUpperCase()
  const [showReleaseNotes, setShowReleaseNotes] = useState(false)
  const { sessionName, platformSession, headerSubtitle } = useSessionHeader(naPlataforma)

  return (
    <>
      {/* O cabeçalho diz de quem é a casa que está aberta.
          Na tela da plataforma isso é a PLATAFORMA, e o mesmo texto que o
          console usa no endereço dele (`console.header`) — dois nomes para a
          mesma coisa seriam duas coisas para quem lê. */}
      <div className={`flex h-19 items-center border-b border-white/10 ${isCollapsed ? 'justify-center px-2' : 'px-4'}`}>
        <Link
          to={naPlataforma ? '/platform' : '/dashboard'}
          onClick={closeMobile}
          className="flex min-w-0 items-center gap-3"
          title={isCollapsed ? `${naPlataforma ? t('console.header') : sessionName} — ${headerSubtitle}` : undefined}
        >
          <BrandMark className="size-10 shrink-0" />
          {!isCollapsed && (
            <div className="min-w-0">
              <div className="truncate text-[0.95rem] font-bold leading-tight text-white">
                {naPlataforma ? t('console.header') : sessionName}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[0.63rem] font-bold uppercase tracking-[0.14em] text-[#9aa9a2]">
                {platformSession && <Icon name="lock" size={11} className="shrink-0" />}
                <span className="truncate">{headerSubtitle}</span>
              </div>
            </div>
          )}
        </Link>
        {closeMobile && (
          <button
            type="button"
            onClick={closeMobile}
            className="ms-auto -me-1.5 flex size-11 shrink-0 items-center justify-center rounded-md text-[#cad3ce] transition-colors hover:bg-white/8 hover:text-white"
            aria-label={t('sidebar.closeNavigation')}
          >
            <Icon name="x" size={21} />
          </button>
        )}
      </div>

      <nav className={`min-h-0 flex-1 overflow-y-auto py-5 ${isCollapsed ? 'px-2.5' : 'px-3'}`} aria-label={t('sidebar.primaryNavigation')}>
        {/* O rótulo da seção some na plataforma: ele encabeça a lista de
            operação de UM provedor, e ali embaixo não há lista — há a saída. */}
        {!isCollapsed && !naPlataforma && (
          <div className="mb-2 px-3 text-[0.62rem] font-bold uppercase tracking-[0.16em] text-[#829188]">{t('sidebar.sectionLabel')}</div>
        )}
        <ul className="space-y-1">
          {naPlataforma ? (
            /* Os sete itens do provedor recolhem para um.
               Eles continuariam funcionando — são da mesma casca —, e é esse o
               problema: ler o nome de um ISP no alto e clicar em "Configuração"
               daqui é mexer naquele ISP achando que se mexe na plataforma. O
               nome dele vai para a linha de baixo, onde diz PARA ONDE se volta
               em vez de dizer onde se está. */
            <li>
              <Link
                to="/dashboard"
                onClick={closeMobile}
                title={isCollapsed ? `${t('sidebar.backToPanel')} — ${appName}` : undefined}
                className={`group flex min-h-12 items-center rounded-md text-[#c9d2cd] transition-colors hover:bg-white/7 hover:text-white ${
                  isCollapsed ? 'justify-center px-2' : 'gap-3 px-3'
                }`}
              >
                <Icon name="chevron-left" size={20} className="shrink-0" />
                {!isCollapsed && (
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold leading-tight">{t('sidebar.backToPanel')}</span>
                    <span className="mt-0.5 block truncate text-[0.68rem] text-[#839189]">{appName}</span>
                  </span>
                )}
              </Link>
            </li>
          ) : visibleItems.map((item) => {
            const active = isActive(item.href)
            const label = t(item.labelKey)
            // O console é o único item que pode morar noutro endereço; os
            // demais são sempre desta casca.
            const foraDaqui = item.platformOnly ? consoleForaDaqui : null
            const classe = `group flex min-h-12 items-center rounded-md transition-colors ${
              isCollapsed ? 'justify-center px-2' : 'gap-3 px-3'
            } ${
              active
                ? 'bg-[#eef0e8] text-[#173f35]'
                : 'text-[#c9d2cd] hover:bg-white/7 hover:text-white'
            }`
            const conteudo = (
              <>
                <Icon name={item.icon} size={20} className="shrink-0" />
                {!isCollapsed && (
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold leading-tight">{label}</span>
                    <span className={`mt-0.5 block truncate text-[0.68rem] ${active ? 'text-[#52665d]' : 'text-[#839189]'}`}>
                      {t(item.descriptionKey)}
                    </span>
                  </span>
                )}
              </>
            )
            return (
              <li key={item.href}>
                {foraDaqui ? (
                  <a href={foraDaqui} onClick={closeMobile} title={isCollapsed ? label : undefined} className={classe}>
                    {conteudo}
                  </a>
                ) : (
                  <Link
                    to={item.href}
                    onClick={closeMobile}
                    title={isCollapsed ? label : undefined}
                    aria-current={active ? 'page' : undefined}
                    className={classe}
                  >
                    {conteudo}
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      </nav>

      <div className={`border-t border-white/10 ${isCollapsed ? 'p-2.5' : 'p-3'}`}>
        {/* O mapa das telas mora no pé, ao lado das novidades, e não como um
            décimo item de menu: o menu é a operação de um ISP, e um índice de
            telas não é uma delas.

            Fora da plataforma, só: dali o link levaria para dentro do painel de
            um provedor, que é o que "Voltar ao painel" já faz dizendo o nome
            dele. */}
        {!naPlataforma && (
          <Link
            to="/sitemap"
            onClick={closeMobile}
            className={`mb-2 flex min-h-11 w-full items-center rounded-md text-[#aab8b0] transition-colors hover:bg-white/8 hover:text-white ${
              isCollapsed ? 'justify-center px-1' : 'gap-2 px-2.5 text-xs font-semibold'
            }`}
            aria-current={isActive('/sitemap') ? 'page' : undefined}
            title={isCollapsed ? t('sidebar.siteMap') : undefined}
          >
            <Icon name="document" size={17} />
            {!isCollapsed && <span>{t('sidebar.siteMap')}</span>}
          </Link>
        )}
        <button
          type="button"
          onClick={() => setShowReleaseNotes(true)}
          className={`mb-2 flex min-h-11 w-full items-center rounded-md text-[#aab8b0] transition-colors hover:bg-white/8 hover:text-white ${
            isCollapsed ? 'justify-center px-1' : 'justify-between gap-3 px-2.5'
          }`}
          aria-label={t('sidebar.releaseNotesAria', { version: APP_VERSION_LABEL })}
          title={isCollapsed ? t('sidebar.versionTooltip', { version: APP_VERSION_LABEL }) : undefined}
        >
          {isCollapsed ? (
            <span className="font-mono text-[0.62rem] font-bold">v{APP_RELEASE.version.split('.').slice(0, 2).join('.')}</span>
          ) : (
            <>
              <span className="flex items-center gap-2 text-xs font-semibold"><Icon name="info" size={17} />{t('sidebar.whatsNew')}</span>
              <span className="rounded bg-white/8 px-2 py-1 font-mono text-[0.65rem] font-bold text-[#d7dfda]">
                v{APP_RELEASE.version}
                {__APP_COMMIT__ && <span className="font-normal text-[#9aa9a2]"> · {__APP_COMMIT__}</span>}
              </span>
            </>
          )}
        </button>
        <div className={`mb-2 flex items-center ${isCollapsed ? 'justify-center' : 'gap-3 px-2 py-2'}`}>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#d97706] text-sm font-bold text-[#1f251f]">
            {initial}
          </div>
          {!isCollapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-white">{displayName}</div>
              <div className="text-[0.68rem] text-[#91a098]">
                {/* O papel escrito por extenso, com o mesmo vocabulário do
                    seletor de operadores: dois rótulos aqui e quatro lá diriam
                    a um `tech` que ele é "acesso somente leitura". */}
                {t(ROLE_LABEL_KEYS[normalizeRole(user?.role)])}
              </div>
            </div>
          )}
        </div>
        <LanguageSwitcher variant="dark" compact={isCollapsed} className="mb-1 w-full" />
        <div className={`grid gap-1 ${isCollapsed ? 'grid-cols-1' : 'grid-cols-2'}`}>
          <button
            type="button"
            onClick={toggleDarkMode}
            className={`flex min-h-11 items-center justify-center rounded-md text-[#bdc8c2] transition-colors hover:bg-white/8 hover:text-white ${isCollapsed ? '' : 'gap-2 px-2 text-xs font-semibold'}`}
            aria-label={isDarkMode ? t('sidebar.useLightTheme') : t('sidebar.useDarkTheme')}
            title={isCollapsed ? (isDarkMode ? t('sidebar.lightTheme') : t('sidebar.darkTheme')) : undefined}
          >
            <Icon name={isDarkMode ? 'sun' : 'moon'} size={18} />
            {!isCollapsed && <span>{isDarkMode ? t('sidebar.light') : t('sidebar.dark')}</span>}
          </button>
          <button
            type="button"
            onClick={logout}
            className={`flex min-h-11 items-center justify-center rounded-md text-[#e8afa8] transition-colors hover:bg-[#9e3930]/25 hover:text-[#ffd8d3] ${isCollapsed ? '' : 'gap-2 px-2 text-xs font-semibold'}`}
            aria-label={t('sidebar.signOut')}
            title={isCollapsed ? t('sidebar.signOut') : undefined}
          >
            <Icon name="logout" size={18} />
            {!isCollapsed && <span>{t('sidebar.signOut')}</span>}
          </button>
        </div>
      </div>
      <ReleaseNotesModal open={showReleaseNotes} onClose={() => setShowReleaseNotes(false)} />
    </>
  )
}
