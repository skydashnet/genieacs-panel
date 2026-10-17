import AppState from '../models/AppState.js';
import { WaError } from './whatsappConfigService.js';
import { isAccountColor } from '../config/waAccountColors.js';
import { DEFAULT_LOCALE, translatorFor } from '../i18n/index.js';
import { tdb, tinsert, tinsertReturningId } from '../config/database.js';
import WaBotConfigService from './waBotConfigService.js';

/** A marca de que as etiquetas padrão já foram criadas — apagar uma não a traz de volta. */
const SEEDED_KEY = 'wa_tags_seeded';

export const MAX_TAGS = 30;
export const TAG_NAME_MAX = 40;

/** As quatro com que todo provedor começa, na cor da paleta dos números. */
const PADRAO = Object.freeze([
  ['whatsapp.tags.defaultFinance', 'blue'],
  ['whatsapp.tags.defaultSupport', 'violet'],
  ['whatsapp.tags.defaultSales', 'lime'],
  ['whatsapp.tags.defaultCancel', 'orange']
]);

const PERIODOS = Object.freeze([7, 30, 90]);

/**
 * O que o cliente pediu ao bot, por grupo de etiqueta automática: segunda via,
 * "sem fatura em aberto" e liberação em confiança são assunto financeiro;
 * sinal, queda e manutenção são suporte técnico.
 */
export const INTENT_GROUP = Object.freeze({
  fatura: 'invoice',
  noOpenInvoice: 'invoice',
  liberar: 'invoice',
  sinal: 'signal',
  outage: 'signal',
  maintenance: 'signal'
});

const invalida = (key, code, status = 400, vars = {}) => new WaError(key, { code, status, vars });

const publica = (row) => ({ id: Number(row.id), name: row.name, color: row.color });

/**
 * As etiquetas das conversas do WhatsApp.
 *
 * A lista é do provedor; quem tem qual fica em `wa_conversation_tags`. Criar,
 * renomear e excluir é de quem configura; pôr e tirar de uma conversa é de
 * quem atende (ver as rotas).
 */
class WaTagService {
  static async seedOnce() {
    if (await AppState.get(SEEDED_KEY)) return;
    // A marca antes das linhas: duas leituras ao mesmo tempo não semeiam duas vezes.
    await AppState.upsert(SEEDED_KEY, new Date().toISOString());
    const existentes = await tdb('wa_tags').count({ n: '*' }).first();
    if (Number(existentes?.n || 0) > 0) return;
    const t = translatorFor(DEFAULT_LOCALE);
    const ids = {};
    for (const [chave, color] of PADRAO) {
      // eslint-disable-next-line no-await-in-loop
      ids[chave] = await tinsertReturningId('wa_tags', { name: t(chave), color, created_at: new Date() });
    }
    // A etiqueta automática já nasce apontando para as padrão — sem passar
    // por cima de uma escolha que o provedor tenha feito antes.
    try {
      const { autoTags } = await WaBotConfigService.getConfig();
      await WaBotConfigService.saveConfig({
        autoTags: {
          invoice: autoTags.invoice ?? ids['whatsapp.tags.defaultFinance'],
          signal: autoTags.signal ?? ids['whatsapp.tags.defaultSupport']
        }
      });
    } catch (error) {
      console.warn(`WhatsApp auto tags not configured: ${error.message}`);
    }
  }

  /**
   * A etiqueta automática de uma resposta do bot. Só acrescenta: nunca tira o
   * que a equipe pôs. Nunca lança — a resposta ao cliente já saiu.
   */
  static async autoTagFor(conversationId, intent) {
    try {
      const grupo = INTENT_GROUP[intent];
      if (!grupo || !conversationId) return null;
      await this.seedOnce();
      const { autoTags } = await WaBotConfigService.getConfig();
      const tagId = autoTags?.enabled ? autoTags[grupo] : null;
      if (!tagId) return null;
      const existe = await tdb('wa_tags').where({ id: tagId }).first('id');
      if (!existe) return null;
      const ja = await tdb('wa_conversation_tags').where({ conversation_id: conversationId, tag_id: tagId }).first('id');
      if (!ja) await tinsert('wa_conversation_tags', { conversation_id: conversationId, tag_id: tagId, created_at: new Date() });
      return Number(tagId);
    } catch (error) {
      console.warn(`WhatsApp auto tag failed: ${error.message}`);
      return null;
    }
  }

