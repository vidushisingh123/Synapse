import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptHistoryOwner, can, clearToken, endSession, getToken, setToken } from './auth.js';

const memoryStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    has: (k) => data.has(k),
  };
};

test('token helpers store, read and clear the session token', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true });
  try {
    assert.equal(getToken(), null);
    assert.equal(setToken('a.b.c'), true);
    assert.equal(getToken(), 'a.b.c');
    clearToken();
    assert.equal(getToken(), null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  }
});

test('setToken reports failure when storage is unavailable', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: { setItem() { throw new Error('denied'); } }, configurable: true,
  });
  try {
    assert.equal(setToken('a.b.c'), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  }
});

test('history saved by another account is wiped, not inherited', () => {
  const storage = memoryStorage({ 'synapse.history.owner': 'user-a' });
  let wiped = 0;
  adoptHistoryOwner('user-b', () => { wiped += 1; }, storage);
  assert.equal(wiped, 1);
  assert.equal(storage.getItem('synapse.history.owner'), 'user-b');
});

test('history of unknown ownership (no owner marker) is wiped', () => {
  const storage = memoryStorage();
  let wiped = 0;
  adoptHistoryOwner('user-a', () => { wiped += 1; }, storage);
  assert.equal(wiped, 1);
});

test('the same account keeps its own history', () => {
  const storage = memoryStorage({ 'synapse.history.owner': 'user-a' });
  let wiped = 0;
  adoptHistoryOwner('user-a', () => { wiped += 1; }, storage);
  assert.equal(wiped, 0);
});

test('unreadable storage is treated as unknown owner and wipes', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  let wiped = 0;
  adoptHistoryOwner('user-a', () => { wiped += 1; }, storage);
  assert.equal(wiped, 1);
});

test('endSession clears the token, wipes history and removes the owner marker', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true });
  const storage = memoryStorage({ 'synapse.history.owner': 'user-a' });
  try {
    setToken('a.b.c');
    let wiped = 0;
    endSession(() => { wiped += 1; }, storage);
    assert.equal(getToken(), null);
    assert.equal(wiped, 1);
    assert.equal(storage.has('synapse.history.owner'), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  }
});

test('endSession still clears the token and owner marker if wiping history throws', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true });
  const storage = memoryStorage({ 'synapse.history.owner': 'user-a' });
  try {
    setToken('a.b.c');
    assert.throws(() => endSession(() => { throw new Error('boom'); }, storage), /boom/);
    assert.equal(getToken(), null);
    assert.equal(storage.has('synapse.history.owner'), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  }
});

test('can() fails closed for missing or malformed sessions', () => {
  assert.equal(can(null, 'investigate'), false);
  assert.equal(can(undefined, 'investigate'), false);
  assert.equal(can({ permissions: 'investigate' }, 'investigate'), false);
  assert.equal(can({ permissions: ['graph:read'] }, 'investigate'), false);
  assert.equal(can({ permissions: ['investigate'] }, 'investigate'), true);
});
