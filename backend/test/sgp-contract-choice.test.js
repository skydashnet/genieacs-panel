import { after, before, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');

/**
 * Um contrato escolhido a mão não é substituído por outro em silêncio.
 *
 * O ERP responde com o CLIENTE, e um cliente tem mais de um contrato: a casa e
 * o comércio, o link novo e o antigo que ainda não foi cancelado. `pickContract`
 * existe para escolher entre eles quando ninguém escolheu — e a escolha dele é
 * um palpite razoável, o primeiro não bloqueado. O defeito era usar o mesmo
 * palpite QUANDO ALGUÉM JÁ TINHA ESCOLHIDO: o operador digitava um contrato, o
 * SGP não devolvia aquele, e o painel vinculava outro respondendo "contrato
 * vinculado" com um número diferente do pedido na tela.
 *
 * O que isso custa não é cosmético. O vínculo é o que o provisionamento lê para
 * decidir VLAN e PPPoE, então a ONT de um assinante entra com os dados do
 * contrato do vizinho — e o registro do painel concorda com o erro, porque foi
 * ele que o gravou.
 */

const DEVICE = 'ont-da-escolha';

// O cliente tem dois. O 4321 é o que `pickContract` escolheria sozinho — está
// ativo e desbloqueado —, e é por isso que ele é o dublê perfeito do erro: toda
// substituição errada cai nele.
const CONTRATOS = [
  {
    contrato: 4321,
    contratoStatus: 1,
    contratoStatusDisplay: 'Ativo',
    planoInternet: 'Fibra 500MB',
    login: 'casa@provedor',
    bloqueado: false
  },
  {
    contrato: 9999,
    contratoStatus: 2,
    contratoStatusDisplay: 'Bloqueado',
    planoInternet: 'Fibra 300MB',
    login: 'comercio@provedor',
    bloqueado: true
  }
];

const CONFIG = {
  enabled: true,
  baseUrl: 'https://sgp.provedor.test',
  app: 'painel',
  token: 'token',
  endpoints: { customer: '/api/ura/consultacliente/' },
  linkMode: 'auto'
};

const getConfigReal = SgpService.getConfig;
const requestReal = SgpService.request;
let consultas = [];

function stubSgp(contratos = CONTRATOS) {
  consultas = [];
  SgpService.getConfig = async () => ({ ...CONFIG });
  // O dublê fica no transporte e não em `lookupCustomer`, para que
  // `normalizeContract` rode de verdade: é ele quem transforma `contrato: 4321`
  // no texto '4321' que a comparação usa, e um teste que o pule estaria
  // afirmando sobre uma forma de dado que o código nunca vê.
  SgpService.request = async (endpoint, payload) => {
    consultas.push({ endpoint, payload });
    return { status: 1, contratos };
  };
}

let panelUrl;

before(async () => {
  ({ panelUrl } = await startTestServers());
  assert.ok(panelUrl);
});

afterEach(async () => {
  SgpService.getConfig = getConfigReal;
  SgpService.request = requestReal;
  await asTenant(() => SgpLink.deleteByDeviceId(DEVICE));
});

after(async () => {
  await stopTestServers();
});

describe('o operador escolhe o contrato', () => {
  it('vincula exatamente o que foi pedido, mesmo bloqueado', async () => {
    stubSgp();
    const link = await asTenant(() => SgpService.linkDevice(DEVICE, { contract: '9999' }));
    // 9999 está bloqueado e 4321 não: se a escolha fosse um palpite, este é o
    // caso em que ele erraria.
    assert.equal(link.contract, '9999');
    assert.equal(link.link_mode, 'manual');
  });

  it('recusa quando o contrato pedido não está entre os que o SGP devolveu', async () => {
    stubSgp();
    await assert.rejects(
      () => asTenant(() => SgpService.linkDevice(DEVICE, { contract: '5555' })),
      (error) => error.translationKey === 'sgp.error.contractNotFound' && error.status === 404
    );
    // E não vincula nada. Um vínculo escrito aqui seria o vínculo errado, e o
    // provisionamento o leria como se fosse o certo.
    assert.ok(!(await asTenant(() => SgpLink.getByDeviceId(DEVICE))), 'nenhum vínculo pode ter sido gravado');
  });

  // O outro lado da regra: sem contrato escolhido, a busca é por documento e a
  // escolha É do painel. Sem este caso, a correção poderia ser "nunca escolher",
  // que quebraria o fluxo de vincular a partir de uma busca.
  it('ainda escolhe sozinho quando ninguém escolheu', async () => {
    stubSgp();
    const link = await asTenant(() => SgpService.linkDevice(DEVICE, { document: '12345678909' }));
    assert.equal(link.contract, '4321', 'o primeiro não bloqueado');
  });
});

describe('um vínculo manual já gravado', () => {
  /**
   * A consulta manual é FILTRADA pelo contrato, e mesmo assim o ERP responde
   * com o cliente inteiro. Era o `pickContract` no meio desse caminho que
   * re-apontava o vínculo a cada refresh — não numa ação do operador, mas
   * sozinho, sempre que o cache vencia.
   */
  it('não é re-apontado quando o contrato some do SGP', async () => {
    stubSgp();
    await asTenant(() => SgpService.linkDevice(DEVICE, { contract: '9999' }));

    // O 9999 sai do ar — cancelado, migrado, o que for — e o SGP passa a
    // responder só com o outro contrato do mesmo cliente.
    stubSgp([CONTRATOS[0]]);
    const { link, source } = await asTenant(
      () => SgpService.resolveDeviceContract(DEVICE, { refresh: true })
    );

    assert.equal(link.contract, '9999', 'o vínculo que o operador fixou continua sendo o dele');
    assert.equal(source, 'cache');
    const gravado = await asTenant(() => SgpLink.getByDeviceId(DEVICE));
    assert.equal(gravado.contract, '9999');
  });

  it('continua sendo atualizado enquanto o contrato existe', async () => {
    stubSgp();
    await asTenant(() => SgpService.linkDevice(DEVICE, { contract: '9999' }));
    await asTenant(() => getDb()('sgp_links').where({ device_id: DEVICE }).update({ plan: 'antigo' }));

    const { link } = await asTenant(
      () => SgpService.resolveDeviceContract(DEVICE, { refresh: true })
    );
    assert.equal(link.contract, '9999');
    assert.equal(link.plan, 'Fibra 300MB', 'os campos do contrato escolhido seguem sendo refrescados');
  });
});
