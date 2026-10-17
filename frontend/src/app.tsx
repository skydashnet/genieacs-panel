import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router'
import Sidebar from '@/components/sidebar'
import { ThemeProvider } from '@/contexts/theme-context'
import { AuthProvider, useAuth } from '@/contexts/auth-context'
import { ToastProvider, useToast } from '@/components/ui/toast'
import { LoadingProvider, RouteChangeLoader } from '@/components/ui/loading'
import { BrandMark } from '@/components/brand-mark'
import { LanguageProvider, useTranslation } from '@/contexts/language-context'
import { SubscriptionNotice } from '@/components/subscription-notice'
import { ImpersonationBanner } from '@/components/impersonation-banner'
import { WhatsAppDisconnectedBanner } from '@/components/whatsapp/disconnected-banner'
import { WhatsAppMessageNotifier } from '@/components/whatsapp/message-notifier'
import { ConsoleHeader } from '@/components/console-header'
import { MfaEnrollmentScreen } from '@/components/mfa-enrollment-screen'
import { mustEnroll } from '@/lib/mfa-enrollment'
import { TenantProvider, useTenant } from '@/contexts/tenant-context'
import { settingsAPI } from '@/lib/api'
import { onboardingDismissKey } from '@/lib/onboarding'
import type { Permission } from '@/lib/permissions'
import { needsGenieAcsOnboarding, sessionKind, shellFor } from '@/lib/shell'
import { sessionOwner } from '@/lib/session-owner'

const DashboardPage = lazy(() => import('@/pages/dashboard'))
const DevicesPage = lazy(() => import('@/pages/devices'))
const DeviceDetailPage = lazy(() => import('@/pages/device-detail'))
const NetworkMapPage = lazy(() => import('@/pages/network-map'))
const SettingsPage = lazy(() => import('@/pages/settings'))
const AuditPage = lazy(() => import('@/pages/audit'))
const WhatsAppPage = lazy(() => import('@/pages/whatsapp'))
const ContactsPage = lazy(() => import('@/pages/contacts'))
const SiteMapPage = lazy(() => import('@/pages/site-map'))
const ContactDetailPage = lazy(() => import('@/pages/contact-detail'))
const PlatformPage = lazy(() => import('@/pages/platform'))
const LoginPage = lazy(() => import('@/pages/login'))
const SetupPage = lazy(() => import('@/pages/setup'))
const SignupPage = lazy(() => import('@/pages/signup'))
const LandingPage = lazy(() => import('@/pages/landing'))
const PrivacyPage = lazy(() => import('@/pages/privacy'))
const PlanPage = lazy(() => import('@/pages/plan'))
const OnboardingPage = lazy(() => import('@/pages/onboarding'))
const InvitePage = lazy(() => import('@/pages/invite'))
const ImpersonatePage = lazy(() => import('@/pages/impersonate'))
const ForgotPasswordPage = lazy(() => import('@/pages/forgot-password'))
const ResetPasswordPage = lazy(() => import('@/pages/reset-password'))
const VerifyEmailPage = lazy(() => import('@/pages/verify-email'))

function PageFallback() {
  const { t } = useTranslation()
  return (
    <div className="page-shell" role="status" aria-live="polite">
      <div className="page-frame">
        <div className="mb-6 h-24 animate-pulse rounded-md bg-muted" />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="h-56 animate-pulse rounded-md bg-muted" />
          <div className="h-56 animate-pulse rounded-md bg-muted" />
        </div>
        <span className="sr-only">{t('app.loadingPage')}</span>
      </div>
    </div>
  )
}

function AuthFallback() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen items-center justify-center bg-background" role="status" aria-label={t('app.checkingAccess')}>
      <BrandMark className="size-11 animate-pulse" />
    </div>
  )
}

/**
 * Sends a freshly signed-up provider to the onboarding wizard, once.
 *
 * The test is the one fact a panel cannot work without: no GenieACS address.
 * Only on the SaaS edition (a self-hosted install has its own setup wizard),
 * only for somebody who can write settings, and never again once the wizard
 * was finished or skipped for this provider — a mark kept on the server, so
 * another admin or another browser is not sent back to it.
 */
function onboardingDismissedLocally(slug: string | null | undefined): boolean {
  if (!slug) return false
  try {
    const value = localStorage.getItem(onboardingDismissKey(slug))
    return value === '1' || value === '2'
  } catch {
    return false
  }
}

