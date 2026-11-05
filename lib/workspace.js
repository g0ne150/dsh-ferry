/**
 * Workspace transfer planning.
 *
 * The planner answers one question: which files under a Session's working
 * directory must travel so the work can continue on another DSH instance?
 * The rule set is deliberately conservative about size and secrets, and
 * deliberately complete about source: tracked source, docs, and lockfiles all
 * travel, while dependency trees, build output, caches, credentials, and
 * machine-local editor state stay home (see docs/transfer-scope.md).
 * @module dsh-ferry/lib/workspace
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_EXCLUDES, IgnoreStack, PatternList, compilePattern, isSecretPath } from './ignore.js';

/** Bytes of one file the transfer refuses by default. */
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Bytes of one workspace the transfer refuses by default. */
export const DEFAULT_MAX_WORKSPACE_BYTES = 1024 * 1024 * 1024;
/** Bytes of `.git` the automatic mode is willing to copy. */
export const DEFAULT_MAX_GIT_BYTES = 64 * 1024 * 1024;

/** Skip categories, in the order reports list them. */
export const SKIP_CATEGORIES = [
  'dependency',
  'build',
  'cache',
  'editor',
  'ignored',
  'secret',
  'large',
  'symlink',
  'special',
  'git',
  'user-exclude',
  'internal',
];

const DEFAULT_EXCLUDE_PATTERNS = DEFAULT_EXCLUDES.map(([source, category]) => ({
  source,
  category,
  pattern: compilePattern(source),
}));

/** Files and directories the walker never transfers regardless of configuration. */
const INTERNAL_PREFIX = '.dsh-ferry';

/**
 * Normalize the workspace rules object from plugin config.
 * @param {unknown} raw - configuration slice.
 * @returns {{ git: 'auto'|'include'|'skip', respectGitignore: boolean, exclude: string[], include: string[], includeSecrets: boolean, maxFileBytes: number, maxWorkspaceBytes: number, maxGitBytes: number, symlinks: 'inside'|'skip' }}
 */
export function normalizeWorkspaceRules(raw = {}) {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  const git = value.git ?? 'auto';
  if (!['auto', 'include', 'skip'].includes(git)) {
    throw new Error(`dsh-ferry: workspace.git must be auto, include, or skip (got ${String(git)})`);
  }
  const symlinks = value.symlinks ?? 'inside';
  if (!['inside', 'skip'].includes(symlinks)) {
    throw new Error(`dsh-ferry: workspace.symlinks must be inside or skip (got ${String(symlinks)})`);
  }
  return {
    git,
    respectGitignore: value.respectGitignore !== false,
    exclude: stringArray(value.exclude, 'workspace.exclude'),
    include: stringArray(value.include, 'workspace.include'),
    includeSecrets: value.includeSecrets === true,
    maxFileBytes: positiveInt(value.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'workspace.maxFileBytes'),
    maxWorkspaceBytes: positiveInt(
      value.maxWorkspaceBytes,
      DEFAULT_MAX_WORKSPACE_BYTES,
      'workspace.maxWorkspaceBytes',
    ),
    maxGitBytes: positiveInt(value.maxGitBytes, DEFAULT_MAX_GIT_BYTES, 'workspace.maxGitBytes'),
    symlinks,
  };
}

/** @param {unknown} value @param {string} name @returns {string[]} */
function stringArray(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`dsh-ferry: ${name} must be a list of strings`);
  }
  return value.map((item) => item.trim()).filter((item) => item !== '');
}

