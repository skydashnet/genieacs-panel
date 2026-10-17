import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * O convite: como alguém entra na equipe de um provedor sem que o administrador
 * escolha a senha dela.
 *
 * A onda 12 recusou, com razão, que o administrador de um provedor anexasse
 * alguém que já existe no deploy — aquele request carrega uma SENHA, e há uma
 * senha por pessoa. O convite inverte a direção: quem administra oferece o
 * vínculo, e quem entra é a pessoa convidada, provando quem é com a senha que
 * já tem ou escolhendo uma que ninguém mais vê.
 *
 * Um convite é uma credencial. É esse o eixo de quase tudo aqui: uso único de
 * verdade (decidido pelo banco, não por um `if`), expira, revogável, guardado
 * como hash, e — o item que este arquivo mais persegue — **um jeito só de não
 * servir**. Token que nunca existiu, expirado, aceito, revogado ou de outro
 * provedor respondem a mesma coisa, byte a byte. Separá-los faria do link um
 * oráculo para quem tem exatamente zero credenciais.
 */

process.env.TENANT_BASE_DOMAIN = 'painel.exemplo.com';
process.env.PORTAL_BASE_DOMAIN = 'portal.exemplo.com';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { runInTenant } = await import('../src/config/tenantContext.js');
const { tinsertReturningId } = await import('../src/config/database.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: TenantInvite } = await import('../src/models/TenantInvite.js');

/** Requisição com `Host` escolhido — `fetch` não faz isto. Ver `tenant-subdomain`. */
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
        resolve({ status: response.statusCode, body: parsed, raw: text });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const ALFA = 'alfa.painel.exemplo.com';
const BETA = 'beta.painel.exemplo.com';

let panelUrl;
let alfa;
let beta;
let alfaOwnerToken;
let alfaAdminToken;
let betaOwnerToken;

async function criarOperador(tenantId, username, senha, role) {
  const bcrypt = (await import('bcryptjs')).default;
  const userId = await runInTenant(tenantId, () => User.create({
    username, password: bcrypt.hashSync(senha, 10), role
  }));
  await runInTenant(tenantId, () => TenantUser.create({ tenantId, userId, role }));
  return userId;
}

async function entrar(host, username, senha) {
  const { body } = await callAs(host, `${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username, password: senha }
  });
  const token = body?.data?.token;
  assert.ok(token, `${username} precisa de um token`);
  return token;
}

const comToken = (token) => ({ Authorization: `Bearer ${token}` });

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  const primeiro = await db('tenants').orderBy('id', 'asc').first();
  await db('tenants').where({ id: primeiro.id }).update({ slug: 'alfa', name: 'Provedor Alfa' });
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  alfa = primeiro.id;
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  await criarOperador(alfa, 'dona-do-alfa', 'senha-da-dona-1', 'owner');
  await criarOperador(alfa, 'admin-do-alfa', 'senha-do-admin-1', 'admin');
  await criarOperador(beta, 'dona-do-beta', 'senha-da-dona-2', 'owner');

  alfaOwnerToken = await entrar(ALFA, 'dona-do-alfa', 'senha-da-dona-1');
  alfaAdminToken = await entrar(ALFA, 'admin-do-alfa', 'senha-do-admin-1');
  betaOwnerToken = await entrar(BETA, 'dona-do-beta', 'senha-da-dona-2');
});

after(async () => {
  await stopTestServers();
});

/** Cria um convite pela API e devolve `{ id, token }`. */
async function convidar(host, token, corpo = { role: 'tech' }) {
  const { status, body } = await callAs(host, `${panelUrl}/api/invites`, {
    method: 'POST', headers: comToken(token), body: corpo
  });
  assert.equal(status, 201, JSON.stringify(body));
  return { id: body.data.invite.id, token: body.data.token, invite: body.data.invite };
}

describe('criar um convite', () => {
  it('devolve o token uma vez e não o guarda em claro', async () => {
    const { token, id } = await convidar(ALFA, alfaAdminToken);
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 64, 'são 32 bytes em hex');

    const linha = await getDb()('tenant_invites').where({ id }).first();
    // O que a tabela guarda é o digest. Se um dia alguém acrescentar uma coluna
    // com o token, esta asserção é o que vai reclamar.
    assert.notEqual(linha.token_hash, token);
    assert.equal(linha.token_hash, TenantInvite.hash(token));
    assert.equal(JSON.stringify(linha).includes(token), false,
      'nenhuma coluna pode conter o token em claro');
  });

  it('não repete o token numa segunda leitura', async () => {
    const { id } = await convidar(ALFA, alfaAdminToken);
    const { body } = await callAs(ALFA, `${panelUrl}/api/invites`, {
      headers: comToken(alfaAdminToken)
    });
    const listado = body.data.invites.find((convite) => convite.id === id);
    assert.ok(listado, 'o convite tem que aparecer na lista');
    assert.equal('token' in listado, false, 'a listagem não pode devolver o token');
  });

  it('recusa papel que não existe', async () => {
    const { status } = await callAs(ALFA, `${panelUrl}/api/invites`, {
      method: 'POST', headers: comToken(alfaAdminToken), body: { role: 'superusuario' }
    });
    assert.equal(status, 400);
  });

  it('não deixa um admin convidar um owner', async () => {
    // Sem esta regra o convite seria a porta dos fundos da promoção: o PATCH em
    // `/api/users` recusa um admin virando owner, e bastaria convidar a si
    // mesmo de volta.
    const { status, body } = await callAs(ALFA, `${panelUrl}/api/invites`, {
      method: 'POST', headers: comToken(alfaAdminToken), body: { role: 'owner' }
    });
    assert.equal(status, 403, JSON.stringify(body));
  });

  it('deixa um owner convidar um owner', async () => {
    // O par do caso acima. Sem ele, um 403 por qualquer outro motivo — token
    // recusado, rota errada — passaria como se fosse a regra funcionando.
    const { status } = await callAs(ALFA, `${panelUrl}/api/invites`, {
      method: 'POST', headers: comToken(alfaOwnerToken), body: { role: 'owner' }
    });
    assert.equal(status, 201);
  });

  it('recusa validade fora da faixa', async () => {
    for (const ttlMs of [60 * 1000, 90 * 24 * 60 * 60 * 1000, -1, 'sempre']) {
      const { status } = await callAs(ALFA, `${panelUrl}/api/invites`, {
        method: 'POST', headers: comToken(alfaAdminToken), body: { role: 'tech', ttlMs }
      });
      assert.equal(status, 400, String(ttlMs));
    }
  });
});

describe('aceitar', () => {
  it('cria a pessoa, o vínculo e já devolve a sessão', async () => {
    const { token } = await convidar(ALFA, alfaAdminToken, { role: 'tech', label: 'novo plantão' });

    const previa = await callAs(ALFA, `${panelUrl}/api/invites/token/preview`, { method: 'POST', body: { token: token } });
    assert.equal(previa.status, 200);
    assert.equal(previa.body.data.tenant.name, 'Provedor Alfa');
    assert.equal(previa.body.data.role, 'tech');

    const { status, body } = await callAs(ALFA, `${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: 'plantao-novo', password: 'senha-do-plantao-1', email: 'plantao-novo@exemplo.test' }
    });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.user.role, 'tech');
    assert.equal(Number(body.data.user.tenantId), Number(alfa));
    assert.ok(body.data.token, 'entra já logada');

    // E a sessão devolvida serve para alguma coisa: um token que o servidor não
    // aceitasse deixaria o teste acima verde e a pessoa de fora.
    const usando = await callAs(ALFA, `${panelUrl}/api/devices/dashboard`, {
      headers: comToken(body.data.token)
    });
    assert.notEqual(usando.status, 401);
    assert.notEqual(usando.status, 403);
  });

  it('anexa quem já existe, e só com a senha que ela já tem', async () => {
    // O caso que a onda 12 não conseguia atender: o consultor que atende dois
    // ISPs. Ninguém aqui escolhe a senha dele.
    const { token } = await convidar(BETA, betaOwnerToken, { role: 'viewer' });

    const errada = await callAs(BETA, `${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: 'plantao-novo', password: 'chute-errado-1', email: 'plantao-novo@exemplo.test' }
    });
    assert.equal(errada.status, 401, 'sem a senha, não entra');
    // E o convite continua de pé: uma tentativa errada não pode queimá-lo, ou
    // qualquer um com o link derrubaria o convite de quem foi convidado.
    assert.equal((await callAs(BETA, `${panelUrl}/api/invites/token/preview`, { method: 'POST', body: { token: token } })).status, 200);

    const certa = await callAs(BETA, `${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: 'plantao-novo', password: 'senha-do-plantao-1', email: 'plantao-novo@exemplo.test' }
    });
    assert.equal(certa.status, 201, JSON.stringify(certa.body));
    assert.equal(Number(certa.body.data.user.tenantId), Number(beta));
    assert.equal(certa.body.data.user.role, 'viewer');

    // Uma pessoa, dois provedores, dois papéis — que é o arranjo que
    // `tenant_users` existe para permitir.
    const pessoa = await getDb()('users').where({ username: 'plantao-novo' }).first();
    const vinculos = await getDb()('tenant_users').where({ user_id: pessoa.id }).orderBy('id');
    assert.equal(vinculos.length, 2);
    assert.deepEqual(vinculos.map((v) => v.role), ['tech', 'viewer']);
  });

  it('não anexa duas vezes', async () => {
    const { token } = await convidar(BETA, betaOwnerToken, { role: 'admin' });
    const { status } = await callAs(BETA, `${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: 'plantao-novo', password: 'senha-do-plantao-1', email: 'plantao-novo@exemplo.test' }
    });
    assert.equal(status, 409);
  });

  /**
   * Dois cliques ao mesmo tempo, e é aqui que o uso único é decidido de fato.
   *
   * Os casos sequenciais acima passam sem o WHERE condicional do UPDATE: quem
   * lê o convite já o encontra aceito e para em `isOpen`. O que só este caso
   * alcança é a janela entre ler e escrever — as duas requisições leem o
   * convite aberto, as duas passam pelo `if`, e o que separa uma da outra é o
   * banco dizendo a uma delas que nenhuma linha casou.
   *
   * Sem o WHERE, as duas viram 201 e o provedor ganha dois operadores de um
   * convite só. Foi reproduzido tirando `whereNull('accepted_at')` de
   * `markAccepted` — **mas só em PostgreSQL e MySQL**. Em SQLite o driver é
   * síncrono e serializa as duas requisições, então a janela não chega a abrir
   * e o caso fica verde mesmo com a proteção fora. Vale escrever porque a
   * conclusão preguiçosa é a oposta: rodando só o padrão local, este teste
   * pareceria não provar nada, e alguém o apagaria por isso. Ele prova; é o
   * dialeto que esconde.
   */
  it('atende um clique só quando dois chegam juntos', async () => {
    const { token } = await convidar(ALFA, alfaAdminToken);
    const respostas = await Promise.all([
      callAs(ALFA, `${panelUrl}/api/invites/token/accept`, {
        method: 'POST', body: { token: token, username: 'corrida-um', password: 'senha-corrida-1', email: 'corrida-um@exemplo.test' }
      }),
      callAs(ALFA, `${panelUrl}/api/invites/token/accept`, {
        method: 'POST', body: { token: token, username: 'corrida-dois', password: 'senha-corrida-2', email: 'corrida-dois@exemplo.test' }
      })
    ]);

    const criados = respostas.filter((r) => r.status === 201);
    assert.equal(criados.length, 1, respostas.map((r) => r.status).join(' e '));

    const vinculos = await getDb()('tenant_users')
      .join('users', 'users.id', 'tenant_users.user_id')
      .whereIn('users.username', ['corrida-um', 'corrida-dois']);
    assert.equal(vinculos.length, 1, 'um convite, um vínculo');

    // E quem perdeu a corrida não pode ter sobrado em `users`. É esta linha, e
    // não o `if` sequencial mais abaixo, que cobra a transação: quem perde já
    // criou a pessoa quando o UPDATE recusa, e sem o rollback ela fica com o
    // nome tomado para sempre e nenhum provedor a que pertencer. Ninguém veria
    // — a resposta é 404 de qualquer jeito. Tirando a transação do
    // controlador, é esta asserção que fica vermelha, e de novo só em
    // PostgreSQL e MySQL, pelo mesmo motivo do parágrafo acima.
    const pessoas = await getDb()('users')
      .whereIn('username', ['corrida-um', 'corrida-dois']);
    assert.equal(pessoas.length, 1, 'quem perdeu a corrida não pode sobrar em users');
  });

  it('não deixa a pessoa criada sobrar quando o convite já foi usado', async () => {
    const { token } = await convidar(ALFA, alfaAdminToken);
    const primeira = await callAs(ALFA, `${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: 'primeiro-a-clicar', password: 'senha-primeira-1', email: 'primeiro-a-clicar@exemplo.test' }
    });
    assert.equal(primeira.status, 201);

    const segunda = await callAs(ALFA, `${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: 'segundo-a-clicar', password: 'senha-segunda-1', email: 'segundo-a-clicar@exemplo.test' }
    });
    assert.equal(segunda.status, 404);

    // Aqui o segundo nem chega a criar a pessoa: `usableInvite` encontra o
    // convite já aceito e recusa antes disso. É esse curto-circuito que este
    // caso fixa — quem "otimizar" o `isOpen` para fora encontra este vermelho,
    // e não o do controlador, que responderia 404 do mesmo jeito depois de já
    // ter escrito. O que a transação compra é a corrida, e está provado no caso
    // acima, não neste.
    const orfa = await getDb()('users').where({ username: 'segundo-a-clicar' }).first();
    assert.equal(orfa, undefined, 'a pessoa não pode sobrar sem vínculo');
  });
});

describe('as cinco maneiras de um convite não servir', () => {
  /**
   * Todas respondem a MESMA coisa, byte a byte. Dois 404 com corpos diferentes
   * não são um 404: viram um oráculo — "este token existiu", "este provedor tem
   * convite em aberto" — para quem chegou sem credencial nenhuma.
   */
  const corpos = new Map();

  async function registrar(nome, token, host = ALFA) {
    const previa = await callAs(host, `${panelUrl}/api/invites/token/preview`, { method: 'POST', body: { token: token } });
    const aceite = await callAs(host, `${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: 'alguem-de-fora', password: 'senha-de-fora-1', email: 'alguem-de-fora@exemplo.test' }
    });
    assert.equal(previa.status, 404, `${nome}: prévia`);
    assert.equal(aceite.status, 404, `${nome}: aceite`);
    corpos.set(nome, { previa: previa.raw, aceite: aceite.raw });
  }

  it('token que nunca existiu', async () => {
    await registrar('inexistente', 'f'.repeat(64));
  });

  it('convite expirado', async () => {
    const { token, id } = await convidar(ALFA, alfaAdminToken);
    await getDb()('tenant_invites').where({ id }).update({ expires_at: new Date(Date.now() - 1000) });
    await registrar('expirado', token);
  });

  it('convite revogado', async () => {
    const { token, id } = await convidar(ALFA, alfaAdminToken);
    const revoga = await callAs(ALFA, `${panelUrl}/api/invites/${id}`, {
      method: 'DELETE', headers: comToken(alfaAdminToken)
    });
    assert.equal(revoga.status, 200);
    await registrar('revogado', token);
  });

  it('convite já aceito', async () => {
    const { token } = await convidar(ALFA, alfaAdminToken);
    const aceite = await callAs(ALFA, `${panelUrl}/api/invites/token/accept`, {
      method: 'POST', body: { token: token, username: 'ja-aceitou', password: 'senha-aceita-1', email: 'ja-aceitou@exemplo.test' }
    });
    assert.equal(aceite.status, 201);
    await registrar('aceito', token);
  });

  it('convite do alfa aberto no endereço do beta', async () => {
    // O convite é válido — só não é deste host. Sem esta conferência a pessoa
    // entraria pelo endereço errado, e num deploy com subdomínio é assim que
    // começa uma sessão no host de outro provedor.
    const { token } = await convidar(ALFA, alfaAdminToken);
    await registrar('host errado', token, BETA);
    // E continua servindo no endereço certo, que é o que separa "recusado aqui"
    // de "quebrado".
    assert.equal((await callAs(ALFA, `${panelUrl}/api/invites/token/preview`, { method: 'POST', body: { token: token } })).status, 200);
  });

  it('e as cinco respondem exatamente a mesma coisa', () => {
    const nomes = [...corpos.keys()];
    assert.equal(nomes.length, 5, `faltou registrar algum caso: ${nomes.join(', ')}`);
    const [primeiro, ...resto] = nomes;
    for (const nome of resto) {
      assert.equal(corpos.get(nome).previa, corpos.get(primeiro).previa,
        `prévia de "${nome}" difere de "${primeiro}"`);
      assert.equal(corpos.get(nome).aceite, corpos.get(primeiro).aceite,
        `aceite de "${nome}" difere de "${primeiro}"`);
    }
  });
});

