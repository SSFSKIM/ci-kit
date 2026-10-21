// The collector against a fake GitHub (test history spec, M2): the real client, the system unzip and a store in a
// temp dir. One scripted repo holds the cases the spec names: two attempts of one run collected together, a fresh
// attempt of a run older than any window, a job with no artifact, both producers' refs and a dispatch, a report
// from outside its job, an unparseable one; and a second pass that changes nothing. Smaller repos hold what spans
// passes: an artifact a pass could not take, a run that arrives after its successor, a predecessor weeks old.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createGitHub } from '../../lib/github.mjs';
import { ArchiveDefect, collectRepo, formatCounts, readArtifact } from '../../history/collect.mjs';
import { parseJUnit } from '../../history/junit.mjs';
import { membershipOf, skippedOf, summarize } from '../../history/record.mjs';
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

const c = (n) => n.repeat(40).slice(0, 40);

// An empty scripted repo, and `run` to add a gate run to it with its attempts' jobs, reports and artifacts.
function builder() {
  const repo = { runs: [], jobs: {}, commits: {}, ancestors: {}, changed: {}, artifacts: [] };
  const reports = new Map(); // artifact id → the report's XML
  let artifactId = 500;
  let jobId = 9000;
  const upload = (conclusion = 'success') => [
    { name: 'Set up job', conclusion: 'success' },
    { name: 'Run rm -rf ci-results', conclusion: conclusion === 'skipped' ? 'failure' : 'success' },
    { name: 'Run actions/upload-artifact@v7', conclusion },
  ];
  // A job's file name: `unit:darwin` → `unit-darwin`, a shard `unit 2/3` → `unit-2of3`.
  const fileOf = (name) => name.replace(':', '-').replace(/ (\d+)\/(\d+)$/, '-$1of$2');
  // A gate run: a nonce commit on top of `tested` for the ci-gates, the head itself otherwise.
  function run({ id, ref, event = 'push', tested, tree, created, attempts, selection = null }) {
    const nonce = event === 'push' && ref.startsWith('ci/');
    const head = nonce ? `${id}0000000000000000000000000000000000000`.slice(0, 40) : tested;
    if (nonce) repo.commits[head] = { tree, parents: [tested], message: `ci-gate: ${tested.slice(0, 8)}\n\nNonce: 1-2\nGates: static,unit${selection ? `\nSelection: ${selection}` : ''}` };
    repo.commits[tested] = { tree, parents: ['0'.repeat(40)], message: 'work' };
    repo.runs.push({ id, event, head_branch: ref, head_sha: head, path: '.github/workflows/gate.yml', run_attempt: attempts.length, created_at: created });
    attempts.forEach((jobs, i) => {
      repo.jobs[`${id}/${i + 1}`] = jobs.map((j) => {
        const job = { id: jobId++, name: j.name, status: j.status ?? 'completed', conclusion: j.conclusion ?? 'success', created_at: j.created ?? j.started, started_at: j.started, completed_at: j.completed, runner_name: j.runner ?? 'runner-1', steps: j.steps ?? upload() };
        const xml = j.xml ?? (j.suites && vitestReport({ timestamp: j.stamp ?? at(j.completed, -60).replace('Z', '.000Z'), suites: j.suites }));
        if (xml !== undefined || j.zip) {
          const a = { id: artifactId++, name: j.artifact ?? `test-results-${fileOf(j.name)}-${i + 1}`, run: id, created_at: at(j.completed, -5), expired: j.expired ?? false, zip: j.zip ?? zipOf({ [`${fileOf(j.name)}.xml`]: xml }) };
          repo.artifacts.push(a);
          if (xml) reports.set(a.id, xml);
        }
        return job;
      });
    });
  }
  return { repo, reports, run };
}

function scenario() {
  const { repo, reports, run } = builder();
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

const NOTHING = { artifacts: 0, lines: 0, present: 0, missing: 0, unparseable: 0, rejected: 0, relinked: 0, failures: 0, written: 0 };
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
  assert.deepEqual(first.counts, { artifacts: 10, lines: 11, present: 8, missing: 1, unparseable: 1, rejected: 1, relinked: 0, failures: 1, written: 8 });
  assert.equal(formatCounts(REPO, first.counts, 0),
    'o/r: artifacts 10, lines 11 (present 8, missing 1, unparseable 1, rejected 1), relinked 0, failures 1, errors 0, files written 8');
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
  assert.deepEqual(second.counts, NOTHING);
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

const tempRoot = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'history-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const passes = (repo, root) => {
  const fake = fakeGitHub(repo);
  const pass = (over = {}) => collectRepo({ gh: createGitHub('t', { fetchImpl: fake.fetchImpl }), repo: REPO, jobs: ['unit', 'unit:darwin'], root, now: NOW, ...over });
  return { fake, pass };
};
const lineOf = (root, day, key) => linesOf(root, day).find((l) => `${l.run}/${l.attempt}/${l.job}` === key);

