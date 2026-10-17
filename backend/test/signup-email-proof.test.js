import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A prova do endereço do dono, mandada no ato do cadastro — e a poda que ela
 * torna obrigatória.
 *
 * O e-mail do dono é o único que se tem de um provedor novo: por ele vão a
 * cobrança, o aviso de vencimento e a redefinição de senha, que desde os
 * bilhetes só sai para endereço PROVADO. Um cadastro que nasce sem provar nada
 * é um cliente que, no dia em que esquecer a senha, não tem por onde voltar.
 *
 * A segunda metade deste arquivo é a consequência menos óbvia: `signup` é uma
 * rota PÚBLICA, então cunhar um bilhete ali põe uma linha em `auth_tickets`
 * por estranho que apertar "cadastrar". Os dois `prune` existiam, testados, e
 * sem um único chamador.
 *
 * SaaS com subdomínio porque o cadastro só existe onde há endereço para
 * entregar. SMTP de mentira e em processo — o link É uma credencial.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const { default: AuthTicket } = await import('../src/models/AuthTicket.js');
const { default: ImpersonationTicket } = await import('../src/models/ImpersonationTicket.js');
const { default: SchedulerService } = await import('../src/services/schedulerService.js');
const { resetMailTransport } = await import('../src/services/mail/index.js');
const { authLimiter } = await import('../src/middleware/rateLimit.js');

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
let smtp;
let recebidas;

const CASA = 'default.painel.test';
const casa = (path, options) => callAs(CASA, `${panelUrl}${path}`, options);

let contador = 0;
const cadastro = () => {
  contador += 1;
  return {
    providerName: `ISP ${contador}`,
    slug: `isp-${contador}`,
    username: `dono-${contador}`,
    password: 'senha-do-dono-1',
    email: `dono-${contador}@exemplo.test`
  };
};

