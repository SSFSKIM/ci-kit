// The gate ledger's job lines (gate ledger spec, "A job line" and Glossary "Gate attempt", "Scope", "Lane"): pure
// functions over a run, its attempt's jobs and the repository's entry in history/repos.json. The rerun listings are
// GitHub's own (fixtures/rerun-listings.json: four real failed-jobs reruns, their job names, ids, times and runners
// only), so a change in how GitHub lists a carried-over job fails here rather than doubling minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { annotationKind, comparable, copiedFrom, filingTime, gateAttempts, gateOf, isCopy, jobLine, laneOf, logKinds, phaseOf, platformKind, runFacts, scopeOf, trailersOf } from '../../history/jobs.mjs';

const repos = JSON.parse(readFileSync(new URL('../../history/repos.json', import.meta.url), 'utf8'));
const entry = (alias) => repos.find((r) => r.alias === alias);
const MAWS = entry('SSFSKIM/MAWS');
const KIT = entry('SSFSKIM/ci-kit');
const DOPER = entry('SSFSKIM/doperpowers');
const listings = JSON.parse(readFileSync(new URL('./fixtures/rerun-listings.json', import.meta.url), 'utf8'));
const listing = (repo) => listings.find((l) => l.repo === repo);

test("platform messages are named by kind only when they are the platform's own, whole", () => {
  // GitHub's own texts, as its annotations give them (cua, doperpowers, MAWS, 2026-10/11).
  assert.equal(platformKind('The job was not started because your account is locked due to a billing issue.'), 'not-started');
  assert.equal(platformKind('The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the \'Billing & plans\' section in your settings'), 'not-started');
  assert.equal(platformKind('The self-hosted runner: ci-kit-gce-a1 lost communication with the server. Verify the machine is running and has a healthy network connection.'), 'runner-lost');
  assert.equal(platformKind('The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.'), 'runner-lost');
  assert.equal(platformKind('The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.'), 'runner-lost');
  assert.equal(platformKind('The job has exceeded the maximum execution time of 15m0s'), 'time-limit');
  assert.equal(platformKind('The job running on runner ci-kit-gce-a1 has exceeded the maximum execution time of 30 minutes.'), 'time-limit');
  // Not the platform's: its words inside something else, or a message too vague to name a cause.
  assert.equal(platformKind('AssertionError: expected "The runner has received a shutdown signal." to be logged'), null);
  assert.equal(platformKind('test said: the job was not started because the fixture was missing'), null);
  // `not-started` is the billing refusal only.
  assert.equal(platformKind('The job was not started because a dependency failed.'), null);
  assert.equal(platformKind('The operation was canceled.'), null);
  assert.equal(platformKind('Process completed with exit code 1.'), null);
  assert.equal(platformKind(undefined), null);
});

test('an annotation is the platform\'s only at the workflow, not at a file a test reported', () => {
  const lost = 'The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.';
  assert.equal(annotationKind({ path: '.github', annotation_level: 'failure', message: lost }), 'runner-lost');
  assert.equal(annotationKind({ path: 'src/runner.test.ts', annotation_level: 'failure', message: lost }), null);
  assert.equal(annotationKind({ path: '.github', annotation_level: 'failure', message: 'The operation was canceled.' }), null);
});

test("a log's kinds come from the runner's own error lines, never from a step's output", () => {
  const log = [
    '2026-11-12T10:00:00.0000000Z ##[group]Run pytest',
    '2026-11-12T10:01:00.0000000Z E   AssertionError: The runner has received a shutdown signal. This can happen when the runner service is stopped',
    '2026-11-12T10:01:01.0000000Z The job running on runner x has exceeded the maximum execution time of 30 minutes.',
    '2026-11-12T10:02:00.0000000Z ##[error]Process completed with exit code 1.',
    '2026-11-12T10:03:00.0000000Z ##[error]The operation was canceled.',
  ].join('\n');
  assert.deepEqual(logKinds(log), []);
  // manim-master 42203224562's lost runner: the runner's own line, at the log's end.
  assert.deepEqual(logKinds(`${log}\n2026-11-12T10:04:00.0000000Z ##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.\n`), ['runner-lost']);
  assert.deepEqual(logKinds('2026-11-12T10:04:00.0000000Z ##[error]The job running on runner GitHub Actions 1 has exceeded the maximum execution time of 30 minutes.'), ['time-limit']);
});

