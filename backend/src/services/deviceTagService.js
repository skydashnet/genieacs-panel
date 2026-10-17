import SgpLink from '../models/SgpLink.js';
import CustomerAccount from '../models/CustomerAccount.js';
import Tenant from '../models/Tenant.js';
import { currentTenantId } from '../config/tenantContext.js';
import DeviceService from './deviceService.js';

/**
 * Tags the panel keeps on each ONT in GenieACS, so whoever opens the ACS
 * directly can see whose equipment it is without the panel in front of them.
 *
 * The prefixes are the panel's own. `cliente_` and `seller_` already live on
 * these fleets, written by some other tool; reusing either prefix would have
 * the panel deleting what it did not write. Anything outside these prefixes —
 * those, `Installed_`, the provisioning marker — is never touched.
 */
export const TAG_PREFIX = Object.freeze({
  contract: 'contrato_',
  customer: 'idcliente_',
  store: 'loja_',
  technician: 'tecnico_'
});

const MANAGED = Object.values(TAG_PREFIX);

/** How many ONTs a fleet pass writes to at once. */
const FLEET_CONCURRENCY = 4;

/**
 * A value made safe for a GenieACS tag: `mutateDeviceTag` accepts only
 * `[A-Za-z0-9_]`, and a contract or a login carries dots, dashes and accents.
 */
export function tagValue(value) {
  const cleaned = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
  return cleaned || null;
}

function tagFor(prefix, value) {
  const cleaned = tagValue(value);
  return cleaned ? `${prefix}${cleaned}` : null;
}

class DeviceTagService {
  /** The provider's slug, which is what `loja_` carries. */
  static async storeTag() {
    const tenant = await Tenant.findById(currentTenantId());
    return tagFor(TAG_PREFIX.store, tenant?.slug || tenant?.name);
  }

  /**
   * What the tags should be, by prefix. `null` removes the prefix's tag; a
   * prefix left out is not touched. The technician is only known at the
   * moment someone acts on the ONT, so a pass without one leaves the tag that
   * names whoever did the install where it is.
   */
  static desired({ link, account, store, technician }) {
    const wanted = {
      [TAG_PREFIX.contract]: tagFor(TAG_PREFIX.contract, link?.contract),
      [TAG_PREFIX.customer]: tagFor(TAG_PREFIX.customer, account?.customer_id)
    };
    if (store) wanted[TAG_PREFIX.store] = store;
    const byTechnician = tagFor(TAG_PREFIX.technician, technician);
    if (byTechnician) wanted[TAG_PREFIX.technician] = byTechnician;
    return wanted;
  }

  /**
   * The writes that take `current` to `wanted`.
   *
   * `loja_` only ever adds. Two providers can read one ACS and see the same
   * device ids, and removing the other provider's store tag would have the two
   * of them rewriting each other's ONTs on every pass.
   */
  static diff(current, wanted) {
    const tags = Array.isArray(current) ? current.map(String) : [];
    const add = [];
    const remove = [];
    for (const [prefix, tag] of Object.entries(wanted)) {
      if (!MANAGED.includes(prefix)) continue;
      if (tag && !tags.includes(tag)) add.push(tag);
      if (prefix === TAG_PREFIX.store) continue;
      for (const existing of tags) {
        if (existing.startsWith(prefix) && existing !== tag) remove.push(existing);
      }
    }
    return { add, remove };
  }

  static async apply(deviceId, { add, remove }) {
    for (const tag of add) await DeviceService.mutateDeviceTag(deviceId, tag, 'POST');
    for (const tag of remove) await DeviceService.mutateDeviceTag(deviceId, tag, 'DELETE');
    return { add, remove };
  }

  /** One device's tags when given an id, the whole fleet's when not. */
  static async currentTags(deviceId) {
    const query = deviceId ? JSON.stringify({ _id: String(deviceId) }) : null;
    const rows = await DeviceService.fetchDeviceListPage(query, ['_id', '_tags']);
    return new Map(rows.map((row) => [String(row._id), row._tags || []]));
  }

  /** Brings one ONT's tags in line with the panel. */
  static async reconcile(deviceId, { technician = null } = {}) {
    if (!deviceId) return null;
    const current = await this.currentTags(deviceId);
    // A device GenieACS does not know has nowhere to put a tag.
    if (!current.has(String(deviceId))) return null;
    const [link, account, store] = await Promise.all([
      SgpLink.getByDeviceId(deviceId),
      CustomerAccount.getByDeviceId(deviceId),
      this.storeTag()
    ]);
    const changes = this.diff(
      current.get(String(deviceId)),
      this.desired({ link, account, store, technician })
    );
    return this.apply(deviceId, changes);
  }

  /**
   * The same over the whole fleet: one read of every ONT's tags, the panel's
   * state in bulk, and writes only where something differs — a second pass
   * over a fleet already in line sends nothing.
   */
  static async reconcileFleet() {
    const current = await this.currentTags(null);
    const ids = [...current.keys()];
    const [links, accounts, store] = await Promise.all([
      SgpLink.getAll(),
      CustomerAccount.getAll(),
      this.storeTag()
    ]);
    const linkBy = new Map(links.map((link) => [String(link.device_id), link]));
    const accountBy = new Map(accounts
      .filter((account) => account.device_id)
      .map((account) => [String(account.device_id), account]));

    const summary = { devices: ids.length, changed: 0, failed: 0 };
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const deviceId = ids[cursor];
        cursor += 1;
        const changes = this.diff(current.get(deviceId), this.desired({
          link: linkBy.get(deviceId),
          account: accountBy.get(deviceId),
          store
        }));
        if (changes.add.length === 0 && changes.remove.length === 0) continue;
        try {
          await this.apply(deviceId, changes);
          summary.changed += 1;
        } catch (error) {
          summary.failed += 1;
          console.warn(`Unable to tag ${deviceId} in GenieACS: ${error.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FLEET_CONCURRENCY, ids.length) }, worker));
    return summary;
  }

  /**
   * `reconcile` for callers whose own job is something else. Tagging the ACS
   * is a courtesy to whoever reads it; an unreachable GenieACS must never
   * turn a contract link, an installation or a swap into an error.
   */
  static async safeReconcile(deviceId, options = {}) {
    try {
      return await this.reconcile(deviceId, options);
    } catch (error) {
      console.warn(`Unable to tag ${deviceId} in GenieACS: ${error.message}`);
      return null;
    }
  }

  static async safeReconcileFleet() {
    try {
      return await this.reconcileFleet();
    } catch (error) {
      console.warn(`Unable to tag the fleet in GenieACS: ${error.message}`);
      return null;
    }
  }
}

export default DeviceTagService;
