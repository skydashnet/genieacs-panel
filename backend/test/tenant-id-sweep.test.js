import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * O portão da Fase 8, na forma que o plano exige: **`GET /:id` com id de B
 * respondendo 404 e não 403**, varrido sobre TODA rota do painel endereçada por
 * id de linha — não sobre uma.
 *
 * A prova que já existia cobria dois endpoints (`portal-password` em
 * `tenant-leak`, `users` em `users-tenancy`). São 24 aqui, e a diferença não é
 * de quantidade: cada rota tem seu próprio caminho até o banco, e é a rota que
 * alguém acrescenta depois — copiando o controlador vizinho e trocando o modelo
 * — que vaza. Uma lista fecha isso por construção: acrescentar rota por id sem
 * acrescentar linha aqui deixa o buraco sem teste, e acrescentar a linha custa
 * uma linha.
 *
 * O controle é o que dá sentido ao 404. Cada caso roda DUAS vezes, com o mesmo
 * token, o mesmo host e o mesmo corpo — só o id muda:
 *
 *   1. beta pedindo o id do alfa  → tem que ser 404, e nunca 403;
 *   2. beta pedindo o id do beta  → tem que ser qualquer coisa MENOS 404.
 *
 * Sem (2) o arquivo inteiro passaria com as rotas quebradas, com o token
 * inválido, ou com o seed nunca tendo gravado nada — um 404 é o que se recebe
 * de graça. Com (2), o 404 de (1) só pode ser o escopo.
 *
 * Por que 404 e não 403: um 403 confirma que a linha existe. Perguntando id por
 * id, um provedor mapeia quantos fabricantes, campanhas e eventos o vizinho
 * tem, sem ler um único campo. O corpo da resposta é a resposta.
 *
 * O que a reversão mostrou, para quem for mexer nisto depois. Tirando o `where`
 * de `tdb()` (e desarmando a sentinela de SQL, que sozinha já derruba o seed
 * antes de qualquer rota rodar), **22 dos 24 casos ficam vermelhos**. Os dois
 * que continuam verdes são os de `/api/users/:id`, e continuam por estarem
 * certos: `users` é tabela do deploy, não de um provedor — a linha é uma
 * PESSOA, e um consultor que atende dois ISPs com um login só é o arranjo comum
 * deste mercado. Quem responde 404 ali não é o filtro, é a leitura do vínculo
 * em `tenant_users` dentro de `UsersController`, que é outro mecanismo e tem
 * prova própria em `users-tenancy.test.js`. Vale dizer porque a conclusão
 * preguiçosa — "o filtro cobre tudo" — é falsa, e porque uma rota nova sobre
 * `users` não herda nada daqui.
 */

process.env.TENANT_BASE_DOMAIN = 'painel.exemplo.com';
process.env.PORTAL_BASE_DOMAIN = 'portal.exemplo.com';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { casos } = await import('./helpers/idSweepCases.js');
const { runInTenant } = await import('../src/config/tenantContext.js');
const { tinsertReturningId } = await import('../src/config/database.js');

const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');

/**
 * Requisição com `Host` escolhido — `fetch` não faz isto: `Host` é header
 * proibido lá e o undici o substitui em silêncio, de modo que um teste escrito
 * com `fetch` passaria provando nada. É a mesma razão de `tenant-subdomain`.
 */
