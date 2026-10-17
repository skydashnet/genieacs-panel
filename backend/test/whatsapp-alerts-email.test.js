import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaAlertService } = await import('../src/services/waAlertService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');

/**
 * Alertas técnicos por e-mail.
 *
 * O que estes casos defendem: o e-mail é um canal por si — dispara sem o
 * WhatsApp configurado, e a recuperação chega por ele também; os dois canais
 * juntos avisam uma vez cada, com um cooldown só; e sem SMTP no servidor a
 * passagem para ANTES de abrir condição, com um motivo que manda o operador ao
 * lugar certo.
 */
const MINUTE = 60_000;
const informedMinutesAgo = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString();
const ON_CALL = '5511999990000';

let panelUrl;
let token;
let smtp;
let recebidas;
let smtpPort;
let fleet = [];
let realDashboardDevices;

const scan = () => asTenant(() => WaAlertService.scan());
const offline = (id, minutes = 45) => ({ _id: id, rxpower: -20, temperature: 45, _lastInform: informedMinutesAgo(minutes) });
const online = (id) => offline(id, 1);
const onlyOffline = { ont_offline: { enabled: true }, rx_power_low: { enabled: false }, temperature_high: { enabled: false }, mass_outage: { enabled: false } };
const alertRows = () => getDb()('wa_alert_state').orderBy('id');
const outbox = () => getDb()('wa_messages').where({ direction: 'out' }).orderBy('id');
/** As mensagens que chegaram ao SMTP, com o corpo já decodificado. */
const mensagens = () => recebidas.map((bruta) => decodificarQuotedPrintable(bruta));

function ligarSmtp() {
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtpPort}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
  resetMailTransport();
}

function desligarSmtp() {
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  resetMailTransport();
}

async function regras(extra) {
  await asTenant(() => WaAlertService.saveSettings({ enabled: true, rules: onlyOffline, ...extra }));
}

