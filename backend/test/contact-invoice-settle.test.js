import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: SgpContactSyncService } = await import('../src/services/sgpContactSyncService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');

/**
 * O botão "Receber" de cada título da ficha: a baixa vai ao SGP pela rota do
 * banco (`/api/banco/titulo/{id}/baixar/`), com o id do título que o próprio
 * SGP mandou, e o comprovante, se pedido, sai pela fila do WhatsApp.
 */

const APP = 'painel';
const TOKEN = 'token-da-baixa';

const clientes = [
  {
    id: 31,
    nome: 'IZERCLEUBER VIEIRA',
    cpfcnpj: '540.858.022-91',
    contatos: { celulares: ['(93) 99203-7298'] },
    contratos: [{ id: 608, status: 'Ativo', vencimento: '7' }]
  }
];

const sgp = {
  server: null,
  titulos: null,
  baixas: [],
  // Como o SGP responde à baixa: um objeto, um texto, ou uma recusa.
  responder: null
};

function titulosBase() {
  return [
    { id: 9001, numeroDocumento: 'D-608-1', valor: 49.5, vencimento: '2026-10-07' },
    // Sem o id do SGP: o painel não sabe para onde mandar a baixa.
    { numeroDocumento: 'D-608-2', valor: 49.5, vencimento: '2026-11-07' }
  ];
}

let panelUrl;
let token;

const receber = (id, body, key = '608') => call(
  `${panelUrl}/api/contacts/${encodeURIComponent(key)}/invoices/${encodeURIComponent(id)}/settle`,
  { method: 'POST', headers: authHeaders(token), body }
);
const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

before(async () => {
  ({ panelUrl } = await startTestServers());
  sgp.titulos = titulosBase();
  sgp.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      const baixa = req.url.match(/^\/api\/banco\/titulo\/([^/]+)\/baixar\/$/);
      if (baixa) {
        sgp.baixas.push({ id: baixa[1], payload });
        if (sgp.responder) return sgp.responder(res);
        // Baixado: some da lista de abertos.
        sgp.titulos = sgp.titulos.filter((titulo) => String(titulo.id) !== baixa[1]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 1, msg: 'Título baixado com sucesso' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.includes('/titulos')) return res.end(JSON.stringify({ status: 1, titulos: String(payload.contrato) === '608' ? sgp.titulos : [] }));
      return res.end(JSON.stringify({ status: 1, clientes }));
    });
  });
  await new Promise((resolve) => sgp.server.listen(0, '127.0.0.1', resolve));
  const sgpUrl = `http://127.0.0.1:${sgp.server.address().port}`;

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'manual', contactsPageSize: 10
  }));
  await asTenant(() => SgpContactSyncService.syncAll());
  await asTenant(() => WhatsAppAccount.create({
    name: 'painel-baixa',
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-da-instancia-baixa'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-do-webhook-baixa')
  }));
});

after(async () => {
  await new Promise((resolve) => sgp.server.close(resolve));
  await stopTestServers();
});

