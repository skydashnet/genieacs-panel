import WaMetaTemplateService from './waMetaTemplateService.js';
import AppState from '../models/AppState.js';
import MappingEdge from '../models/MappingEdge.js';
import MappingNode from '../models/MappingNode.js';
import WaAlertState from '../models/WaAlertState.js';
import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import OutageIncidentService from './outageIncidentService.js';
import MaintenanceService from './maintenanceService.js';
import WaBotConfigService from './waBotConfigService.js';
import WaResponseTimeService from './waResponseTimeService.js';
import { forEachTenant } from '../config/tenantJobs.js';
import DeviceService from './deviceService.js';
import WaSendService from './waSendService.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { timestampMs } from '../utils/helpers.js';
import { DEFAULT_LOCALE, translatorFor } from '../i18n/index.js';
import { TenantCache } from '../config/tenantCache.js';
import { currentTenantId } from '../config/tenantContext.js';
import { mailConfigured, mailTransport, panelUrlFor } from './mail/index.js';
import { isValidEmail } from '../utils/helpers.js';
import Tenant from '../models/Tenant.js';
import { createSecretBox } from '../utils/secretBox.js';
import { TELEGRAM_CHAT_PATTERN, TELEGRAM_TOKEN_PATTERN, sendTelegramMessage } from './telegramClient.js';
import { detectOutages, mapsLink } from './outageDetector.js';

const SETTINGS_KEY = 'whatsapp_alert_settings';

/**
 * Where the last scan's stamp lives, beside the settings and read the same way.
 *
 * One key per provider, because `app_state` is scoped: the row this reads and
 * writes belongs to whoever is in scope, and the scan runs inside one. The
 * in-memory shortcut over it is keyed the same way.
 */
const LAST_SCAN_KEY = 'whatsapp_alert_last_scan';
const DIGEST_KEY = 'whatsapp_alert_digest';
const DIGEST_CHOICES = Object.freeze([0, 5, 10, 15, 30]);
const DIGEST_MAX_ITEMS = 200;
const DIGEST_MAX_AGE_MS = 24 * 3600 * 1000;
const DIGEST_LINES_PER_SECTION = 25;
const normalizeDigest = (value, fallback = 0) => {
  const n = Number(value);
  return DIGEST_CHOICES.includes(n) ? n : fallback;
};

/** Same 30 s window `whatsappConfigService` uses, and for the same reason. */
const SETTINGS_CACHE_TTL_MS = 30_000;

/** How often the driver wakes. Whether a scan is *due* is decided in the tick. */
const TICK_INTERVAL_MS = 60_000;

/** Nobody's on-call roster is longer than this, and a typo should not fan out. */
const MAX_RECIPIENTS = 20;

export const ALERT_RULES = Object.freeze([
  'ont_offline',
  'rx_power_low',
  'temperature_high',
  'mass_outage',
  'wa_disconnected',
  'wa_waiting'
]);

/**
 * Os estados em que um número de WhatsApp está caído DE VERDADE.
 *
 * `connecting` e `pending` ficam de fora: são o número sendo pareado ou
 * reiniciado por alguém que está olhando a tela, não uma queda.
 */
export const ACCOUNT_DOWN_STATUSES = Object.freeze(['disconnected', 'expired']);

/**
 * The translation key each rule's message is built from.
 *
 * The `*Cleared` half is not decoration. A recovery has to be as unambiguous
 * as the alarm was: someone glancing at a phone at 3 a.m. reads the first line
 * and nothing else, and "ONT offline ✔" reads as a second alarm, not as an
 * all-clear. So recovery gets its own sentence rather than the firing sentence
 * with a tick bolted on.
 */
const RULE_KEYS = Object.freeze({
  ont_offline: { firing: 'whatsapp.alerts.ontOffline', cleared: 'whatsapp.alerts.ontOfflineCleared' },
  rx_power_low: { firing: 'whatsapp.alerts.rxPowerLow', cleared: 'whatsapp.alerts.rxPowerLowCleared' },
  temperature_high: { firing: 'whatsapp.alerts.temperatureHigh', cleared: 'whatsapp.alerts.temperatureHighCleared' },
  mass_outage: { firing: 'whatsapp.alerts.massOutage', cleared: 'whatsapp.alerts.massOutageCleared' },
  wa_disconnected: { firing: 'whatsapp.alerts.waDisconnected', cleared: 'whatsapp.alerts.waDisconnectedCleared' },
  // Respondida não vira mensagem: seria um aviso para cada conversa atendida.
  wa_waiting: { firing: 'whatsapp.alerts.waWaiting', cleared: null }
});

/**
 * The defaults, and why each number is what it is.
 *
 * `ont_offline` at 30 minutes: GenieACS calls a device offline after 10 minutes
 * without an inform, but a customer power-cycling a router crosses that line
 * every day and is not an incident. Thirty minutes is long enough that a
 * reboot, a brief drop and a scheduled inform that ran late have all resolved
 * themselves, and short enough to still be news.
 *
 * `rx_power_low` at -27 dBm: the dashboard already calls anything below -27
 * critical (`buildDashboardSummary`), so the alert fires where the panel
 * already turns the row red rather than at a second, private opinion.
 *
 * `temperature_high` at 70 °C: same source — the dashboard's "Hot" bucket.
 *
 * `mass_outage` at 5 ONTs: an ODP typically serves 8 or 16 subscribers. Two or
 * three down together is a normal evening on any network; five on the SAME
 * node at the same moment is not a coincidence, it is the drop or the ODP.
 * Below five the grouping would fire on ordinary churn and start swallowing
 * individual alerts that people actually need.
 *
 * Cooldowns are asymmetric on purpose: an outage repeats every two hours
 * because someone is expected to be acting on it, while an ONT running hot or
 * dim is a maintenance item and repeating it more than every six hours only
 * teaches people to ignore the thread.
 */
const DEFAULT_RULES = Object.freeze({
  ont_offline: { enabled: true, threshold: 30, cooldownMinutes: 120 },
  rx_power_low: { enabled: true, threshold: -27, cooldownMinutes: 360 },
  temperature_high: { enabled: true, threshold: 70, cooldownMinutes: 360 },
  mass_outage: { enabled: true, threshold: 5, cooldownMinutes: 120 },
  // O limite é a carência, em minutos: um `connectfailure` que o Evolution
  // resolve sozinho em segundos não pode acordar ninguém. A repetição é de
  // hora em hora porque, enquanto o número está caído, nenhum cliente recebe
  // resposta — é mais urgente que uma ONT quente.
  wa_disconnected: { enabled: true, threshold: 5, cooldownMinutes: 60 },
  // O limite são os minutos de espera por gente; o aviso se repete a cada hora
  // enquanto o cliente continua sem resposta.
  wa_waiting: { enabled: true, threshold: 15, cooldownMinutes: 60 }
});

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  // Five minutes. The rules are all measured in tens of minutes, so scanning
  // faster would only spend GenieACS reads to discover the same answer.
  intervalSeconds: 300,
  // 0 = cada alerta sai na hora, como sempre. 5, 10, 15 ou 30 juntam os
  // alertas numa fila e mandam um resumo só a cada tantos minutos.
  digestMinutes: 0,
  recipients: [],
  // O segundo canal: e-mails da equipe, pelo SMTP do servidor. Mesma regra
  // dos números — quem recebe é a equipe, nunca o assinante.
  emailRecipients: [],
  rules: DEFAULT_RULES
});

