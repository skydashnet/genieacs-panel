import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O cadastro de um provedor, baixado do console.
 *
 * Existe por causa de uma ordem obrigatória que fechava a porta antes da hora.
 * Suspender devolve 404 no HOST inteiro do provedor, e a exclusão EXIGE
 * suspensão antes — então a janela para o ISP levar os próprios dados fechava
 * antes de a exclusão ser permitida. O que sai junto, quando não sai, é o
 * cadastro dos assinantes dele.
 *
 * Os dois casos que decidem estão em lados opostos:
 *
 * - o provedor SUSPENSO exporta, que é o estado para o qual a rota existe;
 * - e o arquivo de um não traz NENHUMA linha do outro — a varredura de
 *   vazamento entre provedores feita à mão, para a única rota do produto em que
 *   olhar o provedor pelo id é o trabalho e não o defeito.
 */

// A edição precisa ser escolhida antes de `app.js` ser importado.
process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: PlatformAudit } = await import('../src/models/PlatformAudit.js');
const { platformExportLimiter } = await import('../src/middleware/rateLimit.js');

let panelUrl;
let token;
let semPoder;
let operadorId;
let alfa;
let beta;

const platform = (path, options = {}) => call(`${panelUrl}/api/platform${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

/** Um provedor com linhas que dizem de quem elas são. */
async function provedorComDados(slug, nome) {
  const criado = await platform('/tenants', { method: 'POST', body: { slug, name: nome } });
  assert.equal(criado.status, 201, JSON.stringify(criado.body));
  const id = criado.body.data.tenant.id;
  await runInTenant(id, () => insertReturningId('customer_accounts', {
    tenant_id: id,
    customer_id: `CSG-${slug}`,
    device_id: `ONT-${slug}`,
    identity_hash: `hash-${slug}`,
    software_id: 'V1',
    pppoe_username: `assinante-${slug}`,
    password_hash: `hash-secreto-${slug}`,
    active: true
  }));
  await runInTenant(id, () => insertReturningId('vendors', {
    tenant_id: id,
    name: `Fabricante ${nome}`,
    manufacturer_patterns: '[]',
    product_patterns: '[]'
  }));
  return id;
}

const suspender = (id) => platform(`/tenants/${id}`, { method: 'PATCH', body: { status: 'suspended' } });

/** O arquivo, já lido — a rota devolve JSON cru e não o envelope da API. */
async function exportar(id) {
  const resposta = await platform(`/tenants/${id}/export`);
  return resposta;
}

before(async () => {
  ({ panelUrl } = await startTestServers());

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-plataforma', password: 'senha-da-plataforma-1', email: 'a-plataforma@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  operadorId = setup.body.data.user.id;
  if (!(await getDb()('platform_admins').where({ user_id: operadorId }).first())) {
    await getDb()('platform_admins').insert({ user_id: operadorId });
  }

  alfa = await provedorComDados('alfa', 'Provedor Alfa');
  beta = await provedorComDados('beta', 'Provedor Beta');

  // Uma sessão de administrador do PROVEDOR, que não é do plano de controle.
  const conta = await call(`${panelUrl}/api/auth/register`, {
    method: 'POST',
    headers: authHeaders(token),
    body: { username: 'dono-do-isp', password: 'senha-do-isp-12345', email: 'dono@exemplo.test', role: 'admin' }
  });
  if (conta.status === 201 || conta.status === 200) {
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST',
      body: { username: 'dono-do-isp', password: 'senha-do-isp-12345' }
    });
    semPoder = login.body?.data?.token ?? null;
  }
});

after(async () => {
  await stopTestServers();
});

// O teto desta rota é de seis por minuto, e este arquivo exporta mais vezes que
// isso de propósito. Zerado por caso para que a suíte prove a ROTA e não o
// limitador — que tem prova própria no último bloco.
beforeEach(() => platformExportLimiter.resetKey(`user:${operadorId}`));

describe('quem pode pedir', () => {
  it('ninguém sem sessão', async () => {
    const { status } = await call(`${panelUrl}/api/platform/tenants/${alfa}/export`);
    assert.equal(status, 401);
  });

  it('e nem um administrador do próprio provedor', async () => {
    // O console é um plano ACIMA de qualquer provedor: quem manda num ISP,
    // por mais graduado que seja lá dentro, não alcança o cadastro de outro.
    if (!semPoder) return;
    const { status } = await call(`${panelUrl}/api/platform/tenants/${alfa}/export`, {
      headers: authHeaders(semPoder)
    });
    assert.equal(status, 403);
  });

  it('id que não existe dá 404, e id inválido dá 400', async () => {
    const inexistente = await exportar(999999);
    assert.equal(inexistente.status, 404);
    const invalido = await exportar('banana');
    assert.equal(invalido.status, 400);
  });
});

describe('o arquivo', () => {
  it('traz as linhas do provedor pedido', async () => {
    const { status, body, response } = await exportar(alfa);
    assert.equal(status, 200);
    assert.match(
      response.headers.get('content-disposition') || '',
      /attachment; filename="skygenpanel-alfa-/
    );
    assert.equal(body.manifest.tenant.slug, 'alfa');
    const contas = body.data.customer_accounts.map((linha) => linha.customer_id);
    assert.deepEqual(contas, ['CSG-alfa']);
  });

  /**
   * A varredura de vazamento, escrita à mão para esta rota.
   *
   * É a única do produto em que o id de um provedor na URL devolve as linhas
   * daquele provedor de propósito — e por isso a prova não pode ser só "404
   * para id desconhecido". O que se exige aqui é que NADA do vizinho apareça,
   * em tabela nenhuma.
   */
  it('e nenhuma linha do vizinho, em tabela nenhuma', async () => {
    const { body } = await exportar(alfa);
    const doVizinho = [];
    for (const [tabela, linhas] of Object.entries(body.data)) {
      for (const linha of linhas) {
        if (Number(linha.tenant_id) === Number(beta)) doVizinho.push(`${tabela}#${linha.id ?? linha.key}`);
      }
    }
    assert.deepEqual(doVizinho, [], 'o arquivo de um provedor trouxe linha de outro');

    // E o contrário, para o caso não ser satisfeito por um arquivo vazio.
    const outro = await exportar(beta);
    assert.deepEqual(
      outro.body.data.customer_accounts.map((linha) => linha.customer_id),
      ['CSG-beta']
    );
  });

  it('sem os segredos, porque é o mesmo serviço da exportação do provedor', async () => {
    const { body } = await exportar(alfa);
    const [conta] = body.data.customer_accounts;
    assert.ok(conta, 'a conta semeada tinha que estar no arquivo');
    assert.ok(!('password_hash' in conta), 'o hash da senha do portal saiu no arquivo');
    for (const coluna of Object.keys(conta)) {
      assert.ok(!coluna.endsWith('_ciphertext'), `${coluna} saiu no arquivo`);
    }
  });
});