function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { can, user } = useAuth()
  const { tenant, isSaas } = useTenant()
  // O espelho do "já vi" é do provedor da SESSÃO: no host compartilhado o
  // `tenant` acima é o do primeiro provedor, e a chave dele faria o B herdar
  // o "já vi" do A (ou o A gravar no lugar do B).
  const sessionSlug = user?.tenant?.slug ?? null
  const location = useLocation()
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(isSaas ? null : false)

  useEffect(() => {
    if (!isSaas || !tenant?.slug || !can('settings.write')) { setNeedsOnboarding(false); return }
    // A caixa da plataforma sai daqui ANTES da leitura das configurações: ela
    // nunca vai ter um GenieACS, então perguntar pelo campo seria perguntar uma
    // coisa cuja resposta é "vazio" para sempre — e empurrá-la para o
    // onboarding para sempre junto.
    if (tenant.kind === 'platform') { setNeedsOnboarding(false); return }
    // O "já vi" mora no provedor (servidor); o navegador guarda só um espelho,
    // para não esperar a rede a cada página. '1' é o valor de antes, gravado
    // só aqui: sobe para o servidor uma vez e vira '2', já sincronizado.
    // Sem o slug da sessão não há espelho: a pergunta vai direto ao servidor.
    const key = sessionSlug ? onboardingDismissKey(sessionSlug) : null
    let local: string | null = null
    if (key) { try { local = localStorage.getItem(key) } catch {} }
    if (key && local === '1') {
      void settingsAPI.dismissOnboarding('wizard').then((res) => {
        if (res.success) { try { localStorage.setItem(key, '2') } catch {} }
      }).catch(() => {})
    }
    if (local === '1' || local === '2') { setNeedsOnboarding(false); return }
    let cancelled = false
    void Promise.all([
      settingsAPI.getAll(),
      settingsAPI.onboardingStatus().catch(() => null)
    ]).then(([res, onboarding]) => {
      if (cancelled) return
      const url = res.success && res.data ? String((res.data as { genieAcsUrl?: string }).genieAcsUrl ?? '') : ''
      const dismissed = Boolean(onboarding?.success && onboarding.data?.wizardDone)
      if (dismissed && key) { try { localStorage.setItem(key, '2') } catch {} }
      // A decisão mora em `needsGenieAcsOnboarding`, testada sem DOM: uma regra
      // escrita dentro de um `useEffect` é uma regra que ninguém verifica.
      setNeedsOnboarding(res.success && needsGenieAcsOnboarding({
        isSaas, kind: tenant.kind, genieAcsUrl: url, dismissed
      }))
    })
    return () => { cancelled = true }
  }, [isSaas, tenant, sessionSlug, can])

  if (needsOnboarding === null) return <PageFallback />
  // A decisão acima é tomada uma vez por sessão; concluir ou pular o assistente
  // grava a marca local e navega, sem refazê-la. Relida aqui, a marca deixa
  // quem acabou de pular chegar ao Dashboard em vez de voltar ao assistente.
  if (needsOnboarding && location.pathname !== '/onboarding' && !onboardingDismissedLocally(sessionSlug)) {
    return <Navigate to="/onboarding" replace />
  }
  return <>{children}</>
}

function ProtectedShell() {
  const { isAuthenticated, loading, needsSetup, user } = useAuth()
  if (loading) return <AuthFallback />
  if (needsSetup) return <Navigate to="/setup" replace />
  if (!isAuthenticated) return <Navigate to="/login" replace />
  // O provedor exige o 2FA e esta pessoa não ativou: nada do painel abriria —
  // o servidor recusa —, então a casca inteira dá lugar à ativação.
  if (mustEnroll(user)) return <MfaEnrollmentScreen />

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      {/* pt-16 no celular: a barra fixa do menu (sidebar.tsx) cobre o topo. */}
      <main className="min-w-0 flex-1 pt-16 lg:pt-0">
        {/* A faixa ou o muro da assinatura. Fica na casca e não numa tela
            porque a primeira requisição recusada pode vir de qualquer uma. */}
        {/* Antes de tudo: quem está personificando tem que saber disso em toda
            tela, e a faixa da assinatura fala do provedor, não da sessão. */}
        {/* As duas faixas grudam juntas, logo abaixo da barra do celular. */}
        <div className="sticky top-16 z-1100 lg:top-0">
          <ImpersonationBanner />
          <SubscriptionNotice />
          {/* Número de WhatsApp caído: em toda tela, porque o atendente só
              descobriria quando tentasse responder. */}
          <WhatsAppDisconnectedBanner />
          {/* Mensagem nova de cliente: som e notificação do sistema, mesmo
              com o painel em outra aba. Não desenha nada. */}
          <WhatsAppMessageNotifier />
        </div>
        <Suspense fallback={<PageFallback />}>
          <OnboardingGate>
            <Outlet />
          </OnboardingGate>
        </Suspense>
      </main>
    </div>
  )
}

