import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySession, hashEvents, readTail, tailOf } from '../lib/state.js';

const event = (seq, extra = {}) => ({ seq, type: 'message', at: 1000 + seq, data: { text: `event ${seq}` }, ...extra });

test('hashing ignores property order so two sides agree on the same log', () => {
  const left = [{ seq: 0, data: { a: 1, b: [2, 3] } }];
  const right = [{ data: { b: [2, 3], a: 1 }, seq: 0 }];
  assert.equal(hashEvents(left), hashEvents(right));
});

test('hashing ignores attachment identity but not the rest of the event', () => {
  const first = [{ seq: 0, data: { items: [{ attachmentId: 'sha256:aaaa', bytes: 10, name: 'a.png' }] } }];
  const second = [{ seq: 0, data: { items: [{ attachmentId: 'sha256:bbbb', bytes: 99, name: 'b.png' }] } }];
  const different = [{ seq: 0, data: { items: [{ attachmentId: 'sha256:aaaa', bytes: 10, name: 'a.png' }], text: 'x' } }];
  assert.equal(hashEvents(first), hashEvents(second));
  assert.notEqual(hashEvents(first), hashEvents(different));
});

test('a locally stamped seed marker does not read as divergence', () => {
  const marker = (time, data = {}) => ({ seq: 1, type: 'session/end-seed', time, data });
  assert.equal(hashEvents([event(0), marker(100)]), hashEvents([event(0), marker(999)]));
  assert.notEqual(
    hashEvents([event(0), marker(100)]),
    hashEvents([event(0), marker(100, { inherited: true })]),
    'the marker payload still participates',
  );
});

test('a tail fingerprint covers the last events only', () => {
  const events = [event(0), event(1), event(2), event(3), event(4), event(5), event(6), event(7), event(8), event(9)];
  const tail = tailOf(events);
  assert.equal(tail.from, 2);
  assert.equal(tail.count, 8);
  assert.equal(tail.hash, hashEvents(events, 2));
  assert.equal(tailOf([]).hash, hashEvents([]));
  assert.equal(tailOf([]).count, 0);
});

test('a wire tail is accepted only when it is well formed', () => {
  const valid = tailOf([event(0)]);
  assert.deepEqual(readTail(valid), valid);
  assert.equal(readTail({ from: 0, count: 0, hash: 'nope' }), undefined);
  assert.equal(readTail({ from: -1, count: 1, hash: valid.hash }), undefined);
  assert.equal(readTail({ from: 0, count: 99, hash: valid.hash }), undefined);
  assert.equal(readTail('tail'), undefined);
});

test('classifying two copies covers every state the dialog can show', () => {
  const local = (count, events = []) => ({ count, tail: tailOf(events) });
  const remote = (count, events = []) => ({ count, tail: tailOf(events) });

  assert.equal(classifySession(undefined, remote(3, [event(0)])), 'absent');
  assert.equal(classifySession(local(2), { count: undefined }), 'unknown');
  assert.equal(classifySession(local(2), remote(5)), 'behind');
  assert.equal(classifySession(local(5), remote(2)), 'ahead');

  const shared = [event(0), event(1)];
  assert.equal(classifySession(local(2, shared), remote(2, shared)), 'same');
  assert.equal(classifySession(local(2, [event(0), event(1)]), remote(2, [event(0), event(2)])), 'diverged');

  // Without fingerprints the counts decide, exactly as an older sender expects.
  assert.equal(classifySession(local(2), remote(2)), 'same');
});
