import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A página pública do ápice: o catálogo à venda, o subdomínio livre, o
 * pedido de demonstração, e o cadastro que já nasce no plano escolhido.
 *
 * SaaS com subdomínio: é onde o ápice é a vitrine. `Host` é header proibido
 * no `fetch`, daí o `http.request` cru, como em signup-and-rename.test.js.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const { getDb, runInTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { default: User } = await import('../src/models/User.js');

let panelUrl;
let consoleToken;

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

const APEX = 'painel.test';
const CASA = 'default.painel.test';
const noApex = (path, options) => callAs(APEX, `${panelUrl}${path}`, options);
const naCasa = (path, options) => callAs(CASA, `${panelUrl}${path}`, options);
const console_ = (path, options = {}) => noApex(`/api/platform${path}`, {
  ...options,
  headers: { Authorization: `Bearer ${consoleToken}`, ...(options.headers || {}) }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  const casa = (await db('tenants').orderBy('id', 'asc').first()).id;
  const bcrypt = (await import('bcryptjs')).default;
  const adminId = await runInTenant(casa, () => User.create({
    username: 'plataforma',
    email: 'plataforma@exemplo.test',
    password: bcrypt.hashSync('senha-da-plataforma-1', 10),
    role: 'viewer'
  }));
  await db('platform_admins').insert({ user_id: adminId });
  const login = await noApex('/api/auth/login', {
    method: 'POST', body: { username: 'plataforma', password: 'senha-da-plataforma-1' }
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  consoleToken = login.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('o catálogo público', () => {
  it('mostra só os planos ativos marcados como públicos, na ordem do console', async () => {
    const criar = (body) => console_('/plans', { method: 'POST', body });
    assert.equal((await criar({
      code: 'basico', name: 'Básico', priceCents: 9900, trialDays: 7, maxDevices: 500,
      public: true, sortOrder: 2, features: ['ACS TR-069', ' ', 'Portal do assinante'],
      description: 'Para começar'
    })).status, 201);
    assert.equal((await criar({
      code: 'pro', name: 'Pro', priceCents: 19900, priceYearlyCents: 199000, trialDays: 14,
      public: true, featured: true, sortOrder: 1
    })).status, 201);
    assert.equal((await criar({ code: 'interno', name: 'Interno', priceCents: 0 })).status, 201);
    const inativo = await criar({ code: 'antigo', name: 'Antigo', public: true, active: false });
    assert.equal(inativo.status, 201);

    const res = await noApex('/api/public/plans');
    assert.equal(res.status, 200);
    const plans = res.body.data.plans;
    assert.deepEqual(plans.map((p) => p.code), ['pro', 'basico']);
    assert.equal(plans[0].featured, true);
    assert.equal(plans[0].priceYearlyCents, 199000);
    assert.deepEqual(plans[1].features, ['ACS TR-069', 'Portal do assinante']);
    assert.equal(plans[1].limits.devices, 500);
    // A vitrine não carrega o que é do console.
    assert.equal(plans[0].id, undefined);
    assert.equal(plans[0].subscribers, undefined);
  });

  it('recusa uma lista de recursos que não é lista', async () => {
    const res = await console_('/plans', { method: 'POST', body: { code: 'ruim', name: 'Ruim', features: 'texto' } });
    assert.equal(res.status, 400);
  });

  it('não existe no host de um provedor', async () => {
    const res = await naCasa('/api/public/plans');
    assert.equal(res.status, 404);
  });
});

describe('o subdomínio livre', () => {
  it('diz livre, ocupado ou inválido com a regra do cadastro', async () => {
    const livre = await noApex('/api/public/slug-available?slug=provedor-novo');
    assert.equal(livre.body.data.available, true);
    const ocupado = await noApex('/api/public/slug-available?slug=default');
    assert.equal(ocupado.body.data.available, false);
    assert.equal(ocupado.body.data.problem, 'taken');
    const invalido = await noApex('/api/public/slug-available?slug=A_B');
    assert.equal(invalido.body.data.problem, 'invalid');
  });

  it('recusa CNPJ com dígito errado sem sair para fora', async () => {
    const res = await noApex('/api/public/cnpj?cnpj=11111111111111');
    assert.equal(res.status, 400);
  });
});

describe('o cadastro pela página pública', () => {
  it('nasce em teste no plano escolhido, com CNPJ e WhatsApp no cadastro', async () => {
    const res = await noApex('/api/auth/signup', {
      method: 'POST',
      body: {
        providerName: 'Fibra Norte', slug: 'fibra-norte', username: 'dono-fibra',
        email: 'dono@fibra.test', password: 'senha-fibra-1',
        planCode: 'pro', taxId: '11.222.333/0001-81', phone: '(11) 98888-7777',
        legalName: 'Fibra Norte Telecom LTDA', city: 'Manaus', state: 'am'
      }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const db = getDb();
    const tenant = await db('tenants').where({ slug: 'fibra-norte' }).first();
    assert.equal(tenant.billing_tax_id, '11222333000181');
    assert.equal(tenant.billing_phone, '5511988887777');
    assert.equal(tenant.billing_state, 'AM');
    const sub = await db('subscriptions').where({ tenant_id: tenant.id }).first();
    const plan = await db('plans').where({ id: sub.plan_id }).first();
    assert.equal(plan.code, 'pro');
    assert.equal(sub.status, 'trial');
  });

  it('ignora um plano que não está à venda e cai no teste padrão', async () => {
    const res = await noApex('/api/auth/signup', {
      method: 'POST',
      body: {
        providerName: 'Net Sul', slug: 'net-sul', username: 'dono-sul',
        email: 'dono@netsul.test', password: 'senha-sul-12', planCode: 'interno'
      }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const db = getDb();
    const tenant = await db('tenants').where({ slug: 'net-sul' }).first();
    const sub = await db('subscriptions').where({ tenant_id: tenant.id }).first();
    const plan = await db('plans').where({ id: sub.plan_id }).first();
    assert.notEqual(plan.code, 'interno');
  });

  it('recusa um CNPJ inválido', async () => {
    const res = await noApex('/api/auth/signup', {
      method: 'POST',
      body: {
        providerName: 'X', slug: 'provedor-x', username: 'dono-x',
        email: 'x@x.test', password: 'senha-x-1234', taxId: '11222333000100'
      }
    });
    assert.equal(res.status, 400);
  });
});

describe('o pedido de demonstração', () => {
  it('grava, e o console lista e muda a etapa', async () => {
    const semContato = await noApex('/api/public/leads', { method: 'POST', body: { name: 'Ana' } });
    assert.equal(semContato.status, 400);

    const ok = await noApex('/api/public/leads', {
      method: 'POST',
      body: { name: 'Ana', company: 'Ana Net', phone: '11999990000', devicesEstimate: 1200, planCode: 'pro', message: 'Quero ver' }
    });
    assert.equal(ok.status, 201);

    // O robô que preenche o campo escondido recebe o mesmo 201 e não grava.
    const robo = await noApex('/api/public/leads', {
      method: 'POST', body: { name: 'Bot', email: 'bot@bot.test', website: 'http://spam' }
    });
    assert.equal(robo.status, 201);

    const lista = await console_('/leads');
    assert.equal(lista.status, 200);
    assert.equal(lista.body.data.leads.length, 1);
    const lead = lista.body.data.leads[0];
    assert.equal(lead.company, 'Ana Net');
    assert.equal(lead.planCode, 'pro');
    assert.equal(lead.status, 'new');

    const mudou = await console_(`/leads/${lead.id}`, { method: 'PATCH', body: { status: 'contacted', notes: 'Liguei' } });
    assert.equal(mudou.status, 200);
    assert.equal(mudou.body.data.lead.status, 'contacted');
    const ruim = await console_(`/leads/${lead.id}`, { method: 'PATCH', body: { status: 'talvez' } });
    assert.equal(ruim.status, 400);
    const nenhum = await console_('/leads/99999', { method: 'PATCH', body: { status: 'won' } });
    assert.equal(nenhum.status, 404);
  });

  it('é do console: sem a chave, não lista', async () => {
    const res = await noApex('/api/platform/leads');
    assert.ok([401, 404].includes(res.status));
  });
});

/**
 * O que a política de privacidade diz sobre quanto tempo o pedido de contato
 * fica guardado vem DESTA rota — e a rota lê a mesma função que a poda
 * (`utils/leadRetention.js`). Sem isto a página poderia prometer um prazo e o
 * código cumprir outro, que é o defeito que uma política escrita à mão tem.
 */
describe('o prazo que a política publica', () => {
  const anterior = process.env.LEAD_RETENTION_DAYS;
  after(() => {
    if (anterior === undefined) delete process.env.LEAD_RETENTION_DAYS;
    else process.env.LEAD_RETENTION_DAYS = anterior;
  });

  it('é zero — "nada o apaga sozinho" — enquanto ninguém configurou', async () => {
    delete process.env.LEAD_RETENTION_DAYS;
    const info = await noApex('/api/public/info');
    assert.equal(info.status, 200);
    assert.equal(info.body.data.leadRetentionDays, 0);
  });

  it('acompanha a variável de ambiente, sem precisar de outro deploy da página', async () => {
    process.env.LEAD_RETENTION_DAYS = '365';
    const info = await noApex('/api/public/info');
    assert.equal(info.body.data.leadRetentionDays, 365);
  });

  /**
   * O caso que importa: um valor mal digitado NÃO pode virar uma promessa
   * pública. A poda lê `'12abc'` como zero (não apaga nada), e a política tem que
   * dizer o mesmo — publicar "12 dias" sobre um prazo que o código nunca cumpre
   * seria afirmar em público o que não é verdade.
   */
  it('lê um valor inválido como zero, igual à poda, em vez de publicar um prazo inventado', async () => {
    process.env.LEAD_RETENTION_DAYS = '12abc';
    const info = await noApex('/api/public/info');
    assert.equal(info.body.data.leadRetentionDays, 0);
  });
});
