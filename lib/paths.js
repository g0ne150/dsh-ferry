/**
 * Path admission for workspace imports: a peer may only materialize files
 * below a directory this instance explicitly trusts.
 * @module dsh-ferry/lib/paths
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether `child` equals or lives below `parent` after lexical resolution.
 * @param {string} parent - absolute directory.
 * @param {string} child - absolute path.
 * @returns {boolean} true when contained.
 */
export function isInside(parent, child) {
  const normalizedParent = path.resolve(parent);
  const normalizedChild = path.resolve(child);
  if (normalizedChild === normalizedParent) return true;
  const prefix = normalizedParent.endsWith(path.sep) ? normalizedParent : `${normalizedParent}${path.sep}`;
  return normalizedChild.startsWith(prefix);
}

/**
 * Canonicalize configured import roots.
 * @param {readonly string[]} roots - configured absolute directories.
 * @returns {Promise<string[]>} canonical absolute roots.
 * @throws when a root is not absolute.
 */
export async function canonicalRoots(roots) {
  const result = [];
  for (const root of roots) {
    if (!path.isAbsolute(root)) throw new Error(`dsh-ferry: importRoots entry "${root}" must be absolute`);
    const real = await fs.realpath(root).catch(() => undefined);
    result.push(real ?? path.resolve(root));
  }
  return [...new Set(result)];
}

/**
 * Resolve the directory an import will write into, canonicalizing the longest
 * existing prefix so a symlink cannot redirect the write outside a root.
 * @param {string} requested - absolute target directory requested by the peer.
 * @param {readonly string[]} roots - canonical import roots; empty allows any directory.
 * @returns {Promise<string>} canonical absolute target directory.
 * @throws when the path is relative, a file, or outside every root.
 */
export async function resolveTargetDir(requested, roots) {
  if (typeof requested !== 'string' || requested === '') throw new Error('dsh-ferry: target directory is empty');
  if (!path.isAbsolute(requested)) throw new Error(`dsh-ferry: target directory "${requested}" must be absolute`);
  if (requested.includes('\0')) throw new Error('dsh-ferry: target directory is invalid');

  const absolute = path.resolve(requested);
  let existing = absolute;
  /** @type {string[]} */
  const rest = [];
  for (;;) {
    const stat = await fs.lstat(existing).catch(() => undefined);
    if (stat !== undefined) {
      if (!stat.isDirectory() && rest.length === 0) {
        throw new Error(`dsh-ferry: target "${absolute}" is not a directory`);
      }
      break;
    }
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`dsh-ferry: target "${absolute}" has no existing ancestor`);
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  const real = await fs.realpath(existing);
  const target = rest.length === 0 ? real : path.join(real, ...rest);

  if (roots.length > 0 && !roots.some((root) => isInside(root, target))) {
    throw new Error(
      `dsh-ferry: target "${target}" is outside importRoots (${roots.join(', ')}); add the directory or push to an allowed path`,
    );
  }
  return target;
}

/**
 * Choose the directory a received workspace lands in.
 *
 * An explicit target always wins. Otherwise the source path is reused only
 * when it already exists locally and is inside an import root (a natural
 * mapping); a missing path is never created blindly. Everything else lands
 * under `incomingRoot`, named after the source workspace and the session id so
 * repeated imports of the same session are deterministic.
 * @param {object} input - mapping input.
 * @param {string} [input.requested] - explicit target directory.
 * @param {string} [input.sourceRoot] - source session working directory.
 * @param {string} [input.sessionId] - source session id.
 * @param {string} input.incomingRoot - configured incoming directory.
 * @param {readonly string[]} input.roots - canonical import roots.
 * @returns {Promise<string>} canonical target directory.
 */
export async function chooseImportTarget({ requested, sourceRoot, sessionId, peerId, incomingRoot, roots }) {
  if (typeof requested === 'string' && requested.trim() !== '') {
    return resolveTargetDir(requested.trim(), roots);
  }
  if (typeof sourceRoot === 'string' && path.isAbsolute(sourceRoot)) {
    const stat = await fs.lstat(sourceRoot).catch(() => undefined);
    if (stat !== undefined && stat.isDirectory()) {
      try {
        return await resolveTargetDir(sourceRoot, roots);
      } catch {
        // Outside the trusted roots; fall through to the incoming directory.
      }
    }
  }
  const rawBase = typeof sourceRoot === 'string' && sourceRoot !== '' ? path.basename(sourceRoot) : 'workspace';
  const base = rawBase.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  return resolveTargetDir(path.join(incomingRoot, `${base}-${workspaceKey({ peerId, sourceRoot, sessionId })}`), roots);
}

/**
 * Stable short name for one source workspace.
 *
 * Keyed by the sending instance and the source path, not by the session: two
 * sessions from the same directory are the same workspace and must land in the
 * same place, or the receiver ends up with a copy per session. The session id
 * remains the fallback for callers that cannot say where a bundle came from.
 * @param {object} input - key input.
 * @param {string} [input.peerId] - sending instance id.
 * @param {string} [input.sourceRoot] - source workspace path.
 * @param {string} [input.sessionId] - session id fallback.
 * @returns {string} eight hex characters.
 */
export function workspaceKey({ peerId, sourceRoot, sessionId }) {
  const seed =
    typeof peerId === 'string' && peerId !== ''
      ? `peer:${peerId}\nroot:${sourceRoot ?? ''}`
      : `session:${sessionId ?? ''}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 8);
}

/**
 * Resolve a path's canonical spelling without requiring it to exist.
 * @param {string} target - absolute path.
 * @returns {Promise<string>} canonical path.
 */
export async function canonicalize(target) {
  const absolute = path.resolve(target);
  try {
    return await fs.realpath(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(await canonicalize(parent), path.basename(absolute));
  }
}
