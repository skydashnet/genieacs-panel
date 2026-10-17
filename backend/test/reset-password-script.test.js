import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/**
 * As recusas de `scripts/reset-password.js` — as que acontecem antes de tocar
 * no banco, e que por isso rodam sem banco nenhum.
 *
 * O ponto é o uso antigo, com a senha como segundo argumento: ela ficaria em
 * `ps` e no histórico do shell. O script precisa recusar e dizer para onde a
 * senha foi, e não redefinir em silêncio.
 */
const SCRIPT = new URL('../scripts/reset-password.js', import.meta.url).pathname;

function rodar(args, { senha, entrada = '' } = {}) {
  const env = { ...process.env };
  delete env.RESET_PASSWORD;
  if (senha !== undefined) env.RESET_PASSWORD = senha;
  return spawnSync(process.execPath, [SCRIPT, ...args], { env, input: entrada, encoding: 'utf8' });
}

describe('scripts/reset-password.js', () => {
  it('recusa a senha passada como argumento e aponta a variável', () => {
    const run = rodar(['fulano', 'senha-no-argumento']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /argument/i);
    assert.match(run.stderr, /RESET_PASSWORD/);
    assert.doesNotMatch(run.stdout, /updated/i);
  });

  it('recusa mesmo com RESET_PASSWORD definida, se veio senha no argumento', () => {
    const run = rodar(['fulano', 'senha-no-argumento'], { senha: 'senha-boa-123' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /argument/i);
  });

  it('sem usuário, mostra o uso', () => {
    const run = rodar([]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Usage/);
  });

  it('sem senha na variável nem na entrada padrão, recusa', () => {
    const run = rodar(['fulano']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /RESET_PASSWORD or pipe it on stdin/);
  });

  it('aplica o mínimo de 8 caracteres à senha da variável', () => {
    const run = rodar(['fulano'], { senha: 'curta' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /at least 8/);
  });

  it('aplica o mínimo de 8 caracteres à senha da entrada padrão', () => {
    const run = rodar(['--', 'fulano'], { entrada: 'curta\n' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /at least 8/);
  });
});
