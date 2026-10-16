// The agent's orchestration (pool/agent/reconciler.mjs) against fakes of GitHub, Hetzner and Docker: ownership,
// idle-runner retirement, the boot ledger row, and the clamp reaching the container.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, NotAPoolBox } from '../../pool/agent/reconciler.mjs';
import { parseRow } from '../../pool/lib/ledger.mjs';

const T0 = Date.parse('2026-10-16T02:00:00Z');
const SBX = 'SSFSKIM/ci-kit-sandbox';
const L4 = ['self-hosted', 'ci-kit-pool', 'cpus-4'];
const CFG = {
  repos: [{ repo: SBX, workflows: ['ci.yml'] }], types: ['cpx62'], locations: ['hel1'], poll_seconds: 10,
  idle_runner_minutes: 10, drain_minute: 50, memory_gb_per_cpu: 2, max_hours_per_day: 8,
  ledger: { repo: SBX, issue_title: 'pool ledger' },
};
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function world({ labels = { 'ci-kit': 'pool', 'ci-kit-state': 'booting' }, totalCores = 16 } = {}) {
  let clock = T0;
  const calls = [];
  const server = {
    id: 55, name: 'ci-kit-pool', created: new Date(T0 - 5 * 60_000).toISOString(), labels: { ...labels },
    server_type: { name: 'cpx62', prices: [{ location: 'hel1', price_hourly: { gross: '0.2452' } }] }, location: { name: 'hel1' },
  };
  const state = { runners: [], runs: [], jobs: new Map(), containers: [], comments: [], deleteRunnerError: null };
  let commentId = 1;
  const hc = {
    server: async (id) => {
      if (id !== 55) throw httpError(404);
      return { ...server, labels: { ...server.labels } };
    },
    setLabels: async (id, l) => { calls.push(`labels ${JSON.stringify(l)}`); server.labels = { ...l }; },
    deleteServer: async (id) => { calls.push(`delete server ${id}`); return { id: 1 }; },
  };
  const gh = {
    getRepo: async () => ({ private: true }),
    runners: async () => state.runners.map((r) => ({ ...r })),
    runsByStatus: async (_repo, status) => state.runs.filter((r) => r.status === status),
    listJobs: async (_repo, id) => state.jobs.get(id) ?? [],
    deleteRunner: async (_repo, id) => {
      calls.push(`unregister ${id}`);
      if (state.deleteRunnerError) throw httpError(state.deleteRunnerError);
      state.runners = state.runners.filter((r) => r.id !== id);
    },
    jitConfig: async (_repo, spec) => { calls.push(`jit ${spec.name}`); return { runner: { id: 900 }, encoded_jit_config: 'jit' }; },
    enableWorkflow: async () => {},
    openIssues: async () => [{ number: 1, title: 'pool ledger' }],
    issueComments: async () => state.comments.map((c) => ({ ...c })),
    createComment: async (_r, _n, body) => { calls.push('row created'); state.comments.push({ id: commentId++, body }); },
    updateComment: async (_r, id, body) => { calls.push('row updated'); state.comments.find((c) => c.id === id).body = body; },
    deleteComment: async () => {},
    ensureLabel: async () => {},
    createIssue: async () => ({ number: 2 }),
  };
  const docker = {
    list: async () => state.containers.map((c) => ({ ...c })),
    start: async (spec) => { calls.push(`start ${spec.name} ${spec.cores.length} cores${spec.clamped ? ` clamped ${spec.clamped}` : ''}`); },
    remove: async (name) => { calls.push(`remove ${name}`); state.containers = state.containers.filter((c) => c.name !== name); },
  };
  const agent = new Agent({
    cfg: CFG, gh, hc, serverId: 55, totalCores, docker,
    work: { dir: (n) => `/w/${n}`, make: async () => {}, remove: async () => {} },
    touchLastSuccess: async () => {}, blockMetadata: async () => {}, loadConfig: async (c) => c,
    now: () => clock,
  });
  return { agent, calls, state, server, advance: (ms) => { clock += ms; } };
}

test('the agent refuses to start on a server that does not carry ci-kit=pool, and never labels it', async () => {
  for (const labels of [{}, { 'ci-kit': 'builder' }]) {
    const w = world({ labels });
    await assert.rejects(w.agent.start(), NotAPoolBox);
    assert.deepEqual(w.calls, []);
  }
});

test('before deleting itself the agent checks ownership again on the server as it is now', async () => {
  const w = world();
  await w.agent.start();
  w.server.labels = { other: 'x' }; // relabelled (or the metadata named another server) since boot
  w.calls.length = 0;
  await assert.rejects(w.agent.deleteSelf(), NotAPoolBox);
  assert.deepEqual(w.calls, []);
});

