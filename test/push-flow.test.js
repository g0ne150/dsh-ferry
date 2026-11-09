import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createFerry } from '../lib/ferry.js';
import { workspaceKey } from '../lib/paths.js';
import { createPeerHandler } from '../lib/routes.js';
import { event, events, makeEnv } from './env.js';

const TOKEN = 'test-token';

/**
 * Start one receiver-side web listener backed by the fake services.
 * @param {object} env - receiver environment.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} listener.
 */
async function startReceiver(env) {
  const config = { ...env.config, token: TOKEN, instance: { id: 'peer-b', name: 'B' } };
  const ferry = createFerry({ ctx: env.ctx, config, transfer: env.transfer });
  const handler = createPeerHandler({ config, ferry, transfer: env.transfer });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a continued session is updated in place over the wire, and divergence is refused', async (t) => {
  const sender = await makeEnv();
  const receiver = await makeEnv();
  const listener = await startReceiver(receiver);
  t.after(async () => listener.close());

  const config = {
    ...sender.config,
    token: TOKEN,
    instance: { id: 'peer-a', name: 'A' },
    peers: [{ id: 'peer-b', name: 'B', url: listener.url }],
  };
  const ferry = createFerry({ ctx: sender.ctx, config, transfer: sender.transfer });

  const sessionId = 'session-flow';
  const header = { id: sessionId, version: 4, createdAt: 1000, cwd: sender.workspace };
  sender.sessions.set(sessionId, { header, events: events(0, 3) });
  await fs.writeFile(path.join(sender.workspace, 'note.md'), 'one');

  const plan = await ferry.pushPlan({ sessionId });
  assert.equal(plan.session.eventCount, 3);
  assert.equal(plan.peers[0].online, true);
  assert.equal(plan.peers[0].state, 'absent');

  const first = await ferry.push({ peerId: 'peer-b', sessionId, mode: 'new' });
  assert.equal(first.status, 'imported');
  const target = first.targetDir;
  // The incoming directory is keyed by the sending workspace, not the session.
  assert.equal(
    target,
    path.join(
      receiver.root,
      'incoming',
      `workspace-${workspaceKey({ peerId: 'peer-a', sourceRoot: sender.workspace })}`,
    ),
  );
  assert.equal(await fs.readFile(path.join(target, 'note.md'), 'utf8'), 'one');

  // The sender keeps working; the receiver still holds the older copy.
  sender.sessions.get(sessionId).events.push(event(3), event(4));
  await fs.writeFile(path.join(sender.workspace, 'note.md'), 'two');

  const behind = await ferry.pushPlan({ sessionId });
  assert.equal(behind.peers[0].state, 'behind');
  assert.equal(behind.peers[0].eventCount, 3);

  const second = await ferry.push({ peerId: 'peer-b', sessionId, mode: 'update' });
  assert.equal(second.status, 'updated');
  assert.equal(second.appended, 2);
  assert.equal(receiver.sessions.get(sessionId).events.length, 5);
  assert.equal(await fs.readFile(path.join(target, 'note.md'), 'utf8'), 'two');

  // "New session" never touches the existing copy: it forks a fresh id.
  const forked = await ferry.push({ peerId: 'peer-b', sessionId, mode: 'new', merge: true });
  assert.equal(forked.status, 'imported');
  assert.notEqual(forked.sessionId, sessionId);

  const same = await ferry.pushPlan({ sessionId });
  assert.equal(same.peers[0].state, 'same');

  // Both sides continue from the same base; the copies diverge.
  receiver.sessions.get(sessionId).events.push({ seq: 5, type: 'message', at: 1, data: { text: 'local turn' } });
  sender.sessions.get(sessionId).events.push(event(5));

  const diverged = await ferry.pushPlan({ sessionId });
  assert.equal(diverged.peers[0].state, 'diverged');
  await assert.rejects(
    ferry.push({ peerId: 'peer-b', sessionId, mode: 'update' }),
    (error) => error.code === 'session-diverged',
  );
  assert.equal(receiver.sessions.get(sessionId).events[5].data.text, 'local turn', 'the receiver copy is untouched');
});

