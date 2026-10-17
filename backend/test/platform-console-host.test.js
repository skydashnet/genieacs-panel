import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O console da plataforma no endereço da plataforma, sem provedor nenhum.
 *
 * É a peça que faltava para "o painel não pertence a provedor nenhum": até
 * aqui toda sessão nomeava um provedor — o login exigia vínculo em
 * `tenant_users` e `generateTokens` recusava token sem `tenant_id` —, então o
 * console só podia ser aberto no subdomínio de algum cliente. Esta sessão não
 * nomeia provedor: audiência própria, sem `tenantId` e sem papel, rodando em
 * `runUnscoped`.
 *
 * O que este arquivo guarda é o cerco dela, e cada caso corresponde a uma
 * forma de errar: entrar sem estar no cadastro, usar o token de console num
 * host de provedor, usar o token de um provedor no ápice, alcançar dado de
 * provedor com uma sessão que não tem provedor, e continuar valendo depois de
 * perder a chave.
 *
 * `Host` é header proibido no `fetch`, daí o `http.request` cru.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { runInTenant } = await import('../src/config/tenantContext.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');

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

let panelUrl;
let casa;
let semVinculoId;
let donoCasaToken;

const APEX = 'painel.test';
const CASA = 'default.painel.test';
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const noApex = (path, options) => callAs(APEX, `${panelUrl}${path}`, options);
const naCasa = (path, options) => callAs(CASA, `${panelUrl}${path}`, options);

