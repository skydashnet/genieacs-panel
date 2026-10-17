import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, call, defaultTenantId, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpContact } = await import('../src/models/SgpContact.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: ContactProfileService } = await import('../src/services/contactProfileService.js');
const { default: WaConversationService } = await import('../src/services/waConversationService.js');

/**
 * O cliente trocou de número no cadastro: a conversa no número antigo deixa
 * de ser a do contrato, e o painel passa a usar o número novo.
 */

const NOVO = '5593991467556';
const VELHO = '5555939146755';
const OUTRO = '5593981112233';
let accountId;
let tenantId;

const conversa = async (phone, contract) => {
  const c = await asTenant(() => WaConversation.ensure({
    accountId, externalThreadId: `${phone}@s.whatsapp.net`, waPhone: phone, waLid: null, pushName: 'Cliente'
  }));
  await getDb()('wa_conversations').where({ id: c.id }).update({ contract });
  return c.id;
};
const contratoDe = async (id) => (await getDb()('wa_conversations').where({ id }).first()).contract;

before(async () => {
  const { panelUrl } = await startTestServers();
  await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'numero', password: 'numero-senha-1', email: 'numero@exemplo.test' }
  });
  tenantId = await defaultTenantId();
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-numero', purpose: 'support', flavor: 'v2', base_url: 'https://evo.provedor.test', status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('t-num'), ...WhatsAppConfigService.encryptWebhookToken('w-num')
  }));
  accountId = account.id;
});

after(async () => {
  await stopTestServers();
});

describe('troca de número no cadastro', () => {
  it('solta a conversa do número antigo em que a régua já cobrou', async () => {
    await asTenant(() => SgpContact.upsertFromSgp({ contract: 'N-1', client_name: 'Cliente', phone_e164: NOVO }));
    const velha = await conversa(VELHO, 'N-1');
    await getDb()('wa_dunning_sends').insert({
      tenant_id: tenantId, kind: 'step', step_offset: 0, contract: 'N-1', invoice_key: 'F1', phone_e164: VELHO, status: 'queued'
    });
    const soltas = await asTenant(() => WaConversationService.retireStaleBindings('N-1'));
    assert.deepEqual(soltas, [velha]);
    assert.equal(await contratoDe(velha), null);
  });

  it('não solta a conversa de outro número ligada a mão, sem prova de que já foi do contrato', async () => {
    await asTenant(() => SgpContact.upsertFromSgp({ contract: 'N-2', client_name: 'Cliente', phone_e164: NOVO }));
    const outra = await conversa(OUTRO, 'N-2');
    const soltas = await asTenant(() => WaConversationService.retireStaleBindings('N-2'));
    assert.deepEqual(soltas, []);
    assert.equal(await contratoDe(outra), 'N-2');
  });

  it('o número anterior que a sincronização trocou basta como prova', async () => {
    await asTenant(() => SgpContact.upsertFromSgp({ contract: 'N-3', client_name: 'Cliente', phone_e164: NOVO }));
    const velha = await conversa('5593988887777', 'N-3');
    const atual = await conversa(NOVO, 'N-3');
    const soltas = await asTenant(() => WaConversationService.retireStaleBindings('N-3', { oldPhones: ['5593988887777'] }));
    assert.deepEqual(soltas, [velha]);
    assert.equal(await contratoDe(atual), 'N-3', 'a conversa do número atual continua');
  });

  it('o número manual vence: a conversa nele é a do contrato', async () => {
    await asTenant(() => SgpContact.upsertFromSgp({ contract: 'N-4', client_name: 'Cliente', phone_e164: NOVO }));
    await asTenant(() => SgpContact.setManualPhone('N-4', VELHO));
    const { current } = await asTenant(() => WaConversationService.contractPhones('N-4'));
    assert.equal(current, VELHO);
    const velha = await conversa(VELHO, 'N-4');
    assert.deepEqual(await asTenant(() => WaConversationService.retireStaleBindings('N-4', { oldPhones: [VELHO] })), []);
    assert.equal(await contratoDe(velha), 'N-4');
  });
  it('trocar o WhatsApp na ficha solta a conversa do número anterior', async () => {
    await asTenant(() => SgpContact.upsertFromSgp({ contract: 'N-5', client_name: 'Cliente', phone_e164: '5593988887777' }));
    const velha = await conversa('5593988887777', 'N-5');
    await asTenant(() => ContactProfileService.update('N-5', { whatsappPhone: '(93) 98122-2220' }, null));
    assert.equal(await contratoDe(velha), null);
    const { conversation } = await asTenant(async () => (await import('../src/services/waContactService.js')).default.openConversation('N-5'));
    assert.equal(conversation.waPhoneE164, '5593981222220');
  });

  it('trocar o WhatsApp na ficha não mexe na conversa de outro número do contrato', async () => {
    await asTenant(() => SgpContact.upsertFromSgp({ contract: 'N-6', client_name: 'Cliente', phone_e164: NOVO }));
    const outra = await conversa(OUTRO, 'N-6');
    await asTenant(() => ContactProfileService.update('N-6', { whatsappPhone: '(93) 98122-2221' }, null));
    assert.equal(await contratoDe(outra), 'N-6');
  });
});
