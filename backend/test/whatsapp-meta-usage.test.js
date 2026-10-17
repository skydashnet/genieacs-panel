/**
 * Relatório de modelos da Meta enviados por mês, por categoria, com a
 * estimativa em reais a partir dos preços que o provedor digita.
 *
 * As datas são escritas como `new Date(ano, mês, dia)` locais de propósito: o
 * relatório vira o mês no fuso do servidor, e o teste tem de falar no mesmo
 * relógio que ele.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  asTenant, authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaMetaUsageService } = await import('../src/services/waMetaUsageService.js');
const { tinsert, tinsertReturningId } = await import('../src/config/database.js');

let panelUrl;
let token;
let beta;
let cloudId;
let baileysId;

const agora = new Date();
/** Dia 10 do mês `offset` (0 = corrente, -1 = anterior...), 12 h locais. */
const noMes = (offset) => new Date(agora.getFullYear(), agora.getMonth() + offset, 10, 12, 0, 0);
const chaveMes = (offset) => {
  const d = noMes(offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

async function conversa(accountId, fone) {
  return tinsertReturningId('wa_conversations', {
    account_id: accountId,
    external_thread_id: `${fone}@s.whatsapp.net`,
    wa_phone_e164: `+${fone}`,
    created_at: new Date(),
    updated_at: new Date()
  });
}

async function mensagem(conversationId, { modelo, status = 'sent', sentAs = 'template', offset = 0, raw }) {
  return WaMessage.create({
    conversation_id: conversationId,
    direction: 'out',
    body: 'corpo',
    source: 'campaign',
    delivery_status: status,
    sent_as: sentAs,
    meta_template: raw !== undefined ? raw : (modelo ? JSON.stringify({ name: modelo, language: 'pt_BR', params: [] }) : null),
    created_at: noMes(offset),
    updated_at: noMes(offset)
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(async () => {
    const cloud = await WhatsAppAccount.create({
      name: 'oficial-uso',
      label: 'Número oficial',
      purpose: 'general',
      flavor: 'v2',
      integration: 'cloud',
      base_url: 'https://evo-uso.provedor.test',
      status: 'connected',
      is_default: true,
      ...WhatsAppConfigService.encryptInstanceToken('EAAGm0PX4ZCpsBAMetaPermanentTokenUso1234567890'),
      ...WhatsAppConfigService.encryptWebhookToken('webhook-uso')
    });
    cloudId = cloud.id;
    const baileys = await WhatsAppAccount.create({
      name: 'suporte-uso',
      purpose: 'support',
      flavor: 'v2',
      base_url: 'https://evo-uso.provedor.test',
      status: 'connected',
      is_default: false,
      ...WhatsAppConfigService.encryptInstanceToken('token-baileys-uso'),
      ...WhatsAppConfigService.encryptWebhookToken('webhook-baileys-uso')
    });
    baileysId = baileys.id;

    for (const [name, category] of [['aviso_fatura', 'utility'], ['promo', 'MARKETING'], ['codigo', 'AUTHENTICATION']]) {
      // eslint-disable-next-line no-await-in-loop -- três linhas
      await tinsert('wa_meta_templates', {
        account_id: cloudId, name, language: 'pt_BR', category, status: 'APPROVED', synced_at: new Date()
      });
    }

    const cA = await conversa(cloudId, '5593911110001');
    const cB = await conversa(baileysId, '5593911110002');
    // Mês corrente.
    await mensagem(cA, { modelo: 'aviso_fatura', status: 'sent' });
    await mensagem(cA, { modelo: 'aviso_fatura', status: 'delivered' });
    await mensagem(cA, { modelo: 'promo', status: 'read' });
    await mensagem(cA, { modelo: 'promo', status: 'failed' });
    await mensagem(cA, { modelo: 'promo', status: 'queued' });
    await mensagem(cA, { modelo: null, status: 'sent', sentAs: 'text' });
    await mensagem(cA, { modelo: 'nao_sincronizado', status: 'sent' });
    await mensagem(cA, { raw: '{quebrado', status: 'delivered' });
    // Mês anterior: um pelo número oficial, outro por um número sem modelos
    // sincronizados — a categoria vem do nome+idioma em qualquer número.
    await mensagem(cA, { modelo: 'codigo', status: 'sent', offset: -1 });
    await mensagem(cB, { modelo: 'aviso_fatura', status: 'read', offset: -1 });
    // Dois meses atrás.
    await mensagem(cA, { modelo: 'aviso_fatura', status: 'sent', offset: -2 });
    // Fora de um período de 3 meses, dentro de 6.
    await mensagem(cA, { modelo: 'promo', status: 'sent', offset: -4 });
  });

  // Um segundo provedor manda modelo no mês corrente: não pode aparecer no Alfa.
  beta = await insertReturningId('tenants', { slug: 'beta-uso', name: 'Provedor Beta', status: 'active' });
  await runInTenant(beta, async () => {
    const conta = await WhatsAppAccount.create({
      name: 'beta-oficial-uso',
      purpose: 'general',
      flavor: 'v2',
      integration: 'cloud',
      base_url: 'https://evo.beta-uso.test',
      status: 'connected',
      is_default: true,
      ...WhatsAppConfigService.encryptInstanceToken('EAAGm0PX4ZCpsBAMetaPermanentTokenBeta123456789'),
      ...WhatsAppConfigService.encryptWebhookToken('webhook-beta-uso')
    });
    await tinsert('wa_meta_templates', {
      account_id: conta.id, name: 'promo', language: 'pt_BR', category: 'MARKETING', status: 'APPROVED', synced_at: new Date()
    });
    const c = await conversa(conta.id, '5593922220001');
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- três linhas
      await mensagem(c, { modelo: 'promo', status: 'sent' });
    }
  });
});

after(async () => {
  await stopTestServers();
});

const api = (path, init = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...init });

describe('relatório de modelos da Meta por mês', () => {
  it('conta por mês e categoria, falhas à parte, e ignora fila, texto e período', async () => {
    const r = await asTenant(() => WaMetaUsageService.report({ months: 3 }));
    assert.equal(r.months, 3);
    assert.equal(r.truncated, false);
    assert.ok(r.timezone);
    assert.deepEqual(r.monthly.map((m) => m.month), [chaveMes(-2), chaveMes(-1), chaveMes(0)]);

    const [m2, m1, m0] = r.monthly;
    assert.deepEqual(m0.byCategory, { UTILITY: 2, MARKETING: 1, UNKNOWN: 2 });
    assert.equal(m0.total, 5);
    assert.equal(m0.failed, 1);
    assert.deepEqual(m1.byCategory, { AUTHENTICATION: 1, UTILITY: 1 });
    assert.equal(m1.total, 2);
    assert.deepEqual(m2.byCategory, { UTILITY: 1 });
    assert.equal(m2.failed, 0);

    assert.deepEqual(r.totals, {
      byCategory: { UTILITY: 4, MARKETING: 1, UNKNOWN: 2, AUTHENTICATION: 1 }, total: 8, failed: 1
    });
    assert.deepEqual(r.categories.slice(0, 5), ['MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE', 'UNKNOWN']);
    assert.equal(r.estimate, null, 'sem preço digitado não há estimativa');
  });

  it('classifica o modelo não sincronizado e o JSON quebrado como UNKNOWN', async () => {
    const r = await asTenant(() => WaMetaUsageService.report({ months: 3 }));
    const nao = r.templates.find((t) => t.name === 'nao_sincronizado');
    assert.equal(nao.category, 'UNKNOWN');
    const quebrado = r.templates.find((t) => t.name === '');
    assert.equal(quebrado.category, 'UNKNOWN');
    assert.equal(quebrado.count, 1);
  });

  it('ordena os modelos pelo uso e quebra por número', async () => {
    const r = await asTenant(() => WaMetaUsageService.report({ months: 3 }));
    assert.equal(r.templates[0].name, 'aviso_fatura');
    assert.equal(r.templates[0].count, 4);
    assert.equal(r.templates[0].category, 'UTILITY');
    const promo = r.templates.find((t) => t.name === 'promo');
    assert.deepEqual([promo.count, promo.failed], [1, 1]);

    const oficial = r.accounts.find((a) => a.accountId === Number(cloudId));
    assert.equal(oficial.label, 'Número oficial');
    assert.equal(oficial.total, 7);
    assert.equal(oficial.failed, 1);
    const suporte = r.accounts.find((a) => a.accountId === Number(baileysId));
    assert.equal(suporte.name, 'suporte-uso');
    assert.deepEqual(suporte.byCategory, { UTILITY: 1 });
  });

  it('6 e 12 meses alcançam a mensagem antiga; um período estranho vira 6', async () => {
    const seis = await asTenant(() => WaMetaUsageService.report({ months: 6 }));
    assert.equal(seis.monthly.length, 6);
    assert.equal(seis.totals.total, 9);
    assert.equal(seis.totals.byCategory.MARKETING, 2);
    assert.equal(seis.monthly.find((m) => m.month === chaveMes(-4)).total, 1);
    assert.equal(seis.monthly.find((m) => m.month === chaveMes(-3)).total, 0, 'mês vazio aparece zerado');

    const doze = await asTenant(() => WaMetaUsageService.report({ months: 12 }));
    assert.equal(doze.monthly.length, 12);
    assert.equal(doze.totals.total, 9);

    const estranho = await asTenant(() => WaMetaUsageService.report({ months: 99 }));
    assert.equal(estranho.months, 6);
  });

  it('não mostra o que outro provedor mandou', async () => {
    const r = await asTenant(() => WaMetaUsageService.report({ months: 3 }));
    assert.equal(r.monthly[2].byCategory.MARKETING, 1);
    const doBeta = await runInTenant(beta, () => WaMetaUsageService.report({ months: 3 }));
    assert.equal(doBeta.totals.total, 3);
    assert.deepEqual(doBeta.totals.byCategory, { MARKETING: 3 });
  });

  it('responde pela rota HTTP', async () => {
    const r = await api('/meta-usage?months=3');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.months, 3);
    assert.equal(r.body.data.totals.total, 8);
    const estranho = await api('/meta-usage?months=99');
    assert.equal(estranho.body.data.months, 6);
  });
});

