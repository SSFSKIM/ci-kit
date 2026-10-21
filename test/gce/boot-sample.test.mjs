// The boot sampler's arithmetic (gce/tools/boot-sample.mjs, spec M3 The boot): each sample's stages, and each arm's
// median and range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stagesOf, summarize, samplePlacement } from '../../gce/tools/boot-sample.mjs';
import { NEW_CFG } from './config-fixtures.mjs';

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