/** Signup only exists where a provider can be given an address. */
function SignupRoute() {
  const { isAuthenticated, loading } = useAuth()
  const { tenant, isPlatformHost, loading: tenantLoading } = useTenant()
  if (loading || tenantLoading) return <AuthFallback />
  if (isAuthenticated) return <Navigate to="/dashboard" replace />
  // Com subdomínio por provedor, ou no endereço da plataforma de um deploy de
  // endereço único (`PLATFORM_EXTRA_HOSTS`), onde o backend também aceita.
  if (tenant?.edition !== 'saas' || (!tenant.panelBaseDomain && !isPlatformHost)) return <Navigate to="/login" replace />
  return <SignupPage />
}

/**
 * Uma rota guardada pela capacidade que a tela precisa para carregar.
 *
 * Guardava por `role === 'admin'`, o que com quatro papéis fecharia o mapa e a
 * caixa do WhatsApp para o plantão, que é justamente quem trabalha ali. Quem
 * não tem a capacidade é mandado ao painel em vez de a uma tela onde cada
 * requisição responde 403 — e a capacidade escolhida é a da LEITURA que a tela
 * faz ao abrir, não a da ação mais poderosa que ela oferece: quem só lê entra e
 * vê; os botões de escrita se escondem sozinhos lá dentro.
 */
function PermissionRoute({ permission }: { permission: Permission }) {
  const { can, loading } = useAuth()
  if (loading) return <AuthFallback />
  if (!can(permission)) return <Navigate to="/dashboard" replace />
  return <Outlet />
}

/**
 * The control plane, which is a level above a provider's own administrator.
 *
 * Tem a forma de `PermissionRoute` e guarda outro fato, de propósito: estas
 * rotas existem só onde a instalação roda como SaaS, e só para quem está na
 * lista da plataforma. Nenhuma capacidade da matriz responde por isso — nem a
 * de um `owner`, que administra o provedor dele e nada acima —, e guardada por
 * uma delas a tela apareceria para quase todo administrador do painel,
 * apontando para rotas que respondem 404 a ele.
 */
function PlatformRoute() {
  const { user, loading } = useAuth()
  const { tenant, loading: tenantLoading } = useTenant()
  if (loading || tenantLoading) return <AuthFallback />
  // Onde há domínio-base o console mudou de endereço, e as rotas dele não são
  // servidas neste host: a tela abriria e cada requisição dela responderia 404.
  // O caminho para lá é o link da barra lateral, que aponta para fora.
  if (tenant?.panelBaseDomain) return <Navigate to="/dashboard" replace />
  if (!user?.isPlatformAdmin) return <Navigate to="/dashboard" replace />
  return <Outlet />
}

function LoginRoute() {
  const { isAuthenticated, loading, needsSetup } = useAuth()
  const { isPlatformHost, loading: tenantLoading } = useTenant()
  if (loading || tenantLoading) return <AuthFallback />
  if (needsSetup) return <Navigate to="/setup" replace />
  if (isAuthenticated) return <Navigate to="/dashboard" replace />
  return <LoginPage />
}

/**
 * A porta do console, no endereço da plataforma.
 *
 * Era um desvio para `/signup`, na época em que o ápice só servia o cadastro e
 * não havia ninguém para entrar ali. Agora há: a sessão do console, que não
 * nomeia provedor nenhum.
 *
 * `needsSetup` NÃO desvia aqui, ao contrário da porta do painel. A rota de
 * setup não é servida neste endereço — ela cria o primeiro operador de um
 * provedor —, então o desvio seria um laço. O primeiro administrador da
 * plataforma nasce pelo script, e é isso que a tela diz.
 */
function ConsoleLoginRoute() {
  const { isAuthenticated, loading, user } = useAuth()
  if (loading) return <AuthFallback />
  if (isAuthenticated && user?.platform) return <Navigate to="/platform" replace />
  return <LoginPage variant="platform" />
}

/**
 * A casca do console: sem barra lateral, sem aviso de assinatura, sem portão de
 * onboarding.
 *
 * Os três falam de UM provedor — a operação dele, a fatura dele, a configuração
 * inicial dele — e aqui não há um. `OnboardingGate`, em particular, chama
 * `settingsAPI.getAll()`, que neste endereço responde 404.
 */
