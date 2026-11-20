// What a red gate attempt's record shows (gate ledger spec, "What a red gate attempt's record shows", M3's pins): each
// rule holds with the one above it not holding, and nothing in the context changes a cause. Job lines are built here
// in the shape history/jobs.mjs writes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { analyze, deriveCauses } from '../../history/cause.mjs';
import { openMirror } from '../../history/mirror.mjs';
import { gitOrigin } from './helpers.mjs';

const repos = JSON.parse(readFileSync(new URL('../../history/repos.json', import.meta.url), 'utf8'));
const MAWS = repos.find((r) => r.alias === 'SSFSKIM/MAWS');
const KIT = repos.find((r) => r.alias === 'SSFSKIM/ci-kit');
const T0 = Date.parse('2026-11-18T08:00:00Z');
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// One job line. `at`: minutes after T0 the job started; it ran 5 minutes.
let ids = 0;
function line({ run, attempt = 1, at = 0, gate = 'unit', job = gate, tree = 'T1', change = 'maws-ci-gate:x', ...o }) {
  ids += 1;
  return {
    v: 1, run, attempt, workflow: 'gate', event: 'push', ref: `ci/${change ?? 'none'}-${run}`, producer: 'maws-ci-gate', label: 'x', change, gates: gate,
    scope: 'full', scope_key: 'k-full', head: `h${run}`, tested: `t${run}`, tree, tree_key: tree, basis: 'exact',
    job_id: ids, job, gate, shard: null, kind: 'gate', role: null, copy: false, copied_from: null, lane: 'pool-gce', runner: 'ci-kit-gce-a',
    started: iso(at), completed: iso(at + 5), minutes: 5, conclusion: 'success', run_conclusion: 'success',
    failed_step: null, phase: null, annotations: [], log_kinds: [], ...o,
  };
}
// A job that failed in its tests, or stopped where `step` says.
const red = (o) => line({ conclusion: 'failure', run_conclusion: 'failure', failed_step: 'Run pnpm test', phase: 'test', ...o });
const setupRed = (o) => red({ failed_step: 'Run ./.github/actions/setup', phase: 'setup', ...o });

// A landing record that covers everything and holds no landing: the base never moved.
const WHOLE = { since: '2000-01-01T00:00:00Z', events: [] };
const derive = (lines, o = {}) => deriveCauses({
  analysis: analyze(lines, { created: o.created ?? {} }), entry: o.entry ?? MAWS, record: 'record' in o ? o.record : WHOLE, standing: o.standing ?? (() => null),
  known: o.known ?? [], casesOf: o.casesOf ?? (() => null), paths: o.paths ?? (() => null), prOf: o.prOf ?? (() => null), from: o.from ?? '2026-01-01',
});
const causeOf = (causes, run, attempt = 1) => causes.find((c) => c.run === run && c.attempt === attempt);

test('infra: every unsuccessful job lost, by an annotation or by a later attempt on the same tree getting past where it stopped', () => {
  const causes = derive([
    red({ run: 1, at: 0, phase: 'lost', failed_step: null, annotations: ['runner-lost'] }),
    // A setup failure, then the same tree past setup (it failed in its tests, which corroborates the loss all the same).
    setupRed({ run: 2, at: 10, tree: 'T2' }),
    red({ run: 3, at: 20, tree: 'T2' }),
    // A log's runner-lost counts only for a job that stopped with no step ended (phase lost).
    red({ run: 4, at: 30, tree: 'T4', phase: 'lost', failed_step: null, log_kinds: ['runner-lost'] }),
    red({ run: 5, at: 40, tree: 'T5', log_kinds: ['runner-lost'] }),
  ]);
  assert.equal(causeOf(causes, 1).cause, 'infra');
  assert.deepEqual(causeOf(causes, 1).evidence.jobs.map((j) => j.lost), ['annotation:runner-lost']);
  assert.equal(causeOf(causes, 2).cause, 'infra');
  assert.deepEqual(causeOf(causes, 2).evidence.jobs[0].by, { run: 3, attempt: 1 });
  assert.equal(causeOf(causes, 4).cause, 'infra');
  assert.equal(causeOf(causes, 5).cause, 'unattributed', 'a runner-lost line in the log of a job that failed in its tests is not a loss');
});

