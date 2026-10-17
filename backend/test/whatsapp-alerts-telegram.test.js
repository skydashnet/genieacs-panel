import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const { setTelegramFetcher, telegramRefusal } = await import('../src/services/telegramClient.js');

/**
 * Alertas técnicos pelo Telegram: um bot do provedor mandando para um grupo.
 *
 * O que estes casos defendem: o token nunca sai — nem na resposta dos
 * ajustes, nem na trilha, nem no log — e fica cifrado no banco; a ONT que cai
 * vira UMA mensagem no grupo, a recuperação também, e o cooldown vale; e o
 * botão de teste diz o motivo quando não chega (token, grupo, bot fora dele).
 */
const TOKEN = '123456789:AAHdemo-token-do-bot-com-segredo-bem-longo';
const OUTRO_TOKEN = '987654321:BBHoutro-token-do-bot-com-segredo-longo';
const GRUPO = '-1001234567890';
const MINUTE = 60_000;

let panelUrl;
let token;
let fleet = [];
let realDashboardDevices;
/** O Telegram falso: o que chegou, e como ele responde. */
let chamadas = [];
let responder = () => ({ status: 200, body: { ok: true, result: {} } });
const avisos = [];
let realWarn;

const scan = () => asTenant(() => WaAlertService.scan());
const offline = (id, minutes = 45) => ({ _id: id, rxpower: -20, temperature: 45, _lastInform: new Date(Date.now() - minutes * MINUTE).toISOString() });
const onlyOffline = { ont_offline: { enabled: true }, rx_power_low: { enabled: false }, temperature_high: { enabled: false }, mass_outage: { enabled: false } };
const put = (body) => call(`${panelUrl}/api/whatsapp/alerts/settings`, { method: 'PUT', headers: authHeaders(token), body });
const testar = (tk = token) => call(`${panelUrl}/api/whatsapp/alerts/telegram/test`, { method: 'POST', headers: authHeaders(tk), body: {} });

