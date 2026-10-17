/**
 * The slug is the subdomain the panel will be reached at, so the rule is DNS's
 * rule and not a taste in identifiers:
 *
 *   - lowercase ASCII letters, digits and hyphens only;
 *   - first and last character alphanumeric, so no leading or trailing hyphen;
 *   - 3 to 63 characters, 63 being the maximum length of a DNS label.
 *
 * Uppercase is REJECTED rather than lowered, and a stray space rejected rather
 * than trimmed, because whoever creates the provider is about to tell an ISP
 * the address of their panel. A slug that is silently rewritten means the
 * address they were given is not the address they typed, and they find that out
 * from a browser that cannot resolve it. Refusing costs one retry and says
 * exactly what is wrong.
 *
 * Shared by the console and by self-signup, so the two cannot drift: an ISP
 * that signed up on its own has to get the same address rule as one we minted.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MIN_LENGTH = 3;
const SLUG_MAX_LENGTH = 63;

/**
 * Labels that cannot become a provider, because the deployment already answers
 * to them. Handing an ISP `www.panel.example` or `api.panel.example` would put
 * their panel where the marketing site or the API lives — a collision nobody
 * can fix afterwards without moving that ISP to a new address.
 */
export const RESERVED_SLUGS = new Set([
  'www', 'api', 'app', 'admin', 'portal', 'mail', 'static', 'assets', 'cdn', 'status',
  // O endereço da caixa interna da plataforma (`tenants.kind = 'platform'`).
  // Reservado nos dois idiomas em que alguém a nomearia, porque o estrago é o
  // mesmo dos de cima: um ISP cadastrado aqui pousaria no endereço de onde nós
  // atendemos os ISPs.
  'plataforma', 'platform'
]);

/** What is wrong with this slug, or null when nothing is. */
export function slugProblem(slug) {
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) {
    return `Slug must be between ${SLUG_MIN_LENGTH} and ${SLUG_MAX_LENGTH} characters`;
  }
  if (!SLUG_PATTERN.test(slug)) {
    return 'Slug must be lowercase letters, digits and hyphens, starting and ending with a letter or digit';
  }
  // A hyphen in the third and fourth position is reserved by RFC 5891: `xn--`
  // introduces a punycode label, and every other pair is held back for whatever
  // comes next. A resolver is entitled to read such a label as encoded.
  if (slug[2] === '-' && slug[3] === '-') {
    return 'Slug must not carry a hyphen in both the third and fourth position';
  }
  if (RESERVED_SLUGS.has(slug)) {
    return 'Slug is reserved by the deployment';
  }
  return null;
}
