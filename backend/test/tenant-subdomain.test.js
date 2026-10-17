import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The base domains are read once, at module load, because they are deployment
// configuration rather than per-request state. Static imports are hoisted above
// every statement, so the harness has to be pulled in dynamically for these
// assignments to be visible to it — the same reason `edition-saas.test.js`
// does it. `node --test` gives each file its own process, so this does not
// leak into the other suites, which is exactly what keeps them exercising the
// no-subdomain path.
process.env.TENANT_BASE_DOMAIN = 'painel.exemplo.com';
process.env.PORTAL_BASE_DOMAIN = 'portal.exemplo.com';

const { call, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { tenantSlugFromHost } = await import('../src/middleware/tenantResolver.js');

/**
 * A request with a chosen `Host`.
 *
 * `fetch` will not do this: `Host` is a forbidden header there, and undici
 * replaces it with the real one silently — a test written with `fetch` would
 * pass while proving nothing. The raw client is the only way to say which
 * provider the caller is asking for.
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
        resolve({
          status: response.statusCode,
          body: parsed,
          setCookie: (response.headers['set-cookie'] || [])[0] || null
        });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

let panelUrl;
let portalUrl;
let alfaToken;
let betaToken;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
  const db = getDb();

  // The install's own provider becomes `alfa`; `beta` is the second one, which
  // is the entire point of the slice.
  const first = await db('tenants').orderBy('id', 'asc').first();
  await db('tenants').where({ id: first.id }).update({ slug: 'alfa', name: 'Provedor Alfa' });
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  await db('tenants').insert({ slug: 'parada', name: 'Provedor Parado', status: 'suspended' });

  const setup = await callAs('alfa.painel.exemplo.com', `${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operador-alfa', password: 'senha-do-alfa-1', email: 'operador-alfa@exemplo.test' }
  });
  alfaToken = setup.body?.data?.token;

  // Beta's operator is created directly, because the setup route only ever
  // mints the first administrator of a provider that has none. The membership
  // is the part that matters and the part that is easy to forget: a person
  // with no row in `tenant_users` cannot sign in at all, and the token this
  // fixture is here to produce would come back undefined.
  const beta = await db('tenants').where({ slug: 'beta' }).first();
  const { default: User } = await import('../src/models/User.js');
  const { default: TenantUser } = await import('../src/models/TenantUser.js');
  const { runInTenant } = await import('../src/config/tenantContext.js');
  const betaUserId = await runInTenant(beta.id, async () => {
    const bcrypt = (await import('bcryptjs')).default;
    return User.create({
      username: 'operador-beta',
      password: await bcrypt.hash('senha-do-beta-1', 10),
      role: 'admin'
    });
  });
  await runInTenant(beta.id, () => TenantUser.create({
    tenantId: beta.id, userId: betaUserId, role: 'admin'
  }));
  const login = await callAs('beta.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
    method: 'POST',
    body: { username: 'operador-beta', password: 'senha-do-beta-1' }
  });
  betaToken = login.body?.data?.token;
  // Asserted here, once, rather than in each test that uses it: a fixture that
  // silently produced nothing would make `Bearer undefined` answer 403 for the
  // wrong reason, and every assertion below expects exactly 403.
  assert.ok(alfaToken, 'alfa precisa de um token');
  assert.ok(betaToken, 'beta precisa de um token');
});

after(async () => {
  await stopTestServers();
});

describe('reading a provider out of the host', () => {
  const cases = [
    ['alfa.painel.exemplo.com', 'alfa', 'the panel subdomain'],
    ['alfa.portal.exemplo.com', 'alfa', 'the portal subdomain'],
    ['ALFA.PAINEL.EXEMPLO.COM'.toLowerCase(), 'alfa', 'a host the client upcased'],
    ['painel.exemplo.com', null, 'the deployment\'s own name is not a provider'],
    ['a.b.painel.exemplo.com', null, 'two labels deep is refused rather than guessed'],
    ['alfa.painel.outro.com', null, 'another deployment entirely'],
    ['127.0.0.1', null, 'an address names nobody'],
    ['', null, 'no host at all']
  ];

  for (const [host, expected, why] of cases) {
    it(`${why}: ${host || '(vazio)'}`, () => {
      assert.equal(tenantSlugFromHost(host), expected);
    });
  }
});

describe('a host that names a provider', () => {
  it('serves that provider, not the first row', async () => {
    const alfa = await callAs('alfa.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
    });
    assert.equal(alfa.status, 200);

    // The same credentials on the other provider's host are nobody's.
    const beta = await callAs('beta.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
    });
    assert.equal(beta.status, 401);
  });

  // 404 and not 403: a 403 would confirm the slug exists, and the slug list is
  // the customer list.
  it('answers 404 for a slug nobody has', async () => {
    // Not `/api/health`: that one is mounted AHEAD of the resolver on purpose,
    // so that an unreachable database can still say what is down. It would
    // answer 200 here and prove nothing.
    const { status } = await callAs('gama.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
    });
    assert.equal(status, 404);
  });

  it('answers 404 for a provider that is not active', async () => {
    const { status } = await callAs('parada.painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'x', password: 'y' }
    });
    assert.equal(status, 404);
  });

  // Where subdomains are configured, naming the provider is how the deployment
  // works. Falling back to the first row here would answer with one provider's
  // data for a request that asked for nobody.
  it('refuses a host that names no provider at all', async () => {
    const { status } = await callAs('painel.exemplo.com', `${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
    });
    assert.equal(status, 404);
  });
});

describe('a token replayed on another provider\'s host', () => {
  it('works on the host it was minted for', async () => {
    const { status } = await callAs('alfa.painel.exemplo.com', `${panelUrl}/api/users`, {
      headers: { Authorization: `Bearer ${alfaToken}` }
    });
    assert.equal(status, 200);
  });

  it('is refused on the other provider\'s host', async () => {
    const { status, body } = await callAs('beta.painel.exemplo.com', `${panelUrl}/api/users`, {
      headers: { Authorization: `Bearer ${alfaToken}` }
    });
    assert.equal(status, 403);
    assert.equal(body.code, 'tenant_mismatch');
  });

  it('is refused in the other direction too', async () => {
    const { status } = await callAs('alfa.painel.exemplo.com', `${panelUrl}/api/users`, {
      headers: { Authorization: `Bearer ${betaToken}` }
    });
    assert.equal(status, 403);
  });
});

describe('the subscriber portal on a provider\'s host', () => {
  it('refuses a portal host that names nobody', async () => {
    const { status } = await callAs('portal.exemplo.com', `${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'CSG-0000000-000000', password: 'x' }
    });
    assert.equal(status, 404);
  });

  it('reaches the provider its host names', async () => {
    const { status } = await callAs('alfa.portal.exemplo.com', `${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: 'CSG-0000000-000000', password: 'errada' }
    });
    // 401 rather than 404: the provider resolved, the credentials did not.
    assert.equal(status, 401);
  });
});

describe('a portal session replayed on another provider\'s host', () => {
  let alfaCookie;
  let alfaAccountId;

  before(async () => {
    const db = getDb();
    const alfa = await db('tenants').where({ slug: 'alfa' }).first();
    const { runInTenant } = await import('../src/config/tenantContext.js');
    const { default: CustomerService } = await import('../src/services/customerService.js');
    const { default: CustomerPortalPasswordService } = await import(
      '../src/services/customerPortalPasswordService.js'
    );

    const account = await runInTenant(alfa.id, () => CustomerService.ensureAccount({
      _id: 'ONT-DO-ALFA', softwareId: 'V1', pppoe: 'assinante-do-alfa'
    }));
    alfaAccountId = account.id;
    const password = CustomerPortalPasswordService.reveal(account);

    const login = await callAs('alfa.portal.exemplo.com', `${portalUrl}/api/customer/login`, {
      method: 'POST',
      body: { customerId: account.customer_id, password }
    });
    assert.equal(login.status, 200, 'o assinante do alfa precisa conseguir entrar');
    alfaCookie = login.setCookie;
    assert.ok(alfaCookie, 'o login tem que devolver o cookie de sessao');
  });

  // The cookie carries no `domain`, so the browser will not send it to another
  // subdomain in the first place. This asserts what happens when something
  // sends it anyway — a copied header, a client that is not a browser.
  it('is not accepted on the other provider\'s portal', async () => {
    const { status } = await callAs('beta.portal.exemplo.com', `${portalUrl}/api/customer/session`, {
      headers: { Cookie: alfaCookie }
    });
    assert.equal(status, 401);
  });

  it('still works on its own provider\'s portal', async () => {
    const { status } = await callAs('alfa.portal.exemplo.com', `${portalUrl}/api/customer/session`, {
      headers: { Cookie: alfaCookie }
    });
    assert.equal(status, 200);
  });

  it('does not set a cookie domain, which is what keeps a browser from sending it at all', () => {
    assert.ok(!/;\s*domain=/i.test(alfaCookie), alfaCookie);
  });

  /**
   * The signed provider on its own, with the scoped read taken out of the way.
   *
   * The two tests above pass with or without `tenantId` in the payload, and
   * that is not a flaw in them — it is what defence in depth looks like from
   * the outside. `CustomerAccount.getById` reads through `tdb`, so under the
   * other provider's scope it finds nothing and the session is refused either
   * way, and no request can tell the two mechanisms apart.
   *
   * So this one puts the request where the scoped read WOULD succeed — running
   * as alfa, where the account is — while the request claims to be beta's. That
   * is precisely the future in which somebody adds a reader that forgets the
   * filter, and it is the only shape in which the signed provider can be seen
   * to do anything.
   */
  it('refuses a cookie whose provider is not the request\'s, even where the account is readable', async () => {
    const db = getDb();
    const alfa = await db('tenants').where({ slug: 'alfa' }).first();
    const beta = await db('tenants').where({ slug: 'beta' }).first();
    const { runInTenant } = await import('../src/config/tenantContext.js');
    const { authenticatePortalCustomer, PORTAL_COOKIE_NAME } = await import(
      '../src/middleware/portalAuth.js'
    );

    const token = alfaCookie.split(';')[0].slice(PORTAL_COOKIE_NAME.length + 1);
    const req = {
      headers: { cookie: `${PORTAL_COOKIE_NAME}=${token}` },
      tenantId: beta.id,
      t: (key) => key
    };
    let status = null;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    let passedThrough = false;

    await runInTenant(alfa.id, () => authenticatePortalCustomer(req, res, () => {
      passedThrough = true;
    }));

    assert.equal(passedThrough, false, 'a sessao de outro provedor nao pode passar');
    assert.equal(status, 401);
  });
});