describe('o convite do vizinho', () => {
  it('não aparece na lista do outro provedor', async () => {
    await convidar(ALFA, alfaAdminToken, { role: 'tech', label: 'contratacao-do-alfa' });
    const { body } = await callAs(BETA, `${panelUrl}/api/invites`, {
      headers: comToken(betaOwnerToken)
    });
    const rotulos = body.data.invites.map((convite) => convite.label);
    assert.equal(rotulos.includes('contratacao-do-alfa'), false,
      'quem o vizinho está tentando contratar não é da conta deste provedor');
  });

  it('não é revogável pelo id, e responde 404 e não 403', async () => {
    const { id } = await convidar(ALFA, alfaAdminToken);
    const { status } = await callAs(BETA, `${panelUrl}/api/invites/${id}`, {
      method: 'DELETE', headers: comToken(betaOwnerToken)
    });
    assert.equal(status, 404);
    assert.notEqual(status, 403);

    // E continua de pé: um 404 devolvido depois de revogar seria o pior dos
    // dois mundos, e nenhum código de status revela isso.
    const linha = await getDb()('tenant_invites').where({ id }).first();
    assert.equal(linha.revoked_at, null);
  });

  it('mas o próprio provedor revoga o mesmo id', async () => {
    // O controle do caso acima: sem ele, um id inexistente daria o mesmo 404.
    const { id } = await convidar(ALFA, alfaAdminToken);
    const { status } = await callAs(ALFA, `${panelUrl}/api/invites/${id}`, {
      method: 'DELETE', headers: comToken(alfaAdminToken)
    });
    assert.equal(status, 200);
  });
});

