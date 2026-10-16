// The GCE bake (spec §3a Image, I12): its decisions as pure functions, and the bake's run against a fake Compute
// Engine over recorded shapes — ok, failed and timed-out builders, a failed smoke, retention and ownership by label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  reportOutcome, ownsBakeInstance, staleBakeInstances, imagesToPrune, placements, refusal, bakeRunId, bakeNames,
  builderInstance, smokeInstance, imageBody, fillBuilderScript, machineCpus, BAKE_TIMEOUT_MS,
} from '../../gce/bake/plan.mjs';
import { runBake } from '../../gce/bake/bake.mjs';
import { GceError } from '../../lib/gce.mjs';
import { fakeGce, instanceShape, imageShape, FOREIGN } from './fake-gce.mjs';

const CFG = JSON.parse(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
const SHA = 'a'.repeat(40);
const RUN = '20261016-094500';
const MIN = 60_000;

test('a builder is ok only once it reported ok and powered off', () => {
  const at = (status, report, elapsedMs = MIN) => reportOutcome({ instance: instanceShape({ name: 'b', status }), report, elapsedMs, timeoutMs: BAKE_TIMEOUT_MS });
  assert.deepEqual(at('RUNNING', null), { done: false });
  assert.deepEqual(at('RUNNING', 'ok'), { done: false }); // its disk is consistent only once it is off
  assert.deepEqual(at('STOPPING', 'ok'), { done: false });
  assert.deepEqual(at('TERMINATED', 'ok'), { done: true, ok: true });
});

test('a builder that reports a failed step, powers off without a report, vanishes or runs past 30 min has failed', () => {
  const at = (instance, report, elapsedMs = MIN) => reportOutcome({ instance, report, elapsedMs, timeoutMs: BAKE_TIMEOUT_MS });
  const running = instanceShape({ name: 'b', status: 'RUNNING' });
  assert.deepEqual(at(running, 'failed:image'), { done: true, ok: false, reason: 'failed:image' });
  assert.deepEqual(at(instanceShape({ name: 'b', status: 'TERMINATED' }), null), { done: true, ok: false, reason: 'failed:no-report' });
  assert.deepEqual(at(null, null), { done: true, ok: false, reason: 'failed:vanished' });
  assert.deepEqual(at(running, null, 30 * MIN + 1), { done: true, ok: false, reason: 'timeout' });
  assert.deepEqual(at(running, 'ok', 30 * MIN + 1), { done: true, ok: false, reason: 'timeout' }); // never powered off
});

test('the bake owns only instances labelled as its own builders, and sweeps those older than 2 h', () => {
  const mine = instanceShape({ name: `ci-kit-gce-builder-${RUN}`, labels: { 'ci-kit': 'gce-builder', 'ci-kit-run': RUN } });
  const other = instanceShape({ name: 'ci-kit-gce-builder-20261016-000000', labels: { 'ci-kit': 'gce-builder', 'ci-kit-run': '20261016-000000' }, created: '2026-10-16T00:00:00.000Z' });
  const vm = instanceShape({ name: 'ci-kit-gce-abc', labels: { 'ci-kit': 'gce', 'ci-kit-run': RUN }, created: '2026-10-16T00:00:00.000Z' });
  assert.equal(ownsBakeInstance(mine, RUN), true);
  assert.equal(ownsBakeInstance(other, RUN), false);
  assert.equal(ownsBakeInstance(vm, RUN), false);
  for (const f of FOREIGN.instances) assert.equal(ownsBakeInstance(f, '20260901-000000'), false);
  const now = Date.parse('2026-10-16T02:30:00Z');
  assert.deepEqual(staleBakeInstances([mine, other, vm, ...FOREIGN.instances], now).map((i) => i.name), ['ci-kit-gce-builder-20261016-000000']);
});

test('retention keeps the two newest ready images, and drops unready ones only once they are 2 h old', () => {
  const img = (name, created, ready) => imageShape({ name, created, labels: { 'ci-kit': 'gce-image', 'ci-kit-commit': SHA, 'ci-kit-ready': ready } });
  const images = [
    ...FOREIGN.images,
    img('r1', '2026-10-01T00:00:00.000Z', 'true'),
    img('r2', '2026-10-08T00:00:00.000Z', 'true'),
    img('r3', '2026-10-15T00:00:00.000Z', 'true'),
    img('u-old', '2026-10-15T01:00:00.000Z', 'false'),
    img('u-new', '2026-10-16T09:00:00.000Z', 'false'), // a bake in flight
  ];
  const now = Date.parse('2026-10-16T10:00:00Z');
  assert.deepEqual(imagesToPrune(images, { family: 'ci-kit-runner', now }).map((i) => i.name).sort(), ['r1', 'u-old']);
  assert.deepEqual(imagesToPrune(images.slice(0, 4), { family: 'ci-kit-runner', now }), []);
});

test('placements try every zone of a machine before the next machine', () => {
  assert.deepEqual(placements(['e2-standard-4', 'n2d-standard-4'], ['z-a', 'z-b']), [
    { machine: 'e2-standard-4', zone: 'z-a' }, { machine: 'e2-standard-4', zone: 'z-b' },
    { machine: 'n2d-standard-4', zone: 'z-a' }, { machine: 'n2d-standard-4', zone: 'z-b' },
  ]);
});

test('an insert refused for capacity moves to the next zone, one refused for quota to the next machine', () => {
  assert.equal(refusal(new GceError(200, 'x', ['ZONE_RESOURCE_POOL_EXHAUSTED'])), 'capacity');
  assert.equal(refusal(new GceError(200, 'x', ['ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS'])), 'capacity');
  assert.equal(refusal(new GceError(200, 'x', ['QUOTA_EXCEEDED'])), 'quota');
  assert.equal(refusal(new GceError(403, 'x', ['quotaExceeded'])), 'quota');
  assert.equal(refusal(new GceError(400, 'x', ['invalid'])), null);
  assert.equal(refusal(new Error('timeout')), null);
});

test('names: the run id is UTC seconds, and builder, smoke and image names fit Compute Engine\'s rules', () => {
  const run = bakeRunId(new Date('2026-10-16T09:45:00.123Z'));
  assert.equal(run, '20261016-094500');
  const n = bakeNames(run, SHA);
  assert.deepEqual(n, { builder: 'ci-kit-gce-builder-20261016-094500', smoke: 'ci-kit-gce-builder-20261016-094500-smoke', image: `ci-kit-runner-20261016-094500-${SHA.slice(0, 8)}` });
  for (const name of Object.values(n)) assert.match(name, /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/);
  assert.equal(machineCpus('e2-highcpu-2'), 2);
  assert.equal(machineCpus('c3d-highcpu-16'), 16);
});

test('the builder has no service account, carries only a token in its metadata, and is deleted by GCE at the latest after its run limit', () => {
  const body = builderInstance({ name: 'ci-kit-gce-builder-x', zone: 'us-central1-a', machine: 'e2-standard-4', runId: RUN, script: '#!/bin/bash\n', token: 'ghs_x', diskGb: 30 });
  assert.deepEqual(body.serviceAccounts, []);
  assert.deepEqual(body.labels, { 'ci-kit': 'gce-builder', 'ci-kit-run': RUN, 'ci-kit-role': 'builder' });
  assert.deepEqual(body.disks[0].initializeParams.labels, body.labels);
  assert.equal(body.disks[0].autoDelete, true);
  assert.match(body.disks[0].initializeParams.sourceImage, /ubuntu-os-cloud\/global\/images\/family\/ubuntu-2404-lts-amd64$/);
  const meta = Object.fromEntries(body.metadata.items.map((i) => [i.key, i.value]));
  assert.deepEqual(Object.keys(meta).sort(), ['ci-kit-gh-token', 'enable-guest-attributes', 'startup-script']);
  assert.equal(meta['enable-guest-attributes'], 'TRUE');
  assert.equal(body.scheduling.instanceTerminationAction, 'DELETE');
  assert.ok(Number(body.scheduling.maxRunDuration.seconds) > BAKE_TIMEOUT_MS / 1000);
  assert.equal(body.machineType, 'zones/us-central1-a/machineTypes/e2-standard-4');
});

test('the smoke VM boots the new image like a job VM, with no JIT config and the vCPUs it must see', () => {
  const body = smokeInstance({ name: 's', zone: 'us-central1-b', machine: 'e2-highcpu-2', runId: RUN, image: 'projects/ssfskim-ci-kit/global/images/i', diskGb: 50 });
  assert.deepEqual(body.serviceAccounts, []);
  assert.equal(body.labels['ci-kit-role'], 'smoke');
  assert.equal(body.disks[0].initializeParams.sourceImage, 'projects/ssfskim-ci-kit/global/images/i');
  assert.equal(body.disks[0].initializeParams.diskSizeGb, '50');
  const meta = Object.fromEntries(body.metadata.items.map((i) => [i.key, i.value]));
  assert.deepEqual(meta, { 'enable-guest-attributes': 'TRUE', 'ci-kit-smoke': '2' });
});

test('the image goes into the family unready, labelled with the kit commit and the run', () => {
  const body = imageBody({ name: 'i', family: 'ci-kit-runner', zone: 'us-central1-a', disk: 'd', sha: SHA, runId: RUN });
  assert.equal(body.family, 'ci-kit-runner');
  assert.equal(body.sourceDisk, 'zones/us-central1-a/disks/d');
  assert.deepEqual(body.labels, { 'ci-kit': 'gce-image', 'ci-kit-commit': SHA, 'ci-kit-ready': 'false', 'ci-kit-run': RUN });
});

test('the shipped builder script takes only the kit commit, holds no credential, and never traces', () => {
  const template = readFileSync(new URL('../../gce/bake/builder.sh', import.meta.url), 'utf8');
  const script = fillBuilderScript(template, { sha: SHA });
  assert.doesNotMatch(script, /__[A-Z_]+__/);
  assert.match(script, new RegExp(`^KIT_SHA=${SHA}$`, 'm'));
  assert.doesNotMatch(script, /set -[a-z]*x|set -o xtrace|BEGIN [A-Z ]*PRIVATE KEY/);
  assert.match(script, /guest-attributes\/ci-kit\/bake/);
  assert.throws(() => fillBuilderScript(template, { sha: 'main' }), /commit/);
  assert.throws(() => fillBuilderScript(`${template}__OTHER__`, { sha: SHA }), /placeholder __OTHER__/);
});

// ---- the bake's run against the fake

const clock = () => {
  let t = Date.parse('2026-10-16T09:45:00Z');
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};
const OK_BUILDER = [{ status: 'RUNNING' }, { status: 'RUNNING', attrs: { 'ci-kit/bake': 'ok' } }, { status: 'STOPPING' }, { status: 'TERMINATED' }];
const OK_SMOKE = [{ status: 'RUNNING' }, { status: 'RUNNING', attrs: { 'ci-kit/smoke': 'ok' } }, { status: 'TERMINATED' }];
const bake = (gce, c = clock()) => runBake(gce, { cfg: CFG, sha: SHA, runId: RUN, token: 'ghs_x', script: '#!/bin/bash\n', ...c, log: () => {} });
const ready = (gce) => gce.state.images.filter((i) => i.family === 'ci-kit-runner' && i.labels?.['ci-kit-ready'] === 'true').map((i) => i.name);
const leftInstances = (gce) => gce.state.instances.filter((i) => i.labels?.['ci-kit'] === 'gce-builder').map((i) => i.name);

test('an ok builder and a passing smoke publish one ready image, and leave no builder or smoke VM', async () => {
  const gce = fakeGce({ scripts: { builder: OK_BUILDER, smoke: OK_SMOKE } });
  const result = await bake(gce);
  assert.equal(result.image, `ci-kit-runner-${RUN}-aaaaaaaa`);
  assert.deepEqual(ready(gce), [result.image]);
  assert.deepEqual(leftInstances(gce), []);
  const i = gce.calls.indexOf(`insert image ${result.image} from ci-kit-gce-builder-${RUN}`);
  assert.ok(i > 0 && gce.calls.indexOf(`delete instance ci-kit-gce-builder-${RUN}`) > i, 'the image is taken before the builder goes');
  assert.deepEqual(gce.foreignTouched, []);
});

test('a builder that reports a failed step makes no image and is deleted', async () => {
  const gce = fakeGce({ scripts: { builder: [{ status: 'RUNNING' }, { status: 'RUNNING', attrs: { 'ci-kit/bake': 'failed:warm-check' } }] } });
  await assert.rejects(bake(gce), /failed:warm-check/);
  assert.ok(!gce.calls.some((c) => c.startsWith('insert image')));
  assert.deepEqual(leftInstances(gce), []);
});

test('a builder that never powers off times out after 30 min and is deleted', async () => {
  const gce = fakeGce({ scripts: { builder: [{ status: 'RUNNING' }] } });
  const c = clock();
  await assert.rejects(bake(gce, c), /timeout/);
  assert.ok(c.now() - Date.parse('2026-10-16T09:45:00Z') >= 30 * MIN);
  assert.deepEqual(leftInstances(gce), []);
});

test('a failed smoke deletes the new image and keeps the previous ready ones', async () => {
  const prev = imageShape({ name: 'prev', created: '2026-10-09T00:00:00.000Z', labels: { 'ci-kit': 'gce-image', 'ci-kit-commit': SHA, 'ci-kit-ready': 'true' } });
  const gce = fakeGce({ images: [prev], scripts: { builder: OK_BUILDER, smoke: [{ status: 'RUNNING', attrs: { 'ci-kit/smoke': 'failed:caches' } }] } });
  await assert.rejects(bake(gce), /smoke.*failed:caches/);
  assert.deepEqual(ready(gce), ['prev']);
  assert.ok(!gce.state.images.some((i) => i.name.startsWith(`ci-kit-runner-${RUN}`)));
  assert.deepEqual(leftInstances(gce), []);
});

test('a successful bake prunes ready images beyond the two newest, and stale builders of earlier bakes', async () => {
  const img = (name, created) => imageShape({ name, created, labels: { 'ci-kit': 'gce-image', 'ci-kit-commit': SHA, 'ci-kit-ready': 'true' } });
  const stale = instanceShape({ name: 'ci-kit-gce-builder-20261015-000000', status: 'TERMINATED', labels: { 'ci-kit': 'gce-builder', 'ci-kit-run': '20261015-000000' }, created: '2026-10-15T00:00:00.000Z' });
  const gce = fakeGce({ instances: [stale], images: [img('old', '2026-10-01T00:00:00.000Z'), img('mid', '2026-10-08T00:00:00.000Z')], scripts: { builder: OK_BUILDER, smoke: OK_SMOKE } });
  const { image } = await bake(gce);
  assert.deepEqual(ready(gce).sort(), [image, 'mid'].sort());
  assert.deepEqual(leftInstances(gce), []);
  assert.deepEqual(gce.foreignTouched, []);
});

test('a builder machine refused for quota falls back to the next machine; capacity moves through the zones first', async () => {
  const gce = fakeGce({ insertErrors: ['ZONE_RESOURCE_POOL_EXHAUSTED', 'QUOTA_EXCEEDED'], scripts: { builder: OK_BUILDER, smoke: OK_SMOKE } });
  await bake(gce);
  const inserts = gce.calls.filter((c) => c.startsWith(`insert ci-kit-gce-builder-${RUN} `));
  assert.deepEqual(inserts, [
    `insert ci-kit-gce-builder-${RUN} e2-standard-4@us-central1-a`,
    `insert ci-kit-gce-builder-${RUN} e2-standard-4@us-central1-b`,
    `insert ci-kit-gce-builder-${RUN} n2d-standard-4@us-central1-a`,
  ]);
});

test('the smoke VM uses the cpus-2 machine, and its fallback when E2 is refused', async () => {
  const gce = fakeGce({ insertErrors: ['', 'QUOTA_EXCEEDED'], scripts: { builder: OK_BUILDER, smoke: OK_SMOKE } });
  await bake(gce);
  const smokes = gce.calls.filter((c) => c.startsWith(`insert ci-kit-gce-builder-${RUN}-smoke`));
  assert.deepEqual(smokes, [
    `insert ci-kit-gce-builder-${RUN}-smoke e2-highcpu-2@us-central1-a`,
    `insert ci-kit-gce-builder-${RUN}-smoke c3d-highcpu-4@us-central1-a`,
  ]);
  const body = gce.inserted.find((b) => b.name === `ci-kit-gce-builder-${RUN}-smoke`);
  assert.equal(body.metadata.items.find((i) => i.key === 'ci-kit-smoke').value, '4'); // the fallback's vCPUs
});

test('a builder another party relabelled is left alone', async () => {
  const gce = fakeGce({ scripts: { builder: [{ status: 'RUNNING', attrs: { 'ci-kit/bake': 'failed:apt' } }] } });
  const real = gce.insertInstance;
  gce.insertInstance = async (zone, body) => {
    const inst = await real(zone, body);
    gce.state.instances.find((i) => i.name === body.name).labels = { kept: 'debugging' };
    return inst;
  };
  await assert.rejects(bake(gce), /no longer this bake's/);
  assert.deepEqual(gce.state.instances.filter((i) => i.name === `ci-kit-gce-builder-${RUN}`).length, 1);
});
