import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A indicação de provedores (0106): o código, o link e o cadastro com
 * `?ref=CÓDIGO`.
 *
 * SaaS com subdomínio, porque o cadastro só existe ali (ver
 * `signup-and-rename.test.js`): o provedor da instalação (`default`) é quem
 * indica, e os indicados nascem pelo cadastro público com `referralCode`. O
 * dinheiro — a recompensa e o crédito na fatura — está em `referrals.test.js`,
 * que precisa do gateway de mentira em `127.0.0.1` (e o SaaS recusa endereço
 * de loopback na saída).
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const APEX = 'painel.test';
const CASA = 'default.painel.test';
const CNPJ_DA_CASA = '11222333000181';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { maskName, normalizeReferralCode } = await import('../src/services/referralService.js');
const { saveProfile, invalidatePlatformProfile } = await import('../src/services/platformProfileService.js');

let panelUrl;
let donoToken;
let consoleToken;
let casa;

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

const naCasa = (path, options = {}) => callAs(CASA, `${panelUrl}${path}`, {
  ...options, headers: { Authorization: `Bearer ${donoToken}`, ...(options.headers || {}) }
});
const noConsole = (path, options = {}) => callAs(APEX, `${panelUrl}${path}`, {
  ...options, headers: { Authorization: `Bearer ${consoleToken}`, ...(options.headers || {}) }
});
const cadastrar = (body) => callAs(APEX, `${panelUrl}/api/auth/signup`, { method: 'POST', body });
const recompensaDe = (tenantId) => getDb()('referral_rewards').where({ referred_tenant_id: tenantId }).first();

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  casa = (await db('tenants').orderBy('id', 'asc').first()).id;

  const setup = await callAs(CASA, `${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'dona-da-casa', password: 'senha-da-casa-1', email: 'dona@casa.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  donoToken = setup.body.data.token;
  const entrada = await callAs(APEX, `${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'dona-da-casa', password: 'senha-da-casa-1' }
  });
  assert.equal(entrada.status, 200, JSON.stringify(entrada.body));
  consoleToken = entrada.body.data.token;

  if (!(await db('tenants').where({ kind: 'platform' }).first())) {
    await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  }
  await db('tenants').where({ id: casa }).update({ billing_tax_id: CNPJ_DA_CASA });
  await saveProfile({ referralRewardCents: 5000 });
  invalidatePlatformProfile();
});

after(async () => {
  await stopTestServers();
});

describe('o código e o link', () => {
  it('nasce na primeira leitura, curto e legível, e não muda depois', async () => {
    const primeira = await naCasa('/api/tenant/referrals');
    assert.equal(primeira.status, 200, JSON.stringify(primeira.body));
    const { code, signupUrl, enabled, rewardCents, balanceCents } = primeira.body.data;
    assert.match(code, /^[A-HJ-KM-NP-Z2-9]{8}$/);
    assert.equal(signupUrl, `https://painel.test/signup?ref=${code}`);
    assert.equal(enabled, true);
    assert.equal(rewardCents, 5000);
    assert.equal(balanceCents, 0);
    const segunda = await naCasa('/api/tenant/referrals');
    assert.equal(segunda.body.data.code, code);
    assert.equal((await getDb()('tenants').where({ id: casa }).first()).referral_code, code);
  });

  it('normaliza o código do link e mascara o nome do indicado', () => {
    assert.equal(normalizeReferralCode(' ab-cd 23 '), 'ABCD23');
    assert.equal(normalizeReferralCode('x'), null);
    assert.equal(maskName('Provedor Nova Fibra'), 'Pr••• No••• Fi•••');
  });

  it('o console liga e desliga o programa pelas Configurações', async () => {
    const liga = await noConsole('/api/platform/settings/profile', { method: 'PUT', body: { referralRewardCents: 2500 } });
    assert.equal(liga.status, 200, JSON.stringify(liga.body));
    assert.equal(liga.body.data.billing.referralRewardCents, 2500);
    const ruim = await noConsole('/api/platform/settings/profile', { method: 'PUT', body: { referralRewardCents: -1 } });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.field, 'referralRewardCents');
    const desliga = await noConsole('/api/platform/settings/profile', { method: 'PUT', body: { referralRewardCents: 0 } });
    assert.equal(desliga.body.data.billing.referralRewardCents, 0);
    assert.equal((await naCasa('/api/tenant/referrals')).body.data.enabled, false);
  });
});

describe('o cadastro com ?ref=', () => {
  const base = (slug) => ({
    providerName: `ISP ${slug}`, slug, username: `dono-${slug}`, password: 'senha-do-dono-123', email: `${slug}@novo.test`
  });

  it('grava quem indicou e a recompensa pendente', async () => {
    const { code } = (await naCasa('/api/tenant/referrals')).body.data;
    const res = await cadastrar({ ...base('nova'), referralCode: code.toLowerCase() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const nova = await getDb()('tenants').where({ slug: 'nova' }).first();
    assert.equal(Number(nova.referred_by_tenant_id), casa);
    const recompensa = await recompensaDe(nova.id);
    assert.equal(recompensa.status, 'pending');
    assert.equal(Number(recompensa.referrer_tenant_id), casa);
    const trilha = await getDb()('platform_audit').where({ action: 'tenant.created', tenant_id: nova.id }).first();
    assert.equal(JSON.parse(trilha.detail).referredBy, casa);

    // Quem indicou vê o indicado, mascarado.
    const lista = (await naCasa('/api/tenant/referrals')).body.data.referrals;
    const linha = lista.find((r) => r.id === recompensa.id);
    assert.equal(linha.name, 'IS••• no•••');
    assert.equal(linha.status, 'pending');
  });

  it('código inválido é ignorado, e o cadastro segue', async () => {
    const res = await cadastrar({ ...base('semref'), referralCode: 'ZZZZZZZZ' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const t = await getDb()('tenants').where({ slug: 'semref' }).first();
    assert.equal(t.referred_by_tenant_id, null);
    assert.equal(await recompensaDe(t.id), undefined);
  });

  it('indicar a si mesmo (o mesmo CNPJ de quem indicou) é ignorado', async () => {
    const { code } = (await naCasa('/api/tenant/referrals')).body.data;
    const res = await cadastrar({ ...base('eumesmo'), referralCode: code, taxId: CNPJ_DA_CASA });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const t = await getDb()('tenants').where({ slug: 'eumesmo' }).first();
    assert.equal(t.referred_by_tenant_id, null);
    assert.equal(await recompensaDe(t.id), undefined);
  });

  it('o código de um provedor suspenso não indica', async () => {
    const { code } = (await naCasa('/api/tenant/referrals')).body.data;
    await getDb()('tenants').where({ id: casa }).update({ status: 'suspended' });
    try {
      const res = await cadastrar({ ...base('desuspenso'), referralCode: code });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const t = await getDb()('tenants').where({ slug: 'desuspenso' }).first();
      assert.equal(t.referred_by_tenant_id, null);
    } finally {
      await getDb()('tenants').where({ id: casa }).update({ status: 'active' });
    }
  });
});