test('every served repository has the fields the ledger reads', () => {
  assert.deepEqual(repos.map((r) => r.alias).sort(), ['SSFSKIM/MAWS', 'SSFSKIM/ci-kit', 'SSFSKIM/cua', 'SSFSKIM/doperpowers', 'SSFSKIM/manim-master']);
  for (const r of repos) {
    for (const key of ['workflows', 'default_branch', 'token', 'job_prefix', 'control', 'parts', 'setup_steps', 'test_globs', 'path_policy', 'required', 'verdict_job', 'fallback_labels', 'vacuous', 'opaque_events', 'semantic_trailers']) {
      assert.ok(key in r, `${r.alias} has ${key}`);
    }
    assert.ok(['app', 'actions'].includes(r.token));
    for (const p of r.setup_steps) new RegExp(p); // each compiles
  }
  // The two public repositories the App is not installed on are read with the run's own token.
  assert.deepEqual(repos.filter((r) => r.token === 'actions').map((r) => r.alias).sort(), ['SSFSKIM/cua', 'SSFSKIM/doperpowers']);
});

test('a job name folds to its gate: shards, prefixes, control jobs, summary parts, copies and overflows', () => {
  assert.deepEqual(gateOf('unit 3/4', MAWS), { gate: 'unit', shard: [3, 4], kind: 'gate', variant: null });
  assert.deepEqual(gateOf('unit', MAWS), { gate: 'unit', shard: null, kind: 'gate', variant: null });
  assert.deepEqual(gateOf('e2e:desk-web', MAWS), { gate: 'e2e:desk-web', shard: null, kind: 'gate', variant: null });
  assert.deepEqual(gateOf('plan', MAWS), { gate: null, shard: null, kind: 'control', variant: null });
  assert.deepEqual(gateOf('e2e-build (harness)', MAWS), { gate: null, shard: null, kind: 'control', variant: null });
  // MAWS's hosted `static` is the gate's result; its parts carry its cost.
  assert.deepEqual(gateOf('static', MAWS), { gate: 'static', shard: null, kind: 'gate', variant: null });
  assert.deepEqual(gateOf('static-local', MAWS), { gate: 'static', shard: null, kind: 'gate', variant: null });
  assert.deepEqual(gateOf('static / lint', MAWS), { gate: 'static', shard: null, kind: 'gate', variant: null });
  assert.deepEqual(gateOf('e2e:panel (mini copy)', MAWS), { gate: 'e2e:panel', shard: null, kind: 'gate', variant: 'mini-copy' });
  assert.deepEqual(gateOf('e2e:panel (EC2 overflow)', MAWS), { gate: 'e2e:panel', shard: null, kind: 'gate', variant: 'ec2-overflow' });
  assert.deepEqual(gateOf('e2e:panel (mini overflow)', MAWS), { gate: 'e2e:panel', shard: null, kind: 'gate', variant: 'mini-overflow' });
  // A bundled copy is one job with one result: a gate of its own, never split into groups it cannot tell apart.
  assert.deepEqual(gateOf('e2e: mini copy (remote, code)', MAWS), { gate: 'e2e:code+remote', shard: null, kind: 'gate', variant: 'mini-copy' });
  // A name GitHub left unexpanded (a job that never got its matrix) is no gate.
  assert.equal(gateOf('e2e:${{ matrix.group }}', MAWS).kind, 'control');
  assert.deepEqual(gateOf('ci / test', KIT), { gate: 'test', shard: null, kind: 'gate', variant: null });
  assert.deepEqual(gateOf('ci / plan', KIT), { gate: null, shard: null, kind: 'control', variant: null });
  assert.deepEqual(gateOf('ci / verdict', KIT).kind, 'control');
  assert.deepEqual(gateOf('ci / package cache', KIT).kind, 'control');
  assert.deepEqual(gateOf('ci / mods-types', DOPER).gate, 'mods-types');
});

