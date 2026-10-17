import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { variantesTelefoneBr } = await import('../src/utils/wa/waDestino.js');

const INSTANCE = 'painel-contatos';
const INSTANCE_TOKEN = 'token-da-instancia-contatos';
const WEBHOOK_TOKEN = 'segredo-do-webhook-contatos';

/**
 * Os assinantes do SGP como contatos do WhatsApp.
 *
 * Três coisas que a caixa de entrada não fazia: achar o assinante pelo número
 * que o WhatsApp de fato entrega (sem o nono dígito), abrir conversa com quem
 * ainda não escreveu, e deixar o operador dizer à mão de quem é um número que
 * o SGP não conhece.
 */

let panelUrl;
let token;
let accountId;
let beta;

const hook = (body) => call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });

function eventoV2({ id, remoteJid, texto = 'oi', pushName = 'Cliente' }) {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid, fromMe: false, id },
      pushName,
      message: { conversation: texto },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  };
}

const contatos = (query = '') => call(`${panelUrl}/api/whatsapp/contacts${query}`, { headers: authHeaders(token) });
const abrir = (contract) => call(
  `${panelUrl}/api/whatsapp/contacts/${encodeURIComponent(contract)}/conversation`,
  { method: 'POST', headers: authHeaders(token) }
);
const vincular = (id, body) => call(
  `${panelUrl}/api/whatsapp/conversations/${id}/subscriber`,
  { method: 'POST', headers: authHeaders(token), body }
);

async function link(row) {
  await asTenant(() => getDb()('sgp_links').insert({ state: 'active', link_mode: 'auto', ...row }));
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const db = getDb();
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  const account = await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(INSTANCE_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
  accountId = account.id;

  // O SGP guarda o celular com o nono dígito; o WhatsApp entrega sem ele.
  await link({ device_id: 'ONT-NOVE-1', contract: '9001', client_name: 'Carlinhos Vendas', document: '12345678909', phone_e164: '5593992081870' });
  // Dois aparelhos no mesmo contrato: um contato só.
  await link({ device_id: 'ONT-DUPLO-A', contract: '9002', client_name: 'Dona Benedita', phone_e164: '5511988880002' });
  await link({ device_id: 'ONT-DUPLO-B', contract: '9002', client_name: 'Dona Benedita', phone_e164: '5511988880002' });
  // Sem telefone no cadastro.
  await link({ device_id: 'ONT-SEM-FONE', contract: '9003', client_name: 'Sem Telefone' });
  // Para abrir conversa do zero.
  await link({ device_id: 'ONT-NOVA', contract: '9004', client_name: 'Tavares Novo', phone_e164: '5593991935695' });
  // Para o vínculo manual.
  await link({ device_id: 'ONT-MANUAL', contract: '9005', client_name: 'Gilson Manual', phone_e164: '5593981110005' });
  // Um fio antigo, de antes do vínculo na chegada, com o número de um assinante.
  await link({ device_id: 'ONT-ANTIGO', contract: '9006', client_name: 'Luiz Antigo', phone_e164: '5593981249067' });

  // O contrato que só o vizinho tem.
  await runInTenant(beta, () => getDb()('sgp_links').insert({
    tenant_id: beta,
    device_id: 'ONT-BETA-7777',
    contract: '7777',
    client_name: 'Assinante do Beta',
    state: 'active',
    phone_e164: '5511977770007'
  }));
});

after(async () => {
  await stopTestServers();
});

describe('o nono dígito', () => {
  it('casa as duas grafias de um celular', () => {
    assert.deepEqual(variantesTelefoneBr('5593992081870'), ['5593992081870', '559392081870']);
    assert.deepEqual(variantesTelefoneBr('559392081870'), ['559392081870', '5593992081870']);
    assert.deepEqual(variantesTelefoneBr('(93) 99208-1870'), ['5593992081870', '559392081870']);
  });

  it('nunca inventa um 9 para telefone fixo', () => {
    assert.deepEqual(variantesTelefoneBr('559335221234'), ['559335221234']);
  });

  it('vincula na chegada, com o bot ou sem ele, o celular que o WhatsApp manda sem o 9', async () => {
    const res = await hook(eventoV2({ id: 'MSG-NOVE-1', remoteJid: '559392081870@s.whatsapp.net', pushName: 'Carlinhos' }));
    assert.equal(res.status, 200);
    const fio = await asTenant(() => WaConversation.getByThread(accountId, '559392081870@s.whatsapp.net'));
    assert.equal(fio.contract, '9001');
    assert.equal(fio.device_id, 'ONT-NOVE-1');
  });
});

