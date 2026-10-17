import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
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
 * Attaching a person to a provider is the control plane's job.
 *
 * Wave 12 refused it to a provider's own administrator: `/api/users` creates
 * with a PASSWORD, there is one password per person, so attaching an existing
 * stranger there would reset their login. A platform administrator is a
 * different trust level — they mint providers already — so they are who does
 * it, and their version never touches the password. The assertion this whole
 * file exists for is in "without touching their password": the hash is read
 * before and after and has to be byte-identical.
 *
 * Two providers throughout. Alfa is the installation's own, which is what
 * `resolveTenant` answers and therefore the provider every ordinary session
 * here belongs to; beta is a second ISP that no session in this file works for
 * as a platform administrator. Every route below is aimed at BETA on purpose:
 * a control-plane route that only worked on the caller's own provider would
 * pass a weaker test than the one it has to pass.
 *
 * The modules below are pulled in after the harness so that the environment it
 * sets — JWT secret, data directory, dialect — is in place before anything that
 * reads at import time is evaluated. Static imports would be hoisted above it.
 */
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { errorHandler } = await import('../src/app.js');
const { default: platformMembersRouter } = await import('../src/routes/platformMembers.js');

let panelUrl;
let platformUrl;
let platformServer;

let alfa;
let beta;

let ownerToken;
let ownerId;
let anaToken;
let anaId;
let aliceId;
let brunoToken;
let brunoId;
let biaId;

const ALICE = { username: 'alice', password: 'alice-password-1', email: 'alice@exemplo.test' };
const ANA = { username: 'ana', password: 'ana-password-1', email: 'ana@exemplo.test' };
const BRUNO = { username: 'bruno', password: 'bruno-password-1', email: 'bruno@exemplo.test' };

/** MySQL's TIMESTAMP keeps whole seconds, so seeded times carry none. */
function wholeSecond(date = new Date()) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

const personOf = (userId) => getDb()('users').where({ id: userId }).first();

const membershipOf = (tenantId, userId) => getDb()('tenant_users')
  .where({ tenant_id: tenantId, user_id: userId })
  .first();

async function membershipCount(tenantId, userId) {
  const row = await getDb()('tenant_users')
    .where({ tenant_id: tenantId, user_id: userId })
    .count({ n: '*' })
    .first();
  return Number(row.n);
}

async function personCount() {
  const row = await getDb()('users').count({ n: '*' }).first();
  return Number(row.n);
}

async function seedPerson({ username, password, role }) {
  return insertReturningId('users', {
    username,
    password: bcrypt.hashSync(password, 4),
    role
  });
}

async function seedMembership(tenantId, userId, role) {
  await getDb()('tenant_users').insert({ tenant_id: tenantId, user_id: userId, role });
}

const members = (tenantId, token) => call(
  `${platformUrl}/api/platform/tenants/${tenantId}/members`,
  { headers: authHeaders(token) }
);

/**
 * The chain lane B's one mount line will sit in.
 *
 * `app.js` belongs to another lane in this wave, and its `/api` catch-all is
 * registered before anything added to the app afterwards would be — so this
 * suite cannot mount the router on the real application and reach it. It raises
 * the same middleware instead, in the same order and from the same modules:
 * `attachLocale` (which is where `req.t` comes from, and every refusal below
 * goes through it), the JSON parser, and `resolveTenant`, whose provisional
 * scope is exactly what the controller must NOT be reading the provider from.
 */
function startPlatformHost() {
  const host = express();
  host.use(attachLocale);
  host.use(express.json({ limit: '1mb' }));
  host.use('/api', resolveTenant);
  host.use('/api/platform', platformMembersRouter);
  host.use('/api', (req, res) => {
    res.status(404).json({ success: false, message: req.t('common.routeNotFound') });
  });
  host.use(errorHandler);
  return new Promise((resolve) => {
    const server = host.listen(0, '127.0.0.1', () => resolve(server));
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  platformServer = await startPlatformHost();
  platformUrl = `http://127.0.0.1:${platformServer.address().port}`;

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

  // The migration creates `platform_admins` EMPTY and promotes nobody, so the
  // roster is seeded the way the bootstrap scripts seed it: by hand, by whoever
  // holds the deployment. The owner is now both alfa's administrator and a
  // platform administrator, which is the arrangement a real SaaS install has.
  await db('platform_admins').insert({ user_id: ownerId, created_at: wholeSecond() });

  // Alfa's staff, hired the way the panel hires: through its own team screen.
  // Ana is an administrator AT ALFA and nothing more — she is the one who has
  // to bounce off every route in this file.
  const ana = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(ownerToken),
    body: { ...ANA, role: 'admin' }
  });
  assert.equal(ana.status, 201);
  anaId = ana.body.data.user.id;

  const alice = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(ownerToken),
    body: { ...ALICE, role: 'viewer' }
  });
  assert.equal(alice.status, 201);
  aliceId = alice.body.data.user.id;

  // Beta's own staff, seeded through the database because nothing in the panel
  // can reach a second provider yet — which is the gap this wave closes.
  brunoId = await seedPerson({ ...BRUNO, role: 'admin' });
  await seedMembership(beta, brunoId, 'admin');
  biaId = await seedPerson({ username: 'bia', password: 'bia-password-1', role: 'viewer' });
  await seedMembership(beta, biaId, 'viewer');

  const anaLogin = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: ANA });
  assert.equal(anaLogin.status, 200);
  anaToken = anaLogin.body.data.token;

  const brunoLogin = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: BRUNO });
  assert.equal(brunoLogin.status, 200);
  brunoToken = brunoLogin.body.data.token;
});

