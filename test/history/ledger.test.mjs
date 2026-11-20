// The gate ledger's collection pass (gate ledger spec, "Reading GitHub cheaply and completely", M1's pins): the real
// client against a fake GitHub that answers the ledger's reads, a fake mirror, and a store in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub } from '../../lib/github.mjs';
import { gateAttempts } from '../../history/jobs.mjs';
import { collectLedger, createPacer } from '../../history/ledger.mjs';
import { openLedger } from '../../history/store.mjs';

const repos = JSON.parse(readFileSync(new URL('../../history/repos.json', import.meta.url), 'utf8'));
const MAWS = repos.find((r) => r.alias === 'SSFSKIM/MAWS');
const KIT = repos.find((r) => r.alias === 'SSFSKIM/ci-kit');
const listings = JSON.parse(readFileSync(new URL('./fixtures/rerun-listings.json', import.meta.url), 'utf8'));
const REPO = 'o/r';
const NOW = Date.parse('2026-11-19T12:00:00Z');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A fake GitHub. world: { runs: [run], jobs: { 'id/attempt': [job] }, conclusions: { 'id/attempt': c },
// annotations: { jobId: [message] } | 'refused', logs: { jobId: text }, overfull: [day] (a day whose whole-day
// listing reports more than 1,000 runs), failing: ['id/attempt'] (job listings answered 502), flaky: { day: n } (a
// day's whole-day listing answered 502 n times), limitAfter: n (every request after the first n is answered 403 for
// the rate limit), annotationsLimited: true (annotations answered 403 for the rate limit) }.
function fakeGitHub(world, { admit } = {}) {
  const requests = [];
  const fetchImpl = async (href) => {
    const url = new URL(href);
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    requests.push(`${path}${url.search}`);
    if (world.limitAfter !== undefined && requests.length > world.limitAfter) return json({ message: 'API rate limit exceeded for installation ID 1.' }, 403);
    let m;
    if ((m = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(path))) {
      const [from, to] = url.searchParams.get('created').split('..');
      const page = Number(url.searchParams.get('page'));
      const runs = world.runs.filter((r) => r.created_at >= from && r.created_at <= to).sort((a, b) => b.id - a.id);
      const wholeDay = from.endsWith('T00:00:00Z') && to.endsWith('T23:59:59Z');
      if (wholeDay && world.flaky?.[from.slice(0, 10)] > 0) {
        world.flaky[from.slice(0, 10)] -= 1;
        return json({ message: 'Server Error' }, 502);
      }
      const total = wholeDay && (world.overfull ?? []).includes(from.slice(0, 10)) ? 1500 : runs.length;
      return json({ total_count: total, workflow_runs: runs.slice((page - 1) * 100, page * 100) });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(path))) {
      if ((world.failing ?? []).includes(`${m[1]}/${m[2]}`)) return json({ message: 'Bad Gateway' }, 502);
      const jobs = world.jobs[`${m[1]}/${m[2]}`] ?? [];
      const page = Number(url.searchParams.get('page') ?? 1);
      return json({ total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(path))) return json({ id: Number(m[1]), run_attempt: Number(m[2]), conclusion: world.conclusions?.[`${m[1]}/${m[2]}`] ?? 'failure' });
    if ((m = /^\/check-runs\/(\d+)\/annotations$/.exec(path))) {
      if (world.annotationsLimited) return json({ message: 'API rate limit exceeded for installation ID 1.' }, 403);
      if (world.annotations === 'refused') return json({ message: 'Resource not accessible by integration' }, 403);
      return json((world.annotations?.[m[1]] ?? []).map((message) => ({ message, path: '.github', annotation_level: 'failure' })));
    }
    if ((m = /^\/actions\/jobs\/(\d+)\/logs$/.exec(path))) {
      const text = world.logs?.[m[1]];
      return text === undefined ? json({ message: 'Not Found' }, 404) : new Response(text, { status: 200 });
    }
    return json({ message: `fake: no route for ${path}` }, 404);
  };
  return { gh: createGitHub('t', { fetchImpl, ...(admit ? { admit } : {}) }), requests };
}

// A mirror that holds the given heads, each with its one parent.
const fakeMirror = (parents = {}) => ({
  fetch: (shas) => new Set(shas.filter((s) => s in parents)),
  parentOf: (sha) => parents[sha] ?? null,
  treeKey: (tree, policy) => (policy ? `key-${tree}` : tree),
});

const sha = (n) => String(n).padStart(40, '0');
const iso = (s) => s.replace(/\.\d{3}Z$/, 'Z');
const at = (base, minutes) => iso(new Date(Date.parse(base) + minutes * 60_000).toISOString());

// A run of the gate workflow, its listing shape; its jobs completed `minutes` after creation.
function gateRun(id, created, { attempt = 1, status = 'completed', conclusion = 'success', ref = `ci/work-${sha(id + 1).slice(0, 8)}`, message = 'ci-gate: x\n\nNonce: 1-1\nGates: unit' } = {}) {
  return { id, name: 'gate', path: '.github/workflows/gate.yml', event: 'push', head_branch: ref, head_sha: sha(id), head_commit: { tree_id: `tree${id}`, message }, pull_requests: [], status, conclusion, run_attempt: attempt, created_at: created };
}
const job = (id, name, created, minutes, { conclusion = 'success', started = created } = {}) => ({
  id, name, run_attempt: 1, status: 'completed', conclusion, created_at: created, started_at: started, completed_at: at(started, minutes),
  runner_name: 'ci-kit-gce-a1', labels: ['self-hosted', 'ci-kit-pool', 'cpus-8'], steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run pnpm test', conclusion: conclusion === 'success' ? 'success' : 'failure' }],
});
const shardJobs = (base, created, n, minutes) => Array.from({ length: n }, (_, i) => job(base + i, `unit ${i + 1}/${n}`, created, minutes));

function store() {
  const root = mkdtempSync(join(tmpdir(), 'ci-kit-ledger-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const jobsOfFor = (gh) => (run, attempt) => gh.attemptJobs(REPO, run, attempt);
// The client is admitted by the pacer, as the collector builds it.
const pass = (world, root, { pacerFor = null, entry = MAWS, mirror = fakeMirror(Object.fromEntries(world.runs.map((r) => [r.head_sha, sha(r.id + 1)]))), passId = 'p1', limit = 300, limits, now = NOW, listDelays = [0, 0] } = {}) => {
  const pacer = pacerFor ?? createPacer({ pass: passId, now: () => now, ...(limits ? { limits } : {}) });
  const fake = fakeGitHub(world, { admit: () => pacer.allows(entry.token, 1) });
  return collectLedger({ gh: fake.gh, repo: REPO, alias: 'o/r', entry, root, mirror, jobsOf: jobsOfFor(fake.gh), pacer, pass: passId, now, limit, listDelays }).then((result) => ({ ...result, requests: fake.requests }));
};
const allLines = (root) => {
  const dir = join(root, 'o/r/jobs');
  return readdirSync(dir).sort().flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const listingCalls = (requests) => requests.filter((r) => r.includes('/actions/workflows/')).length;

test('a pass lists 35 days by creation, writes each job by its completion day, and leaves a running run open', async () => {
  const s = store();
  try {
    const world = {
      runs: [gateRun(100, '2026-11-18T23:50:00Z'), gateRun(200, '2026-11-17T10:00:00Z', { status: 'in_progress', conclusion: null }), gateRun(300, '2026-11-16T09:00:00Z')],
      jobs: {
        '100/1': [job(1, 'plan', '2026-11-18T23:50:00Z', 1), ...shardJobs(2, '2026-11-18T23:51:00Z', 2, 5), job(4, 'e2e:desk-web', '2026-11-18T23:51:00Z', 20), { ...job(5, 'e2e:${{ matrix.group }}', '2026-11-18T23:51:00Z', 0), conclusion: 'skipped' }],
        '300/1': [job(6, 'probes', '2026-11-16T09:00:00Z', 2)],
      },
    };
    const r = await pass(world, s.root);
    assert.deepEqual(r.errors, []);
    assert.equal(listingCalls(r.requests), 35);
    assert.ok(r.requests.some((q) => q.includes(encodeURIComponent('2026-10-16T00:00:00Z..2026-10-16T23:59:59Z'))));
    assert.ok(!r.requests.some((q) => q.includes('/runs/200/')), 'a running run is not read');
    const lines = allLines(s.root);
    assert.deepEqual(lines.map((l) => [l.job, l.completed.slice(0, 10)]), [['probes', '2026-11-16'], ['plan', '2026-11-18'], ['unit 1/2', '2026-11-18'], ['unit 2/2', '2026-11-18'], ['e2e:desk-web', '2026-11-19']]);
    assert.ok(readdirSync(join(s.root, 'o/r/jobs')).includes('2026-11-19.jsonl'));
    const desk = lines.find((l) => l.job === 'e2e:desk-web');
    assert.equal(desk.producer, 'maws-ci-gate');
    assert.equal(desk.tested, sha(101));
    assert.equal(desk.tree_key, 'key-tree100');
    const ledger = openLedger(s.root, 'o/r');
    assert.deepEqual(ledger.state.runs['100'].closed, [1]);
    assert.deepEqual(ledger.state.runs['200'].closed, []);
    assert.equal(ledger.covered('2026-11-16'), true);
    assert.equal(ledger.covered('2026-11-17'), false, 'a day with an open attempt is not covered');
    assert.equal(ledger.covered('2026-11-18'), true);
    assert.equal(ledger.covered('2026-11-19'), false, 'a day not yet over is not covered');
    assert.equal(ledger.covered('2026-10-01'), false, 'a day never listed is not covered');
    assert.equal(ledger.jobLines('2026-11-18', '2026-11-18').length, 3);
    assert.equal(r.more, false);

    // The next day's pass finds the run finished, and its day covered.
    world.runs[1] = { ...world.runs[1], status: 'completed', conclusion: 'success' };
    world.jobs['200/1'] = [job(7, 'probes', '2026-11-17T10:00:00Z', 3)];
    const next = await pass(world, s.root, { passId: 'p2', now: NOW + 86_400_000 });
    assert.deepEqual(next.errors, []);
    assert.equal(openLedger(s.root, 'o/r').covered('2026-11-17'), true);
    // Nothing collected is read again, and no line is doubled.
    assert.ok(!next.requests.some((q) => q.includes('/runs/100/')));
    assert.equal(allLines(s.root).length, 6);
  } finally {
    s.cleanup();
  }
});

test("a pass's later batches take from its queue without listing again; a new pass lists", async () => {
  const s = store();
  try {
    const world = { runs: [gateRun(100, '2026-11-18T10:00:00Z'), gateRun(110, '2026-11-18T11:00:00Z')], jobs: { '100/1': [job(1, 'probes', '2026-11-18T10:00:00Z', 2)], '110/1': [job(2, 'probes', '2026-11-18T11:00:00Z', 2)] } };
    const first = await pass(world, s.root, { limit: 1 });
    assert.equal(first.more, true);
    assert.deepEqual(allLines(s.root).map((l) => l.run), [100], 'oldest first');
    const second = await pass(world, s.root, { limit: 1 });
    assert.equal(listingCalls(second.requests), 0);
    assert.deepEqual(allLines(s.root).map((l) => l.run), [100, 110]);
    assert.equal(second.more, false);
    const third = await pass(world, s.root, { passId: 'p2' });
    assert.equal(listingCalls(third.requests), 35);
  } finally {
    s.cleanup();
  }
});

test('a rerun of a run created 20 days ago is found, and only its new attempt is read', async () => {
  const s = store();
  try {
    const created = '2026-10-30T08:00:00Z';
    const world = { runs: [gateRun(500, created)], jobs: { '500/1': [job(1, 'unit 1/2', created, 4, { conclusion: 'failure' }), job(2, 'unit 2/2', created, 4)] } };
    await pass(world, s.root);
    // Twenty days on, a failed-jobs rerun: the shard that passed is listed as a copy (a new id, the new attempt's
    // number, its earlier times), the failed one ran again.
    world.runs[0] = { ...world.runs[0], run_attempt: 2 };
    const copy = { ...job(3, 'unit 2/2', created, 4), run_attempt: 2, created_at: '2026-11-19T09:00:00Z' };
    world.jobs['500/2'] = [copy, { ...job(4, 'unit 1/2', '2026-11-19T09:00:00Z', 5), run_attempt: 2 }];
    const r = await pass(world, s.root, { passId: 'p2' });
    assert.deepEqual(r.errors, []);
    // Attempt 1 is not collected again; its listing is read once, to place the copy.
    assert.equal(r.requests.filter((q) => q.includes('/runs/500/attempts/1/jobs')).length, 1);
    assert.equal(allLines(s.root).filter((l) => l.attempt === 1).length, 2);
    const second = allLines(s.root).filter((l) => l.attempt === 2);
    // The copy is filed beside its attempt's fresh job (2026-11-19), not on the day its shard ran (10-30).
    assert.deepEqual(openLedger(s.root, 'o/r').jobLines('2026-11-19', '2026-11-19').map((l) => l.job).sort(), ['unit 1/2', 'unit 2/2']);
    assert.deepEqual(second.map((l) => [l.job, l.copy, l.copied_from, l.minutes]).sort(), [['unit 1/2', false, null, 5], ['unit 2/2', true, 1, null]]);
    assert.equal(second[0].run_conclusion, 'success');
    assert.equal(allLines(s.root).find((l) => l.attempt === 1).run_conclusion, 'success', 'the listing gave attempt 1 as the latest then');
    const attempts = gateAttempts(allLines(s.root));
    assert.deepEqual(attempts.map((a) => [a.attempt, a.result, a.minutes]), [[1, 'failed', 8], [2, 'succeeded', 5]]);
  } finally {
    s.cleanup();
  }
});

test("a real failed-jobs rerun (MAWS 44468141412): copies carry their attempt, no minutes, and the earlier attempt's own conclusion", async () => {
  const s = store();
  try {
    const fx = listings.find((l) => l.run === 44468141412);
    const run = { ...gateRun(fx.run, '2026-11-19T05:52:30Z', { attempt: 2 }), head_sha: sha(fx.run) };
    const lost = fx.attempts[1].find((j) => j.name === 'static-local');
    const world = {
      runs: [run], jobs: { [`${fx.run}/1`]: fx.attempts[1], [`${fx.run}/2`]: fx.attempts[2] }, conclusions: { [`${fx.run}/1`]: 'failure' },
      annotations: { [lost.id]: ['The self-hosted runner: ci-kit-gce-ht8ps9vecf lost communication with the server.'] },
    };
    const r = await pass(world, s.root);
    assert.deepEqual(r.errors, []);
    const lines = allLines(s.root);
    const a2 = lines.filter((l) => l.attempt === 2);
    assert.deepEqual(a2.filter((l) => l.copied_from !== null).map((l) => l.job).sort(), ['e2e:cross-build', 'plan', 'probes', 'unit 1/4', 'unit 2/4', 'unit 3/4', 'unit 4/4']);
    assert.ok(a2.filter((l) => l.copied_from !== null).every((l) => l.copied_from === 1 && l.minutes === null));
    assert.ok(!lines.some((l) => l.conclusion === 'skipped'));
    const first = lines.filter((l) => l.attempt === 1);
    assert.ok(first.every((l) => l.run_conclusion === 'failure'));
    assert.deepEqual(first.find((l) => l.job === 'static-local').annotations, ['runner-lost']);
    assert.equal(first.find((l) => l.job === 'static-local').phase, 'lost');
    assert.equal(first.find((l) => l.job === 'e2e:cross-build').lane, 'hosted-macos');
    const byGate = (attempt) => Object.fromEntries(gateAttempts(lines).filter((a) => a.attempt === attempt).map((a) => [a.gate, [a.result, a.minutes]]));
    assert.equal(first.find((l) => l.job === 'static').role, 'summary');
    assert.deepEqual(byGate(1), { static: ['failed', 10], unit: ['succeeded', 21.2], probes: ['succeeded', 0.6], 'e2e:cross-build': ['succeeded', 14.3] });
    assert.deepEqual(byGate(2), { static: ['succeeded', 3.2], unit: ['succeeded', 0], probes: ['succeeded', 0], 'e2e:cross-build': ['succeeded', 0] });
  } finally {
    s.cleanup();
  }
});

test('where annotations are refused the log is read, and a job with neither keeps none', async () => {
  const s = store();
  try {
    const created = '2026-11-18T10:00:00Z';
    const world = {
      runs: [gateRun(600, created, { ref: 'ci/gate-00000000-ab12cd', message: 'ci-gate 0123\n\nCI-Gates: test' })],
      jobs: { '600/1': [job(1, 'ci / test', created, 30, { conclusion: 'cancelled' }), job(2, 'ci / lint', created, 1, { conclusion: 'failure' })] },
      annotations: 'refused',
      logs: { 1: `${'noise\n'.repeat(5000)}##[error]The job running on runner GitHub Actions 1 has exceeded the maximum execution time of 30 minutes.\n` },
    };
    const r = await pass(world, s.root, { entry: KIT, mirror: fakeMirror({ [sha(600)]: sha(0) }) });
    assert.deepEqual(r.errors, []);
    const lines = allLines(s.root);
    assert.deepEqual(lines.find((l) => l.job === 'ci / test').annotations, []);
    assert.deepEqual(lines.find((l) => l.job === 'ci / test').log_kinds, ['time-limit'], 'read from the log, and marked so');
    assert.deepEqual(lines.find((l) => l.job === 'ci / lint').annotations, []);
    assert.deepEqual(lines.find((l) => l.job === 'ci / lint').log_kinds, []);
    const test0 = lines.find((l) => l.job === 'ci / test');
    assert.equal(test0.gate, 'test');
    assert.equal(test0.tree_key, 'tree600', 'no path policy: the tree is its key');
    assert.equal(test0.change, null, "ci-kit's fallback label is no change");
    // Once refused, annotations are not asked for again.
    assert.equal(r.requests.filter((q) => q.includes('/annotations')).length, 1);
    assert.equal(openLedger(s.root, 'o/r').state.annotations, 'refused');
  } finally {
    s.cleanup();
  }
});

test('a day of more than 1,000 runs is listed hour by hour', async () => {
  const s = store();
  try {
    const runs = [gateRun(700, '2026-11-10T03:10:00Z'), gateRun(701, '2026-11-10T21:59:00Z')];
    const world = { runs, jobs: { '700/1': [job(1, 'probes', runs[0].created_at, 1)], '701/1': [job(2, 'probes', runs[1].created_at, 1)] }, overfull: ['2026-11-10'] };
    const r = await pass(world, s.root);
    assert.deepEqual(r.errors, []);
    const hourly = r.requests.filter((q) => q.includes('/actions/workflows/') && q.includes('2026-11-10T') && !q.includes(encodeURIComponent('T00:00:00Z..2026-11-10T23:59:59Z')));
    assert.equal(hourly.length, 24);
    assert.deepEqual(allLines(s.root).map((l) => l.run), [700, 701]);
  } finally {
    s.cleanup();
  }
});

test("work stops at the pass's call limit, and at the hour's with a wait", async () => {
  const s = store();
  try {
    const runs = Array.from({ length: 10 }, (_, i) => gateRun(800 + i, `2026-11-18T0${i}:00:00Z`));
    const world = { runs, jobs: Object.fromEntries(runs.map((r, i) => [`${r.id}/1`, [job(i + 1, 'probes', r.created_at, 1)]])) };
    const r = await pass(world, s.root, { limits: { app: { pass: 40, hour: 1000 } } });
    assert.ok(r.requests.length <= 40, `${r.requests.length} calls`);
    assert.equal(r.more, false, 'nothing more this pass');
    assert.equal(r.wait, null);
    assert.equal(allLines(s.root).length, 4); // 35 listing calls, then one call an attempt while two fit
    assert.equal(openLedger(s.root, 'o/r').state.pass.calls, r.requests.length);
    // A second batch of the same pass takes nothing.
    const again = await pass(world, s.root, { limits: { app: { pass: 40, hour: 1000 } } });
    assert.equal(again.requests.length, 0);

    const t = store();
    try {
      const hour = await pass(world, t.root, { limits: { app: { pass: 1000, hour: 40 } } });
      assert.equal(hour.more, true);
      assert.ok(hour.wait >= 60 && hour.wait <= 3660, `wait ${hour.wait}`);
    } finally {
      t.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

test('a pass interrupted between batches, or inside one, resumes without a missing or a doubled line', async () => {
  const s = store();
  try {
    const runs = Array.from({ length: 4 }, (_, i) => gateRun(900 + i, `2026-11-18T0${i}:00:00Z`));
    const world = { runs, jobs: Object.fromEntries(runs.map((r, i) => [`${r.id}/1`, [job(10 * i + 1, 'probes', r.created_at, 1), job(10 * i + 2, 'static-local', r.created_at, 2)]])) };
    await pass(world, s.root, { limit: 1 });
    // A batch that wrote its job lines and stopped before attempts.json: the next batch starts from the same state.
    const attemptsFile = join(s.root, 'o/r/attempts.json');
    const before = readFileSync(attemptsFile);
    await pass(world, s.root, { limit: 2 });
    writeFileSync(attemptsFile, before);
    // An item whose listing fails is left for a later batch.
    const failed = await pass({ ...world, failing: ['902/1'] }, s.root, { limit: 2 });
    assert.equal(failed.errors.length, 1);
    assert.match(failed.errors[0], /^run 902 attempt 1: HTTP 502/);
    await pass(world, s.root);
    const lines = allLines(s.root);
    const keys = lines.map((l) => `${l.run}/${l.attempt}/${l.job_id}`);
    assert.equal(new Set(keys).size, keys.length, 'no doubled line');
    assert.deepEqual([...new Set(lines.map((l) => l.run))], [900, 901, 902, 903], 'no missing run');
    assert.equal(lines.length, 8);
    assert.equal(openLedger(s.root, 'o/r').state.pass.queue.length, 0);
  } finally {
    s.cleanup();
  }
});

test('days a listing could not reach stay pending, and a day it listed is not covered while its runs are open', async () => {
  const s = store();
  try {
    const world = { runs: [gateRun(990, '2026-10-17T08:00:00Z')], jobs: { '990/1': [job(1, 'probes', '2026-10-17T08:00:00Z', 1)] } };
    const r = await pass(world, s.root, { limits: { app: { pass: 5, hour: 1000 } } });
    assert.equal(listingCalls(r.requests), 5);
    assert.equal(r.more, false, 'the pass has spent its calls');
    const ledger = openLedger(s.root, 'o/r');
    assert.equal(ledger.state.pass.pending.length, 30);
    assert.equal(ledger.state.pass.queue.length, 1);
    assert.equal(ledger.state.pass.calls, 5);
    assert.ok('2026-10-17' in ledger.state.listed);
    assert.equal(ledger.covered('2026-10-17'), false);
    assert.equal(ledger.covered('2026-10-16'), true, 'a listed day with no runs');
    // The same pass with calls to spare lists only the pending days, then works.
    const next = await pass(world, s.root);
    assert.equal(listingCalls(next.requests), 30);
    assert.deepEqual(allLines(s.root).map((l) => l.run), [990]);
    assert.equal(openLedger(s.root, 'o/r').covered('2026-10-17'), true);
  } finally {
    s.cleanup();
  }
});

test('a listing answered with a server error is tried again; one that keeps failing leaves its day pending', async () => {
  const s = store();
  try {
    const world = { runs: [gateRun(995, '2026-11-12T08:00:00Z')], jobs: { '995/1': [job(1, 'probes', '2026-11-12T08:00:00Z', 1)] }, flaky: { '2026-11-12': 1 } };
    const r = await pass(world, s.root, { listDelays: [0, 0] });
    assert.deepEqual(r.errors, []);
    assert.equal(listingCalls(r.requests), 36);
    assert.deepEqual(allLines(s.root).map((l) => l.run), [995]);
    const t = store();
    try {
      const bad = await pass({ ...world, flaky: { '2026-11-12': 9 } }, t.root, { listDelays: [0, 0] });
      assert.equal(bad.errors.length, 1);
      assert.match(bad.errors[0], /^listing 2026-11-12: HTTP 502/);
      assert.deepEqual(openLedger(t.root, 'o/r').state.pass.pending, ['2026-11-12']);
      assert.equal(bad.more, true);
    } finally {
      t.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

test("a batch counts every repository's calls of the pass from its start, not only those it has reached", async () => {
  const s = store();
  try {
    const world = { runs: Array.from({ length: 6 }, (_, i) => gateRun(1000 + i, `2026-11-18T0${i}:00:00Z`)), jobs: {} };
    world.runs.forEach((r, i) => { world.jobs[`${r.id}/1`] = [job(i + 1, 'probes', r.created_at, 1)]; });
    // Another repository of the same token already spent the pass's calls in an earlier batch.
    const other = openLedger(s.root, 'o/other');
    other.state.pass = { id: 'p1', listed_at: null, calls: 60, pending: [], queue: [] };
    const pacer = createPacer({ pass: 'p1', now: () => NOW, limits: { app: { pass: 80, hour: 1000 } } });
    pacer.add('app', other.state);
    const r = await pass(world, s.root, { pacerFor: pacer });
    assert.ok(r.requests.length <= 20, `${r.requests.length} calls`);
    assert.equal(r.more, false);
  } finally {
    s.cleanup();
  }
});

test("a failure-heavy chunk never passes the hour's limit: the request past it is not made, and the attempt stays queued", async () => {
  const s = store();
  try {
    // Each attempt has ten failed jobs, each an annotations call: far more than the two calls an attempt the chunk
    // is admitted on.
    const runs = Array.from({ length: 4 }, (_, i) => gateRun(1100 + i, `2026-11-18T0${i}:00:00Z`));
    const world = { runs, jobs: {} };
    runs.forEach((r, i) => { world.jobs[`${r.id}/1`] = Array.from({ length: 10 }, (_, k) => job(100 * i + k + 1, `e2e:g${k}`, r.created_at, 1, { conclusion: 'failure' })); });
    const limits = { app: { pass: 1000, hour: 50 } };
    const r = await pass(world, s.root, { limits });
    assert.ok(r.requests.length <= 50, `${r.requests.length} calls, the hour allows 50`);
    assert.deepEqual(r.errors, [], 'a budget stop is no error');
    assert.equal(r.more, true);
    assert.ok(r.wait >= 60, `wait ${r.wait}`);
    const state = openLedger(s.root, 'o/r').state;
    assert.equal(state.pass.calls, r.requests.length, 'every request is counted');
    const closed = Object.values(state.runs).filter((x) => x.closed.length).length;
    assert.equal(allLines(s.root).length, closed * 10, 'a cut attempt writes no line');
    assert.equal(state.pass.queue.length, 4 - closed);
    // An hour later the rest is taken, with no line doubled.
    const later = await pass(world, s.root, { limits, now: NOW + 3_700_000 });
    assert.ok(later.requests.length <= 50);
    const again = await pass(world, s.root, { limits, now: NOW + 7_400_000 });
    assert.ok(again.requests.length <= 50);
    const lines = allLines(s.root);
    assert.equal(new Set(lines.map((l) => l.job_id)).size, lines.length);
    assert.equal(lines.length, 40);
  } finally {
    s.cleanup();
  }
});

test('a paginated day with few calls left stays pending whole, and the next batch lists it in full', async () => {
  const s = store();
  try {
    const runs = Array.from({ length: 150 }, (_, i) => gateRun(2000 + i, `2026-11-18T0${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}:00Z`));
    const world = { runs, jobs: Object.fromEntries(runs.map((r, i) => [`${r.id}/1`, [job(5000 + i, 'probes', r.created_at, 1)]])) };
    // 33 days list in one call each; the 34th (11-18, two pages) is reached with one call left.
    const limits = { app: { pass: 1000, hour: 34 } };
    const r = await pass(world, s.root, { limits });
    assert.equal(r.requests.length, 34);
    let state = openLedger(s.root, 'o/r').state;
    assert.ok(state.pass.pending.includes('2026-11-18'));
    assert.ok(!('2026-11-18' in state.listed), 'a day half listed is not listed');
    const next = await pass(world, s.root, { limits: { app: { pass: 1000, hour: 1000 } }, now: NOW + 3_700_000 });
    assert.deepEqual(next.errors, []);
    state = openLedger(s.root, 'o/r').state;
    assert.deepEqual(state.pass.pending, []);
    assert.equal(new Set(allLines(s.root).map((l) => l.run)).size, 150, 'no run missing');
  } finally {
    s.cleanup();
  }
});

test("GitHub's rate limit stops the pass at once and leaves its work for later", async () => {
  const s = store();
  try {
    const world = { runs: [gateRun(3000, '2026-11-18T08:00:00Z')], jobs: { '3000/1': [job(1, 'probes', '2026-11-18T08:00:00Z', 1)] }, limitAfter: 3 };
    const r = await pass(world, s.root);
    assert.equal(r.requests.length, 4, 'nothing is asked after the first refusal');
    assert.equal(r.more, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^listing \d{4}-\d\d-\d\d: HTTP 403 \(rate limited\)$/);
    assert.equal(openLedger(s.root, 'o/r').state.pass.pending.length, 32);
    // In the job loop too: an annotations call refused for the rate limit is no refusal of annotations.
    const t = store();
    try {
      const w2 = { runs: [gateRun(3100, '2026-11-18T08:00:00Z'), gateRun(3101, '2026-11-18T09:00:00Z')], jobs: { '3100/1': [job(1, 'probes', '2026-11-18T08:00:00Z', 1, { conclusion: 'failure' })], '3101/1': [job(2, 'probes', '2026-11-18T09:00:00Z', 1, { conclusion: 'failure' })] }, annotationsLimited: true };
      const r2 = await pass(w2, t.root);
      const state = openLedger(t.root, 'o/r').state;
      assert.notEqual(state.annotations, 'refused');
      assert.equal(r2.requests.filter((q) => q.includes('/annotations')).length, 1);
      assert.equal(r2.requests.filter((q) => q.includes('/logs')).length, 0);
      assert.equal(state.pass.queue.length, 2, 'both attempts stay queued');
      assert.equal(r2.more, false);
    } finally {
      t.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

test("a rerun's copies fold the same from any window that holds its fresh jobs", async () => {
  const s = store();
  try {
    // The copied shards ran on 11-17; the rerun's fresh shard ran on 11-18.
    const created = '2026-11-17T22:00:00Z';
    const world = { runs: [gateRun(4000, created, { attempt: 2 })], jobs: {
      '4000/1': [job(1, 'unit 1/3', created, 30), job(2, 'unit 2/3', created, 30), job(3, 'unit 3/3', created, 30, { conclusion: 'failure' })],
      '4000/2': [{ ...job(11, 'unit 1/3', created, 30), created_at: '2026-11-18T09:00:00Z' }, { ...job(12, 'unit 2/3', created, 30), created_at: '2026-11-18T09:00:00Z' }, job(13, 'unit 3/3', '2026-11-18T09:00:00Z', 6)],
    } };
    const r = await pass(world, s.root);
    assert.deepEqual(r.errors, []);
    const ledger = openLedger(s.root, 'o/r');
    const fold = (from, to) => gateAttempts(ledger.jobLines(from, to)).filter((a) => a.attempt === 2).map((a) => [a.gate, a.result, a.minutes, a.available, a.copied]);
    assert.deepEqual(fold('2026-11-18', '2026-11-18'), [['unit', 'succeeded', 6, '2026-11-18T09:06:00Z', false]]);
    assert.deepEqual(fold('2026-11-01', '2026-11-30'), fold('2026-11-18', '2026-11-18'));
  } finally {
    s.cleanup();
  }
});

test("a copy is filed by its own gate's availability, whatever another job of the rerun does after midnight", async () => {
  const s = store();
  try {
    const created = '2026-11-17T20:00:00Z';
    // The rerun: unit's copied shard (11-17) and its fresh shard (11-18 23:50); probes, rerun too, ends after midnight.
    const world = { runs: [gateRun(4100, created, { attempt: 2 })], jobs: {
      '4100/1': [job(1, 'unit 1/2', created, 30), job(2, 'unit 2/2', created, 30, { conclusion: 'failure' }), job(3, 'probes', created, 5, { conclusion: 'failure' })],
      '4100/2': [{ ...job(11, 'unit 1/2', created, 30), created_at: '2026-11-18T23:40:00Z' }, job(12, 'unit 2/2', '2026-11-18T23:40:00Z', 10), job(13, 'probes', '2026-11-18T23:55:00Z', 20)],
    } };
    const r = await pass(world, s.root);
    assert.deepEqual(r.errors, []);
    const ledger = openLedger(s.root, 'o/r');
    assert.deepEqual(ledger.jobLines('2026-11-18', '2026-11-18').map((l) => l.job).sort(), ['unit 1/2', 'unit 2/2']);
    const unit = gateAttempts(ledger.jobLines('2026-11-18', '2026-11-18')).find((a) => a.attempt === 2);
    assert.deepEqual([unit.result, unit.available], ['succeeded', '2026-11-18T23:50:00Z']);
  } finally {
    s.cleanup();
  }
});

test("fresh shards of one gate across midnight fold whole from a window with a day's margin", async () => {
  const s = store();
  try {
    const created = '2026-11-17T23:50:00Z';
    const world = { runs: [gateRun(4200, created)], jobs: { '4200/1': [job(1, 'unit 1/2', created, 5), job(2, 'unit 2/2', created, 15)] } };
    await pass(world, s.root);
    const ledger = openLedger(s.root, 'o/r');
    // Each shard is filed by its own completion: one day holds half the attempt.
    assert.equal(gateAttempts(ledger.jobLines('2026-11-18', '2026-11-18'))[0].result, 'incomplete');
    // A reader of 11-18 that reads a day either side, attributing by `available`, has it whole.
    const [a] = gateAttempts(ledger.jobLines('2026-11-17', '2026-11-19'));
    assert.deepEqual([a.result, a.available.slice(0, 10)], ['succeeded', '2026-11-18']);
  } finally {
    s.cleanup();
  }
});
