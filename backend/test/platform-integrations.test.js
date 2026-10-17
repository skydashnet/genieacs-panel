import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * A conta Asaas da plataforma, configurada pelo console — Integrações.
 *
 * SaaS, porque é onde o console existe. E é por ser SaaS que a chamada que SAI
 * para o gateway não chega ao servidor de mentira em `127.0.0.1`: o cliente
 * recusa endereço privado nesta edição, de propósito. Os caminhos felizes das
 * chamadas de saída (o teste de conexão e a criação do cliente) estão em
 * `asaas-gateway-lifecycle.test.js`, que roda no self-hosted; aqui o que se
 * prova é a rota — as guardas, o que ela devolve e o que ela nunca devolve —
 * e, de quebra, que a recusa de endereço privado continua de pé.
 *
 * As três coisas que não podem dar errado:
 *
 * 1. **Um segredo atravessar a resposta.** A leitura diz de onde a chave vem,
 *    nunca qual é.
 * 2. **O `.env` deixar de valer para quem nunca abriu a tela.** Os deploys que
 *    já cobravam continuam cobrando.
 * 3. **O token do webhook trocado pelo console não valer na rota.**
 */
process.env.EDITION = 'saas';

const ENV_KEY = 'chave-do-ambiente-0001';
const ENV_TOKEN = 'token-do-ambiente-0001';
const DB_KEY = '$aact_hmlg_chave-gravada-pelo-console';

const {
  authHeaders, call, defaultTenantId, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { invalidateAsaasSettings, effectiveApiKey, effectiveBaseUrl } = await import(
  '../src/services/billing/asaasSettingsService.js'
);

let panelUrl;
let ownerToken;
let comumToken;
let alfa;
let caixa;
let gateway;
let chamadasAoGateway = 0;

const platform = (path, options = {}, token = ownerToken) => call(`${panelUrl}/api/platform${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

/** Apaga o que o console gravou, e o cache junto. */
async function limpar() {
  await getDb()('app_state').where({ key: 'asaas_gateway_config' }).del();
  invalidateAsaasSettings();
}

before(async () => {
  gateway = http.createServer((req, res) => {
    chamadasAoGateway += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"cus_nunca"}');
  });
  const base = await new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${gateway.address().port}`));
  });
  process.env.ASAAS_BASE_URL = base;

  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;
  if (!(await getDb()('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });
  }

  const hire = await call(`${panelUrl}/api/users`, {
    method: 'POST', headers: authHeaders(ownerToken),
    body: { username: 'comum', password: 'comum-senha-1', role: 'admin', email: 'comum@exemplo.test' }
  });
  assert.equal(hire.status, 201);
  const signIn = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'comum', password: 'comum-senha-1' }
  });
  comumToken = signIn.body.data.token;
});

after(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.BILLING_WEBHOOK_TOKEN;
  delete process.env.ASAAS_BASE_URL;
  await new Promise((r) => gateway.close(r));
  await stopTestServers();
});

beforeEach(async () => {
  delete process.env.ASAAS_API_KEY;
  delete process.env.BILLING_WEBHOOK_TOKEN;
  await limpar();
});

describe('sem caixa da plataforma', () => {
  it('lê só o ambiente e recusa gravar, dizendo o porquê', async () => {
    process.env.ASAAS_API_KEY = ENV_KEY;
    const lido = await platform('/integrations/asaas');
    assert.equal(lido.status, 200);
    assert.equal(lido.body.data.apiKeySource, 'env');
    assert.equal(lido.body.data.environment, 'production', 'chave do .env é o deploy que já cobrava');

    const gravado = await platform('/integrations/asaas', { method: 'PUT', body: { apiKey: DB_KEY } });
    assert.equal(gravado.status, 409);
    assert.equal(gravado.body.code, 'no_platform_tenant');
  });

  it('e cria a caixa para o resto do arquivo', async () => {
    caixa = await Tenant.create({ slug: 'plataforma', name: 'Plataforma', kind: 'platform' });
    invalidateAsaasSettings();
    assert.ok(caixa);
  });
});

