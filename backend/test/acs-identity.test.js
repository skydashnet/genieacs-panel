import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * "É o mesmo GenieACS?" sem se deixar enganar pela grafia do endereço.
 *
 * Comparar o texto de `new URL().origin` deixava um provedor com ACS próprio
 * gravar o ACS compartilhado com outra grafia — o IP no lugar do nome,
 * maiúsculas, ponto final, porta padrão por extenso, outro nome DNS — e passar
 * por "ACS só meu": sem tag, sem filtro, a frota de todos na tela dele. Aqui a
 * comparação, a gravação (409) e o escopo (`sharesAcs`) com essas grafias.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: DirectConnector, forgetSharedAcs, UNASSIGNED_SCOPE_TAG } = await import('../src/services/genieacs/direct.js');
const { genieAcsOriginTakenByAnotherTenant } = await import('../src/config/platformManaged.js');
const {
  acsEndpoints, normalizedAcsOrigin, sameAcs, sameAcsAsAny, setAcsLookup
} = await import('../src/services/genieacs/acsIdentity.js');

// O DNS de mentira: o ACS compartilhado tem dois nomes e um IP; o outro, outro IP.
const ZONA = {
  'acs.exemplo.test': ['198.51.100.7'],
  'apelido.exemplo.test': ['198.51.100.7'],
  'duplo.exemplo.test': ['203.0.113.9', '198.51.100.7'],
  'v6.exemplo.test': ['2001:db8::7'],
  'outro.exemplo.test': ['203.0.113.9']
};
const consultas = [];
const dnsDeMentira = async (hostname) => {
  consultas.push(hostname);
  const ips = ZONA[hostname];
  if (!ips) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe('a origem normalizada', () => {
  it('ignora maiúsculas, ponto final, caminho e a porta padrão por extenso', () => {
    const base = normalizedAcsOrigin('http://acs.exemplo.test:7557');
    assert.equal(base, 'http://acs.exemplo.test:7557');
    assert.equal(normalizedAcsOrigin('HTTP://ACS.Exemplo.TEST:7557/nbi?x=1'), base);
    assert.equal(normalizedAcsOrigin('http://acs.exemplo.test.:7557'), base);
    assert.equal(normalizedAcsOrigin('https://acs.exemplo.test'), normalizedAcsOrigin('https://acs.exemplo.test:443'));
    assert.equal(normalizedAcsOrigin('http://acs.exemplo.test'), 'http://acs.exemplo.test:80');
    assert.equal(normalizedAcsOrigin('http://[2001:DB8::7]:7557'), 'http://[2001:db8::7]:7557');
  });

  it('não é URL, não é origem', () => {
    assert.equal(normalizedAcsOrigin(''), null);
    assert.equal(normalizedAcsOrigin(null), null);
    assert.equal(normalizedAcsOrigin('não é url'), null);
  });
});

describe('o mesmo ACS', () => {
  beforeEach(() => {
    setAcsLookup(dnsDeMentira);
    consultas.length = 0;
  });
  afterEach(() => setAcsLookup());

  it('nome e IP do mesmo servidor', async () => {
    assert.equal(await sameAcs('http://acs.exemplo.test:7557', 'http://198.51.100.7:7557'), true);
    assert.equal(await sameAcs('http://198.51.100.7:7557', 'http://acs.exemplo.test:7557'), true);
  });

  it('maiúsculas, ponto final e porta implícita contra explícita', async () => {
    assert.equal(await sameAcs('http://ACS.EXEMPLO.TEST:7557', 'http://acs.exemplo.test:7557'), true);
    assert.equal(await sameAcs('http://acs.exemplo.test.:7557', 'http://acs.exemplo.test:7557'), true);
    assert.equal(await sameAcs('https://acs.exemplo.test:443', 'https://acs.exemplo.test'), true);
    assert.equal(await sameAcs('http://198.51.100.7:80', 'http://acs.exemplo.test'), true);
  });

  it('outro nome DNS que resolve para o mesmo IP', async () => {
    assert.equal(await sameAcs('http://apelido.exemplo.test:7557', 'http://acs.exemplo.test:7557'), true);
    assert.equal(await sameAcs('http://duplo.exemplo.test:7557', 'http://acs.exemplo.test:7557'), true, 'basta um IP em comum');
  });

  it('IPv6 entre colchetes e IPv4 escrito em v6', async () => {
    assert.equal(await sameAcs('http://[2001:db8::7]:7557', 'http://v6.exemplo.test:7557'), true);
    assert.equal(await sameAcs('http://[::ffff:198.51.100.7]:7557', 'http://acs.exemplo.test:7557'), true);
  });

  it('IPs diferentes, ou a mesma máquina em outra porta, não são o mesmo ACS', async () => {
    assert.equal(await sameAcs('http://outro.exemplo.test:7557', 'http://acs.exemplo.test:7557'), false);
    assert.equal(await sameAcs('http://203.0.113.9:7557', 'http://198.51.100.7:7557'), false);
    assert.equal(await sameAcs('http://acs.exemplo.test:7558', 'http://198.51.100.7:7557'), false);
  });

  it('sem DNS, a comparação de origem continua decidindo', async () => {
    setAcsLookup(async () => { throw new Error('EAI_AGAIN'); });
    assert.equal(await sameAcs('http://ACS.exemplo.test.:7557', 'http://acs.exemplo.test:7557'), true);
    assert.equal(await sameAcs('http://acs.exemplo.test:7557', 'http://198.51.100.7:7557'), false);
    assert.deepEqual([...(await acsEndpoints('http://acs.exemplo.test:7557'))], []);
  });

  it('DNS que não responde para no prazo', async () => {
    setAcsLookup(() => new Promise(() => {}));
    const inicio = Date.now();
    assert.deepEqual([...(await acsEndpoints('http://acs.exemplo.test:7557', { timeoutMs: 50 }))], []);
    assert.ok(Date.now() - inicio < 1_000);
    assert.equal(await sameAcs('http://acs.exemplo.test:7557', 'http://198.51.100.7:7557', { timeoutMs: 50 }), false);
  });

  it('cada endereço é resolvido uma vez só, e IP literal nem consulta', async () => {
    const outros = ['http://outro.exemplo.test:7557', 'http://OUTRO.exemplo.test:7557/x', 'http://203.0.113.9:7557'];
    assert.equal(await sameAcsAsAny('http://acs.exemplo.test:7557', outros), false);
    assert.deepEqual(consultas.sort(), ['acs.exemplo.test', 'outro.exemplo.test']);
  });
});

describe('na SaaS, entre provedores', () => {
  const OWNER = { username: 'dono', password: 'dono-senha-123', email: 'dono@exemplo.test' };
  const COMPARTILHADO = 'http://acs.exemplo.test:7557';
  let panelUrl;
  let token;
  let alfa;
  let beta;

  const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
    ...options,
    headers: { ...authHeaders(token), ...(options.headers || {}) }
  });

  before(async () => {
    setAcsLookup(dnsDeMentira);
    ({ panelUrl } = await startTestServers());
    alfa = await defaultTenantId();
    const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: OWNER });
    assert.equal(setup.status, 201);
    token = setup.body.data.token;
    const userId = setup.body.data.user.id;
    if (!(await getDb()('platform_admins').where({ user_id: userId }).first())) {
      await getDb()('platform_admins').insert({ user_id: userId });
    }
    const criado = await api('/platform/tenants', { method: 'POST', body: { slug: 'beta', name: 'Beta' } });
    assert.equal(criado.status, 201);
    beta = criado.body.data.tenant.id;
    await runInTenant(beta, () => Setting.upsert('genieAcsUrl', COMPARTILHADO));
    const dono = await api(`/platform/tenants/${alfa}/genieacs`, { method: 'PUT', body: { ownership: 'own' } });
    assert.equal(dono.status, 200, JSON.stringify(dono.body));
  });

  after(async () => {
    setAcsLookup();
    await stopTestServers();
  });

  const grafias = [
    'http://198.51.100.7:7557',
    'http://ACS.EXEMPLO.TEST:7557',
    'http://acs.exemplo.test.:7557',
    'http://apelido.exemplo.test:7557'
  ];

  it('a gravação recusa o ACS do vizinho em qualquer grafia', async () => {
    for (const grafia of grafias) {
      assert.equal(await runInTenant(alfa, () => genieAcsOriginTakenByAnotherTenant(grafia)), true, grafia);
    }
    assert.equal(await runInTenant(alfa, () => genieAcsOriginTakenByAnotherTenant('http://outro.exemplo.test:7557')), false);

    const { status, body } = await api('/settings/genieAcsUrl', { method: 'PUT', body: { value: 'http://apelido.exemplo.test:7557' } });
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.code, 'genieacs_origin_in_use');
  });

  it('gravado por fora, o escopo trata como ACS compartilhado', async () => {
    for (const grafia of grafias) {
      await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', grafia));
      await runInTenant(alfa, () => Setting.upsert('deviceScopeTag', ''));
      forgetSharedAcs();
      assert.equal(await runInTenant(alfa, () => DirectConnector.sharesAcs()), true, grafia);
      assert.equal(await runInTenant(alfa, () => DirectConnector.scopeTag()), UNASSIGNED_SCOPE_TAG, grafia);
    }

    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', 'http://outro.exemplo.test:7557'));
    forgetSharedAcs();
    assert.equal(await runInTenant(alfa, () => DirectConnector.scopeTag()), null, 'ACS só dele: sem filtro, como sempre');
  });
});
