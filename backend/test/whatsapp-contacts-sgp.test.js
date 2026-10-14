import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');

/**
 * Os assinantes do SGP sem ONT no painel.
 *
 * `sgp_links` é chaveada pela ONT, então quem não tem uma — rádio, outro
 * fabricante, cadastro novo — não aparecia nos contatos nem era reconhecido
 * quando escrevia. A busca no SGP por CPF/CNPJ ou contrato é o que o traz, e
 * `sgp_contacts` é onde ele fica.
 */

const APP = 'painel';
const TOKEN = 'token-secreto-contatos';
const INSTANCE = 'painel-contatos-sgp';
const WEBHOOK_TOKEN = 'segredo-do-webhook-contatos-sgp';

/** O que o SGP falso tem, por CPF/CNPJ e por contrato. */
const CADASTRO = [
  { contrato: 'S-100', razaoSocial: 'Rosa Sem ONT', cpfcnpj: '98765432100', contratoStatus: 'Ativo', celular: '(93) 99111-2222' },
  { contrato: 'S-200', razaoSocial: 'Pedro Sem Celular', cpfcnpj: '11122233344', contratoStatus: 'Ativo' },
  // O mesmo documento em dois contratos: a busca traz os dois.
  { contrato: 'S-300', razaoSocial: 'Maria Duas Casas', cpfcnpj: '55566677788', contratoStatus: 'Ativo', celular: '5593981113333' },
  { contrato: 'S-301', razaoSocial: 'Maria Duas Casas', cpfcnpj: '55566677788', contratoStatus: 'Suspenso', celular: '5593981113333' },
  // Este já tem ONT no painel.
  { contrato: 'C-ONT', razaoSocial: 'Com ONT', cpfcnpj: '44455566677', contratoStatus: 'Ativo', celular: '5511944445555' }
];

/**
 * O que a listagem de clientes (`/api/ura/clientes/`) tem além dos contratos:
 * um cadastro sem contrato, que o `consultacliente` não acha. Ela ignora o
 * filtro de propósito e devolve todo mundo — a busca tem que ficar só com o
 * CPF pedido.
 */
const CLIENTES = [
  { id: 701, nome: 'Diego Sem Contrato', cpfcnpj: '444.444.444-44', celular: '(93) 99444-4444', contratos: [] },
  { id: 702, nome: 'Um Estranho', cpfcnpj: '777.777.777-77', celular: '(93) 99777-7777', contratos: [] }
];

let panelUrl;
let token;
let accountId;
let beta;
let sgpServer;

const hook = (body) => call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });
const buscar = (search) => call(`${panelUrl}/api/whatsapp/contacts/lookup`, {
  method: 'POST', headers: authHeaders(token), body: { search }
});
const contatos = (query = '') => call(`${panelUrl}/api/whatsapp/contacts${query}`, { headers: authHeaders(token) });
const abrir = (contract) => call(
  `${panelUrl}/api/whatsapp/contacts/${encodeURIComponent(contract)}/conversation`,
  { method: 'POST', headers: authHeaders(token) }
);
const contatoDe = (contract) => asTenant(() => getDb()('sgp_contacts').where({ contract }).first());

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (payload.app !== APP || payload.token !== TOKEN) return send({ status: 0, msg: 'Token inválido' });
      if (req.url.startsWith('/api/ura/clientes/')) return send({ status: 1, clientes: CLIENTES });
      if (!req.url.startsWith('/api/ura/consultacliente')) return send({ status: 0, msg: 'Endpoint inexistente' });
      const contratos = CADASTRO.filter((c) => (
        (payload.cpfcnpj && c.cpfcnpj === payload.cpfcnpj)
        || (payload.contrato && c.contrato === payload.contrato)
      ));
      if (contratos.length === 0) return send({ status: 0, msg: 'Cliente não encontrado' });
      return send({ status: 1, contratos });
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

