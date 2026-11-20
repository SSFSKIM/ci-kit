// A landing (gate ledger spec, "A landing", M3's pins): one update of a default branch, read from the activity listing,
// judged by two verdicts (`exact`: did the landed tree run; `pr_check`: what the required check saw), and the default
// branch's standing per gate. Trees, paths, parents and messages come from a real mirror of a git origin on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub } from '../../lib/github.mjs';
import { analyze, deriveCauses } from '../../history/cause.mjs';
import { landingIndex, landingLine, listActivity, observationsOf, prOfMessage } from '../../history/landings.mjs';
import { openMirror } from '../../history/mirror.mjs';
import { gitOrigin } from './helpers.mjs';

const repos = JSON.parse(readFileSync(new URL('../../history/repos.json', import.meta.url), 'utf8'));
const MAWS = repos.find((r) => r.alias === 'SSFSKIM/MAWS');
const KIT = repos.find((r) => r.alias === 'SSFSKIM/ci-kit');
const T0 = Date.parse('2026-11-18T08:00:00Z');
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let ids = 0;
// A job line as history/jobs.mjs writes it; `at`: minutes after T0 it started, `took` its minutes.
function line({ run, attempt = 1, at = 0, took = 5, gate = 'test', job = `ci / ${gate}`, kind = 'gate', ...o }) {
  ids += 1;
  return {
    v: 1, run, attempt, workflow: 'ci', event: 'push', ref: 'ci/x-1', producer: 'ci-kit-ci-gate', label: 'x', change: 'ci-kit-ci-gate:x', gates: null,
    scope: 'full', scope_key: 'k-full', head: `h${run}`, tested: `t${run}`, tree: null, tree_key: null, basis: 'exact',
    job_id: ids, job, gate: kind === 'gate' ? gate : null, shard: null, kind, role: null, copy: false, copied_from: null, lane: 'hosted-linux', runner: 'GitHub Actions 1',
    started: iso(at), completed: iso(at + took), minutes: took, conclusion: 'success', run_conclusion: 'success',
    failed_step: null, phase: null, annotations: [], log_kinds: [], ...o,
  };
}
// A pull request run of `head`: its gate jobs and the verdict job, which ends `took` minutes after `at`.
const prRun = (run, head, { at = 0, took = 5, conclusion = 'success', gates = ['test'], attempt = 1 } = {}) => [
  ...gates.map((gate) => line({ run, attempt, at, took: took - 1, gate, event: 'pull_request', basis: 'pr-merge', head, head_tree: 'x', ref: 'topic', change: 'branch:topic', conclusion })),
  line({ run, attempt, at: at + took - 1, took: 1, gate: null, job: 'ci / verdict', kind: 'control', event: 'pull_request', basis: 'pr-merge', head, ref: 'topic', change: 'branch:topic', conclusion }),
];

