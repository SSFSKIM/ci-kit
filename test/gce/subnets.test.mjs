// The subnetworks gce/deploy.sh network creates (gce/subnets.mjs): one per placement of gce.json, each given the first
// free /20 of the kit's 10.64.0.0/16, so a new placement needs no edit to the script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { subnetsOf, freeRange } from '../../gce/subnets.mjs';
import { NEW_CFG } from './config-fixtures.mjs';

test('one subnetwork per placement, named with its region, once however many placements share it', () => {
  assert.deepEqual(subnetsOf(NEW_CFG), [{ name: 'ci-kit-us-west4', region: 'us-west4' }, { name: 'ci-kit-us-central1', region: 'us-central1' }]);
  const twice = { placements: [...NEW_CFG.placements, { ...NEW_CFG.placements[0], machines: {} }] };
  assert.equal(subnetsOf(twice).length, 2);
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

test('the script entry prints the shipped config\'s subnetworks and the free range', () => {
  const cli = (...args) => execFileSync('node', [new URL('../../gce/subnets.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const shipped = JSON.parse(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
  assert.deepEqual(cli('list').trim().split('\n'), [...new Map(shipped.placements.map((p) => [p.subnetwork, `${p.subnetwork} ${p.region}`])).values()]);
  assert.equal(cli('free', '10.64.0.0/20').trim(), '10.64.16.0/20');
  assert.throws(() => cli('free', '10.64.0.0/16'), /no free/);
});
