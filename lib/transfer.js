/**
 * Session + workspace transfer: read a Session's durable log, pair it with the
 * attachments it references and the workspace files it needs, and rebuild the
 * same Session on another instance.
 *
 * The session log is copied verbatim (same events, same sequence numbers), so
 * the receiving Agent resumes exactly where the sender stopped. Only the
 * immutable header's identity and working directory are remapped.
 * @module dsh-ferry/lib/transfer
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BundleReader, PROTOCOL, encodeBundle, validateManifest } from './bundle.js';
import { HttpError } from './http.js';
import { canonicalRoots, chooseImportTarget } from './paths.js';
import { classifySession, hashEvents, readTail, tailOf } from './state.js';
import { hashFile, hashPlan, planWorkspace, resolveBelow } from './workspace.js';

/** Event types whose payload may embed an attachment reference. */
const ATTACHMENT_ID = /^(?:sha256:)?[0-9a-f]{64}$/;

/**
 * Walk one JSON value and collect attachment references.
 * @param {unknown} value - event payload.
 * @param {Map<string, object>} found - accumulator keyed by attachment id.
 */
function collectAttachments(value, found) {
  if (Array.isArray(value)) {
    for (const item of value) collectAttachments(item, found);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = /** @type {Record<string, unknown>} */ (value);
  const id = record.attachmentId;
  if (typeof id === 'string' && ATTACHMENT_ID.test(id)) {
    if (typeof record.mediaType === 'string' && typeof record.width === 'number') {
      found.set(id, {
        attachmentId: id,
        mediaType: record.mediaType,
        bytes: typeof record.bytes === 'number' ? record.bytes : 0,
        width: record.width,
        height: record.height,
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
      });
    } else if (typeof record.name === 'string') {
      found.set(id, {
        attachmentId: id,
        name: record.name,
        bytes: typeof record.bytes === 'number' ? record.bytes : 0,
      });
    }
  }
  for (const key of Object.keys(record)) collectAttachments(record[key], found);
}

/**
 * Replace attachment references in a copied session payload.
 * @param {unknown} value - JSON value.
 * @param {Map<string, object>} replacements - old attachment id to new reference.
 * @returns {unknown} a rewritten copy.
 */
export function rewriteAttachmentRefs(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => rewriteAttachmentRefs(item, replacements));
  if (value === null || typeof value !== 'object') return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  const id = record.attachmentId;
  if (typeof id === 'string' && replacements.has(id)) {
    const next = replacements.get(id);
    return { ...record, ...next };
  }
  const out = {};
  for (const key of Object.keys(record)) out[key] = rewriteAttachmentRefs(record[key], replacements);
  return out;
}

/**
 * Build a session transfer engine over the live Host services.
 * @param {object} options - engine options.
 * @param {import('@deepseek-ai/cordis').Context} options.ctx - plugin context.
 * @param {object} options.config - normalized plugin config.
 * @param {object} options.rules - normalized workspace rules.
 * @param {(message: string) => void} [options.log] - logger.
 * @returns {object} transfer operations.
 */
