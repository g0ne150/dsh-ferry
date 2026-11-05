/**
 * Minimal gitignore-style pattern matching used by the workspace transfer
 * planner. It is intentionally self-contained: the Host plugin cannot import
 * DSH or third-party packages, and the workspace walker only needs the subset
 * of gitignore semantics that decides "source file" versus "generated file".
 *
 * Supported: blank lines, `#` comments, `!` negation, trailing `/` for
 * directories, leading or embedded `/` anchoring, `*`, `?`, `**`, and
 * `[...]` character classes. A pattern never matches outside the directory
 * whose ignore file declared it.
 * @module dsh-ferry/lib/ignore
 */

/** Escape one character for a regular expression. */
function reEscape(char) {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

/**
 * Translate one glob path into a regular expression source.
 * @param {string} glob - slash-separated glob without a leading slash.
 * @returns {string} regular expression source.
 */
export function globToRegExp(glob) {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === '*') {
      const doubled = glob[index + 1] === '*';
      if (doubled) {
        const after = glob[index + 2];
        if (after === '/') {
          source += '(?:[^/]+/)*';
          index += 3;
        } else if (after === undefined) {
          source += '.*';
          index += 2;
        } else {
          source += '.*';
          index += 2;
        }
      } else {
        source += '[^/]*';
        index += 1;
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      const end = glob.indexOf(']', index + 1);
      if (end !== -1) {
        let body = glob.slice(index + 1, end);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        source += `[${body.replace(/[\\\]]/g, '\\$&')}]`;
        index = end + 1;
        continue;
      }
    }
    if (char === '\\' && index + 1 < glob.length) {
      source += reEscape(glob[index + 1]);
      index += 2;
      continue;
    }
    source += reEscape(char);
    index += 1;
  }
  return source;
}

/**
 * Compile one ignore line.
 * @param {string} raw - single line of an ignore file.
 * @returns {{ negate: boolean, dirOnly: boolean, anchored: boolean, regex: RegExp } | null}
 */
export function compilePattern(raw) {
  let line = raw.trim();
  if (line === '' || line.startsWith('#')) return null;
  if (line.startsWith('\\#')) line = line.slice(1);
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  }
  if (line === '') return null;
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  let anchored = false;
  if (line.startsWith('/')) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes('/')) {
    anchored = true;
  }
  const source = globToRegExp(line);
  const prefix = anchored ? '^' : '^(?:[^/]+/)*';
  return { negate, dirOnly, anchored, regex: new RegExp(`${prefix}${source}$`) };
}

/**
 * One ordered pattern list. Patterns are tested in declaration order and the
 * last matching pattern wins, matching git's own precedence inside one file.
 */
export class PatternList {
  /**
   * @param {readonly string[]} lines - ignore lines.
   * @param {string} [category] - skip category reported for a match.
   */
  constructor(lines, category = 'ignored') {
    this.category = category;
    this.patterns = [];
    for (const line of lines) {
      const pattern = compilePattern(line);
      if (pattern !== null) this.patterns.push(pattern);
    }
  }

  /**
   * Test one workspace-relative path.
   * @param {string} path - relative POSIX path.
   * @param {boolean} isDir - whether the path names a directory.
   * @returns {boolean | null} `true` ignored, `false` force-included, `null` no opinion.
   */
  test(path, isDir) {
    let verdict = null;
    for (const pattern of this.patterns) {
      if (pattern.dirOnly && !isDir) continue;
      if (pattern.regex.test(path)) verdict = !pattern.negate;
    }
    return verdict;
  }
}

/** `.gitignore` (and `.dsh-ferry-ignore`) lines that are directory-scoped. */
export class IgnoreStack {
  constructor() {
    /** @type {{ base: string, list: PatternList }[]} */
    this.frames = [];
    this.negations = 0;
  }

  /**
   * Add one ignore file.
   * @param {string} base - workspace-relative directory of the ignore file; '' for the root.
   * @param {string} text - file contents.
   * @param {string} [category] - reported skip category.
   */
  push(base, text, category = 'ignored') {
    const lines = text.split(/\r?\n/);
    const list = new PatternList(lines, category);
    for (const pattern of list.patterns) if (pattern.negate) this.negations += 1;
    this.frames.push({ base, list });
  }

  pop() {
    const frame = this.frames.pop();
    if (frame === undefined) return;
    for (const pattern of frame.list.patterns) if (pattern.negate) this.negations -= 1;
  }

  /**
   * Evaluate one path against every active ignore file, outer first.
   * @param {string} path - workspace-relative POSIX path.
   * @param {boolean} isDir - whether it names a directory.
   * @returns {boolean} whether it is ignored.
   */
  ignored(path, isDir) {
    let ignored = false;
    for (const frame of this.frames) {
      let relative = path;
      if (frame.base !== '') {
        if (!path.startsWith(`${frame.base}/`)) continue;
        relative = path.slice(frame.base.length + 1);
      }
      const verdict = frame.list.test(relative, isDir);
      if (verdict !== null) ignored = verdict;
    }
    return ignored;
  }
}

