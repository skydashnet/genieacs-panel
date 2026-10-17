import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Onde o login entra, quando o endereço não decide.
 *
 * Num deploy com subdomínio por provedor o host responde isso sozinho e não há
 * pergunta a fazer. Sem domínio-base — todos os provedores no mesmo endereço, a
 * separação vindo do login — a pergunta é legítima e pode ter mais de uma
 * resposta: os provedores em que a pessoa trabalha, mais o console se ela opera
 * a plataforma.
 *
 * Antes, com vários vínculos, o login mandava a pessoa para o mais antigo em
 * SILÊNCIO — regra defensável e escolha invisível, e invisível é o problema:
 * um consultor que atende dois ISPs não tinha como pedir o outro, e quem opera
 * a plataforma não tinha como abrir o console com a casca dele.
 *
 * Duas propriedades que este arquivo existe para prender, e que são a razão de
 * a lista sair onde sai:
 *
 * - a lista aparece DEPOIS do `bcrypt`. Senha errada responde o 401 de sempre,
 *   sem lista — senão a rota diria em quais provedores um login existe para
 *   quem está sondando;
 * - `tenantId` de provedor onde a pessoa não trabalha não cai em outro: recusa
 *   igual à de senha errada.
 */
process.env.EDITION = 'saas';
delete process.env.TENANT_BASE_DOMAIN;
delete process.env.PORTAL_BASE_DOMAIN;

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { runInTenant } = await import('../src/config/tenantContext.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: PlatformAdmin } = await import('../src/models/PlatformAdmin.js');
const { authLimiter } = await import('../src/middleware/rateLimit.js');

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
let alfa;
let beta;
let suspenso;
let donaId;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const api = (path, options) => call(`${panelUrl}${path}`, options);
const entrar = (body) => api('/api/auth/login', { method: 'POST', body });

/** O balde do login é apertado, e esta suíte entra muitas vezes. */
async function esvaziarBalde() {
  for (const slug of ['default', 'beta', 'suspenso']) {
    await authLimiter.resetKey(`${slug}|127.0.0.1`);
  }
}
beforeEach(esvaziarBalde);

/** Cria alguém com senha conhecida e os vínculos pedidos. */
async function pessoa({ username, email, senha, vinculos }) {
  const bcrypt = (await import('bcryptjs')).default;
  const id = await runInTenant(vinculos[0], () => User.create({
    username, email, password: bcrypt.hashSync(senha, 10), role: 'admin'
  }));
  for (const tenantId of vinculos) {
    await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId: id, role: 'admin' }));
  }
  return id;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();

  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;
  await db('tenants').insert({ slug: 'suspenso', name: 'Provedor Suspenso', status: 'suspended' });
  suspenso = (await db('tenants').where({ slug: 'suspenso' }).first()).id;

  const setup = await api('/api/auth/setup', {
    method: 'POST',
    body: { username: 'dona', password: 'senha-da-dona-1', email: 'dona@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  donaId = setup.body.data.user.id;
});

after(async () => {
  await stopTestServers();
});

describe('um destino só entra direto', () => {
  it('um vínculo e nada mais: 200, no provedor da pessoa', async () => {
    await pessoa({
      username: 'so-do-beta', email: 'so-do-beta@exemplo.test',
      senha: 'senha-do-beta-1', vinculos: [beta]
    });

    const { status, body } = await entrar({ username: 'so-do-beta', password: 'senha-do-beta-1' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.tenantId, beta);
  });
});

describe('vários destinos: o login pergunta', () => {
  it('dois vínculos respondem 409 com os dois nomes', async () => {
    await pessoa({
      username: 'consultora', email: 'consultora@exemplo.test',
      senha: 'senha-da-consultora-1', vinculos: [alfa, beta]
    });

    const { status, body } = await entrar({
      username: 'consultora', password: 'senha-da-consultora-1'
    });

    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.destinations.console, false);
    const nomes = body.destinations.tenants.map((t) => t.slug).sort();
    assert.deepEqual(nomes, ['beta', 'default']);
    // E nenhum token: perguntar não é entrar.
    assert.equal(body.data, undefined);
    assert.equal(body.code, 'choose_destination');
  });

  it('a senha errada NÃO vê a lista', async () => {
    const { status, body } = await entrar({
      username: 'consultora', password: 'senha-errada-mesmo'
    });
    assert.equal(status, 401, JSON.stringify(body));
    assert.equal(body.data, undefined);
    assert.equal(JSON.stringify(body).includes('beta'), false);
  });

  it('nomear o provedor entra direto nele', async () => {
    const { status, body } = await entrar({
      username: 'consultora', password: 'senha-da-consultora-1', tenantId: beta
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.tenantId, beta);
  });

  it('nomear provedor onde a pessoa não trabalha recusa como senha errada', async () => {
    const { status, body } = await entrar({
      username: 'consultora', password: 'senha-da-consultora-1', tenantId: suspenso
    });
    assert.equal(status, 401, JSON.stringify(body));
  });

  it('provedor suspenso continua na lista, porque o portão da assinatura é quem explica', async () => {
    await pessoa({
      username: 'do-suspenso', email: 'do-suspenso@exemplo.test',
      senha: 'senha-do-suspenso-1', vinculos: [beta, suspenso]
    });

    const { status, body } = await entrar({
      username: 'do-suspenso', password: 'senha-do-suspenso-1'
    });
    assert.equal(status, 409, JSON.stringify(body));
    const achado = body.destinations.tenants.find((t) => t.slug === 'suspenso');
    assert.ok(achado, 'o provedor suspenso sumiu da lista');
    assert.equal(achado.status, 'suspended');
  });
});

describe('o console entre os destinos', () => {
  it('NÃO vira seletor para quem opera a plataforma e tem um provedor só', async () => {
    // `dona` nasceu do setup: é do primeiro provedor e está no cadastro da
    // plataforma. O console existe para ela, mas não é ambiguidade: quem opera
    // a plataforma quase sempre também trabalha num provedor, e um seletor em
    // todo login poria uma escolha na frente de quem só quer o painel de
    // sempre. Entra direto, como antes desta mudança.
    assert.equal(await PlatformAdmin.has(donaId), true);

    const { status, body } = await entrar({ username: 'dona', password: 'senha-da-dona-1' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.tenantId, alfa);
  });

  it('mas aparece na lista quando a pergunta acontece por outro motivo', async () => {
    // Com dois provedores a pergunta já existe; listar o console ali é de
    // graça e é onde ele fica achável.
    await runInTenant(beta, () => TenantUser.create({
      tenantId: beta, userId: donaId, role: 'admin'
    }));
    const { status, body } = await entrar({ username: 'dona', password: 'senha-da-dona-1' });
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.destinations.console, true);
    assert.equal(body.destinations.tenants.length, 2);
  });

  it('escolher o console cunha sessão sem provedor, e ela serve o plano de controle', async () => {
    const { status, body } = await entrar({
      username: 'dona', password: 'senha-da-dona-1', destination: 'console'
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.tenantId, null);
    assert.equal(body.data.user.role, null);
    assert.equal(body.data.user.platform, true);

    // É o que a sessão de console existe para alcançar, e aqui não há outro
    // endereço de onde alcançá-lo.
    const provedores = await api('/api/platform/tenants', { headers: bearer(body.data.token) });
    assert.equal(provedores.status, 200, JSON.stringify(provedores.body));
    assert.ok(provedores.body.data.tenants.length >= 3);
  });

  it('quem não está no cadastro da plataforma pede o console e recebe 401', async () => {
    const { status, body } = await entrar({
      username: 'so-do-beta', password: 'senha-do-beta-1', destination: 'console'
    });
    assert.equal(status, 401, JSON.stringify(body));
  });
});

describe('a porta compartilhada não veste ninguém', () => {
  it('o perfil público não devolve o nome do primeiro provedor, mas devolve o slug', async () => {
    const { status, body } = await api('/api/tenant/public');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.name, null);
    assert.equal(body.data.shared, true);
    // O slug PRECISA continuar indo: a tela deduz "aqui é a plataforma" de
    // `slug === null`, e anulá-lo trocaria o painel de todo mundo pela casca
    // do console.
    assert.equal(typeof body.data.slug, 'string');
  });
});
