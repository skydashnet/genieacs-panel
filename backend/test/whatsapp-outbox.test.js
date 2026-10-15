import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage, RECLAIM_MS } = await import('../src/models/WaMessage.js');
const { currentTenantId } = await import('../src/config/tenantContext.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: WaOutboxWorker } = await import('../src/services/waOutboxWorker.js');
const { default: WaSendService } = await import('../src/services/waSendService.js');
const { default: AppState } = await import('../src/models/AppState.js');
const { whatsappBulkRequeueLimiter, whatsappSendLimiter } = await import('../src/middleware/rateLimit.js');
const { outDir } = await import('../src/services/waAttachmentService.js');

const SUPPORT = 'painel-suporte';
const SUPPORT_TOKEN = 'token-suporte-111';
const BACKUP = 'painel-reserva';
const BACKUP_TOKEN = 'token-reserva-222';

/**
 * The Evolution server has to look public.
 *
 * `evolutionClient` runs every target through the SSRF guard, which blocks
 * loopback by literal — so a stub on 127.0.0.1 can never be reached by its own
 * address, and turning that check off for tests would be testing a different
 * program. Instead the account points at a name that resolves nowhere (so the
 * guard's DNS check passes it as "not internal") and `fetch` is rewritten onto
 * the stub. Everything past that line is real: a real socket, real status
 * codes, real bodies.
 */
const EVO_BASE = 'https://evo.provedor.test';

let panelUrl;
let token;
let userId;
let supportId;
let backupId;
let evoServer;
let evoLocalUrl;
let desfazerRota;
/**
 * A pasta de saída do provedor, preenchida no `before`.
 *
 * O envio só aceita caminho debaixo dela: o valor vem do navegador, e sem
 * confinar isso qualquer arquivo em `DATA_DIR` virava anexo enviável. Estes
 * testes escolhem endpoint pelo TIPO do anexo, então o arquivo não precisa
 * existir — o caminho é que precisa ser um que a rota de upload emitiria.
 */
let saida;
const anexoDeSaida = (nome, type) => ({ url: `${saida}/${nome}`, type, name: nome });

/** What the stub answers with, per test. */
const stub = {
  /** O que o `connectionState` responde; `null` = rota inexistente (404). */
  connectionState: null,
  textStatus: 200,
  textBody: null,
  audioStatus: 200,
  mediaStatus: 200,
  nextId: 0
};

/** Every request the stub saw: `{ path, apikey, payload }`. */
const requests = [];

function startEvolutionStub() {
  evoServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const path = req.url.split('?')[0];
      requests.push({ path, apikey: req.headers.apikey || null, payload });

      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const accepted = () => {
        stub.nextId += 1;
        return { key: { id: `EVO-${stub.nextId}`, remoteJid: payload.number }, status: 'PENDING' };
      };

      if (path.startsWith('/instance/connectionState/')) {
        return stub.connectionState
          ? send(200, { instance: { instanceName: path.split('/').pop(), state: stub.connectionState } })
          : send(404, { message: 'unknown route' });
      }
      if (path.startsWith('/message/sendText/')) {
        return stub.textStatus === 200
          ? send(200, accepted())
          : send(stub.textStatus, stub.textBody ?? { message: 'numero invalido' });
      }
      if (path.startsWith('/message/sendWhatsAppAudio/')) {
        return stub.audioStatus === 200
          ? send(200, accepted())
          : send(stub.audioStatus, { message: 'ptt route unavailable' });
      }
      if (path.startsWith('/message/sendMedia/')) {
        return stub.mediaStatus === 200
          ? send(200, accepted())
          : send(stub.mediaStatus, { message: 'media recusada' });
      }
      if (path.startsWith('/message/sendReaction/') || path.startsWith('/chat/deleteMessageForEveryone/')) {
        return send(200, { status: 'SUCCESS' });
      }
      return send(404, { message: 'unknown route' });
    });
  });
  return new Promise((resolve) => {
    evoServer.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${evoServer.address().port}`);
    });
  });
}

/** A fresh thread per test, so no test depends on another one's leftovers. */
let threadSeq = 0;
async function newConversation({ accountId = supportId, phone = null, lid = null, thread } = {}) {
  threadSeq += 1;
  // The worker opens its own scope now; a fixture reached directly does not.
  return asTenant(() => WaConversation.ensure({
    accountId,
    externalThreadId: thread || `55939811104${String(threadSeq).padStart(2, '0')}@s.whatsapp.net`,
    waPhone: phone === null && lid === null ? `55939811104${String(threadSeq).padStart(2, '0')}` : phone,
    waLid: lid,
    pushName: 'Cliente'
  }));
}

/**
 * Empties the outbox before a test that counts requests.
 *
 * `node:test` runs the file in order and the tests above leave queued rows
 * behind on purpose (the send route is supposed to enqueue and stop there), so
 * without this a pass would drain someone else's message and the count would
 * measure the wrong thing.
 */
/**
 * Zera a fila E o minuto gasto — os dois, agora que o minuto é gravado.
 *
 * `WaOutboxWorker.stop()` sozinho já não devolve o minuto: ele larga a cópia em
 * memória, e a primeira passagem seguinte lê de volta o que ficou no banco. É
 * o ponto desta onda, e é por isso que um teste que quer medir um minuto limpo
 * tem que apagar o que foi gravado.
 */
async function clearOutbox() {
  await getDb()('wa_messages').where({ delivery_status: 'queued' }).del();
  await getDb()('app_state').where({ key: WaOutboxWorker.WINDOW_KEY }).del();
  WaOutboxWorker.stop();
  requests.length = 0;
}

function post(conversationId, body) {
  return call(`${panelUrl}/api/whatsapp/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body
  });
}

