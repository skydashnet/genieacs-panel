import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');

const INSTANCE = 'painel-caixa';
const INSTANCE_TOKEN = 'token-da-instancia-caixa';
const WEBHOOK_TOKEN = 'segredo-do-webhook-caixa';

let panelUrl;
let token;
let accountId;

/** Fixture nickname → conversation id, so the assertions read as sentences. */
const fios = {};

const listar = (query = '') => call(
  `${panelUrl}/api/whatsapp/conversations${query}`,
  { headers: authHeaders(token) }
);

const definirEstado = (id, status) => call(
  `${panelUrl}/api/whatsapp/conversations/${id}/status`,
  { method: 'POST', headers: authHeaders(token), body: { status } }
);

const linhaDe = (id) => getDb()('wa_conversations').where({ id }).first();
const idsDe = (body) => (body.data ?? []).map((row) => row.id);

/** A v2 `messages.upsert`, as Evolution API v2 actually posts it. */
const hook = (body) => call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });

function eventoV2({ id, remoteJid, fromMe = false, texto = '', pushName = 'Cliente' }) {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid, fromMe, id },
      pushName,
      message: { conversation: texto },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  };
}

/**
 * One thread per fixture, each carrying exactly ONE of the four searchable
 * facts, so a term that matches two threads is a bug in the query rather than
 * an ambiguity in the fixture.
 */
async function semear({ apelido, phone, pushName, contract, minutos }) {
  const conversa = await asTenant(() => WaConversation.ensure({
    accountId,
    externalThreadId: `${phone}@s.whatsapp.net`,
    waPhone: phone,
    waLid: null,
    pushName
  }));
  await asTenant(() => WaConversation.update(conversa.id, {
    contract: contract ?? null,
    last_message_at: new Date(Date.now() - minutos * 60_000),
    // Conversas com gente dos dois lados: as que só receberam envio
    // automático ficam em "Sem resposta" (whatsapp-inbox-engaged.test.js).
    engaged_at: new Date(Date.now() - minutos * 60_000)
  }));
  fios[apelido] = conversa.id;
  return conversa.id;
}

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

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

  await semear({ apelido: 'telefone', phone: '5593981110001', pushName: 'Zeca', minutos: 1 });
  await semear({ apelido: 'apelido', phone: '5511900000002', pushName: 'Dona Benedita', minutos: 2 });
  await semear({ apelido: 'contrato', phone: '5511900000003', pushName: 'Terceiro', contract: '77123', minutos: 3 });
  await semear({ apelido: 'assinante', phone: '5511900000004', pushName: 'Quarto', contract: '88456', minutos: 4 });

  // The subscriber's name lives in the ERP mirror, never on the thread — which
  // is the whole reason the search has to reach across into it.
  await getDb()('sgp_links').insert({
    device_id: 'ONT-88456',
    contract: '88456',
    client_name: 'Terezinha Albuquerque',
    state: 'active',
    link_mode: 'auto'
  });
});

after(async () => {
  await stopTestServers();
});

describe('closing a conversation', () => {
  it('sets closed_at, and reopening clears it', async () => {
    const id = fios.telefone;

    const fechada = await definirEstado(id, 'closed');
    assert.equal(fechada.status, 200);
    assert.ok(fechada.body.data.closedAt, 'the browser shape has to carry the new state');
    assert.ok((await linhaDe(id)).closed_at, 'closed_at is what the list filters on');

    const reaberta = await definirEstado(id, 'open');
    assert.equal(reaberta.status, 200);
    assert.equal(reaberta.body.data.closedAt, null);
    assert.equal((await linhaDe(id)).closed_at, null);
  });

  it('keeps the thread and its history — filing is not deleting', async () => {
    const id = fios.apelido;
    const antes = await getDb()('wa_messages').where({ conversation_id: id }).count({ total: '*' });

    assert.equal((await definirEstado(id, 'closed')).status, 200);

    const linha = await linhaDe(id);
    assert.ok(linha, 'the conversation row survives');
    assert.equal(linha.push_name, 'Dona Benedita');
    const depois = await getDb()('wa_messages').where({ conversation_id: id }).count({ total: '*' });
    assert.deepEqual(depois, antes);

    await definirEstado(id, 'open');
  });

  it('answers 404 with the code the inbox translates, for an id that is not there', async () => {
    const { status, body } = await definirEstado(999_999, 'closed');
    assert.equal(status, 404);
    assert.equal(body.code, 'conversation_not_found');
  });

  it('refuses a status it does not know rather than guessing at one', async () => {
    const { status } = await definirEstado(fios.telefone, 'arquivada');
    assert.equal(status, 400);
    assert.equal((await linhaDe(fios.telefone)).closed_at, null, 'and nothing moved');
  });
});

