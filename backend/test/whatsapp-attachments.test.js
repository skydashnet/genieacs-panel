import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { DATA_DIR } = await import('../src/config/paths.js');
const { MAX_ATTACHMENT_BYTES } = await import('../src/services/waAttachmentService.js');

const INSTANCE = 'painel-anexos';

let panelUrl;
let token;
let conversationId;

/** A one-pixel PNG, as real bytes: the route stores what it is given. Os
 * outros tipos vêm com os primeiros bytes certos de `helpers/attachmentSamples`,
 * porque o upload confere a assinatura contra o tipo declarado. */
const { PNG, SAMPLES } = await import('./helpers/attachmentSamples.js');

/**
 * The upload as the browser makes it: the raw file as the body, its name
 * percent-encoded in a header, its type in `Content-Type`. `call` from the
 * harness JSON-stringifies its body, which is exactly what this route must not
 * receive, so this one talks to `fetch` directly.
 */
async function upload(bytes, { type, name } = {}) {
  const headers = {};
  if (type) headers['Content-Type'] = type;
  if (name) headers['X-File-Name'] = encodeURIComponent(name);
  const response = await fetch(`${panelUrl}/api/whatsapp/attachments`, {
    method: 'POST',
    headers: { ...headers, ...authHeaders(token) },
    body: bytes
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const enviar = (payload) => call(
  `${panelUrl}/api/whatsapp/conversations/${conversationId}/messages`,
  { method: 'POST', headers: authHeaders(token), body: payload }
);

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
    ...WhatsAppConfigService.encryptInstanceToken('token-da-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('segredo-do-webhook')
  }));

  const conversation = await asTenant(() => WaConversation.ensure({
    accountId: account.id,
    externalThreadId: '5548999990000@s.whatsapp.net',
    waPhone: '5548999990000',
    waLid: null,
    pushName: 'Cliente'
  }));
  conversationId = conversation.id;
});

after(async () => {
  await stopTestServers();
});

