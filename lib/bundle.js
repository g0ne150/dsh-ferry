/**
 * The dsh-ferry wire format: one gzipped stream carrying a JSON manifest, then
 * the manifest's payloads in order, each framed by its exact byte length.
 *
 * Framing exists so the receiver can stream gigabyte-sized workspaces with
 * backpressure instead of buffering them, while still verifying every file by
 * the SHA-256 the sender computed before the transfer started.
 * @module dsh-ferry/lib/bundle
 */
import { createHash } from 'node:crypto';

/** First bytes of every bundle. */
export const BUNDLE_MAGIC = Buffer.from('DSH-FERRY-BUNDLE/1\n', 'utf8');
/** Protocol identity sent in headers and the manifest. */
export const PROTOCOL = 'dsh-ferry/1';
/** Largest manifest JSON the receiver accepts. */
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/**
 * Encode one frame header.
 * @param {number} length - payload length.
 * @returns {Buffer} ten digits and a newline.
 */
function frameHeader(length) {
  return Buffer.from(`${String(length).padStart(10, '0')}\n`, 'ascii');
}

/**
 * Encode one bundle as a sequence of buffers.
 * @param {object} manifest - bundle manifest; `entries` must be in payload order.
 * @param {(entry: object) => AsyncIterable<Uint8Array>} openEntry - payload source.
 * @returns {AsyncGenerator<Buffer>} framed bytes.
 */