describe('the inbox filter', () => {
  it('hides closed threads by default: the list is what still needs answering', async () => {
    const id = fios.contrato;
    await definirEstado(id, 'closed');

    const padrao = await listar();
    assert.equal(padrao.status, 200);
    assert.equal(idsDe(padrao.body).includes(id), false);

    const fechadas = await listar('?status=closed');
    assert.deepEqual(idsDe(fechadas.body), [id], 'and only the closed one is under "closed"');

    const todas = await listar('?status=all');
    assert.equal(idsDe(todas.body).includes(id), true);
    assert.equal(idsDe(todas.body).includes(fios.telefone), true);

    await definirEstado(id, 'open');
    assert.equal(idsDe((await listar()).body).includes(id), true);
  });
});

describe('finding a conversation', () => {
  it('matches the phone', async () => {
    const { body } = await listar('?search=5593981110001');
    assert.deepEqual(idsDe(body), [fios.telefone]);
  });

  it('matches a phone typed the way a human writes one', async () => {
    // The operator has the number off a bill or a caller ID, punctuation and
    // all; the column holds 5593981110001 and nothing else.
    const { body } = await listar(`?search=${encodeURIComponent('(93) 98111-0001')}`);
    assert.deepEqual(idsDe(body), [fios.telefone]);
  });

  it('matches the name WhatsApp pushed, case and part-word alike', async () => {
    const { body } = await listar('?search=benedita');
    assert.deepEqual(idsDe(body), [fios.apelido]);
  });

  it('matches the contract', async () => {
    const { body } = await listar('?search=77123');
    assert.deepEqual(idsDe(body), [fios.contrato]);
  });

  it("matches the subscriber's name, which only the ERP mirror knows", async () => {
    const { body } = await listar('?search=terezinha');
    assert.deepEqual(idsDe(body), [fios.assinante]);
  });

  it('finds nothing rather than everything when the term matches nothing', async () => {
    const { body } = await listar('?search=nao-existe-ninguem');
    assert.deepEqual(idsDe(body), []);
  });

  it('reads a bare wildcard as text, not as "every row"', async () => {
    const { body } = await listar(`?search=${encodeURIComponent('%')}`);
    assert.deepEqual(idsDe(body), [], 'LIKE\'s own wildcards must not leak out of the box');
  });

  it('searches within the chosen pile, not around it', async () => {
    await definirEstado(fios.apelido, 'closed');
    assert.deepEqual(idsDe((await listar('?search=benedita')).body), []);
    assert.deepEqual(idsDe((await listar('?search=benedita&status=closed')).body), [fios.apelido]);
    await definirEstado(fios.apelido, 'open');
  });
});

