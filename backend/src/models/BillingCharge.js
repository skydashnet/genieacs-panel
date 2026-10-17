import crypto from 'node:crypto';
import { getDb, tdb, tinsertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';
import BillingInvoice from './BillingInvoice.js';
import TenantCredit from './TenantCredit.js';

/**
 * A cobrança que o painel emitiu a um provedor.
 *
 * Só por `tdb`/`tinsert`, como o extrato e a assinatura: quem chama abre o
 * escopo do provedor antes. Uma cobrança gravada fora do escopo do dono é uma
 * cobrança que o dono não vê — e, pior que no extrato, é um link de pagamento
 * pendurado no provedor errado.
 *
 * Ao contrário de `BillingEvent`, este modelo ATUALIZA. É a diferença que
 * justifica a tabela: uma cobrança tem ciclo de vida, e o extrato não tem.
 */

/**
 * O `last_error` da cobrança que o "isento de cobrança" cancelou — a marca que
 * o desligar procura para reabrir a do período atual
 * (`ChargeIssuingService.reopenExemptCanceled`). Não é erro: o console não a
 * mostra como "último erro". Cabe folgada nos 500 caracteres da coluna.
 */
export const EXEMPT_CANCEL_MARKER = 'billing_exempt: canceled by the billing exemption';

/**
 * O `last_error` da cobrança de renovação que o fluxo de cancelamento (0107)
 * cancelou — a pausa aceita, o cancelamento agendado. Como a da isenção, não
 * é erro: é a marca que o "desfazer o cancelamento" procura para devolver a
 * cobrança do período à emissão (`ChargeIssuingService.reopenRetentionCanceled`).
 */
export const RETENTION_CANCEL_MARKER = 'retention: canceled by the cancellation flow';

export const CHARGE_STATUSES = Object.freeze([
  /** Emitida, ninguém pagou ainda. É o estado em que ela nasce. */
  'pending',
  /** O webhook creditou o pagamento dela. */
  'paid',
  /** Cancelada — pelo console, ou porque o provedor saiu. */
  'canceled',
  /**
   * O gateway recusou a criação. Fica na tabela de propósito: sem esta linha,
   * "o cliente nunca recebeu a cobrança" e "ninguém tentou emitir" são o mesmo
   * silêncio, e são problemas com consertos opostos.
   */
  'failed',
  /**
   * Venceu e ninguém pagou (`PAYMENT_OVERDUE` do gateway). Continua EM ABERTO:
   * o link de pagamento vale, o aviso de vencimento o manda e a faxina de
   * períodos velhos a alcança — só o nome mudou, e é o nome que o provedor
   * precisa ler na tela para saber que está atrasado.
   */
  'overdue',
  /**
   * O dinheiro voltou para quem pagou — pelo botão de estorno do console, ou
   * no painel do gateway (`PAYMENT_REFUNDED`). Fechada: não há o que pagar
   * nela. O período que ela comprou é desfeito junto, pelos dois caminhos
   * (`SubscriptionService.reversePayment`), uma vez só.
   */
  'refunded'
]);

/**
 * Os estados em que ainda se deve dinheiro por uma cobrança. Uma lista só, e
 * não três `whereIn` escritos à mão: o `overdue` entrou depois e teria ficado
 * de fora de algum deles — e uma cobrança atrasada fora da lista de "em
 * aberto" é exatamente a que some da tela de quem precisa cobrar.
 */
export const OPEN_CHARGE_STATUSES = Object.freeze(['pending', 'failed', 'overdue']);

/**
 * Os dois tipos de cobrança (0101).
 *
 *   renewal    a de sempre: compra o período que começa em `period_end`, uma
 *              por período — a chave única é dela.
 *   proration  a avulsa da subida no meio do período pago: só a diferença
 *              proporcional ao tempo que falta (`SubscriptionService.prorationQuote`).
 *              Não compra período nenhum: paga, não move `renews_at`; vencida,
 *              deixa o provedor `past_due` (`subscriptions.proration_due_at`).
 */
export const CHARGE_KINDS = Object.freeze(['renewal', 'proration', 'overage']);

/**
 * As faturas AVULSAS — as que não compram período: a pró-rata da subida
 * (0101) e a de só excedente (0105: a fatia mensal do excedente de quem é
 * anual, e a final de quem cancela). Todas seguem o mesmo caminho: chave que
 * não é data, emissão e retentativa pela porta da pró-rata
 * (`ChargeIssuingService.emitProration`/`retryProrations`), pagamento que não
 * move `renews_at`, vencida deixa `past_due` (`proration_due_at`).
 */
export const SIDE_CHARGE_KINDS = Object.freeze(['proration', 'overage']);

/**
 * Se a linha é uma fatura AVULSA (`SIDE_CHARGE_KINDS`) — a pró-rata ou a de
 * só excedente. O nome ficou o da primeira delas: todo lugar que pergunta
 * "isto compra período?" pergunta por aqui.
 */
export const isProration = (row) => SIDE_CHARGE_KINDS.includes(row?.kind);

/** Se a linha é a fatura de só excedente (0105). */
export const isOverageCharge = (row) => row?.kind === 'overage';

/**
 * As leituras que querem "a cobrança da renovação" — a do período, a mais
 * recente em aberto, as sobras de períodos velhos — deixam a de pró-rata de
 * fora. A chave dela (`p…`) já não é data e não casa com período nenhum, mas
 * a condição fica escrita: é ela que diz a intenção, e não a coincidência.
 */
const soRenovacao = (query) => query.whereNotIn('kind', SIDE_CHARGE_KINDS);

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * `due_date` como `YYYY-MM-DD`, venha como vier.
 *
 * A coluna é `date`, e cada banco a devolve de um jeito: o SQLite, como o texto
 * gravado; o Postgres e o MySQL, como um `Date` à meia-noite LOCAL do processo.
 * Serializar esse `Date` com `toISOString` o levaria para UTC — e num servidor
 * a leste de Greenwich, o dia anterior. Os campos locais são os que o driver
 * preencheu, e são eles que se leem.
 */
function isoDateOf(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    const mes = String(valor.getMonth() + 1).padStart(2, '0');
    const dia = String(valor.getDate()).padStart(2, '0');
    return `${valor.getFullYear()}-${mes}-${dia}`;
  }
  return String(valor).slice(0, 10);
}

