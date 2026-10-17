import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: SgpContactSyncService } = await import('../src/services/sgpContactSyncService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');

/**
 * O botão "Enviar pelo WhatsApp" de cada título da ficha: a prévia traz o que
 * o SGP diz do título (linha digitável, PIX, link), e o envio entra na fila
 * de sempre, na conversa com o cliente — a que existe ou uma nova.
 */

const APP = 'painel';
const TOKEN = 'token-do-boleto';
const INSTANCE = 'painel-boleto';

const clientes = [
  {
    id: 21,
    nome: 'ELANE PATRIQUI',
    cpfcnpj: '123.456.789-09',
    contatos: { celulares: ['(93) 98851-9934', '(11) 92134-5262'] },
    contratos: [{ id: 329, status: 'Ativo', vencimento: '15' }]
  },
  {
    id: 22,
    nome: 'Sem Telefone',
    cpfcnpj: '987.654.321-00',
    contatos: { celulares: [] },
    contratos: [{ id: 330, status: 'Ativo' }]
  }
];

const titulos = {
  329: [
    {
      numeroDocumento: 'T-1001', valor: 159.5, vencimento: '2026-10-15',
      linhaDigitavel: '34191.79001 01043.510047 91020.150008 1 12340000015950',
      codigoPix: '00020126580014br.gov.bcb.pix0136chave-pix-exemplo',
      link: 'https://sgp.exemplo.test/boleto/T-1001'
    },
    // Sem PIX nem link: a prévia omite essas linhas.
    { numeroDocumento: 'T-1002', valor: 159.5, vencimento: '2026-11-15', linhaDigitavel: '34191.00000 00000.000000 00000.000000 1 00000000015950' }
  ],
  330: [{ numeroDocumento: 'T-2001', valor: 99.9, vencimento: '2026-10-20', linhaDigitavel: '11111' }]
};

let panelUrl;
let token;
let sgpServer;

const prever = (key, id) => call(
  `${panelUrl}/api/contacts/${encodeURIComponent(key)}/invoices/${encodeURIComponent(id)}/whatsapp`,
  { headers: authHeaders(token) }
);
const enviar = (key, id, text) => call(
  `${panelUrl}/api/contacts/${encodeURIComponent(key)}/invoices/${encodeURIComponent(id)}/whatsapp`,
  { method: 'POST', headers: authHeaders(token), body: { text } }
);

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (payload.app !== APP || payload.token !== TOKEN) return res.end(JSON.stringify({ status: 0, msg: 'Token inválido' }));
      if (req.url.includes('/titulos')) {
        return res.end(JSON.stringify({ status: 1, titulos: titulos[payload.contrato] ?? [] }));
      }
      const offset = Number(payload.offset) || 0;
      const limit = Number(payload.limit) || 10;
      return res.end(JSON.stringify({ status: 1, clientes: clientes.slice(offset, offset + limit) }));
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await startSgpStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => SgpService.saveConfig({
    enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'manual', contactsPageSize: 10
  }));
  await asTenant(() => SgpContactSyncService.syncAll());
  // O contrato 329 também tem ONT, e a linha da ONT não tem telefone: o número
  // é o que a sincronização de contatos trouxe, o mesmo que a ficha mostra.
  await asTenant(() => getDb()('sgp_links').insert({
    device_id: 'ONT-329', contract: '329', client_name: 'ELANE PATRIQUI', state: 'active', link_mode: 'auto'
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-da-instancia-boleto'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-do-webhook-boleto')
  }));
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('a prévia do boleto', () => {
  it('traz o valor, o vencimento, a linha, o PIX e o link do título certo', async () => {
    const res = await prever('329', 'T-1001');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { text, phone, contract } = res.body.data;
    assert.equal(contract, '329');
    assert.equal(phone, '5593988519934');
    assert.match(text, /Elane/, 'o primeiro nome, sem gritar em maiúsculas');
    assert.doesNotMatch(text, /ELANE/);
    assert.match(text, /R\$\s?159,50/);
    assert.match(text, /15\/10\/2026/);
    assert.match(text, /34191\.79001/);
    assert.match(text, /chave-pix-exemplo/);
    assert.match(text, /https:\/\/sgp\.exemplo\.test\/boleto\/T-1001/);
  });

  it('omite o PIX e o link quando o SGP não manda', async () => {
    const res = await prever('329', 'T-1002');
    assert.equal(res.status, 200);
    assert.match(res.body.data.text, /34191\.00000/);
    assert.doesNotMatch(res.body.data.text, /PIX/);
    assert.doesNotMatch(res.body.data.text, /https?:/);
  });

  it('um título de outro contrato, ou que não existe, dá 404', async () => {
    const outro = await prever('329', 'T-2001');
    assert.equal(outro.status, 404);
    assert.equal(outro.body.code, 'invoice_not_found');
    const nenhum = await prever('329', 'NAO-EXISTE');
    assert.equal(nenhum.status, 404);
  });
});

