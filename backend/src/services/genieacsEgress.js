import { IS_SAAS } from '../config/edition.js';
import { recordAcsRequest } from '../utils/metrics.js';
import { blockedAddressReason } from '../utils/net/blockedRanges.js';
import { PinnedTransport } from '../utils/net/pinnedFetch.js';

// Re-exported because this module has always been where the panel asks "is this
// address off limits". The table itself now lives in `utils/net/blockedRanges.js`
// so that the WhatsApp guard classifies through exactly the same rules; keeping
// the name here means no call site had to learn about the move.
export { blockedAddressReason };

/**
 * The ports a GenieACS NBI is allowed to be reached on.
 *
 * A base URL that is provider-supplied data is also a port scanner: the panel
 * reports "connected" or "refused" for whatever it is pointed at, so without a
 * list the customer gets to sweep every service our network happens to run.
 * 7557 is the NBI's own default; 80 and 443 are what it looks like behind a
 * reverse proxy, and 8080 is the one every such proxy is actually put on.
 *
 * `GENIEACS_ALLOWED_PORTS` widens it, because four ports is a guess about other
 * people's deployments and some ISP will have put its NBI behind a proxy on
 * 8443. It is deliberately an environment variable and not a column: it is the
 * DEPLOYMENT saying which ports its own network can tolerate being probed on,
 * which is not a decision the probing party gets to make about itself.
 */
/**
 * Este deployment serve mais de um provedor?
 *
 * A guarda de egresso inteira — a tabela de faixas privadas e a allowlist de
 * portas — dependia só de `IS_SAAS`, e `EDITION` tem default `selfhosted`. Um
 * deploy SaaS que suba sem essa variável rodava com as duas DESLIGADAS, e nada
 * no processo percebia: o painel funciona, os testes passam, e a única
 * diferença é que o endereço de metadados da nuvem volta a ser destino válido,
 * salvável em `genieAcsUrl` por qualquer administrador de provedor.
 *
 * O repositório já tinha reconhecido exatamente esse modo de falha no outro
 * portão — `assertSoleProvider` em `dbManagementService.js`, cujo comentário
 * diz que ler `EDITION` "é a ideia certa na forma errada" — e a correção nunca
 * foi trazida para cá. É a mesma: a contagem de provedores é um fato que o
 * processo confere sozinho, e vale TER JUNTO do portão da edição, não no lugar
 * dele.
 *
 * ## Por que a pergunta é síncrona, e a contagem mora fora dela
 *
 * A primeira versão disto consultava o banco DENTRO de `resolveTarget`, que é
 * o caminho de toda requisição ao ACS. Custou caro e ensinou rápido: uma suíte
 * que exercita a resolução de nomes sem banco nenhum parou de terminar, porque
 * a consulta ficava esperando uma conexão que não vinha. Guarda de segurança
 * que pendura o caminho quente numa consulta é guarda que alguém vai desligar.
 *
 * Então a leitura é de memória e a escrita é de fora: `refreshDeploymentSharing`
 * roda no boot e de novo a cada passada do agendador, que já é de minuto em
 * minuto. O pior caso é um provedor número dois nascer e a guarda continuar
 * larga por até uma passada — contra o estado anterior, em que ela ficava larga
 * para sempre.
 *
 * "Compartilhado" é grudento: uma vez que o processo viu dois provedores, não
 * desaprende. Reabrir a guarda porque um provedor foi apagado seria trocar
 * segurança por uma consulta, e a única coisa que a releitura poderia fazer é
 * afrouxar. E a contagem que falha não afrouxa nada: ela simplesmente não muda
 * o que já se sabe.
 */
let compartilhadoGrudento = false;

export function deploymentIsShared() {
  return IS_SAAS || compartilhadoGrudento;
}

/**
 * Confere a tabela e fecha a guarda se houver mais de um provedor.
 *
 * O módulo de banco entra por import DINÂMICO, e isso não é estilo: importá-lo
 * no topo deste arquivo faz `config/database.js` ser carregado por todo mundo
 * que carrega a guarda de egresso — inclusive por suítes que a importam ANTES
 * do harness. E `config/database.js` lê `DATA_DIR` no carregamento: importado
 * cedo demais, ele se liga ao SQLite de desenvolvimento em vez do temporário do
 * teste. Descoberto do jeito certo e pelo preço certo: um `POST /auth/setup`
 * respondeu 409 num banco recém-criado, porque o banco não era o recém-criado.
 */
