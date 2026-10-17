import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Quem opera o SaaS olhando o painel de um cliente para atendê-lo.
 *
 * A personificação é a coisa mais poderosa que o plano de controle faz, e o que
 * este arquivo guarda não é que ela funcione — é o cerco dela: que ninguém a
 * cunhe sem estar no cadastro da plataforma, que ela não escreva nada, que não
 * alcance o console de volta, que morra quando quem a abriu perde o cadastro ou
 * troca a senha, e que o provedor personificado veja na PRÓPRIA trilha que
 * entraram no painel dele.
 *
 * SaaS com subdomínio porque a peça central — o bilhete — existe justamente
 * porque o console e o painel do cliente vivem em hosts diferentes. `Host` é
 * header proibido no `fetch`, daí o `http.request` cru.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { runInTenant } = await import('../src/config/tenantContext.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: ImpersonationTicket } = await import('../src/models/ImpersonationTicket.js');

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
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
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
let plataformaToken;
let plataformaUserId;
let betaAdminToken;
let betaAdminUserId;

/**
 * O console vive no ENDEREÇO DA PLATAFORMA — o ápice —, e não mais no host de
 * um provedor. `CASA` continua existindo porque é onde a instalação faz o setup
 * e onde mora o provedor da casa; o que mudou é de onde os bilhetes são
 * cunhados.
 */
const APEX = 'painel.test';
const CASA = 'default.painel.test';
const BETA = 'beta.painel.test';
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const naCasa = (path, options) => callAs(CASA, `${panelUrl}${path}`, options);
const noConsole = (path, options) => callAs(APEX, `${panelUrl}${path}`, options);
const noBeta = (path, options) => callAs(BETA, `${panelUrl}${path}`, options);

/** Cunha, resgata e devolve o token da sessão de personificação em `beta`. */
async function personificar() {
  const minted = await noConsole(`/api/platform/tenants/${beta}/impersonate`, {
    method: 'POST', headers: bearer(plataformaToken)
  });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  const ticket = new URL(minted.body.data.url).hash.slice(1);
  const redeemed = await noBeta('/api/auth/impersonate/redeem', {
    method: 'POST', body: { ticket }
  });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  return redeemed.body.data.token;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();

  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  // O primeiro administrador de um deploy SaaS entra em `platform_admins` pelo
  // próprio caminho da instalação — é assim que o segundo provedor chega a
  // existir. Aqui isso é o que dá a chave a quem vai personificar.
  const setup = await naCasa('/api/auth/setup', {
    method: 'POST',
    body: { username: 'plataforma', password: 'senha-da-plataforma-1', email: 'plataforma@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  plataformaUserId = setup.body.data.user.id;
  // A sessão que opera o console é a DO CONSOLE, emitida no ápice: a do setup
  // nomeia o provedor da casa, e com ela o console não responde mais.
  const consoleEntrada = await noConsole('/api/auth/login', {
    method: 'POST',
    body: { username: 'plataforma', password: 'senha-da-plataforma-1' }
  });
  assert.equal(consoleEntrada.status, 200, JSON.stringify(consoleEntrada.body));
  assert.equal(consoleEntrada.body.data.user.tenantId, null);
  plataformaToken = consoleEntrada.body.data.token;
  assert.ok(await db('platform_admins').where({ user_id: plataformaUserId }).first());

  // O beta precisa de assinatura ativa, senão o portão comercial responde 402
  // antes de qualquer rota e os casos abaixo mediriam o 402 em vez do que
  // querem medir. Foi assim que um caso desta suíte já passou vazio uma vez:
  // `assert.notEqual(status, 401)` aceita 402 de bom grado.
  const { default: Subscription } = await import('../src/models/Subscription.js');
  const { default: SubscriptionService } = await import('../src/services/subscriptionService.js');
  const plano = await db('plans').orderBy('id', 'asc').first();
  await runInTenant(beta, () => Subscription.upsertForTenant(beta, {
    plan_id: plano?.id ?? null, status: 'active'
  }));
  await runInTenant(beta, () => SubscriptionService.invalidate(beta));

  const bcrypt = (await import('bcryptjs')).default;
  const betaAdminId = await runInTenant(beta, () => User.create({
    username: 'admin-beta',
    email: 'admin-beta@exemplo.test',
    password: bcrypt.hashSync('senha-do-beta-1', 10),
    role: 'admin'
  }));
  await runInTenant(beta, () => TenantUser.create({ tenantId: beta, userId: betaAdminId, role: 'admin' }));
  betaAdminUserId = betaAdminId;
  const entrada = await noBeta('/api/auth/login', {
    method: 'POST', body: { username: 'admin-beta', password: 'senha-do-beta-1' }
  });
  assert.equal(entrada.status, 200);
  betaAdminToken = entrada.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('cunhar o bilhete', () => {
  it('devolve um endereço no host do provedor, com o bilhete no fragmento', async () => {
    const { status, body } = await noConsole(`/api/platform/tenants/${beta}/impersonate`, {
      method: 'POST', headers: bearer(plataformaToken)
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.tenant.slug, 'beta');
    assert.equal(body.data.expiresInSeconds, 60);

    const url = new URL(body.data.url);
    assert.equal(url.host, 'beta.painel.test');
    assert.equal(url.pathname, '/impersonate');
    // O bilhete vai no FRAGMENTO, que o navegador não manda a servidor nenhum.
    // Se um dia alguém o mover para o query string, esta linha é a que cai.
    assert.match(url.hash, /^#[0-9a-f]{64}$/);
    assert.equal(url.search, '');

    // E o que fica gravado é o hash, nunca o valor.
    const bilhete = url.hash.slice(1);
    const linha = await getDb()('impersonation_tickets')
      .where({ token_hash: ImpersonationTicket.hash(bilhete) }).first();
    assert.ok(linha, 'o bilhete tem que existir na tabela, pelo hash');
    assert.equal(Number(linha.tenant_id), beta);
    assert.equal(Number(linha.platform_user_id), plataformaUserId);
    assert.equal(linha.redeemed_at, null);
    assert.equal(
      await getDb()('impersonation_tickets').where({ token_hash: bilhete }).first(),
      undefined,
      'o valor em claro não pode estar guardado'
    );
  });

  it('deixa na trilha da plataforma quem pediu para olhar o painel de quem', async () => {
    await noConsole(`/api/platform/tenants/${beta}/impersonate`, {
      method: 'POST', headers: bearer(plataformaToken)
    });
    const linha = await getDb()('platform_audit')
      .where({ action: 'tenant.impersonated', tenant_id: beta })
      .orderBy('id', 'desc').first();
    assert.ok(linha);
    assert.equal(Number(linha.actor_user_id), plataformaUserId);
    assert.equal(linha.tenant_slug, 'beta');
  });

  it('não é do administrador do provedor, por mais graduado que ele seja', async () => {
    const { status } = await noBeta(`/api/platform/tenants/${beta}/impersonate`, {
      method: 'POST', headers: bearer(betaAdminToken)
    });
    // 404 e não 403: o console não confirma a quem não é dele que ele existe.
    assert.equal(status, 404);
  });

  it('recusa um provedor que não existe', async () => {
    const { status } = await noConsole('/api/platform/tenants/999999/impersonate', {
      method: 'POST', headers: bearer(plataformaToken)
    });
    assert.equal(status, 404);
  });
});

describe('resgatar o bilhete', () => {
  it('vira uma sessão de atendimento (admin) e deixa na trilha DO PROVEDOR que entraram', async () => {
    const minted = await noConsole(`/api/platform/tenants/${beta}/impersonate`, {
      method: 'POST', headers: bearer(plataformaToken)
    });
    const ticket = new URL(minted.body.data.url).hash.slice(1);

    const { status, body } = await noBeta('/api/auth/impersonate/redeem', {
      method: 'POST', body: { ticket }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.user.role, 'admin');
    assert.equal(body.data.user.tenantId, beta);
    assert.equal(body.data.user.impersonation.platformUsername, 'plataforma');
    // Falso mesmo sendo a pessoa do cadastro: dentro da personificação o
    // console responde 404, e um `true` acenderia um menu que não abre.
    assert.equal(body.data.user.isPlatformAdmin, false);
    assert.equal(body.data.tenant.slug, 'beta');
    assert.ok(body.data.token);
    // Não existe refresh: continuar depois de meia hora custa uma volta ao
    // console, que é mais uma linha na trilha.
    assert.equal(body.data.refreshToken, undefined);

    const linha = await runInTenant(beta, () => getDb()('audit_log')
      .where({ tenant_id: beta, action: 'platform.impersonated' })
      .orderBy('id', 'desc').first());
    assert.ok(linha, 'o provedor tem que ver na trilha dele que entraram');
    assert.equal(linha.actor_kind, 'platform');
    assert.equal(linha.actor_username, 'plataforma');
  });

  it('serve uma vez só', async () => {
    const minted = await noConsole(`/api/platform/tenants/${beta}/impersonate`, {
      method: 'POST', headers: bearer(plataformaToken)
    });
    const ticket = new URL(minted.body.data.url).hash.slice(1);

    assert.equal((await noBeta('/api/auth/impersonate/redeem', { method: 'POST', body: { ticket } })).status, 200);
    assert.equal((await noBeta('/api/auth/impersonate/redeem', { method: 'POST', body: { ticket } })).status, 404);
  });

  it('não serve no host de outro provedor', async () => {
    const minted = await noConsole(`/api/platform/tenants/${beta}/impersonate`, {
      method: 'POST', headers: bearer(plataformaToken)
    });
    const ticket = new URL(minted.body.data.url).hash.slice(1);

    // Mesmo bilhete, host da casa. Um bilhete do beta resgatado aqui produziria
    // uma sessão para o beta servida por uma porta que não é a dele.
    const { status } = await naCasa('/api/auth/impersonate/redeem', { method: 'POST', body: { ticket } });
    assert.equal(status, 404);
  });

  it('não serve depois de vencer', async () => {
    const { token } = await runInTenant(beta, () => ImpersonationTicket.create({
      tenantId: beta, platformUserId: plataformaUserId, ttlMs: -1000
    }));
    const { status } = await noBeta('/api/auth/impersonate/redeem', { method: 'POST', body: { ticket: token } });
    assert.equal(status, 404);
  });

  it('não serve se quem o cunhou saiu do cadastro da plataforma', async () => {
    const minted = await noConsole(`/api/platform/tenants/${beta}/impersonate`, {
      method: 'POST', headers: bearer(plataformaToken)
    });
    const ticket = new URL(minted.body.data.url).hash.slice(1);

    await getDb()('platform_admins').where({ user_id: plataformaUserId }).del();
    try {
      const { status } = await noBeta('/api/auth/impersonate/redeem', { method: 'POST', body: { ticket } });
      assert.equal(status, 404);
    } finally {
      await getDb()('platform_admins').insert({ user_id: plataformaUserId });
    }
  });

  it('recusa um bilhete inventado, e um pedido sem bilhete', async () => {
    assert.equal((await noBeta('/api/auth/impersonate/redeem', {
      method: 'POST', body: { ticket: 'f'.repeat(64) }
    })).status, 404);
    assert.equal((await noBeta('/api/auth/impersonate/redeem', { method: 'POST', body: {} })).status, 400);
  });
});

describe('a sessão de personificação', () => {
  it('lê o painel do provedor', async () => {
    const token = await personificar();
    const { status, body } = await noBeta('/api/tenant/public', { headers: bearer(token) });
    assert.equal(status, 200);
    assert.equal(body.data.slug, 'beta');
  });

  it('se apresenta como personificação, e sem o console', async () => {
    const token = await personificar();
    const { status, body } = await noBeta('/api/auth/user', { headers: bearer(token) });
    assert.equal(status, 200);
    assert.equal(body.data.role, 'admin');
    assert.equal(body.data.tenantId, beta);
    assert.equal(body.data.impersonation.platformUsername, 'plataforma');
    assert.equal(body.data.isPlatformAdmin, false);
  });

  it('escreve no painel do provedor, e a trilha dele diz que foi a plataforma', async () => {
    const token = await personificar();
    const res = await noBeta('/api/tenant', { method: 'PATCH', headers: bearer(token), body: { name: 'Beta via atendimento' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { body } = await noBeta('/api/tenant/public');
    assert.equal(body.data.name, 'Beta via atendimento');

    const linha = await runInTenant(beta, () => getDb()('audit_log')
      .where({ tenant_id: beta, action: 'tenant.renamed' })
      .orderBy('id', 'desc').first());
    assert.ok(linha, 'a escrita do atendimento não deixou linha na trilha do provedor');
    assert.equal(linha.actor_kind, 'platform');
    assert.equal(linha.actor_username, 'plataforma');

    // Devolve o nome, que outros casos leem.
    await noBeta('/api/tenant', { method: 'PATCH', headers: bearer(token), body: { name: 'Provedor Beta' } });
  });

  it('não mexe na conta de quem personifica', async () => {
    const token = await personificar();
    const res = await noBeta('/api/auth/change-password', {
      method: 'POST', headers: bearer(token), body: { currentPassword: 'x', newPassword: 'outra-senha-123' }
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, 'impersonation_read_only');
  });

  // ───────────────────────────────────────────────────────────────────────
  // O muro é por MÉTODO, e um GET atravessava
  //
  // O caso acima só exercita PATCH/POST/PUT/DELETE, e foi esse recorte que
  // deixou passar o pior: `GET /api/devices` ESCREVE. Ele chama
  // `CustomerService.decorateDevices` → `syncDevices` → `ensureAccount`, que
  // cria conta de portal, cunha senha, e no ramo do assinante trocado APOSENTA
  // a conta anterior e apaga o vínculo do ERP.
  //
  // O `viewer` imposto na hidratação tem `devices.list`, e GET passa pelo muro.
  // Então quem do plantão da plataforma abrisse o painel de um cliente e
  // clicasse na lista de aparelhos podia fazer um assinante daquele cliente
  // perder o Customer ID, a senha do portal e o vínculo com o ERP — sem uma
  // linha na trilha dizendo quem fez.
  //
  // A prova é no nível do serviço, e não por HTTP: a rota real precisa de um
  // GenieACS de pé, e o que se quer medir aqui é a guarda, não o ACS. A sessão
  // que a rota montaria é montada à mão, com a mesma forma que
  // `hydrateImpersonation` produz.
  // ───────────────────────────────────────────────────────────────────────
  const SESSAO_PERSONIFICANDO = () => ({
    userId: plataformaUserId, username: 'plataforma', role: 'admin',
    impersonation: { platformUsername: 'plataforma' }
  });
  const SESSAO_DO_PROVEDOR = () => ({
    userId: betaAdminUserId, username: 'admin-beta', role: 'admin'
  });

  it('a reconciliação NÃO acontece durante uma personificação', async () => {
    const { default: CustomerService } = await import('../src/services/customerService.js');
    const { runInTenant } = await import('../src/config/tenantContext.js');
    const aparelho = (pppoe) => ({ _id: 'ONT-PERSONIFICADA', softwareId: 'V1.0', pppoe });

    await runInTenant(beta, () => CustomerService.ensureAccount(aparelho('ana')));
    const antes = await getDb()('customer_accounts').where({ device_id: 'ONT-PERSONIFICADA' }).first();
    assert.ok(antes, 'a conta de partida não foi criada');

    // O mesmo aparelho passa a reportar outro login: é o ramo que aposenta.
    await runInTenant(
      beta,
      () => CustomerService.syncDevices([aparelho('carla')], { enabled: true }),
      { actor: SESSAO_PERSONIFICANDO() }
    );

    const depois = await getDb()('customer_accounts').where({ id: antes.id }).first();
    assert.equal(Number(depois.active), 1, 'a conta do assinante foi aposentada por quem estava só olhando');
    assert.equal(depois.customer_id, antes.customer_id, 'o Customer ID mudou durante uma personificação');
    assert.equal(depois.password_ciphertext, antes.password_ciphertext, 'a senha do portal foi recunhada');
    // E nenhuma conta nova apareceu no lugar.
    assert.equal(
      (await getDb()('customer_accounts').where({ device_id: 'ONT-PERSONIFICADA' })).length, 1
    );
  });

  it('e o operador do próprio provedor continua reconciliando, agora com trilha', async () => {
    const { default: CustomerService } = await import('../src/services/customerService.js');
    const { runInTenant } = await import('../src/config/tenantContext.js');
    const aparelho = (pppoe) => ({ _id: 'ONT-COM-TRILHA', softwareId: 'V1.0', pppoe });

    await runInTenant(beta, () => CustomerService.ensureAccount(aparelho('bruno')));
    const antes = await getDb()('customer_accounts').where({ device_id: 'ONT-COM-TRILHA' }).first();

    // A aposentadoria NÃO foi adiada para ninguém: para quem é do provedor ela
    // continua acontecendo na hora, que é o que impede a conta do assinante
    // ANTERIOR de continuar apontando para o aparelho do novo.
    await runInTenant(
      beta,
      () => CustomerService.syncDevices([aparelho('carla')], { enabled: true }),
      { actor: SESSAO_DO_PROVEDOR() }
    );

    const aposentada = await getDb()('customer_accounts').where({ id: antes.id }).first();
    assert.equal(Number(aposentada.active), 0, 'a troca de assinante parou de aposentar');

    // E deixa rastro, com o autor. Antes era só um `console.warn`, que é log de
    // processo e some — o ISP não tinha onde olhar.
    const linha = await getDb()('audit_log')
      .where({ action: 'subscriber_account.retired', tenant_id: beta })
      .orderBy('id', 'desc')
      .first();
    assert.ok(linha, 'a aposentadoria não deixou linha na trilha');
    assert.equal(linha.subject_id, String(antes.customer_id));
    assert.equal(linha.actor_username, 'admin-beta', 'a trilha não diz quem fez');
  });

  it('não desloga — que derrubaria as sessões de quem personifica, não as do cliente', async () => {
    const token = await personificar();
    const antes = await getDb()('users').where({ id: plataformaUserId }).first();
    const { status, body } = await noBeta('/api/auth/logout', { method: 'POST', headers: bearer(token) });
    assert.equal(status, 403);
    assert.equal(body.code, 'impersonation_read_only');
    const depois = await getDb()('users').where({ id: plataformaUserId }).first();
    assert.equal(Number(depois.token_version), Number(antes.token_version),
      'sair de uma personificação não pode revogar as sessões de quem personifica');
  });

  // O roteamento do Express não distingue caixa: `/API/Auth/logout` chega ao
  // mesmo handler que `/api/auth/logout`. O muro comparava o caminho com
  // `startsWith('/api/auth/')` ao pé da letra, então bastava trocar a caixa
  // para a escrita na conta de quem personifica atravessar.
  it('não mexe na conta de quem personifica nem trocando a caixa do caminho', async () => {
    const token = await personificar();
    const antes = await getDb()('users').where({ id: plataformaUserId }).first();
    for (const caminho of ['/API/Auth/logout', '/Api/AUTH/change-username', '/api/Auth/mfa/setup']) {
      const res = await noBeta(caminho, {
        method: 'POST', headers: bearer(token), body: { username: 'sequestrado', password: 'x' }
      });
      assert.equal(res.status, 403, `${caminho}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'impersonation_read_only', caminho);
    }
    const depois = await getDb()('users').where({ id: plataformaUserId }).first();
    assert.equal(Number(depois.token_version), Number(antes.token_version));
    assert.equal(depois.username, antes.username);
  });

  it('não alcança o console de volta, em host nenhum', async () => {
    const token = await personificar();
    // Em host de provedor o console não está — nem no do beta, nem no da casa,
    // onde ele era servido até ontem. 404 de rota inexistente, para todo mundo.
    assert.equal((await noBeta('/api/platform/tenants', { headers: bearer(token) })).status, 404);
    assert.equal((await naCasa('/api/platform/tenants', { headers: bearer(token) })).status, 404);
    // E no endereço onde ele está, esta sessão é recusada pelo endereço: ela
    // nomeia um provedor, e ali isso é o que não vale.
    const noConsoleComEle = await noConsole('/api/platform/tenants', { headers: bearer(token) });
    assert.equal(noConsoleComEle.status, 403);
    assert.equal(noConsoleComEle.body.code, 'tenant_mismatch');
  });

  it('não vale no host de outro provedor', async () => {
    const token = await personificar();
    // Numa rota COM sessão. A pública (`/api/tenant/public`) responde pelo
    // host e ignora o cabeçalho — é o que ela faz para qualquer token, e não
    // teria nada a dizer sobre este.
    const { status, body } = await naCasa('/api/auth/user', { headers: bearer(token) });
    assert.equal(status, 403);
    assert.equal(body.code, 'tenant_mismatch');
  });

  it('morre quando quem a abriu sai do cadastro da plataforma', async () => {
    const token = await personificar();
    assert.equal((await noBeta('/api/auth/user', { headers: bearer(token) })).status, 200);

    await getDb()('platform_admins').where({ user_id: plataformaUserId }).del();
    try {
      const { status } = await noBeta('/api/auth/user', { headers: bearer(token) });
      assert.equal(status, 403, 'o cadastro é lido a cada requisição, não quando o token foi feito');
    } finally {
      await getDb()('platform_admins').insert({ user_id: plataformaUserId });
    }
  });

  it('morre quando quem a abriu troca a senha', async () => {
    const token = await personificar();
    const antes = await getDb()('users').where({ id: plataformaUserId }).first();
    await getDb()('users').where({ id: plataformaUserId })
      .update({ token_version: Number(antes.token_version) + 1 });
    try {
      assert.equal((await noBeta('/api/auth/user', { headers: bearer(token) })).status, 403);
    } finally {
      await getDb()('users').where({ id: plataformaUserId })
        .update({ token_version: Number(antes.token_version) });
    }
  });

  it('não é aceita como refresh', async () => {
    const token = await personificar();
    const { status } = await noBeta('/api/auth/refresh', { method: 'POST', body: { refreshToken: token } });
    assert.notEqual(status, 200);
  });
});

describe('a limpeza dos bilhetes', () => {
  it('apaga o que venceu sem uso e guarda por um dia o que foi usado', async () => {
    const db = getDb();
    await db('impersonation_tickets').del();

    const vencido = await ImpersonationTicket.create({
      tenantId: beta, platformUserId: plataformaUserId, ttlMs: -1000
    });
    const usadoAgora = await ImpersonationTicket.create({
      tenantId: beta, platformUserId: plataformaUserId, ttlMs: -1000
    });
    await db('impersonation_tickets').where({ id: usadoAgora.id }).update({ redeemed_at: new Date() });
    const vivo = await ImpersonationTicket.create({ tenantId: beta, platformUserId: plataformaUserId });

    await ImpersonationTicket.prune();
    const restam = (await db('impersonation_tickets').select('id')).map((r) => Number(r.id)).sort();
    assert.deepEqual(restam, [usadoAgora.id, vivo.id].sort(),
      'o vencido sem uso sai; o usado há pouco fica, porque é o que alguém vai consultar');
    assert.equal(await db('impersonation_tickets').where({ id: vencido.id }).first(), undefined);
  });
});
