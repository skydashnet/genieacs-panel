#!/usr/bin/env node
/**
 * SkyGenPanel — agente do GenieACS.
 *
 * ## O que é
 *
 * O programa que o provedor instala numa máquina da rede DELE quando o
 * GenieACS mora numa rede interna, sem IP público. O agente abre uma conexão
 * WebSocket de SAÍDA para o painel e fica esperando; quando o painel precisa
 * falar com a NBI daquele provedor, manda o pedido por essa conexão, o agente
 * chama o GenieACS local e devolve a resposta. Nenhuma porta é aberta na rede
 * do provedor: quem disca é sempre o agente.
 *
 * Um arquivo, sem dependências, Node 22 ou mais novo (usa o `WebSocket` e o
 * `fetch` globais). Sem `npm install`, sem `node_modules`: o instalador baixa
 * este arquivo e o systemd o executa. Cada dependência seria mais um pacote de
 * terceiro rodando dentro da rede do provedor, com acesso ao ACS dele.
 *
 * ## Configuração
 *
 * Só pelo ambiente — o serviço do systemd carrega de um arquivo 0600:
 *
 *   PANEL_URL=https://painel.exemplo.com.br
 *   AGENT_TOKEN=sgpa_...
 *   GENIEACS_URL=http://127.0.0.1:7557
 *
 * O token NUNCA vem por argumento de linha de comando: a linha de comando de
 * qualquer processo é legível por qualquer usuário da máquina (`ps`,
 * `/proc/<pid>/cmdline`) e acaba em histórico de shell. Argumentos são
 * ignorados, com um aviso.
 *
 * ## O que ele faz
 *
 * - conecta em `<PANEL_URL>/api/genieacs-agent/connect` com `Authorization:
 *   Bearer <token>` e manda `hello` com a versão;
 * - executa pedidos `request` do painel contra a NBI em `GENIEACS_URL` e
 *   devolve `response` (status, cabeçalhos, corpo em base64) ou `error`;
 * - reconecta sozinho, com espera crescente, quando a conexão cai.
 *
 * ## O que ele se recusa a fazer
 *
 * O agente é um pé dentro da rede do provedor controlado de fora. Se o painel
 * for comprometido, a primeira coisa que um atacante tentaria é usar o agente
 * como proxy para varrer a rede interna — o roteador, a OLT, o servidor de
 * banco. Por isso ele só executa o que tem forma de NBI do GenieACS, e confere
 * isso sozinho, sem confiar no painel:
 *
 * - só GET, POST, PUT e DELETE;
 * - só caminhos relativos à raiz da NBI configurada: nada de URL absoluta,
 *   `//host`, barra invertida, caractere de controle ou `..` (nem codificado);
 *   a URL final tem que ter a MESMA origem de `GENIEACS_URL`;
 * - só repassa os cabeçalhos de uma lista curta (credencial, tipo, aceite);
 * - nunca segue redirecionamento (um 3xx volta para o painel como está);
 * - não lê resposta maior que 48 MiB, nem espera mais que 120 s.
 *
 * E o que ele nunca escreve no log: token, corpo, cabeçalho de credencial, nem
 * a query do caminho (ela carrega número de série de cliente). O journal
 * recebe estado e contagem — conectado, desconectado, reconectando, pedidos
 * por minuto por método e primeiro segmento do caminho.
 */

import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

export const AGENT_VERSION = '1.1.0';

/** Onde o painel espera o agente, relativo à `PANEL_URL`. */
const CONNECT_PATH = '/api/genieacs-agent/connect';

/**
 * O teto do corpo de resposta do GenieACS.
 *
 * O painel aceita frames de até 64 MiB (`maxPayload`), e o corpo vai em base64,
 * que cresce 4/3: 48 MiB viram 64 MiB. Acima disso a resposta nem caberia no
 * frame — o painel derrubaria a conexão INTEIRA, levando junto os outros
 * pedidos em andamento. Recusar aqui, com `too_large`, custa só este pedido.
 */
export const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

/**
 * O prazo máximo de um pedido, seja qual for o `timeoutMs` que o painel pedir.
 * Um painel com defeito (ou comprometido) mandando prazos de horas prenderia as
 * vagas de concorrência para sempre; 120 s cobre com folga a NBI mais lenta.
 */
const MAX_TIMEOUT_MS = 120_000;
/** Prazo quando o pedido não diz (o contrato manda sempre; isto é só a rede de segurança). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Quantos pedidos ao GenieACS ao mesmo tempo. O painel já limita os dele; este
 * teto é do lado do provedor, para que um painel com defeito não derrube o ACS
 * local com centenas de requisições simultâneas.
 */
const MAX_CONCURRENCY = 8;
/** Pedidos esperando vaga. Acima disso, recusa: memória do agente não é fila infinita. */
const MAX_QUEUE = 256;

/**
 * O tamanho máximo do caminho. O GenieACS (Node) recusa cabeçalho acima de
 * 16 KiB por padrão, e a linha da requisição entra na conta; o dobro é folga
 * para um ACS configurado com limite maior.
 */
