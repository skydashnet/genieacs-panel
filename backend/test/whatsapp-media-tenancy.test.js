import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
const { default: WaAttachmentService } = await import('../src/services/waAttachmentService.js');
const { default: WaMediaSweeper } = await import('../src/services/waMediaSweeper.js');
const { sign } = await import('../src/utils/wa/waMediaToken.js');

/**
 * The per-provider subtree under `wa-media`, on a panel that has two providers.
 *
 * Everything here is a real file on the real `DATA_DIR` the harness made, for
 * the reason the sibling suites already give: every claim below is about which
 * bytes on which disk a provider may reach or remove, and a stubbed filesystem
 * answers those by agreeing with whatever the code just decided.
 *
 * The three things wave 8 froze, one describe block each:
 *
 *   1. A new write carries the provider in its path.
 *   2. A read does not care — a path written before the subtree existed still
 *      names where its file actually is, and is still served.
 *   3. The sweep runs once per provider and sees only that provider's subtree,
 *      touching the legacy area only on an install where exactly one provider
 *      could possibly own it.
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

/**
 * Whole seconds, like the health suite: MySQL `TIMESTAMP` keeps no fraction and
 * CI runs MySQL. A seeded time carrying milliseconds comes back rounded, and an
 * assertion about "older than the window" becomes a coin toss.
 */
const wholeSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000);

let panelUrl;
let token;
let alfa;
let beta;
let conversaAlfa;
let conversaBeta;

/** Writes a file under `DATA_DIR`, `ageDays` old, and answers with its path. */
function gravar(relative, ageDays = 0, bytes = PNG) {
  const destino = path.join(DATA_DIR, relative);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, bytes);
  const quando = wholeSecond(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(destino, quando, quando);
  return relative;
}

const existe = (relative) => fs.existsSync(path.join(DATA_DIR, relative));

/** A row carrying an attachment, in whichever provider. */
function mensagem({
  tenant,
  conversationId,
  attachment_path,
  delivery_status = 'sent',
  ageDays = 0
}) {
  const quando = wholeSecond(Date.now() - ageDays * DAY_MS);
  return runInTenant(tenant, () => WaMessage.create({
    conversation_id: conversationId,
    direction: 'out',
    body: 'a mensagem que fica',
    attachment_path,
    attachment_type: 'image/png',
    attachment_name: 'foto.png',
    is_note: false,
    delivery_status,
    source: 'operator',
    created_at: quando,
    updated_at: quando
  }));
}

/** One provider's retention window — `app_state` is scoped, so it is theirs alone. */
const comRetencao = (tenant, days) => runInTenant(
  tenant,
  () => WhatsAppConfigService.saveConfig({ mediaRetentionDays: days })
);

/** `call` parses JSON; a file has to come back as bytes. */
async function fetchRaw(url, options = {}) {
  const response = await fetch(url, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    buffer,
    json: () => { try { return JSON.parse(buffer.toString('utf8')); } catch { return null; } }
  };
}

/** The session route. The only session in this suite belongs to Alfa. */
const comoOperador = (id) => fetchRaw(
  `${panelUrl}/api/whatsapp/messages/${id}/media`,
  { headers: authHeaders(token) }
);

/** The signed route, the one the Evolution server uses. */
const comoEvolution = (id, t) => fetchRaw(
  `${panelUrl}/api/whatsapp-media/${id}${t === undefined ? '' : `?t=${encodeURIComponent(t)}`}`
);

