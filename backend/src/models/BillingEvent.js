import { tdb, tinsert } from '../config/database.js';

/**
 * O extrato da assinatura, sempre no escopo do provedor a quem pertence.
 *
 * Só `tdb`/`tinsert`, de propósito: o console, que registra pagamento de um
 * provedor que não é o seu, abre o escopo dele com `runInTenant` antes de
 * chamar aqui — o mesmo que `PlatformController.setStatus` já faz para gravar
 * na trilha do provedor suspenso. Uma linha de extrato gravada fora do escopo
 * do dono é uma linha que o dono não vê no próprio painel.
 */
export const BILLING_EVENT_TYPES = Object.freeze({
  TRIAL_STARTED: 'trial.started',
  PAYMENT_RECORDED: 'payment.recorded',
  PLAN_CHANGED: 'plan.changed',
  STATUS_CHANGED: 'status.changed',
  // O console mexeu num PRAZO — a renovação ou o fim do teste — sem que
  // dinheiro entrasse nem o estado mudasse: a cortesia de alguns dias, a data
  // corrigida à mão. Tipo próprio, e não `status.changed` com o prazo no
  // detalhe, porque a pergunta que se faz ao extrato é "por que este provedor
  // renovou sem pagar?", e ela precisa de uma linha que diga exatamente isso.
  DEADLINE_CHANGED: 'deadline.changed',
  // O dinheiro de um pagamento VOLTOU — estornado pelo console ou pelo painel
  // do gateway — e o período que ele comprou foi desfeito. A referência é a do
  // pagamento com `:refund` no fim (ver `SubscriptionService.reversePayment`):
  // o índice único `(tenant_id, external_id)` é o que faz o estorno do console
  // e o `PAYMENT_REFUNDED` que o gateway manda depois desfazerem o período UMA
  // vez só, do mesmo jeito que faz o pagamento creditar uma vez só.
  PAYMENT_REFUNDED: 'payment.refunded',
  // O console ligou ou desligou o "isento de cobrança" (ver
  // `SubscriptionService.setBillingExempt`). Sem referência externa: o índice
  // único `(tenant_id, external_id)` não colide em nulo, e ligar e desligar
  // várias vezes é o uso esperado, não uma reentrega.
  BILLING_EXEMPT_ENABLED: 'billing_exempt.enabled',
  BILLING_EXEMPT_DISABLED: 'billing_exempt.disabled',
  // A data de fim de uma isenção que continua ligada mudou (o console
  // estendeu, encurtou ou tirou a data). O fim em si é `disabled`.
  BILLING_EXEMPT_UPDATED: 'billing_exempt.updated',
  // Um cupom de desconto entrou ou saiu da assinatura (0093) — pelo provedor
  // ou pelo console. O consumo de um ciclo não tem linha própria: viaja no
  // `detail` do pagamento que o gastou (`coupon`), e a devolução no do
  // estorno (`couponRestored`).
  COUPON_APPLIED: 'coupon.applied',
  COUPON_REMOVED: 'coupon.removed',
  // A retenção no cancelamento (0107): a pausa aceita e o fim dela (pelo
  // agendador na data, ou pelo pagamento antes), e o cancelamento agendado
  // pelo próprio provedor e desfeito antes da data. O cancelamento em si,
  // quando a data chega, é `status.changed` com o motivo `self_cancel`.
  SUBSCRIPTION_PAUSED: 'subscription.paused',
  SUBSCRIPTION_RESUMED: 'subscription.resumed',
  CANCELLATION_SCHEDULED: 'cancellation.scheduled',
  CANCELLATION_REVERTED: 'cancellation.reverted'
});

class BillingEvent {
  /**
   * O evento que uma referência externa já produziu, ou null.
   *
   * É a pergunta que torna um pagamento idempotente: todo gateway reentrega
   * webhook, e a segunda entrega de `PIX-001` tem de encontrar a primeira em
   * vez de creditar outra vez. O índice único em `(tenant_id, external_id)` é
   * a última linha de defesa, para a corrida; esta leitura é a primeira, para
   * o caso comum.
   */
  static async findByExternalId(externalId, trx = null) {
    const id = externalId ? String(externalId).slice(0, 128) : null;
    if (!id) return null;
    return (await tdb('billing_events', trx).where({ external_id: id }).first()) || null;
  }

  static async record({
    subscriptionId = null, type, amountCents = null, currency = null,
    provider = 'manual', externalId = null, createdBy = null, detail = null
  }, trx = null) {
    await tinsert('billing_events', {
      subscription_id: subscriptionId,
      type,
      amount_cents: amountCents,
      currency: currency ? String(currency).toUpperCase().slice(0, 3) : null,
      provider: String(provider).slice(0, 32),
      external_id: externalId ? String(externalId).slice(0, 128) : null,
      created_by: createdBy,
      detail: detail === null || detail === undefined ? null : JSON.stringify(detail).slice(0, 4000)
    }, trx);
    return true;
  }

  /**
   * Quanto os pagamentos com estas referências de fato trouxeram — ou nulo,
   * quando o extrato não tem nenhum. O aceite da diferença
   * (`<referência>:accepted`) é gravado com zero e não entra; o estorno é
   * outro tipo de evento e também não.
   */
  static async receivedFor(externalIds) {
    const ids = [...new Set((externalIds || []).filter(Boolean).map((id) => String(id).slice(0, 128)))];
    if (!ids.length) return null;
    const linhas = await tdb('billing_events')
      .where({ type: BILLING_EVENT_TYPES.PAYMENT_RECORDED })
      .whereIn('external_id', ids)
      .select('amount_cents');
    if (!linhas.length) return null;
    return linhas.reduce((soma, linha) => soma + (Number(linha.amount_cents) || 0), 0);
  }

  /** Do mais recente para o mais antigo. */
  static async listRecent({ limit = 50 } = {}) {
    return tdb('billing_events')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
  }
}

export default BillingEvent;
