import assert from 'node:assert/strict';
import test from 'node:test';
import { NonceWindow, canonicalRequest, signRequest, verifyRequest } from '../lib/auth.js';

const peerId = 'alpha';
const secret = 'shared-secret';

test('signed requests verify and the same nonce cannot replay', () => {
  const headers = signRequest({ secret, peerId, method: 'POST', path: '/dsh-ferry/v1/ping', timestamp: '1000', nonce: 'a'.repeat(32) });
  const nonces = new NonceWindow();
  const first = verifyRequest({
    headers,
    method: 'POST',
    path: '/dsh-ferry/v1/ping',
    secrets: [{ peerId, token: secret }],
    nonces,
    now: 1000,
  });
  assert.equal(first.ok, true);
  const replay = verifyRequest({
    headers,
    method: 'POST',
    path: '/dsh-ferry/v1/ping',
    secrets: [{ peerId, token: secret }],
    nonces,
    now: 1000,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'replayed');
});

test('a different path or secret fails', () => {
  const headers = signRequest({ secret, peerId, method: 'POST', path: '/dsh-ferry/v1/ping', timestamp: '2000', nonce: 'b'.repeat(32) });
  const wrongPath = verifyRequest({
    headers,
    method: 'POST',
    path: '/dsh-ferry/v1/import',
    secrets: [{ peerId, token: secret }],
    nonces: new NonceWindow(),
    now: 2000,
  });
  assert.equal(wrongPath.ok, false);
  const wrongSecret = verifyRequest({
    headers,
    method: 'POST',
    path: '/dsh-ferry/v1/ping',
    secrets: [{ peerId, token: 'other' }],
    nonces: new NonceWindow(),
    now: 2000,
  });
  assert.equal(wrongSecret.ok, false);
});

test('stale timestamps are refused', () => {
  const headers = signRequest({ secret, peerId, method: 'POST', path: '/x', timestamp: '1000', nonce: 'c'.repeat(32) });
  const result = verifyRequest({
    headers,
    method: 'POST',
    path: '/x',
    secrets: [{ peerId, token: secret }],
    nonces: new NonceWindow(),
    now: 1000 + 10 * 60 * 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale');
});

test('an unknown peer id still verifies against a configured secret', () => {
  const headers = signRequest({ secret, peerId: 'beta', method: 'POST', path: '/x', timestamp: '3000', nonce: 'd'.repeat(32) });
  const result = verifyRequest({
    headers,
    method: 'POST',
    path: '/x',
    secrets: [{ peerId: 'alpha', token: secret }],
    nonces: new NonceWindow(),
    now: 3000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.peerId, 'beta');
});

test('canonical text is stable', () => {
  assert.equal(
    canonicalRequest({ peerId, method: 'post', path: '/a?b=1', timestamp: '1', nonce: 'n' }),
    'dsh-ferry/v1\nalpha\nPOST\n/a?b=1\n1\nn',
  );
});
