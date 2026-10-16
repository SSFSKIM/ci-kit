// Ensure's branches (spec §3 Ensure, I7) against a fake Hetzner API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensure, ensureDecision, candidates, newestImage, backendOf, kitConfig, kitRepos, ensureForCaller } from '../../pool/lib/ensure.mjs';
import { fakeHcloud, deletes } from './fake-hcloud.mjs';

const CFG = { types: ['cx53', 'cpx62'], fallback_types: ['cpx52', 'cpx42'], locations: ['hel1', 'fsn1', 'nbg1'] };
// server_types as the API lists them (2026-10-15: cx53 available nowhere; cpx62 in fsn1, nbg1, hel1, sin).
const loc = (name, available = true) => ({ name, available });
const TYPES = [
  { name: 'cx53', locations: [loc('hel1', false), loc('fsn1', false), loc('nbg1', false)] },
  { name: 'cpx62', locations: [loc('fsn1'), loc('nbg1'), loc('hel1'), loc('sin')] },
  { name: 'cx23', locations: [loc('hel1')] },
  { name: 'cpx52', locations: [loc('hel1'), loc('fsn1'), loc('nbg1')] },
  { name: 'cpx42', locations: [loc('hel1'), loc('fsn1'), loc('nbg1')] },
];
const IMAGE = { id: 301, type: 'snapshot', status: 'available', labels: { 'ci-kit': 'pool-image', 'ci-kit-commit': 'abc' }, created: '2026-10-15T20:00:00Z' };
const FIREWALL = { id: 401, name: 'ci-kit-pool', labels: { 'ci-kit': 'pool' } };
const pool = (state, id = 1) => ({ id, name: 'ci-kit-pool', labels: { 'ci-kit': 'pool', 'ci-kit-state': state }, created: '2026-10-15T22:00:00Z' });
const opts = () => {
  let clock = Date.parse('2026-10-15T23:00:00Z');
  return { sleep: async (ms) => { clock += ms; }, now: () => clock, log: () => {} };
};

test('ensure decides from the pool servers: booting or ready is done, draining waits, none creates', () => {
  assert.equal(ensureDecision([]), 'create');
  assert.equal(ensureDecision([pool('booting')]), 'existing');
  assert.equal(ensureDecision([pool('ready')]), 'existing');
  assert.equal(ensureDecision([pool('draining')]), 'wait');
});

test('candidates walk the type preference, then the location preference, skipping what server_types marks unavailable', () => {
  assert.deepEqual(candidates(CFG, TYPES), [
    { type: 'cpx62', location: 'hel1' }, { type: 'cpx62', location: 'fsn1' }, { type: 'cpx62', location: 'nbg1' },
  ]);
});

test('the newest available snapshot labelled ci-kit=pool-image is the image', () => {
  const images = [
    { ...IMAGE, id: 1, created: '2026-10-01T00:00:00Z' },
    { ...IMAGE, id: 2, created: '2026-10-10T00:00:00Z' },
    { ...IMAGE, id: 3, created: '2026-10-12T00:00:00Z', status: 'creating' },
    { ...IMAGE, id: 4, created: '2026-10-14T00:00:00Z', labels: { other: 'x' } },
  ];
  assert.equal(newestImage(images).id, 2);
});

test('an existing pool box is reported and nothing is created', async () => {
  const hc = fakeHcloud({ servers: [pool('ready')], images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES });
  assert.equal(await ensure(hc, CFG, opts()), 'existing');
  assert.ok(!hc.calls.some((c) => c.startsWith('create')));
});

test('no pool server: the box is created from the snapshot with the firewall and the booting labels', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES });
  assert.equal(await ensure(hc, CFG, opts()), 'created:cpx62@hel1');
  const made = hc.state.servers.at(-1);
  assert.deepEqual(
    { name: made.name, image: made.image, firewalls: made.firewalls, labels: made.labels },
    { name: 'ci-kit-pool', image: 301, firewalls: [{ firewall: 401 }], labels: { 'ci-kit': 'pool', 'ci-kit-state': 'booting', 'ci-kit-want': '1792105200' } },
  );
});

test('resource_unavailable (or placement_error) moves on to the next type and location pair', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES, createErrors: ['resource_unavailable', 'placement_error'] });
  assert.equal(await ensure(hc, CFG, opts()), 'created:cpx62@nbg1');
  assert.deepEqual(hc.calls.filter((c) => c.startsWith('create')), ['create cpx62@hel1', 'create cpx62@fsn1', 'create cpx62@nbg1']);
});

test('every pair unavailable fails, naming what was tried', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES, createErrors: ['resource_unavailable', 'resource_unavailable', 'resource_unavailable'] });
  await assert.rejects(ensure(hc, CFG, opts()), /no pool server type is available: cpx62@hel1, cpx62@fsn1, cpx62@nbg1/);
});