describe('paging back through a thread', () => {
  it('walks the whole history with a cursor, and never repeats a message', async () => {
    const fio = fios.telefone;
    // Seven messages, read three at a time: two full pages and a short one,
    // which is how the screen learns there is nothing older left.
    for (let i = 1; i <= 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ids have to come out in order
      await asTenant(() => getDb()('wa_messages').insert({
        conversation_id: fio,
        direction: i % 2 ? 'in' : 'out',
        body: `mensagem ${i}`,
        is_note: false,
        source: i % 2 ? 'operator' : 'bot',
        tenant_id: 1,
        created_at: new Date(),
        updated_at: new Date()
      }));
    }

    const vistos = [];
    let cursor = null;
    for (let page = 0; page < 4; page += 1) {
      const query = `limit=3${cursor ? `&before=${cursor}` : ''}`;
      // eslint-disable-next-line no-await-in-loop -- a cursor is sequential by definition
      const { status, body } = await call(
        `${panelUrl}/api/whatsapp/conversations/${fio}/messages?${query}`,
        { headers: authHeaders(token) }
      );
      assert.equal(status, 200);
      const ids = body.data.messages.map((row) => row.id);
      if (ids.length === 0) break;
      vistos.push(...ids);
      cursor = ids.at(-1);
    }

    assert.equal(vistos.length, 7, 'every message came back exactly once');
    assert.equal(new Set(vistos).size, 7, 'and none of them came back twice');
    // Newest first, all the way down: the order the screen draws.
    assert.deepEqual([...vistos].sort((a, b) => b - a), vistos);
  });

  it('a message arriving mid-scroll cannot shift the page under the reader', async () => {
    const fio = fios.telefone;
    const primeira = await call(
      `${panelUrl}/api/whatsapp/conversations/${fio}/messages?limit=3`,
      { headers: authHeaders(token) }
    );
    const cursor = primeira.body.data.messages.at(-1).id;

    // The customer answers while the operator is still reading.
    await asTenant(() => getDb()('wa_messages').insert({
      conversation_id: fio,
      direction: 'in',
      body: 'oi, ainda estou aqui',
      is_note: false,
      source: 'operator',
      tenant_id: 1,
      created_at: new Date(),
      updated_at: new Date()
    }));

    const segunda = await call(
      `${panelUrl}/api/whatsapp/conversations/${fio}/messages?limit=3&before=${cursor}`,
      { headers: authHeaders(token) }
    );
    const ids = segunda.body.data.messages.map((row) => row.id);
    // An offset would have slid by one here and repeated a message the operator
    // had already read; a cursor cannot.
    assert.ok(ids.every((id) => id < cursor));
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('an inbound message and a closed thread', () => {
  it('REOPENS it: a customer who writes again is not answered by an archive', async () => {
    const remoteJid = '5592988887777@s.whatsapp.net';
    assert.equal((await hook(eventoV2({
      id: 'ENTRADA-1', remoteJid, texto: 'minha internet caiu', pushName: 'Joana'
    }))).body.handled, true);

    const id = (await getDb()('wa_conversations').where({ external_thread_id: remoteJid }).first()).id;
    await definirEstado(id, 'closed');
    assert.equal(idsDe((await listar()).body).includes(id), false, 'gone from the default list');

    const volta = await hook(eventoV2({
      id: 'ENTRADA-2', remoteJid, texto: 'e agora?', pushName: 'Joana'
    }));
    assert.equal(volta.body.handled, true);

    assert.equal((await linhaDe(id)).closed_at, null, 'the thread is open again');
    assert.equal(idsDe((await listar()).body).includes(id), true, 'and back where the operator looks');
    // The history it was closed on is still underneath the new message. Counted
    // on the inbound side only: the self-service bot answers both of these, and
    // its replies are not the history being asserted about.
    const [{ total }] = await getDb()('wa_messages')
      .where({ conversation_id: id, direction: 'in' })
      .count({ total: '*' });
    assert.equal(Number(total), 2);
  });

  it('is not reopened by the provider\'s own outbound echo', async () => {
    const remoteJid = '5592977776666@s.whatsapp.net';
    await hook(eventoV2({ id: 'ENTRADA-3', remoteJid, texto: 'oi', pushName: 'Pedro' }));
    const id = (await getDb()('wa_conversations').where({ external_thread_id: remoteJid }).first()).id;
    await definirEstado(id, 'closed');

    // An echo of a message the operator typed on their own phone. Treating it
    // as news from the customer would refile every thread the provider ever
    // answered from the handset, which is the archive filling back up.
    await hook(eventoV2({ id: 'SAIDA-1', remoteJid, fromMe: true, texto: 'resolvido' }));

    assert.ok((await linhaDe(id)).closed_at, 'still closed');
  });
});