/**
 * O token do bot do Telegram, cifrado dentro dos ajustes (`app_state`), com
 * contexto próprio — e na lista da rotação da `SECRET_BOX_KEY`
 * (`secretRotationService.js`, `BLOBS`).
 */
export const TELEGRAM_SECRET_CONTEXT = 'skygenpanel-telegram-bot-v1';
let telegramBox = null;
const caixaTelegram = () => {
  telegramBox ??= createSecretBox(TELEGRAM_SECRET_CONTEXT);
  return telegramBox;
};

/** Os códigos do cliente do Telegram, e a frase de cada um. */
const TELEGRAM_ERROR_KEYS = Object.freeze({
  telegram_invalid_token: 'whatsapp.alerts.telegramInvalidToken',
  telegram_bot_not_in_chat: 'whatsapp.alerts.telegramBotNotInChat',
  telegram_chat_not_found: 'whatsapp.alerts.telegramChatNotFound',
  telegram_unreachable: 'whatsapp.alerts.telegramUnreachable',
  telegram_failed: 'whatsapp.alerts.telegramFailed'
});

/** O assunto de um alerta por e-mail, cortado: é lido na notificação do celular. */
const EMAIL_SUBJECT_MAX = 120;


/**
 * A timestamp column, in milliseconds, whatever the driver handed back.
 *
 * SQLite stores an integer, Postgres returns a `Date`, MySQL returns a `Date`
 * or a string depending on the driver's settings. The cooldown is the one
 * comparison in this file that must be right on all three.
 */
