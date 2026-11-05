/**
 * Peer authentication for dsh-ferry.
 *
 * Every request between instances is signed with a shared secret that never
 * travels on the wire. The signature covers the claimed peer, the HTTP method,
 * the exact request path, a timestamp, and a nonce; receivers reject stale or
 * replayed requests. Transport encryption is the operator's job (Tailscale,
 * WireGuard, or a trusted LAN) — this module only proves "the holder of the
 * secret sent this request".
 * @module dsh-ferry/lib/auth
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Protocol version carried in headers. */
export const AUTH_VERSION = '1';
/** Accepted clock skew, in milliseconds. */
export const MAX_SKEW_MS = 5 * 60 * 1000;

/** @typedef {{ peerId: string, token: string }} PeerSecret */

/**
 * Compute the canonical string a signature covers.
 * @param {object} input - request facts.
 * @param {string} input.peerId - claimed peer id.
 * @param {string} input.method - HTTP method.
 * @param {string} input.path - request path including query.
 * @param {string} input.timestamp - millisecond timestamp.
 * @param {string} input.nonce - one-time value.
 * @returns {string} canonical text.
 */
export function canonicalRequest({ peerId, method, path, timestamp, nonce }) {
  return ['dsh-ferry/v1', peerId, method.toUpperCase(), path, timestamp, nonce].join('\n');
}

/**
 * Sign one request.
 * @param {object} input - request facts plus the secret.
 * @param {string} input.secret - shared secret.
 * @returns {Record<string, string>} headers to attach.
 */
export function signRequest({ secret, peerId, method, path, timestamp, nonce }) {
  const ts = timestamp ?? String(Date.now());
  const fresh = nonce ?? randomBytes(16).toString('hex');
  const signature = createHmac('sha256', secret)
    .update(canonicalRequest({ peerId, method, path, timestamp: ts, nonce: fresh }), 'utf8')
    .digest('hex');
  return {
    'x-ferry-version': AUTH_VERSION,
    'x-ferry-peer': peerId,
    'x-ferry-timestamp': ts,
    'x-ferry-nonce': fresh,
    'x-ferry-signature': signature,
  };
}

/**
 * Compare two hex signatures without leaking their difference position.
 * @param {string} expected - computed signature.
 * @param {string} received - supplied signature.
 * @returns {boolean} true when equal.
 */
function equalSignature(expected, received) {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Bounded replay memory: one nonce is accepted once inside the skew window.
 */
export class NonceWindow {
  /** @param {number} [capacity] - maximum remembered nonces. */
  constructor(capacity = 20_000) {
    this.capacity = capacity;
    /** @type {Map<string, number>} */
    this.seen = new Map();
  }

  /**
   * Record one nonce.
   * @param {string} key - peer id plus nonce.
   * @param {number} now - current time.
   * @returns {boolean} false when the nonce was already used.
   */
  accept(key, now) {
    this.prune(now);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next();
      if (oldest.done !== true) this.seen.delete(oldest.value);
    }
    return true;
  }

  /** @param {number} now - current time. */
  prune(now) {
    for (const [key, at] of this.seen) {
      if (now - at > MAX_SKEW_MS) this.seen.delete(key);
      else break;
    }
  }
}

/**
 * Verify one inbound request against the configured peer secrets.
 * @param {object} input - request facts.
 * @param {Record<string, string | string[] | undefined>} input.headers - node request headers (lowercase).
 * @param {string} input.method - HTTP method.
 * @param {string} input.path - path including query.
 * @param {readonly PeerSecret[]} input.secrets - accepted secrets.
 * @param {NonceWindow} input.nonces - replay window.
 * @param {number} [input.now] - current time, for tests.
 * @param {number} [input.maxSkewMs] - accepted clock skew.
 * @returns {{ ok: true, peerId: string } | { ok: false, reason: string, status: number }} outcome.
 */
export function verifyRequest({ headers, method, path, secrets, nonces, now = Date.now(), maxSkewMs = MAX_SKEW_MS }) {
  const version = header(headers, 'x-ferry-version');
  const peerId = header(headers, 'x-ferry-peer');
  const timestamp = header(headers, 'x-ferry-timestamp');
  const nonce = header(headers, 'x-ferry-nonce');
  const signature = header(headers, 'x-ferry-signature');
  if (version !== AUTH_VERSION) return { ok: false, reason: 'unsupported-auth-version', status: 401 };
  if (peerId === undefined || peerId === '' || peerId.length > 128) return { ok: false, reason: 'missing-peer', status: 401 };
  if (timestamp === undefined || !/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp', status: 401 };
  if (nonce === undefined || !/^[0-9a-f]{8,64}$/.test(nonce)) return { ok: false, reason: 'bad-nonce', status: 401 };
  if (signature === undefined || !/^[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'bad-signature', status: 401 };
  const at = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(at) || Math.abs(now - at) > maxSkewMs) return { ok: false, reason: 'stale', status: 401 };

  const candidates = secrets.filter((candidate) => candidate.peerId === peerId);
  const fallback = secrets.filter((candidate) => candidate.peerId !== peerId);
  // A peer that this instance only serves (never calls) need not be named in
  // config; any configured secret is accepted for an unknown caller.
  for (const candidate of [...candidates, ...fallback]) {
    if (typeof candidate.token !== 'string' || candidate.token === '') continue;
    const expected = createHmac('sha256', candidate.token)
      .update(canonicalRequest({ peerId, method, path, timestamp, nonce }), 'utf8')
      .digest('hex');
    if (!equalSignature(expected, signature)) continue;
    if (!nonces.accept(`${peerId}:${nonce}`, now)) return { ok: false, reason: 'replayed', status: 401 };
    return { ok: true, peerId };
  }
  return { ok: false, reason: 'unauthenticated', status: 401 };
}

/**
 * Read one header value from a node header bag.
 * @param {Record<string, string | string[] | undefined>} headers - request headers.
 * @param {string} name - lowercase header name.
 * @returns {string | undefined} the value.
 */
export function header(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
