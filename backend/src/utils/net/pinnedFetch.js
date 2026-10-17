/**
 * The one transport every outbound request whose destination came from data
 * goes through: resolve with the resolver the socket will actually use, check
 * every answer against `blockedRanges.js`, then connect to the address that was
 * checked and to no other, reading at most a stated number of bytes back.
 *
 * Three separate holes closed by putting it in one place.
 *
 * The first is the split resolver. `ssrfGuard` validated a hostname with
 * `dns.resolve4`/`dns.resolve6` — the DNS protocol — and then handed the NAME to
 * `fetch`, which resolves through `getaddrinfo`. Those are different resolvers
 * answering from different sources: `/etc/hosts`, a Compose `extra_hosts:`, a
 * container name, NSS, mDNS. Everything the system resolver knows and DNS does
 * not was validated as public and then connected to as private. With
 * `127.0.0.1 vm` in `/etc/hosts`, `http://vm/` passed the check and reached
 * loopback. `dns.lookup` is `getaddrinfo`, so the answer that is vetted here is
 * the answer the connection would have got.
 *
 * The second is the gap between checking and connecting. Vetting a name and
 * then letting an HTTP client resolve it a second time closes nothing: the two
 * answers need not agree, and whoever controls the zone makes sure they do not.
 * So the address vetted here is the address connected to — pinned through the
 * `lookup` hook, with the original hostname still in the `Host` header and in
 * the TLS SNI so the certificate check stays honest. Node's global `fetch`
 * cannot express that: it takes no resolver, and `Host` is a forbidden header
 * there, so pointing it at the vetted IP would silently send the wrong name.
 * That is why this is `node:http`/`node:https` and not `fetch`.
 *
 * The third is the unbounded read. Buffering an answer with no ceiling means
 * the far end chooses this process's memory: a 200 MiB body took RSS from
 * 62 MB to 1133 MB. Every caller now states a ceiling; over it, the socket is
 * destroyed and the call rejects rather than returning a truncated body that
 * something downstream would try to parse.
 *
 * Nothing here follows a redirect. A 3xx arrives as an ordinary not-ok
 * response, which is what a caller that must not be redirected wants, and what
 * a caller that may follow one (`safeFetch`) needs in order to re-vet the next
 * hop itself.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { blockedAddressReason, isCustomerPrivateAddress } from './blockedRanges.js';

/** Tag on the error a body over the ceiling raises, so a caller can tell it apart. */
export const RESPONSE_TOO_LARGE = 'EGRESS_RESPONSE_TOO_LARGE';

export class ResponseTooLargeError extends Error {
  constructor(limit, where) {
    super(`Response from ${where} passed the ${limit}-byte ceiling and was discarded`);
    this.name = 'ResponseTooLargeError';
    this.code = RESPONSE_TOO_LARGE;
  }
}

/**
 * The ceiling for a caller that does not state one. Sized for an API answer,
 * which is what most of these are; the two callers that move real payloads —
 * a WhatsApp attachment, a GenieACS device listing — say so explicitly.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function headersToObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return { ...headers };
}

/**
 * Rebuilds the upstream answer as a real `Response`, so that every call site
 * keeps reading `.ok`, `.status`, `.text()`, `.body` and `.headers.get()`
 * exactly as it did when this went through `fetch`.
 */
function toResponse(res, body) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, single);
      } catch {
        // A header the upstream should not have sent is not a reason to fail
        // the request; the ones the panel reads are well-formed or absent.
      }
    }
  }

  // 204/205/304 may not carry a body at all, and the `Response` constructor
  // enforces that — handing it the empty buffer anyway would throw here and
  // surface as a panel bug rather than as the upstream answer it is.
  const empty = body.length === 0 || [204, 205, 304].includes(res.statusCode);
  const statusText = /^[\t\x20-\x7e]*$/.test(res.statusMessage || '') ? res.statusMessage : undefined;

  return new Response(empty ? null : body, {
    status: res.statusCode,
    ...(statusText ? { statusText } : {}),
    headers
  });
}

