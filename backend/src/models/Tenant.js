import { getDb, insertReturningId } from '../config/database.js';

/**
 * The provider rows themselves — read both from the control plane and, for the
 * two public columns, by anybody who reached a provider's own address.
 *
 * Deliberately NOT read through `tdb`, and for a reason worth stating twice
 * because it is the same one from two directions. `tenants` has no `tenant_id`:
 * it IS the provider. `tdb` would hand back an unfiltered builder anyway, since
 * it only filters tables it knows are scoped — so reaching for it here would
 * LOOK like a scoped read while being nothing of the kind, which is worse than
 * being plainly unscoped. And the registry half is asked ABOVE any one
 * provider: filtering it by the scope would make listing providers return the
 * one you are already in.
 *
 * That is safe only because of what stands in front of each half. The registry
 * methods are unreachable without `requirePlatformAdmin`; the public read
 * carries its own column allowlist, below. Every method names the provider it
 * wants, explicitly, in its arguments.
 */
class Tenant {
  /**
   * The columns a stranger may see.
   *
   * Written out rather than taken as `select *` because this list is a
   * security decision, not a convenience. Somebody will eventually add a column
   * to `tenants` — a plan, a billing status, a contact address, a trial expiry
   * — and with `select *` that column would be on the public internet the
   * moment the migration ran, with no diff anywhere near this file to review.
   * Enumerating them means a new column is private by default and becomes
   * public only when a human writes its name here.
   *
   * `kind` é o terceiro, e passou por essa peneira: ele NÃO é fato sobre um
   * cliente, é fato sobre qual dos endereços do próprio deploy se está olhando.
   * O nome e o slug, que já saem aqui, já dizem o mesmo a quem chegou — e o que
   * ele compra é a tela saber que a caixa interna da plataforma não gerencia
   * equipamento nenhum, e por isso não deve ser empurrada para o onboarding de
   * GenieACS.
   */
  static PUBLIC_COLUMNS = ['name', 'slug', 'kind'];

  /**
   * O cadastro fiscal, e é o parágrafo acima cobrado na prática: estas doze
   * colunas existem desde a migração 0043 e NENHUMA delas está em
   * `PUBLIC_COLUMNS`. O CNPJ e o endereço de um ISP não são segredo de estado,
   * mas também não são coisa que a tela de login de um provedor deva servir a
   * quem passar pelo host — e a lista pública é o que garante isso sem depender
   * de ninguém lembrar.
   *
   * Enumeradas aqui, e não derivadas do banco, pelo mesmo motivo: quem
   * acrescentar uma coluna a `tenants` amanhã não a vê aparecer sozinha numa
   * resposta de API.
   */
  static BILLING_COLUMNS = [
    'billing_legal_name',
    'billing_tax_id',
    'billing_state_registration',
    'billing_postal_code',
    'billing_address_line',
    'billing_address_number',
    'billing_address_extra',
    'billing_district',
    'billing_city',
    'billing_state',
    'billing_email',
    'billing_phone'
  ];

  /**
   * Quem este provedor é dentro do gateway de pagamento.
   *
   * Separadas de `BILLING_COLUMNS` de propósito, ainda que morem na mesma
   * tabela: aquelas são o cadastro FISCAL, que o próprio provedor preenche na
   * tela de plano dele (`PATCH /api/tenant`), e estas são a correlação com um
   * sistema nosso, que só o console da plataforma escreve. Um provedor não pode
   * dizer de quem é o dinheiro que entra — misturar as duas listas daria a ele
   * exatamente isso, por uma rota que já existe e já é dele.
   *
   * Fora de `PUBLIC_COLUMNS`, como todo o resto: o id de um cliente num gateway
   * é o tipo de coisa que não aparece numa resposta pública por esquecimento.
   */
  static GATEWAY_COLUMNS = ['billing_gateway', 'billing_customer_ref'];

  /** A correlação com o gateway, em camelCase, para o console. */
  static presentGateway(row) {
    if (!row) return null;
    return {
      gateway: row.billing_gateway ?? null,
      customerRef: row.billing_customer_ref ?? null
    };
  }

