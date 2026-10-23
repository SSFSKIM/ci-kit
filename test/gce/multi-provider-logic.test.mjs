import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLaunches } from '../../gce/launcher/logic.mjs';
import { runShape, prelaunchedFor, planPrelaunches } from '../../gce/launcher/prelaunch.mjs';
import { ONE_REGION_CFG } from './config-fixtures.mjs';

const repo = 'o/r';
const cfg = { ...ONE_REGION_CFG, repos: [{ repo }], max_vcpus: 64 };
const now = Date.parse('2026-10-23T12:00:00Z');
const labels = (p = 'any') => ['self-hosted', 'ci-kit-pool', 'cpus-8', ...(p === 'any' ? [] : [`ci-kit-${p}`])];
const job = (id, p = 'any') => ({ id, repo, labels: labels(p), created_at: new Date(now - 10000 + id).toISOString() });
const row = (alloc, provider = 'gce', extra = {}) => ({ alloc, provider, account: provider === 'gce' ? cfg.project : 'a', repo, cpus: 8, reserved: 8, instance: `ci-kit-${provider}-${alloc}`, at: new Date(now - 1000).toISOString(), state: 'launching', slow: [{ outcome: 'unknown', sent: new Date(now - 1000).toISOString(), zone: 'z' }], ...extra });
const runnersFor = (rows, extra = {}) => new Map([[repo, new Map(rows.map((r) => [r.instance, { name: r.instance, status: 'online', busy: false, labels: labels(r.provider).map((name) => ({ name })), ...extra }]))]]);

test('constrained demand consumes each pending coverage unit before older generic demand', () => {
  const rows = [row('g'), row('e', 'ec2')];
  const plan = planLaunches({ queued: [job(1), job(2, 'gce'), job(3, 'ec2')], instances: [], runners: runnersFor(rows), rows, now, cfg, admission: false });
  assert.deepEqual(plan.launches.map((x) => x.job.id), [1]);
  assert.equal(plan.inflight, 16);
});

test('unknown inventory holds running/deleting/failed-write rows but only online idle GitHub runners cover', () => {
  const rows = [row('a', 'ec2', { state: 'running' }), row('b', 'ec2', { state: 'deleting' }), row('c', 'ec2')];
  const runners = runnersFor(rows);
  runners.get(repo).get(rows[1].instance).busy = true;
  runners.get(repo).get(rows[2].instance).status = 'offline';
  const plan = planLaunches({ queued: [job(1), job(2), job(3, 'ec2')], instances: [], rows, runners, cfg, now, admission: false, unknown: new Set(['["ec2","a"]']) });
  assert.equal(plan.inflight, 24);
  assert.deepEqual(plan.launches.map((x) => x.job.id), [1, 2]);
});

test('prelaunch shapes separate actual job requirements and speculate only generic slots', () => {
  const rows = ['any', 'gce', 'ec2'].map((p, i) => row(String(i), 'ec2', { v: 2, job: { run: 1, workflow: 'ci.yml', labels: labels(p), required_provider: p } }));
  assert.deepEqual(runShape(rows, repo, 'ci.yml'), { 8: 1, '8:gce': 1, '8:ec2': 1 });
  const plan = planPrelaunches({ runs: [{ repo, id: 2, attempt: 1, path: 'ci.yml' }], jobs: [], rows, runners: runnersFor([]), inflight: 0, waiting: 0, cfg });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].cpus, 8);
});

test('persistent speculative groups count successful fallback and race once, ignore refused groups, and scope repo', () => {
  const prelaunch = { run: 7, attempt: 1, workflow: 'ci.yml', group: 'original' };
  const rows = [row('original', 'ec2', { prelaunch, end: 'refused', state: 'final' }), row('fallback', 'gce', { prelaunch }), row('race', 'ec2', { prelaunch, race: { of: 'fallback' } }), row('refused', 'ec2', { prelaunch: { ...prelaunch, group: 'refused' }, end: 'refused', state: 'final' }), row('foreign', 'ec2', { repo: 'other/repo', prelaunch: { ...prelaunch, group: 'foreign' } })];
  const run = { repo, id: 7, attempt: 1 };
  assert.deepEqual([...prelaunchedFor(rows, run).get(8)], ['original']);
  assert.deepEqual([...prelaunchedFor(rows.slice(1), run).get(8)], ['original'], 'restart without original preserves grouping');
});

test('mixed live runners and pending allocations cover provider-only jobs once before generic demand', () => {
  for (const provider of ['gce', 'ec2']) {
    const live = row('live', provider, { state: 'running' });
    const pending = row('pending', provider === 'gce' ? 'ec2' : 'gce');
    const instance = { provider, account: live.account, alloc: live.alloc, name: live.instance, cpus: 8, vcpus: 8, repoLabel: 'o--r', status: 'RUNNING', created: now - 1000, running: now - 1000 };
    const rows = [live, pending];
    const plan = planLaunches({ queued: [job(1), job(2, 'gce'), job(3, 'ec2')], instances: [instance], rows, runners: runnersFor(rows), now, cfg, admission: false });
    assert.equal(plan.inflight, 16, 'the live row and its listed VM are one reservation');
    assert.deepEqual(plan.launches.map((x) => x.job.id), [1]);
  }
});
