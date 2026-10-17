import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: SgpContact } = await import('../src/models/SgpContact.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');

/** O número do contrato na lista de conversas abre o cadastro do cliente no SGP. */

const SGP = 'https://sgp.provedor.test';
let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'linksgp', password: 'linksgp-senha-1', email: 'linksgp@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => SgpService.saveConfig({ enabled: true, baseUrl: SGP, app: 'painel', token: 'tk', linkMode: 'pppoe' }));
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-link', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.test', status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('t-link'), ...WhatsAppConfigService.encryptWebhookToken('w-link')
  }));
  await asTenant(() => SgpContact.upsertFromSgp({ contract: 'L-COM', client_ref: '4321', client_name: 'Cliente Com Id' }));
  await asTenant(() => SgpContact.upsertFromSgp({ contract: 'L-SEM', client_name: 'Cliente Sem Id' }));
  for (const [i, contract] of ['L-COM', 'L-SEM'].entries()) {
    // eslint-disable-next-line no-await-in-loop
    const c = await asTenant(() => WaConversation.ensure({
      accountId: account.id, externalThreadId: `559398130000${i}@s.whatsapp.net`, waPhone: `559398130000${i}`, waLid: null, pushName: contract
    }));
    // eslint-disable-next-line no-await-in-loop
    await getDb()('wa_conversations').where({ id: c.id }).update({ contract, engaged_at: new Date(), last_message_at: new Date() });
  }
});

after(async () => {
  await stopTestServers();
});

const listar = async () => {
  const res = await call(`${panelUrl}/api/whatsapp/conversations`, { headers: authHeaders(token) });
  return Object.fromEntries(res.body.data.map((c) => [c.contract, c.sgpUrl]));
};

describe('o link do SGP na lista de conversas', () => {
  it('vem pelo id do cliente guardado, sem consultar o SGP; sem id, fica nulo', async () => {
    const urls = await listar();
    assert.equal(urls['L-COM'], `${SGP}/admin/cliente/4321/contratos/`);
    assert.equal(urls['L-SEM'], null);
  });

  it('a conversa aberta traz o mesmo link (cabeçalho)', async () => {
    const lista = (await call(`${panelUrl}/api/whatsapp/conversations`, { headers: authHeaders(token) })).body.data;
    const id = lista.find((c) => c.contract === 'L-COM').id;
    const res = await call(`${panelUrl}/api/whatsapp/conversations/${id}`, { headers: authHeaders(token) });
    const conversa = res.body.data.conversation ?? res.body.data;
    assert.equal(conversa.sgpUrl, `${SGP}/admin/cliente/4321/contratos/`);
  });

  it('com o SGP desligado, nenhum link', async () => {
    await asTenant(() => SgpService.saveConfig({ enabled: false, baseUrl: SGP, app: 'painel', token: 'tk', linkMode: 'pppoe' }));
    const urls = await listar();
    assert.equal(urls['L-COM'], null);
  });
});
