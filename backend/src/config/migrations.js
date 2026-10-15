/**
 * Ordered schema migrations.
 *
 * Each step carries a stable id that is recorded in `schema_migrations` once it
 * succeeds. Ids are never renumbered and never reused: appending a new step is
 * the only supported way to change the schema.
 *
 * Two rules keep the runner safe on installations that predate it:
 *  - every `up` is idempotent, so re-running it on a database that already has
 *    the objects is a no-op instead of an error;
 *  - `isApplied` reports whether the step's objects are already in place, which
 *    is what lets `ensureSchema` baseline an old database (record the step as
 *    applied) rather than migrate it again.
 *
 * Only knex builders that behave the same on better-sqlite3, mysql2 and pg are
 * used here; there is no raw SQL and no dialect-specific syntax. CI runs the
 * whole suite against all three, so a step that holds on only one of them fails
 * before it reaches anyone's database.
 */

import { withWebhookPath } from './waWebhookPath.js';
import { nextAccountColor } from './waAccountColors.js';
import { LEGACY_PRODUCT_NAMES, PRODUCT_NAME } from './brand.js';

/** A chave do blob de configuração do Evolution em `app_state`. */
const EVOLUTION_CONFIG_KEY = 'whatsapp_evolution_config';

/**
 * O blob reescrito com o caminho do painel no `webhookBaseUrl`, ou `null`
 * quando não há nada a fazer.
 *
 * `null` cobre quatro casos distintos, e todos eles querem dizer "não toque":
 * o valor não é JSON, não há endereço gravado, o endereço já termina no caminho
 * do painel, ou o caminho é OUTRO e foi digitado de propósito. O último é o que
 * exige cuidado — quem serve o painel sob um prefixo próprio quebraria se esta
 * migração reescrevesse o que ele configurou —, e quem o distingue é
 * `withWebhookPath`, a mesma função que a gravação usa. Não há segunda cópia
 * da regra aqui, porque duas cópias divergem.
 *
 * Endereço com query ou fragmento também fica intacto: este passo conserta a
 * FALTA de caminho, e reconstruir a URL a partir de origem e caminho descartaria
 * o resto sem que ninguém tivesse pedido.
 */
function caminhoDoWebhookCorrigido(valor) {
  let blob;
  try {
    blob = JSON.parse(valor);
  } catch {
    return null;
  }
  if (!blob || typeof blob !== 'object') return null;

  const atual = typeof blob.webhookBaseUrl === 'string' ? blob.webhookBaseUrl.trim() : '';
  if (!atual) return null;

  let url;
  try {
    url = new URL(atual);
  } catch {
    // Endereço inválido não é problema deste passo: a gravação já o recusa, e
    // adivinhar o que quem digitou queria dizer é pior que deixar como está.
    return null;
  }
  if (url.search || url.hash) return null;

  const resultado = withWebhookPath(url.origin, url.pathname);
  if (resultado.erro || resultado.url === atual) return null;

  return JSON.stringify({ ...blob, webhookBaseUrl: resultado.url });
}

/** Portal credential columns, shared by the initial table and the 0003 upgrade. */
const CUSTOMER_PASSWORD_COLUMNS = [
  ['password_hash', (t) => t.string('password_hash', 255)],
  ['password_ciphertext', (t) => t.text('password_ciphertext')],
  ['password_iv', (t) => t.string('password_iv', 32)],
  ['password_tag', (t) => t.string('password_tag', 32)],
  ['password_updated_at', (t) => t.timestamp('password_updated_at')]
];

/**
 * Records which key encrypted each stored secret.
 *
 * Every ciphertext used to be derived from JWT_SECRET, and `secretBox.decrypt`
 * reports failure by returning null. Rotating that secret — an ordinary
 * security operation — therefore turned every stored secret into an unreadable
 * blob, silently. With the version on the row, a deployment can move to a
 * dedicated SECRET_BOX_KEY and still read what was written before the move.
 *
 * Only the secrets stored in their own columns need this. The ones kept as
 * JSON in `app_state` (the SGP token, the Evolution admin key) already carry
 * the field, because those helpers spread the whole box output into the object.
 *
 * Existing rows stay NULL, which already means version 1; writing a value
 * would be a fleet-sized update that says nothing the absence does not.
 */
const SECRET_KEY_VERSION_COLUMNS = [
  ['customer_accounts', ['password_key_version']],
  ['customer_wifi_credentials', ['password_key_version']],
  ['provisioning_profiles', ['wifi_password_key_version', 'cpe_password_key_version']],
  ['whatsapp_accounts', ['token_key_version', 'webhook_token_key_version']]
];

function keyVersionColumns(names) {
  return names.map((name) => [name, (t) => t.integer(name)]);
}

/** Shared by the initial `users` table and the 0002 upgrade. */
function addTokenVersion(t) {
  t.integer('token_version').notNullable().defaultTo(0);
}

/**
 * Shared by `sgp_links` and the 0008 upgrade.
 *
 * WhatsApp needs a number and the panel never had one anywhere. `phone_e164` is
 * what SGP returned on the last sync; `phone_manual` is what an operator typed
 * and always wins, because the ERP cadastre is often stale and the operator is
 * the one holding the correction.
 */
const SGP_PHONE_COLUMNS = [
  ['phone_e164', (t) => t.string('phone_e164', 24)],
  ['phone_manual', (t) => t.string('phone_manual', 24)]
];

function addSgpPhoneColumns(t) {
  for (const [, add] of SGP_PHONE_COLUMNS) add(t);
}

/**
 * Shared by `wa_messages` and the 0014 upgrade.
 *
 * Rows written before this column existed default to 'operator'. That is the
 * safe direction: the ceiling this column exists to make honest only ever
 * counts 'bot', so an old row misfiled as an operator's message can silence
 * nothing.
 */
const WA_MESSAGE_SOURCE_COLUMNS = [
  ['source', (t) => t.string('source', 16).notNullable().defaultTo('operator')]
];

/**
 * Shared by `wa_messages` and the 0020 upgrade.
 *
 * Three queries that already existed and had no index that fit them. See the
 * 0018 step for what each one serves and why the index it had did not.
 */
const WA_MESSAGE_OUTBOX_INDEXES = [
  ['conversation_id', 'id'],
  ['tenant_id', 'created_at'],
  ['delivery_status', 'next_attempt_at']
];

/**
 * Shared by the 0023 upgrade.
 *
 * The runs' two existing indexes, re-fronted with `tenant_id`: a scoped query
 * always carries the provider, so an index that does not lead with it is one
 * the planner has to look past.
 */
const PROVISIONING_RUN_TENANT_INDEXES = [
  [['tenant_id', 'device_id', 'status'], 'provisioning_runs_tenant_device_status_idx'],
  [['tenant_id', 'status', 'next_attempt_at'], 'provisioning_runs_tenant_due_idx']
];

/**
 * Shared by the 0026 upgrade.
 *
 * Eram três: `wifi_security_mappings` apontava para `vendors`, e a ordem aqui
 * existia para converter o pai primeiro. A 0052 derrubou a tabela do meio — as
 * duas que sobraram não têm chave estrangeira entre si, e a ordem virou só
 * hábito.
 */
const VENDOR_CATALOGUE_TABLES = ['vendors', 'wifi_security_config'];

// Table definitions. Each is a factory so the builder can reach `db.fn.now()`,
// and each is referenced by exactly one place per table so the initial schema
// and the later upgrade steps can never drift apart.

/**
 * Os provedores que têm `admin` e nenhum `owner` — os que a 0065 promove.
 * Lido direto das tabelas: a migração roda antes de qualquer contexto de
 * provedor existir.
 */
async function semDonoComAdmin(db) {
  const comDono = db('tenant_users').where({ role: 'owner' }).select('tenant_id');
  const linhas = await db('tenant_users')
    .where({ role: 'admin' })
    .whereNotIn('tenant_id', comDono)
    .distinct('tenant_id');
  return linhas.map((linha) => linha.tenant_id).sort((a, b) => a - b);
}

const tenantUsersTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('user_id').unsigned().notNullable()
    .references('id').inTable('users').onDelete('CASCADE');
  // The role belongs to the MEMBERSHIP, not to the person: someone can be an
  // admin at the ISP they own and an ordinary operator at one they consult for.
  t.string('role', 32).notNullable().defaultTo('user');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  // One membership per person per provider. This is the row the token names,
  // so a duplicate would make "which role does she have here" ambiguous.
  t.unique(['tenant_id', 'user_id']);
  // How the users screen asks: everyone at this provider.
  t.index(['tenant_id']);
};

const usersTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('username', 64).notNullable().unique();
  // O e-mail com que a pessoa entra. Nulo é legítimo e é o estado de toda conta
  // que existia antes desta coluna: o login por nome continua valendo enquanto
  // `LOGIN_REQUIRES_EMAIL` estiver desligado, que é o que permite a troca
  // acontecer sem um dia de virada em que ninguém entra.
  //
  // 255 porque é o limite prático de um endereço; guardado sempre em minúsculas
  // — ver `User.normalizeEmail` e o porquê de a comparação não poder depender
  // da colação do banco.
  t.string('email', 255).unique();
  // Quando o endereço acima foi PROVADO — nulo enquanto não foi, que é o estado
  // de toda conta anterior a esta coluna e de todo endereço recém-trocado.
  // Cadastrar um endereço prova que se controla a CONTA (a senha atual é
  // exigida); não prova que se controla o ENDEREÇO. A diferença não custava
  // nada enquanto só a senha abria a conta, e passa a custar tudo com a
  // redefinição por e-mail: um endereço errado guardado aqui é um caminho para
  // dentro da conta. Por isso só endereço verificado recebe redefinição.
  t.timestamp('email_verified_at');
  t.string('password', 255).notNullable();
  t.string('role', 32).notNullable().defaultTo('user');
  // Telefone da pessoa, só dígitos (com DDI). Serve para o console mandar o
  // link de senha pelo WhatsApp; nulo é o estado de toda conta anterior a ele.
  t.string('phone', 32);
  addTokenVersion(t);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const keyValueTable = (db) => (t) => {
  t.string('key', 128).primary();
  t.text('value');
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const vendorsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('name', 128).notNullable();
  t.text('manufacturer_patterns');
  t.text('product_patterns');
  t.string('parameter_prefix', 255);
  t.string('service_list_path', 255);
  t.string('lan_binding_path', 255);
  t.string('vlan_id_path', 255);
  t.string('wifi_password_path', 255);
  t.string('http_wan_enable_path', 255);
  t.string('firewall_level_path', 255);
  t.integer('priority').notNullable().defaultTo(10);
  t.boolean('enabled').notNullable().defaultTo(true);
  t.text('description');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const wifiSecurityConfigTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('product_class', 128).notNullable();
  t.string('security_types', 255);
  t.string('password_param_path', 255);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const mappingNodesTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('node_id', 128).notNullable().unique();
  t.string('type', 32).notNullable();
  t.string('name', 255).notNullable();
  t.decimal('latitude', 10, 7).notNullable();
  t.decimal('longitude', 10, 7).notNullable();
  t.integer('capacity');
  t.string('splitter', 64);
  t.string('pppoe', 255);
  t.text('notes');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const mappingEdgesTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('edge_id', 128).notNullable().unique();
  t.string('source', 128).notNullable().references('node_id').inTable('mapping_nodes').onDelete('CASCADE');
  t.string('target', 128).notNullable().references('node_id').inTable('mapping_nodes').onDelete('CASCADE');
  t.string('fiber_type', 32);
  t.decimal('distance', 10, 2);
  t.text('waypoints');
  t.text('notes');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const mapSettingsTable = (db) => (t) => {
  t.integer('id').primary();
  t.string('center_lat', 32).notNullable();
  t.string('center_lng', 32).notNullable();
  t.string('max_zoom_in', 8).notNullable();
  t.string('max_zoom_out', 8).notNullable();
  t.string('default_zoom', 8).notNullable();
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const customerAccountsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('customer_id', 32).notNullable().unique();
  t.string('device_id', 255).notNullable().unique();
  t.string('identity_hash', 64).notNullable().unique();
  t.string('software_id', 255).notNullable();
  t.string('pppoe_username', 255).notNullable();
  t.boolean('active').notNullable().defaultTo(true);
  // Portal credentials are independent of the Customer ID: the ID only
  // identifies the account, the hash authenticates it, and the encrypted
  // copy lets an operator hand the password back without resetting it.
  for (const [, add] of CUSTOMER_PASSWORD_COLUMNS) add(t);
  t.timestamp('last_seen_at').defaultTo(db.fn.now());
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const deviceProfilesTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('device_id', 255).notNullable().unique();
  t.date('installation_date');
  t.string('installation_tag', 64);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const sgpLinksTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('device_id', 255).notNullable().unique();
  t.integer('account_id').unsigned()
    .references('id').inTable('customer_accounts').onDelete('SET NULL');
  t.string('contract', 64).notNullable();
  t.string('document', 32);
  t.string('client_name', 255);
  t.string('plan', 255);
  t.string('status', 64);
  t.string('status_label', 128);
  // Derived from the SGP status so the fleet views can group contracts
  // without depending on each install's Portuguese labels.
  t.string('state', 16).notNullable().defaultTo('unknown');
  t.string('login', 255);
  t.string('link_mode', 16).notNullable().defaultTo('auto');
  addSgpPhoneColumns(t);
  t.timestamp('last_synced_at').defaultTo(db.fn.now());
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const customerWifiCredentialsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('account_id').unsigned().notNullable()
    .references('id').inTable('customer_accounts').onDelete('CASCADE');
  t.integer('wifi_index').notNullable();
  t.string('ssid', 32).notNullable();
  t.text('password_ciphertext');
  t.string('password_iv', 32);
  t.string('password_tag', 32);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['account_id', 'wifi_index']);
};

/**
 * A provider. One row today — the install itself — so that every table that
 * will be scoped has something real to point at before anything depends on it.
 */
/**
 * The SaaS control plane's roster. Deliberately just an identity: what a
 * platform administrator may do is decided in code, not by a role string here,
 * because there is exactly one such power and naming degrees of it would invite
 * inventing more.
 */
const platformAdminsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('user_id').unsigned().notNullable().unique()
    .references('id').inTable('users').onDelete('CASCADE');
  t.timestamp('created_at').defaultTo(db.fn.now());
};

/**
 * O bilhete de personificação: como uma sessão do plano de controle chega ao
 * navegador no endereço do provedor.
 *
 * O token da personificação NÃO viaja numa URL. Num deploy com subdomínio o
 * console vive num host e o painel do provedor noutro, e as duas formas óbvias
 * de atravessar essa fronteira são ruins: um JWT no query string entra em log
 * de proxy, em histórico e em `Referer`; um cookie no domínio-pai desfaz
 * justamente a garantia host-only que a Fase 2 conquistou. O bilhete é a
 * terceira: um valor opaco de uso único, válido por um minuto, que o console
 * põe no FRAGMENTO da URL — a parte que o navegador nunca manda ao servidor —
 * e que a tela do provedor troca pelo token no host dela mesma.
 *
 * Guarda o hash e nunca o valor, como `tenant_invites` e pelo mesmo motivo: um
 * bilhete é uma credencial enquanto vive. Compartilhada, não escopada, porque
 * é cunhada ANTES de existir escopo — o plano de controle está acima dos
 * provedores — e porque quem a lê para resgatar ainda não sabe de qual
 * provedor ela é.
 */
const impersonationTicketsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('token_hash', 64).notNullable().unique();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  // Quem personifica. `CASCADE` porque um bilhete de alguém que deixou de
  // existir não pode ser resgatado por ninguém.
  t.integer('platform_user_id').unsigned().notNullable()
    .references('id').inTable('users').onDelete('CASCADE');
  t.timestamp('expires_at').notNullable();
  t.timestamp('redeemed_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.index(['expires_at'], 'impersonation_tickets_expiry_idx');
};

/**
 * O bilhete que vai por e-mail: redefinição de senha e prova de endereço.
 *
 * Uma tabela para os dois, e não uma para cada, porque são o mesmo mecanismo —
 * um valor opaco de uso único, guardado como hash, com prazo, entregue no
 * fragmento de uma URL e resgatado no host do provedor. O que muda entre eles é
 * só o que o resgate FAZ, e isso é código, não schema. `tenant_invites` e
 * `impersonation_tickets` têm tabela própria porque carregam campos próprios
 * (o papel oferecido, quem personifica); estes dois carregam exatamente os
 * mesmos quatro fatos.
 *
 * `email` é o endereço para onde o bilhete foi — e é o que o resgate confere
 * contra o endereço atual da conta. Sem essa coluna, um link de redefinição
 * mandado para um endereço antigo continuaria valendo depois de a pessoa trocar
 * de endereço, que é justamente o caminho que a troca deveria fechar. Para a
 * prova de endereço ele é o próprio objeto: é este endereço que está sendo
 * provado, e não o que a linha de `users` tiver quando alguém clicar.
 *
 * `tenant_id` é o host por onde o bilhete entra. Uma pessoa pode trabalhar para
 * vários provedores, e o link aponta para um painel só; conferir o provedor no
 * resgate é o que impede um link cunhado num host de ser gasto noutro.
 */
const authTicketsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('token_hash', 64).notNullable().unique();
  // 'password_reset' | 'email_verification' — ver `AuthTicket.PURPOSES`.
  t.string('purpose', 32).notNullable();
  t.integer('user_id').unsigned().notNullable()
    .references('id').inTable('users').onDelete('CASCADE');
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('email', 255).notNullable();
  t.timestamp('expires_at').notNullable();
  t.timestamp('redeemed_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.index(['expires_at'], 'auth_tickets_expiry_idx');
  t.index(['user_id', 'purpose'], 'auth_tickets_user_purpose_idx');
};

/**
 * O convite: como uma pessoa entra na equipe de um provedor sem que o
 * administrador escolha a senha dela.
 *
 * A onda 12 recusou, com razão, que o administrador de um provedor anexasse
 * alguém que já existe no deploy: aquele request carrega uma SENHA, e há uma
 * senha por pessoa, então "adicionar a maria" digitado aqui trocaria o login de
 * uma estranha que trabalha para outro ISP, derrubaria as sessões dela em todo
 * lugar e entregaria a este administrador credenciais válidas no painel do
 * vizinho. O convite é a saída: quem administra oferece o vínculo, e é a pessoa
 * convidada quem entra — com a conta que já tem, ou com uma que ela mesma cria.
 *
 * Guarda o HASH do token e nunca o token. O que vai no link é mostrado uma vez,
 * na resposta da criação, e não pode ser recuperado depois — mesma disciplina
 * do segredo do webhook do SGP e da senha do portal do assinante. Um convite é
 * uma credencial: quem tem o link entra na equipe.
 */
/**
 * A trilha das ações sensíveis: quem fez, o quê, sobre quem, e quando.
 *
 * Escopada por provedor como quase tudo aqui, e por um motivo além do óbvio: a
 * trilha de um ISP diz quem são seus operadores, quantos assinantes ele tem e
 * quando alguém revelou a senha de um deles. É dado tão dele quanto a lista de
 * contratos.
 *
 * A coluna `detail` é a que mais precisa de disciplina. Nada de segredo entra
 * ali — nem a senha revelada, nem a credencial da NBI, nem o token do convite.
 * O que a trilha registra é que a senha foi revelada, não qual era: a primeira
 * coisa é o que permite auditar, a segunda transformaria a auditoria no maior
 * repositório de segredos em claro do produto. `audit-log.test.js` guarda isso
 * com uma varredura sobre o que cada gravação de verdade produz.
 */
/**
 * A trilha do plano de controle — acima dos provedores, não dentro de um.
 *
 * `audit_log` é escopada e responde "o que aconteceu no meu painel?". Esta
 * responde outra coisa: o que quem opera o SaaS fez COM um provedor. Precisa
 * ser uma tabela à parte por uma razão que não é organização: a exclusão de um
 * provedor tem que deixar registro, e registrar isso na trilha DELE é inútil —
 * ela vai junto.
 *
 * Daí `tenant_id` ser um inteiro simples e **não** uma chave estrangeira, com o
 * slug e o nome desnormalizados ao lado. Uma FK aqui apagaria em cascata (ou
 * impediria) exatamente a linha que existe para dizer que aquele provedor foi
 * apagado, que é a única linha desta tabela que não pode faltar.
 */
const platformAuditTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('actor_user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.string('actor_username', 64);
  t.string('action', 64).notNullable();
  // Sem FK, de propósito. Ver acima.
  t.integer('tenant_id').unsigned();
  t.string('tenant_slug', 64);
  t.string('tenant_name', 128);
  t.text('detail');
  t.string('ip', 64);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.index(['created_at', 'id'], 'platform_audit_recent_idx');
};

const auditLogTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  // `SET NULL` e não `CASCADE`: a pessoa pode sair, e a linha que diz o que ela
  // fez tem que continuar de pé. Uma trilha que some junto com quem a produziu
  // não é trilha.
  t.integer('actor_user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
  // Desnormalizado pela mesma razão de `provisioning_runs.profile_name`: seis
  // meses depois o nome ainda responde "quem foi", mesmo que a linha em `users`
  // já não exista.
  t.string('actor_username', 64);
  // operator | platform | system. `platform` é quem opera o SaaS agindo sobre o
  // provedor de fora; `system` é trabalho de fundo sem gente por trás.
  t.string('actor_kind', 16).notNullable().defaultTo('operator');
  t.string('action', 64).notNullable();
  // Sobre o quê: 'customer_account', 'tenant_user', 'invite', 'settings'…
  t.string('subject_type', 32);
  t.string('subject_id', 128);
  // JSON curto e SEM segredo. Ver o comentário acima.
  t.text('detail');
  t.string('ip', 64);
  t.timestamp('created_at').defaultTo(db.fn.now());
  // Como a tela pergunta: as ações deste provedor, da mais recente para a mais
  // antiga. `id` no fim desempata dentro do mesmo segundo, que é o que acontece
  // quando uma ação grava duas linhas.
  t.index(['tenant_id', 'created_at', 'id'], 'audit_log_recent_idx');
  t.index(['tenant_id', 'action'], 'audit_log_action_idx');
};

const tenantInvitesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  // sha256 do token. Único no deploy porque a busca acontece ANTES de haver
  // provedor em escopo: quem abre o link só apresentou o token, e é o token que
  // diz para qual provedor ele é. Único por provedor não serviria — a busca não
  // tem provedor para filtrar.
  t.string('token_hash', 64).notNullable().unique();
  t.string('role', 32).notNullable();
  // Só para quem administra se lembrar de quem convidou. Não é login, não é
  // conferido contra nada, e não é para onde o convite é enviado: o painel não
  // manda e-mail. Nulo é legítimo.
  t.string('label', 255);
  t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('expires_at').notNullable();
  t.timestamp('accepted_at');
  t.integer('accepted_user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('revoked_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  // Como a tela pergunta: os convites em aberto deste provedor.
  t.index(['tenant_id', 'accepted_at'], 'tenant_invites_open_idx');
};

/**
 * O cadastro fiscal do provedor: o que é preciso para emitir uma nota contra
 * ele e para mandar a cobrança a alguém que a pague.
 *
 * Uma fábrica separada porque estas colunas entram por dois caminhos — a tabela
 * nova e o passo 0043 — e a regra da casa é que cada coluna tenha um lugar só,
 * para que o schema inicial e o degrau de upgrade não possam divergir.
 *
 * Todas nulas, e isso não é preguiça: nenhum provedor que já existe tem estes
 * dados, e um provedor novo se cadastra antes de tê-los à mão. O momento de
 * cobrar o preenchimento é o da primeira fatura, não o do INSERT.
 *
 * `billing_tax_id` guarda só dígitos — CNPJ com catorze, CPF com onze, que é o
 * caso do MEI. A formatação é da tela; o banco guarda o que se compara.
 */
const TENANT_BILLING_COLUMNS = [
  ['billing_legal_name', (t) => t.string('billing_legal_name', 160)],
  ['billing_tax_id', (t) => t.string('billing_tax_id', 20)],
  // Inscrição estadual. Opcional e às vezes a palavra "ISENTO": o ISP presta
  // serviço de comunicação, que é tributado pelo estado, e a nota costuma
  // pedir — mas quem não tem não pode ser impedido de se cadastrar por isso.
  ['billing_state_registration', (t) => t.string('billing_state_registration', 32)],
  ['billing_postal_code', (t) => t.string('billing_postal_code', 8)],
  ['billing_address_line', (t) => t.string('billing_address_line', 160)],
  ['billing_address_number', (t) => t.string('billing_address_number', 16)],
  ['billing_address_extra', (t) => t.string('billing_address_extra', 80)],
  ['billing_district', (t) => t.string('billing_district', 80)],
  ['billing_city', (t) => t.string('billing_city', 80)],
  ['billing_state', (t) => t.string('billing_state', 2)],
  // O contato financeiro, que quase nunca é quem administra o painel. Sem ele a
  // cobrança vai para o e-mail de login do dono, que é onde ela se perde.
  ['billing_email', (t) => t.string('billing_email', 160)],
  ['billing_phone', (t) => t.string('billing_phone', 32)]
];

/**
 * Quem este provedor é DENTRO do gateway de pagamento.
 *
 * Em `tenants`, que é tabela compartilhada, e não numa tabela escopada nova —
 * e a razão é o webhook. A entrega do gateway chega sem provedor nenhum em
 * escopo (ela não sabe o que é um provedor; sabe um id de cliente), e é ela que
 * precisa fazer o caminho de volta. Numa tabela escopada essa leitura teria que
 * ser `runUnscoped`, com a razão escrita, para atravessar a sentinela — um
 * `runUnscoped` por entrega de webhook, numa rota pública, para ler uma
 * correlação que não é dado de provedor nenhum e sim de como ele aparece num
 * sistema de fora. Em `tenants` a leitura é direta e a sentinela não tem nada a
 * dizer sobre ela, que é o estado certo.
 *
 * `billing_gateway` guarda o nome do provider (`asaas`), e não um booleano:
 * `billing_events.provider` já é uma string pelo mesmo motivo, e o dia em que
 * houver dois gateways a coluna já responde qual.
 */
const TENANT_GATEWAY_COLUMNS = [
  ['billing_gateway', (t) => t.string('billing_gateway', 32)],
  // O id do cliente no gateway. É por ele que a entrega volta ao provedor
  // quando o pagamento não carrega a nossa própria referência.
  ['billing_customer_ref', (t) => t.string('billing_customer_ref', 128)]
];

const tenantsTable = (db) => (t) => {
  t.increments('id').primary();
  // The subdomain the panel will be reached at once tenants are resolved by
  // host; unique from the start so nothing has to be de-duplicated later.
  t.string('slug', 64).notNullable().unique();
  t.string('name', 128).notNullable();
  t.string('status', 16).notNullable().defaultTo('active');
  /**
   * `provider` ou `platform`: se esta linha é um CLIENTE ou se é a própria
   * plataforma, que precisa de um provedor só para ser dona das coisas que o
   * schema exige que tenham dono — o WhatsApp, antes de tudo.
   *
   * Coluna e não um slug reservado que o código reconheça. A distinção é
   * consultada em SQL (a lista do console, a emissão de cobrança) e tem que ser
   * afirmável num teste; um `slug === 'plataforma'` espalhado por quatro
   * arquivos seria a mesma regra escrita quatro vezes, e a quinta ficaria para
   * trás.
   *
   * `status` continua valendo igual nas duas: um provedor de plataforma
   * suspenso deixa de ser visitado pelos jobs, como qualquer outro. As duas
   * colunas respondem perguntas diferentes.
   */
  t.string('kind', 16).notNullable().defaultTo('provider');
  for (const [, add] of TENANT_BILLING_COLUMNS) add(t);
  for (const [, add] of TENANT_GATEWAY_COLUMNS) add(t);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  // O caminho de volta do webhook: gateway + id do cliente → provedor. É a
  // única leitura no caminho quente de uma rota pública, e sem índice ela é um
  // scan da tabela de clientes a cada entrega.
  t.index(['billing_gateway', 'billing_customer_ref'], 'tenants_gateway_customer_idx');
};

const provisioningProfilesTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('name', 128).notNullable().unique();
  // Case-insensitive substrings matched against the SGP plan name, stored as a
  // JSON array like the vendor pattern columns.
  t.text('plan_patterns');
  // A cleared pattern list must not silently become a catch-all, so the
  // fallback profile is an explicit choice instead.
  t.boolean('is_default').notNullable().defaultTo(false);
  t.integer('priority').notNullable().defaultTo(10);
  t.boolean('enabled').notNullable().defaultTo(true);
  t.boolean('apply_wan').notNullable().defaultTo(true);
  t.boolean('apply_pppoe_password').notNullable().defaultTo(true);
  t.string('wan_name', 256);
  t.integer('wan_vlan_id');
  t.string('wan_service_list', 128);
  t.string('wan_connection_type', 32);
  t.boolean('wan_nat_enabled');
  t.boolean('apply_wifi').notNullable().defaultTo(true);
  t.text('wifi_indexes');
  t.string('wifi_ssid_template', 64);
  t.string('wifi_password_mode', 16).notNullable().defaultTo('random');
  t.text('wifi_password_ciphertext');
  t.string('wifi_password_iv', 32);
  t.string('wifi_password_tag', 32);
  t.boolean('apply_credentials').notNullable().defaultTo(false);
  t.string('credential_targets', 16).notNullable().defaultTo('super');
  t.text('cpe_password_ciphertext');
  t.string('cpe_password_iv', 32);
  t.string('cpe_password_tag', 32);
  t.text('description');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const provisioningRunsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('device_id', 255).notNullable();
  t.string('contract', 64);
  t.integer('profile_id').unsigned()
    .references('id').inTable('provisioning_profiles').onDelete('SET NULL');
  // Denormalized so deleting a profile does not erase why a run behaved the
  // way it did.
  t.string('profile_name', 128);
  t.string('trigger', 16).notNullable().defaultTo('poller');
  t.string('status', 24).notNullable().defaultTo('pending');
  t.integer('attempt_count').notNullable().defaultTo(0);
  t.timestamp('next_attempt_at');
  // JSON array of { step, status, detail, parameterCount, at }, redacted.
  t.text('steps');
  t.text('error');
  t.timestamp('started_at');
  t.timestamp('finished_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.index(['device_id', 'status'], 'provisioning_runs_device_status_idx');
  t.index(['status', 'next_attempt_at'], 'provisioning_runs_due_idx');
};

