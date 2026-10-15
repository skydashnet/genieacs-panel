import WaMessage from '../models/WaMessage.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import WaSendService, { destinationFor } from './waSendService.js';
import { clientForAccount } from './evolutionClient.js';
import { deleteMessageRequest, sendReactionRequest } from '../utils/wa/evolutionApi.js';

/** Um emoji só (com seletor de variação ou tom de pele): até 16 colunas, sem texto. */
const REACTION_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]{1,8}$/u;

/** O endereço da conversa como o servidor Evolution o conhece. */
function jidOf(conversation) {
  const destino = destinationFor(conversation);
  if (!destino) return null;
  return destino.includes('@') ? destino : `${destino}@s.whatsapp.net`;
}

async function loadActionable(messageId) {
  const id = Number(messageId);
  const message = Number.isInteger(id) && id > 0 ? await WaMessage.getById(id) : null;
  if (!message) throw new WaError('common.routeNotFound', { code: 'message_not_found', status: 404 });
  return message;
}

async function clientFor(conversation) {
  const account = await WaSendService.resolveAccount(conversation);
  if (!account) throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 409 });
  const config = await WhatsAppConfigService.getConfig();
  const client = clientForAccount(account, config, WhatsAppConfigService.decryptInstanceToken(account));
  return { account, client };
}

/**
 * Reagir a uma mensagem e apagá-la. Ambos falam com o servidor Evolution; a
 * reação fica guardada na linha para o painel mostrá-la, e a exclusão marca a
 * linha em vez de apagá-la (o histórico mostra "mensagem apagada").
 */
class WaMessageActionService {
  /** `emoji` vazio tira a reação. */
  static async react(messageId, emoji) {
    const message = await loadActionable(messageId);
    const reaction = String(emoji ?? '').trim();
    if (reaction && !REACTION_RE.test(reaction)) {
      throw new WaError('whatsapp.error.messageNotActionable', { code: 'invalid_reaction', status: 400 });
    }
    if (message.is_note || message.deleted_at || !message.external_id) {
      throw new WaError('whatsapp.error.messageNotActionable', { code: 'message_not_actionable', status: 409 });
    }
    const conversation = await WaSendService.requireConversation(message.conversation_id);
    const remoteJid = jidOf(conversation);
    if (!remoteJid) throw new WaError('whatsapp.error.noDestination', { code: 'no_destination', status: 409 });

    const { account, client } = await clientFor(conversation);
    await client.sendOrThrow(sendReactionRequest(account.flavor, account.name, {
      remoteJid,
      id: message.external_id,
      fromMe: message.direction === 'out',
      reaction
    }));
    return WaMessage.update(message.id, { my_reaction: reaction || null, updated_at: new Date() });
  }

  /**
   * Mensagem nossa e já enviada: revoga no WhatsApp (apagar para todos).
   * Mensagem do cliente, ou nossa que nunca saiu: só some da tela do painel.
   */
  static async remove(messageId) {
    const message = await loadActionable(messageId);
    if (message.is_note || message.deleted_at) {
      throw new WaError('whatsapp.error.messageNotActionable', { code: 'message_not_actionable', status: 409 });
    }
    // Na fila ou no meio do envio: apagar agora deixaria a fila mandar assim
    // mesmo. O caminho certo é esperar sair (ou falhar).
    if (message.direction === 'out' && ['queued', 'sending'].includes(message.delivery_status)) {
      throw new WaError('whatsapp.error.messageNotActionable', { code: 'message_pending', status: 409 });
    }

    if (message.direction === 'out' && message.external_id && message.delivery_status !== 'failed') {
      const conversation = await WaSendService.requireConversation(message.conversation_id);
      const remoteJid = jidOf(conversation);
      if (!remoteJid) throw new WaError('whatsapp.error.noDestination', { code: 'no_destination', status: 409 });
      const { account, client } = await clientFor(conversation);
      // A API oficial da Meta não tem revogação: dizer isso é melhor que um 4xx cru.
      if (WhatsAppAccount.isCloud(account)) {
        throw new WaError('whatsapp.error.deleteUnsupported', { code: 'delete_unsupported', status: 409 });
      }
      await client.sendOrThrow(deleteMessageRequest(account.flavor, account.name, {
        remoteJid,
        id: message.external_id
      }));
    }
    return WaMessage.update(message.id, { deleted_at: new Date(), updated_at: new Date() });
  }
}

export default WaMessageActionService;
