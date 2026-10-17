import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: SubscriptionService, PlanLimitError } = await import('../src/services/subscriptionService.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { default: CustomerService } = await import('../src/services/customerService.js');
const { default: CustomerAccount } = await import('../src/models/CustomerAccount.js');

/**
 * Os limites do plano, nos pontos de escrita que o plano nomeia.
 *
 * Self-hosted de propósito: os limites valem nas duas edições — a migração dá
 * a todo provedor existente um plano sem limite, mas o plano é uma linha e a
 * linha pode ser trocada. O que se prova é que cada ponto de escrita PERGUNTA,
 * e que a resposta é 402 com o número, e não um 500 nem um insert que passou.
 */
let panelUrl;
let alfa;
let ownerToken;
let unlimited;
let tight;

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;

  unlimited = await Plan.findByCode('unlimited');
  assert.ok(unlimited, 'the 0034 backfill plan has to exist');
  tight = await Plan.create({
    code: 'apertado', name: 'Apertado',
    max_operators: 2, max_subscribers: 1, max_devices: 3,
    price_cents: 9900, currency: 'BRL', trial_days: 0, active: true
  });
});

after(async () => {
  await stopTestServers();
});

async function onPlan(plan) {
  await Subscription.upsertForTenant(alfa, { plan_id: plan.id, status: 'active' });
  await SubscriptionService.invalidate(alfa);
}

afterEach(async () => {
  await onPlan(unlimited);
});

const hire = (username) => call(`${panelUrl}/api/users`, {
  method: 'POST',
  headers: authHeaders(ownerToken),
  body: { username, password: `senha-${username}-123`, role: 'viewer', email: `${username}@exemplo.test` }
});

describe('operators', () => {
  it('lets the plan fill up and refuses the one past it, with the number', async () => {
    await onPlan(tight);
    // The owner is one; the plan allows two.
    const second = await hire('segundo');
    assert.equal(second.status, 201);
    const third = await hire('terceiro');
    assert.equal(third.status, 402);
    assert.equal(third.body.code, 'plan_limit_operators');
    assert.equal(third.body.limit, 2);
    assert.equal(third.body.current, 2);
    assert.match(third.body.message, /2/);
    // Refused BEFORE anything was written: no person, no username taken.
    assert.equal(await getDb()('users').where({ username: 'terceiro' }).first(), undefined);
  });

  it('an invite past the limit is refused and stays usable for later', async () => {
    await onPlan(tight);
    // Already two people from the case above (owner + segundo).
    const created = await call(`${panelUrl}/api/invites`, {
      method: 'POST', headers: authHeaders(ownerToken), body: { role: 'viewer', label: 'novato' }
    });
    assert.equal(created.status, 201);
    const token = created.body.data.token;

    const accepted = await call(`${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: 'novato', password: 'senha-novato-123', email: 'novato@exemplo.test' }
    });
    assert.equal(accepted.status, 402);
    assert.equal(accepted.body.code, 'plan_limit_operators');
    const invite = await getDb()('tenant_invites').where({ id: created.body.data.invite.id }).first();
    assert.equal(invite.accepted_at, null, 'the invite must not be consumed by a refusal');
    assert.equal(await getDb()('users').where({ username: 'novato' }).first(), undefined);

    // With room again, the same link works.
    await onPlan(unlimited);
    const retried = await call(`${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: 'novato', password: 'senha-novato-123', email: 'novato@exemplo.test' }
    });
    assert.equal(retried.status, 201);
  });

  it('a plan without a limit never refuses', async () => {
    await onPlan(unlimited);
    await assert.doesNotReject(() => runInTenant(alfa, () => SubscriptionService.assertCanAddOperator()));
  });
});

