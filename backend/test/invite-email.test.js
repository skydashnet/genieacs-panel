import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O convite indo por e-mail — e continuando a existir quando não vai.
 *
 * Duas coisas que este arquivo guarda, e a segunda importa mais que a primeira:
 *
 * 1. com transporte configurado, a mensagem sai, com o link e sem nada além do
 *    que o convidado precisa saber;
 * 2. **sem transporte, ou com o SMTP fora do ar, o convite existe do mesmo
 *    jeito** e o link sai na resposta. O e-mail é comodidade; o link sempre foi
 *    o mecanismo, e um servidor de correio quebrado não pode transformar
 *    "convidei alguém" em erro.
 *
 * O SMTP é um de mentira, em processo: fala o mínimo do protocolo e guarda o
 * que recebeu. Nada sai desta máquina.
 */
process.env.PUBLIC_BASE_URL = 'https://painel.exemplo.test';

const { call, authHeaders, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const { resetMailTransport, mailConfigured, panelUrlFor } = await import('../src/services/mail/index.js');

let panelUrl;
let token;
let smtp;
let recebidas;
let smtpPort;

before(async () => {
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  smtpPort = smtp.address().port;

  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'dona', password: 'senha-da-dona-1', email: 'dona@exemplo.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  token = setup.body.data.token;
});

after(async () => {
  resetMailTransport();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  await stopTestServers();
  await new Promise((resolve) => smtp.close(resolve));
});

function ligarSmtp() {
  process.env.SMTP_URL = `smtp://usuario:senha@127.0.0.1:${smtpPort}?ignoreTLS=true`;
  process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
  resetMailTransport();
}

function desligarSmtp() {
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  resetMailTransport();
}

const convidar = (body) => call(`${panelUrl}/api/invites`, {
  method: 'POST', headers: authHeaders(token), body
});

describe('sem transporte configurado', () => {
  it('o painel diz que não há para onde mandar', () => {
    desligarSmtp();
    assert.equal(mailConfigured(), false);
  });

  it('o convite existe, com o link na resposta e sem e-mail', async () => {
    desligarSmtp();
    const { status, body } = await convidar({ role: 'tech', email: 'colega@exemplo.test' });
    assert.equal(status, 201, JSON.stringify(body));
    assert.match(body.data.token, /^[0-9a-f]{64}$/);
    assert.equal(body.data.emailed, false);
    assert.equal(recebidas.length, 0);
  });
});

describe('com transporte configurado', () => {
  it('manda o link para quem foi convidado', async () => {
    ligarSmtp();
    recebidas.length = 0;
    assert.equal(mailConfigured(), true, 'o transporte tem que estar ligado aqui');
    const { status, body } = await convidar({ role: 'tech', email: 'colega@exemplo.test' });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.emailed, true, JSON.stringify(body.data));
    assert.equal(recebidas.length, 1);

    const mensagem = recebidas[0];
    assert.match(mensagem, /To: colega@exemplo\.test/);
    assert.match(mensagem, /From: TR69 Controle <nao-responda@exemplo\.test>/);

    // O corpo vem em quoted-printable, que é como um `#` e uma linha longa
    // atravessam SMTP. Decodificado, o link tem que estar inteiro.
    const corpo = decodificarQuotedPrintable(mensagem);
    assert.ok(
      corpo.includes(`https://painel.exemplo.test/invite#${body.data.token}`),
      `o link com o token tem que estar na mensagem:\n${corpo}`
    );

    // E nada além do que o convidado precisa: sem nome de operador, sem
    // contagem de assinantes, sem nada que faça de uma caixa de entrada alheia
    // um lugar onde mora dado do provedor.
    assert.doesNotMatch(corpo, /dona@exemplo\.test/);
    assert.doesNotMatch(corpo, /\bdona\b/);
  });

  it('não manda nada quando ninguém deu um endereço', async () => {
    ligarSmtp();
    recebidas.length = 0;
    const { status, body } = await convidar({ role: 'viewer' });
    assert.equal(status, 201);
    assert.equal(body.data.emailed, false);
    assert.equal(recebidas.length, 0);
  });

  it('recusa um endereço inválido ANTES de criar o convite', async () => {
    ligarSmtp();
    const { getDb } = await import('./helpers/harness.js');
    const antes = Number((await getDb()('tenant_invites').count({ n: '*' }).first()).n);
    const { status } = await convidar({ role: 'tech', email: 'nao-e-endereco' });
    assert.equal(status, 400);
    const depois = Number((await getDb()('tenant_invites').count({ n: '*' }).first()).n);
    assert.equal(depois, antes, 'um erro de digitação não pode deixar convite órfão');
  });

  it('o convite sobrevive ao SMTP fora do ar', async () => {
    // Uma porta onde não há ninguém: o envio falha, e é só o envio que falha.
    process.env.SMTP_URL = 'smtp://usuario:senha@127.0.0.1:1?ignoreTLS=true&connectionTimeout=300';
    process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
    resetMailTransport();

    const { status, body } = await convidar({ role: 'tech', email: 'colega2@exemplo.test' });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.data.emailed, false);
    // E o link continua ali, que é o que quem convidou usa quando o e-mail não vai.
    assert.match(body.data.token, /^[0-9a-f]{64}$/);
  });
});

describe('o endereço externo do painel', () => {
  it('vem de PUBLIC_BASE_URL quando não há domínio-base', () => {
    assert.equal(panelUrlFor({ slug: 'qualquer' }), 'https://painel.exemplo.test');
  });

  it('é nulo quando ninguém disse qual é, e aí não há link para mandar', () => {
    const antes = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      assert.equal(panelUrlFor({ slug: 'qualquer' }), null);
    } finally {
      process.env.PUBLIC_BASE_URL = antes;
    }
  });

  it('recusa o que não é um endereço http', () => {
    const antes = process.env.PUBLIC_BASE_URL;
    try {
      process.env.PUBLIC_BASE_URL = 'javascript:alert(1)';
      assert.equal(panelUrlFor({ slug: 'q' }), null);
      process.env.PUBLIC_BASE_URL = 'nao é url';
      assert.equal(panelUrlFor({ slug: 'q' }), null);
    } finally {
      process.env.PUBLIC_BASE_URL = antes;
    }
  });
});