function callAs(host, url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

let panelUrl;
let alfa;
let beta;
let betaToken;

/** Os ids semeados de cada provedor, por chave de caso. */
const ids = { alfa: {}, beta: {} };

const PAINEL_BETA = 'beta.painel.exemplo.com';

/**
 * Semeia, para um provedor, uma linha de cada tabela que uma rota por id
 * alcança. Os valores colidem de propósito entre os dois provedores — o mesmo
 * telefone, a mesma `dedupe_key`, o mesmo nome de perfil, o mesmo par de ONTs —
 * porque é assim no mundo real e porque é a colisão que revela um índice único
 * que ficou valendo para o deploy inteiro.
 */
async function semear(tenantId, slug) {
  return runInTenant(tenantId, async () => {
    const bcrypt = (await import('bcryptjs')).default;

    /**
     * Uma linha, e o id dela, conferido na hora.
     *
     * `tinsertReturningId` cru e nunca o `create` do modelo, de propósito. Quase
     * todo `create` daqui lê antes de escrever — `WaOptOut.record` consulta
     * `isActive`, `SgpEvent.insertIfNew` consulta a `dedupe_key`,
     * `Vendor.create` consulta o nome — e todas essas leituras passam pelo
     * MESMO filtro que este arquivo existe para testar. Semeando por elas, o
     * dia em que o filtro cair o seed é que quebra, o `before` estoura, e os 24
     * casos aparecem como "cancelled" em vez de vermelhos: a falha some
     * justamente quando importa. O fixture tem que ser independente do
     * mecanismo sob teste.
     *
     * O `assert` é o resto: sem ele um seed vazio viraria "Cannot read
     * properties of null" dentro do hook, que também não diz qual linha faltou.
     */
    const semearLinha = async (tabela, linha) => {
      const id = await tinsertReturningId(tabela, linha);
      assert.ok(id, `seed do ${slug}: ${tabela} não foi gravada`);
      return id;
    };

    const alvo = {};

    // `users` é do deploy, não de um provedor: a linha é uma PESSOA e quem
    // decide o acesso é o vínculo em `tenant_users`. Por isso esta entra pelo
    // modelo — não há filtro de provedor a contornar aqui.
    const userId = await User.create({
      username: `alvo-${slug}`,
      password: await bcrypt.hash(`senha-do-alvo-${slug}-1`, 10),
      role: 'admin'
    });
    await TenantUser.create({ tenantId, userId, role: 'admin' });
    assert.ok(userId, `seed do ${slug}: users não foi gravada`);
    alvo.user = userId;

    alvo.template = await semearLinha('wa_templates', {
      name: 'segunda-via', body: 'Olá {{nome}}', category: 'cobranca', active: true
    });

    // O mesmo número nos dois: uma pessoa pode ser assinante dos dois
    // provedores e ter pedido silêncio a um só.
    alvo.tag = await semearLinha('wa_tags', { name: `Etiqueta ${slug}`, color: 'blue' });

    alvo.optOut = await semearLinha('wa_opt_outs', {
      wa_phone_e164: '5511900000001', origin: 'customer', created_at: new Date()
    });

    alvo.broadcast = await semearLinha('wa_broadcasts', {
      title: 'Aviso de manutenção', body: 'Teste', status: 'draft'
    });

    alvo.referral = await semearLinha('customer_referrals', {
      referrer_contract: '1001', name: 'Indicado Teste', phone_e164: '5511900000009', status: 'new'
    });

    alvo.account = await semearLinha('whatsapp_accounts', {
      name: `skygp_sweep_${slug}`,
      purpose: 'support',
      flavor: 'v2',
      // Porta 9 (discard), fechada: se alguma rota chegasse à rede em vez de
      // parar no escopo, o teste falharia por recusa de conexão em vez de
      // pendurar — e é isso que se quer saber.
      base_url: 'http://127.0.0.1:9',
      status: 'connected'
    });

    // A mesma `dedupe_key` nos dois. Ela é construída do id sequencial que o
    // ERP daquele provedor emitiu, então o evento nº 12345 de um ISP e o de
    // outro colidem — é a colisão que o índice único por provedor existe para
    // permitir.
    alvo.event = await semearLinha('sgp_events', {
      dedupe_key: 'sgp-evento-12345',
      source: 'webhook',
      type: 'suspend',
      contract: '4242',
      status: 'pending',
      payload: '{}'
    });

    alvo.profile = await semearLinha('provisioning_profiles', {
      name: 'perfil-padrao', priority: 10, enabled: true
    });

    /**
     * A conta de assinante, com os valores COLIDINDO entre os dois provedores —
     * que é a doutrina deste arquivo, e aqui ela é mais do que doutrina: o
     * `identity_hash` é `sha256(software_id \0 pppoe_username)`, derivação
     * determinística do login PPPoE. Dois ISPs com o mesmo firmware e um
     * assinante de mesmo login produzem o MESMO hash, e é exatamente o
     * sequestro de conta que `tenantScope.js` nomeia. Se o índice único voltar
     * a valer para o deploy inteiro, é este seed que estoura.
     */
    alvo.customerAccount = await semearLinha('customer_accounts', {
      customer_id: 'CSG-COMUM-000001',
      device_id: 'ONT-COMUM-0001',
      identity_hash: 'f'.repeat(64),
      software_id: 'V1.0',
      pppoe_username: 'assinante-comum',
      active: true
    });

    alvo.outage = await semearLinha('outage_incidents', {
      node_id: `ODP-${slug}-queda`,
      node_name: 'ODP da queda',
      status: 'open'
    });

    alvo.maintenance = await semearLinha('maintenance_windows', {
      node_id: `ODP-${slug}-manutencao`,
      node_name: 'ODP da manutenção',
      node_type: 'odp',
      starts_at: new Date(Date.now() + 48 * 3600_000),
      ends_at: new Date(Date.now() + 50 * 3600_000),
      lead_minutes: 1440,
      status: 'scheduled'
    });

    alvo.swap = await semearLinha('device_swaps', {
      previous_device_id: 'ONT-ANTIGA-0001',
      device_id: 'ONT-NOVA-0001',
      matched_by: 'pppoe',
      link_action: 'kept'
    });

    alvo.vendor = await semearLinha('vendors', {
      name: 'Fabricante Comum',
      manufacturer_patterns: JSON.stringify(['ACME']),
      product_patterns: JSON.stringify(['AC-1000']),
      parameter_prefix: 'InternetGatewayDevice'
    });

    alvo.wifiConfig = await semearLinha('wifi_security_config', {
      product_class: 'AC-1000',
      security_types: 'WPA2',
      password_param_path: 'WLANConfiguration.1.KeyPassphrase'
    });

    // A planta de fibra. Um nome por provedor, e não o mesmo para os dois: a
    // pergunta desta suíte é se o id do VIZINHO alcança a linha dele, e um id
    // que os dois têm responderia 200 por ser o próprio, provando nada. Que os
    // dois POSSAM nomear o mesmo poste é outra prova, e ela é do
    // `tenant-scoping.test.js`, onde a planta de um sobrevive à reescrita do
    // outro.
    alvo.nodeA = `ODP-${slug}-01`;
    alvo.nodeB = `ODP-${slug}-02`;
    for (const [nodeId, nome] of [[alvo.nodeA, 'ODP da esquina'], [alvo.nodeB, 'ODP da praça']]) {
      await semearLinha('mapping_nodes', {
        node_id: nodeId, type: 'odp', name: `${nome} (${slug})`, latitude: -15.79, longitude: -47.88
      });
    }
    alvo.edge = `CABO-${slug}-01`;
    await semearLinha('mapping_edges', {
      edge_id: alvo.edge, source: alvo.nodeA, target: alvo.nodeB, fiber_type: 'drop', distance: 30
    });

    alvo.invite = await semearLinha('tenant_invites', {
      token_hash: `${slug}`.padEnd(64, '0').slice(0, 64),
      role: 'tech',
      label: `convite do ${slug}`,
      expires_at: new Date(Date.now() + 3_600_000)
    });

    // A conversa e uma mensagem falha nela: a conversa carrega contrato e
    // device id do assinante, e a mensagem é a linha que o reenfileiramento
    // toca.
    alvo.conversation = await semearLinha('wa_conversations', {
      account_id: alvo.account,
      wa_phone_e164: '5511911111111',
      external_thread_id: `thread-${slug}`,
      push_name: `Assinante do ${slug}`,
      contract: '4242',
      last_message_at: new Date()
    });
    alvo.failedMessage = await semearLinha('wa_messages', {
      conversation_id: alvo.conversation,
      direction: 'out',
      external_id: `msg-${slug}-1`,
      body: 'Segunda via em anexo',
      delivery_status: 'failed',
      attempts: 1
    });

    // O contrato do SGP, um por provedor e não o mesmo nos dois, pelo motivo
    // da planta de fibra acima: o que se pergunta é se o contrato do VIZINHO
    // abre conversa aqui. Com telefone, para que o controle chegue a abrir.
    alvo.sgpContract = `CONTRATO-${slug}`;
    await semearLinha('sgp_links', {
      device_id: `ONT-CONTATO-${slug}`,
      contract: alvo.sgpContract,
      client_name: `Contato do ${slug}`,
      state: 'active',
      phone_e164: '5511922222222'
    });

    return alvo;
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();

  const primeiro = await db('tenants').orderBy('id', 'asc').first();
  await db('tenants').where({ id: primeiro.id }).update({ slug: 'alfa', name: 'Provedor Alfa' });
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  alfa = primeiro.id;
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  // O administrador do beta é quem faz as perguntas. Criado direto porque
  // `/auth/setup` só cunha o primeiro administrador de um provedor que não tem
  // nenhum, e o vínculo é a parte que decide: sem linha em `tenant_users` a
  // pessoa não entra e o token viria indefinido.
  const bcrypt = (await import('bcryptjs')).default;
  const betaUserId = await runInTenant(beta, () => User.create({
    username: 'operador-beta',
    password: bcrypt.hashSync('senha-do-beta-1', 10),
    role: 'admin'
  }));
  await runInTenant(beta, () => TenantUser.create({
    tenantId: beta, userId: betaUserId, role: 'admin'
  }));
  const login = await callAs(PAINEL_BETA, `${panelUrl}/api/auth/login`, {
    method: 'POST',
    body: { username: 'operador-beta', password: 'senha-do-beta-1' }
  });
  betaToken = login.body?.data?.token;
  assert.ok(betaToken, 'o operador do beta precisa de um token');

  ids.alfa = await semear(alfa, 'alfa');
  ids.beta = await semear(beta, 'beta');

  // A integração do WhatsApp ligada NO BETA, de propósito. Sem ela as rotas de
  // instância param em `requireConfig` antes de olhar o id, e um 400 dizendo
  // "não configurado" provaria só que o beta não configurou nada. Ligada, o
  // único obstáculo que resta entre o beta e a instância do alfa é o escopo —
  // que é exatamente a afirmação sob teste.
  const config = await callAs(PAINEL_BETA, `${panelUrl}/api/whatsapp/config`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${betaToken}` },
    body: { enabled: true, webhookBaseUrl: 'https://webhook.beta.exemplo.com' }
  });
  assert.equal(config.status, 200, 'o beta precisa ter a integração ligada');
});

after(async () => {
  await stopTestServers();
});


/** A linha crua, com provedor e tudo — nunca por um modelo. */
const cru = (caso, id) => getDb()(caso.tabela).where({ [caso.coluna ?? 'id']: id }).first();

/** O corpo do caso, que às vezes precisa de outros ids do mesmo provedor. */
const corpo = (caso, semeados) => (
  typeof caso.body === 'function' ? caso.body(semeados) : caso.body
);

describe('o operador do beta pedindo, no host do beta, o id do alfa', () => {
  for (const caso of casos) {
    it(`${caso.label} responde ${caso.esperado ?? 404}`, async () => {
      const id = ids.alfa[caso.chave];
      assert.ok(id, `o seed do alfa precisa ter gravado ${caso.chave}`);
      const antes = await cru(caso, id);
      assert.ok(antes, 'a linha do alfa tem que existir antes da chamada');
      const esperado = caso.esperado ?? 404;

      const { status, body } = await callAs(PAINEL_BETA, `${panelUrl}${caso.path(id)}`, {
        method: caso.method,
        headers: { Authorization: `Bearer ${betaToken}` },
        body: corpo(caso, ids.alfa)
      });

      // As duas afirmações separadas de propósito: a primeira é o contrato, a
      // segunda é o que se perderia se alguém "consertasse" o 404 para 403 por
      // achar mais honesto.
      assert.equal(status, esperado, `${caso.label}: ${JSON.stringify(body)}`);
      assert.notEqual(status, 403);

      // E a linha do alfa tem que estar como estava. Um 404 devolvido DEPOIS de
      // escrever é o pior dos dois mundos, e é uma falha que nenhum código de
      // status revela.
      assert.deepEqual(await cru(caso, id), antes,
        `${caso.label}: a linha do alfa foi tocada`);
    });
  }
});

/**
 * O controle, e a razão de o arquivo inteiro querer dizer alguma coisa.
 *
 * Mesma rota, mesmo token, mesmo host, mesmo corpo — só o id muda, do alfa para
 * o beta. Se isto também desse 404, os 404 acima seriam de graça: rota errada,
 * token recusado, seed vazio, qualquer coisa.
 *
 * Roda depois porque metade destes casos apaga a linha que usa.
 */
describe('a mesma pergunta com o id do próprio beta', () => {
  for (const caso of casos) {
    it(`${caso.label} não responde ${caso.esperado ?? 404}`, async () => {
      const id = ids.beta[caso.chave];
      assert.ok(id, `o seed do beta precisa ter gravado ${caso.chave}`);

      const { status, body } = await callAs(PAINEL_BETA, `${panelUrl}${caso.path(id)}`, {
        method: caso.method,
        headers: { Authorization: `Bearer ${betaToken}` },
        body: corpo(caso, ids.beta)
      });

      if (caso.controleSoNaoAchou) {
        // Estas alcançam a rede quando o id resolve, e a porta está fechada de
        // propósito. O que se exige é que a instância tenha sido ENCONTRADA:
        // qualquer falha de transporte serve, `account_not_found` não.
        assert.notEqual(body?.code, caso.codigoDeNaoAchou ?? 'account_not_found',
          `${caso.label}: o beta não achou a própria linha`);
        return;
      }
      assert.notEqual(status, caso.esperado ?? 404, `${caso.label}: ${JSON.stringify(body)}`);
    });
  }
});
