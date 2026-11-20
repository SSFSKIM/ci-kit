// The hand-run Mac gate's import (gate ledger spec, M2): each run directory of manual-gate-mac to jobs-manual/ lines,
// one per job, a bundled mini copy one per group, read back as gate attempts with the collector's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateAttempts } from '../../history/jobs.mjs';
import { importRuns, parseEnv } from '../../history/manual-gate.mjs';
import { openLedger } from '../../history/store.mjs';

const ALIAS = 'SSFSKIM/MAWS';
const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'history-manual-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A row of mac-summary.json, as lib/summary.mjs writes it.
const row = (id, name, kind, place, result, status, start, end) => ({
  id, name, kind, place, planned: place, result, status, why: '', start, end,
  minutes: start && end ? (Date.parse(end) - Date.parse(start)) / 60000 : null, counts: [], log: `/x/${id}/job.log`, githubPlacement: '', note: '',
});
const STEPS = [['checkout', '0', '10', 'actions/checkout@v7'], ['setup-node', '0', '0', 'setup: actions/setup-node (22)'], ['download', '0', '1', 'download-artifact e2e-build-x-harness (from the run\'s build)']];
const envOf = (over) => Object.entries({ J_E2E_ARGS: null, J_E2E_ENV: null, J_PEER: '', J_LIVE: 'false', ...over })
  .filter(([, v]) => v !== null).map(([k, v]) => `export ${k}=${v.startsWith('$') ? v.slice(1) : `'${v.replaceAll("'", "'\\''")}'`}`).join('\n');

// One run directory: runs/<id>/mac/{mac-summary.json, plan/mac-jobs.json, mini-run/jobs/<row>.env, mini-run/logs/<row>/{steps.tsv,job.log}}.
function runDir(runs, id, verdict, rows, { env = {}, steps = {}, log = {} } = {}) {
  const mac = join(runs, id, 'mac');
  mkdirSync(join(mac, 'plan'), { recursive: true });
  writeFileSync(join(mac, 'plan', 'mac-jobs.json'), JSON.stringify({ sha: SHA, tree: TREE, gates: 'e2e:panel,e2e:code,e2e:remote' }));
  writeFileSync(join(mac, 'mac-summary.json'), JSON.stringify({ sha: SHA, tree: TREE, verdict, wall: 1, rows }));
  for (const r of rows) {
    mkdirSync(join(mac, 'mini-run', 'jobs'), { recursive: true });
    mkdirSync(join(mac, 'mini-run', 'logs', r.id), { recursive: true });
    writeFileSync(join(mac, 'mini-run', 'jobs', `${r.id}.env`), `export J_ID='${r.id}'\nexport J_NAME='${r.name.replaceAll("'", "'\\''")}'\n${envOf(env[r.id] ?? {})}\n`);
    writeFileSync(join(mac, 'mini-run', 'logs', r.id, 'steps.tsv'), (steps[r.id] ?? STEPS).map((s) => s.join('\t')).join('\n') + '\n');
    writeFileSync(join(mac, 'mini-run', 'logs', r.id, 'job.log'), (log[r.id] ?? []).join('\n') + '\n');
  }
}