const MAX_PATH_LENGTH = 32 * 1024;
const MAX_ID_LENGTH = 200;

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/**
 * Os cabeçalhos que o agente repassa ao GenieACS. Lista PERMITIDA, não
 * proibida: o que o painel precisa é a credencial da NBI (`authorization`), o
 * tipo do corpo e o aceite. `host`, `cookie`, `connection`,
 * `transfer-encoding`, `x-forwarded-*` e o que mais vier ficam de fora — um
 * `host` escolhido pelo painel, por exemplo, alcançaria outro site virtual
 * atrás do mesmo proxy reverso do provedor.
 *
 * Desde a 1.1.0, também os quatro cabeçalhos com que a NBI do GenieACS recebe um
 * arquivo (`PUT /files/<nome>`): `fileType`, `oui`, `productClass` e `version`.
 * São os únicos metadados que a coleção `files` guarda, e sem eles o firmware
 * enviado pelo painel chegaria ao ACS sem tipo nem modelo. O painel confere a
 * versão anunciada no `hello` antes de mandar um arquivo por um agente.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'authorization', 'content-type', 'accept', 'filetype', 'oui', 'productclass', 'version'
]);

/**
 * Cabeçalhos da resposta que NÃO voltam ao painel.
 *
 * Os hop-by-hop descrevem ESTA conexão HTTP (agente↔GenieACS) e não fazem
 * sentido do outro lado do túnel. `set-cookie` é sessão do ACS, que o painel
 * não usa e não deve guardar. `content-encoding` e `content-length` saem porque
 * o `fetch` já descomprimiu o corpo: repassá-los descreveria bytes que não são
 * os que vão no `body`.
 */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'content-encoding', 'content-length'
]);

/** Sem `open` nesse tempo, a tentativa é dada como falha (um painel mudo não pode segurar o agente). */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Silêncio máximo do painel numa conexão aberta. O painel manda
 * `{ type: 'ping' }` a cada 30 s; o `WebSocket` do Node responde sozinho ao
 * ping de PROTOCOLO, mas não o expõe, então uma conexão meio aberta (NAT que
 * esqueceu o mapeamento, link que caiu sem FIN) só apareceria depois de
 * minutos de keepalive TCP — com o painel dizendo "desconectado" e o agente
 * achando que está tudo bem. Três batimentos perdidos e o agente reconecta.
 */
const SILENCE_LIMIT_MS = 90_000;
/** Prazo da sondagem que descobre o status HTTP de um upgrade recusado (veja `probeUpgrade`). */
const PROBE_TIMEOUT_MS = 10_000;
/** De quanto em quanto tempo o resumo de pedidos vai para o log. */
const STATS_INTERVAL_MS = 60_000;

/** Fechamentos do painel (contrato do 4b). */
const CLOSE_REVOKED = 4001;
const CLOSE_REPLACED = 4002;
const CLOSE_MODE_CHANGED = 4003;

/** `WebSocket.OPEN` — fixo pela especificação; lido daqui para aceitar implementações de teste. */
const OPEN = 1;

/** Erro de configuração: a partida recusa, e o ponto de entrada sai com 2. */
class AgentConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentConfigError';
    this.code = 'AGENT_CONFIG';
  }
}

/** Pedido recusado pelo agente: vira `{ type: 'error', code: 'bad_request' }`. */
class Refusal extends Error {}

/* ------------------------------------------------------------------------ */
/* Configuração                                                             */
/* ------------------------------------------------------------------------ */

/**
 * O host é local? Só para decidir se `http:` merece aviso: token em texto puro
 * pela internet é problema; dentro da própria máquina ou da LAN do provedor
 * (o painel self-hosted na mesma rede) é o caso normal.
 */
function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (family === 6) {
    return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  return false;
}

/** Uma URL http(s) sem credencial embutida, ou erro de configuração com o nome da variável. */
function parseHttpUrl(raw, name) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new AgentConfigError(`${name} não é uma URL válida (ex.: https://painel.exemplo.com.br).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgentConfigError(`${name} precisa usar http:// ou https://.`);
  }
  // Credencial na URL vazaria em qualquer log de URL, e não é como o painel
  // autentica o agente (é o Bearer) nem como a NBI recebe a dela (é o
  // cabeçalho que o painel monta).
  if (url.username || url.password) {
    throw new AgentConfigError(`${name} não pode ter usuário ou senha embutidos na URL.`);
  }
  return url;
}

/**
 * O endereço do WebSocket do painel. Aceita painel publicado sob um prefixo
 * (`https://x/painel`): o caminho de conexão entra DEPOIS dele. Query e
 * fragmento da `PANEL_URL` não têm uso e são descartados.
 */
