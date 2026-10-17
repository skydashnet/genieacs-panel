import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { tenantSlugFromHost } from './tenantResolver.js';

/**
 * Renders the limiter body in the language negotiated for the request. The
 * `code` travels alongside it because it is stable across languages, which is
 * what a client needs to branch on.
 */
function limitMessage(key, code) {
  return (req) => ({ success: false, code, message: req.t(key) });
}

const JSON_HEADERS = {
  standardHeaders: true,
  legacyHeaders: false
};

/** O prefixo que um cliente IPv6 recebe, e portanto o que ele não pode trocar. */
const IPV6_SUBNET = 64;

/**
 * A chave de balde a partir do endereço: o /64 do cliente IPv6, o IPv4 inteiro.
 *
 * Um host IPv6 é dono de um prefixo inteiro, então limitar por endereço é
 * contornável trocando o último grupo. Colapsar era a intenção desde sempre; o
 * que mudou é que agora funciona.
 *
 * A conta era feita à mão e só acertava o endereço ESCRITO POR EXTENSO. A forma
 * comprimida — `2001:db8:0:1::1`, que é como praticamente todo endereço IPv6
 * aparece — caía num atalho que devolvia o endereço inteiro, e daí `::1` e
 * `::2` do mesmo /64 viravam dois baldes. O balde protegia contra quem não
 * estava tentando.
 *
 * Quem faz a conta agora é o `ipKeyGenerator` da própria biblioteca, que expande
 * antes de mascarar e ainda desembrulha o IPv4 mapeado (`::ffff:a.b.c.d`). O
 * padrão dela é /56; aqui fica /64, que é o que este painel escolheu e o que a
 * frase acima sempre disse. A zona (`%eth0`) sai antes, porque ela descreve a
 * interface local e não o cliente.
 *
 * Nada de IP — `'unknown'` quando não há endereço — atravessa sem ser tocado, e
 * vira um balde só, que é o certo: sem endereço não há de quem separar.
 */
export function ipKey(req) {
  const address = String(req.ip || req.socket?.remoteAddress || 'unknown').split('%')[0];
  return ipKeyGenerator(address, IPV6_SUBNET);
}

/**
 * The provider a request is addressed to, folded into the bucket key.
 *
 * The comment below on `accountKey` names the deployment this exists for: every
 * client arrives through one reverse proxy or tunnel, so one address is every
 * caller. On a deployment serving several ISPs that means ONE bucket for all of
 * them, and a single provider's traffic switches off everybody's panel.
 *
 * The slug is read from the host rather than from `req.tenantId`, because the
 * shared limiters are mounted ahead of the resolver — deliberately, so that a
 * flood is refused before it can cost a database read. A deployment without
 * subdomains yields the same empty discriminator for every request and keeps
 * exactly the buckets it has today.
 *
 * The cost is real and worth stating: somebody hitting N providers' hosts from
 * one address now gets N times the budget. That is the price of one provider
 * not being able to exhaust another's, and on a deployment where every request
 * shares a source address it is the cheaper of the two failures.
 */
function tenantScopeKey(req) {
  return tenantSlugFromHost(String(req.headers.host ?? '').split(':')[0].toLowerCase()) || '-';
}

/** Per source address, but never shared between providers. */
export function tenantIpKey(req) {
  return `${tenantScopeKey(req)}|${ipKey(req)}`;
}

/**
 * Portal limits must be per customer, not per source address: the recommended
 * deployment puts every client behind one reverse proxy or Cloudflare Tunnel,
 * where a shared bucket lets a single visitor exhaust the quota for everyone.
 */
function accountKey(req) {
  return req.customer?.id
    ? `account:${req.customer.id}`
    : `ip:${tenantIpKey(req)}`;
}

function limiter(options) {
  return rateLimit({ ...JSON_HEADERS, ...options });
}

export const apiLimiter = limiter({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

export const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.attempts', 'rate_limited_login')
});