test('an update to a peer that holds the session open is queued until it restarts', async (t) => {
  const sender = await makeEnv();
  const receiver = await makeEnv();
  const listener = await startReceiver(receiver);
  t.after(async () => listener.close());

  const config = {
    ...sender.config,
    token: TOKEN,
    instance: { id: 'peer-a', name: 'A' },
    peers: [{ id: 'peer-b', name: 'B', url: listener.url }],
  };
  const ferry = createFerry({ ctx: sender.ctx, config, transfer: sender.transfer });

  const sessionId = 'session-queued-flow';
  const header = { id: sessionId, version: 4, createdAt: 1000, cwd: sender.workspace };
  sender.sessions.set(sessionId, { header, events: events(0, 3) });
  const first = await ferry.push({ peerId: 'peer-b', sessionId, mode: 'new' });
  assert.equal(first.status, 'imported');

  sender.sessions.get(sessionId).events.push(event(3), event(4));
  // The peer's GUI resumed the session, so its Agent holds the write handle.
  receiver.agents.set(sessionId, { status: 'idle' });

  const plan = await ferry.pushPlan({ sessionId });
  assert.equal(plan.peers[0].state, 'behind');
  assert.equal(plan.peers[0].active, true, 'the plan says why the update has to wait');

  const queued = await ferry.push({ peerId: 'peer-b', sessionId, mode: 'update' });
  assert.equal(queued.status, 'queued');
  assert.equal(receiver.sessions.get(sessionId).events.length, 3, 'nothing is written while the peer holds the session');

  receiver.agents.delete(sessionId);
  const applied = await receiver.transfer.applyPending();
  assert.equal(applied.length, 1);
  assert.equal(receiver.sessions.get(sessionId).events.length, 5, 'the next start appends what was missing');
});

test('two sessions from one workspace share one directory on the peer', async (t) => {
  const sender = await makeEnv();
  const receiver = await makeEnv();
  const listener = await startReceiver(receiver);
  t.after(async () => listener.close());

  const config = {
    ...sender.config,
    token: TOKEN,
    instance: { id: 'peer-a', name: 'A' },
    peers: [{ id: 'peer-b', name: 'B', url: listener.url }],
  };
  const ferry = createFerry({ ctx: sender.ctx, config, transfer: sender.transfer });

  for (const [id, text] of [
    ['session-one', 'first'],
    ['session-two', 'second'],
  ]) {
    sender.sessions.set(id, { header: { id, version: 4, createdAt: 1000, cwd: sender.workspace }, events: events(0, 2) });
    await fs.writeFile(path.join(sender.workspace, `${id}.md`), text);
  }

  const first = await ferry.push({ peerId: 'peer-b', sessionId: 'session-one', mode: 'new' });
  assert.equal(first.status, 'imported');

  // The peer now holds a copy of the workspace, so the second session lands
  // in the same directory and reports that a merge is needed.
  const plan = await ferry.pushPlan({ sessionId: 'session-two' });
  assert.equal(plan.peers[0].targetDir, first.targetDir);
  assert.equal(plan.peers[0].needsMerge, true);

  const second = await ferry.push({ peerId: 'peer-b', sessionId: 'session-two', mode: 'new', merge: true });
  assert.equal(second.status, 'imported');
  assert.equal(second.targetDir, first.targetDir);

  assert.equal(receiver.sessions.get('session-one').header.cwd, first.targetDir);
  assert.equal(receiver.sessions.get('session-two').header.cwd, first.targetDir);
  assert.deepEqual((await fs.readdir(first.targetDir)).sort(), ['session-one.md', 'session-two.md']);
});
test('pulling a session that moved on locally appends only what is missing', async (t) => {
  const source = await makeEnv();
  const target = await makeEnv();
  const listener = await startReceiver(source);
  t.after(async () => listener.close());

  const config = {
    ...target.config,
    token: TOKEN,
    instance: { id: 'peer-b', name: 'B' },
    peers: [{ id: 'peer-a', name: 'A', url: listener.url }],
  };
  const ferry = createFerry({ ctx: target.ctx, config, transfer: target.transfer });

  const sessionId = 'session-pull';
  const header = { id: sessionId, version: 4, createdAt: 2000, cwd: source.workspace };
  source.sessions.set(sessionId, { header, events: events(0, 2) });
  await fs.writeFile(path.join(source.workspace, 'doc.txt'), 'first');

  const pulled = await ferry.pull({ peerId: 'peer-a', sessionId, mode: 'new' });
  assert.equal(pulled.status, 'imported');

  source.sessions.get(sessionId).events.push(event(2), event(3));
  await fs.writeFile(path.join(source.workspace, 'doc.txt'), 'second');

  const plan = await ferry.pullPlan({ peerId: 'peer-a', sessionId });
  assert.equal(plan.state, 'behind');
  assert.equal(plan.eventCount, 2);
  assert.equal(plan.session.eventCount, 4);

  const updated = await ferry.pull({ peerId: 'peer-a', sessionId, mode: 'update' });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.appended, 2);
  assert.equal(target.sessions.get(sessionId).events.length, 4);
  assert.equal(await fs.readFile(path.join(updated.targetDir, 'doc.txt'), 'utf8'), 'second');
});
