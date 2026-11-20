// The store directory (gate ledger spec, "The per-test record, kept small" and M2): a pass loads the last 35 days of
// run lines; the lines of the old shape are rewritten small once, every day of them, from the membership they hold;
// the hand-run gate's job lines have files of their own, read with the collector's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseJUnit } from '../../history/junit.mjs';
import { buildBase, buildRunLine, hashIds, isSlim, summarize } from '../../history/record.mjs';
import { io, openLedger, openStore, rewriteRecord, writeManualLines } from '../../history/store.mjs';
import { vitestReport } from './helpers.mjs';

const ALIAS = 'o/r';
const NOW = Date.parse('2026-11-20T06:00:00Z');
const tempRoot = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'history-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const report = (names, skipped = []) => summarize([parseJUnit(vitestReport({ timestamp: '2026-11-01T06:05:00.000Z', suites: [
  { project: 'app', file: 'src/a.test.ts', time: 1, cases: [...names.map((name) => ({ name })), ...skipped.map((name) => ({ name, status: 'skipped' }))] },
] }))]);
const prov = (run, day) => ({
  run, attempt: 1, job: 'unit', workflow: 'gate.yml', event: 'push', headBranch: 'master', headSha: 'h', tested: 't', tree: 'tr',
  producer: 'other', label: null, gates: null, jobId: run, runner: 'r', conclusion: 'success', started: `${day}T06:00:00Z`, completed: `${day}T06:08:00Z`,
});
// A line as the store held it before it was kept small: a delta from its day's base, or its ids written out.
const oldLine = (run, day, summary, base) => {
  const enc = (ids, baseIds) => {
    if (!baseIds) return { ids };
    const has = (list) => new Set(list.map((id) => JSON.stringify(id)));
    const inBase = has(baseIds);
    const inRun = has(ids);
    return { added: ids.filter((id) => !inBase.has(JSON.stringify(id))), removed: baseIds.filter((id) => !inRun.has(JSON.stringify(id))) };
  };
  return {
    ...buildRunLine(prov(run, day), null, 'present', summary),
    membership: { count: summary.ids.length, hash: hashIds(summary.ids), ...enc(summary.ids, base?.cases) },
    skipped: { count: summary.skipped.length, hash: hashIds(summary.skipped), ...enc(summary.skipped, base?.skipped) },
  };
};
const writeDay = (root, day, lines) => {
  const dir = join(root, ALIAS, 'runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
};
const writeBase = (root, day, base) => {
  const dir = join(root, ALIAS, 'base', day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'unit.json.gz'), gzipSync(JSON.stringify(base)));
};
const readDay = (root, day) => readFileSync(join(root, ALIAS, 'runs', `${day}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Two days of the old shape: one long past the 35 days a pass loads, one inside them. Each day's first run is its base.
function oldStore(root) {
  const full = report(['one', 'two'], ['old']);
  const branch = report(['one', 'three']);
  for (const day of ['2026-10-01', '2026-11-18']) {
    const base = buildBase(prov(1, day), full);
    writeBase(root, day, base);
    writeDay(root, day, [oldLine(day === '2026-10-01' ? 1 : 11, day, full, base), oldLine(day === '2026-10-01' ? 2 : 12, day, branch, base)]);
  }
  return { full, branch };
}

test('a pass loads the last 35 days of run lines only', (t) => {
  const root = tempRoot(t);
  const s = report(['one']);
  writeDay(root, '2026-10-16', [buildRunLine(prov(1, '2026-10-16'), null, 'present', s)]);
  writeDay(root, '2026-10-17', [buildRunLine(prov(2, '2026-10-17'), null, 'present', s)]);
  writeDay(root, '2026-11-20', [buildRunLine(prov(3, '2026-11-20'), null, 'present', s)]);
  const store = openStore(root, ALIAS, { now: NOW });
  assert.deepEqual(store.lines().map((l) => l.run), [2, 3]);
  // a line for a day outside the window is still merged with that day's file, never written over it
  store.add(buildRunLine(prov(4, '2026-10-16'), null, 'present', s));
  store.flush();
  assert.deepEqual(readDay(root, '2026-10-16').map((l) => l.run), [1, 4]);
});

test('the old lines are rewritten small once, every day of them, from the membership they hold; the rewrite is marked', (t) => {
  const root = tempRoot(t);
  const { full, branch } = oldStore(root);
  const result = rewriteRecord(root, ALIAS, NOW);
  assert.deepEqual(result, { days: 2, lines: 4, rewritten: 4, unverified: 0 });
  for (const day of ['2026-10-01', '2026-11-18']) {
    const [a, b] = readDay(root, day);
    assert.ok(isSlim(a) && isSlim(b));
    assert.deepEqual([a.membership, a.skipped], [{ count: 3, hash: hashIds(full.ids) }, { count: 1, hash: hashIds(full.skipped) }]);
    assert.deepEqual(b.membership, { count: 2, hash: hashIds(branch.ids) });
  }
  assert.deepEqual(JSON.parse(readFileSync(join(root, ALIAS, 'record.json'), 'utf8')), { v: 1, slim: '2026-11-20T06:00:00.000Z' });
  // a second call finds the mark and reads nothing
  assert.equal(rewriteRecord(root, ALIAS, NOW), null);
  // a store with no lines yet is marked at once
  const empty = tempRoot(t);
  assert.deepEqual(rewriteRecord(empty, ALIAS, NOW), { days: 0, lines: 0, rewritten: 0, unverified: 0 });
  assert.ok(existsSync(join(empty, ALIAS, 'record.json')));
});

test('a line whose delta no longer rebuilds is kept with its counts and no hash, and counted', (t) => {
  const root = tempRoot(t);
  oldStore(root);
  rmSync(join(root, ALIAS, 'base', '2026-10-01'), { recursive: true }); // its deltas' base is gone
  assert.deepEqual(rewriteRecord(root, ALIAS, NOW), { days: 2, lines: 4, rewritten: 4, unverified: 2 });
  assert.deepEqual(readDay(root, '2026-10-01').map((l) => l.membership.hash), [null, null]);
});

test('an old-shape line a pass loads (a collector from before the rewrite wrote it) is made small when the pass flushes', (t) => {
  const root = tempRoot(t);
  const { full } = oldStore(root);
  writeFileSync(join(root, ALIAS, 'record.json'), '{"v":1,"slim":"2026-11-19T00:00:00.000Z"}\n'); // marked before main's collector wrote again
  const store = openStore(root, ALIAS, { now: NOW });
  assert.ok(store.lines().every(isSlim), 'held small at once');
  assert.equal(store.line('11/1/unit').membership.hash, hashIds(full.ids));
  store.flush();
  assert.ok(readDay(root, '2026-11-18').every(isSlim));
  assert.ok(!readDay(root, '2026-10-01').some(isSlim), 'a day outside the window waits for no pass');
});

test("the hand-run gate's lines have their own files, idempotent by job, and are read with the collector's", (t) => {
  const root = tempRoot(t);
  const line = (run, job_id, completed, conclusion = 'success') => ({ v: 1, run, attempt: 1, job_id, gate: 'e2e:panel', kind: 'gate', completed, conclusion });
  const ledger = openLedger(root, ALIAS);
  ledger.addJobLines([{ v: 1, run: 44486328066, attempt: 1, job_id: 135, gate: 'unit', kind: 'gate', completed: '2026-11-19T08:20:00Z', conclusion: 'success' }]);
  ledger.flush();
  const runId = '24952ff2f8a4-20261119T054617Z';
  assert.equal(writeManualLines(root, ALIAS, [
    { day: '2026-11-19', line: line(runId, 'panel', '2026-11-19T06:03:06Z', 'failure') },
    { day: '2026-11-19', line: line(runId, 'copy-panel-code:panel', '2026-11-19T05:53:33Z') },
    { day: '2026-11-19', line: line('03bf454750ec-20261116T084909Z', 'remote', null) },
  ]), 1);
  // the same lines again change nothing; a line read again replaces its own
  assert.equal(writeManualLines(root, ALIAS, [{ day: '2026-11-19', line: line(runId, 'panel', '2026-11-19T06:03:06Z', 'failure') }]), 0);
  assert.equal(writeManualLines(root, ALIAS, [{ day: '2026-11-19', line: line(runId, 'panel', '2026-11-19T06:03:06Z') }]), 1);
  assert.ok(!existsSync(join(root, ALIAS, 'jobs', '2026-11-18.jsonl')));
  const all = openLedger(root, ALIAS).jobLines('2026-11-19', '2026-11-19');
  assert.deepEqual(all.map((l) => [l.run, l.job_id, l.conclusion]), [
    ['03bf454750ec-20261116T084909Z', 'remote', 'success'],
    [runId, 'copy-panel-code:panel', 'success'],
    [runId, 'panel', 'success'],
    [44486328066, 135, 'success'],
  ]);
  assert.deepEqual(readFileSync(join(root, ALIAS, 'jobs-manual', '2026-11-19.jsonl'), 'utf8').trim().split('\n').length, 3);
});

// A write that puts down part of its bytes and then fails, as a full disk or an I/O error does, on the `n`th write.
const failingWrite = (n) => {
  let calls = 0;
  return (path, data) => {
    calls += 1;
    if (calls !== n) return writeFileSync(path, data);
    writeFileSync(path, String(data).slice(0, 5));
    throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
  };
};
const withWrite = (write, fn) => {
  const saved = io.write;
  io.write = write;
  try {
    return fn();
  } finally {
    io.write = saved;
  }
};
const filesUnder = (dir) => readdirSync(dir, { recursive: true }).filter((p) => !statSync(join(dir, p)).isDirectory()).sort();

test('a store file is replaced whole or not at all: a write that fails partway leaves the file it had and no temporary', (t) => {
  const root = tempRoot(t);
  // the gate ledger's files: two days of job lines, then attempts.json
  const ledger = openLedger(root, ALIAS);
  ledger.addJobLines([{ v: 1, run: 1, attempt: 1, job_id: 1, completed: '2026-11-18T01:00:00Z' }, { v: 1, run: 2, attempt: 1, job_id: 2, completed: '2026-11-19T01:00:00Z' }]);
  ledger.flush();
  const before = filesUnder(root).map((p) => [p, readFileSync(join(root, p), 'utf8')]);
  const again = openLedger(root, ALIAS);
  again.addJobLines([{ v: 1, run: 3, attempt: 1, job_id: 3, completed: '2026-11-18T02:00:00Z' }, { v: 1, run: 4, attempt: 1, job_id: 4, completed: '2026-11-19T02:00:00Z' }]);
  again.state.listed['2026-11-18'] = '2026-11-19T00:00:00Z';
  assert.throws(() => withWrite(failingWrite(2), () => again.flush()), /no space/);
  const after = Object.fromEntries(filesUnder(root).map((p) => [p, readFileSync(join(root, p), 'utf8')]));
  assert.deepEqual(Object.keys(after), before.map(([p]) => p), 'no temporary left behind');
  assert.equal(after[join(ALIAS, 'jobs', '2026-11-19.jsonl')], Object.fromEntries(before)[join(ALIAS, 'jobs', '2026-11-19.jsonl')], 'the failed file is as it was');
  assert.equal(after[join(ALIAS, 'jobs', '2026-11-18.jsonl')].trim().split('\n').length, 2, 'the file written before it is whole');
  for (const text of Object.values(after).filter((x, i) => Object.keys(after)[i].endsWith('.jsonl'))) text.trim().split('\n').forEach((l) => JSON.parse(l));

  // the per-test day files and the one-time rewrite: the mark is never written over a day left half done
  const old = tempRoot(t);
  oldStore(old);
  const day = readFileSync(join(old, ALIAS, 'runs', '2026-11-18.jsonl'), 'utf8');
  assert.throws(() => withWrite(failingWrite(2), () => rewriteRecord(old, ALIAS, NOW)), /no space/);
  assert.equal(readFileSync(join(old, ALIAS, 'runs', '2026-11-18.jsonl'), 'utf8'), day);
  assert.ok(!existsSync(join(old, ALIAS, 'record.json')));
  assert.deepEqual(rewriteRecord(old, ALIAS, NOW), { days: 2, lines: 4, rewritten: 2, unverified: 0 }, 'the next pass finishes it');

  // the hand-run gate's files
  const manual = tempRoot(t);
  const line = (job_id, completed) => ({ v: 1, run: 'r', attempt: 1, job_id, completed });
  writeManualLines(manual, ALIAS, [{ day: '2026-11-19', line: line('a', '2026-11-19T01:00:00Z') }]);
  const held = readFileSync(join(manual, ALIAS, 'jobs-manual', '2026-11-19.jsonl'), 'utf8');
  assert.throws(() => withWrite(failingWrite(1), () => writeManualLines(manual, ALIAS, [{ day: '2026-11-19', line: line('b', '2026-11-19T02:00:00Z') }])), /no space/);
  assert.equal(readFileSync(join(manual, ALIAS, 'jobs-manual', '2026-11-19.jsonl'), 'utf8'), held);
  assert.deepEqual(filesUnder(manual), [join(ALIAS, 'jobs-manual', '2026-11-19.jsonl')]);
});

test("a hand-run line read again replaces its own wherever it was filed, and keeps a tree key it cannot compute again", (t) => {
  const root = tempRoot(t);
  const line = (over) => ({ v: 1, run: 'r1', attempt: 1, job_id: 'panel', tree: 'T', tree_key: 'K', completed: null, conclusion: null, ...over });
  writeManualLines(root, ALIAS, [{ day: '2026-11-18', line: line({}) }]);
  // the job completed past midnight: filed on the next day, and the old line goes
  writeManualLines(root, ALIAS, [{ day: '2026-11-19', line: line({ completed: '2026-11-19T00:05:00Z', conclusion: 'success', tree_key: null }) }]);
  const all = openLedger(root, ALIAS).jobLines('2026-11-01', '2026-11-30');
  assert.deepEqual(all.map((l) => [l.job_id, l.conclusion, l.tree_key]), [['panel', 'success', 'K']], 'one line, its key kept for the same tree');
  assert.ok(!existsSync(join(root, ALIAS, 'jobs-manual', '2026-11-18.jsonl')) || readFileSync(join(root, ALIAS, 'jobs-manual', '2026-11-18.jsonl'), 'utf8') === '');
  // a new tree without a key has none: the old key named another tree
  writeManualLines(root, ALIAS, [{ day: '2026-11-19', line: line({ completed: '2026-11-19T00:05:00Z', tree: 'U', tree_key: null }) }]);
  assert.equal(openLedger(root, ALIAS).jobLines('2026-11-01', '2026-11-30')[0].tree_key, null);
});
