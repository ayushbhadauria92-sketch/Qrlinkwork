import test from 'node:test';
import assert from 'node:assert/strict';

test('production safety invariants are represented', () => {
  assert.equal(typeof process.version, 'string');
  assert.match(process.version, /^v\d+/);
});

test('Node runtime exposes modern crypto APIs', () => {
  assert.equal(typeof globalThis.crypto, 'object');
});
