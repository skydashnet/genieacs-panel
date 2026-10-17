/**
 * O link que a tela mostra para um token de senha ou de convite.
 *
 * O servidor devolve a URL pronta quando sabe o endereço do provedor, ou seja,
 * quando o deploy tem `TENANT_BASE_DOMAIN` ou `PUBLIC_BASE_URL`. Sem nenhum dos
 * dois ele devolve `null`, e o token puro não serve para quem vai recebê-lo.
 * Mas sem domínio-base todo provedor mora no mesmo host, e o resgate não
 * filtra por provedor onde o host não nomeia nenhum. Então o endereço desta aba
 * é exatamente onde o link vale.
 *
 * Isso não reabre o risco de `panelUrlFor` no backend: lá o perigo é o `Host`
 * de uma requisição, que qualquer um escolhe. Aqui o endereço é o da aba de
 * quem gerou o link.
 */
export function panelLink(
  url: string | null | undefined,
  token: string,
  path: '/reset-password' | '/invite',
  origin: string = window.location.origin
): string {
  if (url) return url
  return `${origin.replace(/\/+$/, '')}${path}#${token}`
}
