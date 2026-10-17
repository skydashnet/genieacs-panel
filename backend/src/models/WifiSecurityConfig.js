import { getDb, tdb, tinsertReturningId } from '../config/database.js';

function withArray(row) {
  if (!row) return null;
  return {
    ...row,
    security_types_array: row.security_types ? row.security_types.split(',') : []
  };
}

/**
 * The per-product-class WiFi parameter path, per provider.
 *
 * `getByProductClass` is what the WiFi write path consults before it falls back
 * to the vendor's own `wifi_password_path`, so a row read from the wrong
 * provider writes a subscriber's password to a path that ISP never approved.
 * The comparison stays `LOWER(...) = LOWER(?)` because a product class is
 * whatever the CPE reported and case is not part of its identity; it is written
 * raw because the three engines disagree about collations, and `tdb` adds the
 * provider as a normal WHERE alongside it.
 */
/**
 * Whether this provider already has a config for that product class.
 *
 * The duplicate matters more here than tidiness would suggest: `getByProductClass`
 * takes `.first()`, so a second row for the same class does not compete — it
 * simply never applies, and nothing says so. An operator who adds a corrected
 * config beside an old one watches the old one keep winning.
 *
 * Matched case-insensitively, the same way the read matches, or the check would
 * pass for a row the read then treats as the same one.
 *
 * `exceptId` is for an edit: a row is not its own duplicate.
 */
async function productClassTaken(productClass, exceptId = null) {
  const query = tdb('wifi_security_config')
    .whereRaw('LOWER(product_class) = LOWER(?)', [String(productClass ?? '')]);
  // Coerced: the id reaches the model straight from a route parameter, so it is
  // a STRING. Left strict, a row would not recognise itself and every edit that
  // kept its own product class would be refused as a duplicate of itself.
  const self = Number(exceptId);
  if (Number.isFinite(self)) query.whereNot({ id: self });
  return Boolean(await query.first());
}

class WifiSecurityConfig {
  static async getAll() {
    const rows = await tdb('wifi_security_config').orderBy('product_class', 'asc');
    return rows.map(withArray);
  }

  static async getById(id) {
    const row = await tdb('wifi_security_config').where({ id }).first();
    return withArray(row);
  }

  static async getByProductClass(productClass) {
    const row = await tdb('wifi_security_config')
      .whereRaw('LOWER(product_class) = LOWER(?)', [productClass])
      .first();
    return withArray(row);
  }

  /** @returns {Promise<number|null>} the new id, or null when the class is taken. */
  static async create(configData) {
    const { product_class, security_types, password_param_path } = configData;
    const securityTypesString = Array.isArray(security_types) ? security_types.join(',') : security_types;

    if (await productClassTaken(product_class)) return null;

    const id = await tinsertReturningId('wifi_security_config', {
      product_class,
      security_types: securityTypesString,
      password_param_path
    });
    return id;
  }

  /** @returns {Promise<boolean|null>} null when the class is taken by another row. */
  static async update(id, configData) {
    const { product_class, security_types, password_param_path } = configData;
    const securityTypesString = Array.isArray(security_types) ? security_types.join(',') : security_types;

    // Existence FIRST, duplicate second. Handed another provider's id together
    // with a product class this provider does use, both things are true — and
    // answering "duplicate" would be a lie about a row the caller cannot see.
    // Not-found wins, the same way it does everywhere else a scoped row is
    // asked for by an id from outside.
    const mine = await tdb('wifi_security_config').where({ id }).first();
    if (!mine) return false;
    if (await productClassTaken(product_class, id)) return null;

    const count = await tdb('wifi_security_config').where({ id }).update({
      product_class,
      security_types: securityTypesString,
      password_param_path,
      updated_at: getDb().fn.now()
    });
    return count > 0;
  }

  /**
   * Põe numa linha do provedor as colunas de outra — a do catálogo padrão,
   * no "restaurar padrão". O id e o provedor ficam; o resto é substituído.
   * `false` quando a linha não é deste provedor.
   */
  static async resetTo(id, columns) {
    const affected = await tdb('wifi_security_config').where({ id }).update({
      ...columns,
      updated_at: getDb().fn.now()
    });
    return affected > 0;
  }

  static async delete(id) {
    const count = await tdb('wifi_security_config').where({ id }).del();
    return count > 0;
  }
}

export default WifiSecurityConfig;
