import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuid } from '../js/uuid.js';

const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('uuid 使用 randomUUID 时格式正确', () => {
  assert.match(uuid(), RE);
});

test('randomUUID 不存在时用 getRandomValues 回退，格式正确且 1000 次不重复', () => {
  const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), 'randomUUID')
    || Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis.crypto, 'randomUUID');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
  try {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const id = uuid();
      assert.match(id, RE);
      seen.add(id);
    }
    assert.equal(seen.size, 1000);
  } finally {
    if (hadOwn) Object.defineProperty(globalThis.crypto, 'randomUUID', original);
    else delete globalThis.crypto.randomUUID;
  }
  assert.equal(typeof globalThis.crypto.randomUUID, 'function');
});
