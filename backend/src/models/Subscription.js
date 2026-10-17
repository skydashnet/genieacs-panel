import { getDb, tdb, tinsert } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * A assinatura de um provedor: uma linha, uma por provedor.
 *
 * Duas portas de entrada, e a diferença entre elas é quem pergunta.
 *
 * `current()` é o provedor lendo a própria assinatura — a tela de plano e uso,
 * e o gate, que já roda dentro do escopo que o resolvedor abriu. Passa por
 * `tdb`, como tudo que é dele.
 *
 * `forTenant(id)` e `upsertForTenant(id, …)` são o plano de controle olhando
 * para um provedor de fora, e o seed, que roda antes de haver escopo. Levam o
 * provedor no argumento e filtram à mão, como `TenantInvite.findByToken`: o
 * marcador diz à guarda estática que a ausência de `tdb` é decisão, não
 * esquecimento.
 */
export const SUBSCRIPTION_STATUSES = Object.freeze([
  'trial', 'active', 'past_due', 'suspended', 'canceled'
]);

class Subscription {
  static async current() {
    return (await tdb('subscriptions').first()) || null;
  }

  static async forTenant(tenantId, db = getDb()) {
    if (!tenantId) return null;
    // tenant-scope-exempt: o provedor vem no argumento — quem chama está acima dele (console, seed, gate).
    return (await db('subscriptions').where({ tenant_id: tenantId }).first()) || null;
  }

  /**
   * Todas, com o plano ao lado: o que o console lista.
   *
   * `runUnscoped` e não só o marcador: a sentinela de SQL (`sqlSentinel.js`)
   * derruba, em teste, qualquer leitura de tabela escopada sem filtro de
   * provedor — e esta leitura não tem filtro DE PROPÓSITO, porque o console
   * está acima de todos eles. A razão fica escrita aqui, onde a sentinela a
   * lê, e não numa lista de exceções longe do sítio.
   */
  static async listWithPlans() {
    // tenant-scope-exempt: listagem do plano de controle, acima dos provedores.
    return runUnscoped('the console lists every provider\'s subscription', () => getDb()('subscriptions')
      .join('plans', 'plans.id', 'subscriptions.plan_id')
      .select(
        'subscriptions.*',
        'plans.code as plan_code',
        'plans.name as plan_name',
        'plans.max_operators',
        'plans.max_subscribers',
        'plans.max_devices',
        // O preço vem junto para a tela de Assinaturas, que mostra quanto cada
        // um paga — e uma segunda leitura de `plans` por linha seria a
        // consulta N+1 que esta junção existe para não fazer.
        'plans.price_cents as plan_price_cents',
        'plans.currency as plan_currency'
      ));
  }

  /**
   * Quantas assinaturas estão (ou vão estar, pela troca agendada) no ciclo
   * ANUAL deste plano (0104). É a pergunta do console antes de tirar o preço
   * anual de um plano: sem ele, essas assinaturas voltariam ao mensal em
   * silêncio.
   */
  static async countAnnualOnPlan(planId) {
    // tenant-scope-exempt: pergunta do plano de controle, acima dos provedores.
    const linha = await runUnscoped('the console checks every provider on an annual plan', () => getDb()('subscriptions')
      .where({ plan_id: planId, billing_cycle: 'annual' })
      .orWhere((q) => q.where({ pending_plan_id: planId })
        .whereRaw("COALESCE(pending_billing_cycle, billing_cycle) = 'annual'"))
      .count({ total: '*' })
      .first());
    return Number(linha?.total ?? 0);
  }

