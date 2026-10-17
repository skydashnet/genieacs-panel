import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {
  authHeaders,
  call,
  getDb,
  insertReturningId,
  startTestServers,
  stopTestServers
} from './helpers/harness.js';

/**
 * `/api/users` is one provider's team.
 *
 * Every request in this file resolves to the installation's own provider —
 * "alfa" below — because that is what `resolveTenant` answers today. Beta is a
 * second ISP on the same deployment, reachable only through the database here,
 * and it exists so every assertion can ask the question that matters: does the
 * endpoint see, count, or touch anything of beta's?
 */
let panelUrl;
let alfa;
let beta;
let ownerToken;
let ownerId;
let anaId;
let aliceId;
let carolToken;
let carolId;
let brunoId;
let biaId;

const CAROL = { username: 'carol', password: 'carol-password-1', email: 'carol@exemplo.test' };
const BRUNO = { username: 'bruno', password: 'bruno-password-1', email: 'bruno@exemplo.test' };

/** MySQL's TIMESTAMP keeps whole seconds, so seeded times carry none. */
function wholeSecond(date = new Date()) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

async function seedPerson({ username, password, role, email = null }) {
  return insertReturningId('users', {
    username,
    password: bcrypt.hashSync(password, 4),
    role,
    // O e-mail acompanha, senão a linha semeada não tem endereço nenhum e o
    // caso que prova a colisão por e-mail passaria por não haver com o que
    // colidir — verde, e provando o contrário do que diz.
    email
  });
}

async function seedMembership(tenantId, userId, role) {
  await getDb()('tenant_users').insert({ tenant_id: tenantId, user_id: userId, role });
}

const membershipOf = (tenantId, userId) => getDb()('tenant_users')
  .where({ tenant_id: tenantId, user_id: userId })
  .first();

const personOf = (userId) => getDb()('users').where({ id: userId }).first();

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'owner', password: 'owner-password-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  ownerToken = setup.body.data.token;
  ownerId = setup.body.data.user.id;

  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  // `/api/auth/setup` writes the membership along with the person, in the same
  // transaction as the setup latch, so the owner is on the team of the provider
  // she just set up. This hook seeded that row by hand while the login path was
  // still being written; seeding it now would insert it twice.
  assert.ok(await membershipOf(alfa, ownerId),
    'setup left the first administrator off her own team');

  // Alfa's staff, hired the way the panel hires: through this endpoint.
  const ana = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(ownerToken),
    body: { username: 'ana', password: 'ana-password-1', role: 'admin', email: 'ana@exemplo.test' }
  });
  assert.equal(ana.status, 201);
  anaId = ana.body.data.user.id;

  const alice = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(ownerToken),
    body: { username: 'alice', password: 'alice-password-1', role: 'viewer', email: 'alice@exemplo.test' }
  });
  assert.equal(alice.status, 201);
  aliceId = alice.body.data.user.id;

  // Carol is the arrangement the wave exists for: an administrator at the ISP
  // she runs (beta) and an ordinary operator at the one she consults for
  // (alfa). Her `users.role` says 'admin', and nothing reads it: the route
  // guard authorises from the role of the membership the token names, so the
  // column disagreeing with where she actually holds that role is the point.
  carolId = await seedPerson({ ...CAROL, role: 'admin' });
  await seedMembership(alfa, carolId, 'viewer');

  // Beta's own staff. Neither is an administrator there yet: the first guard
  // test needs the other provider to contribute nothing to the count.
  brunoId = await seedPerson({ ...BRUNO, role: 'admin' });
  await seedMembership(beta, brunoId, 'viewer');
  biaId = await seedPerson({ username: 'bia', password: 'bia-password-1', role: 'viewer' });
  await seedMembership(beta, biaId, 'viewer');

  const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: CAROL });
  assert.equal(login.status, 200);
  carolToken = login.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('the team of one provider', () => {
  it('lists the people who work here and nobody else', async () => {
    const { status, body } = await call(`${panelUrl}/api/users`, {
      headers: authHeaders(ownerToken)
    });
    assert.equal(status, 200);
    assert.deepEqual(
      body.data.users.map((user) => user.username).sort(),
      ['alice', 'ana', 'carol', 'owner']
    );
    const names = body.data.users.map((user) => user.username);
    assert.ok(!names.includes('bruno'), "beta's staff is not alfa's business");
    assert.ok(!names.includes('bia'));
  });

  it('reports the role of the membership, not of the person', async () => {
    const { body } = await call(`${panelUrl}/api/users`, {
      headers: authHeaders(ownerToken)
    });
    const byName = Object.fromEntries(body.data.users.map((user) => [user.username, user]));
    assert.equal(byName.ana.role, 'admin');
    assert.equal(byName.alice.role, 'viewer');
    // The one that tells the two apart: carol is `users.role` 'admin' and an
    // ordinary operator here.
    assert.equal((await personOf(carolId)).role, 'admin');
    assert.equal(byName.carol.role, 'viewer');
  });

  it('never exposes a password hash', async () => {
    const { body } = await call(`${panelUrl}/api/users`, {
      headers: authHeaders(ownerToken)
    });
    assert.ok(!JSON.stringify(body.data.users).includes('$2'));
  });
});