test('a day starting with selection has no base or durations until a full run, and later selection replaces neither', async (t) => {
  const root = tempRoot(t);
  const { repo, run } = builder();
  const selectedSuites = [{ project: 'app', file: 'src/a.test.ts', time: 0.1, cases: [{ name: 'a > later', status: 'skipped' }] }];
  const selectedIds = [['app', 'src/a.test.ts', 'a > later']];
  const add = (id, sha, completed, suites, selection) => run({
    id, ref: `ci/selection-${sha.repeat(8)}`, tested: c(sha), tree: `T${sha}`, created: at(completed, -900), selection,
    attempts: [[{ name: 'unit', started: at(completed, -600), completed, suites }]],
  });
  add(701, 'a', '2026-10-21T08:00:00Z', selectedSuites, 'affected');
  const { pass } = passes(repo, root);

  const first = await pass();
  assert.deepEqual([first.errors, first.counts.present], [[], 1]);
  assert.deepEqual(readDir(join(root, REPO)), ['runs/2026-10-21.jsonl']);
  const beforeBase = lineOf(root, '2026-10-21', '701/1/unit');
  assert.equal(beforeBase.selection, 'affected');
  assert.deepEqual(beforeBase.membership.ids, selectedIds);
  assert.deepEqual(beforeBase.skipped.ids, selectedIds);
  assert.deepEqual(membershipOf(beforeBase), selectedIds);
  assert.deepEqual(skippedOf(beforeBase), selectedIds);

  // A selected full-suite fallback is still ineligible for the base and the full-suite cost snapshot.
  add(702, 'b', '2026-10-21T08:30:00Z', suitesA(), 'affected');
  const fallback = await pass();
  assert.deepEqual([fallback.errors, fallback.counts.present], [[], 1]);
  assert.deepEqual(readDir(join(root, REPO)), ['runs/2026-10-21.jsonl']);

  add(703, 'c', '2026-10-21T09:00:00Z', suitesA());
  const full = await pass();
  assert.deepEqual([full.errors, full.counts.present], [[], 1]);
  const base = gz(root, 'base/2026-10-21/unit.json.gz');
  const durations = gz(root, 'durations/2026-10-21/unit.json.gz');
  assert.equal(base.run, 703);
  assert.equal(durations.run, 703);
  assert.equal(base.cases.length, 4);
  assert.equal(lineOf(root, '2026-10-21', '703/1/unit').selection, null);
  assert.deepEqual(membershipOf(beforeBase, base), selectedIds);
  assert.deepEqual(skippedOf(beforeBase, base), selectedIds);

  add(704, 'd', '2026-10-21T10:00:00Z', selectedSuites, 'affected');
  const later = await pass();
  assert.deepEqual([later.errors, later.counts.present], [[], 1]);
  const selected = lineOf(root, '2026-10-21', '704/1/unit');
  assert.equal(selected.selection, 'affected');
  assert.deepEqual(selected.membership.ids, selectedIds);
  assert.deepEqual(membershipOf(selected, base), selectedIds);
  assert.deepEqual(skippedOf(selected, base), selectedIds);
  assert.deepEqual(gz(root, 'base/2026-10-21/unit.json.gz'), base);
  assert.deepEqual(gz(root, 'durations/2026-10-21/unit.json.gz'), durations);
  assert.deepEqual(lineOf(root, '2026-10-21', '701/1/unit'), beforeBase);
  assert.deepEqual(await pass(), { counts: NOTHING, errors: [] });
});

test('an artifact a pass could not download is listed again by the next, however many newer ones were stored', async (t) => {
  const root = tempRoot(t);
  const { repo, run } = builder();
  // a fresh attempt of a run older than the 3-day sweep
  run({ id: 200, ref: 'ci/late-22222222', tested: c('2'), tree: 'T2', created: '2026-10-10T10:00:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-10T10:05:00Z', completed: '2026-10-10T10:15:00Z', suites: suitesA(), expired: true }],
    [{ name: 'unit', started: '2026-10-21T00:10:00Z', completed: '2026-10-21T00:20:00Z', suites: suitesA() }],
  ] });
  // and 101 newer runs a minute apart: more than a page of artifacts, over more than an hour
  for (let i = 0; i < 101; i += 1) {
    const done = at('2026-10-21T01:00:00Z', 60 * i);
    run({ id: 300 + i, ref: 'master', event: 'workflow_dispatch', tested: c('d'), tree: 'TD', created: at(done, -900), attempts: [
      [{ name: 'unit', started: at(done, -600), completed: done, suites: suitesA() }],
    ] });
  }
  const late = repo.artifacts.find((a) => a.run === 200 && a.name === 'test-results-unit-2');
  repo.failing = [late.id];
  const { pass } = passes(repo, root);

  const first = await pass();
  assert.deepEqual(first.errors, [`run 200 attempt 2 unit: HTTP 502 GET /repos/o/r/actions/artifacts/${late.id}/zip: Bad Gateway`]);
  assert.deepEqual([first.counts.lines, first.counts.present], [101, 101]);
  assert.equal(lineOf(root, '2026-10-21', '200/2/unit'), undefined);

  repo.failing = [];
  const second = await pass();
  assert.deepEqual(second.errors, []);
  assert.deepEqual([second.counts.lines, second.counts.present], [1, 1]);
  const line = lineOf(root, '2026-10-21', '200/2/unit');
  assert.deepEqual([line.report, line.artifact.id], ['present', late.id]);
});

