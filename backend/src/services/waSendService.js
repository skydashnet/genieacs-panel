import path from 'node:path';
import WaConversation from '../models/WaConversation.js';
import WaMessage from '../models/WaMessage.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { DATA_DIR } from '../config/paths.js';
import { displayName, normalizeType, outDir } from './waAttachmentService.js';
import { ATTACHMENT_TYPES } from '../config/waAttachmentTypes.js';
import { safeContentType } from './waMediaFile.js';
import { clientForAccount } from './evolutionClient.js';
import {
  normalizeMetaButtons,
  normalizeMetaHeader,
  readMetaError,
  readSentId,
  sanitizeMetaFilename,
  sanitizeMetaLink,
  sanitizeMetaParam,
  sendAudioRequest,
  sendMediaRequest,
  sendTemplateRequest,
  sendTextRequest
} from '../utils/wa/evolutionApi.js';
import { decidirEnvioCloud } from '../utils/wa/waJanelaMeta.js';
import { destinoWa, normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { sign as signMediaToken } from '../utils/wa/waMediaToken.js';
import WaAssignmentService from './waAssignmentService.js';

/** De quanto em quanto tempo um número fora do ar pode ser reconsultado no Evolution. */
const LIVE_CHECK_MS = 30_000;
/** id da conta → quando foi a última consulta ao vivo (por processo). */
const liveChecks = new Map();

/** Column widths from `wa_messages`; truncating here beats a driver error. */
const BODY_ATTACHMENT_PATH_LIMIT = 255;
const ATTACHMENT_TYPE_LIMIT = 128;

/**
 * Who composed an outbound message — `wa_messages.source`.
 *
 * All three automatic senders write `sent_by: NULL`, so that column answers
 * "was a human behind this" and nothing else. It cannot tell the bot's own
 * reply from a dunning message or a technical alert, and the bot's ceiling was
 * reading it as if it could: three campaign messages in an hour and the bot
 * went silent on a subscriber it had never answered.
 *
 * 'operator' is also what an INBOUND row carries, and that is not a fudge.
 * `source` names which of the panel's senders composed the text; the panel
 * composed none of an inbound message, and neither did any of its automatic
 * senders — so the honest value is the one that means "not one of them". It is
 * the column default, which is how `waInboundService` gets it without saying
 * so: an outbound echo of the provider typing on their own phone is literally
 * an operator's message, and every reader here looks at outbound rows anyway.
 */
export const WA_MESSAGE_SOURCES = Object.freeze(['operator', 'bot', 'campaign', 'alert']);

/**
 * Composing and delivering one outbound message.
 *
 * The two halves are deliberately apart. `enqueue()` is what a request touches:
 * it validates, writes a `queued` row and returns — the operator's reply box
 * must not wait on an Evolution server that may be slow, restarting, or gone.
 * `dispatch()` is what the outbox worker calls later, out of any request.
 *
 * Nothing here loops or retries: how often to try, and how many times, is the
 * worker's business (`waOutboxWorker.js`).
 */
class WaSendService {
  /**
   * Writes an outbound message into the outbox.
   *
   * The refusals below all happen BEFORE the row exists, because a message that
   * can never be sent is worse as a permanently failed row than as an error the
   * operator sees while the text is still in the box.
   *
   * What is deliberately NOT checked here is the opt-out list. An opt-out means
   * the provider does not *initiate* contact; it must never stop an operator
   * answering someone who wrote in. Campaigns and alerts enforce it — the reply
   * box does not.
   */
  static async enqueue({
    conversationId,
    body,
    attachment,
    isNote = false,
    userId = null,
    source = 'operator',
    metaTemplate = null,
    replyToId = null
  } = {}) {
    // Defaulting to 'operator' rather than to the caller's intent: a sender
    // that forgets to say must never end up claiming to be the bot, because
    // the bot's ceiling counts exactly this column. An unrecognised value
    // throws instead of being coerced — coercing it to 'operator' would take
    // the bot's own replies out of its own count, which is the loop the
    // ceiling exists to stop, and it would do it silently.
    if (!WA_MESSAGE_SOURCES.includes(source)) {
      throw new Error(`waSend: unknown message source '${source}'`);
    }

    const conversation = await this.requireConversation(conversationId);
    const text = String(body ?? '').trim();
    const anexo = normalizeAttachment(attachment);

    if (!text && !anexo && !metaTemplate) {
      throw new WaError('whatsapp.error.messageEmpty', { code: 'message_empty', status: 400 });
    }

    const note = isNote === true;
    if (!note) {
      // An internal note skips both checks on purpose: it is an annotation on
      // the thread, and refusing to record one because the number happens to be
      // disconnected would lose the operator's own words.
      if (!destinationFor(conversation)) {
        throw new WaError('whatsapp.error.noDestination', { code: 'no_destination', status: 409 });
      }
    }
    const modelo = note ? null : normalizeMetaTemplate(metaTemplate);
    let textoDoModelo = null;
    if (!note) {
      const account = await this.resolveAccount(conversation);
      if (!account) {
        throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 409 });
      }
      // O modelo escolhido pelo atendente na conversa é conferido contra o
      // número que vai enviar: aprovado, suportado e com todos os parâmetros.
      // Os automáticos (régua, campanha, aviso) chegam já montados por uma
      // ligação conferida na hora de salvar.
      if (modelo && source === 'operator') {
        const { default: WaMetaTemplateService } = await import('./waMetaTemplateService.js');
        const row = await WaMetaTemplateService.checkForAccount(account, modelo);
        textoDoModelo = WaMetaTemplateService.renderBody(row, modelo.params);
      }
      // Número oficial fora da janela de 24 h sem modelo aprovado: a Meta vai
      // recusar. Dizer agora, com o texto ainda na caixa, é melhor que uma
      // linha que falha sozinha minutos depois.
      if (cloudDecision(account, conversation, modelo) === 'refuse') throw windowClosed();
    }

    // A resposta só cita uma mensagem desta mesma conversa; qualquer outro id
    // é ignorado, não um erro: a citação é um enfeite e não deve perder o texto.
    const citada = !note && Number.isInteger(Number(replyToId)) && Number(replyToId) > 0
      ? await WaMessage.getById(Number(replyToId))
      : null;

    const now = new Date();
    const message = await WaMessage.create({
      conversation_id: conversation.id,
      direction: 'out',
      reply_to_id: citada && Number(citada.conversation_id) === Number(conversation.id) ? citada.id : null,
      body: text || textoDoModelo || (modelo ? modelo.name : null),
      meta_template: modelo ? JSON.stringify(modelo) : null,
      attachment_path: anexo?.path ?? null,
      attachment_type: anexo?.type ?? null,
      attachment_name: anexo?.name ?? null,
      is_note: note,
      // A note has no delivery state at all. 'queued' would hand it to the
      // worker, and the one thing a note must never do is reach the customer.
      delivery_status: note ? null : 'queued',
      sent_by: userId || null,
      source,
      created_at: now,
      updated_at: now
    });

    // The conversation list is ordered by this column, so a thread the operator
    // just answered has to rise even before the worker despatches the message.
    //
    // Só o que tem gente por trás mexe na caixa de entrada. A cobrança, a
    // campanha e o alerta ficam no histórico da conversa, mas não a trazem
    // para o topo nem para "Abertas": com a régua ligada, cada fatura do mês
    // viraria uma conversa ali. A exceção é a conversa que ainda não teve
    // gente (`engaged_at` nulo) — ela vive em "Sem resposta", e é lá que o
    // envio automático a ordena.
    const humano = source === 'operator';
    // Quem responde uma conversa sem dono passa a ser o dono dela.
    if (humano && !note && userId) await WaAssignmentService.claimOnReply(conversation, userId, { now });
    if (humano) {
      await WaConversation.update(conversation.id, {
        last_message_at: now,
        ...(conversation.engaged_at ? {} : { engaged_at: now })
      });
    } else if (source === 'bot' || !conversation.engaged_at) {
      await WaConversation.update(conversation.id, { last_message_at: now });
    }
    return message;
  }

  /**
   * Sends one already-claimed message and reports the id the server gave it.
   *
   * Throws — every failure is a `WaError` the worker records verbatim. It does
   * not touch the row: the worker owns the outbox state machine, and splitting
   * that ownership is how a message ends up both 'sent' and retried.
   *
   * @returns {Promise<{ accountId: number, externalId: string|null }>}
   */
  static async dispatch(message) {
    const conversation = await this.requireConversation(message.conversation_id);
    const number = destinationFor(conversation);
    if (!number) {
      throw new WaError('whatsapp.error.noDestination', { code: 'no_destination', status: 409 });
    }
    const account = await this.resolveAccount(conversation);
    if (!account) {
      throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 409 });
    }

    const config = await WhatsAppConfigService.getConfig();
    const client = clientForAccount(
      account,
      config,
      WhatsAppConfigService.decryptInstanceToken(account)
    );
    // De novo na hora do envio, e esta é a que vale: a campanha anda por
    // horas, e a janela que estava aberta no enfileiramento pode ter fechado.
    const modelo = parseMetaTemplate(message.meta_template);
    const decisao = cloudDecision(account, conversation, modelo);
    if (decisao === 'refuse') throw windowClosed();
    if (decisao === 'template') {
      const pronto = resolveTemplateHeader(modelo, message, config);
      const { data } = await sendCloud(() => client.sendOrThrow(sendTemplateRequest(account.name, number, pronto)));
      return { accountId: account.id, externalId: readSentId(data), sentAs: 'template' };
    }
    const externalId = WhatsAppAccount.isCloud(account)
      ? await sendCloud(() => sendThrough(client, account, message, number, config))
      : await sendThrough(client, account, message, number, config);
    return { accountId: account.id, externalId, sentAs: 'text' };
  }

  /**
   * Which connected number carries this thread.
   *
   * The conversation's own account comes first: a customer who wrote to the
   * support number must be answered from the support number, or the reply
   * arrives from a stranger. Only when that number is not connected does the
   * purpose routing take over — and it routes on the SAME purpose, so a billing
   * thread falls back to another billing number before it falls back to any.
   */
  static async resolveAccount(conversation) {
    const own = conversation.account_id
      ? await WhatsAppAccount.getById(conversation.account_id)
      : null;
    if (own && own.status === 'connected') return own;
    // O status no banco vem dos avisos de conexão do Evolution, e um aviso de
    // reconexão perdido deixa um número que está funcionando preso em
    // "conectando". Antes de recusar o envio (ou de desviar para outro
    // número), pergunta ao servidor — no máximo uma vez a cada 30 s por
    // número, para a fila não martelar o Evolution enquanto ele está fora.
    if (own && await this.confirmLive(own)) return { ...own, status: 'connected' };
    return WhatsAppAccount.getForPurpose(own?.purpose || 'general');
  }

  /** Para os testes: esquece quando cada número foi consultado ao vivo. */
  static forgetLiveChecks() {
    liveChecks.clear();
  }

  static async confirmLive(account) {
    const agora = Date.now();
    const ultima = liveChecks.get(account.id) ?? 0;
    if (agora - ultima < LIVE_CHECK_MS) return false;
    liveChecks.set(account.id, agora);
    try {
      // Import tardio: o serviço de instâncias é pesado e não depende deste.
      const { default: EvolutionInstanceService } = await import('./evolutionInstanceService.js');
      const { account: atual } = await EvolutionInstanceService.checkStatus(account.id);
      return atual?.status === 'connected';
    } catch (error) {
      console.warn(`waSend: live status check for account ${account.id} failed: ${error?.message || error}`);
      return false;
    }
  }

  static async requireConversation(conversationId) {
    const id = Number(conversationId);
    const conversation = Number.isInteger(id) ? await WaConversation.getById(id) : null;
    if (!conversation) {
      // No dedicated key: "route not found" is what a missing thread is, and
      // inventing a string here would put it out of step with the locale files.
      throw new WaError('common.routeNotFound', { code: 'conversation_not_found', status: 404 });
    }
    return conversation;
  }

  /**
   * The message shape the browser may see.
   *
   * Built field by field like `publicAccount`, and for the same reason: a
   * column added later must not reach the browser by default.
   */
  static publicMessage(row) {
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      direction: row.direction,
      body: row.body ?? null,
      // No `url`. The stored value is a path on the panel's disk, which is
      // useless to a browser — it fetches by message id now — and is a shape of
      // the server's filesystem that nothing outside needs to know. What the
      // screen actually draws from is `type` and `name`.
      attachment: row.attachment_path
        ? {
          type: row.attachment_type || null,
          name: row.attachment_name || null
        }
        : null,
      isNote: Boolean(row.is_note),
      replyToId: row.reply_to_id ?? null,
      externalId: row.external_id || null,
      deliveryStatus: row.delivery_status || null,
      deliveryError: row.delivery_error || null,
      attempts: Number(row.attempts || 0),
      // When the outbox will try again. A message waiting out a backoff is
      // `queued` with an error on it, which reads on screen exactly like one
      // that has given up — this is the field that tells the two apart, so the
      // bubble can say "trying again" instead of showing a failure that is not
      // one yet. NULL is a row with nothing to wait for: never tried, or done.
      nextAttemptAt: row.next_attempt_at || null,
      sentBy: row.sent_by ?? null,
      // The column is NOT NULL, so the fallback is only for a row a test or a
      // fixture built by hand; the browser's type has no null in it.
      source: row.source || 'operator',
      // `template` quando saiu como modelo aprovado da Meta (fora da janela).
      sentAs: row.sent_as || null,
      readAt: row.read_at || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };
  }
}