const sgpEventsTable = (db) => (t) => {
  t.increments('id').primary();
  // A redelivered webhook and a transition seen twice by reconciliation both
  // collapse onto the same key, so neither is processed twice.
  t.string('dedupe_key', 128).notNullable().unique();
  t.string('source', 16).notNullable();
  t.string('type', 32).notNullable();
  t.string('raw_type', 128);
  t.string('contract', 64);
  t.string('document', 32);
  t.string('login', 255);
  t.string('device_id', 255);
  t.string('status', 16).notNullable().defaultTo('pending');
  t.integer('attempts').notNullable().defaultTo(0);
  t.text('payload');
  t.text('error');
  t.timestamp('occurred_at');
  t.timestamp('received_at').defaultTo(db.fn.now());
  t.timestamp('processed_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.index(['status', 'id'], 'sgp_events_status_idx');
  t.index(['contract'], 'sgp_events_contract_idx');
};

/** Provisioning tables, in creation order: the runs reference the profiles. */
const PROVISIONING_TABLES = [
  ['provisioning_profiles', provisioningProfilesTable],
  ['provisioning_runs', provisioningRunsTable],
  ['sgp_events', sgpEventsTable]
];

// ── WhatsApp / Evolution API ───────────────────────────────────────────
//
// Two constraints shape every table below and are easy to violate by habit:
//
// 1. No partial index and no array column: MySQL has neither. Where the source
//    system used `UNIQUE ... WHERE revoked IS NULL`, uniqueness moves into the
//    model instead, and the comment there says why.
// 2. Secrets are stored through the shared secret box (AES-256-GCM keyed from
//    JWT_SECRET under its own context), never in plaintext — the rule the SGP
//    token already follows.

const whatsappAccountsTable = (db) => (t) => {
  t.increments('id').primary();
  // The instance name on the Evolution server. The inbound webhook resolves the
  // account by this value, so it has to be unique.
  t.string('name', 128).notNullable().unique();
  t.string('label', 128);
  // Which kind of traffic this number carries. The sender routes on it and
  // falls back to the default account when no number claims the purpose.
  t.string('purpose', 32).notNullable().defaultTo('general');
  // 'go' | 'v2' — detected by probe, not configured by hand.
  t.string('flavor', 8).notNullable().defaultTo('v2');
  t.string('base_url', 255).notNullable();
  // The server-side UUID. Evolution GO deletes instances by id, not name, so
  // losing this means we can only log out and drop the local row.
  t.string('instance_id', 64);
  t.string('status', 16).notNullable().defaultTo('pending');
  t.text('qr_code');
  t.timestamp('qr_updated_at');
  t.string('phone_e164', 24);
  t.boolean('is_default').notNullable().defaultTo(false);
  t.timestamp('last_seen_at');
  t.text('last_error');
  // The instance token: sending messages and reading contacts as the provider.
  t.text('token_ciphertext');
  t.string('token_iv', 32);
  t.string('token_tag', 32);
  // A DIFFERENT secret, deliberately: it travels in the webhook URL and is
  // stored on the Evolution server, so it shows up in logs on both ends.
  // Leaking it lets someone forge an inbound event; leaking the instance token
  // would let them send as the provider.
  t.text('webhook_token_ciphertext');
  t.string('webhook_token_iv', 32);
  t.string('webhook_token_tag', 32);
  // O que o servidor Evolution respondeu quando lhe perguntamos qual webhook
  // ele tem. Até existirem, a URL era escrita uma vez no create e nunca mais
  // conferida — e as três formas de ela divergir (instância que já existia,
  // webhook editado à mão, `webhookBaseUrl` trocado depois do pareamento)
  // produziam o mesmo silêncio que um webhook certo nunca chamado.
  t.string('webhook_verdict', 32);
  // A URL do servidor COM O TOKEN REDIGIDO. Guardar a URL inteira seria
  // guardar, em claro e na linha ao lado, o segredo que as três colunas
  // acima existem para cifrar.
  t.string('webhook_server_url', 255);
  t.timestamp('webhook_checked_at');
  // A cor do número na caixa de entrada — ver `config/waAccountColors.js`.
  // Nula só em linha anterior à 0055, que a preenche.
  t.string('color', 16);
  // A VOLTA: o painel se chamou pela porta da frente e contou o que aconteceu.
  // Distinto do veredito acima porque responde outra pergunta — aquele diz o
  // que está GRAVADO no servidor, este diz se uma entrada por aquele endereço
  // CHEGA até aqui. Os dois saem do mesmo `webhookBaseUrl`, digitado à mão e
  // conferido só na forma, então o de cima responde `ok` para um endereço
  // errado: as duas pontas da comparação dele concordam porque são a mesma.
  t.string('webhook_probe_verdict', 32);
  t.timestamp('webhook_probed_at');
  // Chegou e foi recusado. É o que distingue "o Evolution não está chamando"
  // de "está chamando e levando 401" — dois problemas com consertos opostos
  // que, sem isto, aparecem na tela como o mesmo "Nunca chegou nada".
  t.timestamp('webhook_refused_at');
  t.string('webhook_refused_reason', 32);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const waConversationsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('account_id').unsigned().notNullable()
    .references('id').inTable('whatsapp_accounts').onDelete('CASCADE');
  // Phone and LID are both identities and neither is guaranteed: a contact
  // addressed only by LID has no phone at all. See utils/wa/waJid.js.
  t.string('wa_phone_e164', 24);
  t.string('wa_lid', 32);
  t.string('external_thread_id', 128);
  t.string('push_name', 128);
  // Who this is, once we know: the ONT, the portal account, the contract.
  t.string('device_id', 255);
  t.integer('customer_account_id').unsigned()
    .references('id').inTable('customer_accounts').onDelete('SET NULL');
  t.string('contract', 64);
  t.timestamp('last_message_at');
  t.timestamp('last_inbound_at');
  t.integer('unread_count').notNullable().defaultTo(0);
  t.timestamp('closed_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  // One thread per contact per instance. A subscriber who writes to both the
  // billing and the support number gets two conversations, which is what an
  // operator expects to see.
  t.unique(['account_id', 'external_thread_id']);
  t.index(['wa_phone_e164']);
  t.index(['last_message_at']);
  // The health read asks three questions of this table on every poll — when
  // anything last arrived, how many threads are unread, how many are open —
  // and without these each one is a scan. On a provider with a hundred
  // thousand threads that is the panel's own status strip becoming the reason
  // the panel is slow.
  t.index(['last_inbound_at']);
  t.index(['closed_at']);
  t.index(['unread_count']);
};

const waMessagesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('conversation_id').unsigned().notNullable()
    .references('id').inTable('wa_conversations').onDelete('CASCADE');
  t.string('direction', 3).notNullable(); // 'in' | 'out'
  // The WhatsApp message id. Unique so a redelivered webhook cannot double an
  // inbound message, and so a receipt can find the outbound one. NULL until an
  // outbound message is accepted by the server, and repeated NULLs do not
  // collide in either engine.
  t.string('external_id', 128).unique();
  t.text('body');
  t.string('attachment_path', 255);
  t.string('attachment_type', 128);
  t.string('attachment_name', 255);
  // An internal note is written by an operator and never sent.
  t.boolean('is_note').notNullable().defaultTo(false);
  // Who produced this message: 'operator', 'bot', 'campaign' or 'alert'.
  // `sent_by` cannot answer that — it is NULL for all three automatic senders,
  // so a dunning campaign message and a bot reply were indistinguishable, and
  // the bot's hourly ceiling counted the campaign's messages against itself.
  t.string('source', 16).notNullable().defaultTo('operator');
  // queued | sending | sent | delivered | read | failed. NULL for inbound.
  t.string('delivery_status', 16);
  t.string('delivery_error', 500);
  t.timestamp('claimed_at');
  t.integer('attempts').notNullable().defaultTo(0);
  t.integer('sent_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('read_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.index(['conversation_id', 'created_at']);
  // The outbox worker's only query.
  t.index(['delivery_status', 'created_at']);
  // The three indexes of 0020 are NOT here. This factory runs in step 0001,
  // where `tenant_id` (0012) and `next_attempt_at` (0020) do not exist yet, so
  // indexing them would fail every fresh install. 0020 adds all three, and it
  // runs on a fresh database too.
};

const waOptOutsTable = (db) => (t) => {
  t.increments('id').primary();
  // Keyed by phone and LID, NOT by customer: an opt-out has to survive a record
  // being merged, deleted, or created again. Whoever asked to be left alone
  // asked as a phone number.
  t.string('wa_phone_e164', 24);
  t.string('wa_lid', 32);
  t.integer('conversation_id').unsigned()
    .references('id').inTable('wa_conversations').onDelete('SET NULL');
  t.string('origin', 16).notNullable().defaultTo('customer'); // customer | operator
  t.string('reason_text', 500);
  t.timestamp('created_at').defaultTo(db.fn.now());
  // Revocation is soft, so the history of who asked out and when survives.
  // Uniqueness of the *active* row is enforced in models/WaOptOut.js — MySQL
  // has no partial index, and a duplicate here is noise rather than a safety
  // failure (the dangerous direction is a MISSING opt-out).
  t.timestamp('revoked_at');
  t.integer('revoked_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.index(['wa_phone_e164']);
  t.index(['wa_lid']);
};

const waTemplatesTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('name', 80).notNullable().unique();
  t.text('body').notNullable();
  // cobranca | alerta | suporte | geral. The dunning renderer only accepts the
  // variables it can fill.
  t.string('category', 32).notNullable().defaultTo('geral');
  t.boolean('active').notNullable().defaultTo(true);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const waBroadcastsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('title', 200).notNullable();
  t.integer('template_id').unsigned()
    .references('id').inTable('wa_templates').onDelete('SET NULL');
  t.text('body').notNullable();
  t.integer('account_id').unsigned()
    .references('id').inTable('whatsapp_accounts').onDelete('SET NULL');
  // A campaign is born as 'draft' on purpose. Messaging hundreds of people must
  // never be the side effect of a click on a listing screen: an operator opens
  // the campaign, reads it, and presses start.
  t.string('status', 16).notNullable().defaultTo('draft');
  t.timestamp('start_at');
  t.integer('rate_limit_per_min');
  t.integer('total_count').notNullable().defaultTo(0);
  t.integer('sent_count').notNullable().defaultTo(0);
  t.integer('failed_count').notNullable().defaultTo(0);
  t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const waBroadcastRecipientsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('broadcast_id').unsigned().notNullable()
    .references('id').inTable('wa_broadcasts').onDelete('CASCADE');
  t.string('phone_e164', 24).notNullable();
  t.string('contract', 64);
  t.string('client_name', 255);
  // Rendered once, when the campaign is built, so what an operator reviews is
  // exactly what goes out.
  t.text('rendered_body').notNullable();
  t.integer('message_id').unsigned()
    .references('id').inTable('wa_messages').onDelete('SET NULL');
  t.string('status', 16).notNullable().defaultTo('pending');
  t.string('error_msg', 500);
  t.integer('attempts').notNullable().defaultTo(0);
  // Quando ESTA linha foi garrada, e não quando a campanha foi montada.
  //
  // A distinção é a diferença entre a trava funcionar e não funcionar. A janela
  // de retomada media idade a partir de `created_at`, que é gravado quando o
  // operador MONTA a campanha — e como ele revisa o rascunho antes de disparar,
  // toda campanha real já nasce com mais de cinco minutos. O ramo "garra morta"
  // casava no mesmo instante da garra, e o `UPDATE` condicional que deveria
  // impedir dois ticks de contatarem o mesmo assinante não impedia nada.
  //
  // É a mesma coluna que `wa_messages` tem, pelo mesmo motivo: lá a janela
  // sempre funcionou porque sempre foi medida da garra.
  t.timestamp('claimed_at');
  t.timestamp('sent_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.index(['broadcast_id', 'status']);
};

const waAlertStateTable = (db) => (t) => {
  t.increments('id').primary();
  // 'ont_offline', 'rx_power_low', 'temperature_high', 'mass_outage', …
  t.string('rule', 48).notNullable();
  // What the rule is about: a device id, or an ODP/OLT node id.
  t.string('subject', 255).notNullable();
  t.string('state', 16).notNullable().defaultTo('firing');
  t.timestamp('fired_at').defaultTo(db.fn.now());
  t.timestamp('cleared_at');
  // Cooldown lives here: an ONT that stays down must not produce a message on
  // every scan.
  t.timestamp('last_notified_at');
  t.integer('notify_count').notNullable().defaultTo(0);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['rule', 'subject']);
};

/** The campaign tables that gain a provider in 0013, in dependency order. */
const TENANT_CAMPAIGN_TABLES = [
  'wa_templates',
  'wa_broadcasts',
  'wa_broadcast_recipients',
  'wa_alert_state'
];

/** The two key/value tables that gain a provider in 0014. */
const KEY_VALUE_TABLES = ['settings', 'app_state'];

/** In creation order; foreign keys dictate it. */
const WHATSAPP_TABLES = [
  ['whatsapp_accounts', whatsappAccountsTable],
  ['wa_conversations', waConversationsTable],
  ['wa_messages', waMessagesTable],
  ['wa_opt_outs', waOptOutsTable],
  ['wa_templates', waTemplatesTable],
  ['wa_broadcasts', waBroadcastsTable],
  ['wa_broadcast_recipients', waBroadcastRecipientsTable],
  ['wa_alert_state', waAlertStateTable]
];

/**
 * The tables of the initial schema, in creation order. Foreign keys dictate it:
 * `mapping_nodes` before `mapping_edges`, and `customer_accounts` before
 * `sgp_links` and `customer_wifi_credentials`.
 */
const deviceSamplesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants');
  t.string('device_id', 255).notNullable();
  // The sample's time axis is the inform it came from, not the tick clock.
  // GenieACS only refreshes a parameter when the device informs, so a tick that
  // sees an unchanged `_lastInform` has nothing new to store. That one decision
  // is also why there is no `online` column: a device that stops informing
  // stops producing rows, and the gap that leaves in the series IS the outage.
  t.timestamp('inform_at').notNullable();
  // Float rather than decimal on purpose: `pg` and `mysql2` both hand DECIMAL
  // back as a string, and 0.01 dBm is far inside what a float carries exactly.
  t.float('rx_power');
  t.float('temperature');
  t.integer('uptime_seconds');
  t.timestamp('created_at').defaultTo(db.fn.now());
  // Serves both reads: `max(inform_at) group by device_id` for the per-tick
  // deduplication, and the range scan the chart does.
  t.index(['tenant_id', 'device_id', 'inform_at'], 'device_samples_device_time_idx');
  // Retention walks this one. Without it the daily prune is a full scan of a
  // table that holds a million rows on a fleet of a thousand.
  t.index(['tenant_id', 'inform_at'], 'device_samples_age_idx');
};

const deviceSampleHoursTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants');
  t.string('device_id', 255).notNullable();
  t.timestamp('bucket_at').notNullable();
  t.integer('sample_count').notNullable().defaultTo(0);
  t.float('rx_min');
  t.float('rx_avg');
  t.float('rx_max');
  t.float('temp_min');
  t.float('temp_avg');
  t.float('temp_max');
  t.integer('uptime_last');
  t.timestamp('created_at').defaultTo(db.fn.now());
  // What makes re-running a rollup safe instead of doubling the buckets.
  t.unique(['tenant_id', 'device_id', 'bucket_at']);
  t.index(['tenant_id', 'bucket_at'], 'device_sample_hours_age_idx');
};

const DEVICE_HISTORY_TABLES = [
  ['device_samples', deviceSamplesTable],
  ['device_sample_hours', deviceSampleHoursTable]
];

const deviceSwapsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants');
  t.integer('account_id').unsigned()
    .references('id').inTable('customer_accounts').onDelete('SET NULL');
  // Denormalized so the row still says who this was after the account is gone,
  // the same reason `provisioning_runs` keeps `profile_name`.
  t.string('customer_id', 32);
  t.string('pppoe_username', 255);
  t.string('previous_device_id', 255).notNullable();
  t.string('device_id', 255).notNullable();
  t.string('contract', 64);
  // Which branch of `ensureAccount` matched: 'identity_hash' when the
  // replacement runs the same firmware, 'pppoe' when it does not.
  t.string('matched_by', 16).notNullable();
  t.string('link_action', 16).notNullable();
  // Two ONTs trading one login during an install produce this pair over and
  // over. One row saying so beats a hundred each saying it once.
  t.boolean('flapping').notNullable().defaultTo(false);
  t.integer('repeat_count').notNullable().defaultTo(1);
  t.timestamp('occurred_at').defaultTo(db.fn.now());
  t.timestamp('acknowledged_at');
  t.integer('acknowledged_by').unsigned()
    .references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['tenant_id', 'previous_device_id', 'device_id']);
  t.index(['tenant_id', 'device_id'], 'device_swaps_device_idx');
  t.index(['tenant_id', 'acknowledged_at'], 'device_swaps_open_idx');
};

const DEVICE_SWAP_TABLES = [
  ['device_swaps', deviceSwapsTable]
];

/**
 * Histórico de rompimentos: cada vez que uma caixa do mapa (CTO/CEO/OLT) teve
 * vários clientes offline ao mesmo tempo — ver `outageDetector.js`.
 *
 * Uma linha por ocorrência, aberta enquanto `ended_at` é nulo. `node_name`
 * fica copiado para a linha continuar dizendo qual era a caixa depois que
 * ela for renomeada ou apagada do mapa. Nenhum dado de assinante: a caixa e
 * as contagens.
 */
const outageEventsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants');
  t.string('node_id', 128).notNullable();
  t.string('node_name', 255);
  t.timestamp('started_at').notNullable();
  t.timestamp('ended_at');
  // O pico: quantos clientes estiveram offline juntos, de quantos a caixa tinha.
  t.integer('peak_count').notNullable().defaultTo(0);
  t.integer('total_clients').notNullable().defaultTo(0);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.index(['tenant_id', 'ended_at'], 'outage_events_open_idx');
  t.index(['tenant_id', 'node_id', 'started_at'], 'outage_events_node_idx');
};

const OUTAGE_HISTORY_TABLES = [
  ['outage_events', outageEventsTable]
];

/**
 * O catálogo de planos do SaaS: o que se vende, e até onde cada um vai.
 *
 * Do deploy, não de um provedor — é a tabela de preços, e a tabela de preços
 * é uma só. Os limites são NULOS quando não há limite: o plano que a migração
 * dá a todo provedor existente não restringe nada, porque um upgrade não pode
 * ser o dia em que um ISP descobre que tem operador demais.
 *
 * `code` é o nome estável que o console e os testes usam; `name` é o que se
 * mostra. Preço em centavos e moeda ao lado, porque o mercado é o brasileiro
 * mas o código não precisa saber disso.
 */
/**
 * A vitrine do plano: o que a página pública mostra dele — ver 0079.
 *
 * `public` nasce falso: um plano que existe no catálogo não vira oferta no
 * site só porque alguém o criou. É o console que decide o que se vende ali.
 * `features` é uma lista JSON de frases curtas, a mesma forma de
 * `plan_patterns`. `price_yearly_cents` nasceu só como o preço anunciado da
 * opção anual; desde a 0104 é o que se COBRA no ciclo anual (365 dias).
 */
const PLAN_MARKETING_COLUMNS = [
  ['public', (t) => t.boolean('public').notNullable().defaultTo(false)],
  ['featured', (t) => t.boolean('featured').notNullable().defaultTo(false)],
  ['sort_order', (t) => t.integer('sort_order').notNullable().defaultTo(0)],
  ['description', (t) => t.text('description')],
  ['features', (t) => t.text('features')],
  ['price_yearly_cents', (t) => t.integer('price_yearly_cents').unsigned()]
];

/**
 * Quem pediu demonstração pela página pública. Da PLATAFORMA, e não de um
 * provedor: é gente que ainda não é cliente — o provedor dela não existe.
 */
const leadsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('name', 128).notNullable();
  t.string('company', 160);
  t.string('email', 160);
  t.string('phone', 32);
  t.string('city', 80);
  t.integer('devices_estimate').unsigned();
  t.text('message');
  t.string('plan_code', 32);
  // new | contacted | won | lost
  t.string('status', 16).notNullable().defaultTo('new');
  t.text('notes');
  t.string('source', 32).notNullable().defaultTo('landing');
  // Sem `ip`: ver `0109_drop_lead_ip`. Era gravado e nunca lido.
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.index(['status', 'created_at'], 'leads_status_created_idx');
};

const LEAD_TABLES = [
  ['leads', leadsTable]
];

const plansTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('code', 32).notNullable().unique();
  t.string('name', 128).notNullable();
  t.integer('max_operators').unsigned();
  t.integer('max_subscribers').unsigned();
  t.integer('max_devices').unsigned();
  t.integer('price_cents').unsigned().notNullable().defaultTo(0);
  t.string('currency', 3).notNullable().defaultTo('BRL');
  // Dias de teste que um provedor novo ganha neste plano. Zero é "sem teste".
  t.integer('trial_days').unsigned().notNullable().defaultTo(0);
  /**
   * Quanto tempo um pagamento compra. Ao lado de `trial_days` porque é o mesmo
   * tipo de coisa: um prazo que é do PLANO e não do código.
   *
   * Até aqui o período pago era um `30` dentro de `subscriptionService`, e o
   * catálogo sabia dizer por quanto vende e não por quanto tempo. Era a metade
   * que faltava para existir plano anual — e plano anual é a diferença entre
   * cobrar um ISP doze vezes e cobrá-lo uma.
   *
   * Inteiro em dias, e não um enum `mensal|anual`: é a forma que `trial_days`
   * já tem, casa com a aritmética de `renews_at`, e não obriga ninguém a
   * decidir hoje o nome do ciclo de 90 dias que alguém vai querer vender.
   * "Mensal" e "anual" são como a tela chama 30 e 365, e isso é da tela.
   */
  t.integer('period_days').unsigned().notNullable().defaultTo(30);
  /**
   * Tetos de retenção, em dias: até quando o provedor pode guardar a trilha
   * de auditoria, as mensagens e os anexos do WhatsApp. Nulo é sem teto —
   * o provedor decide sozinho, como sempre decidiu. Com teto, o valor dele
   * continua valendo quando é menor, e "para sempre" passa a ser o teto.
   */
  t.integer('max_audit_retention_days').unsigned();
  t.integer('max_message_retention_days').unsigned();
  t.integer('max_media_retention_days').unsigned();
  for (const [, add] of PLAN_MARKETING_COLUMNS) add(t);
  // Um plano desativado não some — assinaturas ainda apontam para ele — mas
  // deixa de ser oferecido a provedor novo.
  t.boolean('active').notNullable().defaultTo(true);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

/**
 * A assinatura: em que plano um provedor está, e em que pé.
 *
 * Uma por provedor, e é o `unique` que garante. Escopada como tudo que é de
 * um provedor — o próprio provedor lê a sua na tela de plano e uso — e é lida
 * ANTES de qualquer rota pelo gate, que já está dentro do escopo que o
 * resolvedor abriu.
 *
 * `status` é o ciclo inteiro: trial | active | past_due | suspended |
 * canceled. `trial` e `active` passam; `past_due` passa só para ler;
 * `suspended` e `canceled` respondem 402. A regra vive em
 * `subscriptionService.js`, não aqui.
 *
 * `plan_id` é RESTRICT: apagar um plano com assinante é apagar o chão de
 * alguém. Desativa-se o plano; não se apaga.
 */
const subscriptionsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable().unique()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('plan_id').unsigned().notNullable()
    .references('id').inTable('plans');
  t.string('status', 16).notNullable().defaultTo('trial');
  t.timestamp('trial_ends_at');
  // Até quando o período pago vai. Nulo em trial e em quem nunca pagou.
  t.timestamp('renews_at');
  t.timestamp('canceled_at');
  // QUAL prazo já foi avisado — o valor da data avisada, não a hora do aviso.
  //
  // Guardar "quando avisei" obrigaria a apagar a marca toda vez que o prazo
  // mudasse, e esquecer de apagar em um dos caminhos deixaria um provedor sem
  // aviso para sempre. Guardando o prazo em si, a comparação é direta: avisa
  // quando o prazo que vence não é o que já foi avisado. Um pagamento empurra
  // `renews_at`, a marca deixa de casar sozinha, e o ciclo recomeça sem
  // ninguém precisar limpar nada.
  t.timestamp('expiry_warned_for');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

/**
 * O que aconteceu com a assinatura, na ordem em que aconteceu: pagamento
 * registrado, plano trocado, status mudado. É o extrato — e é o que um
 * gateway vai alimentar por webhook quando existir, pelo mesmo caminho que o
 * `ManualBillingProvider` usa hoje.
 *
 * Escopada: é dado financeiro do provedor, e sai no export dele.
 */
const billingEventsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('subscription_id').unsigned()
    .references('id').inTable('subscriptions').onDelete('SET NULL');
  // payment.recorded | plan.changed | status.changed | trial.started
  t.string('type', 32).notNullable();
  t.integer('amount_cents');
  t.string('currency', 3);
  // Quem registrou: 'manual' hoje; o nome do gateway amanhã.
  t.string('provider', 32).notNullable().defaultTo('manual');
  // O id do pagamento no gateway, ou a referência que alguém digitou.
  t.string('external_id', 128);
  t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.text('detail');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.index(['tenant_id', 'created_at', 'id'], 'billing_events_recent_idx');
  // A idempotência do pagamento. Todo gateway reentrega webhook; sem isto a
  // segunda entrega de uma referência creditava outra vez. Nulos não colidem
  // nos três bancos, então a marca manual sem referência segue livre.
  t.unique(['tenant_id', 'external_id'], 'billing_events_external_uq');
};

/**
 * Criadas pelo 0035. `plans` não aponta para nada; `subscriptions` aponta para
 * `tenants` e `plans`; `billing_events` para as duas e para `users`. Depois
 * das tabelas de membership, portanto — e nessa ordem entre si.
 */
/**
 * A cobrança que o painel EMITIU, e por que ela não cabe no extrato.
 *
 * `billing_events` é livro-caixa: só nasce linha, nunca muda, e é isso que o
 * comentário dela diz ser. Uma cobrança emitida tem o contrário disso — nasce
 * pendente, vira paga, vencida ou cancelada — e estado mutável num livro-caixa
 * ou vira UPDATE numa tabela que não tem `updated_at`, ou vira "dobre o extrato
 * até descobrir o estado atual", que é um `fold` em JS sem índice.
 *
 * Mas a razão que decide não é essa; é uma armadilha concreta. No gateway a
 * cobrança **é** o pagamento: o `pay_…` que a emissão receberia de volta é o
 * mesmo que o webhook traz depois em `payment.id`. Gravar a emissão em
 * `billing_events.external_id` faria a leitura de idempotência de
 * `recordPayment` encontrar a linha da EMISSÃO e responder `duplicate` — sem
 * creditar. O cliente paga, a rota responde 200, o extrato mostra um evento que
 * de fato aconteceu, e ninguém percebe que o período não andou. Tabela separada
 * é o que torna essa colisão impossível em vez de evitada por convenção.
 *
 * A idempotência da emissão é `(tenant_id, period_end)`: **uma cobrança por
 * período, garantida pelo banco**. E ela se renova sozinha pelo mesmo motivo
 * que `expiry_warned_for` se renova — um pagamento empurra `renews_at`, o
 * período seguinte tem outra chave, e o ciclo recomeça sem nenhum caminho
 * precisar lembrar de limpar nada.
 */
const billingChargesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('subscription_id').unsigned()
    .references('id').inTable('subscriptions').onDelete('SET NULL');
  /**
   * O fim do período que esta cobrança compra, como data ISO — e é a chave.
   *
   * String de dez caracteres e não timestamp, de propósito. A chave entra num
   * índice único e é comparada por igualdade, e timestamp não sobrevive a isso
   * nos três bancos: o MySQL trunca para segundos por default, e dois processos
   * que calculam "o mesmo" prazo podem gravar valores que o índice considera
   * diferentes. Um período é coisa de dia; a hora exata está em `due_date` e em
   * `created_at`, onde ela é informação e não chave.
   */
  t.string('period_end', 10).notNullable();
  // Quanto, e em que moeda — copiados do plano na hora da emissão e NÃO lidos
  // dele depois. Um plano que muda de preço não reescreve o que já foi cobrado.
  t.integer('amount_cents').unsigned().notNullable();
  t.string('currency', 3).notNullable().defaultTo('BRL');
  // Qual gateway emitiu. Mesma coluna e mesma razão de `billing_events.provider`.
  t.string('provider', 32).notNullable();
  // O id da cobrança no gateway. Nulo entre gravar a linha e a chamada voltar —
  // que é justamente a janela em que uma falha precisa ser reconhecível.
  t.string('gateway_charge_id', 128);
  // pending | paid | canceled | failed
  t.string('status', 16).notNullable().defaultTo('pending');
  t.date('due_date');
  /**
   * A página do gateway onde o provedor paga — e é por causa dela que a
   * cobrança precisa de tabela: sem esta coluna o aviso de vencimento continua
   * sem ter de onde tirar um link.
   *
   * Uma coluna e não duas. A emissão pede `billingType: UNDEFINED`, que devolve
   * uma página onde quem paga escolhe entre Pix e boleto — então um endereço
   * responde pelos dois meios. O copia-e-cola do Pix é outra chamada ao
   * gateway, e uma coluna que nenhuma chamada preenche é exatamente a dívida
   * que este repositório já encontrou quatro vezes.
   */
  t.string('invoice_url', 512);
  t.integer('attempts').notNullable().defaultTo(0);
  /**
   * Quando se pode tentar de novo.
   *
   * O agendador passa a cada minuto, e sem esta coluna uma resposta perdida no
   * meio viraria cinco cobranças de verdade em cinco minutos na mão de um
   * cliente pagante. `attempts` conta; esta coluna espaça — e são duas coisas
   * diferentes, porque o teto sozinho só decide quando desistir.
   */
  t.timestamp('next_attempt_at');
  t.string('last_error', 500);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['tenant_id', 'period_end'], 'billing_charges_period_uq');
  // "O que está em aberto", que é a pergunta que o console faz.
  t.index(['tenant_id', 'status'], 'billing_charges_status_idx');
};

/** As colunas da 0073 — ver a migração. */
const BILLING_CHARGE_CLAIM_COLUMNS = [
  ['issuing_until', (t) => t.timestamp('issuing_until').nullable()],
  ['superseded_charges', (t) => t.text('superseded_charges').nullable()]
];

/**
 * A coluna da 0078 — ver a migração. Um instante e não um booleano, pela razão
 * de sempre neste arquivo: "quando" responde "quem mexeu nisto, e antes ou
 * depois daquele pagamento?", e um booleano não responde nada.
 */
const BILLING_CHARGE_OVERRIDE_COLUMNS = [
  ['amount_overridden_at', (t) => t.timestamp('amount_overridden_at').nullable()]
];

/**
 * As colunas da 0074 — ver a migração.
 *
 * `pending_plan_id` com o MESMO tipo de `subscriptions.plan_id` (inteiro sem
 * sinal): no MySQL uma chave estrangeira entre um `INT` e um `INT UNSIGNED` é
 * recusada, e a coluna tem de poder virar uma se um dia alguém quiser a
 * constraint. Sem `.references` aqui, de propósito: acrescentar uma chave
 * estrangeira a uma tabela que já existe é, no SQLite, recriar a tabela
 * inteira — e a garantia que ela daria já é dada por quem escreve a coluna
 * (`SelfBillingService.changePlan` só agenda um plano que acabou de ler), e
 * `plans` não perde linha: o console desativa plano, nunca apaga.
 */
const SUBSCRIPTION_PENDING_PLAN_COLUMNS = [
  ['pending_plan_id', (t) => t.integer('pending_plan_id').unsigned().nullable()],
  ['pending_plan_at', (t) => t.timestamp('pending_plan_at').nullable()]
];

/**
 * As colunas da 0075 — ver a migração. Instantes e não booleanos: quem lê o
 * banco depois quer saber QUANDO, e nulo continua querendo dizer "não".
 */
const SUBSCRIPTION_PLAN_GUARD_COLUMNS = [
  ['upgraded_at', (t) => t.timestamp('upgraded_at').nullable()],
  ['pending_plan_locked_at', (t) => t.timestamp('pending_plan_locked_at').nullable()]
];

/**
 * As colunas da 0083 — ver a migração. Um instante e não um booleano, como as
 * outras marcas deste arquivo: "isento desde quando" é a primeira pergunta de
 * quem olha a assinatura, e nulo continua querendo dizer "não".
 */
const SUBSCRIPTION_BILLING_EXEMPT_COLUMNS = [
  ['billing_exempt_at', (t) => t.timestamp('billing_exempt_at').nullable()],
  ['billing_exempt_reason', (t) => t.string('billing_exempt_reason', 255).nullable()]
];

/**
 * A coluna da 0091 — ver a migração. Nula é "até alguém desligar", como era
 * antes dela existir.
 */
const SUBSCRIPTION_BILLING_EXEMPT_UNTIL_COLUMNS = [
  ['billing_exempt_until', (t) => t.timestamp('billing_exempt_until').nullable()]
];

/**
 * A coluna da 0102 — ver a migração. Nula em todo `suspended` de antes dela,
 * que é suspensão à mão: o pagamento não o reativa, como nunca reativou.
 */
const SUBSCRIPTION_SUSPENDED_REASON_COLUMNS = [
  ['suspended_reason', (t) => t.string('suspended_reason', 32).nullable()]
];

/**
 * As colunas da 0104 — o ciclo de cobrança (mensal ou anual).
 *
 * `billing_cycle` é o ciclo que vale AGORA: `monthly` cobra `price_cents` por
 * `period_days`; `annual`, `price_yearly_cents` por 365 dias. Toda assinatura
 * de antes é mensal, que é o que ela sempre pagou — daí o padrão.
 * `pending_billing_cycle` é o ciclo da troca agendada para a renovação, ao
 * lado de `pending_plan_id` (nulo é "o mesmo de agora"): a troca de ciclo
 * reaproveita a descida agendada inteira — a fatura da renovação sai no preço
 * do ciclo novo, o pagamento trava, a aplicação troca na data.
 */
