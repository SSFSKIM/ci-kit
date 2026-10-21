// The collector against a fake GitHub (test history spec, M2): the real client, the system unzip and a store in a
// temp dir. One scripted repo holds the cases the spec names: two attempts of one run collected together, a fresh
// attempt of a run older than any window, a job with no artifact, both producers' refs and a dispatch, a report
// from outside its job, an unparseable one; and a second pass that changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createGitHub } from '../../lib/github.mjs';
import { collectRepo, formatCounts } from '../../history/collect.mjs';
import { parseJUnit } from '../../history/junit.mjs';
import { membershipOf, summarize } from '../../history/record.mjs';
import { fakeGitHub, vitestReport, zipOf } from './helpers.mjs';

const REPO = 'o/r';
const NOW = Date.parse('2026-10-21T12:00:00Z');
const at = (iso, sec) => new Date(Date.parse(iso) + sec * 1000).toISOString().replace('.000Z', 'Z');

const suitesA = ({ twoFails = false, extra = false, dropTwo = false } = {}) => [
  { project: 'app', file: 'src/a.test.ts', time: 1.5, cases: [
    { name: 'a > one' },
    ...(dropTwo ? [] : [{ name: 'a > two', ...(twoFails ? { status: 'failed', message: 'timed out' } : {}) }]),
    { name: 'a > later', status: 'skipped' },
  ] },
  { project: 'app-compiled', file: 'src/a.test.ts', time: 2.5, cases: [{ name: 'a > one' }] },
  ...(extra ? [{ project: 'app', file: 'src/c.test.ts', time: 0.5, cases: [{ name: 'c > new' }] }] : []),
];

