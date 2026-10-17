import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  asTenant,
  authHeaders,
  call,
  getDb,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaMediaSweeper } = await import('../src/services/waMediaSweeper.js');

/**
 * The attachment sweep, against a real disk.
 *
 * Every file below is written into the REAL `DATA_DIR` the harness made and
 * then looked for again with `fs.existsSync`. A stubbed filesystem would be
 * stubbing the exact thing under test: this module's whole job is deciding
 * which bytes on which disk may be removed, and a fake `fs` answers that
 * question by agreeing with whatever the code just decided.
 *
 * The age of a file is set with `utimes` rather than by waiting, so "older than
 * the window" is a real mtime on a real inode and the suite still finishes in
 * milliseconds.
 */
const DATA_DIR = process.env.DATA_DIR;
const MEDIA_ROOT = path.join(DATA_DIR, 'wa-media');

const EVO_BASE = 'https://evo.provedor.test';
const WEBHOOK_BASE = 'https://painel.provedor.test/api/whatsapp-webhook';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A one-pixel PNG: small, but real bytes with a real size on disk. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let panelUrl;
let token;
let accountId;
let conversationId;

/**
 * Sets the retention window the sweeper will read.
 *
 * Through the real setting, not a stub. This was written while
 * `mediaRetentionDays` was defined but never wired — `saveConfig` dropped it
 * on the floor — so it patched `getConfig` to pin what the sweeper actually
 * promises: "the window is whatever the configuration reports". The field is
 * wired now, so the stub is gone and the same tests exercise the path a real
 * install takes, from the settings form down.
 */
function comRetencao(days) {
  return asTenant(() => WhatsAppConfigService.saveConfig({ mediaRetentionDays: days }));
}

/** Writes a file under `DATA_DIR`, `ageDays` old, and answers with its path. */
function gravar(relative, ageDays = 0, bytes = PNG) {
  const destino = path.join(DATA_DIR, relative);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, bytes);
  const quando = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(destino, quando, quando);
  return relative;
}

const existe = (relative) => fs.existsSync(path.join(DATA_DIR, relative));

/** A message row pointing at a stored file, in whatever delivery state. */
async function mensagem({
  attachment_path = null,
  attachment_type = 'image/png',
  attachment_name = 'foto.png',
  direction = 'out',
  delivery_status = 'sent',
  body = 'a mensagem que fica',
  ageDays = 0
} = {}) {
  const quando = new Date(Date.now() - ageDays * DAY_MS);
  return asTenant(() => WaMessage.create({
    conversation_id: conversationId,
    direction,
    body,
    attachment_path,
    attachment_type: attachment_path ? attachment_type : null,
    attachment_name: attachment_path ? attachment_name : null,
    is_note: false,
    delivery_status,
    source: 'operator',
    created_at: quando,
    updated_at: quando
  }));
}

const recarregar = (id) => asTenant(() => WaMessage.getById(id));

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  // Inside a provider: `app_state` became per-provider while this was being
  // written, so a configuration write with nobody in scope now refuses.
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: WEBHOOK_BASE
  }));

  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-varredura',
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-varredura'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-varredura')
  }));
  accountId = account.id;

  const conversation = await asTenant(() => WaConversation.ensure({
    accountId,
    externalThreadId: '5593981110000@s.whatsapp.net',
    waPhone: '5593981110000',
    waLid: null,
    pushName: 'Cliente'
  }));
  conversationId = conversation.id;
});

// Each test starts on an empty disk and an empty table, so the counts a pass
// reports are the files that test wrote and nothing left over from the one
// before it.
beforeEach(async () => {
  // Back to forever between tests, so a window one test set cannot decide what
  // the next one sweeps.
  await comRetencao(0);
  fs.rmSync(MEDIA_ROOT, { recursive: true, force: true });
  await getDb()('wa_messages').del();
});

after(async () => {
  WaMediaSweeper.stop();
  await stopTestServers();
});

