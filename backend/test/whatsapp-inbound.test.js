import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asTenant, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { setMediaFetcher } = await import('../src/services/waMediaService.js');
const { DATA_DIR } = await import('../src/config/paths.js');
const { mintNonce } = await import('../src/utils/wa/waWebhookProbe.js');
const { sign: signProbeTicket, PROBE_TICKET_TTL_MS } = await import('../src/utils/wa/waProbeTicket.js');

const INSTANCE = 'painel-entrada';
const INSTANCE_TOKEN = 'token-instancia-entrada';
const WEBHOOK_TOKEN = 'segredo-webhook-entrada';

/** 1x1 PNG. Small enough to inline, real enough to prove the bytes landed. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let panelUrl;
let accountId;

/** Every event goes in the way the Evolution server sends it: over HTTP, with the token. */
async function hook(body) {
  return call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });
}

const mensagens = () => getDb()('wa_messages');
const conversas = () => getDb()('wa_conversations');

async function mensagemPorId(externalId) {
  // No request behind these; the webhook route opens its own scope from the
  // account the instance name resolved to.
  return asTenant(() => WaMessage.getByExternalId(externalId));
}

async function conversaDaMensagem(externalId) {
  const msg = await mensagemPorId(externalId);
  return msg ? conversas().where({ id: msg.conversation_id }).first() : null;
}

/** A v2 `messages.upsert`, as Evolution API v2 actually posts it. */
function eventoV2({ id, remoteJid, fromMe = false, texto = '', pushName = 'Cliente', chave = {}, message = null }) {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid, fromMe, id, ...chave },
      pushName,
      message: message ?? { conversation: texto },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  };
}

/** A GO `Message`, whose fields are capitalized because whatsmeow has no json tags. */
function eventoGo({ id, chat, fromMe = false, texto = '', pushName = 'Cliente', info = {} }) {
  return {
    event: 'Message',
    instance: INSTANCE,
    data: {
      Info: {
        ID: id,
        Chat: chat,
        Sender: chat,
        IsFromMe: fromMe,
        IsGroup: false,
        PushName: pushName,
        ...info
      },
      Message: { conversation: texto }
    }
  };
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const account = await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'pending',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken(INSTANCE_TOKEN),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
  accountId = account.id;
});

after(async () => {
  await stopTestServers();
});

