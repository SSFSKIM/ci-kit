// Zero mutations of other work's resources, on every path that deletes or labels (spec M5: the guard, the watchdog,
// the bake cleanup and ensure leave a resource without a ci-kit= label untouched, even when it matches by name or
// type). Each test runs the real entry path against the shared foreign fixture (fake-hcloud.mjs FOREIGN): an
// unlabelled server, an unlabelled server named ci-kit-pool, a server named like a builder with someone else's
// label, an unlabelled firewall named ci-kit-pool, an unlabelled snapshot, and one carrying only a run-id label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHcloud, foreignTouched, FOREIGN } from './fake-hcloud.mjs';
import { ensure } from '../../pool/lib/ensure.mjs';
import { runGuard } from '../../pool/guard.mjs';
import { runWatchdog } from '../../pool/agent/watchdog.mjs';
import { cleanup, snapshotBuilder } from '../../pool/bake/bake.mjs';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const loc = (name) => ({ name, available: true });
const TYPES = [{ name: 'cpx62', locations: [loc('hel1')] }, { name: 'cpx52', locations: [loc('hel1')] }];
const CFG = {
  repos: [{ repo: 'SSFSKIM/ci-kit-sandbox', workflows: ['ci.yml'] }], types: ['cpx62'], fallback_types: ['cpx52'], locations: ['hel1'],
  poll_seconds: 10, idle_runner_minutes: 10, drain_minute: 50, memory_gb_per_cpu: 2, max_hours_per_day: 8,
  ledger: { repo: 'SSFSKIM/ci-kit-sandbox', issue_title: 'pool ledger' },
};
const OURS = {
  image: { id: 301, type: 'snapshot', status: 'available', labels: { 'ci-kit': 'pool-image' }, created: '2026-10-15T20:00:00Z' },
  firewall: { id: 401, name: 'ci-kit-pool', labels: { 'ci-kit': 'pool' } },
};
const opts = { sleep: async () => {}, now: () => NOW, log: () => {} };
const quiet = { log: () => {} };

function fakeGitHub({ queuedAgoMin = 30 } = {}) {
  const comments = [];
  let id = 1;
  return {
    runsByStatus: async (_r, status) => (status === 'in_progress' ? [{ id: 5, status, path: '.github/workflows/ci.yml' }] : []),
    listJobs: async () => [{ id: 9, status: 'queued', labels: ['self-hosted', 'ci-kit-pool', 'cpus-4'], created_at: new Date(NOW - queuedAgoMin * 60_000).toISOString() }],
    openIssues: async () => [{ number: 1, title: 'pool ledger' }],
    issueComments: async () => comments.map((c) => ({ ...c })),
    createComment: async (_r, _n, body) => { comments.push({ id: id++, body }); },
    updateComment: async (_r, cid, body) => { comments.find((c) => c.id === cid).body = body; },
    deleteComment: async () => {},
    ensureLabel: async () => {},
    createIssue: async () => ({ number: 2 }),
  };
}

test('ensure, creating a box, uses only the kit\'s snapshot and firewall and touches nothing foreign', async () => {
  const hc = fakeHcloud({ images: [OURS.image], firewalls: [OURS.firewall], serverTypes: TYPES });
  assert.equal(await ensure(hc, CFG, opts), 'created:cpx62@hel1');
  assert.deepEqual(foreignTouched(hc), []);
});

test('ensure with no firewall of its own, where a foreign one holds the name, fails without touching or using it', async () => {
  const hc = fakeHcloud({ images: [OURS.image], serverTypes: TYPES, strict: true });
  await assert.rejects(ensure(hc, CFG, opts), /firewall named ci-kit-pool exists without the ci-kit=pool label/);
  assert.deepEqual(foreignTouched(hc), []);
  assert.ok(!hc.mutations.some((m) => m.op === 'create server'));
});

test('ensure where a foreign server holds the name ci-kit-pool fails, and neither deletes nor labels it', async () => {
  const hc = fakeHcloud({ images: [OURS.image], firewalls: [OURS.firewall], serverTypes: TYPES, strict: true });
  await assert.rejects(ensure(hc, CFG, opts), /server named ci-kit-pool exists without the ci-kit=pool label/);
  assert.deepEqual(foreignTouched(hc), []);
});

