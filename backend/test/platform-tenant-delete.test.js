import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Apagar um provedor.
 *
 * A versão anterior do painel não tinha esta operação, e a razão estava escrita
 * no controlador: apagar leva os aparelhos, os assinantes e o histórico de
 * mensagens de um ISP junto, e um botão que faz isso num clique não deveria
 * existir. O argumento continua inteiro. O que mudou foi a exigência — LGPD dá
 * ao titular o direito de sumir, e um contrato cancelado precisa de um fim.
 *
 * A conciliação está na FORMA da operação, e é o que este arquivo cobra:
 * quatro condições ao mesmo tempo, nenhuma delas acontecendo por acidente, e a
 * trilha gravada ANTES — porque apagar sem deixar rastro é a única forma de
 * apagar que é indefensável.
 *
 * O caso central é o último: a linha da trilha tem que SOBREVIVER ao provedor.
 * É por causa dele que `platform_audit` existe como tabela à parte, sem chave
 * estrangeira para `tenants`.
 */

// A edição precisa ser escolhida antes de `app.js` ser importado.
process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { forgetResolvedTenant } = await import('../src/middleware/tenantResolver.js');
const { tenantMediaRoot } = await import('../src/services/waMediaService.js');

/** Existe no disco? A pergunta que `fs` só responde por exceção. */
async function existe(caminho) {
  try {
    await fs.stat(caminho);
    return true;
  } catch {
    return false;
  }
}

let panelUrl;
let token;
let alfa;

