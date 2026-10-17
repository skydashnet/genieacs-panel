import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SchedulerService, leadRetentionDays } = await import('../src/services/schedulerService.js');
const { default: Lead } = await import('../src/models/Lead.js');
const { default: migrations } = await import('../src/config/migrations.js');

/**
 * A poda dos pedidos de contato da vitrine.
 *
 * Quase todo caso aqui afirma o que tem que **SOBREVIVER**, e a assimetria é o
 * ponto — a mesma de `whatsapp-message-retention.test.js`. Uma poda que apaga
 * de menos custa disco, que alguém nota e corrige. Uma que apaga demais custa o
 * registro de como um cliente chegou, e ninguém nota até precisar dele.
 *
 * O caso que dá nome ao arquivo é o primeiro: **com o prazo desligado, nada
 * sai**. É o que protege toda instalação que já está rodando no dia em que esta
 * mudança chega por `skygenpanel update` — o operador não pediu para apagar
 * nada, e o padrão não pode decidir por ele.
 */
const DAY = 24 * 60 * 60 * 1000;

/**
 * Um instante com os milissegundos cortados.
 *
 * O `TIMESTAMP` do MySQL guarda segundos inteiros quando a coluna não pede
 * fração, e `leads.created_at` não pede. Uma linha semeada em `…347.402` volta
 * de lá como `…347.000`, então um corte que caia dentro desse milissegundo
 * perdido incluiria a linha num dialeto e a excluiria nos outros. Semear tempo
 * que o armazenamento consegue guardar tira a pergunta do caminho.
 */
const segundoInteiro = (ms) => new Date(Math.floor(ms / 1000) * 1000);

/** Um pedido com a idade e o estado pedidos. `leads` não tem `tenant_id`. */
async function lead({ status, ageDays }) {
  const quando = segundoInteiro(Date.now() - ageDays * DAY);
  const [id] = await getDb()('leads').insert({
    name: `Interessado ${status} ${ageDays}d`,
    email: `${status}.${ageDays}@exemplo.test`,
    status,
    source: 'landing',
    created_at: quando,
    updated_at: quando
  }).returning('id');
  return Number(typeof id === 'object' && id !== null ? id.id : id);
}

const existe = async (id) => Boolean(await getDb()('leads').where({ id }).first());

before(async () => {
  await startTestServers();
});

after(async () => {
  await stopTestServers();
  delete process.env.LEAD_RETENTION_DAYS;
});

describe('o prazo dos leads', () => {
  /**
   * Ausente, vazio e zero querem dizer a mesma coisa — "para sempre" —, que é a
   * convenção deste sistema.
   */
  it('é zero quando ninguém o configurou', () => {
    assert.equal(leadRetentionDays(undefined), 0);
    assert.equal(leadRetentionDays(''), 0);
    assert.equal(leadRetentionDays('   '), 0);
    assert.equal(leadRetentionDays('0'), 0);
  });

  /**
   * O caso que a regra estrita existe para pegar: `Number.parseInt('12abc')`
   * devolve 12, e um prazo de 12 dias nascido de um campo digitado errado
   * apagaria dado que ninguém mandou apagar.
   */
  it('e é zero — não um prazo inventado — diante de texto que não é número', () => {
    for (const bruto of ['12abc', '30 dias', '-5', '1.5', 'NaN', 'true']) {
      assert.equal(leadRetentionDays(bruto), 0, `aceitou ${JSON.stringify(bruto)}`);
    }
  });

  it('e respeita o mínimo e o máximo quando é número', () => {
    assert.equal(leadRetentionDays('365'), 365);
    assert.equal(leadRetentionDays('1'), 30);
    assert.equal(leadRetentionDays('99999'), 3650);
  });
});

