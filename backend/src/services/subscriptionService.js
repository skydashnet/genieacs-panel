import Plan from '../models/Plan.js';
import Subscription, { SUBSCRIPTION_STATUSES } from '../models/Subscription.js';
import BillingEvent, { BILLING_EVENT_TYPES } from '../models/BillingEvent.js';
import BillingCharge, { isoDateOf, prorationOverdueAt } from '../models/BillingCharge.js';
import AuditLog from '../models/AuditLog.js';
import PlatformAlertService from './platformAlertService.js';
import PlatformAudit from '../models/PlatformAudit.js';
import Coupon, { parseCouponPlanIds } from '../models/Coupon.js';
import UsagePeak, { USAGE_RESOURCES } from '../models/UsagePeak.js';
import { getDb, tdb, isUniqueViolation } from '../config/database.js';
import { TenantCache } from '../config/tenantCache.js';
import { currentTenantId, runInTenant } from '../config/tenantContext.js';
import { IS_SAAS } from '../config/edition.js';
import { effectiveChargesConfig, earlyDiscountFor } from './billing/asaasSettingsService.js';
import TenantCredit from '../models/TenantCredit.js';
import ReferralService from './referralService.js';

/**
 * O ciclo de vida da assinatura, e o que cada estado deixa fazer.
 *
 * Cinco estados e uma regra por estado — é toda a política, e está aqui e em
 * lugar nenhum mais: o gate pergunta, os limites perguntam, o console pergunta.
 *
 *   trial      passa. Vira `past_due` sozinho quando `trial_ends_at` vence —
 *              sem job, sem cron: é calculado na leitura, então não há janela
 *              em que um teste vencido ainda passe porque o job não rodou.
 *   active     passa — até `renews_at` vencer, e aí vira `past_due` pela mesma
 *              mecânica e pelo mesmo motivo. `renews_at` nulo é assinatura sem
 *              ciclo e não vence; ver `effectiveStatus`.
 *   past_due   passa SÓ PARA LER. Operador atrasado continua vendo a frota e
 *              o assinante continua com o portal de pé; o que para é escrever.
 *              Derrubar o autoatendimento dos clientes finais de um ISP por
 *              fatura atrasada é um tiro no pé comercial — o plano é explícito.
 *   suspended  402. Nós desligamos: inadimplência longa, abuso, o que for.
 *              Dois motivos (`suspended_reason`, 0102): `auto_nonpayment` é
 *              a suspensão automática do agendador, `autoSuspendDays` depois
 *              do vencimento (ver `autoSuspensionStep`), e o PAGAMENTO a
 *              desfaz sozinho — a cobrança, o "pagar agora" e o webhook
 *              continuam valendo para ela. `manual` (ou nulo, de antes da
 *              coluna) é gente, e só gente desfaz: o console.
 *   canceled   402. O contrato acabou; o que resta é exportar e apagar.
 *
 * `suspended` aqui e `tenants.status = 'suspended'` são DUAS chaves, de
 * propósito. A do provedor é operacional: para os jobs de fundo, recusa o
 * webhook do ERP. A da assinatura é comercial: o que o operador vê ao entrar.
 * Uma inadimplência não precisa parar o alerta de ONT caída do assinante, e
 * uma parada operacional não é uma cobrança.
 */
export const STATUSES = SUBSCRIPTION_STATUSES;

/** Códigos que o frontend lê. Estáveis: a tela de bloqueio escolhe o texto por eles. */
export const GATE_CODES = Object.freeze({
  PAST_DUE: 'subscription_past_due',
  TRIAL_EXPIRED: 'subscription_trial_expired',
  SUSPENDED: 'subscription_suspended',
  CANCELED: 'subscription_canceled',
  MISSING: 'subscription_missing',
  // A pausa aceita como retenção (0107): o painel só lê até `paused_until`.
  PAUSED: 'subscription_paused'
});

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Quanto tempo o gate confia na última leitura antes de perguntar de novo. */
const CACHE_TTL_MS = 15_000;
const cache = new TenantCache(CACHE_TTL_MS);
// O vencimento da pró-rata (0101) entra no estado que vale: quem o regrava
// (`BillingCharge.syncProrationDue`) esquece a leitura em cache do provedor.
BillingCharge.onProrationDueChanged = () => cache.invalidate();

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Qual agendamento de cada provedor já foi avisado como bloqueado pelo uso.
 *
 * Em memória e não no banco: é só para o agendador não repetir a mesma linha
 * de log a cada minuto. Um reinício avisa de novo uma vez, o que é até bom.
 */
const avisosDeBloqueio = new Map();

/**
 * O período pago de quem não tem período no plano.
 *
 * Deixou de ser A verdade e virou a reserva: o prazo agora sai de
 * `plans.period_days` (migração 0046), do mesmo jeito que os dias de teste
 * sempre saíram de `plans.trial_days`. Trinta continua aqui porque é o que toda
 * assinatura deste deploy comprou até hoje — a reserva tem que dizer a verdade
 * sobre o passado, e não um número escolhido agora.
 *
 * Vale para o plano que a coluna ainda não alcançou e para a assinatura cujo
 * plano sumiu debaixo dela. Nos dois casos a alternativa seria não creditar
 * período nenhum, que transforma um dado faltando em um cliente bloqueado.
 */
const PAID_PERIOD_DAYS = 30;

/**
 * O menor valor que um cupom deixa uma fatura ter: R$ 5,00, o mínimo que o
 * Asaas aceita numa cobrança. Sem piso, um desconto grande daria uma fatura
 * que o gateway recusa — ou, no limite, uma de valor zero, que exigiria um
 * caminho de dinheiro que não existe (período pago sem pagamento). Um plano
 * que já custa menos que o piso fica com o preço dele: o cupom não sobe preço.
 */
export const COUPON_FLOOR_CENTS = 500;

/** Os dias que um pagamento compra neste plano, ou a reserva. */
function periodoDoPlano(plano) {
  const dias = Number(plano?.period_days);
  return Number.isFinite(dias) && dias > 0 ? Math.floor(dias) : PAID_PERIOD_DAYS;
}

/**
 * Os ciclos de cobrança (0104). `monthly` é o de sempre: `price_cents` por
 * `period_days`. `annual` é `price_yearly_cents` por `ANNUAL_PERIOD_DAYS`.
 */
export const BILLING_CYCLES = Object.freeze(['monthly', 'annual']);

/** Quanto o ciclo anual compra. Fixo: "anual" é um ano, e não o período do plano vezes doze. */
export const ANNUAL_PERIOD_DAYS = 365;

/** O preço anual do plano, ou nulo quando ele não oferece o ciclo anual. */
function precoAnualDe(plano) {
  const valor = Number(plano?.price_yearly_cents);
  return Number.isFinite(valor) && valor > 0 ? Math.floor(valor) : null;
}

/**
 * O cupom de retenção do ciclo anual (0107 + 0104): o desconto de N meses da
 * configuração levado a UMA fatura anual. É do sistema, como o de retenção.
 */
export const ANNUAL_RETENTION_KIND = 'retention_annual';

export function isAnnualRetentionCoupon(coupon) {
  return coupon?.system_kind === ANNUAL_RETENTION_KIND;
}

/** Se o plano pode ser cobrado no ciclo anual: só com `price_yearly_cents`. */
export function annualAvailable(plan) {
  return precoAnualDe(plan) !== null;
}

/** Um ciclo lido de fora (corpo, coluna), ou nulo quando não é um dos dois. */
export function parseBillingCycle(value) {
  const ciclo = String(value ?? '').trim().toLowerCase();
  return BILLING_CYCLES.includes(ciclo) ? ciclo : null;
}

/**
 * Quanto foi pedido por este pagamento, e em que moeda — ou nada, quando não
 * dá para dizer.
 *
 * Duas fontes, nesta ordem, e a ordem é a diferença entre uma conferência e um
 * palpite:
 *
 *   1. **A cobrança que o painel emitiu**, achada pelo id do gateway. É o valor
 *      que nós pedimos, congelado no instante em que pedimos. O plano pode ter
 *      mudado de preço depois — e se mudou, quem pagou pagou o que viu.
 *   2. **O preço do plano.** É a única resposta para a cobrança criada à mão no
 *      painel do gateway, que é como os primeiros contratos são cobrados, e
 *      para o botão do console.
 *
 * Devolve nulo quando não há referência (plano sem preço: todo provedor
 * herdado está no `unlimited`, que custa zero — ali nada foi pedido e qualquer
 * valor é um presente, não um pagamento a menos) e quando a moeda do pagamento
 * não é a da referência: comparar centavos de moedas diferentes não é uma
 * conferência frouxa, é uma conta errada.
 */
async function valorPedido({ externalId, plano, currency, precoDoPlano = null, chargeId = null }) {
  const moedaPaga = String(currency || '').toUpperCase();

  // 1a. A cobrança que NUNCA chegou ao gateway, marcada paga à mão pelo
  //     console: sem id do lado de lá, a baixa manual usa `charge:<id da
  //     linha>` como referência (ver `PlatformSubscriptionsController.settle`),
  //     e é por ele que a linha se acha. Sem isto, a conferência cairia no
  //     preço do plano — e uma cobrança cujo valor o console acabou de ajustar
  //     seria conferida contra um número que não é o que se pediu. `tdb` por
  //     baixo: o id de uma linha do vizinho simplesmente não é achado.
  const daLinha = /^charge:(\d+)$/.exec(String(externalId ?? ''));
  let cobranca = !externalId
    ? null
    : daLinha
      ? await BillingCharge.findById(Number(daLinha[1]))
      : await BillingCharge.byGatewayId(externalId);
  // 1c. A cobrança nomeada por quem chama — o aceite da diferença de uma
  //     pró-rata paga a menos (`<referência>:accepted`), cuja referência não
  //     acha linha nenhuma: sem isto ele seria conferido contra o preço do
  //     plano e estenderia o período como uma renovação.
  if (!cobranca && chargeId) cobranca = await BillingCharge.findById(Number(chargeId));
  if (cobranca) {
    const valor = Number(cobranca.amount_cents);
    if (Number.isFinite(valor) && valor > 0) {
      const moeda = String(cobranca.currency || '').toUpperCase();
      if (moeda && moeda !== moedaPaga) return { cents: null, motivo: 'currency_mismatch', fonte: 'charge' };
      // `overridden`: o valor foi mudado à mão pelo console (0078) e não é o
      // preço de plano nenhum — ver o destino da descida em `recordPayment`.
      // `planId`/`couponId`: com que plano e cupom ela foi emitida (0093),
      // quando a linha o diz — nulo `planId` é cobrança feita à mão ou de
      // antes das colunas, e aí só o valor responde.
      const temPreco = cobranca.plan_id !== null && cobranca.plan_id !== undefined;
      return {
        cents: Math.floor(valor),
        // O preço sem o crédito reservado nela (0106): é ele que diz QUAL
        // plano a cobrança cobrou — `cents` é o que se esperava receber.
        baseCents: Math.floor(valor) + BillingCharge.creditReservedOf(cobranca),
        // O preço do PLANO (já com o cupom) que a conta dela diz (0105) — sem
        // o excedente nem o crédito: é o que a receita compara com o preço
        // cheio para estimar o desconto. Nulo sem conta, ou com o valor
        // mudado à mão (aí o valor inteiro é a decisão de gente).
        planBaseCents: (() => {
          if (cobranca.amount_overridden_at) return null;
          const base = Number(BillingCharge.pricingDetailOf(cobranca)?.base);
          return Number.isFinite(base) && base >= 0 ? Math.floor(base) : null;
        })(),
        motivo: null,
        fonte: 'charge',
        // A fatura de pró-rata (0101) não compra período: ver `recordPayment`.
        kind: cobranca.kind || 'renewal',
        chargeId: Number(cobranca.id),
        overridden: Boolean(cobranca.amount_overridden_at),
        // Quem emitiu e para quando: é o que diz se um desconto por
        // antecipação podia ter valido (`descontoAntecipado`).
        provider: cobranca.provider ? String(cobranca.provider) : null,
        dueDate: isoDateOf(cobranca.due_date),
        // O desconto com que ela saiu (0100, `discount_terms`), ou nulo —
        // linha de antes da coluna, e aí vale a configuração de hoje.
        discountTerms: BillingCharge.discountTermsOf(cobranca),
        planId: temPreco ? Number(cobranca.plan_id) : null,
        couponId: temPreco && cobranca.coupon_id !== null && cobranca.coupon_id !== undefined
          ? Number(cobranca.coupon_id) : null,
        // O ciclo com que ela saiu (0104) — nulo é linha de antes, mensal.
        billingCycle: temPreco ? (cobranca.billing_cycle ?? null) : undefined
      };
    }
  }

  // 1b. **A cobrança que a linha JÁ FOI.** A troca de plano cancela no
  //     gateway a cobrança em aberto e reemite a linha com o preço novo — mas
  //     o boleto velho pode já estar impresso, e cancelar lá não desfaz um
  //     pagamento que entrou antes do cancelamento. Esse pagamento chega com
  //     o id velho, e a pergunta continua sendo "quanto se pediu POR ELE": o
  //     valor que aquela cobrança tinha, e não o preço novo — senão quem pagou
  //     exatamente o que viu seria "pago a menos".
  //
  //     Em voz alta, porque é o caso em que o provedor pode acabar pagando o
  //     mesmo período duas vezes: a cobrança nova continua viva no gateway, e
  //     cancelá-la ou estornar é decisão de gente.
  if (!cobranca && externalId) {
    const trocada = await BillingCharge.bySupersededGatewayId(externalId);
    if (trocada) {
      console.warn(
        `Payment ${externalId} settled a SUPERSEDED charge (replaced by charge row ${trocada.row.id} `
        + `after a plan change); the replacement may still be open at the gateway — review it in the console`
      );
      const valor = Number(trocada.superseded.amountCents);
      if (Number.isFinite(valor) && valor > 0) {
        const moeda = String(trocada.superseded.currency || '').toUpperCase();
        if (moeda && moeda !== moedaPaga) return { cents: null, motivo: 'currency_mismatch', fonte: 'charge' };
        return {
          cents: Math.floor(valor),
          baseCents: Math.floor(valor) + Math.max(0, Math.floor(Number(trocada.superseded.creditCents ?? 0)) || 0),
          motivo: null,
          fonte: 'superseded_charge',
          // A linha que a cobrança velha era diz o que ela pagava: o id velho
          // de uma pró-rata reemitida continua sendo pró-rata, e não compra
          // período (ver `recordPayment`).
          kind: trocada.row.kind || 'renewal',
          chargeId: Number(trocada.row.id),
          // O plano e o ciclo que a cobrança VELHA cobrava, quando a entrada
          // os guardou: é o período deles que o pagamento compra.
          ...(trocada.superseded.planId !== null && trocada.superseded.planId !== undefined ? {
            planId: Number(trocada.superseded.planId),
            couponId: trocada.superseded.couponId === null || trocada.superseded.couponId === undefined
              ? null : Number(trocada.superseded.couponId),
            billingCycle: trocada.superseded.billingCycle ?? null
          } : {})
        };
      }
    }
  }

  // O preço que a emissão teria pedido: o do plano com o cupom, quando há um
  // (`precoDoPlano`, ver `effectivePriceCents`) — senão o pagamento manual do
  // valor com desconto seria chamado de "pago a menos".
  const preco = precoDoPlano ?? Number(plano?.price_cents);
  if (!Number.isFinite(preco) || preco <= 0) return { cents: null, motivo: 'nothing_asked', fonte: null };
  const moedaPlano = String(plano?.currency || '').toUpperCase();
  if (moedaPlano && moedaPlano !== moedaPaga) return { cents: null, motivo: 'currency_mismatch', fonte: 'plan' };
  return { cents: Math.floor(preco), planBaseCents: Math.floor(preco), motivo: null, fonte: 'plan' };
}

/** O fuso das datas de cobrança — o mesmo de `ChargeIssuingService.BILLING_TIMEZONE`. */
const FUSO_DA_COBRANCA = 'America/Sao_Paulo';

/**
 * A chave do período que termina em `instante` — a mesma de
 * `ChargeIssuingService.periodKey` (a data no fuso da cobrança), copiada aqui
 * porque aquele arquivo importa este. É a chave de `usage_peaks` (0105).
 */
function chaveDoPeriodo(instante) {
  const data = asDate(instante);
  if (!data) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_DA_COBRANCA, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(data);
}

/** `YYYY-MM-DD` menos `dias`, em datas de calendário (sem fuso no meio). */
function diasAntes(dataIso, dias) {
  const instante = Date.parse(`${dataIso}T00:00:00Z`);
  if (!Number.isFinite(instante)) return null;
  return new Date(instante - dias * DAY_MS).toISOString().slice(0, 10);
}

/**
 * O desconto por antecipação que explica um pagamento a menos — ou nulo.
 *
 * A cobrança que a plataforma emite no Asaas pode levar um desconto para quem
 * paga até `discountDaysBefore` dias antes do vencimento (bloco `charges` de
 * Integrações). Quem aproveita paga MENOS do que a linha pede, e isso não é
 * "pago a menos": é o combinado. Vale como inteiro quando as três coisas
 * fecham:
 *
 *   1. a cobrança é uma que o painel emitiu NO ASAAS (é só lá que o desconto
 *      vai), com vencimento conhecido;
 *   2. o valor pago cobre o pedido menos o desconto que a configuração de hoje
 *      dá para ele — a mesma conta da emissão (`earlyDiscountFor`), com o piso
 *      de R$ 5,00. Um centavo de folga na porcentagem, porque o gateway
 *      arredonda do lado dele;
 *   3. o pagamento caiu até o limite (`dueDate − discountDaysBefore`), pelo dia
 *      do pagamento que o gateway informa ou, sem ele, pelo dia de hoje no
 *      fuso da cobrança.
 *
 * Qualquer uma falhando, o pagamento continua sendo o que era: a menos.
 */
async function descontoAntecipado({ pedido, amount, paidOn, now }) {
  if (pedido.fonte !== 'charge' || pedido.provider !== 'asaas' || !pedido.dueDate) return null;
  // Os termos com que a cobrança SAIU, quando a linha os tem: a configuração
  // pode ter mudado depois da emissão, e quem pagou com o desconto que estava
  // na fatura pagou o inteiro. Sem eles (linha de antes), a de hoje.
  const desconto = pedido.discountTerms
    ? pedido.discountTerms.discount
    : earlyDiscountFor(pedido.cents, await effectiveChargesConfig());
  if (!desconto) return null;
  const folga = desconto.kind === 'percent' ? 1 : 0;
  const comDesconto = pedido.cents - desconto.cents;
  if (amount < comDesconto - folga) return null;
  const limite = diasAntes(pedido.dueDate, desconto.daysBefore);
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(String(paidOn ?? ''))
    ? String(paidOn)
    : new Intl.DateTimeFormat('en-CA', {
      timeZone: FUSO_DA_COBRANCA, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);
  if (!limite || dia > limite) return null;
  return { discountCents: desconto.cents, discountedCents: comDesconto, paidOn: dia, limitDate: limite };
}

/**
 * O prazo vivo de uma assinatura — o mesmo que a emissão lê, na mesma ordem:
 * a renovação, ou o fim do teste para quem nunca pagou.
 */
function prazoVivo(linha) {
  return asDate(linha?.renews_at) ?? asDate(linha?.trial_ends_at);
}

/**
 * Leva a cobrança em aberto do prazo velho para o novo, quando um prazo muda
 * à mão (`setDeadlines`, `setStatus` com data). Ver
 * `ChargeIssuingService.followDeadline`, que é quem fala com o gateway.
 *
 * Importado na hora, e não no topo: `chargeIssuingService` importa ESTE
 * arquivo, e o caminho de volta só é preciso quando um prazo é mexido à mão.
 * A recusa (`ChargeFollowError`) sobe como está, e quem chama não grava nada.
 */
async function followOpenCharge(before, patch, now = new Date()) {
  const depois = { ...before, ...patch };
  const de = prazoVivo(before);
  const para = prazoVivo(depois);
  if (!de || !para || de.getTime() === para.getTime()) return null;
  const { default: ChargeIssuingService } = await import('./chargeIssuingService.js');
  return ChargeIssuingService.followDeadline({ from: de, to: para, now });
}

/** Os estados em que o "isento de cobrança" pode ser ligado. */
const ESTADOS_ISENTAVEIS = new Set(['trial', 'active', 'past_due', 'suspended']);

/** Uma data sem os milissegundos: o MySQL guarda ao segundo, e o que se devolve tem de ser o que se gravou. */
function aoSegundo(data) {
  return new Date(Math.floor(data.getTime() / 1000) * 1000);
}

/**
 * O motivo que o fim automático da isenção grava no extrato e nas trilhas:
 * a data de fim (`billing_exempt_until`) chegou. Ver `endExpiredBillingExempt`.
 */
export const BILLING_EXEMPT_EXPIRED_REASON = 'billing_exempt_expired';

/** Uma recusa de `setBillingExempt`, com o status HTTP e o código que a tela lê. */
export class BillingExemptError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'BillingExemptError';
    this.status = status;
    this.code = code;
  }
}