// The shape of run 24952ff2f8a4-20261119T054617Z (RED 3/5): the build; e2e:panel red, e2e:code and e2e:remote green on
// their own; e2e:remote's mini copy green; one guest job copying e2e:panel (red) and e2e:code (green).
const RED = '24952ff2f8a4-20261119T054617Z';
function redRun(runs, id = RED) {
  runDir(runs, id, 'RED', [
    row('build', "the run's build (gate.yml's e2e-build)", 'build', 'host', 'BUILT', 0, '2026-11-19T05:47:48Z', '2026-11-19T05:48:53Z'),
    row('panel', 'e2e:panel', 'e2e', 'guest', 'FAIL', 1, '2026-11-19T05:58:18Z', '2026-11-19T06:03:06Z'),
    row('code', 'e2e:code', 'e2e', 'guest', 'PASS', 0, '2026-11-19T06:03:06Z', '2026-11-19T06:08:42Z'),
    row('remote', 'e2e:remote', 'e2e', 'host', 'PASS', 0, '2026-11-19T05:48:53Z', '2026-11-19T05:58:36Z'),
    row('remote-mini', 'e2e:remote (mini copy)', 'e2e', 'host', 'PASS', 0, '2026-11-19T05:58:36Z', '2026-11-19T06:06:59Z'),
    row('copy-panel-code', 'e2e: mini copy (panel, code)', 'e2e-copy', 'guest', 'FAIL', 1, '2026-11-19T05:48:58Z', '2026-11-19T05:58:18Z'),
  ], {
    env: { 'copy-panel-code': { J_COPY_GROUPS: 'panel, code' } },
    steps: {
      panel: [...STEPS, ['e2e', '1', '181', 'pnpm e2e:panel'], ['reports', '0', '0', 'the reports (upload-artifact e2e-panel, kept here)']],
      'copy-panel-code': [...STEPS, ['copy1', '1', '181', 'gate-copy.sh run 1 (e2e:panel)'], ['reports1', '0', '1', 'the reports of e2e:panel'], ['copy2', '0', '268', 'gate-copy.sh run 2 (e2e:code)'], ['verdict', '1', '0', "the copies' verdict"]],
    },
    log: { 'copy-panel-code': [
      '05:50:32Z manual-gate: ##[step] gate-copy.sh run 1 (e2e:panel)',
      '  ✘  1 [panel] › e2e/a.spec.ts:1:1 › a case (2s)',
      '05:53:33Z manual-gate: ##[step-end] gate-copy.sh run 1 (e2e:panel): exit 1',
      '05:53:35Z manual-gate: ##[step] gate-copy.sh run 2 (e2e:code)',
      '05:58:03Z manual-gate: ##[step-end] gate-copy.sh run 2 (e2e:code): exit 0',
    ] },
  });
}
const quiet = async (fn) => {
  const out = [];
  const saved = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try {
    return { result: await fn(), out };
  } finally {
    console.log = saved;
  }
};
const linesOf = (store) => openLedger(store, ALIAS).jobLines('2026-11-01', '2026-11-30');
const attemptsOf = (lines, run) => Object.fromEntries(gateAttempts(lines.filter((l) => l.run === run)).map((a) => [`${a.gate}${lines.find((l) => l.job_id === a.jobs[0]).job.includes('mini copy') ? ' (copy)' : ''}`, a]));

test('a red run: seven lines, the build a control job, each mini copy an attempt apart from its direct job', async (t) => {
  const runs = temp(t);
  const store = temp(t);
  redRun(runs);
  const { result } = await quiet(() => importRuns({ runsDir: runs, root: store, alias: ALIAS }));
  assert.deepEqual(result, { runs: 1, unrecorded: 0, lines: 7, written: 1 });
  const lines = linesOf(store);
  assert.equal(lines.length, 7);
  const build = lines.find((l) => l.job_id === 'build');
  assert.deepEqual([build.kind, build.gate, build.conclusion, build.lane], ['control', null, 'success', 'manual-host']);
  const a = attemptsOf(lines, RED);
  assert.deepEqual(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.result])), {
    'e2e:panel': 'failed', 'e2e:code': 'succeeded', 'e2e:remote': 'succeeded',
    'e2e:remote (copy)': 'succeeded', 'e2e:panel (copy)': 'failed', 'e2e:code (copy)': 'succeeded',
  });
  for (const g of ['e2e:panel', 'e2e:code', 'e2e:remote']) assert.notEqual(a[g].scope_key, a[`${g} (copy)`].scope_key);
  // the shared fields of the run, and each group of the bundled copy with its own exit and segment
  const panel = lines.find((l) => l.job_id === 'panel');
  assert.deepEqual(
    [panel.workflow, panel.run, panel.attempt, panel.event, panel.head, panel.tested, panel.tree, panel.basis, panel.scope, panel.gates, panel.run_conclusion, panel.lane, panel.minutes, panel.failed_step, panel.phase],
    ['manual-gate', RED, 1, 'manual', SHA, SHA, TREE, 'exact', 'full', 'e2e:panel,e2e:code,e2e:remote', 'failure', 'manual-guest', 4.8, 'pnpm e2e:panel', 'test'],
  );
  const copied = (g) => lines.find((l) => l.job_id === `copy-panel-code:${g}`);
  assert.deepEqual([copied('panel').conclusion, copied('panel').started, copied('panel').completed, copied('panel').minutes, copied('panel').failed_step],
    ['failure', '2026-11-19T05:50:32Z', '2026-11-19T05:53:33Z', 3, 'gate-copy.sh run 1 (e2e:panel)']);
  assert.deepEqual([copied('code').conclusion, copied('code').minutes, copied('code').failed_step, copied('code').phase], ['success', 4.5, null, null]);
  // a second import changes nothing
  assert.deepEqual((await quiet(() => importRuns({ runsDir: runs, root: store, alias: ALIAS }))).result, { runs: 1, unrecorded: 0, lines: 7, written: 0 });
});