/**
 * Login is unauthenticated, so the customer ID from the request body is the
 * only per-customer signal available. Pairing it with the source address keeps
 * one visitor's failures from locking out the rest of the customer base.
 */
/**
 * A página pública: o catálogo, o subdomínio livre, a consulta de CNPJ e o
 * pedido de demonstração. Por endereço, sem provedor — só existem no ápice.
 * A leitura é folgada (a página abre e digita); a consulta de CNPJ sai para
 * uma API de fora e o lead grava, então as duas têm balde apertado.
 */
export const publicReadLimiter = limiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

export const publicCnpjLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

export const publicLeadLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.attempts', 'rate_limited')
});

/**
 * A página de indicação, aberta sem sessão por quem recebeu o link. Por IP: o
 * limite protege a lista de lixo (cadastros em massa), e uma casa que indica
 * três amigos de uma vez não chega perto dele.
 */
export const referralSubmitLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.attempts', 'rate_limited')
});

export const portalLoginLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const customerId = String(req.body?.customerId ?? '').trim().toUpperCase().slice(0, 32);
    return `${tenantIpKey(req)}|${customerId || 'unknown'}`;
  },
  message: limitMessage('rateLimit.portalLogin', 'rate_limited_login')
});

/**
 * O convite, aberto sem sessão.
 *
 * Adivinhar não é a ameaça: são 32 bytes de `randomBytes`. O que este balde
 * segura é o custo — duas rotas sem autenticação que consultam o banco a cada
 * chamada, e a de aceitar ainda roda um bcrypt quando o nome existe. Chaveado
 * por provedor e endereço como o resto, para que um ISP barulhento não feche a
 * porta dos outros.
 */
/**
 * `POST /api/auth/email`: o cadastro do próprio endereço de login.
 *
 * A ação é rara — cada pessoa faz uma vez — e a resposta 409 é um oráculo: a
 * tabela `users` é uma só para a plataforma inteira, então "esse e-mail já está
 * em uso" responde se um endereço tem conta em ALGUM provedor, e quem tem
 * sessão em qualquer um deles pode perguntar. O oráculo é inerente à unicidade
 * global, que é o que faz o e-mail servir de identificador de login; o que se
 * tira dele é a escala. Dez por quarto de hora cobrem qualquer uso legítimo
 * com folga e transformam uma enumeração num gotejo.
 */
export const emailChangeLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * `POST /api/users`: criar um operador. O mesmo oráculo do limitador acima, na
 * mão de um administrador de provedor — e o mesmo remédio. Sessenta por quarto
 * de hora é uma equipe inteira cadastrada numa sentada, e não é uma varredura.
 */
export const operatorCreateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

export const inviteAcceptLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * O resgate do bilhete de personificação.
 *
 * Apertado porque é uma rota sem sessão que consulta o banco, e frouxo o
 * bastante para o caso real: uma pessoa do plantão da plataforma atende alguns
 * ISPs por hora, não alguns por segundo. O bilhete são 32 bytes e vale um
 * minuto, então adivinhar não é o risco — o balde existe para a rota não virar
 * bomba de tráfego.
 */
export const impersonationRedeemLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * "Esqueci minha senha": o pedido, que é público e manda e-mail.
 *
 * Apertado por dois motivos que se somam. O primeiro é que cada pedido aceito
 * dispara uma mensagem para o endereço de uma pessoa real, escolhido por quem
 * digita: sem balde, a rota é um canhão de spam apontado para a caixa de
 * entrada de qualquer operador cujo identificador alguém conheça — e o
 * remetente é o nosso domínio, então o preço é a reputação do correio do
 * painel. O segundo é a enumeração: a resposta é idêntica em todos os casos,
 * mas o TEMPO nunca é exatamente idêntico, e quem pode repetir o pedido dez mil
 * vezes mede a diferença. Cinco por quarto de hora e por par (provedor, IP)
 * cobrem quem errou a senha e tentou de novo, e não cobrem uma varredura.
 */
