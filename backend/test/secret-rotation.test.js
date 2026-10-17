import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  asTenant, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: SecretRotationService, SecretUnreadableError } = await import(
  '../src/services/secretRotationService.js'
);
const { createSecretBox, CURRENT_KEY_VERSION, LEGACY_KEY_VERSION } = await import(
  '../src/utils/secretBox.js'
);
const { default: AppState } = await import('../src/models/AppState.js');

/**
 * A rotação da `SECRET_BOX_KEY`, terminável.
 *
 * A metade que já existia mantinha as linhas antigas legíveis enquanto a chave
 * anterior estivesse no ambiente. O que faltava era reescrevê-las — e sem isso
 * o passo natural de "terminar a rotação", limpar `SECRET_BOX_KEY_PREVIOUS` do
 * `.env`, tornava todo segredo não reescrito ilegível em silêncio.
 *
 * O caso que prova o comando é justamente esse: rotaciona, roda, **tira a
 * chave antiga do ambiente** e lê tudo de volta. Antes do comando, essa última
 * leitura devolvia `null`.
 */

const VARS = ['JWT_SECRET', 'SECRET_BOX_KEY', 'JWT_SECRET_PREVIOUS', 'SECRET_BOX_KEY_PREVIOUS'];
const JWT = 'jwt-secret-da-instalacao-longo-o-bastante-para-producao';
const CHAVE_ANTIGA = 'secret-box-key-antiga-longa-o-bastante-para-producao';
const CHAVE_NOVA = 'secret-box-key-nova-longa-o-bastante-para-producao-1';

const PORTAL = 'skygenpanel-customer-portal-password-v1';
const SGP_TOKEN = 'skygenpanel-sgp-token-v1';
const SGP_WEBHOOK = 'skygenpanel-sgp-webhook-secret-v1';

let salvo;
let tenantId;

/** Escreve as colunas cifradas de uma conta de assinante, com a caixa dada. */
async function contaCom(box, senha, sufixo) {
  const cifrado = box.encrypt(senha);
  return asTenant(() => insertReturningId('customer_accounts', {
    tenant_id: tenantId,
    customer_id: `CSG-${sufixo}`,
    device_id: `ONT-${sufixo}`,
    identity_hash: `hash-${sufixo}`,
    software_id: 'V1',
    pppoe_username: `assinante-${sufixo}`,
    active: true,
    password_ciphertext: cifrado.password_ciphertext,
    password_iv: cifrado.password_iv,
    password_tag: cifrado.password_tag,
    password_key_version: cifrado.password_key_version
  }));
}

const contaPorId = (id) => getDb()('customer_accounts').where({ id }).first();

/** O ambiente no estado de rotação: nova viva, antiga só para leitura. */
function emRotacao() {
  process.env.SECRET_BOX_KEY = CHAVE_NOVA;
  process.env.SECRET_BOX_KEY_PREVIOUS = CHAVE_ANTIGA;
}

/** O passo que o README manda dar para terminar: largar a anterior. */
function anteriorRemovida() {
  delete process.env.SECRET_BOX_KEY_PREVIOUS;
}

before(async () => {
  await startTestServers();
  tenantId = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  salvo = Object.fromEntries(VARS.map((nome) => [nome, process.env[nome]]));
  for (const nome of VARS) delete process.env[nome];
  process.env.JWT_SECRET = JWT;
  await getDb()('customer_accounts').del();
});

afterEach(() => {
  for (const nome of VARS) {
    if (salvo[nome] === undefined) delete process.env[nome];
    else process.env[nome] = salvo[nome];
  }
});