describe('the slug cache', () => {
  // A miss is not worth remembering, and remembering it is worse than useless:
  // anyone who can reach the panel could grow the Map without bound by asking
  // for one made-up subdomain after another. Providers are few; the hits are
  // what the cache is for.
  it('does not grow from slugs nobody has', async () => {
    const { resolveTenantIdBySlug, forgetResolvedTenant } = await import(
      '../src/middleware/tenantResolver.js'
    );
    forgetResolvedTenant();

    // Warm a real one so the cache is not simply empty, which would make this
    // pass whether or not misses are kept.
    assert.ok(await resolveTenantIdBySlug('alfa'));
    for (const guess of ['aa', 'ab', 'ac', 'ad', 'ae', 'af']) {
      assert.equal(await resolveTenantIdBySlug(guess), null);
    }

    const db = getDb();
    let queries = 0;
    const count = () => { queries += 1; };
    db.on('query', count);
    try {
      await resolveTenantIdBySlug('alfa');
      assert.equal(queries, 0, 'o acerto tem que vir do cache');
      await resolveTenantIdBySlug('aa');
      assert.equal(queries, 1, 'o erro tem que ir ao banco de novo, e nao ficar guardado');
    } finally {
      db.off('query', count);
    }
  });

  /**
   * O slug renomeado DIRETO no banco — que é o que as outras instâncias de um
   * deploy enxergam quando o console roda numa só: ninguém chamou
   * `forgetResolvedTenant()` neste processo. Antes, o endereço antigo resolvia
   * até o restart; agora, até `RESOLVED_TENANT_TTL_MS`.
   */
  it('lets a slug renamed behind its back stop resolving once the entry expires', async () => {
    const { resolveTenantIdBySlug, forgetResolvedTenant, setResolverClockForTests, RESOLVED_TENANT_TTL_MS } =
      await import('../src/middleware/tenantResolver.js');
    const db = getDb();
    let agora = 1_000_000;
    setResolverClockForTests(() => agora);
    forgetResolvedTenant();
    await db('tenants').insert({ slug: 'renomeia', name: 'Renomeia ISP', status: 'active' });
    const id = (await db('tenants').where({ slug: 'renomeia' }).first()).id;
    try {
      assert.equal(await resolveTenantIdBySlug('renomeia'), id);

      await db('tenants').where({ id }).update({ slug: 'renomeado' });

      // Dentro do prazo, o cache ainda responde — é o custo aceito.
      agora += RESOLVED_TENANT_TTL_MS - 1;
      assert.equal(await resolveTenantIdBySlug('renomeia'), id);

      // Vencido, é falta: relê o banco, e o endereço antigo não é de ninguém.
      agora += 2;
      assert.equal(await resolveTenantIdBySlug('renomeia'), null,
        'o endereço antigo segue resolvendo depois do prazo');
      assert.equal(await resolveTenantIdBySlug('renomeado'), id);
    } finally {
      setResolverClockForTests();
      forgetResolvedTenant();
    }
  });

  it('expires the default provider too', async () => {
    const { resolveDefaultTenantId, forgetResolvedTenant, setResolverClockForTests, RESOLVED_TENANT_TTL_MS } =
      await import('../src/middleware/tenantResolver.js');
    const db = getDb();
    let agora = 5_000_000;
    setResolverClockForTests(() => agora);
    forgetResolvedTenant();
    try {
      await resolveDefaultTenantId();
      let queries = 0;
      const count = () => { queries += 1; };
      db.on('query', count);
      try {
        await resolveDefaultTenantId();
        assert.equal(queries, 0, 'dentro do prazo, o acerto vem do cache');
        agora += RESOLVED_TENANT_TTL_MS;
        await resolveDefaultTenantId();
        assert.equal(queries, 1, 'vencida, a entrada tem que ser relida');
      } finally {
        db.off('query', count);
      }
    } finally {
      setResolverClockForTests();
      forgetResolvedTenant();
    }
  });
});

