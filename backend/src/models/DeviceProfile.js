import { tdb, tinsert } from '../config/database.js';

class DeviceProfile {
  static async getByDeviceId(deviceId) {
    return (await tdb('device_profiles').where({ device_id: deviceId }).first()) || null;
  }

  static async upsertInstallationDate(deviceId, installationDate, installationTag) {
    // The read decides insert-vs-update, so it has to be the provider's own.
    // Unfiltered it found whichever provider wrote the device id first, and the
    // second provider then spent every save overwriting that row instead of
    // ever getting one — the installation date of one ISP's subscriber landing
    // on another ISP's, and from there into the Customer ID minted from it.
    const existing = await this.getByDeviceId(deviceId);
    const values = {
      installation_date: installationDate,
      installation_tag: installationTag,
      updated_at: new Date()
    };
    if (existing) {
      await tdb('device_profiles').where({ device_id: deviceId }).update(values);
    } else {
      await tinsert('device_profiles', {
        device_id: deviceId,
        ...values,
        created_at: new Date()
      });
    }
    return this.getByDeviceId(deviceId);
  }
}

export default DeviceProfile;
