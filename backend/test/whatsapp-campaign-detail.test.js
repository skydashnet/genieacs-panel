import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaBroadcastService } = await import('../src/services/waBroadcastService.js');
const { default: WaBillingService } = await import('../src/services/waBillingService.js');

/**
 * O detalhe de uma campanha: cada destinatário, o que aconteceu com a
 * mensagem dele, e se ele respondeu ou pediu para sair DEPOIS do envio.
 */

let panelUrl;
let token;
const api = (rota, options = {}) => call(`${panelUrl}/api/whatsapp${rota}`, { headers: authHeaders(token), ...options });

const CONTATOS = [
  ['201', 'LEITORA', '5593992220201'],
  ['202', 'ENTREGUE', '5593992220202'],
  ['203', 'RESPONDEU', '5593992220203'],
  ['204', 'SAIU', '5593992220204']
];

/** Em segundos inteiros: o TIMESTAMP do MySQL não guarda milissegundos. */
const segundos = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let broadcastId;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true, webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook', rateLimitPerMin: 60
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: 'painel-detalhe',
    purpose: 'billing',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));
  await getDb()('sgp_contacts').insert(CONTATOS.map(([contract, name, phone]) => ({
    tenant_id: 1, contract, client_name: name, phone_e164: phone, state: 'active'
  })));

  asTenant(() => WaBillingService.resetBuildWindow());
  const { status, body } = await api('/broadcasts', {
    method: 'POST',
    body: { title: 'Aviso', filters: { contracts: CONTATOS.map(([c]) => c) }, body: 'Oi {{primeiro_nome}}' }
  });
  assert.equal(status, 201, JSON.stringify(body));
  broadcastId = body.data.broadcast.id;
  await asTenant(() => WaBroadcastService.setStatus(broadcastId, 'running'));
  await asTenant(() => WaBroadcastService.tickForTenant());

  const linhas = await getDb()('wa_broadcast_recipients').where({ broadcast_id: broadcastId });
  const por = new Map(linhas.map((l) => [l.contract, l]));
  // O envio "aconteceu" uma hora atrás; o que o assinante fez vem depois.
  const enviado = segundos(Date.now() - 3600_000);
  await getDb()('wa_broadcast_recipients').where({ broadcast_id: broadcastId }).update({ sent_at: enviado });
  const depois = segundos(Date.now() - 600_000);
  const antes = segundos(Date.now() - 7200_000);

  await getDb()('wa_messages').where({ id: por.get('201').message_id }).update({ delivery_status: 'read' });
  await getDb()('wa_messages').where({ id: por.get('202').message_id }).update({ delivery_status: 'delivered' });

  const conversa = async (contract) => (await getDb()('wa_messages').where({ id: por.get(contract).message_id }).first()).conversation_id;
  await getDb()('wa_messages').insert([
    // 203 escreveu depois do aviso; 201 tinha escrito ANTES, o que não conta.
    { tenant_id: 1, conversation_id: await conversa('203'), direction: 'in', body: 'obrigado', source: 'operator', created_at: depois },
    { tenant_id: 1, conversation_id: await conversa('201'), direction: 'in', body: 'oi', source: 'operator', created_at: antes }
  ]);
  await getDb()('wa_opt_outs').insert({
    tenant_id: 1, wa_phone_e164: '5593992220204', origin: 'customer', reason_text: 'SAIR', created_at: depois
  });
});

after(async () => {
  await stopTestServers();
});

describe('GET /broadcasts/:id/recipients', () => {
  it('resume a campanha inteira', async () => {
    const { status, body } = await api(`/broadcasts/${broadcastId}/recipients`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.broadcast.id, broadcastId);
    assert.deepEqual(body.data.summary, {
      total: 4, pending: 0, sent: 4, delivered: 2, read: 1, replied: 1, optedOut: 1, failed: 0, skipped: 0, paid: 0
    });
    assert.equal(body.data.total, 4);
    assert.equal(body.data.hasMore, false);
  });

  it('cada linha diz o que aconteceu com aquela pessoa', async () => {
    const { body } = await api(`/broadcasts/${broadcastId}/recipients`);
    const por = new Map(body.data.items.map((i) => [i.contract, i]));
    assert.equal(por.get('201').deliveryStatus, 'read');
    assert.equal(por.get('201').replied, false, 'a mensagem de antes do envio não é resposta');
    assert.equal(por.get('202').deliveryStatus, 'delivered');
    assert.equal(por.get('203').replied, true);
    assert.equal(por.get('204').optedOut, true);
    assert.equal(por.get('203').clientName, 'RESPONDEU');
    assert.ok(por.get('203').sentAt);
  });

  it('filtra e pagina', async () => {
    const respondeu = await api(`/broadcasts/${broadcastId}/recipients?status=replied`);
    assert.deepEqual(respondeu.body.data.items.map((i) => i.contract), ['203']);
    assert.equal(respondeu.body.data.summary.total, 4, 'o resumo é sempre da campanha inteira');

    const pagina = await api(`/broadcasts/${broadcastId}/recipients?limit=3&offset=0`);
    assert.equal(pagina.body.data.items.length, 3);
    assert.equal(pagina.body.data.hasMore, true);
    const resto = await api(`/broadcasts/${broadcastId}/recipients?limit=3&offset=3`);
    assert.deepEqual(resto.body.data.items.map((i) => i.contract), ['204']);
    assert.equal((await api(`/broadcasts/${broadcastId}/recipients?status=failed`)).body.data.items.length, 0);
  });

  it('campanha que não existe: 404', async () => {
    const { status, body } = await api('/broadcasts/999999/recipients');
    assert.equal(status, 404);
    assert.equal(body.code, 'broadcast_not_found');
  });
});
