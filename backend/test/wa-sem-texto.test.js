import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resumoSemTexto } from '../src/utils/wa/waSemTexto.js';

describe('o balão de uma mensagem sem texto e sem anexo', () => {
  it('reação', () => {
    assert.equal(resumoSemTexto({ reactionMessage: { text: '👍', key: {} } }), 'Reagiu com 👍 a uma mensagem');
    assert.equal(resumoSemTexto({ reactionMessage: { text: '' } }), 'Removeu a reação a uma mensagem');
  });

  it('localização com link do mapa', () => {
    const r = resumoSemTexto({ locationMessage: { degreesLatitude: -2.44, degreesLongitude: -54.7, name: 'Casa' } });
    assert.match(r, /📍 Localização/);
    assert.match(r, /Casa/);
    assert.match(r, /https:\/\/www\.google\.com\/maps\?q=-2\.44,-54\.7/);
  });

  it('contato com o telefone do vCard', () => {
    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Maria\nitem1.TEL;waid=5593991112233:+55 93 99111-2233\nEND:VCARD';
    assert.equal(resumoSemTexto({ contactMessage: { displayName: 'Maria', vcard } }), '👤 Contato: Maria — +55 93 99111-2233');
  });

  it('enquete', () => {
    const r = resumoSemTexto({ pollCreationMessageV3: { name: 'Horário?', options: [{ optionName: 'Manhã' }, { optionName: 'Tarde' }] } });
    assert.equal(r, '📊 Enquete: Horário?\n• Manhã\n• Tarde');
  });

  it('mídia que não baixou diz o que era', () => {
    assert.match(resumoSemTexto({ imageMessage: { mimetype: 'image/jpeg' } }), /^📷 Foto — não foi possível baixar/);
    assert.match(resumoSemTexto({ documentMessage: { fileName: 'boleto.pdf' } }), /^📄 Documento \(boleto\.pdf\)/);
  });

  it('tipo desconhecido fica vazio', () => {
    assert.equal(resumoSemTexto({ algoNovo: {} }), '');
    assert.equal(resumoSemTexto(null), '');
  });
});
