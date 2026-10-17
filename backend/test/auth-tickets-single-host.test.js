import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Os bilhetes de e-mail num deploy hospedado de HOST ÚNICO.
 *
 * `password-reset.test.js` guarda o cerco da redefinição com domínio-base — o
 * arranjo em que cada provedor tem o seu subdomínio e o host nomeia de quem é
 * o bilhete. Este arquivo guarda o outro arranjo, que existe, é suportado de
 * propósito, e estava quebrado: SaaS sem `TENANT_BASE_DOMAIN`, todos os
 * provedores no mesmo endereço, a separação vindo do login.
 *
 * Lá o host nomeia o provedor; aqui não nomeia ninguém, e o resolvedor devolve
 * o PRIMEIRO provedor da tabela para toda requisição anônima. Três rotas
 * tomavam esse primeiro como se fosse o provedor certo:
 *
 * - `POST /api/auth/password-reset` conferia o vínculo contra ele, então
 *   "esqueci minha senha" não fazia NADA para quem trabalha em qualquer outro
 *   provedor — e em silêncio, porque a rota responde igual sempre;
 * - os dois `confirm` resgatavam o bilhete filtrando por ele, então o link
 *   cunhado para outro provedor morria com 404.
 *
 * É a mesma forma do bug que o #96 consertou na personificação: comparar com
 * `req.tenantId` onde se devia comparar com `req.hostTenantId` — o campo que só
 * existe quando o host NOMEOU um provedor.
 *
 * O SMTP é de mentira e em processo: o link É a credencial, e nada sai desta
 * máquina. `Host` é header proibido no `fetch`, daí o `http.request` cru.
 */
process.env.EDITION = 'saas';
delete process.env.TENANT_BASE_DOMAIN;
delete process.env.PORTAL_BASE_DOMAIN;
// Sem domínio-base não há subdomínio de onde deduzir o endereço do painel, e é
// daqui que o link da mensagem sai. Um deploy de host único que não declara
// isto não manda bilhete nenhum — para ninguém, nem para o primeiro provedor.
process.env.PUBLIC_BASE_URL = 'https://painel.test';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const { runInTenant } = await import('../src/config/tenantContext.js');
const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const {
  authLimiter, authTicketRedeemLimiter, emailChangeLimiter, passwordResetLimiter
} = await import('../src/middleware/rateLimit.js');

