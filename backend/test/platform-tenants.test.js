import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The provider registry: the first thing in twelve waves that can mint a second
 * provider.
 *
 * What has to be proved here is not that three routes answer. It is that a
 * provider created through the API is INDISTINGUISHABLE from one created at
 * boot — same settings, same equipment catalogue — because the way this fails
 * is silent. An unseeded provider comes up with no GenieACS address and with
 * equipment detection that matches nothing at all; nothing throws, nothing logs,
 * the panel merely looks wrong to the ISP that was just handed it. So the
 * assertions below are on rows in the scoped tables, not on the response body.
 *
 * The SaaS edition has to be chosen before app.js is imported, because the
 * route table is built at module load and these routes are mounted under
 * `IS_SAAS`. Static imports are hoisted above every statement in the file, so
 * the harness is pulled in dynamically for the assignment below to be visible
 * to it. `node --test` gives each file its own process, so the choice does not
 * leak into the other suites — which is also why the self-hosted half of the
 * contract is proved in a child process at the bottom of this file.
 */
process.env.EDITION = 'saas';

const {
  authHeaders,
  call,
  defaultTenantId,
  getDb,
  insertReturningId,
  startTestServers,
  stopTestServers
} = await import('./helpers/harness.js');

const { DEFAULT_SETTINGS } = await import('../src/config/seed.js');
const { default: Tenant } = await import('../src/models/Tenant.js');
const { forEachTenant } = await import('../src/config/tenantJobs.js');

const run = promisify(execFile);

