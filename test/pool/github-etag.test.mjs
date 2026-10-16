// The pool agent polls GitHub every 10 s on the App's installation token. Its run and runner listings are
// conditional requests: an unchanged listing is answered 304, which costs no rate limit, and the client replays
// the body it already has (lib/github.mjs's ETag cache).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../../lib/github.mjs';

function fakeFetch(body) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const inm = init.headers['if-none-match'];
    seen.push([new URL(url).pathname, inm ?? null]);
    if (inm === '"v1"') return { ok: false, status: 304, headers: new Headers(), json: async () => { throw new Error('no body'); } };
    return { ok: true, status: 200, headers: new Headers({ etag: '"v1"' }), json: async () => body };
  };
  return { seen, fetchImpl };
}

test('the agent\'s run listings are conditional: an unchanged listing is a 304 answered from the remembered body', async () => {
  const f = fakeFetch({ workflow_runs: [{ id: 1 }] });
  const gh = createGitHub(async () => 'installation-token', { fetchImpl: f.fetchImpl });
  assert.deepEqual(await gh.runsByStatus('o/r', 'queued'), [{ id: 1 }]);
  assert.deepEqual(await gh.runsByStatus('o/r', 'queued'), [{ id: 1 }]);
  assert.deepEqual(f.seen.map((s) => s[1]), [null, '"v1"']);
  assert.equal(gh.stats().notModified, 1);
});

test('the agent\'s runner and job listings are conditional too', async () => {
  const runners = fakeFetch({ runners: [{ id: 7, name: 'ci-kit-pool-1-1' }] });
  const gh = createGitHub('t', { fetchImpl: runners.fetchImpl });
  await gh.runners('o/r');
  await gh.runners('o/r');
  assert.deepEqual(runners.seen.map((s) => s[1]), [null, '"v1"']);
  const jobs = fakeFetch({ jobs: [] });
  const gh2 = createGitHub('t', { fetchImpl: jobs.fetchImpl });
  await gh2.listJobs('o/r', 5);
  await gh2.listJobs('o/r', 5);
  assert.deepEqual(jobs.seen.map((s) => s[1]), [null, '"v1"']);
});

test('writes are never conditional and carry a JSON body', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(init);
    return { ok: true, status: 201, headers: new Headers(), json: async () => ({ runner: { id: 3 }, encoded_jit_config: 'x' }) };
  };
  const gh = createGitHub('t', { fetchImpl });
  await gh.jitConfig('o/r', { name: 'ci-kit-pool-1-1', labels: ['self-hosted'] });
  await gh.jitConfig('o/r', { name: 'ci-kit-pool-1-2', labels: ['self-hosted'] });
  assert.equal(sent[1].headers['if-none-match'], undefined);
  assert.equal(sent[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(sent[0].body), { runner_group_id: 1, work_folder: '_work', name: 'ci-kit-pool-1-1', labels: ['self-hosted'] });
});
