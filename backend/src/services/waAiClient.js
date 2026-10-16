import { PinnedTransport, RESPONSE_TOO_LARGE } from '../utils/net/pinnedFetch.js';
import { deploymentIsShared } from './genieacsEgress.js';
import { WaError } from './whatsappConfigService.js';
import { AI_ADAPTERS, AI_PROVIDERS, AI_PROVIDER_OPENAI, aiProviderOrDefault } from './waAiAdapters.js';

/**
 * O cliente da IA do atendimento: uma API compatível com OpenAI
 * (`POST {base}/chat/completions`), como a da z.ai.
 *
 * Pela mesma porta que o SGP (`sgpFetch`): o endereço é escolhido pelo
 * provedor, e na edição SaaS isso não pode virar um caminho até a rede
 * interna. Nada de redirecionamento — uma API que redireciona um POST com a
 * chave no cabeçalho não é uma API em que se confia a chave.
 */

export const AI_DEFAULT_BASE_URL = AI_PROVIDERS[AI_PROVIDER_OPENAI].defaultBaseUrl;
export const AI_DEFAULT_MODEL = AI_PROVIDERS[AI_PROVIDER_OPENAI].defaultModel;

const TIMEOUT_MS = 25_000;
const MAX_BYTES = 1024 * 1024;

const erro = (code, status = 502, details = null) => new WaError(
  `whatsapp.ai.error.${code.replace(/^ai_/, '').replace(/_([a-z])/g, (_m, c) => c.toUpperCase())}`,
  { code, status, details }
);

/**
 * O que o provedor disse ao recusar, para a tela mostrar: "HTTP 401 · 1000:
 * Authentication failed". Só os campos de erro conhecidos, curto, numa linha,
 * e nunca com a chave dentro.
 */
export function motivoDoProvedor(status, texto, apiKey, { usarTipo = false } = {}) {
  let corpo = null;
  try {
    corpo = JSON.parse(texto);
  } catch {
    corpo = null;
  }
  const err = corpo && typeof corpo.error === 'object' && corpo.error ? corpo.error : null;
  const codigo = err?.code ?? corpo?.code ?? (usarTipo ? err?.type : null) ?? null;
  const mensagem = err?.message ?? (typeof corpo?.error === 'string' ? corpo.error : null) ?? corpo?.msg ?? corpo?.message ?? null;
  let motivo = [codigo, mensagem].filter((v) => v !== null && v !== undefined && String(v).trim()).join(': ');
  motivo = motivo.replace(/\s+/g, ' ').trim();
  if (apiKey && motivo.includes(apiKey)) motivo = motivo.split(apiKey).join('***');
  if (motivo.length > 200) motivo = `${motivo.slice(0, 199)}…`;
  return { details: motivo ? `HTTP ${status} · ${motivo}` : `HTTP ${status}`, codigo: codigo === null ? null : String(codigo), mensagem: String(mensagem ?? '') };
}

/** O endereço como o painel guarda: só http/https, sem credenciais, sem barra no fim. */
export function normalizeAiBaseUrl(value, provider = AI_PROVIDER_OPENAI) {
  const text = String(value ?? '').trim();
  if (!text) return AI_PROVIDERS[aiProviderOrDefault(provider)].defaultBaseUrl;
  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    throw erro('ai_invalid_url', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw erro('ai_invalid_url', 400);
  }
  url.search = '';
  url.hash = '';
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

class WaAiClient {
  /** Quanto uma resposta pode levar. Campo de classe para o teste encurtar. */
  static TIMEOUT_MS = TIMEOUT_MS;

  /**
   * Uma volta da conversa com o modelo.
   *
   * @returns {Promise<{content: string|null, toolCalls: {id: string, name: string, arguments: object}[], message: object}>}
   */
  static async chat({ provider, baseUrl, apiKey, workspaceId = '', model, messages, tools = null, maxTokens = 600 }) {
    if (!apiKey) throw erro('ai_key_required', 400);
    const id = aiProviderOrDefault(provider);
    const adapter = AI_ADAPTERS[id];
    const url = new URL(`${normalizeAiBaseUrl(baseUrl, id)}${adapter.path}`);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const { headers, body } = adapter.buildRequest({
      apiKey, model: model || AI_PROVIDERS[id].defaultModel, messages, tools, maxTokens, hostname, workspaceId
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
    let response;
    try {
      const addresses = await PinnedTransport.vetTarget(hostname, {
        signal: controller.signal,
        allowPrivateAddresses: !deploymentIsShared(),
        refuse: () => erro('ai_blocked_host', 400)
      });
      controller.signal.throwIfAborted();
      if (addresses.length === 0) throw erro('ai_unreachable');
      response = await PinnedTransport.request({
        url,
        hostname,
        addresses,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        maxBytes: MAX_BYTES
      });
    } catch (error) {
      if (error instanceof WaError) throw error;
      if (error?.name === 'AbortError' || controller.signal.aborted) throw erro('ai_timeout', 504);
      if (error?.code === RESPONSE_TOO_LARGE) throw erro('ai_bad_response');
      throw erro('ai_unreachable');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let texto = '';
      try {
        texto = await response.text();
      } catch {
        texto = '';
      }
      const { details, codigo, mensagem } = motivoDoProvedor(response.status, texto, apiKey, { usarTipo: id !== AI_PROVIDER_OPENAI });
      if (response.status === 401 || response.status === 403) throw erro('ai_unauthorized', 502, details);
      // A z.ai diz "sem saldo" com 429 e o código 1113: não é esperar, é recarregar.
      if (adapter.isNoBalance({ codigo, mensagem })) throw erro('ai_no_balance', 502, details);
      if (response.status === 429 || response.status === 529) throw erro('ai_rate_limited', 502, details);
      throw erro('ai_bad_response', 502, details);
    }

    let data;
    try {
      data = JSON.parse(await response.text());
    } catch {
      throw erro('ai_bad_response');
    }
    const parsed = adapter.parse(data);
    if (!parsed) throw erro('ai_bad_response');
    return parsed;
  }
}

export default WaAiClient;