/** An account and a conversation for one provider, and that conversation's id. */
async function conversaDe(tenant, slug) {
  const account = await runInTenant(tenant, () => WhatsAppAccount.create({
    name: `painel-${slug}`,
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(`token-${slug}`),
    ...WhatsAppConfigService.encryptWebhookToken(`webhook-${slug}`)
  }));
  const conversation = await runInTenant(tenant, () => WaConversation.ensure({
    accountId: account.id,
    externalThreadId: `5593981110${tenant}@s.whatsapp.net`,
    waPhone: `5593981110${tenant}`,
    waLid: null,
    pushName: 'Cliente'
  }));
  return conversation.id;
}

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
  assert.notEqual(alfa, beta);

  for (const tenant of [alfa, beta]) {
    await runInTenant(tenant, () => WhatsAppConfigService.saveConfig({
      enabled: true,
      webhookBaseUrl: WEBHOOK_BASE
    }));
  }

  conversaAlfa = await conversaDe(alfa, 'alfa');
  conversaBeta = await conversaDe(beta, 'beta');
});

// Every test starts on an empty tree, with both providers active and retention
// off, so a window one test set cannot decide what the next one sweeps.
beforeEach(async () => {
  await comRetencao(alfa, 0);
  await comRetencao(beta, 0);
  await getDb()('tenants').where({ slug: 'beta' }).update({ status: 'active' });
  fs.rmSync(MEDIA_ROOT, { recursive: true, force: true });
  await getDb()('wa_messages').del();
});

after(async () => {
  WaMediaSweeper.stop();
  await stopTestServers();
});

describe('where a new file is written', () => {
  it('puts each provider\'s upload in its own subtree', async () => {
    const meu = await runInTenant(alfa, () => WaAttachmentService.store({
      buffer: PNG, contentType: 'image/png', fileName: 'poste.png'
    }));
    const dele = await runInTenant(beta, () => WaAttachmentService.store({
      buffer: PNG, contentType: 'image/png', fileName: 'poste.png'
    }));

    assert.match(meu.path, new RegExp(`^wa-media/t${alfa}/out/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.png$`));
    assert.match(dele.path, new RegExp(`^wa-media/t${beta}/out/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.png$`));

    // The bytes are where the row says they are. A path that is only right in
    // the string is worse than no subtree at all.
    assert.equal(existe(meu.path), true);
    assert.equal(existe(dele.path), true);

    // Neither subtree contains the other, which is what makes a per-provider
    // walk a partition rather than an overlap.
    assert.equal(meu.path.startsWith(`wa-media/t${beta}/`), false);
    assert.equal(dele.path.startsWith(`wa-media/t${alfa}/`), false);
  });

  it('takes the subtree from the session the upload arrived on', async () => {
    // Through the real route this time, raw body and all: the provider has to
    // come from the request's own scope, not from whoever calls the service.
    const response = await fetch(`${panelUrl}/api/whatsapp/attachments`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'image/png', 'X-File-Name': 'foto.png' },
      body: PNG
    });
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.match(payload.data.path, new RegExp(`^wa-media/t${alfa}/out/`));
    assert.equal(existe(payload.data.path), true);
  });
});