describe('a re-cifra move o segredo para a chave viva', () => {
  it('e o segredo continua legível DEPOIS de a chave anterior sair do ambiente', async () => {
    // Escrito com a chave antiga, que é o estado de qualquer instalação que
    // rodou antes da troca.
    process.env.SECRET_BOX_KEY = CHAVE_ANTIGA;
    const id = await contaCom(createSecretBox(PORTAL), 'senha-do-assinante', 'um');

    emRotacao();
    await SecretRotationService.run();

    anteriorRemovida();
    const box = createSecretBox(PORTAL);
    assert.equal(
      box.decrypt(await contaPorId(id)), 'senha-do-assinante',
      'o segredo ficou ilegível quando a chave anterior saiu — que é o desastre inteiro'
    );
  });

  it('e a versão gravada na linha acompanha o ciphertext', async () => {
    process.env.SECRET_BOX_KEY = CHAVE_ANTIGA;
    const id = await contaCom(createSecretBox(PORTAL), 'outra-senha', 'dois');

    emRotacao();
    await SecretRotationService.run();

    const linha = await contaPorId(id);
    assert.equal(Number(linha.password_key_version), CURRENT_KEY_VERSION);
  });

  it('alcança a linha da versão 1, que só abre por JWT_SECRET', async () => {
    // Instalação anterior ao `SECRET_BOX_KEY`: a versão é 1 e a chave vem do
    // `JWT_SECRET`. O passo 0009 não fez backfill de propósito, então há linha
    // com a coluna de versão NULA — e `decrypt` lê isso como versão 1.
    const box = createSecretBox(PORTAL);
    assert.equal(box.keyVersion, LEGACY_KEY_VERSION);
    const id = await contaCom(box, 'senha-antiquissima', 'tres');
    await getDb()('customer_accounts').where({ id }).update({ password_key_version: null });

    emRotacao();
    await SecretRotationService.run();

    anteriorRemovida();
    assert.equal(createSecretBox(PORTAL).decrypt(await contaPorId(id)), 'senha-antiquissima');
  });
});

describe('--dry-run conta e não escreve', () => {
  it('devolve quantos segredos estão em cada versão sem tocar em nada', async () => {
    process.env.SECRET_BOX_KEY = CHAVE_ANTIGA;
    const id = await contaCom(createSecretBox(PORTAL), 'intocada', 'quatro');
    const antes = await contaPorId(id);

    emRotacao();
    const resumo = await SecretRotationService.run({ dryRun: true });

    assert.equal(resumo.reescritas, 0);
    assert.ok(resumo.versoes[CURRENT_KEY_VERSION] >= 1, 'não contou o segredo que existe');
    const depois = await contaPorId(id);
    assert.equal(depois.password_ciphertext, antes.password_ciphertext, 'reescreveu no dry-run');
  });
});

describe('o segredo ilegível para tudo em vez de ser marcado como migrado', () => {
  it('levanta, e não trata o null do decrypt como "nada a fazer"', async () => {
    // O caso que decide se este comando presta. `decrypt` devolve null tanto
    // para "não havia segredo" quanto para "não tenho a chave" — e tratar os
    // dois igual marcaria como migrada justamente a linha que ficou ilegível.
    process.env.SECRET_BOX_KEY = 'uma-chave-que-ninguem-mais-tem-longa-o-bastante';
    const id = await contaCom(createSecretBox(PORTAL), 'perdida', 'cinco');

    // Rotação SEM pôr a chave que escreveu em `*_PREVIOUS`: o erro humano que
    // este comando tem que recusar em vez de consumar.
    process.env.SECRET_BOX_KEY = CHAVE_NOVA;
    delete process.env.SECRET_BOX_KEY_PREVIOUS;

    await assert.rejects(() => SecretRotationService.run(), SecretUnreadableError);

    const linha = await contaPorId(id);
    assert.equal(linha.password_ciphertext !== null, true, 'apagou o que não sabia ler');
  });
});