/**
 * A promise that never settles until the signal aborts, and then rejects with
 * whatever the signal carries — a `TimeoutError` from `AbortSignal.timeout`,
 * the caller's own reason otherwise. Raced against a lookup, it is what lets a
 * deadline end the wait for a resolver that has stopped answering.
 */
function aborted(signal) {
  let solta;
  const promise = new Promise((_resolve, reject) => {
    solta = () => reject(signal.reason);
    signal.addEventListener('abort', solta, { once: true });
  });
  // Removed by hand once the race is over: `safeFetch` shares one signal across
  // every hop, and a listener left behind on each of them is a leak that
  // announces itself as a MaxListeners warning long before it matters.
  promise.dispose = () => signal.removeEventListener('abort', solta);
  return promise;
}

/** Brackets are the URL notation for a v6 literal, not part of the address. */
export function bareHostname(hostname) {
  return String(hostname ?? '').replace(/^\[|\]$/g, '');
}

export class PinnedTransport {
  /**
   * Name resolution, as one overridable slot.
   *
   * `dns.lookup` and not `dns.resolve*`: this is `getaddrinfo`, the same call
   * the socket would make, so what is checked here is what would have been
   * connected to. A test drives a rebinding-shaped answer through this slot —
   * a public address on the first look, a private one on the second — without
   * reaching the network for a name it would have to own.
   */
  static lookup(hostname) {
    return dns.promises.lookup(hostname, { all: true });
  }

  /**
   * Every address the destination resolves to, in `{ address, family }` form.
   *
   * A literal is its own answer: there is nothing to re-resolve, so there is
   * nothing to pin, and it is still classified by the caller because naming
   * 127.0.0.1 outright is the easy attempt.
   *
   * A name that resolves to nothing answers with an empty list rather than
   * throwing. The callers want different things from that — one refuses, one
   * treats it as "not private, and the connection will fail on its own" — and
   * neither wants an NXDOMAIN reported as a blocked address.
   *
   * `signal` bounds the WAIT, not the query. `getaddrinfo` has no cancel — the
   * c-ares resolver does, which is what the previous DNS-protocol check used —
   * so an abort here stops holding the caller and leaves the lookup to finish
   * into nothing. Holding the caller is the harm a deadline exists to prevent;
   * a query still sitting in the threadpool is not. The abort is raised, not
   * folded into the empty list, because "the clock ran out" and "this name has
   * no address" are different answers and the caller reports them differently.
   */
  static async addressesFor(hostname, lookup, signal) {
    const host = bareHostname(hostname);
    if (net.isIP(host)) {
      return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
    }
    const resolve = lookup || ((name) => this.lookup(name));
    if (signal?.aborted) throw signal.reason;
    let answer;
    const corrida = signal ? aborted(signal) : null;
    try {
      answer = await (corrida ? Promise.race([resolve(host), corrida]) : resolve(host));
    } catch {
      if (signal?.aborted) throw signal.reason;
      return [];
    } finally {
      corrida?.dispose();
    }
    return (Array.isArray(answer) ? answer : [answer])
      .filter((entry) => entry && entry.address)
      .map((entry) => ({
        address: entry.address,
        family: entry.family ?? (net.isIPv6(entry.address) ? 6 : 4)
      }));
  }

