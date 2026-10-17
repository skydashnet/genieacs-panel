import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import Coupon from '../models/Coupon.js';
import Tenant from '../models/Tenant.js';
import BillingEvent, { BILLING_EVENT_TYPES } from '../models/BillingEvent.js';
import BillingCharge from '../models/BillingCharge.js';
import UsagePeak from '../models/UsagePeak.js';
import PlatformAudit from '../models/PlatformAudit.js';
import AuditLog from '../models/AuditLog.js';
import CancellationRequest, { CANCELLATION_OUTCOMES } from '../models/CancellationRequest.js';
import SubscriptionService, {
  ANNUAL_RETENTION_KIND, isCancelScheduled, isPauseScheduled, parseBillingCycle
} from './subscriptionService.js';
import ChargeIssuingService, { ChargeFollowError } from './chargeIssuingService.js';
import CouponService from './couponService.js';
import { SelfBillingError } from './selfBillingService.js';
import { retentionConfig } from './platformProfileService.js';
import PlatformAlertService from './platformAlertService.js';
import { getDb, isUniqueViolation } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';

/**
 * A retenção no cancelamento (0107): o dono de um provedor pede para cancelar,
 * diz o motivo, e o painel oferece — antes de cancelar — um desconto ou uma
 * pausa.
 *
 * ## O caminho
 *
 *   1. `request` grava o motivo (da lista `CANCELLATION_REASONS`) e o
 *      comentário, e devolve as ofertas que valem para ele agora.
 *   2. `accept` aceita uma delas:
 *        - **desconto**: o cupom de retenção do sistema (`system_kind =
 *          'retention'`, `retentionDiscountPercent` % por
 *          `retentionDiscountMonths` faturas), aplicado pela porta de sempre
 *          (`CouponService.apply`, `source: 'retention'`) — a fatura em
 *          aberto é reprecificada como na aplicação de qualquer cupom. Uma vez
 *          a cada doze meses, contados pela decisão do pedido.
 *        - **pausa**: `paused_until = renews_at + N meses` (N até
 *          `retentionPauseMaxMonths`). O período pago continua até
 *          `renews_at`; dali até `paused_until` o painel só lê, e nada se
 *          cobra — sem fatura, sem lembrete, sem suspensão automática. A
 *          fatura da renovação que já tinha saído é cancelada no gateway
 *          ANTES de a pausa ser gravada. Na data o agendador devolve a
 *          cobrança (`renews_at = paused_until`, e a emissão sai na mesma
 *          volta). Pagar antes (o "pagar agora", que reabre a fatura que a
 *          pausa cancelou) acaba a pausa e conta o período a partir do
 *          pagamento (`SubscriptionService.recordPayment`).
 *   3. ou `confirm` recusa as ofertas: `cancel_at = renews_at` (o fim do que
 *      foi pago; o fim do teste, no teste). Até lá tudo funciona; nenhuma
 *      fatura nova sai, e a da renovação seguinte, se já saiu, é cancelada no
 *      gateway. Na data o agendador cancela (`self_cancel`). Sem período pago
 *      correndo (o atraso, o teste vencido, a pausa já correndo), cancela na
 *      hora.
 *   4. `revert` desfaz o cancelamento agendado antes da data — pelo dono, ou
 *      pelo console — e a fatura que o agendamento cancelou volta à emissão.
 *
 * ## O desconto e o cupom que já existe
 *
 * Um cupom por assinatura. Quem já tem um cupom que vale no plano dele só
 * recebe a oferta de desconto se o de retenção der uma fatura MENOR que a de
 * hoje (`better_coupon` quando não dá); aceito, ele SUBSTITUI o de antes —
 * nunca soma. Um desconto menor ou igual ao que ele já tem não seria oferta.
 *
 * ## Quem
 *
 * Só o dono (`owner`; ou o `admin` de um provedor sem dono, a regra de
 * `TenantController.updateSecurity`) — conferido no controlador.
 */
export const CANCELLATION_REASONS = Object.freeze([
  'too_expensive',
  'not_using',
  'missing_features',
  'switching_provider',
  'technical_issues',
  'business_closed',
  'temporary',
  'other'
]);

export const CANCELLATION_OFFERS = Object.freeze(['discount', 'pause']);

/** O motivo do cancelamento feito pelo próprio provedor, no extrato e nas trilhas. */
export const SELF_CANCEL_REASON = 'self_cancel';

const COMMENT_MAX = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A carência do desconto de retenção: doze meses DEPOIS do fim do período
 * descontado — `max(12, meses descontados + 12)` contados da decisão. No
 * anual o período descontado é a fatura do ano (doze meses), e a carência é
 * de 24: sem isto, o desconto voltaria a cada renovação anual.
 */
const DISCOUNT_COOLDOWN_MONTHS = 12;
/** A pausa de retenção: uma a cada doze meses. */
const PAUSE_COOLDOWN_MONTHS = 12;
/** Os estados em que o provedor decide sobre a própria assinatura — os de `SelfBillingService`. */
const ESTADOS_VIVOS = new Set(['trial', 'active', 'past_due']);

const recusa = (key, code, status = 409, extra = null) => new SelfBillingError(key, { code, status, extra });

function asDate(value) {
  if (!value) return null;
  const data = value instanceof Date ? value : new Date(value);
  return Number.isNaN(data.getTime()) ? null : data;
}

function isoOf(value) {
  const data = asDate(value);
  return data ? data.toISOString() : null;
}