const platform = (path, options = {}) => call(`${panelUrl}/api/platform${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

/** Cria um provedor com algum conteúdo, para a exclusão ter o que apagar. */
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

const suspender = (id) => platform(`/tenants/${id}`, {
  method: 'PATCH', body: { status: 'suspended' }
});

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'a-plataforma', password: 'senha-da-plataforma-1', email: 'a-plataforma@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  // Guardado porque na edição SaaS o próprio `/auth/setup` já põe o primeiro
  // administrador no plano de controle: inserir de novo estoura no índice
  // único e derruba o `before`, que cancela o arquivo inteiro com uma mensagem
  // que não diz nada. `platform-tenants.test.js` faz a mesma guarda, pelo mesmo
  // motivo.
  const id = setup.body.data.user.id;
  if (!(await getDb()('platform_admins').where({ user_id: id }).first())) {
    await getDb()('platform_admins').insert({ user_id: id });
  }
});

after(async () => {
  await stopTestServers();
});

describe('as quatro condições', () => {
  it('recusa um provedor ativo', async () => {
    const id = await provedorComDados('ativa', 'Ainda Ativa');
    const { status } = await platform(`/tenants/${id}`, {
      method: 'DELETE', body: { confirmSlug: 'ativa' }
    });
    assert.equal(status, 409);
    assert.ok(await getDb()('tenants').where({ id }).first());
  });

  it('recusa sem o slug digitado de volta', async () => {
    const id = await provedorComDados('sem-slug', 'Sem Slug');
    await suspender(id);
    for (const confirmSlug of [undefined, '', 'Sem-Slug', ' sem-slug', 'sem-slug ', 'outra']) {
      const { status } = await platform(`/tenants/${id}`, { method: 'DELETE', body: { confirmSlug } });
      assert.equal(status, 409, String(confirmSlug));
    }
    assert.ok(await getDb()('tenants').where({ id }).first());
  });

  it('e o slug tem que bater EXATO, sem normalizar caixa nem espaço', async () => {
    // Normalizar aceitaria um slug "quase certo", que é justamente o que um
    // engano parece. O caso acima já cobre as variações; este diz por quê.
    const id = await getDb()('tenants').where({ slug: 'sem-slug' }).first();
    const certo = await platform(`/tenants/${id.id}`, {
      method: 'DELETE', body: { confirmSlug: 'sem-slug' }
    });
    assert.equal(certo.status, 200, JSON.stringify(certo.body));
  });

  it('recusa apagar o último provedor do deployment', async () => {
    // Sem nenhum, `resolveDefaultTenantId` devolve null e o deployment inteiro
    // passa a responder 503 — inclusive para quem acabou de apagar, que perde a
    // rota para desfazer.
    const restantes = await getDb()('tenants');
    for (const t of restantes.filter((t) => t.id !== alfa)) {
      await getDb()('customer_accounts').where({ tenant_id: t.id }).del();
      await getDb()('vendors').where({ tenant_id: t.id }).del();
      await getDb()('settings').where({ tenant_id: t.id }).del();
      await getDb()('app_state').where({ tenant_id: t.id }).del();
      await getDb()('map_settings').where({ tenant_id: t.id }).del();
      await getDb()('tenant_users').where({ tenant_id: t.id }).del();
      await getDb()('tenants').where({ id: t.id }).del();
    }
    forgetResolvedTenant();
    assert.equal((await getDb()('tenants')).length, 1);

    await platform(`/tenants/${alfa}`, { method: 'PATCH', body: { status: 'suspended' } });
    const { status } = await platform(`/tenants/${alfa}`, {
      method: 'DELETE', body: { confirmSlug: (await getDb()('tenants').where({ id: alfa }).first()).slug }
    });
    assert.equal(status, 409);
    assert.ok(await getDb()('tenants').where({ id: alfa }).first());
    await platform(`/tenants/${alfa}`, { method: 'PATCH', body: { status: 'active' } });
  });
});

describe('a exclusão que acontece', () => {
  let id;
  let contagemEsperada;

  before(async () => {
    id = await provedorComDados('sai-fora', 'Sai Fora');
    contagemEsperada = {
      customer_accounts: (await getDb()('customer_accounts').where({ tenant_id: id })).length,
      vendors: (await getDb()('vendors').where({ tenant_id: id })).length
    };
    assert.ok(contagemEsperada.customer_accounts >= 1, 'o fixture precisa ter o que apagar');
    await suspender(id);
  });

  it('apaga o provedor e tudo o que é dele', async () => {
    const { status, body } = await platform(`/tenants/${id}`, {
      method: 'DELETE', body: { confirmSlug: 'sai-fora' }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.rowCounts.customer_accounts, contagemEsperada.customer_accounts);

    assert.equal(await getDb()('tenants').where({ id }).first(), undefined);
    for (const tabela of ['customer_accounts', 'vendors', 'settings', 'app_state', 'tenant_users']) {
      assert.equal((await getDb()(tabela).where({ tenant_id: id })).length, 0, tabela);
    }
  });

  it('e não encosta em ninguém mais', async () => {
    // O controle: apagar de trás para frente sem o `where` levaria a base
    // inteira, e todos os testes acima continuariam verdes.
    assert.ok((await getDb()('customer_accounts').where({ tenant_id: alfa })).length >= 0);
    assert.ok(await getDb()('tenants').where({ id: alfa }).first(), 'o outro provedor continua de pé');
    const settingsDoAlfa = await getDb()('settings').where({ tenant_id: alfa });
    assert.ok(settingsDoAlfa.length >= 1, 'as configurações do outro provedor continuam lá');
  });

  it('não apaga a PESSOA, só o vínculo dela com aquele provedor', async () => {
    // Uma linha em `users` é uma pessoa, que pode trabalhar para outro
    // provedor — e o nome dela está em histórico que aponta para `users.id`.
    assert.ok(await getDb()('users').where({ username: 'a-plataforma' }).first());
  });
});

describe('a trilha sobrevive ao provedor', () => {
  /**
   * O caso pelo qual `platform_audit` existe como tabela à parte.
   *
   * Registrar a exclusão no `audit_log` do provedor seria inútil: ele é
   * escopado e a trilha vai junto. E uma FK para `tenants` nesta tabela
   * apagaria em cascata — ou impediria — exatamente a linha que existe para
   * dizer que aquele provedor foi apagado.
   */
  it('a linha continua lá, com o slug e o nome de quem já não existe', async () => {
    // Pela linha e não pela contagem: este arquivo apaga dois provedores (o
    // caso do slug exato apaga o `sem-slug`), e uma asserção sobre o total
    // quebraria por um motivo que não tem nada a ver com o que se quer provar.
    const linhas = await getDb()('platform_audit').where({ action: 'tenant.deleted' });
    const linha = linhas.find((l) => l.tenant_slug === 'sai-fora');
    assert.ok(linha, `esperava a linha de sai-fora entre ${linhas.map((l) => l.tenant_slug)}`);
    assert.equal(linha.tenant_name, 'Sai Fora');
    assert.equal(linha.actor_username, 'a-plataforma');
    // E o provedor que ela nomeia realmente não existe mais — sem isto, a
    // asserção acima passaria num mundo onde nada foi apagado.
    assert.equal(await getDb()('tenants').where({ id: linha.tenant_id }).first(), undefined);
    // A contagem do que sumiu fica registrada: é a única prova do tamanho do
    // que foi destruído, depois que não há mais o que contar.
    assert.ok(JSON.parse(linha.detail).rowCounts.customer_accounts >= 1);
  });

  it('a criação e a suspensão também deixam registro', async () => {
    const acoes = (await getDb()('platform_audit')).map((l) => l.action);
    assert.ok(acoes.includes('tenant.created'));
    assert.ok(acoes.includes('tenant.status_changed'));
  });

  it('e a rota devolve a trilha, inclusive as linhas órfãs', async () => {
    const { status, body } = await platform('/audit?limit=50');
    assert.equal(status, 200);
    const apagado = body.data.entries.find((e) => e.action === 'tenant.deleted');
    assert.ok(apagado, 'a exclusão tem que aparecer na listagem');
    // O nome vem da linha e não de um join com `tenants`, que não teria o que
    // juntar.
    assert.equal(apagado.tenant.slug, 'sai-fora');
  });

  it('não há rota para apagar uma linha da trilha da plataforma', async () => {
    const linha = (await getDb()('platform_audit').first());
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      const { status } = await platform(`/audit/${linha.id}`, { method, body: {} });
      assert.equal(status, 404, method);
    }
  });
});

describe('quem pode apagar', () => {
  it('ninguém que não esteja no plano de controle', async () => {
    const id = await provedorComDados('protegida', 'Protegida');
    await suspender(id);

    const bcrypt = (await import('bcryptjs')).default;
    const { default: User } = await import('../src/models/User.js');
    const { default: TenantUser } = await import('../src/models/TenantUser.js');
    const userId = await runInTenant(alfa, () => User.create({
      username: 'admin-comum', password: bcrypt.hashSync('senha-do-comum-1', 10), role: 'owner'
    }));
    await runInTenant(alfa, () => TenantUser.create({ tenantId: alfa, userId, role: 'owner' }));
    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'admin-comum', password: 'senha-do-comum-1' }
    });

    const { status } = await call(`${panelUrl}/api/platform/tenants/${id}`, {
      method: 'DELETE',
      headers: authHeaders(login.body.data.token),
      body: { confirmSlug: 'protegida' }
    });
    // 404 e não 403: o plano de controle não confirma sequer existir para quem
    // não está nele.
    assert.equal(status, 404);
    assert.ok(await getDb()('tenants').where({ id }).first());
  });
});

/**
 * O que a exclusão apagava eram LINHAS, e os anexos do WhatsApp não são linhas.
 *
 * Os bytes moram em `DATA_DIR/wa-media/t<id>/` — fotos e documentos que os
 * assinantes mandaram. A transação percorria as tabelas escopadas e não falava
 * com o disco em ponto nenhum, e o único varredor que alcançaria aqueles
 * arquivos filtra por provedor `active`: depois da exclusão não há mais linha
 * em `tenants` para casar, então nada nunca mais os visitava. Órfão permanente.
 */
describe('a exclusão também leva o disco', () => {
  let id;
  let subtree;

  before(async () => {
    id = await provedorComDados('leva-o-disco', 'Leva o Disco');
    subtree = tenantMediaRoot(id);
    await fs.mkdir(path.join(subtree, '2026-09'), { recursive: true });
    await fs.writeFile(path.join(subtree, '2026-09', 'documento.pdf'), 'o CPF de alguém');
    // O controle precisa existir para poder sobreviver.
    await fs.mkdir(tenantMediaRoot(alfa), { recursive: true });
    await suspender(id);
  });

  it('remove a subárvore de mídia do provedor', async () => {
    assert.ok(await existe(subtree), 'o fixture precisa ter arquivo para apagar');

    const { status, body } = await platform(`/tenants/${id}`, {
      method: 'DELETE', body: { confirmSlug: 'leva-o-disco' }
    });
    assert.equal(status, 200, JSON.stringify(body));

    assert.equal(await existe(subtree), false, 'os anexos do provedor continuaram no disco');
  });

  it('e não encosta na subárvore de outro provedor', async () => {
    // O controle: um `rm` na raiz de `wa-media` levaria tudo, e a asserção
    // acima continuaria verde.
    assert.ok(await existe(tenantMediaRoot(alfa)), 'a mídia do outro provedor sumiu junto');
  });
});
