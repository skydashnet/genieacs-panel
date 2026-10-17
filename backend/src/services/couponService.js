import Coupon, { normalizeCouponCode, parseCouponPlanIds } from '../models/Coupon.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import Tenant from '../models/Tenant.js';
import BillingEvent, { BILLING_EVENT_TYPES } from '../models/BillingEvent.js';
import CouponRedemption from '../models/CouponRedemption.js';
import SubscriptionService, { ANNUAL_RETENTION_KIND } from './subscriptionService.js';
import SelfBillingService, { SelfBillingError } from './selfBillingService.js';
import { getDb, isUniqueViolation } from '../config/database.js';
import { runInTenant } from '../config/tenantContext.js';

/**
 * O cupom de desconto entrando e saindo de uma assinatura (0093).
 *
 * ## Quem aplica
 *
 * O provedor, digitando o código na tela de Plano (`owner`/`admin`, a mesma
 * capacidade da troca de plano), e o console. O provedor só aplica quando não
 * tem cupom; o console SUBSTITUI o que houver — o resgate do velho continua
 * contado, porque ele foi usado.
 *
 * ## A ordem, que é a da troca de plano
 *
 * Recusas baratas primeiro (código, validade, teto, plano), depois o resgate
 * atômico (`Coupon.redeem`, uma atualização condicional — é ela que segura o
 * `max_redemptions` sob corrida), e só então a fatura em aberto: reprecificada
 * pela porta de sempre (`SelfBillingService.repriceAround`), que cancela no
 * gateway ANTES de gravar e para tudo se o gateway recusar. Qualquer recusa
 * depois do resgate devolve o resgate (`Coupon.unredeem`): um cupom que não
 * chegou a valer não gasta vaga.
 *
 * ## Um resgate por provedor
 *
 * O resgate grava, na mesma transação do contador, a linha de
 * `coupon_redemptions` do provedor — e é ela que impede o provedor de digitar
 * de novo o cupom que já gastou (`coupon_already_used`): o `coupon_id` da
 * assinatura some no último ciclo, a memória fica. O console pode reaplicar
 * por cima dela (é decisão comercial de gente), e aí não conta outro resgate:
 * o provedor já ocupa a vaga dele.
 *
 * ## O que a rota do provedor diz
 *
 * Só "cupom inválido" para vencido, esgotado, inativo ou de outro plano: a
 * tela do provedor não é lugar de sondar o catálogo (quais códigos existem,
 * quais já acabaram). O console continua com o código detalhado.
 */

/** Os estados em que o provedor mexe na própria assinatura — os de `SelfBillingService`. */
const ESTADOS_DO_PROVEDOR = new Set(['trial', 'active', 'past_due']);
/** O console alcança também o suspenso; o cancelado não tem fatura a descontar. */
const ESTADOS_DO_CONSOLE = new Set(['trial', 'active', 'past_due', 'suspended']);

const recusa = (key, code, status = 409, extra = null) => new SelfBillingError(key, { code, status, extra });

export const COUPON_ERRORS = Object.freeze({
  invalid: () => recusa('coupon.invalid', 'coupon_invalid'),
  expired: () => recusa('coupon.expired', 'coupon_expired'),
  exhausted: () => recusa('coupon.exhausted', 'coupon_exhausted'),
  planMismatch: () => recusa('coupon.planMismatch', 'coupon_plan_mismatch'),
  alreadyApplied: () => recusa('coupon.alreadyApplied', 'coupon_already_applied'),
  alreadyUsed: () => recusa('coupon.alreadyUsed', 'coupon_already_used')
});

/** As recusas que, na rota do provedor, viram só `coupon_invalid` — ver o topo. */
const RECUSAS_SONDAVEIS = new Set(['coupon_expired', 'coupon_exhausted', 'coupon_plan_mismatch']);

/** Um instante sem os milissegundos: o MySQL guarda ao segundo. */
function aoSegundo(data) {
  return new Date(Math.floor(data.getTime() / 1000) * 1000);
}

/**
 * Por que um cupom ativo não pode ser resgatado agora — ou nulo. `semTeto`:
 * a reaplicação do console a quem já resgatou, que não toma vaga nova.
 */
function motivoDeNaoResgatar(cupom, now, { semTeto = false } = {}) {
  if (!cupom || !cupom.active) return COUPON_ERRORS.invalid();
  const validade = cupom.valid_until ? new Date(cupom.valid_until) : null;
  if (validade && !Number.isNaN(validade.getTime()) && validade.getTime() <= now.getTime()) {
    return COUPON_ERRORS.expired();
  }
  if (semTeto) return null;
  const teto = cupom.max_redemptions === null || cupom.max_redemptions === undefined
    ? null : Number(cupom.max_redemptions);
  if (teto !== null && Number(cupom.redemptions ?? 0) >= teto) return COUPON_ERRORS.exhausted();
  return null;
}

