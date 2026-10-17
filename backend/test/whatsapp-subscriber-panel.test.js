import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';
import { buildDevice, startGenieAcsStub } from './helpers/genieacs-stub.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');

const APP = 'painel';
const SGP_TOKEN = 'token-secreto-modulo';
const DEVICE_ID = 'modulo-ont-1';
const DOCUMENTO = '15752819000182';
const ATIVO = '256';
const SUSPENSO = '255';
const ASSINANTE = '5593981215425';
const DESCONHECIDO = '5511900000009';
const WAN_IP = '100.64.10.20';
const LINHA = '34191790010104351004791020150008699999999999';
const LINHA_T3 = '34191790010104351004791020150008699999990003';
const PIX_T3 = '00020126580014br.gov.bcb.pix0136provedor-t3-pix5204000053039865406119.505802BR6304ABCD';

let panelUrl;
let token;
let genie;
let sgpServer;
let accountId;
let sgpDown = false;
const sgpRequests = [];
const fios = {};

/** The two contracts the one subscriber holds, in SGP's own shape. */
const CONTRATOS = [
  {
    contratoId: SUSPENSO,
    razaoSocial: 'SINDICATO DOS VIGILANTES',
    cpfcnpj: DOCUMENTO,
    contratoStatusDisplay: 'Suspenso',
    bloqueado: true,
    planoInternet: 'FIBRA 300',
    endereco: 'AVENIDA CARLETO BEMERGY'
  },
  {
    contratoId: ATIVO,
    clienteId: 57,
    razaoSocial: 'SINDICATO DOS VIGILANTES',
    cpfcnpj: DOCUMENTO,
    contratoStatusDisplay: 'Ativo',
    bloqueado: false,
    planoInternet: 'FIBRA 500',
    endereco: 'AVENIDA CARLETO BEMERGY, 100'
  }
];

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      sgpRequests.push({ url: req.url, payload });
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (sgpDown) return send({ status: 0, msg: 'Erro interno do servidor' });
      if (req.url.startsWith('/api/ura/consultacliente')) {
        if (payload.cpfcnpj === DOCUMENTO) return send({ status: 1, contratos: CONTRATOS });
        const one = CONTRATOS.filter((c) => c.contratoId === String(payload.contrato));
        return send(one.length ? { status: 1, contratos: one } : { status: 0, msg: 'Cliente não encontrado' });
      }
      if (req.url.startsWith('/api/ura/titulos')) {
        return send({
          status: 1,
          titulos: [
            { numerodocumento: 'T-0', valor: '99,90', vencimento: '2019-01-10', status: 'Cancelado' },
            { numerodocumento: 'T-2', valor: '99,90', vencimento: '2099-12-10', status: 'Em aberto' },
            { numerodocumento: 'T-1', valor: '99,90', vencimento: '2020-01-10', status: 'Em aberto', linhadigitavel: LINHA },
            // Uma fatura com tudo — boleto, PIX e linha — para o "Enviar na conversa".
            {
              numerodocumento: 'T-3',
              valor: '119,50',
              vencimento: '2020-03-10',
              status: 'Em aberto',
              linhadigitavel: LINHA_T3,
              pix: PIX_T3,
              link: 'https://sgp.provedor.test/boleto/T-3'
            }
          ]
        });
      }
      if (req.url.startsWith('/api/ura/liberacao')) {
        return send({ status: 1, msg: 'Liberado por 3 dias' });
      }
      return send({ status: 0, msg: 'Endpoint inexistente' });
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

function ontComIp() {
  const device = buildDevice({ id: DEVICE_ID });
  const ppp = device.InternetGatewayDevice.WANDevice[1].WANConnectionDevice[1].WANPPPConnection[1];
  ppp.ExternalIPAddress = { _value: WAN_IP, _writable: false };
  ppp.Password = { _value: 'senha-pppoe-secreta', _writable: true };
  return device;
}

async function fio(apelido, phone) {
  const conversa = await asTenant(() => WaConversation.ensure({
    accountId,
    externalThreadId: `${phone}@s.whatsapp.net`,
    waPhone: phone,
    waLid: null,
    pushName: apelido
  }));
  fios[apelido] = conversa.id;
}

const painel = (id, query = '') => call(
  `${panelUrl}/api/whatsapp/conversations/${id}/subscriber${query}`,
  { headers: authHeaders(token) }
);
const agir = (id, acao, body) => call(
  `${panelUrl}/api/whatsapp/conversations/${id}/subscriber/${acao}`,
  { method: 'POST', headers: authHeaders(token), body }
);
const liberacoes = () => sgpRequests.filter((r) => r.url.startsWith('/api/ura/liberacao'));

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: [ontComIp()] });
  const sgpUrl = await startSgpStub();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await call(`${panelUrl}/api/settings/genieAcsUrl`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { value: genie.url }
  });
  await call(`${panelUrl}/api/sgp/config`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: { enabled: true, baseUrl: sgpUrl, app: APP, token: SGP_TOKEN, linkMode: 'manual' }
  });

  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-modulo',
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia-modulo'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-webhook-modulo')
  }));
  accountId = account.id;

  await asTenant(() => SgpLink.upsert({
    device_id: DEVICE_ID,
    contract: ATIVO,
    client_name: 'SINDICATO DOS VIGILANTES',
    document: DOCUMENTO,
    state: 'active',
    link_mode: 'manual',
    phone_e164: ASSINANTE,
    last_synced_at: new Date()
  }));

  await fio('assinante', ASSINANTE);
  await fio('estranho', DESCONHECIDO);
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await genie.close();
  await stopTestServers();
});