describe('who may read a stored file', () => {
  it('refuses another provider\'s file on the operator route, with the bytes right there', async () => {
    const relativo = gravar(`wa-media/t${beta}/${conversaBeta}/deles.png`);
    const alheia = await mensagem({
      tenant: beta, conversationId: conversaBeta, attachment_path: relativo
    });

    // The file exists and the process can read it, so the 404 below is the
    // provider filter answering — not a missing file answering for it.
    assert.equal(existe(relativo), true);

    const res = await comoOperador(alheia.id);
    assert.equal(res.status, 404);
    assert.equal(res.json().code, 'attachment_not_found');

    // And this is WHY, which is the part worth pinning: the row carries the
    // scope. `WaMessage.getById` goes through `tdb`, so Beta's message does not
    // exist to Alfa's session, and the path never gets a say. There is no
    // second check against the subtree and there must not be — a pre-wave-8 row
    // would fail it. See the note at the top of `waMediaFile.js`.
    assert.ok(await runInTenant(beta, () => WaMessage.getById(alheia.id)));
    assert.equal(await runInTenant(alfa, () => WaMessage.getById(alheia.id)), null);
  });

  it('refuses another provider\'s file on the signed route without the panel\'s signature', async () => {
    const alheia = await mensagem({
      tenant: beta,
      conversationId: conversaBeta,
      attachment_path: gravar(`wa-media/t${beta}/${conversaBeta}/assinada.png`)
    });
    const minha = await mensagem({
      tenant: alfa,
      conversationId: conversaAlfa,
      attachment_path: gravar(`wa-media/t${alfa}/${conversaAlfa}/minha.png`)
    });

    // No token at all, then a token the panel minted for a DIFFERENT message.
    // The signature covers the id, so holding a link to one's own attachment is
    // not a step towards the neighbour's — and the signature is the only
    // credential this route takes, minted by the outbox worker and by nobody
    // else.
    assert.equal((await comoEvolution(alheia.id)).status, 404);
    assert.equal((await comoEvolution(alheia.id, sign(minha.id))).status, 404);
    assert.equal((await comoEvolution(minha.id, sign(minha.id))).status, 200);
  });

  it('still serves a row written before the subtree existed', async () => {
    // No `t<id>/` anywhere in it. This is the shape every row on an install
    // that upgrades still has, and those bytes were deliberately never moved.
    const legado = gravar(`wa-media/${conversaAlfa}/antiga.png`);
    assert.equal(legado.includes(`/t${alfa}/`), false);

    const message = await mensagem({
      tenant: alfa, conversationId: conversaAlfa, attachment_path: legado
    });

    const operador = await comoOperador(message.id);
    assert.equal(operador.status, 200);
    assert.deepEqual(operador.buffer, PNG);

    const evolution = await comoEvolution(message.id, sign(message.id));
    assert.equal(evolution.status, 200);
    assert.deepEqual(evolution.buffer, PNG);
  });
});