function connectUrlFor(panel) {
  const url = new URL(panel.href);
  url.protocol = panel.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${panel.pathname.replace(/\/+$/, '')}${CONNECT_PATH}`;
  url.search = '';
  url.hash = '';
  return url;
}

/* ------------------------------------------------------------------------ */
/* O que é NBI                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Um segmento do caminho que, decodificado, é (ou contém) `..`.
 *
 * O parser de URL do WHATWG — o do `new URL` e o do `fetch` — trata `%2e` como
 * `.` em segmentos de caminho: `/devices/%2e%2e/x` vira `/x`, e `.%2E` e `%2e.`
 * também. Então não basta procurar `..` literal. Decodificamos repetidas vezes
 * (até estabilizar, com teto) porque um proxy reverso na frente do GenieACS
 * pode decodificar mais uma camada, e partimos também em `/` e `\` decodificados:
 * `a%2f..%2fb` é um id inocente para o GenieACS, mas não para um nginx que
 * normalize `%2f`. Nenhum id legítimo de equipamento tem `..` como pedaço.
 *
 * Devolve `'dotdot'`, `'escape'` (escape `%` inválido na primeira camada — o
 * GenieACS também o recusaria) ou `null`.
 */
function badSegment(segment) {
  let current = segment;
  for (let layer = 0; layer < 4; layer += 1) {
    if (current.split(/[/\\]/).some((piece) => piece === '..')) return 'dotdot';
    if (!current.includes('%')) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // Na primeira camada o escape inválido é do próprio pedido; nas
      // seguintes é um `%` literal de um id (`%25` decodificado), e parar ali
      // é o certo.
      return layer === 0 ? 'escape' : null;
    }
    if (decoded === current) return null;
    current = decoded;
  }
  return null;
}

/**
 * A URL do GenieACS para o `path` que o painel mandou, ou `Refusal`.
 *
 * Cada regra fecha uma porta diferente; a última (mesma origem) sozinha já
 * bastaria contra troca de host, e as outras existem porque "bastaria" não é
 * como se escreve a única barreira entre um painel comprometido e a rede
 * interna do provedor:
 *
 * - começa com `/` e não com `//`: `//host/x` é URL relativa AO ESQUEMA — o
 *   `new URL` a resolve para outro host. Isto também exclui esquema
 *   (`http://...`), que não começa com `/`;
 * - sem `\`: o WHATWG trata `\` como `/` em URL http, então `/\host` é `//host`;
 * - sem caractere de controle: o parser os remove ou codifica em silêncio, e o
 *   que é removido em silêncio muda o significado depois de conferido;
 * - sem `..` em nenhum segmento, nem codificado (`badSegment`): a NBI é a raiz
 *   do GenieACS, e subir dela é sair dela.
 */
export function resolveNbiUrl(path, genieacsOrigin) {
  if (typeof path !== 'string' || path.length === 0) throw new Refusal('caminho ausente');
  if (path.length > MAX_PATH_LENGTH) throw new Refusal('caminho longo demais');
  if (!path.startsWith('/') || path.startsWith('//')) throw new Refusal('caminho não relativo à raiz da NBI');
  if (path.includes('\\')) throw new Refusal('barra invertida no caminho');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Refusal('caractere de controle no caminho');

  const pathname = path.split(/[?#]/, 1)[0];
  for (const segment of pathname.split('/')) {
    const problem = badSegment(segment);
    if (problem === 'dotdot') throw new Refusal("'..' no caminho");
    if (problem === 'escape') throw new Refusal('escape % inválido no caminho');
  }

  let url;
  try {
    url = new URL(path, `${genieacsOrigin}/`);
  } catch {
    throw new Refusal('caminho inválido');
  }
  if (url.origin !== genieacsOrigin) throw new Refusal('caminho fora do GenieACS');
  url.hash = '';
  return url;
}

/** Só os cabeçalhos permitidos, com valor de texto sem quebra de linha. */
function pickHeaders(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Refusal('cabeçalhos inválidos');
  const headers = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = String(name).toLowerCase();
    if (!FORWARDED_REQUEST_HEADERS.has(key)) continue;
    // eslint-disable-next-line no-control-regex
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000\r\n]/.test(value)) {
      throw new Refusal('cabeçalho inválido');
    }
    headers[key] = value;
  }
  return headers;
}

/** O corpo em bytes, ou `null`. Base64 estrito: o `Buffer` aceitaria lixo em silêncio. */
function decodeBody(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    throw new Refusal('corpo não é base64');
  }
  return Buffer.from(raw, 'base64');
}

function pickTimeout(raw) {
  if (raw === undefined || raw === null) return DEFAULT_TIMEOUT_MS;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) throw new Refusal('prazo inválido');
  return Math.min(Math.ceil(raw), MAX_TIMEOUT_MS);
}

/**
 * O rótulo de um pedido no log: método e PRIMEIRO segmento do caminho, nada
 * além. `/devices/?query={"_id":"ZTEG1234..."}` vira `GET /devices` — a query
 * e os segmentos seguintes carregam número de série e id de cliente, que não
 * têm o que fazer num journal que o provedor copia para qualquer lugar.
 */
