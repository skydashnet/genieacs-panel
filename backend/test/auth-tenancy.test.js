import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  authHeaders,
  call,
  getDb,
  insertReturningId,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

const { default: TenantUser } = await import('../src/models/TenantUser.js');

/**
 * The authentication spine, after wave 12.
 *
 * `users` answers who somebody is; `tenant_users` answers who they work for.
 * The session lives at the crossing of the two, so what has to be proved here
 * is not that a token is well formed but that the provider it names is the
 * provider its requests actually read from — asserted on real rows, because a
 * correct-looking claim in a token that the request then ignores is exactly the
 * failure this change exists to remove.
 *
 * Every sign-in here spends from the login limiter's twenty attempts per
 * quarter hour, which is why sessions are minted once and reused.
 */
let panelUrl;
let alfa;
let beta;

// One person, one login, administrator at both ISPs: the reseller arrangement
// the plan refuses to close off, and the sharpest form of the leak test —
// nothing but the token distinguishes the two requests.
const CONSULTORA = { username: 'consultora', password: 'consultora-senha-1', email: 'consultora@exemplo.test' };
// Ordinary operator at Alfa, administrator at Beta. The role is the
// membership's, so the same password opens different doors at each.
const PLANTONISTA = { username: 'plantonista', password: 'plantonista-senha-1', email: 'plantonista@exemplo.test' };
// A single membership: the person a token minted before this change belongs to.
const SOZINHO = { username: 'sozinho', password: 'sozinho-senha-1', email: 'sozinho@exemplo.test' };
// Taken off Alfa's team and on nobody else's. The account is real and the
// password is right, which is exactly what makes this the dangerous case.
const DESEMPREGADO = { username: 'desempregado', password: 'desempregado-senha-1', email: 'desempregado@exemplo.test' };
// Taken off Alfa's team and still on Beta's. Removal ends a membership, never
// a person, so she has to keep the login she uses at her other ISP.
const REMOVIDA = { username: 'removida', password: 'removida-senha-1', email: 'removida@exemplo.test' };
// The night shift, signed in at both providers at once.
const NOTURNO = { username: 'noturno', password: 'noturno-senha-1', email: 'noturno@exemplo.test' };

const ACS_ALFA = 'http://acs.alfa.test:7557';
const ACS_BETA = 'http://acs.beta.test:7557';

let ownerToken;
const idOf = {};

/** Creates the person through the panel's own route, so they land at Alfa. */
async function hire(person, role) {
  const { status, body } = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(ownerToken),
    body: { ...person, role }
  });
  assert.equal(status, 201, `could not create ${person.username}`);
  idOf[person.username] = body.data.user.id;
  return body.data.user.id;
}

