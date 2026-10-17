import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { isDeadlock, withDeadlockRetry } = await import('../src/config/database.js');

/**
 * A escrita que o banco derrubou por deadlock é repetida; qualquer outra falha
 * sobe na primeira vez. É o que tira da sincronização da frota a falha que o
 * MySQL produzia de vez em quando com vários vínculos gravados em paralelo.
 */
describe('withDeadlockRetry', () => {
  const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 });

  it('reconhece o deadlock nos três bancos', () => {
    assert.equal(isDeadlock(deadlock()), true);
    assert.equal(isDeadlock({ code: '40P01' }), true);
    assert.equal(isDeadlock({ code: 'SQLITE_BUSY' }), true);
    assert.equal(isDeadlock({ code: 'ER_DUP_ENTRY' }), false);
    assert.equal(isDeadlock(null), false);
  });

  it('tenta de novo depois de um deadlock e devolve o resultado', async () => {
    let calls = 0;
    const result = await withDeadlockRetry(async () => {
      calls += 1;
      if (calls === 1) throw deadlock();
      return 'gravado';
    }, { pauseMs: 1 });
    assert.equal(result, 'gravado');
    assert.equal(calls, 2);
  });

  it('um erro que não é deadlock sobe na primeira tentativa', async () => {
    let calls = 0;
    await assert.rejects(withDeadlockRetry(async () => {
      calls += 1;
      throw Object.assign(new Error('coluna não existe'), { code: 'ER_BAD_FIELD_ERROR' });
    }, { pauseMs: 1 }), /coluna não existe/);
    assert.equal(calls, 1);
  });

  it('desiste depois do número de tentativas, com o próprio erro', async () => {
    let calls = 0;
    await assert.rejects(withDeadlockRetry(async () => {
      calls += 1;
      throw deadlock();
    }, { attempts: 3, pauseMs: 1 }), (error) => error.code === 'ER_LOCK_DEADLOCK');
    assert.equal(calls, 3);
  });
});
