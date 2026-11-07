import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tailOf } from '../lib/state.js';
import { buildBundle, event, events, makeEnv } from './env.js';

test('re-pushing a continued session appends only the missing events', async () => {
  const env = await makeEnv();
  const id = 'session-abc';
  const header = { id, version: 4, createdAt: 1000, cwd: env.workspace };
  env.sessions.set(id, { header, events: events(0, 2) });
  await fs.writeFile(path.join(env.workspace, 'a.txt'), 'v1');

  const body = buildBundle({ id, header, events: events(0, 5), files: [{ path: 'a.txt', content: 'v2' }] });
  const result = await env.transfer.importSession({
    body,
    targetDir: env.workspace,
    merge: true,
    update: true,
  });

  assert.equal(result.status, 'updated');
  assert.equal(result.appended, 3);
  assert.equal(result.events, 5);
  assert.equal(env.sessions.get(id).events.length, 5);
  assert.equal(await fs.readFile(path.join(env.workspace, 'a.txt'), 'utf8'), 'v2');
  assert.ok(result.workspace.backupDir, 'an overwritten file stays recoverable');
  assert.equal(await fs.readFile(path.join(result.workspace.backupDir, 'a.txt'), 'utf8'), 'v1');
});

test('an update with nothing new still synchronizes the workspace', async () => {
  const env = await makeEnv();
  const id = 'session-same';
  const header = { id, version: 4, createdAt: 1000, cwd: env.workspace };
  env.sessions.set(id, { header, events: events(0, 3) });
  await fs.writeFile(path.join(env.workspace, 'b.txt'), 'old');

  const body = buildBundle({ id, header, events: events(0, 3), files: [{ path: 'b.txt', content: 'new' }] });
  const result = await env.transfer.importSession({
    body,
    targetDir: env.workspace,
    merge: true,
    update: true,
  });

  assert.equal(result.status, 'updated');
  assert.equal(result.appended, 0);
  assert.equal(await fs.readFile(path.join(env.workspace, 'b.txt'), 'utf8'), 'new');
  assert.equal(env.sessions.get(id).events.length, 3);
});

test('a plain import of identical content stays a no-op', async () => {
  const env = await makeEnv();
  const id = 'session-exists';
  const header = { id, version: 4, createdAt: 1000, cwd: env.workspace };
  env.sessions.set(id, { header, events: events(0, 3) });

  const body = buildBundle({ id, header, events: events(0, 3) });
  const result = await env.transfer.importSession({ body, targetDir: env.workspace, merge: true });

  assert.equal(result.status, 'exists');
  assert.equal(result.sessionId, id);
});

test('an update refuses a copy that is longer here', async () => {
  const env = await makeEnv();
  const id = 'session-ahead';
  const header = { id, version: 4, createdAt: 1000, cwd: env.workspace };
  env.sessions.set(id, { header, events: events(0, 5) });

  const body = buildBundle({ id, header, events: events(0, 2) });
  await assert.rejects(
    env.transfer.importSession({ body, targetDir: env.workspace, merge: true, update: true }),
    (error) => error.code === 'session-ahead',
  );
});

test('an update ignores runtime events each instance wrote for itself', async () => {
  const env = await makeEnv();
  const id = 'session-runtime';
  const header = { id, version: 4, createdAt: 1000, cwd: env.workspace };
  // The receiver opened the session itself: DSH stamped its own seed marker and
  // model choice before the sender's next turn.
  env.sessions.set(id, {
    header,
    events: [
      event(0),
      event(1),
      { seq: 2, type: 'session/end-seed', time: 100, data: {} },
      { seq: 3, type: 'model/selection', time: 100, data: { model: 'deepseek-flash' } },
    ],
  });

  const body = buildBundle({
    id,
    header,
    events: [
      event(0),
      event(1),
      { seq: 2, type: 'session/end-seed', time: 999, data: {} },
      { seq: 3, type: 'model/selection', time: 999, data: { model: 'deepseek-pro' } },
      event(4),
    ],
  });
  const result = await env.transfer.importSession({ body, targetDir: env.workspace, merge: true, update: true });

  assert.equal(result.status, 'updated');
  assert.equal(result.appended, 1);
  assert.equal(env.sessions.get(id).events.length, 5);
  assert.equal(env.sessions.get(id).events.at(-1).seq, 4);
});

test('an update refuses a copy that diverged instead of rewriting events', async () => {
  const env = await makeEnv();
  const id = 'session-diverged';
  const header = { id, version: 4, createdAt: 1000, cwd: env.workspace };
  env.sessions.set(id, { header, events: [event(0), event(99)] });

  const body = buildBundle({ id, header, events: [event(0), event(1)] });
  await assert.rejects(
    env.transfer.importSession({ body, targetDir: env.workspace, merge: true, update: true }),
    (error) => error.code === 'session-diverged',
  );
  assert.equal(env.sessions.get(id).events[1].data.text, 'event 99', 'local events are never rewritten');
});

test('preflight reports the state and whether the target can be merged', async () => {
  const env = await makeEnv();
  const id = 'session-plan';
  const header = { id, version: 4, createdAt: 1000, cwd: env.workspace };
  env.sessions.set(id, { header, events: events(0, 2) });

  const behind = await env.transfer.preflight({
    sessionId: id,
    eventCount: 5,
    createdAt: header.createdAt,
    formatVersion: 4,
    targetDir: env.workspace,
    merge: true,
    tail: tailOf(events(0, 5)),
  });
  assert.equal(behind.state, 'behind');
  assert.equal(behind.decision, 'update');

  const same = await env.transfer.preflight({
    sessionId: id,
    eventCount: 2,
    createdAt: header.createdAt,
    formatVersion: 4,
    merge: true,
    tail: tailOf(events(0, 2)),
  });
  assert.equal(same.state, 'same');
  assert.equal(same.decision, 'exists');

  const absent = await env.transfer.preflight({ sessionId: 'session-unknown', eventCount: 1, merge: true });
  assert.equal(absent.state, 'absent');
});