/** Sem os milissegundos: o MySQL guarda ao segundo, e arredonda. */
function aoSegundo(data) {
  return new Date(Math.floor(data.getTime() / 1000) * 1000);
}

/**
 * `meses` meses de calendário depois de `data`, no mesmo horário — e, no mês
 * mais curto, o último dia dele (31/01 + 1 mês é 28 ou 29/02, não 03/03).
 */
export function addMonths(data, meses) {
  const d = new Date(data.getTime());
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + meses);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d;
}

/**
 * O desconto de retenção do anual: `percent` % por `months` meses, levado a
 * UMA fatura anual — `percent × months ÷ 12` (20% × 3 ÷ 12 = 5% da fatura do
 * ano), até 99%.
 */
export function annualRetentionPercent(percent, months) {
  const p = Math.max(0, Number(percent) || 0);
  const m = Math.max(0, Math.floor(Number(months) || 0));
  return Math.min(99, (p * m) / 12);
}

/**
 * O abatimento em centavos do desconto de retenção numa fatura anual de
 * `annualCents` — arredondado para baixo, como todo desconto.
 */
export function annualRetentionCents(annualCents, percent, months) {
  const preco = Math.max(0, Math.floor(Number(annualCents) || 0));
  return Math.floor((preco * annualRetentionPercent(percent, months)) / 100);
}

/** Os meses que o desconto aceito cobriu (o anual: a fatura do ano). */
function mesesDescontados(linha) {
  if (linha?.billing_cycle === 'annual') return 12;
  const meses = Number(linha?.months);
  return Number.isFinite(meses) && meses > 0 ? Math.floor(meses) : 0;
}

/** Quando o desconto de retenção volta a valer depois do pedido `linha`. */
function descontoVoltaEm(linha) {
  const quando = asDate(linha?.decided_at);
  if (!quando) return null;
  return addMonths(quando, Math.max(DISCOUNT_COOLDOWN_MONTHS, mesesDescontados(linha) + DISCOUNT_COOLDOWN_MONTHS));
}

/** O código do cupom de retenção de uma configuração: um por porcentagem e meses. */
export function retentionCouponCode(percent, months) {
  return `RETENCAO-${percent}-${months}`;
}

/** Um pedido como a tela e o console o leem. */
function presentRequest(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    reason: row.reason,
    comment: row.comment ?? null,
    offersPresented: row.offers_presented ? String(row.offers_presented).split(',').filter(Boolean) : [],
    offer: row.offer ?? null,
    outcome: row.outcome ?? null,
    months: row.months === null || row.months === undefined ? null : Number(row.months),
    discountPercent: row.discount_percent === null || row.discount_percent === undefined ? null : Number(row.discount_percent),
    billingCycle: parseBillingCycle(row.billing_cycle),
    cancelAt: isoOf(row.cancel_at),
    createdAt: isoOf(row.created_at),
    decidedAt: isoOf(row.decided_at),
    revertedAt: isoOf(row.reverted_at),
    revertedBy: row.reverted_by ?? null
  };
}

/** A recusa do gateway (ou da linha ocupada) ao cancelar a fatura, na língua da tela. */
function recusaDaCobranca(error) {
  if (!(error instanceof ChargeFollowError)) return error;
  if (error.code === 'busy') return new SelfBillingError('billing.busy', { code: 'busy', status: 409 });
  return new SelfBillingError('cancellation.chargeCancelFailed', {
    code: 'gateway_failed', status: 502, vars: { detail: error.detail ?? error.message }, detail: error.detail ?? error.message
  });
}

/**
 * O cupom de retenção desta configuração — achado pelo código, ou criado.
 * Nulo quando o código está tomado por um cupom que o console criou à mão
 * (não é do sistema), ou quando o console desativou o do sistema: aí a oferta
 * de desconto não vale.
 */
