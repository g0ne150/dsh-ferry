import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from '../lib/config.js';

test('one shared token is the fleet credential', () => {
  const config = normalizeConfig({
    token: '  fleet-secret  ',
    peers: [{ id: 'a', url: 'http://127.0.0.1:3001' }],
  });
  assert.equal(config.token, 'fleet-secret');
  assert.equal(config.peers[0].token, undefined);
  assert.equal(config.peers[0].url, 'http://127.0.0.1:3001');
});

test('a single legacy per-peer token migrates to the shared token', () => {
  const config = normalizeConfig({
    peers: [
      { id: 'a', url: 'http://127.0.0.1:3001', token: 'old' },
      { id: 'b', url: 'http://127.0.0.1:3002', token: 'old' },
    ],
  });
  assert.equal(config.token, 'old');
  assert.deepEqual(config.peers.map((peer) => peer.id), ['a', 'b']);
  assert.ok(config.peers.every((peer) => peer.token === undefined));
});

test('conflicting legacy per-peer tokens are rejected with guidance', () => {
  assert.throws(
    () =>
      normalizeConfig({
        peers: [
          { id: 'a', url: 'http://127.0.0.1:3001', token: 'one' },
          { id: 'b', url: 'http://127.0.0.1:3002', token: 'two' },
        ],
      }),
    /set one top-level `token`/,
  );
});

test('no token is allowed at activation so the panel can configure one', () => {
  const config = normalizeConfig({});
  assert.equal(config.token, '');
  assert.deepEqual(config.peers, []);
  assert.equal(config.incomingRoot.endsWith('incoming'), true);
});
