import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import express from 'express';

/**
 * Who holds the control plane, and what the guard says to everybody else.
 *
 * Wave 13 adds a privilege that is not a role: `users.role` and the membership's
 * role both answer "what may you do at this provider", and neither can ever
 * answer "you may mint providers". So what has to be proved here is mostly a
 * set of refusals — that being an administrator at an ISP reaches nothing new,
 * that a grant withdrawn is gone at the next request rather than at the next
 * hour, and that the migration's empty table stays empty on an install that has
 * no control plane to hand out.
 *
 * The edition is chosen before the harness pulls the application in, exactly as
 * `edition-saas.test.js` does it: `edition.js` reads the environment at import,
 * static imports are hoisted, and `node --test` gives this file its own
 * process. This file runs as the HOSTED edition, because that is the one where
 * the control plane exists; the self-hosted half of the bootstrap contract is
 * proved in a child process below, which is the only honest way to have two
 * editions in one run.
 */
process.env.EDITION = 'saas';

const {
  authHeaders,
  call,
  getDb,
  startTestServers,
  stopTestServers
} = await import('./helpers/harness.js');

const { default: PlatformAdmin } = await import('../src/models/PlatformAdmin.js');
const { attachLocale } = await import('../src/middleware/locale.js');
const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
const { authenticateToken, requirePlatformAdmin } = await import('../src/middleware/auth.js');

const SRC_URL = new URL('../src/', import.meta.url).href;

// The first administrator of the hosted install: the one `setup` is contracted
// to put on the roster, because a SaaS deployment whose roster is empty has
// nobody who can create the second provider.
const PLATAFORMA = { username: 'plataforma', password: 'plataforma-senha-1', email: 'plataforma@exemplo.test' };
// Administrator at the provider, and nothing more. She is the point of the
// whole exercise: full authority over her own ISP, none at all over the
// deployment that hosts it.
const DONA = { username: 'dona', password: 'dona-senha-1', email: 'dona@exemplo.test' };
// Granted the control plane and then taken off it, with the same token in hand
// throughout.
const PROMOVIDA = { username: 'promovida', password: 'promovida-senha-1', email: 'promovida@exemplo.test' };

let panelUrl;
let probeUrl;
let probeServer;
let plataformaToken;
let donaToken;
let promovidaToken;
const idOf = {};

/**
 * A route that is nothing but the guard.
 *
 * The control-plane routes belong to the lanes that come after this one, so
 * there is no real endpoint to point at yet — but a guard asserted by calling
 * the function with a hand-made `req` proves only that the function was
 * written. This mounts the middleware in the same order and on the same stack
 * the application mounts it in: locale first (the guard answers a translated
 * message), the provider resolver under `/api`, then `authenticateToken` and
 * the guard on the route itself.
 *
 * The unrouted path below it is not decoration. It is the answer the guard is
 * contracted to be indistinguishable from, so the test can assert on the real
 * thing rather than on a status code that merely looks the same.
 */
function buildProbe() {
  const probe = express();
  probe.use(attachLocale);
  probe.use(express.json());
  probe.use('/api', resolveTenant);
  probe.get('/api/platform/probe', authenticateToken, requirePlatformAdmin, (req, res) => {
    res.json({ success: true, data: { userId: req.user.userId } });
  });
  probe.use('/api', (req, res) => {
    res.status(404).json({ success: false, message: req.t('common.routeNotFound') });
  });
  return probe;
}

const reachControlPlane = (token) => call(`${probeUrl}/api/platform/probe`, {
  headers: authHeaders(token)
});

const signIn = (person) => call(`${panelUrl}/api/auth/login`, {
  method: 'POST',
  body: person
});

/** Creates an operator at the provider, through the route an administrator uses. */
async function hire(person, role, token) {
  const { status, body } = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { ...person, role }
  });
  assert.equal(status, 201, `could not create ${person.username}`);
  idOf[person.username] = body.data.user.id;
  return body.data.user.id;
}

