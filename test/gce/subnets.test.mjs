// The subnetworks gce/deploy.sh network creates (gce/subnets.mjs): one per placement of gce.json, each given the first
// free /20 of the kit's 10.64.0.0/16, so a new placement needs no edit to the script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { subnetsOf, freeRange } from '../../gce/subnets.mjs';
import { NEW_CFG, M6_CFG } from './config-fixtures.mjs';

test('one subnetwork per placement, named with its region, once however many placements share it', () => {
  assert.deepEqual(subnetsOf(NEW_CFG), [{ name: 'ci-kit-us-west4', region: 'us-west4' }, { name: 'ci-kit-us-central1', region: 'us-central1' }]);
  const twice = { placements: [...NEW_CFG.placements, { ...NEW_CFG.placements[0], machines: {} }] };
  assert.equal(subnetsOf(twice).length, 2);
});

test('the same subnetwork name in two regions is two subnetworks', () => {
  const [west, central] = NEW_CFG.placements;
  const shared = { placements: [{ ...west, subnetwork: 'ci-kit-pool' }, { ...central, subnetwork: 'ci-kit-pool' }] };
  assert.deepEqual(subnetsOf(shared), [{ name: 'ci-kit-pool', region: 'us-west4' }, { name: 'ci-kit-pool', region: 'us-central1' }]);
});

test('the first free /20 of 10.64.0.0/16: after us-central1\'s, skipping any range that overlaps a taken one', () => {
  assert.equal(freeRange([]), '10.64.0.0/20');
  assert.equal(freeRange(['10.64.0.0/20']), '10.64.16.0/20');
  assert.equal(freeRange(['10.64.0.0/20', '10.64.16.0/20']), '10.64.32.0/20');
  assert.equal(freeRange(['10.64.0.0/24', '10.64.20.0/22']), '10.64.32.0/20', 'a small range blocks the /20 that holds it');
  assert.equal(freeRange(['10.64.0.0/16']), null, 'nothing is left');
  assert.equal(freeRange(['10.0.0.0/8']), null, 'an enclosing range blocks all');
  assert.equal(freeRange(['192.168.0.0/16', '10.200.0.0/20']), '10.64.0.0/20', 'ranges elsewhere do not matter');
});

// What deploy.sh network does with M6's placements on today's network (us-central1 10.64.0.0/20 and us-west4
// 10.64.16.0/20, gcloud compute networks subnets list on 2026-10-21): each subnetwork that exists is left as it is, and
// each new one takes the first /20 free of every range already there, in the order the placements name them.
function plan(cfg, existing) {
  const taken = [...existing];
  return subnetsOf(cfg).map(({ name, region }) => {
    const have = taken.find((s) => s.name === name && s.region === region);
    if (have) return { ...have, created: false };
    const range = freeRange(taken.map((s) => s.range));
    taken.push({ name, region, range });
    return { name, region, range, created: true };
  });
}

test('M6\'s placements: one subnetwork per region, the two that exist kept, the three new ones on the next free /20s', () => {
  const today = [{ name: 'ci-kit-us-central1', region: 'us-central1', range: '10.64.0.0/20' }, { name: 'ci-kit-us-west4', region: 'us-west4', range: '10.64.16.0/20' }];
  assert.deepEqual(plan(M6_CFG, today), [
    { name: 'ci-kit-us-west4', region: 'us-west4', range: '10.64.16.0/20', created: false },
    { name: 'ci-kit-us-central1', region: 'us-central1', range: '10.64.0.0/20', created: false },
    { name: 'ci-kit-us-east1', region: 'us-east1', range: '10.64.32.0/20', created: true },
    { name: 'ci-kit-us-east4', region: 'us-east4', range: '10.64.48.0/20', created: true },
    { name: 'ci-kit-us-east5', region: 'us-east5', range: '10.64.64.0/20', created: true },
  ]);
});

test('the script entry prints the shipped config\'s subnetworks and the free range', () => {
  const cli = (...args) => execFileSync('node', [new URL('../../gce/subnets.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const shipped = JSON.parse(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
  assert.deepEqual(cli('list').trim().split('\n'), [...new Map(shipped.placements.map((p) => [p.subnetwork, `${p.subnetwork} ${p.region}`])).values()]);
  assert.equal(cli('free', '10.64.0.0/20').trim(), '10.64.16.0/20');
  assert.throws(() => cli('free', '10.64.0.0/16'), /no free/);
});