function world(t) {
  const o = gitOrigin();
  const root = mkdtempSync(join(tmpdir(), 'ci-kit-mirrors-'));
  t.after(() => {
    o.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const mirror = () => {
    const m = openMirror({ dir: join(root, 'o.git'), url: `file://${o.dir}`, token: null });
    m.ensure();
    m.fetchPulls();
    return m;
  };
  return { o, mirror };
}
const event = (id, before, after, at, type = 'pr_merge') => ({ id, type, before, after, at: iso(at) });
const landed = (lines, ev, { entry = KIT, mirror, landings = [] }) => {
  const analysis = analyze(lines);
  return landingLine(ev, { entry, mirror, index: landingIndex(analysis, lines), pulls: mirror.pulls() });
};

const KIT_CONFIG = 'version: 1\ngates:\n  - name: test\n    run: npm test\n    paths: ["src/**"]\n  - name: docs\n    run: npm run docs\n    paths: ["docs/**"]\n';

test("pr_check is the verdict job's own result; a later ci-gate push of the head is a cause line of its own, not this verdict", (t) => {
  const { o, mirror } = world(t);
  const base = o.commit({ '.github/ci-kit.yml': KIT_CONFIG, 'src/a.ts': '1', 'docs/x.md': 'x' }, 'base');
  o.git('checkout', '-q', '-b', 'topic');
  const head = o.commit({ 'src/a.ts': '2' }, 'work');
  o.git('checkout', '-q', 'main');
  o.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #410 from o/topic', 'topic');
  const merge = o.git('rev-parse', 'HEAD');
  o.git('update-ref', 'refs/pull/410/head', head);
  const m = mirror();
  const tree = o.tree(head);
  const lines = [
    ...prRun(100, head, { at: 0 }),
    // Six minutes after the merge, a ci-gate push of the same tree fails.
    line({ run: 101, at: 36, tree, tree_key: tree, head: 'nonce', conclusion: 'failure', run_conclusion: 'failure', failed_step: 'Run npm test', phase: 'test' }),
  ];
  const l = landed(lines, event(1, base, merge, 30), { mirror: m });
  assert.equal(l.pr, 410);
  assert.equal(l.pr_link, 'parent');
  assert.equal(l.head, head);
  assert.deepEqual(l.required, ['test'], 'the planner, from the config at before, for the landing\'s paths');
  assert.deepEqual(l.paths, ['src/a.ts']);
  assert.deepEqual(l.pr_check, { result: 'green', run: 100, attempt: 1 });
  assert.equal(l.exact, 'unrun', 'the push ran after the landing');
  assert.equal(l.head_green, false);
  const causes = deriveCauses({ analysis: analyze(lines), entry: KIT, landings: [l], standing: () => null, known: [], casesOf: () => null, paths: () => null, prOf: () => null, from: '2026-01-01' });
  assert.deepEqual(causes.map((c) => [c.run, c.cause]), [[101, 'unattributed']]);
});

test('pr_check: a squash reads its head from refs/pull/<n>/head; in flight at the landing; none without a pull request run; a red check', (t) => {
  const { o, mirror } = world(t);
  const base = o.commit({ '.github/ci-kit.yml': KIT_CONFIG, 'src/a.ts': '1' }, 'base');
  o.git('checkout', '-q', '-b', 'topic');
  const head6 = o.commit({ 'src/a.ts': '6' }, 'six');
  o.git('checkout', '-q', 'main');
  const squash6 = o.commit({ 'src/a.ts': '6' }, 'six (#6)');
  const squash7 = o.commit({ 'docs/y.md': 'y' }, 'docs: y (#7)');
  const squash8 = o.commit({ 'src/a.ts': '8' }, 'eight (#8)\n\nShip-with: the flaky test is #12, fixed on its branch');
  const direct = o.commit({ 'src/a.ts': '9' }, 'a direct push');
  o.git('update-ref', 'refs/pull/6/head', head6);
  o.git('update-ref', 'refs/pull/7/head', squash7);
  o.git('update-ref', 'refs/pull/8/head', head6);
  const m = mirror();
  // #6's check ends after its landing, green; #8's head (the same commit, a later run) red before its landing.
  const lines = [...prRun(200, head6, { at: 0, took: 20 }), ...prRun(201, head6, { at: 40, took: 5, conclusion: 'failure' })];
  const six = landed(lines, event(2, base, squash6, 10), { mirror: m });
  assert.deepEqual([six.pr, six.pr_link, six.head], [6, 'message', head6]);
  assert.deepEqual(six.pr_check, { result: 'unrun', run: 200, attempt: 1, inflight: true, eventual: 'success' });
  const seven = landed(lines, event(3, squash6, squash7, 30), { mirror: m });
  assert.deepEqual(seven.pr_check, { result: 'none' });
  assert.deepEqual(seven.required, ['docs'], 'a docs-only change requires the docs gate alone');
  const eight = landed(lines, event(4, squash7, squash8, 60), { mirror: m });
  assert.deepEqual(eight.pr_check, { result: 'red', run: 201, attempt: 1 });
  assert.equal(eight.ship_with, 'the flaky test is #12, fixed on its branch');
  const nine = landed(lines, event(5, squash8, direct, 70, 'push'), { mirror: m });
  assert.deepEqual([nine.pr, nine.pr_check, nine.exact, nine.ship_with], [null, null, 'unrun', null]);
});

test("exact: the latest full, exact attempt of each required gate on the landed tree, completed before the landing", (t) => {
  const { o, mirror } = world(t);
  const base = o.commit({ '.github/ci-kit.yml': KIT_CONFIG, 'src/a.ts': '1' }, 'base');
  const tip = o.commit({ 'src/a.ts': '2' }, 'two (#3)');
  const m = mirror();
  const tree = o.tree(tip);
  const on = (o2) => line({ tree, tree_key: tree, ...o2 });
  const failed = { conclusion: 'failure', run_conclusion: 'failure', failed_step: 'Run npm test', phase: 'test' };
  const ev = event(1, base, tip, 60);
  assert.equal(landed([on({ run: 1, at: 0 })], ev, { mirror: m }).exact, 'green');
  assert.deepEqual(landed([on({ run: 1, at: 0 })], ev, { mirror: m }).exact_gates, { test: { result: 'succeeded', run: 1, attempt: 1 } });
  assert.equal(landed([on({ run: 1, at: 0 }), on({ run: 2, at: 10, ...failed })], ev, { mirror: m }).exact, 'red', 'the latest, not any');
  assert.equal(landed([on({ run: 1, at: 0, ...failed }), on({ run: 2, at: 10 })], ev, { mirror: m }).exact, 'green');
  assert.equal(landed([on({ run: 1, at: 58 })], ev, { mirror: m }).exact, 'unrun', 'still running at the landing');
  assert.equal(landed([on({ run: 1, at: 0, scope: 'selected', scope_key: 'k-sel' })], ev, { mirror: m }).exact, 'unrun', 'not full');
  assert.equal(landed([on({ run: 1, at: 0, basis: 'pr-merge', event: 'pull_request', tree: null, tree_key: null, head_tree: tree })], ev, { mirror: m }).exact, 'unrun', 'not exact');
});

const MAWS_FILES = { 'src/a.ts': '1', 'src/b.ts': '1', 'docs/plan.md': 'p', 'docs/doperpowers/evidence/e.json': '{}' };

test("MAWS: the whole push's difference under its path policy decides exempt; the exception is not exempt", (t) => {
  const { o, mirror } = world(t);
  const base = o.commit(MAWS_FILES, 'base');
  o.commit({ 'src/c.ts': '1' }, 'product');
  const docsTip = o.commit({ 'docs/plan.md': 'p2' }, 'docs');
  const docsOnly = o.commit({ 'docs/plan.md': 'p3' }, 'docs again');
  const evidence = o.commit({ 'docs/doperpowers/evidence/e.json': '{"a":1}' }, 'evidence');
  const m = mirror();
  const push = landed([], event(1, base, docsTip, 10, 'push'), { entry: MAWS, mirror: m });
  assert.deepEqual(push.paths, ['docs/plan.md', 'src/c.ts']);
  assert.deepEqual([push.exempt, push.exact, push.required], [false, 'unrun', ['static', 'unit', 'probes']]);
  assert.equal(push.pr_check, null, 'MAWS merges no pull requests on GitHub');
  const docs = landed([], event(2, docsTip, docsOnly, 20, 'push'), { entry: MAWS, mirror: m });
  assert.deepEqual([docs.exempt, docs.exact], [true, 'exempt']);
  const ev = landed([], event(3, docsOnly, evidence, 30, 'push'), { entry: MAWS, mirror: m });
  assert.deepEqual([ev.exempt, ev.exact], [false, 'unrun']);
  assert.equal(docs.tree_key, m.treeKey(o.tree(docsOnly), MAWS.path_policy));
});

test('MAWS: a merged tree that never ran, its branch head green on all three gates, is unrun with head_green', (t) => {
  const { o, mirror } = world(t);
  const base = o.commit(MAWS_FILES, 'base');
  o.git('checkout', '-q', '-b', 'work');
  const head = o.commit({ 'src/a.ts': '2' }, 'work');
  o.git('checkout', '-q', 'main');
  const moved = o.commit({ 'src/b.ts': '2' }, 'master moved');
  o.git('merge', '-q', '--no-ff', '-m', 'Merge work', 'work');
  const merge = o.git('rev-parse', 'HEAD');
  const m = mirror();
  const key = m.treeKey(o.tree(head), MAWS.path_policy);
  const lines = ['static', 'unit', 'probes'].map((gate, i) => line({ run: 10 + i, at: 0, gate, job: gate, workflow: 'gate', tree: o.tree(head), tree_key: key }));
  const l = landed(lines, event(1, moved, merge, 30, 'push'), { entry: MAWS, mirror: m });
  assert.deepEqual([l.exact, l.head_green], ['unrun', true]);
  // With one gate of the head red it is not.
  lines[1] = { ...lines[1], conclusion: 'failure', run_conclusion: 'failure', failed_step: 'Run x', phase: 'test' };
  assert.equal(landed(lines, event(1, moved, merge, 30, 'push'), { entry: MAWS, mirror: m }).head_green, false);
  assert.notEqual(base, moved);
});

test("the default branch's standing: an observation is used only after both its completion and its landing's push", () => {
  const lines = [
    line({ run: 1, at: 0, tree: 'A', tree_key: 'A' }), // gated on its branch, landed at 30
    line({ run: 2, at: 50, tree: 'B', tree_key: 'B', conclusion: 'failure', run_conclusion: 'failure', failed_step: 'x', phase: 'test' }), // B landed at 40, ran 50..55
    line({ run: 3, at: 60, tree: 'Z', tree_key: 'Z' }), // a tree that never landed
    line({ run: 4, at: 70, tree: 'C', tree_key: 'C', ref: 'main', change: null, producer: 'other' }), // a push run of the default branch
  ];
  const landings = [{ at: iso(30), tree_key: 'A', after: 'a' }, { at: iso(40), tree_key: 'B', after: 'b' }];
  const obs = observationsOf({ analysis: analyze(lines), landings, entry: KIT });
  assert.equal(obs.standing('test', iso(20)), null, 'run 1 completed, but its tree had not landed');
  assert.deepEqual(obs.standing('test', iso(31)), { result: 'succeeded', commit: 'a', at: iso(5), run: 1, attempt: 1, tree_key: 'A', landed: iso(30) });
  assert.equal(obs.standing('test', iso(45)).run, 1, 'B landed, but its run had not completed: A stands, with its own commit and time');
  assert.equal(obs.standing('test', iso(56)).result, 'failed');
  assert.equal(obs.standing('test', iso(66)).run, 2, 'a tree that never landed is no observation');
  assert.equal(obs.standing('test', iso(80)).commit, 'h4', "a default-branch push run is one, of its head");
  assert.deepEqual(obs.of('test').map((x) => x.run), [1, 2, 4]);
});

test('the activity listing: the four types that move a branch, newest first, page by page until older than `since`', async () => {
  const items = [
    { id: 5, activity_type: 'pr_merge', before: 'b4', after: 'a5', ref: 'refs/heads/main', timestamp: '2026-11-19T10:00:00Z' },
    { id: 4, activity_type: 'branch_creation', before: '0'.repeat(40), after: 'a4', ref: 'refs/heads/main', timestamp: '2026-11-19T09:00:00Z' },
    { id: 3, activity_type: 'force_push', before: 'b3', after: 'a3', ref: 'refs/heads/main', timestamp: '2026-11-18T10:00:00Z' },
    { id: 2, activity_type: 'push', before: 'b2', after: 'a2', ref: 'refs/heads/main', timestamp: '2026-11-17T10:00:00Z' },
    { id: 1, activity_type: 'merge_queue_merge', before: 'b1', after: 'a1', ref: 'refs/heads/main', timestamp: '2026-11-10T10:00:00Z' },
  ];
  const asked = [];
  const fetchImpl = async (href) => {
    const url = new URL(href);
    asked.push(url.search);
    const after = Number(url.searchParams.get('after') ?? 0);
    const page = items.slice(after, after + 2);
    const next = after + 2 < items.length ? `<https://api.github.com/repositories/1/activity?after=${after + 2}>; rel="next"` : null;
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json', ...(next ? { link: next } : {}) } });
  };
  const gh = createGitHub('t', { fetchImpl });
  const events = await listActivity(gh, 'o/r', 'main', { since: '2026-11-15T00:00:00Z' });
  assert.deepEqual(events, [
    { id: 5, type: 'pr_merge', before: 'b4', after: 'a5', at: '2026-11-19T10:00:00Z' },
    { id: 3, type: 'force_push', before: 'b3', after: 'a3', at: '2026-11-18T10:00:00Z' },
    { id: 2, type: 'push', before: 'b2', after: 'a2', at: '2026-11-17T10:00:00Z' },
  ]);
  assert.equal(asked.length, 3, 'the third page holds one older than since, and the listing stops there');
  assert.match(asked[0], /ref=refs%2Fheads%2Fmain/);
});

test("the pull request a tip's message names: a merge, a merge whose subject was set, a squash; none in another's text", () => {
  assert.equal(prOfMessage('Merge pull request #532 from SSFSKIM/stable-charge\n\nbody'), 532);
  assert.equal(prOfMessage('Merge pull request #509: sminos 1.48.0: the CLI on a session\'s PATH'), 509);
  assert.equal(prOfMessage('macOS engine: a field keeps its handle (#398) (#430)'), 430);
  assert.equal(prOfMessage('a direct push naming #12 in passing'), null);
  assert.equal(prOfMessage('subject\n\nMerge pull request #7 from o/x'), null);
});