// A change of two or three runs, each tested commit descending from the last: R0 (run 401, in one variant), then A
// (402), then B (403), which starts after A and finishes first.
for (const variant of ['running', 'missing']) {
  test(`a run that arrives after its successor was stored (${variant} at first) becomes its previous run`, async (t) => {
    const root = tempRoot(t);
    const { repo, run } = builder();
    const withR0 = variant === 'running';
    if (withR0) run({ id: 401, ref: 'ci/chg-aaaaaaaa', tested: c('a'), tree: 'TA', created: '2026-10-21T08:00:00Z', attempts: [
      [{ name: 'unit', started: '2026-10-21T08:05:00Z', completed: '2026-10-21T08:15:00Z', suites: suitesA() }],
    ] });
    run({ id: 402, ref: 'ci/chg-bbbbbbbb', tested: c('b'), tree: 'TB', created: '2026-10-21T09:00:00Z', attempts: [
      [{ name: 'unit', started: '2026-10-21T09:05:00Z', completed: '2026-10-21T09:30:00Z', suites: suitesA() }],
    ] });
    run({ id: 403, ref: 'ci/chg-cccccccc', tested: c('c'), tree: 'TC', created: '2026-10-21T09:10:00Z', attempts: [
      [{ name: 'unit', started: '2026-10-21T09:15:00Z', completed: '2026-10-21T09:25:00Z', suites: suitesA({ extra: true }) }],
    ] });
    repo.ancestors[c('b')] = [c('a')];
    repo.ancestors[c('c')] = [c('a'), c('b')];
    repo.changed[`${c('a')}...${c('b')}`] = [{ filename: 'src/b.ts' }];
    repo.changed[`${c('a')}...${c('c')}`] = [{ filename: 'src/b.ts' }, { filename: 'src/c.ts' }];
    repo.changed[`${c('b')}...${c('c')}`] = [{ filename: 'src/c.ts' }];
    // at first A is still running, its report already uploaded; or it is done, and its artifact not yet listed
    const [jobA] = repo.jobs['402/1'];
    const artifactA = repo.artifacts.find((a) => a.run === 402);
    if (variant === 'running') Object.assign(jobA, { status: 'in_progress', conclusion: null, completed_at: null });
    else repo.artifacts = repo.artifacts.filter((a) => a !== artifactA);
    const { fake, pass } = passes(repo, root);

    const first = await pass();
    assert.deepEqual(first.errors, []);
    assert.equal(first.counts.relinked, 0);
    assert.equal(lineOf(root, '2026-10-21', '402/1/unit')?.report, variant === 'running' ? undefined : 'missing');
    const b1 = lineOf(root, '2026-10-21', '403/1/unit');
    assert.deepEqual(b1.previous, withR0 ? { run: 401, attempt: 1, relation: 'descendant', paths: ['src/b.ts', 'src/c.ts'], truncated: false } : null);

    if (variant === 'running') Object.assign(jobA, { status: 'completed', conclusion: 'success', completed_at: '2026-10-21T09:30:00Z' });
    else repo.artifacts.push(artifactA);
    const second = await pass();
    assert.deepEqual(second.errors, []);
    assert.deepEqual([second.counts.lines, second.counts.present, second.counts.relinked], [1, 1, 1]);
    const a = lineOf(root, '2026-10-21', '402/1/unit');
    assert.deepEqual([a.report, a.previous], ['present', withR0 ? { run: 401, attempt: 1, relation: 'descendant', paths: ['src/b.ts'], truncated: false } : null]);
    const b2 = lineOf(root, '2026-10-21', '403/1/unit');
    assert.deepEqual(b2.previous, { run: 402, attempt: 1, relation: 'descendant', paths: ['src/c.ts'], truncated: false });
    assert.deepEqual({ ...b2, previous: null }, { ...b1, previous: null }); // only its link changed

    // nothing new: nothing linked again, nothing compared, nothing written
    const asked = fake.requests.length;
    const third = await pass();
    assert.deepEqual([third.errors, third.counts], [[], NOTHING]);
    assert.ok(!fake.requests.slice(asked).some((p) => p.endsWith('/zip') || p.startsWith('/compare')));
  });
}

// The keys of the lines on disk whose previous run names no present line on disk.
const dangling = (root) => {
  const lines = readdirSync(join(root, REPO, 'runs')).flatMap((f) => linesOf(root, f.replace(/\.jsonl$/, '')));
  const present = new Set(lines.filter((l) => l.report === 'present').map((l) => `${l.run}/${l.attempt}/${l.job}`));
  return lines.filter((l) => l.previous && !present.has(`${l.previous.run}/${l.previous.attempt}/${l.job}`)).map((l) => `${l.run}/${l.attempt}/${l.job}`);
};