const OWNER = { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' };
// An administrator at the installation's own provider and nothing more. The
// point of the control plane is that this is not enough.
const COMUM = { username: 'comum', password: 'comum-senha-1', email: 'comum@exemplo.test' };

// One vendor, one security mapping, one product-class config: the smallest
// catalogue that still proves the copy remaps the foreign key.
const VENDOR = {
  name: 'Fabricante Teste',
  manufacturer_patterns: JSON.stringify(['teste']),
  product_patterns: JSON.stringify(['ONU-T1']),
  parameter_prefix: 'InternetGatewayDevice',
  wifi_password_path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
  priority: 5,
  enabled: true
};

let panelUrl;
let alfa;
let ownerToken;
let ownerId;
let comumToken;

const platform = (path, options = {}) => call(`${panelUrl}/api/platform${path}`, {
  ...options,
  headers: { ...authHeaders(ownerToken), ...(options.headers || {}) }
});

const createTenant = (body) => platform('/tenants', { method: 'POST', body });

/** Which providers a background job walks — the real reader of `status`. */
const visitedByJobs = () => forEachTenant((tenant) => tenant.slug);

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: OWNER
  });
  assert.equal(setup.status, 201, 'could not create the first administrator');
  ownerToken = setup.body.data.token;
  ownerId = setup.body.data.user.id;

  // `platform_admins` is written straight to the table: it is created empty by
  // 0029 and the route that grants the role belongs to another lane. What is
  // under test here is what the registry does for somebody on the roster, not
  // how they got onto it. Guarded so this still works once the SaaS setup path
  // puts the first administrator there itself.
  if (!(await getDb()('platform_admins').where({ user_id: ownerId }).first())) {
    await getDb()('platform_admins').insert({ user_id: ownerId });
  }

  const hire = await call(`${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(ownerToken),
    body: { ...COMUM, role: 'admin' }
  });
  assert.equal(hire.status, 201, 'could not create the ordinary administrator');
  const signIn = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: COMUM });
  assert.equal(signIn.status, 200, 'the ordinary administrator could not sign in');
  comumToken = signIn.body.data.token;

  // The installation's own provider is given a catalogue, because on a fresh
  // install nobody has one: `vendors` is built by the operator through
  // `/api/vendor-management`, so with the table empty everywhere the copy would
  // have nothing to copy and would pass this suite by doing nothing at all.
  //
  // Na edição hospedada, que é a deste arquivo, só a caixa da plataforma é
  // fonte: o catálogo de um provedor (`alfa`) nunca é copiado para outro. Por
  // isso a caixa nasce aqui com o mesmo catálogo, e o de `alfa` fica para
  // provar que a cópia não é uma segunda leitura das linhas de ninguém.
  const caixa = await Tenant.create({ slug: 'plataforma', name: 'Plataforma', kind: 'platform' });
  for (const tenantId of [alfa, caixa]) {
    await insertReturningId('vendors', { ...VENDOR, tenant_id: tenantId });
    await getDb()('wifi_security_config').insert({
      tenant_id: tenantId,
      product_class: 'ONU-T1',
      security_types: 'WPA2',
      password_param_path: VENDOR.wifi_password_path
    });
  }
});

after(async () => {
  await stopTestServers();
});

describe('creating a provider', () => {
  let novaId;

  it('creates it and lists it with nobody working there yet', async () => {
    const { status, body } = await createTenant({ slug: 'novaisp', name: 'Nova ISP' });
    assert.equal(status, 201);
    assert.equal(body.data.tenant.slug, 'novaisp');
    assert.equal(body.data.tenant.name, 'Nova ISP');
    assert.equal(body.data.tenant.status, 'active');
    assert.equal(body.data.tenant.operators, 0);
    novaId = body.data.tenant.id;

    const list = await platform('/tenants');
    assert.equal(list.status, 200);
    const bySlug = new Map(list.body.data.tenants.map((t) => [t.slug, t]));
    assert.equal(bySlug.get('novaisp').operators, 0,
      'a brand new provider cannot already have staff');
    // The installation's own provider has exactly the two people created above,
    // which is what proves `operators` counts memberships per provider rather
    // than everybody on the deployment.
    assert.equal(bySlug.get((await getDb()('tenants').where({ id: alfa }).first()).slug).operators, 2);
  });

  // The requirement most likely to be missed, and the one that fails silently
  // in production: a provider with no settings row has no GenieACS address and
  // no VirtualParameter mapping.
  it('gives it every default setting, and its own map centre', async () => {
    const settings = await getDb()('settings').where({ tenant_id: novaId });
    const values = new Map(settings.map((row) => [row.key, row.value]));
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      assert.equal(values.get(key), value, `the new provider is missing "${key}"`);
    }

    const map = await getDb()('map_settings').where({ tenant_id: novaId, id: 1 }).first();
    assert.ok(map, 'the new provider has no map centre of its own');
    assert.equal(String(map.default_zoom), '13');
  });

  // Wave 11's rule, applied to a provider that did not exist at boot: an empty
  // catalogue means detection matches no vendor and the WiFi write falls back
  // to guessing a parameter path. Nothing fails; the panel just never works.
  it('gives it a copy of the equipment catalogue', async () => {
    const vendors = await getDb()('vendors').where({ tenant_id: novaId });
    assert.equal(vendors.length, 1, 'the new provider has no equipment catalogue');
    assert.equal(vendors[0].name, VENDOR.name);
    assert.equal(vendors[0].wifi_password_path, VENDOR.wifi_password_path);

    // A cópia é do provedor NOVO, e não uma segunda leitura das linhas do
    // antigo: ids diferentes para o mesmo fabricante.
    const source = await getDb()('vendors').where({ tenant_id: alfa }).first();
    assert.notEqual(Number(vendors[0].id), Number(source.id));

    const configs = await getDb()('wifi_security_config').where({ tenant_id: novaId });
    assert.equal(configs.length, 1);
    assert.equal(configs[0].product_class, 'ONU-T1');
  });

  it('refuses a slug that is already taken', async () => {
    const { status } = await createTenant({ slug: 'novaisp', name: 'Outra ISP' });
    assert.equal(status, 409);
    assert.equal((await getDb()('tenants').where({ slug: 'novaisp' })).length, 1);
  });

  // The slug is the subdomain the panel will be reached at, so each of these is
  // a hostname that does not resolve, or resolves somewhere else entirely.
  it('refuses a slug that is not a hostname, rather than fixing it quietly', async () => {
    const refused = [
      ['', 'empty'],
      ['ab', 'shorter than three characters'],
      ['a'.repeat(64), 'longer than a DNS label'],
      ['Nova', 'uppercase'],
      ['nova isp', 'a space'],
      ['nova_isp', 'an underscore'],
      ['-novaisp', 'a leading hyphen'],
      ['novaisp-', 'a trailing hyphen'],
      ['no--vaisp', 'the reserved punycode position'],
      ['www', 'a label the deployment already answers to'],
      ['nova.isp', 'a dot, which is a second label']
    ];
    const before = (await getDb()('tenants')).length;
    for (const [slug, why] of refused) {
      const { status } = await createTenant({ slug, name: 'Nova ISP' });
      assert.equal(status, 400, `${JSON.stringify(slug)} (${why}) should be refused`);
    }
    assert.equal((await getDb()('tenants')).length, before,
      'a refused slug still created a provider');
  });

  it('refuses a provider with no name', async () => {
    const { status } = await createTenant({ slug: 'semnome', name: '   ' });
    assert.equal(status, 400);
  });
});

describe('suspending and reactivating', () => {
  let outraId;

  before(async () => {
    const { status, body } = await createTenant({ slug: 'outraisp', name: 'Outra ISP' });
    assert.equal(status, 201);
    outraId = body.data.tenant.id;
  });

  it('stops the background jobs visiting a suspended provider', async () => {
    assert.ok((await visitedByJobs()).includes('outraisp'),
      'an active provider is not being visited in the first place');

    const { status, body } = await platform(`/tenants/${outraId}`, {
      method: 'PATCH',
      body: { status: 'suspended' }
    });
    assert.equal(status, 200);
    assert.equal(body.data.tenant.status, 'suspended');

    const visited = await visitedByJobs();
    assert.ok(!visited.includes('outraisp'), 'a suspended provider is still being visited');
    assert.ok(visited.includes('novaisp'), 'suspending one provider stopped another');
  });

  it('brings it back', async () => {
    const { status, body } = await platform(`/tenants/${outraId}`, {
      method: 'PATCH',
      body: { status: 'active' }
    });
    assert.equal(status, 200);
    assert.equal(body.data.tenant.status, 'active');
    assert.ok((await visitedByJobs()).includes('outraisp'),
      'a reactivated provider is not being visited again');
  });

  it('refuses a status that is not one of the two', async () => {
    for (const status of ['deleted', 'ACTIVE', '', null, 42]) {
      const response = await platform(`/tenants/${outraId}`, { method: 'PATCH', body: { status } });
      assert.equal(response.status, 400, `${JSON.stringify(status)} should be refused`);
    }
    const row = await getDb()('tenants').where({ id: outraId }).first();
    assert.equal(row.status, 'active');
  });

  it('answers 404 for a provider that does not exist', async () => {
    const { status } = await platform('/tenants/999999', {
      method: 'PATCH',
      body: { status: 'suspended' }
    });
    assert.equal(status, 404);
  });

  /**
   * Desde quando.
   *
   * `tenants` tinha só `created_at` e `updated_at`, e o segundo é sobrescrito
   * por qualquer renomeação ou edição de cadastro — então ninguém respondia
   * "há quanto tempo este provedor está parado?". Com dois estados só, sem
   * prazo de suspensão e sem exclusão automática, a diferença entre uma semana
   * e dois anos guardando CPF, contrato e a conversa dos assinantes não
   * aparecia em lugar nenhum.
   */
  describe('desde quando está suspenso', () => {
    const linha = () => getDb()('tenants').where({ id: outraId }).first();

    const mudar = (status) => platform(`/tenants/${outraId}`, {
      method: 'PATCH', body: { status }
    });

    it('grava a data ao suspender e a devolve ao console', async () => {
      const { body } = await mudar('suspended');
      assert.ok(body.data.tenant.suspendedAt, 'o console não recebeu a data');
      assert.ok((await linha()).suspended_at, 'a coluna ficou vazia');
    });

    it('e NÃO reinicia o relógio quando a suspensão é reafirmada', async () => {
      // O caso que o COALESCE existe para atender. Sem ele o defeito é
      // invisível: a tela só mostra um número menor, e um número menor não
      // parece errado.
      const antes = (await linha()).suspended_at;
      await new Promise((resolve) => { setTimeout(resolve, 1100); });

      await mudar('suspended');

      const depois = (await linha()).suspended_at;
      assert.equal(
        new Date(depois).getTime(), new Date(antes).getTime(),
        'clicar duas vezes em suspender rejuvenesceu o provedor'
      );
    });

    it('reativar zera, e a suspensão seguinte conta do zero', async () => {
      await mudar('active');
      assert.equal((await linha()).suspended_at, null, 'a data sobreviveu à reativação');

      await mudar('suspended');
      assert.ok((await linha()).suspended_at, 'a suspensão seguinte não começou a contar');
      await mudar('active');
    });
  });

  /**
   * Apagar existe desde a onda 22, e o que este caso fixa é que ele não
   * acontece por acidente: um provedor ATIVO não sai, por mais autorizado que
   * seja quem pede. Suspender primeiro é o que faz da exclusão dois passos com
   * um estado reversível no meio — que era a objeção inteira à versão anterior
   * deste teste, quando o DELETE não existia.
   *
   * As outras três condições — slug digitado de volta, não ser o último
   * provedor, e a trilha gravada antes — estão em `platform-tenant-delete`.
   */
  it('não apaga um provedor que está ativo', async () => {
    const { status } = await platform(`/tenants/${outraId}`, {
      method: 'DELETE',
      body: { confirmSlug: 'outra' }
    });
    assert.equal(status, 409);
    assert.ok(await getDb()('tenants').where({ id: outraId }).first());
  });
});

/**
 * Corrigir o cadastro de um provedor que já existe.
 *
 * Duas metades com pesos diferentes. O nome é texto: corrige-se e pronto. O
 * slug é o SUBDOMÍNIO — trocá-lo muda o endereço em que o painel daquele ISP
 * responde, e é aí que estão as três coisas que só se provam aqui: que o
 * endereço antigo para de resolver na hora (o resolvedor guarda slug -> id pela
 * vida do processo, então esquecer a invalidação deixaria o painel servindo em
 * dois endereços), que o slug de outro provedor é recusado enquanto o PRÓPRIO
 * slug reenviado não é, e que as duas trilhas ficam escritas — a nossa e a DELE,
 * porque quem pergunta "por que o nosso endereço mudou" é o ISP e ele não lê a
 * nossa.
 */
describe('editando os dados de um provedor', () => {
  let editavelId;
  let resolveTenantIdBySlug;
  let forgetResolvedTenant;

  const editar = (id, body) => platform(`/tenants/${id}`, { method: 'PATCH', body });
  const linha = (id) => getDb()('tenants').where({ id }).first();
  const trilhaDaPlataforma = (action) => getDb()('platform_audit').where({ action }).orderBy('id', 'desc');
  const trilhaDoProvedor = (id, action) => getDb()('audit_log')
    .where({ tenant_id: id, action })
    .orderBy('id', 'desc');

  before(async () => {
    ({ resolveTenantIdBySlug, forgetResolvedTenant } = await import(
      '../src/middleware/tenantResolver.js'
    ));
    const { status, body } = await createTenant({ slug: 'editavel', name: 'Editável ISP' });
    assert.equal(status, 201);
    editavelId = body.data.tenant.id;
  });

  it('corrige o nome sem tocar no endereço', async () => {
    const { status, body } = await editar(editavelId, { name: '  Editável Telecom  ' });
    assert.equal(status, 200);
    assert.equal(body.data.tenant.name, 'Editável Telecom', 'o nome não voltou aparado');
    assert.equal(body.data.tenant.slug, 'editavel');

    const row = await linha(editavelId);
    assert.equal(row.name, 'Editável Telecom');
    assert.equal(row.slug, 'editavel', 'um salvamento de nome mexeu no subdomínio');

    const [nossa] = await trilhaDaPlataforma('tenant.identity_changed');
    assert.ok(nossa, 'a correção do nome não deixou linha na trilha da plataforma');
    const detalhe = JSON.parse(nossa.detail);
    assert.deepEqual(detalhe, { name: { from: 'Editável ISP', to: 'Editável Telecom' } },
      'o detalhe tem que trazer só o campo que mudou');
    assert.equal(nossa.tenant_slug, 'editavel');

    const [dele] = await trilhaDoProvedor(editavelId, 'tenant.renamed');
    assert.ok(dele, 'a correção não apareceu na trilha do próprio provedor');
    assert.equal(dele.actor_kind, 'platform', 'a mão veio de fora e a trilha dele não diz isso');
    assert.deepEqual(JSON.parse(dele.detail), { from: 'Editável ISP', to: 'Editável Telecom' });
  });

  /**
   * O caso que paga a fatia. Sem `forgetResolvedTenant()` o endereço ANTIGO
   * continua resolvendo para este provedor até o próximo restart — o painel
   * servindo em dois endereços, um deles livre para ser dado a outro ISP.
   */
  it('troca o endereço, e o antigo para de resolver na hora', async () => {
    forgetResolvedTenant();
    assert.equal(await resolveTenantIdBySlug('editavel'), editavelId,
      'o endereço de partida não resolvia nem antes da troca');

    const { status, body } = await editar(editavelId, { slug: 'editada' });
    assert.equal(status, 200);
    assert.equal(body.data.tenant.slug, 'editada');
    assert.equal((await linha(editavelId)).slug, 'editada');

    assert.equal(await resolveTenantIdBySlug('editavel'), null,
      'o endereço antigo continua resolvendo: o cache do resolvedor não foi esvaziado');
    assert.equal(await resolveTenantIdBySlug('editada'), editavelId,
      'o endereço novo não resolve');

    const [nossa] = await trilhaDaPlataforma('tenant.identity_changed');
    assert.deepEqual(JSON.parse(nossa.detail), { slug: { from: 'editavel', to: 'editada' } });
    // O retrato vai com a linha antiga: a pergunta é "o que foi feito com o
    // provedor que eu conhecia como `editavel`".
    assert.equal(nossa.tenant_slug, 'editavel');

    const [dele] = await trilhaDoProvedor(editavelId, 'tenant.slug_changed');
    assert.ok(dele, 'o ISP não tem na trilha dele por que o endereço mudou');
    assert.equal(dele.actor_kind, 'platform');
    assert.deepEqual(JSON.parse(dele.detail), { from: 'editavel', to: 'editada' });
  });

  it('recusa o endereço que outro provedor já tem', async () => {
    const { status } = await editar(editavelId, { slug: 'novaisp' });
    assert.equal(status, 409);
    assert.equal((await linha(editavelId)).slug, 'editada', 'a recusa ainda mexeu na linha');
  });

  /**
   * O contrário do de cima, e é o que a exclusão pelo id em `findBySlug` existe
   * para permitir: a tela manda o slug atual de volta junto do nome novo, e isso
   * não é conflito com ninguém — é o próprio provedor.
   */
  it('aceita o próprio endereço reenviado junto de um nome novo', async () => {
    const { status, body } = await editar(editavelId, { slug: 'editada', name: 'Editada ISP' });
    assert.equal(status, 200);
    assert.equal(body.data.tenant.name, 'Editada ISP');
    assert.equal(body.data.tenant.slug, 'editada');
  });

  it('não grava nada quando nada mudou', async () => {
    const antes = (await trilhaDaPlataforma('tenant.identity_changed')).length;
    const { status } = await editar(editavelId, { name: 'Editada ISP', slug: 'editada' });
    assert.equal(status, 200);
    assert.equal((await trilhaDaPlataforma('tenant.identity_changed')).length, antes,
      'um salvamento que não mudou nada deixou linha de trilha');
  });

  // A mesma tabela da criação: o slug é um hostname, e cada um destes é um
  // endereço que não resolve ou que resolve em outro lugar.
  it('recusa um endereço que não é um hostname, em vez de consertá-lo em silêncio', async () => {
    const refused = [
      ['', 'vazio'],
      ['ab', 'menor que três caracteres'],
      ['a'.repeat(64), 'maior que um label de DNS'],
      ['Editada', 'maiúscula'],
      ['editada isp', 'um espaço'],
      ['editada_isp', 'um sublinhado'],
      ['-editada', 'hífen à frente'],
      ['editada-', 'hífen no fim'],
      ['ed--itada', 'a posição reservada do punycode'],
      ['www', 'um label a que o deployment já responde'],
      ['editada.isp', 'um ponto, que é um segundo label']
    ];
    for (const [slug, porque] of refused) {
      const { status } = await editar(editavelId, { slug });
      assert.equal(status, 400, `${JSON.stringify(slug)} (${porque}) tinha que ser recusado`);
    }
    assert.equal((await linha(editavelId)).slug, 'editada');
  });

  it('recusa um nome vazio ou maior que o campo', async () => {
    for (const name of ['   ', 'x'.repeat(129)]) {
      const { status } = await editar(editavelId, { name });
      assert.equal(status, 400, `${JSON.stringify(name.slice(0, 12))} tinha que ser recusado`);
    }
    assert.equal((await linha(editavelId)).name, 'Editada ISP');
  });

  /**
   * As duas intenções do PATCH não andam juntas: elas gravam trilhas
   * diferentes, só uma invalida o cache do resolvedor e só uma muda o endereço
   * que o ISP já recebeu, então a linha da trilha ficaria ambígua.
   */
  it('recusa o estado e o cadastro no mesmo corpo', async () => {
    const { status } = await editar(editavelId, { status: 'suspended', name: 'Nem Isto' });
    assert.equal(status, 400);
    const row = await linha(editavelId);
    assert.equal(row.status, 'active', 'o estado mudou num pedido recusado');
    assert.equal(row.name, 'Editada ISP', 'o nome mudou num pedido recusado');
  });

  it('responde 404 para um provedor que não existe', async () => {
    const { status } = await editar(999999, { name: 'Fantasma' });
    assert.equal(status, 404);
  });
});

describe('ligando um provedor ao gateway de pagamento', () => {
  /**
   * A correlação que o webhook de cobrança lê para saber de quem é o dinheiro.
   *
   * No console e não na tela do provedor, ao contrário do cadastro fiscal —
   * e é a diferença que este bloco existe para fixar. O fiscal é dado que o
   * cliente mantém; isto decide para quem vai o crédito de um pagamento.
   */
  let alvo;

  before(async () => {
    const criado = await createTenant({ slug: 'paga-sozinho', name: 'Provedor Que Paga' });
    assert.equal(criado.status, 201);
    alvo = criado.body.data.tenant.id;
  });

  const ligar = (gateway) => platform(`/tenants/${alvo}`, { method: 'PATCH', body: { gateway } });

  it('grava o gateway e o id do cliente, e o console passa a mostrá-los', async () => {
    const res = await ligar({ gateway: 'asaas', customerRef: 'cus_000123' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.gateway, { gateway: 'asaas', customerRef: 'cus_000123' });

    const lista = await platform('/tenants');
    const linha = lista.body.data.tenants.find((t) => t.id === alvo);
    assert.deepEqual(linha.gateway, { gateway: 'asaas', customerRef: 'cus_000123' });
  });

  it('e deixa na trilha da plataforma o gateway, mas nunca o id do cliente', async () => {
    const linha = await getDb()('platform_audit')
      .where({ action: 'tenant.gateway_changed' }).orderBy('id', 'desc').first();
    assert.ok(linha, 'ligar um cliente ao gateway tem que deixar registro');
    assert.equal(String(linha.tenant_id), String(alvo));
    // A chave que decide para quem vai o crédito não entra numa trilha que é
    // lida por mais gente do que o console.
    assert.equal(JSON.stringify(linha).includes('cus_000123'), false);
    assert.equal(JSON.parse(linha.detail).gateway, 'asaas');
    assert.equal(JSON.parse(linha.detail).linked, true);
  });

  /**
   * Meia correlação não resolve provedor nenhum: o webhook procura os dois
   * juntos. Recusar aqui é mais barato do que um pagamento que cai em log.
   */
  it('recusa metade da correlação, dos dois lados', async () => {
    const semRef = await platform(`/tenants/${alvo}`, {
      method: 'PATCH', body: { gateway: { customerRef: '' } }
    });
    assert.equal(semRef.status, 400);
    const semGateway = await platform(`/tenants/${alvo}`, {
      method: 'PATCH', body: { gateway: { gateway: '' } }
    });
    assert.equal(semGateway.status, 400);
  });

  it('e desliga quando os dois são limpos juntos', async () => {
    const res = await ligar({ gateway: '', customerRef: '' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.gateway, { gateway: null, customerRef: null });
  });

  /**
   * O ponto de tudo isto: um provedor que pudesse escrever o próprio
   * `billing_customer_ref` poderia apontá-lo para o cliente de gateway de
   * outro e receber o crédito do pagamento alheio. A rota pela qual ele edita
   * o cadastro fiscal existe e é dele — e não pode alcançar estas duas colunas.
   */
  it('e o próprio provedor não alcança essas colunas pela rota de cadastro fiscal', async () => {
    const antes = await getDb()('tenants').where({ id: alfa }).first();
    const res = await call(`${panelUrl}/api/tenant`, {
      method: 'PATCH',
      headers: authHeaders(ownerToken),
      body: {
        billing: {
          legalName: 'Provedor Alfa LTDA',
          gateway: 'asaas',
          customerRef: 'cus_do_vizinho',
          billing_gateway: 'asaas',
          billing_customer_ref: 'cus_do_vizinho'
        }
      }
    });
    assert.equal(res.status, 200, 'o cadastro fiscal em si continua sendo dele');
    const depois = await getDb()('tenants').where({ id: alfa }).first();
    assert.equal(depois.billing_legal_name, 'Provedor Alfa LTDA');
    assert.equal(depois.billing_gateway, antes.billing_gateway ?? null);
    assert.equal(depois.billing_customer_ref, antes.billing_customer_ref ?? null);
  });

  /**
   * A prova direta, e ela existe porque a de cima não basta.
   *
   * A rota de cadastro fiscal tem DOIS cadeados: a lista de campos escrita à
   * mão no controlador (`CAMPOS_FATURAMENTO`) e `Tenant.BILLING_COLUMNS` no
   * modelo. Pôr as colunas do gateway em `BILLING_COLUMNS` não faz o teste de
   * rota acima falhar — o cadeado do controlador segura sozinho —, e um teste
   * que não vê essa mudança deixaria a segunda porta encostada para quem
   * mexesse no controlador depois. Aqui a afirmação é sobre as listas.
   */
  it('e nenhuma delas está na lista que a rota do provedor pode escrever', () => {
    for (const coluna of Tenant.GATEWAY_COLUMNS) {
      assert.equal(Tenant.BILLING_COLUMNS.includes(coluna), false,
        `${coluna} virou campo do cadastro fiscal: o provedor passa a escrever de quem é o dinheiro`);
      assert.equal(Tenant.PUBLIC_COLUMNS.includes(coluna), false, coluna);
    }
  });
});

describe('who may reach the registry', () => {
  it('refuses somebody who is merely an administrator at their own provider', async () => {
    const before = (await getDb()('tenants')).length;
    for (const [method, path, body] of [
      ['GET', '/api/platform/tenants', undefined],
      ['POST', '/api/platform/tenants', { slug: 'invasora', name: 'Invasora' }],
      ['PATCH', `/api/platform/tenants/${alfa}`, { status: 'suspended' }],
      ['PATCH', `/api/platform/tenants/${alfa}`, { name: 'Invasora', slug: 'invasora' }]
    ]) {
      const { status } = await call(`${panelUrl}${path}`, {
        method,
        headers: authHeaders(comumToken),
        body
      });
      // Which refusal is lane A's to decide; that it IS one is lane B's.
      assert.ok(status >= 400 && status < 500,
        `${method} ${path} answered ${status} to a provider's own administrator`);
    }
    assert.equal((await getDb()('tenants')).length, before);
    const alfaRow = await getDb()('tenants').where({ id: alfa }).first();
    assert.equal(alfaRow.status, 'active', 'an ordinary administrator suspended a provider');
    assert.notEqual(alfaRow.name, 'Invasora', 'an ordinary administrator renamed a provider');
    assert.notEqual(alfaRow.slug, 'invasora', 'an ordinary administrator re-addressed a provider');
  });

  it('refuses a caller with no session at all', async () => {
    const { status } = await call(`${panelUrl}/api/platform/tenants`);
    assert.equal(status, 401);
  });
});