describe('inbound messages', () => {
  it('lands a v2 messages.upsert as one message on one conversation', async () => {
    const { status, body } = await hook(eventoV2({
      id: 'V2-TEXTO-1',
      remoteJid: '5593981110449@s.whatsapp.net',
      texto: 'boa tarde, minha internet caiu',
      pushName: 'Maria'
    }));
    assert.equal(status, 200);
    assert.equal(body.handled, true);
    assert.equal(body.event, 'messages_upsert');

    const msg = await mensagemPorId('V2-TEXTO-1');
    assert.ok(msg, 'the message should exist');
    assert.equal(msg.direction, 'in');
    assert.equal(msg.body, 'boa tarde, minha internet caiu');
    assert.equal(msg.delivery_status, null);

    const conversa = await conversaDaMensagem('V2-TEXTO-1');
    assert.equal(conversa.account_id, accountId);
    assert.equal(conversa.wa_phone_e164, '5593981110449');
    assert.equal(conversa.wa_lid, null);
    assert.equal(conversa.push_name, 'Maria');
    assert.equal(conversa.unread_count, 1);
    assert.ok(conversa.last_inbound_at);
  });

  it('lands a GO MESSAGE the same way, device suffix and all', async () => {
    const { status, body } = await hook(eventoGo({
      id: 'GO-TEXTO-1',
      chat: '5591988887777@s.whatsapp.net',
      texto: 'bom dia',
      pushName: 'Carlos',
      // A WhatsApp Web session is always a companion device, so the sender JID
      // carries `:device`. Gluing it onto the number invents a phone.
      info: { Sender: '5591988887777:22@s.whatsapp.net' }
    }));
    assert.equal(status, 200);
    assert.equal(body.handled, true);

    const conversa = await conversaDaMensagem('GO-TEXTO-1');
    assert.equal(conversa.wa_phone_e164, '5591988887777');
    assert.equal(conversa.external_thread_id, '5591988887777@s.whatsapp.net');
  });

  it('stores ONE row when the same event is delivered twice', async () => {
    const evento = eventoV2({
      id: 'V2-REPETIDA',
      remoteJid: '5593955554444@s.whatsapp.net',
      texto: 'chegou duas vezes'
    });
    const primeira = await hook(evento);
    const segunda = await hook(evento);

    // Both servers redeliver. A duplicate is success, not an error: answering
    // non-2xx would make the server send the same event forever.
    assert.equal(primeira.status, 200);
    assert.equal(segunda.status, 200);
    assert.equal(segunda.body.handled, true);
    assert.equal(segunda.body.duplicate, true);

    const [{ total }] = await mensagens().where({ external_id: 'V2-REPETIDA' }).count({ total: '*' });
    assert.equal(Number(total), 1);

    const conversa = await conversaDaMensagem('V2-REPETIDA');
    assert.equal(conversa.unread_count, 1, 'a redelivery must not bump unread twice');
  });

  it('stores a @lid contact as a LID and NEVER as a phone', async () => {
    await hook(eventoV2({
      id: 'V2-LID-1',
      remoteJid: '140076734488739@lid',
      texto: 'oi',
      pushName: 'Contato Privado'
    }));

    const conversa = await conversaDaMensagem('V2-LID-1');
    // A LID is not a phone number. Writing those 15 digits into the phone
    // column is what put identifiers where customer names belong.
    assert.equal(conversa.wa_lid, '140076734488739');
    assert.equal(conversa.wa_phone_e164, null);
    assert.equal(conversa.external_thread_id, '140076734488739@lid');
  });

  it('keeps both identities when the event carries the phone alongside the LID', async () => {
    await hook(eventoV2({
      id: 'V2-DUPLA-1',
      remoteJid: '140076734488750@lid',
      texto: 'sou eu de novo',
      chave: { senderPn: '5593922221111@s.whatsapp.net' }
    }));

    const conversa = await conversaDaMensagem('V2-DUPLA-1');
    assert.equal(conversa.wa_lid, '140076734488750');
    assert.equal(conversa.wa_phone_e164, '5593922221111');
  });

  it('does NOT take the customer identity from the Sender fields of a fromMe message', async () => {
    // THE TRAP: on an outbound echo `senderPn` / `SenderAlt` are the PROVIDER's
    // own number. Reading them here would stamp the provider's phone onto the
    // customer's conversation, and every later dunning message for that thread
    // would go to the provider.
    await hook(eventoV2({
      id: 'V2-SAIDA-1',
      remoteJid: '140076734488760@lid',
      fromMe: true,
      texto: 'já vamos verificar',
      chave: { senderPn: '5511777776666@s.whatsapp.net' }
    }));

    const msg = await mensagemPorId('V2-SAIDA-1');
    assert.equal(msg.direction, 'out');
    assert.equal(msg.delivery_status, 'sent');

    const conversa = await conversaDaMensagem('V2-SAIDA-1');
    assert.equal(conversa.wa_lid, '140076734488760');
    assert.equal(conversa.wa_phone_e164, null, "the provider's own number must not become the contact");
    assert.equal(conversa.unread_count, 0, 'our own message is not unread');
  });

  it('does the same for the GO SenderAlt on an outbound echo', async () => {
    await hook(eventoGo({
      id: 'GO-SAIDA-1',
      chat: '140076734488770@lid',
      fromMe: true,
      texto: 'retorno em instantes',
      info: { IsFromMe: true, SenderAlt: '5511777776666@s.whatsapp.net' }
    }));

    const conversa = await conversaDaMensagem('GO-SAIDA-1');
    assert.equal(conversa.wa_lid, '140076734488770');
    assert.equal(conversa.wa_phone_e164, null);
  });

  it('discards a pushName that is only the identifier repeated', async () => {
    // Evolution GO sends the identifier as the name when the contact has none.
    // Storing it puts 15 digits where the customer's name goes.
    await hook(eventoGo({
      id: 'GO-NOME-FONE',
      chat: '5593944443333@s.whatsapp.net',
      texto: 'alô',
      pushName: '5593944443333'
    }));
    assert.equal((await conversaDaMensagem('GO-NOME-FONE')).push_name, null);

    await hook(eventoV2({
      id: 'V2-NOME-LID',
      remoteJid: '140076734488780@lid',
      texto: 'alô',
      pushName: '+140076734488780'
    }));
    assert.equal((await conversaDaMensagem('V2-NOME-LID')).push_name, null);
  });

  it('skips a group with 200, so the server does not retry it forever', async () => {
    const { status, body } = await hook(eventoV2({
      id: 'V2-GRUPO-1',
      remoteJid: '120363041234567890@g.us',
      texto: 'mensagem de grupo'
    }));
    assert.equal(status, 200);
    assert.equal(body.handled, false);
    assert.equal(body.skipped, 'group');
    assert.equal(await mensagemPorId('V2-GRUPO-1'), null);
  });

  it('skips broadcasts and domains it does not know, also with 200', async () => {
    const status = await hook(eventoV2({
      id: 'V2-STATUS-1',
      remoteJid: 'status@broadcast',
      texto: 'status de alguem'
    }));
    assert.equal(status.status, 200);
    assert.equal(status.body.skipped, 'broadcast');

    const novo = await hook(eventoV2({
      id: 'V2-DOMINIO-NOVO',
      remoteJid: '998877@newsletter',
      texto: 'canal'
    }));
    assert.equal(novo.status, 200);
    assert.equal(novo.body.skipped, 'unknown_domain');
    assert.equal(await mensagemPorId('V2-DOMINIO-NOVO'), null);
  });

  it('skips an event with no usable address instead of inventing one', async () => {
    const { status, body } = await hook({
      event: 'messages.upsert',
      instance: INSTANCE,
      data: { key: { id: 'V2-SEM-ENDERECO', fromMe: false }, message: { conversation: 'oi' } }
    });
    assert.equal(status, 200);
    assert.equal(body.handled, false);
    assert.equal(await mensagemPorId('V2-SEM-ENDERECO'), null);
  });

  it('reads the text of an extendedTextMessage and of a caption', async () => {
    await hook(eventoV2({
      id: 'V2-EXTENDED',
      remoteJid: '5593911112222@s.whatsapp.net',
      message: { extendedTextMessage: { text: 'segue o link do boleto' } }
    }));
    assert.equal((await mensagemPorId('V2-EXTENDED')).body, 'segue o link do boleto');
  });

  it('describes a reaction or a location instead of leaving an empty bubble', async () => {
    await hook(eventoV2({
      id: 'V2-REACAO',
      remoteJid: '5593911113333@s.whatsapp.net',
      message: { reactionMessage: { text: '👍', key: { id: 'OUTRA' } } }
    }));
    assert.equal((await mensagemPorId('V2-REACAO')).body, 'Reagiu com 👍 a uma mensagem');
    await hook(eventoV2({
      id: 'V2-LOCAL',
      remoteJid: '5593911113333@s.whatsapp.net',
      message: { locationMessage: { degreesLatitude: -2.4, degreesLongitude: -54.7 } }
    }));
    assert.match((await mensagemPorId('V2-LOCAL')).body, /📍 Localização\nhttps:\/\/www\.google\.com\/maps\?q=-2\.4,-54\.7/);
  });

  it('says which media did not come through', async () => {
    await hook(eventoV2({
      id: 'V2-MIDIA-SEM-BYTES',
      remoteJid: '5593911114444@s.whatsapp.net',
      message: { imageMessage: { mimetype: 'image/jpeg', url: 'https://mmg.whatsapp.net/x.enc' } }
    }));
    const msg = await mensagemPorId('V2-MIDIA-SEM-BYTES');
    assert.equal(msg.attachment_path, null);
    assert.match(msg.body, /^📷 Foto — não foi possível baixar/);
  });
});