  /**
   * Cria ou altera a assinatura de um provedor nomeado.
   *
   * `patch` só leva colunas; quem decide o que a mudança significa (extrato,
   * trilha, cache) é o serviço. Aqui é só a linha.
   */
  static async upsertForTenant(tenantId, patch, db = getDb()) {
    const existing = await Subscription.forTenant(tenantId, db);
    if (existing) {
      // tenant-scope-exempt: o provedor vem no argumento (ver acima).
      await db('subscriptions')
        .where({ tenant_id: tenantId })
        .update({ ...patch, updated_at: new Date() });
    } else {
      // tenant-scope-exempt: idem — e o seed chama isto sem escopo nenhum aberto.
      await db('subscriptions').insert({ tenant_id: tenantId, ...patch });
    }
    return Subscription.forTenant(tenantId, db);
  }

  /**
   * Aplica a descida agendada (0074) — só se ela ainda é a que se leu.
   *
   * Condicional pelo `pending_plan_id`, e não um `upsertForTenant` cego: o
   * agendador e um pagamento podem chegar ao mesmo prazo no mesmo minuto, e
   * sem a condição os dois trocariam o plano e gravariam cada um a sua linha
   * de "plano trocado" no extrato. Quem muda a linha é quem aplicou; o outro
   * recebe `false` e não grava nada. Também não passa por cima de um
   * cancelamento ou de uma troca pelo console que entrou no meio — os dois
   * limpam a coluna, e a condição deixa de casar.
   */
  static async applyPendingPlan(tenantId, pendingPlanId, db = getDb()) {
    if (!tenantId || !pendingPlanId) return false;
    // tenant-scope-exempt: o provedor vem no argumento (ver acima).
    const changed = await db('subscriptions')
      .where({ tenant_id: tenantId, pending_plan_id: pendingPlanId })
      .update({
        plan_id: pendingPlanId,
        // O ciclo agendado junto (0104), quando há um; nulo é "o mesmo".
        billing_cycle: db.raw('COALESCE(pending_billing_cycle, billing_cycle)'),
        pending_plan_id: null,
        pending_plan_at: null,
        pending_plan_locked_at: null,
        pending_billing_cycle: null,
        // O plano novo é o de baixo: não há subida no período a proteger.
        upgraded_at: null,
        updated_at: new Date()
      });
    return changed > 0;
  }

  /**
   * Grava uma mudança do "isento de cobrança" — só se a isenção ainda está
   * como se leu (`wasExempt`) e, no fim automático (`expiredBy`), só se o
   * `billing_exempt_until` gravado já passou daquele instante.
   *
   * Condicional pelo mesmo motivo de `applyPendingPlan`: duas voltas do
   * agendador (ou o agendador e o console) podem desligar a mesma isenção no
   * mesmo minuto, e sem a condição as duas gravariam a sua linha no extrato e
   * reabririam a cobrança. Quem muda a linha é quem desligou; o outro recebe
   * `false` e não grava nada.
   */
  static async changeBillingExemptIf(tenantId, { wasExempt, expiredBy = null }, patch, db = getDb()) {
    if (!tenantId) return false;
    // tenant-scope-exempt: o provedor vem no argumento (ver acima).
    const query = db('subscriptions').where({ tenant_id: tenantId });
    if (wasExempt) query.whereNotNull('billing_exempt_at');
    else query.whereNull('billing_exempt_at');
    if (expiredBy) query.whereNotNull('billing_exempt_until').where('billing_exempt_until', '<=', expiredBy);
    const changed = await query.update({ ...patch, updated_at: new Date() });
    return changed > 0;
  }

  /**
   * A suspensão automática por inadimplência (0102) — só se a linha ainda
   * está como se leu: no estado `fromStatus` (um dos três vivos), sem
   * isenção e, quando há a coluna do prazo que venceu (`deadlineColumn`),
   * com ele ainda vencido desde `deadlineBy` ou antes.
   *
   * Condicional pelo mesmo motivo de `applyPendingPlan`: duas voltas do
   * agendador suspenderiam e auditariam duas vezes, e um pagamento que
   * empurrou o prazo no mesmo minuto seria suspenso depois de pagar. Quem
   * muda a linha é quem suspendeu; o outro recebe `false` e não grava nada.
   */
  static async suspendForNonpayment(tenantId, { fromStatus, deadlineColumn = null, deadlineBy = null }, db = getDb()) {
    if (!tenantId || !['trial', 'active', 'past_due'].includes(fromStatus)) return false;
    // tenant-scope-exempt: o provedor vem no argumento (ver acima).
    const query = db('subscriptions')
      .where({ tenant_id: tenantId, status: fromStatus })
      .whereNull('billing_exempt_at');
    if (deadlineColumn) query.whereNotNull(deadlineColumn).where(deadlineColumn, '<=', deadlineBy);
    const changed = await query.update({
      status: 'suspended',
      suspended_reason: 'auto_nonpayment',
      updated_at: new Date()
    });
    return changed > 0;
  }

