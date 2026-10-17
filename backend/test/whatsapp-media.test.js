import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  asTenant,
  authHeaders,
  call,
  getDb,
  runInTenant,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaSendService } = await import('../src/services/waSendService.js');
const { outDir } = await import('../src/services/waAttachmentService.js');
const { default: WaOutboxWorker } = await import('../src/services/waOutboxWorker.js');
const { sign, MEDIA_TOKEN_TTL_MS } = await import('../src/utils/wa/waMediaToken.js');

/**
 * Attachments, end to end, for both audiences.
 *
 * The files here are written into the REAL `DATA_DIR` the harness made, and
 * read back through the real routes off a real disk. Mocking `fs` would be
 * mocking the exact thing under test: every refusal below is about which file
 * on which disk a stored string resolves to, and a stubbed filesystem answers
 * that question by agreeing with whatever the code decided.
 */
const DATA_DIR = process.env.DATA_DIR;

const EVO_BASE = 'https://evo.provedor.test';
const INSTANCE = 'painel-anexos';
const WEBHOOK_BASE = 'https://painel.provedor.test/api/whatsapp-webhook';

/** A one-pixel PNG, so the bytes on the wire are comparable to the bytes on disk. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');

let panelUrl;
let token;
let accountId;
let conversationId;
let alfa;
let beta;
let evoServer;
let evoLocalUrl;
let desfazerRota;

/** Every request the Evolution stub saw. */
const requests = [];
/**
 * Monotonic across the whole file, not derived from `requests.length` — that
 * array is emptied between tests, and a repeated id trips the unique index on
 * `(tenant_id, external_id)` and turns a successful send into a failed one.
 */
let evoSeq = 0;
const mediaCalls = () => requests.filter((r) => r.path.startsWith('/message/sendMedia/'));
const textCalls = () => requests.filter((r) => r.path.startsWith('/message/sendText/'));