/**
 * Runs one module of the application in a process of its own.
 *
 * The two bootstrap paths are decided by `EDITION`, which is read once when
 * `edition.js` is imported and cannot be changed afterwards inside a process.
 * A child is therefore the only way to exercise the self-hosted branch in a run
 * whose application is the hosted one — and it is a faithful way, since the
 * child inherits `DATA_DIR` and so opens the very database this suite is
 * running against, on whichever engine that is.
 */
function runInEdition(edition, source, args = []) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', source, ...args],
    { env: { ...process.env, EDITION: edition }, encoding: 'utf8' }
  );
}

/**
 * A whole self-hosted install, over HTTP, against this suite's own database.
 *
 * It sets itself up and signs in through the real routes rather than calling
 * the model, because two of the three things being proved are answers the
 * CONTROLLER gives. The stray roster row in the middle is the interesting part:
 * it is what an install that once ran the grant script and later moved to the
 * self-hosted edition would still have on disk, and the session it reports must
 * not offer a control plane whose routes are not mounted there.
 */
const SELF_HOSTED_INSTALL = `
  const { app } = await import('${SRC_URL}app.js');
  const { getDb, closePool } = await import('${SRC_URL}config/database.js');

  const [username, password] = process.argv.slice(1);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body, token) => fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: JSON.stringify(body)
  }).then((r) => r.json().then((json) => ({ status: r.status, body: json })));

  const setup = await post('/api/auth/setup', { username, password, email: username + '@exemplo.test' });
  const rosterAfterSetup = await getDb()('platform_admins');

  await getDb()('platform_admins').insert({ user_id: setup.body.data.user.id });
  const login = await post('/api/auth/login', { username, password });
  const session = await fetch(base + '/api/auth/user', {
    headers: { Authorization: 'Bearer ' + login.body.data.token }
  }).then((r) => r.json());

  console.log(JSON.stringify({ setup, rosterAfterSetup, login, session }));
  await new Promise((resolve) => server.close(resolve));
  await closePool();
`;

function listen(target) {
  return new Promise((resolve) => {
    const server = target.listen(0, '127.0.0.1', () => resolve(server));
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  probeServer = await listen(buildProbe());
  probeUrl = `http://127.0.0.1:${probeServer.address().port}`;
});

after(async () => {
  if (probeServer) await new Promise((resolve) => probeServer.close(resolve));
  await stopTestServers();
});

/**
 * First, because it needs an install with no users at all — which is what the
 * harness has just finished creating and what every test below spends.
 */
describe('a self-hosted install', () => {
  let ran;

  before(() => {
    const child = runInEdition('selfhosted', SELF_HOSTED_INSTALL, ['local', 'local-senha-1']);
    assert.equal(child.status, 0, child.stderr);
    // A última linha, não a saída inteira: o filho é uma aplicação completa e
    // escreve o que uma aplicação escreve ao subir. O anúncio do `dotenv` não
    // está mais entre isso — ele passou a sair na stderr no `dotenv` 18 —, mas
    // a razão de ler só a última linha continua sendo o resto.
    ran = JSON.parse(child.stdout.trim().split('\n').pop());
  });

  it('creates the first administrator and puts nobody on the roster', () => {
    assert.equal(ran.setup.status, 201);
    assert.equal(ran.setup.body.data.user.role, 'owner');
    assert.deepEqual(ran.rosterAfterSetup, [],
      'a self-hosted install was handed a control plane it does not have');
  });

  // There is no control plane on this edition, so the panel is told there is
  // nothing to draw — and told it without having to know which edition it is
  // talking to. Asserted with a roster row deliberately present, so what is
  // being proved is the edition and not merely an empty table.
  it('reports no control plane even with a row in the table', () => {
    assert.equal(ran.setup.body.data.user.isPlatformAdmin, false);
    assert.equal(ran.login.body.data.user.isPlatformAdmin, false);
    assert.equal(ran.session.data.isPlatformAdmin, false);
  });

  // Undone here rather than left behind: the hosted bootstrap below is a FRESH
  // install by definition, and `createInitialAdmin` refuses to run once anybody
  // exists. The membership is deleted by hand rather than left to the foreign
  // key, because on SQLite an emptied `users` hands out id 1 again and an
  // orphaned membership row would then collide with the new one. The latch goes
  // too: it is what marks the provider as already set up.
  after(async () => {
    await getDb()('platform_admins').del();
    await getDb()('tenant_users').del();
    await getDb()('users').del();
    await getDb()('app_state').where({ key: 'setup_completed' }).del();
  });
});

describe('setup on a hosted install', () => {
  it('makes the first administrator a platform administrator too', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: PLATAFORMA
    });
    assert.equal(status, 201);
    idOf.plataforma = body.data.user.id;

    const roster = await getDb()('platform_admins');
    assert.equal(roster.length, 1,
      'a hosted install came up with nobody able to create the second provider');
    assert.equal(Number(roster[0].user_id), Number(idOf.plataforma));
    assert.equal(await PlatformAdmin.has(idOf.plataforma), true);

    // And says so on the way out, so the panel walking straight into the
    // session from setup already knows the providers screen is his to open.
    assert.equal(body.data.user.isPlatformAdmin, true);
  });
});

