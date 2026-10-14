import AppState from '../models/AppState.js';
import { TenantCache } from '../config/tenantCache.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { createSecretBox } from '../utils/secretBox.js';
import { AI_DEFAULT_BASE_URL, AI_DEFAULT_MODEL, normalizeAiBaseUrl } from './waAiClient.js';
import { AI_PROVIDERS, AI_PROVIDER_OPENAI, aiProviderOrDefault, isAiProvider } from './waAiAdapters.js';

/** A chave da IA, cifrada num contexto só dela. */
const aiKeyBox = createSecretBox('skygenpanel-wa-ai-key-v1');
const AI_ERROR_KEY = 'wa_ai_last_error';
export const AI_INSTRUCTIONS_MAX = 4000;
const AI_MODEL_MAX = 64;

/**
 * O que o provedor ajusta no atendimento automático — a aba "Chatbot".
 *
 * Mora à parte da configuração do WhatsApp porque é outra conversa: aquela é
 * o servidor Evolution e o número; esta é o que o bot diz e quando. Os dois
 * interruptores que já existiam (`botEnabled`, `botUnlockEnabled`) continuam
 * guardados lá, onde o bot já os lê, e esta tela só os lê e grava por lá — uma
 * chave em dois lugares é como os dois discordam.
 */
const CONFIG_KEY = 'wa_bot_config';

/** Os textos que o provedor pode trocar. Só os SEM variável: um `{amount}` apagado sem querer vira uma fatura sem valor. */
export const EDITABLE_MESSAGES = Object.freeze([
  'greeting', 'askDocument', 'handoffQueued', 'handoff', 'notRecognised', 'noOpenInvoice', 'outsideHours',
  'surveyQuestion', 'surveyAskComment', 'surveyThanks'
]);

/** A chave de i18n do padrão de cada texto editável. */
const DEFAULT_KEYS = Object.freeze({
  greeting: 'whatsapp.bot.menuHeader',
  askDocument: 'whatsapp.bot.askDocument',
  handoffQueued: 'whatsapp.bot.handoffQueued',
  handoff: 'whatsapp.bot.handoff',
  notRecognised: 'whatsapp.bot.notRecognised',
  noOpenInvoice: 'whatsapp.bot.noOpenInvoice',
  outsideHours: 'whatsapp.bot.outsideHours',
  surveyQuestion: 'whatsapp.survey.question',
  surveyAskComment: 'whatsapp.survey.askComment',
  surveyThanks: 'whatsapp.survey.thanks'
});

const MESSAGE_MAX = 1000;
const OPTION_KEYS = Object.freeze(['invoice', 'signal', 'human', 'document']);
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Segunda a sexta 08–18, sábado 08–12, domingo fechado. `day` segue `Date#getDay`: 0 é domingo. */
function semanaPadrao() {
  return [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    closed: day === 0,
    open: '08:00',
    close: day === 6 ? '12:00' : '18:00'
  }));
}

function padroes() {
  return {
    options: Object.fromEntries(OPTION_KEYS.map((k) => [k, true])),
    messages: Object.fromEntries(EDITABLE_MESSAGES.map((k) => [k, ''])),
    hours: { enabled: false, timezone: 'America/Sao_Paulo', week: semanaPadrao() },
    // Desligada até o provedor ligar: é uma mensagem a mais para o cliente.
    satisfaction: { enabled: false },
    // A distribuição automática para quem está disponível. Desligada: atribuir
    // à mão (assumir, transferir) funciona sempre.
    distribution: { enabled: false },
    // Etiqueta automática: o que o cliente pediu ao bot vira etiqueta na
    // conversa. Os ids são preenchidos quando as etiquetas padrão nascem.
    autoTags: { enabled: true, invoice: null, signal: null },
    // Atendimento por IA (API compatível com OpenAI, como a z.ai). Desligado:
    // só liga com chave. `apiKey` é o texto cifrado, nunca a chave.
    ai: {
      enabled: false,
      suggest: false,
      provider: AI_PROVIDER_OPENAI,
      baseUrl: AI_DEFAULT_BASE_URL,
      model: AI_DEFAULT_MODEL,
      apiKey: null,
      instructions: ''
    }
  };
}

