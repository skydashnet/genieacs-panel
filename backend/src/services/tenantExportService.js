import { getDb } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';
import { SCHEMA_TABLES } from '../config/migrations.js';
import { SCOPED_TABLES } from '../config/tenantScope.js';
import Tenant from '../models/Tenant.js';

/**
 * Tudo o que pertence a um provedor, num arquivo.
 *
 * Existe por duas razões que são a mesma de duas direções. A LGPD dá ao titular
 * o direito de levar seus dados embora, e o provedor é titular do que ele
 * cadastrou aqui. E um ISP que decide sair — ou que quer um backup antes de uma
 * migração — não pode depender de nós para ter o próprio cadastro; um SaaS de
 * onde não se sai é um SaaS em que ninguém entra.
 *
 * **As tabelas saem na ordem de criação do schema**, que é a ordem que as
 * chaves estrangeiras exigem. Não é detalhe de arrumação: é o que faz o arquivo
 * poder ser reinserido de cima para baixo sem quebrar referência. Um dump em
 * ordem alfabética é bonito e imprestável.
 */

/**
 * As colunas que NÃO saem, por sufixo.
 *
 * Segredo cifrado exportado é duas coisas ruins ao mesmo tempo: inútil para
 * quem recebe, porque a chave fica aqui e é derivada do `JWT_SECRET` deste
 * deployment; e perigoso para quem guarda, porque um arquivo que circula por
 * e-mail passa a conter o material cifrado de toda a operação. Sai a referência
 * de que existia um segredo — a coluna `..._key_version`, que é metadado — e
 * não o segredo.
 *
 * Por sufixo e não por lista de nomes: o padrão do `secretBox` é
 * `<coisa>_ciphertext` / `_iv` / `_tag`, e o próximo segredo a nascer vai
 * seguí-lo. Uma lista de nomes deixaria o próximo de fora em silêncio.
 *
 * `_token_hash` pelo mesmo raciocínio, para digests de chave: o primeiro foi
 * `agent_token_hash`, a chave do agente do GenieACS. O digest não volta a ser
 * chave, mas quem tem o arquivo não precisa dele para nada — a chave se gera
 * de novo do outro lado — e credencial exportada, ainda que inutilizável, é
 * hábito que a próxima coluna herda (ver `token_hash` abaixo).
 */
const SUFIXOS_OMITIDOS = ['_ciphertext', '_iv', '_tag', '_token_hash'];

/**
 * Colunas que também não saem, nomeadas uma a uma porque não têm padrão.
 *
 * `password_hash` é o hash da senha do portal do assinante: não é reversível,
 * mas é material de ataque offline, e quem recebe o export não precisa dele
 * para nada — a senha é redefinida do outro lado. `token_hash` é o digest de um
 * convite ainda aberto, e quem tivesse o arquivo poderia... nada, porque o
 * digest não volta a ser token. Sai assim mesmo: exportar credencial, ainda que
 * inutilizável, é hábito que a próxima coluna herda.
 */
const COLUNAS_OMITIDAS = new Set(['password_hash', 'token_hash']);

/** Se uma coluna entra no arquivo. */
export function exportaColuna(nome) {
  if (COLUNAS_OMITIDAS.has(nome)) return false;
  return !SUFIXOS_OMITIDOS.some((sufixo) => nome.endsWith(sufixo));
}

class TenantExportService {
  /** A versão do formato. Muda quando a forma do arquivo muda, não o conteúdo. */
  static FORMAT_VERSION = 1;

  /**
   * As tabelas exportadas, na ordem em que as FKs pedem.
   *
   * Derivada de `SCHEMA_TABLES` ∩ `SCOPED_TABLES`, e não escrita à mão: uma
   * tabela nova escopada entra no export sozinha. Escrita à mão, ela ficaria de
   * fora e o export passaria a mentir por omissão — que é o pior jeito de um
   * export falhar, porque parece ter funcionado.
   */
  static tabelas() {
    return SCHEMA_TABLES.filter((tabela) => SCOPED_TABLES.has(tabela));
  }