test('a uniqueness_error means a concurrent ensure won: raced, and treated as done', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES, createErrors: ['uniqueness_error'] });
  hc.createServer = async (spec) => {
    hc.calls.push('create');
    hc.state.servers.push(pool('booting', 99));
    const { HcloudError } = await import('../../lib/hcloud.mjs');
    throw new HcloudError(409, 'uniqueness_error', 'name is already used');
  };
  assert.equal(await ensure(hc, CFG, opts()), 'raced');
});

test('a draining box is waited out, then a new one is created', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES, serverSeq: [[pool('draining')], [pool('draining')], []] });
  assert.equal(await ensure(hc, CFG, opts()), 'created:cpx62@hel1');
});

test('a missing firewall is created, labelled, with no inbound rules', async () => {
  const hc = fakeHcloud({ images: [IMAGE], serverTypes: TYPES });
  await ensure(hc, CFG, opts());
  const fw = hc.state.firewalls.at(-1);
  assert.deepEqual({ name: fw.name, labels: fw.labels, rules: fw.rules }, { name: 'ci-kit-pool', labels: { 'ci-kit': 'pool' }, rules: [] });
  assert.deepEqual(hc.state.servers.at(-1).firewalls, [{ firewall: 6000 }]);
});

test('no pool snapshot is an error that says to bake', async () => {
  const hc = fakeHcloud({ firewalls: [FIREWALL], serverTypes: TYPES });
  await assert.rejects(ensure(hc, CFG, opts()), /no snapshot labelled ci-kit=pool-image.*bake/);
});

test('unlabelled resources are never used or touched, even when they match by name: an unlabelled server named ci-kit-pool is not "existing", and an unlabelled snapshot or firewall is not used', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES });
  assert.equal(await ensure(hc, CFG, opts()), 'created:cpx62@hel1');
  const made = hc.state.servers.at(-1);
  assert.equal(made.image, 301);
  assert.deepEqual(made.firewalls, [{ firewall: 401 }]);
  assert.deepEqual(deletes(hc), []);
});

test('a name clash with a server that is not a pool box is an error, not a race', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES, createErrors: ['uniqueness_error'] });
  await assert.rejects(ensure(hc, CFG, opts()), /named ci-kit-pool exists without the ci-kit=pool label/);
  assert.deepEqual(deletes(hc), []);
});

test('the core limit (Hetzner: 403 resource_limit_exceeded) moves on to the fallback types, labels the box, and warns', async () => {
  // Seen live 2026-10-15: "hcloud POST /servers: 403 resource_limit_exceeded (shared core limit exceeded)".
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES, createErrors: ['resource_limit_exceeded'] });
  const warnings = [];
  assert.equal(await ensure(hc, CFG, { ...opts(), warn: (m) => warnings.push(m) }), 'created:cpx52@hel1');
  // The limit is the project's, so the other locations of a type that is too big are not tried.
  assert.deepEqual(hc.calls.filter((c) => c.startsWith('create')), ['create cpx62@hel1', 'create cpx52@hel1']);
  assert.deepEqual(hc.state.servers.at(-1).labels, { 'ci-kit': 'pool', 'ci-kit-state': 'booting', 'ci-kit-fallback': 'core-limit', 'ci-kit-want': '1792105200' });
  assert.match(warnings.join('\n'), /core limit.*cpx62.*cpx52/);
});

test('the fallback walks down: cpx52 refused for the limit too gives cpx42', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES, createErrors: ['resource_limit_exceeded', 'resource_limit_exceeded'] });
  assert.equal(await ensure(hc, CFG, opts()), 'created:cpx42@hel1');
  assert.deepEqual(hc.calls.filter((c) => c.startsWith('create')), ['create cpx62@hel1', 'create cpx52@hel1', 'create cpx42@hel1']);
});

test('every type refused for the core limit fails naming the limit', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES, createErrors: ['resource_limit_exceeded', 'resource_limit_exceeded', 'resource_limit_exceeded'] });
  await assert.rejects(ensure(hc, CFG, opts()), /core limit.*cpx62, cpx52, cpx42/);
});

test('fallback types are not tried for stock: a preferred type out of stock everywhere fails as before', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES, createErrors: ['resource_unavailable', 'resource_unavailable', 'resource_unavailable'] });
  await assert.rejects(ensure(hc, CFG, opts()), /no pool server type is available/);
  assert.ok(!hc.calls.some((c) => c.includes('cpx52')));
});

