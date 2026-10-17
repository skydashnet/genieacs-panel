import { tdb, tinsert, isUniqueViolation } from '../config/database.js';

/** Os recursos que têm teto no plano, e portanto pico — na ordem da tela. */
export const USAGE_RESOURCES = Object.freeze(['operators', 'subscribers', 'devices']);

/**
 * O maior uso de cada recurso em cada período (0105), que a cobrança por
 * excedente lê na renovação.
 *
 * Só por `tdb`/`tinsert`: quem chama abre o escopo do provedor antes, como em
 * `BillingCharge`.
 *
 * O pico só SOBE. Gravar é "o maior entre o guardado e o de agora", e a
 * escrita é condicional (`peak < novo`), não uma leitura seguida de escrita:
 * duas passadas que se cruzem nunca trocam um pico maior por um menor.
 */
class UsagePeak {
  /**
   * Registra `value` como uso de `resource` no período `periodEnd`, se for
   * maior que o guardado. Devolve o pico que fica.
   */
  static async record(periodEnd, resource, value, snapshot = null) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    const valor = Math.floor(Number(value));
    if (!chave || !USAGE_RESOURCES.includes(resource) || !Number.isFinite(valor) || valor < 0) return null;
    const onde = { period_end: chave, resource };
    if (snapshot) await UsagePeak.recordSnapshot(chave, resource, valor, snapshot);
    const subiu = await tdb('usage_peaks').where(onde).where('peak', '<', valor)
      .update({ peak: valor, updated_at: new Date() });
    if (subiu > 0) return valor;
    const existente = await tdb('usage_peaks').where(onde).first();
    if (existente) return Number(existente.peak);
    try {
      await tinsert('usage_peaks', { ...onde, peak: valor, updated_at: new Date() });
      return valor;
    } catch (error) {
      // Outra passada inseriu no meio: o índice único decidiu, e a escrita
      // condicional de cima, repetida, leva o pico ao maior dos dois.
      if (!isUniqueViolation(error)) throw error;
      await tdb('usage_peaks').where(onde).where('peak', '<', valor)
        .update({ peak: valor, updated_at: new Date() });
      const agora = await tdb('usage_peaks').where(onde).first();
      return agora ? Number(agora.peak) : valor;
    }
  }

  /** O excedente que uma fotografia deve, em centavos: `max(0, uso − teto) × preço`. */
  static owedOf(uso, limite, unidade) {
    const u = Number(uso);
    const l = Number(limite);
    const p = Number(unidade);
    if (![u, l, p].every(Number.isFinite)) return 0;
    return Math.max(0, Math.floor(u) - Math.floor(l)) * Math.floor(p);
  }

  /**
   * A fotografia do plano em vigor (0105): o teto e o preço por unidade de
   * agora, com o uso de agora. Fica a fotografia que DEVE MAIS — o máximo,
   * ao longo do período, de `(uso − teto) × preço` medido com o plano de cada
   * instante. Subir de plano (teto maior) antes da fatura não troca uma
   * fotografia que devia por uma que não deve; descer (teto menor) passa a
   * dever mais, e troca.
   *
   * Condicional como o pico, e sem lançar: duas passadas que se cruzem ficam
   * com a que deve mais.
   */
  static async recordSnapshot(periodEnd, resource, value, { limit, unitCents }) {
    const lim = Math.floor(Number(limit));
    const unit = Math.floor(Number(unitCents));
    if (!Number.isFinite(lim) || lim < 0 || !Number.isFinite(unit) || unit <= 0) return;
    const onde = { period_end: periodEnd, resource };
    const deve = UsagePeak.owedOf(value, lim, unit);
    const foto = { limit_value: lim, unit_cents: unit, overage_peak: value };
    const existente = await tdb('usage_peaks').where(onde).first();
    if (!existente) {
      try {
        await tinsert('usage_peaks', { ...onde, peak: value, ...foto, updated_at: new Date() });
        return;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    const atual = existente ?? await tdb('usage_peaks').where(onde).first();
    if (!atual) return;
    const semFoto = atual.unit_cents === null || atual.unit_cents === undefined
      || atual.limit_value === null || atual.limit_value === undefined;
    const deviaAntes = semFoto ? -1 : UsagePeak.owedOf(atual.overage_peak ?? atual.peak, atual.limit_value, atual.unit_cents);
    if (deve > deviaAntes) {
      // Comparar-e-trocar pela fotografia lida: outra passada que gravou no
      // meio uma que deve mais não é desfeita.
      await tdb('usage_peaks').where(onde)
        .where((q) => (semFoto ? q.whereNull('unit_cents') : q.where({
          unit_cents: atual.unit_cents, limit_value: atual.limit_value, overage_peak: atual.overage_peak
        })))
        .update({ ...foto, updated_at: new Date() });
    }
  }

  /**
   * As linhas do período por recurso — `{ peak, limit, unitCents, overagePeak }`,
   * com `limit`/`unitCents` nulos na linha sem fotografia — ou nulo onde não há.
   */
  static async rowsForPeriod(periodEnd) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    const linhas = { operators: null, subscribers: null, devices: null };
    if (!chave) return linhas;
    for (const linha of await tdb('usage_peaks').where({ period_end: chave })) {
      if (!USAGE_RESOURCES.includes(linha.resource)) continue;
      const num = (v) => (v === null || v === undefined ? null : Number(v));
      linhas[linha.resource] = {
        peak: Number(linha.peak),
        limit: num(linha.limit_value),
        unitCents: num(linha.unit_cents),
        overagePeak: num(linha.overage_peak)
      };
    }
    return linhas;
  }

  /** Os picos do período, como `{ operators, subscribers, devices }` — nulo onde não há. */
  static async forPeriod(periodEnd) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    const picos = { operators: null, subscribers: null, devices: null };
    if (!chave) return picos;
    const linhas = await tdb('usage_peaks').where({ period_end: chave });
    for (const linha of linhas) {
      if (USAGE_RESOURCES.includes(linha.resource)) picos[linha.resource] = Number(linha.peak);
    }
    return picos;
  }
}

export default UsagePeak;
export { UsagePeak };