test("a setup failure nothing got past is unattributed, and one a product change fixed is product-diff: a broken lockfile is the change's own failure", () => {
  const causes = derive([
    setupRed({ run: 1, at: 0, tree: 'T1' }),
    setupRed({ run: 2, at: 10, tree: 'T1' }), // the same tree, stopped in setup again
    setupRed({ run: 3, at: 20, tree: 'T3', change: 'maws-ci-gate:y' }),
    line({ run: 4, at: 30, tree: 'T4', change: 'maws-ci-gate:y' }), // the lockfile fixed
  ], { paths: () => ['pnpm-lock.yaml'] });
  assert.deepEqual([causeOf(causes, 1).cause, causeOf(causes, 1).why], ['unattributed', 'setup-uncorroborated']);
  assert.deepEqual([causeOf(causes, 3).cause, causeOf(causes, 3).why], ['product-diff', null]);
});

test('a job at its time limit is not lost: its rerun on the same tree is rerun-green, never infra', () => {
  const causes = derive([
    line({ run: 1, at: 0, conclusion: 'cancelled', run_conclusion: 'failure', failed_step: 'Run pnpm test', phase: 'test', annotations: ['time-limit'] }),
    line({ run: 1, attempt: 2, at: 40 }),
  ]);
  assert.equal(causeOf(causes, 1).cause, 'rerun-green');
  assert.deepEqual(causeOf(causes, 1).evidence.green, { run: 1, attempt: 2 });
});

test('an attempt with one shard preempted and another failing an assertion is not infra', () => {
  const shard = (k, o) => ({ job: `unit ${k}/2`, shard: [k, 2], ...o });
  const causes = derive([
    red({ run: 1, at: 0, ...shard(1, { phase: 'lost', failed_step: null, annotations: ['runner-lost'] }) }),
    red({ run: 1, at: 0, ...shard(2) }),
    line({ run: 1, attempt: 2, at: 20, ...shard(1) }),
    line({ run: 1, attempt: 2, at: 20, ...shard(2) }),
  ]);
  assert.equal(causeOf(causes, 1).cause, 'rerun-green');
  assert.deepEqual(causeOf(causes, 1).evidence.jobs.map((j) => j.lost), ['annotation:runner-lost', null]);
});

test("a summary job that failed because its part was lost is the part's: MAWS 44468141412's static", () => {
  const causes = derive([
    red({ run: 1, at: 0, gate: 'static', job: 'static-local', phase: 'lost', failed_step: null, annotations: ['runner-lost'] }),
    red({ run: 1, at: 10, gate: 'static', job: 'static', role: 'summary', failed_step: 'Run if [[ $HOSTED == true ]]; then' }),
  ]);
  assert.equal(causeOf(causes, 1).cause, 'infra');
  assert.deepEqual(causeOf(causes, 1).evidence.jobs.map((j) => j.job), ['static-local']);
});

test('rerun-green needs a later comparable attempt on the same tree that succeeded in every shard; a copy is no later green', () => {
  const shard = (k) => ({ job: `unit ${k}/2`, shard: [k, 2] });
  const causes = derive([
    red({ run: 1, at: 0, ...shard(1) }),
    line({ run: 1, at: 0, ...shard(2) }),
    // Attempt 2 reran shard 1 and copied shard 2, and shard 1 failed again: no later green.
    red({ run: 1, attempt: 2, at: 20, ...shard(1) }),
    line({ run: 1, attempt: 2, at: 0, ...shard(2), copy: true, copied_from: 1, minutes: null }),
    // Only one shard of another run on the tree: incomplete, not green.
    line({ run: 2, at: 40, ...shard(1) }),
    // A run of another scope on the tree: not comparable.
    line({ run: 3, at: 50, ...shard(1), scope: 'selected', scope_key: 'k-sel' }),
    line({ run: 3, at: 50, ...shard(2), scope: 'selected', scope_key: 'k-sel' }),
  ]);
  assert.deepEqual([causeOf(causes, 1).cause, causeOf(causes, 1).why], ['unattributed', 'no-later-green']);
  const more = derive([red({ run: 1, at: 0 }), line({ run: 9, at: 30, change: 'other:z' })]);
  assert.equal(causeOf(more, 1).cause, 'rerun-green', 'any change, the same tree');
});