const sendTextCalls = () => requests.filter((r) => r.path.startsWith('/message/sendText/'));
const audioCalls = () => requests.filter((r) => r.path.startsWith('/message/sendWhatsAppAudio/'));
const mediaCalls = () => requests.filter((r) => r.path.startsWith('/message/sendMedia/'));

before(async () => {
  ({ panelUrl } = await startTestServers());
  evoLocalUrl = await startEvolutionStub();

  // O cliente Evolution conecta por `PinnedTransport`, não por `fetch`: a rota
  // para o dublê troca os encaixes dele, e a guarda de endereço roda inteira.
  desfazerRota = rotearBase(EVO_BASE, evoLocalUrl);

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  userId = setup.body.data.user.id;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    rateLimitPerMin: 60
  }));

  const support = await asTenant(() => WhatsAppAccount.create({
    name: SUPPORT,
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(SUPPORT_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-suporte')
  }));
  supportId = support.id;

  const backup = await asTenant(() => WhatsAppAccount.create({
    name: BACKUP,
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    // Disconnected until the routing test needs it, so the fallback cannot be
    // what every other test was quietly exercising.
    status: 'disconnected',
    ...WhatsAppConfigService.encryptInstanceToken(BACKUP_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-reserva')
  }));
  backupId = backup.id;

  saida = await asTenant(() => outDir());
});

after(async () => {
  desfazerRota?.();
  WaOutboxWorker.stop();
  await new Promise((resolve) => evoServer.close(resolve));
  await stopTestServers();
});

describe('the send route enqueues and returns', () => {
  it('answers with a queued message and does not touch the server', async () => {
    const conversation = await newConversation();
    requests.length = 0;

    const { status, body } = await post(conversation.id, { body: 'bom dia' });
    assert.equal(status, 201);
    assert.equal(body.data.direction, 'out');
    assert.equal(body.data.deliveryStatus, 'queued');
    assert.equal(body.data.externalId, null);
    assert.ok(body.data.sentBy, 'the operator who sent it is recorded');
    // Twice over, because the two answer different questions: `sentBy` is which
    // human, `source` is which of the panel's senders — and the bot's ceiling
    // reads only the second one.
    assert.equal(body.data.source, 'operator');
    assert.equal(requests.length, 0, 'enqueuing must not talk to Evolution');
  });

  it('refuses an empty message, a thread with no address, and an unknown thread', async () => {
    const conversation = await newConversation();
    const vazia = await post(conversation.id, { body: '   ' });
    assert.equal(vazia.status, 400);
    assert.equal(vazia.body.code, 'message_empty');

    const semEndereco = await newConversation({ thread: 'grupo-qualquer@g.us', phone: '', lid: '' });
    const sem = await post(semEndereco.id, { body: 'oi' });
    assert.equal(sem.status, 409);
    assert.equal(sem.body.code, 'no_destination');

    const inexistente = await post(999999, { body: 'oi' });
    assert.equal(inexistente.status, 404);
    assert.equal(inexistente.body.code, 'conversation_not_found');
  });

  it('requires an authenticated admin', async () => {
    const conversation = await newConversation();
    const { status } = await call(
      `${panelUrl}/api/whatsapp/conversations/${conversation.id}/messages`,
      { method: 'POST', body: { body: 'oi' } }
    );
    assert.equal(status, 401);
  });
});