export const passwordResetLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * O resgate dos dois bilhetes que chegam por e-mail.
 *
 * Frouxo em relação ao pedido de propósito: aqui não se manda mensagem nenhuma
 * e não há o que enumerar — só um token de 32 bytes que existe ou não existe. O
 * balde é contra a rota virar bomba de tráfego, e a folga é para o caso real de
 * um cliente de e-mail que pré-abre links e de alguém que clica duas vezes.
 */
export const authTicketRedeemLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * Os dois arquivos públicos do agente do GenieACS (instalador e programa).
 *
 * Não há o que proteger neles — nenhum carrega segredo —, então o balde não é
 * contra enumeração: é contra alguém pôr um `curl` em laço e fazer o painel ler
 * o disco a cada volta. Quem instala pede cada arquivo uma vez, e reinstalar
 * dez máquinas seguidas atrás do mesmo NAT cabe com folga em trinta por minuto.
 */
export const agentFileLimiter = limiter({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/** Coarse per-address guard for the whole portal surface. */
export const portalIpLimiter = limiter({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: tenantIpKey,
  message: limitMessage('rateLimit.portalRequests', 'rate_limited')
});

export const portalAccountLimiter = limiter({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalRequests', 'rate_limited')
});

export const portalMutationLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalWifi', 'rate_limited_wifi')
});

export const portalRevealLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalPassword', 'rate_limited_reveal')
});

export const portalBillingLimiter = limiter({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalBilling', 'rate_limited_billing')
});

/**
 * Every trust unlock reaches the provider's billing system, so the portal
 * allows only a handful of attempts per account.
 */
export const portalUnlockLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: accountKey,
  message: limitMessage('rateLimit.portalUnlock', 'rate_limited_unlock')
});

/**
 * Operator SGP calls reach the provider's billing system on every request, so
 * they get a tighter budget than the generic API limiter allows.
 */
/**
 * A mensagem de teste do Telegram dos alertas. Cada clique é uma chamada ao
 * Telegram com o token do provedor e uma mensagem num grupo de gente: dez por
 * minuto sobram para quem está acertando o bot, e seguram um laço.
 */
export const telegramTestLimiter = limiter({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.telegramTest', 'rate_limited_telegram')
});

export const sgpAdminLimiter = limiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.sgpAdmin', 'rate_limited_sgp')
});

/**
 * Baixar o cadastro inteiro de um provedor, pelo console.
 *
 * Uma chamada lê TODA tabela escopada daquele provedor e monta o arquivo em
 * memória — é a leitura mais cara que o painel tem, e a única que cresce com o
 * tamanho do cliente em vez de com o tamanho da página. Um laço sobre a lista
 * de provedores, feito por engano ou por script, tira o banco do ar para todo
 * mundo enquanto roda.
 *
 * Seis por minuto: quem exporta um cliente para ajudá-lo não chega perto
 * disso, e quem está varrendo a base toda esbarra na segunda dúzia. Chaveado
 * por sessão e não por endereço, porque quem opera o console é uma pessoa
 * identificada — e porque todo o console costuma sair do mesmo escritório.
 */
export const platformExportLimiter = limiter({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.platformExport', 'rate_limited_export')
});

/**
 * Enfileirar mensagem, uma por chamada.
 *
 * O `apiLimiter` já cobre tudo sob `/api`, então isto não é uma porta aberta
 * que se fecha — é um teto mais justo para um ato que cria trabalho de saída.
 * A ENTREGA é estrangulada pelo worker, pelo teto por minuto que o provedor
 * configura; o enfileiramento não era, e 300 linhas por minuto por sessão
 * viram uma fila que o operador vê crescer sem entender por quê.
 *
 * Sessenta é muito acima de qualquer humano atendendo pela caixa de entrada e
 * muito abaixo do teto genérico, que é exatamente onde um limite destes tem
 * que ficar: invisível para quem trabalha, presente para quem não está
 * trabalhando.
 */