function eventoV2({ id, remoteJid }) {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid, fromMe: false, id },
      pushName: 'Cliente',
      message: { conversation: 'oi' },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  };
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await startSgpStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const db = getDb();
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  await asTenant(() => SgpService.saveConfig({ enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'manual' }));
  const account = await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-da-instancia-contatos-sgp'),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
  accountId = account.id;

  await asTenant(() => db('sgp_links').insert({
    device_id: 'ONT-COM', contract: 'C-ONT', client_name: 'Com ONT', state: 'active',
    link_mode: 'manual', phone_e164: '5511944445555'
  }));

  // Um contato do vizinho, com um contrato que este provedor também vai ter.
  await runInTenant(beta, () => db('sgp_contacts').insert({
    tenant_id: beta, contract: 'B-900', client_name: 'Assinante do Beta', phone_e164: '5511900009999'
  }));
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('buscar no SGP', () => {
  it('acha pelo CPF quem não tem ONT e guarda como contato', async () => {
    const res = await buscar('987.654.321-00');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.contacts.map((c) => c.contract), ['S-100']);
    const rosa = res.body.data.contacts[0];
    assert.equal(rosa.hasDevice, false);
    assert.equal(rosa.sgpUrl, null);
    assert.equal(rosa.clientName, 'Rosa Sem ONT');
    assert.equal(rosa.phone, '5593991112222');
    assert.equal(rosa.document, '•••2100');

    const linha = await contatoDe('S-100');
    assert.equal(linha.document, '98765432100');
    assert.equal(linha.state, 'active');
  });

  it('acha pelo contrato, e traz todos os contratos de um documento', async () => {
    const porContrato = await buscar('S-200');
    assert.deepEqual(porContrato.body.data.contacts.map((c) => c.contract), ['S-200']);

    const porDocumento = await buscar('55566677788');
    assert.deepEqual(porDocumento.body.data.contacts.map((c) => c.contract).sort(), ['S-300', 'S-301']);
  });

  it('não duplica quem já tem ONT: o contrato continua sendo de sgp_links', async () => {
    const res = await buscar('44455566677');
    assert.deepEqual(res.body.data.contacts.map((c) => c.contract), ['C-ONT']);
    assert.equal(res.body.data.contacts[0].hasDevice, true);
    assert.ok(!(await contatoDe('C-ONT')), 'nenhuma linha em sgp_contacts');
  });

  it('responde vazio, e não erro, quando o SGP não tem ninguém', async () => {
    const res = await buscar('00000000000');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.contacts, []);
  });

  it('pede um termo', async () => {
    const res = await buscar('   ');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'lookup_term_required');
  });
});

describe('buscar no SGP um cliente sem contrato', () => {
  it('acha pelo CPF na listagem de clientes, só o CPF pedido', async () => {
    const res = await buscar('444.444.444-44');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.contacts.map((c) => c.clientName), ['Diego Sem Contrato']);
    const diego = res.body.data.contacts[0];
    assert.equal(diego.hasContract, false);
    assert.equal(diego.state, 'none');
    // O id do cliente no SGP leva à página dele; sem id guardado, não há link.
    assert.match(diego.sgpUrl, /\/admin\/cliente\/701\/contratos\/$/);
    assert.match(diego.key, /^c:\d+$/);
    assert.equal(diego.phone, '5593994444444');

    const aberta = await call(`${panelUrl}/api/whatsapp/contacts/${encodeURIComponent(diego.key)}/conversation`, {
      method: 'POST', headers: authHeaders(token)
    });
    assert.equal(aberta.status, 201);
    assert.equal(aberta.body.data.clientName, 'Diego Sem Contrato');
    assert.equal(aberta.body.data.contract, null);
  });

  it('buscar de novo não duplica o cadastro', async () => {
    await buscar('44444444444');
    const linhas = await asTenant(() => getDb()('sgp_contacts').where({ document: '44444444444' }));
    assert.equal(linhas.length, 1);
  });
});