describe('the sweep, once there is more than one provider', () => {
  /**
   * The claim the whole wave rests on. Before it, Alfa's pass walked the entire
   * tree, found Beta's files with no row of Alfa's pointing at them, called
   * them orphans and would have deleted every one — which is why the pass
   * refused to run at all.
   *
   * The two windows differ on purpose. Beta's is off, so the only window that
   * deletes anything is Alfa's; a pass that could see outside its own subtree
   * would apply it to Beta's file and fail on the file rather than the count.
   */
  it('deletes inside its own subtree and nowhere else', async () => {
    await comRetencao(alfa, 1);
    await comRetencao(beta, 0);

    const meu = gravar(`wa-media/t${alfa}/${conversaAlfa}/velha.png`, 90);
    const dele = gravar(`wa-media/t${beta}/${conversaBeta}/velha.png`, 90);
    const legado = gravar(`wa-media/${conversaAlfa}/legada.png`, 90);
    await mensagem({
      tenant: alfa, conversationId: conversaAlfa, attachment_path: meu, ageDays: 90
    });
    await mensagem({
      tenant: beta, conversationId: conversaBeta, attachment_path: dele, ageDays: 90
    });

    const result = await WaMediaSweeper.tick();

    assert.equal(result.files, 1);
    assert.equal(existe(meu), false, 'Alfa\'s own file goes by Alfa\'s own window');
    assert.equal(existe(dele), true, 'Beta\'s file is not Alfa\'s to judge, old or not');
    assert.equal(existe(legado), true, 'and an orphan of unknown origin is nobody\'s to delete');
  });

  /**
   * The legacy area is the one place where a path says nothing about who wrote
   * it. With two providers on the disk a file there could belong to either, so
   * it is left alone — including one with no row at all, which is exactly the
   * file a single-provider pass would have taken.
   */
  it('never touches the legacy area, orphan or not', async () => {
    await comRetencao(alfa, 1);
    await comRetencao(beta, 1);

    const orfao = gravar('wa-media/out/2020/01/abandonado.png', 400);
    const comLinha = gravar(`wa-media/${conversaAlfa}/com-linha.png`, 400);
    await mensagem({
      tenant: alfa, conversationId: conversaAlfa, attachment_path: comLinha, ageDays: 400
    });

    const result = await WaMediaSweeper.tick();

    assert.equal(result.files, 0);
    assert.equal(existe(orfao), true);
    assert.equal(existe(comLinha), true);
  });

  /**
   * A onda 7 escreveu este ponto cego num comentário: um provedor cuja linha em
   * `tenants` não é `active` era invisível à leitura escopada, e seus arquivos
   * pareciam órfãos para quem varresse. A subárvore por provedor fechou isso: o
   * arquivo do suspenso mora onde a passada de NINGUÉM MAIS enxerga.
   *
   * Essa metade continua valendo, e é o que este caso cobra. O que mudou é a
   * outra: o suspenso agora recebe passada própria, então o que decide se o
   * arquivo dele fica é a RETENÇÃO DELE — aqui desligada, como em todo caso
   * deste arquivo — e não o status. O caso seguinte é o outro lado.
   */
  it('não lê o arquivo do suspenso como órfão do vizinho', async () => {
    await comRetencao(alfa, 1);
    const dele = gravar(`wa-media/t${beta}/${conversaBeta}/suspensa.png`, 400);
    await getDb()('tenants').where({ slug: 'beta' }).update({ status: 'suspended' });

    const result = await WaMediaSweeper.tick();

    assert.equal(result.files, 0);
    assert.equal(existe(dele), true, 'a retenção do vizinho alcançou o arquivo do suspenso');
  });

  /**
   * O outro lado, e a decisão que mudou.
   *
   * Antes, o suspenso não recebia passada — e como não existe prazo de
   * suspensão nem exclusão automática, "não recebe passada" queria dizer
   * guardado para sempre, foto e documento de assinante incluídos. A retenção
   * que o provedor configurou passa a valer estando ele suspenso ou não.
   */
  it('e aplica a retenção DO suspenso aos arquivos dele', async () => {
    await comRetencao(beta, 1);
    const dele = gravar(`wa-media/t${beta}/${conversaBeta}/velha.png`, 400);
    const meu = gravar(`wa-media/t${alfa}/${conversaAlfa}/minha.png`, 400);
    await getDb()('tenants').where({ slug: 'beta' }).update({ status: 'suspended' });

    const result = await WaMediaSweeper.tick();

    assert.equal(existe(dele), false, 'o suspenso continuou guardando para sempre');
    assert.equal(result.files, 1);
    // O controle: a retenção do alfa está desligada, e a passada do suspenso
    // não é desculpa para alcançar o arquivo dele.
    assert.equal(existe(meu), true, 'a passada encostou no arquivo do vizinho');
  });
});

describe('the manual sweep button, with more than one provider', () => {
  /**
   * The button is not the timer. `tick` walks every provider because it belongs
   * to the deployment; this request belongs to one ISP, and routing it through
   * `tick` would have had an admin at Alfa reclaim Beta's disk and read Beta's
   * megabytes as the answer — correct-looking for exactly as long as there was
   * one provider on the install.
   *
   * Beta's window is the aggressive one here, so a run that reached outside
   * Alfa's scope would delete Beta's file. Asserting on the file and not only
   * on the count is the point: a leak that deleted Beta's file and forgot to
   * count it would pass a count-only test.
   */
  it('sweeps only the provider making the request', async () => {
    await comRetencao(alfa, 0);
    await comRetencao(beta, 1);

    const dele = gravar(`wa-media/t${beta}/${conversaBeta}/velha.png`, 90);
    await mensagem({
      tenant: beta, conversationId: conversaBeta, attachment_path: dele, ageDays: 90
    });

    const result = await runInTenant(alfa, () => WaMediaSweeper.sweepCurrentTenant());

    // Alfa keeps its attachments forever, so the honest answer to Alfa's admin
    // is "retention is off" — not a count of what Beta's window would have got.
    assert.equal(result.skipped, 'disabled');
    assert.equal(result.files, 0);
    assert.equal(existe(dele), true, 'Beta\'s disk is not Alfa\'s button to press');
  });

  /**
   * The other half of the same claim: Alfa's own window does apply, and the
   * legacy area stays out of it while the install is ambiguous.
   */
  it('applies the requesting provider\'s own window, and still spares the legacy area', async () => {
    await comRetencao(alfa, 1);
    await comRetencao(beta, 1);

    const meu = gravar(`wa-media/t${alfa}/${conversaAlfa}/velha.png`, 90);
    const legado = gravar(`wa-media/${conversaAlfa}/legada.png`, 90);
    await mensagem({
      tenant: alfa, conversationId: conversaAlfa, attachment_path: meu, ageDays: 90
    });

    const result = await runInTenant(alfa, () => WaMediaSweeper.sweepCurrentTenant());

    assert.equal(result.files, 1);
    assert.equal(existe(meu), false);
    assert.equal(existe(legado), true);
  });
});