describe('the guard', () => {
  before(async () => {
    plataformaToken = (await signIn(PLATAFORMA)).body.data.token;
    await hire(DONA, 'owner', plataformaToken);
    await hire(PROMOVIDA, 'admin', plataformaToken);
    donaToken = (await signIn(DONA)).body.data.token;
    promovidaToken = (await signIn(PROMOVIDA)).body.data.token;
  });

  it('lets a platform administrator through', async () => {
    const { status, body } = await reachControlPlane(plataformaToken);
    assert.equal(status, 200);
    assert.equal(Number(body.data.userId), Number(idOf.plataforma));
  });

  // The claim the whole second roster exists to make. Dona is her provider's
  // owner — the top role there: she creates operators, changes the ACS address
  // and reads every device at her ISP. None of that is authority over the
  // deployment that hosts her.
  it('refuses a provider\'s own administrator', async () => {
    const { status } = await reachControlPlane(donaToken);
    assert.equal(status, 404, 'being owner at a provider reached the control plane');

    // And her token is a perfectly good session — it is the privilege that is
    // missing, not the login. Without this the assertion above would pass just
    // as well if every request were failing.
    const stillSignedIn = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(donaToken)
    });
    assert.equal(stillSignedIn.status, 200);
    assert.equal(stillSignedIn.body.data.role, 'owner');
  });

  // Not merely "a 404 happened to come back": the contract is that her token
  // cannot tell a control plane she is not on from a deployment that has none,
  // so the answer has to be the one an unrouted path gives, body and all.
  it('answers exactly what an unrouted path answers', async () => {
    const guarded = await reachControlPlane(donaToken);
    const unrouted = await call(`${probeUrl}/api/nao-existe`, {
      headers: authHeaders(donaToken)
    });

    assert.equal(guarded.status, unrouted.status);
    assert.deepEqual(guarded.body, unrouted.body,
      'the refusal names itself, and confirms the control plane is there');
  });

  it('refuses a request carrying no session at all', async () => {
    const { status } = await call(`${probeUrl}/api/platform/probe`);
    assert.equal(status, 401);
  });

  // The token is a claim, never the authority. The roster is read from the
  // table on every request for the same reason wave 12 re-reads the membership:
  // a grant taken back at 09:00 has to be gone at 09:00, and not whenever the
  // hour this token is good for happens to run out.
  it('lets somebody through the moment they are granted it', async () => {
    assert.equal((await reachControlPlane(promovidaToken)).status, 404);

    assert.equal(await PlatformAdmin.add(idOf.promovida), true);
    const { status, body } = await reachControlPlane(promovidaToken);
    assert.equal(status, 200, 'the same token that was refused is now the same claim');
    assert.equal(Number(body.data.userId), Number(idOf.promovida));
  });

  it('stops letting them through on the very next request once it is taken back', async () => {
    assert.equal((await reachControlPlane(promovidaToken)).status, 200);

    assert.equal(await PlatformAdmin.remove(idOf.promovida), true);
    assert.equal((await reachControlPlane(promovidaToken)).status, 404,
      'a withdrawn grant survived until the token expired');

    // Losing the control plane is not losing the account: she still works for
    // her provider, and revoking her sessions over this would sign her out of
    // a panel the change has nothing to do with.
    const stillSignedIn = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(promovidaToken)
    });
    assert.equal(stillSignedIn.status, 200);
  });
});

