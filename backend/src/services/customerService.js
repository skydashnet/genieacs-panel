import crypto from 'node:crypto';
import CustomerAccount from '../models/CustomerAccount.js';
import Setting from '../models/Setting.js';

const CUSTOMER_ID_PATTERN = /^CSG-[A-Z0-9]{7}-[0-9]{6}$/;
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DIGITS = '0123456789';

function randomString(alphabet, length) {
  let result = '';
  while (result.length < length) {
    const bytes = crypto.randomBytes(length - result.length);
    for (const byte of bytes) {
      const limit = 256 - (256 % alphabet.length);
      if (byte < limit) result += alphabet[byte % alphabet.length];
      if (result.length === length) break;
    }
  }
  return result;
}

function normalizeIdentityValue(value) {
  return String(value ?? '').trim();
}

class CustomerService {
  static isEnabledValue(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  static async isAutoGenerationEnabled() {
    return this.isEnabledValue(await Setting.getByKey('autoGenerateCustomerId'));
  }

  static identityHash(softwareId, pppoeUsername) {
    return crypto
      .createHash('sha256')
      .update(`${normalizeIdentityValue(softwareId)}\0${normalizeIdentityValue(pppoeUsername)}`)
      .digest('hex');
  }

  static generateCustomerId() {
    return `CSG-${randomString(ID_ALPHABET, 7)}-${randomString(DIGITS, 6)}`;
  }

  static passwordForCustomerId(customerId) {
    return CUSTOMER_ID_PATTERN.test(customerId) ? customerId.slice(-6) : '';
  }

  static normalizeCustomerId(value) {
    const customerId = String(value ?? '').trim().toUpperCase();
    return CUSTOMER_ID_PATTERN.test(customerId) ? customerId : null;
  }

  static async ensureAccount(device) {
    const deviceId = normalizeIdentityValue(device?._id);
    const softwareId = normalizeIdentityValue(device?.softwareId);
    const pppoeUsername = normalizeIdentityValue(device?.pppoe);
    if (!deviceId || !softwareId || !pppoeUsername) return null;

    const existingByDevice = await CustomerAccount.getByDeviceId(deviceId);
    if (existingByDevice) {
      return CustomerAccount.touch(existingByDevice.id, deviceId);
    }

    const identityHash = this.identityHash(softwareId, pppoeUsername);
    const existingByIdentity = await CustomerAccount.getByIdentityHash(identityHash);
    if (existingByIdentity) {
      return CustomerAccount.touch(existingByIdentity.id, deviceId);
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await CustomerAccount.create({
          customer_id: this.generateCustomerId(),
          device_id: deviceId,
          identity_hash: identityHash,
          software_id: softwareId,
          pppoe_username: pppoeUsername,
          active: true,
          last_seen_at: new Date()
        });
      } catch (error) {
        const duplicate =
          error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          error.code === 'ER_DUP_ENTRY' ||
          /unique/i.test(error.message);
        if (!duplicate) throw error;

        const concurrent = await CustomerAccount.getByDeviceId(deviceId)
          || await CustomerAccount.getByIdentityHash(identityHash);
        if (concurrent) return concurrent;
      }
    }
    throw new Error('Unable to allocate a unique customer ID');
  }

  static async syncDevices(devices, { enabled } = {}) {
    const shouldGenerate = enabled ?? await this.isAutoGenerationEnabled();
    const deviceIds = devices.map((device) => String(device?._id || '')).filter(Boolean);
    let rows = await CustomerAccount.getIdsByDeviceIds(deviceIds);

    if (shouldGenerate && rows.length < deviceIds.length) {
      const existingDeviceIds = new Set(rows.map((row) => row.device_id));
      const missing = devices.filter((device) => (
        device?._id && !existingDeviceIds.has(String(device._id))
      ));
      // Keep database pressure bounded while avoiding a slow one-by-one sync
      // for larger GenieACS fleets.
      for (let offset = 0; offset < missing.length; offset += 10) {
        await Promise.all(
          missing.slice(offset, offset + 10).map((device) => this.ensureAccount(device))
        );
      }
      rows = await CustomerAccount.getIdsByDeviceIds(deviceIds);
    }

    return new Map(rows.map((row) => [row.device_id, row.customer_id]));
  }

  static async decorateDevices(devices) {
    const customerIds = await this.syncDevices(devices);
    return devices.map((device) => ({
      ...device,
      customerId: customerIds.get(String(device._id)) || null
    }));
  }
}

export default CustomerService;