beforeEach(() => {
  sgpDown = false;
  sgpRequests.length = 0;
});

describe('the SGP module beside a thread', () => {
  it('finds every contract of the subscriber and picks the active one', async () => {
    const { status, body } = await painel(fios.assinante);
    assert.equal(status, 200, JSON.stringify(body));
    const data = body.data;
    assert.equal(data.ready, true);
    assert.deepEqual(data.contracts.items.map((c) => c.contract).sort(), [SUSPENSO, ATIVO].sort());
    assert.equal(data.contracts.selected, ATIVO);
    assert.equal(data.contract.state, 'active');
    assert.equal(data.attendance.clientName, 'SINDICATO DOS VIGILANTES');
    assert.equal(data.attendance.matchedOn, 'sgp');
  });

  it('links to the client page in the SGP web app, and only from a client id SGP sent', async () => {
    const { body } = await painel(fios.assinante);
    assert.match(body.data.sgpUrl, /\/admin\/cliente\/57\/contratos\/$/);
    assert.ok(body.data.sgpUrl.startsWith('http://127.0.0.1:'));

    // The suspended contract comes without a client id: no link, no guess.
    const other = await painel(fios.assinante, `?contract=${SUSPENSO}`);
    assert.equal(other.body.data.sgpUrl, null);
  });

  it('reads the router address from the ONT, not from the ERP', async () => {
    const { body } = await painel(fios.assinante);
    assert.equal(body.data.router.available, true);
    assert.equal(body.data.router.deviceId, DEVICE_ID);
    assert.equal(body.data.router.ipAddress, WAN_IP);
    assert.equal(JSON.stringify(body).includes('senha-pppoe-secreta'), false, 'no PPPoE password leaves the server');
  });

  it('points at the oldest overdue invoice, and never at a cancelled one', async () => {
    const { body } = await painel(fios.assinante);
    assert.deepEqual(body.data.invoices.items.map((i) => i.id).sort(), ['T-1', 'T-2', 'T-3']);
    assert.equal(body.data.invoices.highlight, 'T-1');
  });

  it('takes the operator pick exactly, and has no router for a contract without an ONT', async () => {
    const { body } = await painel(fios.assinante, `?contract=${SUSPENSO}`);
    assert.equal(body.data.contracts.selected, SUSPENSO);
    assert.equal(body.data.contract.state, 'blocked');
    assert.equal(body.data.router.available, false);
    assert.equal(body.data.router.reason, 'unlinked');
  });

  it('selects nothing for a contract that is not in the list, rather than guessing', async () => {
    const { body } = await painel(fios.assinante, '?contract=9999');
    assert.equal(body.data.contracts.selected, null);
    assert.equal(body.data.contracts.missing, true);
    assert.equal(body.data.contract, null);
  });

  it('falls back to the stored link while SGP is failing', async () => {
    sgpDown = true;
    const { status, body } = await painel(fios.assinante);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.contracts.stale, true);
    assert.ok(body.data.contracts.error?.message);
    assert.deepEqual(body.data.contracts.items.map((c) => c.contract), [ATIVO]);
    assert.equal(body.data.router.ipAddress, WAN_IP, 'the router half does not depend on the ERP');
    assert.ok(body.data.invoices.error);
  });
});

describe('acting from the thread', () => {
  it('unlocks a contract the lookup found for this conversation', async () => {
    const { status, body } = await agir(fios.assinante, 'unlock', { contract: SUSPENSO });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.contract, SUSPENSO);
    assert.equal(String(liberacoes().at(-1).payload.contrato), SUSPENSO);
  });

  it('refuses a contract that belongs to somebody else, before calling SGP', async () => {
    const { status, body } = await agir(fios.assinante, 'unlock', { contract: '9999' });
    assert.equal(status, 409);
    assert.equal(body.code, 'contract_not_in_conversation');
    assert.equal(liberacoes().length, 0);
  });

  it('refuses to authorise from the stale link while SGP is failing', async () => {
    sgpDown = true;
    const { status } = await agir(fios.assinante, 'unlock', { contract: SUSPENSO });
    assert.notEqual(status, 200);
    assert.equal(liberacoes().length, 0);
  });

  it('gives an unknown number nothing to act on', async () => {
    const { body } = await painel(fios.estranho);
    assert.equal(body.data.contracts.searched, false);
    assert.equal(body.data.contract, null);

    const { status } = await agir(fios.estranho, 'unlock', { contract: ATIVO });
    assert.equal(status, 409);
    assert.equal(liberacoes().length, 0);
  });

  it('binds an unknown number after the operator searches by document', async () => {
    const wrong = await agir(fios.estranho, 'bind', { contract: '9999', document: DOCUMENTO });
    assert.equal(wrong.status, 409);

    const { status, body } = await agir(fios.estranho, 'bind', { contract: ATIVO, document: DOCUMENTO });
    assert.equal(status, 200, JSON.stringify(body));
    const row = await getDb()('wa_conversations').where({ id: fios.estranho }).first();
    assert.equal(row.contract, ATIVO);
    assert.equal(row.device_id, DEVICE_ID);
    assert.equal(body.data.router.ipAddress, WAN_IP);
  });
});

