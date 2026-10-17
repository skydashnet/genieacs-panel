import { tdb } from '../config/database.js';
import SgpClient from '../models/SgpClient.js';
import ContactProfileService, { ContactProfileError } from './contactProfileService.js';
import SgpContactSyncService from './sgpContactSyncService.js';
import SgpService, { SgpError } from './sgpService.js';
import DeviceService from './deviceService.js';
import { translateError } from '../i18n/index.js';

/**
 * "Sincronizar" on one client record: the SGP asked again for this client
 * only, and every ONT of its contracts asked to report now.
 *
 * The SGP part writes the way the full contacts sync writes —
 * `SgpClient.upsertFromSgp` and `SgpContactSyncService.store` — so what an
 * operator edited in the panel (overrides, notes, the manual phone) outlives
 * it. The two halves are independent: an SGP that does not answer still
 * leaves the ONTs summoned, and the reverse.
 */
class ContactSyncService {
  static async syncOne(key, { t = (k) => k, canSummon = true } = {}) {
    const row = await ContactProfileService.rowFor(key);
    if (!row) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    const client = await ContactProfileService.clientFor(row);

    const sgp = await this.syncSgp(row, client, t);
    const profile = await ContactProfileService.get(String(key));
    const devices = canSummon ? await this.summonDevices(profile, t) : null;

    return { profile, sgp, devices };
  }

  /** The client asked of the SGP again: by its document, or by its contract. */
  static async syncSgp(row, client, t) {
    const config = await SgpService.getConfig();
    if (!SgpService.isReady(config)) return { skipped: true, contracts: 0, error: null };
    // Panel-only clients have nothing on the SGP to ask for.
    if (client?.source === 'panel' && !row.contract) return { skipped: true, contracts: 0, error: null };

    const seenAt = new Date();
    const document = String(client?.document || row.document || '').replace(/\D/g, '');
    try {
      let rows = [];
      if (document && config.endpoints.customerList) {
        const found = await SgpService.lookupClientsWithProfiles({ document });
        for (const profile of found.clients) {
          // eslint-disable-next-line no-await-in-loop -- one client, a handful of profiles
          await SgpClient.upsertFromSgp(profile, { seenAt });
        }
        rows = found.rows;
      }
      if (rows.length === 0 && row.contract) {
        const { contracts } = await SgpService.lookupCustomer({ contract: row.contract }, config);
        rows = contracts.filter((entry) => String(entry.contract) === String(row.contract));
      }
      for (const entry of rows) {
        // eslint-disable-next-line no-await-in-loop -- one client's contracts
        await SgpContactSyncService.store(entry, seenAt);
      }
      return { skipped: false, contracts: rows.filter((entry) => entry.contract).length, error: null };
    } catch (error) {
      if (!(error instanceof SgpError)) throw error;
      return { skipped: false, contracts: 0, error: translateError(t, error) };
    }
  }

  /** Every ONT of the client's contracts, asked to report now. */
  static async summonDevices(profile, t) {
    const contracts = profile.contracts.map((entry) => String(entry.contract));
    if (contracts.length === 0) return [];
    const links = await tdb('sgp_links').whereIn('contract', contracts).select('device_id', 'contract');
    const results = [];
    for (const link of links) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one client's ONTs, one at a time like the device page
        const { reached, reason } = await DeviceService.summonDevice(link.device_id, []);
        results.push({ deviceId: link.device_id, contract: link.contract, reached: Boolean(reached), reason: reason || null, error: null });
      } catch (error) {
        results.push({
          deviceId: link.device_id,
          contract: link.contract,
          reached: false,
          reason: null,
          error: error?.translationKey ? translateError(t, error) : (error?.message || 'error')
        });
      }
    }
    return results;
  }
}

export default ContactSyncService;
