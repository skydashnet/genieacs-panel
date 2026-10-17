import { getDb } from '../config/database.js';

/**
 * Who holds the control plane.
 *
 * Read OUTSIDE `tdb`, like `tenant_users` and for a sharper version of the same
 * reason. A platform administrator stands ABOVE providers: he is the one who
 * mints them, so filtering the roster by the provider a request happens to be
 * scoped to would be asking "is he a platform administrator *at* this ISP",
 * which is not a question this level has an answer to. There is no `tenant_id`
 * on the table for the same reason.
 *
 * The surface is deliberately narrow — is this person one, add one, remove one,
 * list them. The roster is an authority, not a resource; anything richer would
 * be the control-plane API, which belongs to the routes built on top of this
 * rather than here.
 *
 * A onda que abriu `/api/platform/admins` acrescentou dois métodos a essa
 * lista, e vale escrever por que eles são daqui e não do controlador que os
 * chama:
 *
 * - `find` porque a tela do console mostra a LINHA do cadastro — nome, endereço
 *   e desde quando — e montá-la no controlador seria escrever lá o mesmo join
 *   que `list` já escreve aqui. Duas cópias divergem no dia em que a coluna
 *   mudar, e a que diverge é sempre a que ninguém está olhando.
 * - `removeUnlessLast` porque "o cadastro nunca fica vazio" é invariante DA
 *   TABELA, não regra de uma rota. Escrita como um `if` antes da remoção, ela
 *   vira uma contagem e depois uma remoção, com um intervalo no meio onde cabe
 *   a remoção do outro — e dois pedidos simultâneos tirando os dois últimos
 *   passariam os dois. Ver o método para como a contagem e a remoção viram um
 *   ato só.
 */

/**
 * O que o console mostra de quem está no cadastro.
 *
 * O endereço entra junto com o nome porque numa instalação com dezenas de
 * operadores o nome sozinho não identifica ninguém — e é pelo endereço que a
 * concessão costuma ser pedida, já que é por ele que a pessoa é conhecida
 * desde que `users.email` existe. Nada além disso: a senha está a uma coluna de
 * distância desta consulta e não tem por que atravessá-la.
 */
const COLUNAS = Object.freeze([
  'users.id',
  'users.username',
  'users.email',
  'platform_admins.created_at'
]);

class PlatformAdmin {
  /**
   * Whether this person holds the control plane, right now.
   *
   * The guard calls this on every request rather than trusting a claim minted
   * at sign-in, so it is a single indexed lookup on a unique column and returns
   * a boolean instead of the row: nothing above it needs anything but the
   * answer, and handing back a row invites somebody to authorise off a stale
   * copy of it.
   */
  static async has(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const row = await getDb()('platform_admins').where({ user_id: id }).first('id');
    return Boolean(row);
  }

  /**
   * Puts a person on the roster, and says whether that changed anything.
   *
   * Idempotent, because both callers want it to be: `setup` runs inside the
   * transaction that creates the first administrator, and the grant script is
   * run by hand by whoever holds the server — who will run it twice, on the
   * same install, to check that it took. Granting a grant already held is not
   * an error, so it answers false rather than throwing, and the caller can
   * still tell "added" from "already there" when it has something to print.
   *
   * The check-then-insert is not the guarantee; `user_id` is unique and that
   * is. Two greeters racing would have one of them land on the constraint, so
   * the duplicate is caught and reported the same way as the row already being
   * there — which is what it is.
   */
  static async add(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('PlatformAdmin.add needs the id of an existing person');
    }
    if (await PlatformAdmin.has(id)) return false;

