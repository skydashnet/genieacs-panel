import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearEvolution } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { readContacts } = await import('../src/utils/wa/evolutionApi.js');

/**
 * "Importar do WhatsApp conectado": a agenda do número pareado vira clientes,
 * só os que o painel ainda não conhece, e nada existente é alterado.
 */

const HOST = 'evo-agenda.provedor.test';
let panelUrl;
let token;
let desfazerRota;
let evolution;
let respostaAgenda;
const pedidos = [];

const api = (rota, options = {}) => call(`${panelUrl}/api/contacts${rota}`, { headers: authHeaders(token), ...options });

// Contatos como o Evolution v2 devolve: pessoas, um grupo, uma lista de
// transmissão, um status, um @lid e um repetido.
const AGENDA = [
  { remoteJid: '5593991110001@s.whatsapp.net', pushName: 'Maria Nova' },
  // O João do contrato 301, na grafia antiga, sem o nono dígito.
  { remoteJid: '559391110002@s.whatsapp.net', pushName: 'João Já Cadastrado' },
  { remoteJid: '5593991110003@s.whatsapp.net', pushName: '' },
  // A Ana do contrato 302, que só tem telefone digitado à mão.
  { remoteJid: '5593991110004@s.whatsapp.net', pushName: 'Ana' },
  { remoteJid: '5593991110001@s.whatsapp.net', pushName: 'Maria Nova (de novo)' },
  { remoteJid: '120363000000000000@g.us', pushName: 'Grupo da rua' },
  { remoteJid: 'status@broadcast', pushName: 'Status' },
  { remoteJid: '99887766@lid', pushName: 'Sem número' }
];

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  respostaAgenda = { status: 200, data: AGENDA };
  evolution = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      pedidos.push({ method: req.method, path: req.url, apikey: req.headers.apikey, body: raw ? JSON.parse(raw) : null });
      res.writeHead(respostaAgenda.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(respostaAgenda.data));
    });
  });
  await new Promise((resolve) => evolution.listen(0, '127.0.0.1', resolve));
  desfazerRota = rotearEvolution((url) => (
    url.hostname === HOST ? `http://127.0.0.1:${evolution.address().port}${url.pathname}${url.search}` : null
  ));

  await getDb()('sgp_contacts').insert([
    { tenant_id: 1, contract: '301', client_name: 'JOÃO', phone_e164: '5593991110002', state: 'active' },
    { tenant_id: 1, contract: '302', client_name: 'ANA', phone_manual: '5593991110004', state: 'active' }
  ]);
});

after(async () => {
  desfazerRota?.();
  await new Promise((resolve) => evolution?.close(resolve));
  await stopTestServers();
});

const ligarWhatsapp = async () => {
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    allowedHosts: HOST,
    rateLimitPerMin: 60
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: 'agenda',
    purpose: 'general',
    flavor: 'v2',
    base_url: `https://${HOST}`,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));
};

describe('readContacts', () => {
  it('fica só com pessoas e extrai o número e o nome', () => {
    const lidos = readContacts('v2', AGENDA);
    assert.deepEqual(lidos.map((c) => c.number), [
      '5593991110001', '559391110002', '5593991110003', '5593991110004', '5593991110001'
    ]);
    assert.equal(lidos[0].name, 'Maria Nova');
  });

  it('lê também a resposta do Evolution GO', () => {
    const lidos = readContacts('go', {
      data: [{ Jid: '559391110009@s.whatsapp.net', FullName: 'Fulano GO' }, { Jid: '1203@g.us', FullName: 'Grupo' }]
    });
    assert.deepEqual(lidos, [{ number: '559391110009', name: 'Fulano GO' }]);
  });

  it('resposta que não é lista dá lista vazia', () => {
    assert.deepEqual(readContacts('v2', null), []);
    assert.deepEqual(readContacts('v2', { error: 'x' }), []);
  });
});