const SUBSCRIPTION_BILLING_CYCLE_COLUMNS = [
  ['billing_cycle', (t) => t.string('billing_cycle', 16).notNullable().defaultTo('monthly')],
  ['pending_billing_cycle', (t) => t.string('pending_billing_cycle', 16).nullable()]
];

/**
 * O ciclo com que a cobrança saiu (0104), ao lado de `plan_id`/`coupon_id`:
 * com a troca de ciclo no MESMO plano, o plano sozinho não diz mais se a
 * fatura paga foi a do mês ou a do ano. Nula nas linhas de antes — que são
 * todas mensais.
 */
const BILLING_CHARGE_BILLING_CYCLE_COLUMNS = [
  ['billing_cycle', (t) => t.string('billing_cycle', 16).nullable()]
];

const BILLING_TABLES = [
  ['plans', plansTable],
  ['subscriptions', subscriptionsTable],
  ['billing_events', billingEventsTable],
  // Depois de `subscriptions`: a ordem desta lista é a ordem das chaves
  // estrangeiras, e é ela que o export e a exclusão de provedor percorrem.
  ['billing_charges', billingChargesTable]
];

/**
 * A nota fiscal de serviço (NFS-e) de uma cobrança paga, emitida pela Asaas.
 *
 * Uma linha por cobrança — o índice único em `charge_id` é a idempotência: o
 * webhook reentregue, a baixa do console e o clique repetido no "emitir nota"
 * chegam todos à mesma linha, e nunca a uma segunda nota para o mesmo
 * dinheiro. A linha nasce `pending` no pagamento (sem falar com a Asaas, que
 * pode estar fora do ar) e é o agendador que a leva adiante, com `attempts` e
 * `next_attempt_at` espaçando a insistência como na emissão da cobrança.
 */
const billingInvoicesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('charge_id').unsigned().notNullable()
    .references('id').inTable('billing_charges').onDelete('CASCADE');
  // O id da nota na Asaas (`inv_…`). Nulo até a criação voltar.
  t.string('external_id', 64);
  // pending | scheduled | authorized | error | canceling | canceled
  t.string('status', 16).notNullable().defaultTo('pending');
  t.string('number', 64);
  t.string('pdf_url', 512);
  t.string('xml_url', 512);
  t.string('error', 500);
  t.integer('attempts').notNullable().defaultTo(0);
  t.timestamp('next_attempt_at');
  t.timestamp('issued_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['charge_id'], 'billing_invoices_charge_uq');
  // O agendador pergunta "o que está pendente ou agendado" por provedor.
  t.index(['tenant_id', 'status'], 'billing_invoices_status_idx');
  // O webhook acha a linha pelo id da Asaas, antes de saber o provedor.
  t.index(['external_id'], 'billing_invoices_external_idx');
};

const BILLING_INVOICE_TABLES = [
  ['billing_invoices', billingInvoicesTable]
];

/**
 * Os assinantes do SGP que o painel conhece SEM uma ONT.
 *
 * `sgp_links` é chaveada pelo aparelho: é o espelho do contrato de cada ONT, e
 * um assinante cuja ONT o painel não enxerga — equipamento de outro fabricante,
 * rádio, cadastro novo, ONT que ainda não informou — simplesmente não existia
 * para o WhatsApp. Não havia como abrir conversa com ele nem reconhecer o
 * número dele quando escrevia.
 *
 * A linha nasce de uma consulta ao SGP que um operador pediu (por CPF/CNPJ ou
 * contrato), e é por contrato: o que se guarda é o suficiente para falar com a
 * pessoa — nome, documento, telefone — e nada do equipamento. `phone_manual`
 * tem o mesmo papel que em `sgp_links`: a correção do operador, que uma nova
 * consulta ao SGP nunca sobrescreve.
 */
/**
 * O que a sincronização completa dos contatos (0054) acrescentou.
 *
 * `sgp_client_id` é o id do CLIENTE no SGP, e é a chave de quem não tem
 * contrato: um cadastro sem contrato não tem mais nada que o identifique de uma
 * sincronização para a outra. `last_seen_at` é quando a última sincronização o
 * viu — ninguém é apagado por sumir do SGP, a tela só diz há quanto tempo.
 */
const SGP_CONTACT_SYNC_COLUMNS = [
  ['sgp_client_id', (t) => t.string('sgp_client_id', 64)],
  ['last_seen_at', (t) => t.timestamp('last_seen_at')]
];

/**
 * O que o cadastro completo (0056) acrescentou a cada contrato: o que a
 * listagem do SGP já mandava e o painel descartava. `client_ref` é o id do
 * cliente no SGP dono do contrato — não único, um cliente tem vários — e é o
 * que liga a linha à ficha em `sgp_clients`.
 */
const SGP_CONTACT_PROFILE_COLUMNS = [
  ['client_ref', (t) => t.string('client_ref', 64)],
  ['plan', (t) => t.string('plan', 255)],
  ['due_day', (t) => t.string('due_day', 32)],
  ['status_reason', (t) => t.string('status_reason', 255)],
  ['login', (t) => t.string('login', 128)],
  ['address', (t) => t.text('address')],
  ['contract_created_at', (t) => t.string('contract_created_at', 32)]
];

/**
 * O que o importador da TeiaH Valid (0077) precisa de cada contrato e a linha
 * do endereço não guarda: o endereço em partes (rua, número, bairro, cidade,
 * UF, CEP, e as coordenadas quando o SGP as manda), em JSON como o de
 * `sgp_clients.address`, a data de cancelamento como o SGP a escreveu, e se o
 * equipamento ficou em comodato.
 */
const SGP_CONTACT_TEIAH_COLUMNS = [
  ['address_parts', (t) => t.text('address_parts')],
  ['contract_cancelled_at', (t) => t.string('contract_cancelled_at', 32)],
  // Se o equipamento ficou com o cliente em aluguel ou comodato — o `aluguel`
  // da TeiaH. Nulo é "o SGP não diz", que não é o mesmo que "não".
  ['equipment_rented', (t) => t.boolean('equipment_rented')]
];

/**
 * De onde veio um cadastro que não é do SGP: `whatsapp` (a agenda do número
 * conectado) ou `sheet` (a planilha). Nulo é o que o SGP trouxe ou a equipe
 * digitou — é o que o filtro "Importados" da tela de Contatos separa.
 */
const SGP_CONTACT_IMPORT_COLUMNS = [
  ['import_source', (t) => t.string('import_source', 16).nullable()]
];

/**
 * O que uma campanha de aviso (não de cobrança) guarda além do que
 * `wa_broadcasts` já tinha: de que tipo ela é, quando deve começar sozinha, o
 * anexo que vai junto com cada mensagem e os filtros que escolheram o público.
 */
const WA_BROADCAST_CAMPAIGN_COLUMNS = [
  ['kind', (t) => t.string('kind', 16).notNullable().defaultTo('billing')],
  ['scheduled_at', (t) => t.timestamp('scheduled_at').nullable()],
  ['attachment_path', (t) => t.string('attachment_path', 255)],
  ['attachment_type', (t) => t.string('attachment_type', 128)],
  ['attachment_name', (t) => t.string('attachment_name', 255)],
  ['audience_json', (t) => t.text('audience_json')]
];

/**
 * O detalhe de um pulo que `reason` não cabe: quais variáveis do modelo
 * faltaram. Coluna própria porque `stats()` agrupa por `reason`.
 */
const WA_DUNNING_DETAIL_COLUMNS = [
  ['reason_detail', (t) => t.string('reason_detail', 255)]
];

/**
 * A fatura que um destinatário da cobrança avulsa cita — para conferir, na
 * hora de enviar, se ela não foi paga depois que a campanha foi montada.
 */
const WA_BROADCAST_INVOICE_COLUMNS = [
  ['invoice_key', (t) => t.string('invoice_key', 128)],
  ['due_date', (t) => t.string('due_date', 16)]
];

/**
 * Quais tipos de comunicação um "não perturbe" bloqueia. Nula = todos: o que já
 * está na lista, e todo "SAIR" do cliente, continua bloqueando tudo.
 */
const WA_OPT_OUT_CATEGORY_COLUMNS = [
  ['categories', (t) => t.string('categories', 100).nullable()]
];

/**
 * O ritmo próprio de uma campanha de aviso, em mensagens por hora. Nulo é o
 * ritmo do provedor; o número só pode ser MENOR que ele (o ritmo geral continua
 * valendo na fila de saída).
 */
const WA_BROADCAST_PACE_COLUMNS = [
  ['pace_per_hour', (t) => t.integer('pace_per_hour').nullable()]
];

const SKIP_DETAIL_TABLES = [
  ['wa_dunning_sends', WA_DUNNING_DETAIL_COLUMNS],
  ['wa_broadcast_recipients', WA_BROADCAST_INVOICE_COLUMNS]
];

/**
 * A API oficial da Meta pela integração WHATSAPP-BUSINESS do Evolution v2.
 *
 * `integration` separa o número pareado por QR (`baileys`) do número oficial
 * (`cloud`). Não é o `flavor`: aquele é o dialeto do SERVIDOR (v2 ou GO), e um
 * número oficial roda num servidor v2 como qualquer outro. Os ids da Meta são
 * identificadores, não segredos — o token da Meta, esse sim, vai cifrado no
 * `token_ciphertext` que já existe, porque é ele a chave da instância.
 */
const WA_ACCOUNT_CLOUD_COLUMNS = [
  ['integration', (t) => t.string('integration', 16).notNullable().defaultTo('baileys')],
  ['meta_phone_number_id', (t) => t.string('meta_phone_number_id', 32)],
  ['meta_waba_id', (t) => t.string('meta_waba_id', 32)],
  ['meta_templates_synced_at', (t) => t.timestamp('meta_templates_synced_at').nullable()],
  ['meta_templates_error', (t) => t.string('meta_templates_error', 255)]
];

/**
 * O webhook da conta WABA registrado pelo painel na Graph API
 * (`POST /{waba}/subscribed_apps` com `override_callback_uri`). O provedor não
 * cola mais URL nem token no app dele na Meta: o painel faz isso com o token
 * do próprio número, e o resultado da última tentativa fica aqui para a tela
 * mostrar e oferecer "registrar de novo". Nulo é "ainda não tentado".
 */
const WA_ACCOUNT_META_WEBHOOK_COLUMNS = [
  ['meta_webhook_status', (t) => t.string('meta_webhook_status', 8).nullable()],
  ['meta_webhook_error', (t) => t.string('meta_webhook_error', 255).nullable()],
  ['meta_webhook_at', (t) => t.timestamp('meta_webhook_at').nullable()]
];

/**
 * Como a mensagem saiu: texto livre ou modelo aprovado da Meta. `meta_template`
 * é a foto do modelo no momento do enfileiramento ({name, language, params}) —
 * o envio fora da janela de 24 h só é aceito assim.
 */
const WA_MESSAGE_CLOUD_COLUMNS = [
  ['meta_template', (t) => t.text('meta_template')],
  ['sent_as', (t) => t.string('sent_as', 8)]
];

/**
 * A mensagem a que esta responde (0113): o id local da linha citada, na mesma
 * conversa. O envio busca o id do WhatsApp dela para citar de verdade.
 */
const WA_MESSAGE_REPLY_COLUMNS = [
  ['reply_to_id', (t) => t.integer('reply_to_id').unsigned().nullable()]
];

/**
 * Reação e exclusão de uma mensagem (0114): `my_reaction` é o emoji que o
 * painel pôs nela; `deleted_at` marca a mensagem apagada (para todos no
 * WhatsApp, quando é nossa, ou só da tela do painel, quando é do cliente).
 */
const WA_MESSAGE_ACTION_COLUMNS = [
  ['my_reaction', (t) => t.string('my_reaction', 16).nullable()],
  ['deleted_at', (t) => t.timestamp('deleted_at').nullable()]
];

const WA_CLOUD_TABLES = [
  ['whatsapp_accounts', WA_ACCOUNT_CLOUD_COLUMNS],
  ['wa_messages', WA_MESSAGE_CLOUD_COLUMNS]
];

/** Os tetos de retenção de `plans`, para a migração que os acrescenta. */
const PLAN_RETENTION_COLUMNS = [
  ['max_audit_retention_days', (t) => t.integer('max_audit_retention_days').unsigned()],
  ['max_message_retention_days', (t) => t.integer('max_message_retention_days').unsigned()],
  ['max_media_retention_days', (t) => t.integer('max_media_retention_days').unsigned()]
];

const sgpContactsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  // Nulo para o cadastro sem contrato — ver 0054.
  t.string('contract', 64);
  t.string('document', 32);
  t.string('client_name', 255);
  t.string('status', 64);
  t.string('status_label', 128);
  t.string('state', 16).notNullable().defaultTo('unknown');
  addSgpPhoneColumns(t);
  for (const [, add] of SGP_CONTACT_SYNC_COLUMNS) add(t);
  for (const [, add] of SGP_CONTACT_PROFILE_COLUMNS) add(t);
  for (const [, add] of SGP_CONTACT_TEIAH_COLUMNS) add(t);
  for (const [, add] of SGP_CONTACT_IMPORT_COLUMNS) add(t);
  t.timestamp('last_synced_at').defaultTo(db.fn.now());
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['tenant_id', 'contract'], 'sgp_contacts_contract_uq');
  t.unique(['tenant_id', 'sgp_client_id'], 'sgp_contacts_client_uq');
  t.index(['tenant_id', 'phone_e164'], 'sgp_contacts_phone_idx');
  t.index(['tenant_id', 'phone_manual'], 'sgp_contacts_phone_manual_idx');
  t.index(['tenant_id', 'client_ref'], 'sgp_contacts_client_ref_idx');
};

/**
 * A ficha de cada cliente — uma linha por cliente, e não por contrato como
 * `sgp_contacts`.
 *
 * Os campos vêm da listagem do SGP; `overrides` guarda, por campo, o que um
 * operador escreveu no painel, e é o que a tela mostra no lugar do valor do
 * SGP. A sincronização reescreve só os campos do SGP e nunca toca em
 * `overrides` nem em `notes`. `source` = `panel` é o cliente criado no painel,
 * sem SGP atrás; o id dele começa com `panel:`.
 *
 * Endereço, telefones, e-mails e `overrides` são JSON em texto: os três bancos
 * guardam e devolvem igual, e ninguém filtra por dentro deles.
 */
const sgpClientsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('sgp_client_id', 64).notNullable();
  t.string('source', 16).notNullable().defaultTo('sgp');
  t.string('document', 32);
  t.string('person_type', 16);
  t.string('name', 255);
  t.string('gender', 16);
  t.string('birth_date', 32);
  t.string('registered_at', 32);
  t.text('address');
  t.text('phones');
  t.text('emails');
  t.text('overrides');
  t.text('notes');
  t.timestamp('last_seen_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['tenant_id', 'sgp_client_id'], 'sgp_clients_client_uq');
  t.index(['tenant_id', 'document'], 'sgp_clients_document_idx');
};

/**
 * O que o painel mandou à TeiaH Valid, um contrato por linha — ver
 * `teiahExportService.js`.
 *
 * Guarda o hash do que foi enviado e não o envio em si: o endereço já mora em
 * `sgp_contacts`, e uma segunda cópia seria só mais um lugar a apagar. O hash
 * basta para não reenviar o que não mudou. `status` é `sent`, `skipped` (faltou
 * dado; `reason` diz qual) ou `error`.
 */
const teiahExportsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('contract', 64).notNullable();
  t.string('status', 16).notNullable();
  t.string('reason', 64);
  t.string('payload_hash', 64);
  t.decimal('amount', 12, 2);
  t.timestamp('sent_at');
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
  t.unique(['tenant_id', 'contract'], 'teiah_exports_contract_uq');
  t.index(['tenant_id', 'status'], 'teiah_exports_status_idx');
};

const TEIAH_TABLES = [
  ['teiah_exports', teiahExportsTable]
];

/**
 * A régua de cobrança automática: cada mensagem que ela decidiu mandar — ou
 * decidiu NÃO mandar, e por quê — para uma fatura. Ver `waDunningService.js`.
 *
 * A configuração da régua (etapas, janela, teto) mora em `app_state`, como a
 * do chatbot: é uma por provedor. Esta tabela é o histórico, e é também a
 * trava. O índice único (fatura, tipo, etapa) é o que faz "uma vez por etapa
 * por fatura" valer mesmo com duas passadas ao mesmo tempo: a segunda esbarra
 * no índice e não enfileira nada.
 *
 * `step_offset` é NOT NULL de propósito, com 0 no agradecimento: NULL não
 * colide em índice único em nenhum dos três bancos, e um agradecimento
 * repetido é exatamente o que o índice tem de recusar. `kind` separa o 0 do
 * agradecimento do 0 da etapa "vence hoje".
 *
 * Se a mensagem saiu ou falhou, quem sabe é `wa_messages.delivery_status`,
 * lido por junção: guardar aqui de novo seria uma segunda memória com chance
 * de discordar da primeira.
 */
const waDunningSendsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('kind', 8).notNullable(); // step | thanks
  t.integer('step_offset').notNullable().defaultTo(0);
  t.string('contract', 64).notNullable();
  // O número do título no SGP, ou `venc:<data>:<valor>` quando o ERP não dá um.
  t.string('invoice_key', 128).notNullable();
  t.string('due_date', 10);
  t.decimal('amount', 12, 2);
  t.string('client_name', 255);
  t.string('phone_e164', 24);
  t.integer('template_id').unsigned()
    .references('id').inTable('wa_templates').onDelete('SET NULL');
  t.integer('message_id').unsigned()
    .references('id').inTable('wa_messages').onDelete('SET NULL');
  // queued | skipped | canceled
  t.string('status', 16).notNullable();
  t.string('reason', 32);
  // Quando o painel soube que a fatura foi paga — pelo webhook do SGP ou por
  // ela ter sumido das em aberto numa passada.
  t.timestamp('paid_at');
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
  t.unique(['tenant_id', 'contract', 'invoice_key', 'kind', 'step_offset'], 'wa_dunning_sends_step_uq');
  t.index(['tenant_id', 'created_at'], 'wa_dunning_sends_created_idx');
  t.index(['tenant_id', 'contract'], 'wa_dunning_sends_contract_idx');
};

const DUNNING_TABLES = [
  ['wa_dunning_sends', waDunningSendsTable]
];

/**
 * A pesquisa de satisfação: uma linha por pergunta mandada ao encerrar uma
 * conversa com atendente. `status` anda `pending` → (`comment` →) `answered`,
 * ou para em `skipped` quando o cliente respondeu outra coisa. `agent_user_id`
 * é quem atendeu — a última mensagem de gente na conversa —, e não quem
 * apertou "Encerrar".
 */
const waSatisfactionTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('conversation_id').unsigned().notNullable();
  t.integer('agent_user_id').unsigned().nullable();
  t.string('status', 16).notNullable().defaultTo('pending');
  t.integer('score').nullable();
  t.text('comment');
  t.timestamp('asked_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('answered_at');
  t.index(['tenant_id', 'asked_at'], 'wa_satisfaction_asked_idx');
  t.index(['tenant_id', 'conversation_id'], 'wa_satisfaction_conversation_idx');
};

/**
 * Os modelos (templates) aprovados na conta WABA de um número oficial, como a
 * Meta os devolve pela integração do Evolution — uma cópia, sincronizada pelo
 * botão da tela. Só os aprovados e `supported` aparecem no seletor; o resto
 * fica visível para o provedor saber por que não aparece.
 */
const waMetaTemplatesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('account_id').unsigned().notNullable()
    .references('id').inTable('whatsapp_accounts').onDelete('CASCADE');
  t.string('meta_id', 64);
  t.string('name', 255).notNullable();
  t.string('language', 16).notNullable();
  t.string('category', 24);
  t.string('status', 24);
  t.text('body_text');
  t.integer('param_count').notNullable().defaultTo(0);
  t.string('param_format', 12).notNullable().defaultTo('positional');
  t.boolean('supported').notNullable().defaultTo(false);
  t.text('components_json');
  t.timestamp('synced_at').notNullable().defaultTo(db.fn.now());
  t.unique(['account_id', 'name', 'language'], 'wa_meta_templates_unique');
  t.index(['tenant_id', 'account_id'], 'wa_meta_templates_account_idx');
};

const WA_META_TEMPLATE_TABLES = [
  ['wa_meta_templates', waMetaTemplatesTable]
];

/**
 * O modelo da Meta que um modelo do painel usa fora da janela de 24 h:
 * nome, idioma e a lista ORDENADA das nossas variáveis que preenchem `{{1}}`,
 * `{{2}}`… (`texto` é o texto inteiro já renderizado).
 */
const WA_TEMPLATE_META_COLUMNS = [
  ['meta_template_name', (t) => t.string('meta_template_name', 255)],
  ['meta_language', (t) => t.string('meta_language', 16)],
  ['meta_params', (t) => t.text('meta_params')]
];

/** A foto do modelo Meta de cada destinatário, tirada na montagem da campanha. */
const WA_RECIPIENT_META_COLUMNS = [
  ['meta_template', (t) => t.text('meta_template')]
];

const WA_META_TEMPLATE_COLUMN_TABLES = [
  ['wa_templates', WA_TEMPLATE_META_COLUMNS],
  ['wa_broadcast_recipients', WA_RECIPIENT_META_COLUMNS]
];

/**
 * Cabeçalho e botões dos modelos da Meta (0091).
 *
 * Na cópia sincronizada: o formato do cabeçalho (`NONE`, `TEXT`, `IMAGE`,
 * `VIDEO`, `DOCUMENT`, `LOCATION`), quantas variáveis o cabeçalho de texto tem
 * e a lista dos botões (`[{index, type, urlHasParam}]`).
 *
 * Na ligação do modelo do painel: de onde vem o cabeçalho
 * (`{source: 'attachment'|'variable'|'url', value, type}`), qual variável
 * preenche o sufixo da URL do botão dinâmico e o índice desse botão no modelo
 * — a Meta identifica o botão pela posição.
 */
const WA_META_TEMPLATE_MEDIA_COLUMNS = [
  ['header_format', (t) => t.string('header_format', 12)],
  ['header_param_count', (t) => t.integer('header_param_count').notNullable().defaultTo(0)],
  ['buttons_json', (t) => t.text('buttons_json')]
];

const WA_TEMPLATE_META_MEDIA_COLUMNS = [
  ['meta_header', (t) => t.text('meta_header')],
  ['meta_button_param', (t) => t.string('meta_button_param', 64)],
  ['meta_button_index', (t) => t.integer('meta_button_index')]
];

const WA_META_MEDIA_COLUMN_TABLES = [
  ['wa_meta_templates', WA_META_TEMPLATE_MEDIA_COLUMNS],
  ['wa_templates', WA_TEMPLATE_META_MEDIA_COLUMNS]
];

const SATISFACTION_TABLES = [
  ['wa_satisfaction', waSatisfactionTable]
];

/**
 * Quem está atendendo o WhatsApp agora. `available` é o interruptor da
 * pessoa; `last_seen_at` é o pulso da tela aberta — disponível com a aba
 * fechada há dez minutos não é disponível. `last_assigned_at` desempata o
 * rodízio entre quem tem a mesma carga.
 */
const waAgentsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('user_id').unsigned().notNullable()
    .references('id').inTable('users').onDelete('CASCADE');
  t.boolean('available').notNullable().defaultTo(false);
  t.timestamp('last_seen_at');
  t.timestamp('last_assigned_at');
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['tenant_id', 'user_id'], { indexName: 'wa_agents_tenant_user_unique' });
};

const WA_AGENT_TABLES = [
  ['wa_agents', waAgentsTable]
];

/**
 * As etiquetas das conversas: a lista do provedor (`wa_tags`, cor da mesma
 * paleta fechada dos números) e quem tem qual (`wa_conversation_tags`). O
 * vínculo guarda quando foi feito — é o que o relatório conta por período.
 */
const waTagsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('name', 40).notNullable();
  t.string('color', 16).notNullable();
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.unique(['tenant_id', 'name'], { indexName: 'wa_tags_tenant_name_unique' });
};

const waConversationTagsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('conversation_id').unsigned().notNullable();
  t.integer('tag_id').unsigned().notNullable();
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.unique(['tenant_id', 'conversation_id', 'tag_id'], { indexName: 'wa_conversation_tags_unique' });
  t.index(['tenant_id', 'tag_id'], 'wa_conversation_tags_tag_idx');
};

const WA_TAG_TABLES = [
  ['wa_tags', waTagsTable],
  ['wa_conversation_tags', waConversationTagsTable]
];

/**
 * A régua de cobrança parada para um contrato (0097): o cliente mandou um
 * comprovante, ou alguém pausou à mão. Uma linha por contrato; `until` é até
 * quando. A passada pula o contrato sem gravar nada, então a etapa continua
 * devida e sai depois da pausa se a fatura ainda estiver aberta.
 */
const waDunningPausesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('contract', 64).notNullable();
  t.timestamp('until').notNullable();
  t.string('reason', 16).notNullable(); // receipt | manual
  t.integer('conversation_id').unsigned();
  t.integer('message_id').unsigned();
  t.integer('created_by').unsigned();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
  t.unique(['tenant_id', 'contract'], { indexName: 'wa_dunning_pauses_contract_uq' });
};

/**
 * A situação financeira de cada contrato, como foi vista na última consulta ao
 * SGP (0108): a data da fatura em aberto mais antiga. A cor (em dia, vence
 * hoje, atrasado) é recalculada na leitura a partir dela, então a virada do
 * dia não precisa de nova consulta.
 */
const sgpBillingStatusTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('contract', 64).notNullable();
  t.string('oldest_due_date', 10);
  t.timestamp('checked_at').notNullable().defaultTo(db.fn.now());
  t.unique(['tenant_id', 'contract'], { indexName: 'sgp_billing_status_contract_uq' });
};

const BILLING_STATUS_TABLES = [
  ['sgp_billing_status', sgpBillingStatusTable]
];

/**
 * As indicações (0111): quem um cliente indicou pelo link dele. Uma linha por
 * indicado; `referrer_contract` é o contrato de quem indicou. `status` anda de
 * `new` até `rewarded` (ou `lost`), à mão, na tela de Indicações. Nome e
 * telefone do indicado são dado de uma pessoa que ainda não é cliente — o
 * dossiê da LGPD alcança a linha por qualquer das duas pontas.
 */
const customerReferralsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('referrer_contract', 64).notNullable();
  t.string('referrer_name', 255);
  t.string('name', 120).notNullable();
  t.string('phone_e164', 24).notNullable();
  t.string('neighborhood', 120);
  t.string('note', 500);
  t.string('status', 16).notNullable().defaultTo('new');
  t.timestamp('referrer_notified_at').nullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
  t.index(['tenant_id', 'referrer_contract'], 'customer_referrals_referrer_idx');
  t.index(['tenant_id', 'created_at'], 'customer_referrals_created_idx');
};

const CUSTOMER_REFERRAL_TABLES = [
  ['customer_referrals', customerReferralsTable]
];

const DUNNING_PAUSE_TABLES = [
  ['wa_dunning_pauses', waDunningPausesTable]
];

/**
 * A cobrança por excedente (0105): o preço, em centavos, de cada unidade acima
 * do teto do plano — por operador, por assinante, por ONT. Nulo é "sem preço",
 * e aí o teto continua bloqueando como sempre (o 402 de operador, a
 * sincronização que não cria assinante, a troca de plano recusada). Com preço,
 * o teto deixa de ser parede: quem passa paga as unidades a mais na fatura da
 * renovação (ver `UsageOverageService`).
 */
const PLAN_OVERAGE_COLUMNS = [
  ['overage_price_cents_operators', (t) => t.integer('overage_price_cents_operators').unsigned().nullable()],
  ['overage_price_cents_subscribers', (t) => t.integer('overage_price_cents_subscribers').unsigned().nullable()],
  ['overage_price_cents_devices', (t) => t.integer('overage_price_cents_devices').unsigned().nullable()]
];

/**
 * A conta do valor de uma cobrança (0105), em JSON: `{ base, overage: [...] }`
 * — o preço do plano (já com o cupom) e o excedente do período que fecha —,
 * e outras parcelas que vierem depois (o crédito de indicação). Nula nas
 * linhas de antes: o valor delas é o preço do plano, e só.
 */
const BILLING_CHARGE_PRICING_DETAIL_COLUMNS = [
  ['pricing_detail', (t) => t.text('pricing_detail').nullable()]
];

/**
 * O maior uso de cada recurso em cada período (0105). `period_end` é a chave
 * do período no fuso da cobrança (`ChargeIssuingService.periodKey`, o mesmo
 * texto de `billing_charges.period_end`), e o pico só sobe — o agendador grava
 * o maior entre o guardado e o de agora. Do provedor (escopada), e some com
 * ele.
 */
const USAGE_PEAK_SNAPSHOT_COLUMNS = [
  ['limit_value', (t) => t.integer('limit_value').unsigned().nullable()],
  ['unit_cents', (t) => t.integer('unit_cents').unsigned().nullable()],
  ['overage_peak', (t) => t.integer('overage_peak').unsigned().nullable()]
];

const usagePeaksTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('period_end', 10).notNullable();
  t.string('resource', 16).notNullable(); // operators | subscribers | devices
  t.integer('peak').unsigned().notNullable().defaultTo(0);
  // A fotografia do plano que valia quando o excedente MAIOR do período foi
  // medido: o teto e o preço por unidade dele, e o uso naquele instante. A
  // cobrança lê daqui, e não do plano de quando sai — subir de plano antes
  // da fatura não apaga o excedente que já se devia. Nulos nas linhas
  // gravadas sem a fotografia (aí vale o plano de agora).
  for (const [, add] of USAGE_PEAK_SNAPSHOT_COLUMNS) add(t);
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
  t.unique(['tenant_id', 'period_end', 'resource'], { indexName: 'usage_peaks_period_resource_uq' });
};

const USAGE_PEAK_TABLES = [
  ['usage_peaks', usagePeaksTable]
];

/**
 * Os cupons de desconto da assinatura (0093). Da PLATAFORMA, como `plans`: um
 * cupom é do catálogo comercial do deploy inteiro, e um provedor o resgata —
 * não tem o seu. Por isso sem `tenant_id`, e só o console escreve aqui.
 *
 * `code` único e sempre em maiúsculas (quem grava normaliza). `value` é o
 * percentual inteiro (1–99: o de 100% é recusado na criação, porque a fatura
 * de valor zero seria um caminho de dinheiro novo) ou centavos. `duration`:
 * `once` (só a 1ª fatura), `repeating` (`duration_cycles` faturas) ou
 * `forever`. `plan_ids` é uma lista JSON opcional dos planos em que ele vale.
 * `redemptions` sobe por atualização condicional, nunca por leitura e escrita
 * — é ela que segura o `max_redemptions` sob corrida.
 */
const couponsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('code', 32).notNullable().unique();
  t.string('kind', 16).notNullable();
  t.integer('value').unsigned().notNullable();
  t.string('duration', 16).notNullable();
  t.integer('duration_cycles').unsigned();
  t.integer('max_redemptions').unsigned();
  t.integer('redemptions').unsigned().notNullable().defaultTo(0);
  t.timestamp('valid_until').nullable();
  t.text('plan_ids');
  t.boolean('active').notNullable().defaultTo(true);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

/**
 * Quem já resgatou cada cupom (0093): uma linha por provedor por cupom. É ela
 * que impede o mesmo provedor de resgatar o mesmo cupom de novo depois de
 * gastá-lo — `subscriptions.coupon_id` some quando o último ciclo é consumido,
 * e sem esta memória o código voltaria a valer. Do PROVEDOR (escopada): diz
 * que descontos ele recebeu, e some junto com ele. Gravada na mesma transação
 * que sobe `coupons.redemptions`, e desfeita junto quando a aplicação falha.
 */
const couponRedemptionsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('coupon_id').unsigned().notNullable()
    .references('id').inTable('coupons').onDelete('CASCADE');
  t.timestamp('redeemed_at').notNullable().defaultTo(db.fn.now());
  t.unique(['coupon_id', 'tenant_id'], 'coupon_redemptions_coupon_tenant_uq');
};

const COUPON_TABLES = [
  ['coupons', couponsTable],
  ['coupon_redemptions', couponRedemptionsTable]
];