before(async () => {
  ({ panelUrl } = await startTestServers());
  await casa('/api/auth/setup', {
    method: 'POST',
    body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtp.address().port}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'painel@exemplo.test';
  resetMailTransport();
});

after(async () => {
  resetMailTransport();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  await new Promise((resolve) => smtp.close(resolve));
  await stopTestServers();
});

beforeEach(async () => {
  recebidas.length = 0;
  await authLimiter.resetKey('default|127.0.0.1');
});

describe('o cadastro manda a prova do endereço', () => {
  it('cunha um bilhete de verificação para o dono e diz que mandou', async () => {
    const corpo = cadastro();
    const res = await casa('/api/auth/signup', { method: 'POST', body: corpo });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.emailed, true, 'a resposta tem que dizer se a prova saiu');

    const db = getDb();
    const tenant = await db('tenants').where({ slug: corpo.slug }).first();
    const pessoa = await db('users').where({ username: corpo.username }).first();
    const bilhete = await db('auth_tickets').where({ user_id: pessoa.id }).first();

    assert.ok(bilhete, 'o cadastro tem que deixar um bilhete de verificação');
    assert.equal(bilhete.purpose, AuthTicket.PURPOSES.EMAIL_VERIFICATION);
    assert.equal(bilhete.email, corpo.email);
    // O provedor do bilhete é o que ACABOU de nascer, não o que hospeda a tela
    // de cadastro. No apex `req.tenantId` é nulo e num host de provedor é o
    // outro — é a armadilha inteira desta rota.
    assert.equal(Number(bilhete.tenant_id), Number(tenant.id));
  });

  it('e o link aponta para o painel DELE, não para o de quem serviu a tela', async () => {
    const corpo = cadastro();
    await casa('/api/auth/signup', { method: 'POST', body: corpo });
    const mensagem = decodificarQuotedPrintable(recebidas[recebidas.length - 1]);
    const achado = mensagem.match(/https:\/\/([a-z0-9-]+)\.painel\.test\/verify-email#([0-9a-f]{64})/);
    assert.ok(achado, `a mensagem não traz o link de verificação:\n${mensagem}`);
    assert.equal(achado[1], corpo.slug);
  });

  it('o endereço nasce por provar, e só a visita ao link o carimba', async () => {
    const corpo = cadastro();
    await casa('/api/auth/signup', { method: 'POST', body: corpo });
    const pessoa = await getDb()('users').where({ username: corpo.username }).first();
    assert.equal(pessoa.email_verified_at, null);

    const mensagem = decodificarQuotedPrintable(recebidas[recebidas.length - 1]);
    const token = mensagem.match(/\/verify-email#([0-9a-f]{64})/)[1];
    const confirmado = await callAs(`${corpo.slug}.painel.test`, `${panelUrl}/api/auth/email/verify/confirm`, {
      method: 'POST', body: { token }
    });
    assert.equal(confirmado.status, 200, JSON.stringify(confirmado.body));
    const depois = await getDb()('users').where({ id: pessoa.id }).first();
    assert.ok(depois.email_verified_at, 'a visita ao link tinha que carimbar');
  });

  /**
   * A regra que impede o transporte de e-mail de virar requisito. `SMTP_URL` é
   * opcional e está escrito assim no runbook; um deploy SaaS sem ele tem que
   * continuar aceitando cadastro. O que muda é a resposta DIZER que não foi,
   * para a tela pedir a prova depois, de dentro do painel.
   */
  it('e sem transporte de e-mail o cadastro passa igual, dizendo que não mandou', async () => {
    const antes = process.env.SMTP_URL;
    delete process.env.SMTP_URL;
    resetMailTransport();
    try {
      const corpo = cadastro();
      const res = await casa('/api/auth/signup', { method: 'POST', body: corpo });
      assert.equal(res.status, 201, 'um SMTP ausente não pode impedir um ISP de se cadastrar');
      assert.equal(res.body.data.emailed, false);
      const pessoa = await getDb()('users').where({ username: corpo.username }).first();
      assert.ok(pessoa, 'o provedor e o dono nascem do mesmo jeito');
      const bilhete = await getDb()('auth_tickets').where({ user_id: pessoa.id }).first();
      assert.equal(bilhete, undefined, 'sem transporte não se cunha bilhete que ninguém receberia');
    } finally {
      process.env.SMTP_URL = antes;
      resetMailTransport();
    }
  });
});

describe('a poda dos bilhetes, que o cadastro público torna obrigatória', () => {
  it('apaga o bilhete vencido e guarda o que ainda vale', async () => {
    const db = getDb();
    const tenant = await db('tenants').orderBy('id', 'asc').first();
    const pessoa = await db('users').where({ username: 'owner' }).first();

    await db('auth_tickets').insert({
      tenant_id: tenant.id,
      user_id: pessoa.id,
      purpose: AuthTicket.PURPOSES.EMAIL_VERIFICATION,
      email: 'owner@exemplo.test',
      token_hash: 'a'.repeat(64),
      expires_at: new Date(Date.now() - 48 * 60 * 60 * 1000)
    });
    await db('auth_tickets').insert({
      tenant_id: tenant.id,
      user_id: pessoa.id,
      purpose: AuthTicket.PURPOSES.EMAIL_VERIFICATION,
      email: 'owner@exemplo.test',
      token_hash: 'b'.repeat(64),
      expires_at: new Date(Date.now() + 60 * 60 * 1000)
    });

    await SchedulerService.pruneTickets();

    assert.equal(await db('auth_tickets').where({ token_hash: 'a'.repeat(64) }).first(), undefined);
    assert.ok(await db('auth_tickets').where({ token_hash: 'b'.repeat(64) }).first());
  });

  /**
   * Fora do laço por provedor, e é o ponto: as duas tabelas não são escopadas.
   * Dentro do laço seriam varridas inteiras uma vez POR PROVEDOR — trinta
   * varreduras idênticas por dia num deploy com trinta ISPs — e um provedor
   * suspenso, que `forEachTenant` nem visita, nunca teria as dele podadas.
   */
  it('e não depende de estar dentro do escopo de um provedor', async () => {
    const removidos = await AuthTicket.prune();
    assert.equal(typeof removidos, 'number');
    const outros = await ImpersonationTicket.prune();
    assert.equal(typeof outros, 'number');
  });
});