test('a lane is read from the runner and the labels, and never guessed', () => {
  const job = (runner_name, labels) => ({ runner_name, labels });
  assert.equal(laneOf(job('ci-kit-gce-ht8psek6d8', ['self-hosted', 'ci-kit-pool', 'cpus-8'])), 'pool-gce');
  assert.equal(laneOf(job('ci-kit-ec2-a1b2c3', ['self-hosted', 'ci-kit-pool', 'cpus-8'])), 'pool-ec2');
  assert.equal(laneOf(job('ci-kit-pool-170701310-9', ['self-hosted', 'ci-kit-pool'])), 'pool-hetzner');
  assert.equal(laneOf(job('ci-kit-mac-mini', ['self-hosted', 'ci-kit-mac'])), 'mini-host');
  assert.equal(laneOf(job('ci-kit-mac-mini-2', ['ci-kit-mac-shared'])), 'mini-host');
  assert.equal(laneOf(job('ci-kit-mac-mini-maws-vm-job-1-20261119T054617Z', ['ci-kit-mac-solo'])), 'mini-guest');
  assert.equal(laneOf(job('GitHub Actions 1000061510', ['ubuntu-24.04'])), 'hosted-linux');
  assert.equal(laneOf(job('GitHub Actions 1000061506', ['macos-26'])), 'hosted-macos');
  assert.equal(laneOf(job('GitHub Actions 1000056399', ['macos-latest'])), 'hosted-macos');
  // A job that never started has no runner: its labels say where it was asked to run, when they say it.
  assert.equal(laneOf(job(null, ['ubuntu-latest'])), 'hosted-linux');
  assert.equal(laneOf(job(null, ['macos-latest'])), 'hosted-macos');
  assert.equal(laneOf(job(null, ['self-hosted', 'ci-kit-pool', 'cpus-4'])), null); // GCE or EC2: not known
  assert.equal(laneOf(job('some-other-runner', ['self-hosted'])), null);
});

test('phase says where a job stopped: setup, test, post, or lost when no step says', () => {
  const steps = (...list) => list.map(([name, conclusion]) => ({ name, status: conclusion ? 'completed' : 'in_progress', conclusion }));
  const job = (conclusion, s) => ({ conclusion, steps: s });
  assert.deepEqual(phaseOf(job('success', steps(['Set up job', 'success'], ['Run pnpm test', 'success'])), MAWS), { failed_step: null, phase: null });
  assert.deepEqual(phaseOf(job('failure', steps(['Set up job', 'success'], ['Run ./.github/actions/setup', 'failure'])), MAWS), { failed_step: 'Run ./.github/actions/setup', phase: 'setup' });
  assert.deepEqual(phaseOf(job('failure', steps(['Set up job', 'success'], ['Run ./.github/actions/setup', 'success'], ['Run .github/scripts/gate-run.sh x pnpm test', 'failure'])), MAWS), { failed_step: 'Run .github/scripts/gate-run.sh x pnpm test', phase: 'test' });
  assert.deepEqual(phaseOf(job('failure', steps(['Set up job', 'success'], ['Run pnpm test', 'success'], ['Post Run actions/checkout@v7', 'failure'])), MAWS), { failed_step: 'Post Run actions/checkout@v7', phase: 'post' });
  // MAWS 44468141412's first static-local: its runner was lost in a step that never concluded.
  assert.deepEqual(phaseOf(job('failure', steps(['Set up job', 'success'], ['Run actions/checkout@v7', 'success'], ['Run ./.github/actions/setup', 'success'], ['Run bg start', null])), MAWS), { failed_step: null, phase: 'lost' });
  // A job refused before it started has no steps at all.
  assert.deepEqual(phaseOf(job('failure', []), KIT), { failed_step: null, phase: 'lost' });
  // A cancelled step is where a cancelled job stopped.
  assert.deepEqual(phaseOf(job('cancelled', steps(['Set up job', 'success'], ['Check out', 'success'], ['Install', 'cancelled'])), KIT), { failed_step: 'Install', phase: 'setup' });
  assert.deepEqual(phaseOf(job('cancelled', steps(['Set up job', 'success'], ['Run test', 'cancelled'])), KIT), { failed_step: 'Run test', phase: 'test' });
});