describe('what the sweep deletes', () => {
  it('deletes a file past the window and clears the row, keeping the message', async () => {
    await comRetencao(30);
    const relative = gravar(`wa-media/${conversationId}/antiga.png`, 45);
    const message = await mensagem({ attachment_path: relative, ageDays: 45 });

    const result = await WaMediaSweeper.tick();

    assert.equal(result.files, 1);
    assert.equal(existe(relative), false, 'the file is off the disk');

    const row = await recarregar(message.id);
    assert.ok(row, 'the message row survives — history is not what fills a disk');
    assert.equal(row.body, 'a mensagem que fica');
    assert.equal(row.attachment_path, null);
    assert.equal(row.attachment_type, null);
    assert.equal(row.attachment_name, null);
  });

  /**
   * The rule that costs the most to get wrong. Everything else here costs
   * disk; deleting the file under a message that has not gone out yet turns a
   * pending send into a permanent failure, and the operator who attached it
   * never learns why.
   */
  it('never deletes a file a queued message still has to send, however old', async () => {
    await comRetencao(1);
    const relative = gravar(`wa-media/${conversationId}/na-fila.png`, 400);
    const message = await mensagem({
      attachment_path: relative,
      delivery_status: 'queued',
      ageDays: 400
    });

    const result = await WaMediaSweeper.tick();

    assert.equal(result.files, 0);
    assert.equal(existe(relative), true, 'the bytes the send is waiting on are still there');
    const row = await recarregar(message.id);
    assert.equal(row.attachment_path, relative, 'and the row still points at them');
  });

  it('never deletes a file a sending message still has to send', async () => {
    await comRetencao(1);
    const relative = gravar(`wa-media/${conversationId}/em-envio.png`, 400);
    await mensagem({ attachment_path: relative, delivery_status: 'sending', ageDays: 400 });

    const result = await WaMediaSweeper.tick();

    assert.equal(result.files, 0);
    assert.equal(existe(relative), true);
  });

  it('leaves a file inside the window alone', async () => {
    await comRetencao(30);
    const relative = gravar(`wa-media/${conversationId}/recente.png`, 5);
    const message = await mensagem({ attachment_path: relative, ageDays: 5 });

    const result = await WaMediaSweeper.tick();

    assert.equal(result.files, 0);
    assert.equal(existe(relative), true);
    const row = await recarregar(message.id);
    assert.equal(row.attachment_path, relative);
  });

  /** An upload nobody ever sent: bytes on disk with no row naming them. */
  it('sweeps an orphan file by the same clock', async () => {
    await comRetencao(30);
    const orfao = gravar('wa-media/out/abandonado.png', 60);
    const novo = gravar('wa-media/out/de-agora.png', 1);

    const result = await WaMediaSweeper.tick();

    assert.equal(result.files, 1);
    assert.equal(existe(orfao), false);
    assert.equal(existe(novo), true, 'a young orphan is an upload in progress');
  });

  /**
   * The sweep walks `wa-media` and not `DATA_DIR`, which is the difference
   * between reclaiming disk and deleting the database that fills it.
   */
  it('never touches anything outside the media directory', async () => {
    await comRetencao(1);
    const vizinho = gravar('nao-e-midia.sqlite', 500, Buffer.from('SQLite format 3\0'));

    await WaMediaSweeper.tick();

    assert.equal(existe(vizinho), true);
  });
});

describe('what the sweep reports', () => {
  it('deletes nothing and says so with retention at zero', async () => {
    await comRetencao(0);
    const relative = gravar(`wa-media/${conversationId}/velhissima.png`, 900);
    const message = await mensagem({ attachment_path: relative, ageDays: 900 });

    const result = await WaMediaSweeper.tick();

    assert.equal(result.skipped, 'disabled');
    assert.equal(result.files, 0);
    assert.equal(result.mb, 0);
    assert.equal(existe(relative), true, 'zero is forever, and forever is the default');
    const row = await recarregar(message.id);
    assert.equal(row.attachment_path, relative);
  });

  it('reports what it did on the manual route', async () => {
    await comRetencao(10);
    const um = gravar(`wa-media/${conversationId}/um.png`, 20, Buffer.alloc(512 * 1024, 7));
    const dois = gravar(`wa-media/${conversationId}/dois.png`, 20, Buffer.alloc(512 * 1024, 9));
    await mensagem({ attachment_path: um, ageDays: 20 });
    await mensagem({ attachment_path: dois, ageDays: 20 });

    const res = await call(`${panelUrl}/api/whatsapp/media/sweep`, {
      method: 'POST',
      headers: authHeaders(token)
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.files, 2);
    assert.equal(res.body.data.mb, 1);
    // Matched on the two numbers rather than on the sentence around them: the
    // message is translated, the installation's default locale is pt-BR, and
    // what the operator has to be told is how many files went and how much
    // disk came back — in whatever language they read.
    assert.match(res.body.message, /(^|\D)2(\D|$)/);
    assert.match(res.body.message, /1 MB/);
    assert.equal(existe(um), false);
    assert.equal(existe(dois), false);
  });

  it('refuses the route to anyone without a session', async () => {
    const res = await call(`${panelUrl}/api/whatsapp/media/sweep`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  /**
   * Wave 8 gave stored media a per-provider subtree, so the pass no longer
   * refuses when a second provider appears — it runs once per provider. What it
   * stops doing is touching the legacy area, whose paths name no provider: with
   * two of them on the disk, a file there could belong to either, and the sweep
   * does not guess with somebody's customer photos.
   *
   * The rest of that story — each pass inside its own subtree — is in
   * `whatsapp-media-tenancy.test.js`; here it is only that the refusal is gone
   * and the legacy area survives it.
   */
  it('keeps running when a second provider exists, and leaves the legacy area alone', async () => {
    await comRetencao(1);
    const relative = gravar(`wa-media/${conversationId}/de-alguem.png`, 90);
    await mensagem({ attachment_path: relative, ageDays: 90 });
    await getDb()('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });

    try {
      const result = await WaMediaSweeper.tick();
      assert.equal(result.skipped, undefined, 'the pass runs rather than refusing');
      assert.equal(result.files, 0);
      assert.equal(existe(relative), true, 'a legacy path names no owner, so it is kept');
    } finally {
      await getDb()('tenants').where({ slug: 'beta' }).del();
    }
  });
});
