import SubscriptionService, { GATE_CODES } from '../services/subscriptionService.js';
import { IS_SAAS } from '../config/edition.js';

/**
 * A porta da assinatura, chamada DEPOIS da autenticação.
 *
 * Ela já ficou logo depois do resolvedor, como `app.use('/api', …)`, e a razão
 * era boa: a tela de bloqueio deveria aparecer também para quem ainda nem
 * entrou. O preço, que só aparece quando se olha para a resposta de um
 * ESTRANHO, é alto demais. Ali a porta responde antes do 401, então um
 * `GET /api/devices` sem token nenhum devolve 402 num provedor inadimplente e
 * 401 num em dia — e o corpo do 402 ainda trazia o plano. Qualquer um que
 * alcance o host, e o host é público, varre e descobre quais ISPs estão
 * atrasados na fatura.
 *
 * Isso é exatamente o que `tenantController.getPublicProfile` proíbe, com
 * estas palavras: não distinguir "não existe" de "existe e está suspenso",
 * «um fato sobre o negócio de outra pessoa que estaríamos publicando». A porta
 * no lugar antigo violava a regra de outro arquivo, que é como uma regra assim
 * costuma cair.
 *
 * Chamada de dentro de `authenticateToken` e de `authenticatePortalCustomer`,
 * a ordem 401-antes-de-402 passa a ser garantida por construção, e o operador
 * do provedor bloqueado continua vendo a placa do muro: `/api/auth/*` está
 * fora da porta, ele entra normalmente, e a primeira chamada autenticada
 * devolve o 402 com o código que a tela lê. O que se perde é mostrar o muro a
 * um visitante deslogado — que é precisamente a parte que vazava.
 *
 * Roda dentro do escopo que a sessão abriu, e é isso que a deixa ler a
 * assinatura por `tdb` sem saber o id.
 *
 * O que NÃO passa por ela, e por quê, um a um:
 *
 *   /api/auth/*          Entrar tem que funcionar num provedor bloqueado: é
 *                        entrando que o operador vê o aviso, e é entrando que
 *                        um administrador da plataforma chega ao console. Na
 *                        posição nova a maioria destas rotas já não passaria
 *                        pela porta de todo jeito — a lista fica porque uma
 *                        isenção que depende de a rota continuar sem sessão é
 *                        uma isenção que some no dia em que alguém a autentica.
 *   /api/tenant/public   O nome do provedor na tela de login e de bloqueio.
 *   /api/tenant/subscription  O que a tela de bloqueio mostra: estado, plano,
 *                        até quando. Sem isto o 402 seria um muro sem placa.
 *   /api/tenant/charges  E onde se paga. A isenção anterior dá a placa; esta dá
 *                        a saída: quem está bloqueado é precisamente quem
 *                        precisa do link da cobrança em aberto, e sem ela a
 *                        rota responderia 402 a quem está tentando pagar. Só
 *                        leitura, e só do provedor em escopo.
 *   /api/tenant/plans    O catálogo, com preço. Quem está em `past_due` é
 *                        quem compara planos antes de pagar; só leitura.
 *   /api/tenant/subscription/plan  A troca de plano. É escrita, e passa mesmo
 *                        assim: descer para um plano mais barato é uma das
 *                        saídas de quem está atrasado, e recusá-la com 402
 *                        trancaria a porta pelo lado de dentro. `suspended` e
 *                        `canceled` NÃO passam — quem os recusa é o
 *                        controlador (409 `not_changeable`), porque essas são
 *                        decisões de gente e a saída delas é o console.
 *   /api/tenant/charges/pay  "Pagar agora". Escrita também, e é a saída mais
 *                        direta de todas: um 402 aqui seria o muro recusando o
 *                        pagamento de quem está tentando derrubá-lo. O
 *                        controlador recusa quem não é cobrável (suspenso,
 *                        cancelado, plano de graça), e nada do corpo decide
 *                        valor, período ou gateway.
 *   /api/platform/*      O plano de controle vive ACIMA das assinaturas; um
 *                        provedor cancelado é justamente um que o console
 *                        precisa alcançar.
 *
 * Os webhooks (ERP, Evolution) não têm sessão, então na posição nova não
 * chegam aqui e passam SEMPRE — antes passavam só em `past_due`. A diferença é
 * deliberada e vai na mesma direção do resto: recusar um evento do ERP perde
 * dado de quem não deve nada (o assinante), e um 402 numa entrega anônima
 * seria o mesmo oráculo de enumeração por outra porta. A regra de leitura em
 * `past_due` continua em `SubscriptionService.decide` para quem tem sessão.
 *
 * Só existe na edição SaaS — quem monta é `app.js`, e monta atrás de
 * `IS_SAAS`. Na self-hosted não há assinatura para cobrar, e a migração deu a
 * todo provedor existente um plano sem limites em `active`, então mesmo que
 * fosse montada ela deixaria tudo passar.
 */