test('trailers are read from the head message, the last paragraph of key: value lines', () => {
  const msg = 'ci-gate: 55f4887de\n\nNonce: 1763-42\nGates: static,unit\nRunner: macos\nAffected: a\nAffected: b\nBacklog: hosted=3';
  assert.deepEqual(trailersOf(msg), { Nonce: ['1763-42'], Gates: ['static,unit'], Runner: ['macos'], Affected: ['a', 'b'], Backlog: ['hosted=3'] });
  assert.deepEqual(trailersOf('ci-gate 0123456789ab\n\nCI-Gates: test\n'), { 'CI-Gates': ['test'] });
  assert.deepEqual(trailersOf('a plain commit'), {});
  assert.deepEqual(trailersOf(null), {});
});

test('scope and scope key: selection, vacuous and opaque events, and only the semantic trailers', () => {
  const run = (event, message) => ({ event, head_commit: { message } });
  const base = 'ci-gate: x\n\nNonce: 1-1\nGates: unit\nRunner: linux';
  const a = scopeOf(run('push', base), 'unit', null, MAWS);
  assert.equal(a.scope, 'full');
  // A different nonce and a backlog snapshot change nothing that decides what ran or where.
  assert.equal(scopeOf(run('push', 'ci-gate: x\n\nNonce: 2-9\nGates: unit\nRunner: linux\nBacklog: hosted=4\nPool-Demand: 3'), 'unit', null, MAWS).scope_key, a.scope_key);
  // Another runner does.
  assert.notEqual(scopeOf(run('push', 'ci-gate: x\n\nNonce: 1-1\nGates: unit\nRunner: macos'), 'unit', null, MAWS).scope_key, a.scope_key);
  // A selected run, whether or not selection fell back to the whole suite.
  const sel = scopeOf(run('push', `${base}\nSelection: affected\nAffected-Count: 1\nAffected: src/a.ts`), 'unit', null, MAWS);
  assert.equal(sel.scope, 'selected');
  assert.notEqual(sel.scope_key, a.scope_key);
  // A mini copy is an attempt apart from its direct job.
  assert.notEqual(scopeOf(run('push', base), 'e2e:panel', 'mini-copy', MAWS).scope_key, scopeOf(run('push', base), 'e2e:panel', null, MAWS).scope_key);
  // doperpowers' version-bump on a dispatch compares with nothing.
  assert.equal(scopeOf(run('workflow_dispatch', 'x'), 'version-bump', null, DOPER).scope, 'narrowed');
  assert.equal(scopeOf(run('workflow_dispatch', 'x'), 'sminos', null, DOPER).scope, 'full');
  assert.equal(scopeOf(run('pull_request', 'x'), 'version-bump', null, DOPER).scope, 'full');
  // A MAWS dispatch's inputs (runner, lane, live) are not in the record.
  assert.equal(scopeOf(run('workflow_dispatch', 'x'), 'unit', null, MAWS).scope, 'unknown');
});

test('comparable: same gate and scope key, neither unknown', () => {
  const at = (gate, scope, scope_key) => ({ gate, scope, scope_key });
  assert.equal(comparable(at('unit', 'full', 'k1'), at('unit', 'full', 'k1')), true);
  assert.equal(comparable(at('unit', 'full', 'k1'), at('unit', 'full', 'k2')), false);
  assert.equal(comparable(at('unit', 'full', 'k1'), at('probes', 'full', 'k1')), false);
  assert.equal(comparable(at('unit', 'unknown', 'k1'), at('unit', 'unknown', 'k1')), false);
});

