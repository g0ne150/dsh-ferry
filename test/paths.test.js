import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalRoots, chooseImportTarget, isInside, resolveTargetDir } from '../lib/paths.js';
import { isSafeRelativePath, resolveBelow } from '../lib/workspace.js';

test('relative path safety rejects traversal and absolute forms', () => {
  assert.equal(isSafeRelativePath('src/a.js'), true);
  assert.equal(isSafeRelativePath('./a'), false);
  assert.equal(isSafeRelativePath('../a'), false);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('C:/x'), false);
  assert.equal(isSafeRelativePath('a//b'), false);
  assert.equal(isSafeRelativePath('a\\b'), false);
});

test('resolveBelow refuses escapes', () => {
  const root = path.resolve('/tmp/ferry-root');
  assert.equal(resolveBelow(root, 'a/b.txt'), path.join(root, 'a/b.txt'));
  assert.throws(() => resolveBelow(root, '../x'), /unsafe relative path/);
});

test('import roots constrain the target directory', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-roots-'));
  const roots = await canonicalRoots([home]);
  try {
    const inside = await resolveTargetDir(path.join(home, 'work', 'project'), roots);
    assert.equal(inside, path.join(await fs.realpath(home), 'work', 'project'));
    await assert.rejects(() => resolveTargetDir('/etc/ferry-nope', roots), /outside importRoots/);
    assert.equal(isInside(home, path.join(home, 'a')), true);
    assert.equal(isInside(home, `${home}-other`), false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('a symlinked parent cannot redirect an import outside the root', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-outside-'));
  try {
    await fs.symlink(outside, path.join(rootDir, 'link'));
    const roots = await canonicalRoots([rootDir]);
    await assert.rejects(() => resolveTargetDir(path.join(rootDir, 'link', 'x'), roots), /outside importRoots/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('received workspaces reuse an existing mapped directory, else the incoming root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-map-'));
  const source = path.join(root, 'projects', 'alpha');
  await fs.mkdir(source, { recursive: true });
  const roots = await canonicalRoots([root]);
  const incomingRoot = path.join(root, 'incoming');
  try {
    const reused = await chooseImportTarget({
      sourceRoot: source,
      sessionId: 'session-0123456789abcdef',
      incomingRoot,
      roots,
    });
    assert.equal(reused, await fs.realpath(source));

    const explicit = path.join(root, 'elsewhere');
    const requested = await chooseImportTarget({
      requested: explicit,
      sourceRoot: source,
      sessionId: 'session-0123456789abcdef',
      incomingRoot,
      roots,
    });
    assert.equal(requested, path.join(await fs.realpath(root), 'elsewhere'));

    const missing = await chooseImportTarget({
      sourceRoot: path.join(root, 'projects', 'missing'),
      sessionId: 'session-0123456789abcdef',
      incomingRoot,
      roots,
    });
    assert.equal(missing, path.join(await fs.realpath(root), 'incoming', 'missing-01234567'));

    const outside = await chooseImportTarget({
      sourceRoot: '/etc',
      sessionId: 'session-abcdef0123456789',
      incomingRoot,
      roots,
    });
    assert.equal(outside, path.join(await fs.realpath(root), 'incoming', 'etc-abcdef01'));

    await assert.rejects(
      () =>
        chooseImportTarget({
          sourceRoot: '/etc',
          sessionId: 'session-abcdef0123456789',
          incomingRoot: '/tmp/ferry-not-in-root',
          roots,
        }),
      /outside importRoots/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