function scenario() {
  const repo = { runs: [], jobs: {}, commits: {}, ancestors: {}, changed: {}, artifacts: [] };
  const reports = new Map(); // artifact id → the report's XML
  let artifactId = 500;
  let jobId = 9000;
  const upload = (conclusion = 'success') => [
    { name: 'Set up job', conclusion: 'success' },
    { name: 'Run rm -rf ci-results', conclusion: conclusion === 'skipped' ? 'failure' : 'success' },
    { name: 'Run actions/upload-artifact@v7', conclusion },
  ];
  // A gate run: a nonce commit on top of `tested` for the ci-gates, the head itself otherwise.
  function run({ id, ref, event = 'push', tested, tree, created, attempts }) {
    const nonce = event === 'push' && ref.startsWith('ci/');
    const head = nonce ? `${id}0000000000000000000000000000000000000`.slice(0, 40) : tested;
    if (nonce) repo.commits[head] = { tree, parents: [tested], message: `ci-gate: ${tested.slice(0, 8)}\n\nNonce: 1-2\nGates: static,unit` };
    repo.commits[tested] = { tree, parents: ['0'.repeat(40)], message: 'work' };
    repo.runs.push({ id, event, head_branch: ref, head_sha: head, path: '.github/workflows/gate.yml', run_attempt: attempts.length, created_at: created });
    attempts.forEach((jobs, i) => {
      repo.jobs[`${id}/${i + 1}`] = jobs.map((j) => {
        const job = { id: jobId++, name: j.name, status: 'completed', conclusion: j.conclusion ?? 'success', created_at: j.created ?? j.started, started_at: j.started, completed_at: j.completed, runner_name: 'runner-1', steps: j.steps ?? upload() };
        const xml = j.xml ?? (j.suites && vitestReport({ timestamp: j.stamp ?? at(j.completed, -60).replace('Z', '.000Z'), suites: j.suites }));
        if (xml !== undefined || j.zip) {
          const a = { id: artifactId++, name: j.artifact ?? `test-results-${j.name.replace(':', '-')}-${i + 1}`, run: id, created_at: at(j.completed, -5), expired: j.expired ?? false, zip: j.zip ?? zipOf({ [`${j.name.replace(':', '-')}.xml`]: xml }) };
          repo.artifacts.push(a);
          if (xml) reports.set(a.id, xml);
        }
        return job;
      });
    });
  }
  const c = (n) => n.repeat(40).slice(0, 40);

  run({ id: 101, ref: 'ci/feat-aaaaaaaa', tested: c('a'), tree: 'TA', created: '2026-10-21T07:45:00Z', attempts: [
    [{ name: 'unit', conclusion: 'failure', started: '2026-10-21T07:50:00Z', completed: '2026-10-21T08:00:00Z', suites: suitesA({ twoFails: true }) }],
    [{ name: 'unit', started: '2026-10-21T08:10:00Z', completed: '2026-10-21T08:20:00Z', suites: suitesA() }],
  ] });
  run({ id: 102, ref: 'ci/feat-bbbbbbbb-0a1b2c', tested: c('b'), tree: 'TB', created: '2026-10-21T08:25:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T08:30:00Z', completed: '2026-10-21T08:40:00Z', suites: suitesA() }],
  ] });
  repo.ancestors[c('c')] = [c('a')];
  repo.changed[`${c('a')}...${c('c')}`] = [{ filename: 'src/c.test.ts' }, { filename: 'src/c.ts' }];
  run({ id: 103, ref: 'ci/feat-cccccccc', tested: c('c'), tree: 'TC', created: '2026-10-21T08:55:00Z', attempts: [[
    { name: 'unit', started: '2026-10-21T09:00:00Z', completed: '2026-10-21T09:10:00Z', suites: suitesA({ extra: true }) },
    { name: 'unit:darwin', started: '2026-10-21T09:00:00Z', completed: '2026-10-21T09:20:00Z', suites: suitesA() },
  ]] });
  run({ id: 104, ref: 'master', event: 'workflow_dispatch', tested: c('d'), tree: 'TD', created: '2026-10-20T23:40:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-20T23:50:00Z', completed: '2026-10-20T23:59:30Z', suites: suitesA() }],
  ] });
  run({ id: 105, ref: 'ci/nofile-eeeeeeee', tested: c('e'), tree: 'TE', created: '2026-10-21T09:25:00Z', attempts: [[
    { name: 'unit', started: '2026-10-21T09:30:00Z', completed: '2026-10-21T09:40:00Z' },
    { name: 'unit:darwin', conclusion: 'skipped', started: '2026-10-21T09:30:00Z', completed: '2026-10-21T09:30:00Z', steps: [] },
  ]] });
  run({ id: 106, ref: 'ci/old-ffffffff', tested: c('f'), tree: 'TF', created: '2026-10-21T09:40:00Z', attempts: [[
    { name: 'unit', started: '2026-10-21T09:45:00Z', completed: '2026-10-21T09:55:00Z', steps: [{ name: 'Run pnpm test', conclusion: 'success' }] },
  ]] });
  run({ id: 107, ref: 'ci/stale-11111111', tested: c('1'), tree: 'T1', created: '2026-10-21T09:55:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T10:00:00Z', completed: '2026-10-21T10:10:00Z', suites: suitesA(), stamp: '2026-10-21T07:00:00.000Z' }],
  ] });
  run({ id: 108, ref: 'ci/revive-33333333', tested: c('3'), tree: 'T3', created: '2026-10-01T10:00:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-01T10:05:00Z', completed: '2026-10-01T10:15:00Z', suites: suitesA(), expired: true }],
    [{ name: 'unit', started: '2026-10-21T10:50:00Z', completed: '2026-10-21T11:00:00Z', suites: suitesA({ dropTwo: true }) }],
  ] });
  run({ id: 109, ref: 'ci/broken-55555555', tested: c('5'), tree: 'T5', created: '2026-10-21T10:15:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T10:20:00Z', completed: '2026-10-21T10:30:00Z', zip: zipOf({ 'unit.xml': '<testsuites><testsuite name="cut off' }) }],
  ] });
  // a re-run of the failed jobs only: attempt 2 lists unit again, copied from attempt 1 with its times and steps
  run({ id: 110, ref: 'ci/rerun-77777777', tested: c('7'), tree: 'T7', created: '2026-10-21T10:30:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T10:32:00Z', completed: '2026-10-21T10:42:00Z', suites: suitesA() }],
    [{ name: 'unit', created: '2026-10-21T11:30:00Z', started: '2026-10-21T10:32:00Z', completed: '2026-10-21T10:42:00Z' }],
  ] });
  // artifacts the collector leaves alone: another job's, and a name from before the attempt was in it
  repo.artifacts.push({ id: 900, name: 'e2e-results-smoke-1', run: 103, created_at: '2026-10-21T09:30:00Z', zip: zipOf({ 'x.txt': 'x' }) });
  repo.artifacts.push({ id: 901, name: 'test-results-unit', run: 106, created_at: '2026-10-21T09:56:00Z', zip: zipOf({ 'x.txt': 'x' }) });
  return { repo, reports };
}

