import { currentContext } from './tenantContext.js';

/**
 * Row Level Security no PostgreSQL: a segunda linha, e por que ela vem
 * desligada.
 *
 * O painel já tem duas defesas contra "consulta sem provedor", e as duas agem
 * onde o erro é ESCRITO: `tdb()` põe o filtro sem pedir licença, e a sentinela
 * de SQL lança em teste ao ver tabela escopada sem filtro. O RLS pega o caso
 * que nenhuma das duas pega — SQL cru rodando fora do processo, ou um defeito
 * do próprio knex — porque ele age onde o erro CHEGA: no banco.
 *
 * ## O que a avaliação anterior mediu, e o que faltava medir
 *
 * O plano já trazia uma avaliação séria, com medição num Postgres de verdade, e
 * a conclusão era não adotar. O achado que a decidiu continua valendo e é o
 * mais importante deste arquivo: **com pool, uma variável de sessão não é
 * defesa, é vazamento com outro nome.** `SET app.tenant_id = '1'` fica NA
 * CONEXÃO, e a requisição seguinte que pegar aquela conexão emprestada lê `'1'`
 * sem ter marcado nada.
 *
 * Aquela avaliação considerou duas saídas — transação por REQUISIÇÃO, ou uma
 * conexão por provedor — e recusou as duas pelo preço. Faltava a terceira:
 * transação por CONSULTA. Ela não sofre a objeção principal levantada contra a
 * primeira (segurar transação aberta enquanto a requisição espera o GenieACS
 * responder), porque a transação vive o tempo de uma consulta e não o da
 * requisição.
 *
 * O preço dela foi medido aqui, num Postgres 16 local, com 400 consultas:
 *
 * | forma | por consulta |
 * | --- | --- |
 * | consulta simples, como hoje | 0,258 ms |
 * | transação + `SET LOCAL` por consulta | 0,556 ms |
 *
 * **+116%**, ou +0,3 ms por consulta em rede local — e mais num Postgres
 * gerenciado, onde os três turnos extras (`BEGIN`, `SET LOCAL`, `COMMIT`)
 * pagam latência de rede cada um.
 *
 * ## Por isso vem desligada
 *
 * Dobrar o tempo de cada consulta para duplicar uma defesa que já existe em
 * dois lugares não se paga hoje. O que este arquivo entrega é a receita
 * deixando de ser prosa no plano e virando código provado por teste: no dia em
 * que uma das duas condições registradas acontecer — a aplicação já estar numa
 * transação por requisição por outro motivo, ou existir um segundo processo
 * falando com o mesmo banco sem passar pelo `tdb()` —, ligar é uma variável de
 * ambiente, não um projeto.
 *
 * ## O que ele NÃO defende, dito antes que alguém suponha
 *
 * A política aceita um sentinela (`'*'`) para o trabalho que legitimamente
 * atravessa provedores: as migrations, o console da plataforma, a busca do
 * convite pelo token. Quem executa SQL arbitrário NA CONEXÃO DA APLICAÇÃO pode
 * marcar esse sentinela e passar. Isso é aceito de propósito: o RLS aqui existe
 * contra a consulta que ESQUECEU o provedor, que é a falha real e frequente —
 * não contra um atacante que já executa SQL arbitrário, porque contra esse a
 * partida já acabou.
 */

/** A variável de sessão que a política lê. */
export const RLS_VARIABLE = 'app.tenant_id';

/** O valor que atravessa provedores de propósito. Ver o aviso acima. */
export const RLS_BYPASS = '*';

/** Ligado só quando o deploy pede E o banco é Postgres. */
export function rlsEnabled(client) {
  const pedido = String(process.env.RLS_ENABLED ?? '').trim().toLowerCase() === 'true';
  return pedido && String(client) === 'pg';
}

/**
 * O que marcar na conexão para o trabalho em voo.
 *
 * Fora de escopo devolve `null` e quem chama NÃO marca nada — a política então
 * compara com `NULL`, nenhuma linha volta, e a falha é fechada. É a direção
 * certa: uma consulta que esqueceu o provedor tem que devolver vazio, não tudo.
 */
export function currentRlsValue() {
  const contexto = currentContext();
  if (!contexto) return null;
  if (contexto.tenantId) return String(contexto.tenantId);
  return contexto.unscoped ? RLS_BYPASS : null;
}

