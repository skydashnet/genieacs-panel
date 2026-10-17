import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O modo `agent` na SaaS: quem escolhe o modo é quem administra o GenieACS — a
 * plataforma, pelo console, e a tela do provedor só lê; ou o próprio provedor,
 * quando o console marcou o servidor como dele (`ownership = 'own'`). A CHAVE o
 * provedor gera nos dois casos (é ele quem instala o agente na rede dele),
 * quando o modo já é `agent`.
 *
 * Arquivo à parte de `genieacs-agent.test.js` porque a edição é lida na carga:
 * um processo é SaaS ou self-hosted, nunca os dois.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: GenieAcsConnection } = await import('../src/models/GenieAcsConnection.js');
const { runUnscoped } = await import('../src/config/tenantContext.js');
const { agentHub, AGENT_CONNECT_PATH } = await import('../src/services/genieacs/agentHub.js');

const OWNER = { username: 'plataforma', password: 'plataforma-senha-1', email: 'plataforma@exemplo.test' };

let panelUrl;
let alfa;
let beta;
let token;
const chaves = [];

const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

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
});

after(async () => {
  await stopTestServers();
});

describe('a tela do provedor, na SaaS', () => {
  it('lê o modo, mas diz que não é editável', async () => {
    const { status, body } = await api('/settings/genieacs-connection');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.mode, 'direct');
    assert.equal(body.data.modeEditable, false);
    assert.equal(body.data.agent.connected, false);
  });

  it('e trocar o modo é 403 platform_managed — inclusive para agent', async () => {
    for (const mode of ['agent', 'direct', 'tunnel']) {
      const { status, body } = await api('/settings/genieacs-connection', { method: 'PUT', body: { mode } });
      assert.equal(status, 403, mode);
      assert.equal(body.code, 'platform_managed');
    }
    assert.equal(await runInTenant(alfa, () => GenieAcsConnection.mode()), 'direct');
  });

  it('gerar a chave antes de a plataforma ligar o modo agent é 409', async () => {
    const { status, body } = await api('/settings/genieacs-connection/agent-token', { method: 'POST' });
    assert.equal(status, 409);
    assert.equal(body.code, 'mode_not_agent');
  });

  it('com o modo ligado pela plataforma, o provedor gera a chave', async () => {
    const ligado = await api(`/platform/tenants/${alfa}/genieacs`, { method: 'PUT', body: { mode: 'agent' } });
    assert.equal(ligado.status, 200, JSON.stringify(ligado.body));
    const { status, body } = await api('/settings/genieacs-connection/agent-token', { method: 'POST' });
    assert.equal(status, 201, JSON.stringify(body));
    chaves.push(body.data.token);
    assert.match(body.data.token, /^sgpa_[A-Za-z0-9_-]{43}$/);
  });

  it('com o servidor próprio (ownership own), o provedor escolhe entre direto e agente — túnel, não', async () => {
    const dono = await api(`/platform/tenants/${alfa}/genieacs`, { method: 'PUT', body: { ownership: 'own' } });
    assert.equal(dono.status, 200, JSON.stringify(dono.body));
    try {
      const lido = await api('/settings/genieacs-connection');
      assert.equal(lido.body.data.modeEditable, true);

      const direto = await api('/settings/genieacs-connection', { method: 'PUT', body: { mode: 'direct' } });
      assert.equal(direto.status, 200, JSON.stringify(direto.body));
      assert.equal(await runInTenant(alfa, () => GenieAcsConnection.mode()), 'direct');

      const tunel = await api('/settings/genieacs-connection', { method: 'PUT', body: { mode: 'tunnel' } });
      assert.equal(tunel.status, 400, 'o túnel mexe na regra de rede do painel: é só do console');

      const agente = await api('/settings/genieacs-connection', { method: 'PUT', body: { mode: 'agent' } });
      assert.equal(agente.status, 200, JSON.stringify(agente.body));
    } finally {
      await api(`/platform/tenants/${alfa}/genieacs`, { method: 'PUT', body: { ownership: 'platform' } });
    }
    // De volta à plataforma, a escolha volta a ser só do console.
    const depois = await api('/settings/genieacs-connection', { method: 'PUT', body: { mode: 'direct' } });
    assert.equal(depois.status, 403);
  });
});

describe('o console', () => {
  it('gera a chave de um provedor, e o snapshot traz o AgentStatus', async () => {
    await api(`/platform/tenants/${beta}/genieacs`, { method: 'PUT', body: { mode: 'agent' } });
    const { status, body } = await api(`/platform/tenants/${beta}/genieacs/agent-token`, { method: 'POST' });
    assert.equal(status, 201, JSON.stringify(body));
    chaves.push(body.data.token);
    assert.equal(body.data.agent.tokenHint, body.data.token.slice(-4));

    const lido = await api(`/platform/tenants/${beta}/genieacs`);
    assert.equal(lido.body.data.mode, 'agent');
    assert.equal(lido.body.data.agent.tokenHint, body.data.token.slice(-4));
    assert.equal(lido.body.data.agent.connected, false);
    assert.equal(JSON.stringify(lido.body).includes(body.data.token), false);

    // Só no provedor pedido.
    const doAlfa = await runInTenant(alfa, () => GenieAcsConnection.agentInfo());
    assert.notEqual(doAlfa.tokenHint, body.data.token.slice(-4));
  });

  it('a chave gerada entra no hub e fala pelo provedor dela', async () => {
    const ws = new WebSocket(`${panelUrl.replace(/^http/, 'ws')}${AGENT_CONNECT_PATH}`, {
      headers: { Authorization: `Bearer ${chaves.at(-1)}` }
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('não conectou')), { once: true });
    });
    assert.equal(agentHub.isConnected(beta), true);
    assert.equal(agentHub.isConnected(alfa), false);
    const fechou = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));

    // Voltar o beta para direct pelo console derruba a conexão (4003).
    const volta = await api(`/platform/tenants/${beta}/genieacs`, { method: 'PUT', body: { mode: 'direct' } });
    assert.equal(volta.status, 200, JSON.stringify(volta.body));
    assert.equal(await fechou, 4003);
  });

  it('a trilha dos dois lados leva a dica, nunca a chave', async () => {
    const doBeta = await getDb()('audit_log').where({ tenant_id: beta, action: 'genieacs.agent_token_generated' });
    assert.equal(doBeta.length, 1);
    assert.equal(doBeta[0].actor_kind, 'platform');
    assert.deepEqual(JSON.parse(doBeta[0].detail), { tokenHint: chaves.at(-1).slice(-4) });

    const tudo = JSON.stringify(await runUnscoped('o teste procura a chave em toda a trilha', async () => [
      ...(await getDb()('audit_log').select('*')),
      ...(await getDb()('platform_audit').select('*'))
    ]));
    for (const chave of chaves) assert.equal(tudo.includes(chave), false);
  });

  it('provedor que não existe é 404', async () => {
    const { status } = await api('/platform/tenants/999999/genieacs/agent-token', { method: 'POST' });
    assert.equal(status, 404);
  });
});