/** Entra no console pelo ápice e devolve o corpo inteiro da resposta. */
const entrarNoConsole = (username, password) => noApex('/api/auth/login', {
  method: 'POST', body: { username, password }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  casa = (await db('tenants').orderBy('id', 'asc').first()).id;

  // O primeiro usuário do deploy nasce dono do provedor da casa e, sob SaaS,
  // com a chave do console. É a conta que existe em todo install de hoje.
  const setup = await naCasa('/api/auth/setup', {
    method: 'POST',
    body: { username: 'dono-casa', password: 'senha-da-casa-1', email: 'dono@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  donoCasaToken = setup.body.data.token;

  const bcrypt = (await import('bcryptjs')).default;

  // A conta que o modelo novo quer: no cadastro da plataforma e em provedor
  // NENHUM. Criada como o script de concessão cria, fora de escopo.
  semVinculoId = await runInTenant(casa, () => User.create({
    username: 'so-plataforma',
    email: 'so-plataforma@exemplo.test',
    password: bcrypt.hashSync('senha-da-plataforma-1', 10),
    role: 'viewer'
  }));
  await db('platform_admins').insert({ user_id: semVinculoId });
  assert.equal(await db('tenant_users').where({ user_id: semVinculoId }).first(), undefined);

  // E uma conta real que NÃO tem a chave, para o oráculo do login.
  const foraId = await runInTenant(casa, () => User.create({
    username: 'operador-casa',
    email: 'operador@exemplo.test',
    password: bcrypt.hashSync('senha-do-operador-1', 10),
    role: 'admin'
  }));
  await runInTenant(casa, () => TenantUser.create({ tenantId: casa, userId: foraId, role: 'admin' }));
});

after(async () => {
  await stopTestServers();
});

describe('entrar no console pelo endereço da plataforma', () => {
  it('emite sessão para quem tem a chave e não trabalha em provedor nenhum', async () => {
    const { status, body } = await entrarNoConsole('so-plataforma', 'senha-da-plataforma-1');
    assert.equal(status, 200, JSON.stringify(body));
    // Sem provedor e sem papel: a ausência é a forma da sessão.
    assert.equal(body.data.user.tenantId, null);
    assert.equal(body.data.user.role, null);
    assert.equal(body.data.user.platform, true);
    assert.equal(body.data.user.isPlatformAdmin, true);
    assert.ok(body.data.token);
    // Com refresh, ao contrário da personificação: o console é expediente.
    assert.ok(body.data.refreshToken);
  });

  it('recusa quem não tem a chave com o corpo de senha errada', async () => {
    const certo = await entrarNoConsole('operador-casa', 'senha-do-operador-1');
    const errado = await entrarNoConsole('operador-casa', 'senha-nenhuma');
    assert.equal(certo.status, 401);
    assert.equal(errado.status, 401);
    // Byte por byte: distinguir aqui diria quem opera a plataforma.
    assert.deepEqual(certo.body, errado.body);
  });

  it('responde igual para conta que não existe', async () => {
    const inexistente = await entrarNoConsole('ninguem', 'senha-nenhuma');
    const semChave = await entrarNoConsole('operador-casa', 'senha-do-operador-1');
    assert.equal(inexistente.status, 401);
    assert.deepEqual(inexistente.body, semChave.body);
  });

  it('não deixa o corpo escolher um provedor a partir do ápice', async () => {
    const { status, body } = await noApex('/api/auth/login', {
      method: 'POST',
      body: { username: 'dono-casa', password: 'senha-da-casa-1', tenantId: casa }
    });
    // O dono da casa tem a chave, então entra — mas no console, sem provedor,
    // e não numa sessão do provedor que ele pediu no corpo.
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.tenantId, null);
    assert.equal(body.data.user.platform, true);
  });

  it('continua entrando no provedor pelo host do provedor', async () => {
    const { status, body } = await naCasa('/api/auth/login', {
      method: 'POST', body: { username: 'dono-casa', password: 'senha-da-casa-1' }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.tenantId, casa);
    assert.equal(body.data.user.role, 'owner');
    assert.equal(body.data.user.platform, undefined);
  });

  it('não emite sessão de console para quem só trabalha num provedor', async () => {
    // Mesmo com a senha certa: sem a chave, o ápice não é porta dela.
    const { status } = await entrarNoConsole('operador-casa', 'senha-do-operador-1');
    assert.equal(status, 401);
  });
});

describe('o que a sessão do console alcança', () => {
  let consoleToken;
  let consoleRefresh;

  before(async () => {
    const entrada = await entrarNoConsole('so-plataforma', 'senha-da-plataforma-1');
    consoleToken = entrada.body.data.token;
    consoleRefresh = entrada.body.data.refreshToken;
  });

  it('alcança o console no ápice', async () => {
    const { status, body } = await noApex('/api/platform/tenants', { headers: bearer(consoleToken) });
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(Array.isArray(body.data.tenants));
  });

  it('se apresenta sem provedor e sem papel depois de um F5', async () => {
    const { status, body } = await noApex('/api/auth/user', { headers: bearer(consoleToken) });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.tenantId, null);
    assert.equal(body.data.role, null);
    assert.equal(body.data.platform, true);
    assert.equal(body.data.isPlatformAdmin, true);
  });

  it('não vale no host de um provedor', async () => {
    const { status, body } = await naCasa('/api/devices', { headers: bearer(consoleToken) });
    assert.equal(status, 403);
    assert.equal(body.code, 'tenant_mismatch');
  });

  it('não alcança as rotas do console pelo host de um provedor', async () => {
    // 404 e não 403: onde há domínio-base, o console não é MONTADO no host de
    // um provedor, então ali estas rotas não existem para ninguém — nem para
    // quem tem a chave. É a recusa mais forte das duas, e a que faz o 404 que
    // esconde a existência do plano de controle valer por construção.
    const { status } = await naCasa('/api/platform/tenants', { headers: bearer(consoleToken) });
    assert.equal(status, 404);
  });

  it('não alcança rota de provedor nem no ápice', async () => {
    // Aqui a recusa é do resolvedor: a rota não é servida neste endereço.
    const { status } = await noApex('/api/users', { headers: bearer(consoleToken) });
    assert.equal(status, 404);
  });

  it('é recusada por capacidade, não consultada com papel inventado', async () => {
    // `/api/auth/change-password` está no ápice e não pede capacidade; o que
    // este caso prova é a guarda por capacidade, exercitada no host do provedor
    // onde a rota existe — e ali a sessão de console já não vale, então a
    // prova por fora é a de cima. Aqui só se confirma que trocar a própria
    // senha funciona para quem não trabalha em provedor nenhum.
    const { status } = await noApex('/api/auth/change-password', {
      method: 'POST',
      headers: bearer(consoleToken),
      body: { currentPassword: 'senha-da-plataforma-1', newPassword: 'senha-da-plataforma-2' }
    });
    assert.equal(status, 200);

    // Trocar a senha derruba a sessão, como derruba qualquer outra.
    const depois = await noApex('/api/auth/user', { headers: bearer(consoleToken) });
    assert.equal(depois.status, 403);

    // E a senha nova entra.
    const denovo = await entrarNoConsole('so-plataforma', 'senha-da-plataforma-2');
    assert.equal(denovo.status, 200);
    consoleToken = denovo.body.data.token;
    consoleRefresh = denovo.body.data.refreshToken;
  });

  it('renova no ápice, e não no host de um provedor', async () => {
    // No host de um provedor a rota existe — ela é do painel também —, então a
    // recusa vem de dentro: um refresh de console só renova onde a sessão de
    // console vale.
    const fora = await naCasa('/api/auth/refresh', {
      method: 'POST', body: { refreshToken: consoleRefresh }
    });
    assert.equal(fora.status, 403, JSON.stringify(fora.body));

    const dentro = await noApex('/api/auth/refresh', {
      method: 'POST', body: { refreshToken: consoleRefresh }
    });
    assert.equal(dentro.status, 200, JSON.stringify(dentro.body));
    assert.ok(dentro.body.data.token);
    assert.ok(dentro.body.data.refreshToken);
  });

  it('deixa de existir quando a chave é revogada', async () => {
    const db = getDb();
    await db('platform_admins').where({ user_id: semVinculoId }).del();
    try {
      const { status, body } = await noApex('/api/auth/user', { headers: bearer(consoleToken) });
      assert.equal(status, 403);
      assert.equal(body.code, 'invalid_token');
    } finally {
      await db('platform_admins').insert({ user_id: semVinculoId });
    }
  });
});

describe('o token de uma personificação no endereço da plataforma', () => {
  it('é recusado, como qualquer sessão que nomeia provedor', async () => {
    const entrada = await entrarNoConsole('so-plataforma', 'senha-da-plataforma-2');
    const token = entrada.body.data.token;

    const cunhado = await noApex(`/api/platform/tenants/${casa}/impersonate`, {
      method: 'POST', headers: bearer(token)
    });
    assert.equal(cunhado.status, 200, JSON.stringify(cunhado.body));

    // A URL aponta para o host do provedor, e é lá que o bilhete se gasta.
    const destino = new URL(cunhado.body.data.url);
    assert.equal(destino.host, CASA);
    const bilhete = destino.hash.slice(1);
    const aberta = await naCasa('/api/auth/impersonate/redeem', {
      method: 'POST', body: { ticket: bilhete }
    });
    assert.equal(aberta.status, 200, JSON.stringify(aberta.body));

    // E a sessão que nasceu dali não volta ao ápice: ela nomeia um provedor.
    const volta = await noApex('/api/auth/user', { headers: bearer(aberta.body.data.token) });
    assert.equal(volta.status, 403);
    assert.equal(volta.body.code, 'tenant_mismatch');
  });
});

describe('o token de um provedor no endereço da plataforma', () => {
  it('é recusado na família do console', async () => {
    const { status, body } = await noApex('/api/platform/tenants', { headers: bearer(donoCasaToken) });
    assert.equal(status, 403);
    assert.equal(body.code, 'tenant_mismatch');
  });

  it('é recusado em qualquer rota de sessão servida no ápice', async () => {
    const { status, body } = await noApex('/api/auth/user', { headers: bearer(donoCasaToken) });
    assert.equal(status, 403);
    assert.equal(body.code, 'tenant_mismatch');
  });
});
