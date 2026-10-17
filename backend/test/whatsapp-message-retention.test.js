import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders,
  call,
  getDb,
  runInTenant,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaMessageSweeper } = await import('../src/services/waMessageSweeper.js');

/**
 * The history sweep — the one job here that deletes what an operator wrote.
 *
 * Every test below is a rule about what must SURVIVE. That asymmetry is the
 * point: a sweep that deletes too little costs disk, which is noticed and
 * fixed, and a sweep that deletes too much costs the conversation a provider
 * needs the day a customer disputes something. So the deletion gets one test
 * and the four protections get one each, plus the one that proves a provider
 * cannot sweep its neighbour's threads.
 *
 * The rows are seeded through the real models inside a real provider scope
 * rather than written straight to the table, because "inside a scope" is half
 * of what is under test: `wa_messages` is in `SCOPED_TABLES`, and a fixture
 * that bypassed `tdb` would prove the sweep filters rows it never filtered.
 */
const EVO_BASE = 'https://evo.provedor.test';
const DAY = 24 * 60 * 60 * 1000;

/**
 * A moment with its milliseconds cut off.
 *
 * MySQL's `TIMESTAMP` keeps whole seconds unless the column asks for
 * fractional precision, and `wa_messages.created_at` does not. A row seeded at
 * `…347.402` reads back there as `…347.000`, so a cutoff that lands inside that
 * lost millisecond would include a row on one engine and exclude it on the
 * other two. Seeding times the storage can actually hold removes the question.
 */
const wholeSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let panelUrl;
let token;
let alfa;
let beta;
let alfaConversationId;
let betaConversationId;

/** Sets the window this provider's sweep will read, through the real setting. */
function comRetencao(days, tenantId = alfa) {
  return runInTenant(tenantId, () => WhatsAppConfigService.saveConfig({ messageRetentionDays: days }));
}

/**
 * One row, with its age chosen by the caller.
 *
 * `created_at` is explicit on every seed because age is the only thing this
 * module decides on, and "now" is never the interesting value.
 */
function mensagem({
  ageDays = 0,
  direction = 'out',
  delivery_status = 'sent',
  attachment_path = null,
  body = 'a mensagem',
  tenantId = alfa,
  conversationId = null
} = {}) {
  const quando = wholeSecond(Date.now() - ageDays * DAY);
  return runInTenant(tenantId, () => WaMessage.create({
    conversation_id: conversationId ?? (tenantId === alfa ? alfaConversationId : betaConversationId),
    direction,
    body,
    attachment_path,
    attachment_type: attachment_path ? 'image/png' : null,
    attachment_name: attachment_path ? 'foto.png' : null,
    is_note: false,
    delivery_status,
    source: 'operator',
    created_at: quando,
    updated_at: quando
  }));
}

/** One pass, as the loop performs it: inside one provider's scope. */
const varrer = (tenantId = alfa) => runInTenant(tenantId, () => WaMessageSweeper.sweep());

/** Whether a seeded row is still there, asked WITHOUT a provider filter. */
async function existe(id) {
  return Boolean(await getDb()('wa_messages').where({ id }).first());
}

const idsDe = async (tenantId) => getDb()('wa_messages').where({ tenant_id: tenantId }).pluck('id');

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'vizinho', name: 'Provedor Vizinho', status: 'active' });
  beta = (await db('tenants').orderBy('id', 'desc').first()).id;

  for (const [tenantId, nome] of [[alfa, 'painel-historico'], [beta, 'painel-vizinho']]) {
    // Inside a provider: `app_state` is per-provider, so a configuration write
    // with nobody in scope refuses.
    await runInTenant(tenantId, () => WhatsAppConfigService.saveConfig({
      enabled: true,
      webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook'
    }));
    const account = await runInTenant(tenantId, () => WhatsAppAccount.create({
      name: nome,
      purpose: 'support',
      flavor: 'v2',
      base_url: EVO_BASE,
      status: 'connected',
      is_default: true,
      ...WhatsAppConfigService.encryptInstanceToken(`token-${nome}`),
      ...WhatsAppConfigService.encryptWebhookToken(`webhook-${nome}`)
    }));
    const thread = await runInTenant(tenantId, () => WaConversation.ensure({
      accountId: account.id,
      externalThreadId: `5593981${tenantId}000@s.whatsapp.net`,
      waPhone: `5593981${tenantId}000`,
      waLid: null,
      pushName: 'Cliente'
    }));
    if (tenantId === alfa) alfaConversationId = thread.id;
    else betaConversationId = thread.id;
  }
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('wa_messages').del();
  await comRetencao(0, alfa);
  await comRetencao(0, beta);
});