export async function refreshDeploymentSharing() {
  if (deploymentIsShared()) return true;
  try {
    const { getDb } = await import('../config/database.js');
    const { runUnscoped } = await import('../config/tenantContext.js');
    // `runUnscoped` porque a pergunta é sobre o registro de provedores, que
    // está ACIMA de qualquer provedor — e a sentinela recusaria o handle cru.
    const [{ total } = {}] = await runUnscoped(
      'counting providers to decide whether the egress guard applies',
      () => getDb()('tenants').count({ total: '*' })
    );
    if (Number(total) > 1) compartilhadoGrudento = true;
  } catch (error) {
    // Sem banco não se aprende nada, e não saber não pode virar bloqueio: o
    // que vale continua sendo o que já se sabia.
    console.warn(`Could not count providers for the egress guard: ${error.message}`);
  }
  return deploymentIsShared();
}

/** Só para os testes: desfaz o que o processo aprendeu. */
export function resetDeploymentSharing() {
  compartilhadoGrudento = false;
}

const DEFAULT_ALLOWED_PORTS = [80, 443, 7557, 8080];

function configuredPorts() {
  const extra = String(process.env.GENIEACS_ALLOWED_PORTS || '')
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return new Set([...DEFAULT_ALLOWED_PORTS, ...extra]);
}

const ALLOWED_PORTS = configuredPorts();

/**
 * How much of an NBI answer this process will hold in memory.
 *
 * There was no ceiling at all, which means the ACS chose: a 200 MiB body took
 * RSS from 62 MB to 1133 MB. A ceiling has to be generous, though — a
 * free-text device search asks the NBI for the whole match set, and on a large
 * fleet with the listing projection that is tens of megabytes of legitimate
 * JSON. 128 MiB is far above any real listing and still a bound where there
 * was none; `GENIEACS_MAX_RESPONSE_BYTES` moves it either way for an install
 * that knows its own fleet.
 */
function configuredMaxBytes() {
  const stated = Number.parseInt(process.env.GENIEACS_MAX_RESPONSE_BYTES || '', 10);
  return Number.isInteger(stated) && stated > 0 ? stated : 128 * 1024 * 1024;
}

const MAX_RESPONSE_BYTES = configuredMaxBytes();

/**
 * A refusal by this guard, tagged so a caller can tell it from an upstream
 * failure. The two need different answers: an unreachable ACS is a 502 the
 * operator waits out, a refused address is a 400 they have to fix.
 */
export const EGRESS_REFUSED = 'GENIEACS_EGRESS_REFUSED';

function refuse(message) {
  const error = new Error(message);
  error.code = EGRESS_REFUSED;
  return error;
}

/**
 * The egress guard for every request the panel makes to a GenieACS.
 *
 * Phase 4 turns the ACS base URL into per-provider data, which means a customer
 * gets to name the host this process connects to. Two things follow, and this
 * class is both of them.
 *
 * The first is that the destination has to be checked before the socket opens:
 * a URL naming our own loopback, our VPC, or the cloud metadata service turns
 * the panel into a proxy into its own network.
 *
 * The second is subtler and is the reason this does not use `fetch`: the
 * address vetted here is the address connected to. Both halves — the range
 * table and the resolve-pin-and-cap transport — now live in `utils/net/`, so
 * the WhatsApp guard enforces the same list through the same code path.
 * `utils/net/pinnedFetch.js` explains why `fetch` cannot do this.
 *
 * Nothing here follows a redirect, which is what `redirect: 'manual'` at the
 * call sites asks for — a 3xx arrives as an ordinary not-ok response and is
 * refused by `DeviceService.genieAcsError`.
 *
 * On the self-hosted edition the address classes are not blocked. There the ACS
 * sits on the operator's own LAN and a private address is the normal case, and
 * there is no untrusted party to defend against — the person who wrote the URL
 * owns the install. The pinning stays on in both editions on purpose: one
 * transport that behaves the same everywhere is worth more than a saving, and a
 * path that only ever runs in production is a path nobody has tested.
 */
export class GenieAcsEgress {
  static ALLOWED_PORTS = ALLOWED_PORTS;

  static MAX_RESPONSE_BYTES = MAX_RESPONSE_BYTES;