test('a copy is a job that completed before it was created, in every real rerun listing', () => {
  // GitHub gives every job of a failed-jobs rerun the new attempt's number and a new id (the preflight).
  for (const l of listings) {
    const [earlier, later] = Object.keys(l.attempts).map(Number).sort((a, b) => a - b);
    const ids = new Set(l.attempts[earlier].map((j) => j.id));
    for (const j of l.attempts[later]) {
      assert.equal(j.run_attempt, later, `${l.repo} ${j.name}`);
      assert.ok(!ids.has(j.id), `${l.repo} ${j.name} has a new id`);
    }
  }
  const copies = (repo, attempt) => listing(repo).attempts[attempt].filter((j) => j.conclusion !== 'skipped' && isCopy(j, attempt)).map((j) => j.name).sort();
  assert.deepEqual(copies('SSFSKIM/MAWS', 2), ['e2e:cross-build', 'plan', 'probes', 'unit 1/4', 'unit 2/4', 'unit 3/4', 'unit 4/4']);
  assert.deepEqual(copies('SSFSKIM/MAWS', 1), []);
  assert.deepEqual(copies('SSFSKIM/manim-master', 2), ['ci / forge', 'ci / forge-arachne', 'ci / pipeline', 'ci / plan']);
  assert.deepEqual(copies('SSFSKIM/ci-kit', 2), ['ci / plan']);
  assert.deepEqual(copies('SSFSKIM/cua', 3), ['ci / plan']);
  assert.deepEqual(copies('SSFSKIM/cua', 2), ['ci / plan']);
  // Nothing in a first attempt is a copy, whatever its times say: GitHub stamped jobs of 2026-11-01 09:00Z (the hour
  // US clocks fell back) as completed before they were created or started (MAWS 41290983632's unit shards).
  const dst = { created_at: '2026-11-01T09:57:40Z', started_at: '2026-11-01T09:57:50Z', completed_at: '2026-11-01T09:00:53Z' };
  assert.equal(isCopy(dst, 1), false);
  assert.equal(isCopy({ ...dst, created_at: '2026-11-01T09:58:00Z' }, 2), true);
});