  /**
   * Tira a suspensão automática por inadimplência (0102) — só se a linha
   * AGORA está suspensa por ela. Quem chama é o pagamento da pró-rata que era
   * a última dívida: a suspensão que o agendador gravou depois da leitura do
   * pagamento também sai, e a suspensão à mão nunca.
   */
  static async liftAutoSuspension(tenantId, db = getDb()) {
    if (!tenantId) return false;
    // tenant-scope-exempt: o provedor vem no argumento (ver acima).
    const changed = await db('subscriptions')
      .where({ tenant_id: tenantId, status: 'suspended', suspended_reason: 'auto_nonpayment' })
      .update({ status: 'active', suspended_reason: null, updated_at: new Date() });
    return changed > 0;
  }

  /**
   * Põe (ou tira) o cupom da assinatura — só se o cupom de agora ainda é o que
   * se leu (`expectCouponId`, nulo para "sem cupom").
   *
   * Condicional pelo mesmo motivo de `applyPendingPlan`: duas aplicações ao
   * mesmo tempo (o provedor e o console, dois cliques) leriam as duas "sem
   * cupom" e gravariam cada uma o seu — e cada uma teria consumido um resgate.
   * A segunda recebe `false` e devolve o resgate dela.
   */
  static async setCoupon(tenantId, { expectCouponId = null, couponId, cyclesLeft, appliedAt }, db = getDb()) {
    if (!tenantId) return false;
    // tenant-scope-exempt: o provedor vem no argumento (ver acima).
    let query = db('subscriptions').where({ tenant_id: tenantId });
    query = expectCouponId === null || expectCouponId === undefined
      ? query.whereNull('coupon_id')
      : query.where({ coupon_id: expectCouponId });
    const changed = await query.update({
      coupon_id: couponId ?? null,
      coupon_cycles_left: couponId ? (cyclesLeft ?? null) : null,
      coupon_applied_at: couponId ? (appliedAt ?? new Date()) : null,
      updated_at: new Date()
    });
    return changed > 0;
  }

  /**
   * Gasta um ciclo do cupom `couponId` — o pagamento que estendeu o período
   * consumiu uma fatura com desconto. No zero, o cupom sai da assinatura.
   *
   * Comparar-e-trocar pelo valor lido (`coupon_cycles_left = antes`): dois
   * pagamentos diferentes ao mesmo tempo não descontam o mesmo ciclo duas
   * vezes nem o perdem. Devolve o que gastou, ou nulo quando não havia o que
   * gastar (sem cupom, outro cupom, `forever`, zerado, ou perdeu a corrida).
   */
  static async consumeCouponCycle(tenantId, couponId, db = getDb()) {
    const linha = await Subscription.forTenant(tenantId, db);
    if (!linha || !couponId || Number(linha.coupon_id) !== Number(couponId)) return null;
    if (linha.coupon_cycles_left === null || linha.coupon_cycles_left === undefined) return null;
    const antes = Number(linha.coupon_cycles_left);
    if (!(antes > 0)) return null;
    const depois = antes - 1;
    // tenant-scope-exempt: o provedor vem no argumento (ver acima).
    const changed = await db('subscriptions')
      .where({ tenant_id: tenantId, coupon_id: couponId, coupon_cycles_left: antes })
      .update(depois > 0
        ? { coupon_cycles_left: depois, updated_at: new Date() }
        : { coupon_id: null, coupon_cycles_left: null, coupon_applied_at: null, updated_at: new Date() });
    if (!changed) return null;
    const aplicado = linha.coupon_applied_at ? new Date(linha.coupon_applied_at) : null;
    return {
      cyclesBefore: antes,
      cyclesAfter: depois,
      cleared: depois === 0,
      appliedAt: aplicado && !Number.isNaN(aplicado.getTime()) ? aplicado.toISOString() : null
    };
  }