export function createTransfer({ ctx, config, rules, log = () => {} }) {
  /** @type {string[] | null} */
  let roots = null;
  let formatProbe = null;
  // Optional service: absent in minimal compositions and never required for a
  // transfer, so it is resolved once instead of being declared in `inject`.
  const sessionQuery = ctx.get('sessionQuery');

  /** @returns {Promise<string[]>} canonical import roots. */
  const importRoots = async () => {
    if (roots === null) roots = await canonicalRoots(config.importRoots);
    return roots;
  };

  /**
   * Decide where a received workspace lands.
   *
   * An explicit target always wins. Otherwise the source path is reused only
   * when this instance already has that directory (a natural mapping); a path
   * that does not exist here is not created blindly. Everything else lands
   * under the configured incoming root, in a directory named after the source
   * workspace and the session id so repeated imports stay deterministic.
   * @param {object} input - mapping input.
   * @param {string} [input.requested] - explicit target directory.
   * @param {string} [input.sourceRoot] - source session working directory.
   * @param {string} [input.sessionId] - source session id, for the fallback name.
   * @returns {Promise<string>} canonical target directory.
   */
  const resolveImportTarget = async ({ requested, sourceRoot, sessionId }) =>
    chooseImportTarget({
      requested,
      sourceRoot,
      sessionId,
      incomingRoot: config.incomingRoot,
      roots: await importRoots(),
    });

  /**
   * The target instance's current session format version, from any stored
   * session. `undefined` means this instance has no session to compare with.
   * @returns {Promise<number | undefined>} version.
   */
  const currentFormatVersion = async () => {
    if (formatProbe !== null && Date.now() - formatProbe.at < 10_000) return formatProbe.version;
    const snapshots = await ctx.sessionPersistence.list();
    const version = snapshots[0]?.header.version;
    formatProbe = { at: Date.now(), version };
    return version;
  };

  /**
   * Read one complete session log, preferring the live copy.
   * @param {string} sessionId - session identity.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{ session: object, inheritedEventCount: number, events: object[] }>}
   */
  const readSnapshot = async (sessionId, signal) => {
    if (sessionQuery !== undefined) {
      const snapshot = await sessionQuery.readSession(sessionId);
      return { session: snapshot.session, inheritedEventCount: snapshot.inheritedEventCount, events: snapshot.events };
    }
    const handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal });
    try {
      const result = await handle.read(undefined, undefined, { signal });
      return {
        session: handle.header,
        inheritedEventCount: handle.inheritedEventCount,
        events: [...result.events],
      };
    } finally {
      await handle.close();
    }
  };

  /**
   * Whether the session's Agent currently runs a turn.
   * @param {string} sessionId - session identity.
   * @returns {boolean} true while running.
   */
  const isRunning = (sessionId) => {
    const agent = ctx.get('agents')?.get(sessionId);
    return agent !== undefined && agent.status === 'running';
  };

  /**
   * Whether this process already holds the session open. A live Agent keeps the
   * single-writer handle, so an append from a transfer would be refused by the
   * backend; report it as a state instead of a 500.
   * @param {string} sessionId - session identity.
   * @returns {boolean} true when an Agent owns the session here.
   */
  const isSessionLoaded = (sessionId) => ctx.get('agents')?.get(sessionId) !== undefined;

  /**
   * List local sessions for the picker.
   * @param {object} [options] - listing options.
   * @param {boolean} [options.all] - include subagent sessions.
   * @param {boolean} [options.includeArchived] - include archived sessions.
   * @returns {Promise<{ sessions: object[] }>} summaries.
   */
  const listLocalSessions = async ({ all = false, includeArchived = false } = {}) => {
    /** @type {Map<string, object>} */
    const rows = new Map();
    const archived = new Set(includeArchived ? [] : ctx.workspaceRegistry.archivedSessionIds);
    const controller = ctx.get('sessionController');
    if (controller !== undefined) {
      try {
        const page = await controller.list({}, AbortSignal.timeout(15_000));
        for (const item of page.items) {
          if (!all && item.origin === 'subagent') continue;
          if (archived.has(item.sessionId)) continue;
          const projectedTitle = item.projections?.values?.title;
          rows.set(item.sessionId, {
            sessionId: item.sessionId,
            ...(typeof projectedTitle === 'string' && projectedTitle !== '' ? { title: projectedTitle } : {}),
            cwd: item.cwd,
            updatedAt: item.updatedAt,
            running: item.running,
            blank: item.blank,
          });
        }
      } catch (error) {
        log(`dsh-ferry: session list fallback (${String(error)})`);
      }
    }
    if (rows.size === 0) {
      const records =
        sessionQuery !== undefined
          ? await sessionQuery.listSessions()
          : (await ctx.sessionPersistence.list()).map((snapshot) => ({ header: snapshot.header }));
      for (const record of records) {
        if (!all && record.header.origin === 'subagent') continue;
        if (archived.has(record.header.id)) continue;
        rows.set(record.header.id, {
          sessionId: record.header.id,
          cwd: record.header.cwd,
          updatedAt: record.header.createdAt,
          running: isRunning(record.header.id),
          blank: false,
          agentPreset: record.header.agentPreset,
        });
      }
    }
    const sessions = [...rows.values()];
    // Titles missing from the projection fall back to the log fold; a session
    // without a title event is normal and stays untitled.
    await Promise.all(
      sessions
        .filter((row) => row.title === undefined)
        .map(async (row) => {
          if (sessionQuery === undefined) return;
          try {
            const title = await sessionQuery.readTitle(row.sessionId);
            if (title?.title !== undefined) row.title = title.title;
            if (title?.updatedAt !== undefined) row.updatedAt = Math.max(row.updatedAt ?? 0, title.updatedAt);
          } catch {
            // Optional.
          }
        }),
    );
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { sessions };
  };

  /**
   * Describe one local session and its transfer plan without reading file bytes.
   * @param {string} sessionId - session identity.
   * @param {object} [options] - options.
   * @param {AbortSignal} [options.signal] - cancellation.
   * @param {'auto'|'include'|'skip'} [options.git] - git handling.
   * @returns {Promise<object>} description.
   */
  const describeSession = async (sessionId, { signal, git } = {}) => {
    const snapshot = await readSnapshot(sessionId, signal);
    const header = snapshot.session;
    if (header.cwd === undefined) throw new HttpError(409, 'no-workspace', 'Session has no working directory');
    if (isRunning(sessionId)) {
      throw new HttpError(409, 'session-running', 'Session is running; stop the turn before transferring it');
    }
    const plan = await planWorkspace({ root: header.cwd, rules: { ...rules, git: git ?? rules.git }, signal });
    /** @type {Map<string, object>} */
    const refs = new Map();
    for (const event of snapshot.events) collectAttachments(event.data, refs);
    const attachmentBytes = [...refs.values()].reduce((sum, ref) => sum + (ref.bytes ?? 0), 0);
    let title;
    try {
      title = sessionQuery === undefined ? undefined : (await sessionQuery.readTitle(sessionId, signal))?.title;
    } catch {
      // Optional.
    }
    const records = await ctx.sessionPersistence.list({ signal });
    const children = records.filter((record) => record.header.parentSession === sessionId).length;
    return {
      session: {
        sessionId,
        title,
        cwd: header.cwd,
        createdAt: header.createdAt,
        eventCount: snapshot.events.length,
        tail: tailOf(snapshot.events),
        inheritedEventCount: snapshot.inheritedEventCount,
        origin: header.origin,
        agentPreset: header.agentPreset,
        formatStatus: records.find((record) => record.header.id === sessionId)?.formatStatus,
        formatVersion: header.version,
        children,
      },
      attachments: { count: refs.size, bytes: attachmentBytes },
      workspace: {
        root: plan.root,
        files: plan.files,
        dirs: plan.dirs,
        symlinks: plan.symlinks,
        bytes: plan.bytes,
        git: plan.git,
        skipped: plan.skipped,
        warnings: plan.warnings,
        overLimit: plan.overLimit,
      },
      totalBytes: plan.bytes + attachmentBytes,
      limits: {
        maxWorkspaceBytes: rules.maxWorkspaceBytes,
        maxFileBytes: rules.maxFileBytes,
        maxGitBytes: rules.maxGitBytes,
      },
    };
  };

  /**
   * Read one attachment into memory, bounded by the configured budget.
   * @param {object} ref - image or file reference.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<Buffer>} exact bytes.
   */
  const readAttachment = async (ref, signal) => {
    if (typeof ref.mediaType === 'string') {
      const stored = await ctx.attachments.readImage(ref, signal);
      return Buffer.from(stored.data);
    }
    const chunks = [];
    for await (const chunk of ctx.attachments.readFileStream(ref, signal)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };

  /**
   * Build a transferable bundle for one session.
   * @param {string} sessionId - session identity.
   * @param {object} [options] - options.
   * @param {AbortSignal} [options.signal] - cancellation.
   * @param {'auto'|'include'|'skip'} [options.git] - git handling.
   * @param {boolean} [options.withWorkspace] - include workspace files (default true).
   * @returns {Promise<{ manifest: object, frames: AsyncGenerator<Buffer>, plan: object }>} bundle.
   */
  const exportSession = async (sessionId, { signal, git, withWorkspace = true } = {}) => {
    const snapshot = await readSnapshot(sessionId, signal);
    const header = snapshot.session;
    if (header.cwd === undefined) throw new HttpError(409, 'no-workspace', 'Session has no working directory');
    if (isRunning(sessionId)) {
      throw new HttpError(409, 'session-running', 'Session is running; stop the turn before transferring it');
    }
    const sessions = ctx.get('sessions');
    const live = sessions?.get(sessionId);
    if (live !== undefined) await sessions.flush(live);

    const plan = withWorkspace
      ? await planWorkspace({ root: header.cwd, rules: { ...rules, git: git ?? rules.git }, signal })
      : { root: header.cwd, entries: [], files: 0, dirs: 0, symlinks: 0, bytes: 0, git: {}, skipped: [], warnings: [] };
    if (plan.overLimit) {
      throw new HttpError(
        413,
        'workspace-too-large',
        `Workspace is ${plan.bytes} bytes, above the ${rules.maxWorkspaceBytes} byte limit`,
      );
    }
    const hashed = withWorkspace ? await hashPlan(plan, signal) : [];

    /** @type {Map<string, object>} */
    const refs = new Map();
    for (const event of snapshot.events) collectAttachments(event.data, refs);
    const warnings = [...plan.warnings];
    /** @type {Array<{ entry: object, data: Buffer }>} */
    const attachmentPayloads = [];
    let attachmentBytes = 0;
    let index = 0;
    for (const ref of refs.values()) {
      signal?.throwIfAborted();
      if (attachmentBytes + ref.bytes > config.maxAttachmentBytes) {
        warnings.push({ code: 'attachmentBudgetExceeded', id: ref.attachmentId });
        continue;
      }
      try {
        const data = await readAttachment(ref, signal);
        attachmentBytes += data.length;
        index += 1;
        attachmentPayloads.push({
          entry: {
            kind: 'attachment',
            name: `attachments/${String(index).padStart(4, '0')}`,
            attachment: ref,
            bytes: data.length,
            sha256: createHash('sha256').update(data).digest('hex'),
          },
          data,
        });
      } catch (error) {
        warnings.push({ code: 'attachmentUnreadable', id: ref.attachmentId, message: String(error) });
      }
    }

    const sessionJson = Buffer.from(
      JSON.stringify({
        header,
        inheritedEventCount: snapshot.inheritedEventCount,
        events: snapshot.events,
      }),
      'utf8',
    );
    if (sessionJson.length > config.maxSessionBytes) {
      throw new HttpError(413, 'session-too-large', `Session log exceeds ${config.maxSessionBytes} bytes`);
    }
    const sessionEntry = {
      kind: 'session',
      name: 'session.json',
      bytes: sessionJson.length,
      sha256: createHash('sha256').update(sessionJson).digest('hex'),
    };

    let title;
    try {
      title = sessionQuery === undefined ? undefined : (await sessionQuery.readTitle(sessionId, signal))?.title;
    } catch {
      // Optional.
    }
    const records = await ctx.sessionPersistence.list({ signal });
    const children = records.filter((record) => record.header.parentSession === sessionId).length;
    if (children > 0) warnings.push({ code: 'childSessionsStayBehind', count: children });
    if (header.parentSession !== undefined) warnings.push({ code: 'parentLineageDangling', parentSession: header.parentSession });
    if (refs.size > 0 && attachmentPayloads.length < refs.size) {
      warnings.push({ code: 'attachmentsIncomplete', total: refs.size, kept: attachmentPayloads.length });
    }

    const manifest = {
      protocol: PROTOCOL,
      kind: 'session',
      createdAt: Date.now(),
      source: {
        instanceId: config.instance.id,
        name: config.instance.name,
        dshVersion: config.dshVersion,
      },
      session: {
        id: sessionId,
        title,
        header,
        inheritedEventCount: snapshot.inheritedEventCount,
        eventCount: snapshot.events.length,
        tail: tailOf(snapshot.events),
        lastSeq: snapshot.events.at(-1)?.seq ?? -1,
        agentPreset: header.agentPreset,
        origin: header.origin,
        formatStatus: records.find((record) => record.header.id === sessionId)?.formatStatus,
        formatVersion: header.version,
        children,
      },
      workspace: {
        root: plan.root,
        included: withWorkspace,
        files: plan.files,
        dirs: plan.dirs,
        symlinks: plan.symlinks,
        bytes: plan.bytes,
        git: plan.git,
        skipped: plan.skipped,
        warnings,
      },
      entries: [sessionEntry, ...attachmentPayloads.map((payload) => payload.entry), ...hashed],
      totalBytes: sessionJson.length + attachmentBytes + plan.bytes,
      warnings,
    };

    const payloadByName = new Map();
    payloadByName.set(sessionEntry.name, sessionJson);
    for (const payload of attachmentPayloads) payloadByName.set(payload.entry.name, payload.data);

    const frames = encodeBundle(manifest, (entry) => {
      if (entry.kind === 'session' || entry.kind === 'attachment') {
        return once(payloadByName.get(entry.name));
      }
      if (entry.type === 'file') {
        return createReadStream(resolveBelow(plan.root, entry.path));
      }
      return once(undefined);
    });
    return { manifest, frames, plan };
  };

  /**
   * Decide what importing over an existing local session means.
   *
   * `exists` is reported only for an identical log: an older copy on this side
   * is an update candidate, never "already there". Divergence is always a
   * refusal — the receiver never rewrites events the sender did not produce.
   * @param {object} request - request.
   * @param {string} request.sessionId - session id present locally.
   * @param {object} request.sourceSession - the sender's manifest session block.
   * @param {boolean} request.update - whether the sender allows appending.
   * @param {AbortSignal} [request.signal] - cancellation.
   * @returns {Promise<{ mode: 'exists' } | { mode: 'update', snapshot: object }>} plan.
   */
  const planExisting = async ({ sessionId, sourceSession, update, signal }) => {
    if (isSessionLoaded(sessionId)) {
      throw new HttpError(
        409,
        'session-active',
        `Session "${sessionId}" is open on this instance; close it or stop its turn before updating it`,
      );
    }
    const local = await readSnapshot(sessionId, signal);
    const remoteCount = typeof sourceSession.eventCount === 'number' ? sourceSession.eventCount : undefined;
    const state = classifySession(
      { count: local.events.length, tail: tailOf(local.events) },
      { count: remoteCount, tail: readTail(sourceSession.tail) },
    );
    if (state === 'same') return { mode: update ? 'update' : 'exists', snapshot: local };
    if (!update) {
      throw new HttpError(
        409,
        'session-conflict',
        `Session "${sessionId}" already exists here with different content; import it under a new id instead`,
      );
    }
    if (state === 'ahead') {
      throw new HttpError(
        409,
        'session-ahead',
        `This instance's copy of "${sessionId}" is longer than the incoming one; import it under a new id instead`,
      );
    }
    if (state === 'diverged') {
      throw new HttpError(
        409,
        'session-diverged',
        `Session "${sessionId}" has diverged from this instance's copy; import it under a new id instead`,
      );
    }
    return { mode: 'update', snapshot: local };
  };

  /**
   * Apply one received bundle.
   * @param {object} options - import options.
   * @param {AsyncIterable<Uint8Array>} options.body - decoded bundle stream.
   * @param {string} [options.targetDir] - target working directory override.
   * @param {boolean} [options.merge] - merge into a non-empty target.
   * @param {boolean} [options.forkId] - import under a fresh session id.
   * @param {boolean} [options.update] - append missing events to an existing session.
   * @param {AbortSignal} [options.signal] - cancellation.
   * @returns {Promise<object>} import result.
   */
  const importSession = async ({ body, targetDir, merge = false, forkId = false, update = false, signal }) => {
    const reader = new BundleReader(body);
    let manifest;
    try {
      manifest = validateManifest(await reader.readManifest(), {
        maxFileBytes: rules.maxFileBytes,
        maxTotalBytes: rules.maxWorkspaceBytes,
        maxSessionBytes: config.maxSessionBytes,
      });
    } catch (error) {
      throw new HttpError(400, 'bad-bundle', error instanceof Error ? error.message : String(error));
    }
    if (manifest.kind !== 'session') throw new HttpError(400, 'bad-bundle', 'Bundle is not a session transfer');
    const sourceSession = manifest.session;
    if (sourceSession === null || typeof sourceSession !== 'object' || typeof sourceSession.header?.id !== 'string') {
      throw new HttpError(400, 'bad-bundle', 'Bundle carries no session header');
    }
    const currentVersion = await currentFormatVersion();
    if (currentVersion !== undefined && sourceSession.header.version !== currentVersion) {
      throw new HttpError(
        409,
        'format-mismatch',
        `Session format v${sourceSession.header.version} cannot be read by this instance (v${currentVersion}); update both DSH installations`,
      );
    }

    const target = await resolveImportTarget({
      requested: targetDir,
      sourceRoot: manifest.workspace?.root,
      sessionId: sourceSession.header.id,
    });

    const requestedId = sourceSession.header.id;
    let sessionId = requestedId;
    /** @type {{ mode: 'create' } | { mode: 'exists' } | { mode: 'update', snapshot: object }} */
    let plan = { mode: 'create' };
    if (forkId) {
      sessionId = `session-${randomUUID()}`;
    } else {
      const existing = await ctx.sessionPersistence.stat(requestedId, { signal });
      if (existing !== undefined) {
        plan = await planExisting({ sessionId: requestedId, sourceSession, update, signal });
        if (plan.mode === 'exists') {
          return {
            status: 'exists',
            sessionId: requestedId,
            targetDir: target,
            message: 'This instance already has this session with the same content',
          };
        }
      }
    }

    const targetStat = await fs.lstat(target).catch(() => undefined);
    let targetNonEmpty = false;
    if (targetStat !== undefined) {
      if (!targetStat.isDirectory()) throw new HttpError(409, 'target-not-directory', `Target "${target}" is not a directory`);
      targetNonEmpty = (await fs.readdir(target)).length > 0;
    }
    // An update rewrites the files the sender changed in place; the backup
    // directory keeps every replaced file recoverable, so it never needs the
    // sender's explicit merge consent.
    if (targetNonEmpty && !merge && plan.mode !== 'update') {
      throw new HttpError(
        409,
        'target-not-empty',
        `Target "${target}" already exists and is not empty; merge explicitly to write into it`,
      );
    }

    const keepTargetGit = (await fs.lstat(path.join(target, '.git')).catch(() => undefined)) !== undefined;
    const stage = path.join(target, `.dsh-ferry-partial-${randomUUID()}`);
    const backupDir = path.join(config.dataDir, 'backups', `${Date.now()}-${sessionId}`);
    await fs.mkdir(stage, { recursive: true });
    await fs.mkdir(target, { recursive: true });

    /** @type {Map<string, object>} */
    const attachmentReplacements = new Map();
    /** @type {object | undefined} */
    let sessionPayload;
    /** @type {Array<{ entry: object }>} */
    const dirs = [];
    const files = [];
    const symlinks = [];
    const warnings = [...(manifest.workspace?.warnings ?? [])];
    let skippedGit = 0;

    try {
      for (const entry of manifest.entries) {
        signal?.throwIfAborted();
        if (entry.kind === 'session') {
          const bytes = await reader.readEntryBuffer(entry);
          const parsed = JSON.parse(bytes.toString('utf8'));
          if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
            throw new HttpError(400, 'bad-bundle', 'Session payload is malformed');
          }
          sessionPayload = parsed;
          continue;
        }
        if (entry.kind === 'attachment') {
          const bytes = await reader.readEntryBuffer(entry);
          const ref = entry.attachment;
          try {
            const stored =
              typeof ref.mediaType === 'string'
                ? await ctx.attachments.saveImage({ data: bytes, mediaType: ref.mediaType, name: ref.name })
                : await ctx.attachments.saveFile({ data: bytes, name: ref.name });
            if (stored.attachmentId !== ref.attachmentId) {
              attachmentReplacements.set(ref.attachmentId, stored);
            }
          } catch (error) {
            warnings.push({ code: 'attachmentWriteFailed', id: ref.attachmentId, message: String(error) });
          }
          continue;
        }
        if (entry.git === true && keepTargetGit) {
          // Still consume and verify the payload so the frame sequence stays aligned.
          for await (const _chunk of reader.readEntry(entry)) {
            // Drain only; the target keeps its own history.
          }
          skippedGit += 1;
          continue;
        }
        if (entry.type === 'dir') {
          dirs.push({ entry });
          await fs.mkdir(resolveBelow(stage, entry.path), { recursive: true });
          continue;
        }
        if (entry.type === 'symlink') {
          symlinks.push({ entry });
          continue;
        }
        // Workspace file: stream into the staging tree, verifying the digest.
        const destination = resolveBelow(stage, entry.path);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const handle = await fs.open(destination, 'w', entry.mode ?? 0o644);
        try {
          for await (const chunk of reader.readEntry(entry)) await handle.write(chunk);
        } finally {
          await handle.close();
        }
        files.push({ entry, staged: destination });
      }
      await reader.finish();
      if (sessionPayload === undefined) throw new HttpError(400, 'bad-bundle', 'Bundle carries no session payload');
      if (!Array.isArray(sessionPayload.events)) throw new HttpError(400, 'bad-bundle', 'Session payload has no events');
      if (typeof sourceSession.eventCount === 'number' && sessionPayload.events.length !== sourceSession.eventCount) {
        throw new HttpError(
          400,
          'bad-bundle',
          `Bundle announced ${sourceSession.eventCount} events but carries ${sessionPayload.events.length}`,
        );
      }

      if (attachmentReplacements.size > 0) {
        sessionPayload = {
          ...sessionPayload,
          events: rewriteAttachmentRefs(sessionPayload.events, attachmentReplacements),
        };
      }
      // An update may only append: prove the receiver's log is an exact prefix
      // of what arrived before touching either the log or the workspace.
      if (plan.mode === 'update') {
        const local = /** @type {{ events: object[] }} */ (plan.snapshot);
        const shared = local.events.length;
        if (
          sessionPayload.events.length < shared ||
          hashEvents(sessionPayload.events, 0, shared) !== hashEvents(local.events, 0, shared)
        ) {
          throw new HttpError(
            409,
            'session-diverged',
            `Session "${sessionId}" has diverged from this instance's copy; import it under a new id instead`,
          );
        }
      }
      const header = {
        ...sessionPayload.header,
        id: sessionId,
        cwd: target,
      };
      const applied = await applyWorkspace({
        target,
        stage,
        dirs,
        files,
        symlinks,
        backupDir,
        signal,
      });
      let workspaceId;
      const workspace = await ctx.workspaceRegistry.create(target);
      workspaceId = workspace.id;
      if (plan.mode === 'update') {
        const shared = /** @type {{ events: object[] }} */ (plan.snapshot).events.length;
        let handle;
        try {
          handle = await ctx.sessionPersistence.open(sessionId, 'write', { signal });
        } catch (error) {
          // The owner can appear between preflight and the upload; report it as
          // the state it is instead of an internal error.
          if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
            throw new HttpError(
              409,
              'session-active',
              `Session "${sessionId}" is open on this instance; close it or restart the instance before updating it`,
            );
          }
          throw error;
        }
        try {
          const events = sessionPayload.events;
          for (let offset = shared; offset < events.length; offset += 200) {
            signal?.throwIfAborted();
            await handle.append(events.slice(offset, offset + 200), { signal });
          }
          await handle.flush({ signal });
        } finally {
          await handle.close();
        }
        try {
          // A previously archived copy would keep the update invisible.
          await ctx.workspaceRegistry.unarchiveSession(sessionId);
        } catch (error) {
          warnings.push({ code: 'workspaceUnarchiveFailed', message: String(error) });
        }
        try {
          await workspace.attachSession(sessionId);
        } catch (error) {
          warnings.push({ code: 'workspaceAttachFailed', message: String(error) });
        }
        return {
          status: 'updated',
          sessionId,
          targetDir: target,
          workspaceId,
          appended: sessionPayload.events.length - shared,
          events: sessionPayload.events.length,
          attachments: { rewritten: attachmentReplacements.size },
          workspace: {
            files: applied.files,
            written: applied.written,
            dirs: dirs.length,
            bytes: applied.bytes,
            overwritten: applied.overwritten,
            unchanged: applied.unchanged,
            skippedGit,
            skipped: manifest.workspace?.skipped ?? [],
            backupDir: applied.overwritten > 0 ? backupDir : undefined,
          },
          warnings,
        };
      }
      const handle = await ctx.sessionPersistence.create(header, {
        signal,
        inheritedEventCount: sessionPayload.inheritedEventCount,
      });
      try {
        const events = sessionPayload.events;
        for (let offset = 0; offset < events.length; offset += 200) {
          signal?.throwIfAborted();
          await handle.append(events.slice(offset, offset + 200), { signal });
        }
        await handle.flush({ signal });
      } finally {
        await handle.close();
      }
      try {
        await workspace.attachSession(sessionId);
      } catch (error) {
        warnings.push({ code: 'workspaceAttachFailed', message: String(error) });
      }
      const preset = header.agentPreset;
      if (preset !== undefined) {
        const presets = await ctx.get('agentPresets')?.list().catch(() => undefined);
        if (Array.isArray(presets) && !presets.some((candidate) => candidate.id === preset)) {
          warnings.push({ code: 'agentPresetMissing', agentPreset: preset });
        }
      }
      return {
        status: 'imported',
        sessionId,
        targetDir: target,
        workspaceId,
        events: sessionPayload.events.length,
        attachments: { rewritten: attachmentReplacements.size },
        workspace: {
          files: applied.files,
          written: applied.written,
          dirs: dirs.length,
          bytes: applied.bytes,
          overwritten: applied.overwritten,
          unchanged: applied.unchanged,
          skippedGit,
          skipped: manifest.workspace?.skipped ?? [],
          backupDir: applied.overwritten > 0 ? backupDir : undefined,
        },
        warnings,
      };
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  };

  /**
   * Prepare an import before bytes are uploaded.
   *
   * The answer is an exchange, not a refusal: the sender needs to know whether
   * the session is absent, already identical, or present in an older state it
   * can append to, so its dialog can offer the sensible choice.
   * @param {object} request - preflight request.
   * @param {string} request.sessionId - source session id.
   * @param {number} [request.eventCount] - source event count.
   * @param {number} [request.createdAt] - source header creation time.
   * @param {number} [request.formatVersion] - source header version.
   * @param {string} [request.sourceRoot] - source workspace path, for mapping.
   * @param {string} [request.targetDir] - requested target.
   * @param {boolean} [request.merge] - requested merge.
   * @param {{ from: number, count: number, hash: string }} [request.tail] - source tail fingerprint.
   * @returns {Promise<object>} decision.
   */
  const preflight = async ({
    sessionId,
    eventCount,
    createdAt,
    formatVersion,
    sourceRoot,
    targetDir,
    merge = false,
    tail,
  }) => {
    const target = await resolveImportTarget({ requested: targetDir, sourceRoot, sessionId });
    const currentVersion = await currentFormatVersion();
    if (formatVersion !== undefined && currentVersion !== undefined && formatVersion !== currentVersion) {
      return {
        ok: false,
        code: 'format-mismatch',
        state: 'unknown',
        message: `This instance runs session format v${currentVersion}, the sender has v${formatVersion}`,
      };
    }

    let state = 'absent';
    let localCount;
    let active = false;
    let archived = false;
    if (typeof sessionId === 'string') {
      const existing = await ctx.sessionPersistence.stat(sessionId);
      if (existing !== undefined) {
        active = isSessionLoaded(sessionId);
        archived = ctx.workspaceRegistry.archivedSessionIds.includes(sessionId);
        let snapshot;
        try {
          snapshot = await readSnapshot(sessionId);
        } catch (error) {
          return {
            ok: false,
            code: 'session-unreadable',
            state: 'unknown',
            active,
            archived,
            targetDir: target,
            message: `Session "${sessionId}" exists here but its log cannot be read: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
        localCount = snapshot.events.length;
        state = classifySession(
          { count: localCount, tail: tailOf(snapshot.events) },
          { count: eventCount, tail: readTail(tail) },
        );
        if (state === 'unknown') {
          // A sender predating tail fingerprints only reports its creation time.
          state = createdAt !== undefined && snapshot.session.createdAt === createdAt ? 'same' : 'diverged';
        }
      }
    }
    const base = { ok: true, state, eventCount: localCount, active, archived, targetDir: target, decision: 'create' };
    if (state === 'same') return { ...base, decision: 'exists' };
    if (state === 'behind') return { ...base, decision: 'update' };
    if (state === 'ahead' || state === 'diverged') {
      // Not a hard failure: a sender that wants a separate copy can still fork
      // past this one. The decision belongs to the caller.
      return {
        ...base,
        decision: 'conflict',
        code: state === 'ahead' ? 'session-ahead' : 'session-diverged',
        message:
          state === 'ahead'
            ? `This instance already has a longer copy of "${sessionId}"`
            : `Session "${sessionId}" already exists here with different content`,
      };
    }

    const stat = await fs.lstat(target).catch(() => undefined);
    if (stat === undefined) return base;
    if (!stat.isDirectory()) {
      return { ...base, ok: false, code: 'target-not-directory', message: `"${target}" is not a directory` };
    }
    const nonEmpty = (await fs.readdir(target)).length > 0;
    if (nonEmpty && !merge) {
      return {
        ...base,
        ok: false,
        code: 'target-not-empty',
        message: `"${target}" already exists and is not empty; merge explicitly to write into it`,
      };
    }
    return { ...base, decision: 'merge' };
  };

  return {
    importRoots,
    currentFormatVersion,
    readSnapshot,
    listLocalSessions,
    describeSession,
    resolveImportTarget,
    exportSession,
    importSession,
    preflight,
  };
}

/**
 * One-shot async iterable over a buffer.
 * @param {Buffer | undefined} buffer - bytes.
 * @returns {AsyncGenerator<Buffer>} bytes.
 */
async function* once(buffer) {
  if (buffer !== undefined && buffer.length > 0) yield buffer;
}

/**
 * Reject a merge that would follow a symlinked parent directory out of the
 * workspace. The manifest paths are already lexical-safe; this closes the
 * remaining hole where an existing target directory is (or contains) a
 * symlink that redirects the write elsewhere.
 * @param {string} root - target directory.
 * @param {string} rel - manifest path.
 * @returns {Promise<void>} resolution when every existing parent is a real directory.
 * @throws {HttpError} when a parent is a symlink or a non-directory.
 */
async function assertRealParents(root, rel) {
  const segments = rel.split('/');
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await fs.lstat(current).catch(() => undefined);
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) {
      throw new HttpError(409, 'target-symlink', `"${rel}" would be written through a symlinked directory`);
    }
    if (!stat.isDirectory()) {
      throw new HttpError(409, 'target-conflict', `"${rel}" would be written through a non-directory`);
    }
  }
}

/**
 * Materialize staged files into the target workspace, backing up every file it
 * replaces so a mistaken merge stays reversible.
 * @param {object} options - apply options.
 * @param {string} options.target - target directory.
 * @param {string} options.stage - staging directory inside the target.
 * @param {Array<{ entry: object }>} options.dirs - directory entries.
 * @param {Array<{ entry: object, staged: string }>} options.files - staged files.
 * @param {Array<{ entry: object }>} options.symlinks - symlink entries.
 * @param {string} options.backupDir - backup directory.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{ files: number, bytes: number, overwritten: number, unchanged: number }>} outcome.
 */
async function applyWorkspace({ target, stage, dirs, files, symlinks, backupDir, signal }) {
  /** @type {Array<() => Promise<void>>} */
  const rollback = [];
  let overwritten = 0;
  let unchanged = 0;
  let bytes = 0;
  try {
    for (const { entry } of dirs) {
      signal?.throwIfAborted();
      await assertRealParents(target, entry.path);
      await fs.mkdir(resolveBelow(target, entry.path), { recursive: true });
    }
    for (const { entry, staged } of files) {
      signal?.throwIfAborted();
      bytes += entry.bytes;
      const destination = resolveBelow(target, entry.path);
      await assertRealParents(target, entry.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const existing = await fs.lstat(destination).catch(() => undefined);
      if (existing !== undefined && existing.isDirectory()) {
        throw new HttpError(409, 'target-conflict', `"${entry.path}" exists as a directory on the target`);
      }
      if (existing !== undefined && existing.isFile() && existing.size === entry.bytes) {
        const digest = await hashFile(destination, signal);
        if (digest.sha256 === entry.sha256) {
          unchanged += 1;
          await fs.rm(staged, { force: true });
          continue;
        }
      }
      if (existing !== undefined) {
        const backup = resolveBelow(backupDir, entry.path);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.copyFile(destination, backup);
        overwritten += 1;
        rollback.push(async () => {
          await fs.copyFile(backup, destination);
        });
      } else {
        rollback.push(async () => {
          await fs.rm(destination, { force: true });
        });
      }
      await fs.rename(staged, destination);
      if (entry.mode !== undefined && process.platform !== 'win32') {
        await fs.chmod(destination, entry.mode & 0o777).catch(() => {});
      }
      if (entry.mtimeMs !== undefined) {
        const time = new Date(entry.mtimeMs);
        await fs.utimes(destination, time, time).catch(() => {});
      }
    }
    for (const { entry } of symlinks) {
      signal?.throwIfAborted();
      const destination = resolveBelow(target, entry.path);
      await assertRealParents(target, entry.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const existing = await fs.lstat(destination).catch(() => undefined);
      if (existing !== undefined) {
        await fs.rm(destination, { force: true, recursive: existing.isDirectory() });
        rollback.push(async () => {});
      } else {
        rollback.push(async () => {
          await fs.rm(destination, { force: true });
        });
      }
      await fs.symlink(entry.link, destination);
    }
    return { files: files.length, written: files.length - unchanged, bytes, overwritten, unchanged };
  } catch (error) {
    for (const undo of rollback.reverse()) {
      await undo().catch(() => {});
    }
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