describe('inbound media', () => {
  it('stores the base64 the server already decrypted, under the conversation', async () => {
    await hook(eventoV2({
      id: 'V2-MIDIA-1',
      remoteJid: '5593977776666@s.whatsapp.net',
      message: {
        imageMessage: {
          mimetype: 'image/png',
          caption: 'olha o modem',
          // The encrypted object on WhatsApp's CDN. It must never be fetched.
          url: 'https://mmg.whatsapp.net/d/f/Aq1x.enc',
          fileName: '../../etc/passwd'
        },
        base64: PNG_BASE64
      }
    }));

    const msg = await mensagemPorId('V2-MIDIA-1');
    assert.equal(msg.body, 'olha o modem');
    assert.equal(msg.attachment_type, 'image/png');
    assert.match(msg.attachment_path, new RegExp(`^wa-media/t\\d+/${msg.conversation_id}/`));
    // A filename from a stranger's phone is not a path.
    assert.equal(msg.attachment_path.includes('..'), false);
    assert.equal(fs.existsSync(path.join(DATA_DIR, msg.attachment_path)), true);
    assert.equal(fs.readFileSync(path.join(DATA_DIR, msg.attachment_path)).length, Buffer.from(PNG_BASE64, 'base64').length);
  });

  it('never downloads the WhatsApp CDN url, and stores the message without an attachment', async () => {
    await hook(eventoV2({
      id: 'V2-MIDIA-CIFRADA',
      remoteJid: '5593966665555@s.whatsapp.net',
      message: {
        audioMessage: {
          mimetype: 'audio/ogg',
          // Only the encrypted pointer, no base64 and no mediaUrl. Downloading
          // it writes unreadable bytes and the link expires; the honest result
          // is a message with no attachment.
          url: 'https://mmg.whatsapp.net/v/t62.7117-24/1234.enc?oe=68B00000'
        }
      }
    }));

    const msg = await mensagemPorId('V2-MIDIA-CIFRADA');
    assert.ok(msg, 'the message itself must still land');
    assert.equal(msg.attachment_path, null);
  });

  it('falls back to asking the server for the bytes', async () => {
    setMediaFetcher(async () => ({ base64: PNG_BASE64, mimetype: 'image/png', fileName: 'recibo.png' }));
    try {
      await hook(eventoV2({
        id: 'V2-MIDIA-ULTIMO',
        remoteJid: '5593955551111@s.whatsapp.net',
        message: { imageMessage: { mimetype: 'image/png', url: 'https://mmg.whatsapp.net/d/f/zz.enc' } }
      }));
    } finally {
      setMediaFetcher(null);
    }

    const msg = await mensagemPorId('V2-MIDIA-ULTIMO');
    assert.equal(msg.attachment_name, 'recibo.png');
    assert.equal(fs.existsSync(path.join(DATA_DIR, msg.attachment_path)), true);
  });
});

