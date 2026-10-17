'use client'

import { createContext, useContext, useState, useEffect, useRef } from 'react'
import type { LoginDestination, LoginDestinations } from '@/lib/api'
import { sessionKind } from '@/lib/shell'
import { apiClient, authAPI, settingsAPI, storedSession, whatsappAPI } from '@/lib/api'
import { destinosDaResposta } from '@/lib/login-destinations'
import { contaBloqueadaNaResposta, mfaStepDaResposta, type MfaStep } from '@/lib/login-mfa'
import { MFA_ENROLLMENT_EVENT } from '@/lib/mfa-enrollment'
import { useNavigate } from 'react-router'
import { roleHas, type Permission } from '@/lib/permissions'
import type { User } from '@/types'
import { clearSessionScopedStorage } from '@/lib/session-owner'
import { setActiveDateFormat } from '@/lib/date-format'

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  loading: boolean
  needsSetup: boolean
  /**
   * O que a pessoa alcança, perguntado por capacidade e não por papel.
   *
   * Existe para que nenhuma tela volte a escrever `role === 'admin'`: com
   * quatro papéis essa comparação esconde de um `owner` o que ele pode fazer e
   * oferece a um `tech` o que ele não pode. A resposta vem da matriz espelhada
   * em `@/lib/permissions`, que é a mesma do backend — e a do backend é a que
   * decide, esta só evita oferecer o que seria recusado.
   */
  can: (permission: Permission) => boolean
  /** `identifier` é o nome de usuário OU o e-mail: a rota aceita os dois. */
  /**
   * Devolve `true` quando entrou, `false` quando a credencial não serve, e os
   * DESTINOS quando o servidor pediu para escolher — o que só acontece onde o
   * endereço não nomeia provedor e a pessoa trabalha em mais de um. `'locked'`
   * é a conta bloqueada por tentativas demais.
   */
  login: (
    identifier: string, password: string, destino?: LoginDestination, totpCode?: string
  ) => Promise<boolean | LoginDestinations | MfaStep | 'locked'>
  completeSetup: (username: string, password: string, email: string) => Promise<boolean>
  /** Para quem chega com a sessão já pronta: o convite aceito e a personificação resgatada. */
  adoptSession: (
    token: string,
    refreshToken: string | undefined,
    user: User,
    options?: { tabOnly?: boolean }
  ) => void
  /**
   * Relê a própria conta do backend.
   *
   * Existe porque o estado de verificação do e-mail muda por fora desta aba —
   * a pessoa abre o link da mensagem no celular — e porque trocar o endereço o
   * desfaz. Sem isto, a tela de conta continuaria mostrando o que era verdade
   * quando a página carregou.
   */
  refreshUser: () => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [needsSetup, setNeedsSetup] = useState(false)
  const navigate = useNavigate()
  // Ver a checagem de boot: marca que outra tela já pôs uma sessão no lugar.
  const adotada = useRef(false)
  // O ouvinte do evento da ativação obrigatória é registrado uma vez; ele chama
  // a `refreshUser` da renderização mais recente por aqui.
  const refreshUserRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        const setupRes = await authAPI.getSetupStatus()
        if (setupRes.success && (setupRes.data as any)?.needsSetup) {
          setNeedsSetup(true)
          setUser(null)
          setIsAuthenticated(false)
          setLoading(false)
          return
        }
      } catch (error) {
        console.error("Setup status check failed:", error)
      }

      setNeedsSetup(false)
      // Uma tela pode ter adotado uma sessão enquanto a verificação acima
      // voltava — é o que a personificação faz, e ela chega com o bilhete já
      // na mão. Quem adotou manda: o que esta verificação leu fala de um token
      // que não é mais o desta aba.
      if (adotada.current) { setLoading(false); return }
      const { token } = storedSession()
      if (token) {
        try {
          const res = await authAPI.getCurrentUser()
          if (adotada.current) { setLoading(false); return }
          if (res.success && res.data) {
            setUser(res.data as User)
            setIsAuthenticated(true)
          } else {
            apiClient.clearTokens()
            setUser(null)
            setIsAuthenticated(false)
          }
        } catch (error) {
          console.error("Auth check failed:", error)
          apiClient.clearTokens()
          setUser(null)
          setIsAuthenticated(false)
        }
      } else {
        setUser(null)
        setIsAuthenticated(false)
      }
      setLoading(false)
    }
    checkAuthStatus()
  }, [])

  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null)
      setIsAuthenticated(false)
      navigate(needsSetup ? '/setup' : '/login', { replace: true })
    }
    window.addEventListener('auth:unauthorized', handleUnauthorized)
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized)
  }, [navigate, needsSetup])

  // O provedor passou a exigir o 2FA no meio do expediente: a próxima chamada
  // volta com a recusa, e reler a conta traz `mfaEnrollmentRequired`, que é o
  // que leva a casca à tela de ativar. Reler e não só marcar, porque quem
  // decide é o servidor — a marca sai do mesmo jeito que entrou.
  useEffect(() => {
    const handleEnrollment = () => { void refreshUserRef.current() }
    window.addEventListener(MFA_ENROLLMENT_EVENT, handleEnrollment)
    return () => window.removeEventListener(MFA_ENROLLMENT_EVENT, handleEnrollment)
  }, [])

  const login = async (
    identifier: string, password: string, destino?: LoginDestination, totpCode?: string
  ): Promise<boolean | LoginDestinations | MfaStep | 'locked'> => {
    try {
      const res = await authAPI.login(identifier, password, destino, totpCode)
      if (contaBloqueadaNaResposta(res)) return 'locked'
      // A senha está certa e falta (ou não serviu) o código do app: nem
      // credencial errada, nem sessão. A tela pede o código.
      const codigo = mfaStepDaResposta(res)
      if (codigo) return codigo
      // "Em qual deles?" não é falha de credencial: a senha está certa e falta
      // escolher. Devolver os destinos em vez de `false` é o que deixa a tela
      // perguntar em vez de dizer que a senha está errada.
      const escolher = destinosDaResposta(res)
      if (escolher) return escolher
      if (res.success && res.data) {
        const { token, refreshToken, user } = res.data as {
          token: string
          refreshToken: string
          user: User
        }
        // Entrar em outro provedor não passa por `clearTokens`.
        clearSessionScopedStorage()
        apiClient.beginSession(token, refreshToken)

        setUser(user)
        setIsAuthenticated(true)

        // A sessão de console não tem painel de provedor para onde ir.
        navigate(sessionKind(user) === 'console' ? '/platform' : '/dashboard')
        return true
      } else {
        apiClient.clearTokens()
        setIsAuthenticated(false)
        setUser(null)
        return false
      }
    } catch (error) {
      console.error("Login failed:", error)
      setIsAuthenticated(false)
      setUser(null)
      return false
    }
  }

  const completeSetup = async (username: string, password: string, email: string): Promise<boolean> => {
    try {
      const res = await authAPI.setupAdmin(username, password, email)
      if (res.success && res.data) {
        const { token, refreshToken, user } = res.data as {
          token: string
          refreshToken: string
          user: User
        }
        apiClient.beginSession(token, refreshToken)
        setUser(user)
        setIsAuthenticated(true)
        setNeedsSetup(false)
        navigate('/dashboard')
        return true
      }
      return false
    } catch (error) {
      console.error("Setup failed:", error)
      return false
    }
  }

  /**
   * Adota uma sessão que outra tela já obteve.
   *
   * Duas telas chegam com token na mão em vez de com usuário e senha: quem
   * aceita um convite e quem resgata um bilhete de personificação. As duas
   * tinham que repetir o mesmo bloco do `login` — guardar o token, encher o
   * contexto, navegar —, e repetir isso é como uma delas acaba esquecendo de
   * uma parte.
   *
   * `refreshToken` é opcional porque a personificação não tem um, e passar
   * `undefined` para `setTokens` MANTERIA o anterior. Por isso a limpeza vem
   * antes: sem ela, um refresh token de operador sobreviveria por baixo de uma
   * sessão de personificação e a renovaria como sessão comum.
   *
   * `tabOnly` é a personificação: a sessão fica só nesta aba, sem tocar no que
   * o navegador já guardava. O console abre o painel do provedor numa aba nova
   * e, numa instalação de host único, as duas dividem o mesmo `localStorage` —
   * sem isso a aba nova trocaria a sessão do console pela do provedor e
   * quebraria em silêncio a aba que se queria preservar.
   */
  const adoptSession = (
    token: string,
    refreshToken: string | undefined,
    next: User,
    options?: { tabOnly?: boolean }
  ) => {
    adotada.current = true
    if (options?.tabOnly) {
      apiClient.setTabTokens(token)
    } else {
      apiClient.clearTokens()
      apiClient.beginSession(token, refreshToken)
    }
    setUser(next)
    setIsAuthenticated(true)
    setNeedsSetup(false)
  }

  const logout = () => {
    // Quem sai deixa de estar "Disponível": senão a fila seguia mandando
    // conversas para um atendente que já foi embora. É o melhor esforço — uma
    // falha aqui não segura a saída. O aviso de saída espera por ele porque
    // revoga a sessão, e a disponibilidade enviada depois seria recusada; vai
    // com o token desta sessão na mão, já que a aba o esquece logo abaixo.
    const token = storedSession().token
    const indisponivel = roleHas(user?.role, 'whatsapp.send')
      ? whatsappAPI.setAvailability(false).catch(() => null)
      : Promise.resolve(null)
    void indisponivel
      .then(() => authAPI.logout(token ?? undefined))
      .catch(() => {})
    apiClient.clearTokens()
    setUser(null)
    setIsAuthenticated(false)
    navigate('/login')
  }

  // O formato de data do provedor desta sessão. Lido de novo a cada troca de
  // provedor (personificação, outro login); sem provedor, segue o idioma.
  const tenantId = user && !user.platform ? (user.tenantId ?? user.tenant?.slug ?? null) : null
  useEffect(() => {
    if (!isAuthenticated || tenantId === null) {
      setActiveDateFormat('auto')
      return
    }
    let cancelled = false
    void settingsAPI.display().then((res) => {
      if (!cancelled && res.success && res.data) setActiveDateFormat(res.data.dateFormat)
    })
    return () => { cancelled = true }
  }, [isAuthenticated, tenantId])

  const can = (permission: Permission) => roleHas(user?.role, permission)

  const refreshUser = async () => {
    if (!storedSession().token) return
    try {
      const res = await authAPI.getCurrentUser()
      if (res.success && res.data) setUser(res.data as User)
    } catch {
      // Uma releitura que falha deixa a tela com o que já tinha, que é o
      // comportamento certo: não é ela que decide se a sessão ainda vale.
    }
  }

  useEffect(() => {
    refreshUserRef.current = refreshUser
  })

  const value = {
    user, isAuthenticated, loading, needsSetup, can, login, completeSetup,
    adoptSession, refreshUser, logout
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