describe('quem pode convidar', () => {
  it('recusa quem não administra a equipe', async () => {
    await criarOperador(alfa, 'tecnico-do-alfa', 'senha-do-tecnico-1', 'tech');
    const token = await entrar(ALFA, 'tecnico-do-alfa', 'senha-do-tecnico-1');

    const criar = await callAs(ALFA, `${panelUrl}/api/invites`, {
      method: 'POST', headers: comToken(token), body: { role: 'viewer' }
    });
    assert.equal(criar.status, 403);
    assert.equal(criar.body.code, 'missing_permission');

    const listar = await callAs(ALFA, `${panelUrl}/api/invites`, { headers: comToken(token) });
    assert.equal(listar.status, 403);
  });

  it('mas o administrador do mesmo provedor consegue as duas', async () => {
    // O par obrigatório: sem ele o 403 acima passaria por rota errada ou token
    // inválido.
    assert.equal((await callAs(ALFA, `${panelUrl}/api/invites`, {
      headers: comToken(alfaAdminToken)
    })).status, 200);
  });
});

describe('a linha guardada', () => {
  it('só é encontrada pelo digest, nunca pelo valor', async () => {
    const { token } = await convidar(ALFA, alfaAdminToken);
    // Semeado direto, sem passar pelo modelo: a busca por token é justamente o
    // que está sob teste, e semear por ela provaria a coisa por si mesma.
    const idPlantado = await runInTenant(alfa, () => tinsertReturningId('tenant_invites', {
      token_hash: 'nao-e-um-digest-de-nada',
      role: 'viewer',
      expires_at: new Date(Date.now() + 60_000)
    }));
    assert.ok(idPlantado);

    assert.equal(await TenantInvite.findByToken('nao-e-um-digest-de-nada'), null,
      'o valor cru da coluna não pode servir como token');
    const achado = await TenantInvite.findByToken(token);
    assert.ok(achado, 'o token de verdade acha a linha');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O token não pode viajar no caminho
//
// O `requestLogger` corta a query string — e o comentário de lá diz por quê,
// "a query é onde quem chama põe um token" — mas grava o CAMINHO inteiro. Com
// o token num parâmetro de rota, ele ia para o log do painel, para o
// `errorHandler` e para qualquer access log de proxy na frente, em toda
// consulta e todo aceite.
//
// E este token É a credencial: quem o tem entra na equipe do provedor com o
// papel escrito nele, até `owner`, por trinta dias. O resto do sistema o trata
// assim — hash na tabela, token fora da trilha, link entregue no FRAGMENTO da
// URL justamente para não chegar a servidor nenhum.
// ─────────────────────────────────────────────────────────────────────────────
describe('por onde o token do convite viaja', () => {
  it('as duas rotas não têm parâmetro nenhum no caminho', async () => {
    const { listRoutes } = await import('./helpers/routeInventory.js');
    const doConvite = listRoutes().filter((r) => r.path.includes('/invites/token'));

    assert.equal(doConvite.length, 2, 'esperava a prévia e o aceite');
    for (const rota of doConvite) {
      // Um `:` no caminho é um segredo indo para o log.
      assert.ok(!rota.path.includes(':'), `${rota.path} ainda carrega o token no caminho`);
      // E as duas são POST, porque é o corpo que carrega o token agora — a
      // prévia inclusive, apesar de não escrever nada.
      assert.equal(rota.method, 'POST', rota.path);
    }
  });

  it('o token no corpo continua valendo, e o caminho sem ele não serve', async () => {
    const { token } = await convidar(ALFA, alfaAdminToken, { role: 'tech' });

    // Sem token no corpo: 404, a mesma resposta de um convite que não existe.
    const semToken = await callAs(ALFA, `${panelUrl}/api/invites/token/preview`, {
      method: 'POST', body: {}
    });
    assert.equal(semToken.status, 404);

    // Com o token no corpo: funciona.
    const comToken = await callAs(ALFA, `${panelUrl}/api/invites/token/preview`, {
      method: 'POST', body: { token }
    });
    assert.equal(comToken.status, 200);
    assert.equal(comToken.body.data.role, 'tech');
  });
});
