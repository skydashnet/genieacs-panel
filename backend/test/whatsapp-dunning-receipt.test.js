import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaDunningService, pareceComprovante } = await import('../src/services/waDunningService.js');

/**
 * A régua e o comprovante: o cliente que mandou o comprovante não é cobrado
 * enquanto alguém confere, e a mensagem que ficou horas na fila é conferida
 * no SGP antes de sair.
 */

const APP = 'painel';
const TOKEN = 'token-comprovante';
const COBRANCA = 'Olá {{nome}}, sua fatura de {{valor}} venceu há {{dias_atraso}} dias. PIX: {{pix}}';

const SEMPRE = {
  timezone: 'America/Sao_Paulo',
  week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: false, open: '00:00', close: '23:59' }))
};
function meioDia(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(15, 0, 0, 0);
  return d;
}
const dia = (offset) => meioDia(offset).toISOString().slice(0, 10);

const SUBSCRIBERS = [
  { contract: 'C-FILA', name: 'Joana', phone: '5593981130001',
    invoices: [{ numerodocumento: 'F1', valor: '119,50', vencimento: dia(-2), pix: 'pix-1' }] },
  { contract: 'C-PAGOU', name: 'Bruno', phone: '5593981130002',
    invoices: [{ numerodocumento: 'F2', valor: '89,90', vencimento: dia(-2), pix: 'pix-2' }] },
  { contract: 'C-ANTES', name: 'Clara', phone: '5593981130003',
    invoices: [{ numerodocumento: 'F3', valor: '99,90', vencimento: dia(-2), pix: 'pix-3' }] },
  { contract: 'C-WEBHOOK', name: 'Davi', phone: '5593981130004',
    invoices: [{ numerodocumento: 'F4', valor: '79,90', vencimento: dia(-2), pix: 'pix-4' }] }
];
/** 1x1 PNG: o "comprovante" que chega pelo webhook. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const byContract = new Map(SUBSCRIBERS.map((row) => [row.contract, row]));

let panelUrl;
let token;
let sgpServer;
let sgpFora = false;
let accountId;

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      if (sgpFora) {
        res.writeHead(503);
        return res.end('{}');
      }
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (payload.app !== APP || payload.token !== TOKEN) return send({ status: 0, msg: 'Token inválido' });
      if (req.url.startsWith('/api/ura/titulos')) {
        const subscriber = byContract.get(String(payload.contrato));
        if (!subscriber) return send({ status: 0, msg: 'Contrato inexistente' });
        const titulos = payload.apenas_titulos_em_aberto
          ? subscriber.invoices.filter((f) => !f.dataPagamento)
          : subscriber.invoices;
        return send({ status: 1, titulos });
      }
      res.writeHead(404);
      return res.end('{}');
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

const api = (path, options = {}) => call(`${panelUrl}/api/whatsapp${path}`, { headers: authHeaders(token), ...options });
const run = () => asTenant(() => WaDunningService.run({ now: meioDia() }));
const linhas = (contract) => asTenant(() => getDb()('wa_dunning_sends').where({ contract }).orderBy('id'));
const conversaDe = async (phone) => asTenant(() => WaConversation.ensure({
  accountId, externalThreadId: `${phone}@s.whatsapp.net`, waPhone: phone, pushName: null
}));

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await startSgpStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'cobranca', password: 'cobranca-senha-1', email: 'cobranca@exemplo.test' }
  });
  token = setup.body.data.token;

  await asTenant(() => SgpService.saveConfig({ enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'pppoe' }));
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true, webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook', rateLimitPerMin: 60
  }));
  const account = await asTenant(() => WhatsAppAccount.create({
    name: 'painel-comprovante', purpose: 'billing', flavor: 'v2', base_url: 'https://evo.provedor.test',
    status: 'connected', is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia'),
    ...WhatsAppConfigService.encryptWebhookToken('token-webhook')
  }));
  accountId = account.id;

  const now = new Date();
  await asTenant(() => getDb()('sgp_links').insert(SUBSCRIBERS.map((s, index) => ({
    device_id: `ont-comprovante-${index}`, contract: s.contract, client_name: s.name, document: '12345678909',
    state: 'active', link_mode: 'auto', phone_e164: s.phone, created_at: now, updated_at: now
  }))));

  const modelo = await api('/templates', { method: 'POST', body: { name: 'cobrança', body: COBRANCA, category: 'cobranca' } });
  assert.equal(modelo.status, 201, JSON.stringify(modelo.body));
  const regra = await api('/dunning/rule', {
    method: 'PUT',
    body: { steps: [{ offsetDays: 1, templateId: modelo.body.data.id }], window: SEMPRE, minIntervalHours: 0 }
  });
  assert.equal(regra.status, 200, JSON.stringify(regra.body));
  assert.equal(regra.body.data.receiptPauseDays, 3, 'nasce com três dias');
  const ligou = await api('/dunning/enabled', { method: 'POST', body: { enabled: true } });
  assert.equal(ligou.status, 200, JSON.stringify(ligou.body));
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('o comprovante pausa a régua', () => {
  it('só imagem e PDF contam como comprovante', () => {
    assert.equal(pareceComprovante('image/jpeg'), true);
    assert.equal(pareceComprovante('application/pdf'), true);
    assert.equal(pareceComprovante('audio/ogg; codecs=opus'), false);
    assert.equal(pareceComprovante('video/mp4'), false);
    assert.equal(pareceComprovante(null), false);
  });

  it('a pausa fora do limite é recusada', async () => {
    const res = await api('/dunning/rule', { method: 'PUT', body: { receiptPauseDays: 30 } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_receipt_pause');
  });

  it('pausado antes da passada: pula sem gravar, e sai depois de retomar', async () => {
    const c = await conversaDe(byContract.get('C-ANTES').phone);
    await asTenant(() => WaConversation.update(c.id, { contract: 'C-ANTES' }));
    const conversa = await asTenant(() => WaConversation.getById(c.id));
    const pausa = await asTenant(() => WaDunningService.pauseForReceipt({ conversation: conversa, mime: 'image/jpeg' }));
    assert.equal(pausa.contract, 'C-ANTES');

    // Nota interna e etiqueta "Comprovante" na conversa.
    const nota = await asTenant(() => getDb()('wa_messages').where({ conversation_id: c.id, is_note: true }).first());
    assert.match(nota.body, /Comprovante recebido.*C-ANTES/);
    assert.equal(nota.delivery_status, null, 'nota nunca vai para a fila');
    const tags = await api('/tags');
    const comprovante = tags.body.data.find((t) => t.name === 'Comprovante');
    assert.ok(comprovante, 'a etiqueta nasce');
    const vinculo = await asTenant(() => getDb()('wa_conversation_tags').where({ conversation_id: c.id, tag_id: comprovante.id }).first());
    assert.ok(vinculo);

    const passada = await run();
    assert.equal(passada.skipped.paused, 1);
    assert.equal((await linhas('C-ANTES')).length, 0, 'nada gravado: a etapa continua devida');

    // O painel do assinante mostra a pausa; "Retomar régua" tira.
    const painel = await api(`/conversations/${c.id}/subscriber`);
    assert.equal(painel.body.data.dunningPause?.reason, 'receipt');
    const retomou = await api(`/conversations/${c.id}/subscriber/dunning-resume`, { method: 'POST', body: { contract: 'C-ANTES' } });
    assert.equal(retomou.status, 200, JSON.stringify(retomou.body));
    assert.equal((await api(`/conversations/${c.id}/subscriber`)).body.data.dunningPause, null);

    await run();
    const depois = await linhas('C-ANTES');
    assert.deepEqual(depois.map((r) => r.status), ['queued']);
  });

  it('comprovante com a cobrança na fila: a mensagem é retirada', async () => {
    await run();
    const [linha] = await linhas('C-FILA');
    assert.equal(linha.status, 'queued');
    const msg = await asTenant(() => getDb()('wa_messages').where({ id: linha.message_id }).first());
    const conversa = await asTenant(() => WaConversation.getById(msg.conversation_id));
    assert.equal(conversa.contract, 'C-FILA');

    await asTenant(() => WaDunningService.pauseForReceipt({ conversation: conversa, mime: 'application/pdf' }));
    const [retirada] = await linhas('C-FILA');
    assert.equal(retirada.status, 'canceled');
    assert.equal(retirada.reason, 'paused');
    assert.equal(retirada.paid_at, null, 'pausa não é pagamento');
    assert.equal(await asTenant(() => getDb()('wa_messages').where({ id: linha.message_id }).first()), undefined);
  });

  it('régua desligada ou pausa zero não pausam; conversa sem contrato também não', async () => {
    const semContrato = await conversaDe('5593981139999');
    assert.equal(await asTenant(() => WaDunningService.pauseForReceipt({ conversation: semContrato, mime: 'image/png' })), null);
    await api('/dunning/rule', { method: 'PUT', body: { receiptPauseDays: 0 } });
    const c = await conversaDe(byContract.get('C-PAGOU').phone);
    await asTenant(() => WaConversation.update(c.id, { contract: 'C-PAGOU' }));
    const conversa = await asTenant(() => WaConversation.getById(c.id));
    assert.equal(await asTenant(() => WaDunningService.pauseForReceipt({ conversation: conversa, mime: 'image/png' })), null);
    assert.equal((await asTenant(() => WaDunningService.pausedContracts())).has('C-PAGOU'), false);
    await api('/dunning/rule', { method: 'PUT', body: { receiptPauseDays: 3 } });
  });

  it('a imagem que chega pelo webhook pausa o contrato do número', async () => {
    const evento = (id, message) => call(`${panelUrl}/api/whatsapp-webhook?t=token-webhook`, {
      method: 'POST',
      body: {
        event: 'messages.upsert',
        instance: 'painel-comprovante',
        data: {
          key: { remoteJid: '5593981130004@s.whatsapp.net', fromMe: false, id },
          pushName: 'Davi',
          message,
          messageType: 'imageMessage',
          messageTimestamp: 1739990000
        }
      }
    });
    await evento('RECEIPT-AUDIO', { audioMessage: { mimetype: 'audio/ogg', url: 'https://mmg.whatsapp.net/x.enc' } });
    assert.equal((await asTenant(() => WaDunningService.pausedContracts())).has('C-WEBHOOK'), false, 'áudio não pausa');

    const res = await evento('RECEIPT-IMG', { imageMessage: { mimetype: 'image/png' }, base64: PNG_BASE64 });
    assert.equal(res.status, 200);
    assert.equal((await asTenant(() => WaDunningService.pausedContracts())).has('C-WEBHOOK'), true);
  });
});

describe('a conferência na saída da fila', () => {
  it('a fatura continua aberta: sai; SGP fora: sai; não é da régua: sai', async () => {
    const [linha] = await linhas('C-PAGOU');
    assert.equal(linha.status, 'queued');
    assert.equal(await asTenant(() => WaDunningService.stillDue(linha.message_id)), true);

    sgpFora = true;
    try {
      assert.equal(await asTenant(() => WaDunningService.stillDue(linha.message_id)), true);
    } finally {
      sgpFora = false;
    }
    assert.equal(await asTenant(() => WaDunningService.stillDue(999999)), true);
  });

  it('o SGP deu a baixa enquanto esperava: a mensagem é retirada e a fatura, dada como paga', async () => {
    const [linha] = await linhas('C-PAGOU');
    byContract.get('C-PAGOU').invoices[0].dataPagamento = dia(0);
    assert.equal(await asTenant(() => WaDunningService.stillDue(linha.message_id)), false);
    const [depois] = await linhas('C-PAGOU');
    assert.equal(depois.status, 'canceled');
    assert.equal(depois.reason, 'paid');
    assert.ok(depois.paid_at);
    assert.equal(await asTenant(() => getDb()('wa_messages').where({ id: linha.message_id }).first()), undefined);
  });
});
