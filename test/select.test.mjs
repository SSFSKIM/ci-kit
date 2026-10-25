import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../plan/config.mjs';
import { selectGates, trailerGates, planOutput } from '../plan/select.mjs';
import { ConfigError } from '../plan/config.mjs';

const config = parseConfig(`
version: 1
setup: {node: "24", install: npm ci}
gates:
  - name: unit
    run: npm test
    paths: ["src/**", "test/**"]
  - name: docs
    run: npm run docs
    paths: ["docs/**"]
  - name: lint
    run: npm run lint
  - name: nightly
    run: npm run slow
    on: [dispatch]
  - name: big
    run: npm run big
    lane: pool
    cpus: 8
    on: [pr, ci-ref]
`, { isPrivate: true });

const names = (gates) => gates.map((g) => g.name);

test('an explicit list wins over paths and on', () => {
  const sel = selectGates(config, { event: 'pr', explicit: ['docs', 'nightly'], changedFiles: ['src/a.js'] });
  assert.deepEqual(names(sel), ['docs', 'nightly']);
});

test('an explicit list keeps config order and drops duplicates', () => {
  const sel = selectGates(config, { event: 'ci-ref', explicit: ['lint', 'unit', 'lint'], changedFiles: [] });
  assert.deepEqual(names(sel), ['unit', 'lint']);
});

test('an unknown name in an explicit list is a config error', () => {
  assert.throws(
    () => selectGates(config, { event: 'ci-ref', explicit: ['unit', 'nope'], explicitSource: 'CI-Gates', changedFiles: [] }),
    (e) => e instanceof ConfigError && e.messages[0] === 'unknown gate "nope" in CI-Gates (known: unit, docs, lint, nightly, big)',
  );
});

test('on a PR, a gate with paths runs only when a changed file matches', () => {
  assert.deepEqual(names(selectGates(config, { event: 'pr', changedFiles: ['src/x.js'] })), ['unit', 'lint', 'big']);
  assert.deepEqual(names(selectGates(config, { event: 'pr', changedFiles: ['docs/a.md'] })), ['docs', 'lint', 'big']);
  assert.deepEqual(names(selectGates(config, { event: 'pr', changedFiles: [] })), ['lint', 'big']);
});

test('on: filtering drops gates not listening for the event', () => {
  assert.deepEqual(names(selectGates(config, { event: 'dispatch', changedFiles: [] })), ['unit', 'docs', 'lint', 'nightly']);
});

test('a dispatch ignores changes', () => {
  assert.deepEqual(names(selectGates(config, { event: 'dispatch', changedFiles: ['README.md'] })), ['unit', 'docs', 'lint', 'nightly']);
});

test('an empty selection is possible', () => {
  const only = parseConfig('version: 1\ngates:\n  - {name: a, run: x, paths: ["a/**"]}\n', { isPrivate: false });
  assert.deepEqual(selectGates(only, { event: 'ci-ref', changedFiles: ['b/c'] }), []);
});

test('trailerGates reads the CI-Gates trailer from the last paragraph', () => {
  assert.deepEqual(trailerGates('ci-gate 0123456789ab\n\nCI-Gates: unit, lint\n'), ['unit', 'lint']);
  assert.deepEqual(trailerGates('ci-gate 0123456789ab\n\nci-gates: unit\n'), ['unit']);
  assert.equal(trailerGates('ci-gate 0123456789ab\n'), null);
  assert.equal(trailerGates('subject\n\nCI-Gates: unit\n\nlater paragraph\n'), null);
  assert.equal(trailerGates(''), null);
});

