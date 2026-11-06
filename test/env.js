/**
 * Test fixtures: an in-memory stand-in for the Host services a transfer uses,
 * plus a bundle builder that frames payloads exactly like the sender does.
 * Not a test file itself; `node --test 'test/*.test.js'` never loads it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeBundle } from '../lib/bundle.js';
import { normalizeConfig } from '../lib/config.js';
import { tailOf } from '../lib/state.js';
import { createTransfer } from '../lib/transfer.js';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** One synthetic session event. */
export const event = (seq) => ({ seq, type: 'message', at: 1000 + seq, data: { text: `event ${seq}` } });

/** A contiguous run of synthetic events. */
export const events = (from, to) => Array.from({ length: to - from }, (_, index) => event(from + index));

/** Yield one buffer as an entry payload. */
export async function* once(buffer) {
  if (buffer !== undefined && buffer.length > 0) yield buffer;
}

/**
 * Build a receiver- or sender-side fake of the Host services.
 * @returns {Promise<object>} environment.
 */
export async function makeEnv() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ferry-env-')));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const config = normalizeConfig({
    importRoots: [root],
    dataDir: path.join(root, 'data'),
    workspace: { incomingRoot: path.join(root, 'incoming') },
  });

  /** @type {Map<string, { header: object, events: object[] }>} */
  const sessions = new Map();
  const handle = (record, access) => ({
    id: record.header.id,
    header: record.header,
    inheritedEventCount: 0,
    access,
    async read(offset = 0, length) {
      return {
        eventState: 'owned',
        events: record.events.slice(offset, length === undefined ? undefined : offset + length),
      };
    },
    async append(batch) {
      record.events.push(...batch);
    },
    async flush() {},
    async close() {},
  });
  const persistence = {
    async stat(id) {
      const record = sessions.get(id);
      return record === undefined ? undefined : { header: record.header, revision: `r${record.events.length}` };
    },
    async list() {
      return [...sessions.values()].map((record) => ({ header: record.header }));
    },
    async open(id, access) {
      const record = sessions.get(id);
      if (record === undefined) throw new Error('not found');
      return handle(record, access);
    },
    async create(header) {
      const record = { header, events: [] };
      sessions.set(header.id, record);
      return handle(record, 'write');
    },
  };
  const registry = {
    archivedSessionIds: [],
    unarchived: [],
    async create() {
      return { id: `workspace-${sessions.size}`, async attachSession() {} };
    },
    unarchiveSession(id) {
      registry.unarchived.push(id);
    },
  };
  const ctx = {
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    attachments: {
      async saveFile() {
        throw new Error('no attachments in these fixtures');
      },
      async saveImage() {
        throw new Error('no attachments in these fixtures');
      },
    },
    get() {
      return undefined;
    },
  };
  const transfer = createTransfer({ ctx, config, rules: config.workspace });
  return { root, workspace, config, sessions, registry, ctx, transfer };
}

/**
 * Frame one session bundle the way the sender builds it.
 * @param {object} options - bundle input.
 * @param {string} options.id - session id.
 * @param {object} options.header - session header.
 * @param {object[]} options.events - session events.
 * @param {Array<{ path: string, content: string }>} [options.files] - workspace files.
 * @returns {AsyncIterable<Buffer>} framed bundle.
 */
export function buildBundle({ id, header, events: sessionEvents, files = [] }) {
  const payload = Buffer.from(JSON.stringify({ header, inheritedEventCount: 0, events: sessionEvents }), 'utf8');
  const entries = [
    { kind: 'session', name: 'session.json', bytes: payload.length, sha256: sha256(payload) },
    ...files.map((file) => {
      const bytes = Buffer.from(file.content, 'utf8');
      return { type: 'file', path: file.path, bytes: bytes.length, sha256: sha256(bytes), mode: 0o644, mtimeMs: 1700000000000 };
    }),
  ];
  const manifest = {
    protocol: 'dsh-ferry/1',
    kind: 'session',
    session: { id, eventCount: sessionEvents.length, tail: tailOf(sessionEvents), header },
    workspace: { root: '/source/workspace', included: true, files: [], dirs: [], symlinks: [], bytes: 0, git: 'auto', skipped: [], warnings: [] },
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
  const payloads = new Map([['session.json', payload], ...files.map((file) => [file.path, Buffer.from(file.content, 'utf8')])]);
  return encodeBundle(manifest, (entry) => once(payloads.get(entry.name ?? entry.path)));
}
