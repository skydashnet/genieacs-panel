import crypto from 'node:crypto';

/**
 * Autenticação do webhook de entrada.
 *
 * NENHUM dos dois servidores Evolution assina o webhook por conta própria. O GO
 * manda apenas `Content-Type: application/json`; o v2 põe a chave da instância
 * no CORPO do evento (`apikey`) e só manda header se a instância foi criada com
 * `webhook.headers`. Por isso o segredo vai na URL (`?t=`) nos dois sabores.
 *
 * O QUE ISTO CORRIGE, e por que a forma importa
 * ---------------------------------------------
 * A versão anterior no sistema de origem era, em essência:
 *
 *     if (conta.chave && chaveEnviada && !igual(conta.chave, chaveEnviada)) → 401
 *
 * Isso é fail-OPEN: quando o servidor não manda credencial nenhuma —
 * exatamente o caso do GO — a condição é falsa e a requisição passa. Qualquer
 * pessoa que soubesse o nome de uma instância podia injetar mensagem de entrada
 * num processo rodando com privilégio total.
 *
 * Aqui a ausência de credencial é recusa, nos dois ramos.
 */

/**
 * Compara dois segredos em tempo constante, sem vazar o comprimento.
 *
 * `crypto.timingSafeEqual` exige buffers do mesmo tamanho e lança quando não
 * são — comparar os digests SHA-256 resolve os dois problemas de uma vez: o
 * tamanho é sempre 32 bytes e a comparação continua constante.
 */
export function segredosIguais(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (!x || !y) return false;
  const da = crypto.createHash('sha256').update(x).digest();
  const db = crypto.createHash('sha256').update(y).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * O token que veio na query. O `?t=` é o caminho principal.
 *
 * A barra final é retirada porque proxies e o próprio Evolution já reescreveram
 * a URL acrescentando uma — e um token com `/` no fim não bate com o guardado.
 */
export function tokenDaQuery(query) {
  return String(query?.t ?? '').replace(/\/+$/, '');
}

/**
 * A credencial que o v2 manda quando não há `?t=`: header `apikey`, ou o campo
 * `apikey` do corpo do evento.
 */
export function credencialDoPedido(headers, body) {
  return String(headers?.apikey || headers?.['x-api-key'] || body?.apikey || '');
}

/**
 * Decide se o evento pode ser processado.
 *
 * @param {{ webhookToken: string, instanceToken: string }} segredos os da conta
 * @param {{ urlToken: string, credencial: string }} enviado o que chegou
 * @returns {boolean}
 */
export function pedidoAutorizado(segredos, enviado) {
  // Caminho principal: token dedicado na URL. Vazar este permite forjar evento
  // de entrada; vazar o da instância permitiria mandar mensagem em nome do
  // provedor e ler os contatos dele — por isso são segredos diferentes.
  if (enviado.urlToken) {
    return segredosIguais(segredos.webhookToken, enviado.urlToken);
  }
  // Compatibilidade: instância criada antes de o `?t=` existir, ou servidor que
  // reescreveu a URL. Ainda assim exige credencial — ausência é recusa.
  return segredosIguais(segredos.instanceToken, enviado.credencial);
}