test('planOutput shapes I3: runs_on per lane, setup resolved, pool flag', () => {
  const out = planOutput(config, selectGates(config, { event: 'ci-ref', explicit: ['unit', 'big'] }));
  assert.deepEqual(out, {
    gates: [
      {
        name: 'unit', run: 'npm test', runs_on: ['ubuntu-latest'], timeout: 30,
        setup: { node: '24', pnpm: false, install: 'npm ci', fetch_depth: 1, apt: [], brew: [], cask: [], script: '' }, artifacts: [], env: {}, build_cache: null,
      },
      {
        name: 'big', run: 'npm run big', runs_on: ['self-hosted', 'ci-kit-pool', 'cpus-8'], timeout: 30,
        setup: { node: '24', pnpm: false, install: 'npm ci', fetch_depth: 1, apt: [], brew: [], cask: [], script: '' }, artifacts: [], env: {}, build_cache: null,
      },
    ],
    pool: true,
    note: '',
    cache_write: false,
  });
});

test('planOutput maps hosted-macos and mac lanes, and setup: false', () => {
  const c = parseConfig(`
version: 1
setup: {node: "22", fetch_depth: 0}
gates:
  - {name: m, run: x, lane: hosted-macos}
  - {name: e, run: y, lane: mac, setup: false}
`, { isPrivate: true });
  const out = planOutput(c, c.gates);
  assert.deepEqual(out.gates.map((g) => g.runs_on), [['macos-latest'], ['self-hosted', 'macOS', 'ARM64', 'ci-kit-mac']]);
  assert.deepEqual(out.gates[0].setup, { node: '22', pnpm: false, install: '', fetch_depth: 0, apt: [], brew: [], cask: [], script: '' });
  // setup: false skips the whole shared setup, fetch_depth with it (I1): the gate checks out at the default depth.
  assert.deepEqual(out.gates[1].setup, { node: '', pnpm: false, install: '', fetch_depth: 1, apt: [], brew: [], cask: [], script: '' });
  assert.equal(out.pool, false);
});

test('planOutput carries a gate\'s build_cache, with or without the shared setup', () => {
  const c = parseConfig(`
version: 1
setup: {node: "22"}
gates:
  - {name: img, run: x, build_cache: gha}
  - {name: bare, run: y, setup: false, build_cache: gha}
  - {name: plain, run: z}
`, { isPrivate: false });
  assert.deepEqual(planOutput(c, c.gates).gates.map((g) => g.build_cache), ['gha', 'gha', null]);
});

test('a schedule selects every build_cache gate, whatever its paths and on, and no other', () => {
  const c = parseConfig(`
version: 1
gates:
  - {name: img, run: x, build_cache: gha, paths: ["img/**"]}
  - {name: unit, run: y}
  - {name: pr-only, run: z, build_cache: gha, on: [pr]}
`, { isPrivate: false });
  assert.deepEqual(names(selectGates(c, { event: 'schedule' })), ['img', 'pr-only']);
  assert.deepEqual(selectGates(config, { event: 'schedule' }), []);
});

test('a push selects the build_cache gates whose paths it changed, whatever their on, and no other', () => {
  const c = parseConfig(`
version: 1
gates:
  - {name: img, run: x, build_cache: gha, paths: ["img/**"], on: [dispatch]}
  - {name: other, run: x, build_cache: gha, paths: ["other/**"]}
  - {name: any, run: x, build_cache: gha}
  - {name: unit, run: y, paths: ["img/**"]}
`, { isPrivate: false });
  assert.deepEqual(names(selectGates(c, { event: 'push', changedFiles: ['img/Dockerfile'] })), ['img', 'any']);
  assert.deepEqual(names(selectGates(c, { event: 'push', changedFiles: ['README.md'] })), ['any']);
  assert.deepEqual(selectGates(config, { event: 'push', changedFiles: ['src/a.js', 'docs/b.md'] }), []);
});

test('planOutput says whether the build cache is written', () => {
  assert.equal(planOutput(config, [], { cacheWrite: true }).cache_write, true);
  assert.equal(planOutput(config, []).cache_write, false);
});

test('planOutput of an empty selection says so', () => {
  assert.deepEqual(planOutput(config, []), { gates: [], pool: false, note: 'no gates selected', cache_write: false });
});
