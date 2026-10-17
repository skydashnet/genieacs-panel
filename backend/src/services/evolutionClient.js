import { WaError } from './whatsappConfigService.js';
import {
  flavorFromProbes,
  readLicenseBlock
} from '../utils/wa/evolutionApi.js';
import { normalizeEvoUrl, isHostAllowed } from '../utils/wa/evolutionPolicy.js';
import { assertPublicUrl, SsrfBlockedError } from '../utils/wa/ssrfGuard.js';
import { PinnedTransport, bareHostname } from '../utils/net/pinnedFetch.js';

const REQUEST_TIMEOUT_MS = 15_000;

/** How much of a server error body reaches the operator. */
const ERROR_BODY_LIMIT = 500;

/**
 * The most of an Evolution response this client will hold in memory.
 *
 * `response.text()` buffers the whole body into one string with no ceiling, and
 * `ERROR_BODY_LIMIT` truncates only at print time — by then the body is already
 * resident, twice over once `JSON.parse` copies it. The 15 s timeout bounds how
 * LONG a body may stream, which on a fast link is still hundreds of megabytes.
 *
 * A megabyte is far more than this API ever answers: the largest real response
 * is an instance list, and a base64 QR is tens of kilobytes. Anything past this
 * is a server that is broken or hostile, and either way there is nothing in the
 * excess worth reading.
 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * The HTTP half of the Evolution integration.
 *
 * `utils/wa/evolutionApi.js` decides *what* to ask — it is pure and returns
 * request descriptors. This decides *how*: which credential the route needs,
 * the timeout, what a redirect means, and how a failure becomes a `WaError`
 * with a code the UI can act on.
 *
 * The split exists so the translation between the two Evolution servers stays
 * testable without a network, and so there is exactly one place where an
 * outbound request to an operator-supplied address is made.
 *
 * ── The allowlist is captured, not passed ──────────────────────────────
 * A client is constructed with the target and the allowlist together, and
 * validates on every send. No call site can forget the check, because there is
 * no way to make a request without going through a constructed client. In the
 * source system the allowlist was verified when an account was created and the
 * row stayed writable afterwards, which made the check decorative.
 */
export class EvolutionClient {
  /**
   * @param {object} p
   * @param {string} p.baseUrl        the Evolution server
   * @param {string[]} p.allowedHosts operator allowlist; empty means any public host
   * @param {string} [p.adminKey]     the server's global key — only create, list and delete need it
   * @param {string} [p.instanceToken] this instance's token; on Evolution GO it is what selects the instance
   * @param {'go'|'v2'} [p.flavor]
   */
  constructor({ baseUrl, allowedHosts = [], adminKey = '', instanceToken = '', flavor = 'v2' }) {
    this.baseUrl = normalizeEvoUrl(baseUrl);
    this.allowedHosts = allowedHosts;
    this.adminKey = adminKey;
    this.instanceToken = instanceToken;
    this.flavor = flavor;
  }

  /**
   * Name resolution, as one overridable slot — the same one `GenieAcsEgress`
   * has, for the same reason: a test drives a rebinding-shaped answer through
   * it without owning a zone.
   */
  static lookup(hostname) {
    return PinnedTransport.lookup(hostname);
  }

  /**
   * O socket, como um encaixe substituível. O padrão é `PinnedTransport`, que
   * conecta só aos endereços já conferidos; as suítes trocam isto para levar a
   * chamada a um dublê em loopback sem desligar a guarda que vem antes.
   */
  static connect(options) {
    return PinnedTransport.request(options);
  }

  /** Rejects a target that the operator did not authorise, or that is not public. */
  async assertTarget() {
    this.assertPolicy();
    try {
      await assertPublicUrl(this.baseUrl);
    } catch (error) {
      if (error instanceof SsrfBlockedError) throw blockedHost(error.message);
      throw error;
    }
  }

  /**
   * O que se decide sem rede: URL presente, TLS, allowlist do operador. A
   * classificação do ENDEREÇO fica para `open`, que é quem conecta — conferir
   * aqui e deixar outro resolvedor escolher o endereço depois era a brecha.
   */
  assertPolicy() {
    if (!this.baseUrl) {
      throw new WaError('whatsapp.error.invalidBaseUrl', { code: 'invalid_base_url', status: 400 });
    }
    // TLS is required, and the SSRF guard below is the reason it can be.
    //
    // `http:` was allowed for the sake of a lab Evolution on the same LAN, and
    // that justification does not survive the guard: it blocks every private
    // range, so an `http://` target is by construction a PUBLIC host on the
    // open internet. Every request from `send` carries a credential in the
    // `apikey` header — the server's global admin key on create, list and
    // delete, the instance token everywhere else — so allowing `http:` meant
    // those crossing the internet in the clear, where anyone on the path reads
    // them and then owns the provider's WhatsApp.
    //
    // `probe` sends no credential, but it is refused here too rather than
    // specially exempted: it probes the same base URL that every authenticated
    // call will use, so letting it succeed would only move the refusal to a
    // later step and make it harder to read.
    if (!/^https:\/\//i.test(this.baseUrl)) {
      throw new WaError('whatsapp.error.insecureBaseUrl', {
        code: 'insecure_base_url',
        status: 400
      });
    }
    if (!isHostAllowed(this.baseUrl, this.allowedHosts)) {
      throw new WaError('whatsapp.error.hostNotAllowed', { code: 'host_not_allowed', status: 400 });
    }
  }

