/**
 * Proteção anti-SSRF para qualquer requisição server-side feita a uma URL que
 * veio do usuário (a URL do servidor Evolution, a URL de uma mídia recebida).
 *
 * O padrão ingênuo — regex sobre a string do host, aplicado só à URL inicial —
 * deixa passar:
 *   - IPv6:                 http://[::1]/
 *   - IPv4 não-decimal:     http://2130706433/ , http://0x7f.1/ , http://127.1/
 *   - CGNAT:                100.64.0.0/10
 *   - nome DNS público → IP interno (inclui rebinding)
 *   - qualquer redirect, quando o fetch usa o default `redirect: 'follow'`
 *
 * As faixas bloqueadas e o transporte não moram mais aqui: são
 * `utils/net/blockedRanges.js` e `utils/net/pinnedFetch.js`, os mesmos que o
 * `services/genieacsEgress.js` usa. Duas tabelas separadas eram duas tabelas
 * DIFERENTES — esta entendia 6to4 e 192.0.0.0/16 e deixava passar multicast
 * IPv6; a de lá tinha multicast e não tinha as outras duas — e nenhuma das duas
 * reconhecia `::ffff:0:7f00:1`, que é 127.0.0.1 com um grupo zero a mais.
 *
 * Mais importante: a checagem e a conexão usavam RESOLVEDORES DIFERENTES. Aqui
 * se validava com `dns.resolve4`/`resolve6` (o protocolo DNS) e depois se
 * entregava o NOME ao `fetch`, que resolve por `getaddrinfo`. Tudo o que o
 * resolvedor do sistema sabe e o DNS não — `/etc/hosts`, `extra_hosts:` do
 * Compose, nome de contêiner, NSS, mDNS — passava como público e conectava como
 * privado. Com `127.0.0.1 vm` em `/etc/hosts`, `http://vm/` era aprovado e
 * chegava no loopback. Agora a resolução é `dns.lookup` (o mesmo
 * `getaddrinfo`) e o endereço aprovado é o endereço conectado, fixado no
 * socket — o que também fecha a janela de DNS rebinding entre uma coisa e
 * outra.
 */

import { blockedAddressReason } from '../net/blockedRanges.js';
import { PinnedTransport, ResponseTooLargeError } from '../net/pinnedFetch.js';

export { ResponseTooLargeError };

/**
 * Converte um host IPv4 em qualquer notação aceita por resolvers (dotted quad,
 * decimal, octal, hex e formas curtas tipo `127.1`) para inteiro 32 bits.
 * Retorna null quando o host não é um literal IPv4.
 */
export function parseIPv4(host) {
  const parts = String(host || '').split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!p) return null;
    let n;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // Na forma curta (a.b, a.b.c) o último campo absorve os octetos restantes.
  const last = nums.pop();
  if (last >= 256 ** (4 - nums.length)) return null;
  if (nums.some((n) => n > 255)) return null;
  let val = last;
  nums.forEach((n, i) => {
    val += n * 256 ** (3 - i);
  });
  return val >>> 0;
}

/** O inteiro de 32 bits, escrito como o dotted quad que a tabela classifica. */
function dotted(v) {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
}

export function isPrivateIPv4(v) {
  return blockedAddressReason(dotted(v)) !== null;
}

export function isPrivateIPv6(host) {
  return blockedAddressReason(host) !== null;
}

/**
 * Bloqueio por literal, sem I/O. Nomes DNS públicos passam aqui e devem ser
 * verificados depois por resolvesToPrivate().
 */
export function isBlockedHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (h.startsWith('[') || h.includes(':')) return isPrivateIPv6(h);
  const v4 = parseIPv4(h);
  if (v4 !== null) return isPrivateIPv4(v4);
  return false;
}

/**
 * Resolve o nome e rejeita se QUALQUER endereço cair em faixa interna — cobre
 * host público apontando para IP privado.
 *
 * Um nome que não resolve devolve false: quem barra aí é o próprio fetch, e
 * tratar NXDOMAIN como "privado" só produziria uma mensagem de erro errada.
 */
export async function resolvesToPrivate(host, signal) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || h.includes(':') || parseIPv4(h) !== null) return false; // já coberto por isBlockedHost
  // Já cancelado antes de começar: não há consulta a fazer, e quem chama vai
  // terminar pelo próprio sinal logo em seguida.
  if (signal?.aborted) return false;

  // `dns.lookup` — `getaddrinfo` — e não mais `resolve4`/`resolve6`, porque é
  // o resolvedor que o socket usaria: era essa diferença que deixava
  // `/etc/hosts` e afins passarem como públicos. O preço é que `getaddrinfo`
  // não tem `cancel()`: o prazo abaixo faz esta função PARAR DE ESPERAR, mas a
  // consulta em si segue pendurada no threadpool até o sistema desistir. Quem
  // chamou é solto na hora, que é o que o prazo existe para garantir.
  const addrs = await PinnedTransport.addressesFor(h, undefined, signal);
  return addrs.some(({ address }) => blockedAddressReason(address) !== null);
}