describe('o contato sem ONT no resto do WhatsApp', () => {
  it('aparece na lista de contatos, ao lado de quem tem ONT', async () => {
    const res = await contatos();
    const porContrato = new Map(res.body.data.contacts.map((c) => [c.contract, c]));
    assert.equal(porContrato.get('S-100').hasDevice, false);
    assert.equal(porContrato.get('C-ONT').hasDevice, true);
    assert.ok(!porContrato.has('B-900'), 'o contato do vizinho não aparece');

    const busca = await contatos('?search=rosa');
    assert.deepEqual(busca.body.data.contacts.map((c) => c.contract), ['S-100']);
  });

  it('abre conversa, já com o nome do SGP', async () => {
    const res = await abrir('S-100');
    assert.equal(res.status, 201);
    assert.equal(res.body.data.contract, 'S-100');
    assert.equal(res.body.data.deviceId, null);
    assert.equal(res.body.data.clientName, 'Rosa Sem ONT');
  });

  it('é reconhecido quando escreve, mesmo sem o nono dígito', async () => {
    await hook(eventoV2({ id: 'MSG-SGP-1', remoteJid: '559381113333@s.whatsapp.net' }));
    const fio = await asTenant(() => WaConversation.getByThread(accountId, '559381113333@s.whatsapp.net'));
    assert.ok(['S-300', 'S-301'].includes(fio.contract));
    assert.equal(fio.device_id, null);

    const lista = await call(`${panelUrl}/api/whatsapp/conversations`, { headers: authHeaders(token) });
    assert.equal(lista.body.data.find((row) => row.id === fio.id).clientName, 'Maria Duas Casas');
  });

  it('pode ser vinculado à mão, e o número salvo sobrevive a uma nova busca', async () => {
    await hook(eventoV2({ id: 'MSG-SGP-2', remoteJid: '5521955554444@s.whatsapp.net' }));
    const fio = await asTenant(() => WaConversation.getByThread(accountId, '5521955554444@s.whatsapp.net'));
    assert.equal(fio.contract, null);

    const res = await call(`${panelUrl}/api/whatsapp/conversations/${fio.id}/subscriber`, {
      method: 'POST', headers: authHeaders(token), body: { contract: 'S-200', savePhone: true }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.clientName, 'Pedro Sem Celular');
    assert.equal((await contatoDe('S-200')).phone_manual, '5521955554444');

    await buscar('S-200');
    assert.equal((await contatoDe('S-200')).phone_manual, '5521955554444');
  });

  it('não abre nem vincula o contato do vizinho', async () => {
    assert.equal((await abrir('B-900')).status, 404);
    const doBeta = await runInTenant(beta, () => getDb()('wa_conversations').where({ contract: 'B-900' }));
    assert.equal(doBeta.length, 0);
  });
});

describe('o Módulo SGP de um cliente com mais de um contrato', () => {
  it('lista todos os contratos do cliente mesmo sem ONT e sem documento guardado', async () => {
    // Uma conversa ligada a mão a S-300, sem ONT e com o cadastro sincronizado
    // sem CPF: a busca só pelo contrato achava um contrato só.
    await asTenant(() => getDb()('sgp_contacts').where({ contract: 'S-300' }).update({ document: null }));
    await hook(eventoV2({ id: 'MSG-SGP-DUAS', remoteJid: '5593977770000@s.whatsapp.net' }));
    const fio = await asTenant(() => WaConversation.getByThread(accountId, '5593977770000@s.whatsapp.net'));
    await asTenant(() => WaConversation.update(fio.id, { contract: 'S-300' }));

    const res = await call(`${panelUrl}/api/whatsapp/conversations/${fio.id}/subscriber`, { headers: authHeaders(token) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.contracts.items.map((c) => c.contract).sort(), ['S-300', 'S-301']);
    assert.equal(res.body.data.contract.contract, 'S-300', 'o contrato da conversa continua selecionado');

    const outro = await call(`${panelUrl}/api/whatsapp/conversations/${fio.id}/subscriber?contract=S-301`, { headers: authHeaders(token) });
    assert.equal(outro.body.data.contract.contract, 'S-301');
  });
});