test('two first ensures racing on the firewall: the loser re-lists and uses the winner\'s labelled firewall', async () => {
  const hc = fakeHcloud({ images: [IMAGE], serverTypes: TYPES });
  hc.createFirewall = async () => {
    hc.state.firewalls.push({ ...FIREWALL, id: 402 }); // the other ensure's create landed first
    const { HcloudError } = await import('../../lib/hcloud.mjs');
    throw new HcloudError(409, 'uniqueness_error', 'name is already used');
  };
  assert.equal(await ensure(hc, CFG, opts()), 'created:cpx62@hel1');
  assert.deepEqual(hc.state.servers.at(-1).firewalls, [{ firewall: 402 }]);
});

test('a firewall name taken by a foreign, unlabelled firewall is refused, not used', async () => {
  const hc = fakeHcloud({ images: [IMAGE], serverTypes: TYPES });
  hc.createFirewall = async () => {
    hc.state.firewalls.push({ id: 403, name: 'ci-kit-pool', labels: {} });
    const { HcloudError } = await import('../../lib/hcloud.mjs');
    throw new HcloudError(409, 'uniqueness_error', 'name is already used');
  };
  await assert.rejects(ensure(hc, CFG, opts()), /firewall named ci-kit-pool exists without the ci-kit=pool label/);
  assert.ok(!hc.calls.some((c) => c.startsWith('create ')));
});

test('ensure stamps ci-kit-want on an existing box, keeping its other labels (read-modify-write)', async () => {
  const box = { ...pool('ready', 7), labels: { 'ci-kit': 'pool', 'ci-kit-state': 'ready', 'ci-kit-heartbeat': '1792100000', 'ci-kit-fallback': 'core-limit' } };
  const hc = fakeHcloud({ servers: [box], images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES });
  const o = opts();
  assert.equal(await ensure(hc, CFG, o), 'existing');
  const labels = hc.state.servers.find((s) => s.id === 7).labels;
  assert.deepEqual(labels, { ...box.labels, 'ci-kit-want': String(Math.floor(o.now() / 1000)) });
});

test('a box ensure creates carries ci-kit-want from the start', async () => {
  const hc = fakeHcloud({ images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES });
  const o = opts();
  await ensure(hc, CFG, o);
  assert.equal(hc.state.servers.at(-1).labels['ci-kit-want'], String(Math.floor(o.now() / 1000)));
});

test('ensure stamps a draining box too, so its agent can return it to ready instead of a new box booting', async () => {
  const draining = pool('draining', 8);
  const hc = fakeHcloud({ servers: [draining], images: [IMAGE], firewalls: [FIREWALL], serverTypes: TYPES });
  const realServers = hc.servers;
  let calls = 0;
  hc.servers = async (sel) => {
    calls += 1;
    // The agent undrains once it sees the stamp.
    if (calls > 1) hc.state.servers.find((s) => s.id === 8).labels['ci-kit-state'] = 'ready';
    return realServers(sel);
  };
  assert.equal(await ensure(hc, CFG, opts()), 'existing');
  assert.ok(hc.state.servers.find((s) => s.id === 8).labels['ci-kit-want']);
  assert.ok(!hc.calls.some((c) => c.startsWith('create ')));
});

// Which backend serves the calling repo (spec §3a, Which backend serves a repo; I12): ensure wakes a Hetzner box only
// for a repo in pool.json, so a repo in transit between backends never wakes a box that would not serve it.
const SBX = 'SSFSKIM/ci-kit-sandbox';
const MAWS = 'SSFSKIM/MAWS';

test('backendOf: hetzner for a pool.json repo, gce for a gce.json repo, none for a repo in neither', () => {
  assert.equal(backendOf(SBX, [SBX, MAWS], []), 'hetzner');
  assert.equal(backendOf(MAWS, [SBX], [MAWS]), 'gce');
  assert.equal(backendOf(MAWS, [SBX], []), 'none');
  assert.equal(backendOf('ssfskim/maws', [MAWS], []), 'hetzner'); // GitHub names are case-insensitive
});

test('backendOf: a repo in both files is gce, the check §3a names first (the config test refuses that state)', () => {
  assert.equal(backendOf(MAWS, [MAWS], [MAWS]), 'gce');
});

test('kitConfig reads the file on the kit\'s main, else the bundled copy, else null', async () => {
  const parse = (t) => JSON.parse(t);
  const fails = async () => { throw new Error('GET: 503'); };
  assert.deepEqual(await kitConfig(parse, { fetchMain: async () => '{"at":"main"}', readBundled: async () => '{"at":"bundled"}' }), { at: 'main' });
  assert.deepEqual(await kitConfig(parse, { fetchMain: fails, readBundled: async () => '{"at":"bundled"}' }), { at: 'bundled' });
  // main's copy does not parse with this version's parser: the bundled one is used
  assert.deepEqual(await kitConfig(parse, { fetchMain: async () => 'not json', readBundled: async () => '{"at":"bundled"}' }), { at: 'bundled' });
  assert.equal(await kitConfig(parse, { fetchMain: fails, readBundled: fails }), null);
});