function ConsoleShell() {
  const { isAuthenticated, loading, user } = useAuth()
  if (loading) return <AuthFallback />
  if (!isAuthenticated || !user?.platform) return <Navigate to="/login" replace />

  return (
    <div className="min-h-screen">
      <ConsoleHeader />
      <main>
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  )
}

function SetupRoute() {
  const { isAuthenticated, loading, needsSetup } = useAuth()
  if (loading) return <AuthFallback />
  if (!needsSetup) return <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />
  return <SetupPage />
}

/**
 * As rotas do console: a árvore inteira do endereço da plataforma.
 *
 * Curta de propósito. Fora dela ficam o setup (cria operador de provedor), o
 * convite, a redefinição de senha e a confirmação de e-mail — todas são de um
 * provedor e nenhuma é servida neste endereço. O resgate de personificação é
 * a exceção, e o comentário na rota diz por quê.
 * `/signup` fica porque o ápice é a porta de entrada das duas pessoas que
 * chegam sem conta: o ISP que ainda não existe e quem opera a plataforma.
 */
/**
 * A vitrine do ápice. Só onde o ápice É a plataforma: numa instalação de host
 * único a árvore do console também monta (por sessão), e ali não há o que
 * vender — a raiz continua levando ao console.
 */
function LandingRoute() {
  const { isPlatformHost } = useTenant()
  if (!isPlatformHost) return <Navigate to="/platform" replace />
  return <LandingPage />
}

function ConsoleRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Suspense fallback={<AuthFallback />}><LandingRoute /></Suspense>} />
      <Route path="/login" element={<Suspense fallback={<AuthFallback />}><ConsoleLoginRoute /></Suspense>} />
      <Route path="/signup" element={<Suspense fallback={<AuthFallback />}><SignupRoute /></Suspense>} />
      {/* A política de privacidade é pública e tem que estar onde está o
          formulário que coleta o dado: a vitrine mora aqui, e o aviso da LGPD
          (art. 9º) é na coleta. Antes do `*` abaixo, que a mandaria ao console. */}
      <Route path="/privacidade" element={<Suspense fallback={<AuthFallback />}><PrivacyPage /></Suspense>} />
      {/* O resgate da personificação também mora aqui. Num deploy de host
          único o "Abrir o painel" abre `/impersonate` no MESMO endereço, e a
          aba nova herda do `localStorage` a sessão do console — então é esta
          árvore que monta. Sem a rota, o `*` abaixo mandava para `/platform`
          e o bilhete nunca virava a sessão do provedor: o botão "abria" o
          próprio console. Resgatado, a sessão da aba passa a ser de provedor
          e a casca troca sozinha. */}
      <Route path="/impersonate" element={<Suspense fallback={<AuthFallback />}><ImpersonatePage /></Suspense>} />
      <Route element={<ConsoleShell />}>
        <Route path="/platform" element={<PlatformPage />} />
        <Route path="*" element={<Navigate to="/platform" replace />} />
      </Route>
    </Routes>
  )
}

/**
 * Qual das duas árvores montar. A regra mora em `@/lib/shell`, testada lá.
 *
 * Um componente e não um `if` dentro da casca: cada condicional em volta de um
 * pedaço de painel seria uma chance de ele renderizar onde não há painel, e a
 * lista dessas peças cresce sozinha conforme alguém acrescenta um aviso à
 * casca comum.
 */
function AppRoutes() {
  const { isPlatformHost, loading: tenantLoading } = useTenant()
  const { user, loading } = useAuth()
  if (loading || tenantLoading) return <AuthFallback />
  const casca = shellFor({ platformHost: isPlatformHost, session: sessionKind(user) })
  return casca === 'console' ? <ConsoleRoutes /> : <ProviderRoutes />
}

