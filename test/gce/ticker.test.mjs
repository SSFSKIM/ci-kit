// The launcher's tick coalescer (spec 2026-10-21 M4, The launcher): scheduled and requested ticks serialized in the
// process, at most one pending, starts at least 10 s apart, requested ticks dropped while the App's budget is low.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicker, TICK_SPACING_MS } from '../../gce/launcher/ticker.mjs';

const flush = () => new Promise((r) => setImmediate(r));

// A clock the test moves by hand, and ticks the test ends by hand: every tick() call is recorded with its trigger,
// how many requests it serves and when it started, and stays running until the test settles it.
function world({ budgetLow = () => false } = {}) {
  let t = 1_000_000;
  const sleepers = [];
  const ticks = [];
  const ticker = createTicker({
    now: () => t,
    sleep: (ms) => new Promise((resolve) => sleepers.push({ at: t + ms, resolve })),
    budgetLow: () => budgetLow(),
    tick: (info) => new Promise((resolve, reject) => ticks.push({ ...info, at: t, resolve, reject })),
  });
  return {
    ticker,
    ticks,
    now: () => t,
    async advance(ms) {
      t += ms;
      for (const s of sleepers.filter((x) => x.at <= t)) {
        sleepers.splice(sleepers.indexOf(s), 1);
        s.resolve();
      }
      await flush();
    },
    async end(i, out = { i }) {
      ticks[i].resolve(out);
      await flush();
    },
  };
}

test('an idle launcher runs a requested tick at once', async () => {
  const w = world();
  const done = w.ticker('requested');
  assert.equal(w.ticks.length, 1);
  assert.deepEqual([w.ticks[0].trigger, w.ticks[0].requests], ['requested', 1]);
  await w.end(0, { launched: 1 });
  assert.deepEqual(await done, { launched: 1 });
});

test('requests arriving while a tick runs coalesce into one more tick after it, at least 10 s after its start', async () => {
  const w = world();
  w.ticker('requested');
  const later = [w.ticker('requested'), w.ticker('requested'), w.ticker('requested')];
  await w.advance(3_000);
  assert.equal(w.ticks.length, 1);
  await w.end(0); // the first tick took 3 s; the next may start 7 s later
  assert.equal(w.ticks.length, 1);
  await w.advance(TICK_SPACING_MS - 3_000 - 1);
  assert.equal(w.ticks.length, 1);
  await w.advance(1);
  assert.equal(w.ticks.length, 2);
  assert.deepEqual([w.ticks[1].trigger, w.ticks[1].requests, w.ticks[1].at - w.ticks[0].at], ['requested', 3, TICK_SPACING_MS]);
  await w.end(1, 'second');
  assert.deepEqual(await Promise.all(later), ['second', 'second', 'second']);
});

test('at most one tick is pending: once it starts, later requests form the next one', async () => {
  const w = world();
  w.ticker('requested');
  w.ticker('requested');
  await w.advance(TICK_SPACING_MS);
  await w.end(0);
  assert.equal(w.ticks.length, 2); // the pending one started at once: 10 s had passed
  w.ticker('requested');
  w.ticker('requested');
  await w.advance(TICK_SPACING_MS);
  await w.end(1);
  assert.equal(w.ticks.length, 3);
  assert.equal(w.ticks[2].requests, 2);
  await w.end(2);
  assert.equal(w.ticks.length, 3);
});

test('a scheduled tick arriving while one runs waits in the pending one, which then runs as scheduled', async () => {
  const w = world();
  w.ticker('requested');
  w.ticker('requested');
  const scheduled = w.ticker('scheduled');
  await w.advance(TICK_SPACING_MS);
  await w.end(0);
  assert.deepEqual([w.ticks[1].trigger, w.ticks[1].requests], ['scheduled', 2]);
  await w.end(1, 'served');
  assert.equal(await scheduled, 'served');
});

test('a scheduled tick at an idle launcher still keeps 10 s from the last start', async () => {
  const w = world();
  w.ticker('requested');
  await w.end(0);
  await w.advance(4_000);
  w.ticker('scheduled');
  assert.equal(w.ticks.length, 1);
  await w.advance(TICK_SPACING_MS - 4_000);
  assert.equal(w.ticks.length, 2);
});

test('while the budget is low a requested tick is dropped, a scheduled one runs, and one serving both runs', async () => {
  let low = true;
  const w = world({ budgetLow: () => low });
  assert.deepEqual(await w.ticker('requested'), { dropped: 'rate budget', requests: 1 });
  assert.equal(w.ticks.length, 0);
  w.ticker('scheduled');
  assert.equal(w.ticks.length, 1);
  const requested = w.ticker('requested');
  const scheduled = w.ticker('scheduled');
  await w.advance(TICK_SPACING_MS);
  await w.end(0);
  assert.equal(w.ticks.length, 2);
  await w.end(1, 'ran');
  assert.deepEqual(await Promise.all([requested, scheduled]), ['ran', 'ran']);
  // The budget is read when the tick would start, not when it was asked for.
  w.ticker('scheduled');
  await w.advance(TICK_SPACING_MS);
  assert.equal(w.ticks.length, 3);
  const late = w.ticker('requested'); // asked while the budget is low, behind a running tick
  low = false;
  await w.end(2);
  await w.advance(TICK_SPACING_MS);
  assert.equal(w.ticks.length, 4);
  await w.end(3, 'recovered');
  assert.equal(await late, 'recovered');
});

test('a dropped tick does not count as a start: the next one keeps its spacing from the last tick that ran', async () => {
  let low = false;
  const w = world({ budgetLow: () => low });
  w.ticker('requested');
  await w.end(0);
  low = true;
  const dropped = w.ticker('requested');
  await w.advance(TICK_SPACING_MS);
  assert.deepEqual(await dropped, { dropped: 'rate budget', requests: 1 });
  low = false;
  w.ticker('requested');
  assert.equal(w.ticks.length, 2); // 10 s since the last start: at once
});

test('a failed tick fails the callers it served, and the pending one still runs', async () => {
  const w = world();
  const first = w.ticker('scheduled');
  const second = w.ticker('requested');
  w.ticks[0].reject(new Error('gce unreadable'));
  await assert.rejects(first, /gce unreadable/);
  await w.advance(TICK_SPACING_MS);
  assert.equal(w.ticks.length, 2);
  await w.end(1, 'ok');
  assert.equal(await second, 'ok');
});
