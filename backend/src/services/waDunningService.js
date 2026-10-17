import AppState from '../models/AppState.js';
import SgpLink from '../models/SgpLink.js';
import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import WaTemplate from '../models/WaTemplate.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import SgpService, { SgpError } from './sgpService.js';
import WaBillingService from './waBillingService.js';
import WaSendService from './waSendService.js';
import WaMetaTemplateService from './waMetaTemplateService.js';
import WaTemplateService from './waTemplateService.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import WaTagService from './waTagService.js';
import WaConversationService from './waConversationService.js';
import { DEFAULT_LOCALE, translatorFor } from '../i18n/index.js';
import { isUniqueViolation, tdb, tinsertReturningId, withDeadlockRetry } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import {
  chaveDaFatura,
  diasEntre,
  maisAntigaEmAberto,
  modeloEhLembrete,
  renderCobranca,
  variaveisDeCobranca,
  variaveisVazias
} from '../utils/wa/waCobranca.js';
import { dentroDaJanela, lerJanela, semanaPadraoCobranca } from '../utils/wa/waJanela.js';

/**
 * A régua de cobrança AUTOMÁTICA.
 *
 * A tela "Régua de cobrança" nasceu manual, com uma regra que continua de pé
 * para ela: montar nunca envia. Esta é a outra metade, e ela ENVIA — por isso
 * três travas que não dependem de disciplina de ninguém:
 *
 * 1. **Nasce desligada, e ligar é um ato.** Salvar as etapas não liga nada; o
 *    interruptor é uma rota própria, de `campaigns.manage`, e vai para a trilha.
 *
 * 2. **Uma vez por etapa por fatura**, garantido pelo índice único de
 *    `wa_dunning_sends` e não por uma leitura antes da escrita: a linha é
 *    gravada ANTES de a mensagem entrar na fila, e a segunda passada que
 *    tentar o mesmo esbarra no índice e desiste.
 *
 * 3. **Pagou, parou.** As faturas são lidas do SGP ao vivo, na hora de decidir
 *    cada envio — fatura paga não está mais entre as em aberto e não gera
 *    etapa. O webhook de pagamento do SGP (`onPayment`) tira da fila o que
 *    ainda não saiu. E uma fatura que sumiu das em aberto numa passada é
 *    conferida contra a lista completa antes de ser dada como paga.
 *
 * O resto é o que o painel já fazia bem, reaproveitado: as variáveis e a
 * recusa de modelo incompleto (`waCobranca.js`), o não-perturbe, o telefone
 * corrigido à mão, o ritmo das chamadas ao SGP (`WaBillingService`) e a fila
 * de saída com teto por minuto e novas tentativas (`waOutboxWorker.js`).
 */

const CONFIG_KEY = 'wa_dunning_rule';
const LAST_RUN_KEY = 'wa_dunning_last_run';

/** Limites do que a tela pode pedir. */
export const OFFSET_MIN = -30;
export const OFFSET_MAX = 120;
export const MAX_STEPS = 12;
const MAX_PER_INVOICE_LIMIT = 30;
const MIN_INTERVAL_LIMIT_HOURS = 24 * 30;
const MAX_PER_RUN_LIMIT = 2000;

/**
 * De quanto em quanto tempo a passada automática roda, dentro da janela.
 *
 * Cada passada é uma ida ao SGP por contrato, e o SGP do provedor é o mesmo
 * que atende a URA agora. As etapas são por DIA, então uma passada a cada
 * poucas horas pega tudo o que venceu hoje e ainda dá tempo de o intervalo
 * mínimo de uma pessoa vencer no mesmo dia.
 */
export const RUN_INTERVAL_MS = 3 * 3600_000;

/**
 * Prévia: quantos contratos no máximo.
 *
 * A prévia roda em segundo plano (`startPreview`) — uma ida ao SGP por
 * contrato, a 150 ms uma da outra, passa fácil do minuto que um proxy à frente
 * do painel espera por uma resposta. O teto existe para ela terminar num tempo
 * que alguém espera olhando a barra, não para caber numa requisição.
 */
export const PREVIEW_CONTRACTS = 1000;

/** Por quanto tempo um pagamento ainda rende agradecimento. */
const THANKS_WINDOW_MS = 3 * 24 * 3600_000;

/** Quantos dias a régua para quando o cliente manda um comprovante. */
export const RECEIPT_PAUSE_MAX_DAYS = 15;
const DIA_MS = 24 * 3600_000;

/** O que conta como comprovante: imagem ou PDF. Áudio e vídeo, não. */
export function pareceComprovante(mime) {
  const tipo = String(mime ?? '').toLowerCase();
  return tipo.startsWith('image/') || tipo === 'application/pdf';
}

/** Os motivos de pulo, na ordem em que o operador pode agir sobre eles. */
export const SKIP_REASONS = Object.freeze([
  'noPhone', 'optOut', 'templateIncomplete', 'maxReached', 'interval', 'paused', 'sgpRefused'
]);

/** O motivo gravado em `wa_dunning_sends.reason`. */
const REASON_COLUMN = Object.freeze({
  noPhone: 'no_phone',
  optOut: 'opt_out',
  templateIncomplete: 'template_incomplete',
  maxReached: 'max_reached'
});

function padroes() {
  return {
    enabled: false,
    steps: [],
    maxPerInvoice: 6,
    minIntervalHours: 24,
    maxPerRun: 500,
    // Comprovante (imagem ou PDF) numa conversa com contrato: a régua para
    // esse contrato por tantos dias. 0 desliga.
    receiptPauseDays: 3,
    thanksTemplateId: null,
    window: { timezone: 'America/Sao_Paulo', week: semanaPadraoCobranca() },
    enabledAt: null,
    enabledBy: null,
    updatedAt: null
  };
}

/** `invalid_window` → `whatsapp.dunning.error.invalidWindow`: uma frase por recusa. */
const invalido = (code, vars) => new WaError(
  `whatsapp.dunning.error.${code.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())}`,
  { code, status: code === 'already_running' ? 409 : 400, vars }
);

/** As variáveis que faltaram, como `pix, link_boleto`; `null` sem nenhuma. */
function detalhe(missing) {
  return missing?.length ? missing.join(', ').slice(0, 255) : null;
}

