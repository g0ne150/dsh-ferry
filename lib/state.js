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

/**
 * Payload fields that hold a sequence number pointing at another event. They
 * move when a log is renumbered, so they are compared as "a reference exists"
 * rather than by value.
 */
const SEQ_REFERENCE_KEYS = new Set([
  'headerSeq',
  'sourceEventSeq',
  'sourceEventSeqs',
  'messageSeqs',
  'shadowedSeqs',
  'shadowedRange',
]);

/**
 * Version of the comparison rules. Two instances that disagree cannot compare
 * fingerprints, so a mismatch is reported as such instead of as divergence.
 */
export const HASH_VERSION = 2;

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
    // Sequence references are derived positions, not content: an append that
    // renumbers its tail must not read as a different conversation.
    if (SEQ_REFERENCE_KEYS.has(key)) hash.update('"#seq"');
    else updateHash(hash, record[key]);
    hash.update(',');
  }
  hash.update('}');
}

/**
 * Event types each instance writes for its own runtime, not as conversation.
 *
 * DSH records the locally chosen model, sandbox mode, permission preset, and a
 * seed marker on open. Two instances that ever opened the same session hold
 * their own copies of these events, stamped with their own clocks and values;
 * requiring them to match would report divergence on every healthy pair.
 */
export const LOCAL_EVENT_TYPES = new Set([
  'session/end-seed',
  'model/selection',
  'sandbox/mode',
  'permission/preset',
  'agent-preset/selected',
  'plan/mode',
  'working-directory/change',
  'goal/change',
  'session/title',
  'feedback/record',
  'feedback/message-put',
  'feedback/message-delete',
]);

/**
 * Whether one event belongs to the shared conversation rather than local state.
 * @param {object} event - session event.
 * @returns {boolean} true when both copies must agree on it.
 */
export function isConversationEvent(event) {
  return event === null || typeof event !== 'object' || !LOCAL_EVENT_TYPES.has(event.type);
}

/**
 * Keep only the events both instances must agree on.
 * @param {readonly object[]} events - session events, in seq order.
 * @returns {object[]} conversation events.
 */
export function conversationEvents(events) {
  return events.filter(isConversationEvent);
}

/**
 * Drop the one field that is written locally rather than carried in the log.
 *
 * DSH appends a `session/end-seed` marker when a session is opened, stamped
 * with the local clock. Two instances that open the same session therefore
 * hold the same event at the same seq with different times; that difference is
 * not a divergence, and treating it as one blocks every legitimate append.
 * @param {object} event - session event.
 * @returns {object} event as compared.
 */
function comparableEvent(event) {
  if (event === null || typeof event !== 'object') return event;
  // Position is the array index; the stored number moves when a tail is
  // renumbered onto a peer's log, so it must not decide equality.
  const { seq: _seq, ...rest } = event;
  if (rest.type === 'session/end-seed' && 'time' in rest) {
    const { time: _time, ...withoutTime } = rest;
    return withoutTime;
  }
  return rest;
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
    updateHash(hash, comparableEvent(events[index]));
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
  return { from, count: events.length - from, hash: hashEvents(events, from), version: HASH_VERSION };
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
  const version = Number.isSafeInteger(record.version) ? /** @type {number} */ (record.version) : undefined;
  return {
    from: /** @type {number} */ (record.from),
    count: /** @type {number} */ (record.count),
    hash: record.hash,
    ...(version === undefined ? {} : { version }),
  };
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