  /**
   * Grava a correlação. Mesma regra de `updateBilling`: ausente não toca,
   * presente e vazio apaga — que é como se desliga um provedor do gateway sem
   * mexer no cadastro fiscal dele.
   */
  static async updateGateway(id, patch) {
    const update = {};
    for (const coluna of Tenant.GATEWAY_COLUMNS) {
      if (!(coluna in patch)) continue;
      const valor = patch[coluna];
      update[coluna] = valor === null || valor === '' ? null : valor;
    }
    if (!Object.keys(update).length) return false;
    update.updated_at = new Date();
    const changed = await getDb()('tenants').where({ id }).update(update);
    return changed > 0;
  }

  /**
   * Liga o provedor a um cliente no gateway SÓ SE ele ainda não tem nenhum.
   *
   * Um `UPDATE` condicional, e não ler-conferir-gravar: dois cliques quase
   * juntos no "pagar agora" (ou o botão do console e o clique do provedor)
   * passariam os dois pela leitura, e o segundo a gravar trocaria o vínculo
   * do primeiro — com a primeira cobrança já emitida para um cliente que o
   * provedor deixou de ter. Aqui o banco decide, e quem perde recebe `false`
   * e relê quem ganhou.
   *
   * @returns {Promise<boolean>} se esta chamada fez o vínculo.
   */
  static async linkGatewayIfUnlinked(id, { gateway, customerRef }) {
    const changed = await getDb()('tenants')
      .where({ id })
      .where((livre) => livre.whereNull('billing_customer_ref').orWhere('billing_customer_ref', ''))
      .update({ billing_gateway: gateway, billing_customer_ref: customerRef, updated_at: new Date() });
    return changed > 0;
  }