/** Quantas faturas o cupom desconta ao entrar: uma, N, ou sem conta (`forever`). */
function ciclosDe(cupom) {
  if (cupom.duration === 'once') return 1;
  if (cupom.duration === 'repeating') return Math.max(1, Number(cupom.duration_cycles) || 1);
  return null;
}

/** O que do cupom vai para o extrato e para as trilhas. */
export function couponTrail(cupom) {
  if (!cupom) return null;
  return {
    id: Number(cupom.id),
    code: cupom.code,
    kind: cupom.kind,
    value: Number(cupom.value),
    duration: cupom.duration,
    durationCycles: cupom.duration_cycles === null || cupom.duration_cycles === undefined
      ? null : Number(cupom.duration_cycles)
  };
}

class CouponService {
  /**
   * Aplica o cupom `code` à assinatura do provedor `tenantId`.
   *
   * @returns {Promise<{ subscription: object, coupon: object, replacedCouponId: number|null,
   *   charge: 'none'|'reissued', reissue?: object }>}
   */
  static async apply({
    tenantId, code, actorUserId = null, source = 'provider', countDevices = null, now = new Date()
  }) {
    const doConsole = source === 'console';
    // O desconto de retenção (0107): aplicado pelo fluxo de cancelamento, com
    // o cupom do sistema. Substitui o que houver como o console — quem decide
    // se substitui (só um desconto maior que o atual) é `CancellationService`
    // — e, como o console, não toma vaga nova de quem já o resgatou um dia.
    const daRetencao = source === 'retention';
    const comoConsole = doConsole || daRetencao;
    // A rota do provedor não diferencia o cupom vencido, esgotado ou de outro
    // plano do inexistente (ver o topo).
    const recusar = (erro) => (!doConsole && erro && RECUSAS_SONDAVEIS.has(erro.code) ? COUPON_ERRORS.invalid() : erro);
    return runInTenant(tenantId, async () => {
      const tenant = await Tenant.findById(tenantId);
      if (!tenant || tenant.kind === 'platform') {
        throw recusa('subscription.notChangeable', 'not_changeable');
      }
      const antes = await Subscription.forTenant(tenantId);
      const estados = doConsole ? ESTADOS_DO_CONSOLE : ESTADOS_DO_PROVEDOR;
      if (!antes || !estados.has(antes.status)) throw recusa('subscription.notChangeable', 'not_changeable');

      const codigo = normalizeCouponCode(code);
      if (!codigo || codigo.length > 32) throw COUPON_ERRORS.invalid();
      const cupom = await Coupon.findByCode(codigo);
      if (!cupom || !cupom.active) throw COUPON_ERRORS.invalid();
      // O cupom do sistema (0107) não se resgata digitando: para o provedor
      // ele não existe. E a retenção só aplica o dela.
      if (cupom.system_kind && !comoConsole) throw COUPON_ERRORS.invalid();
      if (daRetencao && cupom.system_kind !== 'retention' && cupom.system_kind !== ANNUAL_RETENTION_KIND) {
        throw COUPON_ERRORS.invalid();
      }
      // O mesmo cupom outra vez não é um segundo resgate. Outro por cima: só
      // o console troca; o provedor precisa pedir.
      if (antes.coupon_id && (Number(antes.coupon_id) === Number(cupom.id) || !comoConsole)) {
        throw COUPON_ERRORS.alreadyApplied();
      }
      // Este provedor já resgatou este cupom um dia (e gastou, ou o console o
      // tirou): o provedor não o resgata de novo; o console pode reaplicar,
      // sem contar outro resgate.
      const jaResgatou = await CouponRedemption.exists(cupom.id);
      if (jaResgatou && !comoConsole) throw COUPON_ERRORS.alreadyUsed();
      const motivo = motivoDeNaoResgatar(cupom, now, { semTeto: jaResgatou });
      if (motivo) throw recusar(motivo);
      const plano = antes.plan_id ? await Plan.findById(antes.plan_id) : null;
      const planos = parseCouponPlanIds(cupom.plan_ids);
      if (planos !== null && !(plano && planos.includes(Number(plano.id)))) throw recusar(COUPON_ERRORS.planMismatch());

      // O resgate, atômico: o contador e a linha do provedor na mesma
      // transação. Perdeu a vaga (a última foi de outro, desativaram no meio,
      // venceu agora): a releitura diz qual das três. Perdeu a linha (outra
      // aplicação deste provedor resgatou no meio): é o "já usado".
      let contado = false;
      if (!jaResgatou) {
        let resgatou;
        try {
          resgatou = await getDb().transaction(async (trx) => {
            if (!(await Coupon.redeem(cupom.id, now, trx))) return false;
            await CouponRedemption.record(cupom.id, { at: aoSegundo(now) }, trx);
            return true;
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          if (!comoConsole) throw COUPON_ERRORS.alreadyUsed();
          resgatou = null;
        }
        if (resgatou === false) {
          throw recusar(motivoDeNaoResgatar(await Coupon.findById(cupom.id), now) ?? COUPON_ERRORS.exhausted());
        }
        contado = resgatou === true;
      }

      const ciclos = ciclosDe(cupom);
      const aplicadoEm = aoSegundo(now);
      const depois = { ...antes, coupon_id: cupom.id, coupon_cycles_left: ciclos, coupon_applied_at: aplicadoEm };
      const substituido = antes.coupon_id ? Number(antes.coupon_id) : null;
      let feito;
      try {
        feito = await SelfBillingService.repriceAround({
          depois,
          tenant,
          countDevices,
          escrever: async () => {
            const gravou = await getDb().transaction(async (trx) => {
              const ok = await Subscription.setCoupon(tenantId, {
                expectCouponId: antes.coupon_id ?? null, couponId: cupom.id, cyclesLeft: ciclos, appliedAt: aplicadoEm
              }, trx);
              if (!ok) return false;
              await BillingEvent.record({
                subscriptionId: antes.id,
                type: BILLING_EVENT_TYPES.COUPON_APPLIED,
                createdBy: actorUserId,
                detail: {
                  coupon: couponTrail(cupom),
                  cyclesLeft: ciclos,
                  source: doConsole ? 'console' : (daRetencao ? 'retention' : 'provider'),
                  priceCents: SubscriptionService.priceFor(depois, plano, cupom),
                  ...(substituido ? { replacedCouponId: substituido } : {})
                }
              }, trx);
              return true;
            });
            // Outra aplicação gravou entre a leitura e aqui: a dela vale.
            if (!gravou) throw COUPON_ERRORS.alreadyApplied();
          }
        });
      } catch (error) {
        // O resgate que não chegou a valer volta inteiro: a vaga e a linha.
        if (contado) {
          await getDb().transaction(async (trx) => {
            await Coupon.unredeem(cupom.id, trx);
            await CouponRedemption.remove(cupom.id, trx);
          });
        }
        throw error;
      } finally {
        SubscriptionService.cache.invalidate();
      }

      return {
        subscription: await Subscription.forTenant(tenantId),
        coupon: cupom,
        replacedCouponId: substituido,
        priceCents: SubscriptionService.priceFor(depois, plano, cupom),
        charge: feito.charge,
        ...(feito.reissue ? { reissue: feito.reissue } : {})
      };
    });
  }

  /**
   * Tira o cupom da assinatura (só o console). O resgate continua contado —
   * foi usado —, e a fatura em aberto volta ao preço sem desconto pela mesma
   * porta da aplicação.
   *
   * @returns {Promise<{ changed: boolean, subscription: object, coupon: object|null,
   *   charge: 'none'|'reissued', reissue?: object }>}
   */
  static async remove({ tenantId, actorUserId = null, countDevices = null }) {
    return runInTenant(tenantId, async () => {
      const tenant = await Tenant.findById(tenantId);
      if (!tenant || tenant.kind === 'platform') throw recusa('subscription.notChangeable', 'not_changeable');
      const antes = await Subscription.forTenant(tenantId);
      if (!antes) throw recusa('subscription.notChangeable', 'not_changeable');
      if (!antes.coupon_id) return { changed: false, subscription: antes, coupon: null, charge: 'none' };
      const cupom = await Coupon.findById(antes.coupon_id);
      const depois = { ...antes, coupon_id: null, coupon_cycles_left: null, coupon_applied_at: null };
      let feito;
      try {
        feito = await SelfBillingService.repriceAround({
          depois,
          tenant,
          countDevices,
          escrever: async () => {
            const gravou = await getDb().transaction(async (trx) => {
              const ok = await Subscription.setCoupon(tenantId, { expectCouponId: antes.coupon_id, couponId: null }, trx);
              if (!ok) return false;
              await BillingEvent.record({
                subscriptionId: antes.id,
                type: BILLING_EVENT_TYPES.COUPON_REMOVED,
                createdBy: actorUserId,
                detail: {
                  coupon: couponTrail(cupom) ?? { id: Number(antes.coupon_id) },
                  cyclesLeft: antes.coupon_cycles_left ?? null,
                  source: 'console'
                }
              }, trx);
              return true;
            });
            if (!gravou) throw new SelfBillingError('billing.busy', { code: 'busy', status: 409 });
          }
        });
      } finally {
        SubscriptionService.cache.invalidate();
      }
      return {
        changed: true,
        subscription: await Subscription.forTenant(tenantId),
        coupon: cupom,
        charge: feito.charge,
        ...(feito.reissue ? { reissue: feito.reissue } : {})
      };
    });
  }
}

export default CouponService;