/**
 * O endereço pedido é o mesmo onde a chave foi salva? Comparado já
 * normalizado (host em minúsculas, sem barra final), e vazio é o salvo.
 */
export function mesmoEnderecoIa(pedido, salvo, provider = AI_PROVIDER_OPENAI) {
  if (pedido === undefined || pedido === null || String(pedido).trim() === '') return true;
  return normalizeAiBaseUrl(pedido, provider) === normalizeAiBaseUrl(salvo, provider);
}

/** A chave salva só vale para o endereço onde foi salva: trocar o endereço pede a chave de novo. */
export const chaveParaNovoEndereco = () => new WaError('whatsapp.ai.error.keyRequiredForNewUrl', {
  code: 'ai_key_required_for_new_url', status: 400
});

function lerIa(raw, atual) {
  if (raw === undefined) return atual;
  if (!raw || typeof raw !== 'object') throw invalido('whatsapp.error.invalidBotConfig', 'invalid_bot_ai');
  // Trocar o endereço sem mandar a chave levaria a chave salva para outro host.
  // Compara com o que vai ser gravado: vazio aqui vira o endereço padrão.
  const providerAtual = aiProviderOrDefault(atual.provider);
  if (raw.provider !== undefined && !isAiProvider(raw.provider)) {
    throw invalido('whatsapp.error.invalidBotConfig', 'invalid_bot_ai_provider');
  }
  const provider = raw.provider === undefined ? providerAtual : raw.provider;
  const trocouProvedor = provider !== providerAtual;
  // Trocar de provedor sem endereço novo volta ao endereço e ao modelo padrão do novo.
  const baseUrl = raw.baseUrl === undefined
    ? (trocouProvedor ? AI_PROVIDERS[provider].defaultBaseUrl : atual.baseUrl)
    : normalizeAiBaseUrl(raw.baseUrl, provider);
  // A chave salva é de outro serviço se o provedor ou o endereço mudou.
  if (raw.apiKey === undefined && atual.apiKey
    && (trocouProvedor || !mesmoEnderecoIa(baseUrl, atual.baseUrl, provider))) {
    throw chaveParaNovoEndereco();
  }
  let apiKey = atual.apiKey;
  if (raw.apiKey !== undefined) {
    const texto = String(raw.apiKey ?? '').trim();
    apiKey = texto ? { v: 1, ...aiKeyBox.encrypt(texto) } : null;
  }
  const modeloPadrao = AI_PROVIDERS[provider].defaultModel;
  const model = raw.model === undefined
    ? (trocouProvedor ? modeloPadrao : atual.model)
    : String(raw.model ?? '').trim() || modeloPadrao;
  if (model.length > AI_MODEL_MAX) throw invalido('whatsapp.error.invalidBotConfig', 'invalid_bot_ai');
  const instructions = raw.instructions === undefined ? atual.instructions : String(raw.instructions ?? '').trim();
  if (instructions.length > AI_INSTRUCTIONS_MAX) throw invalido('whatsapp.error.invalidBotConfig', 'bot_message_too_long');
  const proximo = {
    enabled: raw.enabled === undefined ? atual.enabled : raw.enabled === true,
    suggest: raw.suggest === undefined ? atual.suggest : raw.suggest === true,
    provider,
    baseUrl,
    model,
    apiKey,
    instructions
  };
  // Ligar sem chave seria uma IA que falha a cada mensagem.
  if ((proximo.enabled || proximo.suggest) && !proximo.apiKey) {
    throw invalido('whatsapp.ai.error.keyRequired', 'ai_key_required');
  }
  return proximo;
}

