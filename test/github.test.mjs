// The REST client against a fake fetch: conditional requests (ETag / If-None-Match) and the rate-limit reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../lib/github.mjs';

// A fake fetch that answers from a script of responses, recording each request's headers.
function fakeFetch(responses) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url, headers: init.headers });
    const r = responses.shift();
    return new Response(r.status === 304 ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  return { impl, requests };
}

const RUN = { id: 7, status: 'in_progress', conclusion: null };

test('a repeated poll sends If-None-Match and a 304 returns the cached body', async () => {
  const f = fakeFetch([
    { status: 200, body: RUN, headers: { etag: 'W/"abc"', 'x-ratelimit-remaining': '4900' } },
    { status: 304, headers: { etag: 'W/"abc"', 'x-ratelimit-remaining': '4900' } },
  ]);
  const gh = createGitHub('t', { fetchImpl: f.impl });
  assert.deepEqual(await gh.getRun('o/r', 7), RUN);
  assert.deepEqual(await gh.getRun('o/r', 7), RUN);
  assert.equal(f.requests[0].headers['if-none-match'], undefined);
  assert.equal(f.requests[1].headers['if-none-match'], 'W/"abc"');
  assert.deepEqual(gh.stats(), { requests: 2, notModified: 1, remaining: 4900, reset: null });
});

test('a changed resource replaces the cached body and ETag', async () => {
  const done = { ...RUN, status: 'completed', conclusion: 'success' };
  const f = fakeFetch([
    { status: 200, body: RUN, headers: { etag: '"1"' } },
    { status: 200, body: done, headers: { etag: '"2"' } },
    { status: 304, headers: {} },
  ]);
  const gh = createGitHub('t', { fetchImpl: f.impl });
  await gh.getRun('o/r', 7);
  assert.deepEqual(await gh.getRun('o/r', 7), done);
  assert.deepEqual(await gh.getRun('o/r', 7), done);
  assert.equal(f.requests[2].headers['if-none-match'], '"2"');
});

test('job listings are conditional too', async () => {
  const jobs = { total_count: 1, jobs: [{ id: 1, name: 'ci / plan' }] };
  const f = fakeFetch([
    { status: 200, body: jobs, headers: { etag: '"j"' } },
    { status: 304, headers: {} },
  ]);
  const gh = createGitHub('t', { fetchImpl: f.impl });
  await gh.listJobs('o/r', 7);
  assert.deepEqual(await gh.listJobs('o/r', 7), jobs.jobs);
  assert.equal(f.requests[1].headers['if-none-match'], '"j"');
});

test('remaining is the latest X-RateLimit-Remaining; a response without it leaves it alone', async () => {
  const f = fakeFetch([
    { status: 200, body: RUN, headers: { 'x-ratelimit-remaining': '812' } },
    { status: 200, body: RUN, headers: {} },
    { status: 200, body: RUN, headers: { 'x-ratelimit-remaining': '499' } },
  ]);
  const gh = createGitHub('t', { fetchImpl: f.impl });
  assert.equal(gh.stats().remaining, null);
  await gh.getRun('o/r', 1);
  assert.equal(gh.stats().remaining, 812);
  await gh.getRun('o/r', 2);
  assert.equal(gh.stats().remaining, 812);
  await gh.getRun('o/r', 3);
  assert.equal(gh.stats().remaining, 499);
});

test('an error response still updates remaining, and throws with its status', async () => {
  const f = fakeFetch([{ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } }]);
  const gh = createGitHub('t', { fetchImpl: f.impl });
  await assert.rejects(gh.getRun('o/r', 1), (e) => e.status === 403 && /rate limit exceeded/.test(e.message));
  assert.equal(gh.stats().remaining, 0);
});

test('remaining is the lowest budget among the windows still open (GitHub reports more than one)', async () => {
  // Recorded 2026-10-15: one poll's run and jobs responses carried different windows (resets 1792112074 and
  // 1792112484, remaining 4675 and 4827).
  const f = fakeFetch([
    { status: 200, body: RUN, headers: { 'x-ratelimit-remaining': '4675', 'x-ratelimit-reset': '1792112074' } },
    { status: 200, body: RUN, headers: { 'x-ratelimit-remaining': '4827', 'x-ratelimit-reset': '1792112484' } },
  ]);
  let nowMs = 1792112000 * 1000;
  const gh = createGitHub('t', { fetchImpl: f.impl, now: () => nowMs });
  await gh.getRun('o/r', 1);
  await gh.getRun('o/r', 2);
  assert.equal(gh.stats().remaining, 4675);
  nowMs = 1792112100 * 1000; // the first window has reset
  assert.equal(gh.stats().remaining, 4827);
});

test('a transport failure is counted and reported to onRequest, then rethrown', async () => {
  const seen = [];
  const gh = createGitHub('t', {
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
    onRequest: (r) => seen.push(r),
  });
  await assert.rejects(gh.getRun('o/r', 1), /fetch failed/);
  assert.equal(gh.stats().requests, 1);
  assert.deepEqual(seen, [{ method: 'GET', path: '/repos/o/r/actions/runs/1', status: 'failed: fetch failed', remaining: null }]);
});

test('stats reports the reset of the lowest open window', async () => {
  const f = fakeFetch([
    { status: 200, body: RUN, headers: { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '1792112074' } },
    { status: 200, body: RUN, headers: { 'x-ratelimit-remaining': '4827', 'x-ratelimit-reset': '1792112484' } },
  ]);
  const gh = createGitHub('t', { fetchImpl: f.impl, now: () => 1792112000 * 1000 });
  await gh.getRun('o/r', 1);
  await gh.getRun('o/r', 2);
  assert.deepEqual([gh.stats().remaining, gh.stats().reset], [10, 1792112074]);
});
