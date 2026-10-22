// The planner as gates.yml runs it: a process reading its inputs from the environment, in the caller's checkout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLAN = join(dirname(fileURLToPath(import.meta.url)), '..', 'plan', 'plan.mjs');
let repo;
let base;
let head;

const CONFIG = `version: 1
gates:
  - name: unit
    run: npm test
    paths: ["src/**"]
  - name: lib
    run: npm run lib
    paths: ["lib/**"]
  - name: docs
    run: npm run docs
    paths: ["docs/**"]
`;

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'ci-kit-plan-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  mkdirSync(join(repo, '.github'));
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, '.github', 'ci-kit.yml'), CONFIG);
  writeFileSync(join(repo, 'src', 'a.js'), 'a\n');
  writeFileSync(join(repo, 'docs', 'old.md'), 'old\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  // A rename (src/a.js → lib/a.js) and nothing under docs/.
  mkdirSync(join(repo, 'lib'));
  renameSync(join(repo, 'src', 'a.js'), join(repo, 'lib', 'a.js'));
  git('add', '-A');
  git('commit', '-qm', 'move');
  head = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

function plan(env) {
  const r = spawnSync(process.execPath, [PLAN], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      CI_KIT_CONFIG: '.github/ci-kit.yml',
      CI_KIT_PRIVATE: 'false',
      CI_KIT_BASE: base,
      CI_KIT_HEAD: head,
      CI_KIT_GATES: '',
      CI_KIT_HEAD_MESSAGE: '',
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null };
}

test('a PR selects by changed files, counting both paths of a rename', () => {
  const r = plan({ CI_KIT_EVENT: 'pr' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.gates.map((g) => g.name), ['unit', 'lib']);
  assert.equal(r.json.note, '');
});

test('a ci ref honours the CI-Gates trailer over paths', () => {
  const r = plan({ CI_KIT_EVENT: 'ci-ref', CI_KIT_HEAD_MESSAGE: 'ci-gate 0123456789ab\n\nCI-Gates: docs\n' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.gates.map((g) => g.name), ['docs']);
});

test('a dispatch with a gates input runs exactly those', () => {
  const r = plan({ CI_KIT_EVENT: 'dispatch', CI_KIT_BASE: '', CI_KIT_GATES: 'lib, docs' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.gates.map((g) => g.name), ['lib', 'docs']);
});

test('a dispatch with no gates input runs every dispatch gate', () => {
  const r = plan({ CI_KIT_EVENT: 'dispatch', CI_KIT_BASE: '' });
  assert.deepEqual(r.json.gates.map((g) => g.name), ['unit', 'lib', 'docs']);
});

test('an empty selection is a success with a note', () => {
  const r = plan({ CI_KIT_EVENT: 'pr', CI_KIT_BASE: head });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json, { gates: [], pool: false, note: 'no gates selected', cache_write: false });
});

test('an unknown trailer gate is a config error: exit 2, ci-kit: on stderr', () => {
  const r = plan({ CI_KIT_EVENT: 'ci-ref', CI_KIT_HEAD_MESSAGE: 'ci-gate x\n\nCI-Gates: nope\n' });
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /^ci-kit: unknown gate "nope" in CI-Gates/m);
});

test('A3 fixture: a pool gate on a public repo fails the plan with the exact message', () => {
  const dir = join(repo, 'pool-config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ci-kit.yml'), 'version: 1\ngates:\n  - {name: big, run: x, lane: pool}\n');
  const r = plan({ CI_KIT_EVENT: 'ci-ref', CI_KIT_CONFIG: 'pool-config/ci-kit.yml' });
  assert.equal(r.code, 2);
  assert.equal(r.err, 'ci-kit: lane "pool" is for private repos only (gate "big")\n');
});

test('the same config on a private repo plans a pool gate', () => {
  const r = plan({ CI_KIT_EVENT: 'ci-ref', CI_KIT_CONFIG: 'pool-config/ci-kit.yml', CI_KIT_PRIVATE: 'true' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.pool, true);
  assert.deepEqual(r.json.gates[0].runs_on, ['self-hosted', 'ci-kit-pool', 'cpus-4']);
});

test('a missing config file is reported', () => {
  const r = plan({ CI_KIT_EVENT: 'pr', CI_KIT_CONFIG: 'nope.yml' });
  assert.equal(r.code, 2);
  assert.match(r.err, /^ci-kit: no config at nope\.yml/);
});

test('an unknown event is refused', () => {
  const r = plan({ CI_KIT_EVENT: 'release' });
  assert.equal(r.code, 2);
  assert.match(r.err, /^ci-kit: CI_KIT_EVENT must be pr, ci-ref, dispatch or schedule, not "release"/);
});

test('a schedule seeds: every build_cache gate, no change basis needed, the cache written on the default branch', () => {
  const dir = join(repo, 'cache-config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ci-kit.yml'), `version: 1
gates:
  - {name: img, run: x, build_cache: gha, paths: ["img/**"]}
  - {name: unit, run: y}
`);
  const r = plan({
    CI_KIT_EVENT: 'schedule', CI_KIT_CONFIG: 'cache-config/ci-kit.yml', CI_KIT_BASE: '', CI_KIT_HEAD: '',
    CI_KIT_REF: 'refs/heads/main', CI_KIT_DEFAULT_BRANCH: 'main',
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.gates.map((g) => [g.name, g.build_cache]), [['img', 'gha']]);
  assert.equal(r.json.cache_write, true);
});

test('only a run on the default branch writes the build cache', () => {
  const on = (ref, defaultBranch) => plan({
    CI_KIT_EVENT: 'dispatch', CI_KIT_CONFIG: 'cache-config/ci-kit.yml', CI_KIT_BASE: '',
    CI_KIT_REF: ref, CI_KIT_DEFAULT_BRANCH: defaultBranch,
  }).json.cache_write;
  assert.equal(on('refs/heads/main', 'main'), true);
  assert.equal(on('refs/heads/ci/gate-0123abcd-456789', 'main'), false);
  assert.equal(on('refs/pull/7/merge', 'main'), false);
  assert.equal(on('refs/heads/main', ''), false);
  assert.equal(on('refs/heads/mainline', 'main'), false);
});

// A consumer with no build_cache, on the events it always sent: the plan is what it was before the build cache, with
// the two inert fields it added (a gate's build_cache: null, cache_write: false).
test('a config without build_cache plans as before on pr, ci-ref and dispatch', () => {
  const dir = join(repo, 'private-config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ci-kit.yml'), `version: 1
setup: {node: "22", install: pnpm install, pnpm: true}
gates:
  - {name: unit, run: pnpm test, lane: pool, cpus: 8, paths: ["src/**"]}
  - {name: e2e, run: pnpm e2e, lane: mac, setup: false, on: [ci-ref, dispatch], env: {E2E: "1"}}
  - {name: lint, run: pnpm lint}
`);
  const env = { CI_KIT_CONFIG: 'private-config/ci-kit.yml', CI_KIT_PRIVATE: 'true', CI_KIT_REF: 'refs/pull/7/merge', CI_KIT_DEFAULT_BRANCH: 'main' };
  const setup = { node: '22', pnpm: true, install: 'pnpm install', fetch_depth: 1 };
  const unit = { name: 'unit', run: 'pnpm test', runs_on: ['self-hosted', 'ci-kit-pool', 'cpus-8'], timeout: 30, setup, artifacts: [], env: {}, build_cache: null };
  const e2e = {
    name: 'e2e', run: 'pnpm e2e', runs_on: ['self-hosted', 'macOS', 'ARM64', 'ci-kit-mac'], timeout: 30,
    setup: { node: '', pnpm: false, install: '', fetch_depth: 1 }, artifacts: [], env: { E2E: '1' }, build_cache: null,
  };
  const lint = { name: 'lint', run: 'pnpm lint', runs_on: ['ubuntu-latest'], timeout: 30, setup, artifacts: [], env: {}, build_cache: null };
  const pr = plan({ ...env, CI_KIT_EVENT: 'pr' });
  assert.equal(pr.code, 0, pr.err);
  assert.deepEqual(pr.json, { gates: [unit, lint], pool: true, note: '', cache_write: false });
  const ref = plan({ ...env, CI_KIT_EVENT: 'ci-ref', CI_KIT_REF: 'refs/heads/ci/x-0123abcd-456789', CI_KIT_HEAD_MESSAGE: 'ci-gate x\n\nCI-Gates: unit, e2e\n' });
  assert.deepEqual(ref.json, { gates: [unit, e2e], pool: true, note: '', cache_write: false });
  const all = plan({ ...env, CI_KIT_EVENT: 'dispatch', CI_KIT_BASE: '', CI_KIT_REF: 'refs/heads/main' });
  assert.deepEqual(all.json, { gates: [unit, e2e, lint], pool: true, note: '', cache_write: true });
});

test('a PR without a base is refused rather than guessed', () => {
  const r = plan({ CI_KIT_EVENT: 'pr', CI_KIT_BASE: '' });
  assert.equal(r.code, 2);
  assert.match(r.err, /^ci-kit: CI_KIT_BASE and CI_KIT_HEAD are required for event pr/);
});
