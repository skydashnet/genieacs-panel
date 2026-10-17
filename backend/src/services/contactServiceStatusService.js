import ContactProfileService, { ContactProfileError } from './contactProfileService.js';
import DeviceService from './deviceService.js';
import { primaryAddress } from './waSubscriberPanelService.js';

/**
 * "Status do serviço" on a client record: what each contract's ONT says about
 * the line right now, asked of the ACS (TR-069) and never stored — online or
 * offline by the last inform, how long it has been up, the address its WAN
 * holds, the optical signal and how many devices are on it.
 *
 * Nothing here is a credential: the WAN read returns addresses, status and
 * names only, and the overview carries no password.
 */
export default class ContactServiceStatusService {
  static async forClient(key) {
    const profile = await ContactProfileService.get(String(key));
    if (!profile) throw new ContactProfileError('contacts.error.notFound', { code: 'not_found', status: 404 });
    const contracts = await Promise.all(profile.contracts.map((entry) => this.forContract(entry)));
    return { contracts, generatedAt: new Date().toISOString() };
  }

  static async forContract(entry) {
    const base = { contract: String(entry.contract), deviceId: entry.deviceId ?? null };
    if (!entry.deviceId) return { ...base, available: false, reason: 'unlinked' };

    const [overview, wan] = await Promise.allSettled([
      DeviceService.getCustomerPortalOverview(entry.deviceId),
      DeviceService.getWanAddresses(entry.deviceId)
    ]);
    if (overview.status === 'rejected' && wan.status === 'rejected') {
      return { ...base, available: false, reason: overview.reason?.status === 404 ? 'not_found' : 'unreachable' };
    }
    const info = overview.status === 'fulfilled' ? overview.value : null;
    const connections = wan.status === 'fulfilled' ? wan.value : [];
    const uptime = Number(info?.ont?.uptimeSeconds);
    return {
      ...base,
      available: true,
      status: info?.status ?? null,
      lastInform: info?.lastInform ?? null,
      lastBoot: info?.lastBoot ?? null,
      uptimeSeconds: Number.isFinite(uptime) && uptime >= 0 ? uptime : null,
      model: [info?.ont?.manufacturer, info?.ont?.model].filter(Boolean).join(' ') || null,
      rxPower: info?.optical?.rxPower ?? null,
      temperature: info?.optical?.temperature ?? null,
      connectedDevices: info?.connectedDevices ?? null,
      ipAddress: primaryAddress(connections),
      wanStatus: connections.find((connection) => connection.type === 'PPPoE')?.status ?? connections[0]?.status ?? null
    };
  }
}
