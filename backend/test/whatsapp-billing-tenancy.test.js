import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaBillingService } = await import('../src/services/waBillingService.js');
const { runInTenant } = await import('../src/config/tenantContext.js');

/**
 * O teto de montagem de campanha, e de quem ele é.
 *
 * `reserveBuild` limita a três montagens por cinco minutos, e o que ele protege
 * é o ERP do provedor: cada destinatário custa uma ida e volta ao SGP. Certo.
 *
 * Errado era a janela ser UMA, num campo de classe compartilhado pelo processo
 * inteiro. O provedor A montava três campanhas e os provedores B, C e D
 * levavam 429 por cinco minutos sem terem feito nada — negação de serviço
 * cruzada, trivial de disparar, num painel que vende isolamento.
 *
 * É a mesma classe de defeito que `config/tenantCache.js` documenta como já
 * corrigida em quatro serviços; este teto ficou de fora daquela passagem, e
 * PRECISA de dois provedores para aparecer. Com um só, a janela compartilhada
 * dá a resposta certa por acidente.
 */
let alfa;
let beta;

before(async () => {
  await startTestServers();
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  beta = await insertReturningId('tenants', {
    slug: 'beta-cobranca', name: 'Provedor Beta', status: 'active'
  });
});

after(async () => {
  await stopTestServers();
});

describe('o teto de montagem de campanha', () => {
  it('gasta a cota de um provedor sem tocar na do vizinho', async () => {
    await runInTenant(alfa, () => WaBillingService.resetBuildWindow());
    await runInTenant(beta, () => WaBillingService.resetBuildWindow());

    // O alfa esgota a dele.
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runInTenant(alfa, () => WaBillingService.reserveBuild());
    }
    assert.throws(
      () => runInTenant(alfa, () => WaBillingService.reserveBuild()),
      /rate|limit/i,
      'o quarto do próprio alfa tinha que ser recusado'
    );

    // E o beta, que não montou nada, continua com as três dele.
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      runInTenant(beta, () => WaBillingService.reserveBuild());
    }
    assert.throws(
      () => runInTenant(beta, () => WaBillingService.reserveBuild()),
      /rate|limit/i,
      'o beta tem cota própria, e ela também acaba'
    );
  });

  it('zerar a janela de um não zera a do outro', async () => {
    await runInTenant(alfa, () => WaBillingService.resetBuildWindow());
    await runInTenant(beta, () => WaBillingService.resetBuildWindow());

    for (let i = 0; i < 3; i += 1) {
      runInTenant(beta, () => WaBillingService.reserveBuild());
    }
    runInTenant(alfa, () => WaBillingService.resetBuildWindow());

    // O beta segue esgotado: a janela dele é dele.
    assert.throws(() => runInTenant(beta, () => WaBillingService.reserveBuild()), /rate|limit/i);
    // E o alfa segue livre.
    runInTenant(alfa, () => WaBillingService.reserveBuild());
  });
});