describe('a leitura', () => {
  it('não devolve segredo nenhum, só de onde vem', async () => {
    process.env.ASAAS_API_KEY = ENV_KEY;
    process.env.BILLING_WEBHOOK_TOKEN = ENV_TOKEN;
    const res = await platform('/integrations/asaas');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.data).sort(), [
      'apiKeyConfigured', 'apiKeySource', 'discountDaysBefore', 'discountKind', 'discountValue', 'environment',
      'finePercent', 'interestMonthlyPercent', 'issPercent', 'municipalServiceCode',
      'municipalServiceId', 'municipalServiceName', 'nfseEnabled', 'observations', 'retainIss',
      'serviceDescription', 'updatedAt', 'webhookTokenConfigured', 'webhookTokenSource', 'webhookUrl'
    ]);
    assert.equal(res.body.data.apiKeyConfigured, true);
    assert.equal(res.body.data.apiKeySource, 'env');
    assert.equal(res.body.data.webhookTokenSource, 'env');
    assert.equal(res.body.data.updatedAt, null);
    assert.match(res.body.data.webhookUrl, /\/api\/billing-webhook$/);
    const corpo = JSON.stringify(res.body);
    assert.equal(corpo.includes(ENV_KEY), false);
    assert.equal(corpo.includes(ENV_TOKEN), false);
  });

  it('e sem nada configurado é sandbox, sem fonte', async () => {
    const res = await platform('/integrations/asaas');
    assert.equal(res.body.data.environment, 'sandbox');
    assert.equal(res.body.data.apiKeyConfigured, false);
    assert.equal(res.body.data.apiKeySource, null);
    assert.equal(res.body.data.webhookTokenConfigured, false);
    assert.equal(res.body.data.webhookTokenSource, null);
  });

  it('é só do administrador da plataforma', async () => {
    for (const [method, path] of [
      ['GET', '/integrations/asaas'],
      ['PUT', '/integrations/asaas'],
      ['POST', '/integrations/asaas/test'],
      ['POST', '/integrations/asaas/webhook-token'],
      ['POST', `/tenants/${alfa}/gateway/asaas-customer`]
    ]) {
      const res = await platform(path, { method, ...(method === 'GET' ? {} : { body: {} }) }, comumToken);
      // 404 e não 403: é a regra de `requirePlatformAdmin` para o console
      // inteiro — quem não é da plataforma não fica sabendo que a rota existe.
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    const semSessao = await call(`${panelUrl}/api/platform/integrations/asaas`);
    assert.equal(semSessao.status, 401);
  });
});

