import crypto from 'node:crypto';

/**
 * A volta completa: o painel se chama pela porta da frente.
 *
 * POR QUE ISTO EXISTE, e o que a conferência anterior não resolvia
 * ----------------------------------------------------------------
 * `webhookVerdict` compara o que o servidor Evolution guarda com o que o painel
 * ESPERA — e as duas pontas dessa comparação saem do mesmo `webhookBaseUrl`.
 * Quando esse endereço está errado, os dois lados concordam, o veredito
 * responde `ok`, e nada chega mesmo assim. Um diagnóstico que confirma como são
 * uma instalação quebrada é pior que nenhum: ele encerra a conversa.
 *
 * O `webhookBaseUrl` é digitado à mão e só é conferido na FORMA — absoluto,
 * http(s), sem credencial. Ninguém confere que o caminho é o que o painel
 * atende (`/api/whatsapp-webhook`) nem que o endereço chega aqui. Três jeitos
 * de errar, todos silenciosos e todos aprovados pela conferência estática:
 *
 *   - `https://painel.exemplo.com` sem caminho nenhum. O Evolution faz POST na
 *     raiz, o painel devolve o HTML do frontend com 200, e o servidor registra
 *     entrega bem-sucedida. Este é o pior dos três, porque tudo parece certo
 *     dos dois lados.
 *   - `https://painel.exemplo.com/api/whatsapp/webhook` — caminho parecido e
 *     errado. 404 em toda entrega.
 *   - o endereço certo atrás de um proxy que recusa POST de fora.
 *
 * A volta responde os três de uma vez, e responde a única pergunta que importa:
 * **uma entrada por este endereço chega até aqui?**
 *
 * O NONCE é o que faz isso ser prova
 * ----------------------------------
 * Sem ele, "200" seria a resposta tanto do webhook quanto da página de login do
 * frontend — que é exatamente o primeiro caso acima. O painel sorteia um valor,
 * manda, e só aceita a volta se o MESMO valor voltar. Uma página HTML não
 * contém o nonce; o webhook autenticado devolve-o.
 *
 * E ele volta só DEPOIS da autenticação, o que faz a volta provar duas coisas
 * de uma vez: que o endereço chega aqui e que o token guardado é o que esta
 * rota aceita.
 */

/** O evento que só o próprio painel emite. Não é de nenhum dos dois servidores. */
export const PROBE_EVENT = 'panel.probe';

/**
 * O mesmo nome depois de `canonicalizarEvento`, que troca ponto por sublinhado.
 *
 * As duas formas existem porque a rota compara o nome JÁ canonicalizado: quem
 * comparar com `PROBE_EVENT` cru nunca casa, a sonda cai no caminho dos eventos
 * de verdade e a volta responde `wrong_target` contra o próprio webhook são —
 * um diagnóstico mentindo sobre si mesmo. Foi escrito errado na primeira vez.
 */
export const PROBE_EVENT_CANONICAL = 'panel_probe';

/**
 * Sorteia o valor que a volta tem que trazer de novo.
 *
 * 16 bytes, e não menos: ele é a diferença entre "alguma coisa respondeu 200" e
 * "o meu webhook respondeu". Um valor curto o bastante para aparecer por acaso
 * numa página de erro transformaria a prova em ruído.
 */
export function mintNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * O corpo da sonda, no mesmo formato que um evento de verdade.
 *
 * O `ticket` é opcional e existe só para a sonda de CONFIGURAÇÃO, que roda sem
 * conta nenhuma: sem ele a rota procuraria a instância pelo nome, não acharia,
 * e responderia 401 — que `probeVerdict` traduz como "o endereço leva a outro
 * painel". Ver `waProbeTicket.js` para o que esse bilhete autoriza, que é
 * exatamente uma coisa.
 *
 * A sonda POR CONTA continua sem bilhete, de propósito: ela é autenticada pelo
 * token da própria conta, e é isso que a faz provar as duas coisas de uma vez.
 */
