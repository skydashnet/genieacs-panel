import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O modo túnel: o GenieACS do provedor numa rede privada (VPN, WireGuard,
 * link dedicado), liberada pela plataforma, para aquele provedor e só nele.
 *
 * O que estes casos defendem:
 * - o túnel libera a rede privada DE CLIENTE e nada além: loopback, link-local
 *   (metadados da nuvem) e o `::1` continuam recusados, e a lista de portas
 *   continua valendo;
 * - quem está em `direct` continua recusando endereço privado, inclusive o
 *   provedor vizinho de quem está em túnel;
 * - só o console da plataforma escolhe o modo, e a escolha fica na trilha dos
 *   dois lados.
 */
process.env.EDITION = 'saas';

const {
  asTenant, authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
const { PinnedTransport } = await import('../src/utils/net/pinnedFetch.js');
const { isCustomerPrivateAddress } = await import('../src/utils/net/blockedRanges.js');
const { default: GenieAcsConnection } = await import('../src/models/GenieAcsConnection.js');
const { connectorFor } = await import('../src/services/genieacs/connector.js');
const { default: Setting } = await import('../src/models/Setting.js');

const OWNER = { username: 'plataforma', password: 'plataforma-senha-1', email: 'plataforma@exemplo.test' };
const ACS = 'http://acs.cliente.invalid:7557';

let panelUrl;
let alfa;
let beta;
let token;
let chamadas = [];
const realLookup = GenieAcsEgress.lookup;
const realRequest = PinnedTransport.request;

/** O DNS falso responde `endereco`; o transporte falso responde `[]` e anota para onde ia. */
function responderCom(endereco) {
  GenieAcsEgress.lookup = async () => [{ address: endereco, family: endereco.includes(':') ? 6 : 4 }];
}

const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

/** Uma requisição do painel ao ACS do provedor, pelo conector do modo dele. */
const pedir = (tenantId) => runInTenant(tenantId, async () => (await connectorFor()).request('devices', { unscoped: true }));

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = await defaultTenantId();
  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: OWNER });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  token = setup.body.data.token;
  const userId = setup.body.data.user.id;
  if (!(await getDb()('platform_admins').where({ user_id: userId }).first())) {
    await getDb()('platform_admins').insert({ user_id: userId });
  }
  const criado = await api('/platform/tenants', { method: 'POST', body: { slug: 'beta', name: 'Beta' } });
  assert.equal(criado.status, 201, JSON.stringify(criado.body));
  beta = criado.body.data.tenant.id;
  for (const id of [alfa, beta]) {
    await runInTenant(id, () => Setting.upsert('genieAcsUrl', ACS));
  }
  PinnedTransport.request = async (opcoes) => {
    chamadas.push(opcoes.addresses.map((a) => a.address));
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});

after(async () => {
  GenieAcsEgress.lookup = realLookup;
  PinnedTransport.request = realRequest;
  await stopTestServers();
});

afterEach(async () => {
  chamadas = [];
  GenieAcsEgress.lookup = realLookup;
  for (const id of [alfa, beta]) {
    await runInTenant(id, () => GenieAcsConnection.setMode('direct'));
  }
});

describe('a rede privada de cliente', () => {
  it('é 10/8, 172.16/12, 192.168/16, CGNAT e fc00::/7 — também embutida em IPv6', () => {
    for (const sim of ['10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.10.1', '100.64.0.1', 'fd12:3456::1', '::ffff:10.0.0.1']) {
      assert.equal(isCustomerPrivateAddress(sim), true, sim);
    }
  });

  it('não é loopback, link-local, metadados, 0/8, multicast nem endereço público', () => {
    for (const nao of ['127.0.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', '8.8.8.8', '172.32.0.1', '::ffff:127.0.0.1', 'isto-nao-e-ip']) {
      assert.equal(isCustomerPrivateAddress(nao), false, nao);
    }
  });
});

