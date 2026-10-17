/**
 * O que cada papel pode fazer, dito por capacidade e não por cargo.
 *
 * Até aqui o painel tinha dois papéis — `admin` e `viewer` — e **91 rotas
 * guardadas por `requireRole(['admin'])`**. Na prática isso é um papel só: quem
 * não é administrador não alcança nem a tela de um aparelho. Num provedor de
 * verdade quem está de plantão precisa reiniciar uma ONT às três da manhã e não
 * precisa — nem deve — poder apagar operador, ler a chave do ERP ou trocar o
 * banco de dados.
 *
 * A guarda passa a nomear **o que a rota faz**, não quem pode. `requireRole`
 * espalhava a política por 91 arquivos de rota: acrescentar um papel obrigava a
 * reabrir os 91 e decidir de novo, um a um, e o esquecimento não aparece em
 * lugar nenhum — a rota simplesmente continua exigindo `admin`. Com a
 * capacidade escrita na rota, a política inteira cabe na matriz abaixo, que é
 * uma coisa só para ler e revisar.
 *
 * ## A regra que fixou o recorte
 *
 * **Nenhuma rota fica alcançável por quem não a alcança hoje.** Por isso o
 * `viewer` recebe exatamente o conjunto que hoje NÃO tem `requireRole` — lista
 * de aparelhos, mapa, catálogo — e nada mais. Tudo que hoje é `admin` continua
 * exigindo `admin`, ou passa a exigir `tech`, que é papel novo e portanto não
 * tira nada de ninguém. Quem já usa o painel não perde acesso a nada no dia da
 * migração, e é isso que permite entregar a mudança sem uma conversa com cada
 * install.
 */

/**
 * Os quatro papéis, do mais para o menos poderoso.
 *
 * `owner` e `admin` carregam o mesmo conjunto de capacidades: a diferença entre
 * eles não é uma rota, é quem pode mexer em quem — só um `owner` promove ou
 * rebaixa outro `owner`, e essa regra vive no controlador de operadores, onde
 * estão os outros invariantes da mesma família (não se rebaixar sozinho, não
 * deixar o provedor sem administrador). Um papel não descreve bem "pode mexer
 * no papel do vizinho", e fingir que descreve seria colocar na matriz uma
 * capacidade que nenhuma rota consulta.
 */
export const ROLES = Object.freeze(['owner', 'admin', 'tech', 'viewer']);

/** O papel de quem entra sem que ninguém tenha dito qual é. */
export const DEFAULT_ROLE = 'viewer';

/**
 * Toda capacidade que uma rota pode exigir.
 *
 * Os nomes são por assunto e verbo, e a separação entre `read` e `write` só
 * existe onde algum papel fica de um lado e não do outro — capacidade que
 * nenhum papel tem sem a outra é nome a mais para manter em dia.
 */
export const PERMISSIONS = Object.freeze([
  // A frota. `list` é a tela que todo mundo vê; `inspect` é o aparelho aberto,
  // com seus parâmetros e o assinante atrás dele; `write` é o que muda o
  // equipamento do assinante.
  'devices.list',
  'devices.inspect',
  'devices.write',
  // O que não tem volta ou atinge a ONT inteira: reset de fábrica (e, a seguir,
  // firmware e ações em lote). Separada de `devices.write` porque o plantão
  // reinicia e ajusta Wi-Fi o dia todo, e não precisa, por consequência, poder
  // apagar a configuração do cliente — um reset deixa o assinante sem internet
  // até alguém reprovisionar.
  'devices.maintain',
  // A lista de equipamentos inteira num arquivo (série, PPPoE, ID do cliente).
  // Separada de `devices.list` como `contacts.export` é de `contacts.read`: ver
  // página por página não é o mesmo que levar a base toda de uma vez.
  'devices.export',
  // Revelar ou redefinir a senha do portal do assinante. Separada de
  // `devices.write` de propósito: é a única rota do painel que devolve um
  // segredo de outra pessoa, e quem pode reiniciar uma ONT não precisa dela por
  // consequência.
  'customers.secrets',
  'map.read',
  'map.write',
  'catalogue.read',
  'catalogue.write',
  // O ERP. `read` é consultar contrato e vínculo; `act` é o que mexe no ERP ou
  // no assinante (desbloqueio, chamado, religa, reconciliação); `config` é a
  // credencial e o segredo do webhook.
  'sgp.read',
  'sgp.act',
  'sgp.config',
  // A TeiaH Valid. `read` é ver o que foi enviado; `act` é disparar um envio,
  // que manda endereço e dívida de ex-assinantes para fora do painel — por isso
  // fica com quem responde pelo provedor, e não com o plantão; `config` é a
  // chave de API.
  'teiah.read',
  'teiah.act',
  'teiah.config',
  // O provisionamento. `run` dispara uma passada — escreve no CPE, é do
  // plantão; `write` muda a regra que decide o que será escrito, que é decisão
  // de quem responde pelo provedor.
  'provisioning.read',
  'provisioning.run',
  'provisioning.write',
  // O WhatsApp. `send` é falar como o provedor; `config` é a instância, o
  // servidor Evolution e os alertas.
  'whatsapp.read',
  'whatsapp.send',
  'whatsapp.config',
  // Campanhas, modelos e a lista de não perturbe. Disparar para centenas de
  // pessoas não é ato de plantão.
  'campaigns.read',
  'campaigns.manage',
  // A ficha completa do cliente do SGP. `read` é abrir a ficha, com o CPF
  // inteiro, o endereço e todos os contatos; `edit` é corrigir o cadastro no
  // painel. `export` e `import` são a base inteira numa planilha, e por isso
  // não são do plantão: o mesmo argumento de `tenant.export`. `settle` é dar
  // baixa num título no SGP pelo botão Receber — o plantão recebe no balcão.
  'contacts.read',
  'contacts.edit',
  'contacts.settle',
  'contacts.export',
  'contacts.import',
  'settings.read',
  'settings.write',
  'operators.read',
  'operators.manage',
  // Ler a trilha das ações sensíveis. Separada de `operators.read` porque a
  // trilha diz mais do que a equipe: quem revelou a senha de qual assinante, e
  // quando. Quem pode ver a lista de colegas não recebe isso de brinde.
  'audit.read',
  // Levar o cadastro do provedor embora. Capacidade própria porque é a única
  // rota que devolve TUDO de uma vez: quem administra a operação não recebe de
  // brinde o direito de baixar o cadastro inteiro num arquivo.
  'tenant.export',
  // Baixar o dossiê de UM assinante — o direito de acesso da LGPD, do lado de
  // quem tem que atendê-lo. Capacidade própria pelo mesmo motivo de
  // `tenant.export` e por mais um: quem atende o balcão precisa ver a ficha do
  // assinante o dia inteiro (`devices.list`), e não precisa poder baixar a vida
  // dele num arquivo por consequência.
  'customers.dossier',
  // E apagá-la — o direito de eliminação. Separada da de cima ainda que hoje as
  // duas caiam nos mesmos papéis: entregar a tarefa de atender pedidos da LGPD
  // não pode ser a mesma coisa que entregar o poder de destruir, e uma delas
  // não tem volta. Um nome a mais hoje é o que permite a decisão amanhã.
  'customers.erase',
  // Trocar o banco em runtime, que só existe na edição self-hosted.
  'database.manage'
]);

