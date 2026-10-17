import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import knexFactory from 'knex';

/**
 * Row Level Security, ligado de verdade contra um Postgres de verdade.
 *
 * Só roda quando o dialeto é `pg` — RLS não existe nos outros dois —, e por
 * isso ele é uma SEGUNDA linha e não a primeira: a defesa que vale nos três
 * bancos continua sendo `tdb()` com o filtro obrigatório e a sentinela de SQL.
 *
 * O caso que mais importa aqui é o do **papel que passa por cima**. Um
 * superusuário ignora RLS incondicionalmente, `FORCE` inclusive — então as
 * políticas sobem, nada reclama, e cada provedor lê as linhas de todos os
 * outros. Um controle de segurança que responde "ligado" sem proteger é pior do
 * que não ter controle: ele encerra a conversa. Foi assim que a primeira
 * medição deste arquivo passou, verde, protegendo nada.
 */

const {
  default: rlsDefault, applyRowLevelSecurity, assertRoleEnforcesRls,
  currentRlsValue, policyStatements, removeRowLevelSecurity, rlsEnabled
} = await import('../src/config/rls.js');
const { runInTenant, runUnscoped } = await import('../src/config/tenantContext.js');

const CLIENT = String(process.env.TEST_DB_CLIENT ?? '').toLowerCase();
const EH_POSTGRES = CLIENT === 'pg' || CLIENT === 'postgres' || CLIENT === 'postgresql';

const conexao = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 5432),
  user: process.env.TEST_DB_USER ?? 'skygp',
  password: process.env.TEST_DB_PASSWORD ?? 'skygp',
  database: process.env.TEST_DB_NAME ?? 'skygp_test'
};

const PAPEL = 'skygp_rls_probe';
const TABELA = 'rls_probe_rows';

let dono;
let comum;

