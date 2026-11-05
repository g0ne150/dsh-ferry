import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashPlan, normalizeWorkspaceRules, planWorkspace } from '../lib/workspace.js';

async function makeTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-plan-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'index.js'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'package.json'), '{}\n');
  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await fs.writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  await fs.writeFile(path.join(root, 'dist', 'bundle.js'), 'bundle\n');
  await fs.writeFile(path.join(root, 'debug.log'), 'log\n');
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret\n');
  await fs.writeFile(path.join(root, '.env.example'), 'TOKEN=\n');
  await fs.writeFile(path.join(root, '.gitignore'), '*.generated\n');
  await fs.writeFile(path.join(root, 'cache.generated'), 'x\n');
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(root, '.git', 'config'), '[remote "origin"]\n  url = https://example.com/x.git\n');
  await fs.writeFile(path.join(root, '.git', 'objects', 'blob'), Buffer.alloc(64));
  return root;
}

test('planner keeps source and drops generated, credentials, and .git by rule', async () => {
  const root = await makeTree();
  try {
    const rules = normalizeWorkspaceRules({});
    const plan = await planWorkspace({ root, rules });
    const paths = plan.entries.map((entry) => entry.path);
    assert.ok(paths.includes('src/index.js'));
    assert.ok(paths.includes('package.json'));
    assert.ok(paths.includes('pnpm-lock.yaml'));
    assert.ok(paths.includes('.env.example'));
    assert.ok(!paths.includes('node_modules/dep/index.js'));
    assert.ok(!paths.includes('dist/bundle.js'));
    assert.ok(!paths.includes('debug.log'));
    assert.ok(!paths.includes('.env'));
    assert.ok(!paths.includes('cache.generated'));
    assert.equal(plan.git.present, true);
    assert.equal(plan.git.mode, 'included');
    assert.ok(paths.includes('.git/HEAD'));
    const secret = plan.skipped.find((item) => item.category === 'secret');
    assert.equal(secret.count, 1);
    const dependency = plan.skipped.find((item) => item.category === 'dependency');
    assert.equal(dependency.count, 1);
    const hashed = await hashPlan(plan);
    const file = hashed.find((entry) => entry.path === 'src/index.js');
    assert.equal(file.bytes, 20);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('symlinks are copied only when they stay inside the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-link-'));
  try {
    await fs.writeFile(path.join(root, 'real.txt'), 'x');
    await fs.symlink('real.txt', path.join(root, 'inside.txt'));
    await fs.symlink('/etc/passwd', path.join(root, 'outside.txt'));
    const plan = await planWorkspace({ root, rules: normalizeWorkspaceRules({ git: 'skip' }) });
    const links = plan.entries.filter((entry) => entry.type === 'symlink');
    assert.deepEqual(links.map((entry) => entry.path), ['inside.txt']);
    assert.equal(plan.skipped.find((item) => item.category === 'symlink').count, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('git can be skipped and oversize files are reported', async () => {
  const root = await makeTree();
  try {
    const rules = normalizeWorkspaceRules({ git: 'skip', maxFileBytes: 10 });
    const plan = await planWorkspace({ root, rules });
    assert.equal(plan.git.mode, 'skipped');
    assert.ok(!plan.entries.some((entry) => entry.path.startsWith('.git/')));
    const large = plan.skipped.find((item) => item.category === 'large');
    assert.ok(large !== undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