test('a guard cycle over a project of old, heartbeat-less foreign servers deletes and labels none of them', async () => {
  for (const strict of [false, true]) {
    const hc = fakeHcloud({ images: [OURS.image], firewalls: [OURS.firewall], serverTypes: TYPES, strict });
    // A stranded pool job makes the guard run ensure too, so its create path is exercised as well.
    const failed = await runGuard({ hc, gh: fakeGitHub(), cfg: CFG, ...opts, error: () => {} });
    assert.deepEqual(foreignTouched(hc), [], `strict=${strict}`);
    assert.ok(!hc.mutations.some((m) => m.op === 'delete server' || m.op === 'label server'));
    // Unstrict, the wake creates the box; strict, the foreign ci-kit-pool server makes ensure fail, as it should.
    assert.equal(failed, strict ? 1 : 0);
  }
});

test('the watchdog, run on any foreign server however stale, neither deletes nor labels it; on a pool box it deletes only that box', async () => {
  for (const s of FOREIGN.servers) {
    const hc = fakeHcloud({});
    const verdict = await runWatchdog({ hc, serverId: s.id, lastSuccess: null, bootTime: NOW - 48 * 3600_000, now: () => NOW, writeRow: async () => {}, ...quiet });
    assert.equal(verdict, null);
    assert.deepEqual(hc.mutations, []);
  }
  const box = { id: 55, name: 'ci-kit-pool', labels: { 'ci-kit': 'pool' }, created: new Date(NOW - 2 * 3600_000).toISOString(), server_type: { name: 'cpx62', prices: [] }, location: { name: 'hel1' } };
  const hc = fakeHcloud({ servers: [box] });
  assert.equal(await runWatchdog({ hc, serverId: 55, lastSuccess: null, bootTime: NOW - 2 * 3600_000, now: () => NOW, writeRow: async () => {}, ...quiet }), 'watchdog');
  assert.deepEqual(hc.mutations, [{ op: 'delete server', server: 55 }]);
});

test('bake cleanup deletes its own run\'s builder and unfinished snapshot, and nothing foreign — not a builder-named server, not a snapshot carrying only the run id', async () => {
  const builder = { id: 60, name: 'ci-kit-builder-42', labels: { 'ci-kit': 'builder', 'ci-kit-run': '42' }, created: '2026-10-16T11:00:00Z' };
  const unfinished = { id: 302, type: 'snapshot', status: 'creating', labels: { 'ci-kit': 'pool-image', 'ci-kit-run': '42' }, created: '2026-10-16T11:30:00Z' };
  const hc = fakeHcloud({ servers: [builder], images: [OURS.image, unfinished] });
  await cleanup(hc, '42', quiet);
  assert.deepEqual(foreignTouched(hc), []);
  assert.deepEqual(hc.mutations, [{ op: 'delete server', server: 60 }, { op: 'delete image', image: 302 }]);
});

// The bake waits long enough for an operator to relabel its builder to keep the machine for debugging. From that
// moment the server is theirs: the bake neither labels, snapshots nor deletes it, and fails with a clear message.
const BUILDER_ID = 60;
const finishedBuilder = () => ({ id: BUILDER_ID, name: 'ci-kit-builder-42', status: 'off', created: '2026-10-16T11:00:00Z', labels: { 'ci-kit': 'builder', 'ci-kit-run': '42', 'ci-kit-bake': 'ok' } });
const onBuilder = (hc) => hc.mutations.filter((m) => m.server === BUILDER_ID);

// Runs the bake's wait/snapshot/delete against a builder; `mutate(hc, n, phase)` runs before the nth server fetch
// (the 6th is the one just before the snapshot: the 15 s polls pass the 60 s minimum at the 5th) or after the snapshot.
async function bakeWith(hc, mutate) {
  let t = 0;
  const server = hc.server;
  let fetches = 0;
  hc.server = async (id) => {
    mutate?.(hc, ++fetches, 'fetch');
    return server(id);
  };
  const createImage = hc.createImage;
  hc.createImage = async (...a) => {
    const r = await createImage(...a);
    mutate?.(hc, fetches, 'snapshotted');
    return r;
  };
  const sleep = async (ms) => { t += ms; };
  return snapshotBuilder(hc, { id: BUILDER_ID }, { sha: 'f'.repeat(40), runId: '42', sleep, now: () => t, log: () => {} });
}
const relabel = (hc, labels) => { hc.state.servers.find((s) => s.id === BUILDER_ID).labels = labels; };