describe('the outbox worker despatches', () => {
  it('sends a queued message and stores the id the server gave it', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'a caixa chegou?' });

    const summary = await WaOutboxWorker.tick();
    assert.equal(summary.sent, 1);

    const row = await asTenant(() => WaMessage.getById(body.data.id));
    assert.equal(row.delivery_status, 'sent');
    // The id comes from the server's answer, not from anything we made up: it
    // is the only thing a delivery receipt can be matched against later.
    assert.equal(row.external_id, `EVO-${stub.nextId}`);
    assert.equal(row.delivery_error, null);
    assert.equal(sendTextCalls().length, 1);
    assert.equal(sendTextCalls()[0].payload.text, 'a caixa chegou?');
  });

  it('cita a mensagem respondida e a lista traz o recorte', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const outra = await newConversation();
    const primeira = (await post(conversation.id, { body: 'qual o contrato?' })).body.data;
    const alheia = (await post(outra.id, { body: 'de outra conversa' })).body.data;
    await WaOutboxWorker.tick();
    const enviada = await asTenant(() => WaMessage.getById(primeira.id));
    requests.length = 0;

    const resposta = (await post(conversation.id, { body: 'é o 608', replyToId: primeira.id })).body.data;
    const ignorada = (await post(conversation.id, { body: 'sem citar', replyToId: alheia.id })).body.data;
    assert.equal(resposta.replyToId, primeira.id);
    assert.equal(ignorada.replyToId, null, 'uma mensagem de outra conversa não é citada');
    await WaOutboxWorker.tick();

    const chamada = sendTextCalls().find((c) => c.payload.text === 'é o 608');
    assert.deepEqual(chamada.payload.quoted, { key: { id: enviada.external_id } });
    assert.equal(sendTextCalls().find((c) => c.payload.text === 'sem citar').payload.quoted, undefined);

    const lista = await call(`${panelUrl}/api/whatsapp/conversations/${conversation.id}/messages`, { headers: authHeaders(token) });
    const citada = lista.body.data.messages.find((m) => m.id === resposta.id);
    assert.equal(citada.replyTo.id, primeira.id);
    assert.equal(citada.replyTo.body, 'qual o contrato?');
  });

  it('reage a uma mensagem e guarda o emoji; vazio tira a reação', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const enviada = (await post(conversation.id, { body: 'recebeu?' })).body.data;
    await WaOutboxWorker.tick();
    const row = await asTenant(() => WaMessage.getById(enviada.id));
    requests.length = 0;

    const url = `${panelUrl}/api/whatsapp/messages/${enviada.id}/reaction`;
    const res = await call(url, { method: 'POST', headers: authHeaders(token), body: { emoji: '👍' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.myReaction, '👍');
    const chamada = requests.find((r) => r.path.startsWith('/message/sendReaction/'));
    assert.equal(chamada.payload.reaction, '👍');
    assert.equal(chamada.payload.key.id, row.external_id);
    assert.equal(chamada.payload.key.fromMe, true);
    assert.match(chamada.payload.key.remoteJid, /@s\.whatsapp\.net$/);

    const tirar = await call(url, { method: 'POST', headers: authHeaders(token), body: { emoji: '' } });
    assert.equal(tirar.body.data.myReaction, null);

    const texto = await call(url, { method: 'POST', headers: authHeaders(token), body: { emoji: 'oi' } });
    assert.equal(texto.status, 400, 'só emoji vira reação');
  });

  it('apaga para todos a mensagem enviada e esconde o conteúdo', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const enviada = (await post(conversation.id, { body: 'mensagem errada' })).body.data;
    const pendente = (await post(conversation.id, { body: 'ainda na fila' })).body.data;
    // Só a primeira sai: a segunda fica na fila para provar a recusa.
    await getDb()('wa_messages').where({ id: pendente.id }).update({ delivery_status: 'queued', next_attempt_at: new Date(Date.now() + 3600_000) });
    await WaOutboxWorker.tick();
    const row = await asTenant(() => WaMessage.getById(enviada.id));
    requests.length = 0;

    const res = await call(`${panelUrl}/api/whatsapp/messages/${enviada.id}/delete`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.deletedAt);
    assert.equal(res.body.data.body, null);
    const chamada = requests.find((r) => r.path.startsWith('/chat/deleteMessageForEveryone/'));
    assert.equal(chamada.payload.id, row.external_id);
    assert.equal(chamada.payload.fromMe, true);

    const repetida = await call(`${panelUrl}/api/whatsapp/messages/${enviada.id}/delete`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(repetida.status, 409);
    const fila = await call(`${panelUrl}/api/whatsapp/messages/${pendente.id}/delete`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(fila.status, 409, 'na fila: apagar deixaria a fila mandar assim mesmo');
  });

  it('apagar mensagem do cliente só some do painel, sem falar com o servidor', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const recebida = await asTenant(() => WaMessage.create({
      conversation_id: conversation.id, direction: 'in', external_id: `IN-${Date.now()}`, body: 'oi'
    }));
    const id = typeof recebida === 'object' ? recebida.id : recebida;
    requests.length = 0;
    const res = await call(`${panelUrl}/api/whatsapp/messages/${id}/delete`, { method: 'POST', headers: authHeaders(token) });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.deletedAt);
    assert.equal(requests.filter((r) => r.path.startsWith('/chat/')).length, 0);
  });

  it('sends a message exactly once when two passes overlap', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'só uma vez' });
    requests.length = 0;

    await Promise.all([WaOutboxWorker.tick(), WaOutboxWorker.tick()]);

    assert.equal(sendTextCalls().length, 1, 'the loser of the claim must do nothing');
    const row = await asTenant(() => WaMessage.getById(body.data.id));
    assert.equal(row.delivery_status, 'sent');
    assert.equal(row.attempts, 1);
  });

  it('records the failure and schedules the retry instead of burning it', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'vai falhar' });
    requests.length = 0;
    // A server that is restarting — the failure the queue exists to survive,
    // and one the panel cannot tell apart from a server that is gone for good.
    stub.textStatus = 503;
    stub.textBody = { message: 'servidor reiniciando' };

    try {
      await WaOutboxWorker.tick();
      let row = await asTenant(() => WaMessage.getById(body.data.id));
      // Still queued: a first failure is a retry, not a verdict.
      assert.equal(row.delivery_status, 'queued');
      assert.equal(row.attempts, 1);
      assert.match(row.delivery_error, /http_error/);
      assert.match(row.delivery_error, /servidor reiniciando/);
      assert.ok(row.next_attempt_at, 'the retry has a due time rather than happening at once');

      // The pass five seconds from now must not spend a second attempt on it.
      // That is the whole bug: three instant attempts turned a twenty-second
      // restart into a permanently failed queue. The full window, and what
      // happens at the end of it, are `whatsapp-outbox-backoff.test.js`.
      await WaOutboxWorker.tick();
      assert.equal(sendTextCalls().length, 1);
      row = await asTenant(() => WaMessage.getById(body.data.id));
      assert.equal(row.delivery_status, 'queued');
      assert.equal(row.attempts, 1);
    } finally {
      stub.textStatus = 200;
      stub.textBody = null;
    }
  });

  it('never lets one unsendable message stop the pass', async () => {
    await clearOutbox();
    // A thread whose number stops being usable after the message was queued —
    // a cadastro corrected to something that is not a phone number. Dispatch
    // throws for it, and the message queued behind it still has to go out.
    const quebrada = await newConversation();
    await post(quebrada.id, { body: 'sem destino' });
    await asTenant(() => WaConversation.update(quebrada.id, { wa_phone_e164: '12', wa_lid: null }));

    const boa = await newConversation();
    const { body } = await post(boa.id, { body: 'esta tem de sair' });
    requests.length = 0;

    const summary = await WaOutboxWorker.tick();
    assert.equal(summary.failed, 1);
    assert.equal(summary.sent, 1);
    assert.equal(sendTextCalls().length, 1);
    assert.equal((await asTenant(() => WaMessage.getById(body.data.id))).delivery_status, 'sent');
  });
});