function windowClosed() {
  return new WaError('whatsapp.error.metaWindowClosed', { code: 'meta_window_closed', status: 409 });
}

/** A regra da janela para ESTE número e ESTA conversa. */
function cloudDecision(account, conversation, modelo) {
  return decidirEnvioCloud({
    isCloud: WhatsAppAccount.isCloud(account),
    sameAccount: Number(account.id) === Number(conversation.account_id),
    lastInboundAt: conversation.last_inbound_at,
    hasTemplate: Boolean(modelo)
  });
}

/**
 * Envio por número oficial: a recusa por janela (131047) vira o código do
 * painel, que a fila trata como definitivo — repetir não muda a resposta.
 */
async function sendCloud(fn) {
  try {
    return await fn();
  } catch (error) {
    const corpo = String(error?.translationVars?.body ?? error?.details ?? '');
    if (error?.code === 'http_error' && readMetaError(corpo).windowClosed) throw windowClosed();
    throw error;
  }
}

/**
 * O modelo da Meta como ele vai para a fila: nome, idioma e os parâmetros já
 * prontos, na ordem do `{{1}}`, `{{2}}`…, mais o cabeçalho (mídia só por link
 * https, nome de arquivo curto; ou a marca `attachment`, resolvida no envio) e
 * os sufixos dos botões de URL dinâmica. Qualquer coisa fora disso é ignorada.
 */