const readDir = (dir) => readdirSync(dir, { recursive: true }).filter((p) => /\.(jsonl|gz)$/.test(p)).sort();
const linesOf = (root, day) => readFileSync(join(root, REPO, 'runs', `${day}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const gz = (root, path) => JSON.parse(gunzipSync(readFileSync(join(root, REPO, path))).toString('utf8'));

test('one pass records every job that ran its tests, and a second pass changes nothing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'history-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, reports } = scenario();
  const fake = fakeGitHub(repo);
  const pass = () => collectRepo({ gh: createGitHub('t', { fetchImpl: fake.fetchImpl }), repo: REPO, jobs: ['unit', 'unit:darwin'], root, now: NOW });

  const first = await pass();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.counts, { artifacts: 10, lines: 11, present: 8, missing: 1, unparseable: 1, rejected: 1, failures: 1, written: 8 });
  assert.equal(formatCounts(REPO, first.counts, 0),
    'o/r: artifacts 10, lines 11 (present 8, missing 1, unparseable 1, rejected 1), failures 1, errors 0, files written 8');
  assert.deepEqual(readDir(join(root, REPO)), [
    'base/2026-10-20/unit.json.gz', 'base/2026-10-21/unit-darwin.json.gz', 'base/2026-10-21/unit.json.gz',
    'durations/2026-10-20/unit.json.gz', 'durations/2026-10-21/unit-darwin.json.gz', 'durations/2026-10-21/unit.json.gz',
    'runs/2026-10-20.jsonl', 'runs/2026-10-21.jsonl',
  ]);

  const day = linesOf(root, '2026-10-21');
  const byKey = new Map(day.map((l) => [`${l.run}/${l.attempt}/${l.job}`, l]));
  assert.deepEqual([...byKey.keys()], ['101/1/unit', '101/2/unit', '102/1/unit', '103/1/unit', '103/1/unit:darwin', '105/1/unit', '107/1/unit', '108/2/unit', '109/1/unit', '110/1/unit']);
  assert.deepEqual(linesOf(root, '2026-10-20').map((l) => [l.run, l.producer, l.label, l.tested, l.event]), [[104, 'other', null, 'd'.repeat(40), 'workflow_dispatch']]);

  // provenance: both producers' refs, the nonce's parent as the tested commit, its tree and the gates trailer
  const a1 = byKey.get('101/1/unit');
  assert.deepEqual([a1.producer, a1.label, a1.tested, a1.tree, a1.gates, a1.conclusion], ['maws-ci-gate', 'feat', 'a'.repeat(40), 'TA', 'static,unit', 'failure']);
  assert.deepEqual([a1.artifact.name, a1.report], ['test-results-unit-1', 'present']);
  assert.deepEqual(a1.failed, [{ id: ['app', 'src/a.test.ts', 'a > two'], message: 'timed out' }]);
  const kit = byKey.get('102/1/unit');
  assert.deepEqual([kit.producer, kit.label, kit.tested, kit.previous], ['ci-kit-ci-gate', 'feat', 'b'.repeat(40), null]);

  // two attempts of one run, both done before the first collection: the second follows the first on the same tree
  assert.deepEqual(byKey.get('101/2/unit').previous, { run: 101, attempt: 1, relation: 'same-tree', paths: [], truncated: false });
  // the change's next commit: its previous run is the latest earlier one of the same producer and label
  assert.deepEqual(byKey.get('103/1/unit').previous, { run: 101, attempt: 2, relation: 'descendant', paths: ['src/c.test.ts', 'src/c.ts'], truncated: false });
  assert.equal(byKey.get('103/1/unit:darwin').previous, null);

  // a job that ran its tests with no artifact is missing; a skipped job and one from before the upload step have no line
  assert.deepEqual([byKey.get('105/1/unit').report, byKey.get('105/1/unit').artifact], ['missing', null]);
  assert.ok(!byKey.has('105/1/unit:darwin') && !byKey.has('106/1/unit'));
  // nor does a job a re-run attempt only copied from the attempt before
  assert.ok(!byKey.has('110/2/unit'));
  // a report stamped outside its job is not ingested; a broken one is unparseable
  assert.deepEqual([byKey.get('107/1/unit').report, byKey.get('107/1/unit').membership], ['rejected', null]);
  assert.equal(byKey.get('109/1/unit').report, 'unparseable');
  // a fresh attempt of a run older than any window is found by its artifact, and filed by its job's day
  assert.deepEqual([byKey.get('108/2/unit').report, byKey.get('108/2/unit').started], ['present', '2026-10-21T10:50:00Z']);

  // the day's base is its first report; every present line rebuilds its own report's cases from it exactly
  const base = gz(root, 'base/2026-10-21/unit.json.gz');
  assert.deepEqual([base.run, base.attempt], [101, 1]);
  for (const line of day.filter((l) => l.report === 'present' && l.job === 'unit')) {
    const xml = reports.get(line.artifact.id);
    assert.deepEqual(membershipOf(line, base), summarize([parseJUnit(xml)]).ids, `run ${line.run}`);
  }
  assert.deepEqual(byKey.get('108/2/unit').membership.removed, [['app', 'src/a.test.ts', 'a > two']]);
  assert.deepEqual(byKey.get('103/1/unit').membership.added, [['app', 'src/c.test.ts', 'c > new']]);
  // durations come from the day's last green report
  const durations = gz(root, 'durations/2026-10-21/unit.json.gz');
  assert.deepEqual([durations.run, durations.attempt, durations.sampled], [108, 2, true]);
  assert.deepEqual(durations.files, [['app', 'src/a.test.ts', 1500], ['app-compiled', 'src/a.test.ts', 2500]]);

  // the second pass: nothing new, no download, no comparison, no file written
  const before = new Map(readDir(join(root, REPO)).map((p) => [p, readFileSync(join(root, REPO, p))]));
  const asked = fake.requests.length;
  const second = await pass();
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.counts, { artifacts: 0, lines: 0, present: 0, missing: 0, unparseable: 0, rejected: 0, failures: 0, written: 0 });
  const later = fake.requests.slice(asked);
  assert.ok(!later.some((p) => p.endsWith('/zip') || p.startsWith('/compare')), later.join('\n'));
  for (const [p, bytes] of before) assert.ok(readFileSync(join(root, REPO, p)).equals(bytes), p);
});

test('a missing line gives way when its artifact turns up; an error writes nothing and is retried', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'history-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo } = scenario();
  const fake = fakeGitHub(repo);
  const held = repo.artifacts.filter((a) => a.run === 103);
  repo.artifacts = repo.artifacts.filter((a) => a.run !== 103);
  // the first pass cannot read run 102's tested commit
  const tested102 = repo.commits['b'.repeat(40)];
  delete repo.commits['b'.repeat(40)];
  const pass = () => collectRepo({ gh: createGitHub('t', { fetchImpl: fake.fetchImpl }), repo: REPO, jobs: ['unit', 'unit:darwin'], root, now: NOW });

  const first = await pass();
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0], /^run 102 attempt 1 unit: HTTP 404 GET \/repos\/o\/r\/git\/commits\/b{40}/);
  const keys = (lines) => lines.map((l) => `${l.run}/${l.attempt}/${l.job}:${l.report}`);
  assert.ok(keys(linesOf(root, '2026-10-21')).includes('103/1/unit:missing'));
  assert.ok(!keys(linesOf(root, '2026-10-21')).some((k) => k.startsWith('102/')));

  repo.artifacts.push(...held);
  repo.commits['b'.repeat(40)] = tested102;
  const second = await pass();
  assert.deepEqual(second.errors, []);
  const day = keys(linesOf(root, '2026-10-21'));
  assert.ok(day.includes('103/1/unit:present') && day.includes('103/1/unit:darwin:present') && day.includes('102/1/unit:present'));
  assert.ok(!day.includes('103/1/unit:missing'));
});
