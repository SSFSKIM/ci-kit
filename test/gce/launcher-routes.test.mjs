// The launcher's HTTP surface (spec 2026-10-21 M4): Cloud Scheduler's /tick and Pub/Sub's /request are each answered
// when the tick that serves them has ended (an open request keeps the instance's CPU allocated for that tick).
// A test acts only once the server has done what it waits for (a request reached serve, a tick or a sleep began),
// never after a fixed delay: a request can take any time to reach the handler on a loaded machine (ci-kit#77). A
// fixed wait only backs a check that something has NOT happened yet, where a slow machine can miss a bug but never
// fail correct code. delayMs holds every request back before the handler, to run those tests with requests arriving
// late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler } from '../../gce/launcher/routes.mjs';
import { createTicker, TICK_SPACING_MS } from '../../gce/launcher/ticker.mjs';

async function launcher(serve, { delayMs = 0 } = {}) {
  const asked = [];
  const logs = [];
  const handle = createHandler({
    serve: (trigger) => {
      asked.push(trigger);
      return serve(trigger);
    },
    say: (severity, message, extra) => logs.push({ severity, message, ...extra }),
  });
  const server = http.createServer((req, res) => (delayMs ? setTimeout(() => handle(req, res), delayMs) : handle(req, res)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'POST', body } = {}) => {
    const res = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  // Held requests are dropped on close: a test that failed while one was held must not stall the suite.
  const close = () => new Promise((r) => {
    server.close(r);
    server.closeAllConnections();
  });
  return { call, asked, logs, close };
}

// Resolves once cond() holds, checked every few ms (the test's own timeout bounds it).
async function until(cond) {
  while (!cond()) await new Promise((r) => setTimeout(r, 2));
}
const notYet = () => new Promise((r) => setTimeout(r, 30));
// A request's answer, observable without awaiting it; a failed fetch is kept, not left unhandled.
const watch = (p) => {
  const s = { done: false };
  p.then((v) => Object.assign(s, { done: true, v }), (err) => Object.assign(s, { done: true, err }));
  return s;
};

const envelope = (message) => ({
  message: { data: Buffer.from(JSON.stringify(message)).toString('base64'), messageId: '1', publishTime: '2026-10-21T20:00:00.000Z' },
  subscription: 'projects/ssfskim-ci-kit/subscriptions/ci-kit-tick-requests-launcher',
});

for (const delayMs of [0, 100]) {
  const late = delayMs ? `, the request reaching the handler ${delayMs} ms late` : '';

  test(`a push is answered with its tick's outcome once that tick has ended, and logs the job that asked${late}`, async (t) => {
    let end = null;
    const l = await launcher(() => new Promise((resolve) => { end = resolve; }), { delayMs });
    t.after(l.close);
    const answered = watch(l.call('/request', { body: envelope({ repo: 'SSFSKIM/MAWS', job: 7, delivery: 'd-1' }) }));
    await until(() => end !== null);
    await notYet();
    assert.equal(answered.done, false); // its tick is still running
    end({ launched: ['a'] });
    await until(() => answered.done);
    assert.deepEqual(answered.v, { status: 200, body: { launched: ['a'] } });
    assert.deepEqual(l.asked, ['requested']);
    assert.equal(l.logs[0].message, 'tick request: SSFSKIM/MAWS job 7');
    assert.deepEqual(l.logs[0].request, { repo: 'SSFSKIM/MAWS', job: 7, delivery: 'd-1', published: '2026-10-21T20:00:00.000Z' });
  });

  test(`a push arriving mid-tick is answered only after the following tick, which serves it, has completed${late}`, async (t) => {
    let clock = 0;
    const sleepers = [];
    const ticks = [];
    const serve = createTicker({
      now: () => clock,
      sleep: (ms) => new Promise((resolve) => sleepers.push({ at: clock + ms, resolve })),
      budgetLow: () => false,
      tick: (info) => new Promise((resolve) => ticks.push({ ...info, resolve })),
    });
    const l = await launcher(serve, { delayMs });
    t.after(l.close);

    const first = watch(l.call('/request', { body: envelope({ job: 1 }) }));
    await until(() => ticks.length === 1); // an idle launcher ticks at once
    clock += 3_000;
    const second = watch(l.call('/request', { body: envelope({ job: 2 }) }));
    await until(() => l.asked.length === 2); // it reached the ticker mid-tick
    assert.equal(ticks.length, 1);

    ticks[0].resolve({ tick: 1 });
    await until(() => first.done);
    assert.deepEqual(first.v?.body, { tick: 1 });
    await until(() => sleepers.length === 1); // the pending tick waits out the spacing from the first one's start
    assert.equal(sleepers[0].at, TICK_SPACING_MS);
    await notYet();
    assert.equal(second.done, false); // not answered by the tick it arrived during

    clock += TICK_SPACING_MS - 3_000;
    sleepers.splice(0).forEach((s) => s.resolve());
    await until(() => ticks.length === 2);
    assert.deepEqual([ticks[1].trigger, ticks[1].requests], ['requested', 1]);
    await notYet();
    assert.equal(second.done, false); // held while the tick that serves it runs

    ticks[1].resolve({ tick: 2 });
    await until(() => second.done);
    assert.deepEqual(second.v, { status: 200, body: { tick: 2 } });
  });
}

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
