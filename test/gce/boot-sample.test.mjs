// The boot sampler's arithmetic (gce/tools/boot-sample.mjs, spec M3 The boot): each sample's stages, and each arm's
// median and range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stagesOf, summarize, samplePlacement, cleanUpSample, sample } from '../../gce/tools/boot-sample.mjs';
import { NEW_CFG, M6_CFG, C4D_CENTRAL, CENTRAL } from './config-fixtures.mjs';

const s = (accepted, running, started) => ({ accepted: `2026-10-21T13:00:${accepted}Z`, running: `2026-10-21T13:00:${running}Z`, started });

test('a sample\'s stages run from the insert\'s acceptance to RUNNING and to the job\'s start', () => {
  assert.deepEqual(stagesOf(s('00', '10', '2026-10-21T13:00:40Z')), { acceptedToRunning: 10, runningToStarted: 30, acceptedToStarted: 40 });
  assert.deepEqual(stagesOf(s('00', '10', undefined)), { acceptedToRunning: 10, runningToStarted: null, acceptedToStarted: null }, 'a job that never started');
});

test('an arm\'s summary is each stage\'s median and range over the samples that have it', () => {
  const sum = summarize([s('00', '10', '2026-10-21T13:00:40Z'), s('00', '12', '2026-10-21T13:00:50Z'), s('00', '08', undefined)]);
  assert.deepEqual(sum.acceptedToRunning, { n: 3, median: 10, min: 8, max: 12 });
  assert.deepEqual(sum.acceptedToStarted, { n: 2, median: 45, min: 40, max: 50 });
});

test('a run samples one placement: the region asked for, else the first, and its size-4 machine unless one is named', () => {
  assert.deepEqual(samplePlacement(NEW_CFG, {}), { placement: NEW_CFG.placements[0], machine: 'c4d-highcpu-4' });
  assert.deepEqual(samplePlacement(NEW_CFG, { region: 'us-central1' }), { placement: NEW_CFG.placements[1], machine: 'c3d-highcpu-4' });
  assert.equal(samplePlacement(NEW_CFG, { region: 'us-central1', machine: 'c3d-highcpu-8' }).machine, 'c3d-highcpu-8');
  assert.throws(() => samplePlacement(NEW_CFG, { region: 'europe-west1' }), /no placement in europe-west1/);
});

// Review (M6 placements, P2): two placements share us-central1 (C4D first, C3D after); a requested machine picks the
// placement that names it, so a C3D sample boots on C3D's pd-balanced, never on C4D's Hyperdisk.
test('in a region two placements share, the machine or --family picks the placement', () => {
  assert.deepEqual(samplePlacement(M6_CFG, { region: 'us-central1' }), { placement: C4D_CENTRAL, machine: 'c4d-highcpu-4' }, 'the region\'s first');
  assert.deepEqual(samplePlacement(M6_CFG, { region: 'us-central1', machine: 'c3d-highcpu-4' }), { placement: CENTRAL, machine: 'c3d-highcpu-4' });
  assert.deepEqual(samplePlacement(M6_CFG, { region: 'us-central1', family: 'c3d' }), { placement: CENTRAL, machine: 'c3d-highcpu-4' });
  assert.deepEqual(samplePlacement(M6_CFG, { region: 'us-central1', family: 'c3d', machine: 'c3d-highcpu-16' }).placement, CENTRAL);
  assert.equal(samplePlacement(M6_CFG, { machine: 'c3d-highcpu-8' }).placement.region, 'us-central1', 'no region: the first placement naming it');
  assert.throws(() => samplePlacement(M6_CFG, { region: 'us-east5', machine: 'c3d-highcpu-4' }), /no placement in us-east5 names c3d-highcpu-4/);
  assert.throws(() => samplePlacement(M6_CFG, { region: 'us-east5', family: 'c3d' }), /no c3d placement in us-east5/);
  assert.throws(() => samplePlacement(M6_CFG, { family: 'c4d', machine: 'c3d-highcpu-4' }), /no c4d placement names c3d-highcpu-4/);
});

// Review (M3, P2): an insert accepted whose wait then failed, or a runner registered whose response was lost, leaves
// the sample nothing to address them by; the cleanup finds them by the run's label and the runner's name, as the
// bake's does, and a 404 counts as done.
test('a sample\'s cleanup deletes its VMs by the run\'s label and unregisters its runner by name when the id was lost', async () => {
  const calls = [];
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  const gce = {
    instances: async (filter) => {
      calls.push(`list ${filter}`);
      return [
        { name: 'ci-kit-gce-builder-r1-sample00-check', zone: 'https://x/zones/us-west4-b', labels: { 'ci-kit': 'gce-builder', 'ci-kit-run': 'r1' } },
        { name: 'ci-kit-gce-builder-r2-sample00-check', zone: 'https://x/zones/us-west4-a', labels: { 'ci-kit': 'gce-builder', 'ci-kit-run': 'r2' } },
      ];
    },
    deleteInstance: async (zone, name) => { calls.push(`delete ${name}@${zone}`); },
  };
  const gh = {
    runners: async () => [{ id: 7, name: 'ci-kit-bake-r1' }, { id: 8, name: 'ci-kit-bake-r2' }],
    deleteRunner: async (_repo, id) => { calls.push(`unregister ${id}`); throw notFound(); },
  };
  await cleanUpSample({ gce, gh, runId: 'r1', runner: { name: 'ci-kit-bake-r1', id: null }, run: null, log: () => {}, sleep: async () => {} });
  assert.deepEqual(calls, ['list labels.ci-kit=gce-builder', 'delete ci-kit-gce-builder-r1-sample00-check@us-west4-b', 'unregister 7']);
});

test('a sample\'s check VM takes the configured egress: no external address under egress "nat", one by default', async () => {
  for (const [egress, external] of [['nat', false], ['external', true]]) {
    const cfg = { ...NEW_CFG, egress };
    let body = null;
    const gce = {
      insertInstance: async (_zone, b) => { body = b; throw new Error('stop after the insert'); },
      instances: async () => [], deleteInstance: async () => {},
    };
    const gh = {
      jitConfig: async () => ({ runner: { id: 7 }, encoded_jit_config: 'jit' }),
      dispatchWorkflow: async () => ({ workflow_run_id: 9 }),
      getRun: async () => ({ status: 'completed' }), deleteRunner: async () => {},
    };
    await assert.rejects(sample({ gce, gh, cfg, placement: cfg.placements[0], project: 'p', image: 'img', machine: 'c4d-highcpu-4',
      token: async () => 't', out: '/tmp', log: () => {} }), /stop after the insert/);
    assert.equal(Boolean(body.networkInterfaces[0].accessConfigs?.length), external, egress);
  }
});