describe('audio is a voice bubble before it is a file', () => {
  // Uma função, não uma constante: `saida` só existe depois do `before`, e um
  // objeto montado no registro do `describe` congelaria um caminho indefinido.
  const audio = () => anexoDeSaida('recado.ogg', 'audio/ogg; codecs=opus');

  it('does NOT fall back after a 2xx — a retry would send it twice', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: '', attachment: audio() });
    requests.length = 0;

    await WaOutboxWorker.tick();

    assert.equal(audioCalls().length, 1);
    assert.equal(mediaCalls().length, 0, 'a 2xx audio must never be repeated as media');
    assert.equal((await asTenant(() => WaMessage.getById(body.data.id))).delivery_status, 'sent');
  });

  it('falls back to sendMedia on a non-2xx', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'segue o áudio', attachment: audio() });
    requests.length = 0;
    stub.audioStatus = 404;

    try {
      await WaOutboxWorker.tick();

      assert.equal(audioCalls().length, 1);
      assert.equal(mediaCalls().length, 1);
      assert.equal(mediaCalls()[0].payload.mediatype, 'audio');
      // NOT `audio.url`. What Evolution is given is the panel's own signed
      // media route, because the stored value is a path on the panel's disk
      // that no other machine can open — see `whatsapp-attachments.test.js`.
      assert.match(
        mediaCalls()[0].payload.media,
        new RegExp(`^https://painel\\.provedor\\.test/api/whatsapp-media/${body.data.id}\\?t=`)
      );
      assert.equal(mediaCalls()[0].payload.fileName, audio().name);
      const row = await asTenant(() => WaMessage.getById(body.data.id));
      assert.equal(row.delivery_status, 'sent');
      assert.ok(row.external_id, 'the id comes from the call that actually worked');
    } finally {
      stub.audioStatus = 200;
    }
  });

  it('sends a browser recording (WebM) through the voice-note route too', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    await post(conversation.id, { body: '', attachment: anexoDeSaida('audio-gravado.webm', 'audio/webm') });
    requests.length = 0;

    await WaOutboxWorker.tick();

    assert.equal(audioCalls().length, 1, 'o Evolution v2 converte para mensagem de voz');
    assert.equal(mediaCalls().length, 0);
  });

  it('sends anything else straight through sendMedia', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    await post(conversation.id, {
      body: 'a fatura',
      attachment: anexoDeSaida('f.pdf', 'application/pdf')
    });
    requests.length = 0;

    await WaOutboxWorker.tick();
    assert.equal(audioCalls().length, 0);
    assert.equal(mediaCalls().length, 1);
    assert.equal(mediaCalls()[0].payload.mediatype, 'document');
    // O tipo vai junto no v2: a URL do painel não tem extensão, e sem o campo o
    // servidor tinha de adivinhar o que era aquele arquivo.
    assert.equal(mediaCalls()[0].payload.mimetype, 'application/pdf');
  });
});

describe('an internal note is never sent', () => {
  it('is stored without a delivery status and the worker never sees it', async () => {
    const conversation = await newConversation();
    requests.length = 0;

    const { status, body } = await post(conversation.id, { body: 'cliente ligou também', isNote: true });
    assert.equal(status, 201);
    assert.equal(body.data.isNote, true);
    assert.equal(body.data.deliveryStatus, null);

    await WaOutboxWorker.tick();
    await WaOutboxWorker.tick();

    assert.equal(requests.length, 0, 'a note must never reach the server');
    const row = await asTenant(() => WaMessage.getById(body.data.id));
    assert.equal(row.delivery_status, null);
    assert.equal(row.attempts, 0);
  });

  it('accepts a note on a thread that has no address at all', async () => {
    const semEndereco = await newConversation({ thread: 'grupo-2@g.us', phone: '', lid: '' });
    const { status } = await post(semEndereco.id, { body: 'anotação', isNote: true });
    assert.equal(status, 201);
  });
});

describe('an opt-out does not silence a reply', () => {
  it('lets the operator answer someone who asked not to be contacted', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    await asTenant(() => WaOptOut.record({
      waPhone: conversation.wa_phone_e164, origin: 'customer', reasonText: 'SAIR'
    }));
    assert.equal(
      await asTenant(() => WaOptOut.isActive({ waPhone: conversation.wa_phone_e164 })),
      true
    );
    requests.length = 0;

    // An opt-out means the provider does not INITIATE contact. Refusing to
    // answer a customer who wrote in would be a worse product, not a more
    // respectful one — campaigns and alerts enforce the list, the reply box
    // does not.
    const { status, body } = await post(conversation.id, { body: 'claro, já resolvo' });
    assert.equal(status, 201);

    await WaOutboxWorker.tick();
    assert.equal(sendTextCalls().length, 1);
    assert.equal((await asTenant(() => WaMessage.getById(body.data.id))).delivery_status, 'sent');
  });
});