  /**
   * Name resolution, as one overridable slot. A test drives a rebinding-shaped
   * answer through it — a public address on the first look, a private one on
   * the second — without reaching the network for a name it would have to own.
   */
  static lookup(hostname) {
    return PinnedTransport.lookup(hostname);
  }

  /**
   * Everything decided before the socket opens: which port, which addresses,
   * and whether any of them disqualifies the request.
   *
   * `signal` is the caller's own deadline, and it has to reach the resolution
   * and not only the request that follows it. A resolver that accepts the query
   * and never answers holds the caller exactly as a server that never answers
   * does — same wait, same handler pinned, one step earlier — and the deadline
   * armed around `fetch` below cannot end a wait that happens before the socket
   * is opened. It bounds the WAIT and not the query: `getaddrinfo` has no
   * cancel, so an abort here stops holding the caller and leaves the lookup to
   * finish into nothing.
   */
  static async resolveTarget(url, { allowPrivateAddresses = false, allowPrivateRanges = false, signal } = {}) {
    const parsed = url instanceof URL ? url : new URL(String(url));

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw refuse(`GenieACS URL must use HTTP or HTTPS; received "${parsed.protocol}"`);
    }

    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    // Read through `this` rather than off the module constant, so that the list
    // the class advertises is the list it enforces.
    const allowed = this.ALLOWED_PORTS;
    // `IS_SAAS` OU mais de um provedor na tabela: ver `deploymentIsShared`.
    const protegido = deploymentIsShared();
    if (protegido && !allowed.has(port)) {
      throw refuse(
        `GenieACS port ${port} is not allowed; use one of ${[...allowed].join(', ')}`
      );
    }

    // Brackets are the URL notation for a v6 literal, not part of the address.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

    // `allowPrivateAddresses` is the `tunnel` and `hosted` modes: the ACS really
    // is on a private address there, reached over a link we set up. It is set
    // by us per customer and is never reachable from the provider's own API,
    // because a guard the guarded party can switch off is not a guard. On the
    // self-hosted edition every address is allowed for the same reason.
    const addresses = await PinnedTransport.vetTarget(hostname, {
      lookup: (name) => this.lookup(name),
      signal,
      allowPrivateAddresses: allowPrivateAddresses || !protegido,
      // O modo `tunnel` de um provedor: a rede privada DE CLIENTE passa, e
      // loopback e metadados continuam recusados. Ligado só pela plataforma
      // (`tenant_genieacs_connections`), nunca pela API do próprio provedor.
      allowPrivateRanges,
      refuse: (message) => refuse(`GenieACS host ${message}`)
    });

    // The deadline may have expired INSIDE the resolution above. Without this,
    // a name that did not answer in time would leave here as "resolved to no
    // address" — a sentence about DNS for something that was about the clock.
    signal?.throwIfAborted();
    if (addresses.length === 0) {
      throw new Error(`GenieACS host ${hostname} did not resolve to any address`);
    }

    return { parsed, hostname, port, addresses };
  }

  /**
   * A `fetch`-shaped call that connects only to the vetted addresses.
   *
   * `options` carries the same `method`, `headers`, `body` and `signal` the
   * call sites already passed; the timeouts they arm around it work unchanged.
   */
  static async fetch(url, options = {}) {
    const { allowPrivateAddresses = false, allowPrivateRanges = false, rejectUnauthorized = true } = options;
    let target;
    try {
      target = await this.resolveTarget(url, { allowPrivateAddresses, allowPrivateRanges, signal: options.signal });
    } catch (error) {
      // Counted per provider, by what stopped it: a refusal is ours and a
      // resolution failure is the network's, and the two are different pages.
      recordAcsRequest({ outcome: error?.code === EGRESS_REFUSED ? 'refused' : 'error' });
      throw error;
    }
    const { parsed, hostname, port, addresses } = target;

    try {
      const response = await PinnedTransport.request({
        url: parsed,
        hostname,
        port,
        addresses,
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body,
        signal: options.signal,
        rejectUnauthorized,
        maxBytes: this.MAX_RESPONSE_BYTES
      });
      recordAcsRequest({ outcome: 'ok' });
      return response;
    } catch (error) {
      recordAcsRequest({ outcome: 'error' });
      throw error;
    }
  }
}

export default GenieAcsEgress;