  /**
   * Resolve, confere e conecta ao endereço conferido — e a nenhum outro.
   *
   * Isto era `assertPublicUrl` seguido de `fetch`, e são duas resoluções do
   * mesmo nome: a primeira respondia um endereço público e passava na guarda, a
   * segunda era do `fetch`, que resolve de novo por conta própria. Quem controla
   * a zona faz as duas discordarem (DNS rebinding, TTL zero), e a chamada — com
   * a chave global do servidor ou o token da instância no `apikey` — saía para o
   * loopback ou para a VPC. `PinnedTransport` fixa o endereço conferido no
   * `lookup` do socket, mantendo o nome no `Host` e no SNI, então o certificado
   * continua sendo conferido contra o nome que o operador digitou.
   *
   * O prazo vale da resolução ao último byte, como antes valia do `fetch` em
   * diante; e o teto de corpo agora é aplicado pelo transporte, antes de o
   * corpo inteiro estar na memória.
   */
  async open(path, { method, headers, body, maxBytes }) {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const url = new URL(`${this.baseUrl}${path}`);
    const hostname = bareHostname(url.hostname);
    const addresses = await PinnedTransport.vetTarget(hostname, {
      lookup: (name) => EvolutionClient.lookup(name),
      signal,
      // A mesma frase vaga do `ssrfGuard`: quem lê é o administrador, mas o
      // endereço interno não acrescenta nada ao que ele tem de consertar.
      refuse: () => blockedHost('Private host blocked')
    });
    // O prazo pode ter vencido DENTRO da resolução; aí o motivo é o relógio.
    signal.throwIfAborted();
    if (addresses.length === 0) {
      throw new Error(`${hostname} did not resolve to any address`);
    }
    return EvolutionClient.connect({
      url,
      hostname,
      addresses,
      method,
      headers,
      body,
      signal,
      maxBytes: maxBytes ?? MAX_RESPONSE_BYTES
    });
  }

  /**
   * The credential a route asks for.
   *
   * On Evolution GO almost no route carries the instance name — the server
   * picks the instance by matching the `apikey` header against that instance's
   * token. Only create, list and delete use the server's global key. Getting
   * this wrong is not a 401 you can read: it is the wrong instance answering.
   */
  keyFor(kind) {
    const key = kind === 'admin' ? this.adminKey : this.instanceToken;
    if (!key) {
      throw new WaError(
        kind === 'admin' ? 'whatsapp.error.adminKeyMissing' : 'whatsapp.error.instanceTokenMissing',
        { code: kind === 'admin' ? 'admin_key_missing' : 'instance_token_missing', status: 400 }
      );
    }
    return key;
  }

  /**
   * Performs one request built by `evolutionApi`.
   *
   * Returns `{ ok, status, data }` rather than throwing on a non-2xx: several
   * callers treat a specific failure as an expected state — "no QR available
   * yet" while the client boots, "already exists" on the reconnect path — and
   * an exception would make those read as errors. Transport failures and a
   * licence block do throw, because no caller can proceed through them.
   *
   * @param {{ path: string, method: string, body?: unknown, key: 'admin'|'instance' }} request
   */
  async send(request) {
    this.assertPolicy();
    const apikey = this.keyFor(request.key);

    let response;
    try {
      // Evolution does not redirect in normal use. Following one would send
      // the instance token to wherever the redirect points, so a 3xx is
      // treated as a failure rather than as a hop — and `PinnedTransport`
      // never follows one, so it arrives here as an ordinary answer.
      response = await this.open(request.path, {
        method: request.method,
        headers: { 'Content-Type': 'application/json', apikey },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        maxBytes: request.maxBytes
      });
    } catch (error) {
      if (error instanceof WaError) throw error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new WaError('whatsapp.error.timeout', { code: 'timeout', status: 504 });
      }
      // Um corpo acima de `MAX_RESPONSE_BYTES` também cai aqui: o transporte
      // derruba o socket sem entregar status, e um Evolution que responde mais
      // de um megabyte está quebrado ou é hostil — "inalcançável" é honesto.
      throw new WaError('whatsapp.error.unreachable', {
        code: 'unreachable',
        status: 502,
        vars: { reason: String(error?.message || error).slice(0, 200) }
      });
    }