/** A telemetry reading is only a reading when it is a finite number. */
function reading(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

// The separator is escaped, not typed. A literal NUL in the source makes git
// treat this file as BINARY: it then refuses to merge it and silently keeps
// one side, which is how a merge quietly drops the other side's changes.
const conditionKey = (rule, subject) => `${rule}\u0000${subject}`;

/**
 * Technical alerts: telling the provider's own team, over WhatsApp, when the
 * network breaks.
 *
 * Three things shape every decision in here, and all three are about the same
 * failure mode — an alerting channel people mute.
 *
 * 1. A firing condition notifies ONCE and then respects its cooldown. The
 *    memory is `wa_alert_state`, not this process, so a restart does not
 *    re-announce a fleet that has been down since yesterday.
 * 2. A recovery is a message too. An operator who got "ONT offline" and never
 *    hears again cannot tell a fixed fibre from a broken alerter.
 * 3. A mass outage suppresses the individual alerts underneath it. Forty
 *    messages at 3 a.m. for one fibre cut is how an alerting system gets muted
 *    forever, and a muted system is worse than none because it looks fine.
 *
 * The recipients are the provider's own staff — a list of numbers in the
 * settings, not a lookup against the subscriber base. Nothing here knows who
 * owns the ONT that failed, and it should not: an alert names equipment.
 */
class WaAlertService {
  static settingsCache = new TenantCache(SETTINGS_CACHE_TTL_MS);

  static timer = null;

  /**
   * The pass in flight, per provider.
   *
   * Collapsing was right and stays right — a manual scan while the loop is
   * mid-pass must not read the same rows and send twice. What was wrong was
   * collapsing ACROSS providers: the second provider's scan awaited the
   * first's and was handed its summary, so it never looked at its own fleet.
   */
  static scanPromises = new Map();

  /**
   * When the last pass ran. In `app_state`, with a memo in memory.
   *
   * In memory alone it was zero again after every restart, so the first tick
   * always scanned — and a panel restarts more often than an operator thinks:
   * a deploy, a crash loop, a container rescheduled. `intervalSeconds` is the
   * operator saying how hard the fleet may be swept, and a value the process
   * forgets is not a setting.
   *
   * What is given up is the catch-up scan after downtime, and it is worth
   * little: the delay it saves is bounded by `intervalSeconds`, which is
   * clamped to an hour, and the alert that would have gone out is still going
   * out — one interval later, from a panel that is up.
   */
  /** The last scan's stamp, per provider — see `readLastScanAt`. */
  static lastScanAt = new Map();

  // ── Settings ───────────────────────────────────────────────────────

  /**
   * Forget the provider in scope — its own configuration changed.
   * To forget every provider's, reach for `settingsCache.clear()`; that is a
   * reset, not a save, and the two must not share a name.
   */
  static invalidateSettingsCache() {
    this.settingsCache.invalidate();
  }

  static async readStoredSettings() {
    const raw = await AppState.get(SETTINGS_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) || {};
    } catch {
      // A hand-edited blob must not take the alerts down with it.
      return {};
    }
  }

  static normalizeRules(stored) {
    const rules = {};
    for (const rule of ALERT_RULES) {
      const fallback = DEFAULT_RULES[rule];
      const value = (stored && typeof stored[rule] === 'object' && stored[rule]) || {};
      // `null` and `''` both have to be ruled out BEFORE the conversion, not
      // after: `Number(null)` and `Number('')` are 0, and 0 is finite. Left to
      // `Number.isFinite` alone, a rule whose box the operator emptied would be
      // stored as a threshold of zero rather than restored to the default —
      // and `temperature_high` at 0 °C alerts on the whole fleet, forever.
      const empty = value.threshold === null
        || value.threshold === undefined
        || String(value.threshold).trim() === '';
      const threshold = empty ? Number.NaN : Number(value.threshold);
      rules[rule] = {
        enabled: value.enabled === undefined ? fallback.enabled : value.enabled === true,
        // An absent threshold means "use the default", which is what the browser
        // sends for a rule whose box the operator emptied.
        threshold: Number.isFinite(threshold) ? threshold : fallback.threshold,
        cooldownMinutes: clamp(value.cooldownMinutes, 1, 7 * 24 * 60, fallback.cooldownMinutes)
      };
    }
    return rules;
  }

  /**
   * Accepts a list or a pasted comma/newline-separated string, and refuses
   * anything that is not a usable number.
   *
   * Refusing beats storing: a number that cannot be dialled would fail once per
   * alert, forever, in a log nobody reads — while the operator who typed it is
   * still looking at the form.
   */
  static normalizeRecipients(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,;\n]/);
    const numbers = [];
    for (const entry of list) {
      const text = String(entry ?? '').trim();
      if (!text) continue;
      const number = normalizarTelefoneBr(text);
      if (!number) {
        throw new WaError('whatsapp.error.invalidPhone', {
          code: 'invalid_phone',
          status: 400,
          vars: { phone: text }
        });
      }
      if (!numbers.includes(number)) numbers.push(number);
    }
    if (numbers.length > MAX_RECIPIENTS) {
      throw new WaError('whatsapp.error.tooManyRecipients', {
        code: 'too_many_recipients',
        status: 400,
        vars: { max: MAX_RECIPIENTS }
      });
    }
    return numbers;
  }

  /**
   * Os e-mails da equipe: lista ou texto colado, minúsculos e sem repetição.
   * Recusar o inválido pelo mesmo motivo dos números — ele falharia em todo
   * alerta, para sempre, num log que ninguém lê.
   */
  static normalizeEmailRecipients(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,;\n\s]/);
    const emails = [];
    for (const entry of list) {
      const text = String(entry ?? '').trim().toLowerCase();
      if (!text) continue;
      if (!isValidEmail(text)) {
        throw new WaError('whatsapp.alerts.invalidEmail', {
          code: 'invalid_email',
          status: 400,
          vars: { email: text }
        });
      }
      if (!emails.includes(text)) emails.push(text);
    }
    if (emails.length > MAX_RECIPIENTS) {
      throw new WaError('whatsapp.error.tooManyRecipients', {
        code: 'too_many_recipients',
        status: 400,
        vars: { max: MAX_RECIPIENTS }
      });
    }
    return emails;
  }

  /**
   * O bloco do Telegram de um salvamento.
   *
   * `botToken` omitido mantém o guardado e `''` apaga — a mesma regra da chave
   * admin do Evolution: a tela nunca recebe o token, então não tem como mandá-lo
   * de volta, e "não mexi no campo" não pode virar "apague". O formato é
   * conferido aqui, onde quem colou ainda está olhando a tela.
   */
  static normalizeTelegram(patch, current) {
    const atual = current || { token: '', chatId: '' };
    if (patch === undefined || patch === null) return atual;
    let token = atual.token;
    if (patch.botToken !== undefined) {
      token = String(patch.botToken ?? '').trim();
      if (token && !TELEGRAM_TOKEN_PATTERN.test(token)) {
        throw new WaError('whatsapp.alerts.telegramTokenInvalid', { code: 'invalid_telegram_token', status: 400 });
      }
    }
    let chatId = atual.chatId;
    if (patch.chatId !== undefined) {
      chatId = String(patch.chatId ?? '').trim();
      if (chatId && !TELEGRAM_CHAT_PATTERN.test(chatId)) {
        throw new WaError('whatsapp.alerts.telegramChatInvalid', { code: 'invalid_telegram_chat', status: 400 });
      }
    }
    return { token, chatId };
  }

  static async getSettings() {
    const cached = this.settingsCache.get();
    if (cached) return cached;
    const stored = await this.readStoredSettings();
    const settings = {
      enabled: stored.enabled === true,
      intervalSeconds: clamp(stored.intervalSeconds, 60, 3600, DEFAULT_SETTINGS.intervalSeconds),
      digestMinutes: normalizeDigest(stored.digestMinutes),
      // Already validated on the way in; re-normalised on the way out so a blob
      // written by an older version still yields dialable numbers.
      recipients: Array.isArray(stored.recipients)
        ? stored.recipients.map((entry) => normalizarTelefoneBr(entry)).filter(Boolean)
        : [],
      emailRecipients: Array.isArray(stored.emailRecipients)
        ? stored.emailRecipients.map((entry) => String(entry ?? '').trim().toLowerCase()).filter((entry) => isValidEmail(entry))
        : [],
      // O token aberto só aqui, na memória do processo; nunca sai para a tela.
      telegram: {
        token: stored.telegram?.botToken ? (caixaTelegram().decrypt(stored.telegram.botToken) ?? '') : '',
        chatId: typeof stored.telegram?.chatId === 'string' ? stored.telegram.chatId : ''
      },
      rules: this.normalizeRules(stored.rules),
      updatedAt: stored.updatedAt || null
    };
    this.settingsCache.set(settings);
    return settings;
  }

  /**
   * The shape the browser sees. There is no secret here, so it is the settings
   * themselves plus what the scan would refuse on — the operator has to be able
   * to see WHY alerts are silent without running one.
   */
  static async getPublicSettings() {
    const settings = await this.getSettings();
    const account = await WhatsAppAccount.getForPurpose('alerts');
    const whatsappReady = Boolean(account && settings.recipients.length > 0);
    const emailReady = Boolean(mailConfigured() && settings.emailRecipients.length > 0);
    const telegramReady = Boolean(settings.telegram.token && settings.telegram.chatId);
    return {
      ...settings,
      // O token NUNCA: só se há um guardado, e o grupo, que não é segredo.
      telegram: { configured: Boolean(settings.telegram.token), chatId: settings.telegram.chatId },
      hasAlertsNumber: Boolean(account),
      // Se o servidor manda e-mail — sem isso, o campo dos e-mails avisa em vez
      // de aceitar endereços que nunca vão receber nada.
      mailConfigured: mailConfigured(),
      ready: Boolean(settings.enabled && (whatsappReady || emailReady || telegramReady))
    };
  }

  /**
   * The stored stamp, read once and remembered — a tick a minute has no reason
   * to go back to the table it just wrote.
   */
  static async readLastScanAt() {
    const tenant = currentTenantId();
    const remembered = this.lastScanAt.get(tenant);
    if (remembered) return remembered;
    const stored = Number(await AppState.get(LAST_SCAN_KEY));
    // Anything unusable, and a stamp from the FUTURE — a clock that jumped, a
    // hand-edited row — reads as "never scanned". Trusted, a stamp a year ahead
    // would hold the scan off until then, and the scan is the one thing here
    // that must not be capable of stopping.
    if (!Number.isFinite(stored) || stored <= 0 || stored > Date.now()) return 0;
    this.lastScanAt.set(tenant, stored);
    return stored;
  }

  static async markScanned(at) {
    this.lastScanAt.set(currentTenantId(), at);
    await AppState.upsert(LAST_SCAN_KEY, String(at));
  }

  static async saveSettings(patch = {}) {
    const current = await this.getSettings();
    const next = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      intervalSeconds: patch.intervalSeconds === undefined
        ? current.intervalSeconds
        : clamp(patch.intervalSeconds, 60, 3600, DEFAULT_SETTINGS.intervalSeconds),
      digestMinutes: patch.digestMinutes === undefined
        ? current.digestMinutes
        : normalizeDigest(patch.digestMinutes),
      recipients: patch.recipients === undefined
        ? current.recipients
        : this.normalizeRecipients(patch.recipients),
      emailRecipients: patch.emailRecipients === undefined
        ? current.emailRecipients
        : this.normalizeEmailRecipients(patch.emailRecipients),
      telegram: this.normalizeTelegram(patch.telegram, current.telegram),
      rules: patch.rules === undefined
        ? current.rules
        // Merged onto the stored rules, so a screen that sends one rule cannot
        // silently reset the other three to their defaults.
        : this.normalizeRules({ ...current.rules, ...patch.rules }),
      updatedAt: new Date().toISOString()
    };

    const temTelegram = Boolean(next.telegram.token && next.telegram.chatId);
    if (next.enabled && next.recipients.length === 0 && next.emailRecipients.length === 0 && !temTelegram) {
      // `no_alert_recipients`, the same code the scan raises for the same
      // reason. The campaign's `no_recipients` means "the filters left nobody
      // to charge", and a form that translated the code would put that sentence
      // on this screen.
      throw new WaError('whatsapp.alerts.noRecipients', {
        code: 'no_alert_recipients',
        status: 400
      });
    }

    // O token entra cifrado; o que fica em memória (o cache) é relido do banco.
    await AppState.upsert(SETTINGS_KEY, JSON.stringify({
      ...next,
      telegram: {
        botToken: next.telegram.token ? { v: 1, ...caixaTelegram().encrypt(next.telegram.token) } : null,
        chatId: next.telegram.chatId
      }
    }));
    this.invalidateSettingsCache();
    return this.getPublicSettings();
  }

  // ── The loop ───────────────────────────────────────────────────────

  /**
   * Started from `server.js` only, never as an import side effect, so the test
   * suite never has a timer running behind it. The enabled flag is read inside
   * the tick rather than used to start and stop the timer — the same choice
   * `schedulerService` and `waOutboxWorker` make, so a Settings toggle takes
   * effect within a minute with no lifecycle to keep in sync.
   */
  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      // `tick` swallows its own failures; this catch exists only so a bug in
      // that promise chain cannot become an unhandled rejection.
      void this.tick().catch((error) => {
        console.warn(`WhatsApp alert tick failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One wake-up, one pass per active provider. */
  static async tick() {
    // A pass per provider. Everything the scan reads is now per provider —
    // its settings and stamp in `app_state`, the alert state, the fiber plant,
    // the opt-out list, the WhatsApp number, and the GenieACS the fleet comes
    // from, which follows `settings.genieAcsUrl`. So the loop divides the work
    // rather than repeating it, which is what `forSoleTenant` was holding it
    // back from.
    const summaries = await forEachTenant(() => this.tickForTenant());
    return summaries.reduce(
      (total, one) => ({
        fired: (total.fired || 0) + (one.fired || 0),
        cleared: (total.cleared || 0) + (one.cleared || 0),
        notified: (total.notified || 0) + (one.notified || 0),
        skipped: total.skipped ?? one.skipped ?? null
      }),
      { fired: 0, cleared: 0, notified: 0, skipped: null }
    );
  }

  /** One wake-up for the provider in scope. Scans only when `intervalSeconds` has elapsed. */
  static async tickForTenant() {
    const settings = await this.getSettings().catch(() => null);
    if (!settings || !settings.enabled) return { skipped: 'disabled' };
    // O resumo tem relógio próprio: sai no horário mesmo entre duas varreduras.
    await this.flushDigest(settings).catch((error) => {
      console.warn(`WhatsApp alert digest failed: ${error.message}`);
    });
    const lastScanAt = await this.readLastScanAt();
    if (Date.now() - lastScanAt < settings.intervalSeconds * 1000) {
      return { skipped: 'not_due' };
    }
    // Stamped BEFORE the pass, as it always was: a scan that takes longer than
    // the interval must not have a second one start behind it.
    await this.markScanned(Date.now());
    return this.scan();
  }

  // ── The scan ───────────────────────────────────────────────────────

  /**
   * One pass over the fleet.
   *
   * It NEVER throws. A GenieACS that is down, a malformed reading, an Evolution
   * server that refuses one message — none of those may stop the loop, and a
   * scan that threw out of a tick would take every other rule down with it. The
   * reason a pass did nothing comes back in `skipped` instead, because the
   * caller (the loop, or an admin who just pressed the button) has to be able
   * to tell "nothing is wrong" from "nothing was checked".
   *
   * @returns {Promise<{fired: number, cleared: number, notified: number,
   *   skipped: string|null, error: string|null}>}
   */
  static async scan({ now = Date.now() } = {}) {
    // Overlapping passes collapse onto the running one: a manual scan while the
    // loop is mid-pass would otherwise read the same rows and send twice.
    const tenant = currentTenantId();
    const running = this.scanPromises.get(tenant);
    if (running) return running;
    const work = this.runScan({ now }).finally(() => {
      if (this.scanPromises.get(tenant) === work) this.scanPromises.delete(tenant);
    });
    this.scanPromises.set(tenant, work);
    return work;
  }

  static async runScan({ now = Date.now() } = {}) {
    const summary = { fired: 0, cleared: 0, notified: 0, skipped: null, error: null };
    try {
      const settings = await this.getSettings();
      if (!settings.enabled) {
        summary.skipped = 'disabled';
        return summary;
      }

      // Os canais, decididos ANTES de ler a frota — a regra de sempre: nenhum
      // canal pronto, e a passagem para aqui, porque abrir condição que ninguém
      // vai ouvir deixaria `wa_alert_state` dizendo que todos foram avisados.
      const channels = await this.readyChannels(settings);
      if (!channels.whatsapp && !channels.email && !channels.telegram) {
        summary.skipped = channels.reason;
        return summary;
      }

      // Os números de WhatsApp primeiro, e com o seu próprio acerto de contas:
      // um GenieACS fora do ar não pode calar o aviso de que o atendimento
      // parou — são problemas diferentes, e o segundo nem passa pela frota.
      const contas = await this.evaluateAccounts(settings, now);
      await this.reconcile({ ...contas, settings, channels, now, summary, scope: (rule) => rule === 'wa_disconnected' });
      // Cliente esperando gente: também independe da frota.
      const esperas = await this.evaluateWaiting(settings, now);
      await this.reconcile({ ...esperas, settings, channels, now, summary, scope: (rule) => rule === 'wa_waiting' });

      const devices = await DeviceService.getDashboardDevices();
      if (!Array.isArray(devices) || devices.length === 0) {
        // An empty fleet read is far more likely to be a broken GenieACS than a
        // provider with no ONTs, and treating it as "nothing is firing" would
        // blast a recovery message for every open condition at once.
        summary.skipped = 'no_devices';
        return summary;
      }

      const { firing, unknown } = await this.evaluate(devices, settings, now);
      await this.reconcile({ firing, unknown, settings, channels, now, summary, scope: (rule) => rule !== 'wa_disconnected' && rule !== 'wa_waiting' });
      // O incidente de queda — o que o operador usa para avisar os CLIENTES.
      // À parte e calado: um incidente que não abre não derruba o alerta da
      // equipe, que já saiu.
      await OutageIncidentService.syncFromScan({ firing, unknown }).catch((error) => {
        console.warn(`Outage incident sync failed: ${error.message}`);
      });
    } catch (error) {
      // Reported, not thrown — see the method comment.
      summary.error = error.message;
      summary.skipped = summary.skipped || 'error';
      console.warn(`WhatsApp alert scan failed: ${error.message}`);
    }
    return summary;
  }

  /**
   * Os canais que podem levar um alerta agora, e — quando nenhum pode — o
   * motivo mais útil para a tela.
   *
   * O WhatsApp exige a integração pronta, um número com a finalidade "alertas"
   * e alguém discável (a lista de não perturbe vale aqui também). O e-mail
   * exige o SMTP do servidor e algum endereço. Quando só o WhatsApp está em
   * uso, os motivos são os de sempre (`not_configured`, `no_alert_number`,
   * `no_recipients`); quando só há e-mails e o servidor não manda e-mail, o
   * motivo é `mail_not_configured` — o conserto é em outro lugar.
   */
  static async readyChannels(settings) {
    let whatsapp = null;
    let reason = null;
    if (settings.recipients.length > 0) {
      const config = await WhatsAppConfigService.getConfig();
      if (!WhatsAppConfigService.isReady(config)) {
        reason = 'not_configured';
      } else {
        const account = await WhatsAppAccount.getForPurpose('alerts');
        if (!account) {
          reason = 'no_alert_number';
        } else {
          const recipients = await this.dialableRecipients(settings.recipients);
          if (recipients.length > 0) whatsapp = { account, recipients };
          else reason = 'no_recipients';
        }
      }
    }

    let email = null;
    if (settings.emailRecipients.length > 0) {
      if (mailConfigured()) {
        const tenant = await Tenant.findPublicById(currentTenantId()).catch(() => null);
        email = { recipients: settings.emailRecipients, tenantName: tenant?.name || null };
      } else if (!whatsapp) {
        reason = reason || 'mail_not_configured';
      }
    }

    // O Telegram é um grupo, não uma lista: pronto é ter o bot e o grupo.
    const telegram = settings.telegram?.token && settings.telegram?.chatId
      ? { token: settings.telegram.token, chatId: settings.telegram.chatId }
      : null;

    return { whatsapp, email, telegram, reason: reason || 'no_recipients' };
  }

  /**
   * Turns one fleet read into the set of conditions firing right now.
   *
   * The second return value matters as much as the first. `unknown` holds the
   * conditions this pass could NOT judge — an offline ONT's optical reading is
   * yesterday's, a device suppressed by a mass outage is deliberately not being
   * asked about — and a condition in there is left exactly as it was. Treating
   * "cannot tell" as "not firing" is how an alerter sends "optical power
   * recovered" about a device that has been dark for an hour.
   */
  static async evaluate(devices, settings, now) {
    const firing = new Map();
    const unknown = new Set();
    const rules = settings.rules;

    const offline = [];
    // Quando cada um informou por último: a queda em massa usa o do primeiro
    // a cair como "desde quando".
    const informs = new Map();
    for (const device of devices) {
      // Per device, so one unreadable row cannot end the pass. A fleet always
      // contains at least one device mid-provisioning with half a datamodel.
      try {
        const deviceId = String(device?._id ?? '').trim();
        if (!deviceId) continue;

        const lastInformMs = timestampMs(device._lastInform);
        const ageMs = now - lastInformMs;
        if (!Number.isFinite(ageMs) || ageMs < 0) {
          // Never informed, or a clock that disagrees with ours. Nothing about
          // this device can be judged, including its optical reading.
          unknown.add(conditionKey('ont_offline', deviceId));
          unknown.add(conditionKey('rx_power_low', deviceId));
          unknown.add(conditionKey('temperature_high', deviceId));
          continue;
        }

        const ageMinutes = ageMs / 60_000;
        informs.set(deviceId, lastInformMs);
        const isOnline = DeviceService.isDeviceOnline(device, now);

        if (rules.ont_offline.enabled) {
          // At the threshold, not past it. An operator who types 30 means "30
          // minutes is already too long"; a strict comparison would make the
          // one number they typed the only one that never alerts.
          if (ageMinutes >= rules.ont_offline.threshold) {
            offline.push(deviceId);
            firing.set(conditionKey('ont_offline', deviceId), {
              rule: 'ont_offline',
              subject: deviceId,
              vars: { device: deviceId, minutes: Math.round(ageMinutes) }
            });
          }
        } else if (!isOnline) {
          // The grouping still needs to know who is down even when the
          // individual rule is off — a fibre cut is worth one message whether
          // or not the operator wants forty.
          offline.push(deviceId);
        }

        // Optical and thermal readings are only judged on a device that is
        // currently informing. A dark ONT reports whatever it last managed to
        // send, and "rx power low" stacked on top of "ONT offline" is the same
        // incident said twice.
        for (const [rule, raw] of [
          ['rx_power_low', device.rxpower],
          ['temperature_high', device.temperature]
        ]) {
          if (!rules[rule].enabled) continue;
          const key = conditionKey(rule, deviceId);
          const value = isOnline ? reading(raw) : null;
          if (value === null) {
            unknown.add(key);
            continue;
          }
          const over = rule === 'rx_power_low'
            ? value <= rules[rule].threshold
            : value >= rules[rule].threshold;
          if (over) {
            firing.set(key, {
              rule,
              subject: deviceId,
              vars: { device: deviceId, value, threshold: rules[rule].threshold }
            });
          }
        }
      } catch {
        // One device's telemetry, not the fleet's. Nothing to say about it, and
        // nothing to clear either.
        continue;
      }
    }

    // Manutenção programada em andamento: o que está embaixo do nó caiu de
    // propósito. Nada dispara — nem por aparelho nem por caixa — e nada é
    // dado como resolvido: as condições vão para `unknown` e ficam como
    // estavam, para não sair "normalizado" no meio da manutenção.
    let manutencao = null;
    try {
      manutencao = await MaintenanceService.activeScope({ now });
    } catch (error) {
      console.warn(`WhatsApp alerts: maintenance scope unavailable: ${error.message}`);
    }
    const emManutencao = manutencao?.deviceIds ?? new Set();
    if (emManutencao.size) {
      for (const key of [...firing.keys()]) {
        const condition = firing.get(key);
        if (!emManutencao.has(String(condition.subject))) continue;
        firing.delete(key);
        unknown.add(key);
      }
      for (const deviceId of emManutencao) {
        for (const rule of ['ont_offline', 'rx_power_low', 'temperature_high']) unknown.add(conditionKey(rule, deviceId));
      }
    }

    if (rules.mass_outage.enabled) {
      await this.applyMassOutage({
        offline: emManutencao.size ? offline.filter((id) => !emManutencao.has(id)) : offline,
        rules,
        firing,
        unknown,
        informs,
        now,
        skipClients: manutencao?.ontNodeIds
      });
      for (const nodeId of manutencao?.nodeIds ?? []) {
        const key = conditionKey('mass_outage', nodeId);
        firing.delete(key);
        unknown.add(key);
      }
    }

    return { firing, unknown };
  }

  /**
   * Os números de WhatsApp caídos agora, como condições da regra
   * `wa_disconnected`.
   *
   * Lê o estado que o painel guarda — o webhook `connection_update` e a
   * conferência no envio é que o mantêm —, sem perguntar ao Evolution: uma
   * passagem que dependesse do servidor de WhatsApp responder não saberia
   * avisar justamente quando ele está fora.
   */
  static async evaluateAccounts(settings, now) {
    const firing = new Map();
    const unknown = new Set();
    const rule = settings.rules.wa_disconnected;
    if (!rule?.enabled) return { firing, unknown };
    const accounts = await WhatsAppAccount.getAll();
    const open = new Map(
      (await WaAlertState.listOpen())
        .filter((row) => row.rule === 'wa_disconnected')
        .map((row) => [String(row.subject), row])
    );
    const link = await this.reconnectLink();
    for (const account of accounts) {
      if (!ACCOUNT_DOWN_STATUSES.includes(account.status)) continue;
      const subject = String(account.id);
      const firedAt = timestampMs(open.get(subject)?.fired_at);
      firing.set(conditionKey('wa_disconnected', subject), {
        rule: 'wa_disconnected',
        subject,
        graceMinutes: Math.max(0, Number(rule.threshold) || 0),
        vars: {
          ...this.accountVars(account),
          minutes: Number.isFinite(firedAt) ? Math.max(0, Math.round((now - firedAt) / 60_000)) : 0,
          link
        }
      });
    }
    return { firing, unknown };
  }

  /**
   * Clientes esperando resposta de gente há mais que o limite da regra.
   *
   * Fora do horário de atendimento nada dispara e nada é dado como
   * resolvido: as linhas abertas vão para `unknown`. Uma mensagem das 23h
   * não é atraso de ninguém, e "respondida" às 23h01 seria mentira.
   */
  static async evaluateWaiting(settings, now) {
    const firing = new Map();
    const unknown = new Set();
    const rule = settings.rules.wa_waiting;
    if (!rule?.enabled) return { firing, unknown };
    if (!(await WaBotConfigService.withinHours(new Date(now)))) {
      for (const row of await WaAlertState.listOpen()) {
        if (row.rule === 'wa_waiting') unknown.add(conditionKey('wa_waiting', row.subject));
      }
      return { firing, unknown };
    }
    const t = translatorFor(DEFAULT_LOCALE);
    const esperando = await WaResponseTimeService.waitingNow({
      now: new Date(now),
      minMinutes: Math.max(1, Number(rule.threshold) || 15)
    });
    for (const item of esperando) {
      const subject = String(item.conversationId);
      firing.set(conditionKey('wa_waiting', subject), {
        rule: 'wa_waiting',
        subject,
        vars: {
          contact: item.contact || subject,
          minutes: item.minutes,
          agent: item.assignedTo || t('whatsapp.alerts.noAgent')
        }
      });
    }
    return { firing, unknown };
  }

  /** Como o número aparece na mensagem: o apelido, e o telefone quando há. */
  static accountVars(account) {
    const phone = account.phone_e164 ? `+${String(account.phone_e164).replace(/^\+/, '')}` : '';
    const nome = account.label || phone || account.name;
    return { account: phone && nome !== phone ? `${nome} (${phone})` : nome };
  }

  /**
   * Onde reconectar: o endereço da aba de WhatsApp das Configurações quando o
   * painel sabe o próprio endereço, ou só o caminho na tela.
   */
  static async reconnectLink() {
    const tenant = await Tenant.findPublicById(currentTenantId()).catch(() => null);
    const base = panelUrlFor(tenant);
    return base ? `: ${base}/settings?tab=whatsapp#wa-accounts` : '';
  }

  /**
   * Groups the offline ONTs by the node they hang off, raises one alert per
   * node that is over the threshold, and takes the individual `ont_offline`
   * entries for those devices back out.
   *
   * Grouping is at the NEAREST aggregation point — the ODP an ONT is wired to,
   * not the OLT at the end of the chain. A whole-OLT alert would be one message
   * for what is usually one drop cable, and would tell a technician to drive to
   * the wrong end of the network. A cut further upstream simply produces one
   * message per affected ODP, which is still a handful instead of hundreds.
   */
  static async applyMassOutage({ offline, rules, firing, unknown, informs = new Map(), now = Date.now(), skipClients = null }) {
    // Nenhuma caixa cai com menos de 2: abaixo disso, nem se lê a topologia
    // nem se faz a segunda leitura da frota numa rede saudável.
    if (offline.length < 2) return;

    const nodes = await MappingNode.getAll();
    const ontNodes = nodes.filter((node) => node.type === 'ont' && node.pppoe);
    if (ontNodes.length === 0) return;

    // The dashboard projection has no PPPoE username — the only link between a
    // GenieACS device and a node on the map — so it is read here, from the
    // panel's own reader, and only for a fleet that already looks broken.
    const identities = await DeviceService.getCustomerIdentityDevices();
    const pppoeByDevice = new Map();
    for (const item of identities) {
      const id = String(item?._id ?? '').trim();
      const pppoe = String(item?.pppoe ?? '').trim().toLowerCase();
      if (id && pppoe) pppoeByDevice.set(id, pppoe);
    }

    const nodeByPppoe = new Map();
    for (const node of ontNodes) {
      nodeByPppoe.set(String(node.pppoe).trim().toLowerCase(), node);
    }

    // Cliente no mapa → os equipamentos dele que estão offline.
    const offlineClients = new Map();
    const devicesByClient = new Map();
    for (const deviceId of offline) {
      const pppoe = pppoeByDevice.get(deviceId);
      const ontNode = pppoe ? nodeByPppoe.get(pppoe) : null;
      // Embaixo de um nó em manutenção: não conta para a queda de ninguém.
      if (!ontNode || skipClients?.has(ontNode.node_id)) continue;
      // Duas ONTs no mesmo login: vale o sinal mais antigo, o de quem caiu primeiro.
      const lastInform = informs.get(deviceId) ?? null;
      const previous = offlineClients.get(ontNode.node_id) ?? null;
      offlineClients.set(ontNode.node_id, previous === null ? lastInform : Math.min(previous, lastInform ?? previous));
      devicesByClient.set(ontNode.node_id, [...(devicesByClient.get(ontNode.node_id) ?? []), deviceId]);
    }

    const edges = await MappingEdge.getAll();
    const outages = detectOutages({ nodes, edges, offline: offlineClients, threshold: rules.mass_outage.threshold });

    for (const outage of outages) {
      const { box } = outage;
      firing.set(conditionKey('mass_outage', box.node_id), {
        rule: 'mass_outage',
        subject: box.node_id,
        vars: {
          node: box.name || box.node_id,
          count: outage.count,
          total: outage.total,
          minutes: outage.since === null ? '?' : Math.max(0, Math.round((now - outage.since) / 60_000)),
          link: mapsLink(box)
        },
        // Só em memória, para o incidente saber quem foi atingido — ver
        // `OutageIncidentService.syncFromScan`. `wa_alert_state` não guarda.
        devices: outage.clients.flatMap((clientId) => devicesByClient.get(clientId) ?? [])
      });
      for (const clientId of outage.clients) {
        for (const deviceId of devicesByClient.get(clientId) ?? []) {
          // Held back, not cleared. An `ont_offline` that was already firing for
          // one of these devices keeps its row and stays quiet: clearing it would
          // send "ONT recovered" in the middle of a fibre cut.
          const key = conditionKey('ont_offline', deviceId);
          firing.delete(key);
          unknown.add(key);
        }
      }
    }
  }

  /**
   * Walks the open rows against what is firing now, and sends what is owed.
   *
   * Four cases, and the whole noise policy lives in them: new condition →
   * notify once; still firing → nothing until the cooldown passes; recovered →
   * one message and the row goes; can't tell → leave it exactly as it was.
   */
  static async reconcile({ firing, unknown, settings, channels, now, summary, scope = null }) {
    // `scope` diz quais regras esta passada julga: as linhas das outras ficam
    // como estão, nem disparam de novo nem são dadas como resolvidas.
    const open = (await WaAlertState.listOpen()).filter((row) => !scope || scope(row.rule));
    const openByKey = new Map(open.map((row) => [conditionKey(row.rule, row.subject), row]));
    const stamp = new Date(now);

    for (const [key, condition] of firing) {
      const row = openByKey.get(key);
      const rule = settings.rules[condition.rule];
      const graceMs = (condition.graceMinutes ?? 0) * 60_000;
      if (!row) {
        const opened = await WaAlertState.open({ rule: condition.rule, subject: condition.subject, now: stamp });
        summary.fired += 1;
        // Com carência, a linha abre calada e só fala se ainda estiver valendo
        // quando a carência passar; o que se resolve antes some sem mensagem.
        if (graceMs > 0) continue;
        const sent = await this.notify({ channels, condition, cleared: false });
        if (sent > 0) {
          summary.notified += sent;
            await WaAlertState.markNotified(opened.id, stamp);
        }
        continue;
      }

      if (graceMs > 0 && !row.notify_count) {
        const firedAt = timestampMs(row.fired_at);
        if (Number.isFinite(firedAt) && now - firedAt < graceMs) continue;
      }

      const lastNotified = timestampMs(row.last_notified_at);
      const cooledDown = !Number.isFinite(lastNotified)
        || now - lastNotified >= rule.cooldownMinutes * 60_000;
      if (!cooledDown) continue;

      const sent = await this.notify({ channels, condition, cleared: false });
      if (sent > 0) {
        summary.notified += sent;
        await WaAlertState.markNotified(row.id, stamp);
      }
    }

    for (const [key, row] of openByKey) {
      if (firing.has(key) || unknown.has(key)) continue;
      // A rule the operator has since switched off: the row goes without a
      // message, because "recovered" would be a lie about equipment nobody is
      // watching any more.
      const rule = settings.rules[row.rule];
      if (rule?.enabled && row.notify_count > 0) {
        // A caixa pelo nome, como no alerta que abriu: o id interno
        // ("cto-01-2") não diz nada a quem lê no celular.
        const box = row.rule === 'mass_outage' ? await MappingNode.getByNodeId(row.subject).catch(() => null) : null;
        // O número pelo nome, como no aviso que abriu. Um número apagado não
        // "voltou": a linha sai calada.
        const conta = row.rule === 'wa_disconnected' ? await WhatsAppAccount.getById(row.subject).catch(() => null) : null;
        if (row.rule !== 'wa_disconnected' || conta) {
          summary.notified += await this.notify({
            channels,
            condition: {
              rule: row.rule,
              subject: row.subject,
              vars: { device: row.subject, node: box?.name || row.subject, ...(conta ? this.accountVars(conta) : {}) }
            },
            cleared: true
          });
        }
      }
      await WaAlertState.removeById(row.id);
      summary.cleared += 1;
    }
  }

  // ── Sending ────────────────────────────────────────────────────────

  /**
   * The staff numbers that may actually be written to.
   *
   * The do-not-disturb list is honoured even here. An alert is the provider
   * initiating contact, which is exactly what an opt-out refuses, and a number
   * ends up on that list by asking — including a technician who left the
   * company and kept the phone.
   */
  static async dialableRecipients(recipients) {
    const optedOut = await WaOptOut.activePhones(recipients, 'service');
    return recipients.filter((number) => !optedOut.has(number));
  }

  /**
   * Manda por cada canal pronto e diz quantas cópias saíram.
   *
   * Nunca lança: um destinatário que falha não pode impedir os outros de serem
   * avisados, nem impedir a condição de ser registrada. A condição conta como
   * avisada se QUALQUER canal entregou — o cooldown e a recuperação valem para
   * os canais juntos, e não um relógio para cada um.
   *
   * @returns {Promise<number>} how many copies went out, all channels together
   */
  static async notify({ channels, condition, cleared }) {
    const body = this.compose(condition, cleared);
    if (!body) return 0;
    const { digestMinutes } = await this.getSettings();
    if (digestMinutes > 0) {
      // Entra na fila do resumo. Conta como avisada (um por canal pronto) para o
      // cooldown e a recuperação funcionarem como se tivesse saído.
      await this.enqueueDigest({ rule: condition.rule, cleared: Boolean(cleared), text: body });
      return [channels?.whatsapp, channels?.email, channels?.telegram].filter(Boolean).length;
    }
    return this.deliver(channels, body);
  }

  static async deliver(channels, body) {
    let sent = 0;
    if (channels?.whatsapp) sent += await this.notifyWhatsApp(channels.whatsapp, body);
    if (channels?.email) sent += await this.notifyEmail(channels.email, body);
    if (channels?.telegram) sent += await this.notifyTelegram(channels.telegram, body);
    return sent;
  }

  // ── O resumo ───────────────────────────────────────────────────────

  static digestLocks = new Map();

  /** Uma operação por vez na fila de cada provedor (ler, mudar, gravar). */
  static async withDigestLock(work) {
    const tenant = currentTenantId();
    const previous = this.digestLocks.get(tenant) || Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    const tail = run.catch(() => {});
    this.digestLocks.set(tenant, tail);
    tail.then(() => {
      if (this.digestLocks.get(tenant) === tail) this.digestLocks.delete(tenant);
    });
    return run;
  }

  static async readDigest(now = Date.now()) {
    let stored = null;
    try {
      stored = JSON.parse((await AppState.get(DIGEST_KEY)) || 'null');
    } catch {
      stored = null;
    }
    const items = Array.isArray(stored?.items)
      ? stored.items.filter((item) => item && typeof item.text === 'string' && now - Number(item.at) < DIGEST_MAX_AGE_MS)
      : [];
    return { openedAt: items.length ? Number(items[0].at) : 0, items };
  }

  static async writeDigest(queue) {
    await AppState.upsert(DIGEST_KEY, JSON.stringify(queue?.items?.length ? { openedAt: queue.openedAt, items: queue.items } : { openedAt: 0, items: [] }));
  }

  static async enqueueDigest({ rule, cleared, text }) {
    return this.withDigestLock(async () => {
      const now = Date.now();
      const queue = await this.readDigest(now);
      const items = [...queue.items, { rule, cleared, text, at: now }].slice(-DIGEST_MAX_ITEMS);
      await this.writeDigest({ openedAt: Number(items[0].at), items });
    });
  }

  /**
   * Manda a fila como UMA mensagem quando o prazo do resumo venceu (ou a
   * varredura manual pediu, ou o operador voltou para "na hora"). Só esvazia se
   * algum canal entregou; sem canal pronto a fila espera.
   */
  static async flushDigest(settings, { now = Date.now(), force = false } = {}) {
    return this.withDigestLock(async () => {
      const queue = await this.readDigest(now);
      if (queue.items.length === 0) return 0;
      const minutes = settings.digestMinutes || 0;
      const due = force || minutes === 0 || now - queue.openedAt >= minutes * 60000;
      if (!due) return 0;
      const channels = await this.readyChannels(settings);
      if (!channels.whatsapp && !channels.email && !channels.telegram) return 0;
      const sent = await this.deliver(channels, this.composeDigest(queue, now));
      if (sent > 0) await this.writeDigest(null);
      return sent;
    });
  }

  static composeDigest(queue, now = Date.now()) {
    const items = queue.items;
    if (items.length === 1) return items[0].text;
    const t = translatorFor(DEFAULT_LOCALE);
    const fresh = items.filter((item) => !item.cleared);
    const back = items.filter((item) => item.cleared);
    const minutes = Math.max(1, Math.round((now - queue.openedAt) / 60000));
    const section = (heading, list) => {
      if (list.length === 0) return [];
      const shown = list.slice(0, DIGEST_LINES_PER_SECTION).map((item) => `• ${item.text}`);
      if (list.length > shown.length) shown.push(t('whatsapp.alerts.digestMore', { count: list.length - shown.length }));
      return ['', heading, ...shown];
    };
    return [
      t('whatsapp.alerts.digestTitle', { added: fresh.length, cleared: back.length, minutes }),
      ...section(t('whatsapp.alerts.digestNew'), fresh),
      ...section(t('whatsapp.alerts.digestCleared'), back)
    ].join('\n');
  }

  /** Uma cópia por número no outbox do WhatsApp. */
  static async notifyWhatsApp({ account, recipients }, body) {
    let sent = 0;
    for (const number of recipients) {
      try {
        // Sequential on purpose, the same reason the inbound handler gives:
        // `WaConversation.ensure` is a get-or-create without a transaction, and
        // two passes for the same number in parallel would open two threads.
        const conversation = await WaConversation.ensure({
          accountId: account.id,
          externalThreadId: `${number}@s.whatsapp.net`,
          waPhone: number,
          waLid: null,
          pushName: null
        });
        // The on-duty staff thread is a conversation like any other, so the bot
        // reads it too: an unlabelled alert counted against the ceiling for
        // whoever is on call.
        // Número oficial fora da janela: o alerta sai pelo modelo da Meta
        // ligado aos alertas, com o texto inteiro no parâmetro.
        const metaTemplate = await WaMetaTemplateService.noticePayload('alert', body);
        await WaSendService.enqueue({ conversationId: conversation.id, body, source: 'alert', metaTemplate });
        sent += 1;
      } catch (error) {
        console.warn(`WhatsApp alert to ${number} not enqueued: ${error.message}`);
      }
    }
    return sent;
  }

  /**
   * Um e-mail por endereço, em sequência, pelo SMTP do servidor.
   *
   * O transporte nunca lança — devolve `false` e registra a falha com o
   * endereço mascarado —, então um endereço que o servidor recusa só não conta.
   */
  static async notifyEmail({ recipients, tenantName }, body) {
    const subject = this.emailSubject(body, tenantName);
    let sent = 0;
    for (const to of recipients) {
      if (await mailTransport().send({ to, subject, text: body })) sent += 1;
    }
    return sent;
  }

  /**
   * Uma mensagem no grupo. O cliente nunca lança e nunca devolve a URL (que
   * leva o token): o aviso no log é só o código.
   */
  static async notifyTelegram({ token, chatId }, body) {
    const resultado = await sendTelegramMessage({ token, chatId, text: body });
    if (resultado.ok) return 1;
    console.warn(`Telegram alert not sent: ${resultado.code}`);
    return 0;
  }

  /**
   * A mensagem de teste do botão da tela. Lança com a frase do motivo — é
   * isso que diz ao operador que o bot não está no grupo.
   */
  static async sendTelegramTest() {
    const settings = await this.getSettings();
    if (!settings.telegram.token || !settings.telegram.chatId) {
      throw new WaError('whatsapp.alerts.telegramNotConfigured', { code: 'telegram_not_configured', status: 400 });
    }
    const tenant = await Tenant.findPublicById(currentTenantId()).catch(() => null);
    const t = translatorFor(DEFAULT_LOCALE);
    const resultado = await sendTelegramMessage({
      token: settings.telegram.token,
      chatId: settings.telegram.chatId,
      text: t('whatsapp.alerts.telegramTestMessage', { name: tenant?.name || 'SkyGenPanel' })
    });
    if (resultado.ok) return { sent: true };
    throw new WaError(TELEGRAM_ERROR_KEYS[resultado.code] || TELEGRAM_ERROR_KEYS.telegram_failed, {
      code: resultado.code,
      status: 502
    });
  }

  /**
   * A primeira linha da mensagem, com o nome do provedor na frente: quem
   * atende vários ISPs precisa saber de qual veio antes de abrir.
   */
  static emailSubject(body, tenantName) {
    const primeira = String(body).split('\n').find((linha) => linha.trim()) || '';
    const assunto = tenantName ? `[${tenantName}] ${primeira.trim()}` : primeira.trim();
    return assunto.length > EMAIL_SUBJECT_MAX ? `${assunto.slice(0, EMAIL_SUBJECT_MAX - 1)}…` : assunto;
  }

  /**
   * The message text.
   *
   * A background job has no request locale, so it resolves through the panel's
   * default rather than guessing at one — the same default `attachLocale` falls
   * back to when a browser sends no `Accept-Language`.
   */
  static compose(condition, cleared) {
    const keys = RULE_KEYS[condition.rule];
    const key = keys ? (cleared ? keys.cleared : keys.firing) : null;
    if (!key) return null;
    const t = translatorFor(DEFAULT_LOCALE);
    return t(key, condition.vars || {});
  }
}

export { DEFAULT_RULES, DEFAULT_SETTINGS, LAST_SCAN_KEY, RULE_KEYS, SETTINGS_KEY };
export default WaAlertService;