// A change of three runs, A < B < C by their start, each tested commit descending from the last, and a re-run of A
// after them all. A's reports are listed only once B and C are stored (its lines `missing` till then). On the pass
// that takes them, linking C again fails, so A is held back: B's new link to A is dropped, and A's re-run, which
// names A, is held back with it.
test('a line held back leaves no link to it on disk; the pass that takes it links what names it', async (t) => {
  const root = tempRoot(t);
  const { repo, run } = builder();
  run({ id: 402, ref: 'ci/chg-aaaaaaaa', tested: c('a'), tree: 'TA', created: '2026-10-21T09:00:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T09:05:00Z', completed: '2026-10-21T09:12:00Z', suites: suitesA() }],
    [{ name: 'unit', started: '2026-10-21T09:30:00Z', completed: '2026-10-21T09:40:00Z', suites: suitesA() }],
  ] });
  run({ id: 403, ref: 'ci/chg-bbbbbbbb', tested: c('b'), tree: 'TB', created: '2026-10-21T09:08:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T09:10:00Z', completed: '2026-10-21T09:20:00Z', suites: suitesA() }],
  ] });
  run({ id: 404, ref: 'ci/chg-cccccccc', tested: c('c'), tree: 'TC', created: '2026-10-21T09:13:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T09:15:00Z', completed: '2026-10-21T09:25:00Z', suites: suitesA() }],
  ] });
  repo.ancestors[c('b')] = [c('a')];
  repo.ancestors[c('c')] = [c('a'), c('b')];
  repo.changed[`${c('a')}...${c('b')}`] = [{ filename: 'src/b.ts' }];
  repo.changed[`${c('b')}...${c('c')}`] = [{ filename: 'src/c.ts' }];
  const reportsA = repo.artifacts.filter((a) => a.run === 402);
  repo.artifacts = repo.artifacts.filter((a) => a.run !== 402);
  const { pass } = passes(repo, root);
  const link = (run, relation, paths) => ({ run, attempt: 1, relation, paths, truncated: false });
  const previous = (key) => lineOf(root, '2026-10-21', key).previous;

  const first = await pass();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(['402/1/unit', '402/2/unit'].map((k) => lineOf(root, '2026-10-21', k).report), ['missing', 'missing']);
  assert.deepEqual([previous('403/1/unit'), previous('404/1/unit')], [null, link(403, 'descendant', ['src/c.ts'])]);

  repo.artifacts.push(...reportsA);
  repo.failing = [`${c('b')}...${c('c')}`];
  const second = await pass();
  assert.deepEqual(second.errors, [`run 404 attempt 1 unit: previous run: HTTP 503 GET /repos/o/r/compare/${c('b')}...${c('c')}?per_page=1: Service Unavailable`]);
  assert.deepEqual([second.counts.lines, second.counts.relinked], [0, 0]);
  assert.deepEqual(dangling(root), []);
  assert.deepEqual(['402/1/unit', '402/2/unit'].map((k) => lineOf(root, '2026-10-21', k).report), ['missing', 'missing']);
  assert.deepEqual([previous('403/1/unit'), previous('404/1/unit')], [null, link(403, 'descendant', ['src/c.ts'])]);

  repo.failing = [];
  const third = await pass();
  assert.deepEqual(third.errors, []);
  assert.deepEqual([third.counts.lines, third.counts.present, third.counts.relinked], [2, 2, 1]);
  assert.deepEqual(dangling(root), []);
  assert.deepEqual(['402/1/unit', '402/2/unit', '403/1/unit', '404/1/unit'].map(previous), [
    null,
    link(402, 'same-tree', []),
    link(402, 'descendant', ['src/b.ts']),
    link(403, 'descendant', ['src/c.ts']),
  ]);
});

test('a failure of the machine, not the artifact, writes nothing and is tried again; a defective archive or a report that breaks the reader is unparseable, once', async (t) => {
  const root = tempRoot(t);
  const { repo, run } = builder();
  run({ id: 501, ref: 'ci/disk-55555555', tested: c('5'), tree: 'T5', created: '2026-10-21T10:00:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T10:05:00Z', completed: '2026-10-21T10:15:00Z', suites: suitesA() }],
  ] });
  run({ id: 502, ref: 'ci/nozip-66666666', tested: c('6'), tree: 'T6', created: '2026-10-21T10:00:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T10:05:00Z', completed: '2026-10-21T10:16:00Z', zip: Buffer.from('not a zip archive') }],
  ] });
  run({ id: 503, ref: 'ci/empty-77777777', tested: c('7'), tree: 'T7', created: '2026-10-21T10:00:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T10:05:00Z', completed: '2026-10-21T10:17:00Z', zip: zipOf({}) }],
  ] });
  run({ id: 504, ref: 'ci/nested-88888888', tested: c('8'), tree: 'T8', created: '2026-10-21T10:00:00Z', attempts: [
    [{ name: 'unit', started: '2026-10-21T10:05:00Z', completed: '2026-10-21T10:18:00Z', xml: '<testsuite><testcase><failure><testcase/></failure></testcase></testsuite>' }],
  ] });
  const zip501 = repo.artifacts.find((a) => a.run === 501).zip;
  const nested = repo.artifacts.find((a) => a.run === 504).id;
  // the disk fills while run 501's archive is written; the error's message names a path from the artifact
  const full = (zip) => {
    if (!zip.equals(zip501)) return readArtifact(zip);
    throw Object.assign(new Error("ENOSPC: no space left on device, open '/tmp/x/src/a.test.ts.xml'"), { code: 'ENOSPC', errno: -28, syscall: 'open' });
  };
  const { fake, pass } = passes(repo, root);

  const first = await pass({ readZip: full });
  assert.deepEqual(first.errors, ['run 501 attempt 1 unit: Error ENOSPC']);
  assert.deepEqual([first.counts.lines, first.counts.unparseable], [3, 3]);
  assert.deepEqual(linesOf(root, '2026-10-21').map((l) => `${l.run}:${l.report}`), ['502:unparseable', '503:unparseable', '504:unparseable']);

  const asked = fake.requests.length;
  const second = await pass();
  assert.deepEqual(second.errors, []);
  assert.deepEqual([second.counts.lines, second.counts.present], [1, 1]);
  assert.equal(lineOf(root, '2026-10-21', '501/1/unit').report, 'present');
  assert.ok(!fake.requests.slice(asked).includes(`/actions/artifacts/${nested}/zip`));
});

