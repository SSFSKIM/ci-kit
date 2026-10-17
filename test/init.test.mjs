// ci-gate init (plugin spec, P2): the caller verbatim, a draft config from the repo's own commands that the planner
// accepts, and no overwrite without --force. Fixture repos are built in a temp directory; nothing touches the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInitArgs, UsageError } from '../cli/args.mjs';
import { CALLER, CALLER_PATH, CONFIG_PATH, initRepo } from '../cli/init.mjs';
import { parseConfig } from '../plan/config.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = { isPrivate: false };
const PRIVATE = { isPrivate: true };
let root;
let n = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-kit-init-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

// A git repo holding `files` (path → content; an object is written as JSON).
function repo(files) {
  const dir = join(root, `r${(n += 1)}`);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', dir]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const configOf = (dir, visibility = PUBLIC) => parseConfig(readFileSync(join(dir, CONFIG_PATH), 'utf8'), visibility);
const gatesOf = (config) => config.gates.map((g) => [g.name, g.run]);

test('the caller is the verbatim file of docs/adopting.md', () => {
  const doc = readFileSync(join(KIT, 'docs/adopting.md'), 'utf8');
  const block = doc.split('### 1. `.github/workflows/ci.yml`')[1].match(/```yaml\n([\s\S]*?)```/)[1];
  assert.equal(CALLER, block);
});

test('a Node repo: a gate per declared script, with the package manager its lockfile implies', () => {
  const dir = repo({
    'package.json': { scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc', dev: 'vite' }, engines: { node: '>=22.12' } },
    'package-lock.json': '{}',
  });
  const result = initRepo({ dir, visibility: PUBLIC });
  assert.equal(result.code, 0);
  assert.equal(readFileSync(join(dir, CALLER_PATH), 'utf8'), CALLER);
  const config = configOf(dir);
  assert.deepEqual(gatesOf(config), [['test', 'npm test'], ['lint', 'npm run lint'], ['build', 'npm run build']]);
  assert.deepEqual(config.setup, { node: '22', pnpm: false, install: 'npm ci', fetch_depth: 1 });
  assert.ok(config.gates.every((g) => g.lane === 'hosted' && g.paths.length === 0));
  assert.match(result.lines.join('\n'), /3 gates \(test, lint, build\) from package\.json \(npm, package-lock\.json\)/);
  assert.match(result.lines.at(-1), /^next: .*ci-gate/);
});

test('a pnpm repo enables corepack; npm init\'s placeholder test script is not a gate', () => {
  const dir = repo({
    'package.json': { packageManager: 'pnpm@10.4.0', scripts: { test: 'echo "Error: no test specified" && exit 1', typecheck: 'tsc --noEmit' } },
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    '.nvmrc': 'v24.1.0\n',
  });
  const result = initRepo({ dir, visibility: PUBLIC });
  const config = configOf(dir);
  assert.deepEqual(gatesOf(config), [['typecheck', 'pnpm run typecheck']]);
  assert.deepEqual(config.setup, { node: '24.1.0', pnpm: true, install: 'pnpm install --frozen-lockfile', fetch_depth: 1 });
  assert.match(result.lines.join('\n'), /placeholder/);
});

test('a Python repo with pip: the package and its test extra installed, pytest as the gate', () => {
  const dir = repo({
    'pyproject.toml': '[project]\nname = "x"\n\n[project.optional-dependencies]\ntest = ["pytest>=8"]\n\n[tool.ruff]\n',
    'tests/test_x.py': 'def test_x():\n    assert True\n',
  });
  assert.equal(initRepo({ dir, visibility: PUBLIC }).code, 0);
  const config = configOf(dir);
  assert.deepEqual(gatesOf(config), [['test', 'python3 -m pytest']]);
  assert.equal(config.setup.install, "python3 -m pip install -e '.[test]'");
  assert.equal(config.setup.node, '');
});

test('a Python repo with uv, and one with only requirements files', () => {
  const uv = repo({ 'pyproject.toml': '[project]\nname = "x"\n[tool.pytest.ini_options]\n', 'uv.lock': '' });
  initRepo({ dir: uv, visibility: PUBLIC });
  assert.deepEqual(gatesOf(configOf(uv)), [['test', 'uv run pytest']]);
  assert.equal(configOf(uv).setup.install, 'pipx install uv && uv sync --locked');

  const reqs = repo({ 'requirements.txt': 'requests\n', 'conftest.py': '' });
  initRepo({ dir: reqs, visibility: PUBLIC });
  assert.equal(configOf(reqs).setup.install, 'python3 -m pip install -r requirements.txt pytest');

  const bare = repo({ 'pytest.ini': '[pytest]\n', 'test_x.py': 'def test_x():\n    pass\n' });
  const result = initRepo({ dir: bare, visibility: PUBLIC });
  assert.deepEqual(gatesOf(configOf(bare)), [['test', 'python3 -m pytest']]);
  assert.equal(configOf(bare).setup.install, 'python3 -m pip install pytest');
  assert.match(result.lines[1], /from pytest\.ini \(pip\)/);
});

test('a repo with no detectable command: one placeholder gate that fails, said plainly', () => {
  const dir = repo({ 'README.md': '# notes\n' });
  const result = initRepo({ dir, visibility: PUBLIC });
  assert.equal(result.code, 0);
  const config = configOf(dir);
  assert.equal(config.gates.length, 1);
  assert.equal(config.gates[0].name, 'check');
  assert.match(config.gates[0].run, /exit 1$/);
  assert.match(result.lines.join('\n'), /no test, lint, typecheck or build command found.*placeholder gate, check, that fails until you replace its run/);
  const failed = spawnSync('bash', ['-eo', 'pipefail', '-c', config.gates[0].run], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
});

test('Cargo, Go and Makefile commands; a name taken twice goes under its ecosystem prefix', () => {
  const dir = repo({
    'Cargo.toml': '[package]\nname = "x"\n',
    'go.mod': 'module x\n\ngo 1.24\n',
    Makefile: 'VAR := 1\nlint: deps\n\tgolangci-lint run\ntest:\n\tgo test ./...\ninstall:\n\tcp x y\n',
  });
  const result = initRepo({ dir, visibility: PUBLIC });
  assert.deepEqual(gatesOf(configOf(dir)), [['test', 'cargo test'], ['go-test', 'go test ./...'], ['make-test', 'make test'], ['lint', 'make lint']]);
  assert.match(result.lines.join('\n'), /drafted as gate go-test; drop it if it runs the same checks/);
});

test('a private repo: hosted lanes only, with the pool lane and its owner steps in a comment', () => {
  const dir = repo({ 'package.json': { scripts: { test: 'vitest run' } }, 'package-lock.json': '{}' });
  const result = initRepo({ dir, visibility: PRIVATE });
  const text = readFileSync(join(dir, CONFIG_PATH), 'utf8');
  assert.ok(configOf(dir, PRIVATE).gates.every((g) => g.lane === 'hosted'));
  assert.match(text, /# .*lane: pool/);
  assert.match(text.replace(/\n# /g, ' '), /pool\/config\/gce\.json lists the repo \(a PR in ci-kit\) and the owner has installed the ci-kit-runners GitHub App/);
  assert.doesNotMatch(text.replace(/#.*$/gm, ''), /pool|mac/);
  assert.match(result.lines.join('\n'), /private repo/);
});

test('macOS-specific: hosted-macos on a public repo, hosted on a private one, never a self-hosted lane', () => {
  const files = { 'App.xcodeproj/project.pbxproj': '', 'package.json': { os: ['darwin'], scripts: { test: 'node --test' } } };
  const pub = repo(files);
  initRepo({ dir: pub, visibility: PUBLIC });
  assert.deepEqual(configOf(pub).gates.map((g) => g.lane), ['hosted-macos']);
  assert.match(readFileSync(join(pub, CONFIG_PATH), 'utf8'), /# This repo looks macOS-specific \(App\.xcodeproj at the root\)/);
  const priv = repo(files);
  initRepo({ dir: priv, visibility: PRIVATE });
  assert.deepEqual(configOf(priv, PRIVATE).gates.map((g) => g.lane), ['hosted']);
});

test('an unknown visibility is drafted as for a public repo, and says so', () => {
  const dir = repo({ 'go.mod': 'module x\n' });
  const result = initRepo({ dir, visibility: { isPrivate: null, reason: 'gh is not authenticated' } });
  assert.match(result.lines.join('\n'), /visibility is unknown \(gh is not authenticated\); drafted as for a public repo/);
  assert.doesNotMatch(readFileSync(join(dir, CONFIG_PATH), 'utf8'), /lane: pool/);
});

test('neither file is overwritten without --force; with it, both are', () => {
  const adopted = repo({ [CONFIG_PATH]: 'version: 1\n', 'go.mod': 'module x\n' });
  const refused = initRepo({ dir: adopted, visibility: PUBLIC });
  assert.equal(refused.code, 2);
  assert.match(refused.lines[0], /^ERROR \.github\/ci-kit\.yml already exists/);
  assert.equal(readFileSync(join(adopted, CONFIG_PATH), 'utf8'), 'version: 1\n');
  assert.equal(existsSync(join(adopted, CALLER_PATH)), false);

  const ownCi = repo({ [CALLER_PATH]: 'name: build\n', 'go.mod': 'module x\n' });
  const refusedToo = initRepo({ dir: ownCi, visibility: PUBLIC });
  assert.equal(refusedToo.code, 2);
  assert.match(refusedToo.lines[0], /^ERROR \.github\/workflows\/ci\.yml already exists and is not ci-kit's caller/);
  assert.equal(readFileSync(join(ownCi, CALLER_PATH), 'utf8'), 'name: build\n');
  assert.equal(existsSync(join(ownCi, CONFIG_PATH)), false);

  assert.equal(initRepo({ dir: ownCi, force: true, visibility: PUBLIC }).code, 0);
  assert.equal(readFileSync(join(ownCi, CALLER_PATH), 'utf8'), CALLER);
  assert.equal(initRepo({ dir: adopted, force: true, visibility: PUBLIC }).code, 0);
  assert.deepEqual(gatesOf(configOf(adopted)), [['test', 'go test ./...']]);
});

test('a caller that is already the verbatim file is kept, not refused', () => {
  const dir = repo({ [CALLER_PATH]: CALLER, 'go.mod': 'module x\n' });
  const result = initRepo({ dir, visibility: PUBLIC });
  assert.equal(result.code, 0);
  assert.match(result.lines[0], /^kept \.github\/workflows\/ci\.yml/);
});

test('ci-gate init from the command line, in a repo with no GitHub remote', () => {
  const dir = repo({ 'package.json': { scripts: { test: 'node --test' } } });
  mkdirSync(join(dir, 'sub'));
  const run = spawnSync(process.execPath, [join(KIT, 'bin/ci-gate'), 'init', join(dir, 'sub')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /visibility is unknown \(origin does not push to a GitHub repo/);
  assert.match(run.stdout, /no lockfile/);
  assert.equal(existsSync(join(dir, CONFIG_PATH)), true); // at the top level, not in sub/
  assert.equal(configOf(dir).setup.install, 'npm install');

  const again = spawnSync(process.execPath, [join(KIT, 'bin/ci-gate'), 'init', dir], { encoding: 'utf8' });
  assert.equal(again.status, 2);
  assert.match(again.stdout, /^ERROR /m);
  const usage = spawnSync(process.execPath, [join(KIT, 'bin/ci-gate'), 'init', '--keep'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stdout, /ERROR unknown option --keep for init/);
});

test('parseInitArgs', () => {
  assert.deepEqual(parseInitArgs([]), { target: '.', force: false, repo: null });
  assert.deepEqual(parseInitArgs(['../x', '--force', '--repo=SSFSKIM/cua']), { target: '../x', force: true, repo: 'SSFSKIM/cua' });
  assert.throws(() => parseInitArgs(['--gates', 'a']), UsageError);
  assert.throws(() => parseInitArgs(['a', 'b']), UsageError);
  assert.throws(() => parseInitArgs(['--repo', 'nope']), UsageError);
});
