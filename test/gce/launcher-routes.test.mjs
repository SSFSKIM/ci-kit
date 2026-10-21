// The launcher's HTTP surface (spec 2026-10-21 M4): Cloud Scheduler's /tick waits for the tick that serves it and
// answers its outcome; Pub/Sub's /request is answered at once, whatever the tick it asked for does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler } from '../../gce/launcher/routes.mjs';

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
  return { call, asked, logs, close: () => new Promise((r) => server.close(r)) };
}

const envelope = (message) => ({
  message: { data: Buffer.from(JSON.stringify(message)).toString('base64'), messageId: '1', publishTime: '2026-10-21T20:00:00.000Z' },
  subscription: 'projects/ssfskim-ci-kit/subscriptions/ci-kit-tick-requests-launcher',
});

test('a push is answered 202 before its tick runs, and logs the job that asked', async (t) => {
  const l = await launcher(() => new Promise(() => {})); // a tick that never ends
  t.after(l.close);
  const res = await l.call('/request', { body: envelope({ repo: 'SSFSKIM/MAWS', job: 7, delivery: 'd-1' }) });
  assert.deepEqual([res.status, res.body], [202, { requested: true }]);
  assert.deepEqual(l.asked, ['requested']);
  assert.equal(l.logs[0].message, 'tick request: SSFSKIM/MAWS job 7');
  assert.deepEqual(l.logs[0].request, { repo: 'SSFSKIM/MAWS', job: 7, delivery: 'd-1', published: '2026-10-21T20:00:00.000Z' });
});

test('a push whose body is unreadable still asks for a tick', async (t) => {
  const l = await launcher(async () => ({}));
  t.after(l.close);
  assert.equal((await l.call('/request', { body: { not: 'an envelope' } })).status, 202);
  assert.deepEqual(l.asked, ['requested']);
  assert.equal(l.logs[0].request, null);
});

test('a requested tick that fails is not the push\'s failure, and does not end the process', async (t) => {
  const l = await launcher(async () => { throw new Error('gce unreadable'); });
  t.after(l.close);
  assert.equal((await l.call('/request', { body: envelope({}) })).status, 202);
  await new Promise((r) => setImmediate(r));
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
