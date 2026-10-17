import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: WaBillingService } = await import('../src/services/waBillingService.js');

/**
 * De onde vem o celular de quem a régua cobra.
 *
 * O caso real: a tela de Contatos mostrava o WhatsApp do assinante, e a régua
 * dizia "Sem celular no cadastro" — ela lia só `sgp_links`, o vínculo com a
 * ONT, onde o número quase nunca está; o número mora em `sgp_contacts`, que a
 * sincronização do SGP preenche. E quem não tem ONT no painel nem entrava na
 * conta.
 */

const APP = 'painel';
const TOKEN = 'token-regua-telefones';
let panelUrl;
let token;
let sgpServer;

function dayOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const INVOICES = {
  'C-LINK-SEM-FONE': [{ numerodocumento: 'A1', valor: '119,50', vencimento: dayOffset(-4), pix: 'pix-a' }],
  'C-SO-CONTATO': [{ numerodocumento: 'B1', valor: '119,50', vencimento: dayOffset(-4), pix: 'pix-b' }],
  'C-MANUAL': [{ numerodocumento: 'C1', valor: '119,50', vencimento: dayOffset(-4), pix: 'pix-c' }],
  'C-NADA': [{ numerodocumento: 'D1', valor: '119,50', vencimento: dayOffset(-4), pix: 'pix-d' }]
};

before(async () => {
  ({ panelUrl } = await startTestServers());
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (payload.app !== APP || payload.token !== TOKEN) return res.end(JSON.stringify({ status: 0 }));
      const titulos = INVOICES[String(payload.contrato)];
      return res.end(JSON.stringify(titulos ? { status: 1, titulos } : { status: 0, msg: 'Contrato inexistente' }));
    });
  });
  const sgpUrl = await new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => SgpService.saveConfig({ enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'pppoe' }));

  const now = new Date();
  const link = (contract, index, extra = {}) => ({
    device_id: `ont-fone-${index}`,
    contract,
    client_name: `Link ${contract}`,
    document: '12345678909',
    state: 'active',
    link_mode: 'auto',
    phone_e164: null,
    created_at: now,
    updated_at: now,
    ...extra
  });
  await asTenant(() => getDb()('sgp_links').insert([
    // O caso da tela: vínculo com a ONT, sem número; o número está no contato.
    link('C-LINK-SEM-FONE', 1),
    // O operador corrigiu o número no vínculo, e o contato tem outro do SGP.
    link('C-MANUAL', 2, { phone_manual: '5593981119999' }),
    // Sem número em lugar nenhum.
    link('C-NADA', 3)
  ]));
  await asTenant(() => getDb()('sgp_contacts').insert([
    { contract: 'C-LINK-SEM-FONE', client_name: 'KELLY SILVA AGUIAR', phone_e164: '5593991648687', state: 'active' },
    // Cliente do SGP sem ONT neste painel.
    { contract: 'C-SO-CONTATO', client_name: 'Sem ONT', phone_e164: '5593981112222', state: 'active' },
    { contract: 'C-MANUAL', client_name: 'Manual', phone_e164: '5593981113333', state: 'active' },
    { contract: 'C-NADA', client_name: 'Nada', phone_e164: null, state: 'active' }
  ].map((row) => ({ ...row, tenant_id: 1 }))));
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('o telefone de quem a régua cobra', () => {
  it('vem do contato sincronizado quando o vínculo não tem', async () => {
    const [kelly] = await asTenant(() => WaBillingService.subscribers({ contracts: ['C-LINK-SEM-FONE'] }));
    assert.equal(kelly.phone, '5593991648687');
    assert.equal(kelly.phoneSource, 'sgp');
    assert.equal(kelly.deviceId, 'ont-fone-1');
  });

  it('inclui o cliente do SGP que não tem ONT no painel', async () => {
    const todos = await asTenant(() => WaBillingService.subscribers());
    const semOnt = todos.find((s) => s.contract === 'C-SO-CONTATO');
    assert.ok(semOnt, 'o contrato só de sgp_contacts entra na lista');
    assert.equal(semOnt.phone, '5593981112222');
    assert.equal(semOnt.clientName, 'Sem ONT');
    assert.equal(todos.filter((s) => s.contract === 'C-LINK-SEM-FONE').length, 1, 'um por contrato');
  });

  it('a correção do operador vence o número do SGP', async () => {
    const [manual] = await asTenant(() => WaBillingService.subscribers({ contracts: ['C-MANUAL'] }));
    assert.equal(manual.phone, '5593981119999');
    assert.equal(manual.phoneSource, 'manual');
  });

  it('a listagem da cobrança avulsa mostra o número e só o que não tem nada fica sem', async () => {
    const { status, body } = await call(`${panelUrl}/api/whatsapp/billing/overdue?daysMin=1&daysMax=30&limit=50`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200, JSON.stringify(body));
    const por = new Map(body.data.map((row) => [row.contract, row]));
    assert.equal(por.get('C-LINK-SEM-FONE').phone, '5593991648687');
    assert.equal(por.get('C-SO-CONTATO').phone, '5593981112222');
    assert.equal(por.get('C-NADA').phone, null);
  });

  it('corrigir o número pela régua vale mesmo para quem só tem contato', async () => {
    const res = await call(`${panelUrl}/api/whatsapp/subscribers/C-SO-CONTATO/phone`, {
      method: 'PUT', headers: authHeaders(token), body: { phone: '(93) 98111-4444' }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.phone, '5593981114444');
    assert.equal(res.body.data.phoneSource, 'manual');
  });
});