  /**
   * A etiqueta "Comprovante" na conversa em que o cliente mandou um: achada
   * pelo nome, ou criada se ainda couber. Só acrescenta, e nunca lança.
   */
  static async tagReceipt(conversationId) {
    try {
      if (!conversationId) return null;
      await this.seedOnce();
      const nome = translatorFor(DEFAULT_LOCALE)('whatsapp.tags.defaultReceipt');
      const rows = await tdb('wa_tags').select('id', 'name');
      let tagId = rows.find((r) => r.name.toLowerCase() === nome.toLowerCase())?.id ?? null;
      if (!tagId) {
        if (rows.length >= MAX_TAGS) return null;
        tagId = await tinsertReturningId('wa_tags', { name: nome, color: 'cyan', created_at: new Date() });
      }
      const ja = await tdb('wa_conversation_tags').where({ conversation_id: conversationId, tag_id: tagId }).first('id');
      if (!ja) await tinsert('wa_conversation_tags', { conversation_id: conversationId, tag_id: tagId, created_at: new Date() });
      return Number(tagId);
    } catch (error) {
      console.warn(`WhatsApp receipt tag failed: ${error.message}`);
      return null;
    }
  }

  static async list() {
    await this.seedOnce();
    const rows = await tdb('wa_tags').orderBy('name').select('id', 'name', 'color');
    return rows.map(publica);
  }