test('copied_from is the latest earlier attempt whose job of that name is not itself a copy', () => {
  const of = (repo) => (k) => listing(repo).attempts[k] ?? null;
  assert.equal(copiedFrom('unit 2/4', 2, of('SSFSKIM/MAWS')), 1);
  // cua 43756962006: attempt 3's plan copies attempt 2's, itself a copy of attempt 1's.
  assert.equal(copiedFrom('ci / plan', 3, of('SSFSKIM/cua')), 1);
  // An earlier listing that lacks the job is walked past, down to the attempt that ran it.
  const ran = { id: 1, name: 'ci / test', created_at: '2026-11-01T10:00:00Z', completed_at: '2026-11-01T10:05:00Z' };
  assert.equal(copiedFrom('ci / test', 3, (k) => ({ 2: [], 1: [ran] })[k]), 1);
  // No earlier attempt ran it: the origin cannot be told.
  assert.equal(copiedFrom('ci / test', 3, (k) => ({ 2: [], 1: [] })[k]), null);
  // Every earlier listing is needed, attempt 1's too.
  assert.throws(() => copiedFrom('ci / plan', 2, () => null), /attempt 1's jobs are needed/);
});

test('a job line: the fields, a copy without minutes, and the platform kinds only', () => {
  const run = {
    id: 44486328066, run_attempt: 1, name: 'gate', path: '.github/workflows/gate.yml', event: 'push', head_branch: 'ci/pwdeps-55f4887d',
    head_sha: 'a'.repeat(40), head_commit: { tree_id: 't'.repeat(40), message: 'ci-gate: 55f4887d\n\nNonce: 1-1\nGates: static,unit,probes,e2e:desk-web' },
    pull_requests: [], status: 'completed', conclusion: 'success', created_at: '2026-11-19T08:17:20Z',
  };
  const facts = runFacts(run, 1, { tested: '55f4887d'.padEnd(40, '0'), treeKey: 't'.repeat(40) }, MAWS);
  assert.equal(facts.producer, 'maws-ci-gate');
  assert.equal(facts.label, 'pwdeps');
  assert.equal(facts.change, 'maws-ci-gate:pwdeps');
  assert.equal(facts.basis, 'exact');
  const job = { id: 135000000001, name: 'e2e:desk-web', run_attempt: 1, status: 'completed', conclusion: 'success', created_at: '2026-11-19T08:17:40Z', started_at: '2026-11-19T08:18:10Z', completed_at: '2026-11-19T08:25:45Z', runner_name: 'ci-kit-gce-x1', labels: ['self-hosted', 'ci-kit-pool', 'cpus-4'], steps: [] };
  const line = jobLine(facts, job, { copied_from: null, annotations: [] }, MAWS);
  assert.deepEqual(Object.keys(line), ['v', 'run', 'attempt', 'workflow', 'event', 'ref', 'producer', 'label', 'change', 'gates', 'scope', 'scope_key', 'head', 'tested', 'tree', 'tree_key', 'basis', 'job_id', 'job', 'gate', 'shard', 'kind', 'role', 'copy', 'copied_from', 'lane', 'runner', 'started', 'completed', 'minutes', 'conclusion', 'run_conclusion', 'failed_step', 'phase', 'annotations', 'log_kinds']);
  assert.equal(line.minutes, 7.6);
  assert.equal(line.lane, 'pool-gce');
  assert.equal(line.gates, 'static,unit,probes,e2e:desk-web');
  assert.equal(line.tree, 't'.repeat(40));
  // A job cancelled while queued spans the queue, not a run: it has no runner and no minutes.
  assert.equal(jobLine(facts, { ...job, runner_name: null, conclusion: 'cancelled' }, { copied_from: null, annotations: [] }, MAWS).minutes, 0);
  assert.equal(line.copy, false);
  assert.equal(line.role, null);
  const rerun = runFacts({ ...run, run_attempt: 2 }, 2, { tested: '55f4887d'.padEnd(40, '0'), treeKey: 't'.repeat(40) }, MAWS);
  const copy = jobLine(rerun, { ...job, id: 135000000002, created_at: '2026-11-19T09:00:00Z' }, { copied_from: 1, annotations: [] }, MAWS);
  assert.equal(copy.copied_from, 1);
  assert.equal(copy.copy, true);
  assert.equal(copy.minutes, null);
  // A copy whose origin cannot be told is still a copy, and bills nothing.
  const orphan = jobLine(rerun, { ...job, id: 135000000003, created_at: '2026-11-19T09:00:00Z' }, { copied_from: null, annotations: [] }, MAWS);
  assert.deepEqual([orphan.copy, orphan.copied_from, orphan.minutes], [true, null, null]);
  // MAWS's hosted static is its gate's summary; its parts are not.
  assert.equal(jobLine(facts, { ...job, name: 'static' }, { copied_from: null, annotations: [] }, MAWS).role, 'summary');
  assert.equal(jobLine(facts, { ...job, name: 'static-local' }, { copied_from: null, annotations: [] }, MAWS).role, null);
  // A pull request run tested GitHub's merge: the head's tree is known, the tested tree is not.
  const pr = runFacts({ ...run, event: 'pull_request', head_branch: 'feature', pull_requests: [{ number: 481 }] }, 1, { tested: null, treeKey: null }, DOPER);
  assert.equal(pr.basis, 'pr-merge');
  assert.equal(pr.change, 'pr:481');
  const prLine = jobLine(pr, { ...job, name: 'ci / mods-types' }, { copied_from: null, annotations: ['time-limit'] }, DOPER);
  assert.equal(prLine.tree, null);
  assert.equal(prLine.head_tree, 't'.repeat(40));
  assert.deepEqual(prLine.annotations, ['time-limit']);
  assert.deepEqual(prLine.log_kinds, []);
  // A kind read from a log is kept apart from the annotations' (M3 counts it only beside the job's own evidence).
  const logged = jobLine(pr, { ...job, name: 'ci / mods-types', conclusion: 'failure' }, { copied_from: null, annotations: [], log_kinds: ['runner-lost'] }, DOPER);
  assert.deepEqual([logged.annotations, logged.log_kinds], [[], ['runner-lost']]);
  // `not-started` stands only on a job that never started: no runner, no step that ran.
  const refused = { ...job, runner_name: null, started_at: job.created_at, steps: [], conclusion: 'failure' };
  assert.deepEqual(jobLine(facts, refused, { copied_from: null, annotations: ['not-started'] }, MAWS).annotations, ['not-started']);
  assert.deepEqual(jobLine(facts, { ...refused, runner_name: 'ci-kit-gce-x1' }, { copied_from: null, annotations: ['not-started'] }, MAWS).annotations, []);
  assert.deepEqual(jobLine(facts, { ...refused, steps: [{ name: 'Set up job', conclusion: 'success' }] }, { copied_from: null, annotations: [], log_kinds: ['not-started'] }, MAWS).log_kinds, []);
  // A branch's run without a pull request is the branch's change; a fallback label is no change.
  assert.equal(runFacts({ ...run, event: 'pull_request', head_branch: 'feature', pull_requests: [] }, 1, { tested: null, treeKey: null }, DOPER).change, 'branch:feature');
  const gate = runFacts({ ...run, head_branch: 'ci/gate-0123abcd-ab12cd' }, 1, { tested: '0123abcd'.padEnd(40, '0'), treeKey: 't'.repeat(40) }, KIT);
  assert.equal(gate.producer, 'ci-kit-ci-gate');
  assert.equal(gate.change, null);
  // A head whose parent is not the commit its ref names tested its own head and has no change.
  const other = runFacts(run, 1, { tested: null, treeKey: 't'.repeat(40) }, MAWS);
  assert.equal(other.producer, 'other');
  assert.equal(other.change, null);
  assert.equal(other.tested, run.head_sha);
});

// Job lines of one attempt, shaped as the collector writes them.
let nextId = 1;
const lineOf = (over) => ({ run: 1, attempt: 1, gate: 'unit', kind: 'gate', shard: null, role: null, scope: 'full', scope_key: 'k', basis: 'exact', tree: 't1', tree_key: 't1', head: 'h', tested: 'h', change: 'c', event: 'push', ref: 'ci/x', workflow: 'gate', copy: false, copied_from: null, conclusion: 'success', started: '2026-11-19T08:00:00Z', completed: '2026-11-19T08:05:00Z', minutes: 5, lane: 'pool-gce', run_conclusion: 'success', job_id: nextId++, ...over });

test('a gate attempt folds its shards: four green, one missing, and one red beside three green', () => {
  const shards = (conclusions) => conclusions.map((c, i) => lineOf({ job: `unit ${i + 1}/4`, shard: [i + 1, 4], conclusion: c, job_id: i + 1 }));
  const [green] = gateAttempts(shards(['success', 'success', 'success', 'success']));
  assert.equal(green.result, 'succeeded');
  assert.equal(green.minutes, 20);
  const [missing] = gateAttempts(shards(['success', 'success', 'success', 'success']).slice(0, 3));
  assert.equal(missing.result, 'incomplete');
  // MAWS 39962530337 attempt 1's shape: unit 2/4 failed and the other three passed after it.
  const red = shards(['success', 'failure', 'success', 'success']).map((l, i) => ({ ...l, completed: `2026-11-19T08:0${i === 1 ? 2 : 6}:00Z` }));
  const attempts = gateAttempts(red);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].result, 'failed');
  assert.equal(attempts[0].completed, '2026-11-19T08:06:00Z');
  // One red shard beside a missing one is failed, not incomplete.
  assert.equal(gateAttempts(red.filter((l) => l.shard[0] !== 4))[0].result, 'failed');
});

