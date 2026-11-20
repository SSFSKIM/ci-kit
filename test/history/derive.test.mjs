// The derived lines' pass (gate ledger spec, M3): landings and causes written by day from a repository's job lines,
// the activity listing and the mirror; recomputed while younger than 14 days, then final; a refused listing leaves no
// landing record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub } from '../../lib/github.mjs';
import { deriveRepo, formatDerived } from '../../history/derive.mjs';
import { openMirror } from '../../history/mirror.mjs';
import { openLedger } from '../../history/store.mjs';
import { gitOrigin } from './helpers.mjs';

const repos = JSON.parse(readFileSync(new URL('../../history/repos.json', import.meta.url), 'utf8'));
const KIT = repos.find((r) => r.alias === 'SSFSKIM/ci-kit');
const ALIAS = 'o/r';
const DAY = 86_400_000;

let ids = 0;
const line = (o) => {
  ids += 1;
  return {
    v: 1, attempt: 1, workflow: 'ci', event: 'push', ref: 'ci/x-1', producer: 'ci-kit-ci-gate', label: 'x', change: 'ci-kit-ci-gate:x', gates: null,
    scope: 'full', scope_key: 'k', tested: null, basis: 'exact', job_id: ids, job: 'ci / test', gate: 'test', shard: null, kind: 'gate', role: null,
    copy: false, copied_from: null, lane: 'hosted-linux', runner: 'GitHub Actions 1', minutes: 5, conclusion: 'success', run_conclusion: 'success',
    failed_step: null, phase: null, annotations: [], log_kinds: [], ...o,
  };
};
const failed = { conclusion: 'failure', run_conclusion: 'failure', failed_step: 'Run npm test', phase: 'test' };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// A ci-kit-shaped repository: two landings 20 and 2 days before `now`, each tree gated red then green by ci-gate.
function setup(t) {
  const o = gitOrigin();
  const root = mkdtempSync(join(tmpdir(), 'history-derive-'));
  t.after(() => {
    o.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.parse('2026-11-20T06:00:00Z');
  const config = 'version: 1\ngates:\n  - name: test\n    run: npm test\n';
  const c0 = o.commit({ '.github/ci-kit.yml': config, 'src/a.ts': '0' }, 'base');
  const c1 = o.commit({ 'src/a.ts': '1' }, 'one (#1)');
  const c2 = o.commit({ 'src/a.ts': '2', 'src/a.test.ts': '2' }, 'two (#2)');
  const ledger = openLedger(root, ALIAS);
  const gated = (run, tree, at, o2 = {}) => line({ run, head: `h${run}`, tree, tree_key: tree, started: iso(at), completed: iso(at + 5 * 60_000), ...o2 });
  const old = now - 20 * DAY;
  const recent = now - 2 * DAY;
  const lines = [
    gated(1, o.tree(c1), old - 3600_000, failed),
    gated(2, o.tree(c1), old - 1800_000),
    gated(3, o.tree(c2), recent - 3600_000, { ...failed, change: 'ci-kit-ci-gate:y' }),
    gated(4, o.tree(c2), recent - 1800_000, { change: 'ci-kit-ci-gate:y' }),
  ];
  for (const l of lines) ledger.addJobLines([l]);
  ledger.state.runs = Object.fromEntries(lines.map((l) => [l.run, { day: l.started.slice(0, 10), attempts: 1, closed: [1], created: l.started }]));
  ledger.flush();
  const activity = [
    { id: 22, activity_type: 'pr_merge', before: c1, after: c2, ref: 'refs/heads/main', timestamp: iso(recent) },
    { id: 21, activity_type: 'pr_merge', before: c0, after: c1, ref: 'refs/heads/main', timestamp: iso(old) },
  ];
  const mirror = openMirror({ dir: join(root, 'mirror.git'), url: `file://${o.dir}`, token: null });
  mirror.ensure();
  return { root, now, activity, mirror, ledger: () => openLedger(root, ALIAS) };
}

const ghWith = (answer) => createGitHub('t', { fetchImpl: async () => answer() });
const page = (items) => () => new Response(JSON.stringify(items), { status: 200, headers: { 'content-type': 'application/json' } });
const read = (root, kind) => {
  const dir = join(root, ALIAS, kind);
  return existsSync(dir) ? Object.fromEntries(readdirSync(dir).sort().map((f) => [f.slice(0, 10), readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))])) : {};
};