    if (response.status >= 300 && response.status < 400) {
      throw new WaError('whatsapp.error.redirect', { code: 'redirect', status: 502 });
    }

    const data = await readBody(response, request.maxBytes ?? MAX_RESPONSE_BYTES);

    // A licensed distribution refuses EVERY route with the same 503, health
    // included. Without naming it, the operator reads a raw JSON dump inside
    // "the server returned an error" and goes to check the URL and the key —
    // which are correct. The licence activates in the server's own manager.
    const licence = readLicenseBlock(response.status, data);
    if (licence) {
      throw new WaError('whatsapp.error.licenseRequired', {
        code: 'license_required',
        status: 502,
        details: licence.registerUrl
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new WaError('whatsapp.error.unauthorized', { code: 'unauthorized', status: 502 });
    }

    return { ok: response.ok, status: response.status, data };
  }

  /**
   * Same as `send`, but a non-2xx becomes a `WaError` carrying the server's own
   * words.
   *
   * Reflecting the response body is safe here in a way it was not in the system
   * this is ported from. There, any seller could point the integration at an
   * address of their choosing, so echoing the reply turned the panel into an
   * SSRF read primitive. Here the only person who can set the address is the
   * administrator, who is also the only person who sees the message — there is
   * nothing to exfiltrate to. Truncated all the same, because a server that
   * answers with a stack trace should not fill the screen.
   */
  async sendOrThrow(request) {
    const result = await this.send(request);
    if (!result.ok) {
      throw new WaError('whatsapp.error.httpError', {
        code: 'http_error',
        status: 502,
        vars: { status: result.status, body: describe(result.data) }
      });
    }
    return result;
  }

  /**
   * Asks the server which of the two it is, before building any payload.
   *
   * Both probes are unauthenticated: Evolution GO publishes `GET /server/ok`
   * outside its middleware, and v2 answers its root with a version. Detecting
   * up front is what stops the panel from discovering the flavour the way the
   * source system did — one HTTP 400 at a time, mid-create.
   *
   * A probe that fails is not an error here: `flavorFromProbes` falls back to
   * v2, whose failure mode against a GO server is a legible 404.
   */
  async detectFlavor() {
    const [serverOk, root] = await Promise.all([this.probe('/server/ok'), this.probe('/')]);
    this.flavor = flavorFromProbes(serverOk, root);
    return this.flavor;
  }

  /** One unauthenticated GET, swallowing transport failures. */
  async probe(path) {
    this.assertPolicy();
    try {
      const response = await this.open(path, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });
      return { ok: response.ok, status: response.status, data: await readBody(response) };
    } catch (error) {
      // A recusa da guarda NÃO é "o servidor não respondeu": engolida aqui, um
      // alvo privado viraria uma sonda silenciosa em vez de um erro legível.
      if (error instanceof WaError) throw error;
      return { ok: false, status: 0, data: null };
    }
  }
}

function blockedHost(reason) {
  return new WaError('whatsapp.error.blockedHost', {
    code: 'blocked_host',
    status: 400,
    vars: { reason }
  });
}

/**
 * Reads the body as JSON, falling back to text.
 *
 * A server behind a misconfigured proxy answers HTML, and a JSON parse failure
 * there would hide the status code that actually explains the problem.
 */
async function readBody(response, limit = MAX_RESPONSE_BYTES) {
  const text = await readCapped(response, limit);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The body as text, giving up once it passes `MAX_RESPONSE_BYTES`.
 *
 * The declared length is checked first, so an honest oversized body costs
 * nothing to refuse; the running total is what catches a server that declares
 * no length, or lies about it. Over the cap returns empty rather than a
 * truncated string: half a JSON document parses as nothing useful, and handing
 * back a fragment would invite a caller to act on it.
 */
async function readCapped(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    return '';
  }
  if (!response.body) return '';
  const parts = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > limit) {
        await response.body.cancel().catch(() => {});
        return '';
      }
      parts.push(Buffer.from(chunk));
    }
  } catch {
    // A body that dies mid-stream is the same nothing as a body we refused:
    // `readBody`'s callers already treat a null as "the server said nothing".
    return '';
  }
  return total ? Buffer.concat(parts).toString('utf8') : '';
}

/** A short, printable form of whatever the server sent back. */
function describe(data) {
  if (data === null || data === undefined) return '';
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}…` : text;
}

/**
 * Builds a client for one connected number.
 *
 * `adminKey` comes from the global configuration rather than the row: the
 * server's master key is one secret for the whole panel, and copying it per
 * account would multiply the places it can leak from.
 */
export function clientForAccount(account, config, decryptedInstanceToken) {
  return new EvolutionClient({
    baseUrl: account.base_url,
    allowedHosts: config.allowedHosts,
    adminKey: config.managedAdminKey,
    instanceToken: decryptedInstanceToken,
    flavor: account.flavor
  });
}

export { REQUEST_TIMEOUT_MS };