describe('delivery receipts', () => {
  async function saida(externalId) {
    const conversa = await conversas().where({ external_thread_id: '5593981110449@s.whatsapp.net' }).first();
    return asTenant(() => WaMessage.create({
      conversation_id: conversa.id,
      direction: 'out',
      body: 'com recibo',
      external_id: externalId,
      delivery_status: 'sending'
    }));
  }

  it('reads the v2 flat shape, where there is no data.key at all', async () => {
    const msg = await saida('RCPT-V2');
    const { status, body } = await hook({
      event: 'messages.update',
      instance: INSTANCE,
      data: { messageId: 'cm9m2q06m2pakoe4rcgdmwe42', keyId: 'RCPT-V2', status: 'DELIVERY_ACK' }
    });
    assert.equal(status, 200);
    assert.equal(body.handled, true);
    assert.equal((await asTenant(() => WaMessage.getById(msg.id))).delivery_status, 'delivered');
  });

  it('reads the v1 nested shape', async () => {
    const msg = await saida('RCPT-V1');
    await hook({
      event: 'messages.update',
      instance: INSTANCE,
      data: { key: { id: 'RCPT-V1' }, update: { status: 'READ' } }
    });
    assert.equal((await asTenant(() => WaMessage.getById(msg.id))).delivery_status, 'read');
  });

  it('reads the GO shape, which carries the state outside data and covers a batch', async () => {
    const um = await saida('RCPT-GO-1');
    const dois = await saida('RCPT-GO-2');
    const { body } = await hook({
      event: 'Receipt',
      instance: INSTANCE,
      state: 'Delivered',
      data: { MessageIDs: ['RCPT-GO-1', 'RCPT-GO-2'] }
    });
    assert.equal(body.handled, true);
    assert.equal(body.updated, 2);
    assert.equal((await asTenant(() => WaMessage.getById(um.id))).delivery_status, 'delivered');
    assert.equal((await asTenant(() => WaMessage.getById(dois.id))).delivery_status, 'delivered');
  });

  it('skips with 200 when the update carries no state, and says so', async () => {
    const { status, body } = await hook({
      event: 'messages.update',
      instance: INSTANCE,
      data: { keyId: 'RCPT-V2', message: { conversation: 'texto editado' } }
    });
    // A text edit legitimately has no receipt. It is still a recognised event,
    // so it gets a 200 — but `skipped` keeps it distinguishable from a stored
    // one, which is the difference the source system did not have.
    assert.equal(status, 200);
    assert.equal(body.handled, false);
    assert.equal(body.skipped, 'no_receipt');
  });

  it("ignores the operator's own ReadSelf, which says nothing about the customer", async () => {
    const msg = await saida('RCPT-READSELF');
    await hook({
      event: 'Receipt',
      instance: INSTANCE,
      state: 'ReadSelf',
      data: { MessageIDs: ['RCPT-READSELF'] }
    });
    assert.equal((await asTenant(() => WaMessage.getById(msg.id))).delivery_status, 'sending');
  });
});

describe('opt-out from an inbound message', () => {
  it('records the opt-out when the whole inbound message is the request', async () => {
    await hook(eventoV2({
      id: 'V2-SAIR-1',
      remoteJid: '5599111112222@s.whatsapp.net',
      texto: 'SAIR'
    }));
    assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: '5599111112222' })), true);
  });

  it('does NOT record one on an outbound echo', async () => {
    // The provider typing "sair" on their own phone must never unsubscribe
    // their own customer.
    await hook(eventoV2({
      id: 'V2-SAIR-ECO',
      remoteJid: '5599222223333@s.whatsapp.net',
      fromMe: true,
      texto: 'sair'
    }));
    assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: '5599222223333' })), false);
    assert.equal((await mensagemPorId('V2-SAIR-ECO')).direction, 'out');
  });

  it('does not treat "pode separar" as an opt-out', async () => {
    // Measured against 1.887 real customer messages: a substring rule
    // unsubscribes people who were in the middle of buying something.
    await hook(eventoV2({
      id: 'V2-SEPARAR',
      remoteJid: '5599333334444@s.whatsapp.net',
      texto: 'Então pode separar'
    }));
    assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: '5599333334444' })), false);
  });

  it('records one for a contact known only by LID', async () => {
    await hook(eventoV2({
      id: 'V2-SAIR-LID',
      remoteJid: '140076734488799@lid',
      texto: 'parar'
    }));
    assert.equal(await asTenant(() => WaOptOut.isActive({ waLid: '140076734488799' })), true);
  });
});