test('a first derivation writes every landing and red of the window by day; a later one keeps lines older than 14 days as they are', async (t) => {
  const w = setup(t);
  const first = await deriveRepo({ gh: ghWith(page(w.activity)), repo: 'o/r', alias: ALIAS, entry: KIT, root: w.root, ledger: w.ledger(), mirror: w.mirror, now: w.now });
  assert.deepEqual(first.errors, []);
  const landings = read(w.root, 'landings');
  assert.deepEqual(Object.keys(landings), ['2026-10-31', '2026-11-18']);
  assert.deepEqual(landings['2026-10-31'].map((l) => [l.id, l.exact, l.required]), [[21, 'green', ['test']]]);
  const causes = read(w.root, 'causes');
  assert.deepEqual(Object.values(causes).flat().map((c) => [c.run, c.cause]), [[1, 'rerun-green'], [3, 'rerun-green']]);
  assert.match(formatDerived('o/r', first.counts, 0), /^o\/r: derived: landings 2 \(listed 2\), causes superseded 0, infra 0, rerun-green 2,/);

  // A line older than 14 days is final; a recent one is recomputed, and a new landing is listed since the newest held.
  const oldPath = join(w.root, ALIAS, 'causes', '2026-10-31.jsonl');
  writeFileSync(oldPath, readFileSync(oldPath, 'utf8').replace('"rerun-green"', '"held"'));
  const recentPath = join(w.root, ALIAS, 'causes', '2026-11-18.jsonl');
  writeFileSync(recentPath, readFileSync(recentPath, 'utf8').replace('"rerun-green"', '"stale"'));
  let asked = '';
  const later = createGitHub('t', { fetchImpl: async (href) => ((asked = new URL(href).search), page(w.activity)()) });
  const again = await deriveRepo({ gh: later, repo: 'o/r', alias: ALIAS, entry: KIT, root: w.root, ledger: w.ledger(), mirror: w.mirror, now: w.now + DAY });
  assert.deepEqual(again.errors, []);
  assert.deepEqual(Object.values(read(w.root, 'causes')).flat().map((c) => [c.run, c.cause]), [[1, 'held'], [3, 'rerun-green']]);
  assert.match(asked, /ref=refs%2Fheads%2Fmain/);
});

test('a refused activity listing leaves no landing record, said once; causes are written all the same', async (t) => {
  const w = setup(t);
  const refused = () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
  const ledger = w.ledger();
  const r = await deriveRepo({ gh: ghWith(refused), repo: 'o/r', alias: ALIAS, entry: KIT, root: w.root, ledger, mirror: w.mirror, now: w.now });
  assert.deepEqual(r.errors, []);
  assert.equal(ledger.state.activity, 'refused');
  assert.equal(r.counts.refused, true);
  assert.deepEqual(read(w.root, 'landings'), {});
  assert.equal(Object.values(read(w.root, 'causes')).flat().length, 2);
  assert.match(formatDerived('o/r', r.counts, 0), /landings refused/);
});

test("a listing stopped by the pass's budget is no error; another failure is, named by its request only", async (t) => {
  const w = setup(t);
  const spent = createGitHub('t', { fetchImpl: async () => page([])(), admit: () => false });
  const paced = await deriveRepo({ gh: spent, repo: 'o/r', alias: ALIAS, entry: KIT, root: w.root, ledger: w.ledger(), mirror: w.mirror, now: w.now });
  assert.deepEqual([paced.errors, paced.paced], [[], true]);
  const broken = await deriveRepo({ gh: ghWith(() => new Response('{"message":"secret body"}', { status: 500 })), repo: 'o/r', alias: ALIAS, entry: KIT, root: w.root, ledger: w.ledger(), mirror: w.mirror, now: w.now });
  assert.deepEqual(broken.errors, ['activity: HTTP 500 GET /repos/o/r/activity']);
});

test("two pull request runs of one head are one tree only on a whole landing record: a listing cut short says nothing of the base", async (t) => {
  const w = setup(t);
  const ledger = w.ledger();
  const pr = (run, attempt, at, o2) => line({ run, attempt, event: 'pull_request', basis: 'pr-merge', head: 'hpr', head_tree: 'x', tree: null, tree_key: null, ref: 'topic', change: 'branch:topic', started: iso(at), completed: iso(at + 60_000), ...o2 });
  const at = w.now - 3 * DAY;
  ledger.addJobLines([pr(50, 1, at, failed), pr(50, 2, at + 3600_000, {})]);
  ledger.state.runs[50] = { day: iso(at).slice(0, 10), attempts: 2, closed: [1, 2], created: iso(at) };
  ledger.flush();
  const causeOf50 = () => Object.values(read(w.root, 'causes')).flat().find((c) => c.run === 50);
  const spent = createGitHub('t', { fetchImpl: async () => page([])(), admit: () => false });
  await deriveRepo({ gh: spent, repo: 'o/r', alias: ALIAS, entry: KIT, root: w.root, ledger: w.ledger(), mirror: w.mirror, now: w.now });
  assert.deepEqual([causeOf50().cause, causeOf50().why], ['unattributed', 'basis']);
  await deriveRepo({ gh: ghWith(page(w.activity)), repo: 'o/r', alias: ALIAS, entry: KIT, root: w.root, ledger: w.ledger(), mirror: w.mirror, now: w.now });
  assert.equal(causeOf50().cause, 'rerun-green');
});