describe('somebody who works for another provider', () => {
  it('cannot be updated from here, and answers as nonexistent', async () => {
    const before = await personOf(brunoId);
    const { status } = await call(`${panelUrl}/api/users/${brunoId}`, {
      method: 'PATCH',
      headers: authHeaders(ownerToken),
      body: { role: 'admin', password: 'alfa-owns-you-now' }
    });
    // 404 rather than 403: "you may not touch this one" would confirm that the
    // id is a real person somewhere else on the deployment.
    assert.equal(status, 404);

    const after = await personOf(brunoId);
    assert.equal(after.password, before.password, "beta's operator keeps his password");
    assert.equal(after.role, before.role);
    assert.equal(Number(after.token_version), Number(before.token_version));
    assert.equal((await membershipOf(beta, brunoId)).role, 'viewer');
    assert.equal(await membershipOf(alfa, brunoId), undefined, 'and gains no membership here');
  });

  it('cannot be removed from here', async () => {
    const { status } = await call(`${panelUrl}/api/users/${brunoId}`, {
      method: 'DELETE',
      headers: authHeaders(ownerToken)
    });
    assert.equal(status, 404);
    assert.ok(await personOf(brunoId), 'the person is untouched');
    assert.equal((await membershipOf(beta, brunoId)).role, 'viewer', 'and so is his job at beta');
  });

  it('cannot be hired here by typing their username', async () => {
    const before = await personOf(brunoId);
    const { status } = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(ownerToken),
      // Com um e-mail NOVO e válido de propósito: assim a recusa só pode vir
      // do nome já existir, e não de faltar campo no corpo. Um 400 por e-mail
      // ausente recusaria pelo motivo errado e o teste passaria sem provar
      // nada sobre o atalho.
      body: {
        username: BRUNO.username,
        password: 'guessed-a-username',
        role: 'admin',
        email: 'chute-do-alfa@exemplo.test'
      }
    });
    // Refused, and refused with the same words a username taken here would get.
    // Creating carries a password, and there is one password per person: taking
    // this shortcut would reset beta's operator's login and hand it to alfa.
    assert.equal(status, 409);
    const after = await personOf(brunoId);
    assert.equal(after.password, before.password);
    assert.equal(await membershipOf(alfa, brunoId), undefined);
  });

  it('nem digitando o e-mail dele, com um nome novo', async () => {
    // O mesmo atalho pela outra porta, e ela nasceu junto com a coluna de
    // e-mail: se só o nome fosse conferido, bastaria inventar um `username` e
    // digitar o endereço do operador do vizinho para tomar a conta dele.
    const before = await personOf(brunoId);
    const { status } = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(ownerToken),
      body: {
        username: 'nome-que-ninguem-tem',
        password: 'guessed-an-email',
        role: 'admin',
        email: BRUNO.email
      }
    });
    assert.equal(status, 409);
    const after = await personOf(brunoId);
    assert.equal(after.password, before.password, 'a senha do operador do vizinho foi trocada');
    assert.equal(await getDb()('users').where({ username: 'nome-que-ninguem-tem' }).first(), undefined,
      'a conta não pode ser criada com o e-mail de outra pessoa');
  });

  it('is not found when the id belongs to nobody at all', async () => {
    const { status } = await call(`${panelUrl}/api/users/98765`, {
      method: 'PATCH',
      headers: authHeaders(ownerToken),
      body: { role: 'viewer' }
    });
    assert.equal(status, 404);
  });
});

describe('ending a membership', () => {
  let broadcastId;
  let optOutId;

  before(async () => {
    // History that points at the person by id. All three of these columns are
    // ON DELETE SET NULL, so deleting the row would quietly blank the record of
    // who did what.
    broadcastId = await insertReturningId('wa_broadcasts', {
      tenant_id: alfa,
      title: 'Aviso de manutenção',
      body: 'manutenção programada',
      status: 'draft',
      created_by: aliceId,
      created_at: wholeSecond(),
      updated_at: wholeSecond()
    });
    optOutId = await insertReturningId('wa_opt_outs', {
      tenant_id: alfa,
      wa_phone_e164: '+5511999990000',
      origin: 'operator',
      revoked_at: wholeSecond(),
      revoked_by: aliceId,
      created_at: wholeSecond()
    });
  });

  it('removes the person from this provider without deleting the person', async () => {
    const { status } = await call(`${panelUrl}/api/users/${aliceId}`, {
      method: 'DELETE',
      headers: authHeaders(ownerToken)
    });
    assert.equal(status, 200);

    assert.equal(await membershipOf(alfa, aliceId), undefined, 'the membership is over');
    const person = await personOf(aliceId);
    assert.ok(person, 'the person survives');
    assert.equal(person.username, 'alice');

    const broadcast = await getDb()('wa_broadcasts').where({ id: broadcastId }).first();
    assert.equal(Number(broadcast.created_by), Number(aliceId), 'history still names her');
    const optOut = await getDb()('wa_opt_outs').where({ id: optOutId }).first();
    assert.equal(Number(optOut.revoked_by), Number(aliceId));

    const { body } = await call(`${panelUrl}/api/users`, { headers: authHeaders(ownerToken) });
    assert.ok(!body.data.users.some((user) => user.id === aliceId), 'and the team no longer lists her');
  });
});