test('bake: a builder that is still its own is snapshotted, then deleted', async () => {
  const hc = fakeHcloud({ servers: [finishedBuilder()] });
  await bakeWith(hc);
  assert.deepEqual(onBuilder(hc), [{ op: 'snapshot', server: BUILDER_ID }, { op: 'delete server', server: BUILDER_ID }]);
  assert.deepEqual(foreignTouched(hc), []);
});

test('bake: a builder whose ci-kit label is removed before the snapshot gets no snapshot, delete or label', async () => {
  const hc = fakeHcloud({ servers: [finishedBuilder()] });
  await assert.rejects(
    bakeWith(hc, (h, n) => n === 6 && relabel(h, { 'ci-kit-run': '42', 'ci-kit-bake': 'ok' })),
    /server 60 is no longer this bake's builder.*left untouched/);
  assert.deepEqual(onBuilder(hc), []);
  assert.ok(hc.state.servers.some((s) => s.id === BUILDER_ID));
});

test('bake: a builder replaced by someone else\'s labels (same ci-kit label, another run) is left untouched', async () => {
  const hc = fakeHcloud({ servers: [finishedBuilder()] });
  await assert.rejects(
    bakeWith(hc, (h, n) => n === 6 && relabel(h, { 'ci-kit': 'builder', 'ci-kit-run': '99', 'ci-kit-bake': 'ok' })),
    /no longer this bake's builder/);
  assert.deepEqual(onBuilder(hc), []);
});

test('bake: a builder relabelled while the bake waits for it is never snapshotted', async () => {
  const hc = fakeHcloud({ servers: [{ ...finishedBuilder(), status: 'running' }] });
  await assert.rejects(bakeWith(hc, (h, n) => n === 3 && relabel(h, { owner: 'me' })), /no longer this bake's builder/);
  assert.deepEqual(onBuilder(hc), []);
});

test('bake: a builder relabelled while its snapshot runs is not deleted', async () => {
  const hc = fakeHcloud({ servers: [finishedBuilder()] });
  await assert.rejects(bakeWith(hc, (h, n, phase) => phase === 'snapshotted' && relabel(h, { owner: 'me' })), /no longer this bake's builder/);
  assert.deepEqual(onBuilder(hc), [{ op: 'snapshot', server: BUILDER_ID }]);
});

test('the builder\'s label() writes only while the server still carries ci-kit=builder and this bake\'s run id', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const script = readFileSync(new URL('../../pool/bake/builder.sh', import.meta.url), 'utf8');
  const fn = script.match(/^label\(\) \{[\s\S]*?^\}/m)[0];
  const dir = mkdtempSync(join(tmpdir(), 'ci-kit-label-'));
  try {
    writeFileSync(join(dir, 'token'), 'tok\n');
    const run = (labels) => {
      writeFileSync(join(dir, 'server.json'), JSON.stringify({ server: { id: 99, labels } }));
      writeFileSync(join(dir, 'puts'), '');
      const stub = `curl() { case "$*" in *169.254*) echo 99;; *"-X PUT"*) printf '%s\\n' "$*" >> "${dir}/puts";; *) cat "${dir}/server.json";; esac; }`;
      execFileSync('bash', ['-c', `RUN_ID=42\n${stub}\n${fn.replace('/etc/ci-kit/hcloud_token', `${dir}/token`)}\nlabel ci-kit-bake ok`], { stdio: 'pipe' });
      return readFileSync(join(dir, 'puts'), 'utf8');
    };
    assert.match(run({ 'ci-kit': 'builder', 'ci-kit-run': '42' }), /"ci-kit-bake":"ok".*"ci-kit":"builder"|"ci-kit":"builder".*"ci-kit-bake":"ok"/);
    assert.equal(run({}), '');
    assert.equal(run({ 'ci-kit-run': '42' }), '');
    assert.equal(run({ 'ci-kit': 'builder', 'ci-kit-run': '7' }), '');
    assert.equal(run({ 'ci-kit': 'pool', 'ci-kit-run': '42' }), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
