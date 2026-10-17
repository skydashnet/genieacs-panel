import WaTemplate from '../models/WaTemplate.js';
import WaMetaTemplateService from './waMetaTemplateService.js';
import { WaError } from './whatsappConfigService.js';
import {
  VARIAVEIS_DE_COBRANCA,
  modeloCitaOsDoisEspelhos,
  variaveisDesconhecidas
} from '../utils/wa/waCobranca.js';

/** Column widths from `wa_templates`; truncating here beats a driver error. */
const NAME_LIMIT = 80;
const CATEGORY_LIMIT = 32;

const CATEGORIES = Object.freeze(['cobranca', 'alerta', 'suporte', 'geral', 'atendimento']);

/**
 * As respostas rápidas do atendimento (categoria `atendimento`): textos que o
 * atendente escolhe na conversa digitando "/". Quem preenche é a tela, com o
 * que ela sabe da conversa aberta — não o disparo de cobrança —, então as
 * variáveis são outras, e só elas.
 */
export const VARIAVEIS_DE_ATENDIMENTO = Object.freeze(['nome', 'primeiro_nome', 'contrato', 'atendente']);

/**
 * As variáveis do módulo de campanhas de aviso, que saem do cadastro e não de
 * uma fatura. Repetidas aqui (e não importadas de `waCampaignService`) para
 * este arquivo não depender do serviço que depende dele.
 */
export const VARIAVEIS_DE_AVISO = Object.freeze(['nome', 'primeiro_nome', 'contrato', 'plano']);

/**
 * As variáveis que uma categoria aceita. `geral` serve às duas telas — a
 * cobrança avulsa e a campanha de aviso —, e cada uma recusa na hora de montar
 * o que não sabe preencher.
 */
export function variaveisDaCategoria(category) {
  if (category === 'atendimento') return VARIAVEIS_DE_ATENDIMENTO;
  if (category === 'geral') return [...new Set([...VARIAVEIS_DE_COBRANCA, ...VARIAVEIS_DE_AVISO])];
  return VARIAVEIS_DE_COBRANCA;
}

function lerHeaderMeta(raw) {
  if (!raw) return null;
  try {
    const h = JSON.parse(raw);
    return h && typeof h === 'object' ? { source: String(h.source ?? ''), value: h.value ?? null } : null;
  } catch {
    return null;
  }
}