export const whatsappSendLimiter = limiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * Reenfileirar TODAS as falhas de uma janela.
 *
 * Teto próprio e muito mais apertado que o da vizinha porque os dois atos
 * diferem em três ordens de grandeza: aquela enfileira uma linha, esta pode
 * enfileirar milhares — um restart do Evolution no meio de uma régua de
 * cobrança falha a régua inteira, e é para isso que ela existe.
 *
 * Doze por minuto, e não quatro, porque a rota RECEBE a janela: "as falhas da
 * última hora" e "as das últimas seis" são dois pedidos diferentes, e o
 * operador que não sabe de quando é a queda tenta várias. A primeira versão
 * deste teto usava quatro, com o raciocínio de que a segunda chamada do minuto
 * já não teria o que fazer — o que só vale para a MESMA janela. Quem pegou foi
 * a suíte de `requeue-failed`, que exercita justamente as janelas.
 *
 * Ainda é vinte e cinco vezes mais apertado que o teto genérico, que é o ponto:
 * a chamada repetida é uma varredura sobre `wa_messages`, e mil por minuto é
 * carga de banco sem nada em troca.
 */
export const whatsappBulkRequeueLimiter = limiter({
  windowMs: 60 * 1000,
  max: 12,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * O teste da configuração do WhatsApp.
 *
 * Um clique aqui faz o painel emitir até quatro requisições de saída — duas
 * sondas ao servidor Evolution, uma listagem autenticada e a volta contra a
 * própria URL pública —, e todas para endereços que quem administra escolheu.
 * Seis por minuto cobre com folga alguém consertando um campo e testando de
 * novo, e é pouco o bastante para que este botão não vire um jeito de usar o
 * painel para bater em terceiros em rajada.
 *
 * O roteador de WhatsApp não tinha limitador nenhum; esta é a primeira rota
 * dele que precisa de um, e pelo motivo acima.
 */
export const whatsappTestLimiter = limiter({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/** A fleet sync calls the provider once per ONT, so it is rarer still. */
export const sgpSyncLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.sgpSync', 'rate_limited_sgp')
});

/**
 * TeiaH Valid: the connection test and the preview each call an outside API
 * (the preview the SGP too), so they get the SGP admin budget's shape.
 */
export const teiahAdminLimiter = limiter({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.teiah', 'rate_limited_teiah')
});

/** A run reads the invoices of every cancelled contract: as rare as a fleet sync. */
export const teiahExportLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.teiah', 'rate_limited_teiah')
});

/** Operator-side reveal/reset of a customer portal password. */
/**
 * The webhook is public, so it gets its own bucket rather than sharing the
 * one the panel's own UI draws from.
 */
export const sgpWebhookLimiter = limiter({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.requests')
});

/**
 * A entrega do gateway de pagamento, no mesmo desenho do webhook do SGP: rota
 * pública, balde próprio.
 *
 * Mais apertado que o do SGP de propósito. O ERP de um provedor manda um evento
 * por mudança de contrato e um deploy grande tem muitos contratos; o gateway
 * manda um punhado de eventos por PAGAMENTO, e há uma assinatura por provedor
 * por mês. Trinta por minuto cobre uma reentrega em massa depois de uma queda
 * nossa e continua sendo um teto que um atacante não atravessa de graça.
 */
export const billingWebhookLimiter = limiter({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.requests')
});

/**
 * Provisioning actions write to a subscriber's CPE and each one waits on a
 * connection request, so they are limited per operator on top of the shared
 * API limit rather than by source address.
 */
export const provisioningActionLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.provisioningAction')
});

