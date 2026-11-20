// The weekly report and the status file (gate ledger spec, "The report and the status file", M4's pins): per gate its
// attempts, minutes by lane and reds by cause over four weeks; reds to read; nominations only for a covered gate whose
// every red is `infra`; candidates to read for one whose other reds are `rerun-green` or `test-only-diff`; a `keep`
// entry holding a gate out of both; too little record listed as such; a summary's parts' minutes as its gate's; known
// entries in force, expiring and expired, and only those in force in status.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatWritten, weekOf, weekReport, weekStart, writeAll } from '../../history/report.mjs';
import { statusOf } from '../../history/status.mjs';

const repos = JSON.parse(readFileSync(new URL('../../history/repos.json', import.meta.url), 'utf8'));
const MAWS = repos.find((r) => r.alias === 'SSFSKIM/MAWS');
const ALIAS = 'o/r';
const ENTRY = { ...repos.find((r) => r.alias === 'SSFSKIM/doperpowers'), alias: ALIAS, repo: ALIAS };
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T06:00:00Z'); // a Friday of 2026-W47 (2026-11-16 to 11-22)
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dayOf = (ms) => iso(ms).slice(0, 10);

let ids = 0;
// A job line as history/jobs.mjs writes it, `minutes` long, ending at `end` (ms).
function job({ run, gate, end, minutes = 2, lane = 'pool-gce', conclusion = 'success', ...o }) {
  ids += 1;
  return {
    v: 1, run, attempt: 1, workflow: 'ci', event: 'push', ref: `ci/x-${run}`, producer: 'ci-kit-ci-gate', label: 'x', change: 'ci-kit-ci-gate:x', gates: null,
    scope: 'full', scope_key: 'k', head: `h${run}`, tested: `t${run}`, tree: `T${run}`, tree_key: `T${run}`, basis: 'exact',
    job_id: ids, job: `ci / ${gate}`, gate, shard: null, kind: 'gate', role: null, copy: false, copied_from: null, lane, runner: `${lane}-1`,
    started: iso(end - minutes * 60_000), completed: iso(end), minutes, conclusion, run_conclusion: conclusion,
    failed_step: conclusion === 'success' ? null : 'Run tests', phase: conclusion === 'success' ? null : 'test', annotations: [], log_kinds: [], ...o,
  };
}
// The cause line derive.mjs writes for a failed attempt's job line.
const causeOf = (l, cause, why = null) => ({
  v: 1, run: l.run, attempt: l.attempt, gate: l.gate, scope: l.scope, scope_key: l.scope_key, workflow: l.workflow, event: l.event, ref: l.ref,
  change: l.change, basis: l.basis, tree: l.tree, head: l.head, available: l.completed, minutes: l.minutes, lanes: [l.lane], cause, why, evidence: {}, context: {},
});

