import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { authHeaders, call, startTestServers, stopTestServers } = await import('./helpers/harness.js');

/**
 * `GET /api/settings` devolve só o que `PUT /api/settings/:key` aceita.
 *
 * A tela de configurações regrava cada chave que lê. Com o assistente de
 * boas-vindas fechado, `onboardingWizardDoneAt` vinha na lista, o PUT dela era
 * recusado e o "Salvar configurações" parava antes de gravar a geração de IDs
 * de cliente (que vai por último) — o provedor via "chave não suportada".
 */
let panelUrl;
let token;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
});

after(async () => { await stopTestServers(); });

describe('GET /api/settings', () => {
  it('depois de fechar o assistente, toda chave listada pode ser regravada', async () => {
    const dismiss = await call(`${panelUrl}/api/settings/onboarding/dismiss`, {
      method: 'POST', headers: authHeaders(token), body: { what: 'wizard' }
    });
    assert.equal(dismiss.status, 200);
    const list = await call(`${panelUrl}/api/settings`, { headers: authHeaders(token) });
    assert.equal(list.status, 200);
    assert.ok(!('onboardingWizardDoneAt' in list.body.data));
    assert.ok('autoGenerateCustomerId' in list.body.data);
    for (const [key, value] of Object.entries(list.body.data)) {
      const res = await call(`${panelUrl}/api/settings/${key}`, {
        method: 'PUT', headers: authHeaders(token), body: { value: String(value ?? '') }
      });
      assert.equal(res.status, 200, `${key}: ${res.body?.message}`);
    }
  });
});
