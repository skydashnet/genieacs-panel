import { getDb } from '../config/database.js';

/**
 * Which providers a person works for, and with what role at each.
 *
 * This is the one table in the panel that is deliberately NOT read through
 * `tdb`. Every other model asks "what does the provider in scope hold?" — this
 * one is asked BEFORE a scope exists, at login, to answer the question that
 * decides which scope to open. Reading it through the scope would be circular.
 *
 * That makes every method here a place where the caller must be explicit about
 * whose data it is asking for. There is no method that lists memberships
 * without naming either a user or a provider, on purpose: an accidental "all
 * memberships" is the shape of query that leaks a provider's staff list to
 * another provider's screen.
 */
class TenantUser {
  /** Every provider this person works for, oldest membership first. */
  static async listForUser(userId) {
    return getDb()('tenant_users')
      .where({ user_id: userId })
      .orderBy('id', 'asc');
  }

  /**
   * O mesmo, com o nome e o slug do provedor ao lado.
   *
   * Existe para a tela de login poder PERGUNTAR em qual provedor entrar: uma
   * lista de ids não é escolha que alguém consiga fazer, e buscar o nome de
   * cada um numa consulta por vínculo seria o laço que este `join` evita.
   *
   * Sem filtro por `status`: provedor suspenso continua na lista, e de
   * propósito — quem trabalha só nele entra e encontra o portão da assinatura,
   * que é a tela que explica o que houve. Esconder o destino trocaria essa
   * explicação por um 401 mentiroso.
   */
  static async listForUserWithTenant(userId) {
    return getDb()('tenant_users')
      .join('tenants', 'tenants.id', 'tenant_users.tenant_id')
      .where('tenant_users.user_id', userId)
      .orderBy('tenant_users.id', 'asc')
      .select(
        'tenants.id as id',
        'tenants.name as name',
        'tenants.slug as slug',
        'tenants.status as status',
        'tenants.require_mfa as require_mfa',
        'tenant_users.role as role'
      );
  }

  /**
   * This person's membership at this provider, or null.
   *
   * The authorisation primitive: null here means the person does not work for
   * that provider, which is the same answer as "no such provider" on purpose —
   * telling the two apart tells a prober which providers exist.
   */
  static async find(tenantId, userId) {
    return (await getDb()('tenant_users')
      .where({ tenant_id: tenantId, user_id: userId })
      .first()) || null;
  }

  /**
   * O vínculo, com a exigência de 2FA do provedor ao lado — o que a sessão
   * precisa a cada requisição, numa consulta só.
   */
  static async findWithPolicy(tenantId, userId) {
    return (await getDb()('tenant_users')
      .join('tenants', 'tenants.id', 'tenant_users.tenant_id')
      .where({ 'tenant_users.tenant_id': tenantId, 'tenant_users.user_id': userId })
      .first('tenant_users.*', 'tenants.require_mfa', 'tenants.status as tenant_status')) || null;
  }

  /** O vínculo, com o status do provedor ao lado (`tenant_status`). */
  static async findWithStatus(tenantId, userId) {
    return (await getDb()('tenant_users')
      .join('tenants', 'tenants.id', 'tenant_users.tenant_id')
      .where({ 'tenant_users.tenant_id': tenantId, 'tenant_users.user_id': userId })
      .first('tenant_users.*', 'tenants.status as tenant_status')) || null;
  }

  /** Everyone who works for one provider, with the person's details joined on. */
  static async listForTenant(tenantId) {
    return getDb()('tenant_users')
      .join('users', 'users.id', 'tenant_users.user_id')
      .where('tenant_users.tenant_id', tenantId)
      .orderBy('users.username', 'asc')
      .select(
        'users.id',
        'users.username',
        'users.email',
        'users.phone',
        'users.totp_enabled_at',
        'users.created_at',
        'users.updated_at',
        'tenant_users.role',
        'tenant_users.id as membership_id'
      );
  }

  /**
   * How many people hold one role at one provider.
   *
   * Exists for the "last admin" guard, which was counting admins across the
   * whole deployment before this table: with two providers that guard was wrong
   * in both directions at once — another ISP's admins kept this one from
   * removing its last, and this one's last could be removed while the count
   * stayed above zero on somebody else's staff.
   */
  static async countByRole(tenantId, role) {
    const [row] = await getDb()('tenant_users')
      .where({ tenant_id: tenantId, role })
      .count({ total: '*' });
    return Number(row?.total ?? 0);
  }

  /**
   * Quantas pessoas neste provedor têm um papel de uma lista.
   *
   * A guarda do "último administrador" precisa disto desde que os papéis
   * viraram quatro: contando só `role: 'admin'`, um provedor cujo único
   * administrador é o `owner` responderia zero e a guarda deixaria rebaixar
   * quem ficou sozinho no comando. O que a guarda quer contar não é um nome de
   * papel, é quantas pessoas ainda podem administrar a equipe.
   */
  static async countByRoles(tenantId, roles) {
    if (!roles?.length) return 0;
    const [row] = await getDb()('tenant_users')
      .where({ tenant_id: tenantId })
      .whereIn('role', roles)
      .count({ total: '*' });
    return Number(row?.total ?? 0);
  }

  /** `trx` opcional pelo mesmo motivo de `User.create` — ver o aceite de convite. */
  static async create({ tenantId, userId, role = 'user' }, trx = null) {
    const [id] = await (trx || getDb())('tenant_users')
      .insert({ tenant_id: tenantId, user_id: userId, role })
      .returning('id');
    return typeof id === 'object' && id !== null ? id.id : id;
  }

  static async setRole(tenantId, userId, role) {
    const changed = await getDb()('tenant_users')
      .where({ tenant_id: tenantId, user_id: userId })
      .update({ role, updated_at: new Date() });
    return changed > 0;
  }

  /**
   * Ends one person's membership at one provider.
   *
   * NOT a delete of the person: they may work for another provider, and the
   * row that records who sent a message or revoked an opt-out points at
   * `users.id`. Removing somebody from one ISP must not erase their name from
   * another's history.
   */
  static async remove(tenantId, userId) {
    const changed = await getDb()('tenant_users')
      .where({ tenant_id: tenantId, user_id: userId })
      .del();
    return changed > 0;
  }
}

export default TenantUser;
