/**
 * One table of the addresses the panel may not be sent to, for every outbound
 * path that takes a destination from data rather than from code.
 *
 * There used to be two. `utils/wa/ssrfGuard.js` guarded the WhatsApp side and
 * `services/genieacsEgress.js` the ACS side, and neither was a superset of the
 * other: the WhatsApp one understood 6to4 and the 192.0.0.0/16 assignments and
 * missed IPv6 multicast; the ACS one had multicast and missed both of those.
 * A blocklist that disagrees with its sibling is a blocklist with a hole in it,
 * and which hole you fall through depended only on which feature you reached.
 * So the ranges live here, once, and both modules classify through this file.
 *
 * The list is the strict union of what the two blocked between them:
 *
 *   IPv4
 *     0.0.0.0/8         the unspecified "this network" block
 *     10.0.0.0/8        RFC 1918
 *     100.64.0.0/10     carrier-grade NAT
 *     127.0.0.0/8       loopback
 *     169.254.0.0/16    link-local — where the cloud metadata service lives
 *     172.16.0.0/12     RFC 1918
 *     192.0.0.0/16      IETF protocol assignments and TEST-NET-1
 *     192.168.0.0/16    RFC 1918
 *     224.0.0.0/3       multicast and the reserved space above it
 *
 *   IPv6
 *     ::                the unspecified address
 *     ::1               loopback
 *     ::/96             IPv4-compatible        ─┐
 *     ::ffff:0:0/96     IPv4-mapped             │ classified by the IPv4 rules
 *     ::ffff:0:0:0/96   IPv4-translated         │ above, on the embedded address
 *     64:ff9b::/96      NAT64                   │
 *     2002::/16         6to4                   ─┘
 *     fc00::/7          unique local
 *     fe80::/10         link-local
 *     ff00::/8          multicast
 *
 * Deliberately NOT here: 198.18.0.0/15 and TEST-NET-2/3 (198.51.100.0/24,
 * 203.0.113.0/24). Neither module blocked them — `isPrivateIPv4` catches
 * TEST-NET-1 only because 192.0.2.0/24 sits inside the 192.0.0.0/16 rule — and
 * the suites use 203.0.113.x as their stand-in for "a public host we never
 * actually dial". Adding them would be a new decision, not a union of two old
 * ones, and it would silently retarget every test that leans on that address.
 *
 * Whether these ranges are refused at all is the caller's decision, not this
 * file's: a self-hosted install reaches its own ACS on its own LAN, and
 * `genieacsEgress` says so by not asking. This module only answers "what is
 * this address".
 */

import net from 'node:net';

/** The four octets of a dotted-quad, as numbers. */
export function ipv4Bytes(text) {
  return text.split('.').map((part) => Number.parseInt(part, 10));
}

/**
 * The 16 bytes of an IPv6 address, or null when the text is not one.
 *
 * Written out rather than pattern-matched because the classes below are ranges
 * of leading bits, and a textual address hides them: `fc00::1`, `FC00:0:0::1`
 * and `::ffff:10.0.0.1` are the same address written three ways, and a regex
 * that catches one of the three is a guard with a hole in it.
 */
export function ipv6Bytes(text) {
  if (!net.isIPv6(text)) return null;

  let value = text.split('%')[0];

  // A trailing dotted quad — the `::ffff:10.0.0.1` family — is folded into two
  // ordinary hextets first, so that everything below deals with one notation.
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null;
    const [a, b, c, d] = ipv4Bytes(tail);
    value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...rest];
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const word = Number.parseInt(group, 16);
    bytes.push(word >> 8, word & 0xff);
  }
  return bytes;
}

/** Why this v4 address is not somewhere the panel may be sent, or null. */
export function blockedIpv4Reason([a, b]) {
  if (a === 0) return 'the unspecified "this network" block';
  if (a === 127) return 'loopback';
  if (a === 10) return 'a private network (10/8)';
  if (a === 172 && b >= 16 && b <= 31) return 'a private network (172.16/12)';
  if (a === 192 && b === 168) return 'a private network (192.168/16)';
  if (a === 192 && b === 0) return 'IETF protocol assignments and TEST-NET-1 (192.0.0.0/16)';
  if (a === 169 && b === 254) return 'link-local, where the cloud metadata service lives (169.254/16)';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64/10)';
  if (a >= 224) return 'multicast or reserved space';
  return null;
}