const EXEMPT_PREFIXES = ['/api/auth/', '/api/platform/', '/api/health'];
const EXEMPT_PATHS = new Set([
  '/api/tenant/public',
  '/api/tenant/subscription',
  '/api/tenant/charges',
  '/api/tenant/plans',
  '/api/tenant/subscription/plan',
  '/api/tenant/charges/pay',
  // O cupom (0093): como a troca de plano, uma saída de quem está atrasado.
  '/api/tenant/subscription/coupon',
  // O cartão recorrente (0100): desligar ou remover o cartão recusado é o que
  // devolve a fatura de quem está atrasado para Pix/boleto.
  '/api/tenant/subscription/autopay',
  '/api/tenant/subscription/card',
  // A indicação (0106): o saldo de crédito na mesma tela de Plano que quem
  // está bloqueado usa para pagar — e o crédito é parte do que ele vai pagar.
  '/api/tenant/referrals',
  // A retenção no cancelamento (0107): pedir para cancelar, aceitar uma
  // oferta, confirmar e desfazer — quem está atrasado (ou pausado) também
  // pode querer sair, ou ficar.
  '/api/tenant/subscription/cancellation',
  '/api/tenant/subscription/cancellation/accept',
  '/api/tenant/subscription/cancellation/confirm',
  '/api/auth'
]);
// Os caminhos EXATOS das entregas de fora. `/api/sgp/events` sem o
// `/webhook` é a listagem autenticada e o retry — escrita de operador, que em
// `past_due` tem que ser recusada como qualquer outra. O do Evolution está
// montado ANTES do resolvedor em `app.js`, então nunca chega aqui; fica na
// lista pelo dia em que alguém o mover para baixo.
const WEBHOOK_PREFIXES = ['/api/sgp/events/webhook', '/api/whatsapp-webhook'];

function isExempt(path) {
  if (EXEMPT_PATHS.has(path)) return true;
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isWebhook(path) {
  return WEBHOOK_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

const MESSAGE_KEYS = Object.freeze({
  [GATE_CODES.PAST_DUE]: 'subscription.pastDue',
  [GATE_CODES.TRIAL_EXPIRED]: 'subscription.trialExpired',
  [GATE_CODES.SUSPENDED]: 'subscription.suspended',
  [GATE_CODES.CANCELED]: 'subscription.canceled',
  [GATE_CODES.MISSING]: 'subscription.missing',
  [GATE_CODES.PAUSED]: 'subscription.paused'
});

/**
 * @param {{ portal?: boolean }} options `portal` é o app do assinante, onde
 *   `past_due` passa inteiro — ler E escrever — porque o assinante não é quem
 *   deve, e o autoatendimento dele é o que o plano manda manter de pé.
 */
export async function subscriptionRefusal(req, { portal = false } = {}) {
  // A edição, conferida AQUI e não em `app.js`.
  //
  // Enquanto a porta era um `app.use`, quem a mantinha fora da self-hosted era
  // o `if (IS_SAAS)` que a montava. Chamada de dentro da autenticação, que roda
  // nas duas edições, essa guarda tinha de vir junto — sem ela, um painel
  // self-hosted passa a exigir assinatura de si mesmo.
  if (!IS_SAAS) return null;
  // `req.originalUrl` e não `req.path`: dentro de um router montado, o `path`
  // que o Express entrega já perdeu o prefixo, e a isenção fala do caminho
  // inteiro.
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (!portal && isExempt(path)) return null;

  const state = await SubscriptionService.current();
  const decision = SubscriptionService.decide(state.subscription, {
    method: req.method,
    // No portal, tudo é leitura para efeito da porta: ver o comentário acima.
    webhook: portal || isWebhook(path)
  });
  if (decision.allowed) return null;

  const key = MESSAGE_KEYS[decision.code] || 'subscription.suspended';
  return {
    success: false,
    code: decision.code,
    message: req.t ? req.t(key) : decision.code,
    subscription: SubscriptionService.present(state)
  };
}

export default subscriptionRefusal;