test('test-only-diff and product-diff: the change\'s next comparable success, by the paths between the two trees', () => {
  const lines = [
    red({ run: 1, at: 0, tree: 'T1' }),
    red({ run: 2, at: 10, tree: 'T2' }), // the next attempt, red: not the one compared
    line({ run: 3, at: 20, tree: 'T3' }),
    line({ run: 4, at: 30, tree: 'T4' }),
  ];
  const asked = [];
  const testOnly = derive(lines, { paths: (a, b) => (asked.push([a, b]), ['src/a.test.ts', 'e2e/flow.spec.ts']) });
  assert.equal(causeOf(testOnly, 1).cause, 'test-only-diff');
  assert.deepEqual(asked[0], ['T1', 'T3']);
  assert.deepEqual(causeOf(testOnly, 1).evidence.green, { run: 3, attempt: 1, tree: 'T3', paths: 2 });
  const product = derive(lines, { paths: () => ['src/a.test.ts', 'src/a.ts'] });
  assert.equal(causeOf(product, 1).cause, 'product-diff');
  assert.deepEqual(causeOf(product, 1).evidence.green.outside, ['src/a.ts']);
  // A difference the mirror could not read says so.
  assert.deepEqual([causeOf(derive(lines), 1).cause, causeOf(derive(lines), 1).why], ['unattributed', 'unreadable']);
});