/** @param {unknown} value @param {number} fallback @param {string} name @returns {number} */
function positiveInt(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-ferry: ${name} must be a positive integer`);
  }
  return value;
}

/**
 * Record one skipped path in the report accumulator.
 * @param {Map<string, { count: number, bytes: number, samples: string[] }>} target - accumulator.
 * @param {string} category - skip category.
 * @param {string} rel - relative path.
 * @param {number} [bytes] - known size.
 */
function noteSkipped(target, category, rel, bytes = 0) {
  let entry = target.get(category);
  if (entry === undefined) {
    entry = { count: 0, bytes: 0, samples: [] };
    target.set(category, entry);
  }
  entry.count += 1;
  entry.bytes += bytes;
  if (entry.samples.length < 5) entry.samples.push(rel);
}

/**
 * Whether an exact relative path is safe against path traversal.
 * @param {string} rel - candidate relative path.
 * @returns {boolean} true when the path is normalized, relative, and non-empty.
 */
export function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return false;
  if (rel.includes('\\')) return false;
  if (path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false;
  const segments = rel.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Resolve one relative manifest path below a root directory.
 * @param {string} root - absolute target directory.
 * @param {string} rel - manifest path.
 * @returns {string} absolute path.
 * @throws when the path is unsafe or escapes the root.
 */
export function resolveBelow(root, rel) {
  if (!isSafeRelativePath(rel)) throw new Error(`dsh-ferry: unsafe relative path ${JSON.stringify(rel)}`);
  const absolute = path.resolve(root, ...rel.split('/'));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw new Error(`dsh-ferry: path escapes the workspace: ${JSON.stringify(rel)}`);
  }
  return absolute;
}

/**
 * Hash one file and return its digest and size.
 * @param {string} absolute - file path.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ sha256: string, bytes: number }>} digest and byte count.
 */
export async function hashFile(absolute, signal) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(absolute)) {
    signal?.throwIfAborted();
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Find the default exclusion that applies to one path, if any.
 * @param {string} rel - relative path.
 * @param {boolean} isDir - whether the path is a directory.
 * @returns {string | null} skip category.
 */
function defaultExcludeCategory(rel, isDir) {
  for (const candidate of DEFAULT_EXCLUDE_PATTERNS) {
    const pattern = candidate.pattern;
    if (pattern === null) continue;
    if (pattern.dirOnly && !isDir) continue;
    if (pattern.regex.test(rel)) return candidate.category;
  }
  return null;
}

/**
 * Plan a workspace transfer.
 * @param {object} options - planning options.
 * @param {string} options.root - absolute working directory.
 * @param {ReturnType<typeof normalizeWorkspaceRules>} options.rules - transfer rules.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{ root: string, entries: Array<object>, files: number, dirs: number, symlinks: number, bytes: number, git: object, skipped: Array<object>, warnings: Array<object>, overLimit: boolean }>}
 */
export async function planWorkspace({ root, rules, signal }) {
  const absoluteRoot = path.resolve(root);
  const rootStat = await fs.lstat(absoluteRoot).catch((error) => {
    throw new Error(`dsh-ferry: workspace "${absoluteRoot}" is not readable (${error.code ?? error.message})`);
  });
  if (!rootStat.isDirectory()) throw new Error(`dsh-ferry: workspace "${absoluteRoot}" is not a directory`);

  /** @type {Array<object>} */
  const entries = [];
  /** @type {Map<string, { count: number, bytes: number, samples: string[] }>} */
  const skipped = new Map();
  /** @type {Array<object>} */
  const warnings = [];
  const includeList = new PatternList(rules.include);
  const excludeList = new PatternList(rules.exclude, 'user-exclude');
  let files = 0;
  let dirs = 0;
  let symlinks = 0;
  let bytes = 0;

  /** @param {object} entry - manifest entry to record. */
  const record = (entry) => {
    entries.push(entry);
    if (entry.type === 'file') {
      files += 1;
      bytes += entry.size;
    } else if (entry.type === 'dir') dirs += 1;
    else symlinks += 1;
  };

  /**
   * Decide whether a directory should be pruned.
   * @param {string} rel - relative directory path.
   * @param {IgnoreStack} ignores - active ignore stack.
   * @returns {{ category: string } | null} skip category when pruned.
   */
  const dirSkip = (rel, ignores) => {
    if (includeList.test(rel, true) === true) return null;
    if (isSecretPath(rel, true)) return { category: 'secret' };
    if (ignores.ignored(rel, true)) return { category: 'ignored' };
    const category = defaultExcludeCategory(rel, true);
    if (category !== null) return { category };
    if (excludeList.test(rel, true) === true) return { category: 'user-exclude' };
    return null;
  };

  /**
   * Read the ignore files that apply to one directory.
   * @param {string} rel - relative directory path ('' for the root).
   * @param {IgnoreStack} ignores - active stack.
   */
  const pushIgnores = async (rel, ignores) => {
    const base = path.join(absoluteRoot, ...(rel === '' ? [] : rel.split('/')));
    if (rules.respectGitignore) {
      const text = await fs.readFile(path.join(base, '.gitignore'), 'utf8').catch(() => undefined);
      if (text !== undefined) ignores.push(rel, text, 'ignored');
    }
    const ferry = await fs.readFile(path.join(base, '.dsh-ferry-ignore'), 'utf8').catch(() => undefined);
    if (ferry !== undefined) ignores.push(rel, ferry, 'ignored');
  };

  /**
   * Walk one directory.
   * @param {string} rel - relative directory path ('' for the root).
   * @param {IgnoreStack} ignores - active ignore stack.
   */
  const walk = async (rel, ignores) => {
    signal?.throwIfAborted();
    const depthBefore = ignores.frames.length;
    await pushIgnores(rel, ignores);
    const absoluteDir = path.join(absoluteRoot, ...(rel === '' ? [] : rel.split('/')));
    let dirents;
    try {
      dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      warnings.push({ code: 'directoryUnreadable', path: rel, message: String(error.code ?? error.message) });
      ignores.frames.length = depthBefore;
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      signal?.throwIfAborted();
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      if (dirent.name.startsWith(INTERNAL_PREFIX)) {
        noteSkipped(skipped, 'internal', childRel);
        continue;
      }
      if (dirent.name === '.git') continue;
      let stat;
      try {
        stat = await fs.lstat(path.join(absoluteDir, dirent.name));
      } catch (error) {
        warnings.push({ code: 'entryUnreadable', path: childRel, message: String(error.code ?? error.message) });
        continue;
      }
      if (stat.isSymbolicLink()) {
        const link = await fs.readlink(path.join(absoluteDir, dirent.name)).catch(() => undefined);
        const target = link === undefined ? undefined : path.posix.normalize(path.posix.join(path.posix.dirname(childRel), link));
        const inside = target !== undefined && !path.isAbsolute(link) && isSafeRelativePath(target);
        if (rules.symlinks === 'skip' || link === undefined || !inside) {
          noteSkipped(skipped, 'symlink', childRel);
          continue;
        }
        record({ type: 'symlink', path: childRel, link });
        continue;
      }
      if (stat.isDirectory()) {
        const skip = dirSkip(childRel, ignores);
        if (skip !== null) {
          noteSkipped(skipped, skip.category, `${childRel}/`);
          continue;
        }
        record({
          type: 'dir',
          path: childRel,
          mode: stat.mode & 0o777,
          mtimeMs: Math.floor(stat.mtimeMs),
        });
        await walk(childRel, ignores);
        continue;
      }
      if (!stat.isFile()) {
        noteSkipped(skipped, 'special', childRel);
        continue;
      }
      if (stat.size > rules.maxFileBytes) {
        noteSkipped(skipped, 'large', childRel, stat.size);
        continue;
      }
      const forced = includeList.test(childRel, false) === true;
      if (!forced) {
        if (!rules.includeSecrets && isSecretPath(childRel, false)) {
          noteSkipped(skipped, 'secret', childRel, stat.size);
          continue;
        }
        if (ignores.ignored(childRel, false)) {
          noteSkipped(skipped, 'ignored', childRel, stat.size);
          continue;
        }
        const category = defaultExcludeCategory(childRel, false);
        if (category !== null) {
          noteSkipped(skipped, category, childRel, stat.size);
          continue;
        }
        if (excludeList.test(childRel, false) === true) {
          noteSkipped(skipped, 'user-exclude', childRel, stat.size);
          continue;
        }
      }
      record({
        type: 'file',
        path: childRel,
        size: stat.size,
        mode: stat.mode & 0o777,
        mtimeMs: Math.floor(stat.mtimeMs),
      });
    }
    ignores.frames.length = depthBefore;
  };

  await walk('', new IgnoreStack());

  // `.git` is opt-in by size: history is valuable for continuation, but a huge
  // pack file is exactly the data a clone on the target should fetch instead.
  /** @type {{ present: boolean, mode: 'included'|'skipped'|'absent', bytes: number, reason?: string }} */
  const git = { present: false, mode: 'absent', bytes: 0 };
  const gitPath = path.join(absoluteRoot, '.git');
  const gitStat = await fs.lstat(gitPath).catch(() => undefined);
  if (gitStat !== undefined) {
    git.present = true;
    if (!gitStat.isDirectory()) {
      git.mode = 'skipped';
      git.reason = 'worktree-pointer';
      warnings.push({ code: 'gitSkippedWorktree' });
    } else if (rules.git === 'skip') {
      git.mode = 'skipped';
      git.reason = 'configured';
    } else {
      const gitPlan = await planGit(absoluteRoot, rules.maxGitBytes, signal);
      git.bytes = gitPlan.bytes;
      if (gitPlan.tooLarge) {
        git.mode = 'skipped';
        git.reason = 'too-large';
        warnings.push({ code: 'gitSkippedTooLarge', bytes: gitPlan.bytes, limit: rules.maxGitBytes });
      } else {
        git.mode = 'included';
        for (const entry of gitPlan.entries) record(entry);
        if (await gitConfigLooksCredentialed(absoluteRoot)) {
          warnings.push({ code: 'gitConfigMayHoldCredentials' });
        }
      }
    }
    if (git.mode === 'skipped') noteSkipped(skipped, 'git', '.git/');
  }

  const overLimit = bytes > rules.maxWorkspaceBytes;
  if (overLimit) warnings.push({ code: 'workspaceOverLimit', bytes, limit: rules.maxWorkspaceBytes });

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    root: absoluteRoot,
    entries,
    files,
    dirs,
    symlinks,
    bytes,
    git,
    skipped: SKIP_CATEGORIES.filter((category) => skipped.has(category)).map((category) => ({
      category,
      ...skipped.get(category),
    })),
    warnings,
    overLimit,
  };
}

/**
 * Plan the `.git` directory separately so its size cap can apply as a whole.
 * @param {string} root - workspace root.
 * @param {number} maxBytes - hard cap.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ entries: Array<object>, bytes: number, tooLarge: boolean }>}
 */
async function planGit(root, maxBytes, signal) {
  /** @type {Array<object>} */
  const entries = [];
  let bytes = 0;
  let tooLarge = false;
  const base = path.join(root, '.git');
  /** @param {string} rel @returns {Promise<void>} */
  const walk = async (rel) => {
    if (tooLarge) return;
    signal?.throwIfAborted();
    const dir = path.join(base, ...(rel === '' ? [] : rel.split('/')));
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (tooLarge) return;
      const childRel = `.git/${rel === '' ? dirent.name : `${rel}/${dirent.name}`}`;
      const innerRel = childRel.slice('.git/'.length);
      if (innerRel.startsWith('worktrees/') || innerRel.startsWith('lfs/tmp/') || innerRel.endsWith('.lock')) {
        continue;
      }
      const stat = await fs.lstat(path.join(dir, dirent.name)).catch(() => undefined);
      if (stat === undefined) continue;
      if (stat.isDirectory()) {
        entries.push({ type: 'dir', path: childRel, mode: stat.mode & 0o777 });
        await walk(innerRel);
        continue;
      }
      if (!stat.isFile()) continue;
      bytes += stat.size;
      if (bytes > maxBytes) {
        tooLarge = true;
        return;
      }
      entries.push({
        type: 'file',
        path: childRel,
        size: stat.size,
        mode: stat.mode & 0o777,
        mtimeMs: Math.floor(stat.mtimeMs),
        git: true,
      });
    }
  };
  await walk('');
  return { entries: tooLarge ? [] : entries, bytes, tooLarge };
}

/**
 * Whether `.git/config` contains an embedded credential (a URL with `user@`).
 * @param {string} root - workspace root.
 * @returns {Promise<boolean>} true when the repository config looks credentialed.
 */
async function gitConfigLooksCredentialed(root) {
  const text = await fs.readFile(path.join(root, '.git', 'config'), 'utf8').catch(() => undefined);
  if (text === undefined) return false;
  return /:\/\/[^/\s@]+@/.test(text);
}

/**
 * Hash every planned file, producing the manifest entries the bundle carries.
 * Hashing happens before the stream starts so the receiver can verify each
 * byte and the sender can report an accurate total.
 * @param {object} plan - result of {@link planWorkspace}.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {number} [concurrency] - parallel hash operations.
 * @returns {Promise<Array<object>>} manifest entries.
 */
export async function hashPlan(plan, signal, concurrency = 4) {
  const result = new Array(plan.entries.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= plan.entries.length) return;
      const entry = plan.entries[index];
      if (entry.type !== 'file') {
        result[index] = { ...entry };
        continue;
      }
      signal?.throwIfAborted();
      const digest = await hashFile(path.join(plan.root, ...entry.path.split('/')), signal);
      result[index] = { ...entry, bytes: digest.bytes, sha256: digest.sha256 };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.entries.length) }, worker));
  return result;
}
