import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  asTenant, authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: OnboardingService } = await import('../src/services/onboardingService.js');

/**
 * Os primeiros passos de um provedor novo.
 *
 * O checklist confere o que o provedor TEM — endereço do ACS, um equipamento
 * no ACS, um colega na equipe — e não uma marca clicada. E o "já vi" do
 * assistente mora no provedor, não no navegador: outro administrador, noutra
 * máquina, não pode receber o assistente de novo.
 */
let panelUrl;
let token;
let genie;
let tenantId;

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: [buildDevice({ id: 'ONT-ONBOARD-1' })] });
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dono', password: 'dono-password-1', email: 'dono@exemplo.test' }
  });
  token = setup.body.data.token;
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  await genie.close();
  await stopTestServers();
});

const status = async () => {
  const res = await call(`${panelUrl}/api/settings/onboarding`, { headers: authHeaders(token) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const feito = (data) => Object.fromEntries(data.items.map((item) => [item.key, item.done]));

describe('primeiros passos', () => {
  it('um provedor recém-criado começa com tudo pendente e sem nada visto', async () => {
    const data = await status();
    assert.deepEqual(data.items.map((item) => item.key),
      ['genieacs', 'firstDevice', 'provisioning', 'sgp', 'whatsapp', 'team']);
    assert.ok(data.items.every((item) => item.done === false), JSON.stringify(data.items));
    assert.equal(data.wizardDone, false);
    assert.equal(data.checklistDismissed, false);
  });

  it('um ACS fora do ar deixa o primeiro equipamento pendente, sem derrubar a resposta', async () => {
    await asTenant(() => Setting.upsert('genieAcsUrl', 'http://127.0.0.1:9'));
    const itens = feito(await status());
    assert.equal(itens.genieacs, true);
    assert.equal(itens.firstDevice, false);
  });

  it('com o ACS respondendo e um colega na equipe, os itens se marcam sozinhos', async () => {
    await asTenant(() => Setting.upsert('genieAcsUrl', genie.url));
    const colegaId = await runInTenant(tenantId, () => User.create({
      username: 'colega', password: 'x'.repeat(60), role: 'tech'
    }));
    await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId: colegaId, role: 'tech' }));

    const itens = feito(await status());
    assert.equal(itens.genieacs, true);
    assert.equal(itens.firstDevice, true);
    assert.equal(itens.team, true);
    assert.equal(itens.sgp, false);
  });

  it('recusa marcar como visto o que não é o assistente nem o checklist', async () => {
    const res = await call(`${panelUrl}/api/settings/onboarding/dismiss`, {
      method: 'POST', headers: authHeaders(token), body: { what: 'tudo' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_onboarding_target');
  });

  it('o "já vi" fica no provedor, e não vaza para o vizinho', async () => {
    for (const what of ['wizard', 'checklist']) {
      // eslint-disable-next-line no-await-in-loop -- uma marca por vez
      const res = await call(`${panelUrl}/api/settings/onboarding/dismiss`, {
        method: 'POST', headers: authHeaders(token), body: { what }
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    const data = await status();
    assert.equal(data.wizardDone, true);
    assert.equal(data.checklistDismissed, true);

    const vizinho = await insertReturningId('tenants', { slug: 'vizinho', name: 'Provedor Vizinho', status: 'active' });
    const doVizinho = await runInTenant(vizinho, () => OnboardingService.status(vizinho));
    assert.equal(doVizinho.wizardDone, false, 'o assistente do vizinho não foi visto por ninguém');
    assert.equal(doVizinho.checklistDismissed, false);
  });
});