/**
 * What the session tells the panel about itself.
 *
 * The screen that manages providers cannot be gated on `role`: a provider's own
 * administrator is `admin` too, so that gate would put the link in front of
 * most of the panel's administrators and send them at routes that answer them
 * as though nothing were there. So the session says it outright — and says it
 * from the table, at request time, for the same reason the guard does.
 */
describe('what a session reports about the control plane', () => {
  it('tells a platform administrator apart from a provider\'s administrator', async () => {
    const platform = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(plataformaToken)
    });
    const provider = await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(donaToken)
    });

    assert.equal(platform.body.data.isPlatformAdmin, true);
    assert.equal(provider.body.data.isPlatformAdmin, false);
    // Both are `owner` — the one who ran /setup and a provider's owner —, which
    // is exactly why the flag has to exist.
    assert.equal(platform.body.data.role, provider.body.data.role);
  });

  it('says it on the login response too', async () => {
    const { body } = await signIn(DONA);
    assert.equal(body.data.user.isPlatformAdmin, false);
  });

  // Read at request time, never from the token: the same session that was told
  // "no screen for you" is told otherwise on its next request, without signing
  // in again — and the reverse, which is the one that matters.
  it('follows the roster within the life of one token', async () => {
    const reported = async () => (await call(`${panelUrl}/api/auth/user`, {
      headers: authHeaders(promovidaToken)
    })).body.data.isPlatformAdmin;

    assert.equal(await reported(), false);
    await PlatformAdmin.add(idOf.promovida);
    assert.equal(await reported(), true);
    await PlatformAdmin.remove(idOf.promovida);
    assert.equal(await reported(), false,
      'a withdrawn grant kept drawing the control plane until the token expired');
  });
});