export function normalizeMetaTemplate(input) {
  if (!input || typeof input !== 'object') return null;
  const name = String(input.name ?? '').trim().slice(0, 255);
  const language = String(input.language ?? '').trim().slice(0, 16);
  if (!/^[a-z0-9_]+$/.test(name) || !/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/.test(language)) return null;
  const params = (Array.isArray(input.params) ? input.params : []).slice(0, 20).map(sanitizeMetaParam);
  const header = normalizeMetaHeader(input.header);
  const buttons = normalizeMetaButtons(input.buttons);
  return {
    name,
    language,
    params,
    ...(header ? { header } : {}),
    ...(buttons.length ? { buttons } : {})
  };
}

/**
 * O cabeçalho `attachment` vira o link do anexo DESTA mensagem — o mesmo
 * endereço assinado que o envio de mídia comum usa. Sem anexo, sem endereço
 * público ou com endereço que não é https, recusa: a Meta não aceita modelo
 * de mídia sem a mídia.
 */
function resolveTemplateHeader(modelo, message, config) {
  if (modelo?.header?.source !== 'attachment') return modelo;
  if (!message.attachment_path) {
    throw new WaError('whatsapp.error.metaHeaderMissing', { code: 'meta_header_missing', status: 409 });
  }
  const url = publicMediaUrl(config?.webhookBaseUrl, message.id);
  if (!url) throw new WaError('whatsapp.error.noPublicUrl', { code: 'no_public_url', status: 409 });
  const link = sanitizeMetaLink(url);
  if (!link) throw new WaError('whatsapp.error.metaHeaderMissing', { code: 'meta_header_missing', status: 409 });
  const header = { type: modelo.header.type, link };
  if (header.type === 'document') {
    const filename = sanitizeMetaFilename(message.attachment_name);
    if (filename) header.filename = filename;
  }
  return { ...modelo, header };
}