function routeLabel(method, path) {
  const first = path.split(/[?#]/, 1)[0].split('/')[1] ?? '';
  return `${method} /${/^[A-Za-z0-9_.-]{1,32}$/.test(first) ? first : '…'}`;
}

/* ------------------------------------------------------------------------ */
/* Sondagem do upgrade recusado                                             */
/* ------------------------------------------------------------------------ */

/**
 * O status HTTP de um upgrade que o `WebSocket` global recusou.
 *
 * O `WebSocket` do Node 22 (undici) não expõe o status de um upgrade recusado:
 * um 401 do painel, um 502 do proxy na frente dele e uma conexão recusada dão
 * TODOS o mesmo `error` ("Received network error or non-101 status code"), sem
 * código — e, no Node 22.22, nem chega `close` depois (a conexão fica em
 * CONNECTING para sempre). Mas "chave recusada" e "painel fora do ar" pedem
 * reações diferentes: a primeira não se resolve tentando de novo em 1 s.
 *
 * Então, quando o upgrade falha, o agente repete o MESMO handshake uma vez por
 * `node:http(s)` só para ler o status. Handshake completo (com
 * `Sec-WebSocket-Key`) de propósito: um handshake inválido poderia ser recusado
 * com 400 ANTES de o painel olhar o token, e aí nunca veríamos o 401. Se desta
 * vez o painel aceitar (101), o socket é fechado na hora — foi uma falha
 * passageira, e a reconexão normal cuida do resto.
 */
function probeUpgrade(connectUrl, token, signal) {
  return new Promise((resolve) => {
    const target = new URL(connectUrl.href);
    target.protocol = connectUrl.protocol === 'wss:' ? 'https:' : 'http:';
    const client = target.protocol === 'https:' ? https : http;
    let settled = false;
    let req = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      req?.destroy();
      resolve(result);
    };
    const onAbort = () => finish({ aborted: true });
    const timer = setTimeout(() => finish({ error: 'ETIMEDOUT' }), PROBE_TIMEOUT_MS);
    if (signal?.aborted) return finish({ aborted: true });
    signal?.addEventListener('abort', onAbort);
    try {
      req = client.request(target, {
        method: 'GET',
        agent: false,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          Authorization: `Bearer ${token}`
        }
      });
    } catch (error) {
      finish({ error: error.code || 'erro' });
      return;
    }
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      finish({ status: res.statusCode });
    });
    req.on('response', (res) => {
      res.resume();
      finish({ status: res.statusCode });
    });
    req.on('error', (error) => finish({ error: error.code || 'erro' }));
    req.end();
  });
}

/* ------------------------------------------------------------------------ */
/* O agente                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Liga o agente e devolve `{ stop }`.
 *
 * `WebSocketImpl`, `fetchImpl` e `maxResponseBytes` existem para os testes; na
 * instalação ficam os padrões. `backoff.resetAfterMs` é quanto tempo conectado
 * zera a espera de reconexão (60 s).
 *
 * Lança `AgentConfigError` (código `AGENT_CONFIG`) se a configuração não serve
 * — antes de abrir qualquer conexão.
 */