before(async () => {
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  smtpPort = smtp.address().port;
  ({ panelUrl } = await startTestServers());
  realDashboardDevices = DeviceService.getDashboardDevices;
  DeviceService.getDashboardDevices = async () => fleet;
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => {
  DeviceService.getDashboardDevices = realDashboardDevices;
  desligarSmtp();
  WaAlertService.stop();
  await stopTestServers();
  await new Promise((resolve) => smtp.close(resolve));
});

beforeEach(async () => {
  await getDb()('wa_messages').del();
  await getDb()('wa_alert_state').del();
  await getDb()('app_state').where({ key: 'whatsapp_alert_settings' }).del();
  recebidas.length = 0;
  fleet = [];
  WaAlertService.settingsCache.clear();
  desligarSmtp();
});

describe('os ajustes', () => {
  it('guardam os e-mails minúsculos e sem repetição', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { enabled: true, emailRecipients: 'Plantao@Provedor.test\nplantao@provedor.test; noc@provedor.test' }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.emailRecipients, ['plantao@provedor.test', 'noc@provedor.test']);
  });

  it('recusam o endereço inválido com o nome dele', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { emailRecipients: ['plantao@provedor.test', 'isso-nao-e-email'] }
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'invalid_email');
    assert.match(body.message, /isso-nao-e-email/);
  });

  it('ligar sem ninguém em canal nenhum é recusado', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/alerts/settings`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { enabled: true, recipients: [], emailRecipients: [] }
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'no_alert_recipients');
  });

  it('dizem se o servidor manda e-mail', async () => {
    const semSmtp = await call(`${panelUrl}/api/whatsapp/alerts/settings`, { headers: authHeaders(token) });
    assert.equal(semSmtp.body.data.mailConfigured, false);
    ligarSmtp();
    const comSmtp = await call(`${panelUrl}/api/whatsapp/alerts/settings`, { headers: authHeaders(token) });
    assert.equal(comSmtp.body.data.mailConfigured, true);
  });
});

describe('só e-mail, sem o WhatsApp configurado', () => {
  it('sem SMTP no servidor, para antes de abrir condição, com motivo próprio', async () => {
    await regras({ emailRecipients: ['plantao@provedor.test'] });
    fleet = [offline('ont-email-1')];
    const summary = await scan();
    assert.equal(summary.skipped, 'mail_not_configured');
    assert.equal((await alertRows()).length, 0, 'abriu condição que ninguém ia ouvir');

    const botao = await call(`${panelUrl}/api/whatsapp/alerts/scan`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(botao.status, 409);
    assert.equal(botao.body.code, 'mail_not_configured');
  });

  it('com SMTP, a ONT que cai vira um e-mail por endereço, com o provedor no assunto', async () => {
    ligarSmtp();
    await regras({ emailRecipients: ['plantao@provedor.test', 'noc@provedor.test'] });
    fleet = [offline('ont-email-1')];
    const summary = await scan();
    assert.equal(summary.skipped, null, JSON.stringify(summary));
    assert.equal(summary.fired, 1);
    assert.equal(summary.notified, 2);
    assert.equal(recebidas.length, 2);
    const [primeira] = mensagens();
    assert.match(primeira, /ont-email-1/);
    assert.match(primeira, /To: plantao@provedor\.test/i);
    const nome = (await getDb()('tenants').orderBy('id').first()).name;
    assert.ok(WaAlertService.emailSubject('ONT x offline', nome).startsWith(`[${nome}]`));
    assert.equal((await outbox()).length, 0, 'saiu mensagem de WhatsApp sem WhatsApp configurado');
  });

  it('o cooldown vale para o e-mail', async () => {
    ligarSmtp();
    await regras({ emailRecipients: ['plantao@provedor.test'] });
    fleet = [offline('ont-email-1')];
    await scan();
    await scan();
    assert.equal(recebidas.length, 1, 'o mesmo alerta saiu de novo dentro do cooldown');
  });

  it('a recuperação chega por e-mail também', async () => {
    ligarSmtp();
    await regras({ emailRecipients: ['plantao@provedor.test'] });
    fleet = [offline('ont-email-1')];
    await scan();
    fleet = [online('ont-email-1')];
    const summary = await scan();
    assert.equal(summary.cleared, 1);
    assert.equal(recebidas.length, 2);
    assert.match(mensagens()[1], /ont-email-1/);
    assert.equal((await alertRows()).length, 0);
  });
});

describe('os dois canais juntos', () => {
  it('uma condição, um aviso por canal', async () => {
    await asTenant(() => WhatsAppConfigService.saveConfig({
      enabled: true,
      webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook'
    }));
    await asTenant(() => WhatsAppAccount.create({
      name: 'alertas-email',
      purpose: 'alerts',
      flavor: 'v2',
      base_url: 'https://evo.provedor.test',
      status: 'connected',
      is_default: true,
      ...WhatsAppConfigService.encryptInstanceToken('token-alertas'),
      ...WhatsAppConfigService.encryptWebhookToken('webhook-alertas')
    }));
    ligarSmtp();
    await regras({ recipients: [ON_CALL], emailRecipients: ['plantao@provedor.test'] });
    fleet = [offline('ont-email-2')];
    const summary = await scan();
    assert.equal(summary.fired, 1);
    assert.equal(summary.notified, 2);
    assert.equal((await outbox()).length, 1);
    assert.equal(recebidas.length, 1);
    const [linha] = await alertRows();
    assert.equal(Number(linha.notify_count), 1, 'os dois canais contaram como dois avisos');
  });
});

describe('o assunto', () => {
  it('é a primeira linha, com o provedor na frente, cortado para o celular', () => {
    assert.equal(WaAlertService.emailSubject('ONT a offline há 45 min\nmais texto', 'Provedor X'), '[Provedor X] ONT a offline há 45 min');
    assert.equal(WaAlertService.emailSubject('ONT a offline', null), 'ONT a offline');
    const longo = WaAlertService.emailSubject('x'.repeat(300), 'P');
    assert.equal(longo.length, 120);
    assert.ok(longo.endsWith('…'));
  });
});
