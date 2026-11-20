// The record's pure parts (test history spec, M2; gate ledger spec, "The per-test record, kept small"): case ids, a
// report's summary, the small run line and what it can say of a case, the one-time rewrite of the old lines, the
// report-ownership check, and the idempotent merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJUnit } from '../../history/junit.mjs';
import {
  buildBase, buildDurations, buildRunLine, caseOutcome, hashIds, isSlim, membershipOf, mergeLines, reportWithinJob, skippedOf, slimLine, summarize,
} from '../../history/record.mjs';
import { vitestReport } from './helpers.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const prov = (over = {}) => ({
  run: 1, attempt: 1, job: 'unit', workflow: '.github/workflows/gate.yml', event: 'push', headBranch: 'ci/x-0123abcd',
  headSha: 'h', tested: 't', tree: 'tr', producer: 'maws-ci-gate', label: 'x', gates: 'unit', jobId: 9, runner: 'r',
  conclusion: 'success', started: '2026-10-21T06:00:00Z', completed: '2026-10-21T06:08:00Z', ...over,
});

test('a summary: one id per case, the repeated title numbered, per-project counts, file durations from the suites', () => {
  const s = summarize([parseJUnit(fixture('vitest5.xml'))]);
  assert.equal(s.ids.length, 9);
  assert.deepEqual(s.ids.filter((id) => id[2] === 'queue > drains in order'), [
    ['engine', 'src/queue.test.ts', 'queue > drains in order'],
    ['engine', 'src/queue.test.ts', 'queue > drains in order', 2],
  ]);
  assert.deepEqual(s.failed, [{ id: ['app-compiled', 'src/widgets/Panel.test.tsx', 'Panel > draws its title'], message: "expected 'Title' to be 'title' // Object.is equality" }]);
  assert.equal(s.skipped.length, 2);
  assert.deepEqual(s.projects, {
    app: { tests: 3, failed: 0, skipped: 1 },
    'app-compiled': { tests: 3, failed: 1, skipped: 1 },
    engine: { tests: 3, failed: 0, skipped: 0 },
  });
  assert.deepEqual(s.files, [['app', 'src/widgets/Panel.test.tsx', 1204], ['app-compiled', 'src/widgets/Panel.test.tsx', 2007], ['engine', 'src/queue.test.ts', 701]]);
  assert.equal(s.ms, 3912);
});

// Two branches run different suites the same day: main's run is the base; the feature branch deleted one test,
// added a file, and skips one more.
const T = '2026-10-21T06:05:00.000Z';
const mainReport = vitestReport({ timestamp: T, suites: [
  { project: 'app', file: 'src/a.test.ts', time: 1, cases: [{ name: 'a > one' }, { name: 'a > two' }, { name: 'a > old', status: 'skipped' }] },
  { project: 'app', file: 'src/b.test.ts', time: 1, cases: [{ name: 'b > one' }] },
] });
const featureReport = vitestReport({ timestamp: T, suites: [
  { project: 'app', file: 'src/a.test.ts', time: 1, cases: [{ name: 'a > one' }, { name: 'a > old', status: 'skipped' }] },
  { project: 'app', file: 'src/b.test.ts', time: 1, cases: [{ name: 'b > one', status: 'skipped' }] },
  { project: 'app', file: 'src/c.test.ts', time: 1, cases: [{ name: 'c > new', status: 'failed', message: 'no' }] },
] });

// A line in the shape the store held before it was kept small: membership and skipped ids explicit, or as a
// difference from the day's base.
const oldShape = (summary, base = null) => {
  const delta = (ids, baseIds) => {
    const keys = (list) => new Set(list.map((id) => JSON.stringify(id)));
    const inBase = keys(baseIds);
    const inRun = keys(ids);
    return { added: ids.filter((id) => !inBase.has(JSON.stringify(id))), removed: baseIds.filter((id) => !inRun.has(JSON.stringify(id))) };
  };
  const enc = (ids, baseIds) => (baseIds ? delta(ids, baseIds) : { ids });
  return {
    ...buildRunLine(prov(), null, 'present', summary),
    membership: { count: summary.ids.length, hash: hashIds(summary.ids), ...enc(summary.ids, base?.cases) },
    skipped: { count: summary.skipped.length, hash: hashIds(summary.skipped), ...enc(summary.skipped, base?.skipped) },
  };
};