test("unzip's statuses: a defective archive is the artifact's fault, warnings are not", () => {
  assert.deepEqual(readArtifact(zipOf({ 'b.xml': 'B', 'a/a.xml': 'A', 'notes.txt': 'x' })), ['A', 'B']);
  assert.deepEqual(readArtifact(zipOf({})), []); // status 1: an empty archive, a warning only
  assert.throws(() => readArtifact(Buffer.from('not a zip archive')), ArchiveDefect); // 9
  const zip = zipOf({ 'a.xml': '<testsuites/>'.repeat(50) });
  assert.throws(() => readArtifact(zip.subarray(0, zip.length - 30)), ArchiveDefect); // cut short: 9
  const damaged = Buffer.from(zip);
  damaged[40] ^= 0xff;
  assert.throws(() => readArtifact(damaged), ArchiveDefect); // a damaged entry: 2
});

test('a fresh attempt three weeks after its run finds the first attempt as its previous run', async (t) => {
  const root = tempRoot(t);
  const { repo, run } = builder();
  run({ id: 601, ref: 'ci/resumed-88888888', tested: c('8'), tree: 'T8', created: '2026-09-30T10:00:00Z', attempts: [
    [{ name: 'unit', started: '2026-09-30T10:05:00Z', completed: '2026-09-30T10:15:00Z', suites: suitesA() }],
    [{ name: 'unit', started: '2026-10-21T10:05:00Z', completed: '2026-10-21T10:15:00Z', suites: suitesA() }],
  ] });
  // the first pass runs the day of the first attempt, before the second exists
  const [ghRun] = repo.runs;
  const [first, second] = repo.artifacts;
  const jobs2 = repo.jobs['601/2'];
  delete repo.jobs['601/2'];
  repo.artifacts = [first];
  ghRun.run_attempt = 1;
  const { pass } = passes(repo, root);
  const early = await pass({ now: Date.parse('2026-09-30T12:00:00Z') });
  assert.deepEqual([early.errors, early.counts.present], [[], 1]);

  // three weeks later the first attempt's artifact has expired, and a fresh attempt ran on the same commit
  first.expired = true;
  repo.artifacts.push(second);
  repo.jobs['601/2'] = jobs2;
  ghRun.run_attempt = 2;
  const later = await pass();
  assert.deepEqual([later.errors, later.counts.present], [[], 1]);
  assert.deepEqual(lineOf(root, '2026-10-21', '601/2/unit').previous, { run: 601, attempt: 1, relation: 'same-tree', paths: [], truncated: false });
});

// A matrix's shards of `unit` (MAWS shards it for wall time): each runs its own part of the suite's files on its own
// runner and uploads `test-results-unit-<k>of<n>-<attempt>`. A title repeated in one file stays numbered in the union.
const shardSuites = ({ fails = false } = {}) => [
  [{ project: 'app', file: 'src/a.test.ts', time: 1.5, cases: [{ name: 'a > one' }, { name: 'a > two' }, { name: 'a > later', status: 'skipped' }] }],
  [{ project: 'app-compiled', file: 'src/a.test.ts', time: 2.5, cases: [{ name: 'a > one', ...(fails ? { status: 'failed', message: 'timed out' } : {}) }] }],
  [{ project: 'app', file: 'src/c.test.ts', time: 0.5, cases: [{ name: 'c > new' }, { name: 'c > new' }] }],
];
const unionOf = (suites) => summarize([parseJUnit(vitestReport({ timestamp: '2026-10-21T08:00:00.000Z', suites: suites.flat() }))]);
// The cases a present line's artifacts hold: its own report, or the union of its shards'.
const readBack = (reports, line) => summarize((line.shards ?? [line]).map((p) => parseJUnit(reports.get(p.artifact.id))));

