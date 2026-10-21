// The launcher's HTTP surface (spec 2026-10-21 M4): Cloud Scheduler's /tick and Pub/Sub's /request are each answered
// when the tick that serves them has ended (an open request keeps the instance's CPU allocated for that tick).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler } from '../../gce/launcher/routes.mjs';
import { createTicker, TICK_SPACING_MS } from '../../gce/launcher/ticker.mjs';

async function launcher(serve) {
  const asked = [];
  const logs = [];
  const server = http.createServer(createHandler({
    serve: (trigger) => {
      asked.push(trigger);
      return serve(trigger);
    },
    say: (severity, message, extra) => logs.push({ severity, message, ...extra }),
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'POST', body } = {}) => {
    const res = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { call, asked, logs, base, close: () => new Promise((r) => server.close(r)) };
}

const envelope = (message) => ({
  message: { data: Buffer.from(JSON.stringify(message)).toString('base64'), messageId: '1', publishTime: '2026-10-21T20:00:00.000Z' },
  subscription: 'projects/ssfskim-ci-kit/subscriptions/ci-kit-tick-requests-launcher',
});

test('a push is answered with its tick\'s outcome once that tick has ended, and logs the job that asked', async (t) => {
  let end;
  const l = await launcher(() => new Promise((resolve) => { end = resolve; }));
  t.after(l.close);
  const answered = l.call('/request', { body: envelope({ repo: 'SSFSKIM/MAWS', job: 7, delivery: 'd-1' }) });
  let early = false;
  answered.then(() => { early = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(early, false); // its tick is still running
  end({ launched: ['a'] });
  assert.deepEqual(await answered, { status: 200, body: { launched: ['a'] } });
  assert.deepEqual(l.asked, ['requested']);
  assert.equal(l.logs[0].message, 'tick request: SSFSKIM/MAWS job 7');
  assert.deepEqual(l.logs[0].request, { repo: 'SSFSKIM/MAWS', job: 7, delivery: 'd-1', published: '2026-10-21T20:00:00.000Z' });
});

test('a push whose body is unreadable still asks for a tick', async (t) => {
  const l = await launcher(async () => ({}));
  t.after(l.close);
  assert.equal((await l.call('/request', { body: { not: 'an envelope' } })).status, 200);
  assert.deepEqual(l.asked, ['requested']);
  assert.equal(l.logs[0].request, null);
});

test('a push whose tick failed or was dropped is still acknowledged (200), saying which', async (t) => {
  let outcome = async () => { throw new Error('gce unreadable'); };
  const l = await launcher(() => outcome());
  t.after(l.close);
  assert.deepEqual(await l.call('/request', { body: envelope({}) }), { status: 200, body: { failed: 'gce unreadable' } });
  outcome = async () => ({ dropped: 'rate budget', requests: 1 });
  assert.deepEqual(await l.call('/request', { body: envelope({}) }), { status: 200, body: { dropped: 'rate budget', requests: 1 } });
});

test('a push arriving mid-tick is answered only after the following tick, which serves it, has completed', async (t) => {
  let clock = 0;
  const sleepers = [];
  const ticks = [];
  const serve = createTicker({
    now: () => clock,
    sleep: (ms) => new Promise((resolve) => sleepers.push({ at: clock + ms, resolve })),
    budgetLow: () => false,
    tick: (info) => new Promise((resolve) => ticks.push({ ...info, resolve })),
  });
  const l = await launcher(serve);
  t.after(l.close);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const state = (p) => { const s = { done: false }; p.then((v) => Object.assign(s, { done: true, v })); return s; };

  const first = state(l.call('/request', { body: envelope({ job: 1 }) }));
  await settle();
  assert.equal(ticks.length, 1); // an idle launcher ticks at once
  clock += 3_000;
  const second = state(l.call('/request', { body: envelope({ job: 2 }) })); // mid-tick
  await settle();
  assert.equal(ticks.length, 1);

  ticks[0].resolve({ tick: 1 });
  await settle();
  assert.deepEqual(first.v?.body, { tick: 1 });
  assert.equal(second.done, false); // not answered by the tick it arrived during

  clock += TICK_SPACING_MS; // the spacing from the first tick's start has passed
  for (const s of sleepers.splice(0)) s.resolve();
  await settle();
  assert.equal(ticks.length, 2);
  assert.deepEqual([ticks[1].trigger, ticks[1].requests], ['requested', 1]);
  assert.equal(second.done, false); // held while the tick that serves it runs

  ticks[1].resolve({ tick: 2 });
  await settle();
  assert.deepEqual(second.v, { status: 200, body: { tick: 2 } });
});

test('the scheduler waits for its tick: 200 with the outcome, or 500 when it failed', async (t) => {
  let fail = false;
  const l = await launcher(async () => {
    if (fail) throw new Error('ledger unreadable');
    return { launched: ['a'] };
  });
  t.after(l.close);
  assert.deepEqual(await l.call('/tick'), { status: 200, body: { launched: ['a'] } });
  fail = true;
  assert.deepEqual(await l.call('/tick'), { status: 500, body: { error: 'ledger unreadable' } });
  assert.deepEqual(l.asked, ['scheduled', 'scheduled']);
});

test('only POST to /tick or /request is served', async (t) => {
  const l = await launcher(async () => ({}));
  t.after(l.close);
  assert.equal((await l.call('/tick', { method: 'GET' })).status, 405);
  assert.equal((await l.call('/')).status, 404);
  assert.deepEqual(l.asked, []);
});
