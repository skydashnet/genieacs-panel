import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { asTenant, authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';
import { rotearBase } from './helpers/evolutionRoute.js';
import { HEIC, HTML, PNG, SAMPLES } from './helpers/attachmentSamples.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaOutboxWorker } = await import('../src/services/waOutboxWorker.js');
const { DATA_DIR } = await import('../src/config/paths.js');
const { ATTACHMENT_TYPES, ATTACHMENT_TYPE_ALIASES } = await import('../src/config/waAttachmentTypes.js');
const { ALLOWED_TYPES, normalizeType, displayName } = await import('../src/services/waAttachmentService.js');
const { mediaKind } = await import('../src/services/waSendService.js');
const { sendMediaRequest } = await import('../src/utils/wa/evolutionApi.js');
const { matchesDeclaredType, TEXT_SNIFF_BYTES } = await import('../src/utils/wa/sniffAttachment.js');

/**
 * A lista ampliada de anexos: Word, Excel, ZIP, texto, GIF e a foto HEIC do
 * iPhone. Cada tipo novo é uma porta nova, então cada um é testado nos dois
 * sentidos — entra com os bytes certos e NÃO entra com os errados.
 */

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EVO_BASE = 'https://evo.tipos.test';

let panelUrl;
let token;
let conversationId;
let evoServer;
let evoLocalUrl;
let desfazerRota;
const requests = [];

async function upload(bytes, { type, name } = {}) {
  const headers = {};
  if (type) headers['Content-Type'] = type;
  if (name) headers['X-File-Name'] = encodeURIComponent(name);
  const response = await fetch(`${panelUrl}/api/whatsapp/attachments`, {
    method: 'POST',
    headers: { ...headers, ...authHeaders(token) },
    body: bytes
  });
  return { status: response.status, body: await response.json() };
}

/** Um Evolution v2 de mentira que só grava o que recebeu e aceita tudo. */
function startEvolutionStub() {
  let seq = 0;
  evoServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      requests.push({ path: req.url.split('?')[0], payload });
      seq += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key: { id: `EVO-T${seq}` }, status: 'PENDING' }));
    });
  });
  return new Promise((resolve) => {
    evoServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${evoServer.address().port}`));
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  evoLocalUrl = await startEvolutionStub();
  // O mesmo desvio de `whatsapp-outbox.test.js`: a guarda de SSRF barra
  // loopback pelo literal, então a conta aponta para um nome público e o
  // `fetch` é reescrito para o stub.
  // O cliente Evolution conecta por `PinnedTransport`, não por `fetch`: a rota
  // para o dublê troca os encaixes dele, e a guarda de endereço roda inteira.
  desfazerRota = rotearBase(EVO_BASE, evoLocalUrl);

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook',
    rateLimitPerMin: 60
  }));
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-tipos',
    purpose: 'support',
    flavor: 'v2',
    base_url: EVO_BASE,
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-tipos'),
    ...WhatsAppConfigService.encryptWebhookToken('webhook-tipos')
  }));
  const conversation = await asTenant(() => WaConversation.ensure({
    accountId: account.id,
    externalThreadId: '5548999990001@s.whatsapp.net',
    waPhone: '5548999990001',
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

describe('sniffAttachment — os primeiros bytes contra o tipo declarado', () => {
  it('has a passing sample for every type in the single list', () => {
    // Se alguém acrescentar um tipo à lista sem regra nem amostra, é aqui que
    // quebra — e não no primeiro upload de um operador.
    for (const { type } of ATTACHMENT_TYPES) {
      assert.ok(SAMPLES[type], `sem amostra para ${type}`);
      assert.equal(matchesDeclaredType(SAMPLES[type], type), true, type);
    }
  });

  it('refuses HTML bytes under every binary type', () => {
    for (const { type } of ATTACHMENT_TYPES) {
      if (type.startsWith('text/')) continue;
      assert.equal(matchesDeclaredType(HTML, type), false, type);
    }
  });

  it('does not let one binary format pass as another', () => {
    assert.equal(matchesDeclaredType(SAMPLES['image/png'], 'image/jpeg'), false);
    assert.equal(matchesDeclaredType(SAMPLES['application/zip'], 'application/msword'), false);
    assert.equal(matchesDeclaredType(SAMPLES['application/msword'], DOCX), false);
    assert.equal(matchesDeclaredType(SAMPLES['application/pdf'], 'application/zip'), false);
    // Um MP4 comum tem `ftyp` no mesmo lugar, mas a marca não é de HEIC.
    assert.equal(matchesDeclaredType(SAMPLES['video/mp4'], 'image/heic'), false);
    // RIFF sozinho é também WAV e AVI; sem `WEBP` no 8 não é imagem.
    assert.equal(matchesDeclaredType(Buffer.from('RIFF\0\0\0\0WAVEfmt '), 'image/webp'), false);
    assert.equal(matchesDeclaredType(Buffer.from('GIF88a'), 'image/gif'), false);
  });

  it('knows a browser recording by its bytes: WebM by EBML, M4A by ftyp', () => {
    assert.equal(matchesDeclaredType(SAMPLES['audio/webm'], 'audio/webm'), true);
    assert.equal(matchesDeclaredType(SAMPLES['audio/ogg'], 'audio/webm'), false);
    assert.equal(matchesDeclaredType(SAMPLES['audio/mp4'], 'audio/mp4'), true);
    assert.equal(matchesDeclaredType(Buffer.from('OggS\0\0\0\0'), 'audio/mp4'), false);
  });

  it('accepts MP3 by frame sync as well as by ID3 tag', () => {
    assert.equal(matchesDeclaredType(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg'), true);
    assert.equal(matchesDeclaredType(Buffer.from([0xff, 0x1b, 0x90, 0x00]), 'audio/mpeg'), false);
  });

  it('reads text as "no NUL in the first 8 KB", latin-1 included', () => {
    assert.equal(matchesDeclaredType(Buffer.from('﻿nome;valor\n', 'utf8'), 'text/csv'), true);
    assert.equal(matchesDeclaredType(Buffer.from('Conceição', 'latin1'), 'text/plain'), true);
    // Um executável tem NUL já no cabeçalho.
    assert.equal(matchesDeclaredType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), 'text/plain'), false);
    // Um NUL depois dos 8 KB não é lido — a regra olha só o começo.
    const longo = Buffer.concat([Buffer.alloc(TEXT_SNIFF_BYTES, 0x61), Buffer.from([0])]);
    assert.equal(matchesDeclaredType(longo, 'text/plain'), true);
  });

  it('answers false for a type with no rule and for an empty buffer', () => {
    assert.equal(matchesDeclaredType(PNG, 'image/svg+xml'), false);
    assert.equal(matchesDeclaredType(Buffer.alloc(0), 'text/plain'), false);
  });
});

describe('the list, the aliases and the kind', () => {
  it('derives ALLOWED_TYPES from the single list', () => {
    assert.deepEqual(
      ALLOWED_TYPES,
      Object.fromEntries(ATTACHMENT_TYPES.map((row) => [row.type, row.extensions[0]]))
    );
  });

  it('reads an alias as the canonical type', () => {
    for (const [alias, canonical] of Object.entries(ATTACHMENT_TYPE_ALIASES)) {
      assert.equal(normalizeType(`${alias.toUpperCase()}; q=1`), canonical, alias);
    }
  });

  it('takes the send kind from the list, GIF as an image', () => {
    assert.equal(mediaKind('image/gif'), 'image');
    assert.equal(mediaKind(DOCX), 'document');
    assert.equal(mediaKind('application/zip'), 'document');
    assert.equal(mediaKind('text/csv'), 'document');
    assert.equal(mediaKind('image/jpg'), 'image');
    // Fora da lista, a família do prefixo continua valendo.
    assert.equal(mediaKind('video/quicktime'), 'video');
  });

  it('keeps the name\'s extension in line with the type', () => {
    assert.equal(displayName('contrato', DOCX), 'contrato.docx');
    assert.equal(displayName('contrato.docx', DOCX), 'contrato.docx');
    assert.equal(displayName('planilha.XLSX', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'planilha.XLSX');
    assert.equal(displayName('fatura.exe', 'application/pdf'), 'fatura.exe.pdf');
    assert.equal(displayName('', 'application/zip'), 'document.zip');
  });

  it('sends mimetype on v2 only', () => {
    const p = { number: '1', type: 'document', url: 'u', caption: '', fileName: 'a.docx', mimetype: DOCX };
    assert.equal(sendMediaRequest('v2', 'x', p).body.mimetype, DOCX);
    // O GO não tem registro de aceitar o campo: fica como estava.
    assert.equal('mimetype' in sendMediaRequest('go', 'x', p).body, false);
    assert.equal('mimetype' in sendMediaRequest('v2', 'x', { ...p, mimetype: undefined }).body, false);
  });
});

describe('upload of every accepted type', () => {
  it('stores each type with the extension from the list', async () => {
    for (const row of ATTACHMENT_TYPES) {
      if (row.convertTo) continue; // O HEIC tem teste próprio: não sai HEIC.
      const { status, body } = await upload(SAMPLES[row.type], { type: row.type, name: 'arquivo' });
      assert.equal(status, 201, `${row.type}: ${JSON.stringify(body)}`);
      assert.equal(body.data.type, row.type);
      assert.equal(path.extname(body.data.path), row.extensions[0], row.type);
      assert.equal(path.extname(body.data.name), row.extensions[0], row.type);
      assert.deepEqual(fs.readFileSync(path.join(DATA_DIR, body.data.path)), SAMPLES[row.type]);
    }
  });

  it('refuses each type when the bytes are not of it', async () => {
    for (const row of ATTACHMENT_TYPES) {
      // Texto aceita HTML como texto (é servido como download, com nosniff);
      // o que ele recusa é binário.
      const falso = row.type.startsWith('text/') ? Buffer.from([0x4d, 0x5a, 0x00, 0x00]) : HTML;
      const { status, body } = await upload(falso, { type: row.type, name: 'falso' });
      assert.equal(status, 415, row.type);
      assert.equal(body.code, 'attachment_content_mismatch', row.type);
    }
  });

  it('refuses a .docx whose bytes are an HTML page, with a translated reason', async () => {
    const { status, body } = await upload(HTML, { type: DOCX, name: 'contrato.docx' });
    assert.equal(status, 415);
    assert.equal(body.code, 'attachment_content_mismatch');
    assert.equal(typeof body.message, 'string');
    assert.notEqual(body.message, 'whatsapp.error.attachmentContentMismatch');
  });

  it('still refuses HTML, SVG, executables and scripts by type', async () => {
    for (const type of ['text/html', 'image/svg+xml', 'application/x-msdownload', 'application/javascript']) {
      const { status, body } = await upload(HTML, { type, name: 'x' });
      assert.equal(status, 415, type);
      assert.equal(body.code, 'attachment_type_not_allowed', type);
    }
  });

  it('accepts the aliases browsers send, stored under the canonical type', async () => {
    const jpg = await upload(SAMPLES['image/jpeg'], { type: 'image/jpg', name: 'foto.jpg' });
    assert.equal(jpg.status, 201);
    assert.equal(jpg.body.data.type, 'image/jpeg');
    assert.equal(path.extname(jpg.body.data.path), '.jpg');

    const zip = await upload(SAMPLES['application/zip'], { type: 'application/x-zip-compressed', name: 'fotos.zip' });
    assert.equal(zip.status, 201);
    assert.equal(zip.body.data.type, 'application/zip');
    assert.equal(path.extname(zip.body.data.path), '.zip');
  });
});

describe('the iPhone photo', () => {
  it('turns a real HEIC into a JPEG, name and all', async () => {
    const { status, body } = await upload(HEIC, { type: 'image/heic', name: 'IMG_0001.HEIC' });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.type, 'image/jpeg');
    assert.equal(path.extname(body.data.path), '.jpg');
    assert.equal(body.data.name, 'IMG_0001.jpg');
    const gravado = fs.readFileSync(path.join(DATA_DIR, body.data.path));
    assert.equal(matchesDeclaredType(gravado, 'image/jpeg'), true, 'o que está no disco é JPEG');
  });

  it('takes the image/heif alias the same way', async () => {
    const { status, body } = await upload(HEIC, { type: 'image/heif', name: 'foto.heif' });
    assert.equal(status, 201);
    assert.equal(body.data.type, 'image/jpeg');
    assert.equal(body.data.name, 'foto.jpg');
  });

  it('refuses a body declared as HEIC that is not one', async () => {
    const { status, body } = await upload(SAMPLES['image/jpeg'], { type: 'image/heic', name: 'foto.heic' });
    assert.equal(status, 415);
    assert.equal(body.code, 'attachment_content_mismatch');
  });

  it('refuses a HEIC with the right brand and a broken body', async () => {
    // Passa na assinatura e falha no conversor: a mesma recusa, não um 500.
    const truncado = HEIC.subarray(0, 64);
    const { status, body } = await upload(truncado, { type: 'image/heic', name: 'quebrada.heic' });
    assert.equal(status, 415);
    assert.equal(body.code, 'attachment_content_mismatch');
  });
});

describe('sending a Word file', () => {
  it('goes out as a document, named .docx, with its mimetype', async () => {
    const stored = await upload(SAMPLES[DOCX], { type: DOCX, name: 'contrato' });
    assert.equal(stored.status, 201);

    const enviada = await call(`${panelUrl}/api/whatsapp/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: authHeaders(token),
      body: { attachment: { url: stored.body.data.path, type: DOCX, name: stored.body.data.name } }
    });
    assert.equal(enviada.status, 201);
    requests.length = 0;

    await WaOutboxWorker.tick();
    const media = requests.filter((r) => r.path.startsWith('/message/sendMedia/'));
    assert.equal(media.length, 1);
    assert.equal(media[0].payload.mediatype, 'document');
    assert.match(media[0].payload.fileName, /\.docx$/);
    assert.equal(media[0].payload.fileName, 'contrato.docx');
    assert.equal(media[0].payload.mimetype, DOCX);
  });
});