describe('retention off', () => {
  it('deletes nothing and says which kind of nothing it is', async () => {
    const antiga = await mensagem({ ageDays: 400 });

    const result = await varrer();

    // `disabled` rather than a bare zero: an operator who turned retention off
    // and one whose oldest message is a week old both get "0", and only the
    // reason tells them apart.
    assert.equal(result.skipped, 'disabled');
    assert.equal(result.messages, 0);
    assert.ok(await existe(antiga.id));
  });

  it('is the default, so an install that never touches the setting keeps everything', async () => {
    const config = await runInTenant(alfa, () => WhatsAppConfigService.getConfig());
    assert.equal(config.messageRetentionDays, 0);
  });
});

describe('what ages out', () => {
  it('deletes a plain message past the window', async () => {
    await comRetencao(30);
    const antiga = await mensagem({ ageDays: 90 });

    const result = await varrer();

    assert.equal(result.skipped, undefined);
    assert.equal(result.messages, 1);
    assert.equal(await existe(antiga.id), false);
  });

  it('keeps a message inside the window, and says nothing was old rather than nothing was on', async () => {
    await comRetencao(30);
    const recente = await mensagem({ ageDays: 3 });

    const result = await varrer();

    // No `skipped` at all with a count of zero is the third answer, and it is
    // the one that means the sweep ran and found nothing to do.
    assert.equal(result.skipped, undefined);
    assert.equal(result.messages, 0);
    assert.ok(await existe(recente.id));
  });

  /**
   * `delivery_status` is NULL on every inbound message — it describes a send,
   * and nothing was sent. Written with a plain `whereNotIn` the comparison
   * evaluates to NULL rather than true and the customer's half of every
   * conversation is protected forever, which looks exactly like a working
   * sweep until somebody counts the rows.
   */
  it('deletes an inbound message, whose delivery_status is NULL', async () => {
    await comRetencao(30);
    const entrada = await mensagem({ ageDays: 90, direction: 'in', delivery_status: null });

    const result = await varrer();

    assert.equal(result.messages, 1);
    assert.equal(await existe(entrada.id), false);
  });
});

describe('what is never deleted', () => {
  for (const status of ['queued', 'sending']) {
    it(`keeps an old ${status} message, however far past the window it is`, async () => {
      await comRetencao(30);
      const pendente = await mensagem({ ageDays: 400, delivery_status: status });

      const result = await varrer();

      // Age is not the question for these rows; whether they have gone out is.
      // Deleting one makes a reply an operator typed vanish between being
      // written and being sent, with nothing anywhere to say why.
      assert.equal(result.messages, 0);
      assert.ok(await existe(pendente.id));
    });
  }

  /**
   * The join between the two retentions. `WaMediaSweeper` is the only thing
   * that unlinks a file, and it nulls `attachment_path` when it does — so with
   * attachment retention off, a message carrying one stays forever. That is
   * what "keep the attachments forever" means, not a bug in this window.
   */
  it('keeps an old message whose attachment is still on disk', async () => {
    await comRetencao(30);
    const comAnexo = await mensagem({ ageDays: 400, attachment_path: 'wa-media/7/foto.png' });

    const result = await varrer();

    assert.equal(result.messages, 0);
    assert.ok(await existe(comAnexo.id));
  });

  it('deletes that same message once the media sweep has cleared the path', async () => {
    await comRetencao(30);
    const comAnexo = await mensagem({ ageDays: 400, attachment_path: 'wa-media/7/foto.png' });

    await runInTenant(alfa, () => WaMessage.update(comAnexo.id, { attachment_path: null }));
    // `updated_at` moves when the media sweep clears the columns; `created_at`
    // is what the window is measured against, and it does not.
    const result = await varrer();

    assert.equal(result.messages, 1);
    assert.equal(await existe(comAnexo.id), false);
  });

  /**
   * The conversation row is the phone↔contact binding. There is one per THREAD,
   * so deleting it saves no disk worth counting, and what it costs is knowing
   * whose conversation this was.
   */
  it('leaves the conversation standing after every one of its messages is gone', async () => {
    await comRetencao(30);
    await mensagem({ ageDays: 90 });
    await mensagem({ ageDays: 120 });

    const result = await varrer();

    assert.equal(result.messages, 2);
    assert.equal((await idsDe(alfa)).length, 0);
    const thread = await runInTenant(alfa, () => WaConversation.getById(alfaConversationId));
    assert.ok(thread, 'the conversation must survive its own history');
    assert.equal(thread.id, alfaConversationId);
  });
});

