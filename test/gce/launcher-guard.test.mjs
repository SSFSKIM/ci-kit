// The EC2 guard's trigger (ci-kit#222), through the real REST client against a fake fetch: each call dispatches
// pool-guard.yml on the kit's main and reads its newest successful run, and a guard silent for over an hour, or a
// dispatch that failed, is an ERROR line (the first is what gce/deploy.sh alert mails the owner for).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../../lib/github.mjs';
import { createGuardTrigger, GUARD_SILENT_MS } from '../../gce/launcher/guard.mjs';

const NOW = Date.parse('2026-11-19T22:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// answer(method, path, body): the fake GitHub's response, a {status, body}.
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

const github = (lastSuccess, { dispatch = { status: 200, body: { workflow_run_id: 42 } } } = {}) => ({ method, path }) => {
  if (method === 'POST') return dispatch;
  return { status: 200, body: { workflow_runs: lastSuccess ? [{ id: 41, updated_at: lastSuccess }] : [] } };
};

test('a dispatch on main and one read of the newest successful run: two calls, and a recent success is INFO', async () => {
  const t = trigger(github(ago(16 * 60_000)));
  assert.deepEqual(await t.guard(), { dispatched: 42, lastSuccess: { id: 41, completed: ago(16 * 60_000) } });
  assert.deepEqual(t.requests, [
    { method: 'POST', path: '/repos/SSFSKIM/ci-kit/actions/workflows/pool-guard.yml/dispatches', body: { ref: 'main', inputs: {}, return_run_details: true } },
    { method: 'GET', path: '/repos/SSFSKIM/ci-kit/actions/workflows/pool-guard.yml/runs?status=success&per_page=1', body: undefined },
  ]);
  assert.deepEqual(t.logs.map((l) => l.severity), ['INFO']);
});

test('no successful run in over an hour, or none at all, is one ERROR line with the event the alert matches', async () => {
  for (const last of [ago(GUARD_SILENT_MS + 60_000), null]) {
    const t = trigger(github(last));
    const out = await t.guard();
    assert.equal(out.dispatched, 42);
    assert.equal(t.logs.length, 1);
    assert.equal(t.logs[0].severity, 'ERROR');
    assert.equal(t.logs[0].event, 'pool-guard-silent');
    assert.match(t.logs[0].message, last ? new RegExp(`since ${last}`) : /no successful run ever/);
  }
  // An hour exactly is still within bounds: four triggers missed is the threshold, not three.
  const t = trigger(github(ago(GUARD_SILENT_MS)));
  await t.guard();
  assert.equal(t.logs[0].severity, 'INFO');
});

test('a failed dispatch is an ERROR line and throws, without reading the runs', async () => {
  const t = trigger(github(ago(60_000), { dispatch: { status: 422, body: { message: 'Workflow does not have workflow_dispatch trigger' } } }));
  await assert.rejects(t.guard(), /422/);
  assert.equal(t.requests.length, 1);
  assert.deepEqual(t.logs.map((l) => [l.severity, l.event]), [['ERROR', 'pool-guard-dispatch-failed']]);
});

test('an unreadable run list after a good dispatch is a WARNING, not a silent guard, and still succeeds', async () => {
  const t = trigger(({ method }) => (method === 'POST' ? { status: 200, body: { workflow_run_id: 42 } } : { status: 502, body: { message: 'bad gateway' } }));
  assert.deepEqual(await t.guard(), { dispatched: 42 });
  assert.deepEqual(t.logs.map((l) => l.severity), ['WARNING']);
});

test('a client that cannot be set up (the App key unreadable) fails the dispatch', async () => {
  const logs = [];
  const guard = createGuardTrigger({ github: async () => { throw new Error('secret unreadable'); }, say: (severity, message, extra) => logs.push({ severity, ...extra }) });
  await assert.rejects(guard(), /secret unreadable/);
  assert.deepEqual(logs, [{ severity: 'ERROR', event: 'pool-guard-dispatch-failed' }]);
});