export function startAgent({
  panelUrl,
  token,
  genieacsUrl,
  logger = console,
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  version = AGENT_VERSION,
  backoff = { minMs: 1000, maxMs: 60000 },
  maxResponseBytes = MAX_RESPONSE_BYTES,
  silenceLimitMs = SILENCE_LIMIT_MS
} = {}) {
  const log = makeLog(logger);

  // --- configuração -------------------------------------------------------
  const panel = parseHttpUrl(panelUrl, 'PANEL_URL');
  if (panel.protocol === 'http:' && !isLocalHost(panel.hostname)) {
    log.warn(`PANEL_URL usa http:// para um host que não é local (${panel.host}): a chave do agente e os pedidos à NBI trafegam sem criptografia. Use https://.`);
  }
  const connectUrl = connectUrlFor(panel);

  const acs = parseHttpUrl(genieacsUrl, 'GENIEACS_URL');
  // Só a origem: os caminhos vêm do painel relativos à raiz da NBI, como no
  // modo direto (`DirectConnector.rootUrl`). Um caminho em GENIEACS_URL não
  // seria prefixo de nada — avisar é melhor que fingir que é.
  if (acs.pathname !== '/' || acs.search || acs.hash) {
    log.warn(`GENIEACS_URL: só a origem (${acs.origin}) é usada; o caminho e a query foram ignorados.`);
  }
  const genieacsOrigin = acs.origin;

  const secret = typeof token === 'string' ? token.trim() : '';
  if (!secret) throw new AgentConfigError('AGENT_TOKEN está vazio.');
  // Espaço ou controle no token viraria outro cabeçalho (ou um inválido) no
  // upgrade. Aspas e CRLF de arquivo editado no Windows já saíram no `trim`.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(secret)) throw new AgentConfigError('AGENT_TOKEN tem espaço ou caractere de controle.');
  if (!/^sgpa_[A-Za-z0-9_-]{43}$/.test(secret)) {
    log.warn('AGENT_TOKEN não tem o formato esperado (sgpa_ + 43 caracteres); confira se foi copiado inteiro.');
  }

  if (typeof WebSocketImpl !== 'function') throw new AgentConfigError('WebSocket indisponível: é preciso Node 22 ou mais novo.');
  if (typeof fetchImpl !== 'function') throw new AgentConfigError('fetch indisponível: é preciso Node 22 ou mais novo.');

  const minMs = Math.max(1, Number(backoff?.minMs ?? 1000));
  const maxMs = Math.max(minMs, Number(backoff?.maxMs ?? 60000));
  const resetAfterMs = Math.max(0, Number(backoff?.resetAfterMs ?? 60000));

  // --- estado -------------------------------------------------------------
  let stopped = false;
  let current = null; // a tentativa/conexão viva (uma por vez)
  let reconnectTimer = null;
  let failures = 0; // tentativas seguidas sem ficar `resetAfterMs` conectado
  let keyRefused = false; // 4001 ou 401: espera máxima até uma conexão abrir
  const probeAbort = new AbortController();
  const queue = [];
  let running = 0;
  const stats = newStats();

  const statsTimer = setInterval(() => flushStats(false), STATS_INTERVAL_MS);
  statsTimer.unref?.();

  log.info(`agente ${version} iniciado; painel ${panel.origin}, GenieACS ${genieacsOrigin}`);
  connect();

  // --- conexão ------------------------------------------------------------

  function connect() {
    reconnectTimer = null;
    if (stopped) return;
    const conn = {
      ws: null,
      opened: false,
      openedAt: 0,
      settled: false,
      jobs: new Set(),
      handshakeTimer: null,
      errorTimer: null,
      silenceTimer: null,
      lastMessageAt: 0,
      closeWaiters: []
    };
    current = conn;
    try {
      conn.ws = new WebSocketImpl(connectUrl.href, { headers: { Authorization: `Bearer ${secret}` } });
    } catch (error) {
      // Construtor que lança é configuração/ambiente, não painel: nada a sondar.
      log.error(`não foi possível abrir a conexão com o painel: ${error?.message ?? error}`);
      settle(conn, { kind: 'constructor' });
      return;
    }

    conn.handshakeTimer = setTimeout(() => {
      if (conn.opened || conn.settled) return;
      log.warn(`o painel não completou a conexão em ${HANDSHAKE_TIMEOUT_MS / 1000} s`);
      try { conn.ws.close(); } catch { /* já fechando */ }
      settle(conn, { kind: 'handshake_timeout' });
    }, HANDSHAKE_TIMEOUT_MS);

    conn.ws.addEventListener('open', () => {
      if (conn.settled || stopped) return;
      conn.opened = true;
      conn.openedAt = Date.now();
      clearTimeout(conn.handshakeTimer);
      conn.lastMessageAt = Date.now();
      conn.silenceTimer = setInterval(() => {
        const silencio = Date.now() - conn.lastMessageAt;
        if (silencio <= silenceLimitMs) return;
        log.warn(`o painel está em silêncio há ${Math.round(silencio / 1000)} s; reconectando`);
        try { conn.ws.close(); } catch { /* já fechando */ }
        settle(conn, { kind: 'closed', code: 1006, reason: 'silêncio do painel' });
      }, Math.max(10, Math.min(15_000, Math.floor(silenceLimitMs / 3))));
      conn.silenceTimer.unref?.();
      if (keyRefused) log.info('a chave voltou a ser aceita pelo painel');
      keyRefused = false;
      log.info(`conectado ao painel ${panel.origin}`);
      sendTo(conn, { type: 'hello', version });
    });

    conn.ws.addEventListener('message', (event) => onMessage(conn, event));

    conn.ws.addEventListener('error', () => {
      // Antes de abrir, `error` É o fim da tentativa: no Node 22 o `close`
      // não vem depois de um upgrade recusado (veja `probeUpgrade`). Depois
      // de aberta, o `close` vem em seguida e traz o código; o prazo abaixo
      // é só para uma implementação que não o mande.
      if (!conn.opened) {
        settle(conn, { kind: 'upgrade_failed' });
      } else if (!conn.errorTimer) {
        conn.errorTimer = setTimeout(() => settle(conn, { kind: 'closed', code: 1006, reason: '' }), 5000);
        conn.errorTimer.unref?.();
      }
    });

    conn.ws.addEventListener('close', (event) => {
      settle(conn, { kind: conn.opened ? 'closed' : 'upgrade_failed', code: event?.code, reason: event?.reason });
    });
  }

  /**
   * O fim de uma tentativa ou conexão — uma vez só, venha de `error`, `close`,
   * prazo ou `stop()` (as implementações de `WebSocket` diferem em quais desses
   * eventos mandam, e em que ordem).
   */
  function settle(conn, outcome) {
    if (conn.settled) return;
    conn.settled = true;
    clearTimeout(conn.handshakeTimer);
    clearTimeout(conn.errorTimer);
    clearInterval(conn.silenceTimer);
    if (current === conn) current = null;
    // Os pedidos desta conexão não têm mais para onde responder: o painel já
    // os deu como perdidos quando ela caiu. Abortá-los libera as vagas e o
    // GenieACS; os da fila nem chegam a sair.
    for (const job of [...conn.jobs]) cancelJob(job, 'disconnected');
    for (const resolve of conn.closeWaiters) resolve();
    conn.closeWaiters = [];
    if (stopped) return;

    if (outcome.kind === 'closed') {
      const connectedFor = Date.now() - conn.openedAt;
      if (connectedFor >= resetAfterMs) failures = 0;
      const reason = cleanReason(outcome.reason);
      log.warn(`desconectado do painel (código ${outcome.code ?? '?'}${reason ? `: ${reason}` : ''})`);
      if (outcome.code === CLOSE_REVOKED) {
        keyRefused = true;
        log.error('chave revogada: outra chave foi gerada no painel. Atualize AGENT_TOKEN no arquivo de ambiente e reinicie o serviço.');
      } else if (outcome.code === CLOSE_REPLACED) {
        log.warn('conexão substituída por outra com a mesma chave — há outro agente rodando com ela?');
      } else if (outcome.code === CLOSE_MODE_CHANGED) {
        log.warn('o provedor deixou de usar o modo agente no painel');
      }
      scheduleReconnect();
      return;
    }

    if (outcome.kind === 'upgrade_failed' || outcome.kind === 'handshake_timeout') {
      diagnoseAndReconnect();
      return;
    }
    scheduleReconnect();
  }

  /** Descobre por que o upgrade falhou (`probeUpgrade`) e agenda a próxima tentativa conforme. */
  async function diagnoseAndReconnect() {
    const result = await probeUpgrade(connectUrl, secret, probeAbort.signal);
    if (stopped || result.aborted) return;
    if (result.status === 401) {
      keyRefused = true;
      log.error('chave recusada pelo painel (HTTP 401). Confira AGENT_TOKEN no arquivo de ambiente — se outra chave foi gerada, use a nova e reinicie o serviço.');
    } else if (result.status === 101) {
      log.warn('a conexão com o painel falhou, mas uma nova tentativa foi aceita; reconectando');
    } else if (result.status) {
      log.warn(`o painel recusou a conexão (HTTP ${result.status})`);
    } else {
      log.warn(`painel inalcançável (${result.error})`);
    }
    scheduleReconnect();
  }

  /**
   * Próxima tentativa: 1 s, 2 s, 4 s… até 60 s, com ±20% de variação para que
   * os agentes de vários provedores não voltem todos no mesmo segundo depois
   * de uma queda do painel. Com a chave recusada, sempre a espera máxima: a
   * chave não vai mudar sozinha, e o operador que a trocar reinicia o serviço.
   */
  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const base = keyRefused ? maxMs : Math.min(maxMs, minMs * 2 ** failures);
    failures = Math.min(failures + 1, 30);
    const delay = Math.max(1, Math.round(base * (0.8 + 0.4 * Math.random())));
    log.info(`reconectando em ${(delay / 1000).toFixed(1)} s`);
    reconnectTimer = setTimeout(connect, delay);
  }

  function sendTo(conn, message) {
    if (conn !== current || !conn.opened || conn.ws.readyState !== OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  // --- mensagens ----------------------------------------------------------

  function onMessage(conn, event) {
    if (conn !== current || stopped) return;
    conn.lastMessageAt = Date.now();
    // Frame binário, JSON inválido, pedido sem id: o painel não fala assim.
    // Não há para quem responder (sem id) — conta e segue; a contagem aparece
    // no resumo do minuto.
    if (typeof event?.data !== 'string') {
      stats.malformed += 1;
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      stats.malformed += 1;
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      stats.malformed += 1;
      return;
    }
    // O batimento do painel: já valeu por ter chegado (`lastMessageAt`).
    if (message.type === 'ping') return;
    if (message.type !== 'request') {
      // Tipo desconhecido: talvez um painel mais novo. Ignorar (e contar) é o
      // que permite ao protocolo crescer sem quebrar agentes instalados.
      stats.ignored += 1;
      return;
    }
    if (typeof message.id !== 'string' || !message.id || message.id.length > MAX_ID_LENGTH) {
      stats.malformed += 1;
      return;
    }
    acceptRequest(conn, message);
  }

  function acceptRequest(conn, message) {
    const { id } = message;
    let job;
    try {
      if (typeof message.method !== 'string' || !METHODS.has(message.method)) throw new Refusal('método não permitido');
      const url = resolveNbiUrl(message.path, genieacsOrigin);
      const headers = pickHeaders(message.headers);
      const body = decodeBody(message.body);
      if (body && message.method === 'GET') throw new Refusal('GET com corpo');
      const timeoutMs = pickTimeout(message.timeoutMs);
      if (queue.length >= MAX_QUEUE) throw new Refusal('fila do agente cheia');
      job = {
        id,
        conn,
        method: message.method,
        url,
        headers,
        body,
        timeoutMs,
        label: routeLabel(message.method, message.path),
        controller: new AbortController(),
        abortReason: null,
        queued: true,
        done: false,
        timer: null
      };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      count(stats.refused, error.message);
      sendTo(conn, { type: 'error', id, code: 'bad_request', message: `recusado pelo agente: ${error.message}` });
      return;
    }

    // O prazo corre desde a chegada, fila incluída: o relógio do painel já
    // está correndo, e responder depois que ele desistiu é trabalho perdido.
    // A mensagem diz se o prazo acabou na fila ou no GenieACS, que são
    // problemas diferentes para quem lê.
    job.timer = setTimeout(() => {
      if (job.done) return;
      if (job.queued) {
        removeFromQueue(job);
        finishJob(job, { type: 'error', id, code: 'timeout', message: 'prazo esgotado na fila do agente' }, 'timeout');
      } else {
        job.abortReason = 'timeout';
        job.controller.abort();
      }
    }, job.timeoutMs);

    conn.jobs.add(job);
    queue.push(job);
    pump();
  }

  function pump() {
    while (running < MAX_CONCURRENCY && queue.length > 0) {
      const job = queue.shift();
      job.queued = false;
      running += 1;
      execute(job)
        .catch(() => fail(job, null))
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  async function execute(job) {
    const { controller } = job;
    let response;
    try {
      response = await fetchImpl(job.url, {
        method: job.method,
        headers: job.headers,
        body: job.body ?? undefined,
        // Nunca seguir 3xx: o `Location` escolheria o host, e o host é a única
        // coisa que o agente não deixa ninguém escolher. O 3xx volta ao painel.
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (error) {
      fail(job, error);
      return;
    }
    if (job.done) {
      cancelBody(response);
      return;
    }

    // O `Content-Length` já declara o excesso? Nem começa a ler.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      job.abortReason = 'too_large';
      controller.abort();
      cancelBody(response);
      finishJob(job, tooLarge(job), 'tooLarge');
      return;
    }

    // Em streaming, contando: sem `Content-Length` (resposta chunked) a única
    // forma de saber o tamanho é ler — e ler TUDO antes de medir é exatamente
    // o estouro de memória que o teto existe para evitar.
    const chunks = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxResponseBytes) {
            job.abortReason = 'too_large';
            controller.abort();
            reader.cancel().catch(() => {});
            chunks.length = 0;
            finishJob(job, tooLarge(job), 'tooLarge');
            return;
          }
          chunks.push(value);
        }
      } catch (error) {
        fail(job, error);
        return;
      }
    }

    const headers = {};
    for (const [name, value] of response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
    }
    const body = total > 0 ? Buffer.concat(chunks, total).toString('base64') : null;
    finishJob(job, { type: 'response', id: job.id, status: response.status, headers, body }, 'served');
  }

  /** Traduz a falha de um pedido para o código do contrato — ou silêncio, se ninguém espera mais. */
  function fail(job, error) {
    if (job.done) return;
    if (job.abortReason === 'timeout') {
      finishJob(job, { type: 'error', id: job.id, code: 'timeout', message: 'o GenieACS local não respondeu no prazo' }, 'timeout');
      return;
    }
    if (job.abortReason === 'too_large') {
      finishJob(job, tooLarge(job), 'tooLarge');
      return;
    }
    // Conexão recusada, DNS, reset no meio do corpo, TLS: tudo é "o GenieACS
    // local não atendeu". O código do erro de rede vai na mensagem ao painel
    // (ajuda o suporte); o log fica só com a contagem.
    const cause = error?.cause?.code || error?.code || error?.cause?.errors?.[0]?.code;
    finishJob(job, {
      type: 'error',
      id: job.id,
      code: 'upstream_unreachable',
      message: `o GenieACS local não respondeu${cause ? ` (${cause})` : ''}`
    }, 'unreachable');
  }

  function tooLarge(job) {
    return {
      type: 'error',
      id: job.id,
      code: 'too_large',
      message: `resposta do GenieACS acima de ${Math.floor(maxResponseBytes / (1024 * 1024))} MiB`
    };
  }

  function finishJob(job, message, outcome) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    job.conn.jobs.delete(job);
    if (outcome === 'served') count(stats.served, job.label);
    else stats[outcome] += 1;
    sendTo(job.conn, message);
  }

  /** Encerra um pedido sem responder (a conexão dele caiu ou o agente está parando). */
  function cancelJob(job, reason) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    job.conn.jobs.delete(job);
    job.abortReason = reason;
    removeFromQueue(job);
    job.controller.abort();
  }

  function removeFromQueue(job) {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  }

  // --- log ----------------------------------------------------------------

  /**
   * O resumo do minuto. Só contagens e rótulos de `routeLabel` — nunca
   * caminho completo, corpo ou cabeçalho. Minuto sem nada não gera linha.
   */
  function flushStats(final) {
    const parts = [];
    const served = sum(stats.served);
    if (served) parts.push(`${served} atendido(s) [${describe(stats.served)}]`);
    const refused = sum(stats.refused);
    if (refused) parts.push(`${refused} recusado(s) [${describe(stats.refused)}]`);
    if (stats.timeout) parts.push(`${stats.timeout} com prazo esgotado`);
    if (stats.unreachable) parts.push(`${stats.unreachable} com GenieACS inalcançável`);
    if (stats.tooLarge) parts.push(`${stats.tooLarge} com resposta grande demais`);
    if (stats.malformed) parts.push(`${stats.malformed} mensagem(ns) malformada(s) ignorada(s)`);
    if (stats.ignored) parts.push(`${stats.ignored} mensagem(ns) de tipo desconhecido ignorada(s)`);
    if (parts.length) log.info(`${final ? 'desde o último resumo' : 'último minuto'}: ${parts.join('; ')}`);
    Object.assign(stats, newStats());
  }

  // --- parada -------------------------------------------------------------

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearInterval(statsTimer);
    probeAbort.abort();
    for (const job of [...queue]) cancelJob(job, 'stopped');
    const conn = current;
    if (conn) {
      for (const job of [...conn.jobs]) cancelJob(job, 'stopped');
      if (conn.opened && !conn.settled) {
        const closed = new Promise((resolve) => conn.closeWaiters.push(resolve));
        try { conn.ws.close(1000, 'agente encerrando'); } catch { /* já fechando */ }
        // Um painel que não devolve o fechamento não segura o desligamento.
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000).unref?.())]);
      } else {
        try { conn.ws?.close(); } catch { /* ainda conectando */ }
      }
      settle(conn, { kind: 'stopped' });
    }
    flushStats(true);
    log.info('agente encerrado');
  }

  return { stop };
}