  /**
   * The resolve-and-check half, shared by every guarded path.
   *
   * EVERY answer is checked, not the first: a name that resolves to one public
   * address and one loopback address is a rebinding attempt that does not even
   * need a second lookup — a client walking the list on a failed connect gets
   * there on its own.
   *
   * `refuse` builds the caller's own error, because the three callers report a
   * refusal in three different vocabularies and each of their callers already
   * matches on one of them.
   */
  static async vetTarget(hostname, {
    lookup, signal, allowPrivateAddresses = false, allowPrivateRanges = false, refuse
  } = {}) {
    const host = bareHostname(hostname);
    const addresses = await this.addressesFor(host, lookup, signal);
    if (allowPrivateAddresses) return addresses;
    for (const { address } of addresses) {
      const reason = blockedAddressReason(address);
      // `allowPrivateRanges` é o modo túnel: só a rede privada de cliente passa
      // (`isCustomerPrivateAddress`); loopback e metadados continuam fora.
      if (reason && !(allowPrivateRanges && isCustomerPrivateAddress(address))) {
        throw refuse(
          `${host} resolves to ${address}, which is ${reason} and cannot be reached from here`,
          { hostname: host, address, reason }
        );
      }
    }
    return addresses;
  }

  /**
   * A `fetch`-shaped call that connects only to the vetted addresses.
   *
   * The caller has already decided `addresses` is acceptable; this opens the
   * socket to them and to nothing else, reads at most `maxBytes`, and hands
   * back a `Response`.
   */
  static request({
    url,
    hostname,
    port,
    addresses,
    method = 'GET',
    headers: rawHeaders,
    body: rawBody,
    signal,
    rejectUnauthorized = true,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES
  }) {
    const parsed = url instanceof URL ? url : new URL(String(url));
    const host = bareHostname(hostname ?? parsed.hostname);
    const targetPort = port ?? (parsed.port
      ? Number(parsed.port)
      : (parsed.protocol === 'https:' ? 443 : 80));
    const pinned = addresses ?? [];
    if (pinned.length === 0) {
      return Promise.reject(new Error(`${host} did not resolve to any address`));
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const headers = headersToObject(rawHeaders);
    const body = rawBody === undefined || rawBody === null
      ? null
      : Buffer.from(typeof rawBody === 'string' || Buffer.isBuffer(rawBody) || ArrayBuffer.isView(rawBody)
        ? rawBody
        : String(rawBody));

    if (body && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(body.length);
    }

    return new Promise((resolve, reject) => {
      // An abort raises whatever the signal carries — a `TimeoutError` from
      // `AbortSignal.timeout`, the caller's own reason otherwise — instead of
      // Node's generic socket error, so a deadline still reads as a deadline.
      const fail = (error) => reject(signal?.aborted ? signal.reason : error);

      const request = transport.request({
        protocol: parsed.protocol,
        hostname: host,
        port: targetPort,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        signal,
        // Only meaningful over TLS, and only ever false because an operator
        // told us their upstream carries a self-signed certificate. It costs
        // the certificate's identity check and nothing else: the address was
        // vetted and pinned below, so turning this off cannot redirect the
        // connection somewhere new — it can only stop us noticing that the host
        // we already decided to reach presents a name we did not verify.
        ...(parsed.protocol === 'https:' ? { rejectUnauthorized } : {}),
        // The whole point. `host` above still drives the `Host` header and the
        // TLS server name; only the address the socket goes to is replaced,
        // with one already vetted, so no second resolution can happen.
        lookup: (_name, lookupOptions, done) => {
          if (lookupOptions?.all) done(null, pinned);
          else done(null, pinned[0].address, pinned[0].family);
        }
      }, (res) => {
        // An honest oversized body costs nothing to refuse; the running total
        // below is what catches a server that declares no length, or lies.
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          request.destroy();
          reject(new ResponseTooLargeError(maxBytes, host));
          return;
        }

        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            // Destroyed rather than truncated: half a document parses as
            // nothing useful, and handing back a fragment invites a caller to
            // act on it.
            chunks.length = 0;
            res.destroy();
            request.destroy();
            reject(new ResponseTooLargeError(maxBytes, host));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('end', () => {
          try {
            resolve(toResponse(res, Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on('error', fail);
      if (body) request.write(body);
      request.end();
    });
  }
}

export default PinnedTransport;