test("a sharded job's full set is one line of the job: the union of the shards' reports, each shard's provenance kept", async (t) => {
  const root = tempRoot(t);
  const { repo, reports, run } = builder();
  const red = shardSuites({ fails: true });
  run({ id: 801, ref: 'ci/shard-aaaaaaaa', tested: c('a'), tree: 'TA', created: '2026-10-21T07:50:00Z', attempts: [[
    { name: 'unit 1/3', runner: 'vm-1', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: red[0] },
    { name: 'unit 2/3', runner: 'vm-2', conclusion: 'failure', started: '2026-10-21T08:01:00Z', completed: '2026-10-21T08:09:00Z', suites: red[1] },
    { name: 'unit 3/3', runner: 'vm-3', started: '2026-10-21T07:59:30Z', completed: '2026-10-21T08:05:00Z', suites: red[2] },
  ]] });
  const green = shardSuites();
  run({ id: 802, ref: 'ci/shard-bbbbbbbb', tested: c('b'), tree: 'TB', created: '2026-10-21T08:50:00Z', attempts: [[
    { name: 'unit 1/3', started: '2026-10-21T09:00:00Z', completed: '2026-10-21T09:06:00Z', suites: green[0] },
    { name: 'unit 2/3', started: '2026-10-21T09:00:00Z', completed: '2026-10-21T09:07:00Z', suites: green[1] },
    { name: 'unit 3/3', started: '2026-10-21T09:00:00Z', completed: '2026-10-21T09:05:00Z', suites: green[2] },
  ]] });
  repo.ancestors[c('b')] = [c('a')];
  repo.changed[`${c('a')}...${c('b')}`] = [{ filename: 'src/a.ts' }];
  const { fake, pass } = passes(repo, root);

  const first = await pass();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.counts, { ...NOTHING, artifacts: 6, lines: 2, present: 2, failures: 1, written: 3 });
  assert.deepEqual(readDir(join(root, REPO)), ['base/2026-10-21/unit.json.gz', 'durations/2026-10-21/unit.json.gz', 'runs/2026-10-21.jsonl']);
  assert.deepEqual(linesOf(root, '2026-10-21').map((l) => `${l.run}/${l.attempt}/${l.job}`), ['801/1/unit', '802/1/unit']);

  // the report is the union, as one unsharded report of the same suites would read
  const line = lineOf(root, '2026-10-21', '801/1/unit');
  const union = unionOf(red);
  const base = gz(root, 'base/2026-10-21/unit.json.gz');
  assert.deepEqual([base.run, base.job, base.files], [801, 'unit', union.files]);
  assert.deepEqual(membershipOf(line, base), union.ids);
  assert.deepEqual(skippedOf(line, base), union.skipped);
  assert.deepEqual([line.failed, line.projects, line.ms], [union.failed, union.projects, union.ms]);
  assert.ok(union.ids.some((id) => id[3] === 2));

  // provenance: the earliest start, the latest completion, the worst conclusion; each shard's job, runner and artifact
  assert.deepEqual([line.jobId, line.runner, line.artifact, line.started, line.completed, line.conclusion],
    [null, null, null, '2026-10-21T07:59:30Z', '2026-10-21T08:09:00Z', 'failure']);
  assert.deepEqual(line.shards.map((s) => s.jobId), repo.jobs['801/1'].map((j) => j.id));
  assert.deepEqual(line.shards.map((s) => [s.job, s.runner, s.conclusion, s.started, s.completed, s.artifact.name]), [
    ['unit 1/3', 'vm-1', 'success', '2026-10-21T08:00:00Z', '2026-10-21T08:06:00Z', 'test-results-unit-1of3-1'],
    ['unit 2/3', 'vm-2', 'failure', '2026-10-21T08:01:00Z', '2026-10-21T08:09:00Z', 'test-results-unit-2of3-1'],
    ['unit 3/3', 'vm-3', 'success', '2026-10-21T07:59:30Z', '2026-10-21T08:05:00Z', 'test-results-unit-3of3-1'],
  ]);
  for (const l of linesOf(root, '2026-10-21')) assert.deepEqual(membershipOf(l, base), readBack(reports, l).ids);

  // durations from the green set; the change's next run links to it
  const durations = gz(root, 'durations/2026-10-21/unit.json.gz');
  assert.deepEqual([durations.run, durations.files], [802, unionOf(green).files]);
  assert.deepEqual(lineOf(root, '2026-10-21', '802/1/unit').previous, { run: 801, attempt: 1, relation: 'descendant', paths: ['src/a.ts'], truncated: false });

  const asked = fake.requests.length;
  assert.deepEqual(await pass(), { counts: NOTHING, errors: [] });
  assert.ok(!fake.requests.slice(asked).some((p) => p.endsWith('/zip') || p.startsWith('/compare')));
});

