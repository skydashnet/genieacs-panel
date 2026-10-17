/**
 * Qual das duas cascas o navegador está usando: a do console ou a de um painel.
 *
 * O console da plataforma não pertence a provedor nenhum, e a casca dele é
 * outra coisa: sem barra lateral de operação, sem aviso de assinatura, sem o
 * portão de onboarding — todos falam de UM provedor, e ali não há um. Cada uma
 * dessas peças lida dentro de um `if` na casca comum seria uma chance de um
 * pedaço de painel renderizar onde não há painel; `OnboardingGate`, por
 * exemplo, chama `settingsAPI.getAll()`, que no endereço da plataforma é 404.
 *
 * A decisão sai daqui, e não de dentro do JSX, para poder ser testada: o
 * `frontend/test/` roda em `node` puro, sem DOM, então uma regra escrita dentro
 * de um componente é uma regra que ninguém verifica.
 *
 * A regra tem duas metades, e a ordem entre elas é o conteúdo:
 *
 * 1. **Onde há subdomínio por provedor**, o ENDEREÇO decide. O ápice é a
 *    plataforma e nada mais: mesmo um token de provedor que chegue ali é
 *    recusado pelo backend, então mostrar tela de painel seria desenhar em
 *    volta de requisições que já falharam.
 * 2. **Numa instalação de host único**, o endereço não decide nada — console e
 *    painéis dividem o mesmo — então quem decide é a SESSÃO. Uma sessão de
 *    console não tem provedor nem papel; qualquer tela de painel que ela
 *    abrisse pediria dado escopado com uma credencial que não nomeia escopo.
 */
export type Shell = 'console' | 'provider'

export interface ShellInput {
  /** Se este endereço é o da própria plataforma (o ápice do domínio-base). */
  platformHost: boolean
  /** A sessão em mãos, ou `null` enquanto não há nenhuma. */
  session: 'console' | 'provider' | null
}

export function shellFor({ platformHost, session }: ShellInput): Shell {
  if (platformHost) return 'console'
  return session === 'console' ? 'console' : 'provider'
}

/** A forma de sessão que um usuário logado representa, ou `null` sem sessão. */
export function sessionKind(user: { platform?: boolean } | null | undefined): 'console' | 'provider' | null {
  if (!user) return null
  return user.platform ? 'console' : 'provider'
}

/**
 * A casca de um provedor está, NESTE INSTANTE, mostrando a tela da plataforma?
 *
 * É a terceira situação que o arquivo acima não cobria. `shellFor` decide qual
 * ÁRVORE montar, e num deploy de host único a resposta para um administrador de
 * plataforma que também opera um ISP é "a do provedor" — a sessão dele é de
 * provedor. Só que dentro dessa árvore existe uma rota, `/platform`, que não
 * fala de provedor nenhum: fala do deploy inteiro.
 *
 * Enquanto ela está aberta, a barra lateral escreve o nome de um ISP ao lado de
 * uma tela que lista todos. Não é cosmético: é dali que se clica em
 * "Configuração" achando que se mexe na plataforma e se mexe na ISP.
 *
 * Três entradas, e as duas últimas são as MESMAS que `PlatformRoute` usa para
 * decidir se serve esta tela. Repetidas aqui de propósito: cada uma das duas
 * termina num redirecionamento, e redirecionamento leva um render — sem elas a
 * barra piscaria "Plataforma" antes de voltar ao nome do provedor.
 *
 * 1. **O caminho.** `/platform` e o que estiver abaixo dele, nada mais. O
 *    prefixo é comparado com a barra junto (`/platform/`) de propósito: sem
 *    isso, uma rota futura chamada `/platformas` vestiria o chapéu errado.
 * 2. **Não haver domínio-base.** Onde ele existe, o console mudou de endereço e
 *    ESTA casca não serve `/platform`.
 * 3. **Ser administrador de plataforma.** Quem não é nunca chega à tela.
 */
export interface PlatformHatInput {
  /** O caminho aberto agora. */
  pathname: string
  /** O domínio-base do painel, ou nulo num deploy de host único. */
  panelBaseDomain: string | null | undefined
  /** Se quem está olhando tem a chave do plano de controle. */
  isPlatformAdmin: boolean
}

export function wearingPlatformHat(
  { pathname, panelBaseDomain, isPlatformAdmin }: PlatformHatInput
): boolean {
  if (panelBaseDomain || !isPlatformAdmin) return false
  return pathname === '/platform' || pathname.startsWith('/platform/')
}

/**
 * Este provedor ainda precisa passar pelo onboarding de GenieACS?
 *
 * O portão existe porque um painel sem o endereço da NBI não mostra
 * equipamento nenhum, e a tela vazia não diz o que falta. Mas ele perguntava
 * uma coisa só — o campo está vazio? — e isso deixou de bastar quando a
 * plataforma ganhou o próprio provedor: a caixa com que ela atende os ISPs não
 * gerencia ONT alguma, e mesmo assim era mandada configurar um ACS.
 *
 * As quatro entradas, e o que cada uma responde:
 *
 * 1. **`isSaas`** — na edição self-hosted não há onboarding; quem instalou já
 *    sabe o endereço do próprio ACS.
 * 2. **`kind`** — `platform` NUNCA passa por aqui. Não é "já configurou", é
 *    "não há o que configurar", e a diferença importa: com `genieAcsUrl` vazio
 *    para sempre, qualquer regra baseada só no campo a empurraria para sempre.
 * 3. **`genieAcsUrl`** — a pergunta original, e continua sendo a que decide
 *    para um provedor de verdade.
 * 4. **`dismissed`** — o assistente já foi concluído ou pulado neste provedor.
 *    A marca fica no servidor (`/api/settings/onboarding`), com um espelho no
 *    navegador para não esperar a rede a cada página.
 */
export interface OnboardingInput {
  /** Edição hospedada? Só nela existe onboarding. */
  isSaas: boolean
  /** `provider` ou `platform` — de `/api/tenant/public`. */
  kind: string | null | undefined
  /** O endereço da NBI já gravado, se houver. */
  genieAcsUrl: string | null | undefined
  /** Se o assistente já foi concluído ou pulado neste provedor. */
  dismissed: boolean
}

export function needsGenieAcsOnboarding(
  { isSaas, kind, genieAcsUrl, dismissed }: OnboardingInput
): boolean {
  if (!isSaas || dismissed) return false
  if (kind === 'platform') return false
  return String(genieAcsUrl ?? '').trim() === ''
}

/**
 * O endereço de uma tela DENTRO do painel da caixa da plataforma, ou `null`.
 *
 * `null` não é falha: num deploy de host único não há subdomínio por provedor,
 * e ali se chega à caixa pelo seletor de destino do login — o mesmo caminho de
 * qualquer provedor. As telas que chamam isto mostram a instrução em vez de um
 * link, e é por isso que a ausência precisa ser um valor e não uma exceção.
 *
 * Existe como função porque duas telas do console precisam do mesmo endereço
 * com caminhos diferentes — a caixa de WhatsApp e o catálogo padrão. Montar a
 * string na mão nas duas é como a segunda fica sem a barra, ou com duas.
 */
export function platformBoxUrl(
  { slug, panelBaseDomain, path }: {
    slug: string | null | undefined
    panelBaseDomain: string | null | undefined
    path: string
  }
): string | null {
  const nome = String(slug ?? '').trim()
  const base = String(panelBaseDomain ?? '').trim()
  if (!nome || !base) return null
  const caminho = path.startsWith('/') ? path : `/${path}`
  return `https://${nome}.${base}${caminho}`
}