test('a run line keeps counts, the hashes of its ids and skipped ids, and its failed cases; never its membership', () => {
  const feature = summarize([parseJUnit(featureReport)]);
  const line = buildRunLine(prov({ run: 2 }), { id: 2, name: 'test-results-unit-1', created_at: T }, 'present', feature);
  assert.deepEqual(line.membership, { count: 4, hash: hashIds(feature.ids) });
  assert.deepEqual(line.skipped, { count: 2, hash: hashIds(feature.skipped) });
  assert.deepEqual(line.failed, [{ id: ['app', 'src/c.test.ts', 'c > new'], message: 'no' }]);
  assert.ok(isSlim(line));
  assert.ok(!isSlim(oldShape(feature)));
});

test("a case passed in a run only when the run's ids and skipped ids hash as the base's and the case did not fail", () => {
  const main = summarize([parseJUnit(mainReport)]);
  const base = buildBase(prov(), main);
  const same = buildRunLine(prov({ run: 2 }), null, 'present', main);
  assert.equal(caseOutcome(same, base, ['app', 'src/a.test.ts', 'a > two']), 'passed');
  assert.equal(caseOutcome(same, base, ['app', 'src/a.test.ts', 'a > old']), 'unknown', 'skipped in the base and the run');
  assert.equal(caseOutcome(same, base, ['app', 'src/z.test.ts', 'never there']), 'unknown');
  // the same cases, one of them failing: the failure is the run's
  const failing = summarize([parseJUnit(vitestReport({ timestamp: T, suites: [
    { project: 'app', file: 'src/a.test.ts', time: 1, cases: [{ name: 'a > one' }, { name: 'a > two', status: 'failed', message: 'boom' }, { name: 'a > old', status: 'skipped' }] },
    { project: 'app', file: 'src/b.test.ts', time: 1, cases: [{ name: 'b > one' }] },
  ] }))]);
  const red = buildRunLine(prov({ run: 3 }), null, 'present', failing);
  assert.equal(caseOutcome(red, base, ['app', 'src/a.test.ts', 'a > two']), 'failed');
  assert.equal(caseOutcome(red, base, ['app', 'src/a.test.ts', 'a > one']), 'passed');
  // a selected run that left a case out says nothing of it, nor of the cases it ran and passed
  const selected = summarize([parseJUnit(vitestReport({ timestamp: T, suites: [
    { project: 'app', file: 'src/b.test.ts', time: 1, cases: [{ name: 'b > one' }] },
  ] }))]);
  const narrow = buildRunLine(prov({ run: 4, selection: 'affected' }), null, 'present', selected);
  assert.equal(caseOutcome(narrow, base, ['app', 'src/a.test.ts', 'a > two']), 'unknown');
  assert.equal(caseOutcome(narrow, base, ['app', 'src/b.test.ts', 'b > one']), 'unknown');
  // a run of the same cases that skipped one more: unknown for the case it skipped, and for the rest
  const skipping = summarize([parseJUnit(vitestReport({ timestamp: T, suites: [
    { project: 'app', file: 'src/a.test.ts', time: 1, cases: [{ name: 'a > one' }, { name: 'a > two', status: 'skipped' }, { name: 'a > old', status: 'skipped' }] },
    { project: 'app', file: 'src/b.test.ts', time: 1, cases: [{ name: 'b > one' }] },
  ] }))]);
  const skipped = buildRunLine(prov({ run: 5 }), null, 'present', skipping);
  assert.equal(skipped.membership.hash, base.hash, 'the same cases ran');
  assert.equal(caseOutcome(skipped, base, ['app', 'src/a.test.ts', 'a > two']), 'unknown');
  assert.equal(caseOutcome(skipped, base, ['app', 'src/a.test.ts', 'a > one']), 'unknown');
  // the feature branch's failure is known without a base; nothing else is
  const feature = buildRunLine(prov({ run: 6 }), null, 'present', summarize([parseJUnit(featureReport)]));
  assert.equal(caseOutcome(feature, null, ['app', 'src/c.test.ts', 'c > new']), 'failed');
  assert.equal(caseOutcome(feature, null, ['app', 'src/a.test.ts', 'a > one']), 'unknown');
  assert.equal(caseOutcome(buildRunLine(prov(), null, 'missing'), base, ['app', 'src/a.test.ts', 'a > one']), 'unknown');
});