function call(url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
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
let smtp;
let recebidas;
/** O provedor que o host resolve, por ser o primeiro da tabela. */
let primeiro;
/** O provedor de quem só o login sabe. */
let segundo;
let doSegundoId;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const api = (path, options) => call(`${panelUrl}${path}`, options);

/**
 * Zera os baldes entre as provas.
 *
 * Sem host que nomeie provedor, a chave do limitador é a do provedor resolvido
 * — o primeiro — mais o IP. Cinco pedidos de redefinição por quarto de hora
 * acabam antes das provas deste arquivo.
 */
async function esvaziarBaldes() {
  for (const slug of ['default', 'segundo']) {
    const chave = `${slug}|127.0.0.1`;
    await authLimiter.resetKey(chave);
    await passwordResetLimiter.resetKey(chave);
    await emailChangeLimiter.resetKey(chave);
    await authTicketRedeemLimiter.resetKey(chave);
  }
}

beforeEach(esvaziarBaldes);

function ultimaMensagem() {
  assert.ok(recebidas.length > 0, 'nenhuma mensagem chegou ao SMTP');
  return decodificarQuotedPrintable(recebidas[recebidas.length - 1]);
}

function bilheteDaMensagem(rota) {
  const achado = ultimaMensagem().match(new RegExp(`${rota}#([0-9a-f]{64})`));
  assert.ok(achado, `a mensagem não traz um link de ${rota}:\n${ultimaMensagem()}`);
  return achado[1];
}

before(async () => {
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtp.address().port}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
  const { resetMailTransport } = await import('../src/services/mail/index.js');
  resetMailTransport();

  ({ panelUrl } = await startTestServers());
  const db = getDb();

  primeiro = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'segundo', name: 'Provedor Segundo', status: 'active' });
  segundo = (await db('tenants').where({ slug: 'segundo' }).first()).id;
  assert.notEqual(primeiro, segundo);

  const setup = await api('/api/auth/setup', {
    method: 'POST',
    body: { username: 'dona', password: 'senha-da-dona-1', email: 'dona@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));

  // Alguém que trabalha SÓ no segundo provedor, com endereço já provado. É a
  // fixture inteira: tudo que este arquivo mede acontece com ela.
  const bcrypt = (await import('bcryptjs')).default;
  doSegundoId = await runInTenant(segundo, () => User.create({
    username: 'do-segundo',
    email: 'do-segundo@exemplo.test',
    password: bcrypt.hashSync('senha-do-segundo-1', 10),
    role: 'admin'
  }));
  await runInTenant(segundo, () => TenantUser.create({
    tenantId: segundo, userId: doSegundoId, role: 'admin'
  }));
  await User.markEmailVerified(doSegundoId, 'do-segundo@exemplo.test');
});

after(async () => {
  const { resetMailTransport } = await import('../src/services/mail/index.js');
  resetMailTransport();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  await stopTestServers();
  await new Promise((resolve) => smtp.close(resolve));
});

describe('redefinição de senha num deploy de host único', () => {
  it('manda o link para quem trabalha em outro provedor que não o primeiro', async () => {
    recebidas.length = 0;
    const { status, body } = await api('/api/auth/password-reset', {
      method: 'POST', body: { identifier: 'do-segundo' }
    });

    // A resposta é a mesma sempre — é o que impede a rota de virar oráculo —,
    // então o que prova a correção é a mensagem ter saído.
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(recebidas.length, 1, 'nenhuma mensagem saiu para quem não é do primeiro provedor');
    assert.match(ultimaMensagem(), /do-segundo@exemplo\.test/);
  });

  it('arquiva o pedido na trilha do provedor da pessoa, não na do endereço', async () => {
    recebidas.length = 0;
    await api('/api/auth/password-reset', { method: 'POST', body: { identifier: 'do-segundo' } });

    const noSegundo = await runInTenant(segundo, () => AuditLog.list({ limit: 20 }));
    const linha = (noSegundo.items ?? noSegundo).find(
      (l) => l.action === AuditLog.ACTIONS.PASSWORD_RESET_REQUESTED
    );
    assert.ok(linha, 'o pedido não apareceu na trilha do provedor da pessoa');

    const noPrimeiro = await runInTenant(primeiro, () => AuditLog.list({ limit: 20 }));
    const vazada = (noPrimeiro.items ?? noPrimeiro).find(
      (l) => l.action === AuditLog.ACTIONS.PASSWORD_RESET_REQUESTED
    );
    assert.equal(vazada, undefined, 'a linha caiu na trilha do provedor errado');
  });

  it('o link cunhado para outro provedor é resgatável no host único', async () => {
    recebidas.length = 0;
    await api('/api/auth/password-reset', { method: 'POST', body: { identifier: 'do-segundo' } });
    const bilhete = bilheteDaMensagem('/reset-password');

    const trocada = await api('/api/auth/password-reset/confirm', {
      method: 'POST', body: { token: bilhete, password: 'senha-nova-do-segundo-1' }
    });
    assert.equal(trocada.status, 200, JSON.stringify(trocada.body));

    // E a senha nova é a que entra.
    await esvaziarBaldes();
    const entrou = await api('/api/auth/login', {
      method: 'POST', body: { username: 'do-segundo', password: 'senha-nova-do-segundo-1' }
    });
    assert.equal(entrou.status, 200, JSON.stringify(entrou.body));
    assert.equal(entrou.body.data.user.tenantId, segundo);
  });
});

describe('verificação de e-mail num deploy de host único', () => {
  it('confirma o endereço de quem não é do primeiro provedor', async () => {
    // Tira o carimbo para haver o que provar, e entra para pedir a prova — a
    // cunhagem é autenticada, e é o token que nomeia o provedor ali.
    await getDb()('users').where({ id: doSegundoId }).update({ email_verified_at: null });
    await esvaziarBaldes();
    const entrou = await api('/api/auth/login', {
      method: 'POST', body: { username: 'do-segundo', password: 'senha-nova-do-segundo-1' }
    });
    assert.equal(entrou.status, 200, JSON.stringify(entrou.body));

    recebidas.length = 0;
    const pedido = await api('/api/auth/email/verify', {
      method: 'POST', headers: bearer(entrou.body.data.token)
    });
    assert.equal(pedido.status, 200, JSON.stringify(pedido.body));

    const confirmado = await api('/api/auth/email/verify/confirm', {
      method: 'POST', body: { token: bilheteDaMensagem('/verify-email') }
    });
    assert.equal(confirmado.status, 200, JSON.stringify(confirmado.body));
    assert.equal(confirmado.body.data.email, 'do-segundo@exemplo.test');
  });
});