/**
 * Ping e traceroute pela ONT. A tela consulta o resultado a cada cinco
 * segundos enquanto a ONT roda, e cada consulta pode virar uma tarefa no ACS:
 * quarenta por minuto por operador cobre três diagnósticos seguidos e segura a
 * aba esquecida aberta.
 */
export const deviceDiagnosticLimiter = limiter({
  windowMs: 60 * 1000,
  max: 40,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * `POST /api/devices/factory-reset`: o reset pede a senha do operador, duas
 * vezes. Quem tem só o token roubado poderia usar a rota para adivinhar a
 * senha; dez ERROS por quarto de hora, por operador, deixam isso sem valor.
 * Um reset que deu certo não conta.
 */
export const factoryResetLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * `DELETE /api/devices/:deviceId`: a remoção do GenieACS pede a senha do mesmo
 * jeito que o reset, e pelo mesmo motivo tem o mesmo teto — num contador à
 * parte, para que os erros de uma não bloqueiem a outra.
 */
export const deviceDeleteLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * O login em duas etapas da própria conta: ativar, desligar, trocar os códigos.
 * Por pessoa, e apertado: cada tentativa é um palpite nos 6 dígitos, e quem
 * tenta desligar o 2FA de uma sessão roubada não pode ter palpites à vontade.
 */
export const mfaLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.attempts', 'rate_limited')
});

export const portalPasswordAdminLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : `ip:${ipKey(req)}`),
  message: limitMessage('rateLimit.portalPasswordAdmin', 'rate_limited')
});

/**
 * The Evolution webhook is a public endpoint, so it needs its own bucket — but
 * a generous one. A busy number legitimately produces a burst: every QR
 * rotation (~20 s), every message, and one receipt per recipient per delivery
 * state. Sizing this like a login form would drop real traffic, and a dropped
 * event is a message that never appears in the inbox.
 *
 * The key is the source address because all events come from one server; the
 * ceiling is what protects against that server, or something pretending to be
 * it, hammering the panel.
 */
export const waWebhookLimiter = limiter({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: ipKey,
  message: { success: false, error: 'too many webhook deliveries' }
});

/**
 * The signed media route the Evolution server fetches an attachment from.
 *
 * Its own bucket for the same reason as the webhook's — no session to key on —
 * and lower, because one fetch per outbound attachment is a far quieter shape
 * than one delivery receipt per recipient per state. It also reads a file off
 * the disk, which the webhook does not.
 */
export const waMediaLimiter = limiter({
  windowMs: 60 * 1000,
  max: 240,
  keyGenerator: ipKey,
  message: { success: false, error: 'too many media fetches' }
});

/**
 * The operator's attachment upload, limited BEFORE its body is read.
 *
 * This one is not about the route's own cost — it is about the 16 MB the raw
 * parser is willing to hold. That parser is reserved on the path early, ahead
 * of the shared `apiLimiter`, because the global JSON parser would otherwise
 * claim the body first; the effect was that an anonymous caller could make the
 * panel buffer 16 MB before anything had the chance to refuse the request.
 *
 * The key is the source address rather than the session, deliberately: it has
 * to count a caller that has NO session, which is exactly the case worth
 * refusing. The ceiling is sized for a human attaching files, not for a
 * campaign — outbound campaign attachments are uploaded once and reused.
 */
export const attachmentUploadLimiter = limiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});

/**
 * O envio de firmware ao GenieACS (do provedor e o reenvio da plataforma),
 * limitado ANTES de o corpo ser lido, pelo mesmo motivo do anexo acima — só que
 * aqui o parser aceita até 64 MB por pedido. Pelo endereço de origem, para
 * contar também quem não tem sessão. Firmware se envia de vez em quando, um
 * arquivo por vez: 30 por minuto é folga para quem trabalha e pouco para quem
 * quer encher a memória do painel.
 */
export const firmwareUploadLimiter = limiter({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: ipKey,
  message: limitMessage('rateLimit.requests', 'rate_limited')
});
