import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../plan/config.mjs';

const priv = { isPrivate: true };
const pub = { isPrivate: false };

function errorsOf(text, opts = priv) {
  try {
    parseConfig(text, opts);
  } catch (e) {
    if (e instanceof ConfigError) return e.messages;
    throw e;
  }
  assert.fail('expected a ConfigError');
}

test('a minimal config gets every default', () => {
  const c = parseConfig('version: 1\ngates:\n  - name: unit\n    run: npm test\n', pub);
  assert.deepEqual(c.setup, { node: '', pnpm: false, install: '', fetch_depth: 1 });
  assert.deepEqual(c.gates, [
    {
      name: 'unit', run: 'npm test', lane: 'hosted', cpus: null, timeout: 30, paths: [],
      on: ['pr', 'ci-ref', 'dispatch'], artifacts: [], setup: true, env: {},
    },
  ]);
});

test('every documented field is read', () => {
  const c = parseConfig(`
version: 1
setup:
  node: "24"
  pnpm: true
  install: pnpm install --frozen-lockfile
  fetch_depth: 0
gates:
  - name: unit
    run: npm test
    lane: pool
    cpus: 8
    timeout: 15
    paths: ["src/**"]
    on: [pr, ci-ref]
    artifacts: ["test-results/**"]
    setup: false
    env: {FOO: bar}
`, priv);
  assert.deepEqual(c.setup, { node: '24', pnpm: true, install: 'pnpm install --frozen-lockfile', fetch_depth: 0 });
  assert.deepEqual(c.gates[0], {
    name: 'unit', run: 'npm test', lane: 'pool', cpus: 8, timeout: 15, paths: ['src/**'],
    on: ['pr', 'ci-ref'], artifacts: ['test-results/**'], setup: false, env: { FOO: 'bar' },
  });
});

test('a pool gate defaults to 4 cpus', () => {
  const c = parseConfig('version: 1\ngates:\n  - {name: a, run: x, lane: pool}\n', priv);
  assert.equal(c.gates[0].cpus, 4);
});

test('A3: a pool gate in a public repo is refused with the exact message', () => {
  assert.deepEqual(
    errorsOf('version: 1\ngates:\n  - {name: big, run: x, lane: pool}\n', pub),
    ['lane "pool" is for private repos only (gate "big")'],
  );
});

test('a mac gate in a public repo is refused', () => {
  assert.deepEqual(
    errorsOf('version: 1\ngates:\n  - {name: e2e, run: x, lane: mac}\n', pub),
    ['lane "mac" is for private repos only (gate "e2e")'],
  );
});

test('hosted-macos is allowed in a public repo', () => {
  const c = parseConfig('version: 1\ngates:\n  - {name: m, run: x, lane: hosted-macos}\n', pub);
  assert.equal(c.gates[0].lane, 'hosted-macos');
});