  /**
   * O arquivo inteiro, como objeto.
   *
   * Em memória e não em stream, e a escolha tem prazo de validade: um provedor
   * com dezenas de milhares de ONTs e um ano de mensagens vai produzir um
   * objeto grande demais para isso, e aí o certo é escrever direto na resposta,
   * tabela a tabela. Enquanto o export for pedido por gente, uma vez, e não por
   * um job, o custo de streamar não se paga — mas o dia em que `wa_messages`
   * sozinho passar de alguns milhões de linhas, este comentário é o aviso.
   */
  /**
   * Por qual coluna ordenar as linhas de uma tabela.
   *
   * Perguntado ao schema e não a uma lista de exceções: uma tabela chave-valor
   * nova entraria na lista só depois de alguém ver o 500.
   */
  static async colunaDeOrdem(tabela) {
    return (await getDb().schema.hasColumn(tabela, 'id')) ? 'id' : 'key';
  }

  static async build() {
    const tenantId = currentTenantId();
    const provedor = await Tenant.findById(tenantId);

    const dados = {};
    const contagem = {};
    for (const tabela of TenantExportService.tabelas()) {
      // `getDb()` e não `tdb`: o filtro está aqui, explícito, porque o export é
      // o único lugar do painel que enumera as tabelas escopadas por fora dos
      // modelos. Passar por `tdb` daria o mesmo resultado e esconderia que este
      // laço precisa do `tenant_id` em toda tabela que percorre — que é
      // justamente o invariante do qual ele depende.
      //
      // tenant-scope-exempt: o filtro é o `where` abaixo, escrito à mão.
      //
      // A ordenação sai da coluna que a tabela realmente tem. `settings` e
      // `app_state` são chave-valor: a primária delas é `key`, e não existe
      // `id` nenhum — ordenar por `id` ali não é "sem ordem definida", é erro
      // de SQL, e derruba o export inteiro por causa de duas tabelas. Descoberto
      // do jeito certo: a rota respondeu 500 no primeiro teste que a chamou.
      const chave = await TenantExportService.colunaDeOrdem(tabela);
      const linhas = await getDb()(tabela).where({ tenant_id: tenantId }).orderBy(chave, 'asc');
      dados[tabela] = linhas.map((linha) => Object.fromEntries(
        Object.entries(linha).filter(([coluna]) => exportaColuna(coluna))
      ));
      contagem[tabela] = dados[tabela].length;
    }

    return {
      manifest: {
        formatVersion: TenantExportService.FORMAT_VERSION,
        generatedAt: new Date().toISOString(),
        // O cadastro fiscal vai junto, e não é detalhe: a exportação é o que o
        // provedor leva quando sai, e o que ele cadastrou sobre si mesmo é a
        // primeira coisa que ele espera encontrar lá dentro. `tenants` não é
        // tabela escopada e por isso não entra pelo laço acima — sem esta
        // linha, o único dado do arquivo que fala do dono do arquivo seria o
        // nome.
        tenant: provedor
          ? { id: provedor.id, slug: provedor.slug, name: provedor.name, billing: Tenant.presentBilling(provedor) }
          : null,
        tables: TenantExportService.tabelas(),
        rowCounts: contagem,
        // Dito no próprio arquivo e não só na documentação: quem abrir isto
        // daqui a dois anos precisa saber o que NÃO está aqui antes de concluir
        // que a senha de alguém se perdeu.
        omittedColumns: {
          bySuffix: SUFIXOS_OMITIDOS,
          byName: [...COLUNAS_OMITIDAS],
          why: 'Segredos cifrados e hashes de senha não são exportados: são inúteis '
            + 'fora deste deployment e perigosos dentro de um arquivo que circula.'
        }
      },
      data: dados
    };
  }
}

export default TenantExportService;