test('a gate attempt whose shards announce more than one count is never succeeded', () => {
  const mixed = [[1, 2], [2, 2], [3, 3]].map(([k, n]) => lineOf({ job: `unit ${k}/${n}`, shard: [k, n] }));
  const [a] = gateAttempts(mixed);
  assert.equal(a.result, 'incomplete');
  assert.equal(a.shards, null);
  // An unsharded job beside shards is two forms too; a red one is failed whatever else is wrong.
  assert.equal(gateAttempts([lineOf({ job: 'unit' }), lineOf({ job: 'unit 1/1', shard: [1, 1] })])[0].result, 'incomplete');
  assert.equal(gateAttempts([...mixed, lineOf({ job: 'unit 3/3', shard: [3, 3], conclusion: 'failure' })])[0].result, 'failed');
});

test('a gate attempt: copies count toward the result and not the minutes; control jobs and variants stay apart', () => {
  const lines = [
    lineOf({ attempt: 2, job: 'unit 1/2', shard: [1, 2], copy: true, copied_from: 1, minutes: null }),
    lineOf({ attempt: 2, job: 'unit 2/2', shard: [2, 2], minutes: 4 }),
    lineOf({ attempt: 2, job: 'plan', gate: null, kind: 'control', minutes: 0.2 }),
    lineOf({ attempt: 2, job: 'e2e:panel', gate: 'e2e:panel', scope_key: 'direct' }),
    lineOf({ attempt: 2, job: 'e2e:panel (mini copy)', gate: 'e2e:panel', scope_key: 'copy', conclusion: 'failure' }),
  ];
  const attempts = gateAttempts(lines);
  const unit = attempts.find((a) => a.gate === 'unit');
  assert.equal(unit.result, 'succeeded');
  assert.equal(unit.minutes, 4);
  assert.equal(attempts.filter((a) => a.gate === 'e2e:panel').length, 2);
  assert.equal(attempts.find((a) => a.scope_key === 'copy').result, 'failed');
  assert.equal(attempts.find((a) => a.scope_key === 'direct').result, 'succeeded');
  assert.ok(!attempts.some((a) => a.gate === null));
  // A copied shard's success is its earlier attempt's, never a later pass of anything.
  assert.deepEqual(unit.copies, [1]);
  assert.equal(unit.copied, false, 'unit 2/2 ran in this attempt');
});

