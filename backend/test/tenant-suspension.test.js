import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * Suspender um provedor tem de valer agora, e não no próximo restart.
 *
 * O resolvedor guarda `slug -> id` pela vida do processo e não relê a coluna
 * `status`, então uma suspensão feita pelo console da plataforma ficava valendo
 * só pela metade: os jobs de fundo paravam de visitar o provedor — eles leem a
 * linha — enquanto o painel e o portal dele seguiam servindo, e seguiam
 * autenticando gente nova, para todo host já resolvido uma vez. Pior: a
 * exclusão em duas etapas confia na suspensão para significar "ninguém está
 * trabalhando lá dentro", e essa premissa era falsa.
 *
 * Provar isso exige um processo só: o mesmo que suspende tem de ser o que
 * responde ao host logo depois, porque um restart entre as duas coisas é
 * exatamente o que escondia o defeito. Daí `EDITION` e os domínios base serem
 * escolhidos aqui em cima — o roteador e as bases são lidos na carga dos
 * módulos, e importes estáticos são içados acima de qualquer atribuição, então
 * a harness vem por importe dinâmico. `node --test` dá um processo por arquivo,
 * então nada disto vaza para as outras suítes.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.exemplo.com';
process.env.PORTAL_BASE_DOMAIN = 'portal.exemplo.com';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');

/**
 * Uma requisição com o `Host` escolhido.
 *
 * `fetch` não faz isto: ali `Host` é cabeçalho proibido e o undici o substitui
 * pelo real, em silêncio — um teste escrito com `fetch` passaria sem provar
 * nada. O cliente cru é o único jeito de dizer qual provedor o chamador quer.
 */
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
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
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

const OWNER = { username: 'dona-da-plataforma', password: 'senha-da-plataforma-1', email: 'dona-da-plataforma@exemplo.test' };

let panelUrl;
let portalUrl;
let ownerToken;
let consoleToken;
let betaId;

// O console responde no endereço da PLATAFORMA — o ápice —, e com a sessão de
// lá: a do setup nomeia o provedor alfa, e o console não é servido no host dele.
const platform = (path, options = {}) => callAs(
  'painel.exemplo.com',
  `${panelUrl}/api/platform${path}`,
  { ...options, headers: { Authorization: `Bearer ${consoleToken}`, ...(options.headers || {}) } }
);

const setStatus = (id, status) => platform(`/tenants/${id}`, { method: 'PATCH', body: { status } });

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  const db = getDb();

  const first = await db('tenants').orderBy('id', 'asc').first();
  await db('tenants').where({ id: first.id }).update({ slug: 'alfa', name: 'Provedor Alfa' });

  const setup = await callAs('alfa.painel.exemplo.com', `${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: OWNER
  });
  assert.equal(setup.status, 201, 'não deu para criar o primeiro administrador');
  ownerToken = setup.body.data.token;
  const consoleEntrada = await callAs('painel.exemplo.com', `${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: OWNER.username, password: OWNER.password }
  });
  assert.equal(consoleEntrada.status, 200, JSON.stringify(consoleEntrada.body));
  consoleToken = consoleEntrada.body.data.token;

  // Escrito direto na tabela: `platform_admins` nasce vazia e a rota que
  // concede o papel é de outra faixa. O que está sob teste é o que o console
  // faz para quem já está na lista, não como se entra nela. Guardado porque o
  // caminho de setup da edição SaaS já põe o primeiro administrador ali.
  const ownerId = setup.body.data.user.id;
  if (!(await db('platform_admins').where({ user_id: ownerId }).first())) {
    await db('platform_admins').insert({ user_id: ownerId });
  }

  // Criado pela própria rota do console, e não por INSERT, porque um provedor
  // criado à mão não tem settings nem catálogo — e porque é este o caminho pelo
  // qual um provedor de verdade aparece num processo que já está de pé.
  const nova = await platform('/tenants', {
    method: 'POST',
    body: { slug: 'beta', name: 'Provedor Beta' }
  });
  assert.equal(nova.status, 201, 'não deu para criar o segundo provedor');
  betaId = nova.body.data.tenant.id;
});

after(async () => {
  await stopTestServers();
});

describe('suspender um provedor com o processo de pé', () => {
  it('serve o provedor enquanto ele está ativo, o que é o que enche o cache', async () => {
    const { status, body } = await callAs(
      'beta.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    assert.equal(status, 200);
    assert.equal(body.data.name, 'Provedor Beta');

    // O portal também, porque é a metade que o assinante usa e a que continuava
    // atendendo depois da suspensão.
    const portal = await callAs('beta.portal.exemplo.com', `${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'CSG-0000000-000000', password: 'errada' }
    });
    assert.equal(portal.status, 401, 'o provedor tem que resolver antes de suspender');
  });

  it('para de servir o host assim que a suspensão é feita, sem restart', async () => {
    const suspender = await setStatus(betaId, 'suspended');
    assert.equal(suspender.status, 200);
    assert.equal(suspender.body.data.tenant.status, 'suspended');

    const painel = await callAs('beta.painel.exemplo.com', `${panelUrl}/api/tenant/public`);
    assert.equal(painel.status, 404, 'o painel do provedor suspenso ainda responde');

    const portal = await callAs('beta.portal.exemplo.com', `${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'CSG-0000000-000000', password: 'errada' }
    });
    assert.equal(portal.status, 404, 'o portal do provedor suspenso ainda responde');
  });

  // A parte que mais pesa: enquanto o cache ficava quente, a suspensão não
  // impedia ninguém de ENTRAR. Um provedor desligado seguia emitindo sessões.
  it('recusa uma autenticação nova no host suspenso', async () => {
    const { status } = await callAs('beta.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: OWNER
    });
    assert.equal(status, 404);
  });

  // Suspender o vizinho não pode derrubar quem está ativo: o esquecimento é do
  // mapa inteiro, então o que sobra tem de se reconstruir sozinho na próxima
  // requisição.
  it('deixa os outros provedores em pé', async () => {
    const { status, body } = await callAs(
      'alfa.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    assert.equal(status, 200);
    assert.equal(body.data.slug, 'alfa');
  });

  it('volta a servir quando o provedor é reativado, também sem restart', async () => {
    const reativar = await setStatus(betaId, 'active');
    assert.equal(reativar.status, 200);

    const { status, body } = await callAs(
      'beta.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    assert.equal(status, 200, 'a reativação não voltou a valer no processo que a fez');
    assert.equal(body.data.name, 'Provedor Beta');
  });

  /**
   * O mesmo defeito visto por dentro, sem passar por HTTP.
   *
   * Os testes acima passam pelo resolvedor, mas um deles poderia passar por
   * acaso — bastaria o cache nunca ter esquentado. Aqui a leitura é feita duas
   * vezes de propósito, para que a primeira grave o acerto, e o que se afirma é
   * que a suspensão apaga esse acerto e não que ele nunca existiu.
   */
  it('esquece o acerto guardado, e não apenas deixa de gravá-lo', async () => {
    const { resolveTenantIdBySlug } = await import('../src/middleware/tenantResolver.js');
    assert.equal(Number(await resolveTenantIdBySlug('beta')), Number(betaId));
    assert.equal(Number(await resolveTenantIdBySlug('beta')), Number(betaId));

    await setStatus(betaId, 'suspended');
    assert.equal(await resolveTenantIdBySlug('beta'), null);

    await setStatus(betaId, 'active');
    assert.equal(Number(await resolveTenantIdBySlug('beta')), Number(betaId));
  });
});
