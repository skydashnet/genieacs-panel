import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: PlatformAdmin } = await import('../src/models/PlatformAdmin.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');

/**
 * O papel de cima, e as duas portas que dão nele.
 *
 * `owner` e `admin` alcançam exatamente as mesmas rotas — a diferença inteira
 * entre os dois é quem mexe no papel de quem. Uma regra que existe em um lugar
 * só não é uma regra: quem quiser contorná-la usa a porta ao lado. Este arquivo
 * cobre as portas — promover, rebaixar, encerrar o vínculo e trocar a senha — e existe
 * porque a terceira ficou de fora na primeira escrita: um `admin` não podia
 * rebaixar um `owner`, mas podia apagar a membership dele, que é pior.
 */
let panelUrl;
let tenantId;
let ownerToken;
let adminToken;
let ownerId;
let adminId;

async function criar(username, senha, role) {
  const bcrypt = (await import('bcryptjs')).default;
  const userId = await runInTenant(tenantId, () => User.create({
    username, password: bcrypt.hashSync(senha, 10), role
  }));
  await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId, role }));
  return userId;
}

async function entrar(username, senha) {
  const { body } = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username, password: senha }
  });
  assert.ok(body?.data?.token, `${username} precisa de um token`);
  return body.data.token;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  ownerId = await criar('a-dona', 'senha-da-dona-1', 'owner');
  adminId = await criar('o-admin', 'senha-do-admin-1', 'admin');
  await criar('outro-admin', 'senha-do-outro-1', 'admin');
  ownerToken = await entrar('a-dona', 'senha-da-dona-1');
  adminToken = await entrar('o-admin', 'senha-do-admin-1');
});

after(async () => {
  await stopTestServers();
});

const papelDe = (id) => getDb()('tenant_users')
  .where({ tenant_id: tenantId, user_id: id }).first();

describe('um admin diante do owner', () => {
  it('não o rebaixa', async () => {
    const { status } = await call(`${panelUrl}/api/users/${ownerId}`, {
      method: 'PATCH', headers: authHeaders(adminToken), body: { role: 'tech' }
    });
    assert.equal(status, 403);
    assert.equal((await papelDe(ownerId)).role, 'owner');
  });

  it('não encerra o vínculo dele', async () => {
    // A porta que faltava. Encerrar a membership é estritamente pior que
    // rebaixar: some da equipe em vez de perder poder.
    const { status } = await call(`${panelUrl}/api/users/${ownerId}`, {
      method: 'DELETE', headers: authHeaders(adminToken)
    });
    assert.equal(status, 403);
    assert.ok(await papelDe(ownerId), 'o vínculo do owner continua de pé');
  });

  it('não promove ninguém a owner', async () => {
    const alvo = await getDb()('users').where({ username: 'outro-admin' }).first();
    const { status } = await call(`${panelUrl}/api/users/${alvo.id}`, {
      method: 'PATCH', headers: authHeaders(adminToken), body: { role: 'owner' }
    });
    assert.equal(status, 403);
  });

  it('não se promove a si mesmo', async () => {
    const { status } = await call(`${panelUrl}/api/users/${adminId}`, {
      method: 'PATCH', headers: authHeaders(adminToken), body: { role: 'owner' }
    });
    assert.equal(status, 403);
    assert.equal((await papelDe(adminId)).role, 'admin');
  });

  it('mas mexe normalmente em outro admin', async () => {
    // O par obrigatório dos quatro acima: sem ele, um admin sem nenhum poder
    // sobre a equipe daria os mesmos 403 e o arquivo passaria provando nada.
    const alvo = await getDb()('users').where({ username: 'outro-admin' }).first();
    const { status } = await call(`${panelUrl}/api/users/${alvo.id}`, {
      method: 'PATCH', headers: authHeaders(adminToken), body: { role: 'tech' }
    });
    assert.equal(status, 200);
    assert.equal((await papelDe(alvo.id)).role, 'tech');
  });
});

