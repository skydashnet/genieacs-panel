import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';

/**
 * O webhook de um número oficial registrado pelo próprio painel na Meta.
 *
 * A Meta entrega os eventos do número em `<servidor Evolution>/webhook/meta`,
 * e quem confere o token de verificação é o servidor Evolution — um token só
 * (`WA_BUSINESS_TOKEN_WEBHOOK`) para todos os números dele. Na SaaS esse
 * servidor é da plataforma, e o token era o mesmo para todos os provedores:
 * mostrá-lo a cada um, para ele colar no app dele na Meta, entregava a todos o
 * segredo de todos.
 *
 * Em vez disso, o painel registra o webhook na conta WABA pela Graph API
 * (`POST /{waba}/subscribed_apps` com `override_callback_uri` e
 * `verify_token`), com o token da Meta do próprio número. O token de
 * verificação vai do servidor do painel direto para a Meta, e o provedor não o
 * vê. A Meta confere a URL na hora (o desafio `hub.challenge`), então um
 * `success` aqui já é a prova de que a volta funciona.
 *
 * O host é fixo, como o do Telegram (`telegramClient.js`): não passa pela
 * guarda de egresso dos endereços que vêm de dado. O token vai no cabeçalho,
 * nunca na URL, e nada daqui devolve a exceção do `fetch` nem a URL.
 */

const GRAPH_BASE = 'https://graph.facebook.com';
/** A versão da Graph API; `META_GRAPH_VERSION` troca sem novo deploy de código. */
export const META_GRAPH_VERSION = /^v\d{1,3}\.\d{1,2}$/.test(String(process.env.META_GRAPH_VERSION || '').trim())
  ? String(process.env.META_GRAPH_VERSION).trim()
  : 'v21.0';
const GRAPH_TIMEOUT_MS = 10_000;
/** O tamanho da coluna `meta_webhook_error`. */
const ERROR_LIMIT = 255;
const WABA_ID = /^\d{5,32}$/;

let fetcher = (...args) => fetch(...args);

/** Para os testes: a Graph falsa entra aqui. */
export function setMetaGraphFetcher(fn) {
  fetcher = fn || ((...args) => fetch(...args));
}

/** A recusa da Graph em texto curto: `(<código>) <mensagem>`, sem o token. */
function graphRefusal(status, data) {
  const erro = data?.error;
  const mensagem = typeof erro?.message === 'string' ? erro.message : '';
  const codigo = erro?.code ?? status;
  const texto = mensagem ? `(${codigo}) ${mensagem}` : `meta_http_${status}`;
  return texto.slice(0, ERROR_LIMIT);
}

/**
 * Registra o webhook da conta WABA na Meta. Nunca lança.
 *
 * @param {{ wabaId: string, metaToken: string, callbackUrl: string, verifyToken: string }} p
 * @returns {Promise<{ ok: true, error: null } | { ok: false, error: string }>}
 */
export async function subscribeWabaWebhook({ wabaId, metaToken, callbackUrl, verifyToken }) {
  // Sem URL ou sem token de verificação a Meta recusaria de qualquer jeito;
  // dizer por quê é mais útil que a recusa dela.
  if (!callbackUrl || !verifyToken) return { ok: false, error: 'meta_webhook_unconfigured' };
  const waba = String(wabaId ?? '').trim();
  if (!WABA_ID.test(waba) || !metaToken) return { ok: false, error: 'meta_webhook_invalid_account' };

  let resposta;
  try {
    resposta = await fetcher(`${GRAPH_BASE}/${META_GRAPH_VERSION}/${waba}/subscribed_apps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${metaToken}`
      },
      body: JSON.stringify({ override_callback_uri: callbackUrl, verify_token: verifyToken }),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      redirect: 'manual'
    });
  } catch {
    return { ok: false, error: 'meta_unreachable' };
  }
  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }
  if (resposta.ok && dados?.success !== false && !dados?.error) return { ok: true, error: null };
  return { ok: false, error: graphRefusal(resposta.status, dados) };
}

class MetaWebhookService {
  /**
   * Registra o webhook do número e grava o resultado na linha. Nunca lança:
   * quem chama é a criação e a troca de token, e nenhuma das duas pode ser
   * desfeita porque a Meta recusou o webhook.
   *
   * @param {object} account a linha de `whatsapp_accounts`
   * @param {string} [metaToken] o token da Meta já em mãos; sem ele, o cifrado da linha
   */
  static async register(account, metaToken) {
    let result;
    try {
      const config = await WhatsAppConfigService.getConfig();
      result = await subscribeWabaWebhook({
        wabaId: account.meta_waba_id,
        metaToken: metaToken || WhatsAppConfigService.decryptInstanceToken(account),
        // A instância mora em `account.base_url`: é o `/webhook/meta` DELE que
        // a Meta tem de chamar, salvo URL publicada na configuração.
        callbackUrl: WhatsAppConfigService.cloudCallbackUrl(config, account.base_url),
        verifyToken: config.cloudVerifyToken || ''
      });
    } catch {
      result = { ok: false, error: 'meta_webhook_failed' };
    }
    let updated = account;
    try {
      updated = await WhatsAppAccount.update(account.id, {
        meta_webhook_status: result.ok ? 'ok' : 'error',
        meta_webhook_error: result.ok ? null : String(result.error).slice(0, ERROR_LIMIT),
        meta_webhook_at: new Date()
      });
    } catch {
      // A linha fica como estava; o resultado ainda volta para quem chamou.
    }
    return { ...result, account: updated };
  }

  /** "Registrar de novo", pela tela. 404 de outro provedor, 409 de número por QR. */
  static async retry(id) {
    const { default: EvolutionInstanceService } = await import('./evolutionInstanceService.js');
    const account = await EvolutionInstanceService.loadAccount(id);
    if (!WhatsAppAccount.isCloud(account)) {
      throw new WaError('whatsapp.error.notCloud', { code: 'not_cloud', status: 409 });
    }
    const result = await this.register(account);
    if (!result.ok) {
      throw new WaError('whatsapp.metaWebhook.failed', {
        code: 'meta_webhook_failed',
        status: 502,
        vars: { reason: result.error }
      });
    }
    return { account: result.account };
  }
}

export default MetaWebhookService;
