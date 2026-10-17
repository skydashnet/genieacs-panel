import 'dotenv/config';

/**
 * TR69 Controle ships as two editions from one codebase.
 *
 * `selfhosted` is the historical product: one install per ISP, owned and run by
 * that ISP. `saas` is the hosted service, where one deployment serves many ISPs
 * and a feature that is harmless on a single-tenant box can be destructive.
 *
 * The default is `selfhosted` so an existing install upgrading into this
 * release keeps every capability it had.
 */
const EDITIONS = new Set(['saas', 'selfhosted']);

const configured = String(process.env.EDITION || 'selfhosted').trim().toLowerCase();

if (!EDITIONS.has(configured)) {
  throw new Error(
    `EDITION must be one of ${[...EDITIONS].join(', ')}; received "${process.env.EDITION}"`
  );
}

export const EDITION = configured;
export const IS_SAAS = EDITION === 'saas';
export const IS_SELF_HOSTED = EDITION === 'selfhosted';