function startEvolutionStub() {
  evoServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      requests.push({ path: req.url.split('?')[0], payload });
      evoSeq += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key: { id: `EVO-${evoSeq}` }, status: 'PENDING' }));
    });
  });
  return new Promise((resolve) => {
    evoServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${evoServer.address().port}`));
  });
}

/** Writes a file where `attachment_path` says it is, and answers with that path. */
function gravar(relative, bytes) {
  const destino = path.join(DATA_DIR, relative);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, bytes);
  return relative;
}

/**
 * Um anexo de SAÍDA, na pasta que a rota de upload realmente emite.
 *
 * O envio só aceita caminho dentro de `wa-media/t<id>/out`, e não por capricho:
 * o valor chega do navegador, e sem confinar isso `DATA_DIR` inteiro — incluindo
 * `db-config.json` e `panel.sqlite` — virava anexo enviável.
 */
async function gravarSaida(nome, bytes) {
  return gravar(path.posix.join(await asTenant(() => outDir()), nome), bytes);
}

/** An inbound row carrying an attachment, exactly as `waMediaService` writes one. */
async function mensagemCom({ attachment_path, attachment_type, attachment_name, tenant = null }) {
  const scope = tenant ? (fn) => runInTenant(tenant, fn) : asTenant;
  return scope(() => WaMessage.create({
    conversation_id: conversationId,
    direction: 'in',
    body: null,
    attachment_path,
    attachment_type,
    attachment_name,
    is_note: false,
    delivery_status: null,
    source: 'operator',
    created_at: new Date(),
    updated_at: new Date()
  }));
}

/** `call` parses JSON; a file has to be read as bytes. */
async function fetchRaw(url, options = {}) {
  const response = await fetch(url, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    buffer,
    type: response.headers.get('content-type'),
    disposition: response.headers.get('content-disposition'),
    json: () => { try { return JSON.parse(buffer.toString('utf8')); } catch { return null; } }
  };
}

const comoOperador = (id) => fetchRaw(
  `${panelUrl}/api/whatsapp/messages/${id}/media`,
  { headers: authHeaders(token) }
);

const comoEvolution = (id, t) => fetchRaw(
  `${panelUrl}/api/whatsapp-media/${id}?t=${encodeURIComponent(t)}`
);

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

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: WEBHOOK_BASE,
    rateLimitPerMin: 60
  }));

  const account = await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-anexos'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-anexos')
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

after(async () => {
  desfazerRota?.();
  WaOutboxWorker.stop();
  await new Promise((resolve) => evoServer.close(resolve));
  await stopTestServers();
});

describe('the operator fetches an attachment with their session', () => {
  it('serves an image inline, byte for byte', async () => {
    const message = await mensagemCom({
      attachment_path: gravar(`wa-media/${conversationId}/foto.png`, PNG),
      attachment_type: 'image/png',
      attachment_name: 'foto.png'
    });

    const res = await comoOperador(message.id);
    assert.equal(res.status, 200);
    assert.equal(res.type, 'image/png');
    assert.match(res.disposition, /^inline;/);
    assert.deepEqual(res.buffer, PNG, 'the bytes on the wire are the bytes on disk');
  });

  it('sends anything that is not an image as a download', async () => {
    const message = await mensagemCom({
      attachment_path: gravar(`wa-media/${conversationId}/fatura.pdf`, PDF),
      attachment_type: 'application/pdf',
      attachment_name: 'fatura.pdf'
    });

    const res = await comoOperador(message.id);
    assert.equal(res.status, 200);
    assert.match(res.disposition, /^attachment;/);
    assert.match(res.disposition, /filename="fatura\.pdf"/);
    assert.deepEqual(res.buffer, PDF);
  });

  /**
   * The one that matters most on this route. An SVG is a document with script
   * in it and this route answers on the panel's own origin, where the
   * operator's session lives — inline would make a file the CUSTOMER chose into
   * script running as the panel.
   */
  it('never serves an SVG inline', async () => {
    const message = await mensagemCom({
      attachment_path: gravar(`wa-media/${conversationId}/logo.svg`, SVG),
      attachment_type: 'image/svg+xml',
      attachment_name: 'logo.svg'
    });

    const res = await comoOperador(message.id);
    assert.equal(res.status, 200);
    assert.match(res.disposition, /^attachment;/);
    assert.doesNotMatch(res.disposition, /inline/);
    assert.equal(res.type, 'image/svg+xml');
  });

  /**
   * `attachment_path` was written from a file name that arrived from a
   * stranger's phone. The column is the untrusted input here, not the request.
   */
  it('refuses a stored path that escapes DATA_DIR', async () => {
    const fora = path.join(DATA_DIR, '..', 'segredo-fora-do-data-dir.txt');
    fs.writeFileSync(fora, 'nao devia sair daqui');
    try {
      const message = await mensagemCom({
        attachment_path: 'wa-media/../../segredo-fora-do-data-dir.txt',
        attachment_type: 'text/plain',
        attachment_name: 'segredo.txt'
      });

      const res = await comoOperador(message.id);
      assert.equal(res.status, 404);
      assert.equal(res.json().code, 'attachment_not_found');
      assert.doesNotMatch(res.buffer.toString('utf8'), /nao devia sair daqui/);
    } finally {
      fs.rmSync(fora, { force: true });
    }
  });

  /**
   * The `..` above is caught by comparing strings. A symlink is the case where
   * the string and the file disagree: the path stays inside `DATA_DIR` and the
   * bytes come from wherever it points.
   */
  it('refuses a path that stays inside DATA_DIR but points out of it', async () => {
    const fora = path.join(DATA_DIR, '..', 'alvo-do-link.txt');
    fs.writeFileSync(fora, 'conteudo fora do data dir');
    const link = path.join(DATA_DIR, 'wa-media', 'atalho.txt');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(fora, link);
    try {
      const message = await mensagemCom({
        attachment_path: 'wa-media/atalho.txt',
        attachment_type: 'text/plain',
        attachment_name: 'atalho.txt'
      });
      const res = await comoOperador(message.id);
      assert.equal(res.status, 404);
      assert.doesNotMatch(res.buffer.toString('utf8'), /conteudo fora do data dir/);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(fora, { force: true });
    }
  });

  it('refuses an absolute stored path just as flatly', async () => {
    const message = await mensagemCom({
      attachment_path: '/etc/hostname',
      attachment_type: 'text/plain',
      attachment_name: 'hostname'
    });
    const res = await comoOperador(message.id);
    assert.equal(res.status, 404);
    assert.equal(res.json().code, 'attachment_not_found');
  });

  it('answers the same 404 for a file that is gone, a row with no attachment, and an unknown id', async () => {
    const sumido = await mensagemCom({
      attachment_path: `wa-media/${conversationId}/nunca-existiu.jpg`,
      attachment_type: 'image/jpeg',
      attachment_name: 'nunca-existiu.jpg'
    });
    const semAnexo = await mensagemCom({
      attachment_path: null,
      attachment_type: null,
      attachment_name: null
    });

    for (const id of [sumido.id, semAnexo.id, 999999]) {
      const res = await comoOperador(id);
      assert.equal(res.status, 404, `id ${id}`);
      assert.equal(res.json().code, 'attachment_not_found');
    }
  });

  it('does not serve another provider a message it can see the id of', async () => {
    const relativo = gravar('wa-media/beta/outro-provedor.png', PNG);
    const alheia = await mensagemCom({
      attachment_path: relativo,
      attachment_type: 'image/png',
      attachment_name: 'outro-provedor.png',
      tenant: beta
    });
    assert.notEqual(alfa, beta);

    // 404 rather than 403: a 403 would confirm the row exists, which is the
    // leak itself.
    const res = await comoOperador(alheia.id);
    assert.equal(res.status, 404);
    assert.equal(res.json().code, 'attachment_not_found');
  });

  it('refuses a request with no session at all', async () => {
    const message = await mensagemCom({
      attachment_path: gravar(`wa-media/${conversationId}/privada.png`, PNG),
      attachment_type: 'image/png',
      attachment_name: 'privada.png'
    });
    const { status } = await call(`${panelUrl}/api/whatsapp/messages/${message.id}/media`);
    assert.equal(status, 401);
  });
});

describe('the Evolution server fetches with a signed link', () => {
  let message;

  before(async () => {
    message = await mensagemCom({
      attachment_path: gravar(`wa-media/${conversationId}/assinada.png`, PNG),
      attachment_type: 'image/png',
      attachment_name: 'assinada.png'
    });
  });

  it('serves the bytes for a valid token, with no session anywhere', async () => {
    const res = await comoEvolution(message.id, sign(message.id));
    assert.equal(res.status, 200);
    assert.deepEqual(res.buffer, PNG);
  });

  it('refuses a token that has expired', async () => {
    const velho = sign(message.id, Date.now() - MEDIA_TOKEN_TTL_MS - 5_000);
    const res = await comoEvolution(message.id, velho);
    assert.equal(res.status, 404);
    assert.equal(res.json().code, 'attachment_not_found');
  });

  it('refuses a token minted for another message', async () => {
    const outra = await mensagemCom({
      attachment_path: gravar(`wa-media/${conversationId}/outra.png`, PNG),
      attachment_type: 'image/png',
      attachment_name: 'outra.png'
    });

    // The signature covers the id, so a link that worked for one message is not
    // a link that works for the next one along.
    const res = await comoEvolution(message.id, sign(outra.id));
    assert.equal(res.status, 404);

    const proprio = await comoEvolution(outra.id, sign(outra.id));
    assert.equal(proprio.status, 200, 'the same token on its own id still works');
  });

  it('refuses a missing token, a shape that is not one, and a tampered signature', async () => {
    const bom = sign(message.id);
    const adulterado = `${bom.slice(0, -1)}${bom.endsWith('a') ? 'b' : 'a'}`;

    for (const t of ['', 'sem-ponto', `${Number.MAX_SAFE_INTEGER}.curto`, adulterado]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await comoEvolution(message.id, t);
      assert.equal(res.status, 404, `token ${JSON.stringify(t)}`);
    }
  });

  it('confines the stored path even for a caller holding a valid token', async () => {
    const escapada = await mensagemCom({
      attachment_path: 'wa-media/../../../etc/hostname',
      attachment_type: 'text/plain',
      attachment_name: 'hostname'
    });
    const res = await comoEvolution(escapada.id, sign(escapada.id));
    assert.equal(res.status, 404);
  });
});

describe('the outbox hands Evolution an address it can actually fetch', () => {
  async function enfileirar(attachment) {
    return call(`${panelUrl}/api/whatsapp/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { body: 'segue em anexo', attachment }
    });
  }

  it('sends an absolute signed URL, not the path on the panel disk', async () => {
    const relativo = await gravarSaida('saida.pdf', PDF);
    requests.length = 0;
    const { body } = await enfileirar({ url: relativo, type: 'application/pdf', name: 'saida.pdf' });

    await WaOutboxWorker.tick();

    assert.equal(mediaCalls().length, 1);
    const enviada = mediaCalls()[0].payload.media;
    assert.notEqual(enviada, relativo, 'a disk path is what this whole route exists to stop sending');
    assert.match(enviada, /^https:\/\/painel\.provedor\.test\/api\/whatsapp-media\//);
    assert.match(enviada, new RegExp(`/api/whatsapp-media/${body.data.id}\\?t=`));

    // And the proof that it is not merely well-shaped: fetch it, as the
    // Evolution server would, and get the file.
    const url = new URL(enviada);
    const res = await fetchRaw(`${panelUrl}${url.pathname}${url.search}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.buffer, PDF);
  });

  it('leaves a message with no attachment completely alone', async () => {
    requests.length = 0;
    const enviada = await call(`${panelUrl}/api/whatsapp/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { body: 'só texto' }
    });

    await WaOutboxWorker.tick();

    assert.equal(textCalls().length, 1);
    assert.equal(mediaCalls().length, 0);
    assert.equal(textCalls()[0].payload.text, 'só texto');
    // Nothing in the text path may notice the media work: no signing, no
    // refusal, and a row that went out clean.
    const row = await asTenant(() => WaMessage.getById(enviada.body.data.id));
    assert.equal(row.delivery_status, 'sent');
    assert.equal(row.delivery_error, null);
  });

  /**
   * `webhookBaseUrl` is the only address the panel knows the Evolution server
   * reaches it on. Without it there is no URL to sign, and sending anyway would
   * deliver a link that opens nothing — which the customer discovers, not us.
   */
  it('refuses the send outright when no public URL is configured', async () => {
    const relativo = await gravarSaida('sem-origem.pdf', PDF);
    const { body } = await enfileirar({ url: relativo, type: 'application/pdf', name: 'sem-origem.pdf' });
    const row = await asTenant(() => WaMessage.getById(body.data.id));

    await asTenant(() => WhatsAppConfigService.saveConfig({ enabled: false, webhookBaseUrl: '' }));
    requests.length = 0;
    try {
      // Straight at `dispatch`: the worker's own readiness check would skip the
      // pass before it ever got here, and the refusal being tested is the one
      // that guards the despatch itself.
      await assert.rejects(
        () => asTenant(() => WaSendService.dispatch(row)),
        (error) => {
          assert.equal(error.code, 'no_public_url');
          assert.equal(error.translationKey, 'whatsapp.error.noPublicUrl');
          return true;
        }
      );
      assert.equal(requests.length, 0, 'nothing may reach Evolution');
    } finally {
      await asTenant(() => WhatsAppConfigService.saveConfig({ enabled: true, webhookBaseUrl: WEBHOOK_BASE }));
    }
  });

  it('records that refusal where the operator can read it', async () => {
    const relativo = await gravarSaida('sem-origem-2.pdf', PDF);
    const { body } = await enfileirar({ url: relativo, type: 'application/pdf', name: 'x.pdf' });
    const row = await asTenant(() => WaMessage.getById(body.data.id));

    await asTenant(() => WhatsAppConfigService.saveConfig({ enabled: false, webhookBaseUrl: '' }));
    try {
      const erro = await asTenant(() => WaSendService.dispatch(row)).then(() => null, (e) => e);
      assert.ok(erro, 'the despatch must not have succeeded');
      await asTenant(() => WaOutboxWorker.recordFailure(row, erro));
      const depois = await asTenant(() => WaMessage.getById(body.data.id));
      assert.match(depois.delivery_error, /whatsapp\.error\.noPublicUrl/);
      assert.match(depois.delivery_error, /no_public_url/);
    } finally {
      await asTenant(() => WhatsAppConfigService.saveConfig({ enabled: true, webhookBaseUrl: WEBHOOK_BASE }));
      await getDb()('wa_messages').where({ id: body.data.id }).del();
    }
  });
});