before(async () => {
  ({ panelUrl } = await startTestServers());
  realDashboardDevices = DeviceService.getDashboardDevices;
  DeviceService.getDashboardDevices = async () => fleet;
  setTelegramFetcher(async (url, options) => {
    chamadas.push({ url, body: JSON.parse(options.body) });
    const { status, body } = responder(url, options);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  realWarn = console.warn;
  console.warn = (...args) => { avisos.push(args.join(' ')); realWarn(...args); };
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => {
  console.warn = realWarn;
  setTelegramFetcher(null);
  DeviceService.getDashboardDevices = realDashboardDevices;
  WaAlertService.stop();
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('wa_alert_state').del();
  await getDb()('app_state').where({ key: 'whatsapp_alert_settings' }).del();
  WaAlertService.settingsCache.clear();
  chamadas = [];
  avisos.length = 0;
  fleet = [];
  responder = () => ({ status: 200, body: { ok: true, result: {} } });
});

describe('guardar o bot', () => {
  it('o token fica cifrado no banco e nunca volta na resposta', async () => {
    const { status, body } = await put({ enabled: true, rules: onlyOffline, telegram: { botToken: TOKEN, chatId: GRUPO } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.telegram, { configured: true, chatId: GRUPO });
    assert.ok(!JSON.stringify(body).includes(TOKEN), 'o token saiu na resposta dos ajustes');
    const lido = await call(`${panelUrl}/api/whatsapp/alerts/settings`, { headers: authHeaders(token) });
    assert.ok(!JSON.stringify(lido.body).includes(TOKEN), 'o token saiu na leitura dos ajustes');
    const linha = await getDb()('app_state').where({ key: 'whatsapp_alert_settings' }).first();
    assert.ok(!linha.value.includes(TOKEN), 'o token está em texto no banco');
    assert.ok(JSON.parse(linha.value).telegram.botToken.password_ciphertext);
  });

  it('salvar sem mandar o token mantém o guardado; mandar vazio apaga', async () => {
    await put({ telegram: { botToken: TOKEN, chatId: GRUPO } });
    const mantido = await put({ telegram: { chatId: '-100999' } });
    assert.deepEqual(mantido.body.data.telegram, { configured: true, chatId: '-100999' });
    const apagado = await put({ telegram: { botToken: '' } });
    assert.equal(apagado.body.data.telegram.configured, false);
  });

  it('recusa o token e o grupo fora do formato', async () => {
    const token1 = await put({ telegram: { botToken: 'isso-nao-e-token' } });
    assert.equal(token1.status, 400);
    assert.equal(token1.body.code, 'invalid_telegram_token');
    const grupo = await put({ telegram: { chatId: 'grupo da equipe' } });
    assert.equal(grupo.status, 400);
    assert.equal(grupo.body.code, 'invalid_telegram_chat');
  });

  it('a trilha diz que o bot mudou e qual o grupo — nunca o token', async () => {
    await getDb()('audit_log').where({ action: AuditLog.ACTIONS.ALERTS_TELEGRAM_CHANGED }).del();
    await put({ telegram: { botToken: TOKEN, chatId: GRUPO } });
    await put({ intervalSeconds: 600 });
    const linhas = await getDb()('audit_log').where({ action: AuditLog.ACTIONS.ALERTS_TELEGRAM_CHANGED });
    assert.equal(linhas.length, 1, 'salvar outra coisa não é mudar o Telegram');
    assert.deepEqual(JSON.parse(linhas[0].detail), { tokenChanged: true, chatId: GRUPO });
    assert.ok(!linhas[0].detail.includes(TOKEN));
  });

  it('só o Telegram já é alguém para avisar', async () => {
    const { status } = await put({ enabled: true, recipients: [], emailRecipients: [], telegram: { botToken: TOKEN, chatId: GRUPO } });
    assert.equal(status, 200);
  });
});

describe('o alerta no grupo', () => {
  beforeEach(async () => {
    await asTenant(() => WaAlertService.saveSettings({ enabled: true, rules: onlyOffline, telegram: { botToken: TOKEN, chatId: GRUPO } }));
  });

  it('a ONT que cai vira UMA mensagem no grupo, pelo bot do provedor', async () => {
    fleet = [offline('ont-tg-1')];
    const summary = await scan();
    assert.equal(summary.skipped, null, JSON.stringify(summary));
    assert.equal(summary.fired, 1);
    assert.equal(chamadas.length, 1);
    assert.match(chamadas[0].url, new RegExp(`/bot${TOKEN}/sendMessage$`));
    assert.equal(chamadas[0].body.chat_id, GRUPO);
    assert.match(chamadas[0].body.text, /ont-tg-1/);
  });

  it('o cooldown vale, e a recuperação chega', async () => {
    fleet = [offline('ont-tg-1')];
    await scan();
    await scan();
    assert.equal(chamadas.length, 1, 'repetiu dentro do cooldown');
    fleet = [offline('ont-tg-1', 1)];
    const summary = await scan();
    assert.equal(summary.cleared, 1);
    assert.equal(chamadas.length, 2);
    assert.match(chamadas[1].body.text, /ont-tg-1/);
  });

  it('o Telegram recusando não derruba a passagem, e o log não leva o token', async () => {
    responder = () => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
    fleet = [offline('ont-tg-2')];
    const summary = await scan();
    assert.equal(summary.error, null);
    assert.equal(summary.fired, 1);
    assert.ok(avisos.some((aviso) => aviso.includes('telegram_invalid_token')));
    assert.ok(avisos.every((aviso) => !aviso.includes(TOKEN)), 'o token foi para o log');
  });
});

describe('a mensagem de teste', () => {
  beforeEach(async () => {
    await asTenant(() => WaAlertService.saveSettings({ telegram: { botToken: TOKEN, chatId: GRUPO } }));
  });

  it('chega no grupo com o nome do provedor', async () => {
    const { status } = await testar();
    assert.equal(status, 200);
    assert.equal(chamadas.length, 1);
    const nome = (await getDb()('tenants').orderBy('id').first()).name;
    assert.ok(chamadas[0].body.text.includes(nome));
  });

  it('diz o motivo quando não chega, sem o token na resposta', async () => {
    for (const [resposta, codigo] of [
      [{ status: 401, body: { ok: false, description: 'Unauthorized' } }, 'telegram_invalid_token'],
      [{ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }, 'telegram_chat_not_found'],
      [{ status: 403, body: { ok: false, description: 'Forbidden: bot is not a member of the supergroup chat' } }, 'telegram_bot_not_in_chat']
    ]) {
      responder = () => resposta;
      const { status, body } = await testar();
      assert.equal(status, 502, codigo);
      assert.equal(body.code, codigo);
      assert.ok(!JSON.stringify(body).includes(TOKEN));
    }
  });

  it('a rede caída vira `telegram_unreachable`, sem a URL', async () => {
    responder = () => { throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`); };
    const { status, body } = await testar();
    assert.equal(status, 502);
    assert.equal(body.code, 'telegram_unreachable');
    assert.ok(!JSON.stringify(body).includes(TOKEN));
    assert.ok(avisos.every((aviso) => !aviso.includes(TOKEN)), 'a URL com o token foi para o log');
  });

  it('sem bot configurado, pede para configurar', async () => {
    await asTenant(() => WaAlertService.saveSettings({ telegram: { botToken: '' } }));
    const { status, body } = await testar();
    assert.equal(status, 400);
    assert.equal(body.code, 'telegram_not_configured');
  });

  it('a leitura das recusas do Telegram, sem rede', () => {
    assert.equal(telegramRefusal(401, 'Unauthorized'), 'telegram_invalid_token');
    assert.equal(telegramRefusal(403, 'Forbidden'), 'telegram_bot_not_in_chat');
    assert.equal(telegramRefusal(400, 'Bad Request: chat not found'), 'telegram_chat_not_found');
    assert.equal(telegramRefusal(400, 'Bad Request: message is too long'), 'telegram_failed');
  });
});

describe('outro token, outro provedor', () => {
  it('trocar o token passa a mandar pelo bot novo', async () => {
    await asTenant(() => WaAlertService.saveSettings({ enabled: true, rules: onlyOffline, telegram: { botToken: TOKEN, chatId: GRUPO } }));
    await asTenant(() => WaAlertService.saveSettings({ telegram: { botToken: OUTRO_TOKEN } }));
    fleet = [offline('ont-tg-3')];
    await scan();
    assert.match(chamadas[0].url, new RegExp(`/bot${OUTRO_TOKEN}/`));
  });
});