describe('routing picks the number the thread belongs to', () => {
  it('sends from the conversation own account', async () => {
    await clearOutbox();
    const conversation = await newConversation({ accountId: supportId });
    await post(conversation.id, { body: 'do número de suporte' });
    requests.length = 0;

    await WaOutboxWorker.tick();
    assert.equal(sendTextCalls()[0].path, `/message/sendText/${SUPPORT}`);
    assert.equal(sendTextCalls()[0].apikey, SUPPORT_TOKEN);
  });

  it('falls back to another connected number when that one is down', async () => {
    await clearOutbox();
    const conversation = await newConversation({ accountId: supportId });
    await post(conversation.id, { body: 'pelo reserva' });
    await asTenant(() => WhatsAppAccount.update(supportId, { status: 'disconnected' }));
    await asTenant(() => WhatsAppAccount.update(backupId, { status: 'connected' }));
    requests.length = 0;

    try {
      await WaOutboxWorker.tick();
      assert.equal(sendTextCalls()[0].path, `/message/sendText/${BACKUP}`);
      assert.equal(sendTextCalls()[0].apikey, BACKUP_TOKEN);
    } finally {
      await asTenant(() => WhatsAppAccount.update(supportId, { status: 'connected' }));
      await asTenant(() => WhatsAppAccount.update(backupId, { status: 'disconnected' }));
    }
  });

  it('um número marcado fora do ar, mas que o Evolution diz aberto, envia e volta a "conectado"', async () => {
    // O aviso de reconexão se perdeu: o banco diz "conectando", o servidor diz
    // "open". Recusar aqui era o "Nenhum número conectado" de uma conversa viva.
    const conversation = await newConversation({ accountId: supportId });
    await asTenant(() => WhatsAppAccount.update(supportId, { status: 'connecting' }));
    WaSendService.forgetLiveChecks();
    stub.connectionState = 'open';
    try {
      const { status, body } = await post(conversation.id, { body: 'o número está vivo' });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal((await asTenant(() => WhatsAppAccount.getById(supportId))).status, 'connected');
    } finally {
      stub.connectionState = null;
      WaSendService.forgetLiveChecks();
      await asTenant(() => WhatsAppAccount.update(supportId, { status: 'connected' }));
    }
  });

  it('refuses to enqueue at all when no number is connected', async () => {
    const conversation = await newConversation({ accountId: supportId });
    await asTenant(() => WhatsAppAccount.update(supportId, { status: 'disconnected' }));
    // O Evolution também diz fechado: aí sim, ninguém para enviar.
    WaSendService.forgetLiveChecks();
    stub.connectionState = 'close';
    try {
      const { status, body } = await post(conversation.id, { body: 'ninguém conectado' });
      assert.equal(status, 409);
      assert.equal(body.code, 'no_account');
    } finally {
      stub.connectionState = null;
      await asTenant(() => WhatsAppAccount.update(supportId, { status: 'connected' }));
    }
  });
});

