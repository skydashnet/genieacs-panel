import DeviceSwap from '../models/DeviceSwap.js';
import SgpLink from '../models/SgpLink.js';
import DeviceTagService from './deviceTagService.js';
import { timestampMs } from '../utils/helpers.js';

/**
 * How long two ONTs may trade one PPPoE login before the panel stops believing
 * either of them.
 *
 * During an install both the old and the new equipment can be powered on and
 * informing for a few minutes, and GenieACS reports whichever one spoke last.
 * The account follows, so the panel sees A→B, then B→A, then A→B again. Acting
 * on each of those moves the contract's link off whichever ONT is actually in
 * service about half the time, which is worse than not acting at all — so a
 * reversal inside this window is recorded and the links are left where they
 * are, for the operator to settle.
 */
const FLAP_WINDOW_MS = 30 * 60_000;

/**
 * How long a pair the operator dismissed as unstable stays dismissed while it
 * keeps trading the login.
 *
 * Longer than the flap window on purpose. The pair's rhythm is not the ONTs'
 * inform interval but whoever opens the device list or runs the Customer ID
 * sweep, and a gap of more than 30 minutes between two of those is ordinary.
 * Measuring the dismissal by the flap window brought "Confirmar" back after
 * every lunch break. A pair that stays quiet for a whole day is a new story,
 * and the next swap after that reopens it.
 */
const DISMISSED_FLAP_WINDOW_MS = 24 * 60 * 60_000;

function normalizeId(value) {
  return String(value ?? '').trim();
}

class DeviceSwapService {
  static flapWindowMs() {
    return FLAP_WINDOW_MS;
  }

  static dismissedFlapWindowMs() {
    return DISMISSED_FLAP_WINDOW_MS;
  }

  /**
   * Records that `deviceId` replaced `previousDeviceId` for one subscriber, and
   * retires the old equipment's SGP link.
   *
   * Called from both branches of `CustomerService.ensureAccount` that move an
   * account onto another device, and only those. The identity branch is not
   * optional: `identity_hash` is sha256(softwareId, pppoe_username), so a
   * replacement running the same firmware as the ONT it replaced matches there
   * and never reaches the PPPoE branch — which is the common case, since an
   * operator replaces an ONT with the same model from the same box.
   */
  static async record(account, previousDeviceId, deviceId, matchedBy) {
    const previous = normalizeId(previousDeviceId);
    const next = normalizeId(deviceId);
    if (!previous || !next || previous === next) return null;

    const now = new Date();
    // The pair recorded in the other direction. Its presence means the account
    // already came back the other way, so this is equipment in dispute rather
    // than a replacement.
    const reverse = await DeviceSwap.getPair(next, previous);
    const flapping = Boolean(
      reverse && timestampMs(now) - timestampMs(reverse.occurred_at) <= FLAP_WINDOW_MS
    );
    const keepDismissed = Boolean(
      reverse && timestampMs(now) - timestampMs(reverse.occurred_at) <= DISMISSED_FLAP_WINDOW_MS
    );

    const link = await SgpLink.getByDeviceId(previous);
    let linkAction = 'held';
    if (!flapping) {
      const moved = await SgpLink.moveDevice(previous, next);
      linkAction = moved.action;
      // The contract tag follows the link off the old ONT and onto the new.
      if (moved.action !== 'none') {
        await DeviceTagService.safeReconcile(previous);
        await DeviceTagService.safeReconcile(next);
      }
    }

    const { swap } = await DeviceSwap.record({
      account_id: account?.id ?? null,
      customer_id: account?.customer_id ?? null,
      pppoe_username: account?.pppoe_username ?? null,
      previous_device_id: previous,
      device_id: next,
      contract: link?.contract ?? null,
      matched_by: matchedBy,
      link_action: linkAction,
      flapping,
      repeat_count: 1,
      occurred_at: now,
      created_at: now,
      updated_at: now
    }, { keepDismissed });

    // Both directions describe the same unstable pair, so both are flagged —
    // otherwise the operator's list shows one row calling it a swap and one
    // calling it a flap, for the same two ONTs.
    if (flapping && reverse && !reverse.flapping) await DeviceSwap.markFlapping(reverse.id);

    if (flapping) {
      console.warn(
        `Devices ${previous} and ${next} are trading PPPoE login "${account?.pppoe_username}"; `
        + 'leaving the SGP link where it is until one of them stops informing.'
      );
    }

    return swap;
  }
}

export default DeviceSwapService;
