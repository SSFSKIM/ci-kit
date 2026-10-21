// The record's pure parts (test history spec, M2): case ids, a report's summary, membership as a delta from the
// day's base and its reconstruction, the report-ownership check, and the idempotent merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJUnit } from '../../history/junit.mjs';
import {
  buildBase, buildDurations, buildRunLine, hashIds, membershipOf, mergeLines, reportWithinJob, skippedOf, summarize,
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

test('membership across two branches with different suites and a deleted test: each line rebuilds its own run exactly', () => {
  const main = summarize([parseJUnit(mainReport)]);
  const feature = summarize([parseJUnit(featureReport)]);
  const base = buildBase(prov(), main);
  const mainLine = buildRunLine(prov(), { id: 1, name: 'test-results-unit-1', created_at: T }, 'present', main, base);
  const featureLine = buildRunLine(prov({ run: 2, headBranch: 'ci/y-0123abcd', label: 'y' }), { id: 2, name: 'test-results-unit-1', created_at: T }, 'present', feature, base);

  assert.deepEqual(mainLine.membership, { count: 4, hash: hashIds(main.ids), added: [], removed: [] });
  assert.deepEqual(featureLine.membership.added, [['app', 'src/c.test.ts', 'c > new']]);
  assert.deepEqual(featureLine.membership.removed, [['app', 'src/a.test.ts', 'a > two']]);
  assert.deepEqual(membershipOf(featureLine, base), feature.ids);
  assert.deepEqual(membershipOf(mainLine, base), main.ids);
  // a deleted test is absent from the branch that deleted it, while main still ran it
  assert.ok(!membershipOf(featureLine, base).some((id) => id[2] === 'a > two'));
  assert.ok(membershipOf(mainLine, base).some((id) => id[2] === 'a > two'));
  assert.deepEqual(skippedOf(featureLine, base), feature.skipped);
  assert.deepEqual(featureLine.skipped, { count: 2, added: [['app', 'src/b.test.ts', 'b > one']], removed: [] });
  assert.deepEqual(featureLine.failed, [{ id: ['app', 'src/c.test.ts', 'c > new'], message: 'no' }]);
});

test('a base that is not the one a line was built against fails the hash check', () => {
  const main = summarize([parseJUnit(mainReport)]);
  const feature = summarize([parseJUnit(featureReport)]);
  const base = buildBase(prov(), main);
  const line = buildRunLine(prov({ run: 2 }), null, 'present', feature, base);
  const other = { ...base, cases: base.cases.slice(1) };
  assert.throws(() => membershipOf(line, other), /does not match its hash/);
});

test('a line with no report holds provenance only', () => {
  const line = buildRunLine(prov(), null, 'missing');
  assert.equal(line.report, 'missing');
  assert.equal(line.artifact, null);
  assert.equal(line.membership, null);
  assert.equal(line.tested, 't');
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

test('merging is idempotent by (run, attempt, job), sorted; a missing line gives way to a report, never the reverse', () => {
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
});