describe('preços dos modelos da Meta', () => {
  it('salva, e a estimativa sai das contagens', async () => {
    const put = await api('/meta-prices', { method: 'PUT', body: { MARKETING: 0.35, UTILITY: '0.05', EXTRA: 9 } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.data, { MARKETING: 0.35, UTILITY: 0.05, AUTHENTICATION: null, SERVICE: null });

    const get = await api('/meta-prices');
    assert.deepEqual(get.body.data, put.body.data);

    const r = await api('/meta-usage?months=3');
    assert.deepEqual(r.body.data.estimate, {
      byCategory: { MARKETING: 0.35, UTILITY: 0.2 }, total: 0.55, currency: 'BRL'
    });
  });

  it('recusa negativo, texto, infinito e acima do teto', async () => {
    for (const valor of [-1, 'abc', 'Infinity', 1000]) {
      // eslint-disable-next-line no-await-in-loop -- quatro pedidos
      const r = await api('/meta-prices', { method: 'PUT', body: { AUTHENTICATION: valor } });
      assert.equal(r.status, 400, `${valor}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'invalid_meta_price');
    }
    const get = await api('/meta-prices');
    assert.equal(get.body.data.AUTHENTICATION, null, 'nada foi gravado');
    assert.equal(get.body.data.MARKETING, 0.35);
  });

  it('null limpa uma categoria; sem preço nenhum a estimativa some', async () => {
    const put = await api('/meta-prices', { method: 'PUT', body: { MARKETING: null, UTILITY: '' } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.data, { MARKETING: null, UTILITY: null, AUTHENTICATION: null, SERVICE: null });
    const r = await api('/meta-usage?months=3');
    assert.equal(r.body.data.estimate, null);
  });

  it('os preços de um provedor não valem para o outro', async () => {
    await api('/meta-prices', { method: 'PUT', body: { SERVICE: 0.01 } });
    const doBeta = await runInTenant(beta, () => WaMetaUsageService.getPrices());
    assert.equal(doBeta.SERVICE, null);
    const rows = await getDb()('app_state').where({ key: 'wa_meta_prices' });
    assert.equal(rows.length, 1);
  });
});