describe('the grant script', () => {
  const script = new URL('../scripts/grant-platform-admin.js', import.meta.url).pathname;

  const grant = (...args) => spawnSync(process.execPath, [script, ...args], {
    env: process.env,
    encoding: 'utf8'
  });

  const rosterFor = (username) => getDb()('platform_admins')
    .join('users', 'users.id', 'platform_admins.user_id')
    .where('users.username', username);

  it('puts exactly one row in for the person named', async () => {
    const run = grant(DONA.username);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /granted/i);

    const rows = await rosterFor(DONA.username);
    assert.equal(rows.length, 1);
  });

  // Whoever holds the server will run it a second time to check that it took.
  // That is not a mistake to punish with a constraint violation, and it must
  // not leave a second row behind either.
  it('is idempotent, and says so', async () => {
    const run = grant(DONA.username);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /already/i);

    const rows = await rosterFor(DONA.username);
    assert.equal(rows.length, 1, 'running the grant twice left two rows');
  });

  // The roster is the one list in this codebase that is read whole and
  // unfiltered, because it is the one table that belongs to no provider.
  it('lands on the roster the model reads back', async () => {
    const roster = await PlatformAdmin.list();
    assert.deepEqual(roster.map((r) => r.username), [DONA.username, PLATAFORMA.username]);
    assert.equal(Number(roster[0].id), Number(idOf.dona));
  });

  it('grants the control plane it prints', async () => {
    const { body } = await signIn(DONA);
    assert.equal((await reachControlPlane(body.data.token)).status, 200);
  });

  it('takes it back again with --revoke', async () => {
    const run = grant(DONA.username, '--revoke');
    assert.equal(run.status, 0, run.stderr);
    assert.equal((await rosterFor(DONA.username)).length, 0);
  });

  /**
   * `--create`: a conta de plataforma que não pertence a provedor nenhum.
   *
   * É o que desfaz a contradição de origem — até aqui a primeira chave nascia
   * no `/setup`, que cria o primeiro operador de UM provedor e o põe no
   * cadastro de quebra, fazendo da conta-raiz da plataforma um membro do
   * provedor `default`.
   */
  describe('--create', () => {
    const NOVA = { username: 'so-plataforma', email: 'so-plataforma@exemplo.test' };
    const criar = (args, senha) => spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, PLATFORM_ADMIN_PASSWORD: senha ?? '' },
      encoding: 'utf8'
    });

    it('cria a conta com a chave e SEM vínculo com provedor nenhum', async () => {
      const run = criar([NOVA.username, '--create', '--email', NOVA.email], 'senha-da-plataforma-1');
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /created/i);

      const user = await getDb()('users').where({ username: NOVA.username }).first();
      assert.ok(user, 'a conta não foi criada');
      assert.equal((await rosterFor(NOVA.username)).length, 1, 'a conta não entrou no cadastro');
      // O ponto inteiro do modo: nenhuma linha em `tenant_users`.
      assert.deepEqual(await getDb()('tenant_users').where({ user_id: user.id }), []);
    });

    /**
     * Sem vínculo, não há painel de provedor em que pôr esta sessão — e é isso
     * que o modo `--create` quer: a conta-raiz não é membro de ISP nenhum.
     *
     * O que ela recebe aqui é a sessão de CONSOLE. Num deploy sem domínio-base
     * este é o único endereço que existe, e antes esta conta simplesmente não
     * entrava em lugar nenhum: o console só era cunhado sob `req.platformHost`,
     * que é falso quando não há host de plataforma. O runbook mandava criar a
     * conta pelo script e entrar com ela, e nesse arranjo isso não acontecia.
     *
     * A sessão não nomeia provedor e não tem papel — é o que `tdb()` precisa
     * para estourar alto se um controlador do console esquecer o escopo.
     */
    it('e essa conta entra no console, que é o único lugar dela', async () => {
      const { status, body } = await signIn({
        username: NOVA.username, password: 'senha-da-plataforma-1'
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.data.user.tenantId, null);
      assert.equal(body.data.user.role, null);
      assert.equal(body.data.user.platform, true);
    });

    it('recusa um nome que já existe, e não escreve nada', async () => {
      const antes = await getDb()('users').count({ n: '*' }).first();
      const run = criar([NOVA.username, '--create', '--email', 'outro@exemplo.test'], 'senha-da-plataforma-1');
      assert.equal(run.status, 1);
      assert.deepEqual(await getDb()('users').count({ n: '*' }).first(), antes);
    });

    it('recusa sem e-mail e com senha curta, que são as duas pernas da conta', async () => {
      const semEmail = criar(['outra-conta', '--create'], 'senha-da-plataforma-1');
      assert.equal(semEmail.status, 1);
      assert.match(semEmail.stderr, /email/i);

      const senhaCurta = criar(['outra-conta', '--create', '--email', 'outra@exemplo.test'], 'curta');
      assert.equal(senhaCurta.status, 1);
      assert.match(senhaCurta.stderr, /password/i);

      assert.equal(await getDb()('users').where({ username: 'outra-conta' }).first(), undefined);
    });
  });

  it('refuses a name that belongs to nobody, and writes nothing', async () => {
    const before_ = await getDb()('platform_admins');
    const run = grant('ninguem');
    assert.equal(run.status, 1);
    assert.deepEqual(await getDb()('platform_admins'), before_);
  });
});
