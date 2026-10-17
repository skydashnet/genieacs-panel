import crypto from 'node:crypto';
import { currentTenantId } from '../../config/tenantContext.js';
import GenieAcsConnection from '../../models/GenieAcsConnection.js';
import GenieAcsAuthService from '../genieacsAuthService.js';
import { TranslatableError } from '../../i18n/index.js';
import DirectConnector from './direct.js';
import agentHub, {
  AGENT_CLOSE, AGENT_OFFLINE_CODE, AgentOfflineError, hashAgentToken
} from './agentHub.js';

/**
 * O modo `agent`: o GenieACS do provedor numa rede sem IP público, alcançado
 * por um programa que o provedor instala lá dentro e que abre um WebSocket de
 * SAÍDA para o painel (`agentHub.js`).
 *
 * É o conector direto com UMA diferença: o transporte. Tudo o que o direto faz
 * antes de sair continua valendo, herdado e não copiado — o escopo por
 * etiqueta (`applyScope`), a raiz e o `urlFor` (a raiz decide o host; o
 * caminho nunca), a vaga de concorrência (`withAcsSlot`), o prazo e a
 * credencial de `nbiHeaders`. Só onde o direto chama o egresso este chama o
 * hub, com o `pathname + search` da URL montada: quem escolhe QUAL GenieACS
 * atende é o agente, pela configuração dele, e o painel nunca manda host.
 *
 * Devolve uma `Response` de verdade, montada com o que o agente respondeu,
 * para que `DeviceService` e os demais chamadores não percebam diferença
 * nenhuma entre um modo e o outro.
 */

/** A raiz lógica quando o provedor em modo agente não configurou endereço nenhum. */
export const AGENT_FALLBACK_ROOT = 'http://genieacs.agent';

/**
 * O maior corpo que desce ao agente. O frame tem 64 MiB (`AGENT_MAX_PAYLOAD`)
 * e o corpo vai em base64, que cresce 4/3: 48 MiB é o que cabe. Acima disso o
 * `send` recusa antes de montar o frame — um frame grande demais derrubaria a
 * conexão inteira, com os outros pedidos em andamento junto.
 */
export const AGENT_MAX_REQUEST_BODY = 48 * 1024 * 1024;

/**
 * A primeira versão do agente que repassa os cabeçalhos do envio de arquivo
 * (`fileType`, `oui`, `productClass`, `version`). Um agente mais velho
 * descartaria os quatro em silêncio, e o firmware chegaria ao GenieACS sem
 * tipo nem modelo — invisível para o painel. Quem envia confere antes
 * (`agentSupportsFileUpload`).
 */
export const AGENT_FILE_UPLOAD_VERSION = '1.1.0';

/** `a >= b` entre versões `x.y.z`; o que não for versão é tido como antiga. */
function versaoAoMenos(a, b) {
  const partes = (v) => (/^\d+\.\d+\.\d+/.test(String(v ?? '')) ? String(v).split(/[.-]/).slice(0, 3).map(Number) : null);
  const x = partes(a);
  const y = partes(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return true;
}

/** O agente do provedor em escopo anunciou uma versão que sabe enviar arquivo? */
export async function agentSupportsFileUpload() {
  const { version } = await GenieAcsConnection.agentInfo();
  return versaoAoMenos(version, AGENT_FILE_UPLOAD_VERSION);
}

/** Status que uma `Response` não aceita com corpo. */
const SEM_CORPO = new Set([101, 204, 205, 304]);

/**
 * Cabeçalhos que descrevem o transporte do lado de lá, e não o conteúdo: o
 * agente já entregou o corpo decodificado e inteiro, então repassá-los
 * mentiria sobre o que a `Response` daqui carrega.
 */
const CABECALHOS_DE_TRANSPORTE = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'
]);

function montarResposta({ status, headers, body }) {
  const cabecalhos = new Headers();
  for (const [nome, valor] of Object.entries(headers || {})) {
    if (CABECALHOS_DE_TRANSPORTE.has(nome.toLowerCase())) continue;
    try {
      cabecalhos.append(nome, valor);
    } catch {
      // Nome ou valor que não é cabeçalho HTTP válido: some, em vez de derrubar
      // a resposta inteira por causa dele.
    }
  }
  // A faixa 1xx não chega como resposta final; se o agente a mandou, algo
  // do outro lado está quebrado, e é assim que o chamador deve ler.
  if (status < 200) return new Response(null, { status: 502, headers: cabecalhos });
  const corpo = SEM_CORPO.has(status) || !body || body.length === 0 ? null : body;
  return new Response(corpo, { status, headers: cabecalhos });
}

class AgentConnector extends DirectConnector {
  static mode = 'agent';

