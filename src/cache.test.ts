import assert from 'node:assert/strict';
import test from 'node:test';
import { cachedLoader } from './cache.js';

/** A load whose calls are counted and resolved (or rejected) by the test, and a clock the test moves. */
function harness() {
  let time = 1_000;
  const calls: Array<{ resolve: (value: number) => void; reject: (err: Error) => void }> = [];
  const load = () =>
    new Promise<number>((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return {
    calls,
    load,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** Lets pending promise callbacks (then/finally inside cachedLoader) run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('cachedLoader reuses a loaded value until the configured time has passed', async () => {
  const h = harness();
  const get = cachedLoader(h.load, 60_000, h.now);

  const first = get();
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(7);
  assert.equal(await first, 7);

  h.advance(59_999);
  assert.equal(await get(), 7);
  assert.equal(h.calls.length, 1, 'no new load within the TTL');

  h.advance(1);
  const third = get();
  assert.equal(h.calls.length, 2, 'loads again once the TTL is over');
  h.calls[1].resolve(8);
  assert.equal(await third, 8);
  assert.equal(await get(), 8);
  assert.equal(h.calls.length, 2);
});

test('cachedLoader counts the TTL from when the load resolved, not from when it started', async () => {
  const h = harness();
  const get = cachedLoader(h.load, 1_000, h.now);
  const first = get();
  h.advance(5_000); // a slow load
  h.calls[0].resolve(1);
  await first;

  h.advance(999);
  assert.equal(await get(), 1);
  assert.equal(h.calls.length, 1);
  h.advance(1);
  void get();
  assert.equal(h.calls.length, 2);
});

test('concurrent calls share one in-flight load', async () => {
  const h = harness();
  const get = cachedLoader(h.load, 60_000, h.now);
  const pending = [get(), get(), get()];
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(42);
  assert.deepEqual(await Promise.all(pending), [42, 42, 42]);
  assert.equal(await get(), 42);
  assert.equal(h.calls.length, 1);
});

test('after expiry, concurrent callers again share one new load', async () => {
  const h = harness();
  const get = cachedLoader(h.load, 10, h.now);
  const first = get();
  h.calls[0].resolve(1);
  await first;
  h.advance(10);
  const pending = [get(), get()];
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(2);
  assert.deepEqual(await Promise.all(pending), [2, 2]);
});

test('a failed load is not cached: its callers get the error and the next call loads again', async () => {
  const h = harness();
  const get = cachedLoader(h.load, 60_000, h.now);
  const pending = [get(), get()];
  assert.equal(h.calls.length, 1);
  h.calls[0].reject(new Error('rpc down'));
  for (const result of pending) {
    await assert.rejects(result, /rpc down/);
  }

  const retry = get();
  assert.equal(h.calls.length, 2, 'a new load right away, without waiting for the TTL');
  h.calls[1].resolve(5);
  assert.equal(await retry, 5);
  assert.equal(await get(), 5);
  assert.equal(h.calls.length, 2);
});

test('a failed refresh after expiry does not bring back or keep the old value', async () => {
  const h = harness();
  const get = cachedLoader(h.load, 100, h.now);
  const first = get();
  h.calls[0].resolve(1);
  await first;

  h.advance(100);
  const refresh = get();
  h.calls[1].reject(new Error('rpc down'));
  await assert.rejects(refresh, /rpc down/);
  await settle();

  const again = get();
  assert.equal(h.calls.length, 3);
  h.calls[2].resolve(3);
  assert.equal(await again, 3);
});

test('with a TTL of 0 nothing is reused after a load finishes, but concurrent callers still share it', async () => {
  const h = harness();
  const get = cachedLoader(h.load, 0, h.now);
  const pending = [get(), get()];
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(1);
  assert.deepEqual(await Promise.all(pending), [1, 1]);
  await settle();

  const next = get();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(2);
  assert.equal(await next, 2);
});

test('cachedLoader uses Date.now when no clock is given', async () => {
  let loads = 0;
  const get = cachedLoader(async () => ++loads, 60_000);
  assert.equal(await get(), 1);
  assert.equal(await get(), 1);
  assert.equal(loads, 1);
});