/**
 * Com que plano e com que cupom cada cobrança saiu (0093), gravados na emissão
 * e na reprecificação. É o que diz, no pagamento, se a fatura paga carregava o
 * desconto (para gastar o ciclo do cupom só então) e se pagou a descida
 * agendada (para não comparar preços que o cupom pode ter igualado). Nulas na
 * cobrança feita à mão ou anterior a elas — aí a conferência volta ao preço.
 */
const BILLING_CHARGE_PRICING_COLUMNS = [
  ['plan_id', (t) => t.integer('plan_id').unsigned().nullable()],
  ['coupon_id', (t) => t.integer('coupon_id').unsigned().nullable()]
];

/**
 * A fatura de pró-rata da subida no meio do período (0101).
 *
 * `kind` separa a cobrança da RENOVAÇÃO (a de sempre, uma por período, com a
 * chave `period_end`) da avulsa da subida (`proration`). A avulsa não pode
 * usar a chave do período — a renovação daquele prazo já é dona dela, no
 * índice único `(tenant_id, period_end)` —, então ela grava em `period_end`
 * uma chave própria que não é data (`p…`, ver `BillingCharge.openProration`),
 * e o fim de período de verdade vai em `proration_detail`, com a conta inteira
 * (planos, preços, segundos restantes) para quem precisar conferir depois.
 *
 * Nas linhas que já existem, `renewal`: é o que todas elas são.
 */
const BILLING_CHARGE_PRORATION_COLUMNS = [
  ['kind', (t) => t.string('kind', 16).notNullable().defaultTo('renewal')],
  ['proration_detail', (t) => t.text('proration_detail').nullable()]
];

/**
 * Quando a fatura de pró-rata em aberto mais antiga vence (0101) — a cópia que
 * o estado da assinatura lê sem consulta (`effectiveStatus` é síncrono e roda
 * a cada requisição, pelo gate). Mantida por `BillingCharge.syncProrationDue`
 * a cada mudança de estado de uma cobrança de pró-rata; nula quando não há
 * nenhuma em aberto.
 */
const SUBSCRIPTION_PRORATION_COLUMNS = [
  ['proration_due_at', (t) => t.timestamp('proration_due_at').nullable()]
];

/**
 * O cupom na assinatura (0093). Sem `.references`, pelo motivo de
 * `pending_plan_id`: acrescentar chave estrangeira a uma tabela que já existe
 * é recriá-la no SQLite, e quem escreve a coluna acabou de ler o cupom.
 * `coupon_cycles_left` nulo é o `forever`; `coupon_applied_at` é quando foi
 * aplicado, e volta junto quando um estorno devolve o ciclo que o tirou.
 */
const SUBSCRIPTION_COUPON_COLUMNS = [
  ['coupon_id', (t) => t.integer('coupon_id').unsigned().nullable()],
  ['coupon_cycles_left', (t) => t.integer('coupon_cycles_left').unsigned().nullable()],
  ['coupon_applied_at', (t) => t.timestamp('coupon_applied_at').nullable()]
];

/**
 * O cartão recorrente na assinatura (0100) — ver `cardAutopayService`.
 *
 * O cartão em si nunca passa por aqui: quem o digita é o provedor, na página
 * do Asaas. O que se guarda é o `creditCardToken` que o gateway devolve depois
 * de um pagamento com cartão, cifrado com `secretBox` no envelope de colunas
 * de sempre (`_ciphertext`/`_iv`/`_tag`/`_key_version` — o sufixo é o que
 * tira a coluna do export do provedor), mais o que a tela mostra (bandeira e
 * os quatro últimos dígitos) e o IP de quem ligou a cobrança automática, que
 * o gateway exige em toda cobrança por token (`remoteIp`).
 *
 * `card_autopay_at` é a intenção (nulo = desligada); `card_failed_at` e
 * `card_failure` (um código, nunca o texto do gateway) param o uso do cartão
 * até um novo pagamento com cartão trocar o token; `card_capture_payment_id`
 * é o pagamento cujo token ainda falta ler (a captura sai fora do webhook);
 * `card_failure_notified_at` é a memória do aviso de recusa.
 */
const SUBSCRIPTION_CARD_COLUMNS = [
  ['card_autopay_at', (t) => t.timestamp('card_autopay_at').nullable()],
  ['card_token_ciphertext', (t) => t.text('card_token_ciphertext').nullable()],
  ['card_token_iv', (t) => t.string('card_token_iv', 32).nullable()],
  ['card_token_tag', (t) => t.string('card_token_tag', 32).nullable()],
  ['card_token_key_version', (t) => t.integer('card_token_key_version').nullable()],
  ['card_brand', (t) => t.string('card_brand', 32).nullable()],
  ['card_last4', (t) => t.string('card_last4', 4).nullable()],
  ['card_saved_at', (t) => t.timestamp('card_saved_at').nullable()],
  ['card_remote_ip', (t) => t.string('card_remote_ip', 45).nullable()],
  ['card_failed_at', (t) => t.timestamp('card_failed_at').nullable()],
  ['card_failure', (t) => t.string('card_failure', 32).nullable()],
  ['card_failure_notified_at', (t) => t.timestamp('card_failure_notified_at').nullable()],
  ['card_capture_payment_id', (t) => t.string('card_capture_payment_id', 128).nullable()]
];

/**
 * Com que meio a cobrança foi pedida ao gateway (0100): `UNDEFINED` (a página
 * de Pix-ou-boleto, nulo nas linhas de antes) ou `CREDIT_CARD` (o token
 * salvo). É o que `updateCharge` reenvia, e o que diz que uma tentativa por
 * cartão já foi feita nesta linha.
 */
const BILLING_CHARGE_CARD_COLUMNS = [
  ['billing_type', (t) => t.string('billing_type', 16).nullable()],
  // Os termos do desconto por antecipação com que a cobrança saiu (JSON,
  // `{ discount: {...} | null }`): a conferência do pagamento lê ESTES, e não
  // a configuração de hoje. Nulo nas linhas de antes — e aí vale a de hoje.
  ['discount_terms', (t) => t.text('discount_terms').nullable()]
];

/** A conversa com dono: quem atende, desde quando, e desde quando espera um. */
const WA_ASSIGNMENT_COLUMNS = [
  ['assigned_user_id', (t) => t.integer('assigned_user_id').unsigned().nullable()],
  ['assigned_at', (t) => t.timestamp('assigned_at').nullable()],
  ['waiting_since', (t) => t.timestamp('waiting_since').nullable()]
];

/**
 * Os códigos de recuperação do login em duas etapas — ver `0059_user_totp`.
 * Só o hash de cada código: são senhas de uso único.
 */
const userRecoveryCodesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('user_id').unsigned().notNullable()
    .references('id').inTable('users').onDelete('CASCADE');
  t.string('code_hash', 64).notNullable();
  t.timestamp('used_at').nullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.index(['user_id']);
};

/**
 * Uma queda em massa vista pelo alerta `mass_outage` — um nó do mapa (ODP,
 * ODC, OLT) com ONTs demais offline ao mesmo tempo — e quem ela atingiu.
 *
 * O alerta avisa a equipe e esquece; o incidente é o que sobra para avisar o
 * CLIENTE: a lista dos aparelhos, o que foi dito a quem e quando, e se o
 * "normalizado" já saiu. `outage_incident_devices` guarda o telefone do
 * momento do aviso, para o "normalizado" ir a quem recebeu o aviso mesmo que
 * o cadastro mude no meio.
 */
const outageIncidentsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('node_id', 255).notNullable();
  t.string('node_name', 255);
  t.string('status', 16).notNullable().defaultTo('open');
  t.timestamp('started_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('resolved_at').nullable();
  t.string('eta_text', 255).nullable();
  t.text('notice_body').nullable();
  t.timestamp('notice_sent_at').nullable();
  t.integer('notice_sent_by').nullable();
  t.timestamp('recovery_sent_at').nullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
  t.index(['tenant_id', 'status'], 'outage_incidents_status_idx');
};

const outageIncidentDevicesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('incident_id').unsigned().notNullable()
    .references('id').inTable('outage_incidents').onDelete('CASCADE');
  t.string('device_id', 255).notNullable();
  t.string('contract', 64).nullable();
  t.string('client_name', 255).nullable();
  t.string('phone_e164', 32).nullable();
  t.timestamp('notified_at').nullable();
  t.timestamp('recovered_at').nullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.unique(['incident_id', 'device_id'], 'outage_incident_devices_uq');
  t.index(['tenant_id', 'device_id'], 'outage_incident_devices_device_idx');
};

/**
 * O que o bot respondeu, uma linha por resposta: a intenção e a conversa. É o
 * que o relatório do chatbot conta — `wa_messages` guarda que o bot falou,
 * não sobre o quê. Sem texto nenhum aqui: a mensagem continua só onde já
 * estava. Podada em 180 dias pelo agendador.
 */
const waBotEventsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('conversation_id').unsigned().nullable();
  t.string('intent', 32).notNullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.index(['tenant_id', 'created_at'], 'wa_bot_events_created_idx');
  t.index(['tenant_id', 'conversation_id'], 'wa_bot_events_conversation_idx');
};

const WA_BOT_EVENT_TABLES = [
  ['wa_bot_events', waBotEventsTable]
];

const OUTAGE_TABLES = [
  ['outage_incidents', outageIncidentsTable],
  ['outage_incident_devices', outageIncidentDevicesTable]
];

/**
 * Manutenção programada: uma janela em que o provedor para um nó do mapa de
 * propósito (OLT, ODC, ODP, HTB). O aviso sai sozinho `lead_minutes` antes do
 * início; durante a janela o alerta de queda e o histórico de rompimentos
 * ignoram as ONTs embaixo do nó; no fim, quem foi avisado recebe o
 * "concluída". `maintenance_window_devices` guarda o telefone do momento do
 * aviso, como `outage_incident_devices`.
 */
const maintenanceWindowsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('node_id', 255).notNullable();
  t.string('node_name', 255);
  t.string('node_type', 16);
  t.timestamp('starts_at').notNullable();
  t.timestamp('ends_at').notNullable();
  t.integer('lead_minutes').notNullable().defaultTo(1440);
  t.text('message').nullable();
  t.string('status', 16).notNullable().defaultTo('scheduled');
  t.timestamp('notice_sent_at').nullable();
  t.timestamp('closing_sent_at').nullable();
  t.timestamp('finished_at').nullable();
  t.integer('created_by').nullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
  t.index(['tenant_id', 'status', 'starts_at'], 'maintenance_windows_status_idx');
};

const maintenanceWindowDevicesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('window_id').unsigned().notNullable()
    .references('id').inTable('maintenance_windows').onDelete('CASCADE');
  t.string('device_id', 255).notNullable();
  t.string('contract', 64).nullable();
  t.string('client_name', 255).nullable();
  t.string('phone_e164', 32).nullable();
  t.timestamp('notified_at').nullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.unique(['window_id', 'device_id'], 'maintenance_window_devices_uq');
  t.index(['tenant_id', 'device_id'], 'maintenance_window_devices_device_idx');
};

const MAINTENANCE_TABLES = [
  ['maintenance_windows', maintenanceWindowsTable],
  ['maintenance_window_devices', maintenanceWindowDevicesTable]
];

const MFA_TABLES = [
  ['user_recovery_codes', userRecoveryCodesTable]
];

/**
 * A contagem de tentativas por conta — ver `models/AccountLockout.js`.
 *
 * Sem chave estrangeira para `users`, de propósito: o sujeito é `user:<id>` para
 * quem existe e `login:<sha256>` para o login inventado, e o segundo não aponta
 * para linha nenhuma — é justamente o caso que impede a trava de virar oráculo
 * de quem tem conta. Os instantes são milissegundos em `bigInteger`, e não
 * `timestamp`: a comparação é feita contra `Date.now()` nos três dialetos, sem
 * fuso nem precisão de coluna para discordar entre eles.
 */
const accountLockoutsTable = () => (t) => {
  t.string('subject', 96).primary();
  t.integer('attempts').notNullable().defaultTo(0);
  t.bigInteger('window_started_at').notNullable();
  t.bigInteger('locked_until').nullable();
  t.bigInteger('updated_at').notNullable();
  t.index(['updated_at'], 'account_lockouts_updated_idx');
};

const LOCKOUT_TABLES = [
  ['account_lockouts', accountLockoutsTable]
];

/**
 * O que o modo `agent` (0076) acrescentou à conexão do provedor.
 *
 * - `agent_token_hash`: o sha256 (hex) da chave do agente. A chave em si só
 *   existe na resposta que a gerou e no arquivo de ambiente da máquina do
 *   provedor; aqui fica o digest, que não volta a ser chave. ÚNICO porque é
 *   por ele que a conexão do agente descobre DE QUEM é — a busca acontece
 *   antes de existir provedor em escopo, e dois provedores com o mesmo digest
 *   seriam uma conexão que serve os dois.
 * - `agent_token_hint`: os 4 últimos caracteres, para a tela dizer QUAL chave
 *   está valendo sem mostrá-la.
 * - `agent_token_created_at`, `agent_last_seen_at`, `agent_version`: o que a
 *   tela mostra do agente — desde quando a chave vale, quando ele foi visto
 *   pela última vez e que versão diz ser.
 *
 * Tudo nulo: um provedor em `direct` não tem agente nenhum, e é o caso normal.
 */
const GENIEACS_AGENT_COLUMNS = [
  ['agent_token_hash', (t) => t.string('agent_token_hash', 64).nullable()],
  ['agent_token_hint', (t) => t.string('agent_token_hint', 8).nullable()],
  ['agent_token_created_at', (t) => t.timestamp('agent_token_created_at').nullable()],
  ['agent_last_seen_at', (t) => t.timestamp('agent_last_seen_at').nullable()],
  ['agent_version', (t) => t.string('agent_version', 32).nullable()]
];
const GENIEACS_AGENT_TOKEN_INDEX = 'tgc_agent_token_hash_uq';

/**
 * Como o painel chega ao GenieACS de cada provedor: `direct` (a URL, como
 * sempre foi), `tunnel` (a URL numa rede privada de cliente, liberada pela
 * plataforma) e `agent` (um programa na rede do provedor que abriu WebSocket
 * de saída para o painel — ver `GENIEACS_AGENT_COLUMNS`). Sem linha, vale
 * `direct` — é o que todo provedor de antes desta tabela já fazia, e a
 * migração não precisa escrever nada para que continue assim.
 */
const tenantGenieAcsConnectionsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('mode', 16).notNullable().defaultTo('direct');
  // Quem administra o ACS na SaaS: `platform` (o console grava URL, credencial
  // e parâmetros TR-069) ou `own` (o servidor é do provedor, e ele mesmo grava).
  t.string('ownership', 16).notNullable().defaultTo('platform');
  for (const [, add] of GENIEACS_AGENT_COLUMNS) add(t);
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
  t.unique(['tenant_id']);
  t.unique(['agent_token_hash'], GENIEACS_AGENT_TOKEN_INDEX);
};

const GENIEACS_CONNECTION_TABLES = [
  ['tenant_genieacs_connections', tenantGenieAcsConnectionsTable]
];

const SGP_CONTACT_TABLES = [
  ['sgp_contacts', sgpContactsTable],
  ['sgp_clients', sgpClientsTable]
];

const TENANCY_TABLES = [
  ['tenants', tenantsTable]
];

/**
 * Created by 0028 rather than with the tenancy tables, because it references
 * `users` — which step 0001 creates, long after `tenants` exists.
 */
const MEMBERSHIP_TABLES = [
  ['tenant_users', tenantUsersTable],
  // Same reason as `tenant_users`: it references `users`, created by step 0001.
  ['platform_admins', platformAdminsTable],
  // Idem: aponta para `users` (quem convidou, quem aceitou) e para `tenants`.
  ['tenant_invites', tenantInvitesTable],
  // Idem: aponta para `users` (quem fez) e para `tenants`.
  ['audit_log', auditLogTable],
  // Aponta para `users` e para mais nada — ver o comentário na fábrica.
  ['platform_audit', platformAuditTable],
  // Idem: aponta para `users` (quem personifica) e para `tenants` (quem é
  // personificado).
  ['impersonation_tickets', impersonationTicketsTable],
  // Idem: aponta para `users` (de quem é o bilhete) e para `tenants` (por qual
  // host ele entra).
  ['auth_tickets', authTicketsTable]
];

const INITIAL_TABLES = [
  ['users', usersTable],
  ['settings', keyValueTable],
  ['app_state', keyValueTable],
  ['vendors', vendorsTable],
  ['wifi_security_config', wifiSecurityConfigTable],
  ['mapping_nodes', mappingNodesTable],
  ['mapping_edges', mappingEdgesTable],
  ['map_settings', mapSettingsTable],
  ['customer_accounts', customerAccountsTable],
  ['device_profiles', deviceProfilesTable],
  ['sgp_links', sgpLinksTable],
  ['customer_wifi_credentials', customerWifiCredentialsTable]
];

/**
 * Os lembretes de cobrança que a plataforma mandou ao provedor — ver
 * `subscriptionNoticeService.js` (migração 0092).
 *
 * Substitui a marca única `subscriptions.expiry_warned_for`: a régua tem três
 * etapas por prazo (`before`, `due`, `after`), e uma coluna só lembra de uma.
 * Esta tabela é o histórico que o console mostra E a trava: o índice único
 * `(tenant_id, due_at, step)` é o que faz "uma vez por etapa por prazo" valer
 * com duas passadas ao mesmo tempo — a segunda esbarra no índice e não manda.
 *
 * `due_at` é a DATA do prazo (ISO, no fuso da cobrança), e não o instante,
 * pela mesma razão de `billing_charges.period_end`: a chave entra num índice
 * único, e um timestamp não sobrevive igual aos três bancos (o MySQL trunca
 * para segundos). Um prazo mexido em algumas horas continua sendo o mesmo dia,
 * e não reabre etapa já mandada.
 *
 * `sent_at` nulo é a linha tomada por uma passada que ainda está mandando;
 * `claimed_until` é até quando — vencido, outra passada a retoma, para um
 * processo que morreu no meio não deixar a etapa presa para sempre.
 */
const subscriptionReminderSendsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('due_at', 10).notNullable();
  t.string('step', 8).notNullable(); // before | due | after
  // Por onde saiu, separado por vírgula: `email`, `whatsapp` ou os dois.
  t.string('channels', 32);
  t.timestamp('sent_at');
  t.timestamp('claimed_until');
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.unique(['tenant_id', 'due_at', 'step'], 'subscription_reminder_sends_step_uq');
};

const SUBSCRIPTION_REMINDER_TABLES = [
  ['subscription_reminder_sends', subscriptionReminderSendsTable]
];

/**
 * A indicação de provedores (0106) — ver `referralService.js`.
 *
 * `referral_code` é o código curto e legível do link de indicação de cada
 * provedor, gerado sob demanda (nulo até alguém abrir a tela de Plano) e único.
 * `referred_by_tenant_id` é quem indicou este provedor, gravado no cadastro.
 * Sem `.references`, pelo motivo de `pending_plan_id`: acrescentar chave
 * estrangeira a uma tabela que já existe é recriá-la no SQLite — e aqui a
 * tabela é `tenants`, a mãe de todas. Quem lê confere a linha.
 */
const TENANT_REFERRAL_COLUMNS = [
  ['referral_code', (t) => t.string('referral_code', 16).nullable()],
  ['referred_by_tenant_id', (t) => t.integer('referred_by_tenant_id').unsigned().nullable()]
];

/**
 * Quanto de crédito a cobrança tem RESERVADO (0106): o preço do plano menos
 * isto é o `amount_cents` que foi ao gateway. Nula (ou zero) é a cobrança sem
 * crédito. O detalhe — de quais créditos saiu — está em `credit_allocations`.
 */
const BILLING_CHARGE_CREDIT_COLUMNS = [
  ['credit_reserved_cents', (t) => t.integer('credit_reserved_cents').nullable()]
];

/**
 * A recompensa de uma indicação (0106). Uma linha por provedor INDICADO
 * (`referred_tenant_id` único): nasce `pending` no cadastro e vira `credited`
 * no primeiro pagamento que estende o período dele — por atualização
 * condicional, dentro da transação do pagamento, e é isso que a faz valer uma
 * vez só. `canceled` é o estorno daquele pagamento (ou o programa desligado
 * quando ele chegou). Da PLATAFORMA (compartilhada): fala de dois provedores
 * ao mesmo tempo, e cada lado a lê pelo seu id.
 */
const referralRewardsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('referrer_tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('referred_tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('amount_cents').notNullable().defaultTo(0);
  t.string('status', 16).notNullable().defaultTo('pending'); // pending | credited | canceled
  t.string('payment_external_id', 160).nullable();
  t.integer('credit_id').unsigned().nullable();
  t.timestamp('credited_at').nullable();
  t.timestamp('canceled_at').nullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.unique(['referred_tenant_id'], 'referral_rewards_referred_uq');
  t.index(['referrer_tenant_id'], 'referral_rewards_referrer_idx');
};

/**
 * O saldo de créditos de um provedor (0106): uma linha por crédito, e
 * `remaining_cents` é quanto dele ainda está livre (o reservado numa cobrança
 * em aberto já saiu daqui; volta se a reserva for solta). `source`:
 * `referral` (a recompensa de uma indicação) ou `manual` (o ajuste do console
 * — que pode ser negativo, e então nasce com `remaining_cents` zero e abate dos
 * outros). `canceled_at` é o crédito cancelado: o estorno do pagamento que o
 * gerou. Do PROVEDOR (escopada).
 */
const tenantCreditsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('amount_cents').notNullable();
  t.integer('remaining_cents').notNullable().defaultTo(0);
  t.string('source', 16).notNullable(); // referral | manual
  t.string('reference', 255).nullable();
  t.integer('created_by').unsigned().nullable();
  t.timestamp('canceled_at').nullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.index(['tenant_id', 'created_at'], 'tenant_credits_tenant_idx');
};

/**
 * Quanto de cada crédito foi para cada cobrança (0106): `reserved` na emissão,
 * `consumed` quando ela é paga, `released` quando ela é cancelada, reemitida
 * ou estornada (o valor volta ao crédito). As transições são atualizações
 * condicionais sobre `status`, e é isso que as faz idempotentes.
 */
const creditAllocationsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('credit_id').unsigned().notNullable()
    .references('id').inTable('tenant_credits').onDelete('CASCADE');
  t.integer('charge_id').unsigned().notNullable()
    .references('id').inTable('billing_charges').onDelete('CASCADE');
  t.integer('amount_cents').notNullable();
  t.string('status', 16).notNullable().defaultTo('reserved'); // reserved | consumed | released
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
  t.index(['tenant_id', 'charge_id'], 'credit_allocations_charge_idx');
  t.index(['tenant_id', 'credit_id'], 'credit_allocations_credit_idx');
};

const REFERRAL_TABLES = [
  ['referral_rewards', referralRewardsTable],
  ['tenant_credits', tenantCreditsTable],
  ['credit_allocations', creditAllocationsTable]
];

/**
 * A retenção no cancelamento (0107): cada vez que o dono de um provedor pede
 * para cancelar, uma linha — o motivo, o comentário, o que lhe foi oferecido
 * e o que ele decidiu. É a memória que segura o desconto de retenção a uma vez
 * por doze meses, e é o relatório de cancelamentos do console.
 *
 *   reason            o motivo da lista (`CANCELLATION_REASONS`);
 *   offers_presented  as ofertas que estavam disponíveis, separadas por
 *                     vírgula (`discount,pause`), para a taxa de aceite;
 *   offer             o que ele aceitou: `discount`, `pause`, ou `none`
 *                     (recusou e cancelou); nulo enquanto não decidiu;
 *   outcome           `retained_discount`, `retained_pause`, `canceled`
 *                     (cancelamento agendado ou feito) ou `reverted` (o
 *                     agendado foi desfeito); nulo enquanto não decidiu.
 *
 * Do provedor (escopada): diz o que ele nos contou, e some junto com ele.
 */
const cancellationRequestsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.string('reason', 32).notNullable();
  t.text('comment');
  t.string('offers_presented', 32);
  t.string('offer', 16);
  t.string('outcome', 24);
  // Os meses da pausa ou do desconto aceito, e a porcentagem do desconto.
  t.integer('months').unsigned();
  t.integer('discount_percent').unsigned();
  // O ciclo da fatura que o desconto aceito cobre (0104): no anual, o
  // desconto vira UMA fatura anual, e a carência conta doze meses dela.
  t.string('billing_cycle', 8);
  // A data do cancelamento agendado (o fim do período pago), quando foi o caso.
  t.timestamp('cancel_at').nullable();
  t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.timestamp('decided_at').nullable();
  t.timestamp('reverted_at').nullable();
  // Quem desfez: `provider` ou `console`.
  t.string('reverted_by', 16);
  t.index(['tenant_id', 'created_at'], 'cancellation_requests_tenant_idx');
};

const CANCELLATION_TABLES = [
  ['cancellation_requests', cancellationRequestsTable]
];

/**
 * Os alertas para quem opera a plataforma (0112): a fila do que avisar por
 * WhatsApp e e-mail — um pagamento que entrou, um cartão recusado, um pedido
 * de cancelamento. Ver `platformAlertService`.
 *
 *   event            o evento (`payment_received`, `card_refused`, ...);
 *   tenant_id        o provedor de quem se fala, quando há um. Inteiro simples
 *                    e SEM chave estrangeira, como em `platform_audit`: o
 *                    alerta de um provedor que depois foi apagado continua
 *                    sendo o que aconteceu;
 *   payload          JSON com o que a mensagem mostra — nunca segredo;
 *   dedupe_key       a idempotência: o mesmo fato (o mesmo pagamento, a
 *                    mesma recusa) entra uma vez só, pelo índice único;
 *   status           pending | sent | failed | skipped;
 *   attempts         quantas vezes o envio falhou;
 *   next_attempt_at  quando tentar de novo (nulo: já);
 *   last_error       o motivo curto da última falha, para o console.
 *
 * Da PLATAFORMA (compartilhada): está acima dos provedores, e só o console lê.
 */
const platformAlertsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('event', 32).notNullable();
  t.integer('tenant_id').unsigned().nullable();
  t.text('payload');
  t.string('dedupe_key', 191).notNullable();
  t.string('status', 16).notNullable().defaultTo('pending');
  t.integer('attempts').notNullable().defaultTo(0);
  t.timestamp('next_attempt_at').nullable();
  t.string('last_error', 255).nullable();
  t.timestamp('sent_at').nullable();
  t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  t.unique(['dedupe_key'], 'platform_alerts_dedupe_uq');
  t.index(['status', 'next_attempt_at'], 'platform_alerts_due_idx');
};

const PLATFORM_ALERT_TABLES = [
  ['platform_alerts', platformAlertsTable]
];

/** As colunas que a tabela ganhou depois de nascer (a base de desenvolvimento que já a tinha). */
const CANCELLATION_REQUEST_LATE_COLUMNS = [
  ['billing_cycle', (t) => t.string('billing_cycle', 8)]
];

/**
 * As colunas da 0107 na assinatura:
 *
 *   cancel_at         o cancelamento agendado pelo próprio provedor — o fim do
 *                     período pago. Até lá tudo funciona; nenhuma fatura nova
 *                     sai; na data o agendador cancela.
 *   paused_until      a pausa aceita como retenção: de `renews_at` até aqui,
 *                     sem fatura, sem lembrete, sem suspensão automática, e o
 *                     painel só lê. Na data a cobrança volta.
 *   pause_started_at  quando a pausa foi aceita.
 */
const SUBSCRIPTION_RETENTION_COLUMNS = [
  ['cancel_at', (t) => t.timestamp('cancel_at').nullable()],
  ['paused_until', (t) => t.timestamp('paused_until').nullable()],
  ['pause_started_at', (t) => t.timestamp('pause_started_at').nullable()]
];

/**
 * O cupom do sistema (0107): `retention` é o desconto de retenção, criado
 * pelo próprio painel. O provedor não o resgata digitando o código — só o
 * fluxo de cancelamento o aplica.
 */
const COUPON_SYSTEM_COLUMNS = [
  ['system_kind', (t) => t.string('system_kind', 16).nullable()]
];

/**
 * Every table the schema owns, in creation order — which is also the order the
 * foreign keys require, so it is safe to insert along and to delete against.
 *
 * Derived from the lists above rather than written out again: anything that
 * needs to know the full set (copying a panel to another database, asserting
 * coverage in a test) reads this, so adding a table cannot leave a second list
 * quietly behind.
 */
export const SCHEMA_TABLES = [
  ...TENANCY_TABLES,
  ...INITIAL_TABLES,
  ...MEMBERSHIP_TABLES,
  ...PROVISIONING_TABLES,
  ...WHATSAPP_TABLES,
  ...DEVICE_HISTORY_TABLES,
  ...DEVICE_SWAP_TABLES,
  ...BILLING_TABLES,
  ...OUTAGE_HISTORY_TABLES,
  ...SGP_CONTACT_TABLES,
  ...MFA_TABLES,
  ...OUTAGE_TABLES,
  ...WA_BOT_EVENT_TABLES,
  ...GENIEACS_CONNECTION_TABLES,
  ...LOCKOUT_TABLES,
  ...MAINTENANCE_TABLES,
  ...TEIAH_TABLES,
  ...LEAD_TABLES,
  ...DUNNING_TABLES,
  ...SATISFACTION_TABLES,
  ...WA_AGENT_TABLES,
  ...WA_TAG_TABLES,
  ...DUNNING_PAUSE_TABLES,
  ...CUSTOMER_REFERRAL_TABLES,
  ...BILLING_STATUS_TABLES,
  ...WA_META_TEMPLATE_TABLES,
  ...BILLING_INVOICE_TABLES,
  ...COUPON_TABLES,
  ...SUBSCRIPTION_REMINDER_TABLES,
  ...USAGE_PEAK_TABLES,
  ...REFERRAL_TABLES,
  ...CANCELLATION_TABLES,
  ...PLATFORM_ALERT_TABLES
].map(([name]) => name);

/**
 * The columns that identify a subscriber account. Each is unique across the
 * whole table today; each has to become unique per provider instead.
 *
 * `identity_hash` is the one that matters most: it is
 * sha256(softwareId, pppoe_username), so two providers running the same
 * firmware with a subscriber of the same name produce the same value. Left
 * globally unique, the second provider's device sync would find the first
 * provider's account and re-point it — which is the correct behaviour for an
 * ONT swap inside one provider, and account theft across two.
 */
const CUSTOMER_ACCOUNT_IDENTITY_COLUMNS = ['customer_id', 'device_id', 'identity_hash'];

/**
 * Se um índice com este nome existe na tabela, nos três dialetos.
 *
 * No Postgres a pergunta é feita a `to_regclass`, qualificada pelo schema
 * corrente, e não a `pg_indexes`. A view varre TODOS os schemas: num servidor
 * onde outros processos criam e derrubam os seus ao mesmo tempo — a suíte de
 * testes, um deploy paralelo — a varredura tropeça numa relação sendo apagada
 * e morre com "could not open relation with OID". E sem filtrar pelo schema
 * ela ainda responderia sim pelo índice do vizinho, deixando o nosso sem
 * criar. `to_regclass` resolve um nome só, no schema em que este processo
 * escreve, e devolve nulo em vez de erro quando não há nada com aquele nome.
 */