describe('o provedor em túnel', () => {
  it('chega ao GenieACS no endereço privado', async () => {
    await runInTenant(alfa, () => GenieAcsConnection.setMode('tunnel'));
    responderCom('10.1.2.3');
    const resposta = await pedir(alfa);
    assert.equal(resposta.status, 200);
    assert.deepEqual(chamadas, [['10.1.2.3']]);
  });

  it('continua recusando loopback, metadados da nuvem e ::1', async () => {
    await runInTenant(alfa, () => GenieAcsConnection.setMode('tunnel'));
    for (const proibido of ['127.0.0.1', '169.254.169.254', '::1']) {
      responderCom(proibido);
      await assert.rejects(pedir(alfa), /cannot be reached/, proibido);
    }
    assert.deepEqual(chamadas, [], 'o túnel abriu socket para o próprio servidor do painel');
  });

  it('continua obedecendo a lista de portas', async () => {
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', 'http://acs.cliente.invalid:9999'));
    await runInTenant(alfa, () => GenieAcsConnection.setMode('tunnel'));
    responderCom('10.1.2.3');
    await assert.rejects(pedir(alfa), /port 9999 is not allowed/);
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', ACS));
  });
});

describe('quem está em direct', () => {
  it('continua recusando endereço privado — inclusive o vizinho de quem está em túnel', async () => {
    await runInTenant(alfa, () => GenieAcsConnection.setMode('tunnel'));
    responderCom('10.1.2.3');
    await assert.rejects(pedir(beta), /private network/);
    assert.deepEqual(chamadas, []);
    assert.equal((await asTenantMode(beta)), 'direct');
  });
});

async function asTenantMode(id) {
  return runInTenant(id, () => GenieAcsConnection.mode());
}

describe('quem escolhe o modo', () => {
  it('é o console, que grava no provedor certo e deixa a trilha dos dois lados', async () => {
    const { status, body } = await api(`/platform/tenants/${alfa}/genieacs`, { method: 'PUT', body: { mode: 'tunnel' } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.mode, 'tunnel');
    assert.equal(await asTenantMode(alfa), 'tunnel');
    assert.equal(await asTenantMode(beta), 'direct');

    const lido = await api(`/platform/tenants/${alfa}/genieacs`);
    assert.equal(lido.body.data.mode, 'tunnel');

    const doProvedor = await getDb()('audit_log').where({ tenant_id: alfa, action: 'genieacs.connection_changed' });
    assert.equal(doProvedor.length, 1);
    assert.equal(doProvedor[0].actor_kind, 'platform');
    assert.deepEqual(JSON.parse(doProvedor[0].detail), { from: 'direct', to: 'tunnel' });
  });

  it('recusa modo que não existe', async () => {
    const { status } = await api(`/platform/tenants/${alfa}/genieacs`, { method: 'PUT', body: { mode: 'qualquer' } });
    assert.equal(status, 400);
    assert.equal(await asTenantMode(alfa), 'direct');
  });

  it('o teste de conexão só usa o túnel no endereço já salvo', async () => {
    await runInTenant(alfa, () => GenieAcsConnection.setMode('tunnel'));
    responderCom('10.9.9.9');
    const salvo = await api(`/platform/tenants/${alfa}/genieacs/test`, { method: 'POST', body: {} });
    assert.equal(salvo.status, 200, JSON.stringify(salvo.body));
    const outro = await api(`/platform/tenants/${alfa}/genieacs/test`, {
      method: 'POST', body: { url: 'http://outra-rede.invalid:7557' }
    });
    assert.notEqual(outro.status, 200, 'o botão de teste virou uma sonda da rede privada do painel');
    assert.deepEqual(chamadas, [['10.9.9.9']]);
  });
});

describe('a leitura do modo', () => {
  it('sem linha na tabela é direct, e o conector é o direto', async () => {
    await getDb()('tenant_genieacs_connections').where({ tenant_id: beta }).del();
    GenieAcsConnection.clearCache();
    assert.equal(await asTenantMode(beta), 'direct');
    assert.equal((await runInTenant(beta, () => connectorFor())).mode, 'direct');
    assert.equal(await asTenant(() => GenieAcsConnection.mode()), 'direct');
  });
});