test('at boot the agent writes its session\'s provisional running row; at its idle delete it rewrites that row as deleting', async () => {
  const w = world();
  await w.agent.start();
  assert.equal(w.state.comments.length, 1);
  assert.equal(parseRow(w.state.comments[0].body).state, 'running');
  await w.agent.deleteSelf();
  assert.equal(w.state.comments.length, 1);
  assert.deepEqual([parseRow(w.state.comments[0].body).state, parseRow(w.state.comments[0].body).end], ['deleting', 'idle']);
  assert.ok(w.calls.at(-1) === 'delete server 55');
});

const idleContainer = () => ({ id: 'c1', name: 'ci-kit-pool-55-1', running: true, created: T0 - 11 * 60_000, repo: SBX, runnerId: 7, labels: L4, cpus: 4, cores: [0, 1, 2, 3] });

test('an idle runner whose unregister fails keeps its container; a job taken meanwhile then runs undisturbed', async () => {
  const w = world();
  await w.agent.start();
  w.state.containers = [idleContainer()];
  w.state.runners = [{ id: 7, name: 'ci-kit-pool-55-1', busy: false, status: 'online' }];
  w.state.runs = [{ id: 1, status: 'in_progress', path: '.github/workflows/ci.yml' }];
  w.state.deleteRunnerError = 422; // GitHub refuses: the runner took a job between our read and our call
  w.calls.length = 0;
  await w.agent.tick();
  assert.deepEqual(w.calls.filter((c) => /unregister|remove/.test(c)), ['unregister 7']);
  assert.equal(w.state.containers.length, 1);
  // Next tick: the runner is busy with that job. Nothing is retired.
  w.state.runners = [{ id: 7, name: 'ci-kit-pool-55-1', busy: true, status: 'online' }];
  w.state.deleteRunnerError = null;
  w.calls.length = 0;
  w.advance(10_000);
  await w.agent.tick();
  assert.deepEqual(w.calls.filter((c) => /unregister|remove/.test(c)), []);
  assert.equal(w.state.containers.length, 1);
});

test('an idle runner GitHub has already let go of (404) is retired, container and all', async () => {
  const w = world();
  await w.agent.start();
  w.state.containers = [idleContainer()];
  w.state.runners = [{ id: 7, name: 'ci-kit-pool-55-1', busy: false, status: 'online' }];
  w.state.deleteRunnerError = 404;
  w.calls.length = 0;
  await w.agent.tick();
  assert.deepEqual(w.calls.filter((c) => /unregister|remove/.test(c)), ['unregister 7', 'remove ci-kit-pool-55-1']);
});

test('a cpus-16 job on a 12-core box starts on all 12 cores, marked clamped', async () => {
  const w = world({ totalCores: 12 });
  await w.agent.start();
  w.state.runs = [{ id: 1, status: 'in_progress', path: '.github/workflows/ci.yml' }];
  w.state.jobs.set(1, [{ id: 11, status: 'queued', labels: ['self-hosted', 'ci-kit-pool', 'cpus-16'], created_at: new Date(T0).toISOString() }]);
  w.calls.length = 0;
  await w.agent.tick();
  assert.ok(w.calls.includes('start ci-kit-pool-55-1 12 cores clamped 16'), w.calls.join('\n'));
});

test('ownership lost mid-life: the next tick writes no label (no heartbeat putting ci-kit=pool back), and the agent stops managing the server', async () => {
  const w = world();
  await w.agent.start();
  w.server.labels = { owner: 'other' };
  w.calls.length = 0;
  w.advance(61_000); // a heartbeat is due
  await w.agent.tick();
  assert.deepEqual(w.calls.filter((c) => c.startsWith('labels') || c.startsWith('delete server')), []);
  assert.deepEqual(w.server.labels, { owner: 'other' });
  assert.equal(w.agent.disowned, true);
  // Nothing further: no containers, no labels, no deletion, whatever is queued.
  w.state.runs = [{ id: 1, status: 'in_progress', path: '.github/workflows/ci.yml' }];
  w.state.jobs.set(1, [{ id: 11, status: 'queued', labels: L4, created_at: new Date(T0).toISOString() }]);
  w.advance(10_000);
  await w.agent.tick();
  assert.deepEqual(w.calls.filter((c) => /^(labels|delete server|start|jit)/.test(c)), []);
});

test('ownership lost before a state change: draining is not written either', async () => {
  const w = world();
  await w.agent.start();
  w.server.labels = {};
  w.calls.length = 0;
  w.advance(50 * 60_000); // minute ≥ 50 and idle: the lifecycle wants to drain
  await w.agent.tick();
  assert.deepEqual(w.calls.filter((c) => c.startsWith('labels') || c.startsWith('delete server')), []);
  assert.equal(w.agent.disowned, true);
});