describe('a gravação', () => {
  it('guarda cifrado, e a leitura passa a dizer "db"', async () => {
    const res = await platform('/integrations/asaas', {
      method: 'PUT', body: { environment: 'sandbox', apiKey: DB_KEY, webhookToken: 'token-gravado-1' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.apiKeySource, 'db');
    assert.equal(res.body.data.webhookTokenSource, 'db');
    assert.equal(res.body.data.environment, 'sandbox');
    assert.ok(res.body.data.updatedAt);
    assert.equal(JSON.stringify(res.body).includes(DB_KEY), false);

    const linha = await getDb()('app_state').where({ tenant_id: caixa, key: 'asaas_gateway_config' }).first();
    assert.ok(linha, 'mora na caixa da plataforma');
    assert.equal(linha.value.includes(DB_KEY), false, 'e cifrado');
    assert.equal(linha.value.includes('token-gravado-1'), false);

    const trilha = await getDb()('platform_audit')
      .where({ action: 'platform.integration_changed' }).orderBy('id', 'desc').first();
    assert.ok(trilha);
    assert.deepEqual(JSON.parse(trilha.detail), {
      integration: 'asaas', environment: 'sandbox', apiKeyChanged: true, webhookTokenChanged: true
    });
    assert.equal(trilha.detail.includes(DB_KEY), false);
  });

  it('e o banco ganha do ambiente', async () => {
    process.env.ASAAS_API_KEY = ENV_KEY;
    await platform('/integrations/asaas', { method: 'PUT', body: { apiKey: DB_KEY } });
    assert.equal(await effectiveApiKey(), DB_KEY);
    const res = await platform('/integrations/asaas');
    assert.equal(res.body.data.apiKeySource, 'db');
  });

  it('ausente mantém; vazio apaga e devolve a palavra ao ambiente', async () => {
    process.env.ASAAS_API_KEY = ENV_KEY;
    await platform('/integrations/asaas', { method: 'PUT', body: { apiKey: DB_KEY, environment: 'sandbox' } });

    const mantido = await platform('/integrations/asaas', { method: 'PUT', body: { environment: 'production' } });
    assert.equal(mantido.body.data.apiKeySource, 'db', 'mudar o ambiente não apaga a chave');
    assert.equal(mantido.body.data.environment, 'production');

    const apagado = await platform('/integrations/asaas', { method: 'PUT', body: { apiKey: '' } });
    assert.equal(apagado.status, 200);
    assert.equal(apagado.body.data.apiKeySource, 'env');
    assert.equal(await effectiveApiKey(), ENV_KEY);

    delete process.env.ASAAS_API_KEY;
    const semNada = await platform('/integrations/asaas');
    assert.equal(semNada.body.data.apiKeyConfigured, false);
  });

  it('recusa um ambiente que não existe', async () => {
    const res = await platform('/integrations/asaas', { method: 'PUT', body: { environment: 'staging' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_environment');
  });

  it('e o ambiente escolhe a base quando ASAAS_BASE_URL não força uma', async () => {
    const forcada = process.env.ASAAS_BASE_URL;
    delete process.env.ASAAS_BASE_URL;
    try {
      await platform('/integrations/asaas', { method: 'PUT', body: { environment: 'sandbox' } });
      assert.equal(await effectiveBaseUrl(), 'https://api-sandbox.asaas.com/v3');
      await platform('/integrations/asaas', { method: 'PUT', body: { environment: 'production' } });
      assert.equal(await effectiveBaseUrl(), 'https://api.asaas.com/v3');
    } finally {
      process.env.ASAAS_BASE_URL = forcada;
    }
  });

  it('e o deploy diz "configurado" pela mesma leitura', async () => {
    await platform('/integrations/asaas', { method: 'PUT', body: { apiKey: DB_KEY, webhookToken: 'x-token' } });
    const res = await platform('/deployment');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.configured.billingGateway, true);
    assert.equal(res.body.data.configured.billingWebhookToken, true);
  });
});

describe('multa, juros e desconto', () => {
  it('nascem desligados', async () => {
    const res = await platform('/integrations/asaas');
    assert.equal(res.status, 200);
    const { finePercent, interestMonthlyPercent, discountKind, discountValue, discountDaysBefore } = res.body.data;
    assert.deepEqual(
      { finePercent, interestMonthlyPercent, discountKind, discountValue, discountDaysBefore },
      { finePercent: 0, interestMonthlyPercent: 0, discountKind: 'percent', discountValue: 0, discountDaysBefore: 0 }
    );
  });

  it('gravam, voltam na leitura e entram na trilha sem tocar no resto', async () => {
    const res = await platform('/integrations/asaas', {
      method: 'PUT',
      body: { finePercent: 2, interestMonthlyPercent: 1, discountKind: 'percent', discountValue: 5, discountDaysBefore: 3 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.finePercent, 2);
    assert.equal(res.body.data.interestMonthlyPercent, 1);
    assert.equal(res.body.data.discountValue, 5);
    assert.equal(res.body.data.discountDaysBefore, 3);
    assert.equal(res.body.data.nfseEnabled, false, 'a nota continua como estava');

    const trilha = await getDb()('platform_audit')
      .where({ action: 'platform.integration_changed' }).orderBy('id', 'desc').first();
    const detalhe = JSON.parse(trilha.detail);
    assert.equal(detalhe.chargesChanged, true);
    assert.deepEqual(detalhe.charges, {
      finePercent: 2, interestMonthlyPercent: 1, discountKind: 'percent', discountValue: 5, discountDaysBefore: 3
    });

    // Ausente mantém; trocar só o tipo reconfere o valor que ficou.
    const fixo = await platform('/integrations/asaas', {
      method: 'PUT', body: { discountKind: 'fixed', discountValue: 1000 }
    });
    assert.equal(fixo.status, 200);
    assert.equal(fixo.body.data.finePercent, 2);
    assert.equal(fixo.body.data.discountKind, 'fixed');
    assert.equal(fixo.body.data.discountValue, 1000);

    const desligado = await platform('/integrations/asaas', {
      method: 'PUT', body: { finePercent: null, interestMonthlyPercent: '', discountValue: 0 }
    });
    assert.equal(desligado.body.data.finePercent, 0);
    assert.equal(desligado.body.data.interestMonthlyPercent, 0);
    assert.equal(desligado.body.data.discountValue, 0);
  });

  for (const [nome, corpo] of [
    ['multa acima de 10%', { finePercent: 10.5 }],
    ['multa negativa', { finePercent: -1 }],
    ['juros acima de 10% ao mês', { interestMonthlyPercent: 11 }],
    ['juros que não são número', { interestMonthlyPercent: 'muito' }],
    ['tipo de desconto que não existe', { discountKind: 'brinde' }],
    ['desconto percentual acima de 100', { discountKind: 'percent', discountValue: 150 }],
    ['desconto fixo em fração de centavo', { discountKind: 'fixed', discountValue: 10.5 }],
    ['prazo do desconto acima de 30 dias', { discountDaysBefore: 31 }],
    ['prazo do desconto fracionado', { discountDaysBefore: 1.5 }],
    ['booleano no lugar de número', { finePercent: true }]
  ]) {
    it(`recusa ${nome} com 400 invalid_charges`, async () => {
      const res = await platform('/integrations/asaas', { method: 'PUT', body: corpo });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'invalid_charges');
    });
  }

  it('e trocar para percentual com um fixo grande guardado é recusado', async () => {
    await platform('/integrations/asaas', { method: 'PUT', body: { discountKind: 'fixed', discountValue: 5000 } });
    const res = await platform('/integrations/asaas', { method: 'PUT', body: { discountKind: 'percent' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_charges');
  });
});

describe('o teste de conexão', () => {
  it('responde 400 quando não há chave a testar', async () => {
    const res = await platform('/integrations/asaas/test', { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'not_configured');
  });

  /**
   * Na SaaS o cliente não fala com endereço privado — e a recusa chega à tela
   * como `ok: false` com o código, que é o formato de toda recusa do gateway.
   */
  it('e a recusa vira ok:false, sem sair para endereço privado', async () => {
    await platform('/integrations/asaas', { method: 'PUT', body: { apiKey: DB_KEY } });
    const antes = chamadasAoGateway;
    const res = await platform('/integrations/asaas/test', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.ok, false);
    assert.equal(res.body.code, 'blocked_host');
    assert.equal(res.body.data.environment, 'sandbox');
    assert.equal(chamadasAoGateway, antes, 'nada saiu');
  });
});

describe('o token do webhook cunhado pelo console', () => {
  it('sai uma vez, vale na rota, e o do ambiente deixa de valer', async () => {
    process.env.BILLING_WEBHOOK_TOKEN = ENV_TOKEN;
    const res = await platform('/integrations/asaas/webhook-token', { method: 'POST' });
    assert.equal(res.status, 200);
    const { webhookToken } = res.body.data;
    assert.match(webhookToken, /^[A-Za-z0-9_-]{43}$/);

    const lido = await platform('/integrations/asaas');
    assert.equal(lido.body.data.webhookTokenSource, 'db');
    assert.equal(JSON.stringify(lido.body).includes(webhookToken), false);

    const entregar = (token) => call(`${panelUrl}/api/billing-webhook`, {
      method: 'POST',
      headers: { 'asaas-access-token': token },
      body: { event: 'PAYMENT_CREATED', payment: { id: 'pay_x', value: 1 } }
    });
    const aceita = await entregar(webhookToken);
    assert.equal(aceita.status, 200);
    assert.equal(aceita.body.code, 'ignored');
    const velha = await entregar(ENV_TOKEN);
    assert.equal(velha.status, 401, 'o do .env perdeu para o do console');

    const trilha = await getDb()('platform_audit')
      .where({ action: 'platform.integration_changed' }).orderBy('id', 'desc').first();
    const detalhe = JSON.parse(trilha.detail);
    assert.equal(detalhe.webhookTokenChanged, true);
    assert.equal(detalhe.apiKeyChanged, false);
    assert.equal(trilha.detail.includes(webhookToken), false);
  });

  it('e sem token nenhum a rota volta a não existir', async () => {
    const res = await call(`${panelUrl}/api/billing-webhook`, {
      method: 'POST', headers: { 'asaas-access-token': 'qualquer' }, body: {}
    });
    assert.equal(res.status, 404);
  });
});

describe('o provedor como cliente do gateway', () => {
  const criar = (id) => platform(`/tenants/${id}/gateway/asaas-customer`, { method: 'POST' });

  beforeEach(async () => {
    await getDb()('tenants').where({ id: alfa }).update({
      billing_gateway: null, billing_customer_ref: null,
      billing_tax_id: '12.345.678/0001-95', billing_legal_name: 'Alfa Telecom Ltda'
    });
  });

  it('404 para quem não existe e para a caixa da plataforma', async () => {
    assert.equal((await criar(999999)).status, 404);
    assert.equal((await criar(caixa)).status, 404);
  });

  it('400 sem CPF/CNPJ no cadastro fiscal', async () => {
    await getDb()('tenants').where({ id: alfa }).update({ billing_tax_id: null });
    const res = await criar(alfa);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'missing_tax_id');
  });

  it('409 para quem já está ligado', async () => {
    await getDb()('tenants').where({ id: alfa })
      .update({ billing_gateway: 'asaas', billing_customer_ref: 'cus_existente' });
    const res = await criar(alfa);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'already_linked');
  });

  it('e a recusa do gateway não liga nada', async () => {
    await platform('/integrations/asaas', { method: 'PUT', body: { apiKey: DB_KEY } });
    const res = await criar(alfa);
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'blocked_host');
    const linha = await getDb()('tenants').where({ id: alfa }).first();
    assert.equal(linha.billing_customer_ref, null);
  });
});