test('a gate attempt made only of copies is no new execution, and its result is available when its fresh jobs completed', () => {
  // A rerun whose fresh shard completed a day after the copies' own times.
  const lines = [
    lineOf({ attempt: 2, job: 'unit 1/2', shard: [1, 2], copy: true, copied_from: 1, minutes: null, started: '2026-11-18T23:00:00Z', completed: '2026-11-18T23:10:00Z' }),
    lineOf({ attempt: 2, job: 'unit 2/2', shard: [2, 2], minutes: 6, started: '2026-11-19T09:00:00Z', completed: '2026-11-19T09:06:00Z' }),
    lineOf({ attempt: 2, job: 'probes', gate: 'probes', copy: true, copied_from: 1, minutes: null, completed: '2026-11-18T23:02:00Z' }),
  ];
  const attempts = gateAttempts(lines);
  const unit = attempts.find((a) => a.gate === 'unit');
  assert.equal(unit.copied, false);
  assert.equal(unit.available, '2026-11-19T09:06:00Z');
  assert.equal(unit.completed, '2026-11-19T09:06:00Z');
  assert.equal(unit.started, '2026-11-18T23:00:00Z', "the shards' physical times stay");
  const probes = attempts.find((a) => a.gate === 'probes');
  assert.equal(probes.copied, true);
  assert.equal(probes.available, null);
  // A copy is filed when its own gate's result became available, so a window that holds the gate's fresh jobs holds
  // its copies; a gate of copies only, by its copies' latest time.
  assert.equal(filingTime(lines, lines[0]), '2026-11-19T09:06:00Z');
  assert.equal(filingTime(lines, lines[2]), '2026-11-18T23:02:00Z');
  // A job of another gate finishing after midnight moves no copy of this one.
  const late = lineOf({ attempt: 2, job: 'e2e:desk-web', gate: 'e2e:desk-web', minutes: 30, completed: '2026-11-20T00:20:00Z' });
  assert.equal(filingTime([...lines, late], lines[0]), '2026-11-19T09:06:00Z');
  // Another scope of the same gate is another gate attempt.
  const other = lineOf({ attempt: 2, job: 'unit 2/2 (mini copy)', shard: [2, 2], scope_key: 'other', completed: '2026-11-20T00:30:00Z' });
  assert.equal(filingTime([...lines, other], lines[0]), '2026-11-19T09:06:00Z');
});

test('a gate attempt with summary parts: the parts carry the minutes and lanes, and a failed part or summary fails it', () => {
  const lines = [
    lineOf({ job: 'static-local', gate: 'static', conclusion: 'success', minutes: 10 }),
    lineOf({ job: 'static', gate: 'static', role: 'summary', conclusion: 'failure', minutes: 0.1, lane: 'hosted-linux' }),
  ];
  const [a] = gateAttempts(lines);
  assert.equal(a.result, 'failed');
  assert.equal(a.minutes, 10);
  assert.deepEqual(a.lanes, ['pool-gce']);
  assert.equal(a.tree_key, 't1');
  assert.equal(a.basis, 'exact');
});