  /**
   * A raiz lógica: o endereço configurado, quando há um válido, ou
   * `AGENT_FALLBACK_ROOT`. Ela só serve para montar o caminho — o host nunca
   * sai daqui —, e por isso o modo agente funciona sem endereço configurado.
   */
  static async rootUrl() {
    if (String((await this.baseUrl()) ?? '').trim()) {
      try {
        return await super.rootUrl();
      } catch {
        return AGENT_FALLBACK_ROOT;
      }
    }
    return AGENT_FALLBACK_ROOT;
  }

  /**
   * O ACS atrás do agente é do PRÓPRIO provedor, na rede dele: nenhum outro
   * provedor fala com ele, ainda que dois tenham escrito o mesmo endereço
   * interno (`http://localhost:7557` é o endereço de metade das instalações).
   */
  static async sharesAcs() {
    return false;
  }

  /**
   * O transporte pelo agente. Desconectado, falha NA HORA com
   * `acs_agent_offline` — esperar o prazo seria fazer o operador aguardar 15 s
   * por uma resposta que o painel já sabe que não vem.
   */
  static async send(url, { method, headers, body, signal, timeoutMs }) {
    const tenantId = currentTenantId();
    if (!agentHub.isConnected(tenantId)) {
      const { lastSeenAt } = await GenieAcsConnection.agentInfo();
      throw new AgentOfflineError(lastSeenAt);
    }
    // O corpo em bytes, do jeito que veio: um `Buffer` (o arquivo de firmware)
    // desce como está; texto (o JSON das tarefas) vira UTF-8. Passar o Buffer
    // por uma string corromperia todo byte que não é UTF-8 válido.
    let corpo = null;
    if (body !== null && body !== undefined) {
      corpo = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      if (corpo.length > AGENT_MAX_REQUEST_BODY) {
        throw new TranslatableError('device.firmwareTooLarge', { max: AGENT_MAX_REQUEST_BODY / (1024 * 1024) }, {
          status: 413, code: 'firmware_too_large'
        });
      }
    }
    const resposta = await agentHub.request(tenantId, {
      method,
      path: `${url.pathname}${url.search}`,
      // A credencial da NBI, montada pelo painel como em todo transporte: o
      // agente só repassa, não guarda nem registra.
      headers: await GenieAcsAuthService.nbiHeaders(headers),
      body: corpo,
      timeoutMs,
      signal
    });
    return montarResposta(resposta);
  }
}

/** O erro é "o agente do provedor não está conectado"? */
export function isAgentOffline(error) {
  return error?.code === AGENT_OFFLINE_CODE;
}

/** O corpo do 503 que as rotas que falam com o ACS devolvem quando o agente caiu. */
export function acsAgentOfflineBody(error, message) {
  return {
    success: false,
    message,
    code: AGENT_OFFLINE_CODE,
    lastSeenAt: toIso(error?.lastSeenAt)
  };
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const data = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

/**
 * O `AgentStatus` do provedor em escopo, como a tela o lê:
 * `{ tokenHint, tokenCreatedAt, connected, connectedAt, lastSeenAt, version }`.
 * `connected` e `connectedAt` vêm do hub (são estado do processo, não do banco).
 */
export async function agentStatus() {
  const info = await GenieAcsConnection.agentInfo();
  return {
    tokenHint: info.tokenHint,
    tokenCreatedAt: toIso(info.tokenCreatedAt),
    connected: agentHub.isConnected(currentTenantId()),
    connectedAt: toIso(agentHub.connectedSince(currentTenantId())),
    lastSeenAt: toIso(info.lastSeenAt),
    version: info.version
  };
}

/**
 * Gera a chave do agente do provedor em escopo e devolve `{ token, agent }`.
 *
 * A chave é mostrada UMA vez, nesta resposta: o banco guarda o sha256 e os 4
 * últimos caracteres. Gerar outra derruba a conexão atual com `4001` — quem
 * pede chave nova quase sempre pede porque a antiga vazou, e deixar o agente
 * velho ligado seria deixar valendo justamente o que se quis revogar.
 */
export async function issueAgentToken() {
  const token = `sgpa_${crypto.randomBytes(32).toString('base64url')}`;
  const hint = token.slice(-4);
  await GenieAcsConnection.setAgentToken(hashAgentToken(token), hint);
  agentHub.disconnect(currentTenantId(), AGENT_CLOSE.TOKEN_REVOKED, 'token revoked');
  return { token, agent: await agentStatus() };
}

/**
 * Chamado por quem acabou de gravar o modo do provedor em escopo: saindo de
 * `agent`, a conexão do agente cai com `4003`, porque o painel não vai mais
 * mandar nada por ela e o agente precisa saber por quê.
 */
export function afterModeChange(from, to) {
  if (from === 'agent' && to !== 'agent') {
    agentHub.disconnect(currentTenantId(), AGENT_CLOSE.MODE_CHANGED, 'mode changed');
  }
}

export default AgentConnector;