describe('the rate limit bucket', () => {
  // The deployment this matters for is the one the code already describes:
  // every client arrives through one tunnel, so one address is every caller.
  // Keyed by address alone, one provider's traffic switches off everybody.
  it('is not shared between two providers on the same address', async () => {
    const { tenantIpKey } = await import('../src/middleware/rateLimit.js');
    const asHost = (host) => tenantIpKey({ headers: { host }, ip: '203.0.113.7' });

    assert.notEqual(asHost('alfa.painel.exemplo.com'), asHost('beta.painel.exemplo.com'));
    assert.equal(asHost('alfa.painel.exemplo.com'), asHost('alfa.painel.exemplo.com:443'));
  });

  it('collapses to one bucket where no host names a provider', async () => {
    const { tenantIpKey } = await import('../src/middleware/rateLimit.js');
    const one = tenantIpKey({ headers: { host: '127.0.0.1:5890' }, ip: '203.0.113.7' });
    const two = tenantIpKey({ headers: { host: 'painel.exemplo.com' }, ip: '203.0.113.7' });
    assert.equal(one, two);
  });
});

describe('the deployment without subdomains', () => {
  // Every other suite in this repo is this case, and they are what prove it:
  // no base domain, no host names a provider, and the first row answers. The
  // assertion here is only that `call` — which cannot set Host — still works
  // against a server that HAS base domains configured, because 127.0.0.1
  // names nobody and this deployment does.
  it('refuses a request with no provider in its host', async () => {
    const { status } = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'operador-alfa', password: 'senha-do-alfa-1' }
    });
    assert.equal(status, 404);
  });
});

