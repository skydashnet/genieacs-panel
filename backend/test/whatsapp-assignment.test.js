import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaBotConfigService } = await import('../src/services/waBotConfigService.js');
const { default: WaAssignmentService } = await import('../src/services/waAssignmentService.js');

const INSTANCE = 'painel-distribuicao';
const WEBHOOK_TOKEN = 'segredo-do-webhook-distribuicao';
const SENHA = 'senha-distribuicao-1';

let panelUrl;
const tokens = {};
const ids = {};
let seq = 0;

const hook = (body) => call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });
const post = (path, body, token) => call(`${panelUrl}${path}`, { method: 'POST', headers: authHeaders(token), body });
const get = (path, token) => call(`${panelUrl}${path}`, { headers: authHeaders(token) });
const conversaDe = (phone) => getDb()('wa_conversations').where({ wa_phone_e164: phone }).first();

function cliente(phone, texto = 'preciso de ajuda') {
  seq += 1;
  return hook({
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: `DIST-${seq}` },
      pushName: 'Cliente',
      message: { conversation: texto },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  });
}

async function criar(username, role) {
  const { status, body } = await post('/api/users', {
    username, password: SENHA, role, email: `${username}@exemplo.test`
  }, tokens.dona);
  assert.equal(status, 201, JSON.stringify(body));
  ids[username] = body.data.user.id;
  const entrou = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: { username, password: SENHA } });
  assert.equal(entrou.status, 200, JSON.stringify(entrou.body));
  tokens[username] = entrou.body.data.token;
}

const disponivel = (quem, available = true) => post('/api/whatsapp/agents/me', { available }, tokens[quem]);

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dona', password: SENHA, email: 'dona@exemplo.test' }
  });
  tokens.dona = setup.body.data.token;
  ids.dona = setup.body.data.user.id;
  await criar('ana', 'tech');
  await criar('bruno', 'tech');
  await criar('visitante', 'viewer');

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    // Sem bot: toda mensagem precisa de gente, que é o caso a distribuir.
    botEnabled: false
  }));
  await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-distribuicao'),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('wa_messages').del();
  await getDb()('wa_conversations').del();
  await getDb()('wa_agents').del();
  await asTenant(() => WaBotConfigService.saveConfig({ distribution: { enabled: true } }));
});

describe('a distribuição de conversas', () => {
  it('reparte pela menor carga e, no empate, em rodízio', async () => {
    await disponivel('ana');
    await disponivel('bruno');
    await cliente('5593981130001');
    await cliente('5593981130002');
    await cliente('5593981130003');
    const donos = [];
    for (const phone of ['5593981130001', '5593981130002', '5593981130003']) {
      donos.push(Number((await conversaDe(phone)).assigned_user_id));
    }
    assert.notEqual(donos[0], donos[1], 'a segunda vai para quem ainda não tem nenhuma');
    assert.ok(donos.every((id) => [ids.ana, ids.bruno].includes(id)));

    // Uma nova mensagem do mesmo cliente não troca de atendente.
    await cliente('5593981130001', 'oi de novo');
    assert.equal(Number((await conversaDe('5593981130001')).assigned_user_id), donos[0]);
  });

  it('sem ninguém disponível vai para a fila, e quem fica disponível recebe', async () => {
    await cliente('5593981130010');
    let conversa = await conversaDe('5593981130010');
    assert.equal(conversa.assigned_user_id, null);
    assert.ok(conversa.waiting_since, 'entrou na fila');

    await disponivel('bruno');
    conversa = await conversaDe('5593981130010');
    assert.equal(Number(conversa.assigned_user_id), ids.bruno);
    assert.equal(conversa.waiting_since, null);
  });

  it('quem marcou disponível e sumiu não recebe', async () => {
    await disponivel('ana');
    await getDb()('wa_agents').update({ last_seen_at: new Date(Date.now() - 10 * 60_000) });
    await cliente('5593981130020');
    assert.equal((await conversaDe('5593981130020')).assigned_user_id, null);
  });

  it('desligada, nada é atribuído sozinho; responder assume a conversa', async () => {
    await asTenant(() => WaBotConfigService.saveConfig({ distribution: { enabled: false } }));
    await disponivel('ana');
    await cliente('5593981130030');
    const conversa = await conversaDe('5593981130030');
    assert.equal(conversa.assigned_user_id, null);
    assert.equal(conversa.waiting_since, null);

    const { status } = await post(`/api/whatsapp/conversations/${conversa.id}/messages`, { body: 'Olá, sou a Ana' }, tokens.ana);
    assert.ok(status === 200 || status === 201, `envio: ${status}`);
    assert.equal(Number((await conversaDe('5593981130030')).assigned_user_id), ids.ana);
  });

  it('transferir, soltar e filtrar "minhas"', async () => {
    await cliente('5593981130040');
    const conversa = await conversaDe('5593981130040');

    const transferiu = await post(`/api/whatsapp/conversations/${conversa.id}/assign`, { userId: ids.bruno }, tokens.ana);
    assert.equal(transferiu.status, 200, JSON.stringify(transferiu.body));
    assert.equal(transferiu.body.data.assignedUserId, ids.bruno);
    assert.equal(transferiu.body.data.assignedTo, 'bruno');

    const minhas = await get('/api/whatsapp/conversations?assignee=me', tokens.bruno);
    assert.deepEqual(minhas.body.data.map((c) => c.id), [conversa.id]);
    const daAna = await get('/api/whatsapp/conversations?assignee=me', tokens.ana);
    assert.equal(daAna.body.data.length, 0);

    // Para quem não responde no WhatsApp, não.
    const recusou = await post(`/api/whatsapp/conversations/${conversa.id}/assign`, { userId: ids.visitante }, tokens.ana);
    assert.equal(recusou.status, 400);
    assert.equal(recusou.body.code, 'invalid_assignee');

    const soltou = await post(`/api/whatsapp/conversations/${conversa.id}/assign`, { userId: null }, tokens.bruno);
    assert.equal(soltou.body.data.assignedUserId, null);
    const semDono = await get('/api/whatsapp/conversations?assignee=unassigned', tokens.ana);
    assert.deepEqual(semDono.body.data.map((c) => c.id), [conversa.id]);
  });

  it('a lista da equipe mostra disponibilidade e carga; o visitante não fica disponível', async () => {
    await disponivel('ana');
    await cliente('5593981130050');
    const { status, body } = await get('/api/whatsapp/agents', tokens.dona);
    assert.equal(status, 200);
    const ana = body.data.find((a) => a.userId === ids.ana);
    assert.equal(ana.online, true);
    assert.equal(ana.openConversations, 1);
    assert.ok(!body.data.some((a) => a.userId === ids.visitante), 'quem não responde não aparece');

    const negado = await disponivel('visitante');
    assert.equal(negado.status, 403);
  });

  it('encerrar tira da fila', async () => {
    await cliente('5593981130060');
    const conversa = await conversaDe('5593981130060');
    assert.ok(conversa.waiting_since);
    await post(`/api/whatsapp/conversations/${conversa.id}/status`, { status: 'closed' }, tokens.dona);
    assert.equal((await conversaDe('5593981130060')).waiting_since, null);
    const entregues = await asTenant(() => WaAssignmentService.drainQueue());
    assert.equal(entregues, 0);
  });
});
