import 'dotenv/config';
import crypto from 'node:crypto';
import { DEVELOPMENT_FALLBACK, isProduction } from '../../config/runtimeEnv.js';

/**
 * A credencial da sonda de CONFIGURAÇÃO, e por que ela precisou existir.
 *
 * A sonda por conta já prova o que interessa: o painel chama a própria URL
 * pública do webhook e exige o nonce de volta. Só que a rota do webhook procura
 * a instância pelo NOME antes de qualquer outra coisa, e nome desconhecido
 * responde 401 igual a token errado — de propósito, porque a diferença diria a
 * um sondador quais instâncias existem.
 *
 * Com zero números conectados não há nome nenhum a mandar. A volta levaria 401
 * sempre, e `probeVerdict` traduz 401 como `unauthorized`, cujo significado
 * escrito é "o endereço leva a OUTRO painel". Seria um diagnóstico afirmando,
 * com confiança, exatamente a coisa errada — no único caso em que o operador
 * não tem outro jeito de descobrir se acertou a configuração.
 *
 * Então a sonda de configuração carrega credencial própria, e a rota responde a
 * ela ANTES de procurar instância.
 *
 * O QUE ESTE BILHETE AUTORIZA, dito na cara, porque é o que torna aceitável
 * pôr uma segunda credencial numa rota pública: **devolver o nonce que o
 * próprio chamador acabou de mandar**. Não lê linha, não escreve linha, não
 * resolve provedor, não toca no serviço de entrada. Quem não tem a chave do
 * deploy não consegue cunhar o bilhete; quem tem já é o deploy.
 *
 * A construção é cópia de `waMediaToken.js`, e pelo mesmo motivo: quem chama a
 * rota não tem sessão, então a própria requisição é a credencial, e o que a
 * torna segura tem que morar num lugar só — quem cunha e quem confere separados
 * falham ABERTO, não fechado.
 *
 * A chave é derivada do `JWT_SECRET` sob contexto próprio. Derivação dedicada
 * não é cerimônia: usar o `JWT_SECRET` cru aqui faria um bilhete de sonda e um
 * token de sessão serem assinados pela mesma chave, e o ponto inteiro de chave
 * por contexto é que uma fraqueza numa não se gasta na outra.
 */

/**
 * Sessenta segundos.
 *
 * A sonda é uma ida e volta que o painel faz dentro de uma requisição HTTP, com
 * prazo de 5 s (`PROBE_TIMEOUT_MS`). Um minuto cobre isso com folga para um
 * relógio torto entre processos, e é curto o bastante para que o bilhete estar
 * num log de proxy não valha nada amanhã.
 */
export const PROBE_TICKET_TTL_MS = 60 * 1000;

const CONTEXT = 'wa-probe';

let cachedKey = null;
let cachedFrom = null;

function signingKey() {
  if (!process.env.JWT_SECRET && isProduction()) {
    throw new Error('JWT_SECRET must be set to sign WhatsApp probe tickets');
  }
  const base = process.env.JWT_SECRET || DEVELOPMENT_FALLBACK;
  // Lembrada contra o segredo que a produziu: um processo cujo JWT_SECRET muda
  // por baixo não pode continuar assinando com o antigo.
  if (cachedKey && cachedFrom === base) return cachedKey;
  cachedKey = crypto.createHmac('sha256', base).update(CONTEXT).digest();
  cachedFrom = base;
  return cachedKey;
}

/**
 * A assinatura sobre um nonce e um vencimento.
 *
 * O `exp` entra como a STRING que aparece no bilhete, e não como número, para
 * que os bytes assinados sejam os bytes apresentados: reserializar deixaria
 * `0900` e `900` diferirem no bilhete e coincidirem no HMAC.
 */
function digest(nonce, exp) {
  return crypto.createHmac('sha256', signingKey())
    .update(`${nonce}.${exp}`)
    .digest('hex');
}

/**
 * Cunha `<exp>.<hmac>` para um nonce.
 *
 * @param {string} nonce o valor sorteado por `mintNonce()`
 * @returns {string}
 */
export function sign(nonce, now = Date.now()) {
  const exp = String(Math.floor((now + PROBE_TICKET_TTL_MS) / 1000));
  return `${exp}.${digest(String(nonce), exp)}`;
}

/**
 * Se `ticket` foi cunhado aqui, para ESTE nonce, e ainda não venceu.
 *
 * A comparação é em tempo constante. `timingSafeEqual` lança quando os buffers
 * têm tamanhos diferentes — coisa que um bilhete feito à mão arranja sem
 * esforço —, então o tamanho é conferido antes: divergência é bilhete ruim, não
 * um 500.
 *
 * @returns {boolean}
 */
export function verify(nonce, ticket, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 256) return false;
  if (typeof nonce !== 'string' || !nonce) return false;
  const parts = ticket.split('.');
  if (parts.length !== 2) return false;
  const [exp, provided] = parts;
  // Só dígitos: `Number('12e9')` e `Number(' 12')` ambos convertem, e nenhum
  // dos dois é coisa que este assinante tenha escrito algum dia.
  if (!/^[0-9]{1,15}$/.test(exp)) return false;
  if (Number(exp) * 1000 <= now) return false;

  const expected = Buffer.from(digest(nonce, exp), 'utf8');
  const presented = Buffer.from(provided, 'utf8');
  if (expected.length !== presented.length) return false;
  return crypto.timingSafeEqual(expected, presented);
}