  /** O cadastro fiscal de uma linha já lida, em camelCase, para a tela. */
  static presentBilling(row) {
    if (!row) return null;
    const saida = {};
    for (const coluna of Tenant.BILLING_COLUMNS) {
      const chave = coluna.replace(/^billing_/, '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      saida[chave] = row[coluna] ?? null;
    }
    return saida;
  }

  /**
   * Grava o cadastro fiscal. Recebe já normalizado e validado pelo chamador —
   * o modelo não sabe o que é um CNPJ, e não deve saber.
   *
   * Campo ausente do objeto não é tocado; campo presente e vazio vira nulo, que
   * é como se apaga um dado que foi preenchido por engano. A diferença entre os
   * dois é a razão de este método não aceitar um objeto completo montado com
   * defaults.
   */
  static async updateBilling(id, patch) {
    const update = {};
    for (const coluna of Tenant.BILLING_COLUMNS) {
      if (!(coluna in patch)) continue;
      const valor = patch[coluna];
      update[coluna] = valor === null || valor === '' ? null : valor;
    }
    if (!Object.keys(update).length) return false;
    update.updated_at = new Date();
    const changed = await getDb()('tenants').where({ id }).update(update);
    return changed > 0;
  }

  /**
   * O que o portal do assinante pode mostrar do provedor, quando ele liga
   * "mostrar contato": nome, telefone, e-mail e endereço.
   *
   * Lista própria, e não um recorte de `BILLING_COLUMNS` na hora: CNPJ,
   * inscrição estadual e razão social ficam de fora por construção, e quem
   * um dia acrescentar uma coluna fiscal ao cadastro não a publica no portal
   * sem passar por aqui.
   */
  static PORTAL_CONTACT_COLUMNS = [
    'name',
    'billing_phone',
    'billing_email',
    'billing_address_line',
    'billing_address_number',
    'billing_address_extra',
    'billing_district',
    'billing_city',
    'billing_state',
    'billing_postal_code'
  ];

  static async findPortalContactById(id) {
    if (!id) return null;
    const row = await getDb()('tenants')
      .where({ id })
      .first(...Tenant.PORTAL_CONTACT_COLUMNS);
    return row || null;
  }

  /**
   * One provider's public identity, or null when no such row exists.
   *
   * Deliberately does NOT filter on `status`. It is tempting to make this
   * refuse a suspended provider — but callers of this reach it only after the
   * resolver has already accepted the request, and being stricter here than the
   * rest of the API is itself the leak: a prober who gets 404 from this route
   * and 401 from `/api/auth/login` on the same host has just learned that the
   * provider exists and is switched off. Whatever policy governs a suspended
   * provider has to be the resolver's, applied once, to every route at the same
   * time.
   */
  static async findPublicById(id) {
    if (!id) return null;
    const row = await getDb()('tenants')
      .where({ id })
      .first(...Tenant.PUBLIC_COLUMNS);
    return row || null;
  }

  /**
   * Se a linha é um CLIENTE (`provider`) ou é a própria plataforma
   * (`platform`).
   *
   * A plataforma precisa de uma linha em `tenants` porque o schema exige dono
   * para coisas que ela também tem — a caixa de WhatsApp com que ela atende os
   * provedores, antes de qualquer outra. O que esta coluna faz é impedir que
   * essa linha seja CONFUNDIDA com um cliente: ela não é listada como provedor,
   * não é cobrada e não conta na pergunta que decide a marca da tela de login.
   *
   * O que ela NÃO muda, de propósito: `forEachTenant` continua visitando. É
   * exatamente por isso que a fila de envio e os alertas da caixa da plataforma
   * funcionam sem uma linha de código nova.
   */
  static KINDS = Object.freeze(['provider', 'platform']);

  /** Every provider, oldest first — the order the console lists them in. */
  static async list() {
    return Tenant.providers();
  }

  /**
   * Os CLIENTES, que é o que "provedor" quer dizer em toda tela que lista.
   *
   * `list()` delega aqui e não o contrário: quem escrever uma listagem nova vai
   * chamar `list`, e o padrão dela tem que ser o seguro. Quem precisa da linha
   * da plataforma junto pede `every()` e diz por quê.
   */
  static async providers() {
    return getDb()('tenants').where({ kind: 'provider' }).orderBy('id', 'asc');
  }

  /**
   * Toda linha, a da plataforma incluída. Um chamador só, hoje: a rotação de
   * segredos, que precisa alcançar o que está guardado em qualquer lugar.
   */
  static async every() {
    return getDb()('tenants').orderBy('id', 'asc');
  }

  /** A linha da plataforma, se este deploy tiver uma. */
  static async platform() {
    return (await getDb()('tenants').where({ kind: 'platform' }).first()) || null;
  }

  /**
   * Quantos CLIENTES existem.
   *
   * Um `COUNT` e não um `list().length`: quem pergunta é o perfil público — a
   * tela de login, a rota mais batida do deploy —, e ali a resposta é "um ou
   * mais de um", não a lista.
   *
   * E conta só `provider` porque é disso que a pergunta trata: com mais de um
   * cliente no mesmo endereço, a tela de login para de vestir a marca do
   * primeiro. A caixa da plataforma não é um provedor compartilhando a porta —
   * contá-la faria um deploy de um único ISP perder o nome dele na tela.
   */
  static async count() {
    const row = await getDb()('tenants').where({ kind: 'provider' }).count({ total: '*' }).first();
    return Number(row?.total ?? 0);
  }

  static async findById(id) {
    return (await getDb()('tenants').where({ id }).first()) || null;
  }

  /**
   * The slug is the subdomain, and DNS does not distinguish case, so the lookup
   * must not either — otherwise "Alfa" and "alfa" would both be accepted as
   * free and then resolve to the same host. The insert path rejects anything
   * that is not already lowercase, so this only ever matches on equal terms;
   * comparing on the lowered value keeps that true even for rows written by
   * hand before the rule existed.
   */
  static async findBySlug(slug) {
    return (await getDb()('tenants')
      .whereRaw('LOWER(slug) = ?', [String(slug).toLowerCase()])
      .first()) || null;
  }

  /**
   * How many people hold a membership at each provider, keyed by provider id.
   *
   * Grouped in one query rather than counted per provider, so listing stays two
   * queries however many providers the deployment grows to — the same shape
   * `seedDefaults` uses for catalogue sizes.
   */
  static async operatorCounts() {
    const rows = await getDb()('tenant_users')
      .select('tenant_id')
      .count({ n: '*' })
      .groupBy('tenant_id');
    return new Map(rows.map((row) => [Number(row.tenant_id), Number(row.n)]));
  }

  /**
   * Writes the row and returns its id. Seeding is NOT done here: it belongs to
   * the caller, which owns the transaction that has to cover both.
   */
  static async create({ slug, name, status = 'active', kind = 'provider' }, trx = null) {
    if (!Tenant.KINDS.includes(kind)) throw new Error(`Unknown tenant kind: ${kind}`);
    return insertReturningId('tenants', { slug, name, status, kind }, trx);
  }

  static async rename(id, name) {
    const changed = await getDb()('tenants')
      .where({ id })
      .update({ name, updated_at: new Date() });
    return changed > 0;
  }

  /**
   * O nome e o endereço de um provedor, numa escrita só.
   *
   * Uma instrução e não `rename` seguido de um `setSlug` porque as duas colunas
   * mudam juntas ou não mudam: uma falha entre as duas deixaria o provedor com
   * o nome novo no endereço velho — e uma linha de trilha descrevendo uma
   * mudança que aconteceu pela metade.
   *
   * `rename` fica: é o que o próprio provedor usa para se renomear, e aquele
   * caminho não tem endereço para mexer.
   *
   * O slug chega já validado, porque a regra do endereço mora em `utils/slug.js`
   * e é compartilhada com o cadastro próprio. O que decide uma CORRIDA entre
   * dois pedidos, por outro lado, não é validação nenhuma: é o índice único — e
   * quem chama relê a tabela para distinguir a corrida de um erro de verdade,
   * como na criação.
   */
  static async updateIdentity(id, { name, slug }) {
    const patch = { updated_at: new Date() };
    if (name !== undefined) patch.name = name;
    if (slug !== undefined) patch.slug = slug;
    const changed = await getDb()('tenants')
      .where({ id })
      .update(patch);
    return changed > 0;
  }

  /**
   * O status, e a data que anda com ele.
   *
   * `suspended_at` é escrita AQUI e não no controlador porque este é o ponto
   * único por onde toda mudança de status passa — é o que garante que a data e
   * o status não possam divergir. No controlador, a garantia dependeria de
   * quem chama lembrar.
   *
   * O `COALESCE` é o detalhe que importa: suspender quem JÁ está suspenso não
   * pode reiniciar o relógio. Sem ele, "parado há oito meses" vira "parado há
   * um minuto" porque alguém clicou duas vezes, ou porque uma automação
   * reafirmou o estado — e o número menor não parece errado, que é o que torna
   * esse defeito invisível. Feito na própria escrita, e não lendo a linha
   * antes, porque uma instrução só não tem corrida no meio.
   *
   * Reativar zera a coluna, então uma suspensão futura começa a contar do zero.
   */
  static async setStatus(id, status) {
    const db = getDb();
    const agora = new Date();
    const changed = await db('tenants')
      .where({ id })
      .update({
        status,
        updated_at: agora,
        suspended_at: status === 'suspended'
          ? db.raw('COALESCE(suspended_at, ?)', [agora])
          : null
      });
    return changed > 0;
  }

  /** Se o provedor exige o login em duas etapas da equipe. */
  static async requiresMfa(id) {
    const row = await getDb()('tenants').where({ id }).first('require_mfa');
    return mfaRequired(row);
  }

  static async setRequireMfa(id, required) {
    const changed = await getDb()('tenants')
      .where({ id })
      .update({ require_mfa: Boolean(required), updated_at: new Date() });
    return changed > 0;
  }
}

/**
 * A coluna lida como booleano nos três bancos: o Postgres devolve `true`, o
 * MySQL e o SQLite devolvem `1`. Linha ausente é "não exige".
 */
export function mfaRequired(row) {
  return Boolean(Number(row?.require_mfa ?? 0));
}

export default Tenant;