const signIn = (person, tenantId) => call(`${panelUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Accept-Language': 'en' },
  body: tenantId === undefined ? person : { ...person, tenantId }
});

/** The provider a session reads from, taken from a row only that provider has. */
const acsSeenBy = (token) => call(`${panelUrl}/api/settings/genieAcsUrl`, {
  headers: authHeaders(token)
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();

  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  beta = await insertReturningId('tenants', {
    slug: 'beta', name: 'Provedor Beta', status: 'active'
  });

  // Two ACS addresses, one per provider: the scoped fact each session is
  // expected to read. Written straight to the table because Beta arrived after
  // the defaults were seeded, and because the claim is about what the TABLE
  // holds, not about what a model would return.
  await db('settings').where({ tenant_id: alfa, key: 'genieAcsUrl' }).update({ value: ACS_ALFA });
  await db('settings').insert({ tenant_id: beta, key: 'genieAcsUrl', value: ACS_BETA });
});

after(async () => {
  await stopTestServers();
});

describe('a fresh install', () => {
  // First, because everything below needs the administrator it creates — and
  // because it is the case that breaks first: an admin row without a membership
  // is an install with the right password and no way in.
  it('creates the first administrator AND their membership', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
    });
    assert.equal(status, 201);
    assert.equal(body.data.user.role, 'owner');
    assert.equal(Number(body.data.user.tenantId), Number(alfa));
    ownerToken = body.data.token;
    idOf.owner = body.data.user.id;

    const membership = await TenantUser.find(alfa, body.data.user.id);
    assert.ok(membership, 'setup left the first administrator working for nobody');
    assert.equal(membership.role, 'owner');
  });

  it('lets that administrator sign in and reach an administrator-only route', async () => {
    const { status, body } = await acsSeenBy(ownerToken);
    assert.equal(status, 200);
    assert.equal(body.data.genieAcsUrl, ACS_ALFA);
  });
});

describe('who works for whom', () => {
  before(async () => {
    await hire(CONSULTORA, 'admin');
    await hire(PLANTONISTA, 'viewer');
    await hire(SOZINHO, 'viewer');
    await hire(NOTURNO, 'admin');
    await hire(DESEMPREGADO, 'viewer');
    await hire(REMOVIDA, 'viewer');

    // Second memberships, at the other ISP. `tenant_users` is written directly
    // because the route that will manage a provider's team belongs to lane B;
    // what is under test here is what the spine does with the rows, not how
    // they get written.
    await TenantUser.create({ tenantId: beta, userId: idOf.consultora, role: 'admin' });
    await TenantUser.create({ tenantId: beta, userId: idOf.plantonista, role: 'admin' });
    await TenantUser.create({ tenantId: beta, userId: idOf.noturno, role: 'admin' });
    await TenantUser.create({ tenantId: beta, userId: idOf.removida, role: 'admin' });

    // Two people taken off Alfa's team, through the route an administrator
    // actually uses. It ends the membership and leaves the person — their name
    // is on history that points at `users.id` — so what stops them working here
    // is the login refusing them, not the row being gone.
    for (const person of [DESEMPREGADO, REMOVIDA]) {
      const { status } = await call(`${panelUrl}/api/users/${idOf[person.username]}`, {
        method: 'DELETE',
        headers: authHeaders(ownerToken)
      });
      assert.equal(status, 200, `could not take ${person.username} off the team`);
      assert.ok(await getDb()('users').where({ username: person.username }).first(),
        'removal deleted the person instead of the membership');
    }
    assert.equal((await TenantUser.listForUser(idOf.desempregado)).length, 0);
    assert.equal((await TenantUser.listForUser(idOf.removida)).length, 1);
  });

  it('signs in a person with one membership, and the token names that provider', async () => {
    const { status, body } = await signIn(SOZINHO);
    assert.equal(status, 200);
    assert.equal(Number(body.data.user.tenantId), Number(alfa));

    const claims = jwt.decode(body.data.token);
    assert.equal(Number(claims.tenantId), Number(alfa),
      'the access token has to carry the provider, not just the response');
    assert.equal(claims.role, 'viewer');

    // And the refresh token has to be able to mint the same thing again.
    assert.equal(Number(jwt.decode(body.data.refreshToken).tenantId), Number(alfa));
  });

  it('gives the membership its role, not the one on the person', async () => {
    const atAlfa = await signIn(PLANTONISTA, alfa);
    const atBeta = await signIn(PLANTONISTA, beta);
    assert.equal(atAlfa.body.data.user.role, 'viewer');
    assert.equal(atBeta.body.data.user.role, 'admin');

    // In the token too, and this is where the two genuinely differ: the person
    // row still says `viewer`, which is what the old token carried.
    assert.equal(jwt.decode(atBeta.body.data.token).role, 'admin');
    const person = await getDb()('users').where({ username: PLANTONISTA.username }).first();
    assert.equal(person.role, 'viewer', 'and `users.role` still says otherwise');

    // Not decoration: it is what the panel authorises with.
    assert.equal((await acsSeenBy(atAlfa.body.data.token)).status, 403);
    assert.equal((await acsSeenBy(atBeta.body.data.token)).status, 200);
  });
});

describe('a request authenticated for one provider', () => {
  let atAlfa;
  let atBeta;

  before(async () => {
    atAlfa = (await signIn(CONSULTORA, alfa)).body.data.token;
    atBeta = (await signIn(CONSULTORA, beta)).body.data.token;
  });

  // The one that is a leak rather than a bug. Same person, same password, same
  // route, same process — the token is the only difference between the two
  // requests, and the answer has to be the other ISP's ACS address in one and
  // never in the other. Before this change `resolveTenant` answered with the
  // first provider for both, so the Beta session read Alfa's row.
  // O topo do menu diz de quem é o painel. Tem que ser o provedor do TOKEN:
  // mesma pessoa, mesmo host, e a resposta muda só com a sessão.
  it('names the session\'s own provider in /auth/user', async () => {
    const fromAlfa = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(atAlfa) });
    const fromBeta = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(atBeta) });
    const alfaRow = await getDb()('tenants').where({ id: alfa }).first();

    assert.equal(fromAlfa.status, 200);
    assert.equal(fromBeta.status, 200);
    assert.deepEqual(fromAlfa.body.data.tenant, { slug: alfaRow.slug ?? null, name: alfaRow.name });
    assert.deepEqual(fromBeta.body.data.tenant, { slug: 'beta', name: 'Provedor Beta' });
  });

  it('reads that provider\'s rows and never the other\'s', async () => {
    const fromAlfa = await acsSeenBy(atAlfa);
    const fromBeta = await acsSeenBy(atBeta);

    assert.equal(fromAlfa.status, 200);
    assert.equal(fromBeta.status, 200);
    assert.equal(fromAlfa.body.data.genieAcsUrl, ACS_ALFA);
    assert.equal(fromBeta.body.data.genieAcsUrl, ACS_BETA);
    assert.notEqual(fromBeta.body.data.genieAcsUrl, ACS_ALFA,
      'the Beta session was served the Alfa provider\'s ACS');
  });

  it('writes into that provider and leaves the other\'s row alone', async () => {
    const changed = await call(`${panelUrl}/api/settings/genieAcsUrl`, {
      method: 'PUT',
      headers: authHeaders(atBeta),
      body: { value: 'http://acs.beta.mudou:7557' }
    });
    assert.equal(changed.status, 200);

    const rows = await getDb()('settings').where({ key: 'genieAcsUrl' }).orderBy('tenant_id');
    const byTenant = Object.fromEntries(rows.map((r) => [Number(r.tenant_id), r.value]));
    assert.equal(byTenant[Number(alfa)], ACS_ALFA, 'Alfa never asked for a new ACS');
    assert.equal(byTenant[Number(beta)], 'http://acs.beta.mudou:7557');

    // Put it back; the tests below read it.
    await getDb()('settings')
      .where({ tenant_id: beta, key: 'genieAcsUrl' })
      .update({ value: ACS_BETA });
  });

  it('refuses a token naming a provider the person does not work for', async () => {
    // The same token that worked two assertions ago. Nothing about it changed;
    // the row it stands on went away, and the membership is re-read from the
    // table on every request precisely so that ends the session within the hour
    // rather than at its expiry.
    await TenantUser.remove(beta, idOf.consultora);
    assert.equal((await acsSeenBy(atBeta)).status, 403);

    await TenantUser.create({ tenantId: beta, userId: idOf.consultora, role: 'admin' });
    assert.equal((await acsSeenBy(atBeta)).status, 200, 'and it works again once she is back');
  });
});

describe('somebody taken off a provider\'s team', () => {
  // The regression this closes. `DELETE /api/users/:id` ends the membership and
  // keeps the person, which is right — she may work for another ISP, and her
  // name is on `wa_messages.sent_by` and its neighbours. But a login that
  // resolves by `username` alone would then hand a working session to somebody
  // who was removed this morning, at the provider that removed her.
  it('cannot sign in at the provider that removed her', async () => {
    const { status } = await signIn(REMOVIDA, alfa);
    assert.equal(status, 401, 'a removed operator kept a working login');
  });

  it('still signs in at the provider she does work for', async () => {
    const { status, body } = await signIn(REMOVIDA);
    assert.equal(status, 200, 'removal from one ISP is not removal from the other');
    assert.equal(Number(body.data.user.tenantId), Number(beta),
      'with one membership left there is nothing to choose between');

    // And she reads Beta's rows, not the rows of the provider she left.
    const { body: seen } = await acsSeenBy(body.data.token);
    assert.equal(seen.data.genieAcsUrl, ACS_BETA);
  });
});

describe('a session open when the membership ends', () => {
  /**
   * The plan wanted a `membershipVersion` in the token so a single membership
   * could be revoked without ending the person's other sessions. It is not
   * needed, and this is the test that says why: `hydrateAuthenticatedUser`
   * reads `tenant_users` on EVERY authenticated request, so the row itself is
   * the revocation. A counter would be a cached copy of a fact already being
   * read fresh — strictly weaker, and one more thing to forget to bump.
   */
  it('stops working on the next request, with no counter to bump', async () => {
    const { status: signedIn, body } = await signIn(CONSULTORA, alfa);
    assert.equal(signedIn, 200, 'a fixture that cannot sign in proves nothing');
    const token = body.data.token;

    const before = await acsSeenBy(token);
    assert.equal(before.status, 200, 'the token has to work before it is revoked');

    const user = await getDb()('users').where({ username: CONSULTORA.username }).first();
    await TenantUser.remove(alfa, user.id);

    const after = await acsSeenBy(token);
    assert.equal(after.status, 403, 'the membership row is the revocation');
  });
});

describe('somebody who works for nobody', () => {
  it('cannot sign in, and cannot tell that from a wrong password', async () => {
    const noMembership = await signIn(DESEMPREGADO);
    const wrongPassword = await signIn({ ...CONSULTORA, password: 'senha-errada-1' });

    assert.equal(noMembership.status, 401);
    assert.equal(noMembership.status, wrongPassword.status);
    assert.deepEqual(noMembership.body, wrongPassword.body,
      'the refusal names itself, and tells a prober the account is real');
  });
});

describe('a token minted before the provider was in it', () => {
  // Exactly the old payload: no `tenantId`, and the role read off `users`.
  // Signed with the same secret, issuer and audience the panel signs with, so
  // it is indistinguishable from one issued by yesterday's process.
  async function legacyTokenFor(username) {
    const user = await getDb()('users').where({ username }).first();
    return jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: user.role,
        tokenVersion: Number(user.token_version || 0)
      },
      process.env.JWT_SECRET,
      { issuer: 'skygenpanel', audience: 'skygenpanel-admin', expiresIn: '1h' }
    );
  }

  it('keeps working, resolved through the person\'s sole membership', async () => {
    const token = await legacyTokenFor(SOZINHO.username);
    const { status, body } = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 200, 'an upgrade must not log out the night shift');
    assert.equal(Number(body.data.tenantId), Number(alfa));
    assert.equal(body.data.role, 'viewer');
  });

  it('is refused once that person works for two providers', async () => {
    const token = await legacyTokenFor(SOZINHO.username);
    await TenantUser.create({ tenantId: beta, userId: idOf.sozinho, role: 'viewer' });

    const { status } = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(token) });
    assert.equal(status, 403, 'with two providers and none named there is no honest answer');
  });
});

describe('refreshing a session', () => {
  it('mints a token for the same provider it was minted at', async () => {
    const signedIn = await signIn(NOTURNO, beta);
    assert.equal(signedIn.status, 200);

    const { status, body } = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST',
      body: { refreshToken: signedIn.body.data.refreshToken }
    });
    assert.equal(status, 200);
    assert.equal(Number(jwt.decode(body.data.token).tenantId), Number(beta));

    // And the renewed session still reads Beta, which is the claim that matters.
    const { body: seen } = await acsSeenBy(body.data.token);
    assert.equal(seen.data.genieAcsUrl, ACS_BETA);
  });
});

describe('changing a password', () => {
  // `token_version` stays on the person, so it revokes across providers. That
  // is the correct blast radius: the credential that was compromised is the
  // person's, not the membership's.
  it('ends every session that person has, at every provider', async () => {
    const atAlfa = (await signIn(NOTURNO, alfa)).body.data.token;
    const atBeta = (await signIn(NOTURNO, beta)).body.data.token;
    assert.equal((await acsSeenBy(atAlfa)).status, 200);
    assert.equal((await acsSeenBy(atBeta)).status, 200);

    const changed = await call(`${panelUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: authHeaders(atAlfa),
      body: { currentPassword: NOTURNO.password, newPassword: 'noturno-senha-2' }
    });
    assert.equal(changed.status, 200);

    assert.equal((await acsSeenBy(atAlfa)).status, 403);
    assert.equal((await acsSeenBy(atBeta)).status, 403,
      'the session at the other provider survived a password change');
  });
});