  /**
   * Devolve o ciclo que um pagamento estornado gastou (ver
   * `consumeCouponCycle`). Três casos:
   *
   *   - o mesmo cupom continua na assinatura: um ciclo a mais;
   *   - nenhum cupom, e foi ESTE pagamento que o tirou (`cleared`): ele volta,
   *     com um ciclo e o `coupon_applied_at` de antes;
   *   - outro cupom no lugar: nada — o provedor já trocou de desconto, e
   *     devolver o velho passaria por cima do novo.
   *
   * Devolve o que fez: `{ restored, reattached?, cyclesAfter?, reason? }`.
   */
  static async restoreCouponCycle(tenantId, consumo, db = getDb()) {
    const couponId = Number(consumo?.id);
    if (!couponId) return { restored: false, reason: 'nothing_consumed' };
    const linha = await Subscription.forTenant(tenantId, db);
    if (!linha) return { restored: false, reason: 'no_subscription' };
    if (Number(linha.coupon_id) === couponId) {
      const antes = linha.coupon_cycles_left === null || linha.coupon_cycles_left === undefined
        ? null : Number(linha.coupon_cycles_left);
      if (antes === null) return { restored: false, reason: 'forever' };
      // tenant-scope-exempt: o provedor vem no argumento (ver acima).
      const changed = await db('subscriptions')
        .where({ tenant_id: tenantId, coupon_id: couponId, coupon_cycles_left: antes })
        .update({ coupon_cycles_left: antes + 1, updated_at: new Date() });
      return changed ? { restored: true, cyclesAfter: antes + 1 } : { restored: false, reason: 'raced' };
    }
    if (!linha.coupon_id && consumo.cleared) {
      const aplicado = consumo.appliedAt ? new Date(consumo.appliedAt) : new Date();
      const reaplicou = await Subscription.setCoupon(tenantId, {
        expectCouponId: null,
        couponId,
        cyclesLeft: 1,
        appliedAt: Number.isNaN(aplicado.getTime()) ? new Date() : aplicado
      }, db);
      return reaplicou ? { restored: true, reattached: true, cyclesAfter: 1 } : { restored: false, reason: 'raced' };
    }
    return { restored: false, reason: linha.coupon_id ? 'other_coupon' : 'not_cleared' };
  }

  /**
   * Uma mudança da retenção no cancelamento (0107) — a pausa, o cancelamento
   * agendado, o desfazer, e o que o agendador cumpre na data — só se a linha
   * ainda está como se leu: `condicao` recebe a consulta já filtrada pelo
   * provedor e acrescenta o resto (o estado, a coluna ainda nula ou ainda
   * vencida). Pelo mesmo motivo de `applyPendingPlan`: dois cliques, ou o
   * agendador e um clique, não gravam a mesma decisão duas vezes. Devolve se
   * mudou.
   */
  static async changeIf(tenantId, condicao, patch, db = getDb()) {
    if (!tenantId) return false;
    // tenant-scope-exempt: o provedor vem no argumento (ver acima).
    const query = db('subscriptions').where({ tenant_id: tenantId });
    if (typeof condicao === 'function') condicao(query);
    const changed = await query.update({ ...patch, updated_at: new Date() });
    return changed > 0;
  }

  /** A do provedor em escopo — o caminho que um controlador do próprio provedor usaria. */
  static async createCurrent(row) {
    await tinsert('subscriptions', row);
    return Subscription.current();
  }
}

export default Subscription;