async function hasIndex(db, table, name) {
  const client = String(db.client.config.client);
  if (client === 'pg') {
    // `::text` porque `format()` recebe `VARIADIC "any"`, e um parâmetro sem
    // tipo declarado ali é "could not determine data type of parameter $1".
    const result = await db.raw(
      "select to_regclass(format('%I.%I', current_schema(), ?::text)) as oid", [name]
    );
    return (result.rows?.[0]?.oid ?? null) !== null;
  }
  if (client.startsWith('mysql')) {
    const rows = await db.raw('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
    return (Array.isArray(rows) ? rows[0] : rows).length > 0;
  }
  const rows = await db.raw(
    "select name from sqlite_master where type = 'index' and tbl_name = ? and name = ?", [table, name]
  );
  return rows.length > 0;
}

async function createTableIfMissing(db, name, builder) {
  if (await db.schema.hasTable(name)) return;
  await db.schema.createTable(name, builder);
}

async function missingColumns(db, table, columns) {
  const missing = [];
  for (const [column, add] of columns) {
    if (!(await db.schema.hasColumn(table, column))) missing.push(add);
  }
  return missing;
}

/**
 * The columns the health read filters and orders by, and the ones an install
 * older than that read has no index for.
 */
const WA_CONVERSATION_HEALTH_INDEXES = ['last_inbound_at', 'closed_at', 'unread_count'];

/** The ordered list. Ids are stable and are never renumbered or reused. */
export const migrations = [
  {
    id: '0001_initial_schema',
    async isApplied(db) {
      for (const [name] of INITIAL_TABLES) {
        if (!(await db.schema.hasTable(name))) return false;
      }
      return true;
    },
    async up(db) {
      for (const [name, table] of INITIAL_TABLES) {
        await createTableIfMissing(db, name, table(db));
      }
    }
  },
  {
    // Installations from before refresh-token invalidation existed.
    id: '0002_users_token_version',
    async isApplied(db) {
      return db.schema.hasColumn('users', 'token_version');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      if (await db.schema.hasColumn('users', 'token_version')) return;
      await db.schema.alterTable('users', addTokenVersion);
    }
  },
  {
    // Installations from before the customer portal had its own passwords.
    id: '0003_customer_portal_passwords',
    async isApplied(db) {
      if (!(await db.schema.hasTable('customer_accounts'))) return false;
      const missing = await missingColumns(db, 'customer_accounts', CUSTOMER_PASSWORD_COLUMNS);
      return missing.length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('customer_accounts'))) return;
      const missing = await missingColumns(db, 'customer_accounts', CUSTOMER_PASSWORD_COLUMNS);
      if (missing.length === 0) return;
      await db.schema.alterTable('customer_accounts', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    // Installations from before the SGP integration.
    id: '0004_sgp_links',
    async isApplied(db) {
      return db.schema.hasTable('sgp_links');
    },
    async up(db) {
      await createTableIfMissing(db, 'sgp_links', sgpLinksTable(db));
    }
  },
  {
    // Installations whose sgp_links predates the derived contract state.
    id: '0005_sgp_link_state',
    async isApplied(db) {
      if (!(await db.schema.hasTable('sgp_links'))) return false;
      return db.schema.hasColumn('sgp_links', 'state');
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_links'))) return;
      if (await db.schema.hasColumn('sgp_links', 'state')) return;
      await db.schema.alterTable('sgp_links', (t) => {
        t.string('state', 16).notNullable().defaultTo('unknown');
      });
    }
  },
  {
    // Automatic activation and SGP event handling.
    id: '0006_provisioning_and_sgp_events',
    async isApplied(db) {
      for (const [name] of PROVISIONING_TABLES) {
        if (!(await db.schema.hasTable(name))) return false;
      }
      return true;
    },
    async up(db) {
      for (const [name, table] of PROVISIONING_TABLES) {
        await createTableIfMissing(db, name, table(db));
      }
    }
  }
,
  {
    // The WhatsApp integration through the Evolution API.
    id: '0007_whatsapp_tables',
    async isApplied(db) {
      for (const [name] of WHATSAPP_TABLES) {
        if (!(await db.schema.hasTable(name))) return false;
      }
      return true;
    },
    async up(db) {
      for (const [name, table] of WHATSAPP_TABLES) {
        await createTableIfMissing(db, name, table(db));
      }
    }
  },
  {
    // Installations whose sgp_links predates WhatsApp needing a phone number.
    id: '0008_sgp_link_phone',
    async isApplied(db) {
      if (!(await db.schema.hasTable('sgp_links'))) return false;
      const missing = await missingColumns(db, 'sgp_links', SGP_PHONE_COLUMNS);
      return missing.length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_links'))) return;
      const missing = await missingColumns(db, 'sgp_links', SGP_PHONE_COLUMNS);
      if (missing.length === 0) return;
      await db.schema.alterTable('sgp_links', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    // Lets JWT_SECRET be rotated without destroying the secrets it encrypted.
    id: '0009_secret_key_version',
    async isApplied(db) {
      for (const [table, names] of SECRET_KEY_VERSION_COLUMNS) {
        if (!(await db.schema.hasTable(table))) return false;
        const missing = await missingColumns(db, table, keyVersionColumns(names));
        if (missing.length > 0) return false;
      }
      return true;
    },
    async up(db) {
      for (const [table, names] of SECRET_KEY_VERSION_COLUMNS) {
        if (!(await db.schema.hasTable(table))) continue;
        const missing = await missingColumns(db, table, keyVersionColumns(names));
        if (missing.length === 0) continue;
        await db.schema.alterTable(table, (t) => {
          for (const add of missing) add(t);
        });
      }
    }
  },
  {
    // The first table to become per-provider, and the one that cannot wait:
    // its identity columns are unique across the whole table, so a second
    // provider's device sync would collide with — and re-point — the first
    // provider's accounts.
    id: '0010_customer_accounts_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      return db.schema.hasColumn('customer_accounts', 'tenant_id');
    },
    async up(db) {
      for (const [name, table] of TENANCY_TABLES) {
        await createTableIfMissing(db, name, table(db));
      }

      // The install itself becomes provider #1, under the name already on
      // screen, so nothing looks different to an operator.
      let tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) {
        const appName = await db('settings').where({ key: 'appName' }).first();
        await db('tenants').insert({
          slug: 'default',
          name: appName?.value || PRODUCT_NAME,
          status: 'active'
        });
        tenant = await db('tenants').orderBy('id', 'asc').first();
      }

      if (await db.schema.hasColumn('customer_accounts', 'tenant_id')) return;

      // Nullable first: the table already has rows, and the schema alone has
      // no sensible default to give them.
      await db.schema.alterTable('customer_accounts', (t) => {
        t.integer('tenant_id').unsigned();
      });
      await db('customer_accounts').whereNull('tenant_id').update({ tenant_id: tenant.id });

      // One rebuild on SQLite rather than several: tighten the column, point it
      // at tenants, and move every identity unique to be per-provider.
      //
      // The default is this install's own provider, baked in from the row just
      // created rather than hardcoded. Until requests carry a tenant, every
      // write belongs to it, so existing code keeps inserting correct rows
      // without knowing tenancy exists. The scoping work that follows sets the
      // column explicitly on every insert and can then drop the default.
      await db.schema.alterTable('customer_accounts', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        for (const column of CUSTOMER_ACCOUNT_IDENTITY_COLUMNS) {
          t.dropUnique([column]);
          t.unique(['tenant_id', column]);
        }
      });
    }
  },
  {
    // The tables whose models delete or update without a where clause: the map
    // is replaced wholesale on every import, and setting a default WhatsApp
    // number clears every other row first. Those are correct for one provider
    // and destructive for a second, so they are scoped before anything that
    // only reads.
    id: '0011_mapping_and_whatsapp_tenant',
    async isApplied(db) {
      for (const table of ['mapping_nodes', 'mapping_edges', 'whatsapp_accounts']) {
        if (!(await db.schema.hasTable(table))) return false;
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      // Before anything else. Rebuilding `mapping_nodes` to move its unique
      // would otherwise leave these references pointing at a key that no longer
      // exists, and SQLite's foreign_key_check fails the rebuild on the spot.
      if (await db.schema.hasColumn('mapping_edges', 'source')) {
        await db.schema.alterTable('mapping_edges', (t) => {
          t.dropForeign(['source']);
          t.dropForeign(['target']);
        });
      }

      for (const table of ['mapping_nodes', 'mapping_edges', 'whatsapp_accounts']) {
        if (await db.schema.hasColumn(table, 'tenant_id')) continue;
        await db.schema.alterTable(table, (t) => t.integer('tenant_id').unsigned());
        await db(table).whereNull('tenant_id').update({ tenant_id: tenant.id });
      }

      await db.schema.alterTable('mapping_nodes', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        t.dropUnique(['node_id']);
        t.unique(['tenant_id', 'node_id']);
      });

      await db.schema.alterTable('mapping_edges', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.dropUnique(['edge_id']);
        t.unique(['tenant_id', 'edge_id']);
        // Composite rather than an integer key, because the API and the map
        // editor address nodes by their string id. It also buys a guarantee the
        // old shape could not give: an edge can only reach a node of its own
        // provider.
        t.foreign(['tenant_id', 'source'])
          .references(['tenant_id', 'node_id']).inTable('mapping_nodes').onDelete('CASCADE');
        t.foreign(['tenant_id', 'target'])
          .references(['tenant_id', 'node_id']).inTable('mapping_nodes').onDelete('CASCADE');
      });

      await db.schema.alterTable('whatsapp_accounts', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        // `name` deliberately keeps its global unique. The Evolution webhook
        // arrives with no session and finds the account — and therefore the
        // provider — by that name, so it has to identify a row on its own. It
        // is minted locally and already unique by construction.
      });
    }
  },
  {
    // The WhatsApp inbox and its send queue. Scoping these is what releases the
    // outbox worker from `forSoleTenant`: once `WaMessage.listSendable()`
    // carries a provider, a pass per provider divides the queue instead of
    // sending every message once per provider.
    id: '0012_wa_queue_tenant',
    async isApplied(db) {
      for (const table of ['wa_conversations', 'wa_messages', 'wa_opt_outs']) {
        if (!(await db.schema.hasTable(table))) return false;
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      for (const table of ['wa_conversations', 'wa_messages', 'wa_opt_outs']) {
        if (await db.schema.hasColumn(table, 'tenant_id')) continue;
        await db.schema.alterTable(table, (t) => t.integer('tenant_id').unsigned());
        await db(table).whereNull('tenant_id').update({ tenant_id: tenant.id });
      }

      for (const table of ['wa_conversations', 'wa_opt_outs']) {
        await db.schema.alterTable(table, (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.foreign('tenant_id').references('id').inTable('tenants');
        });
      }

      await db.schema.alterTable('wa_messages', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        // The id is minted by the Evolution server, so it is unique only within
        // one of them. Two providers run their own, and a collision on a global
        // unique would not raise an error a human sees — the inbound dedupe
        // would treat the second provider's message as one already stored and
        // drop it. Repeated NULLs still do not collide: an outbound message has
        // no id until the server accepts it.
        t.dropUnique(['external_id']);
        t.unique(['tenant_id', 'external_id']);
      });

      // `wa_conversations.unique(account_id, external_thread_id)` is left as it
      // is, deliberately. `account_id` points at `whatsapp_accounts`, which is
      // already per-provider, so that unique cannot span two providers. Adding
      // `tenant_id` to it would be churn dressed as a rule.
      //
      // The foreign keys stay integer for the same kind of reason. Unlike
      // `mapping_edges`, whose `source` was a string that stopped being unique
      // once the plant became per-provider, these point at `id` columns that
      // remain globally unique. A cross-provider link would take a bug in a
      // scoped model, not a missing constraint.
    }
  },
  {
    // Campaigns, their templates, and the alert cooldown. Scoping these
    // releases the campaign flush from `forSoleTenant`, and fixes a cooldown
    // that was shared across the whole deployment.
    id: '0013_wa_campaigns_tenant',
    async isApplied(db) {
      for (const table of TENANT_CAMPAIGN_TABLES) {
        if (!(await db.schema.hasTable(table))) return false;
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      for (const table of TENANT_CAMPAIGN_TABLES) {
        if (await db.schema.hasColumn(table, 'tenant_id')) continue;
        await db.schema.alterTable(table, (t) => t.integer('tenant_id').unsigned());
        await db(table).whereNull('tenant_id').update({ tenant_id: tenant.id });
      }

      for (const table of ['wa_broadcasts', 'wa_broadcast_recipients']) {
        await db.schema.alterTable(table, (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.foreign('tenant_id').references('id').inTable('tenants');
        });
      }

      await db.schema.alterTable('wa_templates', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        // A template is the provider's own wording — its dunning message, in
        // its voice. Two providers naming one "segunda-via" is expected, not a
        // conflict.
        t.dropUnique(['name']);
        t.unique(['tenant_id', 'name']);
      });

      await db.schema.alterTable('wa_alert_state', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        // `subject` is a device or node id read from GenieACS, and the row
        // carries the cooldown. Shared, one provider's ONT going down silenced
        // the same rule for every other provider — and `clear` on one closed
        // everyone's alert. The cooldown is per provider because the ONT is.
        t.dropUnique(['rule', 'subject']);
        t.unique(['tenant_id', 'rule', 'subject']);
      });
    }
  },
  {
    // Tells the three automatic senders apart. All of them write `sent_by:
    // NULL`, so a billing campaign's message and the bot's own reply looked
    // identical — and the bot's three-an-hour ceiling counted the campaign
    // against itself, going silent on a subscriber it had never answered.
    id: '0014_wa_message_source',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return false;
      const missing = await missingColumns(db, 'wa_messages', WA_MESSAGE_SOURCE_COLUMNS);
      return missing.length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return;
      const missing = await missingColumns(db, 'wa_messages', WA_MESSAGE_SOURCE_COLUMNS);
      if (missing.length === 0) return;
      await db.schema.alterTable('wa_messages', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    // The configuration pair. `settings` holds what an operator sets on screen —
    // the GenieACS URL, the Customer ID scheme, the VirtualParameter names —
    // and `app_state` holds the integration blobs: Evolution, SGP, alerts,
    // provisioning, and the dashboard snapshot. All of it is one set for the
    // whole deployment until this runs.
    //
    // Both tables come from `keyValueTable`, where `key` is the PRIMARY KEY
    // rather than a unique. This is the only step in the phase that moves a
    // primary key.
    id: '0015_settings_and_app_state_tenant',
    async isApplied(db) {
      for (const table of KEY_VALUE_TABLES) {
        if (!(await db.schema.hasTable(table))) return false;
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      for (const table of KEY_VALUE_TABLES) {
        if (await db.schema.hasColumn(table, 'tenant_id')) continue;
        await db.schema.alterTable(table, (t) => t.integer('tenant_id').unsigned());
        await db(table).whereNull('tenant_id').update({ tenant_id: tenant.id });
      }

      for (const table of KEY_VALUE_TABLES) {
        await db.schema.alterTable(table, (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.dropPrimary();
          t.primary(['tenant_id', 'key']);
          t.foreign('tenant_id').references('id').inTable('tenants');
          // Do NOT add `t.string('key', 128).notNullable().alter()` here. It
          // reads as tidying and it breaks PostgreSQL: knex's alter path emits
          // `drop not null` unconditionally before the retype, and Postgres
          // refuses that on a column still in a primary key. knex also fixes
          // the order — every column alteration is emitted before every table
          // statement — so moving `dropPrimary()` above it does not help; it
          // would need its own earlier `alterTable` call. And it buys nothing:
          // `key` is already NOT NULL on Postgres and MySQL by virtue of
          // having been the primary key.
        });
      }

      // After this step `settings.key` and `app_state.key` are no longer unique
      // on their own, so no table may ever declare a foreign key against them.
      // That is what failed the rebuild in 0011: knex appends a bare
      // `PRAGMA foreign_key_check` with no table argument, so it checks the
      // whole database and a dangling reference anywhere fails the migration.
      // Nothing references either key today.
    }
  },
  {
    // The indexes the health read wants. It changes no column and moves no
    // data, which is why it sits apart from the tenancy steps around it: an
    // index is the one schema change that can be added to a live table without
    // anyone noticing.
    //
    // No `isApplied`. That hook exists to baseline an install older than this
    // runner, and answering "yes, present" there would be a guess — the three
    // engines keep index metadata in three different places and knex has no
    // portable way to ask. `up` is idempotent instead: each index is attempted
    // on its own and a duplicate is swallowed, so this costs a no-op on the
    // installs that already have them.
    id: '0016_wa_conversation_health_indexes',
    async up(db) {
      if (!(await db.schema.hasTable('wa_conversations'))) return;
      for (const column of WA_CONVERSATION_HEALTH_INDEXES) {
        // eslint-disable-next-line no-await-in-loop -- DDL, and three of them
        await db.schema.alterTable('wa_conversations', (t) => t.index([column])).catch(() => {});
      }
    }
  },
  {
    // Per-device telemetry over time.
    //
    // Tenant-ready at the end state the earlier steps are working towards
    // rather than the transitional one they had to use. Those tables already
    // had rows and unconverted writers, so their `tenant_id` carries a default
    // to keep those writers correct. These two have neither: every write goes
    // through `tinsert`/`tbatchInsert` from the first commit, so the column is
    // NOT NULL with no default. A default here would be a mechanism for filing
    // one provider's samples under another, quietly.
    id: '0017_device_history',
    async isApplied(db) {
      for (const [name] of DEVICE_HISTORY_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- two schema probes
        if (!(await db.schema.hasTable(name))) return false;
      }
      return true;
    },
    async up(db) {
      for (const [name, table] of DEVICE_HISTORY_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- DDL, and two of them
        await createTableIfMissing(db, name, table(db));
      }
    }
  },
  {
    // A record of one ONT replacing another for the same subscriber.
    //
    // Its own table rather than an `sgp_events` row, and the deciding reason is
    // that a CPE swap happens on installs with no SGP configured at all.
    // `sgp_events` is also an ingest queue whose rows exist to be acted on and
    // are pruned on an SGP retention setting, and a swap is a fact that already
    // happened.
    id: '0018_device_swaps',
    async isApplied(db) {
      return db.schema.hasTable('device_swaps');
    },
    async up(db) {
      await createTableIfMissing(db, 'device_swaps', deviceSwapsTable(db));
    }
  },
  {
    /**
     * The contract cadastre, per provider.
     *
     * `sgp_links` is what turns a device id into a subscriber: contract,
     * document, name, plan, and the phone number the WhatsApp side resolves an
     * inbound message against. Left deployment-wide it is the last place where
     * one provider's operator can type a phone number and be handed another
     * provider's subscriber — and, through the self-service bot, be read that
     * subscriber's invoice without anyone having logged in anywhere.
     *
     * `device_id` was unique across the deployment, which was right while there
     * was one GenieACS behind one panel. It becomes unique per provider here,
     * for the same reason `customer_accounts` did in 0010: two providers
     * reading one ACS see the same ids, and a deployment-wide unique would let
     * whichever synced first own the row for good.
     *
     * The column is added here rather than in `sgpLinksTable` on purpose. That
     * factory runs in step 0001, before `tenants` exists, so a foreign key
     * written into it would fail every fresh install. `customer_accounts`
     * carries its `tenant_id` the same way and for the same reason.
     */
    id: '0019_sgp_links_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      if (!(await db.schema.hasTable('sgp_links'))) return false;
      return db.schema.hasColumn('sgp_links', 'tenant_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_links'))) return;
      if (await db.schema.hasColumn('sgp_links', 'tenant_id')) return;

      // 0010 created the provider row; this only reads it. If it is somehow
      // missing there is nothing to backfill to, and the step stops rather than
      // inventing a second provider nobody asked for.
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      // Nullable first: the table already has rows and the schema alone has no
      // sensible default to give them.
      await db.schema.alterTable('sgp_links', (t) => {
        t.integer('tenant_id').unsigned();
      });
      await db('sgp_links').whereNull('tenant_id').update({ tenant_id: tenant.id });

      // One rebuild on SQLite rather than several: tighten the column, point it
      // at `tenants`, and move the device unique to be per-provider. The
      // default is this install's own provider, so every insert written before
      // the scoping work lands still produces a correct row.
      await db.schema.alterTable('sgp_links', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        t.dropUnique(['device_id']);
        t.unique(['tenant_id', 'device_id']);
      });
    }
  },
  {
    /**
     * What the outbox needs to survive an Evolution server that blinks, and
     * what the two sweeps and the thread reader need to stay fast on the
     * installation they were written for.
     *
     * `next_attempt_at` is the important one. Without it a failed send goes
     * straight back to `queued` and the worker, which wakes every five seconds,
     * picks it up again immediately: three attempts burn in fifteen seconds and
     * the row is `failed` for good. An Evolution restart that takes twenty
     * seconds therefore fails every message in the queue permanently — during a
     * dunning campaign, thousands of them. `provisioning_runs` already carries
     * this column and its due index; this is the same pattern, in the place
     * that needed it more.
     *
     * The three indexes are queries that already exist and have no index that
     * fits them:
     *
     * - `(conversation_id, id)` — the thread reader pages by `id` (keyset,
     *   since the attachments wave) while the only index orders by
     *   `created_at`, so opening a busy thread filters by index and then sorts.
     * - `(tenant_id, created_at)` — the history sweep reads a provider's oldest
     *   rows. The existing `(delivery_status, created_at)` cannot serve it: the
     *   sweep's test on that column is `IS NULL OR NOT IN (...)`, which no
     *   engine seeks on.
     * - `(delivery_status, next_attempt_at)` — the outbox's own query, once it
     *   has a due time to respect.
     *
     * Indexes are attempted one at a time and a duplicate is swallowed, like
     * 0016: there is no portable way to ask whether an index exists, and
     * guessing would be dishonest.
     */
    id: '0020_wa_outbox_backoff_and_indexes',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return false;
      return db.schema.hasColumn('wa_messages', 'next_attempt_at');
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return;

      if (!(await db.schema.hasColumn('wa_messages', 'next_attempt_at'))) {
        await db.schema.alterTable('wa_messages', (t) => {
          // Nullable, and NULL means "due now". Rows written before this
          // column existed are due, which is the only reading that does not
          // strand a queue on upgrade.
          t.timestamp('next_attempt_at');
        });
      }

      for (const columns of WA_MESSAGE_OUTBOX_INDEXES) {
        // eslint-disable-next-line no-await-in-loop -- DDL, and three of them
        await db.schema.alterTable('wa_messages', (t) => t.index(columns)).catch(() => {});
      }
    }
  },
  {
    /**
     * The campaign queue, given the same patience the outbox got in 0020.
     *
     * `waBroadcastService.deliver` has the same shape of bug 0020 fixed one
     * table over: `MAX_ATTEMPTS` is 3, a failed recipient goes straight back to
     * 'pending', and the flush loop wakes every 60 s — so three attempts burn
     * in about two minutes and the row is 'failed' for good.
     *
     * The failure it actually meets is NOT an Evolution server that is down.
     * `deliver` only ENQUEUES: it writes a row to `wa_messages` and the outbox
     * owns the transport, so a server restart is 0018's problem and is already
     * survived. What reaches this catch is `no_account` — no number connected —
     * a `no_public_url`, or a database that hiccupped. Those are configuration
     * and infrastructure, which is precisely the kind of thing an operator
     * fixes in the ten minutes after starting a campaign and noticing.
     *
     * Two minutes is not enough time for that, and the cost of running out is
     * the whole campaign: every recipient in flight ends `failed`, and the
     * operator's only recovery is the bulk requeue on the messages that were
     * never created.
     *
     * Nullable, and NULL means due now, exactly as in 0020: every row written
     * before this column existed is due, which is the only reading that does
     * not strand a campaign that was already in flight during the upgrade.
     *
     * The index fronts `broadcast_id` because that is how `listPendingIds`
     * asks — one campaign at a time, never the table.
     */
    id: '0021_wa_broadcast_recipient_backoff',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_broadcast_recipients'))) return false;
      return db.schema.hasColumn('wa_broadcast_recipients', 'next_attempt_at');
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_broadcast_recipients'))) return;

      if (!(await db.schema.hasColumn('wa_broadcast_recipients', 'next_attempt_at'))) {
        await db.schema.alterTable('wa_broadcast_recipients', (t) => {
          t.timestamp('next_attempt_at');
        });
      }

      await db.schema
        .alterTable('wa_broadcast_recipients', (t) => t.index(['broadcast_id', 'status', 'next_attempt_at']))
        .catch(() => {});
    }
  },
  {
    /**
     * The installation dates, per provider — and the one table standing between
     * the Customer ID sweep and a per-provider loop.
     *
     * `server.js` runs that sweep under `forSoleTenant`, and its comment names
     * two blockers. One of them, `sgp_links`, stopped being true in 0019. This
     * is the other: `CustomerService.ensureAccount` reads
     * `DeviceProfile.getByDeviceId` when the Customer ID is derived from an
     * installation date, and that read was deployment-wide — so with two
     * providers it could mint provider B's identifier out of provider A's date.
     *
     * `device_id` UNIQUE is the same failure `sgp_links` had before 0019: two
     * providers reading their own GenieACS see the same ids, and the write path
     * decides insert-vs-update from that read, so the second provider would
     * never get a row of its own — it would keep overwriting the first's.
     */
    id: '0022_device_profiles_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      if (!(await db.schema.hasTable('device_profiles'))) return false;
      return db.schema.hasColumn('device_profiles', 'tenant_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('device_profiles'))) return;
      if (await db.schema.hasColumn('device_profiles', 'tenant_id')) return;
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      await db.schema.alterTable('device_profiles', (t) => t.integer('tenant_id').unsigned());
      await db('device_profiles').whereNull('tenant_id').update({ tenant_id: tenant.id });
      await db.schema.alterTable('device_profiles', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        t.dropUnique(['device_id']);
        t.unique(['tenant_id', 'device_id']);
      });
    }
  },
  {
    /**
     * Provisioning, per provider — the profiles and the runs together.
     *
     * They move in one step because `provisioning_runs.profile_id` points at
     * `provisioning_profiles.id`: converting one alone would leave a foreign
     * key that can reach across providers, which is the shape of leak the
     * `mapping_edges` work in 0011 went out of its way to avoid.
     *
     * The profiles hold two AES-GCM secrets (the WiFi and CPE passwords an
     * activation writes), and their `name` is UNIQUE deployment-wide — two ISPs
     * both calling a profile "Padrão" is the expected case, not the exotic one.
     *
     * The runs are the sharper half. `ProvisioningRun.reapInterrupted` and
     * `pruneOlderThan` carry NO identity column in their WHERE at all: the
     * first fails every 'running' row older than a cutoff, the second deletes
     * every settled row older than one. Run per provider as they are, each pass
     * would do that to every other provider's history — which is why
     * `schedulerService` still refuses to loop.
     *
     * Both indexes are re-fronted with `tenant_id`: a scoped query always
     * carries it, so an index that does not lead with it is an index the
     * planner has to look past.
     */
    id: '0023_provisioning_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      for (const table of ['provisioning_profiles', 'provisioning_runs']) {
        // eslint-disable-next-line no-await-in-loop -- two schema probes
        if (!(await db.schema.hasTable(table))) return false;
        // eslint-disable-next-line no-await-in-loop -- two schema probes
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      if (await db.schema.hasTable('provisioning_profiles')
        && !(await db.schema.hasColumn('provisioning_profiles', 'tenant_id'))) {
        await db.schema.alterTable('provisioning_profiles', (t) => t.integer('tenant_id').unsigned());
        await db('provisioning_profiles').whereNull('tenant_id').update({ tenant_id: tenant.id });
        await db.schema.alterTable('provisioning_profiles', (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.foreign('tenant_id').references('id').inTable('tenants');
          t.dropUnique(['name']);
          t.unique(['tenant_id', 'name']);
        });
      }

      if (await db.schema.hasTable('provisioning_runs')
        && !(await db.schema.hasColumn('provisioning_runs', 'tenant_id'))) {
        await db.schema.alterTable('provisioning_runs', (t) => t.integer('tenant_id').unsigned());
        await db('provisioning_runs').whereNull('tenant_id').update({ tenant_id: tenant.id });
        await db.schema.alterTable('provisioning_runs', (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.foreign('tenant_id').references('id').inTable('tenants');
        });
        for (const [columns, name] of PROVISIONING_RUN_TENANT_INDEXES) {
          // eslint-disable-next-line no-await-in-loop -- DDL, and two of them
          await db.schema.alterTable('provisioning_runs', (t) => t.index(columns, name)).catch(() => {});
        }
      }
    }
  },
  {
    /**
     * The ERP event log, per provider — and the silent-drop it was hiding.
     *
     * `sgp_events` is the PII-heaviest table the panel has: contract, document
     * (CPF/CNPJ), login, device id and a redacted payload, one row per webhook
     * or reconciliation event from one ISP's SGP.
     *
     * `dedupe_key` UNIQUE deployment-wide is worse than a collision error.
     * `sgpEventService` builds it as `webhook:sha256(eventId)`, and SGP event
     * ids are per-ERP sequential numbers — so provider B's event #12345 hashes
     * to exactly what provider A's did. `SgpEvent.insertIfNew` reads that as a
     * redelivery and answers 200 duplicate: the second provider's event
     * disappears, with no error anywhere and nothing to notice.
     *
     * `pruneOlderThan` is the destructive one, with no identity column in its
     * WHERE — it deletes every provider's settled history.
     *
     * NOTE, and it is not fixed by this column: the webhook that feeds this
     * table is unauthenticated and mounted under the resolver, which always
     * answers with the FIRST provider, so the HMAC can only ever be checked
     * against provider #1's secret. Scoping the table without giving the
     * request a way to name its provider moves the failure rather than ending
     * it. That is the code half of this slice, not the schema half.
     */
    id: '0024_sgp_events_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      if (!(await db.schema.hasTable('sgp_events'))) return false;
      return db.schema.hasColumn('sgp_events', 'tenant_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_events'))) return;
      if (await db.schema.hasColumn('sgp_events', 'tenant_id')) return;
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      await db.schema.alterTable('sgp_events', (t) => t.integer('tenant_id').unsigned());
      await db('sgp_events').whereNull('tenant_id').update({ tenant_id: tenant.id });
      await db.schema.alterTable('sgp_events', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        t.dropUnique(['dedupe_key']);
        t.unique(['tenant_id', 'dedupe_key']);
      });
    }
  },
  {
    /**
     * The map, per provider. The only one of these that needs a PRIMARY KEY.
     *
     * `map_settings` is a singleton keyed `id: 1`, so `where({ id: 1 })` was
     * never an identity filter — it means "the only row". Provider B saving its
     * map centre overwrote provider A's, and `reset()` put the deployment's one
     * row back to defaults for everybody. There is nothing per-provider about
     * a latitude: it is literally where one ISP's city is.
     *
     * This is the `0015` shape, not the `0019` one: the key becomes
     * `(tenant_id, id)` so each provider keeps its own row 1, and `tdb` adds
     * the provider to the WHERE that the model already writes.
     *
     * Deliberately NOT retyping or re-declaring `id` while changing the key —
     * knex emits `drop not null` before a retype and Postgres refuses that on a
     * column still in a primary key. 0015 documents the same trap.
     */
    id: '0025_map_settings_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      if (!(await db.schema.hasTable('map_settings'))) return false;
      return db.schema.hasColumn('map_settings', 'tenant_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('map_settings'))) return;
      if (await db.schema.hasColumn('map_settings', 'tenant_id')) return;
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      await db.schema.alterTable('map_settings', (t) => t.integer('tenant_id').unsigned());
      await db('map_settings').whereNull('tenant_id').update({ tenant_id: tenant.id });
      await db.schema.alterTable('map_settings', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.dropPrimary();
        t.primary(['tenant_id', 'id']);
        t.foreign('tenant_id').references('id').inTable('tenants');
      });
    }
  },
  {
    /**
     * The equipment catalogue, per provider — the three tables together.
     *
     * The honest counter-argument first, because it is a good one: the CONTENT
     * really is the same for every ISP on earth. A ZTE's `wifi_password_path`
     * is a fact about firmware, not about anybody's subscribers. What makes
     * these per-provider is not the data, it is that the rows are OPERATOR-
     * EDITABLE: every path, priority and enabled flag is changed through
     * `/api/vendor-management`, so left shared, one ISP correcting a detection
     * pattern silently changes another ISP's WiFi writes. `Vendor.delete` also
     * cascades into `wifi_security_mappings`, so it is destructive across
     * providers as well as surprising.
     *
     * The project already made this call: the plan chooses a per-tenant
     * catalogue COPY over a `tenant_id NULL = global` row, precisely to keep
     * the invariant `tdb` depends on — every row of every scoped table carries
     * a provider, with no nulls to special-case.
     *
     * The three move together because `wifi_security_mappings.vendor_id` points
     * at `vendors.id`: converting one alone leaves a foreign key that can reach
     * across providers.
     *
     * (Passaram a ser DUAS: a 0052 derrubou `wifi_security_mappings`, que nunca
     * teve leitor. O parágrafo acima fica porque descreve o que este passo fez
     * no dia em que rodou — e porque a chave estrangeira que ele cita é a razão
     * de a cópia de catálogo ter precisado remapear `vendor_id` até então.)
     *
     * NO new unique is added here. The plan wants `(tenant_id, name)` on
     * vendors and `(tenant_id, product_class)` on the config, and both would be
     * NEW constraints rather than conversions of existing ones — a migration
     * that can fail on data an install already has is a migration that strands
     * an upgrade halfway. They belong in their own step, after a pass that
     * reports duplicates.
     *
     * CONSEQUENCE, and it is not a schema one: nothing seeds `vendors`. A
     * provider created after this step starts with an empty catalogue, and an
     * empty catalogue does not fail loudly — device detection simply matches
     * nothing. The code half of this slice has to give a new provider a copy.
     */
    id: '0026_vendor_catalogue_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      for (const table of VENDOR_CATALOGUE_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- duas sondas de schema
        if (!(await db.schema.hasTable(table))) return false;
        // eslint-disable-next-line no-await-in-loop -- duas sondas de schema
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      for (const table of VENDOR_CATALOGUE_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- DDL, duas tabelas
        if (!(await db.schema.hasTable(table))) continue;
        // eslint-disable-next-line no-await-in-loop -- DDL, duas tabelas
        if (await db.schema.hasColumn(table, 'tenant_id')) continue;
        // eslint-disable-next-line no-await-in-loop -- DDL, duas tabelas
        await db.schema.alterTable(table, (t) => t.integer('tenant_id').unsigned());
        // eslint-disable-next-line no-await-in-loop -- DDL, duas tabelas
        await db(table).whereNull('tenant_id').update({ tenant_id: tenant.id });
        // eslint-disable-next-line no-await-in-loop -- DDL, duas tabelas
        await db.schema.alterTable(table, (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.foreign('tenant_id').references('id').inTable('tenants');
        });
      }
    }
  },
  {
    /**
     * The subscriber's WiFi credentials, per provider.
     *
     * There is no live leak here today, and it is worth saying why rather than
     * implying one: every method filters on `account_id`, a surrogate key into
     * `customer_accounts`, which has been scoped since 0010 — so the parent
     * already refuses to hand one provider another's account, and the portal
     * session carries the account it belongs to.
     *
     * The column is added anyway, for two reasons. The filter becomes direct
     * instead of inherited, which is what lets `tdb` cover the table like every
     * other; and the row holds an AES-GCM-encrypted WiFi password, which is the
     * kind of thing that should not depend on a join staying correct.
     *
     * The unique moves to `(tenant_id, account_id, wifi_index)`. Strictly it
     * need not — `account_id` is globally unique — but the `onConflict` in
     * `CustomerWifiCredential.upsert` names this exact tuple, and a conflict
     * target that does not match the index is the failure `sgp_links` hit in
     * 0019: silent on MySQL, refused on SQLite and Postgres.
     */
    id: '0027_customer_wifi_credentials_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      if (!(await db.schema.hasTable('customer_wifi_credentials'))) return false;
      return db.schema.hasColumn('customer_wifi_credentials', 'tenant_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('customer_wifi_credentials'))) return;
      if (await db.schema.hasColumn('customer_wifi_credentials', 'tenant_id')) return;
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      await db.schema.alterTable('customer_wifi_credentials', (t) => t.integer('tenant_id').unsigned());
      await db('customer_wifi_credentials').whereNull('tenant_id').update({ tenant_id: tenant.id });

      // Before the unique moves, and in a statement of its own so it is in
      // place when it does. `account_id` stops being the leading column of any
      // index once the unique becomes `(tenant_id, …)`, and that column carries
      // the cascade from `customer_accounts`: on MySQL InnoDB simply refuses to
      // drop the index its foreign key is resting on, and on Postgres it would
      // have accepted the drop and turned every cascading delete into a scan.
      await db.schema.alterTable('customer_wifi_credentials', (t) => {
        t.index(['account_id'], 'customer_wifi_credentials_account_idx');
      });

      await db.schema.alterTable('customer_wifi_credentials', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        t.dropUnique(['account_id', 'wifi_index']);
        t.unique(['tenant_id', 'account_id', 'wifi_index']);
      });
    }
  },
  {
    /**
     * Who works for which provider — the last piece of the conversion, and the
     * one that deliberately does NOT follow the pattern of the ten before it.
     *
     * Every other table got a `tenant_id`. `users` must not. A row here is a
     * PERSON, and the plan is explicit about why that matters: a consultant or
     * a reseller serving several ISPs with one login is the common arrangement
     * in this market, and a `users.tenant_id` forecloses it permanently. So
     * `users` stays the identity table, globally unique on `username`, and
     * `tenant_users` is the bridge that says which providers a person works
     * for and with what role there.
     *
     * The role moves onto the membership rather than staying on the person: an
     * operator can be an admin at the ISP they own and an ordinary operator at
     * one they consult for. `users.role` is left in place and keeps its value,
     * because it is what the backfill reads and what an install running the
     * previous code still answers logins with — it stops being consulted once
     * the token carries a membership role.
     *
     * Note what is NOT here: the plan also wants `users` keyed by email rather
     * than username. That is a change to how every operator signs in, it buys
     * no isolation, and doing it in the same step as the authentication spine
     * would be two risky changes at once. It keeps its own step, later.
     */
    id: '0028_tenant_users',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      return db.schema.hasTable('tenant_users');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      await createTableIfMissing(db, 'tenant_users', tenantUsersTable(db));

      // Everybody who can already sign in keeps working, at the provider this
      // install has always been. Their current `users.role` becomes their role
      // there, so nobody is promoted or demoted by an upgrade.
      const existing = await db('users').select('id', 'role');
      const members = await db('tenant_users').where({ tenant_id: tenant.id }).pluck('user_id');
      const already = new Set(members.map(Number));
      const rows = existing
        .filter((user) => !already.has(Number(user.id)))
        .map((user) => ({
          tenant_id: tenant.id,
          user_id: user.id,
          role: user.role || 'user'
        }));
      if (rows.length > 0) await db('tenant_users').insert(rows);
    }
  },
  {
    /**
     * The control plane: who may create and suspend providers.
     *
     * Twelve steps of per-provider isolation went in before this, and none of
     * them could be used — nothing in the panel creates a second provider. The
     * gap was not an oversight about screens, it was a missing authority: a
     * provider's own administrator must NOT be able to mint providers or reach
     * into another one's, so "who may" needed a plane above them before "how"
     * could exist at all.
     *
     * The table is created EMPTY, and the migration grants nobody. A migration
     * that handed the platform to the lowest-numbered administrator would be an
     * upgrade quietly promoting somebody — and on the self-hosted edition,
     * where there is one provider and no platform plane, promoting them to a
     * role that should not exist there. Bootstrapping is explicit instead:
     * `setup` grants it on a fresh SaaS install, and `scripts/grant-platform-admin.js`
     * grants it on an install that already had users, run by whoever holds the
     * server — which is exactly who should be deciding this.
     */
    id: '0029_platform_admins',
    async isApplied(db) {
      return db.schema.hasTable('platform_admins');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      await createTableIfMissing(db, 'platform_admins', platformAdminsTable(db));
    }
  },
  {
    /**
     * Dá um `owner` a cada provedor: o administrador mais antigo dali.
     *
     * Os papéis passaram de dois (`admin`, `viewer`) para quatro (`owner`,
     * `admin`, `tech`, `viewer`). A coluna já é `string(32)` sem constraint, de
     * modo que os dois novos cabem sem tocar no schema — o que falta é ter
     * alguém no papel de cima, porque a única coisa que só o `owner` pode fazer
     * é promover e rebaixar outro `owner`, e sem nenhum `owner` essa porta fica
     * trancada por dentro em todo install que já existe.
     *
     * O mais antigo, e não "todos os admins": promover todo mundo faria de
     * `owner` outro nome para `admin` e apagaria a distinção no mesmo passo que
     * a cria. Quem tiver que ser promovido depois, um `owner` promove.
     *
     * Não tira capacidade de ninguém: `owner` e `admin` carregam exatamente as
     * mesmas capacidades (ver `config/permissions.js`), então a pessoa promovida
     * não ganha rota nenhuma que já não alcançasse, e as que ficaram `admin`
     * não perdem nenhuma.
     *
     * Sem `isApplied`: não há nada para baselinar. Um install anterior ao
     * runner não tem `tenant_users` — a tabela nasceu na 0028, que é do runner
     * — então "já estava assim" não é estado possível aqui.
     */
    id: '0030_tenant_owner_role',
    async up(db) {
      if (!(await db.schema.hasTable('tenant_users'))) return;

      const tenants = await db('tenant_users').distinct('tenant_id').pluck('tenant_id');
      for (const tenantId of tenants) {
        // Se já houver `owner` ali, a migração não tem o que fazer: ou já rodou,
        // ou alguém promovido depois já ocupa o papel, e nos dois casos escolher
        // outro seria desfazer uma decisão que não é desta migração.
        const existente = await db('tenant_users')
          .where({ tenant_id: tenantId, role: 'owner' })
          .first();
        if (existente) continue;

        const maisAntigo = await db('tenant_users')
          .where({ tenant_id: tenantId, role: 'admin' })
          .orderBy('id', 'asc')
          .first();
        // Provedor sem nenhum administrador fica sem `owner`, de propósito:
        // inventar um a partir de um `viewer` daria a alguém um poder que
        // ninguém lhe deu.
        if (!maisAntigo) continue;

        await db('tenant_users')
          .where({ id: maisAntigo.id })
          .update({ role: 'owner', updated_at: new Date() });
      }
    }
  },
  {
    /**
     * A tabela de convites. Criada aqui e não com as tabelas de tenancy porque
     * aponta para `users` — que o passo 0001 cria, muito depois de `tenants`.
     * Mesmo motivo de `tenant_users` e `platform_admins`.
     */
    id: '0031_tenant_invites',
    async isApplied(db) {
      return db.schema.hasTable('tenant_invites');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'tenant_invites', tenantInvitesTable(db));
    }
  },
  {
    /** A trilha. Mesmo motivo das duas acima para nascer aqui: aponta para `users`. */
    id: '0032_audit_log',
    async isApplied(db) {
      return db.schema.hasTable('audit_log');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'audit_log', auditLogTable(db));
    }
  },
  {
    /** A trilha do plano de controle. Aponta para `users`, daí nascer aqui. */
    id: '0033_platform_audit',
    async isApplied(db) {
      return db.schema.hasTable('platform_audit');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      await createTableIfMissing(db, 'platform_audit', platformAuditTable(db));
    }
  },
  {
    /**
     * O e-mail de login, acrescentado NULO.
     *
     * Nulo e não preenchido a partir de nada: não há de onde tirar o endereço
     * de quem já usa o painel, e inventar um (`fulano@localhost`, o username
     * com um domínio colado) daria a cada conta existente um endereço que
     * ninguém controla — e que, no dia em que houver redefinição de senha por
     * e-mail, seria o caminho para dentro dela.
     *
     * Por isso a coluna é anulável e o login por nome continua valendo: a
     * transição é cada pessoa cadastrando o próprio endereço, e não uma
     * migração adivinhando por elas.
     */
    id: '0034_users_email',
    async isApplied(db) {
      return db.schema.hasColumn('users', 'email');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      if (await db.schema.hasColumn('users', 'email')) return;
      await db.schema.alterTable('users', (t) => {
        t.string('email', 255).unique();
      });
    }
  },
  {
    /**
     * Planos, assinaturas e o extrato — a Fase 5.
     *
     * O que a migração NÃO faz é tão importante quanto o que faz. Ela não põe
     * ninguém em teste, não limita ninguém e não cobra ninguém: todo provedor
     * que já existe recebe uma assinatura `active` num plano sem limite nenhum
     * (`unlimited`), porque um upgrade não pode ser o dia em que um ISP em
     * produção descobre que está bloqueado ou tem operador demais. Quem decide
     * o plano de cada um é o console, depois, um por um.
     *
     * O plano `unlimited` é criado aqui e não em `seedDefaults` por isso: o
     * backfill precisa dele antes de o seed rodar, e o seed — que dá `trial` a
     * quem nasce depois — não pode confundir "existia antes desta migração" com
     * "acabou de ser criado". A migração sabe a diferença; o seed não.
     */
    id: '0035_plans_and_subscriptions',
    async isApplied(db) {
      for (const [name] of BILLING_TABLES) {
        if (!(await db.schema.hasTable(name))) return false;
      }
      return true;
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      if (!(await db.schema.hasTable('users'))) return;
      for (const [name, table] of BILLING_TABLES) {
        await createTableIfMissing(db, name, table(db));
      }

      let unlimited = await db('plans').where({ code: 'unlimited' }).first();
      if (!unlimited) {
        await db('plans').insert({
          code: 'unlimited',
          name: 'Sem limites',
          max_operators: null,
          max_subscribers: null,
          max_devices: null,
          price_cents: 0,
          currency: 'BRL',
          trial_days: 0,
          active: true
        });
        unlimited = await db('plans').where({ code: 'unlimited' }).first();
      }

      const tenants = await db('tenants').pluck('id');
      const covered = new Set((await db('subscriptions').pluck('tenant_id')).map(Number));
      const rows = tenants
        .filter((id) => !covered.has(Number(id)))
        .map((id) => ({ tenant_id: id, plan_id: unlimited.id, status: 'active' }));
      if (rows.length > 0) await db('subscriptions').insert(rows);
    }
  },
  {
    /**
     * O nome do provedor deixa de ser `settings.appName`.
     *
     * A barra lateral, a tela de login e a aba do navegador liam o nome de um
     * setting que o operador editava — e `tenants.name`, que o console lista
     * e o perfil público responde, dizia outra coisa. Um nome em dois lugares
     * é um nome mostrado diferente em duas telas; a Fase 6 fica com a linha do
     * provedor.
     *
     * A cópia é só de quem MUDOU o nome: um `appName` ainda no valor de fábrica
     * não diz nada sobre o provedor, e copiá-lo por cima de um nome dado no
     * console — que nasce com o setting de fábrica — trocaria "Provedor Beta"
     * por "SkyGenPanel". O setting fica na tabela, por compatibilidade com o
     * que ainda o lê; ninguém mais escreve nele pela tela.
     */
    id: '0036_tenant_name_from_app_name',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      const flag = await db('app_state').where({ key: 'tenant_name_migrated' }).first().catch(() => null);
      return Boolean(flag);
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      if (!(await db.schema.hasTable('settings'))) return;
      const rows = await db('settings').where({ key: 'appName' }).select('tenant_id', 'value');
      for (const row of rows) {
        const name = String(row.value ?? '').trim();
        // Qualquer nome de fábrica, o de hoje e os de antes, é "não escolheu nome".
        if (!name || name === PRODUCT_NAME || LEGACY_PRODUCT_NAMES.includes(name)) continue;
        await db('tenants').where({ id: row.tenant_id }).whereNot({ name }).update({ name, updated_at: new Date() });
      }
      // The flag lives in `app_state` of the FIRST provider only, as the marker
      // that this one-time copy happened; `app_state` has been per provider
      // since 0014, so the row needs a tenant.
      const first = await db('tenants').orderBy('id', 'asc').first();
      if (first && !(await db('app_state').where({ tenant_id: first.id, key: 'tenant_name_migrated' }).first())) {
        await db('app_state').insert({ tenant_id: first.id, key: 'tenant_name_migrated', value: '1' });
      }
    }
  },
  {
    /**
     * O bilhete de uso único que leva uma personificação do console ao painel
     * do provedor. Ver a fábrica da tabela para o porquê de ele existir em vez
     * de o token viajar na URL.
     *
     * Criada nas duas edições, e não só na SaaS. A tabela vazia não custa nada
     * numa instalação de um ISP só, e uma migration que roda condicionalmente
     * ao ambiente é uma migration cujo resultado depende de uma variável que
     * alguém pode ter trocado — o schema deixa de ser o mesmo nos dois lados e
     * o próximo passo tem que adivinhar em qual dos dois está.
     */
    id: '0037_impersonation_tickets',
    async isApplied(db) {
      return db.schema.hasTable('impersonation_tickets');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      if (!(await db.schema.hasTable('users'))) return;
      await createTableIfMissing(db, 'impersonation_tickets', impersonationTicketsTable(db));
    }
  },
  {
    /**
     * O índice único que faz `external_id` valer alguma coisa.
     *
     * O extrato nasceu com a coluna e com o comentário dizendo que o índice
     * existia — e não existia. Uma referência de pagamento repetida era aceita
     * sem erro e empurrava o período pago outra vez. A tabela nova já o traz em
     * `billingEventsTable`; esta migração o dá a quem já tinha a tabela.
     */
    id: '0038_billing_events_external_id_unique',
    async isApplied(db) {
      if (!(await db.schema.hasTable('billing_events'))) return true;
      return hasIndex(db, 'billing_events', 'billing_events_external_uq');
    },
    async up(db) {
      if (!(await db.schema.hasTable('billing_events'))) return;
      if (await hasIndex(db, 'billing_events', 'billing_events_external_uq')) return;
      await db.schema.alterTable('billing_events', (t) => {
        t.unique(['tenant_id', 'external_id'], 'billing_events_external_uq');
      });
    }
  },
  {
    /**
     * A redefinição de senha por e-mail, e a verificação de endereço que ela
     * torna obrigatória.
     *
     * O passo 0034 escreveu o aviso e este passo o cobra: o e-mail entrou nulo
     * porque um endereço inventado "seria o caminho para dentro da conta no dia
     * em que houver redefinição de senha por e-mail". É este dia. A partir
     * daqui existe um caminho que entrega uma sessão a quem lê uma caixa de
     * entrada, e a pergunta deixa de ser "esta conta tem endereço?" para ser
     * "alguém provou que este endereço é dela?".
     *
     * `email_verified_at` entra NULA para todo mundo, inclusive para os
     * endereços já cadastrados, e essa é a escolha que importa aqui. Dar-lhes
     * um carimbo de verificado seria barato e seria mentira: eles foram
     * gravados exigindo a senha atual, o que prova o controle da CONTA e não o
     * do ENDEREÇO — um endereço digitado errado entraria verificado e
     * apontaria a redefinição para a caixa de entrada de um estranho. O preço
     * de não mentir é um clique: quem já usa o painel entra com a senha, pede a
     * prova e confirma. Ninguém fica trancado do lado de fora, porque a
     * verificação não é condição de login — só de redefinição.
     */
    id: '0039_auth_tickets_and_email_verified',
    async isApplied(db) {
      if (!(await db.schema.hasTable('auth_tickets'))) return false;
      return db.schema.hasColumn('users', 'email_verified_at');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      if (!(await db.schema.hasTable('tenants'))) return;
      if (!(await db.schema.hasColumn('users', 'email_verified_at'))) {
        await db.schema.alterTable('users', (t) => {
          t.timestamp('email_verified_at');
        });
      }
      await createTableIfMissing(db, 'auth_tickets', authTicketsTable(db));
    }
  },
  {
    /**
     * As colunas que deixam o webhook ser conferido em vez de suposto.
     *
     * A URL do webhook era escrita uma única vez, dentro do corpo do create, e
     * nunca mais lida. Quando ela divergia do que o painel espera — instância
     * que já existia no servidor e caiu no ramo "already exists", webhook
     * editado pela interface do Evolution, `webhookBaseUrl` trocado depois do
     * pareamento — não havia onde isso aparecesse. O painel mostrava o número
     * conectado e nada chegando, que é indistinguível de um webhook correto
     * que ninguém está chamando.
     */
    id: '0040_whatsapp_webhook_check',
    async isApplied(db) {
      if (!(await db.schema.hasTable('whatsapp_accounts'))) return true;
      return db.schema.hasColumn('whatsapp_accounts', 'webhook_verdict');
    },
    async up(db) {
      if (!(await db.schema.hasTable('whatsapp_accounts'))) return;
      const faltando = await missingColumns(db, 'whatsapp_accounts', [
        ['webhook_verdict', (t) => t.string('webhook_verdict', 32)],
        ['webhook_server_url', (t) => t.string('webhook_server_url', 255)],
        ['webhook_checked_at', (t) => t.timestamp('webhook_checked_at')],
        ['webhook_refused_at', (t) => t.timestamp('webhook_refused_at')],
        ['webhook_refused_reason', (t) => t.string('webhook_refused_reason', 32)]
      ]);
      if (!faltando.length) return;
      await db.schema.alterTable('whatsapp_accounts', (t) => {
        for (const add of faltando) add(t);
      });
    }
  },
  {
    /**
     * A volta, que é a leitura que faltava.
     *
     * A 0040 deu ao painel como perguntar ao servidor Evolution qual webhook
     * ele guarda. O que ela não podia responder é se aquele endereço FUNCIONA:
     * as duas pontas da comparação — o que o servidor tem e o que o painel
     * espera — saem do mesmo `webhookBaseUrl`, que é digitado à mão e conferido
     * só na forma (absoluto, http(s), sem credencial). Com um endereço errado
     * os dois lados concordam e o veredito responde `ok` sobre uma instalação
     * que não entrega nada.
     *
     * Três jeitos de errar aquele campo, todos silenciosos e todos aprovados
     * pela comparação: sem caminho nenhum (o POST cai na raiz e o painel
     * devolve o HTML do frontend com 200), com caminho parecido e errado (404
     * em toda entrega), e o certo atrás de um proxy que recusa POST de fora.
     *
     * Um diagnóstico que confirma como são uma instalação quebrada é pior que
     * nenhum: ele encerra a conversa. Daí estas duas colunas.
     */
    id: '0041_whatsapp_webhook_probe',
    async isApplied(db) {
      if (!(await db.schema.hasTable('whatsapp_accounts'))) return true;
      return db.schema.hasColumn('whatsapp_accounts', 'webhook_probe_verdict');
    },
    async up(db) {
      if (!(await db.schema.hasTable('whatsapp_accounts'))) return;
      const faltando = await missingColumns(db, 'whatsapp_accounts', [
        ['webhook_probe_verdict', (t) => t.string('webhook_probe_verdict', 32)],
        ['webhook_probed_at', (t) => t.timestamp('webhook_probed_at')]
      ]);
      if (!faltando.length) return;
      await db.schema.alterTable('whatsapp_accounts', (t) => {
        for (const add of faltando) add(t);
      });
    }
  },
  {
    /**
     * A coluna de garra que a campanha nunca teve.
     *
     * `listPendingIds` e `claimRecipient` retomavam qualquer linha em 'sending'
     * mais velha que cinco minutos — medindo a idade por `created_at`, que é
     * quando a campanha foi MONTADA, não quando o destinatário foi garrado. Numa
     * campanha real, montada e revisada antes de disparar, esse corte já estava
     * no passado quando o primeiro envio começou: a condição de retomada casava
     * junto com a garra, e dois ticks sobrepostos contatavam o mesmo assinante.
     *
     * Entra NULA para as linhas existentes, e isso é seguro: uma linha sem garra
     * registrada nunca satisfaz `claimed_at < corte`, então ela só é alcançável
     * pelo ramo 'pending' — que é o certo para uma linha que ninguém pegou.
     */
    id: '0042_broadcast_recipient_claimed_at',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_broadcast_recipients'))) return true;
      return db.schema.hasColumn('wa_broadcast_recipients', 'claimed_at');
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_broadcast_recipients'))) return;
      if (await db.schema.hasColumn('wa_broadcast_recipients', 'claimed_at')) return;
      await db.schema.alterTable('wa_broadcast_recipients', (t) => {
        t.timestamp('claimed_at');
      });
    }
  },
  {
    /**
     * O cadastro fiscal do provedor.
     *
     * `tenants` nasceu com slug, nome e situação — o bastante para resolver um
     * host e para ligar e desligar um cliente, e nada além. Com dezenas de ISPs
     * pagando, falta o que uma nota fiscal exige: razão social, CNPJ, endereço
     * e um contato que receba a cobrança. Sem essas colunas não se fatura nem
     * se emite, e o cadastro de um provedor não serve de contrato.
     *
     * Nulas todas, porque nenhum provedor que já existe as tem — e porque um
     * ISP se cadastra antes de ter o contador por perto. A primeira fatura é
     * que cobra o preenchimento, não o INSERT.
     *
     * Nasceu `0042` e virou `0043` na integração: a garra da campanha chegou ao
     * `main` com o mesmo número enquanto esta fatia estava em revisão. O teste
     * que recusa id repetido — escrito nesta mesma fatia, por causa da `0040` —
     * é o que transformou isso num conflito de merge em vez de num passo pulado
     * em silêncio num banco de produção.
     */
    id: '0043_tenant_billing_profile',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasColumn('tenants', 'billing_tax_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      const faltando = await missingColumns(db, 'tenants', TENANT_BILLING_COLUMNS);
      if (!faltando.length) return;
      await db.schema.alterTable('tenants', (t) => {
        for (const add of faltando) add(t);
      });
    }
  },
  {
    /**
     * A marca do prazo já avisado.
     *
     * Desde que o período pago passou a vencer de verdade, o provedor descobria
     * o vencimento tomando 402 ao salvar — o painel sabia a data e não dizia
     * nada. O aviso precisa de uma memória, ou ele vira uma mensagem por
     * passada do agendador, que é a maneira mais rápida de treinar alguém a
     * ignorar o aviso que importa.
     *
     * Guarda O PRAZO avisado e não a hora do aviso: assim um pagamento que
     * empurra `renews_at` faz a marca deixar de casar sozinha, e o ciclo
     * recomeça sem nenhum caminho precisar lembrar de limpar nada. Nula para
     * quem já existe, que é o certo — ninguém foi avisado ainda.
     */
    id: '0044_subscription_expiry_warned_for',
    async isApplied(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return true;
      return db.schema.hasColumn('subscriptions', 'expiry_warned_for');
    },
    async up(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return;
      if (await db.schema.hasColumn('subscriptions', 'expiry_warned_for')) return;
      await db.schema.alterTable('subscriptions', (t) => {
        t.timestamp('expiry_warned_for');
      });
    }
  },
  {
    /**
     * Quem cada provedor é dentro do gateway de pagamento.
     *
     * O extrato já nasceu preparado para isto — `billing_events.provider` e
     * `external_id` existem desde o começo, e o índice único
     * `(tenant_id, external_id)` da 0038 foi criado explicitamente para a
     * reentrega de webhook. O que faltava era o caminho de volta: dado um
     * pagamento no gateway, de qual provedor ele é.
     *
     * Em `tenants` e não numa tabela nova: ver o comentário de
     * `TENANT_GATEWAY_COLUMNS`. Nulas para quem já existe, que é o certo —
     * ninguém está ligado a gateway nenhum, e a cobrança segue manual até
     * alguém preencher.
     */
    id: '0045_tenant_billing_gateway',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasColumn('tenants', 'billing_gateway');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      const faltando = await missingColumns(db, 'tenants', TENANT_GATEWAY_COLUMNS);
      if (faltando.length) {
        await db.schema.alterTable('tenants', (t) => {
          for (const add of faltando) add(t);
        });
      }
      // O índice à parte das colunas: numa base que já tem as colunas por
      // outro caminho, o passo ainda precisa poder criar o índice — e o
      // `alterTable` acima não teria rodado.
      if (!(await hasIndex(db, 'tenants', 'tenants_gateway_customer_idx'))) {
        await db.schema.alterTable('tenants', (t) => {
          t.index(['billing_gateway', 'billing_customer_ref'], 'tenants_gateway_customer_idx');
        });
      }
    }
  },
  {
    /**
     * Quanto tempo um pagamento compra, por plano.
     *
     * O período pago era um `30` dentro do serviço de assinatura. O catálogo
     * tinha preço, moeda e dias de TESTE por plano, e não tinha o prazo do
     * período PAGO — a assimetria que impedia existir plano anual.
     *
     * `defaultTo(30)` e não nulo: é o que toda assinatura deste deploy já
     * comprou desde sempre, então a coluna nasce dizendo a verdade sobre o
     * passado em vez de deixar todo plano existente sem período no dia do
     * upgrade.
     */
    id: '0046_plan_period_days',
    async isApplied(db) {
      if (!(await db.schema.hasTable('plans'))) return true;
      return db.schema.hasColumn('plans', 'period_days');
    },
    async up(db) {
      if (!(await db.schema.hasTable('plans'))) return;
      if (await db.schema.hasColumn('plans', 'period_days')) return;
      await db.schema.alterTable('plans', (t) => {
        t.integer('period_days').unsigned().notNullable().defaultTo(30);
      });
    }
  },
  {
    /**
     * A cobrança emitida, que até aqui só existia no painel do gateway.
     *
     * O porquê de ser tabela e não um tipo novo em `billing_events` está na
     * fábrica `billingChargesTable`, e o resumo é: no gateway a cobrança é o
     * pagamento, então a emissão e o crédito disputariam a mesma
     * `(tenant_id, external_id)` — e quem perderia a disputa seria o crédito,
     * em silêncio.
     *
     * Nasce vazia. Nenhum provedor tem cobrança emitida porque nada emitia;
     * a primeira linha sai do job, na primeira passada depois que alguém ligar
     * o provedor ao gateway.
     */
    id: '0047_billing_charges',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('billing_charges');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'billing_charges', billingChargesTable(db));
    }
  },
  {
    /**
     * Desde quando o provedor está suspenso.
     *
     * `tenants` tinha só `created_at` e `updated_at`, e `updated_at` é
     * sobrescrito por qualquer renomeação ou edição de cadastro — então ninguém
     * conseguia responder "há quanto tempo este provedor está parado?". A
     * pergunta não é acadêmica: só existem dois estados, sem prazo e sem
     * exclusão automática, então um provedor suspenso pode estar parado há uma
     * semana ou há dois anos, guardando CPF, contrato e a conversa inteira dos
     * assinantes dele, e o console mostrava os dois casos igual.
     *
     * Nasce NULA para todo mundo, e o passo seguinte a preenche a partir da
     * trilha. Nulo continua sendo uma resposta possível depois disso — é o que
     * a tela mostra como "não se sabe", para o provedor suspenso antes de a
     * trilha existir.
     */
    id: '0048_tenant_suspended_at',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasColumn('tenants', 'suspended_at');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      const faltando = await missingColumns(db, 'tenants', [
        ['suspended_at', (t) => t.timestamp('suspended_at')]
      ]);
      if (faltando.length) {
        await db.schema.alterTable('tenants', (t) => {
          for (const add of faltando) add(t);
        });
      }
    }
  },
  {
    /**
     * A data de suspensão de quem já estava suspenso, lida da trilha.
     *
     * Separada do passo que cria a coluna porque faz outra coisa: aquele mexe
     * no esquema, este lê dado e escreve linha. Juntos, uma falha aqui faria a
     * coluna parecer não existir e o passo inteiro rodar de novo.
     *
     * `platform_audit` registra toda mudança de status com `{ from, to }` no
     * `detail`, e é compartilhada e sem FK para `tenants` — de propósito, para
     * sobreviver à exclusão do provedor. Então a data real está lá.
     *
     * O `detail` é TEXT com JSON dentro, e consultar JSON dentro de texto tem
     * sintaxe diferente nos três dialetos. Como mudança de status é rara, a
     * leitura vem crua e o filtro acontece em JS — o que funciona igual em
     * SQLite, MySQL e Postgres sem uma linha de SQL específico.
     *
     * Quem não tem registro fica NULO. Não inventar data é a parte que importa:
     * `updated_at` daria um número plausível e errado, e errado sem avisar.
     */
    id: '0049_tenant_suspended_at_backfill',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      if (!(await db.schema.hasColumn('tenants', 'suspended_at'))) return false;
      // Já rodou se nenhum suspenso está sem data — que é também o estado de
      // uma instalação sem provedor suspenso nenhum.
      const [{ total }] = await db('tenants')
        .where({ status: 'suspended' })
        .whereNull('suspended_at')
        .count({ total: '*' });
      return Number(total) === 0;
    },
    async up(db) {
      if (!(await db.schema.hasColumn('tenants', 'suspended_at'))) return;
      if (!(await db.schema.hasTable('platform_audit'))) return;

      const pendentes = await db('tenants')
        .where({ status: 'suspended' })
        .whereNull('suspended_at')
        .pluck('id');
      if (pendentes.length === 0) return;

      const linhas = await db('platform_audit')
        .whereIn('tenant_id', pendentes)
        .where({ action: 'tenant.status_changed' })
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .select('tenant_id', 'detail', 'created_at');

      // A PRIMEIRA mudança de status de cada provedor decide, e só ela — as
      // linhas vêm da mais recente para a mais antiga.
      //
      // Decidir pela mais recente que TERMINOU em suspenso seria pior que não
      // decidir: um provedor suspenso, reativado, e suspenso de novo sem que a
      // última vez tenha deixado registro receberia a data da suspensão ANTIGA,
      // que é uma mentira precisa — a tela mostraria "parado há dois anos"
      // sobre quem parou semana passada. Se a mudança mais recente terminou em
      // ativo, a suspensão de agora veio depois dela e não está na trilha:
      // nulo é a resposta honesta.
      const decidido = new Map();
      for (const linha of linhas) {
        const id = Number(linha.tenant_id);
        if (decidido.has(id)) continue;
        let detalhe;
        try {
          detalhe = JSON.parse(linha.detail);
        } catch {
          // JSON quebrado não é resposta, e também não impede a próxima linha
          // de ser a resposta: só esta é descartada.
          continue;
        }
        decidido.set(id, detalhe?.to === 'suspended' ? linha.created_at : null);
      }

      for (const [id, quando] of decidido) {
        if (!quando) continue;
        await db('tenants').where({ id }).update({ suspended_at: quando });
      }
    }
  },
  {
    /**
     * Se a linha em `tenants` é um cliente ou é a própria plataforma.
     *
     * Toda tabela de WhatsApp tem `tenant_id` NOT NULL com chave estrangeira
     * para `tenants`, e a sessão do console nasce sem provedor de propósito —
     * então o console não tem como ter caixa de mensagem nenhuma. Dar à
     * plataforma uma LINHA resolve isso sem tocar em nada daquele subsistema: o
     * webhook do Evolution já descobre o dono pelo nome da instância, e
     * `forEachTenant` já drena a fila de quem existe.
     *
     * O que a coluna compra é o outro lado: a plataforma não pode ser tratada
     * como CLIENTE. Sem ela, a caixa apareceria na lista de provedores do
     * console, receberia cobrança e aviso de vencimento, e entraria na contagem
     * que decide se a tela de login esconde o nome do provedor.
     *
     * Todo mundo que já existe nasce `provider`, que é o default da coluna:
     * uma instalação em produção não pode descobrir num update que uma das
     * linhas dela mudou de natureza.
     */
    id: '0050_tenant_kind',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasColumn('tenants', 'kind');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      if (await db.schema.hasColumn('tenants', 'kind')) return;
      await db.schema.alterTable('tenants', (t) => {
        t.string('kind', 16).notNullable().defaultTo('provider');
      });
    }
  },
  {
    /**
     * O endereço do webhook das instalações anteriores à garantia do caminho.
     *
     * POR QUE ISTO EXISTE
     * -------------------
     * `normalizeWebhookBaseUrl` passou a completar o caminho do painel quando
     * quem configura digita só o host — que é o que a tela pede. Mas ela roda na
     * GRAVAÇÃO, e nada alcançou as linhas que já estavam no banco. Uma
     * instalação que configurou o WhatsApp antes daquela correção continua com
     * `https://painel.exemplo.com` gravado, e o sintoma é mudo: o servidor
     * Evolution faz POST na raiz, o frontend responde 200 com HTML, o servidor
     * registra entrega bem-sucedida, e nada chega nunca.
     *
     * Aconteceu num painel em produção e só apareceu quando o diagnóstico da
     * configuração foi rodado à mão. Depender de alguém abrir a aba e clicar em
     * Salvar é depender de alguém suspeitar primeiro — e a forma do defeito é
     * exatamente não dar motivo para suspeitar.
     *
     * O QUE ELA NÃO FAZ
     * -----------------
     * Um caminho que NÃO seja o do painel fica intacto, nunca reescrito. Quem
     * serve o painel sob um prefixo próprio (`/painel/api/whatsapp-webhook`)
     * digitou aquilo de propósito, e `withWebhookPath` já distingue os dois
     * casos — é ela que decide aqui, e não uma regra reescrita nesta migração,
     * porque duas cópias da mesma regra divergem.
     *
     * E ela não alcança o webhook gravado DENTRO das instâncias que já existem
     * no servidor Evolution: aquele valor é escrito no create e em lugar nenhum
     * depois. Consertar o painel conserta os números pareados daqui em diante;
     * os antigos pedem `POST /accounts/:id/webhook`, que já existe e é uma ação
     * de quem administra, não de uma migração.
     */
    id: '0051_whatsapp_webhook_path_backfill',
    async isApplied(db) {
      if (!(await db.schema.hasTable('app_state'))) return true;
      const linhas = await db('app_state')
        .where({ key: EVOLUTION_CONFIG_KEY })
        .select('value');
      // Já rodou quando nenhuma linha está no formato antigo — que é também o
      // estado de uma instalação que nunca configurou o WhatsApp.
      return linhas.every((linha) => caminhoDoWebhookCorrigido(linha.value) === null);
    },
    async up(db) {
      if (!(await db.schema.hasTable('app_state'))) return;
      const linhas = await db('app_state')
        .where({ key: EVOLUTION_CONFIG_KEY })
        .select('tenant_id', 'key', 'value');

      for (const linha of linhas) {
        const corrigido = caminhoDoWebhookCorrigido(linha.value);
        if (corrigido === null) continue;
        // `app_state` não tem `id`: a chave primária é composta. Atualizar por
        // um `id` inexistente é o erro de SQL que `tenantExportService` já
        // documenta — aqui a linha é endereçada pelo par.
        await db('app_state')
          .where({ tenant_id: linha.tenant_id, key: linha.key })
          .update({ value: corrigido });
      }
    }
  },
  {
    /**
     * Derruba `wifi_security_mappings`, que nunca foi ligada.
     *
     * POR QUE ISTO EXISTE
     *
     * A tabela guardaria, por fabricante, a tradução do valor cru de segurança
     * de WiFi que a ONT relata (`11i`, `WPAand11i`) para um nome legível
     * (`WPA2`). A função que a leria — `normalizeWiFiSecurity`, um SELECT por
     * `vendor_id` e `raw_security_value` — existiu no serviço de fabricantes
     * desde o commit mais antigo deste repositório e **nunca teve um chamador
     * sequer**; foi apagada no refactor de banco de dois dialetos. Não é
     * funcionalidade que parou de ser usada: é uma remoção feita pela metade, e
     * a metade que sobrou foi a tabela.
     *
     * POR QUE NÃO TERMINAR EM VEZ DE APAGAR
     *
     * O encaixe existe: o painel LÊ `BeaconType` e mostra o valor cru na tela
     * do aparelho. Mas ele também ESCREVE o valor cru de volta. Traduzir só a
     * exibição faria o operador ver "WPA2", editar, e o painel gravar "WPA2"
     * numa chave que espera "11i" — terminar exige o dicionário nos DOIS
     * sentidos, que é um projeto. Cru na leitura e cru na escrita é coerente;
     * ligada pela metade, a tabela quebraria essa coerência.
     *
     * O QUE ISTO LIBERA
     *
     * Ela era a única tabela do catálogo com chave estrangeira para `vendors`,
     * e por isso a única razão de `copyCatalogue` remapear `vendor_id` ao dar
     * catálogo a um provedor novo — o trecho mais delicado do seed. Sem ela, a
     * cópia passa a ser opaca nas duas tabelas restantes.
     *
     * A CONTAGEM ANTES DO DROP
     *
     * Não é diagnóstico: é o registro de quanto se descartou. Como nunca houve
     * tela que escrevesse na tabela, o esperado é zero — e foi zero no deploy
     * que motivou esta migration. Um número diferente de zero numa instalação
     * qualquer precisa aparecer em algum lugar, senão ninguém consegue
     * investigar depois.
     */
    id: '0052_drop_wifi_security_mappings',
    async isApplied(db) {
      return !(await db.schema.hasTable('wifi_security_mappings'));
    },
    async up(db) {
      if (!(await db.schema.hasTable('wifi_security_mappings'))) return;

      const [linha] = await db('wifi_security_mappings').count({ n: '*' });
      const total = Number(linha?.n || 0);
      if (total > 0) {
        console.warn(
          `0052_drop_wifi_security_mappings: descartando ${total} linha(s) de uma tabela `
          + 'que nenhum código lê. Ver o comentário desta migration.'
        );
      }

      // Filha da chave estrangeira, então não há dependente a derrubar antes.
      await db.schema.dropTable('wifi_security_mappings');
    }
  },
  {
    /**
     * Os contatos do SGP sem ONT — ver `sgpContactsTable`.
     *
     * Nasce vazia. A primeira linha sai da primeira busca de um operador no
     * SGP pela aba Contatos do WhatsApp.
     */
    id: '0053_sgp_contacts',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('sgp_contacts');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'sgp_contacts', sgpContactsTable(db));
    }
  },
  {
    /**
     * Todos os clientes do SGP, com ou sem contrato.
     *
     * A 0053 guardava só o que um operador buscava, e sempre por contrato. A
     * sincronização completa traz também o cadastro sem contrato, então:
     *
     * - `sgp_contacts.contract` passa a aceitar nulo. O unique por
     *   `(tenant_id, contract)` continua: nulos não colidem nos três bancos.
     * - `sgp_client_id` e `last_seen_at` — ver `SGP_CONTACT_SYNC_COLUMNS`.
     * - `wa_conversations.sgp_contact_id`, o vínculo de uma conversa com um
     *   cliente sem contrato. Sem chave estrangeira de propósito:
     *   `wa_conversations` vem antes de `sgp_contacts` em `SCHEMA_TABLES`, que
     *   é a ordem em que a cópia e a exclusão de provedor percorrem as tabelas,
     *   e uma FK para trás quebraria a cópia. Um id que não acha linha é lido
     *   como "sem vínculo", que é o mesmo que o `SET NULL` faria.
     */
    id: '0054_sgp_contacts_full_sync',
    async isApplied(db) {
      if (!(await db.schema.hasTable('sgp_contacts'))) return true;
      if ((await missingColumns(db, 'sgp_contacts', SGP_CONTACT_SYNC_COLUMNS)).length) return false;
      if (!(await db.schema.hasTable('wa_conversations'))) return true;
      return db.schema.hasColumn('wa_conversations', 'sgp_contact_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_contacts'))) return;
      const missing = await missingColumns(db, 'sgp_contacts', SGP_CONTACT_SYNC_COLUMNS);
      if (missing.length) {
        await db.schema.alterTable('sgp_contacts', (t) => {
          for (const add of missing) add(t);
          t.string('contract', 64).nullable().alter();
          t.unique(['tenant_id', 'sgp_client_id'], 'sgp_contacts_client_uq');
        });
      }
      if (
        (await db.schema.hasTable('wa_conversations'))
        && !(await db.schema.hasColumn('wa_conversations', 'sgp_contact_id'))
      ) {
        await db.schema.alterTable('wa_conversations', (t) => {
          t.integer('sgp_contact_id').unsigned();
          t.index(['sgp_contact_id'], 'wa_conversations_sgp_contact_idx');
        });
      }
    }
  },
  {
    /**
     * Uma cor para cada número do WhatsApp.
     *
     * A caixa de entrada misturava as conversas de todos os números do provedor
     * sem dizer qual recebeu cada uma. A coluna guarda a cor do número; quem a
     * escolhe na criação é `EvolutionInstanceService.createAccount`, e o
     * administrador pode trocá-la depois.
     *
     * O backfill é o que faz a mudança aparecer no deploy sem ninguém mexer:
     * cada provedor tem os seus números coloridos em ordem de id, com a mesma
     * regra da criação — então quem tem dois números ganha duas cores
     * DIFERENTES, e não duas vezes a primeira da paleta.
     *
     * Só preenche quem está nulo, então rodar de novo (o processo que morre
     * entre o passo e o registro dele) não troca a cor de ninguém — nem a que o
     * administrador já escolheu. Um número que nasça sem cor depois disto (um
     * processo antigo ainda de pé no deploy) não é alcançado aqui, porque o
     * runner não repete passo registrado; a tela lhe dá uma cor de reserva
     * derivada do id, e a primeira troca feita à mão a grava.
     */
    id: '0055_whatsapp_account_color',
    async isApplied(db) {
      if (!(await db.schema.hasTable('whatsapp_accounts'))) return true;
      return db.schema.hasColumn('whatsapp_accounts', 'color');
    },
    async up(db) {
      if (!(await db.schema.hasTable('whatsapp_accounts'))) return;
      if (!(await db.schema.hasColumn('whatsapp_accounts', 'color'))) {
        await db.schema.alterTable('whatsapp_accounts', (t) => t.string('color', 16));
      }
      const linhas = await db('whatsapp_accounts')
        .select('id', 'tenant_id', 'color')
        .orderBy([{ column: 'tenant_id' }, { column: 'id' }]);
      // As cores já gravadas contam desde o começo, e não só as que este passo
      // der: um número que já tem cor não pode ganhar um vizinho igual a ele.
      const usadas = new Map();
      for (const linha of linhas) {
        if (!usadas.has(linha.tenant_id)) usadas.set(linha.tenant_id, []);
        if (linha.color) usadas.get(linha.tenant_id).push(linha.color);
      }
      for (const linha of linhas) {
        if (linha.color) continue;
        const doProvedor = usadas.get(linha.tenant_id);
        const cor = nextAccountColor(doProvedor);
        doProvedor.push(cor);
        // eslint-disable-next-line no-await-in-loop -- um número por vez, e são poucos
        await db('whatsapp_accounts').where({ id: linha.id }).update({ color: cor });
      }
    }
  },
  {
    /**
     * O cadastro completo dos clientes do SGP.
     *
     * - `sgp_clients`, a ficha por cliente — ver `sgpClientsTable`.
     * - Em `sgp_contacts`, o que faltava de cada contrato — ver
     *   `SGP_CONTACT_PROFILE_COLUMNS`.
     *
     * As linhas antigas ficam com os campos novos vazios até a próxima
     * sincronização, que os preenche.
     */
    id: '0056_sgp_client_profiles',
    async isApplied(db) {
      if (!(await db.schema.hasTable('sgp_contacts'))) return true;
      if ((await missingColumns(db, 'sgp_contacts', SGP_CONTACT_PROFILE_COLUMNS)).length) return false;
      return db.schema.hasTable('sgp_clients');
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_contacts'))) return;
      const missing = await missingColumns(db, 'sgp_contacts', SGP_CONTACT_PROFILE_COLUMNS);
      if (missing.length) {
        await db.schema.alterTable('sgp_contacts', (t) => {
          for (const add of missing) add(t);
          t.index(['tenant_id', 'client_ref'], 'sgp_contacts_client_ref_idx');
        });
      }
      await createTableIfMissing(db, 'sgp_clients', sgpClientsTable(db));
    }
  },
  {
    /**
     * Tetos de retenção por plano — ver `plansTable`.
     *
     * Nascem nulos, que é "sem teto": nenhum provedor perde histórico no dia
     * do upgrade. Quem passa a limitar é o console, plano a plano.
     */
    id: '0057_plan_retention_caps',
    async isApplied(db) {
      if (!(await db.schema.hasTable('plans'))) return true;
      return (await missingColumns(db, 'plans', PLAN_RETENTION_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('plans'))) return;
      const missing = await missingColumns(db, 'plans', PLAN_RETENTION_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('plans', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /**
     * Até quando o bot fica calado numa conversa em que o assinante pediu um
     * atendente. Nulo é "o bot pode responder". Uma coluna, e não uma tabela
     * de estado: o menu do bot não tem memória, e o único estado que ele
     * precisa lembrar é este.
     */
    id: '0058_wa_bot_pause',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_conversations'))) return true;
      return db.schema.hasColumn('wa_conversations', 'bot_paused_until');
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_conversations'))) return;
      if (await db.schema.hasColumn('wa_conversations', 'bot_paused_until')) return;
      await db.schema.alterTable('wa_conversations', (t) => {
        t.timestamp('bot_paused_until').nullable();
      });
    }
  },
  {
    /**
     * Login em duas etapas (app autenticador).
     *
     * Em `users`, e não por provedor: a linha é a PESSOA, que pode trabalhar em
     * vários provedores e no console com o mesmo login — o segundo fator é
     * dela, e vale em todos. O segredo é cifrado como os outros segredos do
     * painel (`secretBox`, contexto próprio, com a versão da chave), e
     * `totp_last_step` é o último passo aceito: o mesmo código não entra duas
     * vezes.
     *
     * Os códigos de recuperação em tabela própria, guardados só como hash — são
     * uma senha de uso único cada.
     */
    id: '0059_user_totp',
    async isApplied(db) {
      return (await db.schema.hasColumn('users', 'totp_enabled_at'))
        && db.schema.hasTable('user_recovery_codes');
    },
    async up(db) {
      const faltando = await missingColumns(db, 'users', [
        ['totp_ciphertext', (t) => t.text('totp_ciphertext').nullable()],
        ['totp_iv', (t) => t.string('totp_iv', 32).nullable()],
        ['totp_tag', (t) => t.string('totp_tag', 32).nullable()],
        ['totp_key_version', (t) => t.integer('totp_key_version').nullable()],
        ['totp_enabled_at', (t) => t.timestamp('totp_enabled_at').nullable()],
        ['totp_last_step', (t) => t.bigInteger('totp_last_step').nullable()]
      ]);
      if (faltando.length > 0) {
        await db.schema.alterTable('users', (t) => {
          for (const add of faltando) add(t);
        });
      }
      for (const [nome, construtor] of MFA_TABLES) {
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /**
     * O dono do provedor pode exigir o login em duas etapas da equipe.
     *
     * Coluna no PROVEDOR, e não chave em `settings`: aquela tabela se grava por
     * `PUT /api/settings/:key`, que o `admin` também alcança, e ele desligaria
     * pela porta genérica o que só o dono pode ligar. Aqui a única escrita é a
     * rota própria, que confere o papel.
     *
     * Nasce falsa para todo mundo: ligar é decisão do dono, nunca do deploy.
     */
    id: '0060_tenant_require_mfa',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasColumn('tenants', 'require_mfa');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      const faltando = await missingColumns(db, 'tenants', [
        ['require_mfa', (t) => t.boolean('require_mfa').notNullable().defaultTo(false)]
      ]);
      if (faltando.length) {
        await db.schema.alterTable('tenants', (t) => {
          for (const add of faltando) add(t);
        });
      }
    }
  },
  {
    /**
     * O centro do mapa que ainda está em Jacarta vai para Brasília.
     *
     * Jacarta (-6.2088, 106.8456) era o padrão do projeto de origem, e ficou
     * gravado para quem salvou o mapa — ou restaurou o padrão — antes de o
     * padrão mudar. Nenhum provedor brasileiro escolheu esse ponto de
     * propósito; quem mudou o centro para a própria cidade não é tocado,
     * porque só se troca o par exato.
     */
    id: '0061_map_center_brasilia',
    async isApplied(db) {
      if (!(await db.schema.hasTable('map_settings'))) return true;
      const jacarta = await db('map_settings')
        .where({ center_lat: '-6.2088', center_lng: '106.8456' })
        .first();
      return !jacarta;
    },
    async up(db) {
      if (!(await db.schema.hasTable('map_settings'))) return;
      await db('map_settings')
        .where({ center_lat: '-6.2088', center_lng: '106.8456' })
        .update({ center_lat: '-15.7942', center_lng: '-47.8822' });
    }
  },
  {
    /**
     * O produto passou a se chamar "TR69 Controle".
     *
     * Um provedor ainda com o nome de fábrica antigo nunca escolheu nome — ele
     * nasceu assim —, então mostrar "SkyGenPanel" no topo da tela dele é
     * mostrar a marca velha. Só o valor EXATO de fábrica é trocado: um provedor
     * que se deu um nome, qualquer nome, fica com ele. O setting `appName` de
     * fábrica é atualizado pelo `seedDefaults` no boot.
     */
    id: '0062_product_rename_tr69_controle',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      const antigo = await db('tenants').whereIn('name', LEGACY_PRODUCT_NAMES).first();
      return !antigo;
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      await db('tenants')
        .whereIn('name', LEGACY_PRODUCT_NAMES)
        .update({ name: PRODUCT_NAME, updated_at: new Date() });
    }
  },
  {
    /**
     * O telefone da pessoa — ver `usersTable`. Nasce nulo para todo mundo.
     */
    id: '0063_user_phone',
    async isApplied(db) {
      if (!(await db.schema.hasTable('users'))) return true;
      return db.schema.hasColumn('users', 'phone');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      if (await db.schema.hasColumn('users', 'phone')) return;
      await db.schema.alterTable('users', (t) => {
        t.string('phone', 32);
      });
    }
  },
  {
    /**
     * O passo do bot numa conversa: esperando o CPF/CNPJ, ou escolhendo entre
     * os contratos que o documento trouxe.
     *
     * Colunas na conversa, e não uma tabela de sessões, pelo mesmo motivo de
     * `bot_paused_until`: o estado é um só por conversa, curto e descartável —
     * o passo vence em 30 min e o contador de tentativas em 1 h.
     * `bot_step_data` guarda só contrato e rótulo para a escolha, nunca o
     * documento que o assinante digitou.
     */
    id: '0064_wa_bot_step',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_conversations'))) return true;
      return db.schema.hasColumn('wa_conversations', 'bot_doc_window_at');
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_conversations'))) return;
      const colunas = [
        ['bot_step', (t) => t.string('bot_step', 32).nullable()],
        ['bot_step_data', (t) => t.text('bot_step_data').nullable()],
        ['bot_step_at', (t) => t.timestamp('bot_step_at').nullable()],
        ['bot_doc_attempts', (t) => t.integer('bot_doc_attempts').notNullable().defaultTo(0)],
        ['bot_doc_window_at', (t) => t.timestamp('bot_doc_window_at').nullable()]
      ];
      for (const [nome, criar] of colunas) {
        // eslint-disable-next-line no-await-in-loop -- uma coluna por vez, cada uma conferida
        if (await db.schema.hasColumn('wa_conversations', nome)) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.schema.alterTable('wa_conversations', criar);
      }
    }
  },
  {
    /**
     * O provedor sem dono ganha dono: o administrador mais antigo.
     *
     * Até aqui o `/setup` criava o primeiro usuário como `admin`, e o provedor
     * instalado assim nunca teve `owner` — o que só o dono decide ficava num
     * remendo ("o admin governa onde não há owner"). Quem fez o `/setup` é o
     * vínculo `admin` mais antigo do provedor, e é ele que vira dono.
     *
     * Uma pessoa por provedor, e só onde não há dono nenhum: provedor que já
     * tem `owner` (cadastro público, console) não é tocado, e dois `admin`
     * não viram dois donos. O `users.role` acompanha só quem trabalha apenas
     * nesse provedor — a mesma regra de `applyRoleSideEffects`. A trilha do
     * provedor registra a promoção, com o sistema como autor.
     */
    id: '0065_first_admin_becomes_owner',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenant_users'))) return true;
      return (await semDonoComAdmin(db)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenant_users'))) return;
      for (const tenantId of await semDonoComAdmin(db)) {
        // eslint-disable-next-line no-await-in-loop -- um provedor por vez, cada um na sua transação
        await db.transaction(async (trx) => {
          const vinculo = await trx('tenant_users')
            .where({ tenant_id: tenantId, role: 'admin' })
            .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'user_id', order: 'asc' }])
            .first();
          if (!vinculo) return;
          await trx('tenant_users').where({ id: vinculo.id }).update({ role: 'owner', updated_at: new Date() });
          const vinculos = await trx('tenant_users').where({ user_id: vinculo.user_id }).count({ n: '*' }).first();
          if (Number(vinculos?.n || 0) <= 1) {
            await trx('users').where({ id: vinculo.user_id }).update({ role: 'owner' });
          }
          if (await trx.schema.hasTable('audit_log')) {
            const pessoa = await trx('users').where({ id: vinculo.user_id }).first('username');
            await trx('audit_log').insert({
              tenant_id: tenantId,
              actor_user_id: null,
              actor_username: null,
              actor_kind: 'system',
              action: 'operator.role_changed',
              subject_type: 'tenant_user',
              subject_id: String(vinculo.user_id),
              detail: JSON.stringify({ username: pessoa?.username ?? null, from: 'admin', to: 'owner' })
            });
          }
        });
      }
    }
  },
  {
    /** Os incidentes de queda em massa — ver `outageIncidentsTable`. */
    id: '0066_outage_incidents',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('outage_incident_devices');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      for (const [nome, construtor] of OUTAGE_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- a segunda aponta para a primeira
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /** O histórico de rompimentos — ver `outageEventsTable`. */
    id: '0067_outage_events',
    async isApplied(db) {
      return db.schema.hasTable('outage_events');
    },
    async up(db) {
      await createTableIfMissing(db, 'outage_events', outageEventsTable(db));
    }
  },
  {
    /** O que o bot respondeu — ver `waBotEventsTable`. */
    id: '0068_wa_bot_events',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('wa_bot_events');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      for (const [nome, construtor] of WA_BOT_EVENT_TABLES) {
        // eslint-disable-next-line no-await-in-loop
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /**
     * Como o painel chega ao GenieACS de cada provedor — ver
     * `tenantGenieAcsConnectionsTable`. Tabela nova e vazia: sem linha vale
     * `direct`, que é o que todos já faziam.
     */
    id: '0069_tenant_genieacs_connections',
    async isApplied(db) {
      return db.schema.hasTable('tenant_genieacs_connections');
    },
    async up(db) {
      for (const [nome, construtor] of GENIEACS_CONNECTION_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- uma tabela por vez
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /**
     * A trava por conta contra força bruta — ver `accountLockoutsTable`. Nasce
     * vazia: ninguém começa travado, e quem já errou a senha antes do upgrade
     * começa a contar do zero.
     */
    id: '0070_account_lockouts',
    async isApplied(db) {
      return db.schema.hasTable('account_lockouts');
    },
    async up(db) {
      for (const [nome, construtor] of LOCKOUT_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- uma tabela só, hoje
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /** Manutenção programada — ver `maintenanceWindowsTable`. */
    id: '0071_maintenance_windows',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('maintenance_window_devices');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      for (const [nome, construtor] of MAINTENANCE_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- a segunda aponta para a primeira
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /**
     * Quem administra o GenieACS do provedor — ver
     * `tenantGenieAcsConnectionsTable`. Todo mundo começa com `platform`, que
     * é o que a SaaS já fazia; a tabela nova da 0069 já nasce com a coluna.
     */
    id: '0072_tenant_genieacs_ownership',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenant_genieacs_connections'))) return true;
      return db.schema.hasColumn('tenant_genieacs_connections', 'ownership');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenant_genieacs_connections'))) return;
      if (await db.schema.hasColumn('tenant_genieacs_connections', 'ownership')) return;
      await db.schema.alterTable('tenant_genieacs_connections', (t) => {
        t.string('ownership', 16).notNullable().defaultTo('platform');
      });
    }
  },
  {
    /**
     * A emissão com dono, e a memória das cobranças que foram trocadas.
     *
     * `issuing_until` é a garra: quem vai falar com o gateway por uma linha
     * grava aqui "até quando ela é minha", num `UPDATE` condicional, e só
     * segue quem de fato mudou a linha. Sem ela, o agendador e um "pagar
     * agora" (ou dois cliques, ou a troca de plano) que lessem a mesma linha
     * sem `gateway_charge_id` criariam DUAS cobranças de verdade no gateway —
     * a leitura de idempotência é leitura, e duas leituras simultâneas
     * respondem a mesma coisa. Um instante e não um booleano: quem morreu
     * segurando a garra (o processo caiu no meio da chamada) a solta sozinho
     * quando o prazo passa, e a linha não fica presa para sempre.
     *
     * `superseded_charges` é o que a troca de plano apaga da linha ao
     * reemitir: o id no gateway da cobrança velha e quanto ELA pedia. Um JSON
     * numa coluna de texto, e não uma tabela: é histórico de uma linha só,
     * raro (uma entrada por troca de plano com cobrança em aberto), lido
     * apenas quando um pagamento chega com um id que nenhuma linha tem — e a
     * pergunta é a de `valorPedido`: quanto se pediu por AQUELE pagamento.
     * Sem isto, o pagamento atrasado da cobrança velha seria conferido contra
     * o preço novo, e quem pagou exatamente o que viu seria "pago a menos".
     *
     * Nulas nas linhas que já existem, que é o estado certo das duas: ninguém
     * está emitindo, e nada foi trocado.
     */
    id: '0073_billing_charge_claims',
    async isApplied(db) {
      if (!(await db.schema.hasTable('billing_charges'))) return true;
      return (await missingColumns(db, 'billing_charges', BILLING_CHARGE_CLAIM_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('billing_charges'))) return;
      const missing = await missingColumns(db, 'billing_charges', BILLING_CHARGE_CLAIM_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('billing_charges', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /**
     * A descida de plano que espera a renovação.
     *
     * Até aqui toda troca feita pelo provedor valia na hora, e a revisão achou
     * o buraco: subir para o plano caro logo depois de pagar, usar os tetos
     * maiores o mês inteiro e descer de volta antes de a cobrança seguinte
     * sair — o plano caro nunca era pago. A regra agora é que SUBIR vale na
     * hora (paga-se a diferença a partir da próxima cobrança) e DESCER, com um
     * período pago correndo, vale na renovação: o provedor fica no plano que
     * pagou até o fim do que pagou.
     *
     * `pending_plan_id` é o plano para o qual a assinatura desce, e
     * `pending_plan_at` é QUANDO — o `renews_at` do momento em que a descida
     * foi pedida, gravado à parte e não relido de `renews_at`: um pagamento
     * adiantado empurra `renews_at` para o mês seguinte, e a descida pedida
     * para este mês não pode escorregar junto. É também por essa data que a
     * emissão sabe que a cobrança daquele prazo já é do plano novo.
     *
     * Nulas nas linhas que já existem, que é o estado certo das duas: ninguém
     * agendou nada ainda.
     */
    id: '0074_subscription_pending_plan',
    async isApplied(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return true;
      return (await missingColumns(db, 'subscriptions', SUBSCRIPTION_PENDING_PLAN_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return;
      const missing = await missingColumns(db, 'subscriptions', SUBSCRIPTION_PENDING_PLAN_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('subscriptions', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /**
     * As duas travas que a revisão da descida agendada pediu, as duas contra
     * o mesmo dano: um mês de plano caro pago pelo preço do barato.
     *
     * `upgraded_at` é quando o provedor SUBIU de plano no meio de um período
     * pago — que não é cobrado (não há proporcional), e só se paga pela
     * cobrança seguinte. Sem esta marca, subir no primeiro dia e agendar a
     * descida antes da cobrança seguinte sair deixava o mês inteiro no plano
     * caro de graça. Com ela, a descida pedida nesse período vai para a
     * renovação SEGUINTE: o próximo período é cobrado pelo preço de cima. Um
     * pagamento que estende o período a apaga — o plano de cima já foi pago.
     *
     * `pending_plan_locked_at` é quando o período que começa na descida foi
     * PAGO pelo preço dela. Dali em diante a descida não se desfaz: cancelá-la
     * ou trocá-la depois de pagar o barato era ficar no caro pelo preço do
     * barato, e o uso que cresce depois de pagar não a segura — ela se aplica
     * na data de qualquer jeito.
     *
     * Nulas nas linhas que já existem, que é o estado certo das duas.
     */
    id: '0075_subscription_plan_guards',
    async isApplied(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return true;
      return (await missingColumns(db, 'subscriptions', SUBSCRIPTION_PLAN_GUARD_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return;
      const missing = await missingColumns(db, 'subscriptions', SUBSCRIPTION_PLAN_GUARD_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('subscriptions', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /**
     * O modo `agent` do GenieACS — ver `GENIEACS_AGENT_COLUMNS`.
     *
     * Numa instalação nova a 0069 já cria a tabela com estas colunas (e o
     * índice), e este passo não acha nada a fazer; numa que rodou a 0069 antes
     * delas existirem, acrescenta. O índice único sai junto com as colunas, no
     * mesmo `alterTable`, porque só falta quando elas faltam.
     */
    id: '0076_genieacs_agent',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenant_genieacs_connections'))) return true;
      return (await missingColumns(db, 'tenant_genieacs_connections', GENIEACS_AGENT_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenant_genieacs_connections'))) return;
      const faltando = await missingColumns(db, 'tenant_genieacs_connections', GENIEACS_AGENT_COLUMNS);
      const semHash = !(await db.schema.hasColumn('tenant_genieacs_connections', 'agent_token_hash'));
      if (!faltando.length) return;
      await db.schema.alterTable('tenant_genieacs_connections', (t) => {
        for (const add of faltando) add(t);
        if (semHash) t.unique(['agent_token_hash'], GENIEACS_AGENT_TOKEN_INDEX);
      });
    }
  },
  {
    /**
     * O importador da TeiaH Valid.
     *
     * - Em `sgp_contacts`, o endereço em partes e a data de cancelamento — ver
     *   `SGP_CONTACT_TEIAH_COLUMNS`. As linhas antigas ficam vazias até a
     *   próxima sincronização de contatos, que as preenche.
     * - `teiah_exports`, o que já foi enviado — ver `teiahExportsTable`.
     */
    id: '0077_teiah_valid',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      if (await db.schema.hasTable('sgp_contacts')
        && (await missingColumns(db, 'sgp_contacts', SGP_CONTACT_TEIAH_COLUMNS)).length) return false;
      return db.schema.hasTable('teiah_exports');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      if (await db.schema.hasTable('sgp_contacts')) {
        const faltando = await missingColumns(db, 'sgp_contacts', SGP_CONTACT_TEIAH_COLUMNS);
        if (faltando.length) {
          await db.schema.alterTable('sgp_contacts', (t) => {
            for (const add of faltando) add(t);
          });
        }
      }
      for (const [nome, construtor] of TEIAH_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- uma tabela só, hoje
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /**
     * O valor de uma cobrança que o CONSOLE mudou à mão (o desconto, o acordo).
     *
     * Duas leituras dependem de saber que o valor da linha não é o preço de
     * plano nenhum:
     *
     * - a emissão, que reprecifica a cobrança da renovação quando a descida
     *   agendada fica bloqueada pelo uso (`repriceBlockedDowngrade`) e acerta
     *   o valor de uma linha ainda não emitida com o preço de agora. As duas
     *   desfariam em silêncio o desconto que alguém deu;
     * - `recordPayment`, que decide se a descida agendada fica TRAVADA pelo
     *   preço que se pagou: "pagou menos que o plano atual" quer dizer "pagou
     *   o barato" — a menos que o menos seja um desconto, e aí travaria a
     *   descida de quem pagou o plano caro com abatimento.
     *
     * Nula nas linhas que já existem, que é o estado certo: nenhuma foi
     * mexida pelo console antes desta coluna existir.
     */
    id: '0078_billing_charge_amount_override',
    async isApplied(db) {
      if (!(await db.schema.hasTable('billing_charges'))) return true;
      return (await missingColumns(db, 'billing_charges', BILLING_CHARGE_OVERRIDE_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('billing_charges'))) return;
      const missing = await missingColumns(db, 'billing_charges', BILLING_CHARGE_OVERRIDE_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('billing_charges', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /**
     * O plano como a página pública o mostra: se aparece, em que ordem, se é
     * o destaque, e as frases que o vendem. Ver `PLAN_MARKETING_COLUMNS`.
     */
    id: '0079_plans_marketing',
    async isApplied(db) {
      if (!(await db.schema.hasTable('plans'))) return true;
      return (await missingColumns(db, 'plans', PLAN_MARKETING_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('plans'))) return;
      const missing = await missingColumns(db, 'plans', PLAN_MARKETING_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('plans', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /** Os pedidos de demonstração da página pública — ver `leadsTable`. */
    id: '0080_leads',
    async isApplied(db) {
      return db.schema.hasTable('leads');
    },
    async up(db) {
      for (const [nome, construtor] of LEAD_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- uma tabela só
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /**
     * A régua de cobrança automática — ver `waDunningSendsTable`. A tabela
     * nasce com o provedor, como as outras desde a 0053, e por isso depende de
     * `tenants` e de `wa_templates`/`wa_messages` existirem.
     */
    id: '0081_wa_dunning_sends',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('wa_dunning_sends');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      for (const [nome, construtor] of DUNNING_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- uma tabela só, hoje
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /**
     * As colunas da TeiaH em `sgp_contacts` para quem rodou a primeira versão
     * da 0077, de antes de `equipment_rented` existir: a 0077 ficou marcada
     * como aplicada e não volta a rodar. Numa instalação nova a 0077 já cria
     * tudo e este passo não acha nada a fazer.
     */
    id: '0082_sgp_contacts_teiah_columns',
    async isApplied(db) {
      if (!(await db.schema.hasTable('sgp_contacts'))) return true;
      return (await missingColumns(db, 'sgp_contacts', SGP_CONTACT_TEIAH_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_contacts'))) return;
      const faltando = await missingColumns(db, 'sgp_contacts', SGP_CONTACT_TEIAH_COLUMNS);
      if (!faltando.length) return;
      await db.schema.alterTable('sgp_contacts', (t) => {
        for (const add of faltando) add(t);
      });
    }
  },
  {
    /**
     * "Isento de cobrança": o console marca a assinatura de um provedor para
     * ficar ativa sem gerar fatura, até alguém desligar. `billing_exempt_at` é
     * desde quando, `billing_exempt_reason` é o porquê que o console escreveu.
     * Ver `SubscriptionService.setBillingExempt`.
     *
     * Nulas nas linhas que já existem, que é o estado certo: ninguém é isento
     * antes desta coluna existir.
     */
    id: '0083_subscription_billing_exempt',
    async isApplied(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return true;
      return (await missingColumns(db, 'subscriptions', SUBSCRIPTION_BILLING_EXEMPT_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return;
      const missing = await missingColumns(db, 'subscriptions', SUBSCRIPTION_BILLING_EXEMPT_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('subscriptions', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /**
     * Desde quando a conversa tem gente dos dois lados: o cliente escreveu, ou
     * um atendente escreveu nela. Nula é a conversa que só recebeu envio
     * automático (régua, campanha, alerta) — ela sai de "Abertas" e fica em
     * "Sem resposta", para a cobrança do mês não encher a caixa de entrada.
     *
     * O preenchimento das linhas antigas é o que evita esvaziar a caixa de
     * quem já usa o painel: conta como engajada toda conversa que já teve
     * entrada do cliente ou mensagem de atendente. A que só tem envio
     * automático fica nula, que é exatamente onde ela deveria estar.
     */
    id: '0084_wa_conversations_engaged_at',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_conversations'))) return true;
      return db.schema.hasColumn('wa_conversations', 'engaged_at');
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_conversations'))) return;
      if (!(await db.schema.hasColumn('wa_conversations', 'engaged_at'))) {
        await db.schema.alterTable('wa_conversations', (t) => {
          t.timestamp('engaged_at').nullable();
          t.index(['tenant_id', 'closed_at', 'engaged_at'], 'wa_conversations_engaged_idx');
        });
      }
      await db('wa_conversations')
        .whereNull('engaged_at')
        .where((q) => q
          .whereNotNull('last_inbound_at')
          .orWhereExists((sub) => sub
            .select(db.raw('1'))
            .from('wa_messages')
            .whereRaw('wa_messages.conversation_id = wa_conversations.id')
            .where({ direction: 'out', source: 'operator' })))
        .update({ engaged_at: db.raw('COALESCE(last_inbound_at, last_message_at, created_at)') });
    }
  },
  {
    /**
     * Campanhas de aviso: o módulo "Nova campanha" monta públicos pelo
     * cadastro (situação, plano, bairro, cidade, lista de contratos), agenda o
     * início e leva um anexo. Ver `WA_BROADCAST_CAMPAIGN_COLUMNS`.
     *
     * As campanhas que já existem nasceram todas da cobrança avulsa, e é o que
     * o padrão de `kind` diz delas.
     */
    id: '0085_wa_broadcast_campaigns',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_broadcasts'))) return true;
      return (await missingColumns(db, 'wa_broadcasts', WA_BROADCAST_CAMPAIGN_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_broadcasts'))) return;
      const missing = await missingColumns(db, 'wa_broadcasts', WA_BROADCAST_CAMPAIGN_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('wa_broadcasts', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    id: '0086_wa_skip_details',
    async isApplied(db) {
      for (const [table, columns] of SKIP_DETAIL_TABLES) {
        if (!(await db.schema.hasTable(table))) continue;
        if ((await missingColumns(db, table, columns)).length) return false;
      }
      return true;
    },
    async up(db) {
      for (const [table, columns] of SKIP_DETAIL_TABLES) {
        if (!(await db.schema.hasTable(table))) continue;
        const missing = await missingColumns(db, table, columns);
        if (!missing.length) continue;
        await db.schema.alterTable(table, (t) => {
          for (const add of missing) add(t);
        });
      }
    }
  },
  {
    /** A pesquisa de satisfação — ver `waSatisfactionTable`. */
    id: '0087_wa_satisfaction',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('wa_satisfaction');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      for (const [nome, construtor] of SATISFACTION_TABLES) {
        // eslint-disable-next-line no-await-in-loop
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /** Número oficial da Meta pelo Evolution — ver `WA_ACCOUNT_CLOUD_COLUMNS`. */
    id: '0088_wa_meta_cloud',
    async isApplied(db) {
      for (const [table, columns] of WA_CLOUD_TABLES) {
        if (!(await db.schema.hasTable(table))) continue;
        if ((await missingColumns(db, table, columns)).length) return false;
      }
      return true;
    },
    async up(db) {
      for (const [table, columns] of WA_CLOUD_TABLES) {
        if (!(await db.schema.hasTable(table))) continue;
        const missing = await missingColumns(db, table, columns);
        if (!missing.length) continue;
        await db.schema.alterTable(table, (t) => {
          for (const add of missing) add(t);
        });
      }
    }
  },
  {
    /**
     * Os modelos aprovados da Meta e o que liga cada modelo do painel a um
     * deles — ver `waMetaTemplatesTable` e `WA_TEMPLATE_META_COLUMNS`.
     */
    id: '0089_wa_meta_templates',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      if (!(await db.schema.hasTable('wa_meta_templates'))) return false;
      for (const [table, columns] of WA_META_TEMPLATE_COLUMN_TABLES) {
        if (!(await db.schema.hasTable(table))) continue;
        if ((await missingColumns(db, table, columns)).length) return false;
      }
      return true;
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      for (const [nome, construtor] of WA_META_TEMPLATE_TABLES) {
        // eslint-disable-next-line no-await-in-loop
        await createTableIfMissing(db, nome, construtor(db));
      }
      for (const [table, columns] of WA_META_TEMPLATE_COLUMN_TABLES) {
        if (!(await db.schema.hasTable(table))) continue;
        const missing = await missingColumns(db, table, columns);
        if (!missing.length) continue;
        await db.schema.alterTable(table, (t) => {
          for (const add of missing) add(t);
        });
      }
    }
  },
  {
    /** A distribuição de conversas — ver `waAgentsTable` e `WA_ASSIGNMENT_COLUMNS`. */
    id: '0090_wa_assignment',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      if (!(await db.schema.hasTable('wa_agents'))) return false;
      if (!(await db.schema.hasTable('wa_conversations'))) return true;
      return (await missingColumns(db, 'wa_conversations', WA_ASSIGNMENT_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      for (const [nome, construtor] of WA_AGENT_TABLES) {
        // eslint-disable-next-line no-await-in-loop
        await createTableIfMissing(db, nome, construtor(db));
      }
      if (!(await db.schema.hasTable('wa_conversations'))) return;
      const missing = await missingColumns(db, 'wa_conversations', WA_ASSIGNMENT_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('wa_conversations', (t) => {
        for (const add of missing) add(t);
        t.index(['tenant_id', 'assigned_user_id', 'closed_at'], 'wa_conversations_assigned_idx');
      });
    }
  },
  {
    /**
     * A isenção de cobrança com data de fim: `billing_exempt_until` é até
     * quando ela vale. Passado o instante, o agendador desliga a isenção pelo
     * mesmo caminho do console (ver `SubscriptionService.endExpiredBillingExempt`).
     * Nula nas linhas que já existem: a isenção de antes desta coluna é "até
     * alguém desligar", e continua sendo.
     */
    id: '0091_subscription_billing_exempt_until',
    async isApplied(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return true;
      return (await missingColumns(db, 'subscriptions', SUBSCRIPTION_BILLING_EXEMPT_UNTIL_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return;
      const missing = await missingColumns(db, 'subscriptions', SUBSCRIPTION_BILLING_EXEMPT_UNTIL_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('subscriptions', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /** A régua de lembretes de cobrança — ver `subscriptionReminderSendsTable`. */
    id: '0092_subscription_reminder_sends',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('subscription_reminder_sends');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      for (const [nome, construtor] of SUBSCRIPTION_REMINDER_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- uma tabela só
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /** Os cupons de desconto — ver `couponsTable` e `SUBSCRIPTION_COUPON_COLUMNS`. */
    id: '0093_coupons',
    async isApplied(db) {
      if (!(await db.schema.hasTable('coupons'))) return false;
      // Criada depois da primeira versão desta migração: o banco de quem já a
      // rodou precisa ganhá-la também.
      if (await db.schema.hasTable('tenants') && !(await db.schema.hasTable('coupon_redemptions'))) return false;
      if (await db.schema.hasTable('billing_charges')
        && (await missingColumns(db, 'billing_charges', BILLING_CHARGE_PRICING_COLUMNS)).length) return false;
      if (!(await db.schema.hasTable('subscriptions'))) return true;
      return (await missingColumns(db, 'subscriptions', SUBSCRIPTION_COUPON_COLUMNS)).length === 0;
    },
    async up(db) {
      for (const [nome, construtor] of COUPON_TABLES) {
        // A memória dos resgates aponta para `tenants`; sem ela, nada a criar.
        // eslint-disable-next-line no-await-in-loop -- uma leitura só
        if (nome === 'coupon_redemptions' && !(await db.schema.hasTable('tenants'))) continue;
        // eslint-disable-next-line no-await-in-loop -- duas tabelas só
        await createTableIfMissing(db, nome, construtor(db));
      }
      if (await db.schema.hasTable('billing_charges')) {
        const faltam = await missingColumns(db, 'billing_charges', BILLING_CHARGE_PRICING_COLUMNS);
        if (faltam.length) {
          await db.schema.alterTable('billing_charges', (t) => {
            for (const add of faltam) add(t);
          });
        }
      }
      if (!(await db.schema.hasTable('subscriptions'))) return;
      const missing = await missingColumns(db, 'subscriptions', SUBSCRIPTION_COUPON_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('subscriptions', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /** A NFS-e de cada cobrança paga, pela Asaas — ver `billingInvoicesTable`. */
    id: '0094_billing_invoices',
    async isApplied(db) {
      if (!(await db.schema.hasTable('billing_charges'))) return true;
      return db.schema.hasTable('billing_invoices');
    },
    async up(db) {
      if (!(await db.schema.hasTable('billing_charges'))) return;
      for (const [nome, construtor] of BILLING_INVOICE_TABLES) {
        // eslint-disable-next-line no-await-in-loop
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /**
     * Cabeçalho de mídia e botão de URL dinâmica nos modelos da Meta — ver
     * `WA_META_TEMPLATE_MEDIA_COLUMNS`. A cópia antiga fica com o formato vazio
     * e continua "não suportada" até a próxima sincronização.
     */
    id: '0095_wa_meta_template_media',
    async isApplied(db) {
      for (const [table, columns] of WA_META_MEDIA_COLUMN_TABLES) {
        if (!(await db.schema.hasTable(table))) continue;
        if ((await missingColumns(db, table, columns)).length) return false;
      }
      return true;
    },
    async up(db) {
      for (const [table, columns] of WA_META_MEDIA_COLUMN_TABLES) {
        if (!(await db.schema.hasTable(table))) continue;
        const missing = await missingColumns(db, table, columns);
        if (!missing.length) continue;
        await db.schema.alterTable(table, (t) => {
          for (const add of missing) add(t);
        });
      }
    }
  },
  {
    /** As etiquetas das conversas — ver `waTagsTable`. */
    id: '0096_wa_tags',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      for (const [nome] of WA_TAG_TABLES) {
        if (!(await db.schema.hasTable(nome))) return false;
      }
      return true;
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      for (const [nome, construtor] of WA_TAG_TABLES) {
        // eslint-disable-next-line no-await-in-loop
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /** A régua parada por contrato — ver `waDunningPausesTable`. */
    id: '0097_wa_dunning_pauses',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('wa_dunning_pauses');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'wa_dunning_pauses', waDunningPausesTable(db));
    }
  },
  {
    id: '0098_wa_opt_out_categories',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_opt_outs'))) return true;
      return (await missingColumns(db, 'wa_opt_outs', WA_OPT_OUT_CATEGORY_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_opt_outs'))) return;
      const missing = await missingColumns(db, 'wa_opt_outs', WA_OPT_OUT_CATEGORY_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('wa_opt_outs', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    id: '0099_sgp_contacts_import_source',
    async isApplied(db) {
      if (!(await db.schema.hasTable('sgp_contacts'))) return true;
      return (await missingColumns(db, 'sgp_contacts', SGP_CONTACT_IMPORT_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_contacts'))) return;
      const missing = await missingColumns(db, 'sgp_contacts', SGP_CONTACT_IMPORT_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('sgp_contacts', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /** O cartão recorrente — ver `SUBSCRIPTION_CARD_COLUMNS` e `BILLING_CHARGE_CARD_COLUMNS`. */
    id: '0100_subscription_card',
    async isApplied(db) {
      for (const [tabela, colunas] of [['subscriptions', SUBSCRIPTION_CARD_COLUMNS], ['billing_charges', BILLING_CHARGE_CARD_COLUMNS]]) {
        if (!(await db.schema.hasTable(tabela))) continue;
        if ((await missingColumns(db, tabela, colunas)).length) return false;
      }
      return true;
    },
    async up(db) {
      for (const [tabela, colunas] of [['subscriptions', SUBSCRIPTION_CARD_COLUMNS], ['billing_charges', BILLING_CHARGE_CARD_COLUMNS]]) {
        if (!(await db.schema.hasTable(tabela))) continue;
        const missing = await missingColumns(db, tabela, colunas);
        if (!missing.length) continue;
        await db.schema.alterTable(tabela, (t) => {
          for (const add of missing) add(t);
        });
      }
    }
  },
  {
    /** A fatura de pró-rata da subida — ver `BILLING_CHARGE_PRORATION_COLUMNS`. */
    id: '0101_billing_charge_proration',
    async isApplied(db) {
      if (await db.schema.hasTable('billing_charges')
        && (await missingColumns(db, 'billing_charges', BILLING_CHARGE_PRORATION_COLUMNS)).length) return false;
      if (!(await db.schema.hasTable('subscriptions'))) return true;
      return (await missingColumns(db, 'subscriptions', SUBSCRIPTION_PRORATION_COLUMNS)).length === 0;
    },
    async up(db) {
      for (const [tabela, colunas] of [
        ['billing_charges', BILLING_CHARGE_PRORATION_COLUMNS],
        ['subscriptions', SUBSCRIPTION_PRORATION_COLUMNS]
      ]) {
        // eslint-disable-next-line no-await-in-loop -- duas tabelas só
        if (!(await db.schema.hasTable(tabela))) continue;
        // eslint-disable-next-line no-await-in-loop
        const faltam = await missingColumns(db, tabela, colunas);
        if (!faltam.length) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.schema.alterTable(tabela, (t) => {
          for (const add of faltam) add(t);
        });
      }
    }
  },
  {
    /**
     * Por que a assinatura está `suspended` (`SubscriptionService`):
     * `auto_nonpayment` é a suspensão automática por inadimplência, que o
     * pagamento desfaz sozinho; `manual` é o console, que só o console desfaz.
     * Nula nas linhas que já existem — toda suspensão de antes era à mão.
     */
    id: '0102_subscription_suspended_reason',
    async isApplied(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return true;
      return (await missingColumns(db, 'subscriptions', SUBSCRIPTION_SUSPENDED_REASON_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('subscriptions'))) return;
      const missing = await missingColumns(db, 'subscriptions', SUBSCRIPTION_SUSPENDED_REASON_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('subscriptions', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /** O webhook da Meta registrado pelo painel — ver `WA_ACCOUNT_META_WEBHOOK_COLUMNS`. */
    id: '0103_wa_meta_webhook',
    async isApplied(db) {
      if (!(await db.schema.hasTable('whatsapp_accounts'))) return true;
      return (await missingColumns(db, 'whatsapp_accounts', WA_ACCOUNT_META_WEBHOOK_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('whatsapp_accounts'))) return;
      const missing = await missingColumns(db, 'whatsapp_accounts', WA_ACCOUNT_META_WEBHOOK_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('whatsapp_accounts', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /** O ciclo de cobrança anual — ver `SUBSCRIPTION_BILLING_CYCLE_COLUMNS`. */
    id: '0104_subscription_billing_cycle',
    async isApplied(db) {
      for (const [tabela, colunas] of [
        ['subscriptions', SUBSCRIPTION_BILLING_CYCLE_COLUMNS],
        ['billing_charges', BILLING_CHARGE_BILLING_CYCLE_COLUMNS]
      ]) {
        // eslint-disable-next-line no-await-in-loop -- duas tabelas só
        if (!(await db.schema.hasTable(tabela))) continue;
        // eslint-disable-next-line no-await-in-loop
        if ((await missingColumns(db, tabela, colunas)).length) return false;
      }
      return true;
    },
    async up(db) {
      for (const [tabela, colunas] of [
        ['subscriptions', SUBSCRIPTION_BILLING_CYCLE_COLUMNS],
        ['billing_charges', BILLING_CHARGE_BILLING_CYCLE_COLUMNS]
      ]) {
        // eslint-disable-next-line no-await-in-loop -- duas tabelas só
        if (!(await db.schema.hasTable(tabela))) continue;
        // eslint-disable-next-line no-await-in-loop
        const faltam = await missingColumns(db, tabela, colunas);
        if (!faltam.length) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.schema.alterTable(tabela, (t) => {
          for (const add of faltam) add(t);
        });
      }
    }
  },
  {
    /**
     * A cobrança por excedente: o preço por unidade acima do teto em cada
     * plano, a conta do valor em cada cobrança e o pico de uso por período —
     * ver `PLAN_OVERAGE_COLUMNS`, `BILLING_CHARGE_PRICING_DETAIL_COLUMNS` e
     * `usagePeaksTable`.
     */
    id: '0105_usage_overage',
    async isApplied(db) {
      for (const [tabela, colunas] of [['plans', PLAN_OVERAGE_COLUMNS], ['billing_charges', BILLING_CHARGE_PRICING_DETAIL_COLUMNS]]) {
        // eslint-disable-next-line no-await-in-loop -- duas tabelas só
        if (!(await db.schema.hasTable(tabela))) continue;
        // eslint-disable-next-line no-await-in-loop
        if ((await missingColumns(db, tabela, colunas)).length) return false;
      }
      if (!(await db.schema.hasTable('tenants'))) return true;
      if (!(await db.schema.hasTable('usage_peaks'))) return false;
      return !(await missingColumns(db, 'usage_peaks', USAGE_PEAK_SNAPSHOT_COLUMNS)).length;
    },
    async up(db) {
      for (const [tabela, colunas] of [['plans', PLAN_OVERAGE_COLUMNS], ['billing_charges', BILLING_CHARGE_PRICING_DETAIL_COLUMNS]]) {
        // eslint-disable-next-line no-await-in-loop -- duas tabelas só
        if (!(await db.schema.hasTable(tabela))) continue;
        // eslint-disable-next-line no-await-in-loop
        const faltam = await missingColumns(db, tabela, colunas);
        if (!faltam.length) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.schema.alterTable(tabela, (t) => {
          for (const add of faltam) add(t);
        });
      }
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'usage_peaks', usagePeaksTable(db));
      // A base que já tinha a tabela antes da fotografia do plano.
      const semFoto = await missingColumns(db, 'usage_peaks', USAGE_PEAK_SNAPSHOT_COLUMNS);
      if (semFoto.length) {
        await db.schema.alterTable('usage_peaks', (t) => {
          for (const add of semFoto) add(t);
        });
      }
    }
  },
  {
    /**
     * A indicação de provedores — ver `TENANT_REFERRAL_COLUMNS`,
     * `BILLING_CHARGE_CREDIT_COLUMNS` e `REFERRAL_TABLES`. O índice único do
     * código à parte das colunas, como o do gateway (0047): a base que já tem
     * a coluna por outro caminho ainda ganha o índice.
     */
    id: '0106_referrals_and_credits',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      if ((await missingColumns(db, 'tenants', TENANT_REFERRAL_COLUMNS)).length) return false;
      if (!(await hasIndex(db, 'tenants', 'tenants_referral_code_uq'))) return false;
      if (await db.schema.hasTable('billing_charges')
        && (await missingColumns(db, 'billing_charges', BILLING_CHARGE_CREDIT_COLUMNS)).length) return false;
      for (const [nome] of REFERRAL_TABLES) {
        if (nome === 'credit_allocations' && !(await db.schema.hasTable('billing_charges'))) continue;
        if (!(await db.schema.hasTable(nome))) return false;
      }
      return true;
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      const faltam = await missingColumns(db, 'tenants', TENANT_REFERRAL_COLUMNS);
      if (faltam.length) {
        await db.schema.alterTable('tenants', (t) => {
          for (const add of faltam) add(t);
        });
      }
      if (!(await hasIndex(db, 'tenants', 'tenants_referral_code_uq'))) {
        await db.schema.alterTable('tenants', (t) => {
          t.unique(['referral_code'], 'tenants_referral_code_uq');
        });
      }
      if (await db.schema.hasTable('billing_charges')) {
        const semCredito = await missingColumns(db, 'billing_charges', BILLING_CHARGE_CREDIT_COLUMNS);
        if (semCredito.length) {
          await db.schema.alterTable('billing_charges', (t) => {
            for (const add of semCredito) add(t);
          });
        }
      }
      for (const [nome, construtor] of REFERRAL_TABLES) {
        // A alocação aponta para `billing_charges`; sem ela, nada a criar.
        // eslint-disable-next-line no-await-in-loop -- três tabelas só
        if (nome === 'credit_allocations' && !(await db.schema.hasTable('billing_charges'))) continue;
        // eslint-disable-next-line no-await-in-loop
        await createTableIfMissing(db, nome, construtor(db));
      }
    }
  },
  {
    /**
     * A retenção no cancelamento — ver `cancellationRequestsTable`,
     * `SUBSCRIPTION_RETENTION_COLUMNS` e `COUPON_SYSTEM_COLUMNS`.
     */
    id: '0107_cancellation_retention',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      if (!(await db.schema.hasTable('cancellation_requests'))) return false;
      for (const [tabela, colunas] of [
        ['subscriptions', SUBSCRIPTION_RETENTION_COLUMNS], ['coupons', COUPON_SYSTEM_COLUMNS],
        ['cancellation_requests', CANCELLATION_REQUEST_LATE_COLUMNS]
      ]) {
        // eslint-disable-next-line no-await-in-loop -- duas tabelas só
        if (!(await db.schema.hasTable(tabela))) continue;
        // eslint-disable-next-line no-await-in-loop
        if ((await missingColumns(db, tabela, colunas)).length) return false;
      }
      return true;
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      for (const [tabela, colunas] of [['subscriptions', SUBSCRIPTION_RETENTION_COLUMNS], ['coupons', COUPON_SYSTEM_COLUMNS]]) {
        // eslint-disable-next-line no-await-in-loop -- duas tabelas só
        if (!(await db.schema.hasTable(tabela))) continue;
        // eslint-disable-next-line no-await-in-loop
        const faltam = await missingColumns(db, tabela, colunas);
        if (!faltam.length) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.schema.alterTable(tabela, (t) => {
          for (const add of faltam) add(t);
        });
      }
      for (const [nome, construtor] of CANCELLATION_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- uma tabela só
        await createTableIfMissing(db, nome, construtor(db));
      }
      const tardias = await missingColumns(db, 'cancellation_requests', CANCELLATION_REQUEST_LATE_COLUMNS);
      if (tardias.length) {
        await db.schema.alterTable('cancellation_requests', (t) => {
          for (const add of tardias) add(t);
        });
      }
    }
  },
  {
    /** A situação financeira por contrato — ver `sgpBillingStatusTable`. */
    id: '0108_sgp_billing_status',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('sgp_billing_status');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'sgp_billing_status', sgpBillingStatusTable(db));
    }
  },
  {
    /**
     * O IP de quem pediu contato na vitrine, que era gravado e NUNCA lido.
     *
     * `publicController.createLead` o escrevia; `models/Lead.js` não o menciona
     * em nenhum dos cinco métodos, e `presentLead` — lista fechada de campos —
     * não o entrega ao console, que portanto nunca o mostrou. Dado pessoal
     * guardado sem finalidade em exercício é o que o art. 6º da LGPD trata como
     * desnecessário, e o titular aqui é alguém que **não é cliente de ninguém**:
     * não há contrato, nem legítimo interesse em exercício, que o justifique.
     *
     * E ele não era o controle de abuso da rota: isso são o `publicLeadLimiter`
     * (5/hora por IP) e o campo-armadilha `website`, que devolvem 201 ao robô
     * sem gravar nada. Nenhum dos dois consulta esta coluna.
     *
     * POR QUE DERRUBAR, E NÃO SÓ PARAR DE GRAVAR
     * ------------------------------------------
     * Parar de gravar deixaria no disco todos os IPs já coletados — e "não
     * guardamos o IP de quem pede contato" seria falso sobre o passado. A
     * coluna é o dado.
     *
     * O número descartado vai para o log de propósito: migração que descarta
     * dado de alguém em silêncio é a que ninguém consegue investigar depois, e
     * aqui o número NÃO vai ser zero — a coluna vem sendo preenchida desde que
     * a vitrine existe.
     *
     * O índice `leads_status_created_idx` tem que sobreviver: é dele que a poda
     * por prazo depende, e o SQLite derruba coluna reconstruindo a tabela, que é
     * onde um índice se perde sem avisar. `backend/test/lead-retention.test.js`
     * confere isso nos três dialetos.
     */
    id: '0109_drop_lead_ip',
    async isApplied(db) {
      if (!(await db.schema.hasTable('leads'))) return true;
      return !(await db.schema.hasColumn('leads', 'ip'));
    },
    async up(db) {
      if (!(await db.schema.hasTable('leads'))) return;
      if (!(await db.schema.hasColumn('leads', 'ip'))) return;

      const [linha] = await db('leads').whereNotNull('ip').count({ n: '*' });
      const total = Number(linha?.n || 0);
      if (total > 0) {
        console.warn(
          `0109_drop_lead_ip: descartando o IP de ${total} lead(s) — dado pessoal que `
          + 'nenhum código lia. Ver o comentário desta migration.'
        );
      }

      await db.schema.alterTable('leads', (t) => t.dropColumn('ip'));
    }
  },
  {
    /** O ritmo escolhido na Nova campanha. Ver `WA_BROADCAST_PACE_COLUMNS`. */
    id: '0110_wa_broadcast_pace',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_broadcasts'))) return true;
      return (await missingColumns(db, 'wa_broadcasts', WA_BROADCAST_PACE_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_broadcasts'))) return;
      const missing = await missingColumns(db, 'wa_broadcasts', WA_BROADCAST_PACE_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('wa_broadcasts', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /** As indicações dos clientes — ver `customerReferralsTable`. */
    id: '0111_customer_referrals',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('customer_referrals');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'customer_referrals', customerReferralsTable(db));
    }
  },
  {
    /** Os alertas para quem opera a plataforma — ver `platformAlertsTable`. */
    id: '0112_platform_alerts',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return true;
      return db.schema.hasTable('platform_alerts');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'platform_alerts', platformAlertsTable(db));
    }
  },
  {
    /** A citação de uma resposta — ver `WA_MESSAGE_REPLY_COLUMNS`. */
    id: '0113_wa_message_reply',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return true;
      return (await missingColumns(db, 'wa_messages', WA_MESSAGE_REPLY_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return;
      const missing = await missingColumns(db, 'wa_messages', WA_MESSAGE_REPLY_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('wa_messages', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    /** Reagir e apagar mensagens — ver `WA_MESSAGE_ACTION_COLUMNS`. */
    id: '0114_wa_message_actions',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return true;
      return (await missingColumns(db, 'wa_messages', WA_MESSAGE_ACTION_COLUMNS)).length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return;
      const missing = await missingColumns(db, 'wa_messages', WA_MESSAGE_ACTION_COLUMNS);
      if (!missing.length) return;
      await db.schema.alterTable('wa_messages', (t) => {
        for (const add of missing) add(t);
      });
    }
  }
];
export default migrations;
