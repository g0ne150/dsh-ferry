import assert from 'node:assert/strict';
import { createGunzip, createGzip } from 'node:zlib';
import test from 'node:test';
import { Readable } from 'node:stream';
import { BundleReader, PROTOCOL, encodeBundle, validateManifest } from '../lib/bundle.js';

function collect(stream) {
  return (async () => {
    const parts = [];
    for await (const chunk of stream) parts.push(chunk);
    return Buffer.concat(parts);
  })();
}

async function* fromBuffer(buffer) {
  yield buffer;
}

test('bundle round trip preserves manifest and payloads', async () => {
  const files = {
    'hello.txt': Buffer.from('hello ferry\n'),
    'nested/blob.bin': Buffer.from([0, 1, 2, 3, 255]),
  };
  const manifest = {
    protocol: PROTOCOL,
    kind: 'session',
    entries: [
      { kind: 'session', name: 'session.json', bytes: 4 },
      ...Object.entries(files).map(([name, bytes]) => ({
        type: 'file',
        path: name,
        bytes: bytes.length,
      })),
    ],
  };
  const frames = encodeBundle(manifest, (entry) => {
    if (entry.kind === 'session') return fromBuffer(Buffer.from('{}  '));
    return fromBuffer(files[entry.path]);
  });
  const gz = Readable.from(frames).pipe(createGzip()).pipe(createGunzip());
  const reader = new BundleReader(gz);
  const received = await reader.readManifest();
  assert.equal(received.entries.length, 3);
  const session = await reader.readEntryBuffer(received.entries[0]);
  assert.equal(session.toString(), '{}  ');
  const first = await reader.readEntryBuffer(received.entries[1]);
  assert.equal(first.toString(), 'hello ferry\n');
  const second = await reader.readEntryBuffer(received.entries[2]);
  assert.deepEqual([...second], [0, 1, 2, 3, 255]);
  await reader.finish();
});

test('checksum mismatch rejects the entry', async () => {
  const manifest = {
    protocol: PROTOCOL,
    kind: 'session',
    entries: [{ type: 'file', path: 'a.txt', bytes: 3, sha256: 'b'.repeat(64) }],
  };
  const frames = encodeBundle(manifest, () => fromBuffer(Buffer.from('abc')));
  const reader = new BundleReader(frames);
  const received = await reader.readManifest();
  await assert.rejects(() => reader.readEntryBuffer(received.entries[0]), /checksum mismatch/);
});

test('manifest validation rejects traversal-free payloads above limits', async () => {
  const manifest = {
    protocol: PROTOCOL,
    kind: 'session',
    entries: [{ type: 'file', path: 'big.bin', bytes: 100 }],
  };
  assert.throws(
    () => validateManifest(manifest, { maxFileBytes: 10, maxTotalBytes: 1000 }),
    /exceeds the 10 byte file limit/,
  );
});

test('a truncated bundle is an error, not a partial success', async () => {
  const manifest = {
    protocol: PROTOCOL,
    kind: 'session',
    entries: [{ type: 'file', path: 'a.txt', bytes: 100 }],
  };
  const frames = encodeBundle(manifest, () => fromBuffer(Buffer.from('short')));
  const reader = new BundleReader(frames);
  const received = await reader.readManifest();
  await assert.rejects(() => reader.readEntryBuffer(received.entries[0]), /ended unexpectedly|produced/);
});

test('non-bundle bytes are rejected', async () => {
  const reader = new BundleReader(fromBuffer(Buffer.from('not a bundle at all')));
  await assert.rejects(() => reader.readManifest(), /not a dsh-ferry bundle/);
});

test('gunzip round trip', async () => {
  const gz = Readable.from(fromBuffer(Buffer.from('hello'))).pipe(createGzip());
  const raw = await collect(gz.pipe(createGunzip()));
  assert.equal(raw.toString(), 'hello');
});

test('zero-byte entries keep the frame sequence aligned', async () => {
  const manifest = {
    protocol: PROTOCOL,
    kind: 'session',
    entries: [
      { type: 'file', path: '.gitignore', bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
      { type: 'file', path: 'README.md', bytes: 5 },
    ],
  };
  const frames = encodeBundle(manifest, () => fromBuffer(Buffer.from('hello')));
  const reader = new BundleReader(frames);
  const received = await reader.readManifest();
  const empty = await reader.readEntryBuffer(received.entries[0]);
  assert.equal(empty.length, 0);
  const readme = await reader.readEntryBuffer(received.entries[1]);
  assert.equal(readme.toString(), 'hello');
  await reader.finish();
});