describe('a senha do owner', () => {
  // A quarta porta: o papel, o vínculo e o 2FA do dono já eram só dele; a
  // senha não era, e trocar a senha é entrar como ele.
  const trocarSenha = (token, id, body) => call(`${panelUrl}/api/users/${id}`, {
    method: 'PATCH', headers: authHeaders(token), body
  });
  const consegueEntrar = async (username, senha) => (await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username, password: senha }
  })).status === 200;

  it('um admin não troca', async () => {
    const { status, body } = await trocarSenha(adminToken, ownerId, { password: 'senha-do-admin-agora' });
    assert.equal(status, 403, JSON.stringify(body));
    assert.equal(await consegueEntrar('a-dona', 'senha-do-admin-agora'), false, 'a senha nova do admin entrou na conta da dona');
    assert.equal(await consegueEntrar('a-dona', 'senha-da-dona-1'), true, 'a dona perdeu a própria senha');
    // A recusa não derruba a sessão dela: o token_version não subiu.
    const sessao = await call(`${panelUrl}/api/auth/user`, { headers: authHeaders(ownerToken) });
    assert.equal(sessao.status, 200);
  });

  it('nem junto com o papel, e nada muda', async () => {
    const { status } = await trocarSenha(adminToken, ownerId, { role: 'admin', password: 'senha-do-admin-agora' });
    assert.equal(status, 403);
    assert.equal((await papelDe(ownerId)).role, 'owner');
    assert.equal(await consegueEntrar('a-dona', 'senha-da-dona-1'), true);
  });

  it('outro owner troca', async () => {
    const segundoDono = await criar('o-segundo-dono', 'senha-do-segundo-1', 'owner');
    const { status } = await trocarSenha(ownerToken, segundoDono, { password: 'senha-nova-do-segundo' });
    assert.equal(status, 200);
    assert.equal(await consegueEntrar('o-segundo-dono', 'senha-nova-do-segundo'), true);
  });

  it('e o admin continua trocando a senha de quem não é owner', async () => {
    // O par obrigatório: sem ele, um admin que não trocasse senha de ninguém
    // daria os mesmos 403 acima e o bloco passaria provando nada.
    const alvo = await criar('mais-um-admin', 'senha-do-mais-um-1', 'admin');
    const { status } = await trocarSenha(adminToken, alvo, { password: 'senha-nova-do-mais-um' });
    assert.equal(status, 200);
    assert.equal(await consegueEntrar('mais-um-admin', 'senha-nova-do-mais-um'), true);
  });

  it('a troca feita pela equipe fica na trilha, sem a senha', async () => {
    const alvo = await criar('com-trilha', 'senha-da-trilha-1', 'tech');
    const { status } = await trocarSenha(adminToken, alvo, { password: 'senha-nova-da-trilha' });
    assert.equal(status, 200);
    const linha = await getDb()('audit_log')
      .where({ action: AuditLog.ACTIONS.OPERATOR_PASSWORD_SET, subject_id: String(alvo) })
      .first();
    assert.ok(linha, 'a troca de senha não deixou rastro');
    assert.equal(linha.actor_user_id, adminId);
    assert.deepEqual(JSON.parse(linha.detail), { username: 'com-trilha' });
  });
});

describe('a própria senha', () => {
  // Pelo PATCH da equipe bastava o token de acesso — sem a senha atual. Quem
  // roubasse um token de uma hora ficava com a conta para sempre.
  it('não se troca pela rota da equipe, e nada muda', async () => {
    const { status, body } = await call(`${panelUrl}/api/users/${adminId}`, {
      method: 'PATCH', headers: authHeaders(adminToken), body: { password: 'senha-roubada-123' }
    });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.code, 'password_self');
    const entra = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'o-admin', password: 'senha-roubada-123' }
    });
    assert.notEqual(entra.status, 200);
  });
});

describe('a senha de quem opera a plataforma', () => {
  // Com a senha, o console: todos os provedores, personificação, cobrança. Um
  // provedor não pode defini-la — nem o admin, nem o owner, nem junto com o papel.
  const trocarSenha = (token, id, body) => call(`${panelUrl}/api/users/${id}`, {
    method: 'PATCH', headers: authHeaders(token), body
  });

  it('ninguém do provedor troca, e nada muda', async () => {
    const alvo = await criar('suporte-plataforma', 'senha-do-suporte-1', 'tech');
    await PlatformAdmin.add(alvo);
    try {
      for (const token of [adminToken, ownerToken]) {
        const { status, body } = await trocarSenha(token, alvo, { role: 'viewer', password: 'senha-do-provedor-1' });
        assert.equal(status, 409, JSON.stringify(body));
        assert.equal(body.code, 'password_platform');
      }
      assert.equal((await papelDe(alvo)).role, 'tech', 'o papel mudou antes da recusa');
      const entra = await call(`${panelUrl}/api/auth/login`, {
        method: 'POST', body: { username: 'suporte-plataforma', password: 'senha-do-provedor-1' }
      });
      assert.notEqual(entra.status, 200, 'a senha escolhida pelo provedor entrou na conta da plataforma');
    } finally {
      await PlatformAdmin.remove(alvo);
    }
  });
});

describe('o owner', () => {
  it('promove outro a owner', async () => {
    const { status } = await call(`${panelUrl}/api/users/${adminId}`, {
      method: 'PATCH', headers: authHeaders(ownerToken), body: { role: 'owner' }
    });
    assert.equal(status, 200);
    assert.equal((await papelDe(adminId)).role, 'owner');
  });

  it('e rebaixa o outro owner de volta', async () => {
    const { status } = await call(`${panelUrl}/api/users/${adminId}`, {
      method: 'PATCH', headers: authHeaders(ownerToken), body: { role: 'admin' }
    });
    assert.equal(status, 200);
    assert.equal((await papelDe(adminId)).role, 'admin');
  });

  it('não se rebaixa para um papel que não administra a equipe', async () => {
    // Sair pela porta e deixar a chave dentro: a pessoa perderia a própria tela
    // de operadores no mesmo request. A condição é a CAPACIDADE e não o nome do
    // papel — ver o par abaixo.
    const { status } = await call(`${panelUrl}/api/users/${ownerId}`, {
      method: 'PATCH', headers: authHeaders(ownerToken), body: { role: 'tech' }
    });
    assert.equal(status, 409);
    assert.equal((await papelDe(ownerId)).role, 'owner');
  });

  it('mas se rebaixa a admin, que continua administrando', async () => {
    const { status } = await call(`${panelUrl}/api/users/${ownerId}`, {
      method: 'PATCH', headers: authHeaders(ownerToken), body: { role: 'admin' }
    });
    assert.equal(status, 200);
    assert.equal((await papelDe(ownerId)).role, 'admin');
  });
});
