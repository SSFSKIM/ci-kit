// The EC2 guard's trigger (ci-kit#222), through the real REST client against a fake fetch: each call dispatches
// pool-guard.yml on the kit's main and, whatever the dispatch did, reads its newest successful run on main. A guard
// with no such run in over an hour is an ERROR line (what gce/deploy.sh alert mails the owner for); a failed dispatch
// or read is an ERROR line too, and a thrown error, which the route answers 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../../lib/github.mjs';
import { createGuardTrigger, GUARD_SILENT_MS } from '../../gce/launcher/guard.mjs';

const NOW = Date.parse('2026-11-19T22:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const DISPATCH = '/repos/SSFSKIM/ci-kit/actions/workflows/pool-guard.yml/dispatches';
const RUNS = '/repos/SSFSKIM/ci-kit/actions/workflows/pool-guard.yml/runs?branch=main&status=success&per_page=1';

// answer({method, path, body}): the fake GitHub's response, a {status, body}.
function trigger(answer) {
  const requests = [];
  const logs = [];
  const gh = createGitHub('t', {
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      const call = { method: init.method, path: u.pathname + u.search, body: init.body && JSON.parse(init.body) };
      requests.push(call);
      const r = answer(call);
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    },
  });
  const guard = createGuardTrigger({ github: async () => gh, say: (severity, message, extra) => logs.push({ severity, message, ...extra }), now: () => NOW });
  return { guard, requests, logs };
}

const DISPATCHED = { status: 200, body: { workflow_run_id: 42 } };
const REFUSED = { status: 403, body: { message: 'Resource not accessible by integration' } };
const github = (lastSuccess, { dispatch = DISPATCHED, runs } = {}) => ({ method }) => {
  if (method === 'POST') return dispatch;
  return runs ?? { status: 200, body: { workflow_runs: lastSuccess ? [{ id: 41, updated_at: lastSuccess }] : [] } };
};
const events = (logs) => logs.map((l) => [l.severity, l.event]);

test('a dispatch on main and one read of the newest successful run on main: two calls, and a recent success is INFO', async () => {
  const t = trigger(github(ago(16 * 60_000)));
  assert.deepEqual(await t.guard(), { dispatched: 42, lastSuccess: { id: 41, completed: ago(16 * 60_000) } });
  assert.deepEqual(t.requests, [
    { method: 'POST', path: DISPATCH, body: { ref: 'main', inputs: {}, return_run_details: true } },
    { method: 'GET', path: RUNS, body: undefined },
  ]);
  assert.deepEqual(events(t.logs), [['INFO', undefined]]);
});

test('no successful run in over an hour, or none at all, is one ERROR line with the event the alert matches', async () => {
  for (const last of [ago(GUARD_SILENT_MS + 60_000), null]) {
    const t = trigger(github(last));
    const out = await t.guard();
    assert.equal(out.dispatched, 42);
    assert.deepEqual(events(t.logs), [['ERROR', 'pool-guard-silent']]);
    assert.match(t.logs[0].message, last ? new RegExp(`since ${last}`) : /no successful run on main ever/);
  }
  // An hour exactly is still within bounds: four triggers missed is the threshold, not three.
  const t = trigger(github(ago(GUARD_SILENT_MS)));
  await t.guard();
  assert.equal(t.logs[0].severity, 'INFO');
});

test('a refused dispatch still reads the runs: its ERROR, the silence ERROR when the guard is silent, and a throw', async () => {
  for (const [last, expected] of [
    [ago(GUARD_SILENT_MS * 2), [['ERROR', 'pool-guard-dispatch-failed'], ['ERROR', 'pool-guard-silent']]],
    [ago(60_000), [['ERROR', 'pool-guard-dispatch-failed']]],
  ]) {
    const t = trigger(github(last, { dispatch: REFUSED }));
    await assert.rejects(t.guard(), /^Error: dispatch: HTTP 403 .*Resource not accessible by integration$/);
    assert.deepEqual(t.requests.map((r) => r.path), [DISPATCH, RUNS]);
    assert.deepEqual(events(t.logs), expected);
  }
});

test('an unreadable run list is an ERROR and a throw, even after a good dispatch; both failing names both', async () => {
  const unreadable = { status: 502, body: { message: 'bad gateway' } };
  let t = trigger(github(null, { runs: unreadable }));
  await assert.rejects(t.guard(), /^Error: runs: HTTP 502/);
  assert.deepEqual(events(t.logs), [['ERROR', 'pool-guard-check-failed']]);
  assert.equal(t.logs[0].dispatched, 42);
  t = trigger(github(null, { dispatch: REFUSED, runs: unreadable }));
  await assert.rejects(t.guard(), /^Error: dispatch: HTTP 403.*; runs: HTTP 502/);
  assert.deepEqual(events(t.logs), [['ERROR', 'pool-guard-dispatch-failed'], ['ERROR', 'pool-guard-check-failed']]);
});

test('a client that cannot be set up (the App key unreadable) is an ERROR and a throw', async () => {
  const logs = [];
  const guard = createGuardTrigger({ github: async () => { throw new Error('secret unreadable'); }, say: (severity, message, extra) => logs.push({ severity, ...extra }) });
  await assert.rejects(guard(), /secret unreadable/);
  assert.deepEqual(logs, [{ severity: 'ERROR', event: 'pool-guard-dispatch-failed' }]);
});