before(async () => {
  if (!EH_POSTGRES) return;
  dono = knexFactory({ client: 'pg', connection: conexao, pool: { min: 1, max: 2 } });

  await dono.raw(`DROP TABLE IF EXISTS ${TABELA}`);
  await dono.raw(`CREATE TABLE ${TABELA} (id serial primary key, tenant_id int not null, v text)`);
  await dono(TABELA).insert([
    { tenant_id: 1, v: 'do alfa' },
    { tenant_id: 2, v: 'do beta' }
  ]);

  // Limpa o que uma execução anterior possa ter deixado. Não é zelo: uma
  // passada interrompida deixa o papel de teste dono de objetos, e o `before`
  // seguinte trava esperando o lock deles — foi o que aconteceu aqui, e um
  // teste que trava a CI por causa da execução passada é pior que um que falha.
  if ((await dono.raw(`SELECT 1 FROM pg_roles WHERE rolname = '${PAPEL}'`)).rows.length) {
    await dono.raw(`DROP OWNED BY ${PAPEL}`);
    await dono.raw(`DROP ROLE ${PAPEL}`);
  }
  await dono.raw(`CREATE ROLE ${PAPEL} LOGIN PASSWORD 'probe'`);
  await dono.raw(`GRANT ALL ON ${TABELA} TO ${PAPEL}`);
  await dono.raw(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${PAPEL}`);

  for (const sql of policyStatements(TABELA)) await dono.raw(sql);

  // UMA conexão de propósito: é com o pool de uma conexão que o vazamento
  // entre requisições apareceria, se houvesse.
  comum = knexFactory({
    client: 'pg',
    connection: { ...conexao, user: PAPEL, password: 'probe' },
    pool: { min: 1, max: 1 }
  });
});

after(async () => {
  if (!EH_POSTGRES) return;
  await comum?.destroy();
  await dono.raw(`DROP TABLE IF EXISTS ${TABELA}`);
  await dono.raw(`DROP OWNED BY ${PAPEL}`);
  await dono.raw(`DROP ROLE IF EXISTS ${PAPEL}`);
  await dono.destroy();
});

/** Lê a tabela marcando a variável como o envoltório faz: na construção. */
function ler(valor) {
  return comum.transaction(async (trx) => {
    await trx.raw('SELECT set_config(?, ?, true)', ['app.tenant_id', valor ?? '']);
    return trx(TABELA).select('tenant_id', 'v').orderBy('tenant_id');
  });
}

describe('a política, contra um Postgres de verdade', { skip: !EH_POSTGRES && 'só existe no Postgres' }, () => {
  it('cada provedor lê só as próprias linhas', async () => {
    assert.deepEqual(await ler('1'), [{ tenant_id: 1, v: 'do alfa' }]);
    assert.deepEqual(await ler('2'), [{ tenant_id: 2, v: 'do beta' }]);
  });

  it('sem provedor marcado, nenhuma linha — falha fechando', async () => {
    // A direção certa: a consulta que esqueceu o provedor devolve vazio, não
    // tudo. É o oposto do que acontece sem RLS, onde ela devolve o deploy
    // inteiro.
    assert.deepEqual(await ler(''), []);
    assert.deepEqual(await ler(null), []);
  });

  it('e depois de uma leitura do alfa, a seguinte sem provedor continua vazia', async () => {
    // O vazamento clássico da variável de sessão com pool: `SET` fica NA
    // CONEXÃO, e a requisição seguinte herdaria o provedor da anterior. Com
    // `set_config(..., true)` dentro da transação, some no commit.
    await ler('1');
    assert.deepEqual(await ler(''), []);
  });

  it('o sentinela atravessa, para o que legitimamente cruza provedores', async () => {
    const tudo = await ler('*');
    assert.equal(tudo.length, 2);
  });

  it('um valor que não é número nem sentinela não estoura, devolve vazio', async () => {
    // O Postgres NÃO garante ordem de avaliação em `AND`/`OR`: escrito com eles,
    // o cast era avaliado mesmo com o outro lado já decidido e a consulta morria
    // com `invalid input syntax for type integer`. É por isso que a política usa
    // `CASE`, que é a única forma da linguagem que garante a ordem.
    assert.deepEqual(await ler('nao-e-numero'), []);
    assert.deepEqual(await ler('1; DROP TABLE x'), []);
  });

  it('escrever para outro provedor é recusado pelo WITH CHECK', async () => {
    await assert.rejects(() => comum.transaction(async (trx) => {
      await trx.raw('SELECT set_config(?, ?, true)', ['app.tenant_id', '1']);
      return trx(TABELA).insert({ tenant_id: 2, v: 'invasor' }).transacting(trx);
    }), 'um INSERT com o tenant_id do vizinho tinha de ser recusado');
  });

  it('e um UPDATE atravessando provedor não toca nada', async () => {
    const tocadas = await comum.transaction(async (trx) => {
      await trx.raw('SELECT set_config(?, ?, true)', ['app.tenant_id', '1']);
      return trx(TABELA).where({ tenant_id: 2 }).update({ v: 'mexido' }).transacting(trx);
    });
    assert.equal(tocadas, 0);
    const [beta] = await ler('2');
    assert.equal(beta.v, 'do beta', 'a linha do vizinho foi alterada');
  });
});

describe('a guarda do papel', { skip: !EH_POSTGRES && 'só existe no Postgres' }, () => {
  it('recusa subir quando o papel passa por cima do RLS', async () => {
    // O `before` conecta como o papel de teste, que é dono do banco e
    // superusuário na maioria das instalações — é exatamente o caso que a
    // guarda existe para pegar.
    const { rows } = await dono.raw('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    const passaPorCima = rows[0].rolsuper || rows[0].rolbypassrls;
    if (passaPorCima) {
      await assert.rejects(() => assertRoleEnforcesRls(dono), /bypasses row level security/);
    } else {
      await assertRoleEnforcesRls(dono);
    }
  });

  it('e aceita o papel comum, que não passa', async () => {
    await assertRoleEnforcesRls(comum);
  });

  it('a receita liga FORCE, sem o que a aplicação dona não obedeceria', async () => {
    // `ENABLE` sozinho não alcança o DONO da tabela — e a instalação normal
    // conecta como dono. Sem `FORCE`, a política subiria e a aplicação leria
    // tudo assim mesmo, que é o cenário que a avaliação do plano registrou
    // como "lendo como dono: vê tudo".
    const { rows } = await dono.raw(
      'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ?', [TABELA]
    );
    assert.equal(rows[0].relrowsecurity, true, 'RLS não ficou habilitado');
    assert.equal(rows[0].relforcerowsecurity, true, 'FORCE não ficou ligado — o dono passaria por cima');
  });

  it('o superusuário realmente ignora a política, FORCE inclusive', async () => {
    // A prova de que a guarda não é paranoia: com o mesmo `FORCE` aplicado, o
    // papel privilegiado lê tudo. A avaliação registrada no plano atribuía esse
    // "vê tudo" apenas à falta de `FORCE` — está incompleto, e confiar nisso
    // deixaria um deploy achando que está protegido.
    const { rows } = await dono.raw('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    if (!(rows[0].rolsuper || rows[0].rolbypassrls)) return;
    const tudo = await dono(TABELA).select('tenant_id');
    assert.equal(tudo.length, 2, 'o papel privilegiado devia ver as duas linhas, e vê');
  });
});

describe('o que o envoltório marca', () => {
  it('dentro de um provedor, marca o id', () => {
    assert.equal(runInTenant(7, () => currentRlsValue()), '7');
  });

  it('fora de escopo, não marca nada — e a política recusa tudo', () => {
    // `null` e não `''` por acaso: quem chama traduz para vazio, e a política
    // trata os dois igual. O ponto é não marcar um provedor que ninguém pediu.
    assert.equal(currentRlsValue(), null);
  });

  it('e no trabalho que atravessa provedores de propósito, o sentinela', () => {
    assert.equal(runUnscoped('migrations', () => currentRlsValue()), '*');
  });

  it('desligado por padrão, e só no Postgres', () => {
    // Ligado exige as duas coisas: o deploy pedir E o banco ser Postgres.
    const antes = process.env.RLS_ENABLED;
    try {
      delete process.env.RLS_ENABLED;
      assert.equal(rlsEnabled('pg'), false, 'o padrão tem que ser desligado');
      process.env.RLS_ENABLED = 'true';
      assert.equal(rlsEnabled('pg'), true);
      assert.equal(rlsEnabled('mysql2'), false, 'não existe RLS no MySQL');
      assert.equal(rlsEnabled('sqlite3'), false, 'nem no SQLite');
    } finally {
      if (antes === undefined) delete process.env.RLS_ENABLED;
      else process.env.RLS_ENABLED = antes;
    }
  });

  it('e aplicar/remover são idempotentes', { skip: !EH_POSTGRES && 'só no Postgres' }, async () => {
    // Rodam no boot, e um boot repetido não pode ser diferente do primeiro.
    await applyRowLevelSecurity(dono, [TABELA]);
    await applyRowLevelSecurity(dono, [TABELA]);
    assert.deepEqual(await ler('1'), [{ tenant_id: 1, v: 'do alfa' }]);
    await removeRowLevelSecurity(dono, [TABELA]);
    await removeRowLevelSecurity(dono, [TABELA]);
    // Sem política, o papel comum volta a ver tudo — que é a prova de que era a
    // política, e não outra coisa, que estava separando.
    assert.equal((await ler('')).length, 2);
    for (const sql of policyStatements(TABELA)) await dono.raw(sql);
  });

  it('e a tabela que não existe é pulada, não quebra o boot', { skip: !EH_POSTGRES && 'só no Postgres' }, async () => {
    const aplicadas = await applyRowLevelSecurity(dono, ['tabela_que_nao_existe', TABELA]);
    assert.deepEqual(aplicadas, [TABELA]);
  });

  it('o módulo não exporta um default enganoso', () => {
    assert.equal(rlsDefault, undefined);
  });
});