async function cupomDeRetencao(percent, months) {
  const code = retentionCouponCode(percent, months);
  let cupom = await Coupon.findByCode(code);
  if (!cupom) {
    try {
      cupom = await Coupon.create({
        code,
        kind: 'percent',
        value: percent,
        duration: 'repeating',
        duration_cycles: months,
        active: true,
        system_kind: 'retention'
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      cupom = await Coupon.findByCode(code);
    }
  }
  if (!cupom || cupom.system_kind !== 'retention' || !cupom.active) return null;
  return cupom;
}

/**
 * O cupom de retenção do ANUAL: UMA fatura (`once`) com o desconto
 * equivalente (`annualRetentionPercent`). Percentual quando a conta dá um
 * inteiro; senão o valor em centavos sobre o preço anual do plano
 * (`annualCents`) — o cupom percentual é inteiro.
 */
async function cupomDeRetencaoAnual(percent, months, annualCents) {
  const equivalente = annualRetentionPercent(percent, months);
  const inteiro = Number.isInteger(equivalente) && equivalente >= 1;
  const valor = inteiro ? equivalente : annualRetentionCents(annualCents, percent, months);
  if (!(valor > 0)) return null;
  const code = inteiro ? `RETENCAO-ANUAL-${valor}` : `RETENCAO-ANUAL-F${valor}`;
  let cupom = await Coupon.findByCode(code);
  if (!cupom) {
    try {
      cupom = await Coupon.create({
        code,
        kind: inteiro ? 'percent' : 'fixed',
        value: valor,
        duration: 'once',
        active: true,
        system_kind: ANNUAL_RETENTION_KIND
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      cupom = await Coupon.findByCode(code);
    }
  }
  if (!cupom || cupom.system_kind !== ANNUAL_RETENTION_KIND || !cupom.active) return null;
  return cupom;
}

/**
 * A fatura que o desconto de retenção vai descontar: a assinatura no ciclo
 * da próxima renovação e o plano dela — a troca agendada (a descida, o ciclo
 * anual), quando há uma; senão a de agora.
 */
async function proximaFatura(subscription, plan) {
  if (subscription?.pending_plan_id) {
    const agendado = await Plan.findById(subscription.pending_plan_id);
    if (agendado) return { view: SubscriptionService.scheduledView(subscription), plan: agendado };
  }
  return { view: subscription, plan };
}

/**
 * Quantos ciclos o desconto de retenção cobre nesta assinatura: os
 * `discountMonths` da configuração no mensal; UM no anual (0104). O cupom
 * `repeating` conta ciclos pagos, e no anual cada ciclo é um ano — "20% por 3
 * meses" lá seriam três faturas anuais, três anos de desconto. Um ciclo anual
 * já cobre doze meses, o maior desconto em tempo que a configuração permite
 * (`retentionDiscountMonths` vai até 24, e o cupom não divide uma fatura).
 */
export function retentionCyclesFor(subscription, plan, discountMonths) {
  const meses = Math.max(0, Math.floor(Number(discountMonths) || 0));
  if (!(meses > 0)) return meses;
  return SubscriptionService.cycleOf(subscription, plan) === 'annual' ? 1 : meses;
}

class CancellationService {
  /**
   * O fim do período já pago — até quando o cancelamento espera —, ou nulo
   * quando não há período pago correndo (e aí o cancelamento é na hora).
   *
   * Na pausa marcada, o fim do período pago é `renews_at` enquanto ela não
   * começou; com ela correndo não há período pago.
   */
  static paidThrough(subscription, now = new Date()) {
    if (!subscription) return null;
    const futuro = (valor) => {
      const data = asDate(valor);
      return data && data.getTime() > now.getTime() ? data : null;
    };
    if (subscription.status === 'active') return futuro(subscription.renews_at);
    if (subscription.status === 'trial') return futuro(subscription.trial_ends_at);
    return null;
  }

  /**
   * As ofertas que valem para esta assinatura agora, e por que a que não vale
   * não vale (`disabled`, `not_eligible`, `used_recently`, `better_coupon`,
   * `already_paused`).
   */
  static async offersFor(subscription, plan, coupon, { now = new Date(), config = null } = {}) {
    const politica = config ?? await retentionConfig();
    // O preço do CICLO (0104): no anual, o da fatura anual.
    const preco = SubscriptionService.cyclePriceCents(subscription, plan);
    const vivo = Boolean(subscription && ESTADOS_VIVOS.has(subscription.status)
      && !subscription.billing_exempt_at && preco > 0 && !isCancelScheduled(subscription));

    // A fatura que o desconto desconta: a da próxima renovação — no ciclo
    // anual quando a assinatura é anual OU vai ser (a troca agendada).
    const proxima = await proximaFatura(subscription, plan);
    const billingCycle = SubscriptionService.cycleOf(proxima.view, proxima.plan);
    const anual = billingCycle === 'annual';
    const percentDaConfig = politica.discountPercent;
    // `months` é quantas FATURAS o desconto cobre (o cupom `repeating` conta
    // ciclos pagos). No ciclo anual (0104) cada ciclo é um ano: lá o desconto
    // vira UMA fatura anual com o equivalente — `percent × meses ÷ 12`.
    const months = retentionCyclesFor(proxima.view, proxima.plan, politica.discountMonths);
    let percent = percentDaConfig;
    let comDesconto;
    if (anual) {
      const precoAnual = SubscriptionService.cyclePriceCents(proxima.view, proxima.plan);
      percent = Math.round(annualRetentionPercent(percentDaConfig, politica.discountMonths) * 100) / 100;
      comDesconto = SubscriptionService.priceWithCoupon(precoAnual, {
        kind: 'fixed', value: annualRetentionCents(precoAnual, percentDaConfig, politica.discountMonths)
      });
    } else {
      comDesconto = SubscriptionService.priceWithCoupon(preco, { kind: 'percent', value: percentDaConfig });
    }
    const discount = {
      available: false,
      reason: null,
      percent,
      months,
      billingCycle,
      priceCents: comDesconto,
      availableAgainAt: null,
      ...(anual ? { configPercent: percentDaConfig, configMonths: politica.discountMonths } : {})
    };
    if (!(percentDaConfig > 0 && politica.discountMonths > 0) || !(percent > 0)) discount.reason = 'disabled';
    else if (!vivo || isPauseScheduled(subscription)) discount.reason = 'not_eligible';
    else {
      const ultimo = await CancellationRequest.lastWithOutcome(CANCELLATION_OUTCOMES.RETAINED_DISCOUNT);
      const volta = ultimo ? descontoVoltaEm(ultimo) : null;
      if (volta && volta.getTime() > now.getTime()) {
        discount.reason = 'used_recently';
        discount.availableAgainAt = volta.toISOString();
      } else if (SubscriptionService.couponApplies(anual ? proxima.view : subscription, anual ? proxima.plan : plan, coupon)
        && SubscriptionService.priceFor(anual ? proxima.view : subscription, anual ? proxima.plan : plan, coupon) <= comDesconto) {
        discount.reason = 'better_coupon';
      }
    }
    discount.available = discount.reason === null;

    const pause = {
      available: false, reason: null, maxMonths: politica.pauseMaxMonths, from: null, availableAgainAt: null
    };
    const renovacao = asDate(subscription?.renews_at);
    if (!(politica.pauseMaxMonths > 0)) pause.reason = 'disabled';
    else if (isPauseScheduled(subscription)) pause.reason = 'already_paused';
    else if (!vivo || subscription.status !== 'active' || !renovacao || renovacao.getTime() <= now.getTime()) {
      // Só com um período pago correndo: a pausa começa no fim dele. Quem está
      // devendo (ou no teste) não tem o que pausar — tem o que pagar.
      pause.reason = 'not_eligible';
    } else {
      // Uma pausa a cada doze meses, contados da decisão da última.
      const ultima = await CancellationRequest.lastWithOutcome(CANCELLATION_OUTCOMES.RETAINED_PAUSE);
      const decidida = asDate(ultima?.decided_at);
      const volta = decidida ? addMonths(decidida, PAUSE_COOLDOWN_MONTHS) : null;
      if (volta && volta.getTime() > now.getTime()) {
        pause.reason = 'pause_cooldown';
        pause.availableAgainAt = volta.toISOString();
      } else {
        pause.from = renovacao.toISOString();
      }
    }
    pause.available = pause.reason === null;
    return { discount, pause };
  }

  /** O que o provedor em escopo lê na tela de cancelamento. */
  static async status({ now = new Date() } = {}) {
    const tenantId = currentTenantId();
    const subscription = await Subscription.forTenant(tenantId);
    const plan = subscription?.plan_id ? await Plan.findById(subscription.plan_id) : null;
    const coupon = subscription?.coupon_id ? await Coupon.findById(subscription.coupon_id) : null;
    const offers = await this.offersFor(subscription, plan, coupon, { now });
    const aberto = await CancellationRequest.open();
    const agendado = isCancelScheduled(subscription) ? await CancellationRequest.scheduled() : null;
    const fim = this.paidThrough(subscription, now);
    return {
      reasons: CANCELLATION_REASONS,
      canCancel: Boolean(subscription && ESTADOS_VIVOS.has(subscription.status) && !isCancelScheduled(subscription)),
      offers,
      request: presentRequest(aberto),
      scheduled: agendado ? presentRequest(agendado) : null,
      cancelAt: isCancelScheduled(subscription) ? isoOf(subscription.cancel_at) : null,
      pausedUntil: isPauseScheduled(subscription) ? isoOf(subscription.paused_until) : null,
      // Até quando o cancelamento esperaria se fosse confirmado agora (nulo:
      // seria na hora). Na pausa marcada, o fim do período pago.
      cancelWouldTakeEffectAt: isoOf(fim)
    };
  }

  /** Lê a assinatura do provedor em escopo e recusa quem não decide sobre ela. */
  static async lerDecidivel() {
    const tenantId = currentTenantId();
    const tenant = await Tenant.findById(tenantId);
    if (!tenant || tenant.kind === 'platform') throw recusa('subscription.notChangeable', 'not_changeable');
    const subscription = await Subscription.forTenant(tenantId);
    if (!subscription || !ESTADOS_VIVOS.has(subscription.status)) throw recusa('subscription.notChangeable', 'not_changeable');
    if (isCancelScheduled(subscription)) throw recusa('cancellation.alreadyScheduled', 'cancel_scheduled');
    return { tenantId, tenant, subscription };
  }

  /**
   * O primeiro passo: o motivo. Devolve as ofertas. Um pedido ainda sem
   * decisão é reaproveitado (o dono voltou à tela e escolheu outro motivo),
   * e não vira outra linha no relatório.
   */
  static async request({ reason, comment = null, actorUserId = null, now = new Date() }) {
    const motivo = typeof reason === 'string' ? reason.trim() : '';
    if (!CANCELLATION_REASONS.includes(motivo)) throw recusa('cancellation.invalidReason', 'invalid_reason', 400);
    if (comment !== null && comment !== undefined && typeof comment !== 'string') {
      throw recusa('cancellation.invalidReason', 'invalid_comment', 400);
    }
    const texto = typeof comment === 'string' ? comment.trim().slice(0, COMMENT_MAX) : '';
    const { subscription } = await this.lerDecidivel();
    const plan = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;
    const coupon = subscription.coupon_id ? await Coupon.findById(subscription.coupon_id) : null;
    const offers = await this.offersFor(subscription, plan, coupon, { now });
    const apresentadas = CANCELLATION_OFFERS.filter((oferta) => offers[oferta].available).join(',') || null;

    const aberto = await CancellationRequest.open();
    let linha;
    if (aberto && await CancellationRequest.updateOpen(aberto.id, {
      reason: motivo, comment: texto || null, offers_presented: apresentadas
    })) {
      linha = await CancellationRequest.findById(aberto.id);
    } else {
      linha = await CancellationRequest.create({
        reason: motivo,
        comment: texto || null,
        offers_presented: apresentadas,
        created_by: actorUserId,
        created_at: aoSegundo(now)
      });
    }
    // O alerta para quem opera a plataforma (0112): um por pedido — o motivo
    // trocado na mesma tela é o mesmo pedido, e não avisa de novo.
    await PlatformAlertService.enqueue('cancellation_requested', {
      tenantId: currentTenantId(),
      dedupeKey: `${currentTenantId()}:${linha.id}`,
      payload: { reason: motivo },
      now
    });
    return { request: presentRequest(linha), offers };
  }

  /**
   * O segundo passo, quando o dono aceita uma oferta. `months` é a duração
   * da pausa (1 até `retentionPauseMaxMonths`; padrão, o máximo); o desconto
   * tem a duração da configuração.
   */
  static async accept({ offer, months = null, actorUserId = null, countDevices = null, now = new Date() }) {
    if (!CANCELLATION_OFFERS.includes(offer)) throw recusa('cancellation.invalidOffer', 'invalid_offer', 400);
    const { tenantId, subscription } = await this.lerDecidivel();
    const aberto = await CancellationRequest.open();
    if (!aberto) throw recusa('cancellation.noRequest', 'no_request');
    const plan = subscription.plan_id ? await Plan.findById(subscription.plan_id) : null;
    const coupon = subscription.coupon_id ? await Coupon.findById(subscription.coupon_id) : null;
    const config = await retentionConfig();
    const offers = await this.offersFor(subscription, plan, coupon, { now, config });
    if (!offers[offer].available) {
      throw recusa('cancellation.offerUnavailable', 'offer_unavailable', 409, { reason: offers[offer].reason });
    }
    return offer === 'discount'
      ? this.aceitarDesconto({
        tenantId, subscription, plan, aberto, config, oferta: offers.discount, actorUserId, countDevices, now
      })
      : this.aceitarPausa({ tenantId, subscription, aberto, config, months, actorUserId, now });
  }

  static async aceitarDesconto({
    tenantId, subscription, plan, aberto, config, oferta, actorUserId, countDevices, now
  }) {
    // No anual (a assinatura, ou a troca agendada para ele), UMA fatura anual
    // com o equivalente; no mensal, N faturas com a porcentagem.
    const anual = oferta?.billingCycle === 'annual';
    let cupom;
    if (anual) {
      const proxima = await proximaFatura(subscription, plan);
      cupom = await cupomDeRetencaoAnual(
        config.discountPercent, config.discountMonths, SubscriptionService.cyclePriceCents(proxima.view, proxima.plan)
      );
    } else {
      cupom = await cupomDeRetencao(config.discountPercent, config.discountMonths);
    }
    if (!cupom) throw recusa('cancellation.offerUnavailable', 'offer_unavailable', 409, { reason: 'disabled' });
    // A porta de sempre do cupom: a fatura em aberto reprecificada (cancelada
    // no gateway ANTES de gravar; a recusa para tudo e nada muda).
    const aplicado = await CouponService.apply({
      tenantId, code: cupom.code, actorUserId, source: 'retention', countDevices, now
    });
    await CancellationRequest.decide(aberto.id, {
      offer: 'discount',
      outcome: CANCELLATION_OUTCOMES.RETAINED_DISCOUNT,
      months: config.discountMonths,
      discount_percent: config.discountPercent,
      billing_cycle: anual ? 'annual' : 'monthly',
      decided_at: aoSegundo(now)
    });
    return {
      offer: 'discount',
      request: presentRequest(await CancellationRequest.findById(aberto.id)),
      coupon: {
        id: Number(cupom.id),
        code: cupom.code,
        percent: anual ? oferta.percent : config.discountPercent,
        months: anual ? 1 : config.discountMonths,
        billingCycle: anual ? 'annual' : 'monthly'
      },
      priceCents: aplicado.priceCents,
      replacedCouponId: aplicado.replacedCouponId ?? null,
      charge: aplicado.charge
    };
  }

  static async aceitarPausa({ tenantId, subscription, aberto, config, months, actorUserId, now }) {
    const meses = months === null || months === undefined ? config.pauseMaxMonths : Number(months);
    if (!Number.isInteger(meses) || meses < 1 || meses > config.pauseMaxMonths) {
      throw recusa('cancellation.invalidMonths', 'invalid_months', 400, { maxMonths: config.pauseMaxMonths });
    }
    const renovacao = asDate(subscription.renews_at);
    const ate = aoSegundo(addMonths(renovacao, meses));

    // A fatura da renovação que a pausa adia, se já saiu: cancelada no
    // gateway ANTES de a pausa existir. A recusa para tudo — melhor "tente de
    // novo" do que uma pausa com a fatura viva no e-mail do provedor.
    let canceladas;
    try {
      canceladas = await ChargeIssuingService.cancelRenewalCharges({
        periodEnd: ChargeIssuingService.periodKey(renovacao), now
      });
    } catch (error) {
      throw recusaDaCobranca(error);
    }

    const gravou = await getDb().transaction(async (trx) => {
      const mudou = await Subscription.changeIf(tenantId, (q) => q
        .where({ status: 'active' })
        .whereNull('paused_until')
        .whereNull('cancel_at'), { paused_until: ate, pause_started_at: aoSegundo(now) }, trx);
      if (!mudou) return false;
      await BillingEvent.record({
        subscriptionId: subscription.id,
        type: BILLING_EVENT_TYPES.SUBSCRIPTION_PAUSED,
        createdBy: actorUserId,
        detail: {
          from: renovacao.toISOString(),
          until: ate.toISOString(),
          months: meses,
          requestId: Number(aberto.id),
          ...(canceladas.canceled.length ? { canceledCharges: canceladas.canceled } : {})
        }
      }, trx);
      await CancellationRequest.decide(aberto.id, {
        offer: 'pause',
        outcome: CANCELLATION_OUTCOMES.RETAINED_PAUSE,
        months: meses,
        decided_at: aoSegundo(now)
      }, trx);
      return true;
    });
    SubscriptionService.cache.invalidate();
    if (!gravou) throw new SelfBillingError('billing.busy', { code: 'busy', status: 409 });
    // A emissão que estava no meio quando a pausa foi gravada (a linha com a
    // garra dela escapou da varredura de cima): varrida de novo, agora que a
    // pausa já está gravada — melhor esforço; a emissão também relê a
    // assinatura depois de criar a cobrança.
    await this.varrerDeNovo(renovacao, now);
    return {
      offer: 'pause',
      request: presentRequest(await CancellationRequest.findById(aberto.id)),
      pausedFrom: renovacao.toISOString(),
      pausedUntil: ate.toISOString(),
      months: meses,
      canceledCharges: canceladas.canceled.length
    };
  }

  /**
   * O dono recusou as ofertas: o cancelamento é agendado para o fim do
   * período pago — ou feito na hora, quando não há período pago correndo.
   */
  static async confirm({ actorUserId = null, now = new Date() } = {}) {
    const { tenantId, subscription } = await this.lerDecidivel();
    const aberto = await CancellationRequest.open();
    if (!aberto) throw recusa('cancellation.noRequest', 'no_request');
    const fim = this.paidThrough(subscription, now);

    // As faturas de renovação que não vão ser pagas: a do período seguinte
    // (agendado), ou todas em aberto (na hora). Antes de gravar, e a recusa
    // para tudo — ver `aceitarPausa`.
    let canceladas;
    try {
      canceladas = await ChargeIssuingService.cancelRenewalCharges({
        periodEnd: fim ? ChargeIssuingService.periodKey(fim) : null, now
      });
    } catch (error) {
      throw recusaDaCobranca(error);
    }

    if (!fim) {
      await SubscriptionService.setStatus({ status: 'canceled', reason: SELF_CANCEL_REASON, actorUserId });
      await CancellationRequest.decide(aberto.id, {
        offer: 'none', outcome: CANCELLATION_OUTCOMES.CANCELED, cancel_at: aoSegundo(now), decided_at: aoSegundo(now)
      });
      // O excedente do período que fecha (0105), numa fatura final de só
      // excedente — as de renovação acabaram de ser canceladas.
      await ChargeIssuingService.issueFinalOverage({ subscription, now });
      await this.alertarAgendado(tenantId, aberto, aoSegundo(now), true, now);
      return {
        immediate: true,
        cancelAt: aoSegundo(now).toISOString(),
        canceledCharges: canceladas.canceled.length,
        request: presentRequest(await CancellationRequest.findById(aberto.id))
      };
    }

    const quando = aoSegundo(fim);
    const gravou = await getDb().transaction(async (trx) => {
      const mudou = await Subscription.changeIf(tenantId, (q) => q
        .whereIn('status', [...ESTADOS_VIVOS])
        .whereNull('cancel_at'), { cancel_at: quando, paused_until: null, pause_started_at: null }, trx);
      if (!mudou) return false;
      await BillingEvent.record({
        subscriptionId: subscription.id,
        type: BILLING_EVENT_TYPES.CANCELLATION_SCHEDULED,
        createdBy: actorUserId,
        detail: {
          cancelAt: quando.toISOString(),
          reason: aberto.reason,
          requestId: Number(aberto.id),
          ...(subscription.paused_until ? { pauseCleared: isoOf(subscription.paused_until) } : {}),
          ...(canceladas.canceled.length ? { canceledCharges: canceladas.canceled } : {})
        }
      }, trx);
      await CancellationRequest.decide(aberto.id, {
        offer: 'none', outcome: CANCELLATION_OUTCOMES.CANCELED, cancel_at: quando, decided_at: aoSegundo(now)
      }, trx);
      return true;
    });
    SubscriptionService.cache.invalidate();
    if (!gravou) throw new SelfBillingError('billing.busy', { code: 'busy', status: 409 });
    // Como na pausa: a emissão que escapou da varredura de antes.
    await this.varrerDeNovo(fim, now);
    await this.alertarAgendado(tenantId, aberto, quando, false, now);
    return {
      immediate: false,
      cancelAt: quando.toISOString(),
      canceledCharges: canceladas.canceled.length,
      request: presentRequest(await CancellationRequest.findById(aberto.id))
    };
  }

  /** O alerta do cancelamento confirmado (0112), um por pedido. Nunca lança. */
  static async alertarAgendado(tenantId, pedido, quando, imediato, now) {
    await PlatformAlertService.enqueue('cancellation_scheduled', {
      tenantId,
      dedupeKey: `${tenantId}:${pedido.id}`,
      payload: { reason: pedido.reason ?? null, date: quando.toISOString(), immediate: imediato },
      now
    });
  }

  /** A segunda varredura das faturas da renovação de `prazo`, depois de gravar — melhor esforço. */
  static async varrerDeNovo(prazo, now) {
    try {
      await ChargeIssuingService.cancelRenewalCharges({ periodEnd: ChargeIssuingService.periodKey(prazo), now });
    } catch (error) {
      console.warn(`Could not re-sweep the renewal charges of provider ${currentTenantId()}: ${error.message}`);
    }
  }

  /**
   * Desfaz o cancelamento agendado do provedor em escopo — `source` é
   * `provider` (o dono) ou `console`. A fatura da renovação que o agendamento
   * cancelou volta à emissão.
   */
  static async revert({ source = 'provider', actorUserId = null, now = new Date() } = {}) {
    const tenantId = currentTenantId();
    const subscription = await Subscription.forTenant(tenantId);
    if (!subscription || !isCancelScheduled(subscription)) throw recusa('cancellation.notScheduled', 'not_scheduled');
    const agendado = await CancellationRequest.scheduled();
    const gravou = await getDb().transaction(async (trx) => {
      const mudou = await Subscription.changeIf(tenantId, (q) => q
        .whereNotNull('cancel_at')
        .whereNot({ status: 'canceled' }), { cancel_at: null }, trx);
      if (!mudou) return false;
      await BillingEvent.record({
        subscriptionId: subscription.id,
        type: BILLING_EVENT_TYPES.CANCELLATION_REVERTED,
        createdBy: actorUserId,
        detail: { cancelAt: isoOf(subscription.cancel_at), source, ...(agendado ? { requestId: Number(agendado.id) } : {}) }
      }, trx);
      if (agendado) await CancellationRequest.markReverted(agendado.id, { at: aoSegundo(now), by: source }, trx);
      return true;
    });
    SubscriptionService.cache.invalidate();
    if (!gravou) throw recusa('cancellation.notScheduled', 'not_scheduled');

    // A fatura do período que o agendamento cancelou volta à emissão — sem
    // isto a linha ficaria `canceled`, a emissão responderia `already_settled`
    // e o provedor venceria sem fatura. Melhor esforço: o "pagar agora" a
    // reabre de todo jeito.
    let reaberta = false;
    const prazo = asDate(subscription.renews_at ?? subscription.trial_ends_at);
    if (prazo) {
      try {
        reaberta = await ChargeIssuingService.reopenRetentionCanceled(ChargeIssuingService.periodKey(prazo), { now });
      } catch (error) {
        console.warn(`Could not reopen the charge canceled by the cancellation of provider ${tenantId}: ${error.message}`);
      }
    }
    return { reverted: true, cancelAt: isoOf(subscription.cancel_at), reopenedCharge: reaberta };
  }

  /**
   * O que o agendador cumpre por provedor, a cada volta, ANTES da emissão:
   *
   *   - o cancelamento agendado cuja data chegou vira `canceled`
   *     (`self_cancel`);
   *   - a pausa cuja data chegou acaba: `renews_at = paused_until`, e a
   *     emissão da mesma volta abre a fatura.
   *
   * As duas gravações são condicionais à linha como está agora: duas voltas
   * sobrepostas cumprem uma vez só, e só quem cumpriu grava extrato e trilhas.
   */
  static async processDue({ tenant = null, now = new Date() } = {}) {
    const tenantId = currentTenantId();
    const subscription = await Subscription.forTenant(tenantId);
    if (!subscription) return { action: 'none' };

    const cancelaEm = asDate(subscription.cancel_at);
    if (isCancelScheduled(subscription) && cancelaEm && cancelaEm.getTime() <= now.getTime()) {
      return this.cumprirCancelamento({ tenant, tenantId, subscription, cancelaEm, now });
    }
    const pausaAte = asDate(subscription.paused_until);
    if (isPauseScheduled(subscription) && pausaAte && pausaAte.getTime() <= now.getTime()) {
      return this.retomarDaPausa({ tenant, tenantId, subscription, pausaAte, now });
    }
    return { action: 'none' };
  }

  static async cumprirCancelamento({ tenant, tenantId, subscription, cancelaEm, now }) {
    const detail = {
      from: subscription.status,
      to: 'canceled',
      reason: SELF_CANCEL_REASON,
      automatic: true,
      cancelAt: cancelaEm.toISOString()
    };
    const gravou = await getDb().transaction(async (trx) => {
      const mudou = await Subscription.changeIf(tenantId, (q) => q
        .whereNotNull('cancel_at')
        .where('cancel_at', '<=', now)
        .whereNot({ status: 'canceled' }), {
        status: 'canceled',
        canceled_at: aoSegundo(now),
        suspended_reason: null,
        cancel_at: null,
        paused_until: null,
        pause_started_at: null
      }, trx);
      if (!mudou) return false;
      await BillingEvent.record({
        subscriptionId: subscription.id,
        type: BILLING_EVENT_TYPES.STATUS_CHANGED,
        detail
      }, trx);
      return true;
    });
    SubscriptionService.cache.invalidate();
    if (!gravou) return { action: 'none', reason: 'raced' };

    // O que ainda estiver em aberto não vai mais ao gateway (a pró-rata sem
    // link), e a renovação que escapou do agendamento sai cancelada — melhor
    // esforço: o contrato já acabou, e a falha fica no log.
    try {
      await BillingCharge.cancelUnissuedProrations({ reason: 'not_billable' });
    } catch (error) {
      console.warn(`Could not cancel the unissued proration charges of provider ${tenantId}: ${error.message}`);
    }
    try {
      await ChargeIssuingService.cancelRenewalCharges({ now });
    } catch (error) {
      console.warn(`Could not cancel the open renewal charges of provider ${tenantId} after its cancellation: ${error.message}`);
    }
    // O excedente do período que fecha com o cancelamento (0105): a
    // renovação não sai para quem cancela, então ele vai numa fatura final
    // de só excedente. Melhor esforço.
    const excedenteFinal = await ChargeIssuingService.issueFinalOverage({ subscription, now });

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
    return {
      action: 'canceled',
      cancelAt: cancelaEm.toISOString(),
      ...(excedenteFinal?.issued || excedenteFinal?.charge ? { finalOverage: excedenteFinal.charge?.id ?? true } : {})
    };
  }

  static async retomarDaPausa({ tenant, tenantId, subscription, pausaAte, now }) {
    // O prazo depois da pausa: o fim dela — ou o prazo de agora, se ele já
    // vai além (um período pago depois de a pausa ser marcada não é encurtado).
    const prazoAntes = asDate(subscription.renews_at);
    const novoPrazo = prazoAntes && prazoAntes.getTime() > pausaAte.getTime() ? prazoAntes : pausaAte;
    const detail = {
      pausedUntil: pausaAte.toISOString(),
      renewsBefore: isoOf(subscription.renews_at),
      renewsAt: novoPrazo.toISOString(),
      automatic: true
    };
    const gravou = await getDb().transaction(async (trx) => {
      const mudou = await Subscription.changeIf(tenantId, (q) => q
        .whereNotNull('paused_until')
        .where('paused_until', '<=', now)
        .whereNot({ status: 'canceled' }), {
        renews_at: novoPrazo,
        paused_until: null,
        pause_started_at: null
      }, trx);
      if (!mudou) return false;
      await BillingEvent.record({
        subscriptionId: subscription.id,
        type: BILLING_EVENT_TYPES.SUBSCRIPTION_RESUMED,
        detail
      }, trx);
      return true;
    });
    SubscriptionService.cache.invalidate();
    if (!gravou) return { action: 'none', reason: 'raced' };
    if (novoPrazo.getTime() !== (prazoAntes?.getTime() ?? NaN)) await this.levarPicosDaPausa(subscription.renews_at, novoPrazo);
    const linha = tenant?.slug ? tenant : ((await getDb()('tenants').where({ id: tenantId }).first()) ?? { id: tenantId });
    await PlatformAudit.record({
      action: PlatformAudit.ACTIONS.SUBSCRIPTION_CANCELLATION_CHANGED,
      tenant: linha,
      detail: { action: 'pause_ended', ...detail, source: 'scheduler' }
    });
    return { action: 'resumed', renewsAt: novoPrazo.toISOString() };
  }

  /**
   * O excedente (0105) do período pago ANTES da pausa, levado para a chave do
   * período que a volta da pausa fecha. A fatura daquele período (que trazia
   * o excedente) foi cancelada pela pausa, e a da volta sai pela chave nova
   * (`renews_at = paused_until`): sem isto o excedente do período usado
   * sumiria na volta natural — e só a volta antecipada (o "pagar agora", que
   * reabre a cancelada com o excedente congelado) o cobraria. Na pausa nada
   * se mede (`recordUsagePeaks`), então a chave velha só tem o período usado.
   * Pelo `record` de sempre (só sobe): rodar duas vezes não soma nada.
   * Melhor esforço: a pausa já acabou, e a falha fica no log.
   */
  static async levarPicosDaPausa(renovacaoAntes, pausaAte) {
    const de = SubscriptionService.overagePeriodKey({ renews_at: renovacaoAntes });
    const para = SubscriptionService.overagePeriodKey({ renews_at: pausaAte });
    if (!de || !para || de === para) return;
    try {
      const linhas = await UsagePeak.rowsForPeriod(de);
      for (const [recurso, linha] of Object.entries(linhas)) {
        if (!linha) continue;
        // A fotografia do plano vai junto (0105): a cobrança da volta lê o
        // teto e o preço de quando o excedente foi medido.
        const foto = linha.unitCents !== null && linha.limit !== null
          ? { limit: linha.limit, unitCents: linha.unitCents } : null;
        // eslint-disable-next-line no-await-in-loop -- três recursos no máximo
        if (foto) await UsagePeak.recordSnapshot(para, recurso, linha.overagePeak ?? linha.peak, foto);
        // eslint-disable-next-line no-await-in-loop
        await UsagePeak.record(para, recurso, linha.peak);
      }
    } catch (error) {
      console.warn(`Could not carry the usage peaks over the pause of provider ${currentTenantId()}: ${error.message}`);
    }
  }

  /**
   * O relatório de cancelamentos do console: quantos pedidos, por motivo, o
   * que foi oferecido e aceito, a taxa de retenção, e a lista.
   *
   * Retido é quem ficou: aceitou o desconto, a pausa, ou desfez o
   * cancelamento agendado. A taxa é retidos ÷ decididos (os pedidos ainda sem
   * decisão não entram em nenhum dos dois).
   */
  static async report({ since = null, limit = 200 } = {}) {
    const linhas = await CancellationRequest.listAll({ since });
    const byReason = Object.fromEntries(CANCELLATION_REASONS.map((motivo) => [motivo, 0]));
    const byOutcome = {
      retained_discount: 0, retained_pause: 0, canceled: 0, reverted: 0, pending: 0
    };
    const offers = { discount: { presented: 0, accepted: 0 }, pause: { presented: 0, accepted: 0 } };
    for (const linha of linhas) {
      if (Object.hasOwn(byReason, linha.reason)) byReason[linha.reason] += 1;
      else byReason.other += 1;
      const desfecho = linha.outcome && Object.hasOwn(byOutcome, linha.outcome) ? linha.outcome : 'pending';
      byOutcome[desfecho] += 1;
      for (const oferta of String(linha.offers_presented ?? '').split(',').filter(Boolean)) {
        if (offers[oferta]) offers[oferta].presented += 1;
      }
      if (linha.offer && offers[linha.offer]) offers[linha.offer].accepted += 1;
    }
    const retidos = byOutcome.retained_discount + byOutcome.retained_pause + byOutcome.reverted;
    const decididos = retidos + byOutcome.canceled;
    return {
      total: linhas.length,
      byReason,
      byOutcome,
      offers,
      retained: retidos,
      decided: decididos,
      retentionRate: decididos ? Math.round((retidos / decididos) * 1000) / 1000 : null,
      requests: linhas.slice(0, limit).map((linha) => ({
        ...presentRequest(linha),
        tenant: { id: Number(linha.tenant_id), name: linha.tenant_name ?? null, slug: linha.tenant_slug ?? null }
      }))
    };
  }
}

export default CancellationService;
