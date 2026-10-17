import crypto from 'node:crypto';
import proxyaddr from 'proxy-addr';
import { WebSocket, WebSocketServer } from 'ws';
import { TRUST_PROXY } from '../../config/proxy.js';
import { TranslatableError } from '../../i18n/index.js';
import GenieAcsConnection, { sanitizeAgentVersion } from '../../models/GenieAcsConnection.js';
import Tenant from '../../models/Tenant.js';

/**
 * O lado do painel do modo `agent`: onde as conexões dos agentes chegam e por
 * onde os pedidos à NBI descem até eles.
 *
 * O agente é um programa na rede do provedor que abre um WebSocket de SAÍDA
 * para `/api/genieacs-agent/connect` e fica esperando. Quando o painel precisa
 * falar com a NBI daquele provedor, `request()` manda o pedido pela conexão, o
 * agente chama o GenieACS local e devolve a resposta. Nenhuma porta é aberta
 * na rede do provedor, que é o ponto do modo inteiro. O protocolo está no
 * contrato da frente 4b; aqui ele é implementado do lado de cá.
 *
 * ## Quem é o agente
 *
 * O provedor sai da CHAVE (`Authorization: Bearer sgpa_…`), nunca do host: o
 * upgrade não passa pelo resolvedor de provedor, e um agente que dissesse "sou
 * o alfa" pelo host estaria pedindo para receber os pedidos do alfa. A chave é
 * guardada só como sha256 (`agent_token_hash`, único), a busca por ela é a
 * única leitura sem provedor deste arquivo (`findByAgentTokenHash`), e além da
 * chave conferir o provedor tem que estar ativo e em modo `agent`. Recusa é
 * `401` no próprio socket; falha demais do mesmo IP vira `429` por um tempo.
 * A chave não vai para log, trilha nem mensagem de erro — nem a errada.
 *
 * ## Uma conexão por provedor
 *
 * A nova substitui a antiga (fechamento `4002`): dois agentes do mesmo
 * provedor ligados ao mesmo tempo é quase sempre o velho que ninguém desligou,
 * e o mais novo é o que o operador acabou de instalar. Gerar outra chave
 * derruba a conexão com `4001`, e o modo deixar de ser `agent` com `4003`.
 *
 * ## LIMITAÇÃO: a conexão vive NESTE processo
 *
 * O mapa de conexões é memória do processo. Com mais de uma réplica do painel
 * atrás de um balanceador, o agente estaria ligado a uma delas e o pedido do
 * operador poderia cair em outra, que responderia "agente desconectado" com o
 * agente de pé. Rodar várias réplicas exige rotear por provedor (afinidade do
 * agente e das requisições daquele provedor para a mesma réplica) ou um
 * barramento entre elas — nenhum dos dois existe hoje, e a instalação de uma
 * réplica, que é a de todo mundo, não precisa.
 */

export const AGENT_CONNECT_PATH = '/api/genieacs-agent/connect';

/** O teto de um frame, dos dois lados: 64 MiB (o agente corta o corpo em 48 MiB, antes do base64). */
export const AGENT_MAX_PAYLOAD = 64 * 1024 * 1024;

/** Os fechamentos que o painel faz, com o que cada um quer dizer ao agente. */
export const AGENT_CLOSE = Object.freeze({
  TOKEN_REVOKED: 4001,
  REPLACED: 4002,
  MODE_CHANGED: 4003
});

export const AGENT_OFFLINE_CODE = 'acs_agent_offline';

const PING_INTERVAL_MS = 30_000;
const PONG_DEADLINE_MS = 75_000;
/** `agent_last_seen_at` no pong é gravado no máximo uma vez por este intervalo. */
const SEEN_WRITE_EVERY_MS = 60_000;

/** O limitador de força bruta: tantas falhas por IP, nesta janela, e depois 429. */
const FAIL_LIMIT = 20;
const FAIL_WINDOW_MS = 15 * 60_000;
/** Acima disto o mapa de falhas é podado dos que já expiraram, para não crescer sem fim. */
const FAIL_MAP_PRUNE_AT = 10_000;