describe('a lista de contatos', () => {
  it('um contrato com ONT sem telefone aparece com o número da ficha', async () => {
    const res = await call(`${panelUrl}/api/whatsapp/contacts?search=329`, { headers: authHeaders(token) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const linha = res.body.data.contacts.find((contato) => contato.contract === '329');
    assert.ok(linha, JSON.stringify(res.body.data.contacts));
    assert.equal(linha.phone, '5593988519934');
  });
});

describe('a conversa pela ficha', () => {
  it('um contrato com ONT sem telefone abre a conversa pelo número da ficha', async () => {
    const ficha = await call(`${panelUrl}/api/contacts/329`, { headers: authHeaders(token) });
    assert.equal(ficha.body.data.whatsappPhone, '5593988519934');
    const res = await call(`${panelUrl}/api/whatsapp/contacts/329/conversation`, { method: 'POST', headers: authHeaders(token) });
    assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
    assert.equal(res.body.data.waPhoneE164, '5593988519934');
  });
});

describe('conversar com outro número da ficha', () => {
  const abrir = (body) => call(`${panelUrl}/api/whatsapp/contacts/329/conversation`, {
    method: 'POST', headers: authHeaders(token), body
  });

  it('abre a conversa com o número extra que a ficha lista', async () => {
    const res = await abrir({ phone: '(11) 92134-5262' });
    assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
    assert.equal(res.body.data.waPhoneE164, '5511921345262');
    assert.equal(res.body.data.contract, '329');
  });

  it('recusa um número que a ficha não lista', async () => {
    const res = await abrir({ phone: '(21) 99999-0000' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_phone');
  });
});

describe('o envio', () => {
  it('abre a conversa, enfileira o texto do operador e registra na trilha sem o texto', async () => {
    const texto = 'Olá! Segue o boleto.\n\nLinha: 34191.79001';
    const res = await enviar('329', 'T-1001', texto);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { conversationId, messageId, conversation } = res.body.data;
    assert.ok(conversation && conversation.id === conversationId);

    const mensagem = await asTenant(() => getDb()('wa_messages').where({ id: messageId }).first());
    assert.equal(mensagem.body, texto);
    assert.equal(mensagem.source, 'operator');
    assert.equal(mensagem.delivery_status, 'queued');
    assert.equal(mensagem.conversation_id, conversationId);

    const conversa = await asTenant(() => getDb()('wa_conversations').where({ id: conversationId }).first());
    assert.equal(conversa.contract, '329');

    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'contact.invoice_sent' }).orderBy('id', 'desc').first());
    assert.ok(trilha, 'o envio ficou na trilha');
    assert.doesNotMatch(String(trilha.detail), /34191/, 'a trilha não guarda o texto');
    assert.match(String(trilha.detail), /T-1001/);
  });

  it('o segundo envio usa a mesma conversa', async () => {
    const primeiro = await enviar('329', 'T-1002', 'boleto 2');
    const segundo = await enviar('329', 'T-1002', 'boleto 2 de novo');
    assert.equal(primeiro.status, 201);
    assert.equal(segundo.body.data.conversationId, primeiro.body.data.conversationId);
  });

  it('um texto vazio é recusado', async () => {
    const res = await enviar('329', 'T-1001', '   ');
    assert.equal(res.status, 400);
  });

  it('um cliente sem telefone do WhatsApp dá 409', async () => {
    const res = await enviar('330', 'T-2001', 'boleto');
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'subscriber_no_phone');
  });
});
