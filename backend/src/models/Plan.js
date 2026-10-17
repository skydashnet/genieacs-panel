import { getDb, insertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * A tabela de preços.
 *
 * Lida fora de `tdb`, pelo mesmo motivo de `tenants` e `platform_admins`: não
 * tem `tenant_id` porque é do deploy inteiro — um provedor não tem o SEU plano
 * `pro`, ele assina O plano `pro`. Filtrar pelo escopo devolveria vazio e
 * pareceria escopado, que é pior que ser abertamente compartilhado.
 *
 * O que protege esta tabela é quem escreve nela: só o plano de controle, atrás
 * de `requirePlatformAdmin`. A leitura é livre por construção — o provedor lê
 * o próprio plano por `subscriptions.plan_id`, e os limites que o plano impõe
 * são o que ele precisa ver para entender um 402.
 */
export const PLAN_LIMIT_COLUMNS = Object.freeze(['max_operators', 'max_subscribers', 'max_devices']);

/** A lista `features` como texto guardado → array de frases, tolerante a lixo. */
export function parsePlanFeatures(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

class Plan {
  static async list({ activeOnly = false } = {}) {
    let query = getDb()('plans').orderBy('id', 'asc');
    if (activeOnly) query = query.where({ active: true });
    return query;
  }

  /**
   * O que a página pública oferece: ativo E marcado como público, na ordem que
   * o console escolheu. A vitrine nunca vê um plano que o console não soltou.
   */
  static async listPublic() {
    return getDb()('plans')
      .where({ active: true, public: true })
      .orderBy('sort_order', 'asc')
      .orderBy('price_cents', 'asc')
      .orderBy('id', 'asc');
  }

  /** Um plano que um cadastro pode escolher: só os da vitrine. */
  static async findPublicByCode(code) {
    if (!code) return null;
    return (await getDb()('plans')
      .where({ code: String(code), active: true, public: true })
      .first()) || null;
  }

  static async findById(id) {
    if (!id) return null;
    return (await getDb()('plans').where({ id }).first()) || null;
  }

  static async findByCode(code) {
    if (!code) return null;
    return (await getDb()('plans').where({ code: String(code) }).first()) || null;
  }

  /**
   * O plano que um provedor novo recebe: o ativo com mais dias de teste, e na
   * falta de qualquer um com teste, o `unlimited` que a migração 0035 garante.
   * Escolhido por regra e não por coluna "default" porque uma coluna dessas é
   * uma segunda coisa para manter em dia — e ninguém lembra de mudar o default
   * quando cria o plano novo.
   */
  static async defaultForNewTenant() {
    const withTrial = await getDb()('plans')
      .where({ active: true })
      .where('trial_days', '>', 0)
      .orderBy('trial_days', 'desc')
      .orderBy('id', 'asc')
      .first();
    if (withTrial) return withTrial;
    return (await Plan.findByCode('unlimited')) || (await Plan.list({ activeOnly: true }))[0] || null;
  }

  static async create(row) {
    const id = await insertReturningId('plans', row);
    return Plan.findById(id);
  }

  static async update(id, patch) {
    const changed = await getDb()('plans')
      .where({ id })
      .update({ ...patch, updated_at: new Date() });
    return changed > 0 ? Plan.findById(id) : null;
  }

  /** Quantas assinaturas apontam para este plano — o que decide se ele pode ser desativado sem susto. */
  static async subscriberCount(id) {
    // tenant-scope-exempt: conta ACIMA dos provedores — é o console perguntando quantos ISPs estão neste plano.
    const [row] = await runUnscoped('the console counts the providers on a plan', () => getDb()('subscriptions')
      .where({ plan_id: id })
      .count({ n: '*' }));
    return Number(row?.n ?? 0);
  }
}

export default Plan;
