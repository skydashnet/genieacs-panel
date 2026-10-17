import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { prepararFio } = await import('../src/services/waAiService.js');

const u = (content) => ({ role: 'user', content });
const a = (content) => ({ role: 'assistant', content });

describe('prepararFio: a forma que a z.ai aceita', () => {
  it('uma conversa normal passa como está', () => {
    assert.deepEqual(prepararFio([u('oi'), a('olá'), u('minha fatura')]), [u('oi'), a('olá'), u('minha fatura')]);
  });

  it('junta turnos seguidos do mesmo papel', () => {
    assert.deepEqual(prepararFio([u('oi'), u('tem alguém?'), a('sim'), a('diga')]).length, 0, 'termina em assistant: vazio');
    assert.deepEqual(prepararFio([u('oi'), u('tem alguém?')]), [u('oi\ntem alguém?')]);
  });

  it('descarta o que a equipe disse antes do primeiro "user"', () => {
    assert.deepEqual(prepararFio([a('sua fatura vence'), a('segue o boleto'), u('paguei')]), [u('paguei')]);
  });

  it('ignora turnos vazios', () => {
    assert.deepEqual(prepararFio([u('  '), u('oi'), a('')]), [u('oi')]);
  });

  it('sem cliente para responder, devolve vazio (o bot de menu segue)', () => {
    assert.deepEqual(prepararFio([a('sua fatura vence')]), []);
    assert.deepEqual(prepararFio([]), []);
  });

  it('o rascunho fecha com a instrução, acrescentada ou colada ao último "user"', () => {
    assert.deepEqual(prepararFio([a('sua fatura vence')], { fecharComUsuario: 'Escreva.' }), [u('Escreva.')]);
    assert.deepEqual(prepararFio([u('oi'), a('olá')], { fecharComUsuario: 'Escreva.' }), [u('oi'), a('olá'), u('Escreva.')]);
    assert.deepEqual(prepararFio([u('oi')], { fecharComUsuario: 'Escreva.' }), [u('oi\n\nEscreva.')]);
  });
});