    try {
      await getDb()('platform_admins').insert({ user_id: id });
      return true;
    } catch (error) {
      if (
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        error.code === 'ER_DUP_ENTRY' ||
        // Postgres names neither code above, so it is recognised by message —
        // the same fallback `User.createInitialAdmin` uses for the same reason.
        /duplicate key|unique/i.test(error.message)
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Takes a person off the roster, and says whether that changed anything.
   *
   * Not a delete of the person: the control plane is a hat somebody wears, and
   * taking it off has to leave them the operator account they still work with
   * at their own provider. Their sessions are deliberately NOT revoked — the
   * guard re-reads this table on every request, so the withdrawal bites at the
   * next one, and revoking would sign them out of the panel of the ISP they
   * work for over a change that has nothing to do with it.
   */
  static async remove(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const changed = await getDb()('platform_admins').where({ user_id: id }).del();
    return changed > 0;
  }

  /**
   * A linha do cadastro de uma pessoa, ou null.
   *
   * `has` responde a mesma pergunta e continua sendo o que as guardas usam, de
   * propósito: quem autoriza não deve ter em mãos uma linha de onde tirar mais
   * nada. Esta é para a TELA — devolve daquela pessoa exatamente o que a lista
   * devolveria dela, para que a resposta de uma concessão tenha a forma de um
   * item da lista e o console não precise recarregá-la inteira para mostrar a
   * linha que acabou de nascer.
   */
  static async find(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const row = await getDb()('platform_admins')
      .join('users', 'users.id', 'platform_admins.user_id')
      .where('platform_admins.user_id', id)
      .first(COLUNAS);
    return row || null;
  }

  /**
   * Tira uma pessoa do cadastro, a não ser que ela seja a última.
   * Devolve `'removed'`, `'absent'` ou `'last'`.
   *
   * Um cadastro vazio tranca todo mundo para fora do plano de controle **para
   * sempre**: a guarda relê esta tabela a cada requisição, não há rota que
   * conceda sem já estar nela, e a única volta é `INSERT` no banco por quem
   * tiver o servidor. Por isso a recusa mora aqui embaixo e não na rota — quem
   * chamar `remove` direto continua podendo esvaziar a tabela, e é justamente
   * por isso que `remove` segue existindo: o script de manutenção, rodado por
   * quem tem o servidor na mão, é o dono legítimo dessa saída.
   *
   * **A contagem e a remoção são um ato só**, e é isso que a transação com
   * `forUpdate` compra. Escritas como duas — contar, decidir, remover — dois
   * pedidos simultâneos tirando os dois últimos leem "somos dois" cada um antes
   * de o outro apagar, e os dois passam. Nenhuma variante sem trava resolve
   * isso, inclusive a tentadora `DELETE ... WHERE EXISTS (outro)`: sob MVCC a
   * subconsulta de cada uma enxerga a linha que a outra ainda não confirmou, e
   * as duas apagam do mesmo jeito.
   *
   * `forUpdate` sobre o cadastro inteiro — que tem dezenas de linhas, não
   * milhões — trava as linhas existentes no Postgres e no MySQL: a segunda
   * transação espera a primeira confirmar, relê o que sobrou e é ela quem
   * recebe `'last'`. No SQLite o `FOR UPDATE` não existe e o knex o compila
   * para nada; lá quem serializa é o lock de escritor do arquivo, e a perdedora
   * falha com "database is locked" em vez de apagar. Errar para o lado do erro
   * é aceitável; errar para o lado do cadastro vazio não é.
   *
   * O que `FOR UPDATE` não tranca é um `INSERT` concorrente — ele prende as
   * linhas que existem, não as que vão nascer. Inofensivo na direção que
   * importa: uma concessão em voo só pode fazer esta recusa ser conservadora
   * demais, e quem a receber tenta de novo.
   */
  static async removeUnlessLast(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return 'absent';

    return getDb().transaction(async (trx) => {
      const cadastro = await trx('platform_admins').select('user_id').forUpdate();
      if (!cadastro.some((linha) => Number(linha.user_id) === id)) return 'absent';
      if (cadastro.length <= 1) return 'last';
      await trx('platform_admins').where({ user_id: id }).del();
      return 'removed';
    });
  }

  /**
   * Everyone on the roster, with the person's name joined on.
   *
   * An unfiltered read of a whole table, which everywhere else in this codebase
   * is the shape of query that leaks one provider's rows to another. It is safe
   * here precisely because the table has no provider: the roster is one list for
   * the whole deployment, and the only caller allowed to ask has already passed
   * the guard.
   */
  static async list() {
    return getDb()('platform_admins')
      .join('users', 'users.id', 'platform_admins.user_id')
      .orderBy('users.username', 'asc')
      .select(COLUNAS);
  }
}

export default PlatformAdmin;