const rejected = [
  ['an unparseable file', 'version: 1\ngates: [\n', /^\.github\/ci-kit\.yml is not valid YAML/],
  ['a non-mapping file', '- a\n', /^the config must be a mapping/],
  ['a missing version', 'gates:\n  - {name: a, run: x}\n', /^version: must be 1/],
  ['version 2', 'version: 2\ngates:\n  - {name: a, run: x}\n', /^version: must be 1/],
  ['an unknown top-level key', 'version: 1\nfoo: 1\ngates:\n  - {name: a, run: x}\n', /^unknown key "foo"/],
  ['missing gates', 'version: 1\n', /^gates: required/],
  ['empty gates', 'version: 1\ngates: []\n', /^gates: required/],
  ['an unknown setup key', 'version: 1\nsetup: {npm: true}\ngates:\n  - {name: a, run: x}\n', /^setup: unknown key "npm"/],
  ['an unquoted node version', 'version: 1\nsetup: {node: 24}\ngates:\n  - {name: a, run: x}\n', /^setup\.node: must be a string/],
  ['a non-boolean pnpm', 'version: 1\nsetup: {pnpm: "yes"}\ngates:\n  - {name: a, run: x}\n', /^setup\.pnpm: must be true or false/],
  ['a negative fetch_depth', 'version: 1\nsetup: {fetch_depth: -1}\ngates:\n  - {name: a, run: x}\n', /^setup\.fetch_depth: must be a whole number of commits, 0 for full history/],
  ['a fractional fetch_depth', 'version: 1\nsetup: {fetch_depth: 1.5}\ngates:\n  - {name: a, run: x}\n', /^setup\.fetch_depth: must be a whole number/],
  ['a quoted fetch_depth', 'version: 1\nsetup: {fetch_depth: "0"}\ngates:\n  - {name: a, run: x}\n', /^setup\.fetch_depth: must be a whole number/],
  ['a gate that is not a mapping', 'version: 1\ngates:\n  - unit\n', /^gates\[0\]: must be a mapping/],
  ['a gate without a name', 'version: 1\ngates:\n  - {run: x}\n', /^gates\[0\]: name: required/],
  ['a bad gate name', 'version: 1\ngates:\n  - {name: Unit, run: x}\n', /^gate "Unit": name: must match/],
  ['a reserved gate name', 'version: 1\ngates:\n  - {name: verdict, run: x}\n', /^gate "verdict": name: "verdict" is reserved/],
  ['a duplicate gate name', 'version: 1\ngates:\n  - {name: a, run: x}\n  - {name: a, run: y}\n', /^gate "a": name: duplicate/],
  ['a gate without run', 'version: 1\ngates:\n  - {name: a}\n', /^gate "a": run: required/],
  ['an unknown gate key', 'version: 1\ngates:\n  - {name: a, run: x, cmd: y}\n', /^gate "a": unknown key "cmd"/],
  ['an unknown lane', 'version: 1\ngates:\n  - {name: a, run: x, lane: cloud}\n', /^gate "a": lane: must be one of hosted, hosted-macos, pool, mac/],
  ['cpus off the pool', 'version: 1\ngates:\n  - {name: a, run: x, cpus: 4}\n', /^gate "a": cpus: only for lane pool/],
  ['cpus not a size', 'version: 1\ngates:\n  - {name: a, run: x, lane: pool, cpus: 3}\n', /^gate "a": cpus: must be one of 2, 4, 8, 16/],
  ['a zero timeout', 'version: 1\ngates:\n  - {name: a, run: x, timeout: 0}\n', /^gate "a": timeout: must be a whole number of minutes from 1 to 360/],
  ['a timeout over 360', 'version: 1\ngates:\n  - {name: a, run: x, timeout: 361}\n', /^gate "a": timeout: must be/],
  ['paths not a list', 'version: 1\ngates:\n  - {name: a, run: x, paths: "src/**"}\n', /^gate "a": paths: must be a list of strings/],
  ['a bracket expression in paths', 'version: 1\ngates:\n  - {name: a, run: x, paths: ["src/**", "src/[[:digit:]].js"]}\n', /^gate "a": paths\[1\]: "src\/\[\[:digit:\]\]\.js" uses bracket expressions/],
  ['a malformed range in paths', 'version: 1\ngates:\n  - {name: a, run: x, paths: ["src/[z-a].js"]}\n', /^gate "a": paths\[0\]: .*bracket expressions/],
  ['an unknown event', 'version: 1\ngates:\n  - {name: a, run: x, on: [push]}\n', /^gate "a": on: "push" is not one of pr, ci-ref, dispatch/],
  ['an empty on list', 'version: 1\ngates:\n  - {name: a, run: x, on: []}\n', /^gate "a": on: must list at least one/],
  ['artifacts not a list', 'version: 1\ngates:\n  - {name: a, run: x, artifacts: 1}\n', /^gate "a": artifacts: must be a list of strings/],
  ['a non-boolean gate setup', 'version: 1\ngates:\n  - {name: a, run: x, setup: no-thanks}\n', /^gate "a": setup: must be true or false/],
  ['a non-string env value', 'version: 1\ngates:\n  - {name: a, run: x, env: {N: 1}}\n', /^gate "a": env\.N: must be a string/],
  ['a bad env name', 'version: 1\ngates:\n  - {name: a, run: x, env: {"1X": "y"}}\n', /^gate "a": env: "1X" is not a valid variable name/],
  ['an env name the kit sets', 'version: 1\ngates:\n  - {name: a, run: x, env: {CI_KIT_BASE: "y"}}\n', /^gate "a": env: "CI_KIT_BASE" is reserved: the kit sets CI_KIT_\* variables/],
];

for (const [what, text, pattern] of rejected) {
  test(`rejects ${what}`, () => {
    const messages = errorsOf(text);
    assert.ok(messages.some((m) => pattern.test(m)), `got: ${JSON.stringify(messages)}`);
  });
}

test('every error is reported, not only the first', () => {
  const messages = errorsOf('version: 1\ngates:\n  - {name: a, run: x, lane: pool}\n  - {name: b, timeout: 0}\n', pub);
  assert.deepEqual(messages, [
    'lane "pool" is for private repos only (gate "a")',
    'gate "b": run: required',
    'gate "b": timeout: must be a whole number of minutes from 1 to 360',
  ]);
});