// The idle rule (spec Decision Log, 2026-10-16: only demand for the pool extends a box's life). The world's box was
// created at T0 - 5 min, so its minute 50 falls at T0 + 45 min.
const MINUTE50 = 45 * 60_000;
const hostedGate = (w) => {
  // A watched MAWS-style gate run in progress whose jobs are all hosted: no pool demand.
  w.state.runs = [{ id: 1, status: 'in_progress', path: '.github/workflows/ci.yml' }];
  w.state.jobs.set(1, [{ id: 21, status: 'in_progress', labels: ['ubuntu-latest'], created_at: new Date(T0).toISOString() }]);
};
// The state changes and deletion among the calls since `w.calls` was last cleared. Every label write carries the whole
// set, so only a write whose state differs from the one before it is a transition.
const lifecycle = (w) => {
  const out = [];
  let state = 'ready';
  for (const c of w.calls) {
    if (c.startsWith('delete server')) out.push('delete');
    if (!c.startsWith('labels ')) continue;
    const next = JSON.parse(c.slice(7))['ci-kit-state'];
    if (next !== state) out.push(next);
    state = next;
  }
  return out;
};

test('a watched run with no pool demand does not pin the box: it drains and deletes itself at minute 50', async () => {
  const w = world();
  await w.agent.start();
  hostedGate(w);
  w.calls.length = 0;
  w.advance(MINUTE50);
  await w.agent.tick();
  w.advance(10_000);
  await w.agent.tick();
  assert.deepEqual(lifecycle(w), ['draining', 'delete']);
});

test('an ensure stamp pins the box for 15 min, then releases it', async () => {
  const w = world();
  await w.agent.start();
  hostedGate(w);
  w.advance(MINUTE50);
  // ensure stamped the box 10 min ago (ci-kit-want), written into the server's labels by ensure, not by the agent
  w.server.labels = { ...w.server.labels, 'ci-kit-want': String(Math.floor((T0 + MINUTE50 - 10 * 60_000) / 1000)) };
  w.calls.length = 0;
  await w.agent.tick();
  assert.deepEqual(lifecycle(w), []);
  w.advance(4 * 60_000 + 50_000); // the stamp is 14 min 50 s old
  await w.agent.tick();
  assert.deepEqual(lifecycle(w), []);
  w.advance(10_000); // 15 min: released
  await w.agent.tick();
  w.advance(10_000);
  await w.agent.tick();
  assert.deepEqual(lifecycle(w), ['draining', 'delete']);
});

test('an ensure stamp that lands while the box drains brings it back to ready', async () => {
  const w = world();
  await w.agent.start();
  w.advance(MINUTE50);
  w.calls.length = 0;
  await w.agent.tick();
  w.server.labels = { ...w.server.labels, 'ci-kit-want': String(Math.floor((T0 + MINUTE50) / 1000)) };
  w.advance(10_000);
  await w.agent.tick();
  assert.deepEqual(lifecycle(w), ['draining', 'ready']);
});

test('a queued pool job pins the box (the agent starts it), and so does one in progress', async () => {
  const w = world();
  await w.agent.start();
  w.advance(MINUTE50);
  w.state.runs = [{ id: 1, status: 'in_progress', path: '.github/workflows/gate.yml' }];
  w.state.jobs.set(1, [{ id: 11, status: 'queued', labels: L4, created_at: new Date(T0).toISOString() }]);
  w.calls.length = 0;
  await w.agent.tick();
  assert.ok(w.calls.some((c) => c.startsWith('start ')));
  // In progress on a runner whose container this tick did not list (a racing read): still demand.
  w.state.jobs.set(1, [{ id: 11, status: 'in_progress', labels: L4, created_at: new Date(T0).toISOString() }]);
  w.advance(10_000);
  await w.agent.tick();
  assert.deepEqual(lifecycle(w), []);
});

test('the agent\'s label writes read-modify-write: a heartbeat keeps the labels others wrote', async () => {
  const w = world();
  await w.agent.start();
  const want = String(Math.floor(T0 / 1000));
  w.server.labels = { ...w.server.labels, 'ci-kit-want': want, 'ci-kit-fallback': 'core-limit', other: 'kept' };
  w.advance(61_000);
  await w.agent.tick();
  assert.equal(w.server.labels['ci-kit-want'], want);
  assert.equal(w.server.labels['ci-kit-fallback'], 'core-limit');
  assert.equal(w.server.labels.other, 'kept');
  assert.ok(w.server.labels['ci-kit-heartbeat']);
  assert.equal(w.server.labels['ci-kit'], 'pool');
});