after(async () => {
  await new Promise((resolve) => platformServer.close(resolve));
  await stopTestServers();
});

describe("a provider's team, read from the control plane", () => {
  it('lists everyone who works there, with the role they hold there', async () => {
    const { status, body } = await members(beta, ownerToken);
    assert.equal(status, 200);
    const byName = Object.fromEntries(
      body.data.memberships.map((member) => [member.username, member])
    );
    assert.deepEqual(Object.keys(byName).sort(), ['bia', 'bruno']);
    assert.equal(byName.bruno.role, 'admin');
    assert.equal(byName.bia.role, 'viewer');
    assert.equal(Number(byName.bruno.userId), Number(brunoId));
  });

  it('reads the provider from the path, not from the caller session', async () => {
    // The owner's session belongs to alfa; every request in this file resolves
    // to alfa as its scope. Asking for beta has to answer beta's team, or the
    // control plane can only ever administer the provider its caller happens to
    // work for — which is the provider they least need this route for.
    const { body } = await members(alfa, ownerToken);
    assert.deepEqual(
      body.data.memberships.map((member) => member.username).sort(),
      ['alice', 'ana', 'owner']
    );
  });

  it('never exposes a password hash', async () => {
    const { body } = await members(beta, ownerToken);
    assert.ok(!JSON.stringify(body.data.memberships).includes('$2'));
  });

  it('answers 404 for a provider that does not exist', async () => {
    const { status } = await members(98765, ownerToken);
    assert.equal(status, 404);
  });
});

describe('attaching a person who already exists', () => {
  it('creates the membership without touching their password', async () => {
    const before = await personOf(aliceId);

    const { status, body } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members`,
      {
        method: 'POST',
        headers: authHeaders(ownerToken),
        body: { username: ALICE.username, role: 'viewer' }
      }
    );
    assert.equal(status, 201);
    assert.equal(body.data.membership.username, 'alice');
    assert.equal(body.data.membership.role, 'viewer');
    assert.equal(Number(body.data.membership.userId), Number(aliceId));

    // The property the whole design rests on. Byte-identical, not merely "she
    // can still sign in": a rehash of the same password would also let her sign
    // in, while having replaced the stored secret and invalidated nothing that
    // could be noticed until an audit.
    const after = await personOf(aliceId);
    assert.ok(
      Buffer.from(after.password, 'utf8').equals(Buffer.from(before.password, 'utf8')),
      "the person's password hash was rewritten by an attach"
    );
    // And nothing else on the person either: no forced sign-out, no change to
    // the deployment-wide role.
    assert.equal(Number(after.token_version), Number(before.token_version));
    assert.equal(after.role, before.role);

    const { body: team } = await members(beta, ownerToken);
    assert.ok(team.data.memberships.some((member) => member.username === 'alice'));

    // Her job at alfa is untouched: attaching is additive, and a person working
    // for two ISPs is the arrangement `tenant_users` exists for.
    assert.equal((await membershipOf(alfa, aliceId)).role, 'viewer');

    // The end of the same proof, from the outside: the password she chose is
    // still the password that signs her in.
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { ...ALICE, tenantId: beta }
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.tenantId, beta);
  });

  it('refuses a username that belongs to nobody, and creates no one', async () => {
    const peopleBefore = await personCount();
    const { status } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members`,
      {
        method: 'POST',
        headers: authHeaders(ownerToken),
        body: { username: 'ghost', role: 'admin' }
      }
    );
    // Creating a person is `/api/users`' job, at a provider, where the request
    // carries a password its owner chose. This route has no password field, so
    // creating from here could only invent one.
    assert.equal(status, 404);
    assert.equal(await personCount(), peopleBefore);
    assert.equal(await getDb()('users').where({ username: 'ghost' }).first(), undefined);
  });

  it('refuses somebody who already works there rather than duplicating them', async () => {
    const { status } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members`,
      {
        method: 'POST',
        headers: authHeaders(ownerToken),
        body: { username: ALICE.username, role: 'admin' }
      }
    );
    assert.equal(status, 409);
    assert.equal(await membershipCount(beta, aliceId), 1, 'exactly one membership per person here');
    // And the role she holds at beta was not quietly changed by a call that
    // reads as "add": promoting somebody is the provider's own decision.
    assert.equal((await membershipOf(beta, aliceId)).role, 'viewer');
  });

  it('refuses a role the team screen could not display', async () => {
    const { status } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members`,
      {
        method: 'POST',
        headers: authHeaders(ownerToken),
        body: { username: 'bia', role: 'superuser' }
      }
    );
    assert.equal(status, 400);
    assert.equal((await membershipOf(beta, biaId)).role, 'viewer');
  });

  it('refuses a provider that does not exist', async () => {
    const { status } = await call(
      `${platformUrl}/api/platform/tenants/98765/members`,
      {
        method: 'POST',
        headers: authHeaders(ownerToken),
        body: { username: ALICE.username, role: 'viewer' }
      }
    );
    assert.equal(status, 404);
  });
});

/**
 * Convidar quem ainda NÃO tem login, que é o caminho da PRIMEIRA conta de um
 * provedor.
 *
 * O que este bloco fixa é um beco sem saída que existia inteiro: um provedor
 * recém-criado pelo console não tinha equipe, e nenhuma porta levava a primeira
 * conta até ele — `add` só vincula quem já existe, o `/setup` no host do
 * provedor novo responde "já concluído" porque conta a tabela `users` do deploy
 * inteiro, `POST /api/invites` exige uma sessão dentro do provedor que ainda não
 * tem ninguém, e a personificação é só de leitura. O ISP recebia um painel que
 * ninguém abria.
 *
 * O caso que prova o conserto é o de ponta a ponta: cunhar aqui e ACEITAR pela
 * rota pública, provando que a pessoa nasce com a senha que ela mesma escolheu
 * e com vínculo no provedor certo — beta, e nunca alfa, que é o provedor de
 * quem convidou.
 */