test('a green run, a narrowed run and the place a job ran: what decides what ran or where is in the scope key', async (t) => {
  const runs = temp(t);
  const store = temp(t);
  const green = (id, env = {}, place = 'guest') => runDir(runs, id, 'GREEN', [
    row('code', 'e2e:code', 'e2e', place, 'PASS', 0, '2026-11-18T06:03:06Z', '2026-11-18T06:08:42Z'),
  ], { env: { code: env } });
  green('111111111111-20261118T060000Z');
  green('222222222222-20261118T070000Z', { J_E2E_ARGS: '$e2e/a.spec.ts\\ -g\\ \\"one\\ case\\"' });
  green('333333333333-20261118T080000Z', {}, 'host');
  green('444444444444-20261118T090000Z', { J_PEER: 'c'.repeat(40) });
  green('555555555555-20261118T100000Z', { J_E2E_ENV: 'MAWS_X=1' });
  green('666666666666-20261118T110000Z');
  await quiet(() => importRuns({ runsDir: runs, root: store, alias: ALIAS }));
  const lines = linesOf(store);
  const [plain, narrowed, host, peer, env, again] = lines;
  assert.deepEqual(lines.map((l) => [l.conclusion, l.scope]), [['success', 'full'], ['success', 'narrowed'], ['success', 'full'], ['success', 'full'], ['success', 'full'], ['success', 'full']]);
  assert.equal(plain.scope_key, again.scope_key, 'two runs of the same work compare');
  assert.equal(new Set([plain, narrowed, host, peer, env].map((l) => l.scope_key)).size, 5);
  assert.deepEqual([plain.lane, host.lane], ['manual-guest', 'manual-host']);
  assert.ok(!JSON.stringify(lines).includes('one\\\\ case') && !JSON.stringify(lines).includes('a.spec.ts'), 'a filter is in the key, never in the line');
  assert.equal(gateAttempts([plain])[0].result, 'succeeded');
});

test('a refused run, a partial run and a run with no record: what never ran is incomplete, never red, and costs nothing', async (t) => {
  const runs = temp(t);
  const store = temp(t);
  runDir(runs, '0d49eae4f45e-20261117T111533Z', 'RED', [
    row('build', "the run's build (gate.yml's e2e-build)", 'build', 'host', 'FAIL', 3, '2026-11-17T11:16:00Z', '2026-11-17T11:16:00Z'),
    row('transcript', 'e2e:transcript', 'e2e', 'host', 'FAIL', 3, '2026-11-17T11:16:00Z', '2026-11-17T11:16:00Z'),
  ]);
  runDir(runs, '3b7493f443a1-20261116T135342Z', 'RED', [
    row('build', "the run's build (gate.yml's e2e-build)", 'build', 'host', 'FAIL', 1, '2026-11-16T13:55:00Z', '2026-11-16T14:05:00Z'),
    row('panel', 'e2e:panel', 'e2e', 'guest', 'FAIL', 8, '2026-11-16T14:05:00Z', '2026-11-16T14:05:00Z'),
    row('design', 'e2e:design', 'e2e', 'host', 'NOT RUN', null, null, null),
    row('copy-panel-code', 'e2e: mini copy (panel, code)', 'e2e-copy', 'guest', 'FAIL', 8, '2026-11-16T14:05:00Z', '2026-11-16T14:05:00Z'),
    row('scm', 'e2e:scm', 'e2e', 'host', 'NO TESTS', 0, '2026-11-16T14:05:00Z', '2026-11-16T14:07:00Z'),
  ], { env: { 'copy-panel-code': { J_COPY_GROUPS: 'panel, code' } }, steps: { build: [['checkout', '0', '1', 'actions/checkout@v7'], ['build', '1', '600', 'scripts/e2e-build.sh harness']] } });
  mkdirSync(join(runs, '06f265e4a123-20261119T223719Z', 'mac', 'plan'), { recursive: true }); // planned, never sent to the mini
  const { result, out } = await quiet(() => importRuns({ runsDir: runs, root: store, alias: ALIAS }));
  assert.deepEqual(result, { runs: 2, unrecorded: 1, lines: 8, written: 2 });
  assert.match(out.join('\n'), /^manual-gate: SSFSKIM\/MAWS: runs 2 imported \(1 without a record\), lines 8, files written 2$/);
  const lines = linesOf(store);
  const by = (run, id) => lines.find((l) => l.run === run && l.job_id === id);
  const refused = by('0d49eae4f45e-20261117T111533Z', 'transcript');
  assert.deepEqual([refused.conclusion, refused.lane, refused.minutes, refused.phase], [null, null, 0, null]);
  const partial = '3b7493f443a1-20261116T135342Z';
  assert.deepEqual([by(partial, 'build').conclusion, by(partial, 'build').phase, by(partial, 'build').failed_step], ['failure', 'test', 'scripts/e2e-build.sh harness']);
  const notRun = by(partial, 'design');
  assert.deepEqual([notRun.conclusion, notRun.started, notRun.completed], [null, null, null]);
  assert.ok(readFileSync(join(store, ALIAS, 'jobs-manual', '2026-11-16.jsonl'), 'utf8').includes('"job_id":"design"'), 'filed by its run\'s start');
  assert.equal(by(partial, 'scm').minutes, 2, 'a job that ran no tests still cost its minutes');
  for (const a of gateAttempts(lines)) assert.equal(a.result, 'incomplete', `${a.run} ${a.gate}`);
});