describe('subscriber accounts', () => {
  const device = (id, pppoe) => ({ _id: id, softwareId: 'V1.0', pppoe });

  afterEach(async () => {
    await getDb()('customer_accounts').where({ tenant_id: alfa }).del();
  });

  it('creates up to the limit in a sync pass, and leaves the rest for a bigger plan', async () => {
    await onPlan(tight); // max_subscribers: 1
    await runInTenant(alfa, () => CustomerService.syncDevices(
      [device('ONT-A', 'ana'), device('ONT-B', 'bruno')], { enabled: true }
    ));
    const rows = await getDb()('customer_accounts').where({ tenant_id: alfa });
    assert.equal(rows.length, 1, 'one fits, the other waits');

    // The pass that could not create it did not fail; the next asks again.
    await onPlan(unlimited);
    await runInTenant(alfa, () => CustomerService.syncDevices(
      [device('ONT-A', 'ana'), device('ONT-B', 'bruno')], { enabled: true }
    ));
    assert.equal((await getDb()('customer_accounts').where({ tenant_id: alfa })).length, 2);
  });

  it('a device that already has an account is never counted against the limit', async () => {
    await onPlan(unlimited);
    await runInTenant(alfa, () => CustomerService.syncDevices([device('ONT-A', 'ana')], { enabled: true }));
    await onPlan(tight); // already at the limit of 1

    // A new subscriber on the same ONT retires one account and opens another:
    // the total does not grow, so the plan has nothing to say about it.
    await runInTenant(alfa, () => CustomerService.syncDevices([device('ONT-A', 'carla')], { enabled: true }));
    const live = await runInTenant(alfa, () => CustomerAccount.getByDeviceId('ONT-A'));
    assert.equal(live.pppoe_username, 'carla');
  });

  // ───────────────────────────────────────────────────────────────────────
  // O teto valia só na varredura de frota
  //
  // `syncDevices` orça a página inteira e respeitava o limite. Mas quem cria
  // conta de verdade é `ensureAccount`, e ele era chamado DIRETO, sem passar
  // por orçamento nenhum, de três lugares: a tela de detalhe de um aparelho, a
  // gravação da data de instalação, e o provisionamento. Um provedor no teto
  // continuava criando conta indefinidamente — bastava abrir a tela de um
  // aparelho que ainda não tivesse uma.
  //
  // `max_subscribers` é o que o plano VENDE. O limite de operadores, no mesmo
  // sistema, sempre esteve nos três pontos certos; era só este que vazava.
  // ───────────────────────────────────────────────────────────────────────
  it('vale também quando `ensureAccount` é chamado direto', async () => {
    await onPlan(unlimited);
    await runInTenant(alfa, () => CustomerService.ensureAccount(device('ONT-A', 'ana')));
    assert.equal((await getDb()('customer_accounts').where({ tenant_id: alfa })).length, 1);

    await onPlan(tight); // max_subscribers: 1, e a vaga já está ocupada

    // O caminho que as três rotas usam. Sem o teto aqui, ele criava.
    const recusada = await runInTenant(alfa, () => CustomerService.ensureAccount(device('ONT-B', 'bruno')));
    assert.equal(recusada, null, 'criou conta acima do teto do plano');
    assert.equal((await getDb()('customer_accounts').where({ tenant_id: alfa })).length, 1);
  });

  it('e uma troca de assinante continua passando, porque a vaga já foi liberada', async () => {
    // O outro lado: recusar isto seria recusar uma troca de ONT por causa do
    // plano, que não é o que o limite vende. E passa sem caso especial nenhum:
    // `retireAccount` desativa a conta antiga antes, e a contagem só olha as
    // vivas — quando a pergunta do teto é feita, a vaga já está livre.
    await onPlan(unlimited);
    await runInTenant(alfa, () => CustomerService.ensureAccount(device('ONT-A', 'ana')));
    await onPlan(tight);

    const nova = await runInTenant(alfa, () => CustomerService.ensureAccount(device('ONT-A', 'carla')));
    assert.ok(nova, 'a troca de assinante foi recusada pelo teto');
    const viva = await runInTenant(alfa, () => CustomerAccount.getByDeviceId('ONT-A'));
    assert.equal(viva.pppoe_username, 'carla');
  });

  it('only live accounts occupy a seat', async () => {
    await onPlan(unlimited);
    await runInTenant(alfa, () => CustomerService.syncDevices([device('ONT-A', 'ana')], { enabled: true }));
    await getDb()('customer_accounts').where({ tenant_id: alfa }).update({ active: false });
    await onPlan(tight);
    assert.equal(await runInTenant(alfa, () => SubscriptionService.remainingSubscribers()), 1);
  });
});

describe('usage against the limits', () => {
  it('reports the three counts, flags what is over, and survives an ACS that will not answer', async () => {
    await onPlan(tight);
    const counted = await runInTenant(alfa, () => SubscriptionService.usage({ countDevices: async () => 7 }));
    assert.equal(counted.limits.devices, 3);
    assert.equal(counted.usage.devices, 7);
    assert.equal(counted.over.devices, true);
    // The cases above may already have filled the operator seats; what is
    // asserted is that the flag agrees with the count, not a fixed value.
    assert.equal(counted.over.operators, counted.usage.operators > 2);
    assert.equal(typeof counted.usage.operators, 'number');
    assert.equal(counted.subscription.plan.code, 'apertado');

    const unreachable = await runInTenant(alfa, () => SubscriptionService.usage({
      countDevices: async () => { throw new Error('ACS down'); }
    }));
    assert.equal(unreachable.usage.devices, null);
    assert.equal(unreachable.over.devices, false);
  });

  it('the provider reads its own through the panel', async () => {
    await onPlan(tight);
    const res = await call(`${panelUrl}/api/tenant/subscription`, { headers: authHeaders(ownerToken) });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.limits.operators, 2);
    assert.equal(res.body.data.subscription.plan.code, 'apertado');
    // No price anywhere: that is the console's business.
    assert.equal(JSON.stringify(res.body).includes('price'), false);
  });
});

describe('the error itself', () => {
  it('carries what the response needs', async () => {
    await onPlan(tight);
    await hire('mais-um'); // fills the plan (owner + segundo already there? depends on order; make sure)
    let caught = null;
    try {
      await runInTenant(alfa, () => SubscriptionService.assertCanAddOperator());
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof PlanLimitError);
    assert.equal(caught.resource, 'operators');
    assert.equal(caught.limit, 2);
    assert.ok(caught.current >= 2);
  });
});