// Repo membership comes from main whenever main answered (review of PR #17): a main copy that the bundled operational
// parser rejects must not bring the bundled list (and a repo main has removed) back.
const httpFail = (status) => async () => { throw Object.assign(new Error(`GET: ${status}`), { status }); };
const file = (obj) => async () => JSON.stringify(obj);
const POOL_MAIN_AHEAD = { repos: [{ repo: SBX }], types: ['cpx62'] }; // MAWS removed, and no `workflows`: I8 moved on
const POOL_BUNDLED = { repos: [{ repo: SBX, workflows: ['ci.yml'] }, { repo: MAWS, workflows: ['gate.yml'] }] };

test('kitRepos: main\'s repos decide even when the bundled parser would reject main\'s copy', async () => {
  assert.deepEqual(await kitRepos('pool.json', { fetchMain: file(POOL_MAIN_AHEAD), readBundled: file(POOL_BUNDLED) }), [SBX]);
});

test('kitRepos: main unreachable reads the bundled copy; absent on main (404) or absent everywhere is no repos', async () => {
  assert.deepEqual(await kitRepos('pool.json', { fetchMain: httpFail(503), readBundled: file(POOL_BUNDLED) }), [SBX, MAWS]);
  assert.deepEqual(await kitRepos('gce.json', { fetchMain: httpFail(404), readBundled: file({ repos: [{ repo: MAWS }] }) }), []);
  assert.deepEqual(await kitRepos('gce.json', { fetchMain: httpFail(503), readBundled: async () => null }), []);
});

test('kitRepos: a copy on main whose repos cannot be read refuses, rather than falling back', async () => {
  for (const text of ['not json', '{"repos":"MAWS"}', '{"repos":[{"name":"x"}]}']) {
    await assert.rejects(kitRepos('pool.json', { fetchMain: async () => text, readBundled: file(POOL_BUNDLED) }), /pool\.json on the kit's main/);
  }
});

const CALLER_POOL = { repos: [{ repo: SBX, workflows: ['ci.yml'] }], types: ['cpx62'], locations: ['hel1'] };
const caller = (over = {}) => {
  const made = [];
  return {
    made,
    args: {
      repo: MAWS, token: 'tok',
      pool: { fetchMain: file(CALLER_POOL), readBundled: file(CALLER_POOL) },
      gce: { fetchMain: file({ repos: [{ repo: MAWS }] }), readBundled: async () => null },
      parsePool: (t) => JSON.parse(t),
      createHcloud: (token) => { made.push(token); return fakeHcloud({ servers: [pool('ready')] }); },
      opts: opts(),
      ...over,
    },
  };
};

test('ensureForCaller: a GCE repo, or a repo in neither file, gets gce|none with no Hetzner token and no Hetzner client', async () => {
  const gce = caller({ token: '' });
  assert.equal(await ensureForCaller(gce.args), 'gce');
  const none = caller({ token: undefined, repo: 'SSFSKIM/cua' });
  assert.equal(await ensureForCaller(none.args), 'none');
  assert.deepEqual([...gce.made, ...none.made], []);
});

test('ensureForCaller: a pool repo needs the token, and with it ensures the box', async () => {
  await assert.rejects(ensureForCaller(caller({ repo: SBX, token: ' ' }).args), /HCLOUD_TOKEN/);
  const ok = caller({ repo: SBX });
  assert.equal(await ensureForCaller(ok.args), 'existing');
  assert.deepEqual(ok.made, ['tok']);
});

test('ensureForCaller: a repo main removed from pool.json gets none, though the bundled copy lists it and main\'s does not parse', async () => {
  const c = caller({
    repo: MAWS, gce: { fetchMain: httpFail(404), readBundled: async () => null },
    pool: { fetchMain: file(POOL_MAIN_AHEAD), readBundled: file(POOL_BUNDLED) },
    parsePool: (t) => { const cfg = JSON.parse(t); if (!cfg.repos.every((r) => r.workflows)) throw new Error('workflows'); return cfg; },
  });
  assert.equal(await ensureForCaller(c.args), 'none');
  assert.deepEqual(c.made, []);
});

test('ensureForCaller: an unreadable pool.json on main touches nothing in Hetzner', async () => {
  const c = caller({ repo: SBX, pool: { fetchMain: async () => 'not json', readBundled: file(CALLER_POOL) } });
  await assert.rejects(ensureForCaller(c.args), /pool\.json on the kit's main/);
  assert.deepEqual(c.made, []);
});
