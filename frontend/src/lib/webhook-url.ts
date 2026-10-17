/**
 * O endereço do webhook como se cola num sistema de fora: sempre absoluto.
 *
 * O backend só sabe montar a URL inteira quando o deploy declara o próprio
 * domínio (`PANEL_BASE_DOMAIN` ou `PUBLIC_BASE_URL`); sem isso ele devolve só o
 * caminho. Um caminho solto colado no Asaas não entrega nada — e o console é
 * servido pela mesma origem da API, com a rota do webhook montada acima do
 * resolvedor de provedor, então a origem da própria página atende a entrega.
 */
export function absoluteWebhookUrl(url: string, origin: string): string {
  if (!url.startsWith('/')) return url
  return `${origin.replace(/\/+$/, '')}${url}`
}