describe('a lista de contatos', () => {
  it('traz um contato por contrato, com o documento mascarado', async () => {
    const res = await contatos();
    assert.equal(res.status, 200);
    const lista = res.body.data.contacts;
    assert.equal(lista.filter((c) => c.contract === '9002').length, 1);
    const carlinhos = lista.find((c) => c.contract === '9001');
    assert.equal(carlinhos.document, '•••8909');
    assert.equal(carlinhos.phone, '5593992081870');
    assert.ok(carlinhos.conversationId, 'o fio que chegou sem o 9 é o fio deste contato');
  });

  it('procura por nome, contrato, documento e número', async () => {
    for (const termo of ['benedita', '9002', '88880002']) {
      const res = await contatos(`?search=${encodeURIComponent(termo)}`);
      assert.deepEqual(res.body.data.contacts.map((c) => c.contract), ['9002'], termo);
    }
    const porDocumento = await contatos('?search=123.456.789-09');
    assert.deepEqual(porDocumento.body.data.contacts.map((c) => c.contract), ['9001']);
  });

  it('filtra quem está sem telefone, combinando com a situação', async () => {
    // Suspenso e sem telefone; e um sem telefone na ONT mas com o celular no
    // cadastro do SGP — este tem número, e não entra no filtro.
    await link({ device_id: 'ONT-SUSPENSO', contract: '9010', client_name: 'Suspenso Sem Fone', state: 'blocked' });
    await link({ device_id: 'ONT-FONE-CADASTRO', contract: '9011', client_name: 'Fone No Cadastro' });
    await getDb()('sgp_contacts').insert({ tenant_id: 1, contract: '9011', client_name: 'Fone No Cadastro', phone_e164: '5593981110011' });

    const semFone = await contatos('?noPhone=true');
    assert.equal(semFone.status, 200);
    assert.deepEqual(semFone.body.data.contacts.map((c) => c.contract).sort(), ['9003', '9010']);
    assert.equal(semFone.body.data.total, 2);
    assert.ok(semFone.body.data.contacts.every((c) => !c.phone));

    const ativosSemFone = await contatos('?state=active&noPhone=true');
    assert.deepEqual(ativosSemFone.body.data.contacts.map((c) => c.contract), ['9003']);

    const todos = await contatos('?noPhone=false');
    assert.ok(todos.body.data.contacts.some((c) => c.contract === '9011' && c.phone === '5593981110011'));
  });

  it('não mostra o assinante do vizinho', async () => {
    const res = await contatos('?search=beta');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.contacts, []);
  });
});

describe('abrir conversa com um assinante', () => {
  it('cria o fio uma vez e devolve o mesmo depois', async () => {
    const primeira = await abrir('9004');
    assert.equal(primeira.status, 201);
    assert.equal(primeira.body.data.contract, '9004');
    assert.equal(primeira.body.data.waPhoneE164, '5593991935695');

    const segunda = await abrir('9004');
    assert.equal(segunda.status, 200);
    assert.equal(segunda.body.data.id, primeira.body.data.id);
  });

  it('a resposta que chega sem o 9 cai no mesmo fio', async () => {
    const aberto = await abrir('9004');
    await hook(eventoV2({ id: 'MSG-NOVE-2', remoteJid: '559391935695@s.whatsapp.net', pushName: 'Tavares' }));
    const fios = await asTenant(() => getDb()('wa_conversations').where({ contract: '9004' }));
    assert.equal(fios.length, 1);
    assert.equal(fios[0].id, aberto.body.data.id);
    assert.equal(fios[0].unread_count, 1);
  });

  it('reaproveita o fio que o assinante já abriu', async () => {
    const res = await abrir('9001');
    assert.equal(res.status, 200);
    const fio = await asTenant(() => WaConversation.getByThread(accountId, '559392081870@s.whatsapp.net'));
    assert.equal(res.body.data.id, fio.id);
  });

  it('recusa quem não tem telefone e o contrato que não existe', async () => {
    const semFone = await abrir('9003');
    assert.equal(semFone.status, 409);
    assert.equal(semFone.body.code, 'subscriber_no_phone');

    const inexistente = await abrir('0000');
    assert.equal(inexistente.status, 404);
    assert.equal(inexistente.body.code, 'subscriber_not_found');
  });

  it('não abre o contrato do vizinho', async () => {
    const res = await abrir('7777');
    assert.equal(res.status, 404);
    const doBeta = await runInTenant(beta, () => getDb()('wa_conversations').where({ contract: '7777' }));
    assert.equal(doBeta.length, 0);
  });
});

describe('vincular à mão', () => {
  let fioId;

  before(async () => {
    await hook(eventoV2({ id: 'MSG-DESCONHECIDO', remoteJid: '5521977776666@s.whatsapp.net', pushName: 'Parente' }));
    fioId = (await asTenant(() => WaConversation.getByThread(accountId, '5521977776666@s.whatsapp.net'))).id;
  });

  it('liga o fio ao contrato escolhido', async () => {
    const res = await vincular(fioId, { contract: '9005' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.contract, '9005');
    assert.equal(res.body.data.clientName, 'Gilson Manual');
    const link = await asTenant(() => getDb()('sgp_links').where({ contract: '9005' }).first());
    assert.equal(link.phone_manual, null, 'sem savePhone o cadastro fica como estava');
  });

  it('e, pedido, guarda o número no cadastro para a próxima mensagem se resolver sozinha', async () => {
    const res = await vincular(fioId, { contract: '9005', savePhone: true });
    assert.equal(res.status, 200);
    const link = await asTenant(() => getDb()('sgp_links').where({ contract: '9005' }).first());
    assert.equal(link.phone_manual, '5521977776666');
  });

  it('recusa o contrato que não existe e o do vizinho', async () => {
    for (const contract of ['0000', '7777']) {
      const res = await vincular(fioId, { contract });
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'subscriber_not_found');
    }
  });
});

describe('os fios antigos', () => {
  it('são vinculados quando a lista é lida', async () => {
    const antigo = await asTenant(() => WaConversation.ensure({
      accountId,
      externalThreadId: '559381249067@s.whatsapp.net',
      waPhone: '559381249067',
      pushName: 'Luiz Carlos Souza'
    }));
    assert.equal(antigo.contract, null);
    await asTenant(() => WaConversation.update(antigo.id, { last_message_at: new Date(), engaged_at: new Date() }));

    const res = await call(`${panelUrl}/api/whatsapp/conversations`, { headers: authHeaders(token) });
    const linha = res.body.data.find((row) => row.id === antigo.id);
    assert.equal(linha.contract, '9006');
    assert.equal(linha.clientName, 'Luiz Antigo');
  });
});
