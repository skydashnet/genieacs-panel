import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { call, getDb, insertReturningId, startTestServers, stopTestServers } from './helpers/harness.js';

const { migrations } = await import('../src/config/migrations.js');

/**
 * O primeiro usuário é o dono.
 *
 * Duas pontas da mesma decisão: o `/setup` de agora em diante cria `owner`, e o
 * provedor instalado antes disto — com o primeiro usuário `admin` e dono
 * nenhum — ganha o dono na atualização: o administrador mais antigo, e só ele.
 * Quem já tem dono não é tocado.
 */
const PROMOVE = migrations.find((m) => m.id === '0065_first_admin_becomes_owner');

let panelUrl;

before(async () => {
  ({ panelUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
});

let seq = 0;
async function pessoa(nome) {
  seq += 1;
  return insertReturningId('users', { username: `${nome}-${seq}`, password: 'x', role: 'admin' });
}
async function provedor(slug) {
  return insertReturningId('tenants', { slug: `${slug}-${seq}`, name: slug, status: 'active' });
}
async function vincular(tenantId, userId, role, criadoEm) {
  await getDb()('tenant_users').insert({ tenant_id: tenantId, user_id: userId, role, created_at: criadoEm, updated_at: criadoEm });
}
const papel = async (tenantId, userId) => (await getDb()('tenant_users').where({ tenant_id: tenantId, user_id: userId }).first()).role;
const ontem = new Date(Date.now() - 86_400_000);
const hoje = new Date();

describe('o /setup', () => {
  it('cria o primeiro usuário como dono — na resposta, no token e no vínculo', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST',
      body: { username: 'quem-instalou', password: 'senha-de-quem-instalou-1', email: 'dono@provedor.test' }
    });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.user.role, 'owner');
    const token = JSON.parse(Buffer.from(body.data.token.split('.')[1], 'base64url').toString());
    assert.equal(token.role, 'owner');
    const vinculo = await getDb()('tenant_users').where({ user_id: body.data.user.id }).first();
    assert.equal(vinculo.role, 'owner');
  });
});

describe('a migração 0065 — o provedor sem dono ganha dono', () => {
  it('promove só o administrador mais antigo, e deixa a linha na trilha', async () => {
    const db = getDb();
    const t = await provedor('sem-dono');
    const primeiro = await pessoa('quem-fez-o-setup');
    const depois = await pessoa('outro-admin');
    const tecnico = await pessoa('tecnico');
    await vincular(t, depois, 'admin', hoje);
    await vincular(t, primeiro, 'admin', ontem);
    await vincular(t, tecnico, 'tech', ontem);

    assert.equal(await PROMOVE.isApplied(db), false);
    await PROMOVE.up(db);
    assert.equal(await PROMOVE.isApplied(db), true);

    assert.equal(await papel(t, primeiro), 'owner');
    assert.equal(await papel(t, depois), 'admin', 'dois admin viraram dois donos');
    assert.equal(await papel(t, tecnico), 'tech');
    assert.equal((await db('users').where({ id: primeiro }).first()).role, 'owner');

    const trilha = await db('audit_log').where({ tenant_id: t, action: 'operator.role_changed' });
    assert.equal(trilha.length, 1);
    assert.equal(trilha[0].actor_kind, 'system');
    assert.equal(trilha[0].subject_id, String(primeiro));
    assert.deepEqual(JSON.parse(trilha[0].detail), { username: (await db('users').where({ id: primeiro }).first()).username, from: 'admin', to: 'owner' });
  });

  it('não toca no provedor que já tem dono', async () => {
    const db = getDb();
    const t = await provedor('com-dono');
    const dona = await pessoa('a-dona');
    const admin = await pessoa('admin-antigo');
    await vincular(t, admin, 'admin', ontem);
    await vincular(t, dona, 'owner', hoje);

    await PROMOVE.up(db);

    assert.equal(await papel(t, admin), 'admin');
    assert.equal(await papel(t, dona), 'owner');
    assert.equal((await db('audit_log').where({ tenant_id: t, action: 'operator.role_changed' })).length, 0);
  });

  it('não inventa dono onde não há admin', async () => {
    const db = getDb();
    const t = await provedor('so-tecnicos');
    const tecnico = await pessoa('tec');
    await vincular(t, tecnico, 'tech', ontem);

    await PROMOVE.up(db);

    assert.equal(await papel(t, tecnico), 'tech');
  });

  it('quem trabalha em dois provedores muda só o vínculo, e não o papel da pessoa', async () => {
    const db = getDb();
    const a = await provedor('prov-a');
    const b = await provedor('prov-b');
    const consultora = await pessoa('consultora');
    const donaDeB = await pessoa('dona-de-b');
    await vincular(a, consultora, 'admin', ontem);
    await vincular(b, donaDeB, 'owner', ontem);
    await vincular(b, consultora, 'admin', hoje);

    await PROMOVE.up(db);

    assert.equal(await papel(a, consultora), 'owner');
    assert.equal(await papel(b, consultora), 'admin', 'o provedor vizinho, que já tem dona, foi tocado');
    assert.equal((await db('users').where({ id: consultora }).first()).role, 'admin');
  });

  it('rodar de novo não muda nada', async () => {
    const db = getDb();
    const antes = await db('tenant_users').orderBy('id').select('id', 'role');
    const trilhaAntes = await db('audit_log').where({ action: 'operator.role_changed' }).count({ n: '*' }).first();
    await PROMOVE.up(db);
    assert.deepEqual(await db('tenant_users').orderBy('id').select('id', 'role'), antes);
    const trilhaDepois = await db('audit_log').where({ action: 'operator.role_changed' }).count({ n: '*' }).first();
    assert.equal(Number(trilhaDepois.n), Number(trilhaAntes.n));
  });
});