/**
 * Default exclusions: generated output, dependency trees, caches, machine
 * local editor state, and OS noise. Every entry carries the skip category the
 * transfer report groups it under, so the user can tell why bytes stayed home.
 * @type {readonly [string, string][]}
 */
export const DEFAULT_EXCLUDES = [
  // Dependency trees: reproducible from the lockfile on the target.
  ['**/node_modules/', 'dependency'],
  ['**/.pnpm-store/', 'dependency'],
  ['**/bower_components/', 'dependency'],
  ['**/jspm_packages/', 'dependency'],
  ['**/.venv/', 'dependency'],
  ['**/venv/', 'dependency'],
  ['**/__pypackages__/', 'dependency'],
  ['**/.tox/', 'dependency'],
  ['**/.nox/', 'dependency'],
  ['**/.bundle/', 'dependency'],
  ['**/.gradle/', 'dependency'],
  ['**/.m2/', 'dependency'],
  ['**/.nuget/', 'dependency'],
  ['**/Pods/', 'dependency'],
  ['**/.yarn/cache/', 'dependency'],
  ['**/.yarn/unplugged/', 'dependency'],
  ['**/.yarn/install-state.gz', 'dependency'],
  ['**/.yarn/build-state.yml', 'dependency'],
  ['**/.pnp.*', 'dependency'],
  // Build output and tool caches.
  ['**/dist/', 'build'],
  ['**/build/', 'build'],
  ['**/out/', 'build'],
  ['**/.next/', 'build'],
  ['**/.nuxt/', 'build'],
  ['**/.svelte-kit/', 'build'],
  ['**/.turbo/', 'cache'],
  ['**/.parcel-cache/', 'cache'],
  ['**/.vite/', 'cache'],
  ['**/.cache/', 'cache'],
  ['**/.eslintcache', 'cache'],
  ['**/.stylelintcache', 'cache'],
  ['**/coverage/', 'cache'],
  ['**/htmlcov/', 'cache'],
  ['**/.nyc_output/', 'cache'],
  ['**/.pytest_cache/', 'cache'],
  ['**/.mypy_cache/', 'cache'],
  ['**/.ruff_cache/', 'cache'],
  ['**/__pycache__/', 'cache'],
  ['**/*.pyc', 'cache'],
  ['**/*.pyo', 'cache'],
  ['**/.ipynb_checkpoints/', 'cache'],
  ['**/.terraform/', 'cache'],
  ['**/.serverless/', 'cache'],
  ['**/.aws-sam/', 'cache'],
  // Logs, temporary files, OS metadata.
  ['**/*.log', 'cache'],
  ['**/*.tmp', 'cache'],
  ['**/*.temp', 'cache'],
  ['**/.DS_Store', 'cache'],
  ['**/Thumbs.db', 'cache'],
  ['**/desktop.ini', 'cache'],
  // Machine-local editor state.
  ['**/.idea/', 'editor'],
  ['**/.vscode/', 'editor'],
];

/**
 * Credentials and other values that must not travel by default: the receiving
 * host has its own credentials, and a shared token in a workspace file would
 * leak across machines. `.env.example`-style templates are explicitly exempt.
 * @type {readonly string[]}
 */
export const SECRET_PATTERNS = [
  '**/.env',
  '**/.env.local',
  '**/.env.*.local',
  '**/.env.development',
  '**/.env.production',
  '**/.env.test',
  '**/.env.prod',
  '**/.env.production.local',
  '**/.npmrc',
  '**/.yarnrc.yml',
  '**/.netrc',
  '**/.git-credentials',
  '**/.gitconfig.local',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/.ssh/',
  '**/.aws/',
  '**/.kube/config',
  '**/*.kubeconfig',
  '**/.docker/config.json',
  '**/.npmrc.bak',
  '**/credentials.json',
  '**/service-account*.json',
  '**/secrets.json',
  '**/.pypirc',
  '**/.htpasswd',
];

/** Template suffixes that are safe despite the `.env` prefix. */
const SAFE_TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.example.local'];

/** Precompiled credential patterns; `test` is on the hot path of every file. */
const SECRET_LIST = new PatternList(SECRET_PATTERNS, 'secret');

/**
 * Whether one workspace-relative path is a credential file.
 * @param {string} path - relative POSIX path.
 * @param {boolean} isDir - whether it is a directory.
 * @returns {boolean} true when the file must not transfer by default.
 */
export function isSecretPath(path, isDir) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base === '.env') return true;
  if (base.startsWith('.env.')) {
    return !SAFE_TEMPLATE_SUFFIXES.some((suffix) => base.endsWith(suffix));
  }
  return SECRET_LIST.test(path, isDir) === true;
}
