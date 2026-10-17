import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Edição declarada em vez de herdada do `.env` do desenvolvedor: nada aqui
// depende dela — um prazo é um prazo nas duas — mas `resolveTarget` consulta
// `IS_SAAS` para decidir portas e faixas privadas, e um arquivo que muda de
// comportamento conforme a máquina é um arquivo que um dia falha sozinho.
process.env.EDITION = 'selfhosted';

const { PinnedTransport } = await import('../src/utils/net/pinnedFetch.js');
const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
const { default: SgpService } = await import('../src/services/sgpService.js');

/**
 * O prazo tem de cobrir a RESOLUÇÃO DO NOME, e não só a requisição.
 *
 * `wa-outbound-limits.test.js` já afirma isso para o `safeFetch`, e é de lá que
 * a propriedade vem. Estes dois caminhos nasceram do mesmo refactor e ficaram
 * sem ela: `sgpFetch` e `GenieAcsEgress.resolveTarget` tinham o sinal na mão,
 * entregavam-no à requisição e não à resolução que vem antes dela.
 *
 * O que isso custava: um resolvedor que aceita a consulta e nunca responde
 * prende quem chamou exatamente como um servidor que nunca responde — mesma
 * espera, mesmo handler ocupado — só que um passo antes de existir socket para
 * o prazo abortar. Medido antes da correção, uma chamada ao SGP com limite de
 * 15 s ainda estava presa aos 17 s. Na edição SaaS o `baseUrl` do SGP é
 * escolhido pelo administrador do provedor, e por ali passam as consultas de
 * fatura do portal e o job de reconciliação.
 *
 * O dublê é um resolvedor que nunca responde. Nenhum socket é aberto em teste
 * nenhum daqui: `PinnedTransport.request` é substituído e cada caso afirma que
 * ele NÃO foi chamado, que é o que separa "o prazo encerrou a espera pelo nome"
 * de "o prazo encerrou a requisição que veio depois".
 */
const lookupReal = PinnedTransport.lookup;
const requestReal = PinnedTransport.request;
const egressLookupReal = GenieAcsEgress.lookup;
const sgpTimeoutReal = SgpService.REQUEST_TIMEOUT_MS;

/**
 * O resultado da chamada, ou o aviso de que ela seguiu presa.
 *
 * Sem isto a falha aparece como `cancelled` e não como asserção: a chamada
 * nunca se resolve, o `node:test` drena o loop e cancela o que está pendente,
 * e o relatório não diz uma palavra sobre o que se esperava. A margem é larga
 * de propósito — os prazos aqui são de dezenas de milissegundos e o que se mede
 * é a diferença entre "acabou" e "não acaba nunca", não a pontualidade.
 */
async function dentroDe(margemMs, chamada) {
  let solta;
  const relogio = new Promise((resolve) => { solta = setTimeout(() => resolve(PRESO), margemMs); });
  try {
    return await Promise.race([chamada.then((valor) => ({ valor }), (erro) => erro), relogio]);
  } finally {
    clearTimeout(solta);
  }
}

const PRESO = Symbol('a chamada seguiu presa depois do prazo');

/** Aceita a consulta e nunca responde. */
function resolvedorMudo() {
  PinnedTransport.lookup = () => new Promise(() => {});
  GenieAcsEgress.lookup = () => new Promise(() => {});
  let abriuSocket = false;
  PinnedTransport.request = () => {
    abriuSocket = true;
    return Promise.resolve(new Response('ok', { status: 200 }));
  };
  return () => abriuSocket;
}

afterEach(() => {
  PinnedTransport.lookup = lookupReal;
  PinnedTransport.request = requestReal;
  GenieAcsEgress.lookup = egressLookupReal;
  SgpService.REQUEST_TIMEOUT_MS = sgpTimeoutReal;
});