test('a shard still running writes nothing yet; one that ran its tests and uploaded nothing makes the line missing until its artifact turns up', async (t) => {
  const root = tempRoot(t);
  const { repo, run } = builder();
  const suites = shardSuites();
  run({ id: 811, ref: 'ci/running-aaaaaaaa', tested: c('a'), tree: 'TA', created: '2026-10-21T07:50:00Z', attempts: [[
    { name: 'unit 1/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: suites[0] },
    { name: 'unit 2/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:09:00Z', suites: suites[2] },
  ]] });
  run({ id: 812, ref: 'ci/lost-bbbbbbbb', tested: c('b'), tree: 'TB', created: '2026-10-21T07:50:00Z', attempts: [[
    { name: 'unit 1/3', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: suites[0] },
    { name: 'unit 2/3', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:07:00Z', suites: suites[1] },
    { name: 'unit 3/3', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:05:00Z', suites: suites[2] },
  ]] });
  // 811's second shard has uploaded and is still running; 812's last two ran their tests and left no artifact (yet)
  const [, running] = repo.jobs['811/1'];
  Object.assign(running, { status: 'in_progress', conclusion: null, completed_at: null });
  const late = (k) => repo.artifacts.find((a) => a.name === `test-results-unit-${k}of3-1`);
  const [late2, late3] = [late(2), late(3)];
  repo.artifacts = repo.artifacts.filter((a) => a !== late2 && a !== late3);
  const { pass } = passes(repo, root);

  const first = await pass();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.counts, { ...NOTHING, artifacts: 1, lines: 1, missing: 1, written: 1 });
  assert.equal(lineOf(root, '2026-10-21', '811/1/unit'), undefined);
  const missing = lineOf(root, '2026-10-21', '812/1/unit');
  assert.deepEqual([missing.report, missing.membership, missing.completed], ['missing', null, '2026-10-21T08:07:00Z']);
  assert.deepEqual(missing.shards.map((s) => s.artifact?.name ?? null), ['test-results-unit-1of3-1', null, null]);
  assert.deepEqual(await pass(), { counts: NOTHING, errors: [] });

  // one of the two turns up: the set is still short, and the missing line stands
  repo.artifacts.push(late2);
  assert.deepEqual(await pass(), { counts: NOTHING, errors: [] });

  Object.assign(running, { status: 'completed', conclusion: 'success', completed_at: '2026-10-21T08:09:00Z' });
  repo.artifacts.push(late3);
  const second = await pass();
  assert.deepEqual(second.errors, []);
  assert.deepEqual([second.counts.lines, second.counts.present, second.counts.artifacts], [2, 2, 5]);
  for (const key of ['811/1/unit', '812/1/unit']) assert.equal(lineOf(root, '2026-10-21', key).report, 'present');
  assert.deepEqual(await pass(), { counts: NOTHING, errors: [] });
});

test("a shard from another attempt never completes an attempt's set: a shard re-run alone leaves its attempt without a line", async (t) => {
  const root = tempRoot(t);
  const { repo, run } = builder();
  const [s1, s2] = [shardSuites()[0], shardSuites({ fails: true })[1]];
  // a red shard re-run alone, green; the other shard is copied into the second attempt
  run({ id: 821, ref: 'ci/rerun-aaaaaaaa', tested: c('a'), tree: 'TA', created: '2026-10-21T07:50:00Z', attempts: [
    [
      { name: 'unit 1/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: s1 },
      { name: 'unit 2/2', conclusion: 'failure', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:07:00Z', suites: s2 },
    ],
    [
      { name: 'unit 1/2', created: '2026-10-21T08:30:00Z', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z' },
      { name: 'unit 2/2', started: '2026-10-21T08:31:00Z', completed: '2026-10-21T08:38:00Z', suites: shardSuites()[1] },
    ],
  ] });
  // a shard preempted before its upload step, then re-run alone
  run({ id: 822, ref: 'ci/preempt-bbbbbbbb', tested: c('b'), tree: 'TB', created: '2026-10-21T07:50:00Z', attempts: [
    [
      { name: 'unit 1/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: s1 },
      { name: 'unit 2/2', conclusion: 'failure', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:03:00Z', steps: [
        { name: 'Run rm -rf ci-results', conclusion: 'failure' }, { name: 'Run actions/upload-artifact@v7', conclusion: 'skipped' },
      ] },
    ],
    [
      { name: 'unit 1/2', created: '2026-10-21T08:30:00Z', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z' },
      { name: 'unit 2/2', started: '2026-10-21T08:31:00Z', completed: '2026-10-21T08:38:00Z', suites: shardSuites()[2] },
    ],
  ] });
  const { fake, pass } = passes(repo, root);

  const first = await pass();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.counts, { ...NOTHING, artifacts: 2, lines: 1, present: 1, failures: 1, written: 2 });
  assert.deepEqual(linesOf(root, '2026-10-21').map((l) => `${l.run}/${l.attempt}/${l.job}:${l.report}`), ['821/1/unit:present']);

  // the incomplete attempts are looked at again, and nothing is downloaded for them
  const asked = fake.requests.length;
  assert.deepEqual(await pass(), { counts: NOTHING, errors: [] });
  assert.ok(!fake.requests.slice(asked).some((p) => p.endsWith('/zip')));
});

test('the job unsharded and sharded across runs in one store: one base, every line rebuilds, the change links across the switch', async (t) => {
  const root = tempRoot(t);
  const { repo, reports, run } = builder();
  const sharded = (id, sha, hour, suites, extra = []) => run({
    id, ref: `ci/chg-${sha.repeat(8)}`, tested: c(sha), tree: `T${sha}`, created: `2026-10-21T${hour}:00:00Z`, selection: suites.length === 1 ? 'affected' : null,
    attempts: [[...suites.map((s, i) => ({ name: `unit ${i + 1}/${suites.length}`, started: `2026-10-21T${hour}:05:00Z`, completed: `2026-10-21T${hour}:1${i}:00Z`, suites: s })), ...extra]],
  });
  const plain = (id, sha, hour, selection = null) => run({ id, ref: `ci/chg-${sha.repeat(8)}`, tested: c(sha), tree: `T${sha}`, created: `2026-10-21T${hour}:00:00Z`, selection, attempts: [
    [{ name: 'unit', started: `2026-10-21T${hour}:05:00Z`, completed: `2026-10-21T${hour}:15:00Z`, suites: shardSuites().flat() }],
  ] });
  // the day opens with an unsharded selected run (an --affected iteration), then full runs before and after the switch
  plain(830, '9', '07', 'affected');
  plain(831, 'a', '08');
  sharded(832, 'b', '09', shardSuites(), [{ name: 'unit:darwin', started: '2026-10-21T09:05:00Z', completed: '2026-10-21T09:20:00Z', suites: shardSuites().flat() }]);
  plain(833, 'c', '10');
  repo.ancestors[c('b')] = [c('a')];
  repo.ancestors[c('c')] = [c('a'), c('b')];
  repo.changed[`${c('a')}...${c('b')}`] = [{ filename: 'src/b.ts' }];
  repo.changed[`${c('b')}...${c('c')}`] = [{ filename: 'src/c.ts' }];
  const { pass } = passes(repo, root);

  const first = await pass();
  assert.deepEqual(first.errors, []);
  assert.deepEqual([first.counts.lines, first.counts.present, first.counts.artifacts], [5, 5, 7]);
  const day = linesOf(root, '2026-10-21');
  assert.deepEqual(day.map((l) => [l.run, l.job, l.shards?.length ?? null, l.selection]),
    [[830, 'unit', null, 'affected'], [831, 'unit', null, null], [832, 'unit', 3, null], [832, 'unit:darwin', null, null], [833, 'unit', null, null]]);
  const base = gz(root, 'base/2026-10-21/unit.json.gz');
  assert.equal(base.run, 831);
  assert.equal(gz(root, 'durations/2026-10-21/unit.json.gz').run, 833);
  for (const l of day) assert.deepEqual(membershipOf(l, l.job === 'unit' ? base : gz(root, 'base/2026-10-21/unit-darwin.json.gz')), readBack(reports, l).ids, `${l.run} ${l.job}`);
  const link = (run, paths) => ({ run, attempt: 1, relation: 'descendant', paths, truncated: false });
  assert.deepEqual(day.filter((l) => l.job === 'unit').map((l) => l.previous), [null, null, link(831, ['src/b.ts']), link(832, ['src/c.ts'])]);
});

test('an attempt whose jobs or artifacts name more than one shard count is refused on every pass, and writes nothing', async (t) => {
  const root = tempRoot(t);
  const { repo, run } = builder();
  const [s1, s2, s3] = shardSuites();
  run({ id: 841, ref: 'ci/mixed-aaaaaaaa', tested: c('a'), tree: 'TA', created: '2026-10-21T07:50:00Z', attempts: [[
    { name: 'unit 1/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: s1 },
    { name: 'unit 2/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: s2 },
    { name: 'unit 3/3', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: s3 },
  ]] });
  run({ id: 842, ref: 'ci/mixed-bbbbbbbb', tested: c('b'), tree: 'TB', created: '2026-10-21T07:50:00Z', attempts: [[
    { name: 'unit', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: s1, artifact: 'test-results-unit-1of2-1' },
  ]] });
  const { pass } = passes(repo, root);
  const refused = [
    'run 841 attempt 1 unit: history: the attempt has the job in more than one shard count (2, 3)',
    'run 842 attempt 1 unit: history: the attempt has the job in more than one shard count (2, unsharded)',
  ];
  for (let i = 0; i < 2; i += 1) {
    const { counts, errors } = await pass();
    assert.deepEqual([[...errors].sort(), counts], [refused, NOTHING]);
  }
  assert.equal(existsSync(join(root, REPO)), false);
});

test('a conflicting shard artifact arriving after the repository-wide listing is refused, sharded or unsharded, and writes nothing', async (t) => {
  const root = tempRoot(t);
  const { repo, run } = builder();
  const [s1, s2] = shardSuites();
  run({ id: 843, ref: 'ci/late-aaaaaaaa', tested: c('a'), tree: 'TA', created: '2026-10-21T07:50:00Z', attempts: [[
    { name: 'unit 1/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: s1 },
    { name: 'unit 2/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: s2 },
  ]] });
  run({ id: 844, ref: 'ci/late-bbbbbbbb', tested: c('b'), tree: 'TB', created: '2026-10-21T07:50:00Z', attempts: [[
    { name: 'unit', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:06:00Z', suites: s1 },
  ]] });
  const { fake, pass } = passes(repo, root);
  const fetchImpl = fake.fetchImpl;
  fake.fetchImpl = async (href) => {
    const response = await fetchImpl(href);
    if (new URL(href).pathname === `/repos/${REPO}/actions/artifacts`) {
      repo.artifacts.push(
        { ...repo.artifacts.find((a) => a.run === 843), id: 950, name: 'test-results-unit-1of3-1' },
        { ...repo.artifacts.find((a) => a.run === 844), id: 951, name: 'test-results-unit-1of2-1' },
      );
    }
    return response;
  };

  const { counts, errors } = await pass();
  assert.deepEqual([[...errors].sort(), counts], [[
    'run 843 attempt 1 unit: history: the attempt has the job in more than one shard count (2, 3)',
    'run 844 attempt 1 unit: history: the attempt has the job in more than one shard count (2, unsharded)',
  ], NOTHING]);
  assert.equal(existsSync(join(root, REPO)), false);
});

test("each shard's report is checked against its own job: one stamped outside it is rejected, one unreadable is unparseable", async (t) => {
  const root = tempRoot(t);
  const { repo, run } = builder();
  const [s1, s2] = shardSuites();
  // the second shard's report is stamped inside the first shard's job, so inside the run's span, but not inside its own
  run({ id: 851, ref: 'ci/stamp-aaaaaaaa', tested: c('a'), tree: 'TA', created: '2026-10-21T07:50:00Z', attempts: [[
    { name: 'unit 1/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:10:00Z', suites: s1 },
    { name: 'unit 2/2', started: '2026-10-21T08:20:00Z', completed: '2026-10-21T08:30:00Z', suites: s2, stamp: '2026-10-21T08:05:00.000Z' },
  ]] });
  run({ id: 852, ref: 'ci/broken-bbbbbbbb', tested: c('b'), tree: 'TB', created: '2026-10-21T07:50:00Z', attempts: [[
    { name: 'unit 1/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:10:00Z', suites: s1 },
    { name: 'unit 2/2', started: '2026-10-21T08:00:00Z', completed: '2026-10-21T08:10:00Z', zip: Buffer.from('not a zip archive') },
  ]] });
  const { pass } = passes(repo, root);

  const first = await pass();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.counts, { ...NOTHING, artifacts: 4, lines: 2, unparseable: 1, rejected: 1, written: 1 });
  assert.deepEqual(linesOf(root, '2026-10-21').map((l) => `${l.run}:${l.report}:${l.shards.length}`), ['851:rejected:2', '852:unparseable:2']);
  assert.deepEqual(await pass(), { counts: NOTHING, errors: [] });
});