describe('o blob de app_state, onde dois segredos dividem a mesma chave', () => {
  it('re-cifra os dois com as caixas certas e preserva o `v` do envelope', async () => {
    process.env.SECRET_BOX_KEY = CHAVE_ANTIGA;
    const tokenBox = createSecretBox(SGP_TOKEN);
    const webhookBox = createSecretBox(SGP_WEBHOOK);
    await runInTenant(tenantId, () => AppState.upsert('sgp_integration_config', JSON.stringify({
      enabled: true,
      baseUrl: 'https://sgp.exemplo.test',
      token: { v: 1, ...tokenBox.encrypt('token-do-erp') },
      webhookSecret: { v: 1, ...webhookBox.encrypt('segredo-do-webhook') }
    })));

    emRotacao();
    await SecretRotationService.run();

    anteriorRemovida();
    const guardado = JSON.parse(await runInTenant(tenantId, () => AppState.get('sgp_integration_config')));

    // As caixas certas: re-cifrar os dois com a mesma destruiria um deles, sem
    // erro e sem volta.
    assert.equal(createSecretBox(SGP_TOKEN).decrypt(guardado.token), 'token-do-erp');
    assert.equal(
      createSecretBox(SGP_WEBHOOK).decrypt(guardado.webhookSecret), 'segredo-do-webhook'
    );
    // `v` é a versão do FORMATO do envelope, não da chave. Perdê-lo mudaria em
    // silêncio o contrato que os serviços leem.
    assert.equal(guardado.token.v, 1);
    assert.equal(guardado.webhookSecret.v, 1);
    // E o resto do objeto não é problema desta rotação.
    assert.equal(guardado.baseUrl, 'https://sgp.exemplo.test');
  });
});

describe('o segredo do login em duas etapas entra na rotação', () => {
  const TOTP = 'skygenpanel-user-totp-v1';

  it('re-cifra o segredo guardado em `users`, que é da pessoa e não de um provedor', async () => {
    // `users` é compartilhada: fica fora do laço dos provedores, e sem o caminho
    // próprio este seria o primeiro segredo do painel que a rotação não alcança.
    process.env.SECRET_BOX_KEY = CHAVE_ANTIGA;
    const cifrado = createSecretBox(TOTP).encrypt('JBSWY3DPEHPK3PXP');
    const [id] = await getDb()('users').insert({
      username: 'pessoa-com-2fa',
      password: 'hash-qualquer',
      role: 'admin',
      totp_ciphertext: cifrado.password_ciphertext,
      totp_iv: cifrado.password_iv,
      totp_tag: cifrado.password_tag,
      totp_key_version: cifrado.password_key_version,
      totp_enabled_at: new Date()
    }).returning('id').then((linhas) => linhas.map((l) => (typeof l === 'object' ? l.id : l)));

    try {
      emRotacao();
      const resumo = await SecretRotationService.run();
      assert.ok(resumo.reescritas >= 1);

      anteriorRemovida();
      const linha = await getDb()('users').where({ id }).first();
      const aberto = createSecretBox(TOTP).decrypt({
        password_ciphertext: linha.totp_ciphertext,
        password_iv: linha.totp_iv,
        password_tag: linha.totp_tag,
        password_key_version: linha.totp_key_version
      });
      assert.equal(aberto, 'JBSWY3DPEHPK3PXP', 'o segredo do 2FA ficou ilegível ao largar a chave anterior');
    } finally {
      await getDb()('users').where({ id }).del();
    }
  });
});

describe('o token do bot do Telegram dos alertas entra na rotação', () => {
  const TELEGRAM = 'skygenpanel-telegram-bot-v1';

  it('re-cifra o token aninhado nos ajustes de alerta, e o resto do objeto fica', async () => {
    process.env.SECRET_BOX_KEY = CHAVE_ANTIGA;
    const token = '123456789:AAHfake-token-do-bot-com-segredo-longo';
    await runInTenant(tenantId, () => AppState.upsert('whatsapp_alert_settings', JSON.stringify({
      enabled: true,
      recipients: [],
      telegram: { botToken: { v: 1, ...createSecretBox(TELEGRAM).encrypt(token) }, chatId: '-1001234567890' }
    })));

    try {
      emRotacao();
      await SecretRotationService.run();

      anteriorRemovida();
      const guardado = JSON.parse(await runInTenant(tenantId, () => AppState.get('whatsapp_alert_settings')));
      assert.equal(
        createSecretBox(TELEGRAM).decrypt(guardado.telegram.botToken), token,
        'o token do Telegram ficou ilegível ao largar a chave anterior'
      );
      assert.equal(guardado.telegram.botToken.v, 1);
      assert.equal(guardado.telegram.chatId, '-1001234567890');
    } finally {
      await runInTenant(tenantId, () => AppState.upsert('whatsapp_alert_settings', JSON.stringify({})));
    }
  });
});