export class PlanLimitError extends Error {
  constructor(code, { limit, current, resource }) {
    super(`Plan limit reached for ${resource}: ${current} of ${limit}`);
    this.name = 'PlanLimitError';
    this.code = code;
    this.limit = limit;
    this.current = current;
    this.resource = resource;
  }
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Uma data como ISO, venha como vier do banco — ou nulo. */
function isoOf(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

/** O `detail` de uma linha do extrato, lido — nunca lança. */
function detalheDe(evento) {
  if (!evento?.detail) return null;
  try {
    const lido = JSON.parse(evento.detail);
    return lido && typeof lido === 'object' ? lido : null;
  } catch {
    return null;
  }
}

/**
 * O que a troca agendada muda no ciclo (0104), para o extrato da aplicação —
 * vazio quando o ciclo fica o mesmo.
 */
function cycleChangeDetail(antes) {
  const de = parseBillingCycle(antes?.billing_cycle) ?? 'monthly';
  const para = parseBillingCycle(antes?.pending_billing_cycle);
  return para && para !== de ? { cycleFrom: de, cycleTo: para } : {};
}

/** Os estados em que um pagamento empurra o prazo — o `reactivates` de `recordPayment`. */
const ESTADOS_QUE_ESTENDEM = new Set(['trial', 'active', 'past_due']);

/**
 * Por que a assinatura está `suspended` (0102). `auto_nonpayment` é a do
 * agendador e o pagamento a desfaz; `manual` é o console, e só ele desfaz.
 */
export const SUSPENDED_REASONS = Object.freeze({
  AUTO_NONPAYMENT: 'auto_nonpayment',
  MANUAL: 'manual'
});

/** A suspensão automática por inadimplência — a única que o pagamento desfaz. */
export function isAutoSuspended(subscription) {
  return subscription?.status === 'suspended'
    && subscription?.suspended_reason === SUSPENDED_REASONS.AUTO_NONPAYMENT;
}

/**
 * Se ainda se cobra esta assinatura: emitir a fatura, "pagar agora", dar
 * baixa. Os estados vivos e, além deles, a suspensão AUTOMÁTICA — é pagando
 * que se sai dela, e recusar a cobrança a quem está tentando pagar trancaria
 * a porta pelo lado de dentro. A suspensão à mão continua fora.
 */
export function isBillableStatus(subscription) {
  return ESTADOS_QUE_ESTENDEM.has(subscription?.status) || isAutoSuspended(subscription);
}

/**
 * A pausa aceita como retenção (0107) — marcada ou correndo. `paused_until`
 * gravado é a pausa inteira: de `renews_at` (o fim do período pago, que fica
 * onde estava) até ela. Antes de `renews_at` o provedor usa o que pagou;
 * depois, só lê (`effectiveStatus` → `past_due`/`paused`). Nos dois trechos
 * nada se cobra: sem fatura, sem lembrete, sem suspensão automática.
 */
export function isPauseScheduled(subscription) {
  return Boolean(subscription?.paused_until) && subscription?.status !== 'canceled';
}

/** A pausa CORRENDO agora: o período pago acabou e `paused_until` ainda não chegou. */
export function isPaused(subscription, now = new Date()) {
  if (!isPauseScheduled(subscription) || subscription.status !== 'active') return false;
  const ate = asDate(subscription.paused_until);
  const pago = asDate(subscription.renews_at);
  if (!ate || ate.getTime() <= now.getTime()) return false;
  return !pago || pago.getTime() <= now.getTime();
}

/** O cancelamento agendado pelo próprio provedor (0107), ainda por acontecer. */
export function isCancelScheduled(subscription) {
  return Boolean(subscription?.cancel_at) && subscription?.status !== 'canceled';
}

/**
 * Desde quando esta assinatura está devendo — o instante do prazo que venceu
 * sem pagamento —, ou nulo quando ela não está devendo (ou não dá para
 * dizer desde quando).
 *
 * É a âncora da suspensão automática (`autoSuspensionStep`): suspende-se
 * `autoSuspendDays` depois DESTE instante. Parte do estado que VALE
 * (`effectiveStatus`) e não do gravado, pela razão de sempre: um `active`
 * com `renews_at` vencido é `past_due` desde o segundo em que venceu. As
 * causas, e o prazo de cada uma:
 *
 *   trial_expired      `trial_ends_at`;
 *   renewal_expired    `renews_at`;
 *   (gravado past_due) o prazo que houver, se já passou;
 *   proration_overdue  o vencimento da fatura de pró-rata, que não mora na
 *                      assinatura — quem chama o lê da cobrança e o passa em
 *                      `prorationDueAt`.
 *
 * Com mais de uma causa, vale a MAIS ANTIGA: é desde ela que se deve.
 * `prorationDueAt` vencido conta mesmo que `effectiveStatus` não o veja (ele
 * é síncrono e não lê cobrança). Isento, cancelado e suspenso não devem nada
 * a esta conta: os dois primeiros não são cobrados, e o suspenso já foi.
 *
 * @returns {{ since: Date, reason: string } | null}
 */
export function overdueSince(subscription, now = new Date(), { prorationDueAt = null } = {}) {
  if (!subscription || subscription.billing_exempt_at) return null;
  // A retenção (0107): na pausa não se deve nada até `paused_until`, e o
  // cancelamento agendado acaba na data — nenhum dos dois é inadimplência.
  if (isPauseScheduled(subscription) || isCancelScheduled(subscription)) return null;
  if (!ESTADOS_QUE_ESTENDEM.has(subscription.status)) return null;
  const causas = [];
  const vencido = (data) => data && data.getTime() <= now.getTime();
  const efetivo = SubscriptionService.effectiveStatus(subscription, now);
  if (efetivo.status === 'past_due') {
    let prazo = null;
    if (efetivo.reason === 'trial_expired') prazo = asDate(subscription.trial_ends_at);
    else if (efetivo.reason === 'renewal_expired') prazo = asDate(subscription.renews_at);
    else if (efetivo.reason === null) prazo = asDate(subscription.renews_at) ?? asDate(subscription.trial_ends_at);
    if (vencido(prazo)) causas.push({ since: prazo, reason: efetivo.reason ?? 'past_due' });
  }
  const proRata = asDate(prorationDueAt);
  if (vencido(proRata)) causas.push({ since: proRata, reason: 'proration_overdue' });
  if (!causas.length) return null;
  causas.sort((a, b) => a.since.getTime() - b.since.getTime());
  return causas[0];
}

/**
 * O que o pagamento de `detalhe` comprou, e de onde saiu a conta. Ver
 * `reversePayment`, que é quem decide QUANTO disto se desfaz.
 *
 *   - `from`/`to`: o prazo de antes (`renewsBefore`, gravado desde o estorno)
 *     e o de depois (`renewsAt`). É o que permite a `reversePayment` devolver
 *     EXATAMENTE o prazo de antes quando nada o mexeu depois do pagamento.
 *   - `ms`: o período COMPRADO — e só ele. O prazo novo de um pagamento é
 *     sempre `base + periodDays`, com `base` o maior entre o prazo de antes e
 *     o instante do pagamento; `renewsAt − max(renewsBefore, pago em)` é,
 *     então, os `periodDays` que ele gravou. É isto que se subtrai quando
 *     outra coisa mexeu no prazo depois (outro pagamento, uma cortesia): a
 *     diferença crua `renewsAt − renewsBefore` de um pagamento ATRASADO
 *     incluiria os dias vencidos entre o prazo velho e o pagamento — que
 *     ninguém comprou — e tiraria do pagamento seguinte o que era dele.
 *   - `basis`: `purchased` (o evento gravou `periodDays`), `period_days` (o
 *     evento é de antes do estorno existir: o período do plano do evento, se
 *     gravado, ou o de hoje) ou `not_extended` — o pagamento não empurrou
 *     nada, porque foi a menos e ninguém aceitou a diferença, ou porque a
 *     assinatura estava parada por gente (`suspended`, `canceled`). Estornar
 *     esse não devolve dia nenhum.
 */
async function duracaoCreditada(detalhe, planoAtual) {
  if (!detalhe || detalhe.underpaid) return { ms: 0, basis: 'not_extended', from: null, to: null };
  // O pagamento de uma pró-rata (0101) não empurrou prazo nenhum: estorná-lo
  // devolve o dinheiro, e só.
  if (detalhe.proration) return { ms: 0, basis: 'not_extended', from: null, to: null };
  // A suspensão automática reativada pelo pagamento (0102) estendeu, e o
  // estorno desfaz o que ela comprou como o de qualquer outro.
  const reativou = detalhe.statusBefore === 'suspended' && detalhe.suspendedReason === SUSPENDED_REASONS.AUTO_NONPAYMENT;
  if (detalhe.statusBefore && !ESTADOS_QUE_ESTENDEM.has(detalhe.statusBefore) && !reativou) {
    return { ms: 0, basis: 'not_extended', from: null, to: null };
  }
  const from = asDate(detalhe.renewsBefore);
  const to = asDate(detalhe.renewsAt);
  const gravado = Number(detalhe.periodDays);
  if (Number.isFinite(gravado) && gravado > 0) {
    return { ms: Math.floor(gravado) * DAY_MS, basis: 'purchased', from, to };
  }
  const planoDoEvento = detalhe.planId ? await Plan.findById(detalhe.planId) : null;
  // O ciclo gravado no evento (0104), quando há; o anual compra um ano.
  const dias = detalhe.billingCycle === 'annual' ? ANNUAL_PERIOD_DAYS : periodoDoPlano(planoDoEvento ?? planoAtual);
  return { ms: dias * DAY_MS, basis: 'period_days', from, to };
}

class SubscriptionService {
  static cache = cache;

  /**
   * O estado que VALE, que nem sempre é o da coluna: um prazo que venceu é
   * `past_due`, e é `past_due` desde o segundo em que venceu.
   *
   * São dois prazos, e por muito tempo só um deles era lido. O teste vencia
   * sozinho; o período PAGO não vencia nunca. `renews_at` era escrito por
   * `recordPayment`, exibido na tela do provedor, no console e no extrato — e
   * nenhuma decisão o consultava. O efeito não era um incômodo operacional: um
   * provedor que pagou UMA vez ficava `active` para sempre, e ninguém percebia,
   * porque a tela mostrava a data certa. Receita saindo em silêncio é pior do
   * que receita saindo com barulho.
   *
   * ## `renews_at` nulo não vence
   *
   * E isso não é descuido, é a regra. A coluna quer dizer "o período pago
   * termina aqui"; sem data, não há período — é a assinatura que nunca foi
   * posta num ciclo. São três populações reais: o provedor que o console pôs
   * num plano sem nunca registrar pagamento (`setPlan` grava `active` e mais
   * nada), a instalação self-hosted, e todo provedor que já está no banco hoje.
   * Tratar nulo como vencido transformaria esta linha, que conserta uma perda
   * de receita, numa parada geral no primeiro deploy.
   */
  static effectiveStatus(subscription, now = new Date()) {
    if (!subscription) return { status: null, reason: 'missing' };
    const stored = STATUSES.includes(subscription.status) ? subscription.status : 'suspended';
    // Isento de cobrança (`setBillingExempt`): ativo, e nunca vencido — não
    // há fatura, então não há prazo que vença. Só o `canceled` continua
    // valendo por cima: o contrato acabou, e a isenção era de cobrança, não de
    // contrato. E o `suspended` gravado também: suspender é o console
    // bloqueando de propósito, e a isenção perdoa a fatura, não o bloqueio.
    if (subscription.billing_exempt_at && stored !== 'canceled' && stored !== 'suspended') {
      return { status: 'active', reason: null };
    }
    if (stored === 'trial') {
      const ends = asDate(subscription.trial_ends_at);
      if (ends && ends.getTime() <= now.getTime()) {
        return { status: 'past_due', reason: 'trial_expired' };
      }
    }
    // A pausa correndo (0107): o período pago acabou e a cobrança está
    // suspensa até `paused_until`. Só ler, como o atraso — com o motivo
    // próprio, para a tela dizer "pausada até" e não "em atraso".
    if (isPaused(subscription, now)) return { status: 'past_due', reason: 'paused' };
    if (stored === 'active') {
      const ends = asDate(subscription.renews_at);
      if (ends && ends.getTime() <= now.getTime()) {
        return { status: 'past_due', reason: 'renewal_expired' };
      }
      // A fatura de pró-rata da subida (0101) vencida sem pagamento: o mesmo
      // `past_due` da renovação vencida — lê, não escreve —, com o motivo
      // próprio para a tela dizer qual fatura falta. A data é a cópia que
      // `BillingCharge.syncProrationDue` mantém na linha, para esta conta
      // continuar sem consulta.
      const prorata = asDate(subscription.proration_due_at);
      if (prorata && prorata.getTime() <= now.getTime()) {
        return { status: 'past_due', reason: 'proration_overdue' };
      }
    }
    // A suspensão automática diz o porquê, para a tela de bloqueio e o
    // console mostrarem "por inadimplência" — e que pagar resolve.
    if (isAutoSuspended(subscription)) return { status: 'suspended', reason: SUSPENDED_REASONS.AUTO_NONPAYMENT };
    return { status: stored, reason: null };
  }

  /**
   * A etapa da régua de lembretes em que o provedor está agora, ou nulo.
   *
   * Substitui o aviso único de antes (`expiry_warned_for`): três etapas por
   * prazo, relativas a ele — `renews_at`, ou `trial_ends_at` no teste:
   *
   *   before  de `REMINDER_BEFORE_DAYS` dias antes até o prazo;
   *   due     do prazo até `REMINDER_AFTER_DAYS` dias depois;
   *   after   de lá até `REMINDER_AFTER_UNTIL_DAYS` dias depois do prazo, e
   *           só enquanto ninguém pagou (`past_due`).
   *
   * É só a etapa da janela de AGORA: uma etapa que passou sem sair (o
   * agendador parado, o SMTP fora) não sai atrasada. Mandar "vence em cinco
   * dias" para quem já venceu seria pior que não mandar nada. Se já foi
   * mandada, quem responde é `subscription_reminder_sends`, não esta função.
   *
   * Sem lembrete para quem não tem o que pagar: isento de cobrança, plano de
   * graça (ou sem plano), e `suspended`/`canceled`, que são decisões de gente —
   * e a gente que as tomou já falou com o cliente. Depois de pago o prazo
   * muda (`renews_at` anda), e a régua recomeça sozinha no prazo novo.
   */
  static REMINDER_BEFORE_DAYS = 5;

  static REMINDER_AFTER_DAYS = 3;

  static REMINDER_AFTER_UNTIL_DAYS = 10;

  static pendingReminder(subscription, now = new Date(), plano = null) {
    if (!subscription) return null;
    // Isento de cobrança: não há prazo a lembrar nem fatura a pagar.
    if (subscription.billing_exempt_at) return null;
    if (!(this.cyclePriceCents(subscription, plano) > 0)) return null;
    // A retenção (0107): pausada não tem prazo a lembrar até `paused_until`,
    // e quem agendou o cancelamento não renova.
    if (isPauseScheduled(subscription) || isCancelScheduled(subscription)) return null;
    const stored = STATUSES.includes(subscription.status) ? subscription.status : 'suspended';
    if (stored !== 'trial' && stored !== 'active' && stored !== 'past_due') return null;

    // `past_due` é estado gravado à mão pelo console; o prazo dele é o que
    // houver. Em `trial` o prazo é o do teste, em `active` o do período pago.
    const prazo = stored === 'trial'
      ? asDate(subscription.trial_ends_at)
      : asDate(subscription.renews_at) ?? asDate(subscription.trial_ends_at);
    if (!prazo) return null;

    const desde = now.getTime() - prazo.getTime();
    let step = null;
    if (desde >= -this.REMINDER_BEFORE_DAYS * DAY_MS && desde < 0) step = 'before';
    else if (desde >= 0 && desde < this.REMINDER_AFTER_DAYS * DAY_MS) step = 'due';
    else if (desde >= this.REMINDER_AFTER_DAYS * DAY_MS && desde < this.REMINDER_AFTER_UNTIL_DAYS * DAY_MS) {
      // "Ainda não pagou": o estado que vale, e não o gravado.
      if (this.effectiveStatus(subscription, now).status === 'past_due') step = 'after';
    }
    if (!step) return null;

    return {
      kind: stored === 'trial' ? 'trial' : 'renewal',
      step,
      deadline: prazo,
      expired: desde >= 0
    };
  }

  /**
   * Onde o provedor está na suspensão automática (0102), ou nulo.
   *
   * `config` é `{ days, warnDays }` (`platformProfileService.autoSuspendConfig`):
   * suspende-se `days` dias depois de o provedor passar a dever
   * (`overdueSince`), e avisa-se `warnDays` antes disso. `days` zero desliga
   * tudo; `warnDays` zero desliga só o aviso.
   *
   *   suspension_warning  da data do aviso até a da suspensão;
   *   suspend             da data da suspensão em diante.
   *
   * Fora: isento, plano de graça (ou sem plano), cancelado e o que já está
   * suspenso — os dois primeiros não devem, os dois últimos já pararam. Pura,
   * sem banco: quem grava é `autoSuspend`, que relê a linha antes.
   *
   * @returns {{ step: 'suspension_warning'|'suspend', since: Date, reason: string,
   *   suspendAt: Date, warnAt: Date|null } | null}
   */
  static autoSuspensionStep(subscription, now = new Date(), plano = null, config = {}, {
    prorationDueAt = null, warnedAt = undefined
  } = {}) {
    const dias = Math.floor(Number(config?.days ?? 0));
    if (!subscription || !(dias > 0)) return null;
    if (subscription.billing_exempt_at) return null;
    if (!(this.cyclePriceCents(subscription, plano) > 0)) return null;
    const devendo = overdueSince(subscription, now, { prorationDueAt });
    if (!devendo) return null;
    const suspendAt = new Date(devendo.since.getTime() + dias * DAY_MS);
    const aviso = Math.floor(Number(config?.warnDays ?? 0));
    const warnAt = aviso > 0 ? new Date(suspendAt.getTime() - aviso * DAY_MS) : null;
    let step = null;
    let suspendeEm = suspendAt;
    if (now.getTime() >= suspendAt.getTime()) step = 'suspend';
    else if (warnAt && now.getTime() >= warnAt.getTime()) step = 'suspension_warning';
    // Nunca suspender sem o aviso antes: quem chama diz quando o aviso deste
    // prazo saiu (`warnedAt`, nulo se não saiu). Sem aviso — o dia do deploy,
    // os dias diminuídos na configuração, o agendador parado na janela —, a
    // etapa é o aviso agora, e a suspensão fica para `warnDays` depois dele.
    // `warnedAt` indefinido é quem não pergunta (a conta pura).
    if (step === 'suspend' && aviso > 0 && warnedAt !== undefined) {
      const avisado = asDate(warnedAt);
      const liberada = avisado ? new Date(avisado.getTime() + aviso * DAY_MS) : null;
      if (!liberada || now.getTime() < liberada.getTime()) {
        step = 'suspension_warning';
        suspendeEm = liberada ?? new Date(now.getTime() + aviso * DAY_MS);
      }
    }
    if (!step) return null;
    return { step, since: devendo.since, reason: devendo.reason, suspendAt: suspendeEm, warnAt };
  }

  /**
   * Suspende o provedor em escopo por inadimplência — se, relida a linha
   * agora, ele ainda está na etapa `suspend` de `autoSuspensionStep`.
   *
   * A gravação é CONDICIONAL (`Subscription.suspendForNonpayment`): só sai de
   * `trial`/`active`/`past_due` — o estado lido —, sem isenção, e com o prazo
   * que venceu ainda vencido há `days` dias. É o que impede as duas corridas
   * que importam: duas voltas do agendador (a segunda não acha mais o estado
   * de antes e não grava nem audita de novo) e o pagamento que chega no mesmo
   * minuto (ele empurra o prazo, e a condição deixa de casar — ou, se ele
   * gravou depois, regrava `active` e limpa o motivo; ver `recordPayment`).
   *
   * A cobrança em aberto NÃO é cancelada: é por ela que se sai daqui.
   *
   * @returns {Promise<{ suspended: boolean, reason?: string, since?: string,
   *   overdueReason?: string, suspendAt?: string }>}
   */
  static async autoSuspend({
    tenant = null, now = new Date(), config = {}, prorationDueAt = null, warnedAt = undefined
  } = {}) {
    const tenantId = currentTenantId();
    const before = await Subscription.forTenant(tenantId);
    if (!before) return { suspended: false, reason: 'no_subscription' };
    const plano = before.plan_id ? await Plan.findById(before.plan_id) : null;
    const etapa = this.autoSuspensionStep(before, now, plano, config, { prorationDueAt, warnedAt });
    if (!etapa || etapa.step !== 'suspend') return { suspended: false, reason: 'not_due' };

    // A coluna do prazo que venceu, para a condição. A da pró-rata é a cópia
    // que a assinatura guarda (`proration_due_at`): paga no meio, ela anda
    // (ou some) e a condição deixa de casar.
    let coluna;
    if (etapa.reason === 'trial_expired') coluna = 'trial_ends_at';
    else if (etapa.reason === 'renewal_expired') coluna = 'renews_at';
    else if (etapa.reason === 'proration_overdue') coluna = 'proration_due_at';
    else coluna = before.renews_at ? 'renews_at' : 'trial_ends_at';
    const limite = new Date(now.getTime() - Math.floor(Number(config.days)) * DAY_MS);

    const detail = {
      from: before.status,
      to: 'suspended',
      reason: SUSPENDED_REASONS.AUTO_NONPAYMENT,
      automatic: true,
      overdueReason: etapa.reason,
      overdueSince: etapa.since.toISOString(),
      days: Math.floor(Number(config.days))
    };
    const gravou = await getDb().transaction(async (trx) => {
      const mudou = await Subscription.suspendForNonpayment(
        tenantId, { fromStatus: before.status, deadlineColumn: coluna, deadlineBy: limite }, trx
      );
      if (!mudou) return false;
      await BillingEvent.record({
        subscriptionId: before.id,
        type: BILLING_EVENT_TYPES.STATUS_CHANGED,
        detail
      }, trx);
      return true;
    });
    cache.invalidate();
    if (!gravou) return { suspended: false, reason: 'raced' };

    const linha = tenant?.slug ? tenant : ((await getDb()('tenants').where({ id: tenantId }).first()) ?? { id: tenantId });
    await PlatformAudit.record({
      action: PlatformAudit.ACTIONS.SUBSCRIPTION_STATUS_CHANGED,
      tenant: linha,
      detail: { ...detail, source: 'scheduler' }
    });
    await AuditLog.record({
      action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
      actorKind: 'system',
      subjectType: 'subscription',
      subjectId: tenantId,
      detail: { ...detail, source: 'scheduler', platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_STATUS_CHANGED }
    });
    console.warn(
      `Provider ${tenantId} was suspended for nonpayment: overdue (${etapa.reason}) since ${etapa.since.toISOString()}`
    );
    return {
      suspended: true,
      since: etapa.since.toISOString(),
      overdueReason: etapa.reason,
      suspendAt: etapa.suspendAt.toISOString()
    };
  }

  /**
   * Anota que o aviso daquele prazo saiu. Idempotente por construção.
   *
   * A régua de lembretes (0092) não a lê — a memória dela é
   * `subscription_reminder_sends` —, mas continua a gravá-la, para quem ler a
   * coluna saber qual foi o último prazo avisado.
   */
  static async markExpiryWarned(deadline) {
    const tenantId = currentTenantId();
    await Subscription.upsertForTenant(tenantId, { expiry_warned_for: asDate(deadline) });
    cache.invalidate();
  }

  /**
   * O que o gate responde para uma requisição, dado o estado.
   *
   * `write` é o método não ser de leitura. `webhook` é uma entrega de fora —
   * ERP, Evolution — que não é "o operador escrevendo": em `past_due` ela
   * continua entrando, porque recusar o evento do ERP por fatura atrasada
   * perderia dado do assinante, e o assinante não deve nada a ninguém.
   */
  static decide(subscription, { method = 'GET', webhook = false, now = new Date() } = {}) {
    const { status, reason } = this.effectiveStatus(subscription, now);
    if (status === null) return { allowed: false, code: GATE_CODES.MISSING };
    if (status === 'trial' || status === 'active') return { allowed: true, code: null };
    if (status === 'past_due') {
      const reading = READ_METHODS.has(String(method).toUpperCase()) || webhook;
      if (reading) return { allowed: true, code: null };
      let code = GATE_CODES.PAST_DUE;
      if (reason === 'trial_expired') code = GATE_CODES.TRIAL_EXPIRED;
      else if (reason === 'paused') code = GATE_CODES.PAUSED;
      return { allowed: false, code };
    }
    if (status === 'suspended') return { allowed: false, code: GATE_CODES.SUSPENDED };
    return { allowed: false, code: GATE_CODES.CANCELED };
  }

  /** A assinatura do provedor em escopo, com o plano, do cache quando dá. */
  static async current() {
    const cached = cache.get();
    if (cached) return cached;
    const subscription = await Subscription.current();
    const plan = subscription ? await Plan.findById(subscription.plan_id) : null;
    // A descida agendada (0074) viaja junto porque a tela e o console a
    // mostram ao lado do plano atual — e uma consulta a mais só para quem tem
    // uma, que é quase ninguém.
    const pendingPlan = subscription?.pending_plan_id ? await Plan.findById(subscription.pending_plan_id) : null;
    // O cupom (0093) pela mesma razão: a tela mostra o preço com desconto.
    const coupon = subscription?.coupon_id ? await Coupon.findById(subscription.coupon_id) : null;
    return cache.set({ subscription, plan, pendingPlan, coupon });
  }

  /** Esquece a leitura de UM provedor — a que o console acabou de mudar. */
  static invalidate(tenantId) {
    return runInTenant(tenantId, () => cache.invalidate());
  }

  /**
   * O que o provedor (ou a tela de bloqueio) pode ver da própria assinatura:
   * o estado, o plano e até quando.
   *
   * Sem preço, mas não por o preço ser segredo do console — deixou de ser
   * quando o provedor passou a escolher o próprio plano. O preço mora em
   * `GET /api/tenant/plans` (`SelfBillingService.listPlans`), junto do resto
   * do catálogo, e o valor de fato cobrado mora na cobrança. Este objeto é
   * também o que a porta da assinatura põe no corpo do 402, e ali a pergunta
   * é "por que parei", não "quanto custa".
   */
  static present({ subscription, plan, pendingPlan = null, coupon = null }, opcoes = {}) {
    if (!subscription) return null;
    // O segundo argumento já foi só `now`; continua aceito assim.
    const { now = new Date(), withExemptReason = false } = opcoes instanceof Date ? { now: opcoes } : (opcoes ?? {});
    const effective = this.effectiveStatus(subscription, now);
    return {
      status: effective.status,
      storedStatus: subscription.status,
      reason: effective.reason,
      plan: plan ? {
        code: plan.code,
        name: plan.name,
        limits: this.limitsOf(plan),
        retention: this.retentionCapsOf(plan)
      } : null,
      trialEndsAt: subscription.trial_ends_at ?? null,
      renewsAt: subscription.renews_at ?? null,
      canceledAt: subscription.canceled_at ?? null,
      // O ciclo de cobrança (0104): o que vale para o plano de agora.
      billingCycle: this.cycleOf(subscription, plan),
      ...this.presentRetention(subscription),
      // Por que está suspensa (0102): `auto_nonpayment` sai pagando; `manual`
      // (ou nulo, de antes da coluna) só pelo console. Nulo fora do suspenso.
      suspendedReason: subscription.status === 'suspended' ? (subscription.suspended_reason ?? null) : null,
      pendingPlan: this.presentPendingPlan(subscription, pendingPlan),
      coupon: this.presentCoupon(subscription, plan, coupon),
      card: this.presentCard(subscription),
      ...this.presentBillingExempt(subscription, { withReason: withExemptReason })
    };
  }

  /**
   * A retenção no cancelamento (0107) como a tela e o console a leem: o
   * cancelamento agendado (o fim do período pago) e a pausa — de `renewsAt`
   * até `pausedUntil`. Nulos quando não há. Função própria porque a lista de
   * Assinaturas monta a linha dela à mão.
   */
  static presentRetention(subscription) {
    return {
      cancelAt: isCancelScheduled(subscription) ? isoOf(subscription.cancel_at) : null,
      pausedUntil: isPauseScheduled(subscription) ? isoOf(subscription.paused_until) : null,
      pauseStartedAt: isPauseScheduled(subscription) ? isoOf(subscription.pause_started_at) : null
    };
  }

  /**
   * O cartão recorrente (0100), como a tela e o console o veem: a intenção,
   * a bandeira, os quatro últimos dígitos e as datas — NUNCA o token, nem o IP
   * de quem ligou. `failure` é um código (`charge_refused`, `capture_refused`)
   * que a tela traduz, e não o texto do gateway.
   */
  static presentCard(subscription) {
    const salvo = Boolean(subscription?.card_token_ciphertext);
    return {
      autopayEnabled: Boolean(subscription?.card_autopay_at),
      autopaySince: isoOf(subscription?.card_autopay_at),
      saved: salvo,
      brand: salvo ? (subscription.card_brand ?? null) : null,
      last4: salvo ? (subscription.card_last4 ?? null) : null,
      savedAt: salvo ? isoOf(subscription.card_saved_at) : null,
      failedAt: salvo ? isoOf(subscription.card_failed_at) : null,
      failure: salvo && subscription.card_failed_at ? (subscription.card_failure ?? null) : null
    };
  }

  // ── Cupom de desconto (0093) ─────────────────────────────────────────

  /**
   * Se o cupom `coupon` vale para a fatura de `plan` desta assinatura.
   *
   * Vale quando é o cupom DA assinatura, ainda tem ciclo (o `forever` não
   * conta ciclo) e o plano está na lista dele, quando ele tem lista. A
   * validade, o teto de resgates e o `active` NÃO entram: são regras do
   * RESGATE. Quem já resgatou fica com o desconto que resgatou — desativar um
   * cupom fecha a porta para os próximos, não tira de quem entrou.
   *
   * O plano conta a cada fatura, e não só na aplicação: a descida para um
   * plano fora da lista faz o cupom parar de valer ali (e voltar a valer se o
   * provedor voltar a um plano da lista, enquanto houver ciclo).
   */
  static couponApplies(subscription, plan, coupon) {
    if (!subscription?.coupon_id || !coupon || !plan) return false;
    if (Number(coupon.id) !== Number(subscription.coupon_id)) return false;
    if (coupon.duration !== 'forever') {
      const restantes = Number(subscription.coupon_cycles_left);
      if (!Number.isFinite(restantes) || restantes <= 0) return false;
      // A troca para o ANUAL (0104): o cupom de N faturas resgatado no
      // mensal não desconta a fatura do ano — "20% por 3 meses" viraria 20%
      // de um ano inteiro. A fatura anual da troca sai sem ele, e ele sai da
      // assinatura quando o anual passa a valer (`dropCouponForAnnual`). O
      // desconto de retenção do anual é calculado PARA o anual, e vale.
      if (subscription.cycle_switch_from && subscription.cycle_switch_from !== 'annual'
        && this.cycleOf(subscription, plan) === 'annual' && !isAnnualRetentionCoupon(coupon)) return false;
    }
    // O desconto de retenção do anual (equivalente aos meses da configuração
    // numa fatura anual) só desconta a fatura anual.
    if (isAnnualRetentionCoupon(coupon) && this.cycleOf(subscription, plan) !== 'annual') return false;
    const planos = parseCouponPlanIds(coupon.plan_ids);
    return planos === null || planos.includes(Number(plan.id));
  }

  /**
   * `priceCents` com o desconto de `coupon`, respeitando o piso
   * (`COUPON_FLOOR_CENTS`). Percentual arredonda o DESCONTO para baixo: o
   * centavo que sobra fica com quem cobra, e a conta é a mesma em toda tela.
   */
  static priceWithCoupon(priceCents, coupon) {
    const preco = Math.floor(Number(priceCents));
    if (!Number.isFinite(preco) || preco <= 0) return 0;
    if (!coupon || preco <= COUPON_FLOOR_CENTS) return preco;
    const valor = Math.floor(Number(coupon.value));
    if (!Number.isFinite(valor) || valor <= 0) return preco;
    const desconto = coupon.kind === 'percent' ? Math.floor((preco * valor) / 100) : valor;
    return Math.max(COUPON_FLOOR_CENTS, preco - desconto);
  }

  // ── O ciclo de cobrança (0104) ───────────────────────────────────────
  //
  // O PONTO ÚNICO de preço e de prazo: toda conta que antes lia
  // `plan.price_cents` ou `plan.period_days` lê `cyclePriceCents` e
  // `cyclePeriodDays`, que olham o ciclo da assinatura. Duas leituras soltas
  // do preço — uma no ciclo, outra não — seriam a fatura anual estendendo
  // trinta dias, ou a mensal estendendo um ano.

  /**
   * O ciclo que VALE para `plan` nesta assinatura: o gravado, a não ser que
   * seja o anual e o plano não ofereça o anual (o console tirou o preço
   * anual) — aí o mensal, com preço E prazo mensais. As duas metades caem
   * juntas: preço anual com prazo mensal (ou o contrário) é dinheiro errado.
   */
  static cycleOf(subscription, plan) {
    return subscription?.billing_cycle === 'annual' && annualAvailable(plan) ? 'annual' : 'monthly';
  }

  /** O preço de UM ciclo de `plan` para esta assinatura, sem cupom. */
  static cyclePriceCents(subscription, plan) {
    if (this.cycleOf(subscription, plan) === 'annual') return precoAnualDe(plan);
    return Math.max(0, Math.floor(Number(plan?.price_cents ?? 0)) || 0);
  }

  /** Os dias que UM pagamento do ciclo compra: 365 no anual, `period_days` no mensal. */
  static cyclePeriodDays(subscription, plan) {
    return this.cycleOf(subscription, plan) === 'annual' ? ANNUAL_PERIOD_DAYS : periodoDoPlano(plan);
  }

  /**
   * A assinatura vista pelo ciclo da troca AGENDADA (`pending_billing_cycle`,
   * nulo é "o mesmo de agora"). É por ela que se precifica o plano agendado:
   * a fatura da renovação paga o período que já é do plano e do ciclo novos.
   */
  static scheduledView(subscription) {
    if (!subscription) return subscription;
    const ciclo = parseBillingCycle(subscription.pending_billing_cycle);
    return ciclo ? this.inCycle(subscription, ciclo) : subscription;
  }

  /**
   * A assinatura vista num ciclo (0104) — com a marca de onde ela vem
   * (`cycle_switch_from`) quando é uma TROCA de ciclo: é por ela que o cupom
   * de N faturas do mensal não desconta a fatura anual (`couponApplies`).
   */
  static inCycle(subscription, ciclo) {
    if (!subscription) return subscription;
    const de = subscription.cycle_switch_from ?? (parseBillingCycle(subscription.billing_cycle) ?? 'monthly');
    return { ...subscription, billing_cycle: ciclo, ...(de !== ciclo ? { cycle_switch_from: de } : {}) };
  }

  /**
   * Tira o cupom que não é `forever` quando a assinatura PASSA ao anual
   * (0104) — a troca agendada aplicada, ou a troca na hora. O cupom de N
   * faturas foi dado no mensal, e no anual cada fatura é um ano: N anos de
   * desconto. Fica o `forever` (desconto permanente é permanente) e o de
   * retenção do anual (calculado para o anual). Condicional ao cupom lido; o
   * extrato registra `coupon.removed` com `reason: 'cycle_change'`.
   *
   * @returns {Promise<object|null>} o que saiu, ou nulo
   */
  static async dropCouponForAnnual(before, { trx = null, actorUserId = null } = {}) {
    if (!before?.coupon_id || !before.tenant_id) return null;
    const db = trx ?? getDb();
    const cupom = await Coupon.findById(before.coupon_id, db);
    if (cupom && (cupom.duration === 'forever' || isAnnualRetentionCoupon(cupom))) return null;
    const ok = await Subscription.setCoupon(before.tenant_id, { expectCouponId: before.coupon_id, couponId: null }, db);
    if (!ok) return null;
    const saiu = {
      coupon: cupom ? {
        id: Number(cupom.id), code: cupom.code, kind: cupom.kind, value: Number(cupom.value), duration: cupom.duration
      } : { id: Number(before.coupon_id) },
      cyclesLeft: before.coupon_cycles_left === null || before.coupon_cycles_left === undefined
        ? null : Number(before.coupon_cycles_left),
      source: 'system',
      reason: 'cycle_change'
    };
    await BillingEvent.record({
      subscriptionId: before.id,
      type: BILLING_EVENT_TYPES.COUPON_REMOVED,
      createdBy: actorUserId,
      detail: saiu
    }, trx);
    cache.invalidate();
    return saiu;
  }

  /**
   * O preço por dia de `plan` no ciclo desta assinatura. É por ele que a
   * troca decide subida ou descida (0104): o anual com desconto custa mais
   * por fatura e menos por dia, e é o "por dia" que diz quem paga mais.
   */
  static dailyPriceOf(subscription, plan) {
    const dias = this.cyclePeriodDays(subscription, plan);
    return dias > 0 ? this.cyclePriceCents(subscription, plan) / dias : 0;
  }

  /**
   * Quanto o ciclo anual economiza: o preço mensal levado a 365 dias contra o
   * anual, em porcentagem inteira arredondada para baixo — a tela nunca
   * promete mais do que dá. Nulo sem preço anual ou sem economia.
   */
  static annualSavingsPercent(plan) {
    const anual = precoAnualDe(plan);
    const mensal = Math.max(0, Math.floor(Number(plan?.price_cents ?? 0)) || 0);
    if (anual === null || !(mensal > 0)) return null;
    const cheio = (mensal * ANNUAL_PERIOD_DAYS) / periodoDoPlano(plan);
    const pct = Math.floor(((cheio - anual) / cheio) * 100);
    return pct > 0 ? pct : null;
  }

  /**
   * O preço da fatura de `plan` para esta assinatura, com o cupom já lido —
   * a versão síncrona de `effectivePriceCents`, para quem lista muitas
   * assinaturas de uma vez com os cupons em mãos.
   */
  static priceFor(subscription, plan, coupon) {
    // O preço do CICLO (0104): no anual, o cupom desconta a fatura do ano.
    const preco = this.cyclePriceCents(subscription, plan);
    return this.couponApplies(subscription, plan, coupon) ? this.priceWithCoupon(preco, coupon) : preco;
  }

  /**
   * O preço que a fatura de `plan` vai pedir a esta assinatura: o do plano,
   * com o cupom dela quando ele vale (`couponApplies`), nunca abaixo do piso.
   *
   * É a ÚNICA conta de preço da cobrança: a emissão (`issueCurrent`, inclusive
   * o preço da descida agendada), a reprecificação da fatura em aberto
   * (`reprecificarCobranca`), o "pagar agora" e a conferência do pagamento
   * leem daqui. O valor mudado à mão pelo console numa cobrança (0078) vence
   * isto — quem decide isso é quem lê a cobrança.
   *
   * Assíncrona porque lê o cupom; `{ coupon }` poupa a leitura a quem já o
   * tem (nulo é "sem cupom").
   */
  static async effectivePriceCents(subscription, plan, { coupon } = {}) {
    if (!subscription?.coupon_id) return this.priceFor(subscription, plan, null);
    const cupom = coupon !== undefined ? coupon : await Coupon.findById(subscription.coupon_id);
    return this.priceFor(subscription, plan, cupom);
  }

  /**
   * O que a cobrança de `plan` grava sobre o próprio preço (0093): o plano e
   * o cupom com que ele foi calculado — `couponId` nulo quando o cupom não
   * vale ali. É o que o pagamento lê depois (`recordPayment`) para saber se a
   * fatura paga carregava o desconto e qual plano ela pagou.
   */
  static chargePricing(subscription, plan, coupon) {
    return {
      planId: plan?.id ? Number(plan.id) : null,
      couponId: this.couponApplies(subscription, plan, coupon) ? Number(coupon.id) : null,
      // O ciclo (0104): no mesmo plano, é só ele que separa a fatura do mês
      // da do ano — e é ele que a trava da troca agendada lê.
      billingCycle: plan ? this.cycleOf(subscription, plan) : null
    };
  }

  /** O menor valor de uma fatura de pró-rata: o mesmo piso do Asaas que o do cupom. */
  static PRORATION_MIN_CENTS = COUPON_FLOOR_CENTS;

  /**
   * Quanto a SUBIDA de `fromPlan` para `toPlan` cobra agora (0101): a
   * diferença entre os preços efetivos (com o cupom, `priceFor`) proporcional
   * ao que falta do período pago —
   *
   *   ⌈ (novo − antigo) × segundos restantes ÷ segundos do período ⌉ centavos
   *
   * — com o período do plano de antes (é ele que o provedor pagou) e os
   * segundos até `renews_at`. Sem teto na fração: quem pagou adiantado mais
   * de um período pagou o preço velho por todo ele.
   *
   * Pura e síncrona: a tela mostra o valor antes do clique (`listPlans`) e a
   * troca o cobra depois, e as duas contas têm de ser a mesma.
   *
   * `eligible: false` quando não há o que cobrar: fora de `active` com o
   * período correndo, isento, não é subida. `skipped: 'below_minimum'` quando
   * há diferença mas ela não chega a `PRORATION_MIN_CENTS` — não sai fatura,
   * e o extrato registra.
   */
  static prorationQuote(subscription, fromPlan, toPlan, coupon, now = new Date()) {
    const nada = { eligible: false, amountCents: 0 };
    if (!subscription || !toPlan) return nada;
    if (subscription.status !== 'active' || subscription.billing_exempt_at) return nada;
    const renovacao = asDate(subscription.renews_at);
    if (!renovacao || renovacao.getTime() <= now.getTime()) return nada;
    const antigo = this.priceFor(subscription, fromPlan, coupon);
    const novo = this.priceFor(subscription, toPlan, coupon);
    // Pelo preço POR DIA de cada plano (0104): com `period_days` diferentes
    // (o de 60 dias contra o de 30), a fatura maior pode ser o dia mais
    // barato, e a menor o mais caro — e é o dia que diz se é subida (a mesma
    // régua de `SelfBillingService.changePlan`). A diferença por dia × o
    // tempo que falta; no mesmo período, é a conta de sempre:
    //   ⌈ (novo − antigo) × restante ÷ período ⌉.
    const diasDe = this.cyclePeriodDays(subscription, fromPlan ?? toPlan);
    const diasPara = this.cyclePeriodDays(subscription, toPlan);
    if (!(novo * diasDe > antigo * diasPara)) return nada;
    // O período do CICLO de agora (0104): a pró-rata é dentro do mesmo ciclo.
    const periodoS = diasDe * 86_400;
    const restantesS = Math.floor((renovacao.getTime() - now.getTime()) / 1000);
    // Em inteiros grandes, exata: (novo/diasPara − antigo/diasDe) × restante/dia.
    const numerador = BigInt(novo * diasDe - antigo * diasPara) * BigInt(restantesS);
    const denominador = BigInt(diasDe * diasPara * 86_400);
    const valor = Number((numerador + denominador - 1n) / denominador);
    const quote = {
      eligible: true,
      amountCents: valor,
      fromPlanId: fromPlan?.id ? Number(fromPlan.id) : null,
      toPlanId: Number(toPlan.id),
      fromPriceCents: antigo,
      toPriceCents: novo,
      remainingSeconds: restantesS,
      periodSeconds: periodoS,
      remainingDays: Math.ceil(restantesS / 86_400),
      renewsAt: renovacao.toISOString(),
      currency: String(toPlan.currency || 'BRL').toUpperCase(),
      billingCycle: this.cycleOf(subscription, toPlan)
    };
    if (valor < this.PRORATION_MIN_CENTS) return { ...quote, skipped: 'below_minimum' };
    return quote;
  }

  /**
   * Se a cobrança paga do período da descida agendada pagou o plano AGENDADO
   * — `true`, `false`, ou nulo quando não dá para dizer.
   *
   * O plano gravado na cobrança (`planId`, 0093) é a resposta. Sem ele (a
   * cobrança feita à mão, ou de antes da coluna), pelo valor: o que casa com
   * o preço de um plano e não com o do outro decide; os dois iguais (o cupom
   * levou os dois ao piso) é nulo. Nenhum casando, contra o preço de TABELA
   * do atual quando o cupom não vale nos dois — com ele valendo só num, o
   * preço com desconto do atual pode ficar abaixo do agendado, e "menos que o
   * atual" deixaria de querer dizer "pagou o barato".
   */
  static paidScheduledPlan({
    planId = null, billingCycle = undefined, cents = null, subscription, current, scheduled, coupon = null
  }) {
    if (!scheduled) return null;
    // O ciclo de cada lado (0104): o atual no ciclo de agora, o agendado no
    // ciclo agendado. A troca só de ciclo agenda o MESMO plano, e aí o plano
    // gravado na cobrança só responde junto com o ciclo gravado nela.
    const agendadaView = this.scheduledView(subscription);
    const cicloAgendado = this.cycleOf(agendadaView, scheduled);
    if (planId !== null && planId !== undefined) {
      if (Number(planId) !== Number(scheduled.id)) return false;
      const mudaCiclo = current && Number(current.id) === Number(scheduled.id)
        && this.cycleOf(subscription, current) !== cicloAgendado;
      if (!mudaCiclo) return true;
      // `billingCycle` indefinido é quem chama sem a linha; nulo é cobrança de
      // antes da coluna — todas mensais, que era o único ciclo que existia.
      if (billingCycle === undefined) return null;
      return (parseBillingCycle(billingCycle) ?? 'monthly') === cicloAgendado;
    }
    if (cents === null || cents === undefined || !current) return null;
    const precoAtual = this.priceFor(subscription, current, coupon);
    const precoAgendado = this.priceFor(agendadaView, scheduled, coupon);
    if (precoAtual === precoAgendado) return null;
    if (cents === precoAgendado) return true;
    if (cents === precoAtual) return false;
    // O agendado mais caro por fatura (o anual, 0104): nenhum casando, só o
    // valor acima do agendado diz que foi ele — pagar a mais credita.
    if (precoAgendado > precoAtual) return cents > precoAgendado ? true : null;
    const nosDois = this.couponApplies(subscription, current, coupon) === this.couponApplies(agendadaView, scheduled, coupon);
    const referencia = nosDois ? precoAtual : this.cyclePriceCents(subscription, current);
    return cents < referencia;
  }

  /**
   * O cupom como a tela e o console o leem — ou nulo. `priceCents` é o preço
   * que a próxima fatura do plano atual vai pedir; `appliesToPlan` diz se o
   * cupom vale no plano de agora (um cupom restrito a outros planos fica na
   * assinatura, sem desconto, até o provedor voltar a um deles ou ele sair).
   */
  static presentCoupon(subscription, plan, coupon) {
    if (!subscription?.coupon_id || !coupon || Number(coupon.id) !== Number(subscription.coupon_id)) return null;
    const restantes = subscription.coupon_cycles_left;
    return {
      id: Number(coupon.id),
      code: coupon.code,
      kind: coupon.kind,
      value: Number(coupon.value),
      duration: coupon.duration,
      durationCycles: coupon.duration_cycles === null || coupon.duration_cycles === undefined
        ? null : Number(coupon.duration_cycles),
      cyclesLeft: restantes === null || restantes === undefined ? null : Number(restantes),
      planIds: parseCouponPlanIds(coupon.plan_ids),
      appliesToPlan: this.couponApplies(subscription, plan, coupon),
      priceCents: this.priceFor(subscription, plan, coupon),
      appliedAt: isoOf(subscription.coupon_applied_at)
    };
  }

  /**
   * O "isento de cobrança" como a tela e o console o leem: se está, desde
   * quando, e o motivo que o console escreveu. Função própria porque a lista
   * de Assinaturas monta a linha dela à mão, e duas cópias destes três campos
   * seriam duas telas que um dia discordam.
   *
   * O motivo é anotação interna do console ("parceiro", "acordo comercial"):
   * o provedor sabe que está isento, não por que o anotamos. Por isso ele sai
   * NULO por padrão, e só as telas do console o pedem (`withReason`) — quem
   * esquecer de pedir mostra menos, e não o contrário.
   */
  static presentBillingExempt(subscription, { withReason = false } = {}) {
    return {
      billingExempt: Boolean(subscription?.billing_exempt_at),
      billingExemptSince: isoOf(subscription?.billing_exempt_at),
      // Até quando (nulo é "até alguém desligar"). O provedor também vê: é a
      // data em que a cobrança volta para ele.
      billingExemptUntil: subscription?.billing_exempt_at ? isoOf(subscription?.billing_exempt_until) : null,
      billingExemptReason: withReason && subscription?.billing_exempt_at
        ? (subscription.billing_exempt_reason ?? null)
        : null
    };
  }

  /**
   * A descida agendada, como a tela e o console a leem — ou nulo.
   *
   * Com o preço, ao contrário do plano atual logo acima: a pergunta que este
   * campo responde é "quanto vou pagar a partir de quando", e sem o número a
   * tela teria de cruzar com o catálogo para dizer uma frase. `blockedBy` não
   * mora aqui: ele depende do uso, que só `usage` conta — é lá que ele entra.
   */
  static presentPendingPlan(subscription, pendingPlan) {
    if (!subscription?.pending_plan_id || !pendingPlan) return null;
    const quando = asDate(subscription.pending_plan_at);
    const agendada = this.scheduledView(subscription);
    return {
      id: Number(pendingPlan.id),
      name: pendingPlan.name,
      // O preço do ciclo agendado (0104): a troca pode ser só de ciclo.
      priceCents: this.cyclePriceCents(agendada, pendingPlan),
      billingCycle: this.cycleOf(agendada, pendingPlan),
      effectiveAt: quando ? quando.toISOString() : null,
      // Paga pelo preço dela: não se cancela nem se troca mais pela tela.
      locked: this.isPendingLocked(subscription)
    };
  }

  /**
   * O primeiro teto de `limits` que `usage` já passa — ou nulo.
   *
   * Um recurso sem teto, ou sem contagem (a de ONTs falha quando o ACS está
   * fora), não decide nada: dado que não se tem não vira recusa, a mesma regra
   * de `usage`. A ordem é a da tela — operadores, assinantes, ONTs — para que
   * a mesma situação dê sempre a mesma resposta.
   */
  static overLimitFor(limits, usage, overagePrices = null) {
    for (const resource of ['operators', 'subscribers', 'devices']) {
      const limit = limits?.[resource] ?? null;
      const used = usage?.[resource];
      if (limit === null || used === null || used === undefined) continue;
      // Com preço de excedente (0105), o teto não barra: quem passa paga as
      // unidades a mais na fatura. Só o recurso sem preço continua barrando.
      if (overagePrices?.[resource]) continue;
      if (used > limit) return { resource, used, limit };
    }
    return null;
  }

  /**
   * O que impede o plano `plan` de valer para o provedor em escopo agora, ou
   * nulo — contando só o que o plano limita.
   *
   * É a pergunta que a descida agendada faz ao chegar a hora, e ela é feita
   * pelo agendador a cada minuto enquanto o uso não couber: contar ONTs no ACS
   * a cada minuto para um plano que nem limita ONTs seria carga à toa.
   */
  static async overLimitOf(plan, { countDevices = null } = {}) {
    const limits = this.limitsOf(plan);
    // O recurso com preço de excedente não barra (`overLimitFor`), e nem é
    // contado: contar ONTs no ACS para uma resposta que não muda nada seria
    // carga à toa.
    const precos = this.overagePricesOf(plan);
    const usage = {};
    if (limits.operators !== null && !precos.operators) usage.operators = await this.operatorCount();
    if (limits.subscribers !== null && !precos.subscribers) usage.subscribers = await this.subscriberCount();
    if (limits.devices !== null && !precos.devices && typeof countDevices === 'function') {
      try {
        usage.devices = await countDevices();
      } catch {
        usage.devices = null;
      }
    }
    return this.overLimitFor(limits, usage, precos);
  }

  /**
   * O que impede a troca AGENDADA de `subscription` para `plan` de valer —
   * `overLimitOf`, menos dois casos que não têm o que conferir: a travada
   * (paga pelo preço dela, 0075) e a troca só de CICLO (0104), no mesmo
   * plano — os tetos são os mesmos de agora, e o uso acima deles não é razão
   * para o provedor não passar ao anual (ou de volta ao mensal).
   */
  static async scheduledOverLimit(subscription, plan, { countDevices = null } = {}) {
    if (this.isPendingLocked(subscription)) return null;
    if (plan && subscription?.plan_id && Number(plan.id) === Number(subscription.plan_id)) return null;
    return this.overLimitOf(plan, { countDevices });
  }

  /** Os dias que um pagamento compra neste plano (ou a reserva de trinta). */
  static periodDaysOf(plan) {
    return periodoDoPlano(plan);
  }

  static limitsOf(plan) {
    const asLimit = (value) => (value === null || value === undefined ? null : Number(value));
    return {
      operators: asLimit(plan?.max_operators),
      subscribers: asLimit(plan?.max_subscribers),
      devices: asLimit(plan?.max_devices)
    };
  }

  // ── Excedente (0105) ─────────────────────────────────────────────────

  /**
   * O preço, em centavos, de cada unidade acima do teto do plano — nulo onde
   * o plano não tem preço (e aí o teto barra, como sempre). Zero e lixo
   * também são "sem preço": excedente de graça é teto nenhum, e isso o plano
   * já diz com o limite nulo.
   */
  static overagePricesOf(plan) {
    const asPrice = (value) => {
      const n = Number(value);
      return value === null || value === undefined || !Number.isInteger(n) || n <= 0 ? null : n;
    };
    return {
      operators: asPrice(plan?.overage_price_cents_operators),
      subscribers: asPrice(plan?.overage_price_cents_subscribers),
      devices: asPrice(plan?.overage_price_cents_devices)
    };
  }

  /**
   * As parcelas do excedente de `plan` para os picos `peaks`
   * (`{ operators, subscribers, devices }`, nulo onde não se mediu):
   * `max(0, pico − teto) × preço` por recurso com teto E preço. Só as
   * parcelas com unidade a cobrar; pura e síncrona — a emissão, a tela e o
   * teste fazem a mesma conta.
   *
   * @returns {Array<{ resource: string, peak: number, limit: number,
   *   unitCents: number, units: number, cents: number }>}
   */
  static overageFor(plan, peaks) {
    const limites = this.limitsOf(plan);
    const precos = this.overagePricesOf(plan);
    const parcelas = [];
    for (const resource of USAGE_RESOURCES) {
      const limit = limites[resource];
      const unitCents = precos[resource];
      const pico = peaks?.[resource];
      if (limit === null || !unitCents || pico === null || pico === undefined) continue;
      const peak = Math.floor(Number(pico));
      if (!Number.isFinite(peak)) continue;
      const units = Math.max(0, peak - limit);
      if (units <= 0) continue;
      parcelas.push({ resource, peak, limit, unitCents, units, cents: units * unitCents });
    }
    return parcelas;
  }

  /**
   * As parcelas de excedente de um período pelas linhas de `usage_peaks`
   * (`UsagePeak.rowsForPeriod`): pela FOTOGRAFIA do plano que valia quando o
   * excedente maior foi medido (o teto e o preço de então), e — na linha sem
   * fotografia — pelo plano `plan` de agora, como antes. Cada parcela leva a
   * chave do período (`periodKey`).
   */
  static overageFromRows(plan, rows, periodKey = null) {
    const parcelas = [];
    const semFoto = {};
    for (const resource of USAGE_RESOURCES) {
      const linha = rows?.[resource];
      if (!linha) continue;
      if (linha.unitCents === null || linha.unitCents === undefined || linha.limit === null || linha.limit === undefined) {
        semFoto[resource] = linha.peak;
        continue;
      }
      const uso = Math.floor(Number(linha.overagePeak ?? linha.peak));
      const units = Math.max(0, uso - Math.floor(Number(linha.limit)));
      if (!(units > 0)) continue;
      const unitCents = Math.floor(Number(linha.unitCents));
      parcelas.push({
        resource, peak: uso, limit: Math.floor(Number(linha.limit)), unitCents, units, cents: units * unitCents
      });
    }
    parcelas.push(...this.overageFor(plan, semFoto));
    const ordem = (r) => USAGE_RESOURCES.indexOf(r);
    parcelas.sort((a, b) => ordem(a.resource) - ordem(b.resource));
    return periodKey ? parcelas.map((item) => ({ ...item, periodKey })) : parcelas;
  }

  /** A chave do período que a renovação desta assinatura fecha, ou nulo (sem período pago). */
  static overagePeriodKey(subscription) {
    return subscription?.renews_at ? chaveDoPeriodo(subscription.renews_at) : null;
  }

  /**
   * As fatias MENSAIS do período anual (0105 + 0104): o excedente de quem é
   * anual não espera um ano — é medido e cobrado a cada `period_days` do
   * plano (o mês), numa fatura de só excedente por fatia
   * (`ChargeIssuingService.issueOverageSlices`).
   *
   * O ano `[renews_at − 365 dias, renews_at)` em `floor(365 ÷ period_days)`
   * fatias de `period_days` dias; a última vai até `renews_at` (com o resto:
   * 35 dias, no mês de 30) e tem a chave da própria renovação — é a fatura
   * do ano seguinte que a fecha, como no mensal. Vazio fora do anual ou sem
   * período pago.
   *
   * @returns {Array<{ start: Date, end: Date, key: string, last: boolean }>}
   */
  static overageSlices(subscription, plan) {
    const fim = asDate(subscription?.renews_at);
    if (!fim || this.cycleOf(subscription, plan) !== 'annual') return [];
    const dias = periodoDoPlano(plan);
    const inicio = new Date(fim.getTime() - ANNUAL_PERIOD_DAYS * DAY_MS);
    const n = Math.max(1, Math.floor(ANNUAL_PERIOD_DAYS / dias));
    const fatias = [];
    for (let k = 1; k <= n; k += 1) {
      const ultima = k === n;
      const de = new Date(inicio.getTime() + (k - 1) * dias * DAY_MS);
      const ate = ultima ? fim : new Date(inicio.getTime() + k * dias * DAY_MS);
      fatias.push({ start: de, end: ate, key: chaveDoPeriodo(ate), last: ultima });
    }
    return fatias;
  }

  /**
   * A chave em que o pico de AGORA se grava: a do período que a renovação
   * fecha, no mensal; a da fatia mensal corrente, no anual.
   */
  static usagePeakKey(subscription, plan, now = new Date()) {
    const fatias = this.overageSlices(subscription, plan);
    if (fatias.length) {
      const corrente = fatias.find((f) => now.getTime() >= f.start.getTime() && now.getTime() < f.end.getTime());
      if (corrente) return corrente.key;
    }
    return this.overagePeriodKey(subscription);
  }

  /**
   * Grava o pico de uso do período corrente do provedor em escopo — o passo
   * do agendador (0105). O período corrente é o que termina em `renews_at`,
   * e é o excedente dele que a cobrança daquela renovação soma
   * (`ChargeIssuingService.issueCurrent`).
   *
   * Só os recursos que o plano de agora limita E cobra por excedente: os
   * outros não viram dinheiro, e contar ONTs no ACS por nada é carga. A
   * contagem de ONTs que falha (ACS fora) não mexe no pico — dado que não se
   * tem não vira número, a regra de `usage`.
   *
   * Sem período pago (teste, assinatura sem data) não há o que medir: o
   * teste não gera fatura de excedente.
   *
   * @returns {Promise<{ recorded: boolean, reason?: string, periodEnd?: string,
   *   peaks?: object }>}
   */
  static async recordUsagePeaks({ countDevices = null, now = new Date() } = {}) {
    const subscription = await Subscription.forTenant(currentTenantId());
    if (!subscription) return { recorded: false, reason: 'no_subscription' };
    const planoDaFatia = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;
    // No anual (0104), a fatia mensal corrente (`overageSlices`).
    const periodo = this.usagePeakKey(subscription, planoDaFatia, now);
    if (!periodo) return { recorded: false, reason: 'no_period' };
    // A pausa de retenção CORRENDO (0107): o período pago acabou, o painel só
    // lê e nada se cobra — e o tempo pausado não vira excedente. Sem esta
    // trava, o uso medido na pausa cairia na chave de `renews_at` (que não
    // anda durante ela) e a fatura da volta cobraria o tempo pausado. Antes
    // de a pausa começar (o período pago ainda correndo) mede-se normalmente;
    // no fim dela, `CancellationService.retomarDaPausa` leva os picos do
    // período pago para a chave nova. O cancelamento agendado continua
    // medindo: desfeito, a renovação cobra o excedente do período que usou.
    if (isPaused(subscription, now)) return { recorded: false, reason: 'paused' };
    const plano = planoDaFatia;
    const limites = this.limitsOf(plano);
    const precos = this.overagePricesOf(plano);
    const medir = USAGE_RESOURCES.filter((recurso) => limites[recurso] !== null && precos[recurso]);
    if (!medir.length) return { recorded: false, reason: 'no_overage_price' };
    const agora = {};
    if (medir.includes('operators')) agora.operators = await this.operatorCount();
    if (medir.includes('subscribers')) agora.subscribers = await this.subscriberCount();
    if (medir.includes('devices') && typeof countDevices === 'function') {
      try {
        const n = await countDevices();
        if (Number.isInteger(n) && n >= 0) agora.devices = n;
      } catch {
        // ACS fora: o pico das ONTs fica como estava.
      }
    }
    const peaks = {};
    for (const [recurso, valor] of Object.entries(agora)) {
      // eslint-disable-next-line no-await-in-loop -- três recursos no máximo
      // Com a fotografia do plano em vigor (0105): o teto e o preço de agora.
      peaks[recurso] = await UsagePeak.record(periodo, recurso, valor, {
        limit: limites[recurso], unitCents: precos[recurso]
      });
    }
    return { recorded: true, periodEnd: periodo, peaks };
  }

  /**
   * Os tetos de retenção do plano, em dias; `null` é sem teto.
   *
   * `audit` é a trilha de auditoria, `messages` e `media` são o histórico e os
   * anexos do WhatsApp. Separados dos `limits` porque não são contagem de uso
   * — ninguém "passa" de um teto de retenção, o que passa é apagado.
   */
  static retentionCapsOf(plan) {
    const asCap = (value) => {
      const n = Number(value);
      return value === null || value === undefined || !Number.isInteger(n) || n < 1 ? null : n;
    };
    return {
      audit: asCap(plan?.max_audit_retention_days),
      messages: asCap(plan?.max_message_retention_days),
      media: asCap(plan?.max_media_retention_days)
    };
  }

  /** Os tetos do provedor em escopo. Na self-hosted não há plano, e não há teto. */
  static async retentionCaps() {
    if (!IS_SAAS) return this.retentionCapsOf(null);
    const { plan } = await this.current();
    return this.retentionCapsOf(plan);
  }

  /**
   * Os dias que valem, dado o que o provedor escolheu e o teto do plano.
   *
   * Sem teto, é o que o provedor escolheu — inclusive zero, "para sempre". Com
   * teto, o menor dos dois, e "para sempre" vira o teto: guardar para sempre
   * é justamente o que o teto existe para impedir.
   */
  static capRetention(days, cap) {
    const escolhido = Math.trunc(Number(days));
    if (cap === null || cap === undefined) return Number.isFinite(escolhido) && escolhido > 0 ? escolhido : 0;
    if (!Number.isFinite(escolhido) || escolhido <= 0) return cap;
    return Math.min(escolhido, cap);
  }

  /** `capRetention` para o provedor em escopo; `kind` é `audit`, `messages` ou `media`. */
  static async effectiveRetention(kind, days) {
    const caps = await this.retentionCaps();
    return this.capRetention(days, caps[kind] ?? null);
  }

  // ── Limites ──────────────────────────────────────────────────────────

  /** Quantas pessoas trabalham no provedor em escopo. */
  static async operatorCount() {
    const [row] = await getDb()('tenant_users')
      .where({ tenant_id: currentTenantId() })
      .count({ n: '*' });
    return Number(row?.n ?? 0);
  }

  static async subscriberCount() {
    // Só as vivas: uma conta aposentada por troca de ONT não ocupa vaga.
    const [row] = await tdb('customer_accounts').where({ active: true }).count({ n: '*' });
    return Number(row?.n ?? 0);
  }

  /**
   * Lança se o provedor em escopo não pode ganhar mais um operador.
   *
   * Conta a partir do banco, não do cache: o limite existe para o dia em que
   * dois administradores criam ao mesmo tempo, e um número guardado 15 s atrás
   * é exatamente o que os dois leriam.
   */
  static async assertCanAddOperator() {
    const { plan } = await this.current();
    const limit = this.limitsOf(plan).operators;
    if (limit === null) return;
    // Com preço de excedente (0105), o operador a mais entra e é cobrado.
    if (this.overagePricesOf(plan).operators) return;
    const current = await this.operatorCount();
    if (current >= limit) {
      throw new PlanLimitError('plan_limit_operators', { limit, current, resource: 'operators' });
    }
  }

  /**
   * Quantos assinantes ainda cabem, ou null quando não há limite.
   *
   * Devolve um número em vez de lançar porque quem pergunta é a sincronização
   * de aparelhos, que roda no fundo e cria contas em lote: ela precisa saber
   * quantas ainda pode criar nesta passada, e a passada seguinte pergunta de
   * novo. Lançar ali derrubaria a sincronização inteira por causa da conta que
   * não coube.
   */
  static async remainingSubscribers() {
    const { plan } = await this.current();
    const limit = this.limitsOf(plan).subscribers;
    if (limit === null) return null;
    // Com preço de excedente (0105), não há teto brando: o assinante a mais
    // é criado e cobrado na fatura.
    if (this.overagePricesOf(plan).subscribers) return null;
    return Math.max(0, limit - await this.subscriberCount());
  }

  /**
   * Uso contra limites, para a tela e para o console.
   *
   * A contagem de ONTs vem do GenieACS e pode falhar — ACS fora, credencial
   * errada. Ela vira `null` em vez de derrubar a resposta: os outros dois
   * números continuam valendo, e a tela diz "não deu para contar" em vez de
   * nada.
   */
  static async usage({ countDevices } = {}) {
    const state = await this.current();
    const limits = this.limitsOf(state.plan);
    const [operators, subscribers] = await Promise.all([
      this.operatorCount(),
      this.subscriberCount()
    ]);
    let devices = null;
    if (typeof countDevices === 'function') {
      try {
        devices = await countDevices();
      } catch {
        devices = null;
      }
    }
    const over = (used, limit) => (limit !== null && used !== null && used > limit);
    const subscription = this.present(state);
    // A descida agendada que não vai se aplicar enquanto o uso não couber:
    // calculada aqui, com as contagens que esta tela já fez, para a tela
    // avisar ANTES da renovação — e não o provedor descobrir depois que
    // continuou pagando o plano caro porque tinha operadores demais.
    // A travada (paga pelo preço dela) não tem bloqueio: aplica-se na data
    // com o uso que houver.
    if (subscription?.pendingPlan?.locked
      || (subscription?.pendingPlan && Number(state.pendingPlan?.id) === Number(state.plan?.id))) {
      // A travada, e a troca só de ciclo (0104): nada a caber.
      subscription.pendingPlan.blockedBy = null;
    } else if (subscription?.pendingPlan) {
      subscription.pendingPlan.blockedBy = this.overLimitFor(
        this.limitsOf(state.pendingPlan), { operators, subscribers, devices }, this.overagePricesOf(state.pendingPlan)
      );
    }
    return {
      subscription,
      usage: { operators, subscribers, devices },
      limits,
      overage: await this.presentOverage(state, { operators, subscribers, devices }),
      retention: IS_SAAS ? this.retentionCapsOf(state.plan) : this.retentionCapsOf(null),
      over: {
        operators: over(operators, limits.operators),
        subscribers: over(subscribers, limits.subscribers),
        devices: over(devices, limits.devices)
      }
    };
  }

  /**
   * O excedente do período corrente como a tela o mostra (0105): os preços
   * do plano e, por recurso que passou do teto, "N × R$ X = R$ Y" — com o
   * maior entre o pico guardado e o uso de agora, que é o que a fatura da
   * renovação vai cobrar se nada mudar até a emissão. Nulo quando o plano não
   * tem preço de excedente nenhum.
   */
  static async presentOverage(state, usoAgora) {
    const precos = this.overagePricesOf(state?.plan);
    if (!precos.operators && !precos.subscribers && !precos.devices) return null;
    // No anual (0104), a fatia mensal corrente: é ela que vira fatura.
    const anual = this.overageSlices(state?.subscription, state?.plan).length > 0;
    const periodo = this.usagePeakKey(state?.subscription, state?.plan);
    const linhas = periodo ? await UsagePeak.rowsForPeriod(periodo) : {};
    // O que se deve pelas fotografias gravadas, e o que o uso de AGORA deve
    // pelo plano de agora — por recurso, o maior dos dois.
    const gravadas = periodo ? this.overageFromRows(state.plan, linhas) : [];
    const agora = periodo ? this.overageFor(state.plan, usoAgora ?? {}) : [];
    const items = [];
    for (const recurso of USAGE_RESOURCES) {
      const candidatos = [...gravadas, ...agora].filter((item) => item.resource === recurso);
      if (!candidatos.length) continue;
      items.push(candidatos.reduce((maior, item) => (item.cents > maior.cents ? item : maior)));
    }
    return {
      prices: precos,
      periodEnd: periodo,
      // Como o excedente é cobrado: na fatura da renovação (`renewal`), ou
      // numa fatura de só excedente a cada mês do anual (`monthly`).
      billing: anual ? 'monthly' : 'renewal',
      items,
      totalCents: items.reduce((soma, item) => soma + item.cents, 0),
      currency: String(state?.plan?.currency || 'BRL').toUpperCase()
    };
  }

  // ── Mudanças (chamadas pelo console, no escopo do provedor alvo — e, a
  // troca de plano, também pelo próprio provedor, via `SelfBillingService`,
  // que confere antes o que só vale para quem troca por dentro) ──────────

  /**
   * Troca o plano do provedor em escopo, NA HORA. O status não muda: quem está
   * em `past_due` continua devendo, só que num plano diferente.
   *
   * E apaga a descida agendada, se houver uma: uma troca que vale agora é a
   * última palavra sobre o plano, venha do console ou do provedor (a subida,
   * a descida sem período pago correndo). Deixar a agendada viva faria o
   * plano escolhido agora ser trocado de novo na renovação por uma decisão
   * que a de agora já substituiu.
   */
  static async changePlan({
    planId, actorUserId = null, upgradedAt = null, eventDetail = null, billingCycle = null
  }) {
    const tenantId = currentTenantId();
    const plan = await Plan.findById(planId);
    if (!plan) throw new Error('Plan not found');
    const before = await Subscription.forTenant(tenantId);
    // O ciclo (0104): o pedido, ou o de agora — que no plano sem preço anual
    // só pode ser o mensal. Pedir o anual a um plano sem ele é erro de quem
    // chama (a troca por dentro já recusa antes, com `cycle_unavailable`).
    const pedido = parseBillingCycle(billingCycle);
    if (pedido === 'annual' && !annualAvailable(plan)) throw new Error('Plan has no annual price');
    const cicloAntes = parseBillingCycle(before?.billing_cycle) ?? 'monthly';
    const ciclo = pedido ?? (cicloAntes === 'annual' && annualAvailable(plan) ? 'annual' : 'monthly');
    const subscription = await Subscription.upsertForTenant(tenantId, {
      plan_id: plan.id,
      billing_cycle: ciclo,
      pending_plan_id: null,
      pending_plan_at: null,
      pending_plan_locked_at: null,
      pending_billing_cycle: null,
      // A marca da subida no meio do período pago (0075): quem sobe agora a
      // passa (`SelfBillingService`), e qualquer outra troca — o console, a
      // descida na hora — a apaga, porque o plano de agora não é mais o que
      // subiu sem pagar.
      upgraded_at: upgradedAt,
      ...(before ? {} : { status: 'active' })
    });
    await BillingEvent.record({
      subscriptionId: subscription.id,
      type: BILLING_EVENT_TYPES.PLAN_CHANGED,
      createdBy: actorUserId,
      detail: {
        from: before?.plan_id ?? null,
        to: plan.id,
        toCode: plan.code,
        ...(ciclo !== cicloAntes ? { cycleFrom: cicloAntes, cycleTo: ciclo } : {}),
        ...(before?.pending_plan_id ? { pendingCleared: Number(before.pending_plan_id) } : {}),
        // O que a troca disse sobre a pró-rata (0101), quando quem troca é o
        // provedor subindo — inclusive a que não saiu por ser menor que o
        // mínimo: é aqui que alguém procura "por que não cobrou?".
        ...(eventDetail ?? {})
      }
    });
    // Passou ao anual agora: o cupom de N faturas do mensal sai (0104).
    if (ciclo === 'annual' && cicloAntes !== 'annual' && before?.coupon_id) {
      await this.dropCouponForAnnual(before, { actorUserId });
      cache.invalidate();
      return Subscription.forTenant(tenantId);
    }
    cache.invalidate();
    return subscription;
  }

  /**
   * Agenda a descida para `at` — o fim do período pago que está correndo.
   *
   * Só a linha e o cache: nenhum evento no extrato, porque nada mudou ainda —
   * o plano, os tetos e o preço deste período são os de antes. O "plano
   * trocado" entra no extrato quando a troca de fato acontece
   * (`applyPendingPlan`), e a trilha de auditoria de quem pediu é do
   * controlador. Uma segunda descida por cima substitui a primeira: é a mesma
   * coluna, e só existe uma renovação por vez.
   */
  static async schedulePlanChange({ planId, at, billingCycle = null }) {
    const tenantId = currentTenantId();
    const quando = asDate(at);
    if (!quando) throw new Error('A scheduled plan change needs a date');
    const subscription = await Subscription.upsertForTenant(tenantId, {
      pending_plan_id: planId,
      pending_plan_at: quando,
      pending_plan_locked_at: null,
      // O ciclo da troca (0104), nulo quando é o de agora.
      pending_billing_cycle: parseBillingCycle(billingCycle)
    });
    cache.invalidate();
    return subscription;
  }

  /** Desiste da descida agendada: o plano atual segue depois da renovação. */
  static async cancelPendingPlan() {
    const tenantId = currentTenantId();
    const subscription = await Subscription.upsertForTenant(tenantId, {
      pending_plan_id: null,
      pending_plan_at: null,
      pending_plan_locked_at: null,
      pending_billing_cycle: null
    });
    cache.invalidate();
    return subscription;
  }

  /**
   * Se a descida agendada já foi PAGA pelo preço dela (0075): o período que
   * começa na data da descida teve o pagamento conferido contra o plano
   * novo. Dali em diante ela não se desfaz nem espera o uso caber.
   */
  static isPendingLocked(subscription) {
    return Boolean(subscription?.pending_plan_id && subscription?.pending_plan_locked_at);
  }

  /**
   * Aplica a descida agendada do provedor em escopo, se chegou a hora e se o
   * uso cabe no plano novo.
   *
   * Chamada pelo agendador a cada passada, ANTES da emissão, e por
   * `recordPayment` quando o pagamento abre o período que já é do plano novo.
   * Nunca lança por causa do uso: não caber é o caso esperado de quem pediu a
   * descida e não se ajustou, e a resposta é continuar no plano atual — que é
   * o que ele comporta — com a agendada viva, até caber ou até alguém
   * desistir dela. O aviso sai uma vez por agendamento, e não a cada minuto;
   * a tela mostra o mesmo bloqueio o tempo todo (`pendingPlan.blockedBy`).
   *
   * @returns {Promise<{ applied: boolean, reason?: string, from?: number,
   *   to?: number, blockedBy?: object }>}
   */
  static async applyPendingPlan({ now = new Date(), countDevices = null } = {}) {
    const tenantId = currentTenantId();
    const subscription = await Subscription.forTenant(tenantId);
    if (!subscription?.pending_plan_id) return { applied: false, reason: 'none' };
    const quando = asDate(subscription.pending_plan_at);
    if (quando && quando.getTime() > now.getTime()) return { applied: false, reason: 'not_due' };

    // A pausa de retenção correndo (0107): a troca agendada (a descida, o
    // ciclo anual) espera a renovação de verdade — a do fim da pausa, quando
    // `retomarDaPausa` move `renews_at` e esta mesma volta a aplica, antes
    // da emissão. Aplicá-la no meio da pausa trocaria o plano de quem não
    // está renovando nada. A travada (já paga pelo preço dela) não espera.
    if (isPaused(subscription, now) && !this.isPendingLocked(subscription)) {
      return { applied: false, reason: 'paused' };
    }

    const plano = await Plan.findById(subscription.pending_plan_id);
    if (!plano) {
      // O console não apaga plano, mas um banco mexido à mão pode. Uma
      // agendada para lugar nenhum não tem como se aplicar nunca, e ficaria
      // tentando para sempre: sai, e o provedor fica onde está.
      await this.cancelPendingPlan();
      return { applied: false, reason: 'plan_gone' };
    }

    // Paga pelo preço dela, a descida se aplica na data com o uso que houver:
    // segurá-la porque o uso cresceu DEPOIS de pagar o barato seria entregar
    // o plano caro pelo preço do barato — o buraco que a trava fecha. Acima
    // dos tetos, o provedor só não cresce mais (o 402 de operador, a
    // sincronização que não cria assinante); o que já existe fica.
    const travada = this.isPendingLocked(subscription);
    const blockedBy = await this.scheduledOverLimit(subscription, plano, { countDevices });
    if (blockedBy) {
      const marca = `${subscription.pending_plan_id}@${quando ? quando.getTime() : 'now'}`;
      if (avisosDeBloqueio.get(tenantId) !== marca) {
        avisosDeBloqueio.set(tenantId, marca);
        console.warn(
          `Scheduled plan change of provider ${tenantId} to plan ${plano.id} was not applied: `
          + `${blockedBy.used} ${blockedBy.resource} over the limit of ${blockedBy.limit}; it stays pending`
        );
      }
      return { applied: false, reason: 'over_limit', blockedBy };
    }

    const aplicou = await Subscription.applyPendingPlan(tenantId, plano.id);
    if (!aplicou) return { applied: false, reason: 'raced' };
    avisosDeBloqueio.delete(tenantId);
    await BillingEvent.record({
      subscriptionId: subscription.id,
      type: BILLING_EVENT_TYPES.PLAN_CHANGED,
      detail: {
        from: subscription.plan_id ?? null, to: plano.id, toCode: plano.code, scheduled: true,
        ...cycleChangeDetail(subscription),
        ...(travada ? { locked: true } : {})
      }
    });
    if (cycleChangeDetail(subscription).cycleTo === 'annual') await this.dropCouponForAnnual(subscription);
    cache.invalidate();
    return { applied: true, from: subscription.plan_id ?? null, to: plano.id, locked: travada };
  }

  /**
   * Muda o status à mão. `active` por aqui não é pagamento — pagamento é
   * `recordPayment`, que estende o período; isto é o botão de "libera" que
   * um humano aperta com razão própria, e a razão vai no extrato.
   */
  static async setStatus({
    status, reason = null, actorUserId = null, trialEndsAt, renewsAt, suspendedReason = SUSPENDED_REASONS.MANUAL
  }) {
    if (!STATUSES.includes(status)) throw new Error(`Status must be one of: ${STATUSES.join(', ')}`);
    const tenantId = currentTenantId();
    const before = await Subscription.forTenant(tenantId);
    if (!before) throw new Error('Subscription not found');
    // O motivo da suspensão (0102): suspender por aqui é gente (`manual`, que
    // o pagamento não desfaz); qualquer outro estado o apaga.
    const patch = {
      status,
      suspended_reason: status === 'suspended' ? (suspendedReason || SUSPENDED_REASONS.MANUAL) : null
    };
    if (trialEndsAt !== undefined) patch.trial_ends_at = asDate(trialEndsAt);
    if (renewsAt !== undefined) patch.renews_at = asDate(renewsAt);
    patch.canceled_at = status === 'canceled' ? new Date() : null;
    // A retenção (0107): cancelar à mão encerra a pausa e o agendamento; e
    // tirar do `canceled` não pode deixar para trás uma data de cancelamento
    // vencida, que o agendador cumpriria de novo na passada seguinte.
    if (status === 'canceled' || before.status === 'canceled') {
      patch.cancel_at = null;
      patch.paused_until = null;
      patch.pause_started_at = null;
    }
    // O prazo mudado junto com o status leva a cobrança em aberto com ele,
    // ANTES de ser gravado — ver `followOpenCharge`.
    if (trialEndsAt !== undefined || renewsAt !== undefined) await followOpenCharge(before, patch);
    const subscription = await Subscription.upsertForTenant(tenantId, patch);
    // Cancelada ou suspensa à mão (0101): a fatura de pró-rata que ainda não
    // chegou ao gateway não vai mais — a retentativa do agendador a levaria
    // depois da decisão. A que já tem link fica como está.
    let prorationsCanceled = 0;
    if (!isBillableStatus(subscription)) {
      try {
        prorationsCanceled = await BillingCharge.cancelUnissuedProrations({ reason: 'not_billable' });
      } catch (error) {
        console.warn(`Could not cancel the unissued proration charges of provider ${tenantId}: ${error.message}`);
      }
    }
    await BillingEvent.record({
      subscriptionId: subscription.id,
      type: BILLING_EVENT_TYPES.STATUS_CHANGED,
      createdBy: actorUserId,
      detail: {
        from: before.status,
        to: status,
        reason,
        ...(status === 'suspended' ? { suspendedReason: patch.suspended_reason } : {}),
        ...(prorationsCanceled ? { prorationsCanceled } : {})
      }
    });
    cache.invalidate();
    return subscription;
  }

  /**
   * Mexe nos PRAZOS do provedor em escopo sem mexer no estado — a cortesia de
   * alguns dias, a data corrigida à mão pelo console.
   *
   * Três formas de pedir, e o controlador garante que venha uma só:
   *
   *   - `extendDays`: soma ao prazo VIVO. Em `trial`, o fim do teste; em
   *     qualquer outro estado, a renovação. Soma a partir do maior entre o
   *     prazo e agora — estender em cinco dias quem venceu há dez não pode
   *     devolver um prazo que continua vencido, e estender quem vence daqui a
   *     vinte não pode jogar fora os vinte.
   *   - `renewsAt` e/ou `trialEndsAt`: a data exata. `trialEndsAt: null` apaga
   *     o prazo do teste; `renewsAt` nulo não é aceito lá em cima, porque
   *     "sem renovação" é assinatura fora de ciclo, e isso é decisão de
   *     status, não de prazo.
   *
   * O status NÃO muda — com uma exceção, a do `past_due` GRAVADO que ganha um
   * prazo no futuro, e que volta a `active` (ver abaixo) —, e é o que separa
   * isto de `setStatus`. Mas o estado que
   * VALE pode mudar, e é o ponto: `effectiveStatus` calcula `past_due` a partir
   * do prazo, então um `active` vencido volta a passar no instante em que o
   * prazo anda — sem ninguém gravar `active` à mão e sem registrar pagamento
   * que não houve.
   *
   * A descida agendada (0074) que estava marcada para o fim do período anda
   * junto com ele: ela quer dizer "na renovação", e deixá-la na data velha a
   * aplicaria no meio do período que a cortesia acabou de esticar. Só quando
   * ela está exatamente na renovação antiga — uma agendada para outra data é
   * outra decisão, e fica como está.
   *
   * A cobrança em aberto do prazo velho vai junto para o novo — no gateway
   * e na linha —, antes de o prazo ser gravado (`followOpenCharge`). Sem
   * isso, a emissão abriria outra para o prazo novo com a primeira ainda viva
   * na Asaas: duas faturas, e o provedor cobrado pela que o painel esqueceu.
   *
   * Uma linha no extrato (`deadline.changed`, com `courtesy: true` quando é
   * uma extensão), porque é o extrato que responde "por que este provedor
   * renovou sem pagar?".
   *
   * @returns {Promise<object>} a assinatura depois da mudança.
   */
  static async setDeadlines({
    renewsAt = undefined, trialEndsAt = undefined, extendDays = null,
    reason = null, actorUserId = null, now = new Date(), externalId = null
  }) {
    const tenantId = currentTenantId();
    const before = await Subscription.forTenant(tenantId);
    if (!before) throw new Error('Subscription not found');

    const patch = {};
    if (extendDays !== null && extendDays !== undefined) {
      const dias = Number(extendDays);
      if (!Number.isInteger(dias) || dias < 1) throw new Error('extendDays must be a positive integer');
      const coluna = before.status === 'trial' ? 'trial_ends_at' : 'renews_at';
      const atual = asDate(before[coluna]);
      const base = atual && atual.getTime() > now.getTime() ? atual : now;
      patch[coluna] = new Date(base.getTime() + dias * DAY_MS);
    } else {
      if (renewsAt !== undefined) {
        const data = asDate(renewsAt);
        if (!data) throw new Error('renewsAt must be a date');
        patch.renews_at = data;
      }
      if (trialEndsAt !== undefined) {
        const data = trialEndsAt === null ? null : asDate(trialEndsAt);
        if (trialEndsAt !== null && !data) throw new Error('trialEndsAt must be a date or null');
        patch.trial_ends_at = data;
      }
    }
    if (!Object.keys(patch).length) throw new Error('Nothing to change');

    // A cortesia a quem está `past_due` GRAVADO (o console o pôs lá à mão)
    // precisa destravá-lo, ou não é cortesia nenhuma: `effectiveStatus` só
    // calcula `past_due` a partir do prazo em `active`, e um `past_due`
    // gravado continua bloqueando escrita com a renovação no ano que vem. Só
    // quando o prazo novo está de fato no futuro — mexer num prazo e deixá-lo
    // vencido não destrava nada, e o status fica como estava.
    if (before.status === 'past_due' && patch.renews_at && patch.renews_at.getTime() > now.getTime()) {
      patch.status = 'active';
    }

    // A cobrança em aberto acompanha o prazo, e ANTES de ele ser gravado: se o
    // gateway recusa, o prazo não se move — ver `followOpenCharge`.
    await followOpenCharge(before, patch, now);

    const renovacaoAntiga = asDate(before.renews_at);
    const agendada = asDate(before.pending_plan_at);
    if (patch.renews_at && before.pending_plan_id && renovacaoAntiga && agendada
      && agendada.getTime() === renovacaoAntiga.getTime()) {
      patch.pending_plan_at = patch.renews_at;
    }

    const iso = (valor) => {
      const data = asDate(valor);
      return data ? data.toISOString() : null;
    };
    const subscription = await getDb().transaction(async (trx) => {
      const depois = await Subscription.upsertForTenant(tenantId, patch, trx);
      await BillingEvent.record({
        subscriptionId: before.id,
        type: BILLING_EVENT_TYPES.DEADLINE_CHANGED,
        // A chave do pedido, quando há (a cortesia em massa): o índice único
        // `(tenant_id, external_id)` faz o mesmo pedido repetido desfazer a
        // transação inteira em vez de dar o prazo duas vezes.
        externalId,
        createdBy: actorUserId,
        detail: {
          ...(extendDays ? { courtesy: true, extendDays: Number(extendDays) } : {}),
          from: { renewsAt: iso(before.renews_at), trialEndsAt: iso(before.trial_ends_at) },
          to: { renewsAt: iso(depois.renews_at), trialEndsAt: iso(depois.trial_ends_at) },
          status: before.status,
          ...(patch.status ? { statusAfter: patch.status } : {}),
          reason
        }
      }, trx);
      return depois;
    });
    cache.invalidate();
    return subscription;
  }

  /**
   * Liga ou desliga o "isento de cobrança" de um provedor: ativo, sem fatura,
   * até alguém desligar. Chamado pelo console.
   *
   * ## Ligar
   *
   *   - grava `billing_exempt_at` (agora) e o motivo;
   *   - o `past_due` ou `suspended` GRAVADO vira `active` — isentar quem
   *     continua bloqueado não isentaria nada. `trial` fica `trial` na coluna
   *     (e `active` para quem lê: `effectiveStatus`);
   *   - cancela as cobranças em aberto, no gateway e aqui, pelo mesmo gesto do
   *     "cancelar" da tela de Assinaturas (`ChargeIssuingService.cancelOpenCharges`).
   *     A que o gateway recusar fica em aberto e é dita no log: a isenção vale
   *     mesmo assim.
   *
   * A isenção é gravada ANTES de falar com o gateway: a partir dela a emissão
   * para (`issueCurrent` → `billing_exempt`), e o agendador não abre uma
   * cobrança nova no meio do cancelamento das velhas.
   *
   * Só de assinatura viva ou parada por inadimplência (`trial`, `active`,
   * `past_due`, `suspended`); a `canceled` é 409 `not_billable` — o contrato
   * acabou, e não há cobrança de que isentar.
   *
   * ## Desligar
   *
   * Limpa os dois campos, e a cobrança volta pelo plano atual. Se o prazo vivo
   * já passou — ou, num plano pago, não existe —, ganha `LEAD_DAYS` a partir de
   * agora: sem isso o provedor ficaria vencido no mesmo segundo em que a
   * isenção sai, sem ter recebido fatura nenhuma. Com isso a emissão acha o
   * prazo dentro da janela e manda a fatura na próxima passada. O `past_due`
   * gravado com o prazo no futuro volta a `active` (a regra de `setDeadlines`),
   * e a cobrança do período atual que a própria isenção cancelou é reaberta
   * para a emissão (`ChargeIssuingService.reopenExemptCanceled`).
   *
   * ## Com data de fim (`until`)
   *
   * `until` é até quando a isenção vale: uma data no futuro (senão 400
   * `invalid_until`), ou nulo para "até alguém desligar". Só cabe ao ligar
   * (`until_requires_exempt` ao desligar), e desligar limpa a coluna. Ligar
   * quem já está isento com OUTRO `until` muda só a data (`billing_exempt.updated`
   * no extrato, `untilChanged: true`); sem `until` (indefinido) não muda nada.
   * Passada a data, o agendador desliga pelo caminho de cima
   * (`endExpiredBillingExempt`, com `source: 'scheduler'` e `expiredBy`).
   *
   * ## Uma linha no extrato, e idempotente
   *
   * `billing_exempt.enabled`/`disabled`, sem referência externa (nulos não
   * colidem no índice único). Pedir o estado em que já está não grava nada e
   * responde `alreadyInState: true`. A gravação é condicional ao estado lido
   * (`Subscription.changeBillingExemptIf`): duas chamadas que desligam a mesma
   * isenção ao mesmo tempo gravam uma linha só, e a segunda responde
   * `alreadyInState: true`.
   *
   * @returns {Promise<{ subscription: object, canceledCharges: number,
   *   alreadyInState: boolean, failedCharges: number[], reopenedCharge: boolean,
   *   statusBefore: string, statusAfter: string }>}
   */
  static async setBillingExempt({
    tenantId, exempt, reason = null, until = undefined, actorUserId = null,
    source = 'console', expiredBy = null, now = new Date()
  }) {
    const ligar = Boolean(exempt);
    const motivo = reason === null || reason === undefined ? null : (String(reason).trim().slice(0, 255) || null);
    // `undefined` é "não mexer na data"; `null` é "sem data de fim".
    let ate;
    if (until === null) ate = null;
    else if (until !== undefined) {
      const lida = asDate(until);
      if (!lida) throw new BillingExemptError(400, 'invalid_until', 'until must be an ISO date-time');
      ate = aoSegundo(lida);
      if (!ligar) throw new BillingExemptError(400, 'until_requires_exempt', 'until only applies when exempt is true');
      if (ate.getTime() <= now.getTime()) {
        throw new BillingExemptError(400, 'invalid_until', 'until must be in the future');
      }
    }
    return runInTenant(tenantId, async () => {
      const before = await Subscription.forTenant(tenantId);
      if (!before) throw new BillingExemptError(404, 'subscription_not_found', 'Subscription not found');
      const jaIsento = Boolean(before.billing_exempt_at);
      const ateAntes = asDate(before.billing_exempt_until);
      const semMudanca = {
        subscription: before,
        canceledCharges: 0,
        failedCharges: [],
        reopenedCharge: false,
        alreadyInState: true,
        untilChanged: false,
        statusBefore: before.status,
        statusAfter: before.status
      };
      // O fim automático só desliga a isenção cuja data já passou — a que o
      // console estendeu ou tornou sem fim no meio do caminho fica.
      if (expiredBy && (!jaIsento || !ateAntes || ateAntes.getTime() > expiredBy.getTime())) return semMudanca;

      if (ligar && jaIsento) {
        // Já isento: só a data de fim pode mudar.
        if (ate === undefined) return semMudanca;
        if ((ate?.getTime() ?? null) === (ateAntes ? aoSegundo(ateAntes).getTime() : null)) return semMudanca;
        const subscription = await getDb().transaction(async (trx) => {
          const mudou = await Subscription.changeBillingExemptIf(
            tenantId, { wasExempt: true }, { billing_exempt_until: ate }, trx
          );
          if (!mudou) return null;
          await BillingEvent.record({
            subscriptionId: before.id,
            type: BILLING_EVENT_TYPES.BILLING_EXEMPT_UPDATED,
            createdBy: actorUserId,
            detail: { untilFrom: isoOf(ateAntes), untilTo: isoOf(ate) }
          }, trx);
          return Subscription.forTenant(tenantId, trx);
        });
        if (!subscription) return { ...semMudanca, subscription: await Subscription.forTenant(tenantId) };
        cache.invalidate();
        return {
          ...semMudanca,
          subscription,
          alreadyInState: false,
          untilChanged: true,
          untilBefore: isoOf(ateAntes)
        };
      }
      if (ligar === jaIsento) return semMudanca;
      if (ligar && !ESTADOS_ISENTAVEIS.has(before.status)) {
        throw new BillingExemptError(409, 'not_billable', `A ${before.status} subscription cannot be exempted from billing`);
      }

      const { default: ChargeIssuingService } = await import('./chargeIssuingService.js');
      const patch = {};
      const detalhe = { reason: motivo, statusBefore: before.status };
      if (source !== 'console') detalhe.source = source;
      if (ligar) {
        patch.billing_exempt_at = aoSegundo(now);
        patch.billing_exempt_reason = motivo;
        patch.billing_exempt_until = ate ?? null;
        if (ate) detalhe.until = ate.toISOString();
        if (before.status === 'past_due' || before.status === 'suspended') {
          patch.status = 'active';
          patch.suspended_reason = null;
        }
      } else {
        patch.billing_exempt_at = null;
        patch.billing_exempt_reason = null;
        patch.billing_exempt_until = null;
        detalhe.exemptSince = isoOf(before.billing_exempt_at);
        if (ateAntes) detalhe.exemptUntil = isoOf(ateAntes);
        // O prazo vivo, pela mesma coluna que a cortesia (`setDeadlines`) usa.
        const coluna = before.status === 'trial' ? 'trial_ends_at' : 'renews_at';
        const prazo = asDate(before[coluna]);
        const plano = before.plan_id ? await Plan.findById(before.plan_id) : null;
        const pago = SubscriptionService.cyclePriceCents(before, plano) > 0;
        const cobravel = before.status !== 'canceled';
        if (cobravel && ((prazo && prazo.getTime() <= now.getTime()) || (!prazo && pago))) {
          patch[coluna] = aoSegundo(new Date(now.getTime() + ChargeIssuingService.LEAD_DAYS * DAY_MS));
          detalhe.deadlineFrom = isoOf(prazo);
          detalhe.deadlineTo = patch[coluna].toISOString();
          detalhe.deadlineColumn = coluna;
          // A descida agendada para a renovação velha anda junto com ela, como
          // na cortesia: ela quer dizer "na renovação".
          const agendada = asDate(before.pending_plan_at);
          if (coluna === 'renews_at' && before.pending_plan_id && prazo && agendada
            && agendada.getTime() === prazo.getTime()) {
            patch.pending_plan_at = patch.renews_at;
          }
        }
        // O `past_due` GRAVADO com o prazo (talvez o de agora mesmo) no futuro
        // volta a `active`, pela mesma regra da cortesia (`setDeadlines`): quem
        // lê o estado não o recalcula a partir do prazo quando o gravado já
        // diz `past_due`, e o provedor sairia da isenção direto para o
        // bloqueio sem ter recebido a fatura do prazo que ainda nem venceu.
        const prazoDepois = coluna === 'renews_at' ? (patch.renews_at ?? prazo) : null;
        if (before.status === 'past_due' && prazoDepois && prazoDepois.getTime() > now.getTime()) {
          patch.status = 'active';
        }
      }
      if (patch.status) detalhe.statusAfter = patch.status;

      const subscription = await getDb().transaction(async (trx) => {
        // Condicional ao que se leu: quem perde a corrida não grava nada.
        const mudou = await Subscription.changeBillingExemptIf(
          tenantId, { wasExempt: jaIsento, expiredBy }, patch, trx
        );
        if (!mudou) return null;
        await BillingEvent.record({
          subscriptionId: before.id,
          type: ligar ? BILLING_EVENT_TYPES.BILLING_EXEMPT_ENABLED : BILLING_EVENT_TYPES.BILLING_EXEMPT_DISABLED,
          createdBy: actorUserId,
          detail: detalhe
        }, trx);
        return Subscription.forTenant(tenantId, trx);
      });
      if (!subscription) return { ...semMudanca, subscription: await Subscription.forTenant(tenantId) };
      cache.invalidate();

      let cancelamento = { canceled: 0, failed: [] };
      let reaberta = false;
      if (ligar) {
        try {
          cancelamento = await ChargeIssuingService.cancelOpenCharges({ now });
        } catch (error) {
          // A isenção já está gravada e vale; o que sobrou em aberto a
          // varredura do agendador cancela (`issueCurrent` → `billing_exempt`).
          console.warn(`Could not cancel the open charges of provider ${tenantId} after exempting it: ${error.message}`);
        }
      } else {
        // A cobrança do período atual que a isenção cancelou volta à emissão:
        // sem isto ela ficaria `canceled`, o agendador responderia
        // `already_settled` e o provedor venceria sem fatura. O período é o do
        // prazo de AGORA (talvez o que acabou de ganhar `LEAD_DAYS`), lido como
        // a emissão o lê.
        const prazoVivo = asDate(subscription?.renews_at ?? subscription?.trial_ends_at);
        if (prazoVivo) {
          try {
            reaberta = await ChargeIssuingService.reopenExemptCanceled(
              ChargeIssuingService.periodKey(prazoVivo), { now }
            );
          } catch (error) {
            console.warn(`Could not reopen the exempted charge of provider ${tenantId}: ${error.message}`);
          }
        }
      }

      return {
        subscription,
        canceledCharges: cancelamento.canceled,
        failedCharges: cancelamento.failed,
        reopenedCharge: reaberta,
        alreadyInState: false,
        untilChanged: false,
        statusBefore: before.status,
        statusAfter: subscription?.status ?? before.status
      };
    });
  }

  /**
   * O fim automático da isenção com data de fim: passado o
   * `billing_exempt_until`, desliga pelo MESMO caminho do console
   * (`setBillingExempt({ exempt: false })`) — o prazo que ganha `LEAD_DAYS`
   * se já venceu, o `past_due` que volta a `active`, a cobrança do período
   * que a isenção cancelou e volta à emissão. Chamado pelo agendador, por
   * provedor, antes da emissão (`schedulerService.runJobs`): assim a mesma
   * volta já emite a fatura que a isenção segurava.
   *
   * Sem ator: o extrato leva `source: 'scheduler'` e o motivo
   * `BILLING_EXEMPT_EXPIRED_REASON`; as duas trilhas (a da plataforma e a do
   * provedor, `actorKind: 'system'`) também. Idempotente e seguro com duas
   * voltas sobrepostas: a gravação é condicional à isenção ainda ligada e à
   * data ainda vencida (`Subscription.changeBillingExemptIf`), e só quem
   * desligou grava as trilhas.
   *
   * @returns {Promise<{ ended: boolean, reason?: string, until?: string|null,
   *   reopenedCharge?: boolean, renewsAt?: string|null }>}
   */
  static async endExpiredBillingExempt({ tenant = null, tenantId = null, now = new Date() } = {}) {
    const id = tenantId ?? tenant?.id ?? currentTenantId();
    if (!id) return { ended: false, reason: 'no_tenant' };
    const sub = await Subscription.forTenant(id);
    if (!sub?.billing_exempt_at) return { ended: false, reason: 'not_exempt' };
    const ate = asDate(sub.billing_exempt_until);
    if (!ate) return { ended: false, reason: 'no_end_date' };
    if (ate.getTime() > now.getTime()) return { ended: false, reason: 'not_yet', until: ate.toISOString() };

    const resultado = await this.setBillingExempt({
      tenantId: id,
      exempt: false,
      reason: BILLING_EXEMPT_EXPIRED_REASON,
      actorUserId: null,
      source: 'scheduler',
      expiredBy: now,
      now
    });
    // Outra volta (ou o console) desligou primeiro: ela gravou as trilhas.
    if (resultado.alreadyInState) return { ended: false, reason: 'already_ended' };

    const detail = {
      exempt: false,
      source: 'scheduler',
      reason: BILLING_EXEMPT_EXPIRED_REASON,
      exemptUntil: ate.toISOString(),
      statusBefore: resultado.statusBefore,
      statusAfter: resultado.statusAfter,
      canceledCharges: 0,
      ...(resultado.reopenedCharge ? { reopenedCharge: true } : {}),
      renewsAt: isoOf(resultado.subscription?.renews_at)
    };
    // A linha do provedor dá à trilha da plataforma o nome e o slug; o
    // agendador já a tem na mão (`forEachTenant`).
    const linha = tenant?.slug ? tenant : ((await getDb()('tenants').where({ id }).first()) ?? { id });
    await PlatformAudit.record({
      action: PlatformAudit.ACTIONS.SUBSCRIPTION_BILLING_EXEMPT_CHANGED,
      tenant: linha,
      detail
    });
    await runInTenant(id, () => AuditLog.record({
      action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
      actorKind: 'system',
      subjectType: 'subscription',
      subjectId: id,
      detail: { ...detail, platformAction: PlatformAudit.ACTIONS.SUBSCRIPTION_BILLING_EXEMPT_CHANGED }
    }));
    return {
      ended: true,
      until: ate.toISOString(),
      reopenedCharge: resultado.reopenedCharge,
      renewsAt: isoOf(resultado.subscription?.renews_at)
    };
  }

  /**
   * Um pagamento entrou. O período pago se estende a partir do fim do período
   * atual quando ele ainda não venceu (pagou adiantado), ou de hoje quando já
   * venceu (pagou atrasado) — e o status volta a `active`, que é o que o
   * dinheiro compra. Um provedor `suspended` ou `canceled` NÃO é reativado por
   * pagamento: essas duas são decisões de gente, e é gente que as desfaz.
   */
  /**
   * Um pagamento: registra o fato e, se a assinatura está viva, empurra o
   * período pago.
   *
   * @returns {Promise<{ subscription: object, duplicate: boolean }>} a
   *   assinatura depois do pagamento, e se esta chamada foi uma REENTREGA —
   *   uma referência já vista, que não creditou nada.
   *
   * ## A mesma referência credita uma vez só
   *
   * Todo gateway reentrega webhook, e reentrega é a regra: sem isto, cada
   * entrega repetida de `PIX-001` empurrava o período pago mais trinta dias.
   * Medido antes da correção: a segunda entrega era aceita sem erro, a data
   * saía de 10/10 para 09/11 e o extrato ganhava um segundo evento. O
   * extrato tinha a coluna `external_id` mas não o índice único que o seu
   * próprio comentário dizia existir, e ninguém lia a referência antes de
   * creditar.
   *
   * Duas defesas, para dois casos. A leitura da referência é para o caso
   * comum — a reentrega minutos depois — e responde a primeira gravação. O
   * índice único `(tenant_id, external_id)` é para a corrida — duas entregas
   * iguais ao mesmo tempo, que passam as duas pela leitura — e a segunda
   * perde na inserção. Nulos não colidem nos três bancos, então a marca
   * manual sem referência continua podendo repetir-se.
   *
   * ## O evento antes da data, numa transação
   *
   * A ordem antiga era assinatura primeiro, evento depois, sem transação. Com
   * o índice no lugar, isso ainda creditaria: a reentrega empurrava os trinta
   * dias e SÓ ENTÃO estourava na inserção — 500 para quem chamou, mês dado.
   * O evento é o que a unicidade recusa, então é ele que vai primeiro, e a
   * data só se move na mesma transação em que ele entrou.
   */
  static async recordPayment({
    amountCents, currency = 'BRL', provider = 'manual', externalId = null,
    actorUserId = null, periodDays = null, allowUnderpayment = false, paidOn = null, now = new Date(), chargeId = null
  }) {
    const tenantId = currentTenantId();
    const before = await Subscription.forTenant(tenantId);
    if (!before) throw new Error('Subscription not found');
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount < 0) throw new Error('Amount must be a non-negative integer of cents');

    if (externalId && await BillingEvent.findByExternalId(externalId)) {
      return { subscription: before, duplicate: true };
    }

    // O plano, lido agora e não do cache.
    //
    // `this.current()` traria o plano junto e de graça, e é exatamente o que
    // NÃO serve aqui: aquele cache tem quinze segundos de validade, e uma
    // leitura de quinze segundos atrás não pode decidir por quanto tempo um
    // pagamento vale. Uma consulta a mais por pagamento, e um pagamento é raro.
    //
    // `periodDays` explícito ainda vence o plano: é a saída para um ajuste
    // manual ou uma migração de contrato, e quem o passa está dizendo que sabe
    // mais que o catálogo naquele caso.
    const planoAtual = before.plan_id ? await Plan.findById(before.plan_id) : null;

    // O período que este pagamento compra começa em `base`: no fim do período
    // atual, quando ainda não venceu (pagou adiantado), ou agora (atrasado).
    const currentEnd = asDate(before.renews_at);
    const base = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;

    // A descida agendada (0074) e o período que ela alcança.
    //
    // Se o período comprado começa na data da descida ou depois dela, ele é do
    // plano NOVO: é o preço dele que a cobrança daquele prazo pediu (a emissão
    // já saiu com ele), e é o período dele que o pagamento estende. Conferir
    // contra o plano velho chamaria de "pago a menos" quem pagou exatamente a
    // fatura que recebeu.
    //
    // Aplicar a troca, porém, só quando a data já chegou (`now`): pago
    // adiantado, o provedor ainda está no período do plano caro, que já pagou,
    // e perder os tetos dele antes da hora seria cobrar um e entregar o outro.
    // Nesse caso quem troca é o agendador, quando a data chegar.
    const dataDaDescida = before.pending_plan_id ? asDate(before.pending_plan_at) : null;
    const planoAgendado = before.pending_plan_id && (!dataDaDescida || base.getTime() >= dataDaDescida.getTime())
      ? await Plan.findById(before.pending_plan_id)
      : null;
    // Com a mesma guarda da emissão: se o uso não cabe no plano agendado, a
    // descida não vai se aplicar e a cobrança do prazo saiu (ou foi
    // reprecificada) pelo preço do atual — é contra ele que se confere, QUANDO
    // não há cobrança (a cobrança, havendo, é quem responde: `valorPedido`).
    // As ONTs ficam de fora pela razão de sempre aqui: quem chama é o webhook,
    // sem ACS em mãos — e não precisam entrar, porque o destino da descida
    // abaixo não depende do uso, e sim do preço que foi pago. Contado FORA da
    // transação — no SQLite a transação segura a única conexão, e uma
    // contagem por fora dela esperaria para sempre. A travada não conta nada:
    // já foi paga pelo preço dela.
    const descidaBloqueada = planoAgendado ? await this.scheduledOverLimit(before, planoAgendado) : null;
    const plano = planoAgendado && !descidaBloqueada ? planoAgendado : planoAtual;
    // A assinatura no ciclo do período que este pagamento compra (0104): o
    // agendado, quando o período já é da troca agendada — a fatura anual da
    // renovação estende 365 dias, e a mensal depois do anual, um mês.
    const doPeriodo = plano === planoAgendado ? this.scheduledView(before) : before;

    // O cupom (0093): o preço que a fatura deste período pediu já tem o
    // desconto, e é contra ele que se confere quando não há cobrança.
    const cupom = before.coupon_id ? await Coupon.findById(before.coupon_id) : null;

    // A conferência do valor, que é o que separa "recebi dinheiro" de "esta
    // conta está paga".
    //
    // Sem ela, um centavo comprava o mesmo período que a fatura inteira: o
    // pagamento virava um interruptor, e o número que ele carrega era enfeite
    // de extrato. Não é um caso de laboratório — a cobrança dos primeiros
    // contratos é criada à mão no painel do gateway, e um valor digitado com um
    // zero a menos passaria como mês pago para sempre, sem uma linha de log.
    //
    // Pagar A MAIS credita: um boleto quitado depois do vencimento chega com
    // juros, e recusar o período de quem pagou mais do que devia seria o
    // absurdo simétrico.
    //
    // Pagar A MENOS não credita, e o dinheiro **não some**: o evento é gravado
    // com a diferença dentro, porque ele de fato aconteceu e o extrato é o que
    // responde "quanto este provedor já nos mandou". O que não anda é
    // `renews_at` — e `past_due` deixa ler e para de deixar escrever, que é
    // onde alguém que pagou a menos deve ficar: visível, avisado e recuperável,
    // não trancado do lado de fora.
    const pedido = await valorPedido({
      externalId, plano, currency, precoDoPlano: this.priceFor(doPeriodo, plano, cupom), chargeId
    });
    // A fatura de pró-rata da subida (0101): o dinheiro entra no extrato como
    // qualquer pagamento (e na receita e na NFS-e), conferido contra o valor
    // DELA — mas não compra período: não estende `renews_at`, não reativa,
    // não mexe na descida agendada nem gasta ciclo de cupom. O período que
    // ela completa já está pago; o que ela paga é a diferença de preço dele.
    // (A reativação de quem foi suspenso por inadimplência, quando paga a
    // pró-rata, volta a `active` SEM estender o prazo — é por esta marca.)
    // A de só excedente (0105) é avulsa do mesmo jeito: paga o consumo, não
    // compra período.
    const isProration = pedido.kind === 'proration' || pedido.kind === 'overage';
    // Pagar a menos POR CAUSA do desconto por antecipação é pagar o inteiro:
    // ver `descontoAntecipado`. A multa e os juros, do outro lado, chegam como
    // pagamento a mais — e a mais já credita, logo acima.
    const antecipado = pedido.cents !== null && amount < pedido.cents
      ? await descontoAntecipado({ pedido, amount, paidOn, now })
      : null;
    const faltou = pedido.cents !== null && amount < pedido.cents && !antecipado;
    const underpaid = faltou && !allowUnderpayment;
    if (pedido.motivo === 'currency_mismatch') {
      // Nem credita errado nem bloqueia por uma condição que quem recebeu o
      // pagamento não tem como consertar: diz em voz alta e segue.
      console.warn(
        `Payment ${externalId ?? '(no reference)'} arrived in ${String(currency).toUpperCase()} `
        + `and the ${pedido.fonte} is priced in another currency: the amount was not checked`
      );
    }

    const patch = {};
    // A suspensão AUTOMÁTICA por inadimplência (0102) também: foi o atraso
    // que a pôs, e é o pagamento que a tira — o período conta a partir do
    // pagamento (`base`, que é agora, já que o prazo venceu há dias). A
    // suspensão à mão continua parada: quem a pôs tem razão própria.
    const autoSuspensa = isAutoSuspended(before);
    const reactivates = !underpaid && !isProration
      && (before.status === 'trial' || before.status === 'active' || before.status === 'past_due' || autoSuspensa);

    // O destino da descida agendada, decidido pelo PREÇO que este pagamento
    // pagou pelo período que começa nela — e não pelo uso, que é o que um
    // provedor mexe à vontade depois de pagar:
    //
    //   - pagou o preço de baixo (o que se pediu é menor que o preço do plano
    //     atual): a descida fica TRAVADA (0075). Não se cancela nem se troca
    //     mais, e se aplica na data com o uso que houver — sem isto, pagar o
    //     barato adiantado e desistir da descida depois (ou crescer o uso para
    //     ela não se aplicar) era um mês de plano caro pelo preço do barato.
    //     Se a data já chegou (pagamento atrasado), aplica-se aqui mesmo, na
    //     transação do pagamento, para o período novo nascer no plano novo.
    //   - pagou o preço de cima (a descida estava bloqueada pelo uso e a
    //     cobrança saiu pelo atual): o período é do plano atual, e a descida
    //     vai para a renovação SEGUINTE — tenta de novo lá, pela mesma regra.
    let destinoDaDescida = null;
    if (reactivates && planoAgendado) {
      // Qual plano a cobrança paga cobrou: o gravado nela (0093), ou, sem
      // ele, pelo valor (`paidScheduledPlan`) — com o cupom, que pode ter
      // levado os dois planos ao mesmo preço, a comparação de valores sozinha
      // adiaria a descida para sempre.
      //
      // A cobrança com valor mudado à mão pelo console (o desconto) não diz
      // nada sobre QUAL plano foi pago pelo VALOR: menos que o preço do atual
      // ali é abatimento, não o preço do barato. Aí vale o plano gravado nela,
      // ou o que a cobrança teria pedido sem o desconto — o agendado, se a
      // descida cabe no uso; o atual, se não cabe —, que é a mesma resposta de
      // quando não há cobrança nenhuma (o valor esperado ali É o do `plano`).
      const pelaCobranca = pedido.fonte === 'charge' || pedido.fonte === 'superseded_charge';
      const veredito = pelaCobranca
        ? this.paidScheduledPlan({
          planId: pedido.planId ?? null,
          billingCycle: pedido.billingCycle,
          cents: pedido.overridden ? null : (pedido.baseCents ?? pedido.cents),
          subscription: before,
          current: planoAtual,
          scheduled: planoAgendado,
          coupon: cupom
        })
        : null;
      const pagoBarato = veredito ?? (plano === planoAgendado);
      destinoDaDescida = pagoBarato ? 'lock' : 'postpone';
    }
    // O plano e o ciclo do período que ESTE pagamento compra — e os dias.
    //
    // Decididos DEPOIS do destino da descida, e pela cobrança paga quando ela
    // os diz: o palpite de cima (`plano`/`doPeriodo`) é o que a emissão teria
    // pedido hoje, e não o que a fatura paga pediu. Sem isto, a renovação
    // MENSAL do plano atual (a descida + anual estava bloqueada pelo uso
    // quando ela saiu) paga com a descida agendada já cabendo no uso comprava
    // 365 dias pelo preço de um mês.
    //
    //   - a descida adiada (`postpone`): o plano atual, no ciclo de agora;
    //   - a cobrança com plano gravado (0093) responde: o plano dela no ciclo
    //     dela (nulo é linha de antes do 0104, mensal);
    //   - a descida travada (`lock`): o agendado, no ciclo agendado.
    let planoDoPeriodo = plano;
    let vistaDoPeriodo = doPeriodo;
    const pelaCobrancaComPlano = (pedido.fonte === 'charge' || pedido.fonte === 'superseded_charge')
      && pedido.planId !== null && pedido.planId !== undefined;
    if (destinoDaDescida === 'postpone') {
      planoDoPeriodo = planoAtual;
      vistaDoPeriodo = before;
    } else if (pelaCobrancaComPlano) {
      const idCobrado = Number(pedido.planId);
      planoDoPeriodo = planoAtual && Number(planoAtual.id) === idCobrado ? planoAtual
        : planoAgendado && Number(planoAgendado.id) === idCobrado ? planoAgendado
          : ((await Plan.findById(idCobrado)) ?? plano);
      vistaDoPeriodo = this.inCycle(before, parseBillingCycle(pedido.billingCycle) ?? 'monthly');
    } else if (destinoDaDescida === 'lock') {
      planoDoPeriodo = planoAgendado;
      vistaDoPeriodo = this.scheduledView(before);
    }
    const dias = periodDays ?? this.cyclePeriodDays(vistaDoPeriodo, planoDoPeriodo);
    const descidaVenceu = !dataDaDescida || dataDaDescida.getTime() <= now.getTime();
    const descida = destinoDaDescida === 'lock' && descidaVenceu ? planoAgendado : null;

    // As OUTRAS faturas de pró-rata em aberto, sem a que este pagamento paga
    // (0101): é por elas que se sabe se o provedor continua devendo depois
    // deste pagamento — a reativação segue o pagamento do que suspendeu.
    const outrasProrratas = (await BillingCharge.openProrations())
      .filter((linha) => !(isProration && Number(linha.id) === Number(pedido.chargeId)));
    let proximaProrata = null;
    for (const linha of outrasProrratas) {
      if (!linha.gateway_charge_id) continue;
      const quando = prorationOverdueAt(linha.due_date);
      if (quando && (!proximaProrata || quando.getTime() < proximaProrata.getTime())) proximaProrata = quando;
    }
    // Ainda devendo DEPOIS deste pagamento? O estado de depois, com a
    // suspensão automática tirada, lido por `overdueSince`.
    const aindaDevendo = (depois) => Boolean(overdueSince({
      ...before,
      ...depois,
      status: before.status === 'suspended' ? 'active' : (depois.status ?? before.status),
      suspended_reason: null
    }, now, { prorationDueAt: proximaProrata }));

    // A renovação paga por quem a suspensão automática parou enquanto uma
    // pró-rata vencida continua em aberto: o período anda (o pagamento é da
    // renovação), mas a suspensão fica — a dívida que suspendeu não foi paga.
    const continuaSuspensa = reactivates && autoSuspensa
      && aindaDevendo({ renews_at: new Date(base.getTime() + dias * DAY_MS), trial_ends_at: null });

    if (reactivates) {
      patch.renews_at = new Date(base.getTime() + dias * DAY_MS);
      patch.status = continuaSuspensa ? before.status : 'active';
      // Sempre, e não só quando estava suspensa: a suspensão automática que
      // entrou entre a leitura e esta gravação também sai.
      patch.suspended_reason = continuaSuspensa ? before.suspended_reason : null;
      patch.trial_ends_at = null;
      // A subida no meio do período (0075) foi paga: o período que este
      // pagamento compra é cobrado pelo plano de agora.
      patch.upgraded_at = null;
      if (destinoDaDescida === 'lock' && !descida) patch.pending_plan_locked_at = now;
      // A pausa de retenção (0107) acaba quando o provedor paga a renovação:
      // é o "retomar antes" — o período conta a partir do pagamento (`base`
      // é agora, já que a pausa só corre depois do fim do período pago) ou,
      // pago antes de a pausa começar, a partir do fim do período, como se
      // ela nunca tivesse existido.
      if (before.paused_until) {
        patch.paused_until = null;
        patch.pause_started_at = null;
      }
      // E o cancelamento agendado não engole um período que foi pago (a
      // fatura que já estava na mão dele, paga no meio do agendamento): a
      // data anda junto com a renovação, e ele cancela no fim do que pagou.
      if (before.cancel_at && before.status !== 'canceled') patch.cancel_at = patch.renews_at;
      if (destinoDaDescida === 'postpone') {
        console.warn(
          `Payment for provider ${tenantId} paid the renewal at the current plan's price because the `
          + `scheduled change to plan ${planoAgendado.id} is blocked by usage; it moves to the next renewal`
        );
        patch.pending_plan_at = patch.renews_at;
        patch.pending_plan_locked_at = null;
      }
    }
    // A pró-rata paga por quem a suspensão automática parou (0101 + 0102):
    // a dívida que suspendeu era ela, então o provedor volta a `active` — mas
    // SEM estender o prazo, que ela não compra. Estender aqui seria dar de
    // graça um período que ninguém pagou.
    //
    // Só quando ela era a ÚLTIMA dívida (`aindaDevendo`): com a renovação
    // vencida, ou outra pró-rata vencida, a suspensão continua. E a decisão
    // vale sobre a linha GRAVADA, e não só sobre `before`: a suspensão que o
    // agendador gravou entre a leitura e o pagamento também sai (a gravação
    // condicional na transação, abaixo).
    const podeReativarPelaProrata = isProration && !underpaid && !aindaDevendo({});
    // A subida paga por inteiro (0101): a diferença do resto do período
    // entrou, e a marca da subida (`upgraded_at`, que adia a descida para a
    // renovação seguinte) não tem mais o que proteger — se não sobrou outra
    // pró-rata em aberto.
    if (pedido.kind === 'proration' && !underpaid && before.upgraded_at
      && !outrasProrratas.some((linha) => linha.kind === 'proration')) {
      patch.upgraded_at = null;
    }
    const statusAfter = patch.status ?? before.status;
    const renewsAt = patch.renews_at ?? before.renews_at ?? null;

    // O ciclo do cupom que ESTE pagamento gasta: só quando ele estende o
    // período (é a fatura com desconto sendo paga), só nos cupons que contam
    // ciclo, e só se o cupom vale no plano do período pago — a fatura de um
    // plano fora da lista saiu sem desconto, e não gastou nada.
    //
    // E só se a fatura paga CARREGAVA o desconto: a cobrança com valor mudado
    // à mão pelo console não é a do cupom; a emitida com o cupom gravado nela
    // (0093) diz por si; sem essa marca, o valor pedido tem de ser o preço
    // com o cupom — a fatura velha de preço cheio, paga depois de o console
    // aplicar o cupom a um suspenso, não gasta o ciclo que não descontou.
    let faturaComCupom = false;
    if (cupom && !pedido.overridden) {
      if (pelaCobrancaComPlano) {
        faturaComCupom = Number(pedido.couponId) === Number(cupom.id);
      } else {
        faturaComCupom = this.couponApplies(before, plano, cupom)
          && (pedido.cents === null || (pedido.baseCents ?? pedido.cents) === this.priceFor(doPeriodo, plano, cupom));
      }
    }
    const gastaCupom = reactivates && cupom && cupom.duration !== 'forever' && faturaComCupom;

    // A indicação (0106): o pagamento que ESTENDE o período do indicado — não
    // a pró-rata, não o pago a menos (nem o aceito a menos), não o de valor
    // zero — dá a quem o indicou o crédito configurado. Lido aqui, fora da
    // transação (ver `ReferralService.prepareReward`); gravado lá dentro.
    const indicacao = reactivates && !faltou && amount > 0
      ? await ReferralService.prepareReward(tenantId)
      : null;
    // O crédito reservado na cobrança que este pagamento quita passa a gasto,
    // na mesma transação do evento (0106). O pago a menos deixa a cobrança em
    // aberto, e a reserva com ela.
    const cobrancaComCredito = !underpaid && pedido.chargeId
      && (pedido.fonte === 'charge' || pedido.fonte === 'superseded_charge')
      ? Number(pedido.chargeId) : null;

    try {
      const subscription = await getDb().transaction(async (trx) => {
        const recompensa = indicacao
          ? await ReferralService.rewardOnPayment({ trx, tenantId, prepared: indicacao, externalId, now })
          : null;
        const creditoGasto = cobrancaComCredito ? await TenantCredit.consumeForCharge(cobrancaComCredito, trx) : 0;
        // Dentro da transação do evento: a reentrega do mesmo pagamento morre
        // no índice único do evento logo abaixo, e o ciclo gasto aqui volta
        // junto no rollback — o cupom é consumido uma vez por pagamento.
        const consumo = gastaCupom ? await Subscription.consumeCouponCycle(tenantId, cupom.id, trx) : null;
        // A pró-rata que era a última dívida tira a suspensão automática da
        // linha como ela está AGORA (condicional), e não como se leu.
        const reativouPelaProrata = podeReativarPelaProrata
          ? await Subscription.liftAutoSuspension(tenantId, trx)
          : false;
        await BillingEvent.record({
          subscriptionId: before.id,
          type: BILLING_EVENT_TYPES.PAYMENT_RECORDED,
          amountCents: amount,
          currency,
          provider,
          externalId,
          createdBy: actorUserId,
          detail: {
            statusBefore: before.status,
            statusAfter: reativouPelaProrata ? 'active' : statusAfter,
            ...(autoSuspensa ? { suspendedReason: SUSPENDED_REASONS.AUTO_NONPAYMENT } : {}),
            ...((autoSuspensa && reactivates && !continuaSuspensa) || reativouPelaProrata ? { reactivated: true } : {}),
            ...(continuaSuspensa ? { stillSuspended: 'proration_overdue' } : {}),
            // A retenção (0107): o pagamento que acabou a pausa, e o que
            // empurrou o cancelamento agendado para o fim do período pago.
            ...(patch.paused_until === null && before.paused_until
              ? { pauseEnded: true, pausedUntil: isoOf(before.paused_until) } : {}),
            ...(patch.cancel_at && before.cancel_at
              ? { cancelAtMoved: isoOf(patch.cancel_at), cancelAtBefore: isoOf(before.cancel_at) } : {}),
            renewsAt,
            // O prazo de ANTES, e quantos dias o plano deu, viajam junto para
            // o estorno (`reversePayment`): desfazer um pagamento é devolver o
            // prazo exatamente o quanto ESTE pagamento o empurrou — e sem o
            // ponto de partida gravado aqui, a única resposta seria o período
            // do plano de hoje, que pode não ser o de quando se pagou.
            renewsBefore: isoOf(before.renews_at),
            ...(reactivates ? {
              periodDays: dias,
              planId: planoDoPeriodo?.id ?? null,
              billingCycle: planoDoPeriodo ? this.cycleOf(vistaDoPeriodo, planoDoPeriodo) : null
            } : {}),
            // A trava da descida agendada foi posta POR este pagamento, e
            // QUANDO: o estorno dele a tira, porque o que a pagou voltou — mas
            // só se ela ainda tem este instante (ver `reversePayment`).
            ...(patch.pending_plan_locked_at
              ? { pendingLocked: true, pendingLockedAt: patch.pending_plan_locked_at.toISOString() }
              : {}),
            // O que foi pedido viaja com o evento porque o extrato é o único
            // lugar onde alguém reconstrói, meses depois, por que aquele
            // pagamento não esticou o período.
            expectedCents: pedido.cents,
            // O preço do plano com o cupom que esta fatura pediu, sem o
            // excedente nem o crédito — o que a receita compara com o preço
            // cheio para estimar o desconto (`revenueReportService`).
            ...(pedido.planBaseCents !== null && pedido.planBaseCents !== undefined && !isProration
              ? { baseCents: pedido.planBaseCents } : {}),
            ...(pedido.motivo ? { amountCheck: pedido.motivo } : {}),
            ...(underpaid ? { underpaid: true, shortfallCents: pedido.cents - amount } : {}),
            ...(faltou && allowUnderpayment ? { underpaymentAccepted: true } : {}),
            // O desconto por antecipação que fez o valor menor valer como
            // inteiro — quanto, até quando, e em que dia se pagou.
            ...(antecipado ? { earlyPaymentDiscount: antecipado } : {}),
            // O ciclo do cupom que este pagamento gastou, para o estorno o
            // devolver (`reversePayment`) — e, se o zerou, o cupom inteiro.
            ...(consumo ? { coupon: { id: Number(cupom.id), code: cupom.code, ...consumo } } : {}),
            // A pró-rata (0101): o estorno lê isto e não desfaz prazo nenhum.
            ...(isProration ? { proration: true, chargeId: pedido.chargeId } : {}),
            // A indicação recompensada por este pagamento, e o crédito que a
            // cobrança paga gastou (0106) — o estorno lê os dois.
            ...(recompensa ?? {}),
            ...(creditoGasto ? { creditConsumed: { chargeId: cobrancaComCredito, cents: creditoGasto } } : {})
          }
        }, trx);
        // Na mesma transação do pagamento: um período novo que começasse no
        // plano velho porque a troca falhou depois do commit seria exatamente
        // a mistura que a descida agendada existe para não fazer. Condicional
        // (ver `Subscription.applyPendingPlan`): se o agendador aplicou no
        // mesmo minuto, o extrato ganha uma linha de troca, e não duas.
        if (descida && await Subscription.applyPendingPlan(tenantId, descida.id, trx)) {
          await BillingEvent.record({
            subscriptionId: before.id,
            type: BILLING_EVENT_TYPES.PLAN_CHANGED,
            createdBy: actorUserId,
            detail: {
              from: before.plan_id ?? null,
              to: descida.id,
              toCode: descida.code,
              scheduled: true,
              ...cycleChangeDetail(before),
              byPayment: true,
              locked: true
            }
          }, trx);
          if (cycleChangeDetail(before).cycleTo === 'annual') {
            await this.dropCouponForAnnual(before, { trx, actorUserId });
          }
        }
        return Object.keys(patch).length
          ? Subscription.upsertForTenant(tenantId, patch, trx)
          : Subscription.forTenant(tenantId, trx);
      });
      // O alerta para quem opera a plataforma (0112): DEPOIS da transação, e
      // sem poder derrubar nada — o dinheiro já está creditado. A referência
      // do gateway é a idempotência; o aceite da diferença (valor zero) não é
      // dinheiro novo e não avisa.
      if (amount > 0) {
        await PlatformAlertService.enqueue('payment_received', {
          tenantId,
          dedupeKey: externalId ? `${tenantId}:${externalId}` : `${tenantId}:manual:${now.getTime()}:${before.id}`,
          payload: { amountCents: amount, underpaid: Boolean(underpaid), proration: isProration },
          now
        });
      }
      return {
        subscription,
        duplicate: false,
        underpaid,
        expectedCents: pedido.cents,
        paidCents: amount,
        ...(isProration ? { proration: true } : {})
      };
    } catch (error) {
      // A corrida: a outra entrega igual chegou primeiro e já está gravada. A
      // resposta certa é a mesma da leitura lá em cima — o que já existe.
      if (externalId && isUniqueViolation(error)) {
        return { subscription: await Subscription.forTenant(tenantId), duplicate: true };
      }
      throw error;
    } finally {
      cache.invalidate();
    }
  }

  /**
   * O dinheiro de um pagamento VOLTOU: desfaz o período que ele comprou.
   *
   * Decisão de quem opera o SaaS: o estorno é só o inteiro, e desfaz o período
   * pago. Quando nada mexeu no prazo depois do pagamento, `renews_at` volta
   * EXATAMENTE ao prazo de antes dele; quando algo mexeu (outro pagamento,
   * uma cortesia), volta só o período que ele COMPROU (ver
   * `duracaoCreditada`), e o que os outros deram fica. Se a data que sobra já passou, o provedor é
   * `past_due` pela regra de sempre (`effectiveStatus`), e nenhum `past_due` é
   * gravado aqui: o status da coluna não muda, do mesmo jeito que o prazo que
   * vence sozinho não o muda. Um `trial` que pagou e virou `active` não volta a
   * `trial` — o teste acabou quando ele pagou, e devolver o dinheiro não
   * devolve o teste.
   *
   * Quem chama: o console (o botão de estorno, depois de falar com o gateway) e
   * o webhook (`PAYMENT_REFUNDED`, o estorno feito no painel da Asaas). Os dois
   * no escopo do provedor, e os dois pela referência do PAGAMENTO — a mesma com
   * que ele foi registrado.
   *
   * ## Uma vez só, pela mesma trava do pagamento
   *
   * O estorno do console faz a Asaas mandar `PAYMENT_REFUNDED` do mesmo
   * pagamento, minutos depois, e ele não pode devolver outro período. O evento
   * do estorno é gravado com a referência `<pagamento>:refund`, e é o índice
   * único `(tenant_id, external_id)` que decide — a leitura antes, para a
   * reentrega comum, e a inserção na mesma transação da data, para a corrida.
   * Quem chega depois recebe `duplicate: true` e nada muda.
   *
   * ## O aceite da diferença
   *
   * O pagamento a menos não empurra nada; quem empurra é o aceite
   * (`<referência>:accepted`, ver `PlatformSubscriptionsController`). Então é
   * a conta DELE que se desfaz — e o estorno do pagamento curto sem aceite não
   * devolve dia nenhum, só registra que o dinheiro voltou.
   *
   * ## O que NÃO se desfaz
   *
   * A descida agendada que o pagamento APLICOU (pagou atrasado e o período
   * novo nasceu no plano novo) continua aplicada, e a marca de subida no meio
   * do período que ele apagou continua apagada: trocar o plano de novo é
   * decisão de gente, com o console. A trava da descida que ele PÔS sai — o
   * que a pagou voltou —, mas só se ainda é a MESMA trava: o evento grava o
   * instante em que travou (`pendingLockedAt`), e uma trava posta depois, por
   * outro pagamento, tem outro instante e fica. A descida marcada para a
   * renovação anda junto com ela, como na cortesia (`setDeadlines`).
   *
   * @returns {Promise<{ subscription: object, duplicate: boolean, found: boolean,
   *   renewsAtBefore: string|null, renewsAtAfter: string|null, basis: string|null }>}
   */
  static async reversePayment({
    externalId, reason = null, actorUserId = null, source = 'console'
  }) {
    const tenantId = currentTenantId();
    const referencia = String(externalId ?? '').trim();
    if (!referencia) throw new Error('A refund needs the payment reference');
    const before = await Subscription.forTenant(tenantId);
    if (!before) throw new Error('Subscription not found');
    const referenciaDoEstorno = `${referencia}:refund`;
    const intacta = (extra) => ({
      subscription: before,
      renewsAtBefore: isoOf(before.renews_at),
      renewsAtAfter: isoOf(before.renews_at),
      basis: null,
      ...extra
    });
    // O estorno que já aconteceu responde com as datas DELE — as que o
    // primeiro a gravar moveu —, e não com o prazo de agora repetido nos dois
    // campos: quem chega depois (o botão do console que perdeu a corrida para
    // o próprio webhook) precisa dizer na tela e na trilha o que de fato
    // mudou.
    const jaFeito = async (marca) => {
      const agora = await Subscription.forTenant(tenantId);
      const lido = detalheDe(marca);
      return {
        subscription: agora,
        duplicate: true,
        found: true,
        renewsAtBefore: lido && 'renewsBefore' in lido ? lido.renewsBefore : isoOf(agora?.renews_at),
        renewsAtAfter: lido && 'renewsAt' in lido ? lido.renewsAt : isoOf(agora?.renews_at),
        basis: lido?.basis ?? null
      };
    };

    const marcaAnterior = await BillingEvent.findByExternalId(referenciaDoEstorno);
    if (marcaAnterior) return jaFeito(marcaAnterior);

    // O pagamento que se estorna. Sem ele não há período a desfazer — e nem
    // marca a gravar: um estorno de algo que o extrato não conhece (a
    // cobrança criada à mão no gateway e nunca creditada aqui) não tem o que
    // travar contra a segunda vez.
    const pagamento = await BillingEvent.findByExternalId(referencia);
    if (!pagamento || pagamento.type !== BILLING_EVENT_TYPES.PAYMENT_RECORDED) {
      return intacta({ duplicate: false, found: false });
    }
    const detalhe = detalheDe(pagamento);
    let quemEstendeu = detalhe;
    if (detalhe?.underpaid) {
      const aceite = await BillingEvent.findByExternalId(`${referencia}:accepted`);
      quemEstendeu = aceite?.type === BILLING_EVENT_TYPES.PAYMENT_RECORDED ? detalheDe(aceite) : null;
    }
    const planoAtual = before.plan_id ? await Plan.findById(before.plan_id) : null;
    const credito = await duracaoCreditada(quemEstendeu, planoAtual);
    const { ms, from, to } = credito;
    let { basis } = credito;

    const patch = {};
    const prazo = asDate(before.renews_at);
    if (ms > 0 && prazo) {
      // O caso comum — nada mexeu no prazo depois deste pagamento — volta
      // EXATAMENTE ao prazo de antes, sem conta: a subtração carregaria o
      // arredondamento do MySQL (que guarda ao segundo) para a data. Com
      // outra coisa no meio (outro pagamento, uma cortesia), subtrai-se o que
      // este deu, e o resto fica.
      const intocado = from && to && Math.abs(prazo.getTime() - to.getTime()) < 1000;
      patch.renews_at = intocado ? new Date(from.getTime()) : new Date(prazo.getTime() - ms);
      if (intocado) basis = 'restored';
      const agendada = asDate(before.pending_plan_at);
      if (before.pending_plan_id && agendada && agendada.getTime() === prazo.getTime()) {
        patch.pending_plan_at = patch.renews_at;
      }
    } else if (ms > 0) {
      // Sem prazo para voltar: alguém tirou a assinatura do ciclo depois do
      // pagamento. Não há de onde subtrair — dito em voz alta, e o estorno
      // segue registrado.
      console.warn(`Refund of payment ${referencia} for provider ${tenantId}: the subscription has no renewal date to roll back`);
    }
    // O cancelamento agendado que ESTE pagamento empurrou (0107) volta à data
    // de antes — o período que o empurrou foi devolvido. Só se a data ainda é
    // a que ele gravou (com a folga do segundo do MySQL): outra mudança
    // depois (desfeito, reagendado) fica.
    const cancelaAntes = asDate(quemEstendeu?.cancelAtBefore);
    const cancelaMovido = asDate(quemEstendeu?.cancelAtMoved);
    const cancelaAgora = asDate(before.cancel_at);
    if (cancelaAntes && cancelaMovido && cancelaAgora && before.status !== 'canceled'
      && Math.abs(cancelaAgora.getTime() - cancelaMovido.getTime()) < 1000) {
      patch.cancel_at = cancelaAntes;
    }
    // A trava só sai se é a que ESTE pagamento pôs — o mesmo instante, com a
    // folga do segundo que o MySQL arredonda. Evento antigo, sem o instante
    // gravado, não destrava nada: sem como provar de quem é a trava, ela fica.
    const travouEm = asDate(quemEstendeu?.pendingLockedAt);
    const travaAtual = asDate(before.pending_plan_locked_at);
    if (travouEm && travaAtual && Math.abs(travouEm.getTime() - travaAtual.getTime()) < 1000) {
      patch.pending_plan_locked_at = null;
    }

    // A cobrança que este pagamento quitou, para o crédito que ela gastou
    // voltar ao saldo (0106). Lida antes da transação, pelas mesmas portas da
    // conferência do pagamento (`valorPedido`).
    const daLinha = /^charge:(\d+)$/.exec(referencia);
    const cobrancaPaga = daLinha
      ? await BillingCharge.findById(Number(daLinha[1]))
      : (await BillingCharge.byGatewayId(referencia)) ?? (await BillingCharge.bySupersededGatewayId(referencia))?.row ?? null;

    try {
      const subscription = await getDb().transaction(async (trx) => {
        // A recompensa de indicação que este pagamento gerou é cancelada, e o
        // crédito que a cobrança dele gastou volta (0106) — na transação da
        // marca do estorno, uma vez só.
        const indicacaoDesfeita = await ReferralService.cancelOnRefund({ trx, tenantId, reference: referencia });
        const creditoDevolvido = cobrancaPaga ? await TenantCredit.restoreForCharge(cobrancaPaga.id, trx) : 0;
        // O ciclo do cupom que o pagamento gastou volta com o dinheiro — na
        // mesma transação da marca do estorno, então o segundo estorno do
        // mesmo pagamento (o webhook depois do console) não devolve outro.
        const gastou = quemEstendeu?.coupon?.id ? quemEstendeu.coupon : null;
        const devolucao = gastou ? await Subscription.restoreCouponCycle(tenantId, gastou, trx) : null;
        await BillingEvent.record({
          subscriptionId: before.id,
          type: BILLING_EVENT_TYPES.PAYMENT_REFUNDED,
          amountCents: pagamento.amount_cents === null || pagamento.amount_cents === undefined
            ? null : Number(pagamento.amount_cents),
          currency: pagamento.currency,
          provider: pagamento.provider || 'manual',
          externalId: referenciaDoEstorno,
          createdBy: actorUserId,
          detail: {
            reference: referencia,
            source: source === 'webhook' ? 'webhook' : 'console',
            reason: reason ? String(reason).slice(0, 255) : null,
            status: before.status,
            renewsBefore: isoOf(before.renews_at),
            renewsAt: patch.renews_at ? patch.renews_at.toISOString() : isoOf(before.renews_at),
            reversedDays: patch.renews_at && prazo
              ? Math.round(((prazo.getTime() - patch.renews_at.getTime()) / DAY_MS) * 1000) / 1000
              : 0,
            basis,
            ...(patch.pending_plan_locked_at === null ? { pendingUnlocked: true } : {}),
            ...(patch.cancel_at ? { cancelAtRestored: patch.cancel_at.toISOString() } : {}),
            ...(devolucao ? { couponRestored: { id: Number(gastou.id), code: gastou.code ?? null, ...devolucao } } : {}),
            ...(indicacaoDesfeita ?? {}),
            ...(creditoDevolvido ? { creditRestored: { chargeId: Number(cobrancaPaga.id), cents: creditoDevolvido } } : {})
          }
        }, trx);
        return {
          linha: Object.keys(patch).length
            ? await Subscription.upsertForTenant(tenantId, patch, trx)
            : await Subscription.forTenant(tenantId, trx),
          indicacaoDesfeita
        };
      }).then(async ({ linha, indicacaoDesfeita }) => {
        // O crédito de indicação cancelado ainda reservado em faturas abertas
        // de quem indicou: elas voltam ao preço sem ele (0106).
        const desfeita = indicacaoDesfeita?.referralRewardCanceled;
        if (desfeita?.creditId) {
          await ReferralService.releaseCanceledCreditReservations({
            referrerTenantId: desfeita.referrerTenantId, creditId: desfeita.creditId
          }).catch((error) => {
            console.error(`Could not release the reservations of canceled referral credit ${desfeita.creditId}: ${error.message}`);
          });
        }
        return linha;
      });
      return {
        subscription,
        duplicate: false,
        found: true,
        renewsAtBefore: isoOf(before.renews_at),
        renewsAtAfter: isoOf(subscription?.renews_at),
        basis
      };
    } catch (error) {
      // A corrida: o console e o webhook estornando o mesmo pagamento ao mesmo
      // tempo. Quem gravou primeiro desfez o período; este não desfaz outro.
      if (isUniqueViolation(error)) {
        return jaFeito(await BillingEvent.findByExternalId(referenciaDoEstorno));
      }
      throw error;
    } finally {
      cache.invalidate();
    }
  }
}

export default SubscriptionService;
