/**
 * O que uma aba faz quando OUTRA aba do mesmo navegador mexe no token.
 *
 * O `localStorage` é do navegador inteiro, mas cada aba guarda o token também
 * em memória (`ApiClient`). Sem ouvir o evento `storage`, uma aba seguia
 * falando com o servidor como o provedor A depois de outra aba sair, ou entrar
 * como o provedor B — e mostrava os dados de um com o nome do outro.
 *
 * - `ignore`: não é o token, não mudou, ou a sessão desta aba é só dela (a
 *   personificação mora no `sessionStorage` e não segue o navegador).
 * - `logout`: a outra aba saiu; esta sai junto.
 * - `adopt`: a mesma sessão (mesmo usuário, mesmo provedor) renovada na outra
 *   aba; esta pega o token novo em silêncio, sem recarregar a cada refresh.
 * - `reload`: outra sessão — ou um token que não dá para ler. Recarregar é o
 *   jeito limpo de a aba largar tudo o que montou para a sessão anterior.
 */
export type CrossTabTokenAction = 'ignore' | 'adopt' | 'logout' | 'reload'

/**
 * Quem o token diz que é: o usuário e o provedor (ou o console). Lido do
 * payload sem verificar a assinatura — não é para confiar no token, quem
 * confia é o servidor; é só para saber se a sessão continua a mesma.
 */
export function tokenIdentity(token: string | null | undefined): string | null {
  if (!token) return null
  const partes = token.split('.')
  if (partes.length !== 3 || !partes[1]) return null
  try {
    const b64 = partes[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const payload: unknown = JSON.parse(json)
    if (!payload || typeof payload !== 'object') return null
    const { userId, tenantId, platform } = payload as { userId?: unknown; tenantId?: unknown; platform?: unknown }
    if (typeof userId !== 'number' && typeof userId !== 'string') return null
    const escopo = typeof tenantId === 'number' || typeof tenantId === 'string'
      ? `t${tenantId}`
      : platform === true ? 'platform' : '-'
    return `${escopo}:${userId}`
  } catch {
    return null
  }
}

export function crossTabTokenAction(ctx: {
  key: string | null
  newValue: string | null
  current: string | null
  tabScoped: boolean
}): CrossTabTokenAction {
  // `key` nulo é um `localStorage.clear()` na outra aba: o token foi junto.
  if (ctx.key !== 'token' && ctx.key !== null) return 'ignore'
  if (ctx.tabScoped) return 'ignore'
  if (ctx.newValue === ctx.current) return 'ignore'
  if (ctx.newValue === null) return 'logout'
  const antes = tokenIdentity(ctx.current)
  const depois = tokenIdentity(ctx.newValue)
  if (antes !== null && antes === depois) return 'adopt'
  return 'reload'
}
