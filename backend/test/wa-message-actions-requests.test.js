import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deleteMessageRequest, sendReactionRequest, sendTextRequest } from '../src/utils/wa/evolutionApi.js';

describe('as requisições de reação, exclusão e citação', () => {
  const jid = '5593981110001@s.whatsapp.net';

  it('Evolution v2: reação pela chave da mensagem e exclusão para todos', () => {
    const reacao = sendReactionRequest('v2', 'suporte', { remoteJid: jid, id: 'ABC', fromMe: false, reaction: '❤️' });
    assert.equal(reacao.path, '/message/sendReaction/suporte');
    assert.deepEqual(reacao.body, { key: { remoteJid: jid, fromMe: false, id: 'ABC' }, reaction: '❤️' });

    const apagar = deleteMessageRequest('v2', 'suporte', { remoteJid: jid, id: 'ABC' });
    assert.equal(apagar.method, 'DELETE');
    assert.equal(apagar.path, '/chat/deleteMessageForEveryone/suporte');
    assert.deepEqual(apagar.body, { id: 'ABC', remoteJid: jid, fromMe: true });
  });

  it('Evolution GO: rotas sem nome da instância', () => {
    const reacao = sendReactionRequest('go', 'suporte', { remoteJid: jid, id: 'ABC', fromMe: true, reaction: '👍' });
    assert.equal(reacao.path, '/message/react');
    assert.deepEqual(reacao.body, { number: jid, id: 'ABC', fromMe: true, reaction: '👍' });

    const apagar = deleteMessageRequest('go', 'suporte', { remoteJid: jid, id: 'ABC' });
    assert.equal(apagar.path, '/message/delete');
    assert.deepEqual(apagar.body, { chat: jid, messageId: 'ABC' });
  });

  it('a citação só entra no corpo do texto quando há id', () => {
    assert.equal(sendTextRequest('v2', 'n', '55', 'oi').body.quoted, undefined);
    assert.deepEqual(sendTextRequest('v2', 'n', '55', 'oi', 'X').body.quoted, { key: { id: 'X' } });
    assert.deepEqual(sendTextRequest('go', 'n', '55', 'oi', 'X').body.quoted, { messageId: 'X' });
  });
});