function newStats() {
  return { served: new Map(), refused: new Map(), timeout: 0, unreachable: 0, tooLarge: 0, malformed: 0, ignored: 0 };
}

/** Conta sob um rótulo, com teto de rótulos distintos (um painel hostil não enche a memória de chaves). */
function count(map, key) {
  if (!map.has(key) && map.size >= 32) key = 'outros';
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sum(map) {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function describe(map) {
  return [...map].map(([key, value]) => `${key} ×${value}`).join(', ');
}

function cancelBody(response) {
  try { response?.body?.cancel().catch(() => {}); } catch { /* sem corpo */ }
}

/** O motivo de fechamento do painel, curto e sem controle, para caber numa linha do journal. */
function cleanReason(reason) {
  // eslint-disable-next-line no-control-regex
  return typeof reason === 'string' ? reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '';
}

/** `logger.info/warn/error` com prefixo; aceita um logger que só tenha `log`. */
function makeLog(logger) {
  const pick = (level) => {
    const fn = logger?.[level] ?? logger?.log;
    return typeof fn === 'function' ? (message) => fn.call(logger, `[skygenpanel-agent] ${message}`) : () => {};
  };
  return { info: pick('info'), warn: pick('warn'), error: pick('error') };
}

/* ------------------------------------------------------------------------ */
/* Ponto de entrada                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Este arquivo é o programa que o Node executou? (E não um `import` dos
 * testes.) `realpath` porque o instalador pode apontar um link simbólico para
 * cá, e o Node resolve o link no `import.meta.url` mas não no `argv`.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

function main() {
  const prefix = '[skygenpanel-agent]';
  if (process.argv.length > 2) {
    // Não repetimos os argumentos: se alguém passou o token por aqui, ele não
    // precisa ir também para o journal.
    console.warn(`${prefix} ${process.argv.length - 2} argumento(s) de linha de comando ignorado(s): a configuração vem só do ambiente (PANEL_URL, AGENT_TOKEN, GENIEACS_URL). Nunca passe a chave na linha de comando — ela fica visível para qualquer usuário da máquina.`);
  }
  if (typeof globalThis.WebSocket !== 'function' || typeof globalThis.fetch !== 'function') {
    console.error(`${prefix} este agente precisa do Node 22 ou mais novo (encontrado ${process.version}).`);
    process.exit(2);
  }
  const missing = ['PANEL_URL', 'AGENT_TOKEN', 'GENIEACS_URL'].filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    console.error(`${prefix} faltando no ambiente: ${missing.join(', ')}. Configure no arquivo de ambiente do serviço (ex.: /etc/skygenpanel-agent.env, permissão 0600).`);
    process.exit(2);
  }

  let agent;
  try {
    agent = startAgent({
      panelUrl: process.env.PANEL_URL,
      token: process.env.AGENT_TOKEN,
      genieacsUrl: process.env.GENIEACS_URL
    });
  } catch (error) {
    if (error?.code === 'AGENT_CONFIG') {
      console.error(`${prefix} ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.info(`${prefix} ${signal} recebido; encerrando`);
    agent.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (isEntryPoint()) main();
