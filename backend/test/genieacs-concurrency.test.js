import { afterEach, before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { getDb, runInTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const {
  GLOBAL_LIMIT, TENANT_LIMIT, inFlightForTenant, resetAcsConcurrency, withAcsSlot
} = await import('../src/services/genieacs/concurrency.js');
const { default: GenieAcsDirect } = await import('../src/services/genieacs/direct.js');
const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
const { default: Setting } = await import('../src/models/Setting.js');

/**
 * The ceiling on ACS requests in flight — item 8 of the checklist.
 *
 * The dashboard read fetches a provider's whole device collection, and with
 * dozens of providers in one process the failure is not a slow dashboard: it is
 * every provider's request queued behind one provider's fleet. The per-provider
 * cap is what isolates; the global one keeps sockets and heap bounded.
 */
let alfa;
let beta;

before(async () => {
  await startTestServers();
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
});

after(async () => {
  await stopTestServers();
});

afterEach(() => {
  resetAcsConcurrency();
});

describe('the ceiling on ACS requests in flight', () => {
  it('has a per-provider cap below the global one', () => {
    assert.ok(TENANT_LIMIT > 0);
    assert.ok(GLOBAL_LIMIT >= TENANT_LIMIT);
  });

  it('holds one provider to its own cap', async () => {
    let peak = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });

    const started = [];
    const runs = Array.from({ length: TENANT_LIMIT + 3 }, () => runInTenant(alfa, () => withAcsSlot(async () => {
      peak = Math.max(peak, await runInTenant(alfa, () => inFlightForTenant()));
      started.push(1);
      await held;
    })));

    // Long enough for every runnable slot to be taken; the ones over the cap
    // cannot start at all, which is the assertion.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, TENANT_LIMIT);
    release();
    await Promise.all(runs);
    assert.equal(peak, TENANT_LIMIT);
  });

  it('does not let one provider\'s queue stall another', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });

    // A provider with a slow ACS fills its own cap and queues the rest. The
    // failure this guards against is the whole panel queueing behind it — which
    // is exactly what one shared ceiling, or none, produces.
    const busy = Array.from({ length: TENANT_LIMIT * 2 }, () =>
      runInTenant(alfa, () => withAcsSlot(() => held)));

    let served = false;
    await runInTenant(beta, () => withAcsSlot(async () => { served = true; }));

    assert.equal(served, true);
    release();
    await Promise.all(busy);
  });

  it('gives the slot back when the request throws', async () => {
    await assert.rejects(
      runInTenant(alfa, () => withAcsSlot(() => { throw new Error('upstream is down'); })),
      /upstream is down/
    );

    // A slot leaked on failure is worse than no ceiling: an ACS that is failing
    // is exactly the one whose provider retries, so the cap would fill with
    // nothing and the provider would be locked out of its own panel.
    assert.equal(await runInTenant(alfa, () => inFlightForTenant()), 0);
  });

  it('refuses to hand out a slot to nobody', async () => {
    // Outside a provider scope there is no bucket to charge, and charging the
    // global one alone would let a scope-less caller bypass every per-provider
    // cap. The tenant context already throws here; this pins that the ceiling
    // does not soften it.
    await assert.rejects(() => withAcsSlot(async () => 'ran'));
  });
});

/**
 * O prazo mede a requisição, e não a espera por uma vaga.
 *
 * O `AbortController` era armado no topo de `DirectConnector.request` e a vaga
 * só era pedida no fim, no `withAcsSlot` — mas a fila de concorrência espera
 * sem prazo nenhum. Com seis vagas por provedor e uma varredura de frota
 * segurando as suas por segundos, a sétima requisição gastava os 15 s inteiros
 * ESPERANDO e morria sem nunca ter aberto socket.
 *
 * E morria de forma indistinguível: nada no caminho separa um `AbortError` de
 * fila de um ACS mudo, então o operador lia "o ACS não respondeu" sobre um ACS
 * a quem ninguém tinha perguntado nada.
 */
describe('o prazo não corre na fila', () => {
  it('a requisição que esperou vaga sai com o prazo inteiro', async () => {
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', 'http://acs.exemplo.test:7557'));

    const fetchReal = GenieAcsEgress.fetch;
    let abortadaAoChegar = null;
    GenieAcsEgress.fetch = async (_url, options) => {
      // A asserção inteira está aqui: se o prazo tivesse sido armado antes da
      // vaga, ele teria estourado durante a espera e o sinal chegaria abortado.
      abortadaAoChegar = options.signal.aborted;
      return new Response('[]', { status: 200 });
    };

    let liberar;
    const presas = new Promise((resolve) => { liberar = resolve; });
    const ocupando = Array.from({ length: TENANT_LIMIT }, () =>
      runInTenant(alfa, () => withAcsSlot(() => presas)));

    try {
      // Todas as vagas tomadas antes de a requisição sob teste pedir a dela.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await runInTenant(alfa, () => inFlightForTenant()), TENANT_LIMIT);

      // O prazo precisa cobrir o que roda DENTRO da janela cronometrada, e não
      // só a chamada ao ACS: `direct.js` arma o timer, lê a credencial da NBI
      // (`nbiHeaders` → `getConfig`, que no cache frio vai ao banco) e só então
      // chama o egresso. Com 40 ms, uma ida ao banco num runner carregado
      // estourava o prazo e o teste reprovava o código certo — foi o que
      // derrubou o `Backend on mysql` num PR que não tocava em aplicação.
      // Margem grande não afrouxa nada: a espera abaixo continua sendo o dobro
      // do prazo, então o bug antigo (timer armado antes da vaga) continua
      // sendo pego.
      const PRAZO_MS = 1000;
      const pedido = runInTenant(alfa, () => GenieAcsDirect.request('devices', { timeoutMs: PRAZO_MS }));

      // Esperar MAIS que o prazo com a fila cheia: é a janela em que o prazo
      // antigo era consumido sem que nada tivesse acontecido.
      await new Promise((resolve) => setTimeout(resolve, PRAZO_MS * 2));
      assert.equal(abortadaAoChegar, null, 'a requisição não deveria ter saído ainda');

      liberar();
      const resposta = await pedido;

      assert.equal(abortadaAoChegar, false, 'o prazo foi gasto na fila');
      assert.equal(resposta.status, 200);
    } finally {
      liberar();
      GenieAcsEgress.fetch = fetchReal;
      await Promise.all(ocupando);
    }
  });
});
