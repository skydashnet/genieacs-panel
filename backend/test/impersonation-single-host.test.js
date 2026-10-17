import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A personificação num deploy hospedado de HOST ÚNICO.
 *
 * `impersonation.test.js` guarda o cerco da personificação, e o faz com
 * domínio-base configurado — o arranjo em que cada provedor tem o seu
 * subdomínio. Este arquivo guarda o outro arranjo, que existe e estava
 * quebrado: SaaS sem `TENANT_BASE_DOMAIN`, console e painéis no mesmo endereço.
 *
 * Lá o host nomeia o provedor; aqui não nomeia ninguém, e o resolvedor devolve
 * o PRIMEIRO provedor da tabela para toda requisição. O resgate conferia o
 * bilhete contra esse primeiro, então um bilhete de qualquer outro provedor era
 * recusado como se fosse forjado — a personificação simplesmente não existia
 * fora do primeiro provedor, e a linha "entraram no meu painel" ia para a
 * trilha do provedor errado.
 *
 * Arquivo separado e não mais um `describe` porque as duas coisas se decidem no
 * import: `TENANT_BASE_DOMAIN` é lido uma vez, no load do módulo do resolvedor.
 * `Host` é header proibido no `fetch`, daí o `http.request` cru.
 */
process.env.EDITION = 'saas';
delete process.env.TENANT_BASE_DOMAIN;
delete process.env.PORTAL_BASE_DOMAIN;

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { runInTenant } = await import('../src/config/tenantContext.js');
const { default: Subscription } = await import('../src/models/Subscription.js');

function call(url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
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

let panelUrl;
/** O provedor que o host resolve por ser o primeiro da tabela. */
let primeiro;
/** O provedor que só o bilhete sabe nomear. */
let segundo;
let plataformaToken;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const api = (path, options) => call(`${panelUrl}${path}`, options);

/** Cunha um bilhete pelo console e devolve o valor que vai no fragmento. */
async function bilhetePara(tenantId) {
  const { status, body } = await api(`/api/platform/tenants/${tenantId}/impersonate`, {
    method: 'POST', headers: bearer(plataformaToken)
  });
  assert.equal(status, 200, JSON.stringify(body));
  // Endereço relativo, e é o que prova o arranjo: sem domínio-base não há outro
  // host para onde mandar o navegador.
  assert.equal(body.data.url.startsWith('/impersonate#'), true, body.data.url);
  return body.data.url.slice('/impersonate#'.length);
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();

  primeiro = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'segundo', name: 'Provedor Segundo', status: 'active' });
  segundo = (await db('tenants').where({ slug: 'segundo' }).first()).id;
  assert.notEqual(primeiro, segundo);
  // Com assinatura em dia: o atendimento escreve, e a porta da assinatura
  // recusaria a escrita de um provedor sem plano antes de ela chegar.
  const plano = await db('plans').orderBy('id', 'asc').first();
  await runInTenant(segundo, () => Subscription.upsertForTenant(segundo, { plan_id: plano.id, status: 'active' }));

  const setup = await api('/api/auth/setup', {
    method: 'POST',
    body: { username: 'plataforma', password: 'senha-da-plataforma-1', email: 'plataforma@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  plataformaToken = setup.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('personificar num deploy de host único', () => {
  it('abre a sessão do provedor que o BILHETE nomeia, não a do primeiro da tabela', async () => {
    const ticket = await bilhetePara(segundo);

    const { status, body } = await api('/api/auth/impersonate/redeem', {
      method: 'POST', body: { ticket }
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.tenantId, segundo);
    assert.equal(body.data.user.role, 'admin');
    assert.equal(body.data.tenant.slug, 'segundo');
  });

  it('nomeia o provedor certo na sessão, porque o endereço nomeia o errado', async () => {
    const ticket = await bilhetePara(segundo);
    const aberta = await api('/api/auth/impersonate/redeem', { method: 'POST', body: { ticket } });
    assert.equal(aberta.status, 200, JSON.stringify(aberta.body));

    // O que a faixa vermelha lê. O perfil público deste host responde o
    // PRIMEIRO provedor, então um nome tirado dali diria o painel errado.
    assert.equal(aberta.body.data.user.impersonation.tenantName, 'Provedor Segundo');
    assert.equal(aberta.body.data.user.impersonation.tenantSlug, 'segundo');

    const publico = await api('/api/tenant/public');
    assert.equal(publico.status, 200);
    assert.notEqual(publico.body.data.name, 'Provedor Segundo');

    // E depois de um F5 a resposta é a mesma, porque vem da hidratação do token
    // e não da tela.
    const relido = await api('/api/auth/user', { headers: bearer(aberta.body.data.token) });
    assert.equal(relido.status, 200, JSON.stringify(relido.body));
    assert.equal(relido.body.data.tenantId, segundo);
    assert.equal(relido.body.data.impersonation.tenantName, 'Provedor Segundo');
  });

  it('arquiva a trilha no provedor personificado, e não no do endereço', async () => {
    const ticket = await bilhetePara(segundo);
    assert.equal((await api('/api/auth/impersonate/redeem', { method: 'POST', body: { ticket } })).status, 200);

    const linha = await runInTenant(segundo, () => getDb()('audit_log')
      .where({ tenant_id: segundo, action: 'platform.impersonated' })
      .orderBy('id', 'desc').first());
    assert.ok(linha, 'o provedor personificado tem que ver na trilha dele que entraram');
    assert.equal(linha.actor_kind, 'platform');
    assert.equal(linha.actor_username, 'plataforma');

    const noPrimeiro = await runInTenant(primeiro, () => getDb()('audit_log')
      .where({ tenant_id: primeiro, action: 'platform.impersonated' })
      .first());
    assert.equal(noPrimeiro, undefined, 'o provedor do endereço não foi personificado');
  });

  it('continua abrindo o primeiro provedor, que era o único que funcionava', async () => {
    const ticket = await bilhetePara(primeiro);
    const { status, body } = await api('/api/auth/impersonate/redeem', {
      method: 'POST', body: { ticket }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.tenantId, primeiro);
  });

  it('escreve no provedor do BILHETE, não no do endereço, e continua servindo uma vez só', async () => {
    const ticket = await bilhetePara(segundo);
    const aberta = await api('/api/auth/impersonate/redeem', { method: 'POST', body: { ticket } });
    const token = aberta.body.data.token;

    const nomePrimeiro = (await getDb()('tenants').where({ id: primeiro }).first()).name;
    const escrita = await api('/api/tenant', {
      method: 'PATCH', headers: bearer(token), body: { name: 'Segundo pelo atendimento' }
    });
    assert.equal(escrita.status, 200, JSON.stringify(escrita.body));
    assert.equal((await getDb()('tenants').where({ id: segundo }).first()).name, 'Segundo pelo atendimento');
    assert.equal((await getDb()('tenants').where({ id: primeiro }).first()).name, nomePrimeiro,
      'a escrita caiu no provedor do endereço');
    await getDb()('tenants').where({ id: segundo }).update({ name: 'Provedor Segundo' });

    assert.equal((await api('/api/auth/impersonate/redeem', { method: 'POST', body: { ticket } })).status, 404);
  });

  it('não alcança o console de volta', async () => {
    const ticket = await bilhetePara(segundo);
    const aberta = await api('/api/auth/impersonate/redeem', { method: 'POST', body: { ticket } });

    const console_ = await api('/api/platform/tenants', {
      headers: bearer(aberta.body.data.token)
    });
    assert.equal(console_.status, 404);
  });
});