/**
 * O estado para o qual esta rota existe.
 *
 * Suspenso, o host do provedor responde 404 inteiro — a exportação DELE não é
 * alcançável nem por ele nem por uma personificação. E é exatamente o estado
 * que a exclusão exige antes de permitir apagar.
 */
describe('o provedor suspenso', () => {
  it('continua exportável pelo console', async () => {
    const id = await provedorComDados('de-saida', 'Provedor de Saída');
    assert.equal((await suspender(id)).status, 200);
    assert.equal(
      (await getDb()('tenants').where({ id }).first()).status,
      'suspended',
      'o provedor tinha que estar suspenso para este caso valer'
    );

    const { status, body } = await exportar(id);
    assert.equal(status, 200);
    assert.deepEqual(
      body.data.customer_accounts.map((linha) => linha.customer_id),
      ['CSG-de-saida']
    );
  });
});

describe('a trilha', () => {
  it('grava no plano de controle quem baixou o quê', async () => {
    await exportar(beta);
    const linha = await getDb()('platform_audit')
      .where({ action: PlatformAudit.ACTIONS.TENANT_EXPORTED, tenant_id: beta })
      .orderBy('id', 'desc')
      .first();
    assert.ok(linha, 'a exportação não foi registrada no plano de controle');
    assert.equal(linha.actor_username, 'a-plataforma');
    const detalhe = JSON.parse(linha.detail);
    assert.equal(detalhe.status, 'active');
    assert.ok(Number(detalhe.rowCounts.customer_accounts) >= 1);
  });

  /**
   * E na trilha DO PROVEDOR, que é onde ele vai perguntar.
   *
   * Quem faz a pergunta "alguém baixou a nossa base?" é o ISP, e ele não lê a
   * trilha da plataforma. `actorKind: 'platform'` é o que diz de onde veio.
   */
  it('e na do provedor, dizendo que veio do console', async () => {
    await exportar(beta);
    const linha = await runInTenant(beta, () => getDb()('audit_log')
      .where({ tenant_id: beta, action: 'tenant.exported' })
      .orderBy('id', 'desc')
      .first());
    assert.ok(linha, 'a exportação não apareceu na trilha do provedor');
    assert.equal(linha.actor_kind, 'platform');
  });

  /**
   * A trilha da plataforma é CONDIÇÃO, no molde da exclusão.
   *
   * Uma cópia dos assinantes de um cliente saindo daqui sem registro é o que
   * não pode acontecer em silêncio. Como o arquivo já está pronto na memória
   * quando a trilha é escrita, recusar não desfaz nada — só não entrega.
   */
  it('e sem ela gravada o arquivo não sai', async () => {
    const original = PlatformAudit.fromRequest;
    PlatformAudit.fromRequest = async () => false;
    try {
      const { status, body } = await exportar(alfa);
      assert.equal(status, 500);
      assert.ok(!body.data, 'o arquivo saiu sem registro');
    } finally {
      PlatformAudit.fromRequest = original;
    }
  });
});

/**
 * E o teto, que é a única defesa contra o laço.
 *
 * Uma chamada lê toda tabela escopada de um provedor. Um laço sobre a lista de
 * clientes — por engano ou por script — tira o banco do ar enquanto roda, e o
 * limitador genérico de 300 por minuto não o segura.
 */
describe('o teto da exportação', () => {
  it('para o sétimo pedido do mesmo minuto', async () => {
    platformExportLimiter.resetKey(`user:${operadorId}`);
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- gastar a janela é o caso
      const { status } = await exportar(alfa);
      assert.equal(status, 200, `exportação ${i + 1}`);
    }
    const excedente = await exportar(alfa);
    assert.equal(excedente.status, 429);
    assert.equal(excedente.body.code, 'rate_limited_export');
  });
});