const PERMISSION_SET = new Set(PERMISSIONS);

/** Quem lê. Exatamente as rotas que hoje não pedem papel nenhum. */
const VIEWER = [
  'devices.list',
  'map.read',
  'catalogue.read'
];

/** O plantão: mexe em equipamento e fala com assinante; não mexe em configuração nem em gente. */
const TECH = [
  ...VIEWER,
  'devices.inspect',
  'devices.write',
  'customers.secrets',
  'map.write',
  'sgp.read',
  'sgp.act',
  'teiah.read',
  'provisioning.read',
  'provisioning.run',
  'whatsapp.read',
  'whatsapp.send',
  'campaigns.read',
  'contacts.read',
  'contacts.edit',
  'contacts.settle'
];

/** Administra a operação do provedor. */
const ADMIN = [
  ...TECH,
  'devices.maintain',
  'devices.export',
  'catalogue.write',
  'sgp.config',
  'teiah.act',
  'teiah.config',
  'provisioning.write',
  'whatsapp.config',
  'campaigns.manage',
  'contacts.export',
  'contacts.import',
  'settings.read',
  'settings.write',
  'operators.read',
  'operators.manage',
  'audit.read',
  'tenant.export',
  'customers.dossier',
  'customers.erase',
  'database.manage'
];

const MATRIX = Object.freeze({
  owner: Object.freeze(new Set(ADMIN)),
  admin: Object.freeze(new Set(ADMIN)),
  tech: Object.freeze(new Set(TECH)),
  viewer: Object.freeze(new Set(VIEWER))
});

/**
 * O papel tal como vale para a autorização.
 *
 * Linhas escritas antes de os papéis existirem carregam `'user'`, que era o
 * default da coluna, e as memberships que a migração 0028 preencheu carregam o
 * que a pessoa tinha em `users.role`. Qualquer coisa que não seja um papel
 * conhecido cai em `viewer` — a direção segura, e a mesma leitura que
 * `usersController` já fazia quando os papéis eram dois.
 */
export function normalizeRole(role) {
  const name = String(role ?? '').trim().toLowerCase();
  return ROLES.includes(name) ? name : DEFAULT_ROLE;
}

/** As capacidades de um papel, como Set. Papel desconhecido responde como `viewer`. */
export function permissionsOf(role) {
  return MATRIX[normalizeRole(role)];
}

/**
 * Se um papel tem uma capacidade.
 *
 * Uma capacidade que não existe responde **false** e não "true por não estar
 * proibida": a guarda erra fechando. Um nome errado numa rota vira 403 para
 * todo mundo, inclusive para o dono do provedor, que é falha barulhenta e
 * corrigida no mesmo dia — enquanto "não conheço, deixa passar" abre a rota
 * para o `viewer` e não aparece em lugar nenhum. `assertKnownPermissions()`
 * abaixo é o que transforma esse 403 em erro de teste antes de virar produção.
 */
export function roleHas(role, permission) {
  if (!PERMISSION_SET.has(permission)) return false;
  return permissionsOf(role).has(permission);
}

/**
 * Confere que toda capacidade citada existe. Chamada pelos testes, não no
 * import: um nome errado tem que ser falha nomeada e não um boot que não sobe.
 */
export function unknownPermissions(names) {
  return [...new Set(names)].filter((name) => !PERMISSION_SET.has(name));
}

/**
 * As capacidades que nenhum papel tem.
 *
 * Uma capacidade órfã é rota que ninguém alcança — inclusive o dono. Vale ser
 * falha de teste e não descoberta pelo suporte.
 */
export function orphanPermissions() {
  return PERMISSIONS.filter(
    (permission) => !ROLES.some((role) => MATRIX[role].has(permission))
  );
}