/** Why this v6 address is not somewhere the panel may be sent, or null. */
export function blockedIpv6Reason(bytes) {
  const allZero = bytes.every((byte) => byte === 0);
  if (allZero) return 'the unspecified address (::)';
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return 'IPv6 loopback (::1)';

  // Five prefixes carry a whole IPv4 address in their low 32 bits, and each of
  // them reaches the same v4 host by another spelling. All five are answered by
  // the v4 rules, or the entire v4 blocklist is bypassed by asking for the
  // address in v6 notation.
  //
  // The translated form is the one that used to slip through both modules:
  // `::ffff:0:7f00:1` is 127.0.0.1 with an extra zero group, so the regex that
  // looked for `::ffff:` followed by exactly two hextets saw three and gave up,
  // and the byte test that looked for 0xffff at bytes 10-11 found it at 8-9.
  const zeroThrough7 = bytes.slice(0, 8).every((byte) => byte === 0);
  const zeroThrough9 = zeroThrough7 && bytes[8] === 0 && bytes[9] === 0;
  const isMapped = zeroThrough9 && bytes[10] === 0xff && bytes[11] === 0xff;
  const isCompatible = zeroThrough9 && bytes[10] === 0 && bytes[11] === 0;
  const isTranslated = zeroThrough7 && bytes[8] === 0xff && bytes[9] === 0xff
    && bytes[10] === 0 && bytes[11] === 0;
  const isNat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes.slice(4, 12).every((byte) => byte === 0);
  if (isMapped || isCompatible || isTranslated || isNat64) {
    const reason = blockedIpv4Reason(bytes.slice(12));
    return reason ? `${reason}, reached through an IPv4-mapped IPv6 address` : null;
  }

  // 6to4 keeps its IPv4 right after the prefix rather than at the end.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const reason = blockedIpv4Reason(bytes.slice(2, 6));
    return reason ? `${reason}, reached through a 6to4 address (2002::/16)` : null;
  }

  if ((bytes[0] & 0xfe) === 0xfc) return 'a unique local address (fc00::/7)';
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'IPv6 link-local (fe80::/10)';
  if (bytes[0] === 0xff) return 'IPv6 multicast (ff00::/8)';
  return null;
}

/**
 * Why this address is off limits, or null when it is fair game.
 *
 * Text that is not an address at all answers with a reason rather than with
 * null: something that claims to be an IP and does not parse is refused, not
 * waved through, because every caller reaches this with a value it is about to
 * open a socket to.
 */
export function blockedAddressReason(address) {
  const text = String(address ?? '').replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(text)) return blockedIpv4Reason(ipv4Bytes(text));
  const bytes = ipv6Bytes(text);
  if (bytes) return blockedIpv6Reason(bytes);
  return 'not a usable IP address';
}

/**
 * Se o endereço é rede privada DE CLIENTE: onde mora um GenieACS atrás de VPN,
 * WireGuard ou de um link dedicado — e nada além disso.
 *
 * É o que o modo `tunnel` libera, e a lista é curta de propósito: 10/8,
 * 172.16/12, 192.168/16, CGNAT (100.64/10) e fc00::/7, também quando escritos
 * dentro de um IPv6 que embute IPv4. Loopback, link-local (onde mora o serviço
 * de metadados da nuvem), 0/8 e multicast continuam fora mesmo no túnel: são
 * endereços do PRÓPRIO servidor do painel, e liberá-los faria do túnel de um
 * cliente uma porta para dentro do painel.
 */
export function isCustomerPrivateAddress(address) {
  const text = String(address ?? '').replace(/^\[|\]$/g, '').split('%')[0];
  const v4Privado = ([a, b]) => a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
  if (net.isIPv4(text)) return v4Privado(ipv4Bytes(text));
  const bytes = ipv6Bytes(text);
  if (!bytes) return false;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  const zeroThrough9 = bytes.slice(0, 10).every((byte) => byte === 0);
  const embutido = zeroThrough9 && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0));
  return embutido ? v4Privado(bytes.slice(12)) : false;
}