describe('convidando quem ainda não tem login', () => {
  const convidar = (tenantId, token, body) => call(
    `${platformUrl}/api/platform/tenants/${tenantId}/invites`,
    { method: 'POST', headers: authHeaders(token), body }
  );

  const convitesDe = (tenantId) => getDb()('tenant_invites')
    .where({ tenant_id: tenantId })
    .orderBy('id', 'desc');

  it('cunha o convite no provedor NOMEADO, não no de quem convidou', async () => {
    const { status, body } = await convidar(beta, ownerToken, { role: 'owner' });
    assert.equal(status, 201);
    assert.ok(body.data.token, 'o convite voltou sem token, e o token é o convite');
    assert.equal(body.data.invite.role, 'owner');

    const [convite] = await convitesDe(beta);
    assert.ok(convite, 'o convite não nasceu em beta');
    assert.equal(Number(convite.tenant_id), beta);
    // O token guardado é o HASH: quem lê a tabela não consegue usar o convite.
    assert.notEqual(convite.token_hash, body.data.token);
    assert.equal((await convitesDe(alfa)).length, 0,
      'o convite nasceu no provedor de quem convidou, que é o erro que `runInTenant` existe para impedir');
  });

  // O ACEITE não é provado aqui: `usableInvite` exige que o convite seja aberto
  // no host do provedor, e este arquivo roda sem domínio-base de propósito. O
  // caminho inteiro — console cunha, pessoa aceita no endereço do provedor,
  // entra e trabalha — está em `platform-invite-onboarding.test.js`.
  it('monta o link no endereço do provedor convidado', async () => {
    // `TENANT_BASE_DOMAIN` é lido no carregamento do módulo e este arquivo roda
    // sem ele de propósito — é `PUBLIC_BASE_URL`, lido a cada chamada, que dá o
    // endereço absoluto aqui sem mexer na resolução por host do resto da suíte.
    const antes = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://painel.exemplo.test';
    try {
      const { status, body } = await convidar(beta, ownerToken, { role: 'admin' });
      assert.equal(status, 201);
      assert.equal(body.data.url, `https://painel.exemplo.test/invite#${body.data.token}`);
    } finally {
      if (antes === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = antes;
    }
  });

  it('e devolve `url` nula quando o deploy não tem endereço absoluto', async () => {
    const { status, body } = await convidar(beta, ownerToken, { role: 'tech' });
    assert.equal(status, 201);
    assert.equal(body.data.url, null, 'inventou um endereço que o deploy não declarou');
    assert.ok(body.data.token, 'sem endereço, o token é o que sobra para entregar');
  });

  it('recusa um papel que a matriz não conhece, e uma validade fora da régua', async () => {
    const antes = (await convitesDe(beta)).length;
    for (const body of [
      { role: 'sysadmin' },
      { role: undefined },
      { role: 'owner', ttlMs: 1000 },
      { role: 'owner', ttlMs: 365 * 24 * 60 * 60 * 1000 },
      { role: 'owner', ttlMs: 'sete dias' },
      { role: 'owner', email: 'nao-e-endereco' }
    ]) {
      const { status } = await convidar(beta, ownerToken, body);
      assert.equal(status, 400, `${JSON.stringify(body)} tinha que ser recusado`);
    }
    assert.equal((await convitesDe(beta)).length, antes,
      'um pedido recusado deixou convite para trás');
  });

  it('responde 404 para um provedor que não existe', async () => {
    const { status } = await convidar(999999, ownerToken, { role: 'owner' });
    assert.equal(status, 404);
  });

  it('e o administrador de um provedor não convida para o vizinho', async () => {
    const antes = (await convitesDe(beta)).length;
    const { status } = await convidar(beta, anaToken, { role: 'owner' });
    assert.ok(status >= 400 && status < 500, `respondeu ${status} a quem não é da plataforma`);
    assert.equal((await convitesDe(beta)).length, antes,
      'quem não é da plataforma cunhou um convite para outro provedor');
  });

  it('deixa a linha nas duas trilhas', async () => {
    const { status, body } = await convidar(beta, ownerToken, { role: 'admin' });
    assert.equal(status, 201);
    const inviteId = body.data.invite.id;

    const nossa = await getDb()('platform_audit')
      .where({ action: 'tenant.member_invited' })
      .orderBy('id', 'desc')
      .first();
    assert.ok(nossa, 'a plataforma cunhou um convite e não registrou');
    assert.equal(Number(nossa.tenant_id), beta);
    assert.equal(nossa.actor_username, 'owner');
    const detalhe = JSON.parse(nossa.detail);
    assert.equal(detalhe.inviteId, inviteId);
    assert.equal(detalhe.role, 'admin');
    // O token é uma credencial: não entra em trilha nenhuma.
    assert.ok(!nossa.detail.includes(body.data.token), 'o token vazou para a trilha');

    const dele = await getDb()('audit_log')
      .where({ tenant_id: beta, action: 'invite.created' })
      .orderBy('id', 'desc')
      .first();
    assert.ok(dele, 'o ISP não tem na trilha dele que um convite foi cunhado para a equipe dele');
    assert.equal(dele.actor_kind, 'platform', 'a mão veio de fora e a trilha dele não diz isso');
    assert.equal(dele.subject_id, String(inviteId));
    assert.ok(!String(dele.detail).includes(body.data.token), 'o token vazou para a trilha do provedor');
  });
});

describe('ending a membership', () => {
  let broadcastId;
  let optOutId;
  let messageId;
  let aliceToken;

  before(async () => {
    // History at beta that names alice by id. All three of these columns are ON
    // DELETE SET NULL, so deleting the person would not fail loudly — it would
    // quietly blank the record of who did what.
    broadcastId = await insertReturningId('wa_broadcasts', {
      tenant_id: beta,
      title: 'Aviso de manutenção',
      body: 'manutenção programada',
      status: 'draft',
      created_by: aliceId,
      created_at: wholeSecond(),
      updated_at: wholeSecond()
    });
    optOutId = await insertReturningId('wa_opt_outs', {
      tenant_id: beta,
      wa_phone_e164: '+5511999990001',
      origin: 'operator',
      revoked_at: wholeSecond(),
      revoked_by: aliceId,
      created_at: wholeSecond()
    });
    const accountId = await insertReturningId('whatsapp_accounts', {
      tenant_id: beta,
      name: 'beta-instance',
      base_url: 'http://127.0.0.1:9999',
      created_at: wholeSecond(),
      updated_at: wholeSecond()
    });
    const conversationId = await insertReturningId('wa_conversations', {
      tenant_id: beta,
      account_id: accountId,
      wa_phone_e164: '+5511999990001',
      external_thread_id: '5511999990001@s.whatsapp.net',
      created_at: wholeSecond(),
      updated_at: wholeSecond()
    });
    messageId = await insertReturningId('wa_messages', {
      tenant_id: beta,
      conversation_id: conversationId,
      direction: 'out',
      body: 'bom dia',
      sent_by: aliceId,
      created_at: wholeSecond(),
      updated_at: wholeSecond()
    });

    // A session of hers at the OTHER provider, opened before the removal, so
    // the test can ask afterwards whether ending one membership signed her out
    // of a job this operation was not about.
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { ...ALICE, tenantId: alfa }
    });
    assert.equal(login.status, 200);
    aliceToken = login.body.data.token;
  });

  it('removes the person from the provider without deleting the person', async () => {
    const before = await personOf(aliceId);
    const { status, body } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members/${aliceId}`,
      { method: 'DELETE', headers: authHeaders(ownerToken) }
    );
    assert.equal(status, 200);
    assert.equal(Number(body.data.userId), Number(aliceId));

    assert.equal(await membershipOf(beta, aliceId), undefined, 'the membership is over');

    const person = await personOf(aliceId);
    assert.ok(person, 'the person survives');
    assert.equal(person.username, 'alice');
    assert.equal(person.password, before.password);

    const broadcast = await getDb()('wa_broadcasts').where({ id: broadcastId }).first();
    assert.equal(Number(broadcast.created_by), Number(aliceId), 'history still names her');
    const optOut = await getDb()('wa_opt_outs').where({ id: optOutId }).first();
    assert.equal(Number(optOut.revoked_by), Number(aliceId));
    const message = await getDb()('wa_messages').where({ id: messageId }).first();
    assert.equal(Number(message.sent_by), Number(aliceId));

    const { body: team } = await members(beta, ownerToken);
    assert.ok(!team.data.memberships.some((member) => member.username === 'alice'));
  });

  it('leaves the job she still holds at another provider alone', async () => {
    assert.equal((await membershipOf(alfa, aliceId)).role, 'viewer');
    // `token_version` is per PERSON, so revoking here would have signed her out
    // of the shift she is working at alfa to tell her about a job at beta she
    // no longer has. It is not needed for safety either: the membership is read
    // back from the table on every request, so the beta session died on its own.
    const stillWorking = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(aliceToken)
    });
    assert.equal(stillWorking.status, 200);
    assert.equal(stillWorking.body.data.tenantId, alfa);
  });

  it('answers 404 for somebody who does not work there', async () => {
    const { status } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members/${aliceId}`,
      { method: 'DELETE', headers: authHeaders(ownerToken) }
    );
    assert.equal(status, 404);
    assert.ok(await personOf(aliceId), 'and still does not touch the person');
  });

  it("refuses to end the membership the caller's own session runs on", async () => {
    // Alfa has two administrators here, so this refusal is not the last-admin
    // guard: it is the session the caller is holding. Ending it would 403 their
    // very next request, and the screen would look broken at the moment it
    // succeeded.
    assert.ok(
      Number((await getDb()('tenant_users')
        .where({ tenant_id: alfa }).whereIn('role', ['owner', 'admin']).count({ n: '*' }).first()).n) >= 2
    );
    const { status } = await call(
      `${platformUrl}/api/platform/tenants/${alfa}/members/${ownerId}`,
      { method: 'DELETE', headers: authHeaders(ownerToken) }
    );
    assert.equal(status, 409);
    assert.ok(await membershipOf(alfa, ownerId));
  });
});

