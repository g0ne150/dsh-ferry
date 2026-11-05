import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternList, compilePattern, isSecretPath } from '../lib/ignore.js';

test('glob patterns anchor and cross directories', () => {
  const list = new PatternList(['dist/', '/build', 'docs/**/*.md', '*.tmp']);
  assert.equal(list.test('dist', true), true);
  assert.equal(list.test('src/dist', true), true);
  assert.equal(list.test('build', true), true);
  assert.equal(list.test('src/build', true), null);
  assert.equal(list.test('docs/a/b/readme.md', false), true);
  assert.equal(list.test('docs/readme.md', false), true);
  assert.equal(list.test('src/x.tmp', false), true);
  assert.equal(list.test('keep.txt', false), null);
});

test('directory-only patterns never match files', () => {
  const pattern = compilePattern('node_modules/');
  assert.equal(pattern.dirOnly, true);
  assert.equal(pattern.regex.test('node_modules'), true);
  assert.equal(pattern.regex.test('a/node_modules'), true);
});

test('negation wins inside one list', () => {
  const list = new PatternList(['*.log', '!keep.log']);
  assert.equal(list.test('a.log', false), true);
  assert.equal(list.test('keep.log', false), false);
});

test('secret handling keeps templates and finds credentials', () => {
  assert.equal(isSecretPath('.env', false), true);
  assert.equal(isSecretPath('apps/web/.env.local', false), true);
  assert.equal(isSecretPath('.env.example', false), false);
  assert.equal(isSecretPath('config/.env.sample', false), false);
  assert.equal(isSecretPath('deploy/id_rsa', false), true);
  assert.equal(isSecretPath('.ssh', true), true);
  assert.equal(isSecretPath('src/index.ts', false), false);
  assert.equal(isSecretPath('certs/server.pem', false), true);
});

test('character classes and question marks', () => {
  const list = new PatternList(['file-?.[ch]']);
  assert.equal(list.test('file-a.c', false), true);
  assert.equal(list.test('file-aa.c', false), null);
});
