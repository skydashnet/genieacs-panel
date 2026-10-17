import WhatsAppConfigService from './whatsappConfigService.js';
import { tdb } from '../config/database.js';

const LIMITE = 50;
const JANELA_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const PREVIA_MAX = 100;

const ms = (valor) => (valor instanceof Date ? valor.getTime() : new Date(valor).getTime());

/**
 * O que a notificação do navegador mostra: mensagens novas de cliente desde
 * o último cursor, só das conversas que são do atendente ou que esperam gente.
 *
 * Conversa que o bot está atendendo não toca nada — seria o sino a cada
 * "2" que o cliente digita no menu.
 */
class WaNotificationService {
  /**
   * O cursor é o id da última mensagem lida, não uma hora: no MySQL o
   * `created_at` guarda segundos inteiros (arredondados), e um cursor com
   * milissegundos repetiria ou perderia mensagens perto da virada do segundo.
   */
  static async since({ userId, after, now = new Date() } = {}) {
    const texto = String(after ?? '').trim();
    const desde = /^\d+$/.test(texto) ? Number(texto) : null;
    if (desde === null || !Number.isSafeInteger(desde)) {
      // Primeira leitura (ou um cursor de outra versão): só o ponto de partida.
      const maior = await tdb('wa_messages').max({ id: 'id' }).first();
      return { cursor: String(Number(maior?.id ?? 0)), items: [] };
    }

    const mensagens = await tdb('wa_messages')
      .where({ direction: 'in' })
      .where('id', '>', desde)
      .where('created_at', '>', new Date(now.getTime() - JANELA_MAX_MS))
      .orderBy('id', 'asc')
      .limit(LIMITE)
      .select('id', 'conversation_id', 'body', 'attachment_type', 'created_at');
    // O lote inteiro avança o cursor, inclusive o que não vira aviso.
    const cursor = String(mensagens.length ? Number(mensagens[mensagens.length - 1].id) : desde);
    if (!mensagens.length) return { cursor, items: [] };

    const ids = [...new Set(mensagens.map((m) => Number(m.conversation_id)))];
    const conversas = new Map((await tdb('wa_conversations')
      .whereIn('id', ids)
      .select('id', 'push_name', 'wa_phone_e164', 'contract', 'assigned_user_id', 'bot_paused_until', 'waiting_since'))
      .map((c) => [Number(c.id), c]));
    const { botEnabled } = await WhatsAppConfigService.getConfig();
    const agora = now.getTime();

    const items = [];
    for (const m of mensagens) {
      const c = conversas.get(Number(m.conversation_id));
      if (!c) continue;
      const mine = Boolean(userId) && Number(c.assigned_user_id) === Number(userId);
      const precisaDeGente = !c.assigned_user_id && (
        botEnabled === false
        || (c.bot_paused_until && ms(c.bot_paused_until) > agora)
        || Boolean(c.waiting_since)
      );
      if (!mine && !precisaDeGente) continue;
      const texto = String(m.body ?? '').replace(/\s+/g, ' ').trim();
      items.push({
        messageId: Number(m.id),
        conversationId: Number(c.id),
        contact: c.push_name || (c.wa_phone_e164 ? `+${c.wa_phone_e164}` : null) || c.contract || null,
        preview: texto ? (texto.length > PREVIA_MAX ? `${texto.slice(0, PREVIA_MAX - 1)}…` : texto) : null,
        hasAttachment: !texto && Boolean(m.attachment_type),
        createdAt: new Date(ms(m.created_at)).toISOString(),
        mine
      });
    }
    return { cursor, items };
  }
}

export default WaNotificationService;
