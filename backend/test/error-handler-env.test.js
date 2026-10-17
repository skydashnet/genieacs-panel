import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { errorHandler } = await import('../src/app.js');

/**
 * O texto interno de um 5xx só sai quando a instalação pede com
 * `APP_ENV=development`. Uma instalação manual sem `APP_ENV` — ou só com
 * `NODE_ENV=production` — respondia com a mensagem crua do erro (SQL, nome de
 * tabela, caminho de arquivo), porque a constante exportada assume
 * 'development' quando a variável falta.
 */
const SEGREDO = 'SQLITE_ERROR: no such column: customer_accounts.password_hash';
const original = process.env.APP_ENV;

function responder(env) {
  if (env === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = env;
  let corpo;
  const res = { status() { return this; }, json(body) { corpo = body; return this; } };
  errorHandler(new Error(SEGREDO), { method: 'GET', originalUrl: '/api/x' }, res, () => {});
  return JSON.stringify(corpo);
}

afterEach(() => {
  if (original === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = original;
});

describe('o texto interno de um erro 500', () => {
  it('não sai quando APP_ENV não está definido', () => {
    assert.equal(responder(undefined).includes('password_hash'), false);
  });

  it('nem em produção', () => {
    assert.equal(responder('production').includes('password_hash'), false);
  });

  it('sai só com APP_ENV=development', () => {
    assert.equal(responder('development').includes('password_hash'), true);
  });
});