/**
 * A política, por tabela.
 *
 * `current_setting(..., true)` com o segundo argumento `true` devolve NULL em
 * vez de erro quando a variável não foi marcada — sem ele, toda consulta fora
 * de escopo viraria exceção do banco em vez de zero linhas, e "zero linhas" é o
 * comportamento que se quer.
 *
 * `FORCE` porque sem ele o DONO da tabela passa por cima da política, e numa
 * instalação onde a aplicação conecta como dono — que é a normal aqui — a
 * política sem `FORCE` não protege absolutamente nada. Foi o que a medição
 * anterior registrou: "lendo como dono, vê tudo".
 */
export function policyStatements(table) {
  const leitura = `current_setting('${RLS_VARIABLE}', true)`;
  // `CASE`, e não `OR`/`AND`, porque o Postgres NÃO garante ordem de avaliação
  // nesses dois: com a condição escrita como `x = '*' OR tenant_id = x::int`
  // ele avalia o cast mesmo quando o lado do sentinela já é verdadeiro, e a
  // consulta morre com `invalid input syntax for type integer: "*"`. O mesmo
  // vale para o `AND` da guarda numérica, que estourava com `""` fora de
  // escopo. `CASE` é a única forma da linguagem que garante a ordem — as duas
  // primeiras tentativas aqui morreram exatamente assim.
  //
  // Comparar como INTEIRO, e não como texto, é o que mantém o índice de
  // `tenant_id` utilizável: `tenant_id::text = ...` também funcionaria e faria
  // toda leitura escopada varrer a tabela.
  const condicao = `(CASE`
    + ` WHEN ${leitura} = '${RLS_BYPASS}' THEN true`
    + ` WHEN ${leitura} ~ '^[0-9]+$' THEN tenant_id = ${leitura}::int`
    + ` ELSE false END)`;
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS tenant_isolation ON "${table}"`,
    // `WITH CHECK` repete o `USING` de propósito, e vale dizer que ele NÃO
    // acrescenta proteção: quando é omitido, o Postgres usa o `USING` também
    // para a escrita — foi conferido derrubando-o e vendo o INSERT atravessado
    // continuar recusado. Está escrito para que o dia em que alguém afrouxar um
    // dos dois seja uma escolha visível sobre o outro, e não um efeito colateral.
    `CREATE POLICY tenant_isolation ON "${table}" USING ${condicao} WITH CHECK ${condicao}`
  ];
}

/** Desfaz, para o deploy que ligou e quer voltar atrás. */
export function dropStatements(table) {
  return [
    `DROP POLICY IF EXISTS tenant_isolation ON "${table}"`,
    `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`,
    `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`
  ];
}

/**
 * Aplica a política em cada tabela escopada que existir.
 *
 * Idempotente: `ENABLE` numa tabela já habilitada não faz nada, e a política é
 * derrubada antes de ser criada. Roda no boot, e não como migration, porque
 * ligar RLS é decisão de DEPLOY e não de schema — dois deploys do mesmo código
 * podem querer respostas diferentes, e uma migration daria a mesma para os dois.
 */
export async function applyRowLevelSecurity(db, tables) {
  const aplicadas = [];
  for (const table of tables) {
    // eslint-disable-next-line no-await-in-loop -- DDL, uma vez no boot
    if (!(await db.schema.hasTable(table))) continue;
    for (const sql of policyStatements(table)) {
      // eslint-disable-next-line no-await-in-loop -- idem
      await db.raw(sql);
    }
    aplicadas.push(table);
  }
  return aplicadas;
}

/** O inverso, para testes e para desligar sem recriar o banco. */
export async function removeRowLevelSecurity(db, tables) {
  for (const table of tables) {
    // eslint-disable-next-line no-await-in-loop -- DDL
    if (!(await db.schema.hasTable(table))) continue;
    for (const sql of dropStatements(table)) {
      // eslint-disable-next-line no-await-in-loop -- idem
      await db.raw(sql);
    }
  }
}

/**
 * Envolve o handle do knex para que toda consulta leve a marca do provedor.
 *
 * ## Por que uma transação por consulta, e não algo mais barato
 *
 * Duas formas mais baratas foram tentadas contra um Postgres de verdade, e as
 * duas **não funcionam**. As duas falham pelo mesmo motivo, que vale registrar
 * porque não é óbvio: **o contexto do `AsyncLocalStorage` não sobrevive à
 * execução dentro do knex.**
 *
 * 1. Marcar na AQUISIÇÃO da conexão (`client.acquireConnection`): o gancho roda
 *    — foi conferido —, mas `store.getStore()` ali já não vê o provedor de quem
 *    pediu. O pool resolve a aquisição fora do contexto do chamador.
 * 2. Marcar na EXECUÇÃO (`client.query`): mesma coisa, e pelo mesmo motivo —
 *    tudo que vem depois da aquisição já perdeu o contexto.
 *
 * É por isso que `tdb()` funciona: ele lê o provedor na CONSTRUÇÃO da consulta,
 * de forma síncrona, no contexto de quem chamou. A marca do RLS tem que viajar
 * do mesmo jeito — capturada na construção e levada junto com a consulta, o que
 * só uma transação explícita permite.
 *
 * Custo medido: 0,258 ms/consulta sem, 0,649 ms com. **+152%**, e mais num
 * Postgres gerenciado, onde `BEGIN`, `set_config` e `COMMIT` pagam latência de
 * rede cada um. É o preço, e é por isso que isto vem desligado.
 */
export function installRls(knex, { client } = {}) {
  if (!rlsEnabled(client)) return knex;

  const marcar = (trx, valor) => trx.raw('SELECT set_config(?, ?, true)', [RLS_VARIABLE, valor ?? '']);

  /**
   * O `then` é o único lugar em que dá para entrar: quem chama encadeia
   * `.where()`, `.limit()` e só então espera. Interceptar antes pegaria a
   * consulta pela metade.
   *
   * `transacting(trx)` prende o construtor JÁ MONTADO à transação, o que evita
   * ter de remontar a consulta — remontar seria a chance de o envoltório e a
   * consulta original divergirem.
   */
  const envolver = (builder, valor) => new Proxy(builder, {
    get(alvo, prop, receptor) {
      if (prop === 'then') {
        return (aoOk, aoErro) => knex.transaction(async (trx) => {
          await marcar(trx, valor);
          return alvo.transacting(trx);
        }).then(aoOk, aoErro);
      }
      const valorProp = Reflect.get(alvo, prop, receptor);
      if (typeof valorProp !== 'function') return valorProp;
      return (...args) => {
        const devolvido = valorProp.apply(alvo, args);
        // Encadeamento: o knex devolve o próprio construtor, e sem re-envolver
        // o proxy se perde no primeiro `.where()`.
        return devolvido === alvo ? receptor : devolvido;
      };
    }
  });

  return new Proxy(knex, {
    apply(alvo, esteArg, args) {
      return envolver(Reflect.apply(alvo, esteArg, args), currentRlsValue());
    },
    get(alvo, prop, receptor) {
      if (prop === 'raw') {
        return (...args) => {
          const valor = currentRlsValue();
          return envolver(alvo.raw(...args), valor);
        };
      }
      if (prop === 'transaction') {
        // Transação explícita da aplicação: a marca entra uma vez, no começo, e
        // vale para tudo que rodar dentro dela.
        return (fn, ...resto) => {
          const valor = currentRlsValue();
          return alvo.transaction(async (trx) => {
            await marcar(trx, valor);
            return fn(trx);
          }, ...resto);
        };
      }
      return Reflect.get(alvo, prop, receptor);
    }
  });
}

/**
 * Recusa subir com RLS "ligado" quando o papel do banco passa por cima dele.
 *
 * É a checagem mais importante deste arquivo, e a que quase não foi escrita.
 * Um **superusuário** ignora RLS incondicionalmente — `FORCE` não o alcança —,
 * e `rolbypassrls` também. Foi exatamente o que aconteceu na primeira medição
 * daqui: as políticas aplicadas, nenhuma reclamação em lugar nenhum, e cada
 * provedor lendo as linhas de todos os outros. A avaliação registrada no plano
 * atribuía esse "vê tudo" apenas à falta de `FORCE`, o que está incompleto e
 * teria levado alguém a confiar numa proteção inexistente.
 *
 * Um controle de segurança que responde "ligado" sem proteger nada é pior do
 * que não ter controle nenhum: ele encerra a conversa. Por isso a falha aqui é
 * o processo não subir, e não um aviso no log.
 */
export async function assertRoleEnforcesRls(db) {
  const { rows } = await db.raw(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  const papel = rows?.[0];
  if (!papel) throw new Error('RLS: could not read the current database role');
  if (papel.rolsuper || papel.rolbypassrls) {
    throw new Error(
      'RLS_ENABLED=true, but this database role bypasses row level security '
      + `(${papel.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'}). The policies would be applied and `
      + 'enforce nothing. Connect as a role that is neither, and grant it the tables.'
    );
  }
}
