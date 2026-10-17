import { getDb, tdb, tinsertReturningId } from '../config/database.js';

/**
 * O saldo de créditos de um provedor e o que dele foi para cada cobrança
 * (0106) — `tenant_credits` e `credit_allocations`, as duas escopadas.
 *
 * Só por `tdb`/`tinsert`, como a cobrança: quem chama abre o escopo do
 * provedor antes, e é ele que garante que o crédito de um nunca abate a fatura
 * do outro. A recompensa de uma indicação é gravada no escopo de QUEM INDICOU
 * (`ReferralService`, com `runInTenant` explícito) mesmo acontecendo durante o
 * pagamento do indicado.
 *
 * ## O ciclo de um centavo de crédito
 *
 *   livre (`remaining_cents`) ──reserva──▶ `reserved` na cobrança emitida
 *   `reserved` ──a cobrança foi paga──▶ `consumed` (gasto, não volta)
 *   `reserved` ──cancelada / reemitida──▶ `released` (volta a `remaining_cents`)
 *   `consumed` ──a cobrança foi estornada──▶ `released` (volta também)
 *
 * Cada passo é uma atualização CONDICIONAL sobre o estado de partida, e só
 * quem mudou a linha mexe no saldo: o webhook reentregue, o botão do console e
 * o agendador que chegam ao mesmo passo ao mesmo tempo movem o dinheiro uma
 * vez só. E o crédito CANCELADO (`canceled_at`) não recebe nada de volta: o
 * estorno que o cancelou já levou o dinheiro que ele representava.
 */

/** O preço mínimo de uma fatura com crédito — o mesmo piso do cupom (R$ 5,00). */
export const CREDIT_FLOOR_CENTS = 500;

/** As fontes de um crédito. */
export const CREDIT_SOURCES = Object.freeze(['referral', 'manual']);

/** Os estados de uma alocação. */
export const ALLOCATION_STATUSES = Object.freeze(['reserved', 'consumed', 'released']);

/** Roda `fn` na transação dada, ou numa nova. */
function naTransacao(trx, fn) {
  return trx ? fn(trx) : getDb().transaction(fn);
}