function lerParamsMeta(raw) {
  if (!raw) return [];
  try {
    const lista = JSON.parse(raw);
    return Array.isArray(lista) ? lista.map(String) : [];
  } catch {
    return [];
  }
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g;

/**
 * Saved message bodies.
 *
 * The one rule this service exists to enforce: a body may only cite variables
 * the dispatcher knows how to fill. It is checked on the way IN, for every
 * category, rather than at send time — by then the render has already refused
 * (`renderCobranca` returns null on an empty variable) and the operator is
 * looking at a campaign that silently dropped everybody, with no way to tell
 * why from the screen. The test runs against the FINAL category — the one a
 * `PUT` leaves the row with —, so a category change re-checks the stored body:
 * `atendimento` (quick replies) has its own variables, filled by the inbox
 * screen; every other category uses the billing dispatcher's.
 */
class WaTemplateService {
  static async list({ category, includeInactive } = {}) {
    const rows = await WaTemplate.list({
      category: CATEGORIES.includes(String(category ?? '')) ? String(category) : null,
      includeInactive: includeInactive === true
    });
    return rows.map((row) => this.publicTemplate(row));
  }

  static async create({ name, body, category, metaTemplateName, metaLanguage, metaParams, metaHeader, metaButtonParam } = {}) {
    const clean = this.validate({ name, body, category });
    const meta = await WaMetaTemplateService.validateMapping(
      { metaTemplateName, metaLanguage, metaParams, metaHeader, metaButtonParam }, variaveisDaCategoria(clean.category)
    );
    if (await WaTemplate.getByName(clean.name)) {
      throw new WaError('whatsapp.templates.nameTaken', { code: 'name_taken', status: 409 });
    }
    return this.publicTemplate(await WaTemplate.create({
      name: clean.name,
      body: clean.body,
      category: clean.category,
      active: true,
      ...meta
    }));
  }

  static async update(id, patch = {}) {
    const existing = await this.require(id);
    // A patch that omits a field keeps the stored one, so a rename cannot be
    // read as "and blank the body".
    const merged = this.validate({
      name: patch.name === undefined ? existing.name : patch.name,
      body: patch.body === undefined ? existing.body : patch.body,
      category: patch.category === undefined ? existing.category : patch.category
    });
    if (merged.name !== existing.name && await WaTemplate.getByName(merged.name)) {
      throw new WaError('whatsapp.templates.nameTaken', { code: 'name_taken', status: 409 });
    }
    // A ligação com a Meta só muda quando o pedido fala dela: um PUT que só
    // renomeia não a apaga. Mudar a categoria revalida as variáveis ligadas.
    let meta = {};
    if (patch.metaTemplateName !== undefined) {
      meta = await WaMetaTemplateService.validateMapping(patch, variaveisDaCategoria(merged.category));
    } else if (existing.meta_template_name && merged.category !== existing.category) {
      meta = await WaMetaTemplateService.validateMapping({
        metaTemplateName: existing.meta_template_name,
        metaLanguage: existing.meta_language,
        metaParams: JSON.parse(existing.meta_params || '[]'),
        metaHeader: lerHeaderMeta(existing.meta_header),
        metaButtonParam: existing.meta_button_param
      }, variaveisDaCategoria(merged.category));
    }
    return this.publicTemplate(await WaTemplate.update(existing.id, {
      name: merged.name,
      body: merged.body,
      category: merged.category,
      active: patch.active === undefined ? existing.active : patch.active === true,
      ...meta
    }));
  }

  static async remove(id) {
    const existing = await this.require(id);
    await WaTemplate.remove(existing.id);
    return true;
  }

  /**
   * The body a campaign should use for `template`.
   *
   * A campaign may cite a stored template by name or by id, or carry a body
   * typed straight into the box for a one-off run. Both are legitimate, and the
   * same validation covers them: whichever it turns out to be, the text that
   * reaches the recipients went through `variaveisDesconhecidas` first.
   *
   * @returns {Promise<{ body: string, templateId: number|null, name: string|null }>}
   */
  static async resolveBody(template) {
    const raw = String(template ?? '').trim();
    if (!raw) {
      throw new WaError('whatsapp.error.templateEmpty', { code: 'template_empty', status: 400 });
    }
    const stored = /^\d+$/.test(raw)
      ? await WaTemplate.getById(Number(raw))
      : await WaTemplate.getByName(raw);
    const body = stored ? String(stored.body) : raw;
    this.assertKnownVariables(body);
    return { body, templateId: stored?.id ?? null, name: stored?.name ?? null, template: stored };
  }

  static assertKnownVariables(body, category = null) {
    // Uma resposta rápida tem as suas variáveis; todo o resto (e um corpo
    // digitado direto numa campanha) segue a lista do disparo de cobrança.
    const unknown = category === 'atendimento' || category === 'geral'
      ? [...new Set([...String(body).matchAll(PLACEHOLDER)].map((m) => m[1]))]
        .filter((name) => !variaveisDaCategoria(category).includes(name))
      : variaveisDesconhecidas(body);
    if (unknown.length > 0) {
      const names = unknown.map((name) => `{{${name}}}`).join(', ');
      throw new WaError('whatsapp.error.unknownVariable', {
        code: 'unknown_variable',
        status: 400,
        // Named in the message, not just counted: "uses a variable the
        // dispatcher cannot fill" leaves the operator hunting through the text.
        vars: { names },
        details: unknown
      });
    }
  }

  static validate({ name, body, category }) {
    const cleanName = String(name ?? '').trim().slice(0, NAME_LIMIT);
    const cleanBody = String(body ?? '').trim();
    if (!cleanName || !cleanBody) {
      throw new WaError('whatsapp.error.templateEmpty', { code: 'template_empty', status: 400 });
    }
    const cleanCategory = String(category ?? '').trim().slice(0, CATEGORY_LIMIT);
    const finalCategory = CATEGORIES.includes(cleanCategory) ? cleanCategory : 'geral';
    // Contra a categoria FINAL: um PUT que muda só a categoria revalida o
    // corpo que já estava gravado.
    this.assertKnownVariables(cleanBody, finalCategory);
    // A body citing both mirrors passes every other check and can never render
    // for anybody: one of the two is always empty, and an empty cited variable
    // refuses the whole message. Left to the dispatcher it shows up as a
    // `templateIncomplete` count on a campaign that reached nobody, hours later.
    if (modeloCitaOsDoisEspelhos(cleanBody)) {
      throw new WaError('whatsapp.error.templateMirrors', {
        code: 'template_mirrors',
        status: 400
      });
    }
    return {
      name: cleanName,
      body: cleanBody,
      category: finalCategory
    };
  }

  static async require(id) {
    const numeric = Number(id);
    const row = Number.isInteger(numeric) ? await WaTemplate.getById(numeric) : null;
    if (!row) {
      throw new WaError('whatsapp.templates.notFound', { code: 'template_not_found', status: 404 });
    }
    return row;
  }

  /**
   * The shape the browser may see.
   *
   * Built field by field like `publicAccount`, and for the same reason: a
   * column added later must not reach the browser by default.
   */
  static publicTemplate(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      body: row.body,
      category: row.category,
      active: Boolean(row.active),
      // O modelo da Meta que este usa fora da janela de 24 h, num número oficial.
      metaTemplateName: row.meta_template_name || null,
      metaLanguage: row.meta_language || null,
      metaParams: lerParamsMeta(row.meta_params),
      // De onde vem o cabeçalho de mídia/texto e a variável do botão dinâmico.
      metaHeader: lerHeaderMeta(row.meta_header),
      metaButtonParam: row.meta_button_param || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };
  }
}

export { CATEGORIES, VARIAVEIS_DE_COBRANCA };
export default WaTemplateService;
