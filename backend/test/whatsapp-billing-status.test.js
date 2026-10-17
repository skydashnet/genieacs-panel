import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: BillingStatusService } = await import('../src/services/billingStatusService.js');
const { situacaoFinanceira, situacaoPorVencimento } = await import('../src/utils/wa/waCobranca.js');

/** A cor da situação financeira: em dia, vence hoje, atrasado. */

const APP = 'painel';
const TOKEN = 'token-situacao';
const hoje = new Date();
const dia = (offset) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};
const FATURAS = {
  'S-ATRASADO': [{ numerodocumento: 'A1', valor: '99,90', vencimento: dia(-3) }],
  'S-HOJE': [{ numerodocumento: 'H1', valor: '99,90', vencimento: dia(0) }],
  'S-EMDIA': [{ numerodocumento: 'E1', valor: '99,90', vencimento: dia(5) }]
};
let panelUrl;
let token;
let sgpServer;
let accountId;
const pedidos = [];

before(async () => {
  ({ panelUrl } = await startTestServers());
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      pedidos.push(payload.contrato);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!req.url.startsWith('/api/ura/titulos')) return res.end(JSON.stringify({ status: 0 }));
      return res.end(JSON.stringify({ status: 1, titulos: FATURAS[String(payload.contrato)] || [] }));
    });
  });
  const sgpUrl = await new Promise((r) => sgpServer.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${sgpServer.address().port}`)));
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'cores', password: 'cores-senha-1', email: 'cores@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => SgpService.saveConfig({ enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'pppoe' }));
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-cores', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.test', status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('t-cores'), ...WhatsAppConfigService.encryptWebhookToken('w-cores')
  }));
  accountId = account.id;
});

after(async () => {
  await new Promise((r) => sgpServer.close(r));
  await stopTestServers();
});

describe('a regra das cores', () => {
  it('em dia, vence hoje, atrasado — no fuso de São Paulo', () => {
    assert.equal(situacaoFinanceira([], hoje).status, 'ok');
    assert.equal(situacaoFinanceira([{ dueDate: dia(1) }], hoje).status, 'ok');
    assert.equal(situacaoFinanceira([{ dueDate: dia(0) }], hoje).status, 'due_today');
    assert.deepEqual(situacaoFinanceira([{ dueDate: dia(5) }, { dueDate: dia(-1) }], hoje).daysOverdue, 1);
    // 23 h em São Paulo é 02 h do dia seguinte em UTC: ainda é "hoje" lá.
    const noite = new Date('2026-10-06T02:00:00Z');
    assert.equal(situacaoPorVencimento('2026-10-05', noite).status, 'due_today');
    assert.equal(situacaoPorVencimento('2026-10-05', new Date('2026-10-06T15:00:00Z')).status, 'overdue');
  });
});

describe('na caixa de entrada', () => {
  it('a lista traz a cor; a foto que falta é buscada em segundo plano', async () => {
    for (const [i, contract] of Object.keys(FATURAS).entries()) {
      // eslint-disable-next-line no-await-in-loop
      const c = await asTenant(() => WaConversation.ensure({
        accountId, externalThreadId: `559398120000${i}@s.whatsapp.net`, waPhone: `559398120000${i}`, waLid: null, pushName: contract
      }));
      // eslint-disable-next-line no-await-in-loop
      await getDb()('wa_conversations').where({ id: c.id }).update({ contract, engaged_at: new Date(), last_message_at: new Date() });
    }
    const listar = async () => (await call(`${panelUrl}/api/whatsapp/conversations`, { headers: authHeaders(token) })).body.data;
    const primeira = await listar();
    assert.ok(primeira.every((c) => c.billing === null), 'sem foto ainda: a lista não espera o SGP');

    // A atualização em segundo plano termina; a próxima leitura traz a cor.
    for (let i = 0; i < 50 && BillingStatusService.refreshing.size; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    const segunda = await listar();
    const cor = Object.fromEntries(segunda.map((c) => [c.contract, c.billing?.status]));
    assert.deepEqual(cor, { 'S-ATRASADO': 'overdue', 'S-HOJE': 'due_today', 'S-EMDIA': 'ok' });
    assert.equal(segunda.find((c) => c.contract === 'S-ATRASADO').billing.daysOverdue, 3);

    // Fresca, não consulta de novo.
    const antes = pedidos.length;
    await listar();
    assert.equal(pedidos.length, antes);
  });

  it('a virada do dia muda a cor sem nova consulta', async () => {
    const amanha = new Date(Date.now() + 86_400_000);
    const mapa = await asTenant(() => BillingStatusService.forContracts(['S-HOJE'], amanha));
    assert.equal(mapa.get('S-HOJE').status, 'overdue');
  });
});