describe('the last administrator of this provider', () => {
  it('may be removed while another one remains here, with the other provider holding none', async () => {
    assert.equal(
      Number((await getDb()('tenant_users').where({ tenant_id: beta, role: 'admin' }).count({ n: '*' }).first()).n),
      0,
      'beta has no administrators to lend'
    );

    const { status } = await call(`${panelUrl}/api/users/${anaId}`, {
      method: 'DELETE',
      headers: authHeaders(ownerToken)
    });
    assert.equal(status, 200, 'alfa still has the owner');
    assert.equal(await membershipOf(alfa, anaId), undefined);
    assert.ok(await personOf(anaId), 'removing an administrator does not delete her either');
    assert.equal(
      Number((await getDb()('tenant_users').where({ tenant_id: beta }).count({ n: '*' }).first()).n),
      2,
      "beta's team is untouched by anything alfa does"
    );
  });

  it('is not saved by another provider having administrators', async () => {
    // Beta staffs up. Under the count this guard used before memberships — one
    // number for the whole deployment — these two would be enough to let alfa
    // remove its own last administrator.
    await getDb()('tenant_users')
      .where({ tenant_id: beta, user_id: brunoId })
      .update({ role: 'admin' });
    await seedMembership(beta, carolId, 'admin');

    // Carol is signed into alfa, where she is an operator, and she is now an
    // administrator at beta. The route guard reads the role of the membership
    // the token names, so administering somebody else's ISP buys her nothing
    // here: she is refused before the count is ever consulted. That refusal
    // replaces the 409 this test asserted while `requireRole` still read
    // `users.role` — the deployment-wide administrator whose reach made the
    // deployment-wide count dangerous does not exist any more.
    const removal = await call(`${panelUrl}/api/users/${ownerId}`, {
      method: 'DELETE',
      headers: authHeaders(carolToken)
    });
    assert.equal(removal.status, 403);
    assert.equal((await membershipOf(alfa, ownerId)).role, 'owner', 'the owner still runs alfa');

    const demotion = await call(`${panelUrl}/api/users/${ownerId}`, {
      method: 'PATCH',
      headers: authHeaders(carolToken),
      body: { role: 'viewer' }
    });
    assert.equal(demotion.status, 403, 'demoting the last administrator is the same loss');
    assert.equal((await membershipOf(alfa, ownerId)).role, 'owner');

    // And signed into beta, where she really is an administrator, alfa's owner
    // is not somebody she can reach either — answered as nonexistent rather
    // than forbidden, because "you may not touch this one" would confirm the id
    // belongs to a real person at another provider.
    const atBeta = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { ...CAROL, tenantId: beta }
    });
    assert.equal(atBeta.status, 200);
    const acrossProviders = await call(`${panelUrl}/api/users/${ownerId}`, {
      method: 'DELETE',
      headers: authHeaders(atBeta.body.data.token)
    });
    assert.equal(acrossProviders.status, 404);
    assert.equal((await membershipOf(alfa, ownerId)).role, 'owner');

    assert.equal(
      Number((await getDb()('tenant_users').where({ tenant_id: beta, role: 'admin' }).count({ n: '*' }).first()).n),
      2,
      "and beta's administrators were never alfa's to count"
    );
  });
});

describe('a person who works for two providers', () => {
  it('keeps their password out of one provider administrator hands', async () => {
    const before = await personOf(carolId);
    const { status } = await call(`${panelUrl}/api/users/${carolId}`, {
      method: 'PATCH',
      headers: authHeaders(ownerToken),
      body: { password: 'alfa-picks-your-password' }
    });
    assert.equal(status, 409);
    assert.equal((await personOf(carolId)).password, before.password);

    // O provedor vai nomeado porque Carol trabalha em dois, e num deploy sem
    // domínio-base o login PERGUNTA em vez de escolher por ela. O que esta
    // prova mede é a senha dela continuar sendo a dela — não a ambiguidade,
    // que tem arquivo próprio.
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { ...CAROL, tenantId: alfa }
    });
    assert.equal(login.status, 200, 'she can still sign in with the password she chose');
  });

  it('can still have their role here changed, at this provider only', async () => {
    const beforeAtBeta = await membershipOf(beta, carolId);
    const { status, body } = await call(`${panelUrl}/api/users/${carolId}`, {
      method: 'PATCH',
      headers: authHeaders(ownerToken),
      body: { role: 'admin' }
    });
    assert.equal(status, 200);
    assert.equal(body.data.user.role, 'admin');
    assert.equal((await membershipOf(alfa, carolId)).role, 'admin');
    assert.equal((await membershipOf(beta, carolId)).role, beforeAtBeta.role, 'beta decides beta');
  });
});