describe('a poda dos leads', () => {
  /**
   * O caso que dá nome ao arquivo.
   */
  it('não apaga nada enquanto o prazo está desligado, nem um pedido de três anos', async () => {
    delete process.env.LEAD_RETENTION_DAYS;
    const antigo = await lead({ status: 'new', ageDays: 1095 });

    await SchedulerService.pruneLeads();

    assert.ok(await existe(antigo), 'apagou com o prazo desligado');
  });

  /**
   * O lead `won` é o único elo entre um provedor que assinou e o pedido que o
   * originou: não há `tenant_id`, `lead_id` nem `converted_at` em lugar nenhum.
   * Apagá-lo é perda comercial sem ganho de privacidade.
   */
  it('e nunca apaga um lead ganho, com qualquer idade e qualquer prazo', async () => {
    process.env.LEAD_RETENTION_DAYS = '30';
    const ganhoVelho = await lead({ status: 'won', ageDays: 3650 });

    await SchedulerService.pruneLeads();

    assert.ok(await existe(ganhoVelho), 'apagou um lead ganho');
  });

  it('e guarda o que é mais novo que o prazo', async () => {
    process.env.LEAD_RETENTION_DAYS = '365';
    const recentes = await Promise.all([
      lead({ status: 'new', ageDays: 10 }),
      lead({ status: 'contacted', ageDays: 200 }),
      lead({ status: 'lost', ageDays: 364 })
    ]);

    await SchedulerService.pruneLeads();

    for (const id of recentes) {
      assert.ok(await existe(id), `apagou um lead dentro do prazo (${id})`);
    }
  });

  it('e apaga os três estados que não deram em cliente, passado o prazo', async () => {
    process.env.LEAD_RETENTION_DAYS = '365';
    const vencidos = await Promise.all([
      lead({ status: 'new', ageDays: 400 }),
      lead({ status: 'contacted', ageDays: 500 }),
      lead({ status: 'lost', ageDays: 900 })
    ]);

    await SchedulerService.pruneLeads();

    for (const id of vencidos) {
      assert.equal(await existe(id), false, `guardou um lead vencido (${id})`);
    }
  });

  /**
   * Fora do laço por provedor, e é essa a afirmação: a mesma que
   * `signup-email-proof.test.js` faz para os bilhetes. Sem ela um `tdb`
   * acidental só explodiria em produção, no primeiro tick depois do deploy.
   */
  it('e roda sem nenhum provedor em escopo', async () => {
    process.env.LEAD_RETENTION_DAYS = '365';
    const vencido = await lead({ status: 'new', ageDays: 400 });

    const apagados = await Lead.prune(new Date(Date.now() - 365 * DAY));

    assert.equal(typeof apagados, 'number');
    assert.equal(await existe(vencido), false);
  });
});

describe('a migração que derruba o IP dos leads', () => {
  /**
   * O estado ANTERIOR tem que ser refabricado à mão, e a razão merece estar
   * escrita: o banco de teste nasce da fábrica `leadsTable`, que já não declara
   * `ip`, então a migração encontraria a coluna ausente e seria um no-op. Um
   * teste rodando contra o no-op passaria sempre e não mediria nada — que é
   * pior do que não existir, porque parece cobertura.
   *
   * Então o passo recria a coluna, semeia uma linha com IP, e só então chama o
   * `up`. É o molde de `schema-migrations.test.js`.
   */
  const PASSO = '0109_drop_lead_ip';
  let comIp;

  before(async () => {
    const db = getDb();
    if (!(await db.schema.hasColumn('leads', 'ip'))) {
      await db.schema.alterTable('leads', (t) => t.string('ip', 64));
    }
    comIp = await lead({ status: 'new', ageDays: 5 });
    await db('leads').where({ id: comIp }).update({ ip: '203.0.113.7' });

    await migrations.find((m) => m.id === PASSO).up(db);
  });

  it('derruba a coluna e guarda a linha', async () => {
    assert.equal(await getDb().schema.hasColumn('leads', 'ip'), false);
    assert.ok(await existe(comIp), 'levou o lead junto com o IP dele');
  });

  /**
   * O caso que justifica rodar os três dialetos.
   *
   * O SQLite derruba coluna **reconstruindo a tabela**, e é aí que um índice se
   * perde sem avisar. Sem `leads_status_created_idx` a poda continua CORRETA e
   * passa a varrer a tabela inteira a cada dia — defeito que nenhum outro teste
   * veria, porque o resultado não muda.
   */
  it('e o índice de que a poda depende continua de pé', async () => {
    const db = getDb();
    const client = db.client.config.client;
    let indices = [];

    if (client.includes('sqlite')) {
      indices = (await db.raw("select name from sqlite_master where type='index' and tbl_name='leads'"))
        .map((linha) => linha.name);
    } else if (client.includes('pg')) {
      const res = await db.raw("select indexname as name from pg_indexes where tablename = 'leads'");
      indices = res.rows.map((linha) => linha.name);
    } else {
      const [rows] = await db.raw('show index from leads');
      indices = rows.map((linha) => linha.Key_name);
    }

    assert.ok(
      indices.includes('leads_status_created_idx'),
      `o índice sumiu no drop da coluna; existem: ${indices.join(', ')}`
    );
  });

  it('e roda de novo sem erro, numa instalação que já a aplicou', async () => {
    const passo = migrations.find((m) => m.id === PASSO);
    assert.equal(await passo.isApplied(getDb()), true);
    await passo.up(getDb());
    assert.equal(await getDb().schema.hasColumn('leads', 'ip'), false);
  });
});