export function probeBody(instance, nonce, ticket = null) {
  const probe = ticket ? { nonce, ticket } : { nonce };
  return { event: PROBE_EVENT, instance, probe };
}

/** O nonce que veio no corpo de uma requisição, se houver. */
export function nonceOfRequest(body) {
  const probe = body?.probe;
  const nonce = probe && typeof probe === 'object' ? probe.nonce : null;
  const texto = String(nonce ?? '');
  // Limitado no tamanho porque ele volta na resposta: sem teto, o corpo da
  // sonda escolheria o tamanho do que esta rota pública devolve.
  return /^[a-f0-9]{8,64}$/i.test(texto) ? texto : '';
}

/**
 * O bilhete que veio no corpo, se houver.
 *
 * Mesmo teto de tamanho do nonce e pelo mesmo motivo — este valor é comparado
 * contra uma assinatura, e `verify` já recusa acima de 256, mas cortar aqui
 * também mantém a leitura do corpo barata. O alfabeto é o que `sign` produz:
 * dígitos, um ponto e hexadecimal.
 */
export function ticketOfRequest(body) {
  const probe = body?.probe;
  const ticket = probe && typeof probe === 'object' ? probe.ticket : null;
  const texto = String(ticket ?? '');
  return /^[0-9]{1,15}\.[a-f0-9]{64}$/i.test(texto) ? texto : '';
}

/**
 * Os vereditos da volta. Distintos dos de configuração de propósito: aqueles
 * dizem o que está gravado, estes dizem o que acontece.
 */
export const PROBE_VERDICTS = Object.freeze({
  /** O nonce voltou. O endereço chega aqui e o token é aceito. */
  REACHED: 'reached',
  /** Chegou ao painel e foi recusado — o endereço leva a OUTRO painel. */
  UNAUTHORIZED: 'unauthorized',
  /** Respondeu 200 e não é o webhook: a raiz do painel, um proxy, outro serviço. */
  WRONG_TARGET: 'wrong_target',
  /** O host está certo e o caminho não. */
  NOT_FOUND: 'not_found',
  /** Alguém no meio recusou: WAF, proxy, regra de firewall. */
  BLOCKED: 'blocked',
  /** Chegou e o painel quebrou ao responder. */
  SERVER_ERROR: 'server_error',
  /** Não deu para chegar: DNS, prazo, conexão recusada. */
  UNREACHABLE: 'unreachable'
});

/**
 * Lê a volta.
 *
 * A ordem NÃO é a do status HTTP, é a da certeza. O nonce vem primeiro porque
 * é o único sinal positivo: um 200 sem ele é um destino errado, e trocar essas
 * duas leituras faria a página de login do próprio painel passar por webhook
 * saudável — o caso que esta função existe para pegar.
 *
 * @param {{ status: number|null, corpo: string, falhou: boolean }} resposta
 * @param {string} nonce o que foi enviado
 */
export function probeVerdict(resposta, nonce) {
  if (resposta?.falhou || !Number.isFinite(resposta?.status)) return PROBE_VERDICTS.UNREACHABLE;
  const { status } = resposta;
  const corpo = String(resposta.corpo ?? '');

  if (status === 200 && nonce && corpo.includes(nonce)) return PROBE_VERDICTS.REACHED;
  if (status === 401) return PROBE_VERDICTS.UNAUTHORIZED;
  if (status === 403) return PROBE_VERDICTS.BLOCKED;
  if (status === 404 || status === 405) return PROBE_VERDICTS.NOT_FOUND;
  if (status >= 500) return PROBE_VERDICTS.SERVER_ERROR;
  // Tudo o mais que respondeu alguma coisa sem trazer o nonce de volta. Inclui
  // o 200 da raiz do painel, que é o caso mais comum e o mais enganoso.
  return PROBE_VERDICTS.WRONG_TARGET;
}