describe('o prazo de uma chamada ao GenieACS', () => {
  // Um NOME e não um literal: um literal é o seu próprio endereço, o dublê nem
  // seria consultado, e o teste passaria afirmando coisa nenhuma.
  const ACS = 'http://acs.provedor.test:7557/devices';

  test('encerra a espera por um nome que não resolve, sem abrir socket', async () => {
    const abriuSocket = resolvedorMudo();
    // A folga segura o loop de eventos: sem ela o `node:test` drena, cancela o
    // que está pendente e a falha aparece como "cancelled", nunca como uma
    // asserção quebrada — que é o jeito mais difícil de ler esta falha.
    const fim = await dentroDe(2_000, GenieAcsEgress.fetch(ACS, { signal: AbortSignal.timeout(60) }));

    assert.notEqual(fim, PRESO, 'a chamada seguiu presa: o prazo não alcança a resolução do nome');
    // O prazo é o motivo de a chamada acabar. Uma consulta abandonada não
    // devolve endereço nenhum, e chamar isso de "não resolveu para endereço
    // nenhum" seria uma frase sobre DNS para um problema de relógio.
    assert.equal(fim.name, 'TimeoutError');
    assert.equal(abriuSocket(), false, 'nada pode ter chegado ao socket');
  });

  test('respeita o cancelamento de quem chamou, e não só o relógio', async () => {
    const abriuSocket = resolvedorMudo();
    const controle = new AbortController();
    setTimeout(() => controle.abort(new Error('o operador fechou a tela')), 40);

    const fim = await dentroDe(2_000, GenieAcsEgress.fetch(ACS, { signal: controle.signal }));

    assert.notEqual(fim, PRESO, 'a chamada seguiu presa depois do cancelamento');
    assert.equal(fim.message, 'o operador fechou a tela');
    assert.equal(abriuSocket(), false);
  });
});

describe('o prazo de uma chamada ao SGP', () => {
  const CONFIG = {
    enabled: true,
    baseUrl: 'https://sgp.provedor.test',
    app: 'app-de-teste',
    token: 'token-de-teste',
    endpoints: { customer: '/api/ura/consultacliente/' },
    linkMode: 'auto'
  };

  test('encerra a espera por um nome que não resolve, sem abrir socket', async () => {
    const abriuSocket = resolvedorMudo();
    // O limite é lido por `this` justamente para isto: a propriedade é sobre o
    // prazo cobrir a resolução, não sobre quanto ele vale, e esperar os 15 s
    // reais só tornaria a suíte quinze segundos mais lenta.
    SgpService.REQUEST_TIMEOUT_MS = 60;
    const fim = await dentroDe(2_000, SgpService.request('customer', { cpfcnpj: '0' }, CONFIG));

    assert.notEqual(fim, PRESO, 'a chamada seguiu presa: o prazo não alcança a resolução do nome');
    // `timeout` e não `unreachable`: o operador tem de ler que o tempo acabou,
    // que é o que aconteceu.
    assert.equal(fim.code, 'timeout');
    assert.equal(fim.translationKey, 'sgp.error.timeout');
    assert.equal(abriuSocket(), false, 'nada pode ter chegado ao socket');
  });

  // O contrário do caso acima, e o que impede que ele passe por preguiça: com o
  // resolvedor respondendo, a chamada tem de seguir até o transporte.
  test('deixa passar quando o nome resolve dentro do prazo', async () => {
    PinnedTransport.lookup = async () => [{ address: '203.0.113.10', family: 4 }];
    let chegou = null;
    PinnedTransport.request = (opcoes) => {
      chegou = opcoes;
      return Promise.resolve(new Response(JSON.stringify({ contratos: [] }), { status: 200 }));
    };

    await SgpService.request('customer', { cpfcnpj: '00000000000' }, CONFIG);
    assert.equal(chegou.method, 'POST');
    assert.deepEqual(chegou.addresses, [{ address: '203.0.113.10', family: 4 }]);
    assert.ok(chegou.signal, 'a requisição segue sob o mesmo sinal');
  });
});
