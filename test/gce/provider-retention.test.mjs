import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './fake-world.mjs';
import { createGceLedger, WINDOW_MS, ROTATE_AT } from '../../gce/launcher/ledger-store.mjs';
import { launchRow } from '../../gce/launcher/ledger.mjs';
import { ONE_REGION_CFG } from './config-fixtures.mjs';

test('non-final rows survive aging, rotation and a cold reader during a multi-day outage', async () => {
  const start = Date.parse('2026-10-23T12:00:00Z');
  const w = world({ start });
  const config = ONE_REGION_CFG.ledger;
  const store = createGceLedger(w.github, config, { now: w.now });
  await store.read();
  await store.upsert(launchRow({ alloc: 'held', repo: 'o/r', cpus: 8, reserved: 8, provider: 'ec2', account: 'a', at: start, config: 'test' }));
  const issue = w.gh.issues[0];
  issue.comments = ROTATE_AT;
  w.advance(WINDOW_MS * 3);
  await store.read();
  assert.equal((await store.rows()).find((r) => r.alloc === 'held')?.reserved, 8);
  const cold = createGceLedger(w.github, config, { now: w.now });
  await cold.read();
  assert.equal((await cold.rows()).find((r) => r.alloc === 'held')?.reserved, 8);
  assert.notEqual(issue.state, 'closed', 'an issue retaining non-final allocations cannot retire');
});