test('an amendment that drops a product edit and keeps a test edit is product-diff: the two trees are compared, not their ancestry', (t) => {
  const o = gitOrigin();
  const root = mkdtempSync(join(tmpdir(), 'ci-kit-mirrors-'));
  t.after(() => {
    o.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const base = o.commit({ 'src/a.ts': '1', 'src/a.test.ts': '1' }, 'base');
  const amended = o.commit({ 'src/a.ts': '2', 'src/a.test.ts': '2' }, 'edit both');
  o.git('reset', '-q', '--hard', base);
  const kept = o.commit({ 'src/a.test.ts': '2' }, 'edit the test only');
  const mirror = openMirror({ dir: join(root, 'o.git'), url: `file://${o.dir}`, token: null });
  mirror.ensure();
  mirror.fetch([amended]);
  const causes = derive([red({ run: 1, at: 0, tree: o.tree(amended) }), line({ run: 2, at: 10, tree: o.tree(kept) })], { paths: (a, b) => mirror.paths(a, b) });
  assert.equal(causeOf(causes, 1).cause, 'product-diff');
  assert.deepEqual(causeOf(causes, 1).evidence.green.outside, ['src/a.ts']);
});

test('a full red followed by a narrower green stays unattributed (incomparable); a red of unknown scope is too', () => {
  const causes = derive([
    red({ run: 1, at: 0, tree: 'T1' }),
    line({ run: 2, at: 10, tree: 'T2', scope: 'selected', scope_key: 'k-sel' }),
    line({ run: 3, at: 20, tree: 'T1', scope: 'selected', scope_key: 'k-sel' }),
    red({ run: 4, at: 30, tree: 'T9', change: 'maws-ci-gate:d', scope: 'unknown', scope_key: 'k-unknown' }),
    line({ run: 5, at: 40, tree: 'T9', change: 'maws-ci-gate:d', scope: 'unknown', scope_key: 'k-unknown' }),
  ], { paths: () => ['src/a.test.ts'] });
  assert.deepEqual([causeOf(causes, 1).cause, causeOf(causes, 1).why], ['unattributed', 'incomparable']);
  assert.deepEqual([causeOf(causes, 4).cause, causeOf(causes, 4).why], ['unattributed', 'incomparable']);
});

test('unattributed says why: no change to follow, the change ended red, or a pull request run whose tree is not known', () => {
  const pr = (o) => ({ event: 'pull_request', basis: 'pr-merge', tree: null, tree_key: null, head_tree: 'H1', change: 'branch:topic', ref: 'topic', ...o });
  const causes = derive([
    red({ run: 1, at: 0, change: null }),
    red({ run: 2, at: 10, tree: 'T2' }),
    red({ run: 3, at: 20, tree: 'T3' }),
    red({ run: 4, at: 30, ...pr({ head: 'h4' }) }),
    line({ run: 5, at: 40, ...pr({ head: 'h5', head_tree: 'H5' }) }),
  ], { entry: KIT, prOf: (branch) => (branch === 'topic' ? 481 : null) });
  assert.deepEqual([causeOf(causes, 1).cause, causeOf(causes, 1).why], ['unattributed', 'no-change']);
  assert.deepEqual([causeOf(causes, 2).cause, causeOf(causes, 2).why], ['unattributed', 'no-later-green']);
  assert.deepEqual([causeOf(causes, 4).cause, causeOf(causes, 4).why], ['unattributed', 'basis']);
  // A pull request run's change is its pull request's number where the mirror's pull request heads give one.
  assert.equal(causeOf(causes, 4).change, 'pr:481');
});

test("two pull request runs of one head are one tree for rerun-green only while the base did not move between them", () => {
  const pr = (o) => ({ event: 'pull_request', basis: 'pr-merge', tree: null, tree_key: null, head_tree: 'H1', head: 'h1', change: 'branch:topic', ref: 'topic', ...o });
  const lines = [red({ run: 1, at: 0, ...pr() }), line({ run: 1, attempt: 2, at: 30, ...pr() })];
  const record = (events, since = iso(-120)) => ({ since, events });
  const before = { at: iso(-60), before: 'b0', after: 'b1' };
  assert.equal(causeOf(derive(lines, { entry: KIT, record: record([before]) }), 1).cause, 'rerun-green');
  const moved = derive(lines, { entry: KIT, record: record([before, { at: iso(20), before: 'b1', after: 'b2' }]) });
  assert.deepEqual([causeOf(moved, 1).cause, causeOf(moved, 1).why], ['unattributed', 'basis']);
  // The landing after the interval names the branch where the one before left it: the chain is whole, nothing moved.
  assert.equal(causeOf(derive(lines, { entry: KIT, record: record([before, { at: iso(90), before: 'b1', after: 'b2' }]) }), 1).cause, 'rerun-green');
  // A break in the chain across the interval: a landing the record lacks may have moved the base. Not known.
  const broken = derive(lines, { entry: KIT, record: record([before, { at: iso(90), before: 'bX', after: 'b2' }]) });
  assert.deepEqual([causeOf(broken, 1).cause, causeOf(broken, 1).why], ['unattributed', 'basis']);
  // A record that starts after the first run was created, or none at all, says nothing of the base.
  assert.equal(causeOf(derive(lines, { entry: KIT, record: record([], iso(10)) }), 1).cause, 'unattributed');
  assert.equal(causeOf(derive(lines, { entry: KIT, record: null }), 1).cause, 'unattributed');
});

test('a follower began strictly after the red was known: a short green inside a slow red is no evidence about it', () => {
  const lines = [
    red({ run: 1, at: 0, tree: 'T1', completed: iso(60), minutes: 60 }),
    // The change's next gate, on another tree, ran and passed while run 1 was still running.
    line({ run: 2, at: 10, tree: 'T2' }),
  ];
  const causes = derive(lines, { paths: () => ['src/a.ts'] });
  assert.deepEqual([causeOf(causes, 1).cause, causeOf(causes, 1).why], ['unattributed', 'no-later-green']);
  // On the same tree it is no rerun-green either; and one starting the moment the red was known is not after it.
  assert.equal(causeOf(derive([lines[0], line({ run: 2, at: 10, tree: 'T1' })]), 1).cause, 'unattributed');
  assert.equal(causeOf(derive([lines[0], line({ run: 2, at: 60, tree: 'T1' })]), 1).cause, 'unattributed');
  assert.equal(causeOf(derive([lines[0], line({ run: 2, at: 61, tree: 'T1' })]), 1).cause, 'rerun-green');
});

test('a time limit with no step recorded is never corroborated into infra; one in an identified setup step can be', () => {
  const timedOut = { conclusion: 'cancelled', run_conclusion: 'failure', annotations: ['time-limit'] };
  const causes = derive([
    line({ run: 1, at: 0, tree: 'T1', phase: 'lost', failed_step: null, ...timedOut }),
    line({ run: 2, at: 40, tree: 'T1', change: 'maws-ci-gate:b' }),
    line({ run: 3, at: 0, tree: 'T3', change: 'maws-ci-gate:c', phase: 'setup', failed_step: 'Run ./.github/actions/setup', ...timedOut }),
    line({ run: 4, at: 40, tree: 'T3', change: 'maws-ci-gate:d' }),
  ]);
  assert.deepEqual([causeOf(causes, 1).cause, causeOf(causes, 1).evidence.jobs[0].lost], ['rerun-green', null]);
  assert.deepEqual([causeOf(causes, 3).cause, causeOf(causes, 3).evidence.jobs[0].lost], ['infra', 'corroborated']);
  // Nothing later on its tree: not setup-uncorroborated either, since nothing says it stopped in setup.
  const alone = causeOf(derive([line({ run: 1, at: 0, tree: 'T1', phase: 'lost', failed_step: null, ...timedOut })]), 1);
  assert.deepEqual([alone.cause, alone.why], ['unattributed', 'no-later-green']);
});

test("a summary's failure restates a part's only where a part failed: beside parts only cancelled it is a red", () => {
  const part = (o) => line({ job: 'unit 1/2', shard: [1, 2], conclusion: 'cancelled', run_conclusion: 'cancelled', failed_step: 'Run pnpm test', phase: 'test', ...o });
  const summary = (o) => line({ job: 'unit', role: 'summary', conclusion: 'failure', run_conclusion: 'cancelled', failed_step: 'Check shards', phase: 'test', ...o });
  const lines = [
    part({ run: 1, at: 0, ref: 'topic', change: 'branch:topic' }),
    summary({ run: 1, at: 5, ref: 'topic', change: 'branch:topic' }),
    // A later run for its ref, created while run 1 ran: run 1 would be superseded but for its summary's failure.
    line({ run: 2, at: 20, ref: 'topic', change: 'branch:topic', tree: 'T2' }),
    part({ run: 3, at: 40, tree: 'T3', change: 'maws-ci-gate:t' }),
    summary({ run: 3, at: 45, tree: 'T3', change: 'maws-ci-gate:t', conclusion: 'cancelled', annotations: ['time-limit'] }),
  ];
  const causes = derive(lines, { created: { 1: iso(0), 2: iso(3), 3: iso(40) }, paths: () => ['src/a.ts'] });
  assert.equal(causeOf(causes, 1).cause, 'product-diff');
  assert.deepEqual(causeOf(causes, 1).evidence.jobs.map((j) => j.job), ['unit 1/2', 'unit']);
  assert.deepEqual([causeOf(causes, 3).cause, causeOf(causes, 3).why], ['unattributed', 'no-later-green'], 'a timed-out summary is a red');
  // A summary cancelled with its parts is cancelled with them; one that failed beside a failed part is the part's.
  const both = causeOf(derive([part({ run: 1, at: 0 }), summary({ run: 1, at: 5, conclusion: 'cancelled' })]), 1);
  assert.equal(both.cause, 'cancelled');
  const failedPart = causeOf(derive([part({ run: 1, at: 0, conclusion: 'failure', run_conclusion: 'failure' }), summary({ run: 1, at: 5 })]), 1);
  assert.deepEqual(failedPart.evidence.jobs.map((j) => j.job), ['unit 1/2']);
});

test('superseded: the cancelled jobs of a run cancelled while a later run existed for its ref or its change; they are not reds', () => {
  const cancelled = (o) => line({ conclusion: 'cancelled', run_conclusion: 'cancelled', failed_step: 'Run pnpm test', phase: 'test', ...o });
  const lines = [
    cancelled({ run: 1, at: 0, ref: 'topic', change: 'branch:topic' }),
    line({ run: 2, at: 10, ref: 'topic', change: 'branch:topic', tree: 'T2' }),
    // MAWS's ci-gate makes a ref per commit: a later gate of the same change supersedes.
    cancelled({ run: 3, at: 20, ref: 'ci/w-aaaa', change: 'maws-ci-gate:w', tree: 'T3' }),
    line({ run: 4, at: 30, ref: 'ci/w-bbbb', change: 'maws-ci-gate:w', tree: 'T4' }),
    // Cancelled with no later run for it (by hand).
    cancelled({ run: 5, at: 40, ref: 'ci/v-cccc', change: 'maws-ci-gate:v', tree: 'T5' }),
    // Cancelled, and a run for its ref only created after it ended: not superseded.
    cancelled({ run: 6, at: 50, ref: 'late', change: 'branch:late', tree: 'T6' }),
    line({ run: 7, at: 70, ref: 'late', change: 'branch:late', tree: 'T7' }),
  ];
  const created = { 1: iso(0), 2: iso(3), 3: iso(20), 4: iso(22), 5: iso(40), 6: iso(50), 7: iso(70) };
  const causes = derive(lines, { created, paths: () => ['src/a.ts'] });
  assert.deepEqual([causeOf(causes, 1).cause, causeOf(causes, 1).evidence.by_run], ['superseded', 2]);
  assert.equal(causeOf(causes, 3).cause, 'superseded');
  // Neither superseded nor followed by a run: cancelled, not a red.
  assert.deepEqual([causeOf(causes, 5).cause, causeOf(causes, 5).why], ['cancelled', null]);
  assert.equal(causeOf(causes, 6).cause, 'cancelled');
  // A red shard in a cancelled run is a red, whatever came later.
  const mixed = derive([red({ run: 1, at: 0, run_conclusion: 'cancelled', ref: 'topic', change: 'branch:topic' }), line({ run: 2, at: 10, ref: 'topic', change: 'branch:topic', tree: 'T2' })], { created: { 1: iso(0), 2: iso(3) }, paths: () => ['src/a.ts'] });
  assert.equal(causeOf(mixed, 1).cause, 'product-diff');
});

test('cancelled: an interrupted attempt is never product-diff, whatever product change and green came after it in its change', () => {
  const stopped = (o) => line({ conclusion: 'cancelled', run_conclusion: 'cancelled', failed_step: 'Run pnpm test', phase: 'test', ...o });
  const causes = derive([
    stopped({ run: 1, at: 0, job: 'unit 1/2', shard: [1, 2] }),
    stopped({ run: 1, at: 0, job: 'unit 2/2', shard: [2, 2], runner: null, lane: null, minutes: 0, phase: 'lost', failed_step: null }),
    // The change's next push, created after run 1 ended, changes the product and passes.
    line({ run: 2, at: 30, ref: 'ci/x-bbbb', tree: 'T2' }),
  ], { created: { 1: iso(0), 2: iso(30) }, paths: () => ['src/a.ts'] });
  const c = causeOf(causes, 1);
  assert.deepEqual([c.cause, c.why], ['cancelled', null]);
  assert.deepEqual(c.evidence.jobs.map((j) => [j.job, j.started, j.minutes]), [['unit 1/2', true, 5], ['unit 2/2', false, 0]]);
});

test('one shard failed and the others cancelled is a red: its cancelled shards are marked, and nothing is lost', () => {
  const stopped = (o) => line({ conclusion: 'cancelled', run_conclusion: 'failure', failed_step: 'Run pnpm test', phase: 'test', ...o });
  const lines = [
    red({ run: 1, at: 0, job: 'unit 1/3', shard: [1, 3] }),
    stopped({ run: 1, at: 0, job: 'unit 2/3', shard: [2, 3] }),
    // Cancelled before any runner took it: cancelled, not lost, whatever ran later on its tree.
    stopped({ run: 1, at: 0, job: 'unit 3/3', shard: [3, 3], runner: null, lane: null, minutes: 0, phase: 'lost', failed_step: null }),
  ];
  const alone = causeOf(derive(lines), 1);
  assert.deepEqual([alone.cause, alone.why], ['unattributed', 'no-later-green']);
  assert.deepEqual(alone.evidence.jobs.map((j) => [j.cancelled, j.lost]), [[false, null], [true, null], [true, null]]);
  const green = [1, 2, 3].map((i) => line({ run: 2, at: 30, change: 'other:o', job: `unit ${i}/3`, shard: [i, 3] }));
  const rerun = causeOf(derive([...lines, ...green]), 1);
  assert.equal(rerun.cause, 'rerun-green');
  assert.equal(rerun.evidence.jobs[2].lost, null);
});

test('a failure on the base and a known entry are context only: the cause is the rules\' alone', () => {
  const base = { result: 'failed', commit: 'c0ffee', at: iso(-30), run: 77 };
  const known = [{ id: 'k1', gate: 'unit', case: '*.test.ts › flaky*', reason: 'r', since: '2026-11-01', review_by: '2026-12-01', by: 'x' }];
  const lines = [red({ run: 1, at: 0, tree: 'T1' }), line({ run: 1, attempt: 2, at: 20 })];
  const plain = derive(lines);
  const withContext = derive(lines, { standing: () => base, known, casesOf: () => [['p', 'a.test.ts', 'flaky one']] });
  assert.equal(withContext[0].cause, plain[0].cause);
  assert.deepEqual(plain[0].context, {});
  assert.deepEqual(withContext[0].context, { base_also_failed: { commit: 'c0ffee', at: iso(-30), run: 77 }, known: [{ id: 'k1', case_match: 'yes' }] });
  // A standing that passed is no context.
  assert.deepEqual(derive(lines, { standing: () => ({ ...base, result: 'succeeded' }) })[0].context, {});
});

test('a cause line per failed attempt from `from` on: a copied attempt, a success and an incomplete attempt have none', () => {
  const causes = derive([
    red({ run: 1, at: -60 * 24 }),
    red({ run: 2, at: 0, tree: 'T2' }),
    line({ run: 3, at: 10, tree: 'T3' }),
    line({ run: 4, at: 20, tree: 'T4', job: 'unit 1/2', shard: [1, 2] }),
    red({ run: 5, at: 30, tree: 'T5' }),
    line({ run: 5, attempt: 2, at: 30, tree: 'T5', copy: true, copied_from: 1, minutes: null, conclusion: 'failure' }),
  ], { from: '2026-11-18', paths: () => ['src/a.ts'] });
  assert.deepEqual(causes.map((c) => [c.run, c.attempt]), [[2, 1], [5, 1]]);
  const c = causeOf(causes, 2);
  for (const k of ['run', 'attempt', 'gate', 'scope', 'scope_key', 'change', 'basis', 'tree', 'available', 'minutes', 'cause', 'why', 'evidence', 'context']) assert.ok(k in c, k);
  assert.equal(c.available, iso(5));
});

test("a step the repository's setup_steps name now is setup on lines written before: MAWS's browser install stalled at its time limit, then got past on the same tree", () => {
  const stalled = { conclusion: 'cancelled', run_conclusion: 'cancelled', phase: 'test', failed_step: 'Run pnpm --filter desk-web exec playwright install --with-deps chromium webkit', annotations: ['time-limit'] };
  const causes = derive([
    line({ run: 1, at: 0, gate: 'e2e:desk-web', tree: 'T1', change: 'maws-ci-gate:a', ...stalled }),
    line({ run: 2, at: 60, gate: 'e2e:desk-web', tree: 'T1', change: 'maws-ci-gate:b' }),
    // The same stall with nothing later on its tree is not lost.
    line({ run: 3, at: 0, gate: 'e2e:desk-web', tree: 'T3', change: 'maws-ci-gate:c', ...stalled }),
  ]);
  assert.deepEqual([causeOf(causes, 1).cause, causeOf(causes, 1).evidence.jobs[0].phase], ['infra', 'setup']);
  assert.deepEqual([causeOf(causes, 3).cause, causeOf(causes, 3).why], ['unattributed', 'setup-uncorroborated']);
});

test("a job that reached its time limit ended on its own: it failed, never superseded and never cancelled", () => {
  const timedOut = { conclusion: 'cancelled', run_conclusion: 'cancelled', failed_step: 'Run pnpm test', phase: 'test', annotations: ['time-limit'] };
  const lines = [
    line({ run: 1, at: 0, ref: 'topic', change: 'branch:topic', ...timedOut }),
    line({ run: 2, at: 6, ref: 'topic', change: 'branch:topic', tree: 'T2' }),
    line({ run: 3, at: 40, tree: 'T3', change: 'maws-ci-gate:z', conclusion: 'cancelled', run_conclusion: 'cancelled', failed_step: 'Run pnpm test', phase: 'test', log_kinds: ['time-limit'] }),
  ];
  // Run 2 was created while run 1 ran (its jobs began once run 1's result was known): run 1's cancellation would read as
  // superseded but for its time limit.
  const causes = derive(lines, { created: { 1: iso(0), 2: iso(3), 3: iso(40) }, paths: () => ['src/a.ts'] });
  assert.equal(causeOf(causes, 1).cause, 'product-diff');
  assert.deepEqual([causeOf(causes, 3).cause, causeOf(causes, 3).why], ['unattributed', 'no-later-green']);
});