// A store over the report's four weeks: every day listed whole from `listedFrom` to the day before NOW.
function makeStore(t, { lines, causes = [], landings = [], known = [], listedFrom = '2026-10-15', activity = undefined, pass = undefined, marker = null }) {
  const root = mkdtempSync(join(tmpdir(), 'history-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ALIAS);
  const byDay = (list, key) => {
    const out = new Map();
    for (const l of list) (out.get(l[key].slice(0, 10)) ?? out.set(l[key].slice(0, 10), []).get(l[key].slice(0, 10))).push(l);
    return out;
  };
  for (const [kind, list, key] of [['jobs', lines, 'completed'], ['causes', causes, 'available'], ['landings', landings, 'at']]) {
    mkdirSync(join(dir, kind), { recursive: true });
    for (const [day, ls] of byDay(list, key)) writeFileSync(join(dir, kind, `${day}.jsonl`), ls.map((l) => `${JSON.stringify(l)}\n`).join(''));
  }
  const listed = {};
  for (let d = Date.parse(`${listedFrom}T00:00:00Z`); d < NOW - DAY; d += DAY) listed[dayOf(d)] = `${dayOf(d + DAY)}T01:00:00Z`;
  const state = { v: 1, runs: {}, listed, settled: {}, pass: pass ?? { id: 'p', listed_at: '2026-11-20T05:00:00.000Z', pending: [], queue: [], derived: true }, calls: {}, activity: activity ?? { since: '2026-10-15T00:00:00Z', through: iso(NOW), breaks: [] } };
  writeFileSync(join(dir, 'attempts.json'), `${JSON.stringify(state)}\n`);
  if (known.length) writeFileSync(join(dir, 'known.json'), JSON.stringify(known));
  if (marker) writeFileSync(join(root, 'collected.json'), JSON.stringify({ v: 1, at: marker, repos: {} }));
  return root;
}

// One attempt a day of `gate` from 2026-10-27 to 11-19, 24 in all (the report's window of W47 starts 10-26).
let runs = 1000;
const daily = (gate, o = {}) => Array.from({ length: 24 }, (_, i) => job({ run: (runs += 1), gate, end: Date.parse('2026-10-27T12:00:00Z') + i * DAY, ...o }));
const red = (l) => Object.assign(l, { conclusion: 'failure', run_conclusion: 'failure', failed_step: 'Run tests', phase: 'test' });

function world(t) {
  const lines = [];
  const causes = [];
  const gate = (name, o) => {
    const ls = daily(name, o);
    lines.push(...ls);
    return ls;
  };
  const steady = gate('steady');
  causes.push(causeOf(red(steady[3]), 'infra'));
  const flaky = gate('flaky', { lane: 'mini-host', minutes: 3 });
  causes.push(causeOf(red(flaky[22]), 'rerun-green')); // 11-18, this week
  causes.push(causeOf(red(flaky[5]), 'cancelled'));
  const testfix = gate('testfix');
  causes.push(causeOf(red(testfix[10]), 'test-only-diff'));
  const mystery = gate('mystery');
  causes.push(causeOf(red(mystery[23]), 'unattributed', 'no-later-green')); // 11-19, this week
  causes.push(causeOf(red(mystery[21]), 'unattributed', 'setup-uncorroborated')); // 11-17, this week
  causes.push(causeOf(red(mystery[6]), 'unattributed', 'no-change')); // 11-02, an earlier week
  const caught = gate('caught');
  causes.push(causeOf(red(caught[12]), 'product-diff'));
  gate('kept');
  const uncaused = gate('uncaused');
  red(uncaused[8]); // a failed attempt with no cause line
  const unknown = gate('unknown');
  causes.push(causeOf(red(unknown[4]), 'a-cause-from-a-later-collector'));
  const superseded = gate('busy');
  causes.push(causeOf(red(superseded[2]), 'superseded'));
  for (let i = 0; i < 3; i += 1) lines.push(job({ run: (runs += 1), gate: 'sparse', end: Date.parse('2026-11-10T12:00:00Z') + i * DAY }));
  // MAWS-shaped static: two parts and the summary job, which decides the result and carries no minutes.
  for (const l of daily('static', { job: 'static-local', minutes: 4 })) {
    lines.push(l, { ...l, job_id: (ids += 1), job: 'static / lint', minutes: 2 }, { ...l, job_id: (ids += 1), job: 'static', role: 'summary', lane: 'hosted-linux', minutes: 7 });
  }
  const known = [
    { id: 'keep-kept', gate: 'kept', keep: true, reason: 'guards a costly miss', since: '2026-11-01', review_by: '2027-02-01', by: 'CI-opt' },
    { id: 'old-1', gate: 'mystery', reason: 'shipped once', since: '2026-10-01', review_by: '2026-11-10', by: 'x' },
    { id: 'soon-1', gate: 'mystery', reason: 'shipped with', since: '2026-11-15', review_by: '2026-11-25', by: 'x' },
    { id: 'later-1', gate: 'steady', reason: 'shipped with', since: '2026-11-15', review_by: '2027-01-01', by: 'x' },
  ];
  return { lines, causes, known };
}

test('ISO weeks: a day to its week, a week to its Monday; a week the year lacks is refused', () => {
  assert.equal(weekOf(NOW), '2026-W47');
  assert.equal(iso(weekStart('2026-W47')), '2026-11-16T00:00:00Z');
  assert.equal(weekOf(Date.parse('2027-01-03T12:00:00Z')), '2026-W53'); // 2026 begins on a Thursday: 53 weeks
  assert.equal(iso(weekStart('2027-W01')), '2027-01-04T00:00:00Z');
  assert.throws(() => weekStart('2025-W53'), /week/);
  assert.throws(() => weekStart('2026-47'), /week/);
});

test('nominations: a covered gate with no red but infra; candidates: rerun-green or test-only-diff, each red linked; neither for unattributed, product-diff, no cause line, keep', (t) => {
  const w = world(t);
  const root = makeStore(t, w);
  const { model, text } = weekReport({ root, alias: ALIAS, entry: ENTRY, week: '2026-W47', now: NOW });
  assert.deepEqual(model.nominations.map((g) => g.gate).sort(), ['busy', 'static', 'steady']);
  assert.deepEqual(model.candidates.map((g) => g.gate).sort(), ['flaky', 'testfix']);
  assert.deepEqual(model.tooLittle.map((g) => g.gate), ['sparse']);
  assert.deepEqual(model.kept.map((g) => g.gate), ['kept']);
  for (const g of ['mystery', 'caught', 'uncaused', 'unknown', 'kept', 'sparse']) {
    assert.ok(!model.nominations.some((n) => n.gate === g) && !model.candidates.some((n) => n.gate === g), g);
  }
  // The candidate's red is linked, with its cancelled attempts and minutes on the same line.
  const flaky = w.causes.find((c) => c.gate === 'flaky' && c.cause === 'rerun-green');
  const line = text.split('\n').find((l) => l.startsWith('- `flaky`'));
  assert.ok(line.includes(`https://github.com/${ALIAS}/actions/runs/${flaky.run}/attempts/1`), line);
  assert.match(line, /cancelled 1 \(3 min\)/);
  assert.match(text, /a rerun's pass does not rule out an intermittent product fault/i);
  // A nomination gives its runner minutes a week and the lanes it would free: 24 attempts of 2 minutes over 4 weeks.
  assert.match(text.split('\n').find((l) => l.startsWith('- `steady`')), /12 runner minutes a week \(pool-gce 12\)/);
  assert.match(text.split('\n').find((l) => l.startsWith('- `sparse`')), /3 attempts/);
});

test('reds to read: the week\'s unattributed reds, newest first, with their why and run links; the earlier ones counted', (t) => {
  const w = world(t);
  const root = makeStore(t, w);
  const { model, text } = weekReport({ root, alias: ALIAS, entry: ENTRY, week: '2026-W47', now: NOW });
  const mystery = model.toRead.find((g) => g.gate === 'mystery');
  assert.deepEqual(mystery.reds.map((c) => c.why), ['no-later-green', 'setup-uncorroborated']);
  assert.equal(mystery.earlier, 1);
  const section = text.slice(text.indexOf('## Reds to read'), text.indexOf('## Nominations'));
  assert.ok(section.indexOf('no-later-green') < section.indexOf('setup-uncorroborated'));
  assert.match(section, /1 earlier in the four weeks/);
  assert.ok(section.includes(`/actions/runs/${w.causes.find((c) => c.why === 'no-later-green').run}/attempts/1`));
});

test('per gate: attempts, minutes by lane with the Mac apart, superseded and cancelled beside the reds; a summary\'s parts carry its minutes', (t) => {
  const w = world(t);
  const root = makeStore(t, w);
  const { model, text } = weekReport({ root, alias: ALIAS, entry: ENTRY, week: '2026-W47', now: NOW });
  const g = (name) => model.gates.find((x) => x.gate === name);
  assert.deepEqual(g('static').lanes, { 'pool-gce': 144 }); // 24 × (4 + 2); the summary's 7 minutes on hosted-linux are no one's
  assert.equal(g('static').attempts, 24);
  assert.deepEqual(g('flaky').mac, { 'mini-host': 72 });
  assert.deepEqual(g('flaky').lanes, {});
  assert.deepEqual(g('flaky').cancelled, { n: 1, minutes: 3 });
  assert.deepEqual(g('busy').superseded, { n: 1, minutes: 2 });
  assert.equal(g('busy').reds.superseded, undefined);
  assert.equal(g('uncaused').uncaused.length, 1);
  assert.equal(g('flaky').week.attempts, 4); // 11-16 to 11-19
  const row = text.split('\n').find((l) => l.startsWith('| `flaky`'));
  assert.match(row, /mini-host 72/);
  assert.match(row, /1 \(3 min\)/);
});

test('known entries: in force, expiring within a week, expired; status.json holds only those in force', (t) => {
  const w = world(t);
  const root = makeStore(t, w);
  const { model, text } = weekReport({ root, alias: ALIAS, entry: ENTRY, week: '2026-W47', now: NOW });
  assert.deepEqual(model.known.inForce.map((e) => e.id), ['keep-kept', 'later-1', 'soon-1']);
  assert.deepEqual(model.known.expiring.map((e) => e.id), ['soon-1']);
  assert.deepEqual(model.known.expired.map((e) => e.id), ['old-1']);
  const section = text.slice(text.indexOf('## Known entries'), text.indexOf('## What the record cannot say'));
  assert.match(section, /old-1/);
  const status = statusOf({ root, alias: ALIAS, entry: ENTRY, now: NOW });
  assert.deepEqual(status.known.map((e) => e.id), ['keep-kept', 'soon-1', 'later-1']);
});

test('too little record: a window with fewer than 21 covered days nominates nothing and lists every gate as such', (t) => {
  const w = world(t);
  const root = makeStore(t, { ...w, listedFrom: '2026-11-05' }); // 11-05 to 11-19: 15 covered days of the window
  const { model, text } = weekReport({ root, alias: ALIAS, entry: ENTRY, week: '2026-W47', now: NOW });
  assert.deepEqual(model.nominations, []);
  assert.deepEqual(model.candidates, []);
  assert.ok(model.tooLittle.some((g) => g.gate === 'steady'));
  assert.equal(model.covered.count, 15);
  assert.match(text, /2026-10-26 to 2026-11-04/); // the days not covered, as a range
  assert.match(text, /2026-11-20 to 2026-11-22 not yet ended/);
});

test('landings: counts by both verdicts; red, unrun not in flight and head_green listed by commit; overrides with their reasons; chain breaks counted', (t) => {
  const at = (d) => `2026-11-${d}T10:00:00Z`;
  const landing = (id, d, o) => ({ v: 1, id, type: 'pr_merge', before: `b${id}`, after: `${String(id).repeat(40)}`.slice(0, 40), at: at(d), tree: 't', tree_key: 't', paths: [], pr: id, exempt: false, head_green: null, ship_with: null, ...o });
  const landings = [
    landing(1, 17, { exact: 'green', pr_check: { result: 'green', run: 1, attempt: 1 } }),
    landing(2, 17, { exact: 'red', pr_check: { result: 'green', run: 2, attempt: 1 }, ship_with: 'the banner bug, fixed next' }),
    landing(3, 18, { exact: 'unrun', head_green: true, pr_check: { result: 'unrun', run: 3, attempt: 1, inflight: true, eventual: 'success' } }),
    landing(4, 18, { exact: 'unrun', head_green: false, pr_check: { result: 'unrun', run: 4, attempt: 1, inflight: true, eventual: 'success' } }),
    landing(5, 19, { exact: 'unrun', head_green: false, pr_check: { result: 'none' } }),
    landing(6, 19, { exact: 'exempt', pr_check: null }),
    landing(7, 9, { exact: 'red', pr_check: { result: 'red', run: 7, attempt: 1 } }), // an earlier week
  ];
  const root = makeStore(t, { lines: daily('steady'), landings, activity: { since: '2026-10-15T00:00:00Z', through: iso(NOW), breaks: [{ at: '2026-11-18T11:00:00Z', id: 9 }, { at: '2026-10-01T00:00:00Z', id: 8 }] } });
  const { model, text } = weekReport({ root, alias: ALIAS, entry: ENTRY, week: '2026-W47', now: NOW });
  assert.deepEqual(model.landings.exact, { green: 1, red: 1, unrun: 3, exempt: 1 });
  assert.deepEqual(model.landings.prCheck, { green: 2, 'unrun in flight': 2, none: 1, 'no check': 1 });
  assert.deepEqual(model.landings.listed.map((l) => l.id), [2, 3, 5]);
  assert.deepEqual(model.landings.overrides.map((l) => l.id), [2]);
  assert.match(text, /the banner bug, fixed next/);
  assert.match(text, /1 chain break/);
});

test('a repository with no landing record says so; the gates that compare with the default branch are named', (t) => {
  const root = makeStore(t, { lines: [...daily('steady'), ...daily('version-bump')], activity: 'refused' });
  const { text } = weekReport({ root, alias: ALIAS, entry: ENTRY, week: '2026-W47', now: NOW });
  assert.match(text, /no landing record/);
  // A repository that lands by push, with no required check (MAWS), says so rather than counting checks.
  const maws = weekReport({ root: makeStore(t, { lines: daily('steady'), landings: [{ v: 1, id: 1, type: 'push', before: 'a', after: 'b'.repeat(40), at: '2026-11-17T10:00:00Z', exact: 'green', pr_check: null }] }), alias: ALIAS, entry: { ...MAWS, alias: ALIAS, repo: ALIAS }, week: '2026-W47', now: NOW });
  assert.match(maws.text, /green 1\. The repository has no required check: no `pr_check`\./);
  assert.match(text.slice(text.indexOf('## What the record cannot say')), /`version-bump`/);
});

test('status.json: each gate\'s standing on the default branch, its time and run; as_of from the pass that derived', (t) => {
  const landedAt = Date.parse('2026-11-18T10:00:00Z');
  const lines = [
    job({ run: 1, gate: 'test', end: landedAt - 3600_000, tree: 'L', tree_key: 'L' }),
    job({ run: 2, gate: 'lint', end: landedAt + 3600_000, tree: 'L', tree_key: 'L', conclusion: 'failure' }),
    job({ run: 3, gate: 'test', end: landedAt - 7200_000, tree: 'X', tree_key: 'X' }), // a tree that never landed
  ];
  const landings = [{ v: 1, id: 1, type: 'pr_merge', before: 'a', after: 'c'.repeat(40), at: iso(landedAt), tree: 'L', tree_key: 'L' }];
  const root = makeStore(t, { lines, landings });
  const status = statusOf({ root, alias: ALIAS, entry: ENTRY, now: NOW });
  assert.equal(status.as_of, '2026-11-20T05:00:00.000Z');
  assert.deepEqual(status.gates, {
    lint: { result: 'failed', commit: 'c'.repeat(40), at: iso(landedAt + 3600_000), run: 2, attempt: 1 },
    test: { result: 'succeeded', commit: 'c'.repeat(40), at: iso(landedAt - 3600_000), run: 1, attempt: 1 },
  });
  // A pass that has not derived: the collector's last whole pass, else nothing (a reader takes it as unreadable).
  const undrained = { id: 'q', listed_at: '2026-11-20T05:30:00.000Z', pending: [], queue: [1], derived: false };
  assert.equal(statusOf({ root: makeStore(t, { lines, landings, pass: undrained, marker: '2026-11-19T01:00:00.000Z' }), alias: ALIAS, entry: ENTRY, now: NOW }).as_of, '2026-11-19T01:00:00.000Z');
  assert.equal(statusOf({ root: makeStore(t, { lines, landings, pass: undrained }), alias: ALIAS, entry: ENTRY, now: NOW }).as_of, null);
});

test('the daily write: the current week\'s report and the three before it, and status.json, per repository; counts printed, never a gate', (t) => {
  const w = world(t);
  const root = makeStore(t, w);
  const counts = writeAll({ root, repos: [ENTRY], now: NOW });
  assert.deepEqual(readdirSync(join(root, ALIAS, 'reports')).sort(), ['2026-W44.md', '2026-W45.md', '2026-W46.md', '2026-W47.md']);
  assert.ok(existsSync(join(root, ALIAS, 'status.json')));
  const printed = counts.map(formatWritten).join('\n');
  assert.match(printed, /^o\/r: reports 4 written of 4, status gates \d+ \(failed \d+\), known in force 3$/);
  for (const g of ['steady', 'flaky', 'mystery', 'static']) assert.ok(!printed.includes(g));
  // Unchanged data writes nothing the second time.
  assert.equal(writeAll({ root, repos: [ENTRY], now: NOW + 60_000 })[0].reports, 0);
  // A repository with nothing in the store is skipped.
  assert.deepEqual(writeAll({ root, repos: [{ ...MAWS }], now: NOW }), []);
});