describe('qr and connection', () => {
  it('stores the QR and moves the account to connecting', async () => {
    const { status, body } = await hook({
      event: 'qrcode.updated',
      instance: INSTANCE,
      data: { qrcode: { base64: 'data:image/png;base64,AAAA', code: '2@abc' } }
    });
    assert.equal(status, 200);
    assert.equal(body.handled, true);

    const conta = await asTenant(() => WhatsAppAccount.getById(accountId));
    assert.equal(conta.qr_code, 'data:image/png;base64,AAAA');
    assert.equal(conta.status, 'connecting');
    assert.ok(conta.qr_updated_at);
  });

  it('connects, clears the dead QR and captures the paired number', async () => {
    const { body } = await hook({
      event: 'connection.update',
      instance: INSTANCE,
      data: { state: 'open', wuid: '5593981110000:14@s.whatsapp.net' }
    });
    assert.equal(body.handled, true);

    const conta = await asTenant(() => WhatsAppAccount.getById(accountId));
    assert.equal(conta.status, 'connected');
    assert.equal(conta.phone_e164, '5593981110000');
    assert.equal(conta.qr_code, null, 'a paired session has no QR left to read');
    assert.ok(conta.last_seen_at);
  });

  it('reads a GO connection event whose payload carries no state at all', async () => {
    // The GO splits "connection" into five events and often sends an empty
    // body: `readStatus('go', {})` would read that as disconnected, so the raw
    // event name has to be the fallback.
    await hook({ event: 'LoggedOut', instance: INSTANCE, data: {} });
    assert.equal((await asTenant(() => WhatsAppAccount.getById(accountId))).status, 'disconnected');

    await hook({ event: 'Connected', instance: INSTANCE, data: {} });
    assert.equal((await asTenant(() => WhatsAppAccount.getById(accountId))).status, 'connected');
  });

  it('uma mensagem chegando tira o número de "conectando": a sessão está viva', async () => {
    // O aviso de reconexão se perdeu e o número ficou em "conectando",
    // recebendo mensagens — e o painel recusava responder.
    await asTenant(() => WhatsAppAccount.update(accountId, { status: 'connecting', qr_code: null }));
    const { body } = await hook(eventoV2({ id: 'VIVO-1', remoteJid: '5593981110449@s.whatsapp.net', texto: 'oi' }));
    assert.equal(body.handled, true);
    assert.equal((await asTenant(() => WhatsAppAccount.getById(accountId))).status, 'connected');
  });

  it('mas não desfaz um logout: "desconectado" só sobe pela conferência ao vivo', async () => {
    await asTenant(() => WhatsAppAccount.update(accountId, { status: 'disconnected' }));
    await hook(eventoV2({ id: 'ATRASADO-1', remoteJid: '5593981110449@s.whatsapp.net', texto: 'oi' }));
    assert.equal((await asTenant(() => WhatsAppAccount.getById(accountId))).status, 'disconnected');
    await asTenant(() => WhatsAppAccount.update(accountId, { status: 'connected' }));
  });

  it('answers 200 with a reason for an event it does not handle', async () => {
    const { status, body } = await hook({ event: 'presence.update', instance: INSTANCE, data: {} });
    assert.equal(status, 200);
    assert.equal(body.handled, false);
    assert.equal(body.skipped, 'unsupported_event');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A recusa deixa rastro
//
// Um evento que chega e leva 401 e um evento que nunca chega são problemas com
// consertos OPOSTOS — um é token divergente, o outro é o Evolution não estar
// chamando — e na tela eram o mesmo "Nunca chegou nada". A trilha da recusa é
// o que os separa.
// ─────────────────────────────────────────────────────────────────────────────
describe('um evento que chega e é recusado', () => {
  const recarregar = () => asTenant(() => WhatsAppAccount.getById(accountId));

  async function limparRastro() {
    await asTenant(() => WhatsAppAccount.update(accountId, {
      webhook_refused_at: null,
      webhook_refused_reason: null
    }));
  }

  it('registra o token errado, em vez de sumir com a recusa', async () => {
    await limparRastro();
    const { status } = await call(`${panelUrl}/api/whatsapp-webhook?t=nao-e-o-token`, {
      method: 'POST',
      body: eventoV2({ id: 'RECUSADO-1', remoteJid: '559381110449@s.whatsapp.net', texto: 'oi' })
    });
    assert.equal(status, 401);

    const conta = await recarregar();
    assert.equal(conta.webhook_refused_reason, 'bad_token');
    assert.ok(conta.webhook_refused_at);
  });

  it('distingue o servidor que não manda credencial nenhuma', async () => {
    await limparRastro();
    const { status } = await call(`${panelUrl}/api/whatsapp-webhook`, {
      method: 'POST',
      body: eventoV2({ id: 'RECUSADO-2', remoteJid: '559381110449@s.whatsapp.net', texto: 'oi' })
    });
    assert.equal(status, 401);
    assert.equal((await recarregar()).webhook_refused_reason, 'no_credential');
  });

  it('não escreve de novo dentro do minuto, porque a rota é pública', async () => {
    await limparRastro();
    await call(`${panelUrl}/api/whatsapp-webhook?t=errado`, {
      method: 'POST',
      body: eventoV2({ id: 'RECUSADO-3', remoteJid: '559381110449@s.whatsapp.net', texto: 'oi' })
    });
    const primeira = (await recarregar()).webhook_refused_at;

    // Quem souber o nome de uma instância não pode transformar a trilha num
    // jeito de fazer o painel escrever no banco em laço.
    await call(`${panelUrl}/api/whatsapp-webhook?t=errado-de-novo`, {
      method: 'POST',
      body: eventoV2({ id: 'RECUSADO-4', remoteJid: '559381110449@s.whatsapp.net', texto: 'oi' })
    });
    const segunda = (await recarregar()).webhook_refused_at;
    assert.equal(new Date(segunda).getTime(), new Date(primeira).getTime());
  });

  it('a recusa é rastro e nunca muda a resposta nem o que foi gravado', async () => {
    await limparRastro();
    await call(`${panelUrl}/api/whatsapp-webhook?t=errado`, {
      method: 'POST',
      body: eventoV2({ id: 'NAO-GRAVADO', remoteJid: '559381110449@s.whatsapp.net', texto: 'oi' })
    });
    // O evento continua descartado: a trilha diz que ele bateu na porta, não
    // que ele entrou.
    assert.equal(await mensagemPorId('NAO-GRAVADO'), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A outra metade da volta: o que esta rota responde à sonda
//
// A volta só vale como prova por responder DEPOIS da autorização. É isso que
// faz um `reached` significar duas coisas de uma vez — que o endereço chega
// aqui, e que o token guardado é o que esta rota aceita.
// ─────────────────────────────────────────────────────────────────────────────
describe('a sonda do próprio painel', () => {
  const sonda = (nonce) => ({
    event: 'panel.probe',
    instance: INSTANCE,
    probe: { nonce }
  });

  it('devolve o nonce quando o token confere', async () => {
    const nonce = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const { status, body } = await call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, {
      method: 'POST',
      body: sonda(nonce)
    });
    assert.equal(status, 200);
    assert.equal(body.pong, nonce);
  });

  it('NÃO devolve o nonce com o token errado', async () => {
    const nonce = 'b1b2c3d4e5f60718293a4b5c6d7e8f90';
    const { status, body } = await call(`${panelUrl}/api/whatsapp-webhook?t=errado`, {
      method: 'POST',
      body: sonda(nonce)
    });
    // Se o eco viesse antes da autorização, a volta diria `reached` sobre um
    // token divergente — exatamente a falha que ela existe para achar.
    assert.equal(status, 401);
    assert.equal(body.pong, undefined);
  });

  it('não grava nada: um diagnóstico não suja a caixa que veio diagnosticar', async () => {
    const antes = await conversas().count({ total: '*' });
    await call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, {
      method: 'POST',
      body: sonda('c1b2c3d4e5f60718293a4b5c6d7e8f90')
    });
    const depois = await conversas().count({ total: '*' });
    assert.deepEqual(depois, antes);
  });

  it('não ecoa lixo: o corpo da sonda não escolhe o tamanho da resposta', async () => {
    const { body } = await call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, {
      method: 'POST',
      body: sonda('x'.repeat(5000))
    });
    assert.equal(body.pong, '');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A sonda de CONFIGURAÇÃO, que roda com zero números conectados
//
// Sem conta não há nome de instância nem token, e a busca pelo nome responde
// 401 — que `probeVerdict` traduz como "o endereço leva a OUTRO painel". Um
// diagnóstico afirmando a coisa errada com confiança, justamente no caso em
// que ele é a única fonte de informação. O bilhete existe para isso, e o que
// ele autoriza é uma coisa só: devolver o nonce que o chamador mandou.
// ─────────────────────────────────────────────────────────────────────────────
describe('a sonda de configuração, pelo bilhete', () => {
  const NOME_SINTETICO = 'panel-config-test';

  const sondaComBilhete = (nonce, ticket) => ({
    event: 'panel.probe',
    instance: NOME_SINTETICO,
    probe: { nonce, ticket }
  });

  it('devolve o nonce sem token de instância e sem instância nenhuma', async () => {
    const nonce = mintNonce();
    // Sem `?t=` na URL: é o ponto inteiro. E o nome da instância não existe no
    // banco — se a rota o procurasse antes, isto seria 401.
    const { status, body } = await call(`${panelUrl}/api/whatsapp-webhook`, {
      method: 'POST',
      body: sondaComBilhete(nonce, signProbeTicket(nonce))
    });
    assert.equal(status, 200);
    assert.equal(body.pong, nonce);
  });

  it('recusa o bilhete cunhado para OUTRO nonce', async () => {
    // O bilhete assina o nonce. Sem esse laço, um bilhete válido capturado uma
    // vez daria eco a qualquer valor, e a volta deixaria de ser prova.
    const nonce = mintNonce();
    const { status, body } = await call(`${panelUrl}/api/whatsapp-webhook`, {
      method: 'POST',
      body: sondaComBilhete(nonce, signProbeTicket(mintNonce()))
    });
    assert.equal(status, 401);
    assert.equal(body.pong, undefined);
  });

  it('recusa o bilhete vencido', async () => {
    const nonce = mintNonce();
    const vencido = signProbeTicket(nonce, Date.now() - PROBE_TICKET_TTL_MS - 1000);
    const { status } = await call(`${panelUrl}/api/whatsapp-webhook`, {
      method: 'POST',
      body: sondaComBilhete(nonce, vencido)
    });
    assert.equal(status, 401);
  });

  it('recusa o bilhete inventado, no formato certo', async () => {
    // Formato válido e assinatura falsa: é o que um estranho consegue montar
    // sem a chave do deploy, e é o caso que decide se isto é credencial ou
    // decoração.
    const nonce = mintNonce();
    const forjado = `${Math.floor(Date.now() / 1000) + 60}.${'a'.repeat(64)}`;
    const { status } = await call(`${panelUrl}/api/whatsapp-webhook`, {
      method: 'POST',
      body: sondaComBilhete(nonce, forjado)
    });
    assert.equal(status, 401);
  });

  it('não grava nada, nem abre conversa para o nome sintético', async () => {
    const antes = await conversas().count({ total: '*' });
    const nonce = mintNonce();
    await call(`${panelUrl}/api/whatsapp-webhook`, {
      method: 'POST',
      body: sondaComBilhete(nonce, signProbeTicket(nonce))
    });
    const depois = await conversas().count({ total: '*' });
    assert.deepEqual(depois, antes);
  });

  it('e o bilhete NÃO abre caminho para evento de verdade', async () => {
    // O que o bilhete autoriza é o eco, e só. Um evento real carregando um
    // bilhete válido tem que morrer aqui, sem tocar no serviço de entrada —
    // senão a credencial estreita viraria uma porta larga.
    const antes = await mensagens().count({ total: '*' });
    const nonce = mintNonce();
    const { status, body } = await call(`${panelUrl}/api/whatsapp-webhook`, {
      method: 'POST',
      body: {
        ...eventoV2({ id: 'EVT-COM-BILHETE', remoteJid: '5511999990000@s.whatsapp.net', texto: 'oi' }),
        probe: { nonce, ticket: signProbeTicket(nonce) }
      }
    });
    assert.equal(status, 200);
    assert.equal(body.pong, nonce, 'o bilhete devia ter encerrado a requisição no eco');
    assert.deepEqual(await mensagens().count({ total: '*' }), antes, 'o evento entrou mesmo assim');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dois limites que o lote não tinha
// ─────────────────────────────────────────────────────────────────────────────
describe('o lote e o que ele deixa para trás', () => {
  it('o anexo NÃO fica no disco quando a linha não chega a existir', async () => {
    // Os bytes são gravados ANTES do insert, porque o caminho deles é uma
    // coluna da linha. Quando o insert falha por qualquer motivo que não seja
    // duplicidade, a linha não existe e os bytes ficavam sem dono.
    //
    // E não eram poucos para sempre: o varredor de mídia só apaga o que está
    // ligado a uma linha, e a retenção padrão é 0 — nunca apaga. Numa
    // instalação padrão esses arquivos ficavam no disco para sempre.
    //
    // O caso do evento REPETIDO não vaza, e vale dizer por quê: ele produz o
    // mesmo nome de arquivo — mesmo `externalId`, mesma conversa —, então a
    // segunda passagem sobrescreve a primeira em vez de deixar um segundo
    // arquivo. A limpeza cobre os dois ramos mesmo assim, porque depender
    // dessa coincidência de nome é depender de algo que ninguém prometeu.
    const { default: WaMediaService } = await import('../src/services/waMediaService.js');
    const real = WaMediaService.armazenar;
    let gravadoEm = null;

    // Envolve o armazenamento só para saber ONDE o arquivo foi parar.
    WaMediaService.armazenar = async (args) => {
      const r = await real.call(WaMediaService, args);
      if (r?.attachment_path) gravadoEm = path.join(DATA_DIR, r.attachment_path);
      return r;
    };
    // E o insert falha com um erro que NÃO é violação de unicidade.
    const db = getDb();
    const insertReal = db.client.query.bind(db.client);
    let derrubar = true;
    db.client.query = (connection, obj) => {
      // O dialeto cita identificador de jeitos diferentes — crase no SQLite e
      // no MySQL, aspas duplas no Postgres —, então a peneira olha a forma e
      // não a pontuação.
      if (derrubar && /^insert into ["`]?wa_messages["`]?/i.test(String(obj?.sql || ''))) {
        derrubar = false;
        return Promise.reject(new Error('disco cheio'));
      }
      return insertReal(connection, obj);
    };

    try {
      await hook(eventoV2({
        id: 'V2-MIDIA-SEM-LINHA',
        remoteJid: '5593977774444@s.whatsapp.net',
        message: {
          imageMessage: { mimetype: 'image/png', caption: 'sem linha' },
          base64: PNG_BASE64
        }
      }));
    } catch {
      /* o webhook responde 500; o que importa é o disco */
    } finally {
      WaMediaService.armazenar = real;
      db.client.query = insertReal;
    }

    assert.ok(gravadoEm, 'o anexo nem chegou a ser gravado; o caso não mede nada');
    assert.equal(await mensagemPorId('V2-MIDIA-SEM-LINHA'), null, 'a linha não devia existir');
    assert.equal(fs.existsSync(gravadoEm), false, 'os bytes ficaram no disco sem dono');
  });

  it('um lote que estoura o orçamento para na borda, sem deixar gravação pela metade', async () => {
    // Cada item pode gastar 90 s baixando mídia, e o teto de cinquenta limita o
    // TAMANHO do lote, não o tempo. Cinquenta em série chegam a ~87 minutos com
    // o handler preso — e o Evolution, ao estourar o prazo dele, reentrega o
    // mesmo lote e multiplica os handlers presos.
    const real = Date.now;
    let agora = real.call(Date);
    // O relógio anda 60 s a cada consulta: o orçamento (120 s) estoura na
    // terceira conferência, que acontece ANTES do terceiro item.
    Date.now = () => { agora += 60_000; return agora; };
    try {
      const { status, body } = await call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, {
        method: 'POST',
        body: {
          event: 'messages.upsert',
          instance: INSTANCE,
          data: ['A', 'B', 'C', 'D'].map((sufixo) => ({
            key: { remoteJid: '5593966665555@s.whatsapp.net', fromMe: false, id: `LOTE-${sufixo}` },
            pushName: 'Cliente',
            message: { conversation: `item ${sufixo}` },
            messageType: 'conversation',
            messageTimestamp: 1739990000
          }))
        }
      });
      assert.equal(status, 200);
      // O corpo CONTA o que ficou de fora: sem isso, um lote cortado pela
      // metade e um lote inteiro respondem exatamente a mesma coisa.
      assert.ok(body.dropped > 0, 'o orçamento não cortou nada');
      assert.ok(body.stored > 0, 'nem sequer o primeiro item entrou');
    } finally {
      Date.now = real;
    }

    // O corte é na BORDA entre dois itens: o que entrou, entrou inteiro.
    assert.ok(await mensagemPorId('LOTE-A'));
    assert.equal(await mensagemPorId('LOTE-D'), null);
  });
});

/**
 * O eco de uma mensagem que saiu DAQUI não vira uma segunda bolha.
 *
 * O servidor ecoa toda mensagem enviada como evento de entrada. Enquanto a
 * confirmação de saída não grava o `external_id` na linha do operador, o eco
 * não tinha como se reconhecer — a única deduplicação de entrada é por
 * `external_id`, e a linha do operador está justamente com ele nulo. Então o
 * eco inseria linha nova, e a conversa ficava com DUAS bolhas iguais.
 *
 * Para quem lê a tela isso é o cliente ter recebido a mensagem duas vezes: o
 * oposto exato do que o tratamento de unicidade no worker existe para evitar.
 * E a linha do operador, sem `external_id`, ficava fora do alcance de todo
 * recibo — congelada em "enviada" para sempre.
 */
describe('o eco de uma mensagem nossa adota a linha que já existe', () => {
  /** Um número por caso: os três compartilhariam a mesma conversa. */
  const REMOTE = (n) => `55119888800${n}@s.whatsapp.net`;

  /** A linha que o painel escreve ao enviar, no instante ANTES da confirmação. */
  async function linhaDeSaida(conversationId, body) {
    await asTenant(() => getDb()('wa_messages').insert({
      tenant_id: 1,
      conversation_id: conversationId,
      direction: 'out',
      body,
      external_id: null,
      delivery_status: 'sent',
      is_note: false,
      created_at: new Date(),
      updated_at: new Date()
    }));
  }

  /**
   * Abre a conversa com uma mensagem de entrada, como o cliente faria.
   *
   * O bot de autoatendimento responde a ela e escreve uma linha 'out' própria —
   * por isso toda asserção abaixo é pelo CORPO da mensagem sob teste, e não por
   * "quantas saídas esta conversa tem".
   */
  async function conversaAberta(id, remoteJid) {
    await hook(eventoV2({ id, remoteJid, texto: 'oi' }));
    return (await conversaDaMensagem(id)).id;
  }

  const saidasCom = (conversationId, body) =>
    mensagens().where({ conversation_id: conversationId, direction: 'out', body });

  it('uma bolha, não duas — e o external_id fica na linha do operador', async () => {
    const conversationId = await conversaAberta('CLIENTE-1', REMOTE(1));
    await linhaDeSaida(conversationId, 'segue o boleto');

    await hook(eventoV2({
      id: 'ECO-1', remoteJid: REMOTE(1), fromMe: true, texto: 'segue o boleto'
    }));

    const saidas = await saidasCom(conversationId, 'segue o boleto');
    assert.equal(saidas.length, 1, 'o eco inseriu uma segunda bolha');
    assert.equal(saidas[0].external_id, 'ECO-1', 'a linha do operador ficou sem o id');
  });

  it('e por isso o recibo encontra a linha do operador', async () => {
    const conversationId = await conversaAberta('CLIENTE-2', REMOTE(2));
    await linhaDeSaida(conversationId, 'já está a caminho');
    await hook(eventoV2({
      id: 'ECO-2', remoteJid: REMOTE(2), fromMe: true, texto: 'já está a caminho'
    }));

    await hook({
      event: 'messages.update',
      instance: INSTANCE,
      data: { keyId: 'ECO-2', key: { id: 'ECO-2', remoteJid: REMOTE(2), fromMe: true }, status: 'READ' }
    });

    const [saida] = await saidasCom(conversationId, 'já está a caminho');
    assert.equal(saida.delivery_status, 'read', 'o recibo não alcançou a linha do operador');
  });

  it('mas o eco de uma mensagem mandada do CELULAR continua entrando', async () => {
    // O controle. Sem nada para adotar, o eco é a única notícia que o painel
    // tem de que o provedor respondeu por fora — e some se a adoção for ampla
    // demais.
    const conversationId = await conversaAberta('CLIENTE-3', REMOTE(3));

    await hook(eventoV2({
      id: 'ECO-3', remoteJid: REMOTE(3), fromMe: true, texto: 'respondi pelo celular'
    }));

    const saidas = await saidasCom(conversationId, 'respondi pelo celular');
    assert.equal(saidas.length, 1, 'o eco do celular deixou de entrar');
    assert.equal(saidas[0].external_id, 'ECO-3');
  });
});
