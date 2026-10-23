import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreparation } from '../../gce/launcher/preparation.mjs';

const T0 = Date.parse('2026-10-23T01:00:00Z');

test('preparation timings start calls immediately, retain overlapping spans and return their values', async () => {
  let now = T0;
  const preparation = createPreparation({ now: () => now });
  let release;
  const pending = preparation.time('ledger.read', () => new Promise((resolve) => { release = resolve; }));
  assert.equal(typeof release, 'function', 'instrumentation does not defer starting the call');
  now += 100;
  const value = await preparation.time('github.runners', async () => { now += 200; return 7; }, { repo: 'owner/repo' });
  assert.equal(value, 7);
  assert.deepEqual(preparation.calls, [
    { call: 'ledger.read', started: new Date(T0).toISOString(), ms: null },
    { call: 'github.runners', repo: 'owner/repo', started: new Date(T0 + 100).toISOString(), ms: 200 },
  ], 'a read still in flight is explicit, not a zero-duration read');
  now += 400;
  release(9);
  assert.equal(await pending, 9);
  assert.equal(preparation.calls[0].ms, 700, 'overlapping calls are wall-time spans, not additive stages');
});

test('preparation timings retain failures without changing their rejection', async () => {
  let now = T0;
  const preparation = createPreparation({ now: () => now });
  const error = new Error('read failed');
  await assert.rejects(preparation.time('config', () => { now += 350; throw error; }), (err) => err === error);
  assert.deepEqual(preparation.calls, [{ call: 'config', started: new Date(T0).toISOString(), ms: 350, failed: true }]);
});