const idOuNulo = (valor, atual) => {
  if (valor === undefined) return atual;
  if (valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw invalido('whatsapp.error.invalidBotConfig', 'invalid_bot_auto_tags');
  return n;
};

function lerAutoTags(raw, atual) {
  if (raw === undefined) return atual;
  if (!raw || typeof raw !== 'object') throw invalido('whatsapp.error.invalidBotConfig', 'invalid_bot_auto_tags');
  return {
    enabled: raw.enabled === undefined ? atual.enabled : raw.enabled === true,
    invoice: idOuNulo(raw.invoice, atual.invoice),
    signal: idOuNulo(raw.signal, atual.signal)
  };
}

function lerDistribuicao(raw, atual) {
  if (raw === undefined) return atual;
  if (!raw || typeof raw !== 'object') throw invalido('whatsapp.error.invalidBotConfig', 'invalid_bot_distribution');
  return { enabled: raw.enabled === undefined ? atual.enabled : raw.enabled === true };
}

function lerPesquisa(raw, atual) {
  if (raw === undefined) return atual;
  if (!raw || typeof raw !== 'object') throw invalido('whatsapp.error.invalidBotConfig', 'invalid_bot_satisfaction');
  return { enabled: raw.enabled === undefined ? atual.enabled : raw.enabled === true };
}

function fusoValido(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const invalido = (key, code) => new WaError(key, { code, status: 400 });

function lerOpcoes(raw, atual) {
  if (raw === undefined) return atual;
  if (!raw || typeof raw !== 'object') throw invalido('whatsapp.error.invalidBotConfig', 'invalid_bot_options');
  return Object.fromEntries(OPTION_KEYS.map((k) => [k, raw[k] === undefined ? atual[k] : raw[k] !== false]));
}

function lerMensagens(raw, atual) {
  if (raw === undefined) return atual;
  if (!raw || typeof raw !== 'object') throw invalido('whatsapp.error.invalidBotConfig', 'invalid_bot_messages');
  const saida = { ...atual };
  for (const k of EDITABLE_MESSAGES) {
    if (raw[k] === undefined) continue;
    const texto = String(raw[k] ?? '').trim();
    if (texto.length > MESSAGE_MAX) throw invalido('whatsapp.error.invalidBotConfig', 'bot_message_too_long');
    saida[k] = texto;
  }
  return saida;
}

function lerHorario(raw, atual) {
  if (raw === undefined) return atual;
  if (!raw || typeof raw !== 'object') throw invalido('whatsapp.error.invalidBotHours', 'invalid_bot_hours');
  const timezone = raw.timezone === undefined ? atual.timezone : String(raw.timezone).trim();
  if (!fusoValido(timezone)) throw invalido('whatsapp.error.invalidBotHours', 'invalid_timezone');
  let week = atual.week;
  if (raw.week !== undefined) {
    if (!Array.isArray(raw.week)) throw invalido('whatsapp.error.invalidBotHours', 'invalid_bot_hours');
    week = semanaPadrao().map((padrao) => {
      const dia = raw.week.find((d) => Number(d?.day) === padrao.day) || padrao;
      const closed = dia.closed === true;
      const open = String(dia.open ?? padrao.open);
      const close = String(dia.close ?? padrao.close);
      if (!closed && (!HORA.test(open) || !HORA.test(close) || open >= close)) {
        throw invalido('whatsapp.error.invalidBotHours', 'invalid_bot_hours');
      }
      return { day: padrao.day, closed, open, close };
    });
  }
  return { enabled: raw.enabled === undefined ? atual.enabled : raw.enabled === true, timezone, week };
}

class WaBotConfigService {
  static cache = new TenantCache(30_000);

  static invalidate() {
    this.cache.invalidate();
  }

  /** Padrões fundidos com o que o provedor gravou. */
  static async getConfig() {
    const guardado = this.cache.get();
    if (guardado) return guardado;
    const base = padroes();
    let salvo = {};
    try {
      salvo = JSON.parse((await AppState.get(CONFIG_KEY)) || '{}') || {};
    } catch {
      salvo = {};
    }
    const config = {
      options: { ...base.options, ...(salvo.options || {}) },
      messages: { ...base.messages, ...(salvo.messages || {}) },
      hours: {
        ...base.hours,
        ...(salvo.hours || {}),
        week: Array.isArray(salvo.hours?.week) && salvo.hours.week.length === 7 ? salvo.hours.week : base.hours.week
      },
      satisfaction: { ...base.satisfaction, ...(salvo.satisfaction || {}) },
      distribution: { ...base.distribution, ...(salvo.distribution || {}) },
      autoTags: { ...base.autoTags, ...(salvo.autoTags || {}) },
      ai: { ...base.ai, ...(salvo.ai || {}) }
    };
    this.cache.set(config);
    return config;
  }

  /** Os textos padrão, para a tela mostrar como placeholder e restaurar. */
  static defaults(locale = DEFAULT_LOCALE) {
    return Object.fromEntries(EDITABLE_MESSAGES.map((k) => [k, translate(locale, DEFAULT_KEYS[k])]));
  }

  /** O texto que o bot manda: o do provedor, ou o padrão. */
  static async message(key) {
    const { messages } = await this.getConfig();
    return messages[key] || translate(DEFAULT_LOCALE, DEFAULT_KEYS[key]);
  }

  /** O que a tela lê: esta configuração mais os dois interruptores do WhatsApp. */
  static async getPublic(locale) {
    const [config, wa, ultimoErro] = await Promise.all([
      this.getConfig(), WhatsAppConfigService.getConfig(), this.aiLastError()
    ]);
    // A chave nunca sai: a tela só sabe se há uma.
    const { apiKey, ...ai } = config.ai;
    return {
      enabled: wa.botEnabled !== false,
      unlockEnabled: wa.botUnlockEnabled === true,
      ...config,
      ai: { ...ai, hasApiKey: Boolean(apiKey), keyHint: this.aiKeyHint(apiKey), lastError: ultimoErro },
      defaults: this.defaults(locale)
    };
  }

  /**
   * Os 4 últimos caracteres da chave salva, para a tela conferir qual chave
   * está ali — o navegador já gravou a senha do painel no lugar dela.
   */
  static aiKeyHint(stored) {
    if (!stored) return null;
    const chave = aiKeyBox.decrypt(stored) ?? '';
    return chave.length >= 12 ? chave.slice(-4) : null;
  }

  /** A configuração da IA com a chave em claro, para quem chama a API. */
  static async aiSettings() {
    const { ai } = await this.getConfig();
    const apiKey = ai.apiKey ? (aiKeyBox.decrypt(ai.apiKey) ?? '') : '';
    return { ...ai, apiKey };
  }

  /** A última falha da IA (`{at, code}`), para a tela dizer por que caiu no menu. */
  static async aiLastError() {
    try {
      return JSON.parse((await AppState.get(AI_ERROR_KEY)) || 'null');
    } catch {
      return null;
    }
  }

  static async recordAiError(code, detail = null) {
    try {
      const valor = code ? { at: new Date().toISOString(), code, detail: detail ? String(detail).slice(0, 240) : null } : null;
      await AppState.upsert(AI_ERROR_KEY, JSON.stringify(valor));
    } catch {
      // A tela perder o último erro é melhor que o bot perder a resposta.
    }
  }

  static async saveConfig(patch = {}, locale) {
    const atual = await this.getConfig();
    const proximo = {
      options: lerOpcoes(patch.options, atual.options),
      messages: lerMensagens(patch.messages, atual.messages),
      hours: lerHorario(patch.hours, atual.hours),
      satisfaction: lerPesquisa(patch.satisfaction, atual.satisfaction),
      distribution: lerDistribuicao(patch.distribution, atual.distribution),
      autoTags: lerAutoTags(patch.autoTags, atual.autoTags),
      ai: lerIa(patch.ai, atual.ai)
    };
    const interruptores = {};
    if (patch.enabled !== undefined) interruptores.botEnabled = patch.enabled !== false;
    if (patch.unlockEnabled !== undefined) interruptores.botUnlockEnabled = patch.unlockEnabled === true;
    if (Object.keys(interruptores).length) await WhatsAppConfigService.saveConfig(interruptores);

    await AppState.upsert(CONFIG_KEY, JSON.stringify(proximo));
    this.invalidate();
    return this.getPublic(locale);
  }

  /**
   * Agora é horário de atendimento humano? Sem horário configurado, sempre é.
   * A hora vem do fuso do provedor, não do servidor — o deploy pode estar em UTC.
   */
  static async withinHours(now = new Date()) {
    const { hours } = await this.getConfig();
    if (!hours.enabled) return true;
    const partes = new Intl.DateTimeFormat('en-US', {
      timeZone: hours.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now);
    const valor = (tipo) => partes.find((p) => p.type === tipo)?.value;
    const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(valor('weekday'));
    const agora = `${valor('hour')}:${valor('minute')}`;
    const regra = hours.week.find((d) => d.day === dia);
    if (!regra || regra.closed) return false;
    return agora >= regra.open && agora < regra.close;
  }
}

export default WaBotConfigService;