describe("a provider's own administrator", () => {
  it('is refused on every one of these routes', async () => {
    // Ana runs alfa. Bruno runs beta. Neither is on `platform_admins`, and the
    // whole point of the plane is that running an ISP does not put you on it.
    const list = await members(beta, anaToken);
    assert.equal(list.status, 404, 'listing another provider staff');

    const attach = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members`,
      {
        method: 'POST',
        headers: authHeaders(anaToken),
        body: { username: 'bia', role: 'admin' }
      }
    );
    assert.equal(attach.status, 404, 'attaching');
    assert.equal((await membershipOf(beta, biaId)).role, 'viewer', 'and nothing was written');

    const detach = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members/${biaId}`,
      { method: 'DELETE', headers: authHeaders(anaToken) }
    );
    assert.equal(detach.status, 404, 'detaching');
    assert.ok(await membershipOf(beta, biaId), 'and nobody was removed');
  });

  it('is refused on their OWN provider too', async () => {
    // Bruno really is beta's administrator, and bia really is his colleague:
    // through `/api/users` this removal is his to make. It is refused here
    // because these routes are the control plane, and what decides is the plane
    // the caller is on, not the provider the row belongs to. Were it otherwise,
    // the guard would be authorising from the caller's own membership — which
    // is the read that lets a provider's admin reach a provider they are an
    // admin of, and there is no version of that which stops at their own.
    const list = await members(beta, brunoToken);
    assert.equal(list.status, 404);

    const detach = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members/${biaId}`,
      { method: 'DELETE', headers: authHeaders(brunoToken) }
    );
    assert.equal(detach.status, 404);
    assert.ok(await membershipOf(beta, biaId));

    const attach = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members`,
      {
        method: 'POST',
        headers: authHeaders(brunoToken),
        body: { username: ALICE.username, role: 'viewer' }
      }
    );
    assert.equal(attach.status, 404);
    assert.equal(await membershipOf(beta, aliceId), undefined);
  });

  it('is refused before the request is even understood', async () => {
    // A provider id that does not exist, from a caller who is not on the plane:
    // the answer must be the guard's, not the controller's. Otherwise the
    // routes tell anybody holding a session which provider ids are real.
    //
    // The guard answers 404 — the same status the controller gives an unknown
    // provider — so the STATUS no longer tells the two apart, and asserting on
    // it would prove nothing. The body does: the guard returns exactly what an
    // unrouted `/api` path returns, which is the point of it choosing 404 over
    // 403 in the first place.
    const real = await members(alfa, anaToken);
    const invented = await members(98765, anaToken);
    assert.equal(invented.status, 404);
    assert.deepEqual(
      invented.body,
      real.body,
      'a provider that exists and one that does not must answer identically to somebody off the plane'
    );
  });

  it('and a request with no session at all is refused', async () => {
    const { status } = await call(`${platformUrl}/api/platform/tenants/${beta}/members`);
    assert.equal(status, 401);
  });
});