test("a bundled copy whose log has no group's segment (it failed in setup): each group takes the job's end, its minutes on the first", async (t) => {
  const runs = temp(t);
  const store = temp(t);
  const id = '777777777777-20261117T230000Z';
  runDir(runs, id, 'RED', [
    row('copy-a-b-c', 'e2e: mini copy (a, b, c)', 'e2e-copy', 'guest', 'FAIL', 1, '2026-11-17T23:50:00Z', '2026-11-18T00:02:00Z'),
  ], {
    env: { 'copy-a-b-c': { J_COPY_GROUPS: 'a, b, c' } },
    steps: { 'copy-a-b-c': [['checkout', '0', '10', 'actions/checkout@v7'], ['setup-cikit', '1', '19', 'setup: SSFSKIM/ci-kit/setup@v1']] },
  });
  await quiet(() => importRuns({ runsDir: runs, root: store, alias: ALIAS }));
  const lines = linesOf(store);
  assert.deepEqual(lines.map((l) => [l.job_id, l.gate, l.conclusion, l.phase, l.failed_step, l.minutes]), [
    ['copy-a-b-c:a', 'e2e:a', 'failure', 'setup', 'setup: SSFSKIM/ci-kit/setup@v1', 12],
    ['copy-a-b-c:b', 'e2e:b', 'failure', 'setup', 'setup: SSFSKIM/ci-kit/setup@v1', 0],
    ['copy-a-b-c:c', 'e2e:c', 'failure', 'setup', 'setup: SSFSKIM/ci-kit/setup@v1', 0],
  ]);
  assert.ok(lines.every((l) => l.completed === '2026-11-18T00:02:00Z'));
  // and a segment that crossed midnight is dated by the job's start
  const next = '888888888888-20261117T234500Z';
  runDir(runs, next, 'GREEN', [
    row('copy-a', 'e2e: mini copy (a)', 'e2e-copy', 'guest', 'PASS', 0, '2026-11-17T23:50:00Z', '2026-11-18T00:10:00Z'),
  ], { env: { 'copy-a': { J_COPY_GROUPS: 'a' } }, log: { 'copy-a': ['23:58:00Z manual-gate: ##[step] gate-copy.sh run 1 (e2e:a)', '00:06:00Z manual-gate: ##[step-end] gate-copy.sh run 1 (e2e:a): exit 0'] } });
  await quiet(() => importRuns({ runsDir: runs, root: store, alias: ALIAS }));
  const a = linesOf(store).find((l) => l.run === next);
  assert.deepEqual([a.started, a.completed, a.minutes, a.conclusion], ['2026-11-17T23:58:00Z', '2026-11-18T00:06:00Z', 8, 'success']);
});

test("a job's environment file: the last assignment of a key, single quotes undone, any other value kept as written", () => {
  const env = parseEnv("export J_NAME='the run'\\''s build (e2e-build)'\nexport J_SCRIPT='e2e:code'\nexport J_SCRIPT=exec\nexport J_E2E_ARGS=e2e/a.spec.ts\\ -g\\ x\nexport EMPTY=''\n");
  assert.equal(env.get('J_NAME'), "the run's build (e2e-build)");
  assert.equal(env.get('J_SCRIPT'), 'exec');
  assert.equal(env.count('J_SCRIPT'), 2);
  assert.equal(env.get('J_E2E_ARGS'), 'e2e/a.spec.ts\\ -g\\ x');
  assert.equal(env.get('EMPTY'), '');
  assert.equal(env.get('ABSENT'), '');
});