describe('one provider at a time', () => {
  it('never touches another provider\'s messages, even with the same window', async () => {
    await comRetencao(30, alfa);
    await comRetencao(30, beta);
    const minha = await mensagem({ ageDays: 90, tenantId: alfa });
    const vizinha = await mensagem({ ageDays: 90, tenantId: beta });

    const result = await varrer(alfa);

    assert.equal(result.messages, 1);
    assert.equal(await existe(minha.id), false);
    assert.ok(await existe(vizinha.id), 'the neighbour keeps its history');
  });

  /**
   * Each provider's window is its own setting, in its own `app_state`. A
   * neighbour who has never turned retention on must not lose rows because the
   * provider next door did.
   */
  it('applies each provider\'s own window, not the first one it read', async () => {
    await comRetencao(30, alfa);
    await comRetencao(0, beta);
    const minha = await mensagem({ ageDays: 90, tenantId: alfa });
    const vizinha = await mensagem({ ageDays: 90, tenantId: beta });

    assert.equal((await varrer(alfa)).messages, 1);
    assert.equal((await varrer(beta)).skipped, 'disabled');

    assert.equal(await existe(minha.id), false);
    assert.ok(await existe(vizinha.id));
  });

  it('sweeps every provider on one tick', async () => {
    await comRetencao(30, alfa);
    await comRetencao(30, beta);
    const minha = await mensagem({ ageDays: 90, tenantId: alfa });
    const vizinha = await mensagem({ ageDays: 90, tenantId: beta });

    // No scope open: the tick opens one per provider itself, which is the
    // whole difference between this job and the media sweep beside it.
    const results = await WaMessageSweeper.tick();

    assert.equal(results.length, 2);
    assert.equal(results.reduce((total, one) => total + one.messages, 0), 2);
    assert.equal(await existe(minha.id), false);
    assert.equal(await existe(vizinha.id), false);
  });

  /**
   * O suspenso também, e esta é a decisão que mudou.
   *
   * A varredura visitava só `active`, e como não existe prazo de suspensão nem
   * exclusão automática, não visitar queria dizer guardar para sempre — a
   * conversa inteira de cada assinante, sem prazo nenhum, num provedor que o
   * ISP nem atende mais. A retenção que ele configurou passa a valer estando
   * suspenso ou não: suspender muda quem trabalha, não o que guardamos dele.
   */
  it('e o provedor suspenso também é varrido', async () => {
    await comRetencao(30, beta);
    const dele = await mensagem({ ageDays: 90, tenantId: beta });
    await getDb()('tenants').where({ id: beta }).update({ status: 'suspended' });

    try {
      await WaMessageSweeper.tick();
      assert.equal(await existe(dele.id), false, 'o suspenso continuou guardando para sempre');
    } finally {
      await getDb()('tenants').where({ id: beta }).update({ status: 'active' });
    }
  });
});

describe('the setting reaches the sweep from the settings screen', () => {
  it('saves messageRetentionDays through the API the form posts to', async () => {
    const saved = await call(`${panelUrl}/api/whatsapp/config`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: { messageRetentionDays: 45 }
    });

    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.messageRetentionDays, 45);

    // The field being defined is not the same as the field being wired: this
    // asserts the value the sweep will actually read, not the one the form
    // sent.
    const config = await runInTenant(alfa, () => WhatsAppConfigService.getConfig());
    assert.equal(config.messageRetentionDays, 45);
  });
});