function ProviderRoutes() {
  return (
              <Routes>
                <Route path="/login" element={<Suspense fallback={<AuthFallback />}><LoginRoute /></Suspense>} />
                <Route path="/setup" element={<Suspense fallback={<AuthFallback />}><SetupRoute /></Suspense>} />
                <Route path="/signup" element={<Suspense fallback={<AuthFallback />}><SignupRoute /></Suspense>} />
                {/* As duas portas que se abrem com uma credencial no fragmento
                    da URL, e não com usuário e senha: o convite e o bilhete de
                    personificação. Fora da casca protegida de propósito — quem
                    chega nelas ainda não tem sessão neste provedor. */}
                {/* Pública, como as outras deste bloco: o operador lê o que
                    guardamos dele antes de entrar, e um deploy de endereço único
                    — sem vitrine — não tem outro lugar para a política morar. */}
                <Route path="/privacidade" element={<Suspense fallback={<AuthFallback />}><PrivacyPage /></Suspense>} />
                <Route path="/invite" element={<Suspense fallback={<AuthFallback />}><InvitePage /></Suspense>} />
                <Route path="/impersonate" element={<Suspense fallback={<AuthFallback />}><ImpersonatePage /></Suspense>} />
                {/* As três que chegam de fora com um token no fragmento. Sem
                    guarda de sessão, como o convite: quem perdeu a senha não
                    tem uma, e quem confirma um endereço costuma estar no
                    celular. */}
                <Route path="/forgot-password" element={<Suspense fallback={<AuthFallback />}><ForgotPasswordPage /></Suspense>} />
                <Route path="/reset-password" element={<Suspense fallback={<AuthFallback />}><ResetPasswordPage /></Suspense>} />
                <Route path="/verify-email" element={<Suspense fallback={<AuthFallback />}><VerifyEmailPage /></Suspense>} />
                <Route element={<ProtectedShell />}>
                  <Route index element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/devices" element={<DevicesPage />} />
                  <Route path="/devices/detail" element={<DeviceDetailPage />} />
                  {/* Sem `PermissionRoute`: o mapa é a resposta a "onde fica
                      X", e um `viewer` precisa dela tanto quanto um `owner`. A
                      tela lista só o que a sessão abre. */}
                  <Route path="/sitemap" element={<SiteMapPage />} />
                  <Route element={<PlatformRoute />}>
                    <Route path="/platform" element={<PlatformPage />} />
                  </Route>
                  <Route element={<PermissionRoute permission="map.read" />}>
                    <Route path="/network-map" element={<NetworkMapPage />} />
                  </Route>
                  {/* A trilha do provedor. A capacidade é a da leitura que a
                      tela faz ao abrir, e é a mesma do item no menu — item que
                      aparece e leva a um redirecionamento é pior que item
                      nenhum. */}
                  <Route element={<PermissionRoute permission="audit.read" />}>
                    <Route path="/audit" element={<AuditPage />} />
                  </Route>
                  <Route element={<PermissionRoute permission="settings.read" />}>
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/plan" element={<PlanPage />} />
                  </Route>
                  <Route element={<PermissionRoute permission="settings.write" />}>
                    <Route path="/onboarding" element={<OnboardingPage />} />
                  </Route>
                  <Route element={<PermissionRoute permission="whatsapp.read" />}>
                    <Route path="/whatsapp" element={<WhatsAppPage />} />
                    <Route path="/contacts" element={<ContactsPage />} />
                    <Route path="/contacts/:key" element={<ContactDetailPage />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Route>
              </Routes>
  )
}

/**
 * Apaga os toasts quando a sessão muda de dono.
 *
 * O `ToastProvider` fica acima das rotas e sobrevive a sair, entrar em outro
 * provedor e à personificação. Sem isto, um "Dispositivo X reiniciado" ou um
 * erro com o nome de um cliente do provedor A continuava na tela de quem entrou
 * em seguida — o provedor B lendo um aviso que não é dele.
 *
 * Compara com o dono ANTERIOR, guardado num ref, e não dispara na montagem: o
 * primeiro valor é só o ponto de partida. E também no `auth:unauthorized`, que
 * é a sessão caindo por 401 — ali o aviso de quem saiu já não tem a quem servir.
 */
function ToastSessionReset() {
  const { user } = useAuth()
  const { clearAll } = useToast()
  const owner = sessionOwner(user)
  const previous = useRef(owner)

  useEffect(() => {
    if (previous.current === owner) return
    previous.current = owner
    clearAll()
  }, [owner, clearAll])

  useEffect(() => {
    window.addEventListener('auth:unauthorized', clearAll)
    return () => window.removeEventListener('auth:unauthorized', clearAll)
  }, [clearAll])

  return null
}

export default function App() {
  return (
    <AuthProvider>
      <TenantProvider>
      <LanguageProvider>
        <ThemeProvider>
          <LoadingProvider>
            <ToastProvider>
              <RouteChangeLoader />
              <ToastSessionReset />
              <AppRoutes />
            </ToastProvider>
          </LoadingProvider>
        </ThemeProvider>
      </LanguageProvider>
      </TenantProvider>
    </AuthProvider>
  )
}