/** Um inteiro de centavos, ou zero. */
function centavos(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

class TenantCredit {
  /** O saldo livre: a soma do que resta dos créditos não cancelados. */
  static async balance(trx = null) {
    const [linha] = await tdb('tenant_credits', trx)
      .whereNull('canceled_at')
      .where('remaining_cents', '>', 0)
      .sum({ total: 'remaining_cents' });
    return centavos(linha?.total);
  }

  /** O que está reservado agora em cobranças em aberto. */
  static async reservedTotal(trx = null) {
    const [linha] = await tdb('credit_allocations', trx).where({ status: 'reserved' }).sum({ total: 'amount_cents' });
    return centavos(linha?.total);
  }

  static async findById(id, trx = null) {
    const numero = Number(id);
    if (!Number.isInteger(numero) || numero <= 0) return null;
    return (await tdb('tenant_credits', trx).where({ id: numero }).first()) || null;
  }

  /** Os créditos do provedor, do mais novo ao mais velho. */
  static async list({ limit = 100 } = {}, trx = null) {
    const teto = Math.min(500, Math.max(1, Number(limit) || 100));
    return tdb('tenant_credits', trx).orderBy('id', 'desc').limit(teto);
  }

  /** As alocações do provedor, das mais novas às mais velhas. */
  static async allocations({ limit = 100 } = {}, trx = null) {
    const teto = Math.min(500, Math.max(1, Number(limit) || 100));
    return tdb('credit_allocations', trx).orderBy('id', 'desc').limit(teto);
  }

  /** As alocações de uma cobrança. */
  static async allocationsFor(chargeId, trx = null) {
    return tdb('credit_allocations', trx).where({ charge_id: Number(chargeId) }).orderBy('id');
  }

  /**
   * Grava um crédito novo no provedor em escopo. `remainingCents` padrão é o
   * próprio valor (o crédito nasce todo livre); o débito manual nasce com
   * zero.
   */
  static async add({
    amountCents, source, reference = null, createdBy = null, remainingCents = undefined, at = new Date()
  }, trx = null) {
    const valor = centavos(amountCents);
    if (!CREDIT_SOURCES.includes(source)) throw new Error(`Unknown credit source ${source}`);
    return tinsertReturningId('tenant_credits', {
      amount_cents: valor,
      remaining_cents: remainingCents === undefined ? Math.max(0, valor) : Math.max(0, centavos(remainingCents)),
      source,
      reference: reference ? String(reference).slice(0, 255) : null,
      created_by: createdBy ?? null,
      created_at: at
    }, trx);
  }

  /**
   * Tira `cents` do saldo livre, dos créditos mais velhos para os mais novos —
   * o débito manual do console. Devolve quanto saiu de fato (pode ser menos,
   * se outra escrita gastou no meio). Na transação de quem chama.
   */
  static async debit(cents, trx) {
    let falta = centavos(cents);
    if (falta <= 0) return 0;
    const livres = await tdb('tenant_credits', trx)
      .whereNull('canceled_at').where('remaining_cents', '>', 0).orderBy('id');
    let tirado = 0;
    for (const credito of livres) {
      if (falta <= 0) break;
      const parte = Math.min(falta, centavos(credito.remaining_cents));
      // eslint-disable-next-line no-await-in-loop -- poucos créditos por provedor
      const mudou = await tdb('tenant_credits', trx).where({ id: credito.id })
        .whereNull('canceled_at').where('remaining_cents', '>=', parte)
        .decrement('remaining_cents', parte);
      if (mudou > 0) {
        tirado += parte;
        falta -= parte;
      }
    }
    return tirado;
  }

  /**
   * Devolve a um crédito o que uma alocação levou — só se ele não foi
   * cancelado (ver o cabeçalho).
   */
  static async #devolver(creditId, cents, trx) {
    if (cents <= 0) return false;
    const mudou = await tdb('tenant_credits', trx).where({ id: creditId }).whereNull('canceled_at')
      .increment('remaining_cents', cents);
    return mudou > 0;
  }

  /**
   * Leva as alocações da cobrança de `de` para `released`, devolvendo o valor
   * a cada crédito. Só as que esta chamada mudou devolvem — a condição sobre
   * `status` é a trava. Devolve quanto voltou ao saldo.
   */
  static async #soltar(chargeId, de, trx) {
    const linhas = await tdb('credit_allocations', trx).where({ charge_id: Number(chargeId), status: de });
    let devolvido = 0;
    for (const linha of linhas) {
      // eslint-disable-next-line no-await-in-loop -- uma ou duas por cobrança
      const mudou = await tdb('credit_allocations', trx).where({ id: linha.id, status: de })
        .update({ status: 'released', updated_at: new Date() });
      if (!mudou) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await TenantCredit.#devolver(linha.credit_id, centavos(linha.amount_cents), trx)) {
        devolvido += centavos(linha.amount_cents);
      }
    }
    return devolvido;
  }

  /**
   * A reserva da cobrança volta ao saldo: ela foi cancelada, ou vai ser
   * reemitida (e a reemissão reserva de novo, pelo preço de então). Zera
   * `credit_reserved_cents` da linha. Idempotente.
   */
  static async releaseForCharge(chargeId, trx = null) {
    return naTransacao(trx, async (t) => {
      const devolvido = await TenantCredit.#soltar(chargeId, 'reserved', t);
      const restantes = await tdb('credit_allocations', t)
        .where({ charge_id: Number(chargeId) }).whereIn('status', ['reserved', 'consumed']).first();
      if (!restantes) {
        await tdb('billing_charges', t).where({ id: Number(chargeId) })
          .whereNotNull('credit_reserved_cents').update({ credit_reserved_cents: null });
      }
      return devolvido;
    });
  }

  /** A cobrança foi paga: o reservado nela passa a gasto. Idempotente. */
  static async consumeForCharge(chargeId, trx = null) {
    return naTransacao(trx, async (t) => {
      const linhas = await tdb('credit_allocations', t).where({ charge_id: Number(chargeId), status: 'reserved' });
      let gasto = 0;
      for (const linha of linhas) {
        // eslint-disable-next-line no-await-in-loop
        const mudou = await tdb('credit_allocations', t).where({ id: linha.id, status: 'reserved' })
          .update({ status: 'consumed', updated_at: new Date() });
        if (mudou) gasto += centavos(linha.amount_cents);
      }
      return gasto;
    });
  }

  /**
   * A cobrança paga foi ESTORNADA: o crédito que ela gastou volta ao saldo
   * (e o que ainda estivesse reservado nela também). Idempotente.
   */
  static async restoreForCharge(chargeId, trx = null) {
    return naTransacao(trx, async (t) => {
      const consumido = await TenantCredit.#soltar(chargeId, 'consumed', t);
      const reservado = await TenantCredit.#soltar(chargeId, 'reserved', t);
      return consumido + reservado;
    });
  }

  /**
   * Reserva crédito para a cobrança `chargeId`, cujo preço sem crédito é
   * `baseCents`: solta o que ela já tinha reservado (o preço pode ter mudado
   * desde a tentativa anterior), tira do saldo até `baseCents − piso`, dos
   * créditos mais velhos para os mais novos, e grava na linha o valor que vai
   * ao gateway (`amount_cents`) e o reservado (`credit_reserved_cents`). Tudo
   * numa transação: ou a linha diz o preço com o desconto E o saldo foi
   * tirado, ou nada mudou.
   *
   * @returns {Promise<{ amountCents: number, reservedCents: number }>}
   */
  static async reserveForCharge(chargeId, baseCents, { floorCents = CREDIT_FLOOR_CENTS } = {}) {
    const base = centavos(baseCents);
    return getDb().transaction(async (t) => {
      await TenantCredit.#soltar(chargeId, 'reserved', t);
      let falta = Math.max(0, base - floorCents);
      let reservado = 0;
      if (falta > 0) {
        const livres = await tdb('tenant_credits', t)
          .whereNull('canceled_at').where('remaining_cents', '>', 0).orderBy('id');
        for (const credito of livres) {
          if (falta <= 0) break;
          const parte = Math.min(falta, centavos(credito.remaining_cents));
          if (parte <= 0) continue;
          // eslint-disable-next-line no-await-in-loop -- poucos créditos por provedor
          const mudou = await tdb('tenant_credits', t).where({ id: credito.id })
            .whereNull('canceled_at').where('remaining_cents', '>=', parte)
            .decrement('remaining_cents', parte);
          if (!mudou) continue;
          // eslint-disable-next-line no-await-in-loop
          await tinsertReturningId('credit_allocations', {
            credit_id: credito.id,
            charge_id: Number(chargeId),
            amount_cents: parte,
            status: 'reserved',
            created_at: new Date(),
            updated_at: new Date()
          }, t);
          reservado += parte;
          falta -= parte;
        }
      }
      const valor = base - reservado;
      await tdb('billing_charges', t).where({ id: Number(chargeId) }).update({
        amount_cents: valor,
        credit_reserved_cents: reservado > 0 ? reservado : null,
        updated_at: new Date()
      });
      return { amountCents: valor, reservedCents: reservado };
    });
  }

  /**
   * Cancela o que resta de um crédito — o estorno do pagamento que o gerou.
   * O que já foi reservado ou gasto fica onde está (e a reserva solta depois
   * não volta a ele). Devolve quanto foi cancelado. Na transação de quem chama.
   */
  static async cancel(creditId, trx, { at = new Date() } = {}) {
    const credito = await TenantCredit.findById(creditId, trx);
    if (!credito || credito.canceled_at) return 0;
    const mudou = await tdb('tenant_credits', trx).where({ id: credito.id }).whereNull('canceled_at')
      .update({ canceled_at: at, remaining_cents: 0 });
    return mudou ? centavos(credito.remaining_cents) : 0;
  }

  /** Um crédito como as telas o veem. */
  static present(row) {
    if (!row) return null;
    return {
      id: row.id,
      amountCents: centavos(row.amount_cents),
      remainingCents: centavos(row.remaining_cents),
      source: row.source,
      reference: row.reference ?? null,
      canceled: Boolean(row.canceled_at),
      canceledAt: row.canceled_at ?? null,
      createdAt: row.created_at ?? null
    };
  }

  /** Uma alocação como o console a vê. */
  static presentAllocation(row) {
    if (!row) return null;
    return {
      id: row.id,
      creditId: row.credit_id,
      chargeId: row.charge_id,
      amountCents: centavos(row.amount_cents),
      status: row.status,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null
    };
  }
}

export default TenantCredit;