export async function* encodeBundle(manifest, openEntry) {
  yield BUNDLE_MAGIC;
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(`dsh-ferry: manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  yield frameHeader(manifestBytes.length);
  yield manifestBytes;
  for (const entry of manifest.entries) {
    if (!Number.isSafeInteger(entry.bytes)) continue;
    yield frameHeader(entry.bytes);
    if (entry.bytes === 0) continue;
    let sent = 0;
    for await (const chunk of openEntry(entry)) {
      if (chunk.length === 0) continue;
      sent += chunk.length;
      if (sent > entry.bytes) {
        throw new Error(`dsh-ferry: entry "${entry.path ?? entry.name}" produced more bytes than declared`);
      }
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    if (sent !== entry.bytes) {
      throw new Error(
        `dsh-ferry: entry "${entry.path ?? entry.name}" produced ${sent} bytes but declared ${entry.bytes}`,
      );
    }
  }
  yield frameHeader(0);
}

/** Streaming reader over an async iterable of byte chunks. */
export class BundleReader {
  /**
   * @param {AsyncIterable<Uint8Array>} source - decoded (gunzipped) bytes.
   */
  constructor(source) {
    this.iterator = source[Symbol.asyncIterator]();
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.consumed = 0;
  }

  /** Pull the next source chunk into the buffer. */
  async pull() {
    if (this.ended) throw new Error('dsh-ferry: bundle ended unexpectedly');
    const next = await this.iterator.next();
    if (next.done === true) {
      this.ended = true;
      throw new Error('dsh-ferry: bundle ended unexpectedly');
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /**
   * Read exactly `length` bytes.
   * @param {number} length - byte count.
   * @returns {Promise<Buffer>} the bytes.
   */
  async take(length) {
    while (this.buffer.length < length) await this.pull();
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    this.consumed += length;
    return out;
  }

  /**
   * Read exactly `length` bytes as a stream of chunks without copying.
   * @param {number} length - byte count.
   * @returns {AsyncGenerator<Buffer>} the bytes.
   */
  async *chunks(length) {
    let remaining = length;
    while (remaining > 0) {
      if (this.buffer.length === 0) await this.pull();
      const take = Math.min(remaining, this.buffer.length);
      const out = this.buffer.subarray(0, take);
      this.buffer = this.buffer.subarray(take);
      remaining -= take;
      this.consumed += take;
      yield out;
    }
  }

  /**
   * Read one frame header.
   * @returns {Promise<number>} payload length.
   */
  async frameLength() {
    const header = await this.take(11);
    const text = header.toString('ascii');
    if (!/^\d{10}\n$/.test(text)) throw new Error('dsh-ferry: malformed bundle frame header');
    return Number.parseInt(text.slice(0, 10), 10);
  }

  /**
   * Read the magic line and the manifest frame.
   * @returns {Promise<object>} parsed manifest.
   */
  async readManifest() {
    const magic = await this.take(BUNDLE_MAGIC.length);
    if (!magic.equals(BUNDLE_MAGIC)) throw new Error('dsh-ferry: not a dsh-ferry bundle');
    const length = await this.frameLength();
    if (length <= 0 || length > MAX_MANIFEST_BYTES) throw new Error('dsh-ferry: invalid manifest length');
    const bytes = await this.take(length);
    let manifest;
    try {
      manifest = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error(`dsh-ferry: manifest is not valid JSON (${String(error)})`);
    }
    if (manifest === null || typeof manifest !== 'object') throw new Error('dsh-ferry: manifest is not an object');
    if (manifest.protocol !== PROTOCOL) {
      throw new Error(`dsh-ferry: unsupported protocol ${JSON.stringify(manifest.protocol)}`);
    }
    if (!Array.isArray(manifest.entries)) throw new Error('dsh-ferry: manifest has no entries');
    return manifest;
  }

  /**
   * Read one entry payload while verifying its size and digest.
   * @param {{ bytes: number, sha256?: string }} entry - manifest entry.
   * @returns {AsyncGenerator<Buffer>} verified payload chunks.
   */
  async *readEntry(entry) {
    const declared = await this.frameLength();
    if (declared !== entry.bytes) {
      throw new Error(`dsh-ferry: entry "${entry.path ?? entry.name}" frame length ${declared} disagrees with the manifest`);
    }
    const hash = createHash('sha256');
    let count = 0;
    for await (const chunk of this.chunks(entry.bytes)) {
      count += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
    if (count !== entry.bytes) throw new Error('dsh-ferry: entry byte count mismatch');
    const digest = hash.digest('hex');
    if (typeof entry.sha256 === 'string' && digest !== entry.sha256) {
      throw new Error(`dsh-ferry: checksum mismatch for "${entry.path ?? entry.name}"`);
    }
  }

  /**
   * Read one entry payload completely, verifying its digest.
   * @param {{ bytes: number, sha256?: string }} entry - manifest entry.
   * @returns {Promise<Buffer>} verified payload.
   */
  async readEntryBuffer(entry) {
    const parts = [];
    for await (const chunk of this.readEntry(entry)) parts.push(chunk);
    return Buffer.concat(parts);
  }

  /** Consume the end frame and reject trailing data. */
  async finish() {
    const length = await this.frameLength();
    if (length !== 0) throw new Error('dsh-ferry: bundle has trailing frames');
    const extra = await this.iterator.next();
    if (extra.done !== true) throw new Error('dsh-ferry: bundle has trailing bytes');
  }
}

/**
 * Validate a manifest against receiver limits before any byte is written.
 * @param {object} manifest - parsed manifest.
 * @param {{ maxFileBytes: number, maxTotalBytes: number, maxSessionBytes?: number, maxEntries?: number }} limits - receiver limits.
 * @returns {object} the same manifest, narrowed.
 */
export function validateManifest(manifest, limits) {
  const entries = manifest.entries;
  if (entries.length > (limits.maxEntries ?? 200_000)) throw new Error('dsh-ferry: too many entries');
  let total = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') throw new Error('dsh-ferry: malformed entry');
    const payloadKind = entry.kind === 'session' || entry.kind === 'attachment';
    if (!payloadKind && entry.type !== 'file' && entry.type !== 'dir' && entry.type !== 'symlink') {
      throw new Error(`dsh-ferry: unsupported entry type ${JSON.stringify(entry.type)}`);
    }
    if (payloadKind) {
      if (typeof entry.name !== 'string' || entry.name === '') throw new Error('dsh-ferry: payload without a name');
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('dsh-ferry: bad payload size');
      if (entry.kind === 'session' && entry.bytes > (limits.maxSessionBytes ?? 256 * 1024 * 1024)) {
        throw new Error('dsh-ferry: session payload exceeds the receiver limit');
      }
      total += entry.bytes;
      continue;
    }
    if (typeof entry.path !== 'string' || entry.path === '') throw new Error('dsh-ferry: entry without a path');
    if (entry.type === 'file') {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('dsh-ferry: bad entry size');
      if (entry.bytes > limits.maxFileBytes) {
        throw new Error(`dsh-ferry: "${entry.path}" exceeds the ${limits.maxFileBytes} byte file limit`);
      }
      total += entry.bytes;
    }
    if (entry.type === 'symlink' && (typeof entry.link !== 'string' || entry.link === '')) {
      throw new Error('dsh-ferry: symlink without a target');
    }
  }
  if (total > limits.maxTotalBytes) {
    throw new Error(`dsh-ferry: workspace exceeds the ${limits.maxTotalBytes} byte limit`);
  }
  return manifest;
}
