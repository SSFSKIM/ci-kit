// The bake's cleanup and pruning (spec §3 Bake, "When a bake does not complete").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bakeLeftovers, snapshotsToPrune, builderUserData, createBuilder, CoreLimitError } from '../../pool/bake/plan.mjs';
import { fakeHcloud } from './fake-hcloud.mjs';
import { FOREIGN } from './fake-hcloud.mjs';

const snap = (id, created, { status = 'available', run = '1', labels } = {}) => ({
  id, type: 'snapshot', status, created, labels: labels ?? { 'ci-kit': 'pool-image', 'ci-kit-commit': 'abc', 'ci-kit-run': run },
});
const builder = (id, run) => ({ id, name: `ci-kit-builder-${run}`, labels: { 'ci-kit': 'builder', 'ci-kit-run': run }, created: '2026-10-15T00:00:00Z' });

test('cleanup takes its own run\'s builders and its own unfinished snapshots, nothing else', () => {
  const servers = [...FOREIGN.servers, builder(1, '42'), builder(2, '41'), { id: 3, name: 'ci-kit-builder-42', labels: {} }];
  const images = [...FOREIGN.images, snap(10, '2026-10-15T01:00:00Z', { run: '42', status: 'creating' }), snap(11, '2026-10-15T01:00:00Z', { run: '42' }), snap(12, '2026-10-15T01:00:00Z', { run: '41', status: 'creating' }),
    { id: 13, type: 'snapshot', status: 'creating', created: '2026-10-15T01:00:00Z', labels: { 'ci-kit-run': '42' } }];
  const left = bakeLeftovers({ servers, images, runId: '42' });
  assert.deepEqual(left.servers.map((s) => s.id), [1]);
  assert.deepEqual(left.images.map((i) => i.id), [10]);
});

test('pruning keeps the two newest available pool snapshots and never touches foreign images', () => {
  const images = [...FOREIGN.images, snap(1, '2026-10-01T00:00:00Z'), snap(2, '2026-10-08T00:00:00Z'), snap(3, '2026-10-15T00:00:00Z'), snap(4, '2026-10-16T00:00:00Z', { status: 'creating' })];
  assert.deepEqual(snapshotsToPrune(images, 2).map((i) => i.id), [1]);
  assert.deepEqual(snapshotsToPrune(images.slice(0, 3), 2), []);
});

test('the builder user-data carries the kit commit and the credentials, and a template placeholder is never left behind', () => {
  const template = '#!/bin/bash\nKIT_SHA=__KIT_SHA__\nAPP_ID=__APP_ID__\ncat > key <<\'K\'\n__APP_KEY__\nK\nTOKEN=__HCLOUD_TOKEN__\n';
  const ud = builderUserData(template, { sha: 'abc123', appId: '5', appKey: '-----BEGIN-----\nx\n-----END-----', hcloudToken: 'tok' });
  assert.match(ud, /KIT_SHA=abc123/);
  assert.match(ud, /-----BEGIN-----\nx\n-----END-----/);
  assert.doesNotMatch(ud, /__[A-Z_]+__/);
  assert.throws(() => builderUserData(template + '__OTHER__\n', { sha: 'a', appId: '5', appKey: 'k', hcloudToken: 't' }), /placeholder __OTHER__/);
});

test('the shipped builder script fills with no unknown placeholder, quotes the secrets, and never traces them', async () => {
  const { readFileSync } = await import('node:fs');
  const template = readFileSync(new URL('../../pool/bake/builder.sh', import.meta.url), 'utf8');
  const ud = builderUserData(template, { sha: 'f'.repeat(40), appId: '5337915', appKey: '-----BEGIN RSA PRIVATE KEY-----\nAAA$HOME`x`\n-----END RSA PRIVATE KEY-----\n', hcloudToken: 'tok$x' });
  assert.ok(Buffer.byteLength(ud) < 32 * 1024, 'Hetzner user-data is limited to 32 KiB');
  assert.match(ud, /<<'CI_KIT_APP_KEY'\n-----BEGIN RSA PRIVATE KEY-----\nAAA\$HOME`x`\n-----END RSA PRIVATE KEY-----\nCI_KIT_APP_KEY\n/);
  assert.doesNotMatch(ud, /set -[a-z]*x|set -o xtrace/);
});

test('warm reads the lockfile\'s resolved root versions, without peer suffixes', async () => {
  const { lockedVersion } = await import('../../pool/bake/warm.mjs');
  const lock = { importers: { '.': { devDependencies: { '@playwright/test': { specifier: '^1.63.0', version: '1.63.2' }, electron: { specifier: '44.4.5', version: '44.4.5(patch)' } } } } };
  assert.equal(lockedVersion(lock, '@playwright/test'), '1.63.2');
  assert.equal(lockedVersion(lock, 'electron'), '44.4.5');
  assert.equal(lockedVersion(lock, 'vitest'), null);
});

const BTYPES = [{ name: 'cx23', locations: [{ name: 'hel1', available: true }, { name: 'fsn1', available: true }] }];
const BUILDER = { types: ['cx23'], locations: ['hel1', 'fsn1'] };
const clock = () => {
  let t = Date.parse('2026-10-16T03:17:00Z');
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};

test('a builder refused for the core limit is retried every 5 min, and created once the pool box is gone', async () => {
  const hc = fakeHcloud({ serverTypes: BTYPES, firewalls: [{ id: 401, name: 'ci-kit-pool', labels: { 'ci-kit': 'pool' } }], createErrors: ['resource_limit_exceeded', 'resource_limit_exceeded'] });
  const c = clock();
  const waits = [];
  const server = await createBuilder(hc, { userData: 'x', runId: 9, builder: BUILDER, ...c, log: (m) => waits.push(m) });
  assert.equal(server.name, 'ci-kit-builder-9');
  // The limit is project-wide: one attempt per round, not one per location.
  assert.deepEqual(hc.calls.filter((x) => x.startsWith('create ')), ['create cx23@hel1', 'create cx23@hel1', 'create cx23@hel1']);
  assert.equal(c.now() - Date.parse('2026-10-16T03:17:00Z'), 10 * 60_000);
  assert.match(waits.join('\n'), /core limit/);
});

test('a builder still refused for the core limit after 2 h fails with CoreLimitError', async () => {
  const hc = fakeHcloud({ serverTypes: BTYPES, firewalls: [{ id: 401, name: 'ci-kit-pool', labels: { 'ci-kit': 'pool' } }], createErrors: Array(100).fill('resource_limit_exceeded') });
  const c = clock();
  await assert.rejects(createBuilder(hc, { userData: 'x', runId: 9, builder: BUILDER, ...c, log: () => {} }), (err) => {
    assert.ok(err instanceof CoreLimitError);
    assert.match(err.message, /core limit.*2 h/);
    return true;
  });
  const waited = c.now() - Date.parse('2026-10-16T03:17:00Z');
  assert.ok(waited >= 2 * 3600_000 && waited < 2 * 3600_000 + 5 * 60_000, `waited ${waited / 60_000} min`);
});