/**
 * Suspending the neighbour does NOT turn this into a single-provider install,
 * and the sweep used to think it did.
 *
 * `includeLegacy` was decided from the count of ACTIVE providers, so the moment
 * Beta was suspended — for non-payment, or an operator toggling a row — Alfa
 * became "sole" and its next pass applied ALFA's retention to BETA's legacy
 * files. Those files carry no row Alfa can see, so they were judged orphans and
 * deleted by age alone, at the moment Beta was least able to notice. The row
 * left behind still pointed at bytes that no longer existed, which is the one
 * state this module says it exists to prevent.
 *
 * The genuinely-single-provider case is not tested here and cannot be: this
 * file always holds two provider rows. `whatsapp-media-sweep.test.js` is the
 * single-provider file and covers it, including the case where a second row
 * appears and the legacy area stops being anyone's to sweep.
 */
describe('the sweep when the neighbour is suspended rather than absent', () => {
  beforeEach(async () => {
    await getDb()('tenants').where({ slug: 'beta' }).update({ status: 'suspended' });
  });

  it('leaves the legacy area alone, because a suspended provider still owns its files', async () => {
    await comRetencao(alfa, 30);

    const legadoComLinha = gravar(`wa-media/${conversaAlfa}/antiga.png`, 45);
    const legadoOrfao = gravar('wa-media/out/2021/03/abandonada.png', 45);
    const novo = gravar(`wa-media/t${alfa}/${conversaAlfa}/nova.png`, 45);
    const recente = gravar(`wa-media/${conversaAlfa}/de-ontem.png`, 1);
    const message = await mensagem({
      tenant: alfa, conversationId: conversaAlfa, attachment_path: legadoComLinha, ageDays: 45
    });

    const result = await WaMediaSweeper.tick();

    // Só o que está no subtree do próprio Alfa, e nada do que a idade sozinha
    // condenaria na área legada.
    assert.equal(result.files, 1);
    assert.equal(existe(novo), false, 'my own subtree is still mine to sweep');
    assert.equal(existe(legadoComLinha), true, 'age alone must not decide in a shared area');
    assert.equal(existe(legadoOrfao), true);
    assert.equal(existe(recente), true, 'the window still decides, not the area');

    const row = await runInTenant(alfa, () => WaMessage.getById(message.id));
    assert.ok(row, 'the message row survives — that part never changes');
    assert.equal(
      row.attachment_path,
      legadoComLinha,
      'a row whose file was kept must keep pointing at it'
    );
  });

  it('still refuses to delete what a queued message has to send, in either area', async () => {
    await comRetencao(alfa, 1);
    const legado = gravar(`wa-media/${conversaAlfa}/na-fila-legada.png`, 400);
    const novo = gravar(`wa-media/t${alfa}/${conversaAlfa}/na-fila-nova.png`, 400);
    for (const attachment_path of [legado, novo]) {
      await mensagem({
        tenant: alfa,
        conversationId: conversaAlfa,
        attachment_path,
        delivery_status: 'queued',
        ageDays: 400
      });
    }

    const result = await WaMediaSweeper.tick();

    assert.equal(result.files, 0);
    assert.equal(existe(legado), true);
    assert.equal(existe(novo), true);
  });
});