/** A forma da chave: `sgpa_` e o base64url de 32 bytes. Nada mais chega ao banco. */
const TOKEN_SHAPE = /^sgpa_[A-Za-z0-9_-]{43}$/;

const METODOS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const PEDIDO_TIMEOUT_PADRAO_MS = 15_000;

/** O sha256 hex de uma chave — a única forma em que ela é guardada. */
export function hashAgentToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * O agente do provedor não está conectado. 503 com `code` próprio, que as
 * rotas que falam com o ACS devolvem como estão (ver `acsAgentOfflineBody`).
 * `lastSeenAt` é quando o painel o viu pela última vez, ou nulo.
 */
export class AgentOfflineError extends TranslatableError {
  constructor(lastSeenAt = null) {
    super('device.acsAgentOffline', null, { status: 503, code: AGENT_OFFLINE_CODE });
    this.name = 'AgentOfflineError';
    this.lastSeenAt = lastSeenAt ?? null;
  }
}

/**
 * O pedido chegou ao agente e não voltou resposta útil: o agente recusou, não
 * alcançou o GenieACS local, passou do prazo ou o corpo passou do teto.
 * `agentCode` é o código do protocolo (`bad_request`, `upstream_unreachable`,
 * `timeout`, `too_large`); o prazo estourado do lado de cá também é
 * `timeout`. O nome `TimeoutError` nos dois prazos é o que os chamadores que
 * já distinguem "o ACS não respondeu" reconhecem.
 */
export class AgentRequestError extends Error {
  constructor(agentCode, message) {
    super(message);
    this.name = agentCode === 'timeout' ? 'TimeoutError' : 'AgentRequestError';
    this.code = `acs_agent_${agentCode}`;
    this.agentCode = agentCode;
  }
}

const CODIGOS_DO_AGENTE = new Set(['bad_request', 'upstream_unreachable', 'timeout', 'too_large']);

/**
 * `trust proxy` compilado como o Express compila (`TRUST_PROXY`): o IP que o
 * limitador conta tem que ser o mesmo que o resto do painel conta. Atrás de um
 * proxy reverso, contar o endereço do socket poria todos os agentes no MESMO
 * balde — e 20 chaves erradas de qualquer um trancariam os agentes de todos.
 */
function compilarConfianca(valor) {
  if (valor === null || valor === undefined) return () => false;
  if (valor === true) return () => true;
  if (typeof valor === 'number') return (_endereco, i) => i < valor;
  return proxyaddr.compile(String(valor).split(',').map((parte) => parte.trim()).filter(Boolean));
}
const confia = compilarConfianca(TRUST_PROXY);

function ipDe(req) {
  try {
    return proxyaddr(req, confia) || req.socket?.remoteAddress || 'desconhecido';
  } catch {
    return req.socket?.remoteAddress || 'desconhecido';
  }
}

/** A chave do cabeçalho, ou nulo. Só a forma é conferida aqui; o resto é do banco. */
function chaveDoCabecalho(req) {
  const bruto = String(req.headers?.authorization ?? '');
  const casou = /^Bearer\s+(\S+)$/i.exec(bruto.trim());
  if (!casou) return null;
  return TOKEN_SHAPE.test(casou[1]) ? casou[1] : null;
}

/** Recusa o upgrade com uma resposta HTTP curta, no próprio socket, e fecha. */
function recusar(socket, status, texto) {
  if (socket.destroyed) return;
  // `destroy` só depois de a resposta sair: destruído logo em seguida ao
  // `end`, o socket pode ir embora com a resposta ainda na fila, e o agente
  // leria "conexão caiu" em vez de "401".
  const destruir = () => socket.destroy();
  setTimeout(destruir, 2_000).unref();
  try {
    socket.end(
      `HTTP/1.1 ${status} ${texto}\r\nConnection: close\r\nContent-Type: text/plain\r\n`
      + `Content-Length: ${Buffer.byteLength(texto)}\r\n\r\n${texto}`,
      destruir
    );
  } catch {
    destruir();
  }
}

