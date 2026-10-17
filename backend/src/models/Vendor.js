import { getDb, tdb, tinsertReturningId } from '../config/database.js';

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: Number(row.enabled) ? 1 : 0,
    manufacturer_patterns: JSON.parse(row.manufacturer_patterns || '[]'),
    product_patterns: JSON.parse(row.product_patterns || '[]')
  };
}

function serialize(vendorData) {
  const {
    name,
    manufacturer_patterns,
    product_patterns,
    parameter_prefix,
    service_list_path,
    lan_binding_path,
    vlan_id_path,
    wifi_password_path,
    http_wan_enable_path,
    firewall_level_path,
    priority = 10,
    enabled = 1,
    description
  } = vendorData;

  return {
    name,
    manufacturer_patterns: JSON.stringify(manufacturer_patterns || []),
    product_patterns: JSON.stringify(product_patterns || []),
    parameter_prefix,
    service_list_path,
    lan_binding_path,
    vlan_id_path,
    wifi_password_path,
    http_wan_enable_path,
    firewall_level_path,
    priority,
    enabled: enabled ? 1 : 0,
    description
  };
}

/**
 * The equipment catalogue, per provider.
 *
 * Every row here is operator-editable through `/api/vendor-management`, so the
 * detection patterns and parameter paths one ISP corrects are that ISP's
 * decision and nobody else's. `update` and `delete` are the reason this model
 * could not stay deployment-wide any longer: both take an id off the URL and
 * nothing else, so unscoped they edit and remove another provider's rows.
 * `tdb` supplies the provider half of that WHERE, which turns both into
 * no-ops on a row that belongs to someone else.
 *
 * (O argumento original era mais forte ainda: `vendors` era pai de
 * `wifi_security_mappings` com ON DELETE CASCADE, então apagar um fabricante
 * levava junto os mapeamentos de OUTRO provedor. A 0052 derrubou aquela
 * tabela; a razão de escopar este model não dependia dela.)
 */
/**
 * Whether this provider already has a vendor by that name.
 *
 * Cosmetic next to the product-class check — a vendor's name is not what
 * `detectVendor` matches on, so a duplicate name breaks nothing by itself. It
 * is refused because the list is how an operator finds the row they mean to
 * edit, and two rows called "ZTE" make that a guess: they will correct one and
 * watch the other keep winning on priority.
 *
 * Compared case-insensitively in JavaScript rather than in SQL: the three
 * engines disagree about collations, and this runs once per write.
 */
async function nameTaken(name, exceptId = null) {
  const wanted = String(name ?? '').trim().toLowerCase();
  if (!wanted) return false;
  // Coerced, because the id reaches the model straight from a route parameter
  // and is therefore a STRING. Compared strictly, a row would fail to recognise
  // itself and every edit that kept its own name would be refused as a
  // duplicate of itself.
  const self = Number(exceptId);
  const rows = await tdb('vendors').select('id', 'name');
  return rows.some((row) => String(row.name ?? '').trim().toLowerCase() === wanted
    && !(Number.isFinite(self) && Number(row.id) === self));
}

class Vendor {
  static async getAll() {
    const rows = await tdb('vendors')
      .orderBy([{ column: 'priority', order: 'desc' }, { column: 'name', order: 'asc' }]);
    return rows.map(parseRow);
  }

  static async getEnabled() {
    const rows = await tdb('vendors')
      .where({ enabled: true })
      .orderBy([{ column: 'priority', order: 'desc' }, { column: 'name', order: 'asc' }]);
    return rows.map(parseRow);
  }

  static async findById(id) {
    const row = await tdb('vendors').where({ id }).first();
    return parseRow(row);
  }

  /** @returns {Promise<number|null>} the new id, or null when the name is taken. */
  static async create(vendorData) {
    if (await nameTaken(vendorData?.name)) return null;
    const id = await tinsertReturningId('vendors', serialize(vendorData));
    return id;
  }

  /** @returns {Promise<boolean|null>} null when the name is taken by another row. */
  static async update(id, vendorData) {
    // Existence FIRST, duplicate second — see the note in `WifiSecurityConfig`:
    // handed another provider's id, "not found" is the true answer and
    // "duplicate" would describe a row the caller cannot see.
    const mine = await tdb('vendors').where({ id }).first();
    if (!mine) return false;
    if (await nameTaken(vendorData?.name, id)) return null;
    const payload = serialize(vendorData);
    payload.updated_at = getDb().fn.now();
    const affected = await tdb('vendors').where({ id }).update(payload);
    return affected > 0;
  }

  /**
   * Põe numa linha do provedor as colunas de outra — a do catálogo padrão,
   * no "restaurar padrão". O id e o provedor ficam; o resto é substituído.
   * `false` quando a linha não é deste provedor.
   */
  static async resetTo(id, columns) {
    const affected = await tdb('vendors').where({ id }).update({
      ...columns,
      updated_at: getDb().fn.now()
    });
    return affected > 0;
  }

  static async delete(id) {
    const affected = await tdb('vendors').where({ id }).del();
    return affected > 0;
  }
}

export default Vendor;