describe('the last administrator of a provider', () => {
  it('cannot be removed from the control plane either', async () => {
    assert.equal(
      Number((await getDb()('tenant_users')
        .where({ tenant_id: beta, role: 'admin' }).count({ n: '*' }).first()).n),
      1,
      'bruno is the only one who runs beta'
    );

    const { status } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members/${brunoId}`,
      { method: 'DELETE', headers: authHeaders(ownerToken) }
    );
    // The decision, and it is not wave 12's reason. There the argument is that
    // nobody left inside the provider could undo it; here the caller holds the
    // repair tool and could put an administrator back with one POST. It is
    // refused because the panel already has an operation for taking a provider
    // out of service — suspension, which is recorded on `tenants.status`, is
    // honoured by `forEachTenant`, the media sweep and the SGP webhook, and is
    // reversible in one click. An administrator-less provider reaches the same
    // dead end for its staff while the control plane's own list still shows it
    // active: two ways to disable a provider, one of them invisible. The cost
    // of refusing is only that staff churn has to be done in the other order.
    assert.equal(status, 409);
    assert.ok(await membershipOf(beta, brunoId), 'and he still runs beta');
  });

  it('is not counted from another provider staff', async () => {
    // Alfa has two administrators. Under the deployment-wide count this guard
    // used before `tenant_users` existed, they would be enough to authorise
    // emptying beta.
    assert.ok(
      Number((await getDb()('tenant_users')
        .where({ tenant_id: alfa }).whereIn('role', ['owner', 'admin']).count({ n: '*' }).first()).n) >= 2
    );
    const { status } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members/${brunoId}`,
      { method: 'DELETE', headers: authHeaders(ownerToken) }
    );
    assert.equal(status, 409);
  });

  it('may go once a replacement is attached, which is the supported order', async () => {
    const attach = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members`,
      {
        method: 'POST',
        headers: authHeaders(ownerToken),
        body: { username: ANA.username, role: 'admin' }
      }
    );
    assert.equal(attach.status, 201);
    assert.equal(attach.body.data.membership.role, 'admin');
    // Ana administers alfa; the membership just written says she administers
    // beta as well, and neither statement changes the other.
    assert.equal((await membershipOf(alfa, anaId)).role, 'admin');

    const { status } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members/${brunoId}`,
      { method: 'DELETE', headers: authHeaders(ownerToken) }
    );
    assert.equal(status, 200);
    assert.equal(await membershipOf(beta, brunoId), undefined);
    assert.ok(await personOf(brunoId), 'removing an administrator does not delete him either');
    assert.equal(
      Number((await getDb()('tenant_users')
        .where({ tenant_id: beta, role: 'admin' }).count({ n: '*' }).first()).n),
      1,
      'beta kept exactly one administrator throughout'
    );
  });
});