  static normalizeName(raw) {
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > TAG_NAME_MAX) {
      throw invalida('whatsapp.error.invalidTag', 'invalid_tag', 400, { max: TAG_NAME_MAX });
    }
    return name;
  }

  static normalizeColor(raw) {
    if (!isAccountColor(raw)) throw invalida('whatsapp.error.invalidTag', 'invalid_tag_color', 400, { max: TAG_NAME_MAX });
    return raw;
  }

  static async assertNameFree(name, exceptId = null) {
    const rows = await tdb('wa_tags').select('id', 'name');
    const igual = rows.find((r) => r.name.toLowerCase() === name.toLowerCase() && Number(r.id) !== Number(exceptId));
    if (igual) throw invalida('whatsapp.error.tagNameTaken', 'tag_name_taken', 409, { name });
    return rows.length;
  }

  static async get(id) {
    const numeric = Number.parseInt(String(id ?? ''), 10);
    const row = Number.isInteger(numeric) && numeric > 0 ? await tdb('wa_tags').where({ id: numeric }).first() : null;
    if (!row) throw invalida('whatsapp.error.tagNotFound', 'tag_not_found', 404);
    return row;
  }

  static async create({ name, color }) {
    await this.seedOnce();
    const nome = this.normalizeName(name);
    const cor = this.normalizeColor(color);
    const total = await this.assertNameFree(nome);
    if (total >= MAX_TAGS) throw invalida('whatsapp.error.tooManyTags', 'too_many_tags', 400, { max: MAX_TAGS });
    const id = await tinsertReturningId('wa_tags', { name: nome, color: cor, created_at: new Date() });
    return publica(await this.get(id));
  }

  static async update(id, { name, color }) {
    const atual = await this.get(id);
    const patch = {};
    if (name !== undefined) {
      patch.name = this.normalizeName(name);
      await this.assertNameFree(patch.name, atual.id);
    }
    if (color !== undefined) patch.color = this.normalizeColor(color);
    if (Object.keys(patch).length) await tdb('wa_tags').where({ id: atual.id }).update(patch);
    return publica(await this.get(atual.id));
  }

  static async remove(id) {
    const atual = await this.get(id);
    await tdb('wa_conversation_tags').where({ tag_id: atual.id }).del();
    await tdb('wa_tags').where({ id: atual.id }).del();
    // Uma regra automática que apontava para ela volta a "nenhuma".
    const { autoTags } = await WaBotConfigService.getConfig();
    const limpar = {};
    for (const grupo of ['invoice', 'signal']) {
      if (Number(autoTags?.[grupo]) === Number(atual.id)) limpar[grupo] = null;
    }
    if (Object.keys(limpar).length) await WaBotConfigService.saveConfig({ autoTags: limpar });
  }

  /** Troca o conjunto inteiro de uma conversa. Só aceita etiquetas deste provedor. */
  static async setConversationTags(conversationId, tagIds) {
    if (!Array.isArray(tagIds)) throw invalida('whatsapp.error.invalidTag', 'invalid_tag', 400, { max: TAG_NAME_MAX });
    const pedidos = [...new Set(tagIds.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];
    const validas = pedidos.length ? await tdb('wa_tags').whereIn('id', pedidos).pluck('id') : [];
    if (validas.length !== pedidos.length) throw invalida('whatsapp.error.tagNotFound', 'tag_not_found', 404);
    const atuais = await tdb('wa_conversation_tags').where({ conversation_id: conversationId }).pluck('tag_id');
    const sair = atuais.map(Number).filter((id) => !pedidos.includes(id));
    const entrar = pedidos.filter((id) => !atuais.map(Number).includes(id));
    if (sair.length) await tdb('wa_conversation_tags').where({ conversation_id: conversationId }).whereIn('tag_id', sair).del();
    for (const tagId of entrar) {
      // eslint-disable-next-line no-await-in-loop
      await tinsert('wa_conversation_tags', { conversation_id: conversationId, tag_id: tagId, created_at: new Date() });
    }
  }

  /** As etiquetas de várias conversas de uma vez: `Map<conversationId, tag[]>`. */
  static async tagsFor(conversationIds) {
    const ids = [...new Set(conversationIds.map(Number).filter(Boolean))];
    const mapa = new Map();
    if (!ids.length) return mapa;
    const vinculos = await tdb('wa_conversation_tags').whereIn('conversation_id', ids).select('conversation_id', 'tag_id');
    if (!vinculos.length) return mapa;
    const tags = await tdb('wa_tags').whereIn('id', [...new Set(vinculos.map((v) => v.tag_id))]).select('id', 'name', 'color');
    const porId = new Map(tags.map((t) => [Number(t.id), publica(t)]));
    for (const v of vinculos) {
      const tag = porId.get(Number(v.tag_id));
      if (!tag) continue;
      const lista = mapa.get(Number(v.conversation_id)) || [];
      lista.push(tag);
      mapa.set(Number(v.conversation_id), lista);
    }
    for (const lista of mapa.values()) lista.sort((a, b) => a.name.localeCompare(b.name));
    return mapa;
  }

  /** Por etiqueta: conversas marcadas no período e quantas estão abertas agora. */
  static async report({ days = 30, now = new Date() } = {}) {
    const periodo = PERIODOS.includes(Number(days)) ? Number(days) : 30;
    const desde = new Date(now.getTime() - periodo * 24 * 60 * 60 * 1000);
    const tags = await this.list();
    const vinculos = await tdb('wa_conversation_tags').select('conversation_id', 'tag_id', 'created_at');
    const conversaIds = [...new Set(vinculos.map((v) => Number(v.conversation_id)))];
    const abertas = new Set(conversaIds.length
      ? (await tdb('wa_conversations').whereIn('id', conversaIds).whereNull('closed_at').pluck('id')).map(Number)
      : []);
    return {
      days: periodo,
      tags: tags.map((tag) => {
        const daTag = vinculos.filter((v) => Number(v.tag_id) === tag.id);
        return {
          ...tag,
          taggedInPeriod: daTag.filter((v) => new Date(v.created_at).getTime() >= desde.getTime()).length,
          openNow: daTag.filter((v) => abertas.has(Number(v.conversation_id))).length
        };
      })
    };
  }
}

export default WaTagService;
