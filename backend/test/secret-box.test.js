import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_KEY_VERSION, LEGACY_KEY_VERSION, createSecretBox } from '../src/utils/secretBox.js';

const CONTEXT = 'skygenpanel-test-secret-v1';
const ORIGINAL_JWT = 'jwt-secret-original-long-enough-for-production-rules';
const ROTATED_JWT = 'jwt-secret-rotated-long-enough-for-production-rules';
const BOX_KEY = 'dedicated-secret-box-key-long-enough-for-production';

let saved;

const VARS = ['JWT_SECRET', 'SECRET_BOX_KEY', 'JWT_SECRET_PREVIOUS', 'SECRET_BOX_KEY_PREVIOUS'];

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
  process.env.JWT_SECRET = ORIGINAL_JWT;
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('secret box key versions', () => {
  it('writes version 1 when only JWT_SECRET is configured', () => {
    const box = createSecretBox(CONTEXT);
    const stored = box.encrypt('portal-password');

    assert.equal(stored.password_key_version, LEGACY_KEY_VERSION);
    assert.equal(box.decrypt(stored), 'portal-password');
  });

  it('writes version 2 once SECRET_BOX_KEY is configured', () => {
    process.env.SECRET_BOX_KEY = BOX_KEY;
    const box = createSecretBox(CONTEXT);
    const stored = box.encrypt('portal-password');

    assert.equal(stored.password_key_version, CURRENT_KEY_VERSION);
    assert.equal(box.decrypt(stored), 'portal-password');
  });

  it('still reads rows written before SECRET_BOX_KEY existed', () => {
    const legacy = createSecretBox(CONTEXT).encrypt('written-under-jwt-secret');

    process.env.SECRET_BOX_KEY = BOX_KEY;
    assert.equal(createSecretBox(CONTEXT).decrypt(legacy), 'written-under-jwt-secret');
  });

  it('treats a row with no recorded version as version 1', () => {
    const stored = createSecretBox(CONTEXT).encrypt('legacy-row');
    delete stored.password_key_version;

    assert.equal(createSecretBox(CONTEXT).decrypt(stored), 'legacy-row');
  });

  // The point of the whole change: rotating JWT_SECRET is an ordinary security
  // operation and it used to destroy every stored secret without a word.
  it('survives a JWT_SECRET rotation for anything written under the dedicated key', () => {
    process.env.SECRET_BOX_KEY = BOX_KEY;
    const stored = createSecretBox(CONTEXT).encrypt('survives-rotation');

    process.env.JWT_SECRET = ROTATED_JWT;
    assert.equal(createSecretBox(CONTEXT).decrypt(stored), 'survives-rotation');
  });

  it('loses version 1 rows on a JWT_SECRET rotation, which is why version 2 exists', () => {
    const legacy = createSecretBox(CONTEXT).encrypt('keyed-to-jwt-secret');

    process.env.JWT_SECRET = ROTATED_JWT;
    process.env.SECRET_BOX_KEY = BOX_KEY;
    assert.equal(createSecretBox(CONTEXT).decrypt(legacy), null);
  });

  /**
   * A rotação passa a ter janela de leitura.
   *
   * Sem isto, girar o `JWT_SECRET` deixava ilegível toda senha de portal, senha
   * de WiFi e token guardado que ainda não tivesse sido reescrito — e em
   * silêncio, porque `decrypt` devolve null e `hasSavedPassword` continua
   * dizendo true. Aparecia para o assinante como dado sumido, não como chave
   * faltando.
   */
  it('still reads a version 1 row after a rotation, when the old secret is kept', () => {
    const stored = createSecretBox(CONTEXT).encrypt('escrito-antes-de-girar');

    process.env.JWT_SECRET = ROTATED_JWT;
    process.env.JWT_SECRET_PREVIOUS = ORIGINAL_JWT;

    assert.equal(createSecretBox(CONTEXT).decrypt(stored), 'escrito-antes-de-girar');
  });

  it('writes with the live secret, never with the one kept for reading', () => {
    process.env.JWT_SECRET = ROTATED_JWT;
    process.env.JWT_SECRET_PREVIOUS = ORIGINAL_JWT;
    const stored = createSecretBox(CONTEXT).encrypt('escrito-depois-de-girar');

    // Sem o antigo configurado, o novo sozinho tem de bastar: é o que prova que
    // a escrita saiu na chave viva, e não na que só existe para ler.
    delete process.env.JWT_SECRET_PREVIOUS;
    assert.equal(createSecretBox(CONTEXT).decrypt(stored), 'escrito-depois-de-girar');
  });

  it('gives the dedicated key the same read window', () => {
    const OUTRA_BOX = 'segunda-chave-dedicada-longa-o-bastante-para-producao';
    process.env.SECRET_BOX_KEY = BOX_KEY;
    const stored = createSecretBox(CONTEXT).encrypt('guardado-na-v2');
    assert.equal(stored.password_key_version, CURRENT_KEY_VERSION);

    process.env.SECRET_BOX_KEY = OUTRA_BOX;
    process.env.SECRET_BOX_KEY_PREVIOUS = BOX_KEY;
    assert.equal(createSecretBox(CONTEXT).decrypt(stored), 'guardado-na-v2');
  });

  it('does not let a stale previous secret decrypt what it never wrote', () => {
    process.env.JWT_SECRET_PREVIOUS = 'chave-antiga-que-nunca-escreveu-nada-aqui';
    const stored = createSecretBox(CONTEXT).encrypt('atual');

    process.env.JWT_SECRET = ROTATED_JWT;
    delete process.env.JWT_SECRET_PREVIOUS;
    assert.equal(createSecretBox(CONTEXT).decrypt(stored), null);
  });

  it('returns null rather than throwing when the recorded version has no key', () => {
    const stored = createSecretBox(CONTEXT).encrypt('unreadable');
    stored.password_key_version = 99;

    assert.equal(createSecretBox(CONTEXT).decrypt(stored), null);
  });

  /**
   * O guard lia só `APP_ENV`. Os dois caminhos suportados o definem —
   * `install.sh` e o Dockerfile — mas uma instalação feita fora deles com
   * apenas `NODE_ENV=production` caía no fallback embutido e cifrava os
   * segredos guardados sob uma chave derivada de 'insecure-development-secret',
   * computável a partir deste repositório.
   */
  it('refuses to fall back to the built-in key in production, under either variable', () => {
    const salvos = { app: process.env.APP_ENV, node: process.env.NODE_ENV };
    delete process.env.JWT_SECRET;
    delete process.env.SECRET_BOX_KEY;
    try {
      for (const [nome, outro] of [['APP_ENV', 'NODE_ENV'], ['NODE_ENV', 'APP_ENV']]) {
        delete process.env[outro];
        process.env[nome] = 'production';
        assert.throws(() => createSecretBox(CONTEXT), /must be set/, nome);
      }
    } finally {
      for (const [nome, valor] of [['APP_ENV', salvos.app], ['NODE_ENV', salvos.node]]) {
        if (valor === undefined) delete process.env[nome];
        else process.env[nome] = valor;
      }
    }
  });

  it('keeps contexts isolated from one another', () => {
    const stored = createSecretBox('context-a').encrypt('secret');
    assert.equal(createSecretBox('context-b').decrypt(stored), null);
  });

  it('returns null for an incomplete row', () => {
    const box = createSecretBox(CONTEXT);
    assert.equal(box.decrypt(null), null);
    assert.equal(box.decrypt({ password_ciphertext: 'x' }), null);
  });
});