test('an old line is rewritten small from the exact membership it holds, its skipped hash computed where it had none', () => {
  const main = summarize([parseJUnit(mainReport)]);
  const feature = summarize([parseJUnit(featureReport)]);
  const base = buildBase(prov(), main);
  const want = buildRunLine(prov(), null, 'present', feature);
  for (const old of [oldShape(feature, base), oldShape(feature)]) {
    assert.deepEqual(membershipOf(old, base), feature.ids);
    const { line, verified } = slimLine(old, base);
    assert.equal(verified, true);
    assert.deepEqual(line, want);
  }
  // the parent spec's first delta lines carried a skipped count only
  const legacy = oldShape(feature, base);
  delete legacy.skipped.hash;
  assert.deepEqual(slimLine(legacy, base).line.skipped, { count: 2, hash: hashIds(feature.skipped) });
  // a line already small, or with no report, is left as it is
  assert.equal(slimLine(want, base).line, want);
  const missing = buildRunLine(prov(), null, 'missing');
  assert.equal(slimLine(missing, base).line, missing);
});

test('an old line whose membership does not rebuild to its hash keeps its counts and no hash: it answers unknown', () => {
  const main = summarize([parseJUnit(mainReport)]);
  const feature = summarize([parseJUnit(featureReport)]);
  const base = buildBase(prov(), main);
  const other = { ...base, cases: base.cases.slice(1) };
  for (const [old, against] of [[oldShape(feature, base), other], [oldShape(feature, base), null], [oldShape(main, base), other]]) {
    const { line, verified } = slimLine(old, against);
    assert.equal(verified, false);
    assert.deepEqual([line.membership, line.skipped.count], [{ count: old.membership.count, hash: null }, old.skipped.count]);
    assert.equal(caseOutcome(line, base, ['app', 'src/b.test.ts', 'b > one']), 'unknown');
    assert.deepEqual(line.failed, old.failed);
  }
});

test('legacy delta lines still reconstruct without a skipped hash or selection field', () => {
  const one = ['app', 'src/a.test.ts', 'one'];
  const two = ['app', 'src/a.test.ts', 'two'];
  const added = ['app', 'src/b.test.ts', 'new'];
  const line = {
    run: 1, attempt: 1, job: 'unit',
    membership: { count: 2, hash: hashIds([one, added]), added: [added], removed: [two] },
    skipped: { count: 1, added: [added], removed: [two] },
  };
  const base = { cases: [one, two], skipped: [two] };
  assert.deepEqual(membershipOf(line, base), [one, added]);
  assert.deepEqual(skippedOf(line, base), [added]);
  assert.throws(() => membershipOf({ ...line, membership: { ...line.membership, added: [two] } }, base), /does not match its hash/);
  assert.throws(() => skippedOf({ ...line, skipped: { ...line.skipped, count: 2 } }, base), /does not match its count/);
});

test("a project named like an object's own key keeps its counts", () => {
  const s = summarize([parseJUnit(vitestReport({ timestamp: T, suites: [
    { project: 'constructor', file: 'src/a.test.ts', time: 1, cases: [{ name: 'one' }, { name: 'two', status: 'failed' }] },
    { project: '__proto__', file: 'src/a.test.ts', time: 1, cases: [{ name: 'one', status: 'skipped' }] },
    { project: 'app', file: 'src/a.test.ts', time: 1, cases: [{ name: 'one' }] },
  ] }))]);
  assert.deepEqual(Object.keys(s.projects), ['__proto__', 'app', 'constructor']);
  assert.deepEqual(s.projects.constructor, { tests: 2, failed: 1, skipped: 0 });
  assert.deepEqual(Object.getOwnPropertyDescriptor(s.projects, '__proto__').value, { tests: 1, failed: 0, skipped: 1 });
  // and a run line written and read back holds all three
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(s.projects))), ['__proto__', 'app', 'constructor']);
});