/**
 * The other half of the contract, and it cannot be asserted in this process:
 * the edition is read when `app.js` is imported, and this file has already
 * imported it as `saas`. So a child process boots the whole application as a
 * self-hosted install and reports what the routes answer.
 *
 * The claim is precise. On a self-hosted install these routes do not merely
 * refuse — they are NOT MOUNTED, so they answer 404 like any other unknown
 * path. A 403 would tell whoever asked that a control plane is there to find,
 * which on an install that has exactly one provider is information about the
 * product rather than about them.
 */
const SELF_HOSTED_PROBE = `
const harness = await import(process.env.LANE_B_HARNESS);
const { panelUrl } = await harness.startTestServers();
const answers = [];
for (const [method, path, body] of [
  ['GET', '/api/platform/tenants', undefined],
  ['POST', '/api/platform/tenants', { slug: 'novaisp', name: 'Nova ISP' }],
  ['PATCH', '/api/platform/tenants/1', { status: 'suspended' }],
  ['GET', '/api/settings', undefined]
]) {
  const { status } = await harness.call(panelUrl + path, { method, body });
  answers.push([method + ' ' + path, status]);
}
console.log('LANE_B_RESULT ' + JSON.stringify(answers));
await harness.stopTestServers();
`;

describe('a self-hosted install', () => {
  it('does not mount the platform routes at all', async () => {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', SELF_HOSTED_PROBE], {
      env: {
        ...process.env,
        EDITION: 'selfhosted',
        LANE_B_HARNESS: new URL('./helpers/harness.js', import.meta.url).href
      },
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024
    });
    const line = stdout.split('\n').find((l) => l.startsWith('LANE_B_RESULT '));
    assert.ok(line, `the self-hosted probe printed no result:\n${stdout}`);
    const answers = new Map(JSON.parse(line.slice('LANE_B_RESULT '.length)));

    for (const route of [
      'GET /api/platform/tenants',
      'POST /api/platform/tenants',
      'PATCH /api/platform/tenants/1'
    ]) {
      assert.equal(answers.get(route), 404, `${route} should not be routed at all`);
    }
    // A 401 here rather than a 404 is what proves the 404s above come from the
    // edition gate and not from the whole API being unreachable in the child.
    assert.equal(answers.get('GET /api/settings'), 401);
  });
});