describe('POST /api/contacts/import/whatsapp', () => {
  it('sem WhatsApp ligado: 400 not_configured', async () => {
    const { status, body } = await api('/import/whatsapp?mode=preview', { method: 'POST', body: {} });
    assert.equal(status, 400);
    assert.equal(body.code, 'not_configured');
  });

  it('a prévia separa novos, já cadastrados e repetidos, sem gravar nada', async () => {
    await ligarWhatsapp();
    const antes = await getDb()('sgp_contacts').count({ n: '*' }).first();
    const { status, body } = await api('/import/whatsapp?mode=preview', { method: 'POST', body: {} });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.total, 5);
    assert.equal(body.data.creates, 2, 'Maria e a pessoa sem nome salvo');
    assert.equal(body.data.existing, 2, 'João (também sem o nono dígito) e Ana (telefone manual)');
    assert.equal(body.data.duplicated, 1);
    assert.deepEqual(body.data.rows.map((r) => r.phone), ['5593991110001', '5593991110003']);
    assert.equal(body.data.rows[1].name, '5593991110003', 'sem nome, fica o número');
    const depois = await getDb()('sgp_contacts').count({ n: '*' }).first();
    assert.equal(Number(depois.n), Number(antes.n));
    const pedido = pedidos.at(-1);
    assert.equal(pedido.method, 'POST');
    assert.equal(pedido.path, '/chat/findContacts/agenda');
    assert.equal(pedido.apikey, 'token-instancia');
  });

  it('aplicar cria os clientes novos e uma segunda vez não cria nada', async () => {
    const { status, body } = await api('/import/whatsapp?mode=apply', { method: 'POST', body: {} });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.created, 2);
    const maria = await getDb()('sgp_contacts').where({ client_name: 'Maria Nova' }).first();
    assert.equal(maria.phone_e164, '5593991110001');
    assert.equal(maria.contract, null);

    const outra = await api('/import/whatsapp?mode=apply', { method: 'POST', body: {} });
    assert.equal(outra.body.data.created, 0);
    const joao = await getDb()('sgp_contacts').where({ contract: '301' }).first();
    assert.equal(joao.client_name, 'JOÃO', 'o que existia não muda');
  });

  it('o filtro "Importados" separa quem veio da agenda e da planilha', async () => {
    const importarCsv = (csv) => fetch(`${panelUrl}/api/contacts/import?mode=apply`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'text/csv' },
      body: csv
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    const planilha = await importarCsv('Nome;WhatsApp\nCarla da Planilha;93991110005\n');
    assert.equal(planilha.status, 200, JSON.stringify(planilha.body));
    assert.equal(planilha.body.data.created, 1);

    const lista = (query) => call(`${panelUrl}/api/whatsapp/contacts${query}`, { headers: authHeaders(token) });
    const todos = await lista('');
    const nomes = (r) => r.body.data.contacts.map((c) => c.clientName).sort();
    assert.ok(nomes(todos).includes('JOÃO'), 'sem o filtro, o cadastro do SGP aparece');

    const importados = await lista('?imported=true');
    assert.equal(importados.status, 200);
    assert.deepEqual(nomes(importados), ['5593991110003', 'Carla da Planilha', 'Maria Nova']);
    assert.equal(importados.body.data.total, 3);
    const origem = new Map(importados.body.data.contacts.map((c) => [c.clientName, c.importSource]));
    assert.equal(origem.get('Maria Nova'), 'whatsapp');
    assert.equal(origem.get('Carla da Planilha'), 'sheet');
    assert.equal(todos.body.data.contacts.find((c) => c.clientName === 'JOÃO').importSource, null);

    // Combina com a situação: os importados não têm contrato, então "ativos" esvazia.
    const ativos = await lista('?imported=true&state=active');
    assert.equal(ativos.body.data.total, 0);
  });

  it('a exportação respeita o filtro "Importados"', async () => {
    const res = await fetch(`${panelUrl}/api/contacts/export?imported=true`, { headers: authHeaders(token) });
    const csv = await res.text();
    assert.match(csv, /Maria Nova/);
    assert.doesNotMatch(csv, /JOÃO/);
  });

  it('a agenda de mais de 1 MB cabe: o teto é maior só para esta leitura', async () => {
    const grande = Array.from({ length: 12000 }, (_, i) => ({
      remoteJid: `5593988${String(100000 + i)}@s.whatsapp.net`,
      pushName: `Contato número ${i} com um nome comprido para encher a resposta`
    }));
    respostaAgenda = { status: 200, data: grande };
    const { status, body } = await api('/import/whatsapp?mode=preview', { method: 'POST', body: {} });
    assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
    assert.equal(body.data.total, 12000);
    assert.equal(body.data.creates, 5000, 'o teto de novos por importação');
    assert.equal(body.data.truncated, true);
    respostaAgenda = { status: 200, data: AGENDA };
  });

  it('o servidor recusar vira 502 legível', async () => {
    respostaAgenda = { status: 500, data: { error: 'boom' } };
    const { status, body } = await api('/import/whatsapp?mode=preview', { method: 'POST', body: {} });
    assert.equal(status, 502);
    assert.equal(body.code, 'http_error');
    respostaAgenda = { status: 200, data: AGENDA };
  });
});
