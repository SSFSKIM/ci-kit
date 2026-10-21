// gce/deploy.sh against a fake gcloud (fake-gcloud.mjs). network: for every placement region of the shipped gce.json, a
// subnetwork with Private Google Access, and a Cloud Router with a Cloud NAT (spec 2026-10-21 M6: job and bake VMs have
// no external address); what exists is converged and kept, never deleted; an ingress rule on the network still stops
// it. alert: the log-based metrics and the policies that mail the owner, A13's and M6's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGceConfig } from '../../gce/launcher/config.mjs';
import { subnetsOf } from '../../gce/subnets.mjs';

const SCRIPT = fileURLToPath(new URL('../../gce/deploy.sh', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-gcloud.mjs', import.meta.url));
const SHIPPED = subnetsOf(parseGceConfig(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8')));
const REGIONS = [...new Set(SHIPPED.map((s) => s.region))];

const NAT_FLAGS = [
  '--auto-allocate-nat-external-ips', '--nat-all-subnet-ip-ranges',
  '--enable-dynamic-port-allocation', '--no-enable-endpoint-independent-mapping', '--min-ports-per-vm=1024', '--max-ports-per-vm=65536',
  '--enable-logging', '--log-filter=ERRORS_ONLY',
];

// Runs `deploy.sh <part>` against `state`: {status, stderr, calls (each an argv), state (after)}.
function deploy(part, state) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-kit-deploy-'));
  try {
    const gcloud = join(dir, 'gcloud');
    writeFileSync(gcloud, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(gcloud, 0o755);
    const files = { FAKE_GCLOUD_STATE: join(dir, 'state.json'), FAKE_GCLOUD_LOG: join(dir, 'calls') };
    const empty = { network: false, subnets: [], routers: [], nats: [], firewall: [], metrics: [], channel: null, policies: [] };
    writeFileSync(files.FAKE_GCLOUD_STATE, JSON.stringify({ ...empty, ...state }));
    writeFileSync(files.FAKE_GCLOUD_LOG, '');
    const path = [dir, dirname(process.execPath), process.env.PATH].join(':');
    const run = spawnSync('bash', [SCRIPT, part], { encoding: 'utf8', env: { ...process.env, ...files, PATH: path }, timeout: 30_000 });
    const calls = readFileSync(files.FAKE_GCLOUD_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { status: run.status, stderr: run.stderr, calls, state: JSON.parse(readFileSync(files.FAKE_GCLOUD_STATE, 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const network = (state) => deploy('network', state);
const verb = (calls, ...words) => calls.filter((c) => words.every((w, i) => c[i] === w));

test('a new network: each placement region gets its subnetwork with Private Google Access, a Cloud Router and a Cloud NAT', () => {
  const run = network({});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(verb(run.calls, 'compute', 'networks', 'create').length, 1);
  for (const { name, region } of SHIPPED) {
    const [create] = verb(run.calls, 'compute', 'networks', 'subnets', 'create', name).filter((c) => c.includes(`--region=${region}`));
    assert.ok(create?.includes('--enable-private-ip-google-access'), `${name} is created with Private Google Access`);
  }
  for (const region of REGIONS) {
    assert.deepEqual(verb(run.calls, 'compute', 'routers', 'create').filter((c) => c.includes(`--region=${region}`)),
      [['compute', 'routers', 'create', 'ci-kit-router', '--network=ci-kit', `--region=${region}`, '--description=ci-kit: Cloud NAT for pool and bake VMs, which have no external address']]);
    assert.deepEqual(verb(run.calls, 'compute', 'routers', 'nats', 'create').filter((c) => c.includes(`--region=${region}`)),
      [['compute', 'routers', 'nats', 'create', 'ci-kit-nat', '--router=ci-kit-router', `--region=${region}`, ...NAT_FLAGS]]);
  }
  assert.deepEqual(run.state.nats.sort(), [...REGIONS].sort());
  assert.ok(run.state.subnets.every((s) => s.pga));
  assert.equal(run.stderr, '');
});

test('an existing network is converged, never rebuilt: Private Google Access turned on, the NAT updated to the same settings, nothing deleted', () => {
  const subnets = SHIPPED.map((s, i) => ({ ...s, range: `10.64.${16 * i}.0/20`, pga: false }));
  const run = network({ network: true, subnets, routers: REGIONS, nats: REGIONS });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls.filter((c) => c.includes('create')), [], 'nothing is created');
  assert.deepEqual(run.calls.filter((c) => c.includes('delete')), [], 'nothing is deleted');
  for (const { name, region } of SHIPPED) {
    assert.deepEqual(verb(run.calls, 'compute', 'networks', 'subnets', 'update', name).filter((c) => c.includes(`--region=${region}`)),
      [['compute', 'networks', 'subnets', 'update', name, `--region=${region}`, '--enable-private-ip-google-access']]);
  }
  for (const region of REGIONS) {
    assert.deepEqual(verb(run.calls, 'compute', 'routers', 'nats', 'update').filter((c) => c.includes(`--region=${region}`)),
      [['compute', 'routers', 'nats', 'update', 'ci-kit-nat', '--router=ci-kit-router', `--region=${region}`, ...NAT_FLAGS]]);
  }
  assert.deepEqual(run.state.subnets.map((s) => s.range), subnets.map((s) => s.range), 'the ranges are left as they are');
});

test('a subnetwork that has Private Google Access already is not updated', () => {
  const subnets = SHIPPED.map((s, i) => ({ ...s, range: `10.64.${16 * i}.0/20`, pga: true }));
  const run = network({ network: true, subnets, routers: REGIONS, nats: REGIONS });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(verb(run.calls, 'compute', 'networks', 'subnets', 'update'), []);
});

// Today's network (2026-10-21): us-central1 and us-west4 have their subnetworks, routers and NATs. The shipped
// placements' other regions get theirs, each on its own /20 after those two; what exists is not touched.
test('today\'s network and the shipped placements: the two subnetworks that exist kept, each new region on the next free /20', () => {
  const today = [
    { name: 'ci-kit-us-central1', region: 'us-central1', range: '10.64.0.0/20', pga: true },
    { name: 'ci-kit-us-west4', region: 'us-west4', range: '10.64.16.0/20', pga: true },
  ];
  const run = network({ network: true, subnets: today, routers: ['us-central1', 'us-west4'], nats: ['us-central1', 'us-west4'] });
  assert.equal(run.status, 0, run.stderr);
  const created = verb(run.calls, 'compute', 'networks', 'subnets', 'create').map((c) => c[4]).sort();
  assert.deepEqual(created, SHIPPED.filter((s) => !today.some((t) => t.name === s.name && t.region === s.region)).map((s) => s.name).sort());
  assert.deepEqual(verb(run.calls, 'compute', 'networks', 'subnets', 'update'), [], 'the two that exist are left as they are');
  assert.deepEqual(run.state.subnets.slice(0, 2), today);
  const ranges = run.state.subnets.map((s) => s.range);
  assert.equal(new Set(ranges).size, ranges.length, 'no two subnetworks share a range');
  assert.deepEqual(ranges.slice(2).sort(), ['10.64.32.0/20', '10.64.48.0/20', '10.64.64.0/20']);
  assert.deepEqual(run.state.nats.sort(), [...REGIONS].sort(), 'a router and NAT in each new region');
});

test('a rule allowing ingress into the network still stops the deploy', () => {
  const run = network({ firewall: ['ci-kit-ssh\tci-kit\tINGRESS\tFalse\ttcp:22', 'default-ssh\tdefault\tINGRESS\tFalse\ttcp:22'] });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /network ci-kit has rules allowing ingress: ci-kit-ssh/);
});

// A manual rollback pins a service's traffic to an older revision (update-traffic --to-revisions=<old>=100); a later
// `gcloud run deploy` then creates the new revision at 0%, and the deploy used to report ok. Each service's deploy
// sends all traffic to its latest ready revision and checks that revision serves.
const pinned = (name) => ({ revisions: 1, latestReady: `${name}-00001-old`, traffic: [{ revisionName: `${name}-00001-old`, percent: 100, latestRevision: false }] });
for (const [part, service] of [['launcher', 'ci-kit-launcher'], ['webhook', 'ci-kit-webhook']]) {
  test(`${part}: traffic pinned to an older revision moves to the one just deployed`, () => {
    const run = deploy(part, { services: { 'ci-kit-launcher': pinned('ci-kit-launcher'), 'ci-kit-webhook': pinned('ci-kit-webhook') } });
    assert.equal(run.status, 0, run.stderr);
    const svc = run.state.services[service];
    assert.deepEqual(svc.traffic, [{ revisionName: `${service}-00002-new`, percent: 100, latestRevision: true }]);
    assert.ok(verb(run.calls, 'run', 'services', 'update-traffic', service).some((c) => c.includes('--to-latest')));
  });

  test(`${part}: a deploy whose revision does not serve fails, naming what does`, () => {
    const run = deploy(part, { services: { 'ci-kit-launcher': { ...pinned('ci-kit-launcher'), stuck: true }, 'ci-kit-webhook': { ...pinned('ci-kit-webhook'), stuck: true } } });
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`${service}: its latest revision ${service}-00002-new does not serve all traffic: ${service}-00001-old 100%`));
  });
}

test('alert: each failure the owner is mailed for has its log-based metric and a policy on it, on one channel', () => {
  const run = deploy('alert', {});
  assert.equal(run.status, 0, run.stderr);
  const filters = Object.fromEntries(run.state.metrics.map((m) => [m.name, m.filter]));
  assert.deepEqual(Object.keys(filters), ['ci-kit-launcher-tick-failed', 'ci-kit-runner-never-online', 'ci-kit-nat-dropped']);
  assert.equal(filters['ci-kit-launcher-tick-failed'],
    'resource.type="cloud_scheduler_job" AND resource.labels.job_id="ci-kit-launcher-tick" AND severity>=ERROR');
  // What the launcher logs for a VM whose runner never came online (launcher.mjs reportNeverOnline).
  assert.equal(filters['ci-kit-runner-never-online'],
    'resource.type="cloud_run_revision" AND resource.labels.service_name="ci-kit-launcher" AND severity>=ERROR AND jsonPayload.event="runner-never-online"');
  // A connection a NAT dropped (logged by its ERRORS_ONLY filter: out of ports, or no address to allocate).
  assert.equal(filters['ci-kit-nat-dropped'],
    'resource.type="nat_gateway" AND resource.labels.gateway_name="ci-kit-nat" AND jsonPayload.allocation_status="DROPPED"');
  const policies = Object.fromEntries(run.state.policies.map((p) => [p.conditions[0].conditionThreshold.filter, p]));
  const on = (metric, resource) => policies[`metric.type="logging.googleapis.com/user/${metric}" AND resource.type="${resource}"`];
  assert.equal(on('ci-kit-launcher-tick-failed', 'cloud_scheduler_job').conditions[0].conditionThreshold.thresholdValue, 2, 'three failed ticks');
  assert.equal(on('ci-kit-runner-never-online', 'cloud_run_revision').conditions[0].conditionThreshold.thresholdValue, 0, 'any');
  assert.equal(on('ci-kit-nat-dropped', 'nat_gateway').conditions[0].conditionThreshold.thresholdValue, 0, 'any');
  assert.equal(run.state.policies.length, 3);
  for (const p of run.state.policies) {
    assert.deepEqual(p.notificationChannels, [run.state.channel]);
    assert.deepEqual(p.userLabels, { 'ci-kit': 'alert' });
    assert.equal(p.conditions[0].conditionThreshold.aggregations[0].alignmentPeriod, '600s');
    assert.ok(p.documentation.content.length > 0);
  }
});

test('alert: run again, it creates nothing', () => {
  const first = deploy('alert', {});
  const again = deploy('alert', first.state);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.calls.filter((c) => c.includes('create')), []);
});