describe('WhatsApp attachments — what the operator uploads', () => {
  /**
   * O parser cru fica reservado no caminho bem cedo, acima do `apiLimiter` e do
   * `authenticateToken`, porque o parser global de JSON reclamaria o corpo
   * antes. O efeito era que qualquer um, sem sessão nenhuma, fazia o painel
   * segurar até 16 MB na memória e só DEPOIS ouvia que precisava se autenticar.
   *
   * O corpo tem de passar do teto do parser para o teste separar os dois
   * mundos: abaixo dele os dois respondem 401 e nada se prova. Acima, quem
   * responde diz quem chegou primeiro — 413 é o parser, e significa que os
   * bytes foram lidos antes de alguém ter a chance de recusar.
   */
  it('refuses an unauthenticated oversized upload before reading its body', async () => {
    const acimaDoTeto = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024, 0x41);
    const response = await fetch(`${panelUrl}/api/whatsapp/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-File-Name': 'anonimo.png' },
      body: acimaDoTeto
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.notEqual(body.code, 'attachment_too_large', 'o parser cru não pode ter respondido');
  });

  /**
   * O outro lado da mesma ordem: para quem TEM sessão o parser continua sendo
   * quem recusa, com o código que a tela sabe explicar. Sem isto, a correção
   * acima passaria igual se ela tivesse simplesmente quebrado o upload.
   */
  it('still answers an authenticated oversized upload from the parser', async () => {
    const acimaDoTeto = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024, 0x41);
    const { status, body } = await upload(acimaDoTeto, { type: 'image/png', name: 'grande.png' });

    assert.equal(status, 413);
    assert.equal(body.code, 'attachment_too_large');
  });

  it('stores an accepted file under DATA_DIR, with the extension of its TYPE', async () => {
    // The name says `.txt` and the type says PNG. The type wins: the extension
    // is half of what a browser later decides to do with the file, and it is
    // the only one of the two that this route checked.
    const { status, body } = await upload(PNG, { type: 'image/png', name: 'planta-do-poste.txt' });

    assert.equal(status, 201);
    assert.equal(body.success, true);
    assert.equal(body.data.type, 'image/png');
    // The provider is in the path since wave 8: an upload lands in that
    // provider's own subtree, which is what lets the sweep run per provider.
    assert.match(body.data.path, /^wa-media\/t\d+\/out\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);

    const onDisk = path.join(DATA_DIR, body.data.path);
    assert.equal(fs.existsSync(onDisk), true);
    assert.deepEqual(fs.readFileSync(onDisk), PNG);
    // Relative to DATA_DIR, exactly as the inbound side stores it: the volume
    // moves between the provider's machine and a container.
    assert.equal(path.isAbsolute(body.data.path), false);
  });

  it('keeps a hostile X-File-Name as a label and never as a path', async () => {
    const { status, body } = await upload(PNG, { type: 'image/png', name: '../../etc/passwd' });

    assert.equal(status, 201);
    // The name survives only as something to show, stripped of everything that
    // could be read as a path.
    assert.doesNotMatch(body.data.name, /[\\/]/);
    assert.doesNotMatch(body.data.name, /\.\./);
    assert.match(body.data.name, /^passwd\./);

    // And the file itself is where the route decided, not where the name asked.
    const resolved = path.resolve(DATA_DIR, body.data.path);
    assert.equal(resolved.startsWith(path.resolve(DATA_DIR) + path.sep), true);
    assert.equal(fs.existsSync(resolved), true);
    assert.equal(fs.existsSync('/etc/passwd.png'), false);
  });

  it('refuses a file over the 16 MB ceiling with attachment_too_large', async () => {
    const { status, body } = await upload(
      Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x41),
      { type: 'image/jpeg', name: 'foto-enorme.jpg' }
    );

    assert.equal(status, 413);
    assert.equal(body.success, false);
    assert.equal(body.code, 'attachment_too_large');
    // The refusal names the ceiling: the key takes `{max}` in MB.
    assert.match(body.message, /16/);
  });

  it('refuses SVG — it is executable on the panel\'s own origin', async () => {
    // Explicit, and deliberately its own case: SVG is the one type someone
    // will try to put back in the allowlist because "it is an image", and the
    // panel serves these files back on the origin the operator's session is on.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const { status, body } = await upload(svg, { type: 'image/svg+xml', name: 'diagrama.svg' });

    assert.equal(status, 415);
    assert.equal(body.code, 'attachment_type_not_allowed');
  });

  it('refuses every other type off the allowlist, and a request with no type at all', async () => {
    // GIF saiu desta lista quando entrou na lista única; `application/javascript`
    // ocupa o lugar — um script é exatamente o que nunca pode ser anexo.
    for (const type of ['text/html', 'application/octet-stream', 'application/x-msdownload', 'application/javascript']) {
      const { status, body } = await upload(PNG, { type, name: 'arquivo' });
      assert.equal(status, 415, `${type} should not be stored`);
      assert.equal(body.code, 'attachment_type_not_allowed');
    }

    // No `Content-Type` means no accepted type, which is the same refusal: the
    // raw parser does not even take a body it cannot name.
    const semTipo = await upload(PNG, { name: 'arquivo' });
    assert.equal(semTipo.status, 415);
    assert.equal(semTipo.body.code, 'attachment_type_not_allowed');
  });

  it('accepts the original allowlist, one extension each', async () => {
    // Os sete tipos de antes, ainda aceitos com a mesma extensão. A lista nova
    // inteira é conferida em `whatsapp-attachment-types.test.js`.
    const esperado = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'application/pdf': '.pdf',
      'video/mp4': '.mp4',
      'audio/ogg': '.ogg',
      'audio/mpeg': '.mp3'
    };
    for (const [type, extension] of Object.entries(esperado)) {
      // The parameters a browser adds to a type must not decide the answer.
      const { status, body } = await upload(SAMPLES[type], { type: `${type}; charset=binary`, name: 'x' });
      assert.equal(status, 201, `${type} should be stored`);
      assert.equal(body.data.type, type);
      assert.equal(path.extname(body.data.path), extension);
    }
  });

  it('refuses a nought-byte file rather than store one', async () => {
    // An empty file is not a small file. Stored, it reaches the customer as a
    // download that opens onto nothing — indistinguishable from a corrupt
    // upload, and impossible for the operator to tell apart afterwards.
    const { status, body } = await upload(Buffer.alloc(0), {
      type: 'image/png',
      name: 'vazio.png'
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'attachment_empty');
  });

  it('demands a session, like every other route on this surface', async () => {
    const response = await fetch(`${panelUrl}/api/whatsapp/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: PNG
    });
    assert.equal(response.status, 401);
  });

  it('returns a path the send route takes as an attachment', async () => {
    const stored = await upload(PNG, { type: 'image/png', name: 'fibra.png' });
    const { path: caminho, type, name } = stored.body.data;

    // No caption: a file on its own is a whole message. This is the pairing the
    // composer performs, and the only proof that the two halves agree.
    const enviada = await enviar({ attachment: { url: caminho, type, name } });
    assert.equal(enviada.status, 201);
    assert.equal(enviada.body.data.body, null);
    // The response says WHAT is attached, never where it is: the path stays on
    // the server's side of the wire, and the browser fetches the bytes by
    // message id. The row below is where the path has to be right.
    assert.equal(enviada.body.data.attachment.url, undefined);
    assert.equal(enviada.body.data.attachment.type, 'image/png');
    assert.equal(enviada.body.data.attachment.name, name);
    assert.equal(enviada.body.data.deliveryStatus, 'queued');

    const row = await getDb()('wa_messages').where({ id: enviada.body.data.id }).first();
    assert.equal(row.attachment_path, caminho);
    assert.equal(row.attachment_type, 'image/png');
    assert.equal(fs.existsSync(path.join(DATA_DIR, row.attachment_path)), true);
  });

  /**
   * O caminho do anexo chega do navegador, e a única coisa que ele deveria ser
   * é o que a rota de upload acabou de devolver. Sem confinar, `DATA_DIR`
   * inteiro ficava legível: é lá que moram `db-config.json`, com as credenciais
   * do banco em texto claro, e o `panel.sqlite`.
   *
   * `isNote: true` é o que deixava o ataque limpo — pula as checagens de
   * destino e de conta, então não precisa de número de WhatsApp e nada chega a
   * cliente nenhum.
   */
  it('refuses an attachment path the upload route never minted', async () => {
    for (const caminho of [
      'db-config.json',
      'panel.sqlite',
      'wa-media/t2/c9/de-outro-provedor.png',
      'wa-media/t1/entrada/recebido.png',
      '../../../etc/passwd'
    ]) {
      const recusada = await enviar({
        isNote: true,
        body: 'n',
        attachment: { path: caminho, type: 'application/json', name: 'x.json' }
      });
      assert.equal(recusada.status, 400, caminho);
      assert.equal(recusada.body.code, 'attachment_not_allowed', caminho);
    }
  });

  it('refuses a path that climbs back out of the outbound folder', async () => {
    const stored = await upload(PNG, { type: 'image/png', name: 'ok.png' });
    // Começa dentro da pasta certa e sobe: é o caso que uma checagem de prefixo
    // feita antes de resolver `..` deixaria passar.
    const fuga = `${stored.body.data.path}/../../../../db-config.json`;
    const recusada = await enviar({ isNote: true, body: 'n', attachment: { path: fuga } });

    assert.equal(recusada.status, 400);
    assert.equal(recusada.body.code, 'attachment_not_allowed');
  });

  /**
   * O upload confere os bytes contra a lista, que deixa HTML de fora. O envio
   * copiava o tipo e o nome do corpo da requisição: um `.txt` com HTML dentro
   * passava pelo upload e saía para o assinante como `Fatura.html`,
   * `text/html` — a página de golpe com o nome e o número do provedor.
   */
  it('takes the type from the stored file, never from the request', async () => {
    const stored = await upload(Buffer.from('<html><body>pague aqui</body></html>\n'), {
      type: 'text/plain', name: 'nota.txt'
    });
    assert.equal(stored.status, 201, JSON.stringify(stored.body));
    const enviada = await enviar({
      attachment: { url: stored.body.data.path, type: 'text/html', name: 'Fatura-Provedor.html' }
    });

    assert.equal(enviada.status, 201, JSON.stringify(enviada.body));
    const row = await getDb()('wa_messages').where({ id: enviada.body.data.id }).first();
    assert.equal(row.attachment_type, 'text/plain');
    assert.match(row.attachment_name, /\.txt$/);
    assert.equal(row.attachment_name.endsWith('.html'), false);
  });

  it('keeps an internal note a note when it carries a file', async () => {
    const stored = await upload(PNG, { type: 'image/png', name: 'interno.png' });
    const enviada = await enviar({
      isNote: true,
      attachment: { url: stored.body.data.path, type: 'image/png', name: 'interno.png' }
    });

    assert.equal(enviada.status, 201);
    assert.equal(enviada.body.data.isNote, true);
    // The one thing a note must never do is reach the customer: no delivery
    // state at all means the outbox worker never sees it.
    assert.equal(enviada.body.data.deliveryStatus, null);
  });
});