describe('sem o ponto de recebimento configurado', () => {
  it('a ficha não oferece o Receber e a rota responde 409 sem chamar o SGP', async () => {
    const ficha = await call(`${panelUrl}/api/contacts/608`, { headers: authHeaders(token) });
    assert.equal(ficha.body.data.settle, null);
    const res = await receber('D-608-1', { amount: 49.5, method: 'PIX' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(sgp.baixas.length, 0);
  });
});

describe('o caminho da baixa', () => {
  it('aceita o {{fatura_id}} do Postman como o id do título', async () => {
    const config = await asTenant(() => SgpService.saveConfig({ endpoints: { invoiceSettle: '{{url}}/api/banco/titulo/{{fatura_id}}/baixar/' } }));
    assert.equal(config.endpoints.invoiceSettle, '/api/banco/titulo/{id}/baixar/');
  });

  it('recusa um caminho sem o id', async () => {
    await assert.rejects(
      asTenant(() => SgpService.saveConfig({ endpoints: { invoiceSettle: '/api/banco/titulo/baixar/' } })),
      (error) => error.code === 'invalid_endpoint'
    );
  });
});

describe('receber um título', () => {
  before(async () => {
    const res = await call(`${panelUrl}/api/sgp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { settleReceivingPoint: 3, settlePaymentMethods: 'Dinheiro, PIX', settleFees: 1.5 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.settleReady, true);
    assert.deepEqual(res.body.data.settlePaymentMethods, ['Dinheiro', 'PIX']);
  });

  it('a ficha oferece o Receber com as formas configuradas', async () => {
    const ficha = await call(`${panelUrl}/api/contacts/608`, { headers: authHeaders(token) });
    assert.deepEqual(ficha.body.data.settle, { methods: ['Dinheiro', 'PIX'] });
  });

  it('valores inválidos dão 400 e não chamam o SGP', async () => {
    const amanha = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    for (const body of [
      { amount: 0, method: 'PIX' },
      { amount: -5, method: 'PIX' },
      { amount: 49.5, method: 'Cheque' },
      { amount: 49.5, method: 'PIX', paidAt: amanha },
      { amount: 49.5, method: 'PIX', paidAt: '2026-02-30' }
    ]) {
      // eslint-disable-next-line no-await-in-loop -- um caso de cada vez
      const res = await receber('D-608-1', body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(res.body)}`);
    }
    assert.equal(sgp.baixas.length, 0);
  });

  it('um título sem o id do SGP dá 409, e um que não está em aberto dá 404', async () => {
    const semId = await receber('D-608-2', { amount: 49.5, method: 'PIX' });
    assert.equal(semId.status, 409, JSON.stringify(semId.body));
    const outro = await receber('NAO-EXISTE', { amount: 49.5, method: 'PIX' });
    assert.equal(outro.status, 404);
    assert.equal(sgp.baixas.length, 0);
  });

  it('a recusa do SGP volta com a mensagem dele e nada fica na trilha', async () => {
    sgp.responder = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 0, msg: 'Caixa fechado' }));
    };
    const res = await receber('D-608-1', { amount: 49.5, method: 'Dinheiro' });
    sgp.responder = null;
    assert.equal(res.status, 502);
    assert.match(res.body.message, /Caixa fechado/);
    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'contact.invoice_settled' }).first());
    assert.equal(trilha, undefined);
    sgp.baixas = [];
  });

  it('dá baixa com o id do SGP, os campos da chamada, a trilha e o comprovante', async () => {
    const res = await receber('D-608-1', { amount: 49.5, method: 'PIX', receipt: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(sgp.baixas.length, 1);
    const [baixa] = sgp.baixas;
    assert.equal(baixa.id, '9001');
    assert.equal(baixa.payload.app, APP);
    assert.equal(baixa.payload.token, TOKEN);
    assert.equal(baixa.payload.data_pagamento, hoje());
    assert.equal(baixa.payload.valor_pago, 49.5);
    assert.equal(baixa.payload.forma_pagamento, 'PIX');
    assert.equal(baixa.payload.ponto_recebimento, 3);
    assert.equal(baixa.payload.tarifas, 1.5);

    const { receipt } = res.body.data;
    assert.equal(receipt.sent, true, JSON.stringify(receipt));
    const mensagem = await asTenant(() => getDb()('wa_messages').where({ id: receipt.messageId }).first());
    assert.equal(mensagem.source, 'operator');
    assert.match(mensagem.body, /R\$\s?49,50/);
    assert.match(mensagem.body, /07\/10\/2026/);
    assert.match(mensagem.body, /PIX/);

    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'contact.invoice_settled' }).orderBy('id', 'desc').first());
    assert.ok(trilha);
    assert.match(String(trilha.detail), /9001/);
    assert.doesNotMatch(String(trilha.detail), /IZERCLEUBER/);
  });

  it('o mesmo título de novo dá 404: já não está em aberto', async () => {
    const res = await receber('D-608-1', { amount: 49.5, method: 'PIX' });
    assert.equal(res.status, 404);
    assert.equal(sgp.baixas.length, 1);
  });

  it('uma resposta em texto puro do SGP conta como baixa feita', async () => {
    sgp.titulos = titulosBase();
    sgp.baixas = [];
    sgp.responder = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end("'Título 9001 baixado com sucesso'");
    };
    const res = await receber('D-608-1', { amount: 50, method: 'Dinheiro', paidAt: '2026-10-01' });
    sgp.responder = null;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.message, 'Título 9001 baixado com sucesso');
    assert.equal(res.body.data.receipt, null, 'sem comprovante pedido');
    assert.equal(sgp.baixas[0].payload.data_pagamento, '2026-10-01');
  });
});

describe('o SGP que responde a baixa sem corpo', () => {
  // A rota do banco do SGP dá a baixa e responde 200 vazio (ou 204): é baixa
  // feita, com comprovante e trilha, não "resposta inválida".
  for (const [caso, responder] of [
    ['200 sem corpo', (res) => { res.writeHead(200); res.end(); }],
    ['204', (res) => { res.writeHead(204); res.end(); }],
    ['200 em HTML', (res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>ok</body></html>'); }]
  ]) {
    it(`${caso} conta como baixa feita`, async () => {
      sgp.titulos = titulosBase();
      sgp.baixas = [];
      sgp.responder = responder;
      const antes = await asTenant(() => getDb()('audit_log').where({ action: 'contact.invoice_settled' }).count({ n: '*' }).first());
      const res = await receber('D-608-1', { amount: 49.5, method: 'Dinheiro', receipt: true });
      sgp.responder = null;
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.message, null);
      assert.equal(res.body.data.receipt.sent, true, JSON.stringify(res.body.data.receipt));
      assert.equal(sgp.baixas.length, 1);
      const depois = await asTenant(() => getDb()('audit_log').where({ action: 'contact.invoice_settled' }).count({ n: '*' }).first());
      assert.equal(Number(depois.n), Number(antes.n) + 1);
    });
  }
});

describe('o id que chega à URL', () => {
  it('só um id numérico do SGP vira caminho', async () => {
    await assert.rejects(
      asTenant(() => SgpService.request('invoiceSettle', {}, null, { pathId: '1/../../admin' })),
      (error) => error.code === 'invoice_id_missing'
    );
  });
});