/**
 * O instante em que uma cobrança com vencimento `YYYY-MM-DD` passa a estar
 * vencida: o dia seguinte, à meia-noite no fuso da cobrança (o de
 * `ChargeIssuingService.BILLING_TIMEZONE`, sem horário de verão desde 2019) —
 * o boleto vale o dia inteiro do vencimento.
 */
function venceEm(dueDate) {
  const dia = isoDateOf(dueDate);
  if (!dia) return null;
  const meiaNoite = new Date(`${dia}T00:00:00-03:00`);
  if (Number.isNaN(meiaNoite.getTime())) return null;
  return new Date(meiaNoite.getTime() + DIA_MS);
}

class BillingCharge {
  /** A cobrança da renovação de um período, ou nada. É a leitura de idempotência da emissão. */
  static async forPeriod(periodEnd, trx = null) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    if (!chave) return null;
    return (await soRenovacao(tdb('billing_charges', trx).where({ period_end: chave })).first()) || null;
  }

  /** Uma cobrança pelo id da linha, dentro do provedor em escopo. */
  static async findById(id, trx = null) {
    const numero = Number(id);
    if (!Number.isInteger(numero) || numero <= 0) return null;
    return (await tdb('billing_charges', trx).where({ id: numero }).first()) || null;
  }

  /** A cobrança que o gateway nomeia, dentro do provedor em escopo. */
  static async byGatewayId(gatewayChargeId) {
    const id = String(gatewayChargeId ?? '').slice(0, 128);
    if (!id) return null;
    return (await tdb('billing_charges').where({ gateway_charge_id: id }).first()) || null;
  }

  /**
   * Grava a cobrança do período ANTES de falar com o gateway.
   *
   * Antes, e não depois, porque é a linha que impede a segunda emissão: se ela
   * só nascesse com a resposta na mão, duas passadas do agendador que se
   * cruzassem criariam duas cobranças de verdade na mão de um cliente pagante.
   * O índice único `(tenant_id, period_end)` decide a corrida; esta inserção é
   * o bilhete que a ganha.
   */
  static async open({
    subscriptionId = null, periodEnd, amountCents, currency, provider, dueDate = null, claimUntil = null,
    planId = null, couponId = null, billingType = null, pricingDetail = undefined, billingCycle = null
  }) {
    return tinsertReturningId('billing_charges', {
      // A conta do valor (0105) — ver `pricingDetailOf`.
      ...(pricingDetail !== undefined ? { pricing_detail: BillingCharge.serializePricingDetail(pricingDetail) } : {}),
      // A linha nasce JÁ garrada por quem a inseriu — ver `claim`. Sem isto,
      // entre a inserção e a chamada ao gateway, outra passada que lesse a
      // linha nova sem `gateway_charge_id` a tomaria por "falhou no meio" e
      // emitiria de novo.
      issuing_until: claimUntil,
      subscription_id: subscriptionId,
      period_end: String(periodEnd).slice(0, 10),
      amount_cents: amountCents,
      currency: String(currency || 'BRL').toUpperCase().slice(0, 3),
      provider: String(provider).slice(0, 32),
      status: 'pending',
      due_date: dueDate,
      // Com que plano e cupom este valor foi calculado (0093) — ver
      // `BILLING_CHARGE_PRICING_COLUMNS`.
      plan_id: planId ?? null,
      coupon_id: couponId ?? null,
      // E em que ciclo (0104): `monthly` ou `annual`.
      billing_cycle: billingCycle ? String(billingCycle).slice(0, 16) : null,
      // Com que meio ela vai ao gateway (0100) — `UNDEFINED` ou `CREDIT_CARD`.
      billing_type: billingType ? String(billingType).slice(0, 16) : null
    });
  }

  static async update(id, patch) {
    const changed = await tdb('billing_charges').where({ id })
      .update({ ...patch, updated_at: new Date() });
    // O crédito reservado na cobrança (0106) segue o estado dela, aqui e não
    // em cada um dos que chamam, pelo mesmo motivo da pró-rata logo abaixo:
    // paga, a reserva vira gasto; cancelada, volta ao saldo; estornada, o que
    // ela gastou volta também. Cada passo é idempotente (`TenantCredit`).
    if (changed > 0 && 'status' in patch) await BillingCharge.followCredit(id, patch.status);
    // Quem muda o estado (ou o vencimento) de uma cobrança de pró-rata muda o
    // que a assinatura diz sobre ela (`proration_due_at`). Aqui, e não em
    // cada um dos que chamam — o webhook, os gestos do console, a faxina da
    // isenção —: o que fosse esquecido num deles deixaria um provedor
    // bloqueado por uma fatura que ele já pagou.
    if (changed > 0 && ('status' in patch || 'due_date' in patch)) {
      const linha = await BillingCharge.findById(id);
      if (isProration(linha)) await BillingCharge.syncProrationDue();
    }
    return changed > 0;
  }

  /**
   * O crédito acompanha o estado novo da cobrança — ver `update`. Nunca
   * lança: a etiqueta da cobrança já foi gravada, e uma falha aqui fica no
   * log com o que alguém precisa para acertar à mão.
   */
  static async followCredit(id, status) {
    try {
      if (status === 'paid') await TenantCredit.consumeForCharge(id);
      else if (status === 'canceled') await TenantCredit.releaseForCharge(id);
      else if (status === 'refunded') await TenantCredit.restoreForCharge(id);
    } catch (error) {
      console.error(`Charge ${id} became ${status} but its reserved credit could not follow: ${error.message}`);
    }
  }

  /**
   * Quanto de crédito a linha tem reservado (0106) — o preço do plano é
   * `amount_cents` mais isto. Zero na linha sem crédito.
   */
  static creditReservedOf(linha) {
    const valor = Number(linha?.credit_reserved_cents ?? 0);
    return Number.isFinite(valor) && valor > 0 ? Math.floor(valor) : 0;
  }

  /** O preço da linha antes do crédito (0106): `amount_cents` + o reservado. */
  static baseAmountOf(linha) {
    return Number(linha?.amount_cents ?? 0) + BillingCharge.creditReservedOf(linha);
  }

  /**
   * A chave (`period_end`) da fatura de pró-rata de uma subida: `p` e nove
   * dígitos hexadecimais do hash de "de qual plano, para qual, em qual
   * período".
   *
   * Não é data, de propósito: a renovação do mesmo prazo é dona da chave do
   * período no índice único, e duas subidas no mesmo período (Básico → Médio
   * → Pro) são duas faturas — cada uma com a sua. E é DETERMINÍSTICA, para o
   * índice único ser também a trava da corrida: dois cliques "subir para o
   * Pro" que leram o mesmo plano de antes calculam a mesma chave, e o segundo
   * perde na inserção em vez de abrir a segunda fatura. O prefixo `p` fica
   * depois de todo dígito na ordem do texto, então `openBefore` (`<` uma
   * data) nunca a alcança — a faxina de períodos velhos não cancela pró-rata.
   */
  static prorationKey({ fromPlanId, toPlanId, periodEnd, seq = 0 }) {
    // `seq`: a mesma subida repetida no mesmo período depois de a primeira
    // fatura dela já ter fechado (o console voltou o plano, e o provedor subiu
    // de novo) — outra chave, para a segunda fatura não colidir com a paga.
    const base = `${fromPlanId ?? '-'}>${toPlanId}@${String(periodEnd).slice(0, 10)}${seq > 0 ? `#${seq}` : ''}`;
    return `p${crypto.createHash('sha256').update(base).digest('hex').slice(0, 9)}`;
  }

  /**
   * Abre a fatura de pró-rata de uma subida — já garrada por quem a abriu,
   * como a da renovação (`open`) — com a chave de `prorationKey`. A
   * referência que vai ao gateway (`tenant:<id>:proration:<id da linha>`) usa
   * o id da linha; o fim do período de verdade e a conta vão em
   * `proration_detail`.
   *
   * A violação do índice único sobe: quem chama a lê como "outra passada já
   * abriu esta" (`isUniqueViolation`).
   */
  static async openProration({
    key, subscriptionId = null, amountCents, currency, provider, dueDate, claimUntil = null,
    planId = null, couponId = null, detail = null, billingCycle = null, kind = 'proration', pricingDetail = undefined
  }) {
    return tinsertReturningId('billing_charges', {
      issuing_until: claimUntil,
      subscription_id: subscriptionId,
      period_end: String(key).slice(0, 10),
      kind: SIDE_CHARGE_KINDS.includes(kind) ? kind : 'proration',
      ...(pricingDetail !== undefined ? { pricing_detail: BillingCharge.serializePricingDetail(pricingDetail) } : {}),
      proration_detail: detail ? JSON.stringify(detail) : null,
      amount_cents: amountCents,
      currency: String(currency || 'BRL').toUpperCase().slice(0, 3),
      provider: String(provider).slice(0, 32),
      status: 'pending',
      due_date: dueDate,
      plan_id: planId ?? null,
      coupon_id: couponId ?? null,
      billing_cycle: billingCycle ? String(billingCycle).slice(0, 16) : null
    });
  }

  /** A fatura de pró-rata com esta chave (`prorationKey`), ou nada. */
  static async prorationByKey(key) {
    return (await tdb('billing_charges').where({ period_end: String(key).slice(0, 10), kind: 'proration' }).first())
      || null;
  }

  /**
   * A chave (`period_end`) da fatura de só excedente (0105): `o` e a data do
   * fim do período que ela fecha, sem os traços (`o20261106`) — não é data,
   * como a da pró-rata, e o `o` fica depois de todo dígito na ordem do texto
   * (`openBefore` nunca a alcança). Uma por fim de período: o índice único é
   * a trava da corrida de duas passadas.
   */
  static overageKey(periodKey, { final = false } = {}) {
    const dia = String(periodKey ?? '').slice(0, 10).replace(/-/g, '');
    return `${final ? 'f' : 'o'}${dia}`.slice(0, 10);
  }

  /** Todas as cobranças deste provedor (poucas por provedor: uma por período, e as avulsas). */
  static async allForTenant() {
    return tdb('billing_charges').orderBy('id');
  }

  /** A cobrança da renovação do período ANTERIOR a `periodEnd` (a mais recente antes dele), ou nada. */
  static async previousRenewal(periodEnd) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    if (!chave) return null;
    return (await soRenovacao(tdb('billing_charges').where('period_end', '<', chave))
      .orderBy('period_end', 'desc')
      .first()) || null;
  }

  /** As faturas de só excedente deste provedor, de qualquer estado. */
  static async overageCharges() {
    return tdb('billing_charges').where({ kind: 'overage' }).orderBy('id');
  }

  /**
   * As faturas de pró-rata deste provedor que ainda não chegaram ao gateway —
   * a criação falhou, ou o gateway nem estava configurado — e que o agendador
   * retoma (`ChargeIssuingService.retryProrations`).
   */
  static async unissuedProrations() {
    return tdb('billing_charges')
      .whereIn('kind', SIDE_CHARGE_KINDS)
      .whereIn('status', ['pending', 'failed'])
      .whereNull('gateway_charge_id')
      .orderBy('id');
  }

  /** As faturas de pró-rata deste provedor ainda em aberto. */
  static async openProrations() {
    return tdb('billing_charges')
      .whereIn('kind', SIDE_CHARGE_KINDS)
      .whereIn('status', OPEN_CHARGE_STATUSES)
      .orderBy('id');
  }

  /**
   * Regrava `subscriptions.proration_due_at` do provedor em escopo: quando
   * vence a fatura de pró-rata em aberto mais antiga — ou nulo.
   *
   * Só conta a que CHEGOU ao gateway (tem id lá): a que falhou na criação não
   * tem link de pagamento, e bloquear alguém por uma fatura que ele não tem
   * como pagar seria cobrar dele a falha do gateway. Quando a retentativa a
   * emite, a marca vem junto (`markIssued`).
   *
   * Recalcula do zero a cada vez, e não soma nem subtrai: idempotente, e
   * qualquer caminho que chame duas vezes chega ao mesmo lugar.
   */
  static async syncProrationDue() {
    const abertas = await BillingCharge.openProrations();
    let maisCedo = null;
    for (const linha of abertas) {
      if (!linha.gateway_charge_id) continue;
      const quando = venceEm(linha.due_date);
      if (quando && (!maisCedo || quando.getTime() < maisCedo.getTime())) maisCedo = quando;
    }
    await tdb('subscriptions').update({ proration_due_at: maisCedo, updated_at: new Date() });
    if (typeof BillingCharge.onProrationDueChanged === 'function') BillingCharge.onProrationDueChanged();
    return maisCedo;
  }

  /**
   * Avisado quando `proration_due_at` muda — `SubscriptionService` liga aqui
   * a limpeza do cache dele, sem que o modelo precise importar o serviço.
   */
  static onProrationDueChanged = null;

  /** A conta da pró-rata, lida de `proration_detail` — nunca lança. */
  static prorationDetailOf(linha) {
    if (!isProration(linha) || !linha.proration_detail) return null;
    try {
      const lido = JSON.parse(linha.proration_detail);
      return lido && typeof lido === 'object' ? lido : null;
    } catch {
      return null;
    }
  }

  /**
   * O fim de período de que a linha fala: a chave, na renovação; o fim do
   * período em que a subida aconteceu, na pró-rata (a chave dela não é data,
   * ver `openProration`).
   */
  static periodEndOf(linha) {
    if (!linha) return null;
    if (isProration(linha)) return BillingCharge.prorationDetailOf(linha)?.periodEnd ?? null;
    return linha.period_end ?? null;
  }

  /** O que a tela mostra da conta de uma pró-rata — nada de gateway. */
  static presentProration(linha) {
    const detalhe = BillingCharge.prorationDetailOf(linha);
    if (!detalhe) return null;
    return {
      ...(isOverageCharge(linha) ? { overage: true, slices: Array.isArray(detalhe.slices) ? detalhe.slices : [] } : {}),
      fromPlanId: detalhe.fromPlanId ?? null,
      toPlanId: detalhe.toPlanId ?? null,
      fromPriceCents: detalhe.fromPriceCents ?? null,
      toPriceCents: detalhe.toPriceCents ?? null,
      remainingDays: detalhe.remainingDays ?? null
    };
  }

  /**
   * O que o gateway devolveu quando a criação deu certo.
   *
   * Condicional: só grava numa linha que AINDA não tem id no gateway. A garra
   * (`claim`) já impede duas emissões da mesma linha; esta condição é a
   * segunda tranca, para o caso em que a garra venceu no meio de uma chamada
   * lenta e outro a tomou. Aí as duas cobranças existem no gateway e só uma
   * pode ficar na linha — a primeira a gravar. Quem chega depois recebe
   * `false` e é quem precisa cancelar a sua do lado de lá.
   *
   * Solta a garra junto: a emissão acabou.
   */
  static async markIssued(id, {
    gatewayChargeId, invoiceUrl = null, dueDate = null, discountTerms = undefined
  }) {
    const changed = await tdb('billing_charges').where({ id }).whereNull('gateway_charge_id').update({
      gateway_charge_id: String(gatewayChargeId).slice(0, 128),
      invoice_url: invoiceUrl ? String(invoiceUrl).slice(0, 512) : null,
      ...(dueDate ? { due_date: dueDate } : {}),
      // Os termos do desconto com que ela saiu (0100, `discount_terms`) —
      // quando quem emitiu os sabe. A adoção de uma cobrança achada pela
      // referência não sabe, e a linha fica com a configuração de hoje.
      ...(discountTerms !== undefined ? { discount_terms: BillingCharge.serializeDiscountTerms(discountTerms) } : {}),
      status: 'pending',
      last_error: null,
      issuing_until: null,
      updated_at: new Date()
    });
    // A pró-rata que chegou ao gateway passa a contar para o vencimento
    // (`syncProrationDue` só conta a que tem link de pagamento).
    if (changed > 0 && isProration(await BillingCharge.findById(id))) await BillingCharge.syncProrationDue();
    return changed > 0;
  }

  /**
   * Toma a linha para falar com o gateway por ela, até `until` — ou não toma.
   *
   * Um `UPDATE` condicional, e só segue quem de fato mudou a linha: é o banco
   * que decide entre duas passadas que leram a mesma coisa ao mesmo tempo, do
   * mesmo jeito que o índice único decide entre duas inserções. A garra de
   * quem morreu no meio vence sozinha (`issuing_until` no passado), e a linha
   * volta a ser de quem a pedir.
   *
   * `unissued: true` (o padrão, que é o da emissão) só toma linha sem id no
   * gateway: uma linha já emitida não tem mais o que emitir. A troca de plano
   * pede `false`, porque é justamente a linha emitida que ela vai cancelar e
   * reemitir.
   *
   * @returns {Promise<boolean>} se esta chamada ficou com a linha.
   */
  static async claim(id, {
    until, now = new Date(), unissued = true, openOnly = false, statuses = null
  } = {}) {
    let query = tdb('billing_charges').where({ id })
      .where((livre) => livre.whereNull('issuing_until').orWhere('issuing_until', '<', now));
    if (unissued) query = query.whereNull('gateway_charge_id');
    // `openOnly` é o dos gestos do console: a leitura que decidiu "está em
    // aberto" e a garra são dois comandos, e entre eles o webhook pode ter
    // quitado a linha. Na mesma condição do `UPDATE`, quem toma a garra toma
    // uma linha que AINDA está em aberto — ou não toma nada.
    if (openOnly) query = query.whereIn('status', OPEN_CHARGE_STATUSES);
    // `statuses` é a mesma trava para o gesto que quer uma linha FECHADA — o
    // estorno, que só toma a cobrança que ainda está `paid`: entre a leitura e
    // a garra, o `PAYMENT_REFUNDED` do gateway pode tê-la estornado.
    if (Array.isArray(statuses) && statuses.length) query = query.whereIn('status', statuses);
    const changed = await query.update({ issuing_until: until, updated_at: new Date() });
    return changed > 0;
  }

  /** Solta a garra, quando quem a tomou desistiu sem emitir nem falhar. */
  static async release(id) {
    return BillingCharge.update(id, { issuing_until: null });
  }

  /**
   * A tentativa falhou. `attempts` sobe e o motivo fica — e é o motivo que
   * separa "o gateway recusou o CNPJ" de "a rede caiu", que é a diferença entre
   * um chamado para o cliente e um para a infraestrutura.
   */
  static async markFailed(id, motivo, { retryAfterMs = 0 } = {}) {
    // `increment` e não ler-somar-gravar: duas passadas que se cruzassem
    // perderiam um incremento, e o teto de tentativas é justamente o que
    // impede uma cobrança recusada de ser tentada para sempre.
    const changed = await tdb('billing_charges').where({ id }).update({
      status: 'failed',
      last_error: String(motivo ?? '').slice(0, 500),
      next_attempt_at: retryAfterMs > 0 ? new Date(Date.now() + retryAfterMs) : null,
      // A tentativa acabou, mal, e a linha volta a ser de quem vier depois
      // da espera.
      issuing_until: null,
      updated_at: new Date()
    });
    await tdb('billing_charges').where({ id }).increment('attempts', 1);
    return changed > 0;
  }

  /**
   * Devolve a cobrança do período ao ponto de partida, com outro valor — para
   * ser emitida de novo.
   *
   * É o que a troca de plano feita pelo provedor faz com a cobrança em aberto
   * do período: a do gateway (se havia) já foi cancelada lá por quem chama, e
   * aqui a linha esquece tudo o que dizia respeito a ELA — o id no gateway, a
   * página de pagamento, as tentativas, o último erro — e fica com o preço
   * novo, `pending` e sem id. É o estado que a emissão reconhece como "ainda
   * não saiu", e por isso é o próximo passe dela (ou o "pagar agora") que a
   * emite, pela porta de sempre.
   *
   * A MESMA linha, e não uma nova: o índice único `(tenant_id, period_end)` é
   * o que impede duas cobranças do mesmo período, e abrir outra linha exigiria
   * apagar esta — perdendo o histórico de que houve uma cobrança antes.
   *
   * `invoice_url` vai junto porque o link antigo leva a uma cobrança apagada;
   * mostrá-lo na tela do provedor seria mandá-lo pagar o que não existe mais.
   *
   * O id velho NÃO some: vai para `superseded_charges`, com o valor que
   * aquela cobrança pedia. Cancelar no gateway não impede que alguém pague o
   * boleto velho que já estava impresso, e quando esse pagamento chegar a
   * conferência precisa saber quanto AQUELA cobrança pedia — ver
   * `bySupersededGatewayId`.
   *
   * Quem chama segura a garra da linha (`claim` com `unissued: false`); a
   * condição sobre `gateway_charge_id` é a segunda tranca: se a linha mudou
   * de id entre a leitura e aqui, alguém emitiu no meio, e reescrevê-la
   * apagaria uma cobrança viva. Devolve `false` nesse caso, e solta a garra
   * quando dá certo.
   *
   * @returns {Promise<boolean>}
   */
  static async resetForReissue(id, {
    amountCents, currency, holdUntil = null, planId = undefined, couponId = undefined, pricingDetail = undefined,
    billingCycle = undefined
  }) {
    const linha = await BillingCharge.findById(id);
    if (!linha) return false;
    const anteriores = BillingCharge.supersededOf(linha);
    if (linha.gateway_charge_id) {
      anteriores.push({
        id: String(linha.gateway_charge_id),
        amountCents: Number(linha.amount_cents),
        // O crédito que ela levava (0106): o preço do plano que ela cobrava
        // é o valor mais isto.
        ...(BillingCharge.creditReservedOf(linha) ? { creditCents: BillingCharge.creditReservedOf(linha) } : {}),
        // O plano, o cupom e o ciclo com que ela saiu (0093/0104): o
        // pagamento do boleto velho compra o período DAQUELE plano e ciclo, e
        // não o da linha reemitida — ver `recordPayment`.
        ...(linha.plan_id !== null && linha.plan_id !== undefined ? {
          planId: Number(linha.plan_id),
          couponId: linha.coupon_id === null || linha.coupon_id === undefined ? null : Number(linha.coupon_id),
          billingCycle: linha.billing_cycle ?? null
        } : {}),
        currency: String(linha.currency || 'BRL').toUpperCase(),
        at: new Date().toISOString()
      });
    }
    let query = tdb('billing_charges').where({ id });
    query = linha.gateway_charge_id
      ? query.where({ gateway_charge_id: linha.gateway_charge_id })
      : query.whereNull('gateway_charge_id');
    const changed = await query.update({
      amount_cents: amountCents,
      currency: String(currency || 'BRL').toUpperCase().slice(0, 3),
      gateway_charge_id: null,
      invoice_url: null,
      status: 'pending',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      // A garra fica com quem reprecificou quando ele pede (`holdUntil`): a
      // troca de plano ainda vai gravar o plano novo (ou a descida agendada)
      // DEPOIS daqui, e uma linha solta entre as duas escritas seria emitida
      // pelo agendador ou por um "pagar agora" com o preço que o estado velho
      // ainda diz. Quem a segura a solta logo antes de reemitir.
      issuing_until: holdUntil,
      superseded_charges: anteriores.length ? JSON.stringify(anteriores) : null,
      // O valor novo é o preço de um plano: o desconto dado à cobrança velha
      // pelo console não passa para a reemitida.
      amount_overridden_at: null,
      // O meio é decidido de novo na reemissão (0100): o cartão, se ele ainda
      // for utilizável; senão a página de Pix-ou-boleto.
      billing_type: null,
      // Os termos do desconto são os da emissão nova.
      discount_terms: null,
      // O plano e o cupom do preço novo (0093), quando quem reprecifica os
      // diz; sem eles (a reabertura da isenção, que mantém o valor), ficam.
      ...(planId !== undefined ? { plan_id: planId } : {}),
      ...(couponId !== undefined ? { coupon_id: couponId } : {}),
      // A conta do valor novo (0105), quando quem reprecifica a diz; sem ela
      // fica a que a linha tinha — o excedente congelado vai junto.
      ...(pricingDetail !== undefined ? { pricing_detail: BillingCharge.serializePricingDetail(pricingDetail) } : {}),
      ...(billingCycle !== undefined ? { billing_cycle: billingCycle } : {}),
      updated_at: new Date()
    });
    // A reserva de crédito da cobrança velha volta ao saldo (0106): a
    // reemissão reserva de novo, pelo preço de então (`issueCurrent`).
    if (changed > 0) {
      try {
        await TenantCredit.releaseForCharge(id);
      } catch (error) {
        console.error(`Charge ${id} was reset for reissue but its reserved credit could not be released: ${error.message}`);
      }
    }
    return changed > 0;
  }

  // ── A conta do valor (0105) ──────────────────────────────────────────

  /**
   * A conta do valor de uma cobrança, lida de `pricing_detail` — um objeto
   * `{ base, overage: [...], ... }`, ou nulo (linha de antes da coluna, valor
   * mudado à mão sem conta, lixo). Nunca lança.
   *
   *   - `base`: o preço do plano do período, já com o cupom — o cupom vale
   *     só sobre ele, nunca sobre o excedente;
   *   - `overage`: as parcelas do excedente do período que a renovação fecha
   *     (`[{ resource, peak, limit, unitCents, units, cents }]`), CONGELADAS
   *     na primeira vez que a linha as calculou: a reemissão (troca de plano,
   *     cupom, "Reemitir", a cancelada reaberta) reaproveita estas, e não
   *     reconta — o mesmo período nunca vira duas contas;
   *   - outras chaves (o crédito de indicação, `credit`) são de quem as grava,
   *     e `mergePricingDetail` as preserva.
   */
  static pricingDetailOf(linha) {
    const bruto = linha?.pricing_detail;
    if (!bruto) return null;
    try {
      const lido = typeof bruto === 'string' ? JSON.parse(bruto) : bruto;
      return lido && typeof lido === 'object' && !Array.isArray(lido) ? lido : null;
    } catch {
      return null;
    }
  }

  /** O JSON de `pricing_detail`, ou nulo para objeto nenhum. */
  static serializePricingDetail(detalhe) {
    if (detalhe === null || detalhe === undefined) return null;
    return JSON.stringify(detalhe);
  }

  /**
   * A conta de `linha` (ou de um objeto já lido) com as chaves de `patch` por
   * cima — as outras ficam. É a porta de quem acrescenta uma parcela sem
   * conhecer as dos outros (o excedente, o crédito). Devolve o OBJETO; quem
   * grava passa por `serializePricingDetail` (ou pelo `pricingDetail` de
   * `open`/`resetForReissue`, que serializam).
   */
  static mergePricingDetail(linhaOuDetalhe, patch = {}) {
    const atual = linhaOuDetalhe && typeof linhaOuDetalhe === 'object' && 'pricing_detail' in linhaOuDetalhe
      ? BillingCharge.pricingDetailOf(linhaOuDetalhe)
      : (linhaOuDetalhe && typeof linhaOuDetalhe === 'object' ? linhaOuDetalhe : null);
    return { ...(atual ?? {}), ...(patch ?? {}) };
  }

  /**
   * As parcelas de excedente congeladas na linha — ou nulo quando a linha
   * nunca as calculou (aí quem emite calcula, e congela).
   */
  static frozenOverageOf(linha) {
    const detalhe = BillingCharge.pricingDetailOf(linha);
    if (!detalhe || !Array.isArray(detalhe.overage)) return null;
    return detalhe.overage
      .filter((item) => item && Number.isInteger(Number(item.cents)) && Number(item.cents) > 0)
      .map((item) => ({
        resource: String(item.resource),
        peak: Number(item.peak),
        limit: Number(item.limit),
        unitCents: Number(item.unitCents),
        units: Number(item.units ?? (Number(item.peak) - Number(item.limit))),
        cents: Number(item.cents),
        // De que período (a chave dos picos) a parcela é, e se é o acerto
        // (`true_up`) de um período que uma fatura anterior congelou cedo.
        ...(item.periodKey ? { periodKey: String(item.periodKey).slice(0, 10) } : {}),
        ...(item.kind ? { kind: String(item.kind) } : {})
      }));
  }

  /** O total do excedente congelado na linha, em centavos (zero sem nenhum). */
  static overageCentsOf(linha) {
    return (BillingCharge.frozenOverageOf(linha) ?? []).reduce((soma, item) => soma + item.cents, 0);
  }

  /**
   * A conta como as telas a mostram — o provedor e o console: o preço do
   * plano, as parcelas do excedente e o resto que a conta tiver (o crédito).
   * Nulo quando a linha não tem conta.
   */
  static presentPricing(linha) {
    const detalhe = BillingCharge.pricingDetailOf(linha);
    if (!detalhe) return null;
    const base = Number(detalhe.base);
    const credit = detalhe.credit && typeof detalhe.credit === 'object'
      ? Number(detalhe.credit.cents ?? detalhe.credit.amountCents ?? 0)
      : Number(detalhe.credit ?? 0);
    return {
      baseCents: Number.isFinite(base) ? base : null,
      overage: (BillingCharge.frozenOverageOf(linha) ?? []).map((item) => ({
        resource: item.resource,
        peak: item.peak,
        limit: item.limit,
        units: item.units,
        unitCents: item.unitCents,
        cents: item.cents,
        ...(item.periodKey ? { periodKey: item.periodKey } : {}),
        ...(item.kind ? { kind: item.kind } : {})
      })),
      overageCents: BillingCharge.overageCentsOf(linha),
      creditCents: Number.isFinite(credit) && credit > 0 ? credit : 0
    };
  }

  /**
   * Os termos do desconto por antecipação gravados na linha (0100,
   * `discount_terms`): `{ discount: {...} | null }` quando a emissão os
   * gravou, ou nulo — a linha de antes da coluna, ou adotada sem eles — e aí
   * quem confere usa a configuração de hoje. Nunca lança.
   */
  static discountTermsOf(linha) {
    if (!linha?.discount_terms) return null;
    try {
      const lido = JSON.parse(linha.discount_terms);
      if (!lido || typeof lido !== 'object' || !('discount' in lido)) return null;
      const d = lido.discount;
      if (d === null) return { discount: null };
      if (!d || typeof d !== 'object') return null;
      const cents = Number(d.cents);
      const daysBefore = Number(d.daysBefore);
      if (!Number.isInteger(cents) || cents <= 0 || !Number.isInteger(daysBefore) || daysBefore < 0) return null;
      return {
        discount: {
          cents, kind: d.kind === 'percent' ? 'percent' : 'fixed', percent: d.percent ?? null, daysBefore
        }
      };
    } catch {
      return null;
    }
  }

  /** O JSON de `discount_terms` a partir do que o cliente do gateway devolveu. */
  static serializeDiscountTerms(terms) {
    if (terms === null || terms === undefined) return null;
    const d = terms.discount ?? null;
    return JSON.stringify({
      discount: d ? {
        cents: Number(d.cents), kind: d.kind, percent: d.percent ?? null, daysBefore: Number(d.daysBefore)
      } : null
    });
  }

  /**
   * Cancela as faturas de pró-rata deste provedor que ainda NÃO chegaram ao
   * gateway (sem id lá, sem garra viva): a assinatura deixou de ser cobrável
   * (cancelada, suspensa à mão), e a retentativa do agendador não pode levá-la
   * ao gateway depois. A que está nas mãos de uma emissão agora é relida por
   * ela logo antes de falar com o gateway (`emitProration`).
   *
   * @returns {Promise<number>} quantas foram canceladas.
   */
  static async cancelUnissuedProrations({ reason = 'not_billable', now = new Date() } = {}) {
    const changed = await tdb('billing_charges')
      .where({ kind: 'proration' })
      .whereIn('status', ['pending', 'failed'])
      .whereNull('gateway_charge_id')
      // A de cartão pode existir no gateway com a resposta perdida: quem a
      // fecha é `emitProration`, depois de perguntar pela referência.
      .where((meio) => meio.whereNull('billing_type').orWhere('billing_type', '!=', 'CREDIT_CARD'))
      .where((livre) => livre.whereNull('issuing_until').orWhere('issuing_until', '<', now))
      .update({
        status: 'canceled',
        issuing_until: null,
        next_attempt_at: null,
        last_error: String(reason).slice(0, 500),
        updated_at: new Date()
      });
    if (changed > 0) await BillingCharge.syncProrationDue();
    return changed;
  }

  /** As cobranças que esta linha já foi, lidas da coluna — nunca lança. */
  static supersededOf(linha) {
    if (!linha?.superseded_charges) return [];
    try {
      const lista = JSON.parse(linha.superseded_charges);
      return Array.isArray(lista) ? lista.filter((item) => item && item.id) : [];
    } catch {
      return [];
    }
  }

  /**
   * A linha que JÁ FOI a cobrança que o gateway nomeia, e o que ela pedia.
   *
   * Só é perguntada quando `byGatewayId` não achou nada: o id é de uma
   * cobrança que a troca de plano cancelou e substituiu. A busca é um `LIKE`
   * sobre o JSON (com `!` como escape, que os três bancos aceitam do mesmo
   * jeito), e a confirmação é pelo JSON lido — o `LIKE` só estreita, quem
   * decide é a igualdade exata do id.
   *
   * @returns {Promise<{ row: object, superseded: { id: string, amountCents: number,
   *   currency: string } } | null>}
   */
  static async bySupersededGatewayId(gatewayChargeId) {
    const id = String(gatewayChargeId ?? '').slice(0, 128);
    if (!id) return null;
    const escapado = JSON.stringify(id).replace(/[!%_]/g, (c) => `!${c}`);
    const linhas = await tdb('billing_charges')
      .whereNotNull('superseded_charges')
      .whereRaw("superseded_charges LIKE ? ESCAPE '!'", [`%${escapado}%`])
      .limit(5);
    for (const linha of linhas) {
      const achada = BillingCharge.supersededOf(linha).find((item) => String(item.id) === id);
      if (achada) return { row: linha, superseded: achada };
    }
    return null;
  }

  /** As cobranças ainda em aberto de períodos anteriores a este. */
  static async openBefore(periodEnd) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    if (!chave) return [];
    return soRenovacao(tdb('billing_charges')
      .whereIn('status', OPEN_CHARGE_STATUSES)
      .where('period_end', '<', chave))
      .orderBy('period_end');
  }

  /**
   * Todas as cobranças em aberto deste provedor, de qualquer período — o que
   * o "isento de cobrança" cancela ao ser ligado.
   */
  static async openAll() {
    return tdb('billing_charges')
      .whereIn('status', OPEN_CHARGE_STATUSES)
      .orderBy('period_end')
      .orderBy('id');
  }

  /**
   * A cobrança da RENOVAÇÃO em aberto mais recente deste provedor — a que o
   * aviso linka. A de pró-rata fica de fora: o lembrete de vencimento fala do
   * período, e a avulsa da subida tem a linha dela na tela.
   */
  static async currentOpen() {
    return (await soRenovacao(tdb('billing_charges')
      .whereIn('status', OPEN_CHARGE_STATUSES))
      .orderBy('period_end', 'desc')
      .first()) || null;
  }

  static async listRecent({ limit = 50 } = {}) {
    const teto = Math.min(200, Math.max(1, Number(limit) || 50));
    return tdb('billing_charges').orderBy('id', 'desc').limit(teto);
  }

  /**
   * As cobranças em aberto de TODOS os provedores, numa consulta só — o que a
   * tela de Assinaturas do console soma e mostra ao lado de cada provedor.
   *
   * `runUnscoped` e o marcador pelo mesmo motivo de
   * `Subscription.listWithPlans`: a leitura não tem filtro de provedor DE
   * PROPÓSITO, porque quem pergunta está acima de todos eles, e a sentinela de
   * SQL derrubaria a consulta crua sem a razão escrita. Uma consulta, e não uma
   * por provedor: com cinquenta clientes, cinquenta `runInTenant` seriam a
   * tela mais lenta do console para responder a pergunta mais simples dele.
   *
   * O índice `(tenant_id, status)` não serve a um `WHERE status IN (...)` sem
   * provedor, e não precisa: em aberto há no máximo uma ou duas por provedor.
   */
  static async openAcrossTenants() {
    // tenant-scope-exempt: listagem do plano de controle, acima dos provedores.
    // A renovação antes da pró-rata (`renewal` > `proration` na ordem do
    // texto): a tela mostra a primeira de cada provedor, e a chave da
    // pró-rata (`p…`) passaria à frente de qualquer data.
    return runUnscoped('the console sums every provider\'s open charges', () => getDb()('billing_charges')
      .whereIn('status', OPEN_CHARGE_STATUSES)
      .orderBy('kind', 'desc')
      .orderBy('period_end', 'desc')
      .orderBy('id', 'desc'));
  }

  /**
   * Uma cobrança como o CONSOLE a vê: tudo o que `present` esconde do provedor.
   *
   * O id no gateway (é por ele que alguém acha a cobrança no painel da Asaas),
   * as tentativas e o último erro (é o que diz por que ela não saiu) e as
   * cobranças que esta linha JÁ FOI — a troca de plano cancela no gateway e
   * reemite, e o boleto velho ainda pode ser pago: quem olha a linha precisa
   * saber que existe um id antigo que também quita este período.
   *
   * O link de pagamento vai cru, de qualquer estado: quem opera o console abre
   * a página do gateway de uma cobrança paga para conferir o recibo, que é
   * exatamente o que a tela do provedor não deve convidar a fazer.
   */
  static presentForConsole(row, invoiceRow = null) {
    if (!row) return null;
    return {
      id: row.id,
      periodEnd: BillingCharge.periodEndOf(row),
      // `renewal` ou `proration` (0101) — o selo "Pró-rata" da tela.
      kind: row.kind || 'renewal',
      proration: BillingCharge.presentProration(row),
      // A conta do valor (0105): preço do plano e excedente.
      pricing: BillingCharge.presentPricing(row),
      amountCents: Number(row.amount_cents),
      // O crédito abatido nela (0106) — o preço do plano é a soma dos dois.
      creditCents: BillingCharge.creditReservedOf(row),
      currency: row.currency,
      status: row.status,
      dueDate: isoDateOf(row.due_date),
      invoiceUrl: row.invoice_url ?? null,
      provider: row.provider ?? null,
      // `CREDIT_CARD` quando saiu no cartão salvo (0100); nulo/`UNDEFINED`, a página.
      billingType: row.billing_type ?? null,
      gatewayChargeId: row.gateway_charge_id ?? null,
      attempts: Number(row.attempts ?? 0),
      // Quando o console mudou o valor à mão — nulo quando o valor é o preço
      // de um plano. A emissão não reprecifica uma cobrança marcada assim.
      amountOverriddenAt: row.amount_overridden_at ?? null,
      // A marca da isenção não é erro de ninguém (ver `EXEMPT_CANCEL_MARKER`).
      lastError: row.last_error && row.last_error !== EXEMPT_CANCEL_MARKER && row.last_error !== RETENTION_CANCEL_MARKER
        ? row.last_error : null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      superseded: BillingCharge.supersededOf(row).map((item) => ({
        gatewayChargeId: String(item.id),
        amountCents: Number(item.amountCents)
      })),
      // A NFS-e desta cobrança, quando há — lida por quem chama (`forCharges`).
      invoice: BillingInvoice.presentForConsole(invoiceRow)
    };
  }

  /**
   * Uma cobrança como o PROVEDOR pode vê-la.
   *
   * A lista de colunas é curta de propósito, e o que ficou de fora é a parte
   * interessante: `gateway_charge_id` (o id dela na Asaas, que é correlação
   * nossa com o gateway e não endereço de pagamento), `attempts` e
   * `next_attempt_at` (o backoff da emissão, que é mecânica nossa) e
   * `last_error` — texto cru que o gateway devolveu, o único aqui que pode
   * carregar detalhe da NOSSA conta na Asaas para dentro da tela de um cliente.
   *
   * O que sobra é o que o provedor precisa para pagar e para conferir o que
   * pagou: de que período é, quanto, até quando, em que pé está, e onde se
   * paga.
   */
  static present(row, invoiceRow = null) {
    if (!row) return null;
    return {
      id: row.id,
      periodEnd: BillingCharge.periodEndOf(row),
      kind: row.kind || 'renewal',
      proration: BillingCharge.presentProration(row),
      // A conta do valor (0105): preço do plano e excedente.
      pricing: BillingCharge.presentPricing(row),
      amountCents: Number(row.amount_cents),
      creditCents: BillingCharge.creditReservedOf(row),
      currency: row.currency,
      status: row.status,
      dueDate: row.due_date ?? null,
      // Só de cobrança que ainda se paga. Um link de cobrança já quitada é um
      // botão que leva a uma página do gateway dizendo que não há o que pagar —
      // e, pior, convida a pagar de novo.
      invoiceUrl: OPEN_CHARGE_STATUSES.includes(row.status) ? (row.invoice_url ?? null) : null,
      // Se ela é cobrada sozinha no cartão salvo (0100) — o meio, nunca o cartão.
      billingType: row.billing_type ?? null,
      // O ciclo que ela paga (0104) — nulo nas de antes, que são mensais.
      billingCycle: row.billing_cycle ?? null,
      createdAt: row.created_at ?? null,
      // A nota fiscal (NFS-e) desta cobrança: estado, número e PDF — sem o erro.
      invoice: BillingInvoice.present(invoiceRow)
    };
  }
}

export default BillingCharge;
export { BillingCharge, isoDateOf, venceEm as prorationOverdueAt };