describe('the second copy and the number, from the thread', () => {
  const segundaVia = (body) => agir(fios.assinante, 'second-copy', body);

  it('renders the oldest overdue invoice into the billing text, and sends nothing', async () => {
    const antes = await getDb()('wa_messages').count({ total: '*' }).first();
    const { status, body } = await segundaVia({
      contract: ATIVO,
      template: 'Olá {{nome}}, a fatura de {{valor}} venceu há {{dias_atraso}} dias. Linha: {{linha_digitavel}}'
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.invoiceId, 'T-1');
    assert.match(body.data.text, /SINDICATO DOS VIGILANTES/);
    assert.match(body.data.text, /R\$ 99,90/);
    assert.ok(body.data.text.includes(LINHA));
    const depois = await getDb()('wa_messages').count({ total: '*' }).first();
    assert.deepEqual(depois, antes, 'the text goes back to the composer, never to the outbox');
  });

  it('refuses the whole text when the template cites a field the invoice lacks', async () => {
    const { status, body } = await segundaVia({ contract: ATIVO, template: 'PIX: {{pix}}' });
    assert.equal(status, 409);
    assert.equal(body.code, 'template_incomplete');
  });

  it('refuses a contract that is not this conversation', async () => {
    const { status, body } = await segundaVia({ contract: '9999', template: 'Olá {{nome}}' });
    assert.equal(status, 409);
    assert.equal(body.code, 'contract_not_in_conversation');
  });

  it('saves the thread number as the contract manual phone', async () => {
    const { status, body } = await agir(fios.estranho, 'phone', { contract: ATIVO });
    assert.equal(status, 200, JSON.stringify(body));
    const [link] = await getDb()('sgp_links').where({ contract: ATIVO });
    assert.equal(link.phone_manual, DESCONHECIDO);
    assert.equal(body.data.attendance.matchedOn, 'manual');

    const outro = await agir(fios.estranho, 'phone', { contract: '9999' });
    assert.equal(outro.status, 409);
  });
});

describe('"Enviar na conversa": a fatura em mensagens separadas', () => {
  const enviar = (body) => agir(fios.assinante, 'invoice', body);
  const saidas = () => getDb()('wa_messages')
    .where({ conversation_id: fios.assinante, direction: 'out' })
    .orderBy('id');

  it('manda o resumo com o boleto, depois o PIX puro e a linha pura, em ordem', async () => {
    const antes = (await saidas()).length;
    const { status, body } = await enviar({ contract: ATIVO, invoiceId: 'T-3' });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.messages.length, 3);
    const novas = (await saidas()).slice(antes);
    assert.equal(novas.length, 3);
    assert.match(novas[0].body, /R\$ 119,50/);
    assert.match(novas[0].body, /https:\/\/sgp\.provedor\.test\/boleto\/T-3/);
    assert.equal(novas[1].body, PIX_T3, 'o PIX vai sozinho, para copiar');
    assert.equal(novas[2].body, LINHA_T3, 'a linha vai sozinha, para copiar');
    for (const m of novas) {
      assert.equal(m.source, 'operator');
      assert.ok(m.sent_by, 'a mensagem não ficou com o operador');
    }
    const trilha = await getDb()('audit_log').where({ action: 'whatsapp.invoice_sent' }).orderBy('id', 'desc').first();
    assert.ok(trilha, 'o envio não foi para a trilha');
    assert.ok(!String(trilha.detail).includes(PIX_T3), 'o código de pagamento foi para a trilha');
  });

  it('sem PIX nem link, manda só o resumo e a linha', async () => {
    const antes = (await saidas()).length;
    const { status, body } = await enviar({ contract: ATIVO, invoiceId: 'T-1' });
    assert.equal(status, 201, JSON.stringify(body));
    const novas = (await saidas()).slice(antes);
    assert.equal(novas.length, 2);
    assert.equal(novas[1].body, LINHA);
  });

  it('uma fatura que não está em aberto neste contrato não sai', async () => {
    const antes = (await saidas()).length;
    const { status, body } = await enviar({ contract: ATIVO, invoiceId: 'T-0' });
    assert.equal(status, 404);
    assert.equal(body.code, 'invoice_not_found');
    assert.equal((await saidas()).length, antes);
  });

  it('um contrato que não é desta conversa não sai', async () => {
    const antes = (await saidas()).length;
    const { status, body } = await enviar({ contract: '9999', invoiceId: 'T-3' });
    assert.equal(status, 409);
    assert.equal(body.code, 'contract_not_in_conversation');
    assert.equal((await saidas()).length, antes);
  });
});
