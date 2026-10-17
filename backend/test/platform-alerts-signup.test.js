import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O alerta `referral_signup` (0112): o cadastro público com o código de quem
 * indicou avisa quem opera a plataforma — depois da transação do cadastro, uma
 * vez por provedor indicado. À parte de `platform-alerts.test.js` porque o
 * cadastro só existe no SaaS com subdomínio (ver `referrals-signup.test.js`).
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const APEX = 'painel.test';
const CASA = 'default.painel.test';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { saveProfile, invalidatePlatformProfile } = await import('../src/services/platformProfileService.js');

let panelUrl;
let donoToken;

function callAs(host, url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const cadastrar = (body) => callAs(APEX, `${panelUrl}/api/auth/signup`, { method: 'POST', body });
const base = (slug) => ({
  providerName: `ISP ${slug}`, slug, username: `dono-${slug}`, password: 'senha-do-dono-123', email: `${slug}@novo.test`
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  const setup = await callAs(CASA, `${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-da-casa', password: 'senha-da-casa-1', email: 'dona@casa.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  donoToken = setup.body.data.token;
  if (!(await db('tenants').where({ kind: 'platform' }).first())) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  }
  invalidatePlatformProfile();
  await saveProfile({ referralRewardCents: 5000 });
});

after(async () => {
  await stopTestServers();
});

describe('referral_signup', () => {
  it('desligado, o cadastro indicado não grava alerta', async () => {
    const { code } = (await callAs(CASA, `${panelUrl}/api/tenant/referrals`, {
      headers: { Authorization: `Bearer ${donoToken}` }
    })).body.data;
    const res = await cadastrar({ ...base('alerta-off'), referralCode: code });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await getDb()('platform_alerts').where({ event: 'referral_signup' })).length, 0);
  });

  it('ligado, avisa uma vez com quem indicou; sem código válido, não avisa', async () => {
    await saveProfile({ alerts: { events: { referral_signup: { enabled: true, channels: ['email'] } } } });
    const { code } = (await callAs(CASA, `${panelUrl}/api/tenant/referrals`, {
      headers: { Authorization: `Bearer ${donoToken}` }
    })).body.data;
    const res = await cadastrar({ ...base('alerta-on'), referralCode: code });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const nova = await getDb()('tenants').where({ slug: 'alerta-on' }).first();
    const linhas = await getDb()('platform_alerts').where({ event: 'referral_signup' });
    assert.equal(linhas.length, 1);
    assert.equal(Number(linhas[0].tenant_id), Number(nova.id));
    assert.equal(linhas[0].dedupe_key, `referral_signup:${nova.id}`);
    const payload = JSON.parse(linhas[0].payload);
    assert.equal(payload.slug, 'alerta-on');
    assert.ok(payload.referrer);
    // Nada da conta nova vai junto: nem senha, nem e-mail.
    assert.equal(linhas[0].payload.includes('senha-do-dono-123'), false);
    assert.equal(linhas[0].payload.includes('alerta-on@novo.test'), false);

    const sem = await cadastrar({ ...base('alerta-sem'), referralCode: 'ZZZZZZZZ' });
    assert.equal(sem.status, 201);
    assert.equal((await getDb()('platform_alerts').where({ event: 'referral_signup' })).length, 1);
  });
});
