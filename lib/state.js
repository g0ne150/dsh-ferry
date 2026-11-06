/**
 * Compare one stored Session log against a peer's copy, cheaply enough to run
 * before a transfer starts.
 *
 * Both sides hash the same events with the same routine, so a digest computed
 * on the sender matches the receiver's digest for the same prefix. Attachment
 * references are masked: the receiver rewrites them to its own store ids, and
 * that rewrite must not read as "the two copies diverged".
 * @module dsh-ferry/lib/state
 */
import { createHash } from 'node:crypto';

/** Number of trailing events that make up a tail fingerprint. */
export const TAIL_EVENTS = 8;

/** Accepted states for a session that already exists on the receiving side. */
export const SESSION_STATES = ['absent', 'same', 'behind', 'ahead', 'diverged', 'unknown'];

/**
 * Feed one JSON value into a hash in a canonical, key-sorted form.
 * @param {import('node:crypto').Hash} hash - target hash.
 * @param {unknown} value - JSON value.
 */
function updateHash(hash, value) {
  if (value === null || value === undefined) {
    hash.update('null');
    return;
  }
  const type = typeof value;
  if (type === 'string') {
    hash.update(JSON.stringify(value));
    return;
  }
  if (type === 'number') {
    hash.update(Number.isFinite(value) ? String(value) : 'null');
    return;
  }
  if (type === 'boolean') {
    hash.update(value ? 'true' : 'false');
    return;
  }
  if (Array.isArray(value)) {
    hash.update('[');
    for (const item of value) {
      updateHash(hash, item);
      hash.update(',');
    }
    hash.update(']');
    return;
  }
  if (type !== 'object') {
    hash.update('null');
    return;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  // The receiver stores its own attachment ids; identity of those blobs is not
  // part of the session log's meaning for comparison purposes.
  if (typeof record.attachmentId === 'string') {
    hash.update('"#attachment"');
    return;
  }
  hash.update('{');
  for (const key of Object.keys(record).sort()) {
    hash.update(JSON.stringify(key));
    hash.update(':');
    updateHash(hash, record[key]);
    hash.update(',');
  }
  hash.update('}');
}

/**
 * Digest one contiguous slice of a session log.
 * @param {readonly object[]} events - session events, in seq order.
 * @param {number} [from] - first index to include.
 * @param {number} [to] - one past the last index to include.
 * @returns {string} hex digest.
 */
export function hashEvents(events, from = 0, to = events.length) {
  const hash = createHash('sha256');
  for (let index = from; index < to; index += 1) {
    updateHash(hash, events[index]);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Fingerprint the last few events of a log.
 * @param {readonly object[]} events - session events, in seq order.
 * @returns {{ from: number, count: number, hash: string }} fingerprint.
 */
export function tailOf(events) {
  const from = Math.max(0, events.length - TAIL_EVENTS);
  return { from, count: events.length - from, hash: hashEvents(events, from) };
}

/**
 * Accept a tail fingerprint from the wire, or report that it is unusable.
 * @param {unknown} value - candidate.
 * @returns {{ from: number, count: number, hash: string } | undefined} fingerprint.
 */
export function readTail(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isSafeInteger(record.from) || record.from < 0) return undefined;
  if (!Number.isSafeInteger(record.count) || record.count < 0 || record.count > TAIL_EVENTS) return undefined;
  if (typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.hash)) return undefined;
  return { from: /** @type {number} */ (record.from), count: /** @type {number} */ (record.count), hash: record.hash };
}

/**
 * Classify a receiver's copy against the sender's session.
 *
 * The answer is from the receiver's point of view: `behind` means the receiver
 * may append the sender's remaining events, `same` means both logs hash alike,
 * and `diverged` means both continued from the same base but disagree.
 * @param {{ count: number, tail?: { hash: string } }} local - receiver's log.
 * @param {{ count: number | undefined, tail?: { hash: string } }} remote - sender's log.
 * @returns {'absent'|'same'|'behind'|'ahead'|'diverged'|'unknown'} state.
 */
export function classifySession(local, remote) {
  if (local === undefined || local === null) return 'absent';
  if (typeof remote?.count !== 'number') return 'unknown';
  if (local.count < remote.count) return 'behind';
  if (local.count > remote.count) return 'ahead';
  if (typeof local.tail?.hash !== 'string' || typeof remote.tail?.hash !== 'string') return 'same';
  return local.tail.hash === remote.tail.hash ? 'same' : 'diverged';
}
