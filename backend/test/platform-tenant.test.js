import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A linha da plataforma: um provedor que NÃO é cliente.
 *
 * Ela existe por uma razão estrutural. Toda tabela de WhatsApp tem `tenant_id`
 * NOT NULL com chave estrangeira para `tenants`, e a sessão do console nasce
 * sem provedor de propósito — então, sem uma linha dona, o console não pode ter
 * caixa de mensagem nenhuma. Dar uma a ele não custa schema novo: o webhook do
 * Evolution já acha o dono pelo nome da instância, e `forEachTenant` já drena a
 * fila de quem existe.
 *
 * O trabalho todo está do outro lado, e é o que este arquivo guarda: essa linha
 * não pode ser CONFUNDIDA com um cliente. Cada caso abaixo é um lugar onde a
 * confusão apareceria, e três deles seriam silenciosos.
 *
 * SaaS, porque é a edição em que o console existe.
 */
process.env.EDITION = 'saas';

const {
  call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { seedDefaults } = await import('../src/config/seed.js');
const { forEachTenant } = await import('../src/config/tenantJobs.js');
const { default: ChargeIssuingService } = await import('../src/services/chargeIssuingService.js');
const { default: SubscriptionNoticeService } = await import('../src/services/subscriptionNoticeService.js');
const { resolveDefaultTenantId } = await import('../src/middleware/tenantResolver.js');
const { slugProblem } = await import('../src/utils/slug.js');

let panelUrl;
let alfa;
let caixa;

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();
  caixa = await Tenant.create({ slug: 'plataforma', name: 'Plataforma', kind: 'platform' });
});

after(async () => {
  await stopTestServers();
});

describe('o que a linha da plataforma não é', () => {
  it('não entra na lista de provedores', async () => {
    const provedores = await Tenant.list();
    const ids = provedores.map((t) => Number(t.id));
    assert.ok(ids.includes(Number(alfa)));
    assert.equal(ids.includes(Number(caixa)), false);
  });

  /**
   * O mais fácil de errar de todos, e o único que se vê sem estar logado.
   *
   * O único chamador de `Tenant.count()` é o perfil público, que esconde o nome
   * do provedor quando há MAIS DE UM cliente no mesmo endereço. Contar a caixa
   * faria um deploy de um provedor só perder a marca dele na tela de login — um
   * defeito que nenhuma tela de erro mostraria.
   */
  it('não conta na pergunta que decide a marca da tela de login', async () => {
    assert.equal(await Tenant.count(), 1);

    const perfil = await call(`${panelUrl}/api/tenant/public`);
    assert.equal(perfil.status, 200);
    assert.equal(perfil.body.data.shared, false, 'um provedor só continua sendo um provedor só');
    assert.ok(perfil.body.data.name, 'e o nome dele continua na tela');
  });

  it('não recebe cobrança emitida', async () => {
    const resultado = await runInTenant(caixa, () => ChargeIssuingService.issueCurrent({
      tenant: { id: caixa, kind: 'platform', billing_gateway: 'asaas', billing_customer_ref: 'cus_0001' }
    }));
    assert.equal(resultado.issued, false);
    assert.equal(resultado.reason, 'platform_tenant', 'a recusa tem que ser POR ser a plataforma');
  });

  it('nem aviso de vencimento', async () => {
    const resultado = await runInTenant(caixa, () => SubscriptionNoticeService.notifyCurrent({
      tenant: { id: caixa, kind: 'platform' }
    }));
    assert.equal(resultado.sent, false);
  });

  /**
   * Onde o host não nomeia provedor, esta função responde "de quem é o painel
   * deste endereço". A caixa não é o painel de ninguém — sem o filtro, um
   * deploy que perdesse os provedores passaria a servi-la a toda requisição.
   */
  it('não é o provedor padrão de um host que não nomeia ninguém', async () => {
    assert.equal(await resolveDefaultTenantId(), alfa);
  });

  it('e o endereço dela não pode ser cadastrado por um ISP', () => {
    assert.ok(slugProblem('plataforma'), 'plataforma tinha que estar reservado');
    assert.ok(slugProblem('platform'), 'platform também');
  });
});

/**
 * O outro lado, e é o que faz a abordagem inteira valer: NADA no subsistema de
 * WhatsApp muda. Se os jobs deixassem de visitar a caixa, a fila de envio dela
 * nunca drenaria — a plataforma teria uma caixa que não fala.
 */
describe('mas continua sendo um provedor para quem trabalha', () => {
  it('os jobs visitam a caixa como visitam qualquer provedor ativo', async () => {
    const visitados = [];
    await forEachTenant((tenant) => visitados.push(Number(tenant.id)));
    assert.ok(visitados.includes(Number(caixa)), 'sem esta visita a fila de envio dela não drena');
    assert.ok(visitados.includes(Number(alfa)));
  });

  /**
   * Um teste VENCE, e vencido o provedor fica em modo de leitura. Na caixa com
   * que a plataforma atende os clientes, isso é parar de responder a eles num
   * dia que ninguém marcou — e o sintoma seria "o WhatsApp não envia mais",
   * com a causa a três tabelas de distância.
   *
   * Pelo seed, que é o caminho que o script de criação usa: é o seed que decide
   * em que plano um provedor nasce, e a regra tem que morar lá, não no script.
   */
  it('e nasce com assinatura que não vence, para a caixa não parar sozinha', async () => {
    const nova = await Tenant.create({ slug: 'plataforma-2', name: 'Plataforma 2', kind: 'platform' });
    await seedDefaults(getDb(), { tenantIds: [nova] });

    const assinatura = await getDb()('subscriptions').where({ tenant_id: nova }).first();
    assert.ok(assinatura, 'sem assinatura o portão responde `subscription_missing` e trava a caixa');
    assert.equal(assinatura.status, 'active');
    assert.equal(assinatura.trial_ends_at ?? null, null, 'um teste vence, e vencido a caixa para');
    assert.equal(assinatura.renews_at ?? null, null, 'nulo é o valor que nunca vence');

    // E o contraste, que é o que prova que a regra é sobre o `kind` e não sobre
    // ser o provedor mais novo: um cliente criado pelo mesmo seed nasce em teste.
    const cliente = await Tenant.create({ slug: 'gama', name: 'Gama' });
    await seedDefaults(getDb(), { tenantIds: [cliente] });
    const doCliente = await getDb()('subscriptions').where({ tenant_id: cliente }).first();
    assert.equal(doCliente.status, 'trial');
    assert.ok(doCliente.trial_ends_at, 'e com prazo');
  });
});

describe('o console mostra a caixa à parte da lista', () => {
  it('`Tenant.platform()` acha a linha, e `every()` devolve as duas', async () => {
    const achada = await Tenant.platform();
    assert.equal(Number(achada?.id), Number(caixa));

    const todas = (await Tenant.every()).map((t) => Number(t.id));
    assert.ok(todas.includes(Number(alfa)) && todas.includes(Number(caixa)));
  });

  it('e `create` recusa um tipo que não existe', async () => {
    await assert.rejects(
      () => Tenant.create({ slug: 'zeta', name: 'Zeta', kind: 'cliente-vip' }),
      /Unknown tenant kind/
    );
  });
});