/** Cabeçalhos de resposta vindos do agente, só os que são pares texto→texto. */
function cabecalhosValidos(bruto) {
  if (bruto === undefined || bruto === null) return {};
  if (typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const saida = {};
  for (const [nome, valor] of Object.entries(bruto)) {
    if (typeof valor !== 'string') return null;
    saida[nome] = valor;
  }
  return saida;
}

class AgentHub {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: AGENT_MAX_PAYLOAD, clientTracking: false });
    /** provedor → conexão viva. */
    this.conexoes = new Map();
    /**
     * provedor → quantas vezes a conexão dele foi derrubada por `disconnect`.
     * Um agente que se autenticou com a chave velha e só termina o upgrade
     * DEPOIS de a chave nova ser gerada seria adotado com a chave já
     * revogada; conferir a geração antes de adotar fecha essa janela.
     */
    this.geracoes = new Map();
    /** IP → `{ count, resetAt }` das falhas de autenticação. */
    this.falhas = new Map();
    this.servidores = new WeakSet();
    this.timer = null;
    this.sequencia = 0;
    this.descartados = 0;
    this.pingIntervalMs = PING_INTERVAL_MS;
    this.pongDeadlineMs = PONG_DEADLINE_MS;
  }

  /** Passa a atender o upgrade do agente neste servidor HTTP. Idempotente. */
  attach(httpServer) {
    if (this.servidores.has(httpServer)) return this;
    this.servidores.add(httpServer);
    httpServer.on('upgrade', (req, socket, head) => {
      this.onUpgrade(req, socket, head).catch((error) => {
        console.error(`[genieacs-agent] upgrade falhou: ${error?.message || error}`);
        recusar(socket, 503, 'Service Unavailable');
      });
    });
    return this;
  }

  async onUpgrade(req, socket, head) {
    // Sem isto, um agente que desiste no meio da autenticação vira um `error`
    // sem ouvinte — que derruba o processo.
    socket.on('error', () => {});
    let caminho = '';
    try {
      caminho = new URL(req.url, 'http://painel').pathname;
    } catch {
      caminho = '';
    }
    // O painel não atende nenhum outro upgrade: qualquer coisa fora do caminho
    // do agente é um socket que ninguém vai ler, e fica aberto até alguém
    // fechá-lo. Fechamos nós.
    if (caminho !== AGENT_CONNECT_PATH) {
      socket.destroy();
      return;
    }

    const ip = ipDe(req);
    if (this.bloqueado(ip)) {
      recusar(socket, 429, 'Too Many Requests');
      return;
    }

    const token = chaveDoCabecalho(req);
    const dono = token ? await this.autenticar(token) : null;
    if (!dono) {
      this.registrarFalha(ip);
      recusar(socket, 401, 'Unauthorized');
      return;
    }
    if (socket.destroyed) return;

    const geracao = this.geracoes.get(dono.tenantId) ?? 0;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if ((this.geracoes.get(dono.tenantId) ?? 0) !== geracao) {
        // A chave foi trocada (ou o modo mudou) enquanto este upgrade terminava.
        ws.close(AGENT_CLOSE.TOKEN_REVOKED, 'token revoked');
        return;
      }
      this.adotar(dono.tenantId, ws);
    });
  }

  /**
   * O provedor dono da chave, ou nulo. Nulo também quando o provedor não está
   * ativo ou não está em modo `agent`: uma chave que sobrou de quando ele era
   * agente não pode continuar abrindo conexão depois de ele voltar ao direto.
   */
  async autenticar(token) {
    const hash = hashAgentToken(token);
    const linha = await GenieAcsConnection.findByAgentTokenHash(hash);
    if (!linha?.hash) return null;
    // A busca foi por igualdade no banco; a conferência em tempo constante é a
    // que decide, para que nenhum caminho de código compare o digest byte a
    // byte com saída antecipada.
    const guardado = Buffer.from(String(linha.hash), 'hex');
    const recebido = Buffer.from(hash, 'hex');
    if (guardado.length !== recebido.length || !crypto.timingSafeEqual(guardado, recebido)) return null;
    if (linha.mode !== 'agent') return null;
    const tenant = await Tenant.findById(linha.tenantId);
    if (!tenant || tenant.status !== 'active') return null;
    return { tenantId: Number(linha.tenantId) };
  }

  bloqueado(ip) {
    const entrada = this.falhas.get(ip);
    if (!entrada) return false;
    if (entrada.resetAt <= Date.now()) {
      this.falhas.delete(ip);
      return false;
    }
    return entrada.count >= FAIL_LIMIT;
  }

  registrarFalha(ip) {
    const agora = Date.now();
    if (this.falhas.size >= FAIL_MAP_PRUNE_AT) {
      for (const [chave, entrada] of this.falhas) {
        if (entrada.resetAt <= agora) this.falhas.delete(chave);
      }
    }
    const entrada = this.falhas.get(ip);
    if (!entrada || entrada.resetAt <= agora) {
      this.falhas.set(ip, { count: 1, resetAt: agora + FAIL_WINDOW_MS });
    } else {
      entrada.count += 1;
    }
  }

  /** Para os testes: esquece as falhas contadas. */
  forgetFailures() {
    this.falhas.clear();
  }

  adotar(tenantId, ws) {
    const anterior = this.conexoes.get(tenantId);
    const conexao = {
      tenantId,
      ws,
      pendentes: new Map(),
      ultimoPong: Date.now(),
      conectadaEm: new Date(),
      ultimaGravacao: 0,
      version: null
    };
    this.conexoes.set(tenantId, conexao);
    if (anterior) this.encerrar(anterior, AGENT_CLOSE.REPLACED, 'replaced by a newer connection');

    ws.on('message', (dados, binario) => this.mensagem(conexao, dados, binario));
    ws.on('pong', () => {
      conexao.ultimoPong = Date.now();
      this.visto(conexao);
    });
    // `maxPayload` estourado, frame inválido: o `ws` emite `error` e fecha. O
    // ouvinte existe para que isso não vire exceção sem dono no processo.
    ws.on('error', (error) => {
      this.descartar(conexao, `erro do socket (${error?.code || 'desconhecido'})`);
    });
    ws.on('close', () => this.fechou(conexao));
    this.armarTimer();
  }

  /** Grava `agent_last_seen_at`, no máximo uma vez por minuto (a não ser que `forcar`). */
  visto(conexao, { forcar = false, version } = {}) {
    const agora = Date.now();
    if (!forcar && agora - conexao.ultimaGravacao < SEEN_WRITE_EVERY_MS) return;
    conexao.ultimaGravacao = agora;
    GenieAcsConnection.touchAgent(conexao.tenantId, version === undefined ? {} : { version })
      .catch((error) => {
        console.warn(`[genieacs-agent] provedor ${conexao.tenantId}: não gravou o último contato (${error?.message || error})`);
      });
  }

  /** Um frame que não serve para nada: conta e registra, sem o corpo. */
  descartar(conexao, motivo) {
    this.descartados += 1;
    console.warn(`[genieacs-agent] provedor ${conexao.tenantId}: frame descartado (${motivo}); ${this.descartados} no total`);
  }

  mensagem(conexao, dados, binario) {
    if (binario) return this.descartar(conexao, 'binário');
    let msg;
    try {
      msg = JSON.parse(dados.toString('utf8'));
    } catch {
      return this.descartar(conexao, 'JSON inválido');
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.descartar(conexao, 'não é objeto');

    if (msg.type === 'hello') {
      conexao.version = sanitizeAgentVersion(msg.version);
      this.visto(conexao, { forcar: true, version: conexao.version });
      return undefined;
    }
    if (msg.type !== 'response' && msg.type !== 'error') return this.descartar(conexao, 'tipo desconhecido');

    const pendente = typeof msg.id === 'string' ? conexao.pendentes.get(msg.id) : undefined;
    if (!pendente) return this.descartar(conexao, 'id desconhecido');

    if (msg.type === 'error') {
      const codigo = CODIGOS_DO_AGENTE.has(msg.code) ? msg.code : 'bad_request';
      return pendente.falhar(new AgentRequestError(codigo, `GenieACS agent answered ${codigo}`));
    }

    const status = Number(msg.status);
    const headers = cabecalhosValidos(msg.headers);
    // Malformada, mas com o id de um pedido que espera: o pedido falha AGORA.
    // Ignorar o frame (como se faz com um id desconhecido) deixaria o operador
    // esperando o prazo inteiro por uma resposta que já chegou — quebrada.
    if (!Number.isInteger(status) || status < 100 || status > 599 || headers === null) {
      this.descartar(conexao, 'resposta malformada');
      return pendente.falhar(new AgentRequestError('bad_request', 'GenieACS agent sent a malformed response'));
    }
    let body = Buffer.alloc(0);
    if (msg.body !== null && msg.body !== undefined) {
      if (typeof msg.body !== 'string') {
        this.descartar(conexao, 'corpo malformado');
        return pendente.falhar(new AgentRequestError('bad_request', 'GenieACS agent sent a malformed body'));
      }
      body = Buffer.from(msg.body, 'base64');
    }
    return pendente.cumprir({ status, headers, body });
  }

  fechou(conexao) {
    if (conexao.fechada) return;
    conexao.fechada = true;
    if (this.conexoes.get(conexao.tenantId) === conexao) this.conexoes.delete(conexao.tenantId);
    this.rejeitarPendentes(conexao, () => new AgentOfflineError(new Date()));
    this.visto(conexao, { forcar: true });
    if (this.conexoes.size === 0) this.desarmarTimer();
  }

  rejeitarPendentes(conexao, erro) {
    for (const pendente of [...conexao.pendentes.values()]) pendente.falhar(erro());
  }

  /** Fecha uma conexão com código e motivo, e já rejeita o que esperava por ela. */
  encerrar(conexao, code, reason) {
    this.rejeitarPendentes(conexao, () => new AgentOfflineError(new Date()));
    try {
      conexao.ws.close(code, reason);
    } catch {
      conexao.ws.terminate();
    }
    // Um agente que não responde ao fechamento não segura o socket para sempre.
    setTimeout(() => {
      if (conexao.ws.readyState !== WebSocket.CLOSED) conexao.ws.terminate();
    }, 5_000).unref();
  }

  armarTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.batimento(), this.pingIntervalMs);
    this.timer.unref();
  }

  desarmarTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** O ping de protocolo, e a queda de quem não respondeu ao último a tempo. */
  batimento() {
    const agora = Date.now();
    for (const conexao of [...this.conexoes.values()]) {
      if (agora - conexao.ultimoPong > this.pongDeadlineMs) {
        conexao.ws.terminate();
        continue;
      }
      try {
        conexao.ws.ping();
        // O mesmo batimento, como MENSAGEM: o `WebSocket` do Node (o do agente)
        // responde ao ping de protocolo mas não o mostra a quem o usa, e é por
        // esta que o agente percebe uma conexão meio aberta e reconecta.
        conexao.ws.send('{"type":"ping"}');
      } catch {
        conexao.ws.terminate();
      }
    }
  }

  /**
   * Desde quando a conexão ATUAL do provedor está aberta, ou nulo. É estado do
   * processo, como `isConnected`: o `agent_last_seen_at` do banco anda a cada
   * pong e não serve para dizer "conectado desde".
   */
  connectedSince(tenantId) {
    if (!this.isConnected(tenantId)) return null;
    return this.conexoes.get(Number(tenantId)).conectadaEm;
  }

  isConnected(tenantId) {
    const conexao = this.conexoes.get(Number(tenantId));
    return Boolean(conexao && conexao.ws.readyState === WebSocket.OPEN);
  }

  /**
   * Derruba a conexão do provedor (se houver) com código e motivo. `4001` ao
   * gerar chave nova, `4003` ao sair do modo `agent`.
   */
  disconnect(tenantId, code, reason) {
    const id = Number(tenantId);
    this.geracoes.set(id, (this.geracoes.get(id) ?? 0) + 1);
    const conexao = this.conexoes.get(id);
    if (!conexao) return false;
    this.conexoes.delete(id);
    this.encerrar(conexao, code, reason);
    return true;
  }

  /**
   * Um pedido à NBI pelo agente do provedor.
   *
   * `path` é relativo à raiz da NBI (`/devices/?query=…`), nunca URL absoluta;
   * `headers` já trazem a credencial; `body` é `Buffer` ou nulo. Resolve com
   * `{ status, headers, body: Buffer }`; rejeita com `AgentOfflineError` se não
   * há agente (ou ele cai no meio), com `AgentRequestError` se o agente
   * respondeu erro ou o prazo passou.
   */
  request(tenantId, {
    method = 'GET', path, headers = {}, body = null, timeoutMs = PEDIDO_TIMEOUT_PADRAO_MS, signal = null
  } = {}) {
    const conexao = this.conexoes.get(Number(tenantId));
    if (!conexao || conexao.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new AgentOfflineError(null));
    }
    const metodo = String(method).toUpperCase();
    if (!METODOS.has(metodo)) return Promise.reject(new Error(`Unsupported method for the GenieACS agent: ${metodo}`));
    // O contrato diz "relativo à raiz, nunca URL absoluta", e é aqui que isso
    // vira garantia: `//host` seria lido por um cliente HTTP como outro host.
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      return Promise.reject(new Error('GenieACS agent path must be relative to the NBI root'));
    }
    const prazo = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : PEDIDO_TIMEOUT_PADRAO_MS;

    this.sequencia += 1;
    const id = `${this.sequencia.toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

    return new Promise((resolve, reject) => {
      let timer = null;
      const aoAbortar = () => pendente.falhar(new AgentRequestError('timeout', 'GenieACS agent request aborted'));
      const encerrar = () => {
        clearTimeout(timer);
        conexao.pendentes.delete(id);
        signal?.removeEventListener?.('abort', aoAbortar);
      };
      const pendente = {
        cumprir: (resposta) => { encerrar(); resolve(resposta); },
        falhar: (erro) => { encerrar(); reject(erro); }
      };
      if (signal?.aborted) {
        reject(new AgentRequestError('timeout', 'GenieACS agent request aborted'));
        return;
      }
      conexao.pendentes.set(id, pendente);
      timer = setTimeout(
        () => pendente.falhar(new AgentRequestError('timeout', 'GenieACS agent did not answer in time')),
        prazo
      );
      timer.unref();
      signal?.addEventListener?.('abort', aoAbortar, { once: true });

      const frame = JSON.stringify({
        type: 'request',
        id,
        method: metodo,
        path,
        headers: headers || {},
        body: body === null || body === undefined ? null : Buffer.from(body).toString('base64'),
        timeoutMs: prazo
      });
      conexao.ws.send(frame, (erro) => {
        if (erro) pendente.falhar(new AgentOfflineError(null));
      });
    });
  }

  /** Para os testes (e o desligamento): derruba todas as conexões e esquece tudo. */
  close() {
    this.desarmarTimer();
    for (const conexao of [...this.conexoes.values()]) {
      this.rejeitarPendentes(conexao, () => new AgentOfflineError(null));
      conexao.fechada = true;
      conexao.ws.terminate();
    }
    this.conexoes.clear();
    this.geracoes.clear();
    this.falhas.clear();
  }
}

/** O hub do processo. Um só: a conexão de um agente é estado deste processo (ver o topo). */
export const agentHub = new AgentHub();

/** Atende o upgrade do agente no servidor HTTP do PAINEL (nunca no do portal). */
export function attachAgentHub(httpServer) {
  return agentHub.attach(httpServer);
}

export default agentHub;