describe('the per-minute ceiling', () => {
  it('holds one pass to the configured number of sends', async () => {
    // `stop()` drops the rolling window, so the budget this test measures is
    // not whatever the tests above happened to leave behind.
    WaOutboxWorker.stop();
    await asTenant(() => WhatsAppConfigService.saveConfig({ rateLimitPerMin: 2 }));
    await clearOutbox();

    try {
      const ids = [];
      for (const texto of ['um', 'dois', 'três', 'quatro', 'cinco']) {
        const conversation = await newConversation();
        // eslint-disable-next-line no-await-in-loop -- the order of the queue is the point
        const { body } = await post(conversation.id, { body: texto });
        ids.push(body.data.id);
      }

      const summary = await WaOutboxWorker.tick();
      assert.equal(summary.sent, 2);
      assert.equal(summary.skipped, 'rate_limited');
      assert.equal(sendTextCalls().length, 2, 'the ceiling is a ceiling, not a target for the batch');

      // A second pass in the same minute sends nothing more.
      const again = await WaOutboxWorker.tick();
      assert.equal(again.sent, 0);
      assert.equal(again.skipped, 'rate_limited');
      assert.equal(sendTextCalls().length, 2);

      const statuses = await Promise.all(ids.map(async (id) => (await asTenant(() => WaMessage.getById(id))).delivery_status));
      assert.equal(statuses.filter((s) => s === 'sent').length, 2);
      assert.equal(statuses.filter((s) => s === 'queued').length, 3);
    } finally {
      await asTenant(() => WhatsAppConfigService.saveConfig({ rateLimitPerMin: 60 }));
      WaOutboxWorker.stop();
    }
  });

  it('sends nothing while the integration is disabled', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    await post(conversation.id, { body: 'com a integração ligada' });
    await asTenant(() => WhatsAppConfigService.saveConfig({ enabled: false }));
    requests.length = 0;

    try {
      const summary = await WaOutboxWorker.tick();
      assert.equal(summary.skipped, 'disabled');
      assert.equal(requests.length, 0);
    } finally {
      await asTenant(() => WhatsAppConfigService.saveConfig({ enabled: true }));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A corrida com o eco de saída
//
// O painel assina `MESSAGES_UPSERT`, e o Evolution ecoa a mensagem que ACABOU
// de sair como evento de entrada; o webhook a grava como linha 'out' com o
// mesmo `external_id`. Entre o `dispatch` retornar e a confirmação de saída
// commitar existe uma janela em que o eco chega primeiro e insere.
//
// Antes desta guarda, a escrita violava o índice único `(tenant_id,
// external_id)`, o `catch` lia isso como "não enviou", a linha voltava para
// 'queued' com `external_id` ainda nulo — e o cliente recebia de novo.
// ─────────────────────────────────────────────────────────────────────────────
describe('o eco de entrada grava antes da confirmação de saída', () => {
  it('não reenvia: a linha sai da fila em vez de voltar para ela', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'uma vez só, por favor' });
    requests.length = 0;

    // O eco: uma linha 'out' com o id que o servidor VAI devolver, inserida
    // antes de a confirmação de saída chegar. É exatamente o que
    // `gravarMensagem` faz quando o webhook chega primeiro.
    // `nextId` é o id JÁ usado; o próximo envio produzirá o seguinte. É esse
    // que o eco precisa carregar para colidir com a confirmação de saída.
    const externalId = `EVO-${stub.nextId + 1}`;
    await asTenant(() => getDb()('wa_messages').insert({
      tenant_id: 1,
      conversation_id: conversation.id,
      direction: 'out',
      body: 'uma vez só, por favor',
      external_id: externalId,
      delivery_status: 'sent'
    }));

    await WaOutboxWorker.tick();

    // A prova que importa: uma chamada de envio, não duas.
    assert.equal(sendTextCalls().length, 1, 'reenviou — o cliente recebeu duas vezes');

    const row = await asTenant(() => WaMessage.getById(body.data.id));
    // 'queued' aqui significa que o próximo laço pegaria a linha de novo.
    assert.equal(row.delivery_status, 'sent');
    assert.equal(row.delivery_error, null);

    // E o segundo laço confirma: não sobrou nada para reenviar.
    await WaOutboxWorker.tick();
    assert.equal(sendTextCalls().length, 1);
  });
});

/**
 * O teto de envio é de cada provedor, e não do processo.
 *
 * Era um array só, num campo de classe compartilhado, enquanto o teto vem de
 * configuração POR PROVEDOR. E `forEachTenant` visita em série por id
 * crescente: o provedor de menor id gastava o minuto inteiro e os seguintes
 * levavam `rate_limited` sem ter enviado nada. Negação de serviço cruzada num
 * painel que vende isolamento.
 *
 * A prova precisa de DOIS provedores. Com um só, a janela compartilhada dá a
 * resposta certa por acidente — que é exatamente por que isto passou tanto
 * tempo despercebido.
 */
describe('o teto por minuto é de cada provedor', () => {
  let outro;

  before(async () => {
    await getDb()('tenants').insert({ slug: 'vizinho', name: 'Provedor Vizinho', status: 'active' });
    outro = (await getDb()('tenants').where({ slug: 'vizinho' }).first()).id;
  });

  /** Um processo novo: nada em memória, e o banco é tudo o que sobrou. */
  async function reiniciar() {
    WaOutboxWorker.stop();
  }

  const esquecerJanelas = () => getDb()('app_state')
    .where({ key: WaOutboxWorker.WINDOW_KEY }).del();

  beforeEach(async () => {
    await esquecerJanelas();
    await reiniciar();
  });

  it('o que um gasta não sai da cota do outro', async () => {
    const TETO = 3;

    // O primeiro provedor gasta o minuto inteiro.
    await asTenant(async () => {
      for (let i = 0; i < TETO; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- cada reserva é gravada
        assert.equal(await WaOutboxWorker.reserve(TETO), true, `reserva ${i + 1}`);
      }
      assert.equal(await WaOutboxWorker.reserve(TETO), false, 'o minuto dele acabou');
      assert.equal(WaOutboxWorker.budget(TETO), 0);
    });

    // O segundo não tem nada a ver com isso.
    await runInTenant(outro, async () => {
      assert.equal(
        WaOutboxWorker.budget(TETO), TETO,
        'o vizinho começou o minuto já sem cota'
      );
      assert.equal(await WaOutboxWorker.reserve(TETO), true);
    });

    // E gastar a cota do vizinho não devolve nada ao primeiro.
    await asTenant(() => {
      assert.equal(WaOutboxWorker.budget(TETO), 0);
    });
  });

  /**
   * O minuto atravessa o processo — é esta onda inteira num caso.
   *
   * Antes, a janela vivia só em memória e `stop` a largava: um deploy no meio
   * de uma campanha devolvia o minuto cheio, e o teto que o painel promete
   * seguir é o que o WhatsApp impõe, que não reinicia junto com a gente.
   */
  it('o minuto gasto sobrevive ao processo', async () => {
    const TETO = 3;

    await asTenant(async () => {
      for (let i = 0; i < TETO; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- cada reserva é gravada
        await WaOutboxWorker.reserve(TETO);
      }
    });

    await reiniciar();

    await asTenant(async () => {
      await WaOutboxWorker.hydrate();
      assert.equal(WaOutboxWorker.budget(TETO), 0, 'o restart devolveu o minuto cheio');
      assert.equal(await WaOutboxWorker.reserve(TETO), false);
    });

    // E o do vizinho continua sendo dele: o que foi gravado é por provedor.
    await runInTenant(outro, async () => {
      await WaOutboxWorker.hydrate();
      assert.equal(WaOutboxWorker.budget(TETO), TETO);
    });
  });

  it('mas o que sobrevive é o minuto, não a vaga', async () => {
    const TETO = 2;
    // Instantes gravados por um processo que morreu há mais de um minuto. Eles
    // não podem segurar ninguém: a janela é rolante, e um painel que ficou uma
    // hora fora do ar não deve dois minutos a ninguém quando volta.
    await asTenant(() => AppState.upsert(
      WaOutboxWorker.WINDOW_KEY,
      JSON.stringify([Date.now() - 61_000, Date.now() - 3_600_000])
    ));

    await asTenant(async () => {
      await WaOutboxWorker.hydrate();
      assert.equal(WaOutboxWorker.budget(TETO), TETO);
    });
  });

  it('e um instante no futuro não segura vaga', async () => {
    const TETO = 2;
    // Relógio que andou para trás. Sem o corte, a vaga ficaria presa até o
    // relógio alcançar o instante gravado.
    await asTenant(() => AppState.upsert(
      WaOutboxWorker.WINDOW_KEY,
      JSON.stringify([Date.now() + 10 * 60_000, Date.now() + 60_000])
    ));

    await asTenant(async () => {
      await WaOutboxWorker.hydrate();
      assert.equal(WaOutboxWorker.budget(TETO), TETO);
    });
  });

  it('janela ilegível é janela vazia, e não um envio parado', async () => {
    const TETO = 2;
    for (const lixo of ['não é json', '{"não":"uma lista"}', 'null', '[["nem número"]]']) {
      // eslint-disable-next-line no-await-in-loop -- um estado gravado por vez
      await asTenant(() => AppState.upsert(WaOutboxWorker.WINDOW_KEY, lixo));
      await reiniciar();
      // eslint-disable-next-line no-await-in-loop -- idem
      await asTenant(async () => {
        await WaOutboxWorker.hydrate();
        assert.equal(WaOutboxWorker.budget(TETO), TETO, `parou o envio com ${lixo}`);
      });
    }
  });

  it('e a leitura é uma por provedor por processo, não uma por passagem', async () => {
    // Esta função roda a cada cinco segundos, vezes o número de provedores. Uma
    // consulta a mais POR PASSAGEM é uma por provedor que ninguém pediu — a
    // conta que o painel já pagou caro de aprender na tela inicial.
    const TETO = 2;
    let leituras = 0;
    const original = AppState.get;
    AppState.get = async (key) => {
      if (key === WaOutboxWorker.WINDOW_KEY) leituras += 1;
      return original.call(AppState, key);
    };
    try {
      await asTenant(async () => {
        await WaOutboxWorker.hydrate();
        await WaOutboxWorker.hydrate();
        await WaOutboxWorker.hydrate();
        assert.equal(WaOutboxWorker.budget(TETO), TETO);
      });
      assert.equal(leituras, 1);
    } finally {
      AppState.get = original;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O teto do ENFILEIRAMENTO, que é outro do teto da entrega
//
// O worker estrangula a ENTREGA pelo teto por minuto que o provedor configura.
// O enfileiramento não tinha teto próprio: só o `apiLimiter` genérico, 300 por
// minuto, e 300 linhas na fila por sessão é uma fila que o operador vê crescer
// sem entender por quê.
// ─────────────────────────────────────────────────────────────────────────────
describe('o teto de quem enfileira', () => {
  before(() => {
    whatsappSendLimiter.resetKey(`user:${userId}`);
    whatsappBulkRequeueLimiter.resetKey(`user:${userId}`);
  });

  after(() => {
    whatsappSendLimiter.resetKey(`user:${userId}`);
    whatsappBulkRequeueLimiter.resetKey(`user:${userId}`);
  });

  it('o reenfileiramento EM BLOCO tem teto muito mais apertado que o envio', async () => {
    // Os dois atos diferem em três ordens de grandeza: um enfileira uma linha,
    // o outro pode enfileirar milhares. O mesmo teto seria frouxo para um ou
    // apertado para o outro.
    //
    // Doze e não quatro: a rota recebe a JANELA, então "a última hora" e "as
    // últimas seis" são pedidos diferentes e o operador que não sabe de quando
    // é a queda tenta várias. Quatro pegava a suíte de `requeue-failed`, que
    // exercita exatamente isso — e o que pega uma suíte pega um operador.
    const bulk = () => call(`${panelUrl}/api/whatsapp/messages/requeue-failed`, {
      method: 'POST', headers: authHeaders(token), body: {}
    });
    for (let i = 0; i < 12; i += 1) {
      assert.notEqual((await bulk()).status, 429, `a tentativa ${i + 1} devia caber no minuto`);
    }
    const { status, body } = await bulk();
    assert.equal(status, 429);
    assert.equal(body.code, 'rate_limited');
    whatsappBulkRequeueLimiter.resetKey(`user:${userId}`);
  });

  it('e o envio de uma linha cabe muito acima de qualquer humano', async () => {
    // Sessenta é o ponto onde um limite destes tem que ficar: invisível para
    // quem trabalha, presente para quem não está trabalhando. Aqui se confere
    // o lado de baixo — que o plantão não esbarra nele.
    const conversation = await newConversation();
    for (let i = 0; i < 10; i += 1) {
      assert.notEqual(
        (await post(conversation.id, { body: `mensagem ${i}` })).status, 429,
        'o teto pegou um operador atendendo normalmente'
      );
    }
    whatsappSendLimiter.resetKey(`user:${userId}`);
    await clearOutbox();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A passagem ociosa
//
// O worker acorda a cada cinco segundos e visitava TODO provedor ativo para
// perguntar a cada um se havia algo na fila — uma consulta pela lista de
// provedores e mais uma por provedor, com a fila vazia em todos, que é o estado
// normal de um painel. Agora ele pergunta uma vez e visita só quem respondeu.
// ─────────────────────────────────────────────────────────────────────────────
describe('a passagem ociosa do envio', () => {
  let ociosos;

  before(async () => {
    for (const slug of ['ocioso-a', 'ocioso-b', 'ocioso-c']) {
      // eslint-disable-next-line no-await-in-loop -- três linhas de fixture
      await getDb()('tenants').insert({ slug, name: slug, status: 'active' });
    }
    ociosos = await getDb()('tenants').whereIn('slug', ['ocioso-a', 'ocioso-b', 'ocioso-c']).pluck('id');
  });

  /** Quem `tickForTenant` atendeu, na ordem. */
  async function visitados(fn) {
    const lista = [];
    const original = WaOutboxWorker.tickForTenant;
    WaOutboxWorker.tickForTenant = function espiao() {
      lista.push(currentTenantId());
      return original.call(this);
    };
    try {
      await fn();
    } finally {
      WaOutboxWorker.tickForTenant = original;
    }
    return lista;
  }

  it('com a fila vazia em todo mundo, é UMA consulta — com um provedor ou com cinco', async () => {
    await clearOutbox();
    // A premissa, conferida em vez de suposta: nenhum provedor tem nada vencido.
    // Sem ela a contagem abaixo mediria o resto de outro teste.
    assert.deepEqual(await WaMessage.providersWithSendable(), []);
    assert.ok(
      (await getDb()('tenants').where({ status: 'active' }).count({ n: '*' }))[0].n >= 4,
      'o caso só prova algo com vários provedores ativos'
    );

    const db = getDb();
    let consultas = 0;
    const contar = () => { consultas += 1; };
    db.on('query', contar);
    let visitas;
    try {
      visitas = await visitados(() => WaOutboxWorker.tick());
    } finally {
      db.off('query', contar);
    }
    assert.deepEqual(visitas, [], 'visitou provedor sem nada na fila');
    assert.equal(consultas, 1);
  });

  it('visita só quem tem mensagem vencida, e ela sai', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'só este provedor tem fila' });

    let summary;
    const visitas = await visitados(async () => { summary = await WaOutboxWorker.tick(); });

    assert.deepEqual(visitas, [1]);
    for (const id of ociosos) assert.ok(!visitas.includes(id));
    assert.equal(summary.sent, 1);
    assert.equal((await asTenant(() => WaMessage.getById(body.data.id))).delivery_status, 'sent');
  });

  it('uma mensagem ainda em espera de nova tentativa não acorda o provedor', async () => {
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'ainda não é a hora' });
    await asTenant(() => WaMessage.update(body.data.id, { next_attempt_at: new Date(Date.now() + 60_000) }));

    const visitas = await visitados(() => WaOutboxWorker.tick());
    assert.deepEqual(visitas, []);
    assert.equal(sendTextCalls().length, 0);
  });

  it('a garra de uma passagem que morreu no meio acorda o provedor', async () => {
    // O caminho de recuperação: uma linha presa em 'sending' além do prazo de
    // retomada. Se a pergunta prévia usasse um critério próprio e esquecesse
    // este ramo, a mensagem ficaria presa para sempre — sem erro nenhum.
    await clearOutbox();
    const conversation = await newConversation();
    const { body } = await post(conversation.id, { body: 'a passagem anterior morreu' });
    await asTenant(() => WaMessage.update(body.data.id, {
      delivery_status: 'sending',
      claimed_at: new Date(Date.now() - RECLAIM_MS - 60_000)
    }));

    const visitas = await visitados(() => WaOutboxWorker.tick());
    assert.deepEqual(visitas, [1]);
    assert.equal((await asTenant(() => WaMessage.getById(body.data.id))).delivery_status, 'sent');
  });

  it('o provedor suspenso não é visitado, mesmo com fila', async () => {
    // A pergunta prévia atravessa o escopo e não sabe de status; quem sabe é o
    // laço. Suspender o provedor dos testes durante o caso é o jeito de ter uma
    // fila de verdade num suspenso — conta, conversa e linha reais.
    await clearOutbox();
    const conversation = await newConversation();
    await post(conversation.id, { body: 'não pode sair' });
    await getDb()('tenants').where({ id: 1 }).update({ status: 'suspended' });

    try {
      assert.ok((await WaMessage.providersWithSendable()).includes(1), 'a premissa: ele TEM fila');
      const visitas = await visitados(() => WaOutboxWorker.tick());
      assert.deepEqual(visitas, [], 'o suspenso foi visitado');
      assert.equal(sendTextCalls().length, 0);
    } finally {
      await getDb()('tenants').where({ id: 1 }).update({ status: 'active' });
      await clearOutbox();
    }
  });
});