function parseMetaTemplate(raw) {
  if (!raw) return null;
  try {
    return normalizeMetaTemplate(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch {
    return null;
  }
}

/**
 * Where this thread's messages go, in the form Evolution accepts as `number`.
 *
 * `destinoWa` decides between the phone and the LID; the normalisation below
 * only strips punctuation and adds the Brazilian country code to a number that
 * clearly lacks one. It never invents the ninth digit — see `waDestino.js`:
 * guessing it hits an old mobile and misses a landline, and the miss is silent
 * because the wrong number exists and belongs to someone else.
 */
export function destinationFor(conversation) {
  const destino = destinoWa(conversation, conversation);
  if (!destino) return null;
  // A LID is not a phone number and must keep its domain, or the server reads
  // fifteen digits as an international number and delivers nowhere.
  if (destino.tipo === 'lid') return `${destino.valor}@lid`;
  return normalizarTelefoneBr(destino.valor) || null;
}

/** O `kind` de cada tipo da lista única, para o envio não adivinhar pelo prefixo. */
const KIND_BY_TYPE = new Map(ATTACHMENT_TYPES.map((row) => [row.type, row.kind]));

/**
 * Evolution's media vocabulary has exactly four words. The column holds a MIME
 * type, so the mapping is by family — and anything unrecognised is a
 * 'document', which is the one kind that carries any bytes at all.
 *
 * Um tipo da lista (`config/waAttachmentTypes.js`) usa o `kind` que está lá —
 * é a mesma linha que a tela e o upload leem. O prefixo fica como reserva para
 * o que não está na lista: linhas antigas e anexos de bot/alerta.
 */
export function mediaKind(attachmentType) {
  const raw = String(attachmentType || '').trim().toLowerCase();
  if (['image', 'video', 'audio', 'document'].includes(raw)) return raw;
  const known = KIND_BY_TYPE.get(normalizeType(raw));
  if (known) return known;
  if (raw.startsWith('image/')) return 'image';
  if (raw.startsWith('video/')) return 'video';
  if (raw.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * The address the Evolution server can fetch this message's attachment at.
 *
 * `attachment_path` is a path on the panel's own disk, relative to `DATA_DIR`.
 * Handing that to Evolution — which is what this service did until now — asks
 * another machine to open a file it has no idea about, and the send fails, or
 * worse, succeeds with nothing attached.
 *
 * The origin comes from `webhookBaseUrl` because it is the ONLY address the
 * panel has been told the Evolution server can reach it on: it is where the
 * events arrive from. Deriving it from the request would be worse than
 * guessing — a despatch happens in a worker, with no request in sight.
 *
 * @returns {string|null} null when nothing has told the panel its public origin
 */
export function publicMediaUrl(webhookBaseUrl, messageId) {
  let origin;
  try {
    ({ origin } = new URL(String(webhookBaseUrl || '')));
  } catch {
    return null;
  }
  if (!origin || origin === 'null') return null;
  // The token is minted here, at despatch, and nowhere else: it is good for
  // fifteen minutes, which covers the fetch the server is about to make and
  // nothing beyond it.
  return `${origin}/api/whatsapp-media/${messageId}?t=${encodeURIComponent(signMediaToken(messageId))}`;
}

/**
 * Confina um caminho vindo do request à pasta de saída DESTE provedor.
 *
 * O caminho chega do navegador, e a única coisa que ele deveria ser é o que a
 * rota de upload acabou de devolver — `wa-media/t<id>/out/<ano>/<mês>/<uuid>`.
 * Nada, entre aqui e `wa_messages.attachment_path`, verificava isso: o único
 * confinamento do sistema era o `inside(ROOT, …)` de `waMediaFile.js`, com
 * `ROOT = DATA_DIR`. E `DATA_DIR` é onde ficam `db-config.json`, com as
 * credenciais do banco em texto claro, e o `panel.sqlite` inteiro.
 *
 * O raciocínio em `waMediaFile.js` — "o arquivo é o daquela linha que quem
 * chamou já podia ler" — vale para a leitura e falha aqui, porque quem chama
 * ESCREVE o caminho daquela linha. Por isso a checagem mora deste lado, no
 * único caller que aceita anexo vindo de request: `waBroadcastService`,
 * `waBotService` e `waAlertService` não passam nenhum.
 *
 * `path.resolve` colapsa `..` ANTES da comparação de prefixo, que é a única
 * ordem que funciona, e um caminho absoluto guardado perde para o `resolve` e
 * cai fora do prefixo do mesmo jeito.
 */
function confinarCaminho(relativo) {
  const raiz = path.resolve(DATA_DIR, outDir());
  const alvo = path.resolve(DATA_DIR, relativo);
  if (alvo !== raiz && !alvo.startsWith(raiz + path.sep)) {
    throw new WaError('whatsapp.error.attachmentNotAllowed', {
      code: 'attachment_not_allowed',
      status: 400
    });
  }
  return alvo;
}

/**
 * O tipo de um arquivo da pasta de saída, pela extensão com que o upload o
 * gravou. O upload confere os primeiros bytes contra a lista e grava o arquivo
 * com a extensão PRINCIPAL do tipo aprovado — então a extensão no disco é o
 * veredito do upload, e a única fonte confiável do tipo daqui em diante.
 */
const TYPE_BY_STORED_EXTENSION = new Map(
  ATTACHMENT_TYPES.filter((row) => !row.convertTo).map((row) => [row.extensions[0], row.type])
);

/**
 * Accepts the request body's `attachment`, in either naming convention.
 *
 * Só o caminho vem do navegador. O tipo e o nome que o corpo trazia iam
 * direto para o `mimetype` e o `fileName` do envio: um `.txt` com HTML dentro
 * passava pelo upload e saía para o assinante como `Fatura.html`, `text/html`
 * — a lista que deixa HTML de fora contornada no passo seguinte. Agora o tipo
 * sai da extensão gravada e o nome passa pela mesma limpeza do upload,
 * terminando na extensão desse tipo.
 */
export function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const caminho = String(attachment.url ?? attachment.path ?? '').trim();
  if (!caminho) return null;
  // Truncado ANTES de confinar, e não depois: o que a coluna vai guardar é o
  // que precisa ter sido verificado. Cortar um caminho já aprovado devolveria
  // à linha uma string que ninguém checou.
  const guardado = caminho.slice(0, BODY_ATTACHMENT_PATH_LIMIT);
  confinarCaminho(guardado);
  const type = TYPE_BY_STORED_EXTENSION.get(path.extname(guardado).toLowerCase());
  if (!type) {
    throw new WaError('whatsapp.error.attachmentNotAllowed', {
      code: 'attachment_not_allowed',
      status: 400
    });
  }
  const pedido = String(attachment.name ?? attachment.fileName ?? '').trim();
  const name = pedido ? displayName(encodeURIComponent(pedido), type) : null;
  return {
    path: guardado,
    type: type.slice(0, ATTACHMENT_TYPE_LIMIT),
    name: name ? name.slice(0, BODY_ATTACHMENT_PATH_LIMIT) : null
  };
}

/**
 * Picks the route, sends once, and returns the server's message id.
 *
 * The audio branch is the delicate one. `sendMedia` with `mediatype: 'audio'`
 * delivers a FILE the recipient has to download; `sendWhatsAppAudio` delivers
 * the voice bubble that plays in place. Measured on the source system's real
 * account: three recordings made in the panel came out as attachments.
 */
async function sendThrough(client, account, message, number, config) {
  const { flavor, name } = account;
  const caption = String(message.body || '');

  if (!message.attachment_path) {
    const citada = message.reply_to_id ? await WaMessage.getById(message.reply_to_id) : null;
    const { data } = await client.sendOrThrow(
      sendTextRequest(flavor, name, number, caption, citada?.external_id || null)
    );
    return readSentId(data);
  }

  // Everything below this line is about the attachment, so a message without
  // one never reaches it — the refusal cannot touch a plain text send.
  const mediaUrl = publicMediaUrl(config?.webhookBaseUrl, message.id);
  if (!mediaUrl) {
    // Refused rather than sent, and this is the same lesson the portal link
    // already taught: a send that "succeeds" with an address nobody can open
    // costs the operator a conversation with a customer to find out. Failing
    // here puts the reason in `delivery_error`, where the bubble shows it.
    throw new WaError('whatsapp.error.noPublicUrl', { code: 'no_public_url', status: 409 });
  }

  const kind = mediaKind(message.attachment_type);
  // Número oficial não tem a rota de voz do Baileys: o áudio vai como mídia.
  if (kind === 'audio' && !WhatsAppAccount.isCloud(account)) {
    // Null on Evolution GO, whose PTT route has never been measured — and a
    // guessed path is exactly the mistake this integration already paid for.
    const request = sendAudioRequest(flavor, name, { number, url: mediaUrl });
    if (request) {
      const result = await client.send(request);
      // ONLY a non-2xx falls through to sendMedia. Retrying after a 2xx sends
      // the audio twice, and nobody can unsend the second copy. A transport
      // failure or a 401 does not reach here at all: `send` throws on those,
      // and they would fail the same way on the media route.
      if (result.ok) return readSentId(result.data);
    }
  }

  const { data } = await client.sendOrThrow(sendMediaRequest(flavor, name, {
    number,
    type: kind,
    url: mediaUrl,
    caption,
    fileName: message.attachment_name || '',
    // O tipo sem parâmetros e só se for um tipo MIME de verdade — a coluna veio
    // de um request. Sem tipo guardado, nada: o servidor deduz como fazia antes.
    mimetype: message.attachment_type ? safeContentType(message.attachment_type) : undefined
  }));
  return readSentId(data);
}

export default WaSendService;
