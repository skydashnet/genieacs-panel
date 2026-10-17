import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import CustomerAccount from '../models/CustomerAccount.js';
import { createSecretBox } from '../utils/secretBox.js';

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PASSWORD_LENGTH = 10;
// Portal passwords are machine-generated (10 chars over a 32-symbol alphabet,
// ~50 bits), so they do not need the work factor a human-chosen operator
// password does; 10 rounds keeps a fleet-wide backfill from pegging the CPU.
const BCRYPT_ROUNDS = 10;
const BACKFILL_BATCH = 25;

// Compared against when the submitted Customer ID has no account, so a wrong
// ID costs the same time as a wrong password and cannot be enumerated.
let dummyHash;
function dummyPasswordHash() {
  if (!dummyHash) dummyHash = bcrypt.hashSync('skygenpanel-invalid-portal-login', BCRYPT_ROUNDS);
  return dummyHash;
}

let box;
function secretBox() {
  if (!box) box = createSecretBox('skygenpanel-customer-portal-password-v1');
  return box;
}

class CustomerPortalPasswordService {
  static get passwordLength() {
    return PASSWORD_LENGTH;
  }

  static generatePassword() {
    let result = '';
    while (result.length < PASSWORD_LENGTH) {
      const bytes = crypto.randomBytes(PASSWORD_LENGTH - result.length);
      for (const byte of bytes) {
        const limit = 256 - (256 % PASSWORD_ALPHABET.length);
        if (byte < limit) result += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
        if (result.length === PASSWORD_LENGTH) break;
      }
    }
    return result;
  }

  /** Columns describing a portal password, ready to be inserted or updated. */
  static async buildRecord(password) {
    return {
      password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      ...secretBox().encrypt(password),
      password_updated_at: new Date()
    };
  }

  static async createRecord() {
    const password = this.generatePassword();
    return { password, record: await this.buildRecord(password) };
  }

  static async verify(account, password) {
    const hash = account?.password_hash;
    if (!hash) {
      // Keep the timing identical to a real comparison for accounts that have
      // not been migrated yet; they can only be unlocked by an operator reset.
      await bcrypt.compare(String(password), dummyPasswordHash());
      return false;
    }
    return bcrypt.compare(String(password), hash);
  }

  static async rejectUnknownAccount(password) {
    await bcrypt.compare(String(password), dummyPasswordHash());
  }

  static async reset(accountId) {
    const { password, record } = await this.createRecord();
    await CustomerAccount.updatePassword(accountId, record);
    return password;
  }

  static reveal(account) {
    return secretBox().decrypt(account);
  }

  /**
   * Accounts created before portal passwords existed authenticated with the
   * last six characters of their own Customer ID. Give each of them a real
   * random password instead; operators read the new value from the panel.
   */
  static async backfillMissing() {
    let generated = 0;
    const handled = new Set();
    for (;;) {
      const accounts = await CustomerAccount.getWithoutPassword(BACKFILL_BATCH);
      // Stop instead of spinning if an account somehow comes back unchanged.
      const pending = accounts.filter((account) => !handled.has(account.id));
      if (pending.length === 0) return generated;
      for (const account of pending) {
        handled.add(account.id);
        const { record } = await this.createRecord();
        await CustomerAccount.updatePassword(account.id, record);
        generated += 1;
      }
    }
  }
}

export default CustomerPortalPasswordService;