test('a line with no report holds provenance only', () => {
  const line = buildRunLine(prov(), null, 'missing');
  assert.equal(line.report, 'missing');
  assert.equal(line.artifact, null);
  assert.equal(line.shards, null); // an unsharded job's line
  assert.equal(line.membership, null);
  assert.equal(line.tested, 't');
  assert.equal(line.selection, null);
  assert.equal(buildRunLine(prov({ selection: 'affected' }), null, 'missing').selection, 'affected');
});

test('the durations snapshot is sampled and names its source', () => {
  const d = buildDurations(prov({ run: 5 }), summarize([parseJUnit(mainReport)]));
  assert.deepEqual(d, { run: 5, attempt: 1, job: 'unit', completed: '2026-10-21T06:08:00Z', sampled: true, files: [['app', 'src/a.test.ts', 1000], ['app', 'src/b.test.ts', 1000]] });
});

test("a report is this job's only when its timestamps fall within the job, give or take a minute", () => {
  const job = { started_at: '2026-10-21T06:00:00Z', completed_at: '2026-10-21T06:08:00Z' };
  const at = (timestamp) => [{ suites: [{ timestamp }] }];
  assert.equal(reportWithinJob(at('2026-10-21T06:05:00.000Z'), job), true);
  assert.equal(reportWithinJob(at('2026-10-21T06:08:30.000Z'), job), true);
  assert.equal(reportWithinJob(at('2026-10-21T05:40:00.000Z'), job), false); // an earlier job's report left behind
  assert.equal(reportWithinJob(at('2026-10-21T06:10:00.000Z'), job), false);
  assert.equal(reportWithinJob([{ suites: [{ timestamp: '2026-10-21T06:05:00Z' }] }, { suites: [{ timestamp: '2026-10-20T06:05:00Z' }] }], job), false);
  assert.equal(reportWithinJob(at(null), job), true); // node --test stamps no suite: nothing to check
});

test('merging is idempotent by (run, attempt, job), sorted; a missing line gives way to a report, never the reverse; a replacement takes its place', () => {
  const a = buildRunLine(prov({ run: 2 }), null, 'missing');
  const b = { ...buildRunLine(prov({ run: 1, job: 'unit:darwin' }), null, 'missing') };
  const c = buildRunLine(prov({ run: 1 }), null, 'missing');
  const merged = mergeLines([], [a, b, c]);
  assert.deepEqual(merged.map((l) => [l.run, l.job]), [[1, 'unit'], [1, 'unit:darwin'], [2, 'unit']]);
  assert.deepEqual(mergeLines(merged, [a, b, c]), merged);
  const present = { ...a, report: 'present' };
  const replaced = mergeLines(merged, [present]);
  assert.equal(replaced.find((l) => l.run === 2).report, 'present');
  assert.equal(mergeLines(replaced, [a]).find((l) => l.run === 2).report, 'present');
  // a line linked again is merged as a replacement; as an ordinary line it would leave the held one in place
  const relinked = { ...present, previous: { run: 1, attempt: 1, relation: 'same-tree', paths: [], truncated: false } };
  assert.equal(mergeLines(replaced, [relinked]).find((l) => l.run === 2).previous, null);
  const again = mergeLines(replaced, [], [relinked]);
  assert.deepEqual(again.find((l) => l.run === 2), relinked);
  assert.deepEqual(again.map((l) => [l.run, l.job]), [[1, 'unit'], [1, 'unit:darwin'], [2, 'unit']]);
  assert.deepEqual(mergeLines(again, [a, b, c]), again);
});