/** O contrário de `detalhe`. */
function lerDetalhe(raw) {
  return String(raw ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

function inteiro(raw, { min, max, code }) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw invalido(code, { min, max });
  return n;
}

/** A chave de uma fatura — mora em `waCobranca.js`, reexportada aqui. */
export { chaveDaFatura };

/**
 * A etapa que vale para uma fatura com `dias` de atraso (negativo: a vencer).
 *
 * A de maior deslocamento que já chegou, e só do MESMO LADO do vencimento: uma
 * fatura vencida não recebe etapa de lembrete e uma a vencer não recebe etapa
 * de cobrança. As etapas que passaram sem sair NÃO são recuperadas em rajada —
 * quem entrou na régua no décimo dia recebe a etapa do décimo dia, e não as
 * quatro anteriores de uma vez.
 */
export function etapaDevida(steps, dias) {
  if (!Number.isInteger(dias)) return null;
  const candidatas = (steps || [])
    .filter((s) => (dias > 0 ? s.offsetDays > 0 : s.offsetDays <= 0))
    .filter((s) => s.offsetDays <= dias)
    .sort((a, b) => b.offsetDays - a.offsetDays);
  return candidatas[0] || null;
}

/**
 * Os modelos prontos do botão "Usar modelos prontos".
 *
 * Um provedor que abre a régua pela primeira vez não tem modelo nenhum, e uma
 * etapa sem modelo não salva. Estes são o ponto de partida: passam na mesma
 * validação de qualquer modelo (`WaTemplateService.validate`), obedecem à
 * regra dos espelhos — lembrete só cita `{{dias_para_vencer}}`, cobrança só
 * `{{dias_atraso}}`, "vence hoje" e o agradecimento nenhum dos dois — e são
 * só texto: o operador edita na aba Modelos como qualquer outro.
 *
 * Citam PIX, boleto e linha digitável juntos. Pela regra 1 de `waCobranca.js`
 * isso quer dizer que uma fatura sem um dos três no SGP fica de fora, com o
 * motivo "Faltou variável do modelo" — a prévia mostra quem, antes de ligar.
 *
 * Em português de propósito: o texto vai para o assinante, não para a tela.
 */
export const STARTER_TEMPLATES = Object.freeze([
  {
    offsetDays: -3,
    name: 'Régua · Lembrete (3 dias antes)',
    category: 'cobranca',
    body: 'Olá, {{nome}}! Passando para lembrar que sua fatura de {{valor}} vence em {{dias_para_vencer}} dias ({{vencimento}}).'
      + '\n\nPIX copia e cola:\n{{pix}}\n\nBoleto: {{link_boleto}}\nLinha digitável: {{linha_digitavel}}\n\nSe já pagou, desconsidere esta mensagem.'
  },
  {
    offsetDays: 0,
    name: 'Régua · Vence hoje',
    category: 'cobranca',
    body: 'Olá, {{nome}}! Sua fatura de {{valor}} vence hoje ({{vencimento}}). Pague agora e evite atrasos.'
      + '\n\nPIX copia e cola:\n{{pix}}\n\nBoleto: {{link_boleto}}\nLinha digitável: {{linha_digitavel}}\n\nSe já pagou, desconsidere esta mensagem.'
  },
  {
    offsetDays: 1,
    name: 'Régua · 1 dia de atraso',
    category: 'cobranca',
    body: 'Olá, {{nome}}. Não identificamos o pagamento da sua fatura de {{valor}}, vencida em {{vencimento}} ({{dias_atraso}} dia de atraso).'
      + '\n\nPIX copia e cola:\n{{pix}}\n\nBoleto: {{link_boleto}}\nLinha digitável: {{linha_digitavel}}\n\nSe já pagou, desconsidere esta mensagem.'
  },
  {
    offsetDays: 5,
    name: 'Régua · 5 dias de atraso',
    category: 'cobranca',
    body: 'Olá, {{nome}}. Sua fatura de {{valor}}, vencida em {{vencimento}}, está em aberto há {{dias_atraso}} dias. Regularize para manter sua internet funcionando normalmente.'
      + '\n\nPIX copia e cola:\n{{pix}}\n\nBoleto: {{link_boleto}}\nLinha digitável: {{linha_digitavel}}\n\nSe já pagou, desconsidere esta mensagem.'
  },
  {
    offsetDays: 10,
    name: 'Régua · 10 dias (aviso de suspensão)',
    category: 'cobranca',
    body: 'Olá, {{nome}}. Sua fatura de {{valor}}, vencida em {{vencimento}}, está em aberto há {{dias_atraso}} dias. Para evitar a suspensão da sua conexão, faça o pagamento o quanto antes.'
      + '\n\nPIX copia e cola:\n{{pix}}\n\nBoleto: {{link_boleto}}\nLinha digitável: {{linha_digitavel}}\n\nSe já pagou, desconsidere esta mensagem.'
  },
  {
    offsetDays: 20,
    name: 'Régua · 20 dias (último aviso)',
    category: 'cobranca',
    body: 'Olá, {{nome}}. ÚLTIMO AVISO: sua fatura de {{valor}}, vencida em {{vencimento}}, está em aberto há {{dias_atraso}} dias e sua conexão está sujeita a suspensão. Pague agora ou fale com a gente para negociar.'
      + '\n\nPIX copia e cola:\n{{pix}}\n\nBoleto: {{link_boleto}}\nLinha digitável: {{linha_digitavel}}\n\nSe já pagou, desconsidere esta mensagem.'
  },
  {
    offsetDays: null,
    name: 'Régua · Agradecimento',
    category: 'geral',
    body: 'Olá, {{nome}}! Recebemos o pagamento da sua fatura de {{valor}} (vencimento {{vencimento}}). Obrigado por estar com a gente!'
  }
]);

class WaDunningService {
  /** Passadas em andamento, por provedor. */
  static running = new Set();

  /**
   * A prévia de cada provedor: `{ status, checked, total, startedAt, finishedAt, result, error }`.
   * Em memória de propósito — é o resultado de um clique, não um registro, e
   * um restart no meio só pede outro clique.
   */
  static previews = new Map();

  // ── A configuração ─────────────────────────────────────────────────

  static async getRule() {
    const base = padroes();
    let salvo = {};
    try {
      salvo = JSON.parse((await AppState.get(CONFIG_KEY)) || '{}') || {};
    } catch {
      salvo = {};
    }
    return {
      ...base,
      ...salvo,
      steps: Array.isArray(salvo.steps) ? salvo.steps : base.steps,
      window: lerJanela(salvo.window) || base.window
    };
  }

  static async writeRule(rule) {
    await AppState.upsert(CONFIG_KEY, JSON.stringify(rule));
  }

  /**
   * Grava etapas, janela e limites. NÃO liga a régua.
   *
   * Uma régua ligada continua ligada depois de salva — mas só se o que foi
   * salvo continua enviável; senão ela desliga, e a resposta diz isso. Uma
   * régua ligada com um modelo apagado recusaria cada envio em silêncio.
   */
  static async saveRule(input = {}) {
    const atual = await this.getRule();
    const steps = await this.readSteps(input.steps ?? atual.steps);
    const window = input.window === undefined ? atual.window : lerJanela(input.window);
    if (!window) throw invalido('invalid_window');

    const maxPerInvoice = input.maxPerInvoice === undefined ? atual.maxPerInvoice
      : inteiro(input.maxPerInvoice, { min: 1, max: MAX_PER_INVOICE_LIMIT, code: 'invalid_max_per_invoice' });
    const minIntervalHours = input.minIntervalHours === undefined ? atual.minIntervalHours
      : inteiro(input.minIntervalHours, { min: 0, max: MIN_INTERVAL_LIMIT_HOURS, code: 'invalid_min_interval' });
    const maxPerRun = input.maxPerRun === undefined ? atual.maxPerRun
      : inteiro(input.maxPerRun, { min: 1, max: MAX_PER_RUN_LIMIT, code: 'invalid_max_per_run' });
    const receiptPauseDays = input.receiptPauseDays === undefined ? atual.receiptPauseDays
      : inteiro(input.receiptPauseDays, { min: 0, max: RECEIPT_PAUSE_MAX_DAYS, code: 'invalid_receipt_pause' });

    let thanksTemplateId = input.thanksTemplateId === undefined ? atual.thanksTemplateId : input.thanksTemplateId;
    if (thanksTemplateId === '' || thanksTemplateId === null) thanksTemplateId = null;
    else thanksTemplateId = await this.readThanksTemplate(thanksTemplateId);

    const rule = {
      ...atual,
      steps,
      window,
      maxPerInvoice,
      minIntervalHours,
      maxPerRun,
      receiptPauseDays,
      thanksTemplateId,
      enabled: atual.enabled && steps.length > 0,
      updatedAt: new Date().toISOString()
    };
    await this.writeRule(rule);
    return rule;
  }

  /** As etapas, validadas contra os modelos que existem hoje. */
  static async readSteps(raw) {
    if (!Array.isArray(raw)) throw invalido('invalid_steps');
    if (raw.length > MAX_STEPS) throw invalido('too_many_steps', { max: MAX_STEPS });
    const vistos = new Set();
    const steps = [];
    for (const entrada of raw) {
      const offsetDays = inteiro(entrada?.offsetDays, { min: OFFSET_MIN, max: OFFSET_MAX, code: 'invalid_offset' });
      if (vistos.has(offsetDays)) throw invalido('duplicate_offset', { offset: offsetDays });
      vistos.add(offsetDays);
      // eslint-disable-next-line no-await-in-loop -- no máximo doze etapas
      const template = await WaTemplate.getById(Number(entrada?.templateId));
      if (!template || !template.active) throw invalido('step_template_missing', { offset: offsetDays });
      // O modelo se autodeclara (`waCobranca.js`): citar `dias_para_vencer` é
      // ser lembrete. Uma etapa depois do vencimento com um lembrete nunca
      // renderia, e uma antes com `dias_atraso` também não — recusado aqui
      // para não virar um `templateIncomplete` por assinante, todo dia.
      const lembrete = modeloEhLembrete(template.body);
      const citaAtraso = /\{\{\s*dias_atraso\s*\}\}/.test(template.body);
      if (offsetDays > 0 && lembrete) throw invalido('step_needs_dunning', { offset: offsetDays });
      if (offsetDays <= 0 && citaAtraso) throw invalido('step_needs_reminder', { offset: offsetDays });
      steps.push({ offsetDays, templateId: template.id });
    }
    return steps.sort((a, b) => a.offsetDays - b.offsetDays);
  }

  /** O agradecimento não pode citar dia nenhum: a fatura dele está paga. */
  static async readThanksTemplate(raw) {
    const template = await WaTemplate.getById(Number(raw));
    if (!template || !template.active) throw invalido('thanks_template_missing');
    if (/\{\{\s*(dias_atraso|dias_para_vencer)\s*\}\}/.test(template.body)) {
      throw invalido('thanks_template_days');
    }
    return template.id;
  }

  /**
   * Cria os modelos prontos e, numa régua ainda sem etapas, preenche as etapas
   * e o agradecimento com eles. NÃO liga a régua.
   *
   * Um modelo com o mesmo nome que já existe é reaproveitado e nunca
   * sobrescrito: o operador pode ter editado o texto, e apertar o botão de
   * novo não pode desfazer isso. Uma régua que já tem etapas também fica como
   * está — o botão só cria os modelos, e quem quiser usá-los escolhe na tela.
   *
   * @returns {Promise<{ created: number, reused: number, stepsFilled: boolean, rule: object }>}
   */
  static async installStarter() {
    let created = 0;
    let reused = 0;
    const ids = new Map();
    for (const starter of STARTER_TEMPLATES) {
      // eslint-disable-next-line no-await-in-loop -- sete modelos
      const existing = await WaTemplate.getByName(starter.name);
      if (existing) {
        reused += 1;
        ids.set(starter.name, existing);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- idem
      const template = await WaTemplateService.create({
        name: starter.name, body: starter.body, category: starter.category
      });
      created += 1;
      ids.set(starter.name, template);
    }

    const atual = await this.getRule();
    let rule = atual;
    let stepsFilled = false;
    if (atual.steps.length === 0) {
      // Só os modelos ATIVOS e de lado certo entram: um reaproveitado que o
      // operador desativou, ou reescreveu citando o espelho errado, faria o
      // `saveRule` recusar a régua inteira por causa de uma etapa.
      const steps = [];
      for (const starter of STARTER_TEMPLATES) {
        const template = ids.get(starter.name);
        if (starter.offsetDays === null || !template || !template.active) continue;
        const lembrete = modeloEhLembrete(template.body);
        const citaAtraso = /\{\{\s*dias_atraso\s*\}\}/.test(template.body);
        if (starter.offsetDays > 0 && lembrete) continue;
        if (starter.offsetDays <= 0 && citaAtraso) continue;
        steps.push({ offsetDays: starter.offsetDays, templateId: template.id });
      }
      const thanks = ids.get(STARTER_TEMPLATES.find((t) => t.offsetDays === null).name);
      const thanksOk = thanks && thanks.active && !/\{\{\s*(dias_atraso|dias_para_vencer)\s*\}\}/.test(thanks.body);
      rule = await this.saveRule({
        steps,
        ...(atual.thanksTemplateId ? {} : { thanksTemplateId: thanksOk ? thanks.id : null })
      });
      stepsFilled = steps.length > 0;
    }
    return { created, reused, stepsFilled, rule };
  }

  /** Liga ou desliga. Ligar exige etapas e o WhatsApp de cobrança pronto. */
  static async setEnabled(enabled, userId = null) {
    const rule = await this.getRule();
    if (enabled) {
      if (rule.steps.length === 0) throw invalido('no_steps');
      // As etapas são relidas: um modelo pode ter sido apagado ou desativado
      // desde que a régua foi salva.
      rule.steps = await this.readSteps(rule.steps);
      await this.requireSender();
    }
    const next = {
      ...rule,
      enabled: enabled === true,
      enabledAt: enabled ? new Date().toISOString() : rule.enabledAt,
      enabledBy: enabled ? userId : rule.enabledBy
    };
    await this.writeRule(next);
    return next;
  }

  static async lastRun() {
    try {
      return JSON.parse((await AppState.get(LAST_RUN_KEY)) || 'null');
    } catch {
      return null;
    }
  }

  /** A régua como a tela a vê. */
  static async publicRule() {
    const rule = await this.getRule();
    return {
      enabled: rule.enabled === true,
      steps: rule.steps,
      maxPerInvoice: rule.maxPerInvoice,
      minIntervalHours: rule.minIntervalHours,
      maxPerRun: rule.maxPerRun,
      receiptPauseDays: rule.receiptPauseDays,
      thanksTemplateId: rule.thanksTemplateId,
      window: rule.window,
      enabledAt: rule.enabledAt,
      updatedAt: rule.updatedAt,
      inWindowNow: dentroDaJanela(rule.window, new Date()),
      running: this.running.has(currentTenantId()),
      lastRun: await this.lastRun()
    };
  }

  // ── A passada ──────────────────────────────────────────────────────

  /** O número de cobrança conectado, ou a recusa que a tela sabe explicar. */
  static async requireSender() {
    const config = await WhatsAppConfigService.getConfig();
    if (!WhatsAppConfigService.isReady(config)) {
      throw new WaError('whatsapp.error.notConfigured', { code: 'not_configured', status: 409 });
    }
    const account = await WhatsAppAccount.getForPurpose('billing');
    if (!account) throw new WaError('whatsapp.error.noAccount', { code: 'no_account', status: 409 });
    SgpService.requireReady(await SgpService.getConfig());
    return account;
  }

  /**
   * Se a passada automática deve rodar agora. Chamado pelo agendador, uma vez
   * por minuto, por provedor; responde barato quando a resposta é não.
   */
  static async due(lastRunAt, now = new Date()) {
    const rule = await this.getRule();
    if (!rule.enabled || rule.steps.length === 0) return false;
    if (!dentroDaJanela(rule.window, now)) return false;
    if (!lastRunAt) return true;
    const last = Date.parse(lastRunAt);
    return !Number.isFinite(last) || now.getTime() - last >= RUN_INTERVAL_MS;
  }

  /**
   * Uma passada. Com `dryRun`, só responde quem receberia o quê.
   *
   * Nunca roda duas vezes ao mesmo tempo para o mesmo provedor: o botão
   * "Rodar agora" e o agendador podem coincidir, e o índice único já impediria
   * a mensagem dobrada — a trava é para não gastar duas vezes o SGP.
   */
  /**
   * As recusas de uma passada de verdade, sem fazê-la — para o botão "Rodar
   * agora" poder responder o motivo antes de a passada ir para o fundo.
   *
   * @returns {Promise<{ rule: object, account: object }>}
   */
  static async assertCanRun(now = new Date()) {
    const rule = await this.getRule();
    if (!rule.enabled) throw invalido('rule_disabled');
    if (rule.steps.length === 0) throw invalido('no_steps');
    if (!dentroDaJanela(rule.window, now)) throw invalido('outside_window');
    if (this.running.has(currentTenantId())) throw invalido('already_running');
    const account = await this.requireSender();
    return { rule, account };
  }

  /**
   * Começa a prévia em segundo plano e responde na hora.
   *
   * As recusas que dá para saber sem ir ao SGP — régua sem etapa, SGP
   * desligado — saem daqui mesmo, como erro da requisição. Uma prévia que já
   * está rodando não começa outra: devolve a que está em andamento.
   */
  static async startPreview(now = new Date()) {
    const tenantId = currentTenantId();
    const atual = this.previews.get(tenantId);
    if (atual?.status === 'running') return atual;

    const rule = await this.getRule();
    if (rule.steps.length === 0) throw invalido('no_steps');
    SgpService.requireReady(await SgpService.getConfig());

    const state = { status: 'running', checked: 0, total: null, startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
    this.previews.set(tenantId, state);
    void this.run({
      dryRun: true,
      now,
      onProgress: ({ checked, total }) => {
        state.checked = checked;
        if (total !== undefined) state.total = total;
      }
    }).then((result) => {
      state.status = 'done';
      state.result = result;
      state.checked = result.checked;
    }).catch((error) => {
      console.warn(`[wa] régua: prévia falhou: ${error.code || error.message}`);
      state.status = 'failed';
      state.error = error;
    }).finally(() => {
      state.finishedAt = new Date().toISOString();
    });
    return state;
  }

  /** A prévia deste provedor, ou `null` se nenhuma foi pedida desde o último restart. */
  static getPreview() {
    return this.previews.get(currentTenantId()) || null;
  }

  static async run({ dryRun = false, manual = false, now = new Date(), onProgress = null } = {}) {
    let rule;
    let account = null;
    if (dryRun) {
      rule = await this.getRule();
      if (rule.steps.length === 0) throw invalido('no_steps');
      SgpService.requireReady(await SgpService.getConfig());
    } else {
      ({ rule, account } = await this.assertCanRun(now));
    }

    const tenantId = currentTenantId();
    if (!dryRun) {
      if (this.running.has(tenantId)) throw invalido('already_running');
      this.running.add(tenantId);
    }
    try {
      const summary = await this.pass({ rule, account, dryRun, now, onProgress });
      if (!dryRun) {
        await AppState.upsert(LAST_RUN_KEY, JSON.stringify({
          at: now.toISOString(),
          manual,
          checked: summary.checked,
          queued: summary.queued,
          paid: summary.paid,
          thanked: summary.thanked,
          skipped: summary.skipped,
          truncated: summary.truncated
        }));
      }
      return summary;
    } finally {
      if (!dryRun) this.running.delete(tenantId);
    }
  }

  static async pass({ rule, account, dryRun, now, onProgress = null }) {
    const templates = await this.loadTemplates(rule);
    const reminders = rule.steps.some((s) => s.offsetDays <= 0);
    const summary = {
      checked: 0,
      queued: 0,
      paid: 0,
      thanked: 0,
      truncated: false,
      skipped: Object.fromEntries(SKIP_REASONS.map((k) => [k, 0])),
      items: []
    };

    let subscribers = await WaBillingService.subscribers();
    if (dryRun && subscribers.length > PREVIEW_CONTRACTS) {
      subscribers = subscribers.slice(0, PREVIEW_CONTRACTS);
      summary.truncated = true;
    }

    onProgress?.({ checked: 0, total: subscribers.length });
    const blocked = await WaOptOut.activePhones(subscribers.map((s) => s.phone).filter(Boolean), 'billing');
    const open = await this.openSendsByContract();
    const pausados = await this.pausedContracts(now);
    let calls = 0;

    for (const subscriber of subscribers) {
      if (!dryRun && summary.queued >= rule.maxPerRun) {
        summary.truncated = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- uma ida ao SGP por contrato, no ritmo de WaBillingService
      const invoices = await WaBillingService.pacedInvoices(subscriber.contract, calls++ > 0);
      summary.checked += 1;
      onProgress?.({ checked: summary.checked });
      if (invoices === null) {
        summary.skipped.sgpRefused += 1;
        continue;
      }

      // Faturas que tinham cobrança e sumiram das em aberto: pagas, ou
      // canceladas. Quem decide é a lista completa, em `detectPayments`.
      const abertas = new Set(invoices.map(chaveDaFatura));
      const pendentes = open.get(subscriber.contract) || [];
      if (!dryRun && pendentes.some((key) => !abertas.has(key))) {
        // eslint-disable-next-line no-await-in-loop -- raro: só quando uma fatura cobrada sumiu
        summary.paid += await this.detectPayments(subscriber.contract, now);
      }

      const { fatura } = maisAntigaEmAberto(invoices, now, reminders);
      if (!fatura) continue;
      const dias = diasEntre(fatura.dueDate, now);
      const step = etapaDevida(rule.steps, dias);
      if (!step) continue;

      // O cliente mandou comprovante (ou alguém pausou): nada se grava, e a
      // etapa continua devida para a primeira passada depois da pausa.
      if (pausados.has(subscriber.contract)) {
        summary.skipped.paused += 1;
        if (dryRun) {
          summary.items.push({
            contract: subscriber.contract,
            clientName: subscriber.clientName,
            phone: subscriber.phone,
            dueDate: fatura.dueDate ? String(fatura.dueDate).slice(0, 10) : null,
            amount: fatura.amount ?? null,
            daysOverdue: dias,
            stepOffset: step.offsetDays,
            templateName: templates.get(step.templateId)?.name ?? null,
            status: 'deferred',
            reason: 'paused',
            missing: []
          });
        }
        continue;
      }

      // eslint-disable-next-line no-await-in-loop -- uma decisão por contrato
      const outcome = await this.decide({
        rule, step, fatura, dias, subscriber, template: templates.get(step.templateId),
        blocked, account, dryRun, now
      });
      if (!outcome) continue;
      if (outcome.status === 'queued') summary.queued += 1;
      else if (outcome.reason) summary.skipped[outcome.reason] += 1;
      if (dryRun) summary.items.push(outcome.item);
    }

    if (!dryRun) summary.thanked = await this.sendThanks({ rule, account, now });
    return summary;
  }

  /**
   * O que fazer com UMA fatura nesta passada.
   *
   * @returns {Promise<{status: string, reason?: string, item?: object}|null>}
   *   `null` quando não há nada a fazer — a etapa já saiu, ou uma posterior.
   */
  static async decide({ rule, step, fatura, dias, subscriber, template, blocked, account, dryRun, now }) {
    const invoiceKey = chaveDaFatura(fatura);
    const anteriores = await tdb('wa_dunning_sends')
      .where({ contract: subscriber.contract, invoice_key: invoiceKey, kind: 'step' })
      .select('step_offset', 'status', 'created_at');
    // Já decidida para esta etapa ou uma posterior — inclusive pulada: um
    // "não perturbe" de ontem não vira mensagem hoje por outra porta.
    if (anteriores.some((row) => Number(row.step_offset) >= step.offsetDays)) return null;

    const item = {
      contract: subscriber.contract,
      clientName: subscriber.clientName,
      phone: subscriber.phone,
      dueDate: fatura.dueDate ? String(fatura.dueDate).slice(0, 10) : null,
      amount: fatura.amount ?? null,
      daysOverdue: dias,
      stepOffset: step.offsetDays,
      templateName: template?.name ?? null,
      status: 'queued',
      reason: null,
      missing: []
    };
    const skip = (reason, missing = []) => ({ status: 'skipped', reason, item: { ...item, status: 'skipped', reason, missing } });

    const enviadas = anteriores.filter((row) => row.status === 'queued').length;
    let result = null;
    if (!subscriber.phone) result = skip('noPhone');
    else if (blocked.has(subscriber.phone)) result = skip('optOut');
    else if (enviadas >= rule.maxPerInvoice) result = skip('maxReached');

    let body = null;
    let metaTemplate = null;
    if (!result) {
      const vars = variaveisDeCobranca(fatura, subscriber.clientName, now);
      body = template ? renderCobranca(template.body, vars) : null;
      // Sem modelo, a lista fica vazia e o rótulo continua o genérico.
      if (body === null) result = skip('templateIncomplete', template ? variaveisVazias(template.body, vars) : []);
      else {
        // O modelo da Meta para número oficial fora da janela, com as mesmas
        // variáveis. Variável vazia lá também pula, com o mesmo motivo.
        metaTemplate = WaMetaTemplateService.buildPayload(template, vars, body);
        if (metaTemplate?.incomplete) result = skip('templateIncomplete', metaTemplate.incomplete);
      }
    }

    // O intervalo mínimo é por CONTRATO, não por fatura: duas faturas em
    // atraso não viram duas mensagens no mesmo dia. Não grava nada — a etapa
    // continua devida e sai na primeira passada depois do intervalo.
    if (!result && rule.minIntervalHours > 0 && await this.sentRecently(subscriber.contract, rule.minIntervalHours, now)) {
      return { status: 'deferred', reason: 'interval', item: { ...item, status: 'deferred', reason: 'interval' } };
    }

    if (dryRun) return result || { status: 'queued', item };

    const row = {
      kind: 'step',
      step_offset: step.offsetDays,
      contract: subscriber.contract,
      invoice_key: invoiceKey,
      due_date: item.dueDate,
      amount: fatura.amount ?? null,
      client_name: subscriber.clientName ? String(subscriber.clientName).slice(0, 255) : null,
      phone_e164: subscriber.phone || null,
      template_id: template?.id ?? null,
      status: result ? 'skipped' : 'queued',
      reason: result ? REASON_COLUMN[result.reason] : null,
      reason_detail: detalhe(result?.item?.missing),
      created_at: now,
      updated_at: now
    };
    const sendId = await this.claim(row);
    // Outra passada chegou primeiro. Não é erro: é o índice fazendo o trabalho.
    if (!sendId) return null;
    if (result) return result;

    try {
      const message = await this.enqueue({ account, subscriber, body, metaTemplate });
      await tdb('wa_dunning_sends').where({ id: sendId }).update({ message_id: message.id, updated_at: new Date() });
      return { status: 'queued', item };
    } catch (error) {
      // A linha fica como pulada, com o motivo: sem ela a etapa seria tentada
      // de novo a cada passada, e o mesmo erro viraria ruído no histórico.
      console.warn(`[wa] régua: contrato ${subscriber.contract}: ${error.code || error.message}`);
      await tdb('wa_dunning_sends').where({ id: sendId })
        .update({ status: 'skipped', reason: String(error.code || 'send_failed').slice(0, 32), updated_at: new Date() });
      return null;
    }
  }

  /** Grava a decisão; `null` quando o índice único diz que já existe. */
  static async claim(row) {
    try {
      return await withDeadlockRetry(() => tinsertReturningId('wa_dunning_sends', row));
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /** Para a conversa do assinante, na fila de saída — quem envia é o outbox. */
  static async enqueue({ account, subscriber, body, metaTemplate = null }) {
    const number = normalizarTelefoneBr(subscriber.phone);
    if (!number) throw new WaError('whatsapp.error.noDestination', { code: 'no_destination', status: 409 });
    // O cadastro trocou de número: a conversa antiga sai do contrato e a
    // cobrança abre (ou reusa) a do número novo, que ganha o contrato abaixo.
    if (subscriber.contract) await WaConversationService.retireStaleBindings(subscriber.contract);
    const conversation = await WaConversation.ensure({
      accountId: account.id,
      externalThreadId: `${number}@s.whatsapp.net`,
      waPhone: number,
      pushName: subscriber.clientName || null
    });
    if (subscriber.contract && !conversation.contract) {
      await WaConversation.update(conversation.id, { contract: subscriber.contract });
    }
    // 'campaign' e não um valor novo: é o que diz ao teto do bot que esta
    // mensagem não é resposta dele.
    return WaSendService.enqueue({ conversationId: conversation.id, body, source: 'campaign', metaTemplate });
  }

  static async sentRecently(contract, hours, now) {
    const desde = new Date(now.getTime() - hours * 3600_000);
    const row = await tdb('wa_dunning_sends')
      .where({ contract, status: 'queued' })
      .where('created_at', '>', desde)
      .first('id');
    return !!row;
  }

  static async loadTemplates(rule) {
    const ids = [...new Set(rule.steps.map((s) => s.templateId))];
    const rows = ids.length ? await tdb('wa_templates').whereIn('id', ids).where({ active: true }) : [];
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** As faturas com cobrança enviada e ainda não dadas como pagas, por contrato. */
  static async openSendsByContract() {
    const rows = await tdb('wa_dunning_sends')
      .where({ kind: 'step', status: 'queued' })
      .whereNull('paid_at')
      .distinct('contract', 'invoice_key');
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.contract)) map.set(row.contract, []);
      map.get(row.contract).push(row.invoice_key);
    }
    return map;
  }

  // ── Pagamento ──────────────────────────────────────────────────────

  /**
   * Confere no SGP quais faturas cobradas deste contrato foram pagas.
   *
   * Pela lista COMPLETA, e não pela em aberto: sumir das em aberto também é o
   * que acontece com uma fatura cancelada, e cancelada não rende
   * "recebemos seu pagamento".
   *
   * Para cada fatura paga: a data fica marcada, e a mensagem que ainda não
   * saiu da fila é retirada dela — a remoção é condicional ao estado
   * `queued`, então uma que o outbox já pegou segue o seu caminho.
   *
   * @returns {Promise<number>} faturas dadas como pagas agora
   */
  static async detectPayments(contract, now = new Date()) {
    const key = String(contract ?? '').trim();
    if (!key) return 0;
    const pendentes = await tdb('wa_dunning_sends')
      .where({ contract: key, kind: 'step' })
      .whereNull('paid_at')
      .select('id', 'invoice_key', 'message_id', 'status');
    if (pendentes.length === 0) return 0;

    let invoices;
    try {
      ({ invoices } = await SgpService.listInvoices({ contract: key, onlyOpen: false }));
    } catch (error) {
      if (error instanceof SgpError) return 0;
      throw error;
    }
    const pagas = new Set(invoices.filter((f) => f.paid).map(chaveDaFatura));
    const alvo = pendentes.filter((row) => pagas.has(row.invoice_key));
    if (alvo.length === 0) return 0;

    for (const row of alvo) {
      // eslint-disable-next-line no-await-in-loop -- poucas linhas por contrato
      await this.cancelQueued(row, now);
    }
    return new Set(alvo.map((row) => row.invoice_key)).size;
  }

  static async cancelQueued(row, now) {
    const retirada = await this.withdraw(row);
    await tdb('wa_dunning_sends').where({ id: row.id }).update({
      paid_at: now,
      ...(retirada ? { status: 'canceled', reason: 'paid', message_id: null } : {}),
      updated_at: now
    });
  }

  /** Apaga a mensagem da fila, se ela ainda não saiu. */
  static async withdraw(row) {
    if (!row.message_id) return false;
    return (await tdb('wa_messages')
      .where({ id: row.message_id, delivery_status: 'queued' })
      .del()) > 0;
  }

  /**
   * Retira da fila, sem dar a fatura como paga: a etapa fica decidida, como
   * já acontece com a que o pagamento cancelou — não volta a ser cobrada.
   */
  static async cancelWithReason(row, reason, now = new Date()) {
    if (!await this.withdraw(row)) return false;
    await tdb('wa_dunning_sends').where({ id: row.id })
      .update({ status: 'canceled', reason, message_id: null, updated_at: now });
    return true;
  }

  // ── Conferência na saída ───────────────────────────────────────────

  /**
   * A mensagem da régua ainda deve sair? Perguntado pelo outbox na hora do
   * envio, porque entre a passada e a saída podem correr horas: o cliente
   * mandou o comprovante, ou o SGP deu a baixa.
   *
   * `false` quer dizer que a mensagem foi retirada da fila. Uma mensagem que
   * não é da régua, ou um SGP que não responde, deixa sair — a passada já viu
   * a fatura em aberto, e uma queda do ERP não pode travar a régua.
   */
  static async stillDue(messageId, now = new Date()) {
    try {
      const row = await tdb('wa_dunning_sends')
        .where({ message_id: messageId, kind: 'step', status: 'queued' })
        .first('id', 'contract', 'invoice_key', 'message_id');
      if (!row) return true;
      if ((await this.pausedContracts(now, [row.contract])).has(row.contract)) {
        return !await this.cancelWithReason(row, 'paused', now);
      }
      const invoices = await WaBillingService.pacedInvoices(row.contract, false);
      if (invoices === null) return true;
      if (invoices.some((f) => chaveDaFatura(f) === row.invoice_key)) return true;
      // Saiu das em aberto: paga (marca e agradece pelo caminho de sempre)
      // ou cancelada (só retira).
      await this.detectPayments(row.contract, now);
      const depois = await tdb('wa_dunning_sends').where({ id: row.id }).first('status');
      if (depois?.status === 'queued') return !await this.cancelWithReason(row, 'paid', now);
      return false;
    } catch (error) {
      console.warn(`[wa] régua: conferência na saída da mensagem ${messageId}: ${error.message}`);
      return true;
    }
  }

  // ── Pausa por comprovante ──────────────────────────────────────────

  /** Os contratos com a régua parada agora (opcionalmente só entre `contracts`). */
  static async pausedContracts(now = new Date(), contracts = null) {
    const q = tdb('wa_dunning_pauses').where('until', '>', now);
    if (contracts) q.whereIn('contract', contracts.map(String));
    return new Set((await q.pluck('contract')).map(String));
  }

  /** A pausa ativa de um contrato, para a tela; `null` sem nenhuma. */
  static async pauseFor(contract, now = new Date()) {
    const key = String(contract ?? '').trim();
    if (!key) return null;
    const row = await tdb('wa_dunning_pauses').where({ contract: key }).where('until', '>', now).first();
    if (!row) return null;
    return { contract: key, until: new Date(row.until).toISOString(), reason: row.reason };
  }

  /** Para a régua de um contrato até `until`. Nunca encurta uma pausa maior. */
  static async pause({ contract, until, reason, conversationId = null, messageId = null, userId = null, now = new Date() }) {
    const key = String(contract ?? '').trim();
    if (!key) return null;
    const atual = await tdb('wa_dunning_pauses').where({ contract: key }).first();
    if (atual) {
      const fim = new Date(Math.max(new Date(atual.until).getTime(), until.getTime()));
      await tdb('wa_dunning_pauses').where({ id: atual.id }).update({
        until: fim, reason, conversation_id: conversationId, message_id: messageId, created_by: userId, updated_at: now
      });
    } else {
      try {
        await tinsertReturningId('wa_dunning_pauses', {
          contract: key, until, reason, conversation_id: conversationId, message_id: messageId,
          created_by: userId, created_at: now, updated_at: now
        });
      } catch (error) {
        // Dois comprovantes juntos: o outro gravou primeiro, e vale o mesmo.
        if (!isUniqueViolation(error)) throw error;
      }
    }
    // O que já estava na fila para este contrato não sai.
    const naFila = await tdb('wa_dunning_sends')
      .where({ contract: key, kind: 'step', status: 'queued' })
      .whereNotNull('message_id')
      .select('id', 'message_id');
    let retiradas = 0;
    for (const row of naFila) {
      // eslint-disable-next-line no-await-in-loop -- poucas linhas por contrato
      if (await this.cancelWithReason(row, 'paused', now)) retiradas += 1;
    }
    return { contract: key, until: until.toISOString(), withdrawn: retiradas };
  }

  /** Retomar: a próxima passada volta a cobrar o contrato. */
  static async resume(contract) {
    const key = String(contract ?? '').trim();
    if (!key) return false;
    return (await tdb('wa_dunning_pauses').where({ contract: key }).del()) > 0;
  }

  /**
   * O cliente mandou imagem ou PDF numa conversa com contrato: pode ser o
   * comprovante. A régua para esse contrato por `receiptPauseDays` dias,
   * e a conversa ganha a nota e a etiqueta para alguém conferir no SGP.
   *
   * Nunca lança: a mensagem do cliente já está gravada.
   *
   * @returns {Promise<{contract: string, until: string}|null>}
   */
  static async pauseForReceipt({ conversation, messageId = null, mime, now = new Date() }) {
    try {
      if (!pareceComprovante(mime) || !conversation?.contract) return null;
      const rule = await this.getRule();
      const dias = Number(rule.receiptPauseDays) || 0;
      if (!rule.enabled || dias <= 0) return null;
      const until = new Date(now.getTime() + dias * DIA_MS);
      const feito = await this.pause({
        contract: conversation.contract, until, reason: 'receipt', conversationId: conversation.id, messageId, now
      });
      if (!feito) return null;
      const pausa = await this.pauseFor(conversation.contract, now);
      await this.noteReceipt(conversation, pausa?.until ?? feito.until);
      await WaTagService.tagReceipt(conversation.id);
      return { contract: feito.contract, until: pausa?.until ?? feito.until };
    } catch (error) {
      console.warn(`[wa] régua: pausa por comprovante: ${error.message}`);
      return null;
    }
  }

  /** A nota interna na conversa: só o atendente vê. */
  static async noteReceipt(conversation, until) {
    const t = translatorFor(DEFAULT_LOCALE);
    const quando = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit'
    }).format(new Date(until));
    await WaSendService.enqueue({
      conversationId: conversation.id,
      body: t('whatsapp.dunning.receiptNote', { contract: conversation.contract, until: quando }),
      isNote: true
    });
  }

  /**
   * O webhook de pagamento do SGP chegou para este contrato.
   *
   * Nunca lança: o evento do ERP tem o seu próprio ciclo de vida, e uma
   * régua mal configurada não pode deixá-lo preso em "pendente".
   */
  static async onPayment(contract) {
    try {
      const pagas = await this.detectPayments(contract);
      if (pagas === 0) return { paid: 0, thanked: 0 };
      const rule = await this.getRule();
      let thanked = 0;
      if (rule.enabled && rule.thanksTemplateId && dentroDaJanela(rule.window, new Date())) {
        const account = await WhatsAppAccount.getForPurpose('billing');
        if (account) thanked = await this.sendThanks({ rule, account, now: new Date(), contract });
      }
      return { paid: pagas, thanked };
    } catch (error) {
      console.warn(`[wa] régua: pagamento do contrato ${contract}: ${error.code || error.message}`);
      return { paid: 0, thanked: 0, error: error.code || error.message };
    }
  }

  /**
   * "Recebemos seu pagamento", uma vez por fatura paga que foi cobrada.
   *
   * Só para quem de fato recebeu cobrança (status `queued`) e pagou há pouco:
   * ligar o agradecimento hoje não pode mandar mensagem por um boleto quitado
   * mês passado. Respeita o não-perturbe e a janela — quem chama já conferiu a
   * janela.
   */
  static async sendThanks({ rule, account, now, contract = null }) {
    if (!rule.thanksTemplateId || !account) return 0;
    const template = await WaTemplate.getById(rule.thanksTemplateId);
    if (!template || !template.active) return 0;

    const query = tdb('wa_dunning_sends')
      .where({ kind: 'step', status: 'queued' })
      .whereNotNull('paid_at')
      .where('paid_at', '>', new Date(now.getTime() - THANKS_WINDOW_MS))
      .select('contract', 'invoice_key', 'due_date', 'amount', 'client_name', 'phone_e164')
      .orderBy('id', 'desc');
    if (contract) query.where({ contract });
    const rows = await query;
    if (rows.length === 0) return 0;

    // Quem já foi agradecido, numa segunda leitura e não numa subconsulta: a
    // subconsulta nomearia a tabela sem o provedor, e a leitura escopada é
    // o que garante que só as linhas deste provedor entram na conta.
    const agradecidas = new Set((await tdb('wa_dunning_sends')
      .where({ kind: 'thanks' })
      .whereIn('contract', [...new Set(rows.map((r) => r.contract))])
      .select('contract', 'invoice_key'))
      .map((r) => `${r.contract}\u0000${r.invoice_key}`));

    const vistos = new Set();
    const alvo = rows.filter((row) => {
      const k = `${row.contract}\u0000${row.invoice_key}`;
      if (vistos.has(k) || agradecidas.has(k)) return false;
      vistos.add(k);
      return true;
    });
    if (alvo.length === 0) return 0;

    // O número de hoje, não o da cobrança: se o cadastro mudou entre a
    // cobrança e o pagamento, o obrigado vai para o número novo.
    for (const row of alvo) {
      // eslint-disable-next-line no-await-in-loop -- poucos pagamentos por passada
      const { current } = await WaConversationService.contractPhones(row.contract);
      if (current) row.phone_e164 = current;
    }
    const blocked = await WaOptOut.activePhones(alvo.map((r) => r.phone_e164).filter(Boolean), 'billing');
    let sent = 0;
    for (const row of alvo) {
      const fatura = { amount: row.amount === null ? null : Number(row.amount), dueDate: row.due_date, id: row.invoice_key };
      const vars = variaveisDeCobranca(fatura, row.client_name, now);
      const body = renderCobranca(template.body, vars);
      const metaTemplate = body === null ? null : WaMetaTemplateService.buildPayload(template, vars, body);
      const motivo = !row.phone_e164 ? 'no_phone'
        : blocked.has(row.phone_e164) ? 'opt_out'
          : body === null || metaTemplate?.incomplete ? 'template_incomplete' : null;
      // eslint-disable-next-line no-await-in-loop -- uma linha por pagamento
      const id = await this.claim({
        kind: 'thanks',
        step_offset: 0,
        contract: row.contract,
        invoice_key: row.invoice_key,
        due_date: row.due_date,
        amount: row.amount,
        client_name: row.client_name,
        phone_e164: row.phone_e164,
        template_id: template.id,
        status: motivo ? 'skipped' : 'queued',
        reason: motivo,
        reason_detail: motivo === 'template_incomplete' ? detalhe(variaveisVazias(template.body, vars)) : null,
        paid_at: now,
        created_at: now,
        updated_at: now
      });
      if (!id || motivo) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- idem
        const message = await this.enqueue({
          account, subscriber: { contract: row.contract, clientName: row.client_name, phone: row.phone_e164 }, body, metaTemplate
        });
        // eslint-disable-next-line no-await-in-loop -- idem
        await tdb('wa_dunning_sends').where({ id }).update({ message_id: message.id, updated_at: new Date() });
        sent += 1;
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop -- idem
        await tdb('wa_dunning_sends').where({ id })
          .update({ status: 'skipped', reason: String(error.code || 'send_failed').slice(0, 32), updated_at: new Date() });
      }
    }
    return sent;
  }

  // ── Histórico e resultado ──────────────────────────────────────────

  static async listSends({ contract, status, kind, limit, offset } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = Math.max(Number(offset) || 0, 0);
    const query = tdb('wa_dunning_sends')
      .orderBy('id', 'desc')
      .limit(cap + 1)
      .offset(skip);
    const needle = String(contract ?? '').trim();
    if (needle) query.where({ contract: needle });
    if (['queued', 'skipped', 'canceled'].includes(status)) query.where({ status });
    // "Falhou" não é um estado da linha: é a entrega da mensagem que ela gerou.
    if (status === 'failed') {
      query.whereIn('message_id', tdb('wa_messages').where({ delivery_status: 'failed' }).select('id'));
    }
    if (['step', 'thanks'].includes(kind)) query.where({ kind });
    const rows = (await query).slice(0, cap + 1);
    const pagina = rows.slice(0, cap);
    const mensagens = await this.messagesById(pagina.map((r) => r.message_id));
    const modelos = await this.templatesById(pagina.map((r) => r.template_id));
    const items = pagina.map((row) => publicSend({
      ...row,
      delivery_status: mensagens.get(row.message_id)?.delivery_status ?? null,
      template_name: modelos.get(row.template_id)?.name ?? null
    }));
    return { items, hasMore: rows.length > cap };
  }

  /** `wa_messages` por id, numa leitura escopada. */
  static async messagesById(ids) {
    const lista = [...new Set(ids.filter((id) => id !== null && id !== undefined))];
    if (lista.length === 0) return new Map();
    const rows = await tdb('wa_messages').whereIn('id', lista).select('id', 'delivery_status');
    return new Map(rows.map((r) => [r.id, r]));
  }

  static async templatesById(ids) {
    const lista = [...new Set(ids.filter((id) => id !== null && id !== undefined))];
    if (lista.length === 0) return new Map();
    const rows = await tdb('wa_templates').whereIn('id', lista).select('id', 'name');
    return new Map(rows.map((r) => [r.id, r]));

  }

  /**
   * O que a régua rendeu nos últimos `days` dias.
   *
   * "Recuperado" é fatura cobrada e depois paga — correlação, não prova: parte
   * dessas pessoas pagaria sem mensagem. É o número que o provedor pede, e a
   * tela diz o que ele é.
   */
  static async stats({ days } = {}) {
    const janela = Math.min(Math.max(Number(days) || 30, 1), 365);
    const desde = new Date(Date.now() - janela * 24 * 3600_000);
    const linhas = await tdb('wa_dunning_sends')
      .where('created_at', '>=', desde)
      .select('kind', 'step_offset', 'status', 'reason', 'contract', 'invoice_key', 'amount', 'paid_at', 'message_id');
    const mensagens = await this.messagesById(linhas.map((r) => r.message_id));
    const rows = linhas.map((row) => ({ ...row, delivery_status: mensagens.get(row.message_id)?.delivery_status ?? null }));

    const byStep = new Map();
    const faturas = new Map();
    const skipped = {};
    let thanks = 0;
    let failed = 0;
    let queued = 0;
    for (const row of rows) {
      if (row.kind === 'thanks') {
        if (row.status === 'queued') thanks += 1;
        continue;
      }
      if (row.status === 'skipped') {
        const reason = row.reason || 'other';
        skipped[reason] = (skipped[reason] || 0) + 1;
        continue;
      }
      if (row.status !== 'queued' && row.status !== 'canceled') continue;
      const offset = Number(row.step_offset);
      const step = byStep.get(offset) || { offsetDays: offset, sent: 0, paidAfter: 0 };
      if (row.status === 'queued') {
        step.sent += 1;
        queued += 1;
        if (row.delivery_status === 'failed') failed += 1;
      }
      if (row.paid_at) step.paidAfter += 1;
      byStep.set(offset, step);

      const k = `${row.contract}\u0000${row.invoice_key}`;
      const f = faturas.get(k) || { amount: Number(row.amount) || 0, paid: false };
      if (row.paid_at) f.paid = true;
      faturas.set(k, f);
    }
    const cobradas = [...faturas.values()];
    const pagas = cobradas.filter((f) => f.paid);
    return {
      days: janela,
      messages: queued,
      failed,
      thanks,
      invoices: cobradas.length,
      invoicesPaid: pagas.length,
      amountCharged: round2(cobradas.reduce((s, f) => s + f.amount, 0)),
      amountRecovered: round2(pagas.reduce((s, f) => s + f.amount, 0)),
      recoveryRate: cobradas.length ? round2((pagas.length / cobradas.length) * 100) : 0,
      byStep: [...byStep.values()].sort((a, b) => a.offsetDays - b.offsetDays),
      skipped
    };
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function asIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Uma linha do histórico como a tela a vê, campo por campo. */
function publicSend(row) {
  return {
    id: row.id,
    kind: row.kind,
    stepOffset: Number(row.step_offset),
    contract: row.contract,
    invoiceKey: row.invoice_key,
    dueDate: row.due_date || null,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    clientName: row.client_name || null,
    phone: row.phone_e164 || null,
    templateName: row.template_name || null,
    status: row.status,
    reason: row.reason || null,
    missing: lerDetalhe(row.reason_detail),
    deliveryStatus: row.delivery_status || null,
    paidAt: asIso(row.paid_at),
    createdAt: asIso(row.created_at)
  };
}

export default WaDunningService;