describe('the trail a membership leaves', () => {
  /**
   * As duas mãos, e por que uma trilha só não bastava.
   *
   * Um vínculo escrito daqui vira uma sessão legítima DENTRO de um ISP — o
   * cadastro inteiro, as senhas de portal, a exportação. Registrar isso só em
   * `platform_audit` deixaria a única cópia do registro na trilha de quem agiu,
   * que é justamente a trilha que o ISP não pode ler: vincular-se, entrar,
   * levar tudo e desvincular-se não deixaria, para o provedor, nenhum rastro de
   * que alguém esteve lá. Daí a linha espelhada no `audit_log` DAQUELE
   * provedor, com `actor_kind: 'platform'` — a mesma forma que a suspensão de
   * provedor já usa, e pelo mesmo motivo.
   */
  const trilhaDaPlataforma = (action) => getDb()('platform_audit')
    .where({ action }).orderBy('id', 'asc');

  const trilhaDoProvedor = (tenantId, action) => getDb()('audit_log')
    .where({ tenant_id: tenantId, action }).orderBy('id', 'asc');

  let anaNoBeta;

  it('attaching writes one line in each trail', async () => {
    const naPlataforma = (await trilhaDaPlataforma('tenant.member_added')).length;
    const noBeta = (await trilhaDoProvedor(beta, 'operator.created')).length;
    // O provedor do administrador da plataforma não é o provedor afetado, e a
    // linha não pode nascer nele: alfa é o escopo que a sessão de quem chama
    // abre, então é exatamente onde uma escrita distraída cairia.
    const noAlfa = (await trilhaDoProvedor(alfa, 'operator.created')).length;

    const { status } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members`,
      {
        method: 'POST',
        headers: authHeaders(ownerToken),
        body: { username: ALICE.username, role: 'tech' }
      }
    );
    assert.equal(status, 201);

    const daPlataforma = await trilhaDaPlataforma('tenant.member_added');
    assert.equal(daPlataforma.length, naPlataforma + 1);
    const linha = daPlataforma[daPlataforma.length - 1];
    // Quem agiu.
    assert.equal(linha.actor_username, 'owner');
    assert.equal(Number(linha.actor_user_id), Number(ownerId));
    // Em qual provedor — com slug e nome na própria linha, como todas as
    // outras desta tabela, para que ela siga legível se o provedor sumir.
    assert.equal(Number(linha.tenant_id), Number(beta));
    assert.equal(linha.tenant_slug, 'beta');
    assert.equal(linha.tenant_name, 'Provedor Beta');
    // Quem foi vinculado, e com que papel.
    const detalhe = JSON.parse(linha.detail);
    assert.equal(detalhe.username, 'alice');
    assert.equal(detalhe.role, 'tech');
    assert.equal(Number(detalhe.userId), Number(aliceId));

    const doProvedor = await trilhaDoProvedor(beta, 'operator.created');
    assert.equal(doProvedor.length, noBeta + 1, 'o ISP afetado também registra');
    const espelhada = doProvedor[doProvedor.length - 1];
    // A afirmação inteira desta linha: a mão veio de fora. Sem isto, a trilha
    // do provedor mostraria um operador aparecendo na equipe sem que nenhum
    // operador dele estivesse por trás — indistinguível de uma linha cujo ator
    // se perdeu.
    assert.equal(espelhada.actor_kind, 'platform');
    assert.equal(espelhada.actor_username, 'owner');
    assert.equal(Number(espelhada.actor_user_id), Number(ownerId));
    assert.equal(espelhada.subject_type, 'tenant_user');
    assert.equal(Number(espelhada.subject_id), Number(aliceId));
    assert.equal(JSON.parse(espelhada.detail).role, 'tech');
    assert.equal(JSON.parse(espelhada.detail).username, 'alice');

    assert.equal(
      (await trilhaDoProvedor(alfa, 'operator.created')).length,
      noAlfa,
      'e nada foi escrito no provedor em que quem chamou trabalha'
    );
  });

  it('ending the membership writes one line in each trail too', async () => {
    const naPlataforma = (await trilhaDaPlataforma('tenant.member_removed')).length;
    const noBeta = (await trilhaDoProvedor(beta, 'operator.removed')).length;
    const noAlfa = (await trilhaDoProvedor(alfa, 'operator.removed')).length;

    const { status } = await call(
      `${platformUrl}/api/platform/tenants/${beta}/members/${aliceId}`,
      { method: 'DELETE', headers: authHeaders(ownerToken) }
    );
    assert.equal(status, 200);

    const daPlataforma = await trilhaDaPlataforma('tenant.member_removed');
    assert.equal(daPlataforma.length, naPlataforma + 1);
    const linha = daPlataforma[daPlataforma.length - 1];
    assert.equal(linha.actor_username, 'owner');
    assert.equal(Number(linha.tenant_id), Number(beta));
    assert.equal(linha.tenant_slug, 'beta');
    const detalhe = JSON.parse(linha.detail);
    // O papel que a pessoa TINHA, que é o que diz o tamanho do que foi
    // desfeito; depois da remoção não há mais onde ler isso.
    assert.equal(detalhe.role, 'tech');
    assert.equal(detalhe.username, 'alice');
    assert.equal(Number(detalhe.userId), Number(aliceId));

    const doProvedor = await trilhaDoProvedor(beta, 'operator.removed');
    assert.equal(doProvedor.length, noBeta + 1);
    const espelhada = doProvedor[doProvedor.length - 1];
    assert.equal(espelhada.actor_kind, 'platform');
    assert.equal(espelhada.actor_username, 'owner');
    assert.equal(Number(espelhada.subject_id), Number(aliceId));
    assert.equal(JSON.parse(espelhada.detail).role, 'tech');

    assert.equal((await trilhaDoProvedor(alfa, 'operator.removed')).length, noAlfa);
  });

  it('carries no secret into either trail', async () => {
    // A pessoa vinculada tem uma senha, e o hash dela está a um join de
    // distância de tudo que estas rotas leem. Nada disso entra na trilha: ela
    // registra QUE o vínculo mudou, nunca com que credencial.
    const hash = (await personOf(aliceId)).password;
    const tudo = JSON.stringify([
      await getDb()('platform_audit'),
      await getDb()('audit_log')
    ]);
    assert.ok(!tudo.includes(hash));
    assert.ok(!tudo.includes(ALICE.password));
    assert.ok(!tudo.includes('$2'), 'nenhum hash bcrypt em trilha nenhuma');
  });

  it('shows up on the affected provider own audit screen', async () => {
    // Ana administra beta desde o teste anterior deste arquivo, e é por ela que
    // se pergunta: a rota que serve a tela de trilha do provedor é escopada,
    // então uma linha que não estivesse no `audit_log` DELE não apareceria aqui
    // por mais que estivesse gravada na plataforma.
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { ...ANA, tenantId: beta }
    });
    assert.equal(login.status, 200);
    anaNoBeta = login.body.data.token;

    const { status, body } = await call(`${panelUrl}/api/audit?limit=200`, {
      headers: authHeaders(anaNoBeta)
    });
    assert.equal(status, 200);

    const deFora = body.data.entries.filter((entry) => entry.actor.kind === 'platform');
    const vinculo = deFora.find((entry) => entry.action === 'operator.created'
      && Number(entry.subject.id) === Number(aliceId));
    const fim = deFora.find((entry) => entry.action === 'operator.removed'
      && Number(entry.subject.id) === Number(aliceId));
    assert.ok(vinculo, 'o ISP vê que alguém de fora colocou uma pessoa na equipe dele');
    assert.ok(fim, 'e que a tirou');
    assert.equal(vinculo.actor.username, 'owner');
    assert.equal(vinculo.detail.role, 'tech');
    assert.equal(fim.actor.username, 'owner');
  });

  it('never shows another provider lines on that screen', async () => {
    // A contraprova da anterior: alfa também recebeu ações de equipe neste
    // arquivo, e a tela de beta não pode enxergá-las.
    const { body } = await call(`${panelUrl}/api/audit?limit=200`, {
      headers: authHeaders(anaNoBeta)
    });
    const idsDeBeta = new Set(
      (await getDb()('audit_log').where({ tenant_id: beta })).map((linha) => Number(linha.id))
    );
    for (const entry of body.data.entries) {
      assert.ok(idsDeBeta.has(Number(entry.id)), `linha ${entry.id} não é de beta`);
    }
  });
});

/**
 * Este bloco fica por ÚLTIMO de propósito: ele cria contas — administradores
 * inclusive — dentro de beta, e as suítes acima contam quantos administradores
 * o provedor tem e qual foi a última linha de cada trilha. Rodando antes, ele
 * mudaria o mundo que elas descrevem.
 */
/**
 * Criar a conta direto, que é a terceira porta da tela de equipe.
 *
 * `add` exige quem já tem login; o convite exige que a pessoa do outro lado
 * escolha nome e senha. Esta serve o provedor ADMINISTRADO: a conta nasce
 * pronta, e a senha ou vem de um link de uso único (padrão, e ninguém além da
 * pessoa a conhece) ou é digitada por quem opera o console.
 *
 * O que estes casos fixam: a conta nasce com vínculo no provedor NOMEADO, o
 * bilhete do link é um `auth_tickets` de verdade guardado como hash, a senha
 * digitada é a que fica valendo, e nenhum caminho aqui encosta numa conta que
 * já existe — que é a linha que separa esta rota de `add`.
 */
describe('criando um operador para um provedor administrado', () => {
  const NOVO = { username: 'operador-beta', email: 'operador-beta@exemplo.test' };

  const criar = (tenantId, token, body) => call(
    `${platformUrl}/api/platform/tenants/${tenantId}/operators`,
    { method: 'POST', headers: authHeaders(token), body }
  );

  const bilhetesDe = (userId) => getDb()('auth_tickets')
    .where({ user_id: userId, purpose: 'password_reset' })
    .orderBy('id', 'desc');

  it('cria a conta e o vínculo no provedor nomeado, e devolve o link uma vez', async () => {
    const pessoasAntes = await personCount();
    const { status, body } = await criar(beta, ownerToken, { ...NOVO, role: 'admin' });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(await personCount(), pessoasAntes + 1);

    const pessoa = await getDb()('users').where({ username: NOVO.username }).first();
    assert.ok(pessoa, 'a conta não foi criada');
    assert.equal(pessoa.email, NOVO.email);
    assert.equal(body.data.membership.userId, pessoa.id);
    assert.equal(body.data.membership.role, 'admin');

    const vinculo = await membershipOf(beta, pessoa.id);
    assert.ok(vinculo, 'a conta nasceu sem vínculo');
    assert.equal(vinculo.role, 'admin');
    assert.equal(await membershipCount(alfa, pessoa.id), 0,
      'a conta entrou também no provedor de quem operou o console');

    // O bilhete existe, é de uso único e está guardado como HASH.
    assert.ok(body.data.token, 'o link voltou sem bilhete');
    const [bilhete] = await bilhetesDe(pessoa.id);
    assert.ok(bilhete, 'nenhum bilhete de senha foi cunhado');
    assert.equal(Number(bilhete.tenant_id), beta);
    assert.notEqual(bilhete.token_hash, body.data.token);
    assert.equal(bilhete.redeemed_at, null);
    // Sete dias, e não os trinta minutos da redefinição comum.
    const dias = (new Date(bilhete.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(dias > 6 && dias < 8, `o prazo do bilhete é de ${dias} dias`);
  });

  /**
   * A senha da conta criada por link é aleatória e ninguém a conhece — nem quem
   * a criou. É o que dá sentido ao link: sem ele, a conta não entra em lugar
   * nenhum.
   */
  it('e a senha que fica gravada não é nada que quem operou o console escolheu', async () => {
    const pessoa = await getDb()('users').where({ username: NOVO.username }).first();
    for (const tentativa of ['', 'password', NOVO.username, NOVO.email, 'operador-beta-1']) {
      assert.equal(await bcrypt.compare(tentativa, pessoa.password), false,
        `a senha gravada é ${JSON.stringify(tentativa)}`);
    }
  });

  it('aceita a senha digitada, e é ela que fica valendo', async () => {
    const corpo = {
      username: 'suporte-beta',
      email: 'suporte-beta@exemplo.test',
      role: 'tech',
      password: 'senha-do-suporte-1'
    };
    const { status, body } = await criar(beta, ownerToken, corpo);
    assert.equal(status, 201, JSON.stringify(body));
    // Sem link: não há bilhete a entregar quando a senha já foi escolhida.
    assert.equal(body.data.url, null);
    assert.equal(body.data.token, null);

    const pessoa = await getDb()('users').where({ username: corpo.username }).first();
    assert.ok(await bcrypt.compare(corpo.password, pessoa.password),
      'a senha gravada não é a que foi digitada');
    assert.equal((await bilhetesDe(pessoa.id)).length, 0, 'cunhou bilhete sem precisar');
    assert.ok(await membershipOf(beta, pessoa.id));
  });

  /**
   * A conta usada aqui é a da ANA, criada pela API do provedor e portanto com
   * endereço — `seedPerson` grava sem e-mail, e um caso escrito contra uma
   * conta semeada provaria só que o endereço dela não existe.
   */
  it('recusa um nome ou um endereço que já existem, sem tocar na conta de ninguém', async () => {
    const antes = await personOf(anaId);
    const nome = await criar(beta, ownerToken, {
      username: ANA.username, email: 'outro-endereco@exemplo.test', role: 'admin'
    });
    assert.equal(nome.status, 409, JSON.stringify(nome.body));
    assert.equal(nome.body.code, 'username_taken');

    const endereco = await criar(beta, ownerToken, {
      username: 'nome-livre', email: ANA.email, role: 'admin'
    });
    assert.equal(endereco.status, 409, JSON.stringify(endereco.body));
    assert.equal(endereco.body.code, 'email_taken');

    // A conta de quem já existe fica exatamente como estava — é a linha que
    // separa esta rota de um "criar" que na verdade sobrescreve.
    const depois = await personOf(anaId);
    assert.equal(depois.password, antes.password, 'a senha de uma conta existente foi tocada');
    assert.equal(depois.username, antes.username);
    assert.equal(depois.email, antes.email);
    assert.equal((await getDb()('users').where({ username: 'nome-livre' })).length, 0);
  });

  it('recusa o que não é conta: nome curto, endereço inválido, papel de fora, senha curta', async () => {
    const pessoasAntes = await personCount();
    for (const corpo of [
      { username: 'ab', email: 'valido@exemplo.test', role: 'admin' },
      { username: 'x'.repeat(65), email: 'valido@exemplo.test', role: 'admin' },
      { username: 'nome-ok', email: 'nao-e-endereco', role: 'admin' },
      { username: 'nome-ok', email: undefined, role: 'admin' },
      { username: 'nome-ok', email: 'valido@exemplo.test', role: 'sysadmin' },
      { username: 'nome-ok', email: 'valido@exemplo.test', role: undefined },
      { username: 'nome-ok', email: 'valido@exemplo.test', role: 'admin', password: 'curta' }
    ]) {
      const { status } = await criar(beta, ownerToken, corpo);
      assert.equal(status, 400, `${JSON.stringify(corpo)} tinha que ser recusado`);
    }
    assert.equal(await personCount(), pessoasAntes, 'um pedido recusado criou gente');
  });

  it('responde 404 para um provedor que não existe', async () => {
    const { status } = await criar(999999, ownerToken, {
      username: 'fantasma', email: 'fantasma@exemplo.test', role: 'admin'
    });
    assert.equal(status, 404);
  });

  it('e o administrador de um provedor não cria conta no vizinho', async () => {
    const pessoasAntes = await personCount();
    const { status } = await criar(beta, anaToken, {
      username: 'invasora', email: 'invasora@exemplo.test', role: 'owner'
    });
    assert.ok(status >= 400 && status < 500, `respondeu ${status}`);
    assert.equal(await personCount(), pessoasAntes);
  });

  it('deixa a linha nas duas trilhas, com o modo da senha no detalhe', async () => {
    const { status, body } = await criar(beta, ownerToken, {
      username: 'auditada', email: 'auditada@exemplo.test', role: 'viewer'
    });
    assert.equal(status, 201);
    const userId = body.data.membership.userId;

    const nossa = await getDb()('platform_audit')
      .where({ action: 'tenant.operator_created' })
      .orderBy('id', 'desc')
      .first();
    assert.ok(nossa, 'o console criou uma conta e não registrou');
    assert.equal(Number(nossa.tenant_id), beta);
    const detalhe = JSON.parse(nossa.detail);
    assert.equal(detalhe.userId, userId);
    assert.equal(detalhe.mode, 'link', 'o modo da senha tem que estar na trilha');
    assert.ok(!String(nossa.detail).includes(body.data.token), 'o bilhete vazou para a trilha');

    const dele = await getDb()('audit_log')
      .where({ tenant_id: beta, action: 'operator.created' })
      .orderBy('id', 'desc')
      .first();
    assert.ok(dele, 'o ISP não tem na trilha dele que uma conta foi criada na equipe');
    assert.equal(dele.actor_kind, 'platform');
    assert.equal(dele.subject_id, String(userId));
  });
});