/**
 * The one route that answers a stranger with something out of `tenants`.
 *
 * It exists so the login screen can render the provider's own name before
 * anybody has signed in, which makes it the enumeration surface of the whole
 * deployment — a place where "this ISP is a customer of ours" is one request
 * away. The assertions below are about what it refuses to say, not only about
 * what it returns.
 */
describe('the provider a login screen sees', () => {
  it('answers with the provider its host names', async () => {
    const { status, body } = await callAs(
      'alfa.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    assert.equal(status, 200);
    assert.equal(body.data.name, 'Provedor Alfa');
    assert.equal(body.data.slug, 'alfa');
  });

  // The failure this guards is the resolver reverting to the first row: with
  // one provider in the fixture that mistake is invisible, and it is exactly
  // the mistake that puts one ISP's name on another ISP's login screen.
  it('answers with the OTHER provider on the other provider\'s host', async () => {
    const { status, body } = await callAs(
      'beta.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    assert.equal(status, 200);
    assert.equal(body.data.name, 'Provedor Beta');
  });

  it('needs no token at all', async () => {
    const { status } = await callAs(
      'alfa.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    assert.equal(status, 200);
  });

  /**
   * Pinned key by key, so nobody widens what a stranger sees without touching
   * this line.
   *
   * `id` is the field this is really watching for. It is the stable primary key
   * of a `tenants` row, the screen has no use for it, and once an
   * unauthenticated response carries it, clients start sending it back — which
   * is the shape of parameter that becomes an IDOR the day a route trusts it
   * over the host. `status`, `created_at` and any future column are the same
   * argument with a different name on it.
   *
   * `shared` entrou com justificativa, que é o que esta linha cobra: ele não
   * diz nada SOBRE ESTE PROVEDOR — diz que o deploy põe todos os provedores no
   * mesmo endereço, que é fato do deploy, da mesma família de `edition` e
   * `panelBaseDomain`, e que a tela precisa para não vestir a marca de um ISP
   * na porta de todos. Aqui, com domínio-base, ele é sempre `false`.
   *
   * `kind` entrou pela mesma porta e com a mesma cobrança: ele não diz nada
   * sobre o NEGÓCIO deste provedor — diz qual dos endereços do próprio deploy
   * se está olhando, o de um ISP ou o da caixa com que a plataforma atende os
   * ISPs. O nome e o slug, que já saem aqui, já dizem isso a quem souber ler;
   * o campo apenas para de exigir que se saiba. Sem ele, o onboarding manda a
   * caixa da plataforma configurar um GenieACS que ela não tem por que ter.
   */
  it('returns the public fields and nothing else', async () => {
    const { body } = await callAs(
      'alfa.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    assert.deepEqual(
      Object.keys(body.data).sort(),
      ['edition', 'kind', 'name', 'panelBaseDomain', 'shared', 'slug']
    );
    assert.equal(body.data.kind, 'provider');
    assert.equal(body.data.shared, false);
    assert.deepEqual(Object.keys(body).sort(), ['data', 'message', 'success']);
  });

  it('answers 404 for a host nobody has', async () => {
    const { status } = await callAs(
      'gama.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    assert.equal(status, 404);
  });

  it('answers 404 for a provider that is not active', async () => {
    const { status } = await callAs(
      'parada.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    assert.equal(status, 404);
  });

  /**
   * The assertion the two above cannot make on their own.
   *
   * Two 404s prove nothing if their bodies differ: a message, a code, a
   * `retryAfter`, anything that only the real-but-suspended provider can
   * produce, and a prober sweeping candidate slugs can sort the deployment's
   * customer list from the rest of the dictionary — and then tell which of
   * those customers is switched off, which is a fact about somebody else's
   * business we would be publishing. Compared whole, deliberately, so that a
   * field added to either answer fails here.
   */
  it('says exactly the same thing about a suspended provider as about no provider', async () => {
    const missing = await callAs(
      'gama.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    const suspended = await callAs(
      'parada.painel.exemplo.com', `${panelUrl}/api/tenant/public`
    );
    assert.equal(suspended.status, missing.status);
    assert.deepEqual(suspended.body, missing.body);
  });

  // Where subdomains are configured, a host that names no provider is the
  // platform's own front door. It answers — that is where a new ISP signs up —
  // but with NO provider: answering the first row here would brand the
  // deployment's own name page with one arbitrary customer's.
  it('answers the platform\'s own host with no provider in it', async () => {
    const { status, body } = await callAs('painel.exemplo.com', `${panelUrl}/api/tenant/public`);
    assert.equal(status, 200);
    assert.equal(body.data.slug, null);
    assert.equal(body.data.name, null);
    assert.equal(body.data.panelBaseDomain, 'painel.exemplo.com');
  });

  // The portal's base is not a front door: nothing a stranger needs lives there.
  it('refuses the portal\'s own base host', async () => {
    const { status } = await callAs('portal.exemplo.com', `${panelUrl}/api/tenant/public`);
    assert.equal(status, 404);
  });
});
