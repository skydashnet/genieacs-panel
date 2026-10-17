import { getDb, insertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * Os cupons de desconto da assinatura (migração 0093).
 *
 * Lida fora de `tdb`, pelo motivo de `plans`: não tem `tenant_id` porque é do
 * deploy inteiro — um provedor resgata O cupom `BEMVINDO10`, não tem o seu.
 * Quem protege a tabela é quem escreve: só o plano de controle, atrás de
 * `requirePlatformAdmin`. O provedor só chega aqui pelo código que digitou, e
 * o que ele lê de volta é o cupom que já está na assinatura dele.
 */
export const COUPON_KINDS = Object.freeze(['percent', 'fixed']);
export const COUPON_DURATIONS = Object.freeze(['once', 'repeating', 'forever']);

/** O código como se guarda e se compara: sem espaço nas pontas, em maiúsculas. */
export function normalizeCouponCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

/**
 * A lista `plan_ids` como texto guardado → ids, ou nulo quando o cupom vale
 * para qualquer plano. Tolerante a lixo: uma lista ilegível vale como "nenhum
 * plano" (lista vazia), e não como "todos" — na dúvida, o desconto não sai.
 */
export function parseCouponPlanIds(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const lista = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(lista)) return [];
    return lista.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  }
}

class Coupon {
  static async list() {
    return getDb()('coupons').orderBy('id', 'desc');
  }

  static async findById(id, db = getDb()) {
    if (!id) return null;
    return (await db('coupons').where({ id }).first()) || null;
  }

  static async findByCode(code, db = getDb()) {
    const codigo = normalizeCouponCode(code);
    if (!codigo) return null;
    return (await db('coupons').where({ code: codigo }).first()) || null;
  }

  static async create(row) {
    const id = await insertReturningId('coupons', { ...row, code: normalizeCouponCode(row.code) });
    return Coupon.findById(id);
  }

  static async update(id, patch) {
    const changed = await getDb()('coupons').where({ id }).update({ ...patch, updated_at: new Date() });
    return changed > 0 ? Coupon.findById(id) : null;
  }

  /**
   * Apaga o cupom que NUNCA foi resgatado — condicional, para que um resgate
   * que entrou entre a leitura do console e aqui não perca a linha que o
   * extrato daquele provedor nomeia. Devolve se apagou.
   */
  static async deleteIfUnused(id) {
    const changed = await getDb()('coupons').where({ id, redemptions: 0 }).del();
    return changed > 0;
  }

  /**
   * O resgate: `redemptions + 1`, numa atualização só, e só se o cupom ainda
   * pode ser resgatado — ativo, dentro da validade e abaixo do teto.
   *
   * Ler o contador e gravar o seguinte deixaria dois provedores resgatarem a
   * última vaga ao mesmo tempo: os dois leriam `max − 1`. A condição na própria
   * atualização é o que serializa — o banco aplica uma de cada vez, e a
   * segunda já não casa. Devolve se resgatou.
   */
  static async redeem(id, now = new Date(), db = getDb()) {
    const changed = await db('coupons')
      .where({ id, active: true })
      .where((q) => q.whereNull('max_redemptions').orWhere('redemptions', '<', db.ref('max_redemptions')))
      .where((q) => q.whereNull('valid_until').orWhere('valid_until', '>', now))
      .update({ redemptions: db.raw('redemptions + 1'), updated_at: now });
    return changed > 0;
  }

  /**
   * Devolve um resgate que não chegou a valer — a aplicação falhou depois de
   * resgatar (o gateway recusou, outra aplicação ganhou a corrida). Nunca
   * abaixo de zero.
   */
  static async unredeem(id, db = getDb()) {
    const changed = await db('coupons')
      .where({ id })
      .where('redemptions', '>', 0)
      .update({ redemptions: db.raw('redemptions - 1'), updated_at: new Date() });
    return changed > 0;
  }

  /**
   * Quantas assinaturas têm cada cupom aplicado AGORA — o "em uso" da aba
   * Cupons, ao lado dos resgates (que nunca descem). Um mapa id → contagem.
   */
  static async activeUsage() {
    // tenant-scope-exempt: conta ACIMA dos provedores — o console perguntando quantos ISPs usam cada cupom.
    const linhas = await runUnscoped('the console counts the providers using each coupon', () => getDb()('subscriptions')
      .whereNotNull('coupon_id')
      .select('coupon_id')
      .count({ n: '*' })
      .groupBy('coupon_id'));
    return new Map(linhas.map((linha) => [Number(linha.coupon_id), Number(linha.n ?? 0)]));
  }
}

export default Coupon;