export class SsrfBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * A URL, mais os endereços que ela resolve — que são os endereços que o socket
 * pode usar e nenhum outro.
 *
 * `exigeEndereco` separa os dois usos. Quem só valida (`assertPublicUrl`, que o
 * EvolutionClient chama antes de guardar uma configuração) trata "não resolve"
 * como "não é privado": quem barra aí é a conexão, e chamar NXDOMAIN de host
 * bloqueado só produziria uma mensagem errada. Quem vai CONECTAR precisa de
 * pelo menos um endereço para fixar, e sem isso não há requisição.
 *
 * O `signal` põe a resolução de nome sob o mesmo prazo da requisição que ela
 * precede. Uma consulta abandonada não devolve endereço nenhum, e é o sinal —
 * não um "host privado" inventado — que encerra a chamada.
 */
async function vetUrl(raw, { exigeEndereco, signal }) {
  let u;
  try {
    u = raw instanceof URL ? raw : new URL(String(raw));
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new SsrfBlockedError('Unsupported protocol');
  if (isBlockedHost(u.hostname)) throw new SsrfBlockedError('Private host blocked');

  const addresses = await PinnedTransport.vetTarget(u.hostname, {
    signal,
    refuse: () => new SsrfBlockedError('Private host blocked')
  });
  if (exigeEndereco) {
    // O prazo pode ter vencido DENTRO da resolução acima, e aí o motivo de
    // parar é ele. Sem esta linha, um nome que não respondeu a tempo sairia
    // daqui como "não resolveu para endereço nenhum" — uma mensagem sobre o
    // DNS para um problema que foi de relógio.
    signal?.throwIfAborted();
    if (addresses.length === 0) {
      throw new SsrfBlockedError(`Host ${u.hostname} did not resolve to any address`);
    }
  }
  return { url: u, addresses };
}

/**
 * Valida uma URL antes de qualquer requisição server-side. Lança
 * SsrfBlockedError quando o destino não é público.
 *
 * Com o prazo vencido durante a resolução, esta responde "não é privado" e
 * quem chama termina pelo sinal: reportar "host privado" por causa de um
 * relógio seria dizer ao operador uma coisa que não aconteceu.
 */
export async function assertPublicUrl(raw, signal) {
  const { url } = await vetUrl(raw, { exigeEndereco: false, signal });
  return url;
}

export const MAX_REDIRECTS = 3;

/**
 * Quanto tempo uma busca inteira pode levar, do primeiro salto ao último byte.
 *
 * O `fetch` do Node não tem prazo nenhum por conta própria, e sem um destes o
 * host de destino escolhe por quanto tempo prende quem chamou: manda os
 * cabeçalhos, depois pinga um byte por minuto, e o handler do webhook que
 * aguarda esta função nunca devolve o socket. `waWebhookLimiter` conta chegadas,
 * não requisições simultâneas, então nada limitava quantas ficavam presas ao
 * mesmo tempo. O teto de bytes abaixo limita o tamanho, não o tempo — são
 * coisas diferentes e cada uma precisa do seu limite.
 *
 * Um prazo SÓ, criado antes do laço e compartilhado por todos os saltos, e não
 * um por salto: três saltos com 30 s cada seriam 90 s de espera, que é
 * justamente o que se quer evitar.
 *
 * E vale da resolução do nome ao último byte, não só do `fetch` em diante. A
 * verificação anti-SSRF consulta o DNS antes de qualquer conexão, e um
 * resolver que não responde prende quem chamou exatamente como um servidor que
 * não responde — mesma espera, mesmo handler preso, um passo antes.
 */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Quanto de resposta cabe na memória do processo quando quem chama não diz.
 * Dimensionado para resposta de API; quem baixa arquivo — `waMediaService` —
 * passa o seu próprio teto.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Segue redirects manualmente, revalidando o host a CADA salto. Usar no lugar
 * de fetch() sempre que a URL de destino tiver origem no usuário.
 *
 * `init.timeoutMs` substitui o prazo padrão para quem baixa arquivo grande, e
 * `init.maxBytes` o teto de corpo. O `signal` de quem chama continua valendo:
 * os dois são combinados, então o cancelamento vem do que disparar primeiro, e
 * o combinado governa tanto a resolução de nome de cada salto quanto a
 * requisição em si.
 *
 * Não vai por `fetch`: o endereço aprovado precisa ser o endereço conectado, e
 * o `fetch` do Node não aceita resolvedor. Ver `utils/net/pinnedFetch.js`.
 */
export async function safeFetch(start, init = {}, maxRedirects = MAX_REDIRECTS) {
  const {
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES,
    signal: callerSignal,
    method,
    headers,
    body
  } = init;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;

  let current = start instanceof URL ? start : new URL(String(start));
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // eslint-disable-next-line no-await-in-loop -- os saltos são sequenciais por natureza
    const { url, addresses } = await vetUrl(current, { exigeEndereco: true, signal });
    // O prazo pode ter vencido DENTRO da resolução acima. Sem isto a decisão
    // de encerrar ficaria por conta da requisição, que é justamente o passo que
    // o prazo existe para não deixar começar.
    signal.throwIfAborted();
    // eslint-disable-next-line no-await-in-loop
    const r = await PinnedTransport.request({
      url,
      addresses,
      method,
      headers,
      body,
      signal,
      maxBytes
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) return r;
      try {
        // eslint-disable-next-line no-await-in-loop
        await r.body?.cancel();
      } catch {
        /* corpo já descartado */
      }
      current = new URL(loc, url);
      continue;
    }
    return r;
  }
  throw new SsrfBlockedError('Too many redirects');
}
